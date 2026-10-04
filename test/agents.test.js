import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
// breakaway's routine, from TASKS_ROUTINES in vitest.config.js.
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';

const routine = { fires: [], fail: null, next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE || url === FIRE_BREAKAWAY) {
      const headers = new Headers(init.headers);
      routine.fires.push({
        url,
        auth: headers.get('Authorization'),
        version: headers.get('anthropic-version'),
        text: JSON.parse(init.body).text,
      });
      if (routine.fail)
        return new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: routine.fail.message } }), {
          status: routine.fail.status,
          headers: routine.fail.headers ?? {},
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

const start = (ref, note) => api('agents/start', { method: 'POST', body: { ref, note } });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;

describe('cloud agents', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    routine.fail = null;
  });
  afterEach(() => spy.mockRestore());

  it('sets up a board to work on', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Publish security.txt', project: 'ops', tags: ['agent'], horizon: 'now', priority: 'H' },
          { description: 'Status page', project: 'ops', tags: ['agent', 'owner'], horizon: 'now', depends: ['OPS-1'] },
          { description: 'Decide word rules', project: 'moderation', tags: ['owner', 'decide'], horizon: 'now' },
          { description: 'Split rooms', project: 'product', tags: ['agent'], horizon: 'now' },
          { description: 'Route table', project: 'debt', tags: ['agent'], horizon: 'now' },
          { description: 'Lint and format', project: 'debt', tags: ['agent'], horizon: 'next' },
          { description: 'Owner only', project: 'ops', tags: ['owner'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'MOD-1', 'PRD-1', 'DEBT-1', 'DEBT-2', 'OPS-3']);
  });

  it('refuses to start agents on tasks that can’t take one, and says why', async () => {
    expect((await body(await start('OPS-2'))).error).toMatch(/waits for OPS-1/);
    expect((await body(await start('MOD-1'))).error).toMatch(/waits on a decision/);
    expect((await body(await start('OPS-3'))).error).toMatch(/isn’t tagged \+agent/);
    expect(routine.fires).toHaveLength(0);
  });

  it('starts one: claims the task for the agent, fires the routine, and links the session', async () => {
    const res = await body(await start('OPS-1', 'Keep it short.'));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({
      agent: 'claude-ops-1',
      trigger: 'manual',
      status: 'started',
      url: 'https://claude.ai/code/session_0001',
    });
    expect(res.task).toMatchObject({
      claim: 'claude-ops-1',
      active: true,
      session: 'https://claude.ai/code/session_0001',
    });
    expect(routine.fires[0].auth).toBe('Bearer sk-ant-oat01-test-routine-token');
    expect(routine.fires[0].version).toBe('2023-06-01');
    expect(routine.fires[0].text).toContain('Task: OPS-1');
    expect(routine.fires[0].text).toContain('Agent name: claude-ops-1');
    expect(routine.fires[0].text).toContain('Repository: widgets (acme/widgets)');
    expect(routine.fires[0].text).toContain('Keep it short.');
    // The agent claims it again under the same name: that works.
    expect((await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-ops-1' } })).status).toBe(200);
    // Anyone else can't, and neither can a second start.
    expect((await body(await start('OPS-1'))).error).toMatch(/claude-ops-1 has it/);
  });

  it('starts exactly one agent when two starts race', async () => {
    const [a, b] = await Promise.all([start('PRD-1'), start('PRD-1')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(routine.fires.filter((f) => f.text.includes('Task: PRD-1'))).toHaveLength(1);
  });

  it('gives the task back when Claude won’t start the session', async () => {
    routine.fail = { status: 429, message: 'rate limited', headers: { 'Retry-After': '600' } };
    const res = await body(await start('DEBT-1'));
    expect(res.status).toBe(429);
    expect(res.error).toMatch(/hourly limit.*600/);
    expect((await task('DEBT-1')).claim).toBeNull();
    routine.fail = { status: 401, message: 'bad token' };
    expect((await body(await start('DEBT-1'))).error).toMatch(/token was refused/);
  });

  it('keeps to the limit on agents running at once', async () => {
    expect((await body(await api('agents/settings', { method: 'PATCH', body: { max: 2 } }))).settings.max).toBe(2);
    const res = await body(await start('DEBT-1'));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/2 agents are already running \(the limit is 2\)/);
    expect((await api('agents/settings', { method: 'PATCH', body: { max: 9 } })).status).toBe(400);
    await api('agents/settings', { method: 'PATCH', body: { max: 4 } });
  });

  it('lets the owner set how many agents start an hour', async () => {
    expect((await body(await api('agents/settings', { method: 'PATCH', body: { hourly: 30 } }))).settings.hourly).toBe(
      30,
    );
    expect((await api('agents/settings', { method: 'PATCH', body: { hourly: 31 } })).status).toBe(400);
    expect((await api('agents/settings', { method: 'PATCH', body: { hourly: 0 } })).status).toBe(400);
    await api('agents/settings', { method: 'PATCH', body: { hourly: 20 } });
  });

  it('picks the next few so they don’t collide: one per area, none where an agent already works', async () => {
    const firesBefore = routine.fires.length;
    const plan = await body(await api('agents/next', { method: 'POST', body: { count: 3, dryRun: true } }));
    expect(plan.started.map((t) => t.wid)).toEqual(['DEBT-1']);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.wid, s.reason]));
    expect(reasons['DEBT-2']).toMatch(/one Tech debt task at a time/);
    expect(routine.fires).toHaveLength(firesBefore); // a dry run starts nothing
    const run = await body(await api('agents/next', { method: 'POST', body: { count: 3 } }));
    expect(run.started.map((t) => t.wid)).toEqual(['DEBT-1']);
    expect(routine.fires.at(-1).text).toMatch(/as one of the next few/);
  });

  it('starts a Start-when-ready task by itself once what it waits for is done', async () => {
    await api('tasks/OPS-2', { method: 'PATCH', body: { autostart: 'yes' } });
    const before = await body(await api('agents'));
    expect(before.queue).toEqual([
      expect.objectContaining({ wid: 'OPS-2', ready: false, reason: 'it waits for OPS-1' }),
    ]);

    await api('tasks/OPS-1/done', { method: 'POST', body: {} });
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    await runDurableObjectAlarm(stub);
    const t = await task('OPS-2');
    expect(t).toMatchObject({ claim: 'claude-ops-2', autostart: true });
    expect(routine.fires.at(-1).text).toMatch(/Task: OPS-2[\s\S]*by itself/);
  });

  it('holds a ready Start-when-ready task in the queue while its area is busy or auto-start is off', async () => {
    await api('tasks', {
      method: 'POST',
      body: { description: 'Another ops job', project: 'ops', tags: ['agent'], horizon: 'now', autostart: 'yes' },
    });
    let queue = (await body(await api('agents'))).queue;
    expect(queue.find((q) => q.wid === 'OPS-4')).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/already working in Operations \(OPS-2\)/),
    });
    await api('agents/settings', { method: 'PATCH', body: { autostart: false } });
    queue = (await body(await api('agents'))).queue;
    expect(queue.find((q) => q.wid === 'OPS-4').reason).toMatch(/already working|auto-start is off/);
    await api('agents/settings', { method: 'PATCH', body: { autostart: true } });
  });

  it('shows the session’s output on the task, newest after what you’ve seen', async () => {
    const post = (entries) => api('tasks/PRD-1/session', { method: 'POST', body: { agent: 'claude-prd-1', entries } });
    expect(
      (
        await post([
          { kind: 'start', text: 'Session started' },
          { kind: 'tool', tool: 'Bash', title: 'Run the tests', detail: 'pnpm test', output: 'ok' },
          { kind: 'bogus', text: 'x' },
        ])
      ).status,
    ).toBe(201);
    const first = await body(await api('tasks/PRD-1/session'));
    expect(first.entries.map((e) => e.kind)).toEqual(['start', 'tool']);
    expect(first.live).toBe(true);
    expect(first.run).toMatchObject({
      agent: 'claude-prd-1',
      url: expect.stringMatching(/^https:\/\/claude\.ai\/code\//u),
    });
    await post([{ kind: 'message', text: `Done.${'x'.repeat(9000)}` }]);
    const more = await body(await api(`tasks/PRD-1/session?after=${first.entries.at(-1).id}`));
    expect(more.entries).toHaveLength(1);
    expect(more.entries[0].text.length).toBe(4000);
    const card = await task('PRD-1');
    expect(card.agentRun).toMatchObject({ agent: 'claude-prd-1', live: true });
  });

  it('takes no output from an agent that no longer holds the task, and says so', async () => {
    const before = (await body(await api('tasks/PRD-1/session'))).entries.length;
    const res = await api('tasks/PRD-1/session', {
      method: 'POST',
      body: { agent: 'claude-someone-else', entries: [{ kind: 'message', text: 'still here' }], messages: true },
    });
    expect(await body(res)).toMatchObject({ added: 0, messages: [], released: true });
    expect((await body(await api('tasks/PRD-1/session'))).entries).toHaveLength(before);
  });

  it('lists running agents with their latest line, and shows starts in Activity', async () => {
    const overview = await body(await api('agents'));
    expect(overview.connected).toBe(true);
    const prd = overview.running.find((r) => r.wid === 'PRD-1');
    expect(prd).toMatchObject({ agent: 'claude-prd-1', live: true, lastLine: expect.stringMatching(/^Done\./u) });
    expect(overview.budget.used).toBeGreaterThan(3);
    const { events } = await body(await api('activity'));
    const kinds = events
      .filter((e) => e.source === 'agents')
      .flatMap((e) => e.changes.filter((c) => c.kind.startsWith('agent_')).map((c) => `${c.kind}:${c.trigger}`));
    expect(kinds).toEqual(
      expect.arrayContaining([
        'agent_started:manual',
        'agent_started:next',
        'agent_started:auto',
        'agent_failed:manual',
      ]),
    );
  });
});

describe('cloud agents across repositories', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    routine.fail = null;
  });
  afterEach(() => spy.mockRestore());

  const overview = async () => body(await api('agents'));
  const settings = (patch) => api('agents/settings', { method: 'PATCH', body: patch });
  const caps = (slug, routineSettings) => api(`repos/${slug}`, { method: 'PATCH', body: { routine: routineSettings } });

  it('registers breakaway, with its own routine, and scratch, without one', async () => {
    expect(
      (
        await api('repos', {
          method: 'POST',
          body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK', 'ops:BOPS'] },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api('repos', {
          method: 'POST',
          body: { slug: 'scratch', github: 'acme/scratch', areas: ['product:SCR'] },
        })
      ).status,
    ).toBe(201);
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          {
            description: 'Breakaway landing page',
            project: 'product',
            repo: 'breakaway',
            tags: ['agent'],
            horizon: 'now',
            priority: 'H',
          },
          {
            description: 'Breakaway health check',
            project: 'ops',
            repo: 'breakaway',
            tags: ['agent'],
            horizon: 'now',
            priority: 'H',
          },
          {
            description: 'Breakaway docs',
            project: 'product',
            repo: 'breakaway',
            tags: ['agent'],
            horizon: 'now',
            priority: 'H',
          },
          {
            description: 'Scratch work',
            project: 'product',
            repo: 'scratch',
            tags: ['agent'],
            horizon: 'now',
            priority: 'H',
          },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['BRK-1', 'BOPS-1', 'BRK-2', 'SCR-1']);
    // Room for every test below: the shared limits are set where nothing in widgets is in the way.
    await settings({ max: 6, hourly: 30 });
    const { repos } = await overview();
    expect(repos.map((r) => [r.slug, r.connected])).toEqual([
      ['widgets', true],
      ['breakaway', true],
      ['scratch', false],
    ]);
  });

  it('keeps agents apart per repository and area, not across repositories', async () => {
    const { running } = await overview();
    // widgets has agents in Product (PRD-1) and Operations (OPS-2); breakaway's areas are its own.
    expect(running.map((r) => r.wid)).toEqual(expect.arrayContaining(['PRD-1', 'OPS-2']));
    const plan = await body(await api('agents/next', { method: 'POST', body: { count: 6, dryRun: true } }));
    expect(plan.started.map((t) => t.wid)).toEqual(expect.arrayContaining(['BRK-1', 'BOPS-1']));
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.wid, s.reason]));
    expect(reasons['BRK-2']).toMatch(/one Product task at a time/);
    expect(reasons['SCR-1']).toMatch(/scratch’s agent routine isn’t connected/);
    const only = await body(
      await api('agents/next', { method: 'POST', body: { count: 6, dryRun: true, repo: 'breakaway' } }),
    );
    expect(only.started.every((t) => t.repo === 'breakaway')).toBe(true);
  });

  it('starts a task through its own repository’s routine and names the repository in the payload', async () => {
    const res = await body(await start('BRK-1'));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ agent: 'claude-brk-1', repo: 'breakaway', status: 'started' });
    const fire = routine.fires.at(-1);
    expect(fire.url).toBe(FIRE_BREAKAWAY);
    expect(fire.auth).toBe('Bearer sk-ant-oat01-breakaway-routine-token');
    expect(fire.text).toContain('Task: BRK-1');
    expect(fire.text).toContain('Repository: breakaway (acme/breakaway)');
  });

  it('refuses a repository whose routine isn’t connected, and says how to connect it', async () => {
    const res = await body(await start('SCR-1'));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(
      /scratch’s agent routine isn’t connected yet: run npx breakaway agents-connect --repo scratch/,
    );
    expect((await task('SCR-1')).claim).toBeNull();
  });

  it('says which routine to connect again when a repository’s token is refused', async () => {
    routine.fail = { status: 401, message: 'bad token' };
    const res = await body(await start('BOPS-1'));
    expect(res.error).toMatch(/breakaway routine’s token was refused.*agents-connect --repo breakaway/);
    expect((await task('BOPS-1')).claim).toBeNull();
  });

  it('honours a repository’s cap on agents at once, under the shared limit', async () => {
    expect((await caps('breakaway', { max: 9 })).status).toBe(400);
    expect((await body(await caps('breakaway', { max: 1 }))).repo.routine).toEqual({ max: 1 });
    const res = await body(await start('BOPS-1'));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/1 agent is already running in breakaway \(its cap is 1\)/);
    const plan = await body(await api('agents/next', { method: 'POST', body: { count: 6, dryRun: true } }));
    expect(plan.skipped.find((s) => s.wid === 'BOPS-1').reason).toMatch(/its cap is 1/);
    // widgets isn't held back by breakaway's cap.
    expect(plan.started.every((t) => t.repo === 'widgets')).toBe(true);
  });

  it('honours a repository’s cap on starts an hour', async () => {
    // breakaway has two starts this hour: BRK-1, and the refused one.
    expect((await body(await caps('breakaway', { max: null, hourly: 2 }))).repo.routine).toEqual({ hourly: 2 });
    const res = await body(await start('BOPS-1'));
    expect(res.status).toBe(429);
    expect(res.error).toMatch(/2 agents were started in breakaway in the last hour, its cap/);
    const { repos } = await overview();
    expect(repos.find((r) => r.slug === 'breakaway')).toMatchObject({
      connected: true,
      running: 1,
      used: 2,
      caps: { max: null, hourly: 2 },
    });
    await caps('breakaway', null);
  });

  it('counts every repository’s agents against the shared slots and budget', async () => {
    const { running, budget } = await overview();
    expect(running.find((r) => r.wid === 'BRK-1')).toMatchObject({ repo: 'breakaway' });
    // The slots: widgets's agents and breakaway's fill the same ones.
    await settings({ max: running.length });
    let res = await body(await start('BOPS-1'));
    expect(res.error).toMatch(
      new RegExp(`${running.length} agents are already running \\(the limit is ${running.length}\\)`),
    );
    // The budget: breakaway's starts are in the board's hourly count.
    await settings({ max: 6, hourly: budget.used });
    res = await body(await start('BOPS-1'));
    expect(res.status).toBe(429);
    expect(res.error).toMatch(/the most the board starts/);
    await settings({ hourly: 30 });
    expect((await body(await start('BOPS-1'))).run.repo).toBe('breakaway');
  });

  it('starts Start-when-ready tasks per repository, and holds those whose routine isn’t connected', async () => {
    await api('tasks/SCR-1', { method: 'PATCH', body: { autostart: 'yes' } });
    await api('tasks/BRK-2', { method: 'PATCH', body: { autostart: 'yes' } });
    const { queue } = await overview();
    expect(queue.find((q) => q.wid === 'SCR-1')).toMatchObject({
      repo: 'scratch',
      ready: false,
      reason: expect.stringMatching(/scratch’s agent routine isn’t connected/),
    });
    expect(queue.find((q) => q.wid === 'BRK-2')).toMatchObject({
      repo: 'breakaway',
      ready: false,
      reason: expect.stringMatching(/already working in Product \(BRK-1\)/),
    });
  });

  it('fixes and reviews a pull request through the pull request’s own repository', async () => {
    const pull = (number, extra = {}) => ({
      number,
      title: `Pull ${number}`,
      state: 'open',
      draft: false,
      url: `https://github.com/acme/breakaway/pull/${number}`,
      author: 'claude[bot]',
      mergeable: false,
      mergeableState: 'dirty',
      checks: { state: 'success', total: 1, passed: 1, runs: [] },
      review: { decision: null, comments: 0 },
      closes: [],
      mentions: [],
      ...extra,
    });
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => {
      instance.sql.exec(
        "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('breakaway', 4, '2026-10-02T09:00:00Z', 'open', ?)",
        JSON.stringify(pull(4)),
      );
      instance.sql.exec(
        "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('breakaway', 5, '2026-10-02T09:00:00Z', 'open', ?)",
        JSON.stringify(pull(5, { author: 'dependabot[bot]', mergeableState: 'clean', mergeable: true })),
      );
    });
    // widgets has no #4: the number means breakaway's only with its repository.
    expect((await api('github/pulls/4/fix', { method: 'POST', body: {} })).status).toBe(404);
    expect((await api('github/pulls/4/fix', { method: 'POST', body: { repo: 'nowhere' } })).status).toBe(400);
    const fixed = await body(await api('github/pulls/4/fix?repo=breakaway', { method: 'POST', body: {} }));
    expect(fixed.status).toBe(200);
    expect(fixed.task).toMatchObject({
      wid: expect.stringMatching(/^BRK-/u),
      repo: 'breakaway',
      pr: '4',
      claim: expect.stringMatching(/-fix$/u),
    });
    expect(routine.fires.at(-1)).toMatchObject({
      url: FIRE_BREAKAWAY,
      text: expect.stringMatching(/Mode: fix-pr[\s\S]*Pull request: #4/),
    });
    expect(routine.fires.at(-1).text).toContain('Repository: breakaway (acme/breakaway)');

    await api('tasks/BOPS-1/done', { method: 'POST', body: {} }); // frees a slot
    const reviewed = await body(await api('github/pulls/5/review', { method: 'POST', body: { repo: 'breakaway' } }));
    expect(reviewed.status).toBe(200);
    expect(reviewed.task).toMatchObject({ repo: 'breakaway', pr: '5', claim: expect.stringMatching(/-check$/u) });
    expect(routine.fires.at(-1)).toMatchObject({ url: FIRE_BREAKAWAY, text: expect.stringMatching(/Mode: review/) });
  });
});
