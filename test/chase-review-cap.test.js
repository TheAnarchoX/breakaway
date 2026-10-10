import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// BRK-276: a chase waits for its owner. At its review cap (pull requests it opened that wait on the owner: open,
// checks done, nothing for an agent to fix) it starts nothing new, fix agents still run, and it resumes as the owner
// merges or closes them.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const routine = { fires: [], next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      routine.fires.push(JSON.parse(init.body).text);
      const id = `session_r${String(routine.next++).padStart(3, '0')}`;
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
const tick = () => runInDurableObject(stub(), (instance) => instance.chaseTick());
const fixes = () => routine.fires.filter((text) => text.includes('Mode: fix-pr'));
const builds = () => routine.fires.filter((text) => !text.includes('Mode: '));
const queued = async (wid) => (await feature('cap')).chase.queue.find((q) => q.wid === wid);

/** A pull request that closes `wid`, as the reconcile stores it: open and clean, open with checks running, conflicting, or closed. */
async function pull(number, wid, { head = `h${number}`, how = 'clean' } = {}) {
  await runInDurableObject(stub(), (instance) => {
    const state = how === 'closed' ? 'closed' : 'open';
    instance.sql.exec(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', ?, '2026-10-02T09:00:00Z', ?, ?)",
      number,
      state,
      JSON.stringify({
        number,
        title: `Pull ${number}`,
        state,
        draft: false,
        url: `https://github.com/acme/widgets/pull/${number}`,
        author: 'claude[bot]',
        headSha: head,
        mergeable: how !== 'conflicts',
        mergeableState: how === 'conflicts' ? 'dirty' : 'clean',
        checks:
          how === 'running'
            ? { state: 'pending', total: 1, passed: 0, runs: [] }
            : { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
        closes: [wid],
        mentions: [],
      }),
    );
  });
}

/** Moves time on, so a problem the chase saw is past its grace. */
async function later(minutes) {
  const ms = minutes * 60_000;
  await runInDurableObject(stub(), (instance) => {
    instance.sql.exec('UPDATE agent_runs SET started = started - ?', ms);
    instance.sql.exec('UPDATE agent_logs SET at = at - ?', ms);
    instance.sql.exec('UPDATE chase_fixes SET seen = seen - ?', ms);
  });
}

describe('a chase waits for its owner at its review cap', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('has a cap of 5 by default, which only the owner sets, from 1 to 50', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: ['One', 'Two', 'Three'].map((n) => ({
          description: `Ops ${n.toLowerCase()}`,
          project: 'ops',
          who: 'agent',
          tags: ['cap'],
          horizon: 'now',
        })),
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3']);
    expect((await api('features', { method: 'POST', body: { slug: 'cap' } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } });
    expect((await feature('cap')).chase).toMatchObject({ reviewCap: 5 });
    for (const reviewCap of [0, 51, 2.5, 'x'])
      expect(await chase('cap', { reviewCap })).toMatchObject({
        status: 400,
        error: expect.stringMatching(/^reviewCap is how many of the chase’s pull requests may wait for you/u),
      });
    expect((await chase('cap', { reviewCap: 2, by: 'claude-x' })).status).toBe(403);
    // Set before pressing Chase: the next chase keeps it.
    expect((await chase('cap', { reviewCap: 2 })).chase).toMatchObject({ state: 'off', reviewCap: 2 });
    expect((await chase('cap', { on: true, parallel: 6 })).started).toEqual(['OPS-1', 'OPS-2', 'OPS-3']);
  });

  it('counts only pull requests that wait on the owner: open, checks done, nothing to fix', async () => {
    await pull(41, 'OPS-1');
    await pull(42, 'OPS-2', { how: 'running' });
    await pull(43, 'OPS-3', { how: 'conflicts' });
    expect((await feature('cap')).chase.review).toEqual({ waiting: 1, cap: 2, full: false, pulls: [41] });
  });

  it('starts nothing new at the cap and says why, on its line and on each task it holds', async () => {
    await pull(42, 'OPS-2');
    await api('tasks', {
      method: 'POST',
      body: [{ description: 'Ops four', project: 'ops', who: 'agent', tags: ['cap'], horizon: 'now' }],
    });
    const before = builds().length;
    await tick();
    expect(builds()).toHaveLength(before);
    const f = await feature('cap');
    expect(f.chase.review).toMatchObject({ waiting: 2, cap: 2, full: true });
    expect(f.chase.summary).toContain(
      '2 pull requests wait for you: the chase starts nothing new until you merge or close one',
    );
    expect(await queued('OPS-4')).toMatchObject({
      ready: false,
      reason:
        '2 of the chase’s pull requests wait for you, the most it lets wait: it starts more as you merge or close them',
    });
    // The roadmap's feature list carries it too, for the timeline's bar.
    const { features } = await body(await api('features'));
    expect(features.find((x) => x.slug === 'cap').chase.review).toMatchObject({ waiting: 2, full: true });
    // A dry run says the same.
    expect((await chase('cap', { dryRun: true })).wouldStart).toEqual([]);
  });

  it('still starts fix agents on its conflicting pull requests', async () => {
    // Its own agent went quiet an hour ago; the chase sees #43's conflict, then gives it the grace.
    await later(60);
    await tick();
    await later(4);
    await tick();
    expect(fixes()).toHaveLength(1);
    expect(fixes()[0]).toContain('Pull request: #43');
    expect(await queued('OPS-4')).toMatchObject({ ready: false });
  });

  it('follows a new cap on the next tick, and resumes as the owner merges or closes them', async () => {
    const before = builds().length;
    await pull(41, 'OPS-1', { how: 'closed' });
    await tick();
    expect(builds()).toHaveLength(before + 1);
    expect(builds().at(-1)).toContain('Task: OPS-4\n');
    expect((await feature('cap')).chase.review).toMatchObject({ waiting: 1, full: false });
    const raised = await chase('cap', { reviewCap: 1 });
    expect(raised.chase).toMatchObject({ reviewCap: 1, review: { waiting: 1, cap: 1, full: true } });
  });
});
