import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LAPSE_MS, STALE_MS } from '../src/store-claim-lapse.js';
import { FOOTPRINT_SWEEP } from '../src/store-footprints.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);

const ADA = 'claude-lapse-ada';
const BEA = 'claude-lapse-bea';
const CY = 'codex-lapse-cy';
const DEE = 'claude-lapse-dee';
const PERSON = 'jo';

const show = async (wid) => (await body(await api(`tasks/${wid}`))).task;
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
const hook = (wid, agent) =>
  api(`tasks/${wid}/session`, {
    method: 'POST',
    body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }] },
  });
/** Runs the footprints sweep, as the alarm does, `ms` from now. */
const sweep = (ms) => inStore((s) => s.footprintsSweep(Date.now() + ms));
const lapsed = (task) => task.comments.filter((c) => c.by === 'board' && c.text.startsWith('Lapsed:'));

describe('task claims lapse by heartbeat (IDEA-55 section 1c)', () => {
  /** @type {string[]} */
  let wids;
  let repo;
  beforeAll(async () => {
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: ['Lapse one', 'Lapse two', 'Lapse three', 'Lapse four', 'Lapse five', 'Lapse six'].map((d) => ({
          description: d,
          project: 'ops',
          who: 'agent',
          horizon: 'now',
          force: true,
        })),
      }),
    );
    wids = created.tasks.map((t) => t.wid);
    repo = await inStore((s) => s.defaultRepoSlug());
  });

  it('is a step of the footprints sweep, not an alarm of its own', () => {
    expect(FOOTPRINT_SWEEP).toEqual(expect.arrayContaining(['lapseSilentClaims', 'markStaleClaims']));
  });

  it('releases an agent’s claim with no pull request after 60 silent minutes, with a comment, and the task is ready again', async () => {
    const wid = wids[0];
    expect((await claim(wid, ADA)).status).toBe(200);
    expect((await hook(wid, ADA)).status).toBe(201);
    await sweep(LAPSE_MS - 60_000);
    expect((await show(wid)).claim).toBe(ADA);

    await sweep(LAPSE_MS + 60_000);
    const task = await show(wid);
    expect(task.claim).toBeNull();
    expect(task.start).toBeNull();
    expect(task.status).toBe('pending');
    const [comment] = lapsed(task);
    expect(comment.text).toMatch(new RegExp(`^Lapsed: ${ADA} silent since \\d\\d:\\d\\d UTC on `));
    expect(comment.text).toContain('no open pull request');
    // Ready again: anyone may claim it.
    expect((await claim(wid, BEA)).status).toBe(200);
    expect((await api(`tasks/${wid}/release`, { method: 'POST', body: { agent: BEA } })).status).toBe(200);
  });

  it('a heartbeat resets the clock', async () => {
    const wid = wids[1];
    expect((await claim(wid, CY)).status).toBe(200);
    // Fifty minutes in, a heartbeat; the sweep at 70 minutes is 20 minutes after it.
    await inStore((s) => {
      const uuid = s.resolve(wid);
      s.sql.exec('UPDATE task_heartbeats SET at = at - ? WHERE uuid = ?', 50 * 60_000, uuid);
    });
    await sweep(20 * 60_000);
    expect((await show(wid)).claim).toBe(CY);
    expect((await hook(wid, CY)).status).toBe(201);
    await sweep(LAPSE_MS - 60_000);
    expect((await show(wid)).claim).toBe(CY);
    await sweep(LAPSE_MS + 60_000);
    expect((await show(wid)).claim).toBeNull();
  });

  it('holds an agent’s claim while its pull request is open, however long it is silent', async () => {
    const wid = wids[2];
    expect((await claim(wid, DEE)).status).toBe(200);
    await inStore((s) =>
      s.sql.exec(
        'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES (?, ?, ?, ?, ?)',
        repo,
        951,
        new Date().toISOString(),
        'open',
        JSON.stringify({
          number: 951,
          title: `${wid}: the change`,
          state: 'open',
          url: 'https://github.com/acme/widgets/pull/951',
          branch: 'claude/lapse-dee',
          author: 'someone',
          closes: [wid],
          mentions: [],
          checks: { state: 'pending', total: 1, passed: 0, runs: [] },
          review: { decision: null, comments: 0 },
        }),
      ),
    );
    await sweep(10 * LAPSE_MS);
    expect((await show(wid)).claim).toBe(DEE);
    expect(lapsed(await show(wid))).toEqual([]);
  });

  it('a pull request in the task’s pr field holds it before GitHub’s sync has seen it', async () => {
    const wid = wids[3];
    expect((await claim(wid, BEA)).status).toBe(200);
    expect((await api(`tasks/${wid}`, { method: 'PATCH', body: { pr: '952', by: BEA } })).status).toBe(200);
    await sweep(2 * LAPSE_MS);
    expect((await show(wid)).claim).toBe(BEA);
  });

  it('keeps the Not pushed handover and names its branch; a returning agent finds its claim gone', async () => {
    const wid = wids[4];
    expect((await claim(wid, ADA)).status).toBe(200);
    expect(
      (
        await api(`tasks/${wid}/annotate`, {
          method: 'POST',
          body: { text: 'Not pushed: claude/lapse-ada, the store test is only local', by: ADA },
        })
      ).status,
    ).toBe(200);
    await sweep(LAPSE_MS + 60_000);
    const task = await show(wid);
    expect(task.claim).toBeNull();
    expect(task.comments.some((c) => c.text.startsWith('Not pushed: claude/lapse-ada'))).toBe(true);
    const [comment] = lapsed(task);
    expect(comment.text).toContain('Its branch: claude/lapse-ada.');
    expect(comment.text).toContain('Not pushed handover');

    // It comes back: its hook is told the task was released, its heartbeat keeps nothing, and it claims again.
    expect((await body(await hook(wid, ADA))).released).toBe(true);
    expect(await inStore((s) => s.heartbeat(s.resolve(wid), ADA))).toBe(false);
    expect((await claim(wid, ADA)).status).toBe(200);
    // Or another agent got there first, and its claim is refused.
    expect((await claim(wid, BEA)).status).toBe(409);
  });

  it('never lapses while GitHub or Claude reports trouble', async () => {
    const wid = wids[5];
    expect((await claim(wid, CY)).status).toBe(200);
    await inStore((s) => {
      s.githubOutage = () => ({ disrupted: true });
      s.footprintsSweep(Date.now() + 2 * LAPSE_MS);
      delete s.githubOutage;
      s.claudeOutage = () => ({ disrupted: true });
      s.footprintsSweep(Date.now() + 2 * LAPSE_MS);
      delete s.claudeOutage;
    });
    expect((await show(wid)).claim).toBe(CY);
    await sweep(2 * LAPSE_MS);
    expect((await show(wid)).claim).toBeNull();
  });
});

describe('a person’s claim never lapses, and is marked stale after 3 days (IDEA-55 section 1c)', () => {
  let wid;
  beforeAll(async () => {
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          {
            description: 'A person holds this',
            project: 'ops',
            who: 'person',
            assignee: 'owner',
            horizon: 'now',
            force: true,
          },
        ],
      }),
    );
    wid = created.tasks[0].wid;
    expect((await claim(wid, PERSON)).status).toBe(200);
  });

  const stalePings = () =>
    inStore((s) =>
      s.sql.exec("SELECT kind, message, quiet FROM pings WHERE task = ? AND agent = 'board'", s.resolve(wid)).toArray(),
    );

  it('never lapses, however long it goes without a heartbeat', async () => {
    await sweep(2 * STALE_MS - 1000 * 60 * 60 * 24);
    expect((await show(wid)).claim).toBe(PERSON);
  });

  it('after 3 days with no change, the owner sees it marked stale once, quietly, and the claim stays', async () => {
    await inStore((s) => s.sql.exec('DELETE FROM claim_stale'));
    await inStore((s) => s.sql.exec("DELETE FROM pings WHERE agent = 'board'"));
    await sweep(STALE_MS - 60_000);
    expect(await stalePings()).toEqual([]);

    const before = await show(wid);
    await sweep(STALE_MS + 60_000);
    await sweep(STALE_MS + 120_000);
    const pings = await stalePings();
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ kind: 'stale', quiet: 1 });
    expect(pings[0].message).toContain(`${PERSON} has held ${wid} for 3 days`);
    const after = await show(wid);
    expect(after.claim).toBe(PERSON);
    // No comment, so the task's own last change still says how old the claim is.
    expect(after.modified).toBe(before.modified);
    const inbox = (await body(await api('pings'))).pings.find((p) => p.task === wid);
    expect(inbox).toMatchObject({ kind: 'stale', by: 'board', push: false });
  });

  it('a new claim of the task counts again from nothing', async () => {
    expect((await api(`tasks/${wid}/release`, { method: 'POST', body: { agent: PERSON } })).status).toBe(200);
    await sweep(0);
    expect(await inStore((s) => s.sql.exec('SELECT * FROM claim_stale').toArray())).toEqual([]);
  });
});
