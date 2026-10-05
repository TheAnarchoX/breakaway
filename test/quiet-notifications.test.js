import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// BRK-219: the board tells the owner what needs them, not what fixes itself. A GitHub outage says so when it
// ends, a chase waiting only on pull requests set to merge when green doesn't ping, and a session that went
// quiet while GitHub was down isn't Silent yet.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const routine = { fires: [], next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      routine.fires.push(JSON.parse(init.body).text);
      const id = `session_q${String(routine.next++).padStart(3, '0')}`;
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
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
/** Points the store at a pretend status page (the test config turns it off) for `fn`. */
const withPage = (fn) =>
  inStore(async (s) => {
    const saved = s.env.TASKS_GITHUB_STATUS;
    s.env.TASKS_GITHUB_STATUS = 'https://status.acme.example';
    try {
      return await fn(s);
    } finally {
      s.env.TASKS_GITHUB_STATUS = saved;
    }
  });
const inbox = async () => body(await api('pings'));
const chase = async (slug, input = {}) => body(await api(`features/${slug}/chase`, { method: 'POST', body: input }));
const feature = async (slug) => (await body(await api(`features/${slug}`))).feature;
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;

/** GitHub's status page as the board last read it: down, or working again. */
const githubDown = (down) =>
  inStore((s) =>
    s.setMeta(
      'gh_status',
      JSON.stringify({
        disrupted: down,
        components: [{ name: 'Actions', status: down ? 'major_outage' : 'operational' }],
        affected: down ? ['Actions'] : [],
        incidents: [],
        checked: Date.now(),
        at: Date.now(),
        since: down ? Date.now() : null,
        error: null,
      }),
    ),
  );

/** The GitHub's status row, as Connections reports it, needing attention or working, since `minutes` ago. */
const statusRow = (state, minutes) =>
  inStore((s) => {
    const since = Date.now() - minutes * 60_000;
    s.connectionsNotify(
      [{ id: 'github.status', repo: null, name: 'GitHub’s status', state, detail: `Actions: ${state}` }],
      new Map([['github.status', { since }]]),
    );
  });
const statusNotes = async () => (await inbox()).notices.filter((n) => n.connection === 'github.status');

/** An open pull request that closes `wid`, green, and set to merge by itself when `autoMerge`. */
async function openPull(number, wid, { autoMerge = false, review = null } = {}) {
  await inStore((s) =>
    s.sql.exec(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', ?, '2026-10-05T09:00:00Z', 'open', ?)",
      number,
      JSON.stringify({
        number,
        title: `Pull ${number}`,
        state: 'open',
        draft: false,
        url: `https://github.com/acme/widgets/pull/${number}`,
        author: 'claude[bot]',
        headSha: 'abc1234',
        mergeable: true,
        mergeableState: review === 'changes_requested' ? 'blocked' : 'clean',
        checks: { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: review, comments: 0 },
        autoMerge: autoMerge ? { method: 'SQUASH' } : null,
        closes: [wid],
        mentions: [],
      }),
    ),
  );
}

describe('quieter notifications (BRK-219)', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('says nothing while GitHub is down, and once when it’s working again', async () => {
    await statusRow('attention', 2);
    await statusRow('attention', 60);
    await statusRow('attention', 120);
    expect(await statusNotes()).toEqual([]);
    await statusRow('working', 0);
    const notes = await statusNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'recovered', name: 'GitHub’s status', resolved: null });
    // Down again: the old "working again" note goes, and nothing new comes until it ends.
    await statusRow('attention', 60);
    expect(await statusNotes()).toEqual([]);
    await statusRow('working', 0);
    expect((await statusNotes()).map((n) => n.kind)).toEqual(['recovered']);
  });

  it('says nothing about a blip that ended before it settled', async () => {
    await inStore((s) => s.sql.exec("DELETE FROM connection_notices WHERE conn = 'github.status'"));
    await statusRow('attention', 3);
    await statusRow('working', 0);
    expect(await statusNotes()).toEqual([]);
  });

  it('sets up a chase whose next task waits for one in review', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'First part', project: 'ops', tags: ['agent', 'calm'], horizon: 'now' },
          { description: 'Second part', project: 'ops', tags: ['agent', 'calm'], horizon: 'now', depends: ['OPS-1'] },
          { description: 'Quiet one', project: 'debt', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'DEBT-1']);
    expect((await api('features', { method: 'POST', body: { slug: 'calm' } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 10, hourly: 30 } });
  });

  it('doesn’t ping about a pull request that merges by itself when its checks pass', async () => {
    await openPull(51, 'OPS-1', { autoMerge: true });
    const res = await chase('calm', { on: true });
    expect(res.status).toBe(200);
    expect(res.started).toEqual([]);
    expect(res.chase).toMatchObject({ state: 'on', stalledPingAt: null });
    expect(res.chase.needsYou).toEqual([]);
    expect(res.chase.tasks.find((t) => t.wid === 'OPS-1')).toMatchObject({
      state: 'in-review',
      why: expect.stringMatching(/#51 merges by itself/),
    });
    expect((await inbox()).pings).toEqual([]);
  });

  it('still pings when merging is the owner’s: no auto-merge, or changes requested', async () => {
    await openPull(51, 'OPS-1', { autoMerge: true, review: 'changes_requested' });
    let f = await chase('calm', { on: false });
    f = await chase('calm', { on: true });
    expect(f.chase.needsYou).toEqual([expect.objectContaining({ wid: 'OPS-1', kind: 'merge', pr: 51 })]);
    let { pings } = await inbox();
    expect(pings).toEqual([expect.objectContaining({ task: 'OPS-1', kind: 'blocked', push: true })]);

    await inStore((s) => s.sql.exec('UPDATE pings SET resolved = ? WHERE resolved IS NULL', Date.now()));
    await openPull(51, 'OPS-1');
    await chase('calm', { on: false });
    f = await chase('calm', { on: true });
    expect(f.chase.needsYou).toEqual([expect.objectContaining({ wid: 'OPS-1', kind: 'merge', pr: 51 })]);
    ({ pings } = await inbox());
    expect(pings).toEqual([expect.objectContaining({ task: 'OPS-1', kind: 'blocked' })]);
    expect((await feature('calm')).chase.stalledPingAt).not.toBeNull();
    await chase('calm', { on: false });
    await inStore((s) => s.sql.exec('UPDATE pings SET resolved = ? WHERE resolved IS NULL', Date.now()));
  });

  it('doesn’t call a session Silent while GitHub is down, and does once it’s back', async () => {
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: 'DEBT-1' } }));
    expect(started.run).toMatchObject({ agent: 'claude-debt-1', status: 'started' });
    await githubDown(true);
    await inStore((s) => s.sql.exec('UPDATE agent_runs SET started = started - ?', 45 * 60_000));
    await withPage((s) => s.silentTick());
    expect((await inbox()).pings).toEqual([]);
    expect((await task('DEBT-1')).agentRun.silentSince).toBeNull();

    await githubDown(false);
    await withPage((s) => s.silentTick());
    const { pings } = await inbox();
    expect(pings).toEqual([expect.objectContaining({ task: 'DEBT-1', kind: 'blocked', by: 'board' })]);
    expect(pings[0].message).toMatch(/claude-debt-1 has said nothing for over 30 minutes/);
  });
});
