import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdsTask, runState } from '../src/run-state.js';
import { api } from './helpers.js';

// WEB-41: every run says which state it's in, so a task and the Agents view can say what happens next.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const claude = { fail: null, headers: {}, next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      if (claude.fail)
        return new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'refused' } }), {
          status: claude.fail,
          headers: claude.headers,
        });
      const id = `session_r${String(claude.next++).padStart(3, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const start = (ref) => api('agents/start', { method: 'POST', body: { ref } });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const session = async (ref) => (await body(await api(`tasks/${ref}/session`))).run;
const overview = async () => body(await api('agents'));
const release = (wid) =>
  api(`tasks/${wid}/release`, { method: 'POST', body: { agent: `claude-${wid.toLowerCase()}` } });
const say = (wid, text) =>
  api(`tasks/${wid}/session`, {
    method: 'POST',
    body: { agent: `claude-${wid.toLowerCase()}`, entries: [{ kind: 'message', text }] },
  });
const meta = (key, value) => runInDurableObject(stub(), (instance) => instance.setMeta(key, value));
const reconnect = () =>
  runInDurableObject(stub(), (instance) => {
    const kept = JSON.parse(instance.meta('routine_hold:widgets'));
    instance.setMeta('routine_hold:widgets', JSON.stringify({ ...kept, routine: '0000000000000000' }));
  });
/** Moves time on: runs started and output came `minutes` earlier than they did. */
const later = (minutes) =>
  runInDurableObject(stub(), (instance) => {
    instance.sql.exec('UPDATE agent_runs SET started = started - ?', minutes * 60_000);
    instance.sql.exec('UPDATE agent_logs SET at = at - ?', minutes * 60_000);
  });

describe('runState', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const run = { status: 'started', started: now - 60_000, agent: 'claude-x-1', trigger: 'manual' };
  const ago = (min) => now - min * 60_000;

  it('says Starting until the session speaks, and late after 10 minutes', () => {
    expect(runState({ run, holding: true }, now)).toMatchObject({ id: 'starting', late: false });
    expect(runState({ run: { ...run, started: ago(11) }, holding: true }, now)).toMatchObject({
      id: 'starting',
      late: true,
    });
    expect(runState({ run: { ...run, status: 'starting' }, holding: false }, now).id).toBe('starting');
  });

  it('says Working, Quiet, and Silent from its output', () => {
    expect(runState({ run, holding: true, lastAt: ago(1) }, now).id).toBe('working');
    expect(runState({ run, holding: true, lastAt: ago(5) }, now)).toMatchObject({
      id: 'quiet',
      since: new Date(ago(5)).toISOString(),
    });
    expect(runState({ run: { ...run, silent: ago(31) }, holding: true, lastAt: ago(31) }, now)).toMatchObject({
      id: 'silent',
      since: new Date(ago(31)).toISOString(),
    });
  });

  it('says a run that let go of its task ended', () => {
    expect(runState({ run, holding: false, lastAt: ago(1) }, now)).toEqual({ id: 'ended' });
  });

  it('says Retrying until a limit ends, and whether it starts again by itself', () => {
    const limited = { ...run, status: 'failed', hold: 'limit', holdUntil: now + 120_000, error: 'limit' };
    expect(runState({ run: limited, holding: false }, now)).toMatchObject({
      id: 'retrying',
      until: new Date(now + 120_000).toISOString(),
      again: false,
    });
    expect(runState({ run: limited, holding: false, autostart: true }, now).again).toBe(true);
    expect(runState({ run: { ...limited, trigger: 'chase' }, holding: false }, now).again).toBe(true);
    // Past its time, nothing waits: it's a start that failed, to try again.
    expect(runState({ run: { ...limited, holdUntil: now - 1 }, holding: false }, now)).toMatchObject({
      id: 'failed',
      until: null,
    });
  });

  it('says Paused while the routine is, and Couldn’t start once it’s connected again', () => {
    const refused = { ...run, status: 'failed', hold: 'paused', error: 'the routine’s token was refused' };
    expect(runState({ run: refused, holding: false, paused: true }, now)).toEqual({
      id: 'paused',
      error: 'the routine’s token was refused',
    });
    expect(runState({ run: refused, holding: false, paused: false }, now).id).toBe('failed');
  });

  it('says Couldn’t start with the error, and when auto-start tries again after a backoff', () => {
    const failed = { ...run, status: 'failed', hold: 'backoff', holdUntil: now + 60_000, error: 'Claude couldn’t' };
    expect(runState({ run: failed, holding: false }, now)).toEqual({
      id: 'failed',
      error: 'Claude couldn’t',
      until: null,
      again: false,
    });
    expect(runState({ run: failed, holding: false, autostart: true }, now)).toMatchObject({
      until: new Date(now + 60_000).toISOString(),
      again: true,
    });
  });

  it('says Needs you over anything else, with what was tried', () => {
    expect(
      runState({ run, holding: true, lastAt: ago(1), needsYou: { kind: 'fix', pr: 7, tries: 2, at: ago(3) } }, now),
    ).toEqual({ id: 'needs-you', since: new Date(ago(3)).toISOString(), fix: { pr: 7, tries: 2 } });
    expect(
      runState({ run, holding: false, needsYou: { kind: 'ping', id: 4, message: 'Which one?', at: ago(2) } }, now),
    ).toMatchObject({ id: 'needs-you', ping: { id: 4, message: 'Which one?' } });
  });

  it('knows when a run still holds its task', () => {
    const t = { status: 'pending', claim: 'claude-x-1', github: [] };
    expect(holdsTask(run, t)).toBe(true);
    expect(holdsTask(run, { ...t, claim: null })).toBe(false);
    expect(holdsTask(run, { ...t, github: [{ closes: true, state: 'open' }] })).toBe(false);
    expect(holdsTask({ ...run, kind: 'fix-pr' }, { ...t, github: [{ closes: true, state: 'open' }] })).toBe(true);
  });
});

describe('a run’s state on the board (WEB-41)', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    claude.fail = null;
    claude.headers = {};
  });
  afterEach(() => spy.mockRestore());

  it('sets up tasks', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'One', project: 'ops', who: 'agent', horizon: 'now' },
          { description: 'Two', project: 'debt', who: 'agent', horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'DEBT-1']);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 6, hourly: 30 } });
  });

  it('shows a start that failed on its task, with the error', async () => {
    claude.fail = 500;
    expect((await start('OPS-1')).status).toBe(502);
    const t = await task('OPS-1');
    expect(t.claim).toBeNull();
    expect(t.agentRun).toMatchObject({
      status: 'failed',
      state: { id: 'failed', error: expect.stringMatching(/Claude couldn’t start the session \(500/), again: false },
    });
    const { recent } = await overview();
    expect(recent[0]).toMatchObject({ wid: 'OPS-1', state: { id: 'failed' } });
    await meta('routine_hold:widgets', null);
  });

  it('shows Paused after a refused token, and Couldn’t start once the routine is connected again', async () => {
    claude.fail = 401;
    await start('OPS-1');
    expect((await task('OPS-1')).agentRun.state).toMatchObject({
      id: 'paused',
      error: expect.stringMatching(/token was refused/),
    });
    expect((await overview()).recent[0].state.id).toBe('paused');
    // Connected again: the next look at the routines lets the hold go.
    await reconnect();
    await overview();
    expect((await task('OPS-1')).agentRun.state.id).toBe('failed');
    await meta('routine_hold:widgets', null);
  });

  it('shows Retrying until Claude’s Retry-After', async () => {
    claude.fail = 429;
    claude.headers = { 'Retry-After': '120' };
    await start('OPS-1');
    const { state } = (await task('OPS-1')).agentRun;
    expect(state).toMatchObject({ id: 'retrying', again: false });
    expect(Date.parse(state.until) - Date.now()).toBeGreaterThan(100_000);
    await meta('routine_hold:widgets', null);
  });

  it('follows a started run through Starting, Working, Quiet, Silent, and ended', async () => {
    expect((await body(await start('OPS-1'))).status).toBe(200);
    expect((await task('OPS-1')).agentRun.state).toMatchObject({ id: 'starting', late: false });
    expect((await session('OPS-1')).state.id).toBe('starting');
    await say('OPS-1', 'Reading the task');
    expect((await task('OPS-1')).agentRun.state.id).toBe('working');
    const running = (await overview()).running.find((r) => r.wid === 'OPS-1');
    expect(running.state.id).toBe('working');
    await later(5);
    expect((await session('OPS-1')).state.id).toBe('quiet');
    await later(30);
    await runInDurableObject(stub(), (instance) => instance.silentTick());
    expect((await task('OPS-1')).agentRun.state.id).toBe('silent');
    // Silent's own ping is the Silent state, not Needs you.
    expect((await overview()).running.find((r) => r.wid === 'OPS-1').state.id).toBe('silent');
    await release('OPS-1');
    expect((await task('OPS-1')).agentRun.state).toEqual({ id: 'ended' });
  });

  it('shows Needs you while an agent’s ping is open', async () => {
    expect((await body(await start('DEBT-1'))).status).toBe(200);
    const res = await api('tasks/DEBT-1/pings', {
      method: 'POST',
      body: { by: 'claude-debt-1', kind: 'question', message: 'Which colour should the button be?' },
    });
    expect(res.status).toBe(201);
    expect((await task('DEBT-1')).agentRun.state).toMatchObject({
      id: 'needs-you',
      ping: { message: 'Which colour should the button be?' },
    });
    expect((await overview()).running.find((r) => r.wid === 'DEBT-1').state.id).toBe('needs-you');
    // Only the latest run on a task can need you.
    const { recent } = await overview();
    expect(recent.filter((r) => r.wid === 'OPS-1').every((r) => r.state.id !== 'needs-you')).toBe(true);
  });
});
