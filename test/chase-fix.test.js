import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const routine = { fires: [], next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      routine.fires.push(JSON.parse(init.body).text);
      const id = `session_f${String(routine.next++).padStart(3, '0')}`;
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
// The alarm and the cron's chase step: they run it whether or not a change set an alarm.
const tick = () => runInDurableObject(stub(), (instance) => instance.chaseTick());
const fixes = () => routine.fires.filter((text) => text.includes('Mode: fix-pr'));
const stateOf = async (wid) => (await feature('fast')).chase.tasks.find((t) => t.wid === wid);

/** An open pull request that closes `wid`, as the reconcile stores it: clean, conflicting, or failing. */
async function pull(number, wid, { head, problem = null }) {
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
        headSha: head,
        mergeable: problem !== 'conflicts',
        mergeableState: problem === 'conflicts' ? 'dirty' : 'clean',
        checks:
          problem === 'failing'
            ? { state: 'failure', total: 1, passed: 0, runs: [{ name: 'Test and build', state: 'failure' }] }
            : { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
        closes: [wid],
        mentions: [],
      }),
    );
  });
}

/** Moves time on: agents that started went quiet a while ago, and (with `seen`) problems the chase saw are older. */
async function later(minutes, { seen = true } = {}) {
  const ms = minutes * 60_000;
  await runInDurableObject(stub(), (instance) => {
    instance.sql.exec('UPDATE agent_runs SET started = started - ?', ms);
    instance.sql.exec('UPDATE agent_logs SET at = at - ?', ms);
    if (seen) instance.sql.exec('UPDATE chase_fixes SET seen = seen - ?', ms);
  });
}

/** Sets or clears a task's claim directly, as a person's would be. */
async function claim(wid, who) {
  const { uuid } = await task(wid);
  await runInDurableObject(stub(), (instance) => {
    instance.change(uuid, { claim: who, start: false });
  });
}

describe('a chase fixes its own pull requests', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('sets up a feature with two tasks and starts its chase', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Ops one', project: 'ops', tags: ['agent', 'fast'], horizon: 'now' },
          { description: 'Ops two', project: 'ops', tags: ['agent', 'fast'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2']);
    expect((await api('features', { method: 'POST', body: { slug: 'fast' } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } });
    expect((await chase('fast', { on: true })).started).toEqual(['OPS-1', 'OPS-2']);
  });

  it('leaves a conflicting pull request to the agent that opened it while that agent is still there', async () => {
    await pull(41, 'OPS-1', { head: 'aaa', problem: 'conflicts' });
    await tick();
    expect(await stateOf('OPS-1')).toMatchObject({
      state: 'running',
      why: 'claude-ops-1 is on its pull request #41, which conflicts with its base branch',
    });
    expect(fixes()).toEqual([]);
  });

  it('gives the agent three minutes from when the chase saw it before it starts a fix', async () => {
    await later(60, { seen: false });
    await tick();
    expect(await stateOf('OPS-1')).toMatchObject({
      state: 'waiting',
      why: expect.stringMatching(/#41 conflicts with its base branch: if no agent picks it up within 3 minutes/),
    });
    expect(fixes()).toEqual([]);
    // Waiting on the grace keeps the chase on: it hasn't ended with a pull request nobody will fix.
    expect((await feature('fast')).chase.state).toBe('on');
  });

  it('then starts a fix agent on it, through Fix with an agent, telling it it’s one of the chase’s', async () => {
    await later(4);
    await tick();
    expect(fixes()).toHaveLength(1);
    const text = fixes()[0];
    expect(text).toContain('Task: OPS-1\n');
    expect(text).toContain('Pull request: #41');
    expect(text).toContain('Started: by the owner’s chase of a feature, to fix a pull request its agent left');
    expect(text).toMatch(/It conflicts with main.*Merge main into the branch/);
    expect(text).toContain('part of the chase on Fast (+fast)');
    expect(await task('OPS-1')).toMatchObject({ claim: 'claude-ops-1-fix' });
    const { events } = await body(await api('activity'));
    const starts = events.flatMap((e) => e.changes).filter((c) => c.kind === 'agent_started');
    expect(starts.filter((c) => c.trigger === 'chase-fix')).toHaveLength(1);
    // While the fix agent starts, the chase doesn't start another.
    await tick();
    expect(fixes()).toHaveLength(1);
    expect(await stateOf('OPS-1')).toMatchObject({ state: 'running' });
  });

  it('tries once more on the same head, then marks it Stuck', async () => {
    await later(60);
    await tick();
    expect(fixes()).toHaveLength(2);
    await later(60);
    await tick();
    expect(fixes()).toHaveLength(2);
    const f = await feature('fast');
    expect(f.chase.stuck).toEqual([
      expect.objectContaining({
        wid: 'OPS-1',
        pr: 41,
        why: 'its pull request #41 still conflicts with its base branch after 2 agents tried to fix it',
      }),
    ]);
  });

  it('fixes failing checks on a new head the same way', async () => {
    await pull(41, 'OPS-1', { head: 'bbb', problem: 'failing' });
    await tick();
    expect(await stateOf('OPS-1')).toMatchObject({ state: 'waiting' });
    await later(11);
    await tick();
    expect(fixes()).toHaveLength(3);
    expect(fixes()[2]).toContain('Checks are failing: Test and build.');
  });

  it('ends when everything is done or in review and clean, and keeps fixing its pull requests after that', async () => {
    await pull(41, 'OPS-1', { head: 'ccc' });
    await done('OPS-2');
    await later(60);
    await tick();
    expect((await feature('fast')).chase.state).toBe('done');

    // A task added to the feature after the end doesn't start: an ended chase only fixes.
    await api('tasks', { method: 'POST', body: { description: 'Ops three', project: 'ops', tags: ['agent', 'fast'] } });
    await pull(41, 'OPS-1', { head: 'ccc', problem: 'conflicts' });
    await tick();
    await later(11);
    await tick();
    expect(fixes()).toHaveLength(4);
    expect(fixes()[3]).toContain('part of the chase on Fast (+fast)');
    expect(await task('OPS-3')).toMatchObject({ claim: null });
    expect((await feature('fast')).chase.state).toBe('done');
  });

  it('never fixes a pull request a person holds', async () => {
    await claim('OPS-1', 'sam');
    await pull(41, 'OPS-1', { head: 'ddd', problem: 'conflicts' });
    await later(60);
    await tick();
    await later(11);
    await tick();
    expect(fixes()).toHaveLength(4);
    expect((await feature('fast')).chase.needsYou).toEqual([expect.objectContaining({ wid: 'OPS-1', kind: 'merge' })]);
  });

  it('never fixes one in a chase the owner stopped', async () => {
    await claim('OPS-1', null);
    await pull(41, 'OPS-1', { head: 'eee' });
    // Starting it again starts OPS-3, which the ended chase had left alone.
    const again = await chase('fast', { on: true });
    expect(again).toMatchObject({ started: ['OPS-3'], chase: { state: 'on' } });
    expect((await chase('fast', { on: false })).chase.state).toBe('stopped');
    await pull(41, 'OPS-1', { head: 'eee', problem: 'conflicts' });
    await tick();
    await later(60);
    await tick();
    expect(fixes()).toHaveLength(4);
  });

  it('starts a road captain on a chase: the owner’s prompt, the chase under it, its repository, force started', async () => {
    const captain = (input) => api('agents/general', { method: 'POST', body: input });
    expect((await captain({ chase: 'fast', prompt: 'Look', by: 'claude-x-1' })).status).toBe(403);
    expect((await captain({ chase: 'fast', prompt: '  ' })).status).toBe(400);
    expect((await captain({ chase: 'fast', prompt: 'Look', repo: 'elsewhere' })).status).toBe(400);
    expect((await api('features', { method: 'POST', body: { slug: 'quiet' } })).status).toBe(201);
    const off = await body(await captain({ chase: 'quiet', prompt: 'Look' }));
    expect(off).toMatchObject({ status: 409, error: expect.stringMatching(/no chase yet/) });

    // Full: the board's limits don't hold a road captain back.
    const { running } = await body(await api('agents'));
    await api('agents/settings', { method: 'PATCH', body: { max: Math.max(1, running.length) } });
    const before = routine.fires.length;
    const res = await body(await captain({ chase: 'fast', prompt: 'Fix the conflicts on the open pull requests.' }));
    expect(res.status).toBe(201);
    expect(routine.fires).toHaveLength(before + 1);
    const text = routine.fires.at(-1);
    expect(text).toContain('Mode: general');
    expect(text).toContain('Started: by the owner, as the road captain of a chase');
    expect(text).toContain('Title: Road captain for Fast: Fix the conflicts on the open pull requests.');
    const t = await task(res.task.uuid);
    expect(t.tags).toEqual(expect.arrayContaining(['agent', 'general', 'fast']));
    expect(t.brief).toMatch(/^Fix the conflicts on the open pull requests\.\n\n## The chase on Fast \(\+fast\)/);
    expect(t.brief).toContain('- #41 closes OPS-1 (widgets): conflicts with its base branch');
    expect(t.brief).toContain("You're its road captain");
    const { events } = await body(await api('activity'));
    expect(events.flatMap((e) => e.changes).find((c) => c.trigger === 'road-captain')).toMatchObject({
      forced: true,
    });
  });
});
