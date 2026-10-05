import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryAt } from '../src/store-agents.js';
import { routineFix } from '../src/connections.js';
import { api, releaseRoutineHolds } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

/** Claude's /fire: `fail` is the status it answers with until it's null. */
const claude = { fires: [], fail: null, headers: {}, next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      claude.fires.push(JSON.parse(init.body).text);
      if (claude.fail)
        return new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'refused' } }), {
          status: claude.fail,
          headers: claude.headers,
        });
      const id = `session_${String(claude.next++).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return new Response('{"message":"Not Found"}', { status: 404 }); // GitHub, during alarms
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
/** One run of the alarm, whether or not one is scheduled, as the cron's would. */
const tick = () => runInDurableObject(stub(), (instance) => instance.alarm());
const start = (ref) => api('agents/start', { method: 'POST', body: { ref } });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const queued = async (wid) => (await body(await api('agents'))).queue.find((q) => q.wid === wid);
const fired = (wid) => claude.fires.filter((text) => text.includes(`Task: ${wid}\n`));
const routineRow = async () =>
  (await body(await api('connections'))).connections.find((c) => c.id === 'claude.routine');
const hold = () =>
  runInDurableObject(stub(), (instance) => JSON.parse(instance.meta('routine_hold:widgets') ?? 'null'));
/** Moves the hold's wait into the past, as if its time ran out. */
const waitOut = () =>
  runInDurableObject(stub(), (instance) => {
    const kept = JSON.parse(instance.meta('routine_hold:widgets'));
    instance.setMeta('routine_hold:widgets', JSON.stringify({ ...kept, until: Date.now() - 1 }));
  });
/** Gives the hold another routine's hash, as if the routine were connected again with a new URL or token. */
const reconnect = () =>
  runInDurableObject(stub(), (instance) => {
    const kept = JSON.parse(instance.meta('routine_hold:widgets'));
    instance.setMeta('routine_hold:widgets', JSON.stringify({ ...kept, routine: '0000000000000000' }));
  });
/** Turns Start when ready off on `wid`, then lets its agent go, so nothing starts it again. */
const settle = async (wid) => {
  await api(`tasks/${wid}`, { method: 'PATCH', body: { autostart: '' } });
  await release(wid);
};
const release = (wid) =>
  api(`tasks/${wid}/release`, { method: 'POST', body: { agent: `claude-${wid.toLowerCase()}` } });

describe('a routine Claude refuses (BRK-144)', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    claude.fail = null;
    claude.headers = {};
  });
  afterEach(() => spy.mockRestore());

  it('reads Retry-After as seconds or a date, and waits 15 minutes when it says nothing', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(retryAt('600', now)).toBe(now + 600_000);
    expect(retryAt('Mon, 05 Oct 2026 12:30:00 GMT', now)).toBe(Date.parse('2026-10-05T12:30:00Z'));
    expect(retryAt(null, now)).toBe(now + 15 * 60_000);
    expect(retryAt('soon', now)).toBe(now + 15 * 60_000);
  });

  it('gives 403 and 404 their own fixes', () => {
    expect(routineFix('the routine’s token has no access to it: make a new token')).toMatch(/new API token/);
    expect(routineFix('the routine is gone on claude.ai: make it again')).toMatch(/make the routine again/);
  });

  it('sets up tasks that start by themselves', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'One', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Two', project: 'debt', tags: ['agent'], horizon: 'now' },
          { description: 'Three', project: 'product', tags: ['agent'], horizon: 'now' },
          { description: 'Four', project: 'compliance', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'DEBT-1', 'PRD-1', 'CMP-1']);
    // Room for every start this file makes in an hour, so only Claude's answers hold them.
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 6, hourly: 30 } });
  });

  for (const [status, words] of [
    [401, /token was refused/],
    [403, /has no access/],
    [404, /is gone on claude\.ai/],
  ]) {
    it(`pauses auto-start on a ${status}, says why with its fix, and resumes once it's connected again`, async () => {
      claude.fail = status;
      const refused = await body(await start('OPS-1'));
      expect(refused.error).toMatch(words);
      expect(await hold()).toMatchObject({ kind: 'paused', status: 502 });

      // Start when ready waits, saying why, and no tick fires it.
      await api('tasks/DEBT-1', { method: 'PATCH', body: { autostart: 'yes' } });
      expect(await queued('DEBT-1')).toMatchObject({
        ready: false,
        forceable: false,
        reason: expect.stringMatching(/paused because Claude refused it/),
      });
      const before = claude.fires.length;
      await tick();
      await tick();
      expect(claude.fires).toHaveLength(before);

      const row = await routineRow();
      expect(row).toMatchObject({ state: 'attention', hold: { kind: 'paused', until: null } });
      expect(row.detail).toMatch(/^paused: .*auto-start and chase start nothing here until it’s connected again/);
      expect(row.fix).toMatch(status === 404 ? /make the routine again/ : /new API token/);

      // Connected again (its URL or token changed): it starts by itself on the next tick.
      claude.fail = null;
      await reconnect();
      await tick();
      expect(await hold()).toBeNull();
      expect((await task('DEBT-1')).claim).toBe('claude-debt-1');
      expect((await routineRow()).hold).toBeUndefined();
      await settle('DEBT-1');
    });
  }

  it('lets the owner start by hand while paused, and a start that works ends the pause', async () => {
    claude.fail = 401;
    await start('OPS-1');
    expect((await hold())?.kind).toBe('paused');
    claude.fail = null;
    expect((await body(await start('OPS-1'))).status).toBe(200);
    expect(await hold()).toBeNull();
    await release('OPS-1');
  });

  it('ends the pause when a session the routine started verifies it', async () => {
    claude.fail = 401;
    await start('OPS-1');
    await runInDurableObject(stub(), (instance) => {
      instance.setMeta('routine_verified:widgets', JSON.stringify({ at: Date.now() + 1, task: 'x' }));
    });
    expect(await hold()).not.toBeNull();
    await api('tasks/PRD-1', { method: 'PATCH', body: { autostart: 'yes' } });
    claude.fail = null;
    await tick();
    expect((await task('PRD-1')).claim).toBe('claude-prd-1');
    await settle('PRD-1');
    await runInDurableObject(stub(), (instance) => instance.setMeta('routine_verified:widgets', null));
    await releaseRoutineHolds();
  });

  it('holds every start after a 429 until its Retry-After, then starts again', async () => {
    claude.fail = 429;
    claude.headers = { 'Retry-After': '120' };
    const refused = await body(await start('OPS-1'));
    expect(refused.status).toBe(429);
    expect(refused.error).toMatch(/hourly limit.*120 seconds, at \d\d:\d\d UTC/);
    expect(await hold()).toMatchObject({ kind: 'limit' });

    // Neither a start by hand nor a tick fires before then.
    claude.fail = null;
    const before = claude.fires.length;
    const held = await body(await start('OPS-1'));
    expect(held.status).toBe(429);
    expect(held.error).toMatch(/hourly limit/);
    await api('tasks/CMP-1', { method: 'PATCH', body: { autostart: 'yes' } });
    expect((await queued('CMP-1')).reason).toMatch(
      /Claude’s limit for starting sessions: starts in widgets wait until/,
    );
    await tick();
    expect(claude.fires).toHaveLength(before);
    const row = await routineRow();
    expect(row.hold).toMatchObject({ kind: 'limit', until: expect.any(String) });
    expect(row.detail).toMatch(/auto-start and chase wait until \d\d:\d\d UTC/);

    await waitOut();
    await tick();
    expect((await task('CMP-1')).claim).toBe('claude-cmp-1');
    await settle('CMP-1');
  });

  it('backs off after any other refusal instead of firing every tick', async () => {
    claude.fail = 500;
    const earlier = fired('DEBT-1').length;
    await api('tasks/DEBT-1', { method: 'PATCH', body: { autostart: 'yes' } });
    await tick();
    expect(fired('DEBT-1')).toHaveLength(earlier + 1);
    expect(await hold()).toMatchObject({ kind: 'backoff' });
    await tick();
    await tick();
    expect(fired('DEBT-1')).toHaveLength(earlier + 1);
    expect((await queued('DEBT-1')).reason).toMatch(/the last start in widgets failed .*try again at/);

    // Once the few minutes pass, auto-start tries again by itself.
    await waitOut();
    claude.fail = null;
    await tick();
    expect(fired('DEBT-1')).toHaveLength(earlier + 2);
    expect((await task('DEBT-1')).claim).toBe('claude-debt-1');
    await settle('DEBT-1');
  });

  it('pauses a chase on a refused routine: its tasks wait for you, and nothing fires', async () => {
    expect((await api('features', { method: 'POST', body: { slug: 'speed' } })).status).toBe(201);
    const made = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Fast one', project: 'product', tags: ['agent', 'speed'], horizon: 'now' },
          { description: 'Fast two', project: 'compliance', tags: ['agent', 'speed'], horizon: 'now' },
        ],
      }),
    );
    expect(made.tasks.map((t) => t.wid)).toEqual(['PRD-2', 'CMP-2']);
    claude.fail = 404;
    const res = await body(await api('features/speed/chase', { method: 'POST', body: { on: true } }));
    // The first start is refused; the second, in the same tick, isn't fired at all.
    expect(res.started).toEqual([]);
    expect(claude.fires.filter((t) => /Task: (PRD|CMP)-2\n/.test(t))).toHaveLength(1);
    const before = claude.fires.length;
    await tick();
    await tick();
    expect(claude.fires).toHaveLength(before);
    const { feature } = await body(await api('features/speed'));
    expect(feature.chase.needsYou).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ wid: 'PRD-2', kind: 'connect', why: expect.stringMatching(/paused/) }),
        expect.objectContaining({ wid: 'CMP-2', kind: 'connect' }),
      ]),
    );

    claude.fail = null;
    await reconnect();
    await tick();
    expect((await task('PRD-2')).claim).toBe('claude-prd-2');
    expect((await task('CMP-2')).claim).toBe('claude-cmp-2');
  });
});
