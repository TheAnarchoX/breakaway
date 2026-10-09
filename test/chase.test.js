import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, releaseRoutineHolds } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
// breakaway's routine, from TASKS_ROUTINES in vitest.config.js.
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';

const routine = { fires: [], fail: null, next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE || url === FIRE_BREAKAWAY) {
      routine.fires.push({ url, text: JSON.parse(init.body).text });
      if (routine.fail)
        return new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: routine.fail } }), {
          status: 500,
        });
      const id = `session_${String(routine.next++).padStart(4, '0')}`;
      return Response.json({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 }); // GitHub, during alarms
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const chase = async (slug, input = {}) => body(await api(`features/${slug}/chase`, { method: 'POST', body: input }));
const feature = async (slug) => (await body(await api(`features/${slug}`))).feature;
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const done = (ref) => api(`tasks/${ref}/done`, { method: 'POST', body: {} });
const fired = (wid) => routine.fires.filter((f) => f.text.includes(`Task: ${wid}\n`));
const queued = (f, wid) => f.chase.queue.find((q) => q.wid === wid);
const tick = () => runDurableObjectAlarm(stub());
const pings = async () => body(await api('pings'));

/** An open pull request that closes `wid`, as the reconcile stores it. */
async function openPull(number, wid) {
  await runInDurableObject(stub(), (instance) => {
    instance.sql.exec(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', ?, '2026-10-02T09:00:00Z', 'open', ?)",
      number,
      JSON.stringify({
        number,
        title: `Pull ${number}`,
        state: 'open',
        draft: false,
        url: `https://github.com/acme/widgets/pull/${number}`,
        author: 'claude[bot]',
        checks: { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
        closes: [wid],
        mentions: [],
      }),
    );
  });
}

describe('chase', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    routine.fail = null;
  });
  afterEach(() => spy.mockRestore());

  it('sets up a board with two features, a blocker in another repository, and one whose routine isn’t connected', async () => {
    for (const repo of [
      { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
      { slug: 'scratch', github: 'acme/scratch', areas: ['product:SCR'] },
    ])
      expect((await api('repos', { method: 'POST', body: repo })).status).toBe(201);
    const add = (items) => api('tasks', { method: 'POST', body: items });
    let res = await body(
      await add([
        // tiny: an agent task that waits for a step only the owner can do.
        {
          description: 'Owner step',
          project: 'moderation',
          who: 'person',
          assignee: 'owner',
          tags: ['tiny'],
          horizon: 'now',
        },
        {
          description: 'After the step',
          project: 'moderation',
          who: 'agent',
          tags: ['tiny'],
          horizon: 'now',
          depends: ['MOD-1'],
        },
        // speed: four ready in Operations, two related in Tech debt, a decision, and one waiting on two repositories.
        { description: 'Ops one', project: 'ops', who: 'agent', tags: ['speed'], horizon: 'now' },
        { description: 'Ops two', project: 'ops', who: 'agent', tags: ['speed'], horizon: 'now' },
        { description: 'Ops three', project: 'ops', who: 'agent', tags: ['speed'], horizon: 'now' },
        { description: 'Ops four', project: 'ops', who: 'agent', tags: ['speed'], horizon: 'now' },
        { description: 'Debt one', project: 'debt', who: 'agent', tags: ['speed'], horizon: 'now' },
        {
          description: 'Debt two',
          project: 'debt',
          who: 'agent',
          tags: ['speed'],
          horizon: 'now',
          related: ['DEBT-1'],
        },
        { description: 'Pick a name', project: 'moderation', who: 'decision', tags: ['speed'], horizon: 'now' },
        // Outside any feature, in Operations.
        { description: 'Ops elsewhere', project: 'ops', who: 'agent', horizon: 'now' },
        { description: 'Ops later', project: 'ops', who: 'agent', horizon: 'next' },
        { description: 'Empty', project: 'debt', tags: ['empty-feature-x'], horizon: 'later' },
      ]),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual([
      'MOD-1',
      'MOD-2',
      'OPS-1',
      'OPS-2',
      'OPS-3',
      'OPS-4',
      'DEBT-1',
      'DEBT-2',
      'MOD-3',
      'OPS-5',
      'OPS-6',
      'DEBT-3',
    ]);
    res = await body(
      await add([
        { description: 'Breakaway part', project: 'product', repo: 'breakaway', who: 'agent', horizon: 'now' },
        { description: 'Scratch part', project: 'product', repo: 'scratch', who: 'agent', horizon: 'now' },
      ]),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['BRK-1', 'SCR-1']);
    res = await body(
      await add({
        description: 'Needs both parts',
        project: 'product',
        who: 'agent',
        tags: ['speed'],
        horizon: 'now',
        depends: ['BRK-1', 'SCR-1'],
      }),
    );
    expect(res.tasks[0].wid).toBe('PRD-1');
    for (const slug of ['tiny', 'speed'])
      expect((await api('features', { method: 'POST', body: { slug } })).status).toBe(201);
    expect((await api('features', { method: 'POST', body: { slug: 'nothing' } })).status).toBe(201);
    expect(
      (await body(await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } })))
        .settings,
    ).toMatchObject({ max: 12, hourly: 30 });
  });

  it('is off by default, is the owner’s alone, and checks what it’s given', async () => {
    const f = await feature('speed');
    expect(f.chase).toMatchObject({ state: 'off', on: false, parallel: 3, startedAt: null });
    expect((await chase('speed', { on: true, by: 'claude-x-1' })).status).toBe(403);
    expect((await chase('speed', { parallel: 0 })).status).toBe(400);
    expect((await chase('speed', { parallel: 2.5 })).status).toBe(400);
    expect((await chase('speed', { on: 'yes' })).status).toBe(400);
    expect((await chase('nope', { on: true })).status).toBe(404);
    const empty = await chase('nothing', { on: true });
    expect(empty.status).toBe(409);
    expect(empty.error).toMatch(/no tasks to chase/);
    expect(routine.fires).toHaveLength(0);
  });

  it('pings the owner once when only they can move it, then starts again by itself when they act', async () => {
    const res = await chase('tiny', { on: true });
    expect(res.status).toBe(200);
    expect(res.started).toEqual([]);
    expect(res.chase).toMatchObject({ state: 'on', on: true, stalledPingAt: expect.any(String) });
    expect(res.chase.needsYou).toEqual([
      expect.objectContaining({ wid: 'MOD-1', kind: 'person', unblocks: 1, why: expect.stringMatching(/step for you/) }),
    ]);
    let { pings: open } = await pings();
    expect(open).toEqual([
      expect.objectContaining({
        task: 'MOD-1',
        kind: 'blocked',
        by: 'board',
        push: true,
        message: expect.stringMatching(
          /chase on Tiny can’t start anything: MOD-1 is a step for you.*1 more task waits/,
        ),
      }),
    ]);
    // Once: the next ticks keep quiet while nothing changes.
    await tick();
    await tick();
    ({ pings: open } = await pings());
    expect(open).toHaveLength(1);

    await done('MOD-1');
    await tick();
    expect(await task('MOD-2')).toMatchObject({ claim: 'claude-mod-2' });
    expect(fired('MOD-2').at(-1).text).toMatch(/Started: by the owner’s chase of a feature/);
    expect((await feature('tiny')).chase).toMatchObject({ state: 'on', stalledPingAt: null });
  });

  it('ends by itself when every task is done or in review: one note in the inbox, no push', async () => {
    await openPull(41, 'MOD-2');
    await tick();
    const f = await feature('tiny');
    expect(f.chase).toMatchObject({ state: 'done', on: false, endedAt: expect.any(String) });
    expect(f.chase.tasks.map((t) => [t.wid, t.state])).toEqual([
      ['MOD-1', 'done'],
      ['MOD-2', 'in-review'],
    ]);
    expect(f.chase.needsYou).toEqual([expect.objectContaining({ wid: 'MOD-2', kind: 'merge', pr: 41 })]);
    const inbox = await pings();
    expect(inbox.chases).toEqual([
      expect.objectContaining({ feature: 'tiny', title: 'Tiny', detail: expect.stringMatching(/1 to merge/) }),
    ]);
    // No ping (so no push) for the end: only the stall's, which finished with its task.
    expect(inbox.pings).toEqual([]);
    expect((await chase('tiny', { dismiss: true })).status).toBe(200);
    expect((await pings()).chases).toEqual([]);
  });

  it('shows what it would start without starting anything', async () => {
    // An agent outside the chase already works in Operations: it counts toward the area's limit.
    expect((await api('agents/start', { method: 'POST', body: { ref: 'OPS-5' } })).status).toBe(200);
    const before = routine.fires.length;
    const res = await chase('speed', { on: true, dryRun: true });
    expect(res).toMatchObject({ status: 200, dryRun: true });
    expect(res.wouldStart).toEqual(['BRK-1', 'DEBT-1', 'OPS-1', 'OPS-2']);
    expect(routine.fires).toHaveLength(before);
    expect((await feature('speed')).chase.state).toBe('off');
  });

  it('starts every ready task together, across repositories, up to the per-area limit', async () => {
    const res = await chase('speed', { on: true });
    expect(res.status).toBe(200);
    expect(res.started).toEqual(['BRK-1', 'DEBT-1', 'OPS-1', 'OPS-2']);
    // A blocker in another repository starts through that repository's routine.
    expect(fired('BRK-1')).toEqual([expect.objectContaining({ url: FIRE_BREAKAWAY })]);
    expect(fired('BRK-1')[0].text).toContain('Repository: breakaway (acme/breakaway)');
    const f = await feature('speed');
    expect(f.chase.summary).toMatch(/^4 running, 3 ready, 1 waiting on other tasks, 2 waiting for you$/);
    expect(f.chase.tasks.find((t) => t.wid === 'BRK-1')).toMatchObject({ blocks: ['PRD-1'], state: 'running' });
    expect(queued(f, 'OPS-3').reason).toBe('3 agents are already working in Operations, the most this chase allows');
    expect(queued(f, 'OPS-4').reason).toMatch(/3 agents are already working in Operations/);
    // Related tasks in one area never run together.
    expect(queued(f, 'DEBT-2').reason).toMatch(/related to DEBT-1, which an agent is working on in Tech debt/);
    expect(f.chase.needsYou.map((n) => [n.wid, n.kind])).toEqual([
      ['MOD-3', 'decision'],
      ['SCR-1', 'connect'],
    ]);
    expect(f.chase.needsYou[1].why).toMatch(/connect scratch/);
    expect(f.chase.tasks.find((t) => t.wid === 'PRD-1')).toMatchObject({ state: 'waiting' });
    // Every start is the chase's, for the budget.
    const { events } = await body(await api('activity'));
    const starts = events.flatMap((e) => e.changes).filter((c) => c.kind === 'agent_started' && c.trigger === 'chase');
    expect(starts).toHaveLength(5); // MOD-2 and these four
    expect(events.flatMap((e) => e.changes).filter((c) => c.kind === 'chase_started')).toHaveLength(2);
  });

  it('shows the chases that are on in the Agents view, each with its live line and queue', async () => {
    const { chases } = await body(await api('agents'));
    expect(chases).toEqual([
      expect.objectContaining({
        slug: 'speed',
        title: 'Speed',
        state: 'on',
        parallel: 3,
        summary: '4 running, 3 ready, 1 waiting on other tasks, 2 waiting for you',
      }),
    ]);
    expect(chases[0].queue.map((q) => q.wid)).toEqual(expect.arrayContaining(['OPS-3', 'OPS-4', 'DEBT-2']));
    expect(chases[0].needsYou.map((n) => n.wid)).toEqual(['MOD-3', 'SCR-1']);
  });

  it('keeps one agent per area outside a chase, for agents next and auto-start', async () => {
    const plan = await body(await api('agents/next', { method: 'POST', body: { count: 6, dryRun: true } }));
    expect(plan.skipped.find((s) => s.wid === 'OPS-6').reason).toMatch(/already working in Operations/);
    await api('tasks/OPS-6', { method: 'PATCH', body: { autostart: 'yes' } });
    const { queue } = await body(await api('agents'));
    expect(queue.find((q) => q.wid === 'OPS-6')).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/already working in Operations/),
    });
    await api('tasks/OPS-6', { method: 'PATCH', body: { autostart: 'no' } });
  });

  it('follows a changed parallel on the next tick', async () => {
    const res = await chase('speed', { parallel: 4 });
    expect(res.started).toEqual([]);
    expect(res.chase.parallel).toBe(4);
    await tick();
    expect(await task('OPS-3')).toMatchObject({ claim: 'claude-ops-3' });
    expect(await task('OPS-4')).toMatchObject({ claim: null });
    const f = await feature('speed');
    expect(queued(f, 'OPS-4').reason).toBe('4 agents are already working in Operations, the most this chase allows');
    expect(queued(f, 'DEBT-2').reason).toMatch(/related to DEBT-1/);
  });

  it('lets auto-start go first when slots run short', async () => {
    // DEBT-1 finishes, so DEBT-2 is free to start, and one slot is left.
    await done('DEBT-1');
    const { running } = await body(await api('agents'));
    await api('agents/settings', { method: 'PATCH', body: { max: running.length + 1 } });
    // Nothing of auto-start's is ready, so the chase has the slot.
    let f = await feature('speed');
    expect(queued(f, 'DEBT-2')).toMatchObject({ ready: true, reason: 'starting now' });
    // A Start-when-ready task that's ready takes it first, whatever its rank.
    const extra = await body(
      await api('tasks', {
        method: 'POST',
        body: {
          description: 'Ready by itself',
          project: 'product',
          who: 'agent',
          horizon: 'later',
          autostart: 'yes',
        },
      }),
    );
    const wid = extra.tasks[0].wid;
    f = await feature('speed');
    expect(queued(f, 'DEBT-2')).toMatchObject({
      ready: false,
      reason: `no free slot (${running.length} of ${running.length + 1} running)`,
    });
    await tick();
    expect(await task(wid)).toMatchObject({ claim: `claude-${wid.toLowerCase()}` });
    expect(await task('DEBT-2')).toMatchObject({ claim: null });
  });

  it('marks a task refused twice as Stuck and stops retrying it', async () => {
    await done('OPS-1');
    routine.fail = 'session refused';
    await tick();
    // A refused start holds the routine for a few minutes (BRK-144), so the next tick fires only once they've passed.
    await releaseRoutineHolds();
    await tick();
    const f = await feature('speed');
    expect(f.chase.stuck).toEqual([
      expect.objectContaining({ wid: 'DEBT-2', why: 'it was refused 2 times', last: expect.stringMatching(/refused/) }),
    ]);
    expect(queued(f, 'DEBT-2')).toBeUndefined();
    const tries = fired('DEBT-2').length;
    expect(tries).toBe(2);
    routine.fail = null;
    await releaseRoutineHolds();
    await tick();
    expect(fired('DEBT-2')).toHaveLength(tries);
    // The slot it would have had goes to the next in line.
    expect(await task('OPS-4')).toMatchObject({ claim: 'claude-ops-4' });
  });

  it('stops: starts nothing new and leaves running agents alone, and can start again', async () => {
    const res = await chase('speed', { on: false });
    expect(res.chase).toMatchObject({ state: 'stopped', on: false });
    expect((await body(await api('agents'))).chases).toEqual([]);
    const before = routine.fires.length;
    await done('OPS-2');
    await tick();
    expect(routine.fires).toHaveLength(before);
    expect(await task('OPS-3')).toMatchObject({ claim: 'claude-ops-3' });
    const again = await chase('speed', { on: true });
    expect(again.chase.state).toBe('on');
    // Starting it again gives a Stuck task another try: the owner pressed Chase.
    expect(again.started).toEqual(['DEBT-2']);
    expect(again.chase.stalledPingAt).toBeNull();
    const kinds = (await body(await api('activity'))).events.flatMap((e) => e.changes).map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['chase_stopped', 'chase_ended', 'chase_stalled']));
  });
});
