import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, releaseRoutineHolds } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
const fires = [];
let claudeRefuses = false;

const start = (ref, extra = {}) => api('agents/start', { method: 'POST', body: { ref, ...extra } });
const settings = (patch) => api('agents/settings', { method: 'PATCH', body: patch });
const overview = async () => body(await api('agents'));

describe('force start', () => {
  let spy;
  beforeEach(() => {
    claudeRefuses = false;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE && url !== FIRE_BREAKAWAY) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      if (claudeRefuses)
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Retry-After': '600' },
        });
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  it('sets up tasks to start', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'One', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Two', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Three', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Four', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Five', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Owner only', project: 'ops', tags: ['owner'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-5', 'OPS-6']);
  });

  it('refuses at the limit on agents at once, says Force start could skip it, and skips it when forced', async () => {
    await settings({ max: 1 });
    expect((await body(await start('OPS-1'))).status).toBe(200);
    const refused = await body(await start('OPS-2'));
    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(/1 agent.* already running/);
    expect(refused.forceable).toBe(true);
    const forced = await body(await start('OPS-2', { force: true }));
    expect(forced.status).toBe(200);
    expect(forced.run).toMatchObject({ agent: 'claude-ops-2', forced: true });
    // A start that wasn't forced says so.
    expect((await body(await api('agents'))).recent.find((r) => r.wid === 'OPS-1').forced).toBe(false);
  });

  it('skips the board’s starts an hour, but still counts the start', async () => {
    const { budget } = await overview();
    await settings({ max: 6, hourly: budget.used });
    const refused = await body(await start('OPS-3'));
    expect(refused.status).toBe(429);
    expect(refused.forceable).toBe(true);
    expect((await body(await start('OPS-3', { force: true }))).run.forced).toBe(true);
    expect((await overview()).budget.used).toBe(budget.used + 1);
    await settings({ hourly: 30 });
  });

  it('skips a repository’s own caps on a build and on a pull request fix', async () => {
    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
    });
    expect(registered.status).toBe(201);
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Docs', project: 'product', repo: 'breakaway', tags: ['agent'], horizon: 'now' },
        { description: 'Landing', project: 'product', repo: 'breakaway', tags: ['agent'], horizon: 'now' },
      ],
    });
    await settings({ max: 6 });
    const caps = (routineSettings) => api('repos/breakaway', { method: 'PATCH', body: { routine: routineSettings } });
    await caps({ max: 1 });
    expect((await body(await start('BRK-1'))).status).toBe(200);
    const refused = await body(await start('BRK-2'));
    expect(refused.error).toMatch(/its cap is 1/);
    expect(refused.forceable).toBe(true);
    expect((await body(await start('BRK-2', { force: true }))).run).toMatchObject({ repo: 'breakaway', forced: true });

    // The starts an hour cap, on a fix for a pull request.
    await caps({ max: null, hourly: 1 });
    const pull = {
      number: 4,
      title: 'Pull 4',
      state: 'open',
      draft: false,
      url: 'https://github.com/acme/breakaway/pull/4',
      author: 'claude[bot]',
      mergeable: false,
      mergeableState: 'dirty',
      checks: { state: 'success', total: 1, passed: 1, runs: [] },
      review: { decision: null, comments: 0 },
      closes: [],
      mentions: [],
    };
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => {
      instance.sql.exec(
        "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('breakaway', 4, '2026-10-02T09:00:00Z', 'open', ?)",
        JSON.stringify(pull),
      );
    });
    const fix = (extra) => api('github/pulls/4/fix?repo=breakaway', { method: 'POST', body: { ...extra } });
    const held = await body(await fix());
    expect(held.status).toBe(429);
    expect(held.error).toMatch(/its cap/);
    expect(held.forceable).toBe(true);
    const forcedFix = await body(await fix({ force: true }));
    expect(forcedFix.status).toBe(200);
    expect(forcedFix.run).toMatchObject({ kind: 'fix-pr', forced: true });
    await caps(null);
  });

  it('never skips Claude’s limit: its 429 still refuses a forced start, with its Retry-After', async () => {
    await settings({ max: 6 });
    claudeRefuses = true;
    const res = await body(await start('OPS-4', { force: true }));
    expect(res.status).toBe(429);
    expect(res.error).toMatch(/Claude’s hourly limit/);
    expect(res.error).toMatch(/600/);
    expect(res.forceable).toBeUndefined();
    await releaseRoutineHolds();
  });

  it('never skips what makes a start wrong: a task that is claimed, done, or not an agent’s', async () => {
    await api('tasks/OPS-5/claim', { method: 'POST', body: { agent: 'someone' } });
    const claimed = await body(await start('OPS-5', { force: true }));
    expect(claimed.status).toBe(409);
    expect(claimed.forceable).toBeUndefined();
    const owner = await body(await start('OPS-6', { force: true }));
    expect(owner.error).toMatch(/isn’t tagged \+agent/);
    expect(owner.forceable).toBeUndefined();
  });

  it('refuses a forced start signed by an agent', async () => {
    const res = await body(await start('OPS-4', { force: true, by: 'claude-ops-1' }));
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/only the owner/);
  });

  it('records forced starts in Activity and in the Agents view', async () => {
    const { events } = await body(await api('activity'));
    const started = events
      .filter((e) => e.source === 'agents')
      .flatMap((e) => e.changes.filter((c) => c.kind === 'agent_started'));
    expect(started.some((c) => c.forced === true)).toBe(true);
    expect(started.some((c) => c.forced === undefined || c.forced === false)).toBe(true);
    const { running } = await overview();
    expect(running.find((r) => r.wid === 'OPS-2')).toMatchObject({ forced: true });
    expect(running.find((r) => r.wid === 'OPS-1')).toMatchObject({ forced: false });
  });

  it('skips a routine’s daily caps on a run, and not a routine that is off', async () => {
    const make = (slug, extra = {}) =>
      api('routines', { method: 'POST', body: { slug, name: `Routine ${slug}`, prompt: 'Do the thing.', ...extra } });
    expect((await make('daily', { dailyCap: 1 })).status).toBe(201);
    const run = (extra) => api('routines/daily/run', { method: 'POST', body: { ...extra } });
    for (const ref of ['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'BRK-1', 'BRK-2'])
      await api(`tasks/${ref}/done`, { method: 'POST', body: {} });
    await settings({ max: 6, hourly: 30 });
    const first = await body(await run());
    expect(first.error ?? '').toBe('');
    await api('tasks/RUN-1/done', { method: 'POST', body: {} });
    const capped = await body(await run());
    expect(capped.status).toBe(429);
    expect(capped.error).toMatch(/daily cap/);
    expect(capped.forceable).toBe(true);
    const forced = await body(await run({ force: true }));
    expect(forced.status).toBe(200);
    expect(forced.run).toMatchObject({ kind: 'routine', forced: true });
    await api('tasks/RUN-2/done', { method: 'POST', body: {} });
    await api('routines/daily', { method: 'PATCH', body: { enabled: false } });
    const off = await body(await run({ force: true }));
    expect(off.status).toBe(409);
    expect(off.forceable).toBeUndefined();
  });
});
