import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// BRK-145: a session that goes silent, and repeated fixes on one pull request, reach the owner once.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const routine = { fires: [], next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      routine.fires.push(JSON.parse(init.body).text);
      const id = `session_s${String(routine.next++).padStart(3, '0')}`;
      return Response.json({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const pings = async () => (await body(await api('pings'))).pings;
const silentTick = () => runInDurableObject(stub(), (instance) => instance.silentTick());
const fixesTick = () => runInDurableObject(stub(), (instance) => instance.fixesTick());
const fixes = (number) => runInDurableObject(stub(), (instance) => instance.prFixes('widgets', number));
const fix = (number, payload = {}) => api(`github/pulls/${number}/fix`, { method: 'POST', body: payload });
const say = (wid, agent, text) =>
  api(`tasks/${wid}/session`, { method: 'POST', body: { agent, entries: [{ kind: 'message', text }] } });

/** Moves time on: runs started and output came `minutes` earlier than they did. */
async function later(minutes) {
  const ms = minutes * 60_000;
  await runInDurableObject(stub(), (instance) => {
    instance.sql.exec('UPDATE agent_runs SET started = started - ?', ms);
    instance.sql.exec('UPDATE agent_logs SET at = at - ?', ms);
  });
}

/** An open pull request that closes `wid`, as the reconcile stores it: clean, conflicting, or failing. */
async function pull(number, wid, { head = 'aaa', problem = null } = {}) {
  await runInDurableObject(stub(), (instance) => {
    instance.sql.exec(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', ?, '2026-10-05T09:00:00Z', 'open', ?)",
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

describe('a silent session (BRK-145)', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('sets up a task and starts an agent on it', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Quiet one', project: 'ops', who: 'agent', horizon: 'now' },
          { description: 'Fix target', project: 'product', who: 'agent', horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'PRD-1']);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 10, hourly: 30 } });
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: 'OPS-1' } }));
    expect(started.run).toMatchObject({ agent: 'claude-ops-1', status: 'started', silentSince: null });
  });

  it('isn’t Silent before 30 minutes', async () => {
    await later(29);
    await silentTick();
    expect(await pings()).toEqual([]);
    expect((await task('OPS-1')).agentRun.silentSince).toBeNull();
  });

  it('is Silent after 30 minutes with nothing, pings the owner once, and keeps its claim and slot', async () => {
    await later(2);
    await silentTick();
    await silentTick();
    const open = await pings();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ task: 'OPS-1', kind: 'blocked', by: 'board', push: true });
    expect(open[0].message).toMatch(/claude-ops-1 has said nothing for over 30 minutes on OPS-1/);
    expect(open[0].message).toContain('https://claude.ai/code/session_s001');
    const t = await task('OPS-1');
    expect(t.claim).toBe('claude-ops-1');
    expect(t.agentRun.silentSince).toEqual(t.agentRun.startedAt);
    expect(t.comments.at(-1)).toMatchObject({ by: 'board' });
    expect(t.comments.at(-1).text).toMatch(/^Ping \(blocked\): claude-ops-1 has said nothing/);
    const { running } = await body(await api('agents'));
    expect(running.find((r) => r.wid === 'OPS-1')).toMatchObject({ silentSince: t.agentRun.startedAt });
  });

  it('clears Silent when the session says something, and resolves its ping', async () => {
    await say('OPS-1', 'claude-ops-1', 'back again');
    expect((await task('OPS-1')).agentRun.silentSince).toBeNull();
    expect(await pings()).toEqual([]);
    const { running } = await body(await api('agents'));
    expect(running.find((r) => r.wid === 'OPS-1').silentSince).toBeNull();
  });

  it('goes Silent again after another 30 minutes, without a second ping for the same run', async () => {
    await later(31);
    await silentTick();
    expect((await task('OPS-1')).agentRun.silentSince).not.toBeNull();
    expect(await pings()).toEqual([]);
  });

  it('leaves a run on a pull request alone while its checks run', async () => {
    await api('tasks/OPS-1/release', { method: 'POST', body: { agent: 'claude-ops-1' } });
    await pull(51, 'PRD-1', { problem: 'conflicts' });
    expect((await body(await fix(51))).run).toMatchObject({ agent: 'claude-prd-1-fix' });
    await runInDurableObject(stub(), (instance) => {
      const row = instance.sql.exec('SELECT data FROM gh_pulls WHERE number = 51').one();
      const data = JSON.parse(row.data);
      instance.sql.exec(
        'UPDATE gh_pulls SET data = ? WHERE number = 51',
        JSON.stringify({ ...data, mergeable: true, mergeableState: 'clean', checks: { state: 'pending', runs: [] } }),
      );
    });
    await later(45);
    await silentTick();
    expect((await task('PRD-1')).agentRun.silentSince).toBeNull();
    expect((await pings()).filter((p) => p.task === 'PRD-1')).toEqual([]);
  });
});

describe('repeated fixes on one pull request (BRK-145)', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  /** The fix agent before stopped: it's no longer live or starting, so the next fix can take over. */
  const stopped = () => later(15);

  it('sets up a task with a conflicting pull request', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: 'Fix twice', project: 'brand', who: 'agent', horizon: 'now' }],
      }),
    );
    expect(res.tasks[0].wid).toBe('BRD-1');
    await pull(61, 'BRD-1', { head: 'one', problem: 'conflicts' });
  });

  it('starts the first two fixes', async () => {
    expect((await body(await fix(61))).run).toMatchObject({ agent: 'claude-brd-1-fix', status: 'started' });
    await stopped();
    await pull(61, 'BRD-1', { head: 'two', problem: 'failing' });
    expect((await body(await fix(61))).run).toMatchObject({ agent: 'claude-brd-1-fix', status: 'started' });
    await stopped();
    expect(await fixes(61)).toEqual({ tries: 2, needsYou: null });
  });

  it('refuses a third with Needs you, and pings once', async () => {
    const before = routine.fires.length;
    const third = await body(await fix(61));
    expect(third.status).toBe(409);
    expect(third.forceable).toBe(true);
    expect(third.error).toMatch(/Needs you: 2 fix agents on #61 didn’t get it green/);
    expect(routine.fires).toHaveLength(before);
    const again = await body(await fix(61));
    expect(again.status).toBe(409);
    const open = (await pings()).filter((p) => p.task === 'BRD-1');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'blocked', by: 'board', push: true });
    expect(open[0].message).toMatch(/#61 still has failing checks after 2 fix agents/);
    const counted = await fixes(61);
    expect(counted.tries).toBe(2);
    expect(counted.needsYou).toEqual(expect.any(String));
    const { needsYou } = await body(await api('agents'));
    expect(needsYou).toEqual([
      expect.objectContaining({ repo: 'widgets', pr: 61, wid: 'BRD-1', tries: 2, since: counted.needsYou }),
    ]);
  });

  it('lets the owner force a third', async () => {
    const forced = await body(await fix(61, { force: true, by: 'owner' }));
    expect(forced.run).toMatchObject({ agent: 'claude-brd-1-fix', status: 'started', forced: true });
    await stopped();
  });

  it('starts counting again once the pull request is green', async () => {
    await pull(61, 'BRD-1', { head: 'three' });
    await fixesTick();
    expect(await fixes(61)).toEqual({ tries: 0, needsYou: null });
    await pull(61, 'BRD-1', { head: 'four', problem: 'conflicts' });
    expect((await body(await fix(61))).run).toMatchObject({ status: 'started' });
  });
});
