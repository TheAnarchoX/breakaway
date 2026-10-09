import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimLines, footprintLines } from '../src/footprint-text.js';
import { CEILING_MS, LEASE_MS } from '../src/store-footprints.js';
import { api, boardApi } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const sql = (query, ...values) => inStore((s) => s.sql.exec(query, ...values).toArray());

const ADA = 'claude-fp-ada';
const BEA = 'claude-fp-bea';
const CY = 'claude-fp-cy';

/** The tasks' paths: claims, releases, and dirty paths, as an agent (or the owner, with no agent). */
const paths = (wid, payload) => api(`tasks/${wid}/paths`, { method: 'POST', body: payload });
const footprint = async (wid) => body(await api(`tasks/${wid}/footprint`));
const hook = (wid, agent, extra = {}) =>
  api(`tasks/${wid}/session`, {
    method: 'POST',
    body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }], ...extra },
  });
/** Moves a task's claims back in time, as if `ms` passed without a heartbeat. */
const age = (wid, ms) =>
  inStore((s) => {
    const uuid = s.resolve(wid);
    s.sql.exec(
      'UPDATE path_claims SET claimed = claimed - ?, heartbeat = heartbeat - ?, ceiling = ceiling - ? WHERE uuid = ?',
      ms,
      ms,
      ms,
      uuid,
    );
    s.sql.exec('UPDATE task_heartbeats SET at = at - ? WHERE uuid = ?', ms, uuid);
  });

describe('footprints and path claims (IDEA-55, sections 1, 1a, 1b, 5)', () => {
  let a;
  let b;
  let c;
  let idle;
  beforeAll(async () => {
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          {
            description: 'Route the gizmo API',
            brief: 'Change apps/gizmo/api/routes.js and test/gizmo.test.js.',
            project: 'ops',
            tags: ['agent'],
            horizon: 'now',
            force: true,
          },
          { description: 'Tidy the gizmo views', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
          { description: 'Write the gizmo docs', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
          { description: 'Nothing named here at all', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
        ],
      }),
    );
    [a, b, c, idle] = created.tasks.map((t) => t.wid);
    for (const [wid, agent] of [
      [a, ADA],
      [b, BEA],
      [c, CY],
    ])
      expect((await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } })).status).toBe(200);
  });

  it('predicts a footprint before an agent claims a path, and says unknown when nothing is named', async () => {
    const before = await footprint(a);
    expect(before.status).toBe(200);
    expect(before.footprint).toMatchObject({ task: a, kind: 'predicted', known: true });
    expect(before.footprint.paths.map((p) => p.pattern)).toEqual(
      expect.arrayContaining(['apps/gizmo/api/routes.js', 'test/gizmo.test.js']),
    );
    expect(before.footprint.paths.every((p) => p.state === 'predicted')).toBe(true);
    const none = await footprint(idle);
    expect(none.footprint).toMatchObject({ kind: 'unknown', known: false, paths: [] });
  });

  it('grants a glob claim, and answers an overlapping one with 409, the holder, its pattern, and its last activity', async () => {
    const granted = await body(await paths(a, { agent: ADA, claim: ['apps/gizmo/api/**'] }));
    expect(granted.status).toBe(200);
    expect(granted.granted).toEqual([{ pattern: 'apps/gizmo/api/**', until: expect.any(String) }]);
    expect(granted.refused).toEqual([]);

    const refused = await body(
      await paths(b, { agent: BEA, claim: ['apps/gizmo/api/routes.js', 'apps/gizmo/views/'] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(/apps\/gizmo\/api\/routes\.js. is claimed by claude-fp-ada on/u);
    expect(refused.refused).toEqual([
      {
        pattern: 'apps/gizmo/api/routes.js',
        holder: {
          task: a,
          agent: ADA,
          pattern: 'apps/gizmo/api/**',
          active: expect.any(String),
          until: expect.any(String),
        },
      },
    ]);
    // The rest of the request is granted.
    expect(refused.granted.map((g) => g.pattern)).toEqual(['apps/gizmo/views/']);

    // Two patterns of the same task never conflict, and claiming one again is no new claim.
    const again = await body(await paths(a, { agent: ADA, claim: ['apps/gizmo/api/routes.js', 'apps/gizmo/api/**'] }));
    expect(again.status).toBe(200);
    expect(again.granted.map((g) => g.pattern)).toEqual(['apps/gizmo/api/routes.js']);
    expect(again.held).toEqual(['apps/gizmo/api/**']);
  });

  it('only the task’s holder claims, and patterns are checked', async () => {
    expect((await paths(a, { agent: BEA, claim: ['docs/x.md'] })).status).toBe(403);
    expect((await paths(idle, { agent: ADA, claim: ['docs/x.md'] })).status).toBe(403);
    expect((await paths(a, { claim: ['docs/x.md'] })).status).toBe(400);
    for (const bad of [['{a,b}.js'], ['!src/'], [''], ['x'.repeat(301)], ['../etc/passwd']])
      expect((await paths(a, { agent: ADA, claim: bad })).status, bad[0]).toBe(400);
  });

  it('lockfiles and shared files never conflict', async () => {
    expect((await paths(a, { agent: ADA, claim: ['pnpm-lock.yaml'] })).status).toBe(200);
    expect((await paths(c, { agent: CY, claim: ['pnpm-lock.yaml'] })).status).toBe(200);
  });

  it('shows the claimed footprint, with when each claim runs out', async () => {
    const { footprint: fp } = await footprint(a);
    expect(fp.kind).toBe('claimed');
    const api = fp.paths.find((p) => p.pattern === 'apps/gizmo/api/**');
    expect(api).toMatchObject({ state: 'claimed', agent: ADA, until: expect.any(String) });
    expect(Date.parse(api.until) - Date.now()).toBeGreaterThan(LEASE_MS - 60_000);
    expect(Date.parse(api.until) - Date.now()).toBeLessThanOrEqual(LEASE_MS);
    // The prediction stays alongside, for the hit rate.
    expect(fp.predicted.known).toBe(true);
  });

  it('every session hook call is a heartbeat that renews the task’s claims', async () => {
    await age(a, LEASE_MS - 60_000);
    const before = await inStore((s) => s.lastHeartbeat(s.resolve(a)));
    expect(Date.now() - before.at).toBeGreaterThan(LEASE_MS - 120_000);
    expect((await hook(a, ADA)).status).toBe(201);
    const after = await inStore((s) => s.lastHeartbeat(s.resolve(a)));
    expect(after).toMatchObject({ agent: ADA });
    expect(Date.now() - after.at).toBeLessThan(10_000);
    const { footprint: fp } = await footprint(a);
    const api = fp.paths.find((p) => p.pattern === 'apps/gizmo/api/**');
    expect(Date.parse(api.until) - Date.now()).toBeGreaterThan(LEASE_MS - 60_000);
    // Another agent's hook post renews nothing of this task's.
    expect((await inStore((s) => s.lastHeartbeat(s.resolve(b)))).agent).toBe(BEA);
  });

  it('a claim lapses 10 minutes after the task’s last heartbeat, and the sweep ends it', async () => {
    await age(c, LEASE_MS + 1000);
    const { footprint: fp } = await footprint(c);
    expect(fp.paths.filter((p) => p.state === 'claimed')).toEqual([]);
    const swept = await inStore((s) => {
      s.footprintsSweep();
      return s.sql
        .exec('SELECT pattern, why FROM path_claims WHERE uuid = ? AND ended IS NOT NULL', s.resolve(c))
        .toArray();
    });
    expect(swept).toEqual([{ pattern: 'pnpm-lock.yaml', why: 'lapsed' }]);
    // A lapsed claim isn't revived by a later heartbeat.
    await hook(c, CY);
    expect((await footprint(c)).footprint.paths.filter((p) => p.state === 'claimed')).toEqual([]);
  });

  it('a claim ends at its 4-hour ceiling even while the agent keeps calling tools, and the next claim starts afresh', async () => {
    await age(b, CEILING_MS + 1000);
    await hook(b, BEA);
    expect((await footprint(b)).footprint.paths.filter((p) => p.state === 'claimed')).toEqual([]);
    const again = await body(await paths(b, { agent: BEA, claim: ['apps/gizmo/views/'] }));
    expect(again.granted.map((g) => g.pattern)).toEqual(['apps/gizmo/views/']);
    const ends = await inStore((s) => {
      s.footprintsSweep();
      return s.sql
        .exec('SELECT claimed, ceiling FROM path_claims WHERE uuid = ? AND ended IS NULL', s.resolve(b))
        .toArray();
    });
    expect(ends).toHaveLength(1);
    expect(ends[0].ceiling - ends[0].claimed).toBe(CEILING_MS);
  });

  it('dirty paths: a free one is claimed for the task, another task’s is flagged as a conflict', async () => {
    const res = await body(
      await paths(b, { agent: BEA, dirty: ['apps/gizmo/views/list.js', 'apps/gizmo/api/routes.js', 'README.md'] }),
    );
    expect(res.status).toBe(200);
    expect(res.claimed).toEqual(['README.md']);
    expect(res.conflicts).toEqual([
      {
        path: 'apps/gizmo/api/routes.js',
        task: a,
        agent: ADA,
        pattern: 'apps/gizmo/api/**',
        at: expect.any(String),
        new: true,
      },
    ]);
    // Flagged once: the same report again isn't new.
    const twice = await body(await paths(b, { agent: BEA, dirty: ['apps/gizmo/api/routes.js'] }));
    expect(twice.conflicts).toEqual([expect.objectContaining({ path: 'apps/gizmo/api/routes.js', new: false })]);
    // The session hook can send them with its post, and hears the conflicts back.
    const posted = await body(await hook(b, BEA, { dirty: ['apps/gizmo/api/routes.js', 'docs/gizmo.md'] }));
    expect(posted.footprint.conflicts.map((x) => x.path)).toEqual(['apps/gizmo/api/routes.js']);
    expect(posted.footprint.claimed).toEqual(['docs/gizmo.md']);

    const { footprint: fp } = await footprint(b);
    expect(fp.kind).toBe('actual');
    expect(fp.paths).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'apps/gizmo/api/routes.js', state: 'dirty' })]),
    );
    expect(fp.conflicts.map((x) => x.path)).toEqual(['apps/gizmo/api/routes.js']);
  });

  it('the agent releases its own claims; only the owner releases another’s', async () => {
    expect((await paths(a, { agent: BEA, release: ['apps/gizmo/api/**'] })).status).toBe(403);
    const own = await body(await paths(b, { agent: BEA, release: ['README.md'] }));
    expect(own).toMatchObject({ status: 200, released: ['README.md'] });
    // The owner, with no agent name: the bearer token from their CLI, or the signed-in board.
    const owner = await body(await paths(a, { release: ['apps/gizmo/api/routes.js'] }));
    expect(owner).toMatchObject({ status: 200, released: ['apps/gizmo/api/routes.js'] });
    const board = await body(
      await boardApi(`tasks/${a}/paths`, { method: 'POST', body: { release: ['apps/gizmo/api/**'] } }),
    );
    expect(board).toMatchObject({ status: 200, released: ['apps/gizmo/api/**'] });
    const why = await inStore((s) =>
      s.sql
        .exec("SELECT why FROM path_claims WHERE uuid = ? AND pattern = 'apps/gizmo/api/**'", s.resolve(a))
        .toArray()
        .map((r) => r.why),
    );
    expect(why).toEqual(['released by the owner']);
    // Now free: B's claim on it is granted.
    expect((await paths(b, { agent: BEA, claim: ['apps/gizmo/api/routes.js'] })).status).toBe(200);
  });

  it('every claim ends with its task’s claim, and a claim again doesn’t bring them back', async () => {
    expect((await footprint(b)).footprint.paths.some((p) => p.state === 'claimed')).toBe(true);
    expect((await api(`tasks/${b}/release`, { method: 'POST', body: { agent: BEA } })).status).toBe(200);
    expect((await footprint(b)).footprint.paths.filter((p) => p.state === 'claimed')).toEqual([]);
    expect((await api(`tasks/${b}/claim`, { method: 'POST', body: { agent: BEA } })).status).toBe(200);
    expect((await footprint(b)).footprint.paths.filter((p) => p.state === 'claimed')).toEqual([]);
    // So the path is free for another task.
    expect((await paths(a, { agent: ADA, claim: ['apps/gizmo/api/routes.js'] })).status).toBe(200);
    const why = await inStore((s) => {
      s.footprintsSweep();
      return s.sql
        .exec(
          "SELECT DISTINCT why FROM path_claims WHERE uuid = ? AND ended IS NOT NULL AND why != 'released'",
          s.resolve(b),
        )
        .toArray()
        .map((r) => r.why);
    });
    expect(why).toContain('task released');
  });

  it('moves to actual once the task has a pull request, which holds while its head moved in 24 hours or an agent holds it', async () => {
    const repo = await inStore((s) => s.defaultRepoSlug());
    const pr = (number, wid, files, head) =>
      sql(
        'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES (?, ?, ?, ?, ?)',
        repo,
        number,
        new Date().toISOString(),
        'open',
        JSON.stringify({
          number,
          title: `${wid}: the change`,
          state: 'open',
          url: `https://github.com/acme/widgets/pull/${number}`,
          branch: 'b',
          author: 'someone',
          closes: [wid],
          mentions: [],
          checks: { state: 'pending', total: 1, passed: 0, runs: [] },
          review: { decision: null, comments: 0 },
          headSha: head,
          files,
          filesHead: head,
        }),
      );
    await pr(901, c, ['docs/gizmo-guide.md', 'pnpm-lock.yaml'], 'aaa111');
    const { footprint: fp } = await footprint(c);
    expect(fp.kind).toBe('actual');
    expect(fp.pull).toMatchObject({ number: 901, holds: true });
    expect(fp.paths).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'docs/gizmo-guide.md', state: 'pull', holds: true })]),
    );
    // The lockfile is shared: shown as left out, never a path.
    expect(fp.paths.some((p) => p.pattern === 'pnpm-lock.yaml')).toBe(false);
    expect(fp.shared).toContain('pnpm-lock.yaml');

    // Released, with a head that last moved over a day ago: shown, but holds nothing.
    expect((await api(`tasks/${c}/release`, { method: 'POST', body: { agent: CY } })).status).toBe(200);
    await inStore((s) =>
      s.sql.exec(
        "UPDATE footprints SET moved = ? WHERE kind = 'pull' AND uuid = ?",
        Date.now() - 25 * 3_600_000,
        s.resolve(c),
      ),
    );
    const stale = (await footprint(c)).footprint;
    expect(stale.pull).toMatchObject({ number: 901, holds: false });
    expect(stale.paths.find((p) => p.pattern === 'docs/gizmo-guide.md')).toMatchObject({ holds: false });
    // A new head is a move: it holds again.
    await pr(901, c, ['docs/gizmo-guide.md'], 'bbb222');
    expect((await footprint(c)).footprint.pull).toMatchObject({ holds: true, head: 'bbb222' });
  });

  it('a check-in claims the files it names, or --files, and says what it couldn’t', async () => {
    const peloton = await inStore((s) => s.defaultRepoSlug());
    expect((await paths(b, { agent: BEA, claim: ['docs/gizmo.md'] })).status).toBe(200);
    const res = await body(
      await api(`peloton/${encodeURIComponent(peloton)}`, {
        method: 'POST',
        body: { agent: ADA, kind: 'checkin', text: 'Changing apps/gizmo/cli.js and docs/gizmo.md' },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.paths.granted.map((g) => g.pattern)).toEqual(['apps/gizmo/cli.js']);
    expect(res.paths.refused.map((r) => [r.pattern, r.holder.agent])).toEqual([['docs/gizmo.md', BEA]]);
    const files = await body(
      await api(`peloton/${encodeURIComponent(peloton)}`, {
        method: 'POST',
        body: { agent: ADA, kind: 'checkin', text: 'More in the CLI', files: ['apps/gizmo/cli/**'] },
      }),
    );
    expect(files.paths.granted.map((g) => g.pattern)).toEqual(['apps/gizmo/cli/**']);
  });

  it('keeps a day of ended claims, then prunes them', async () => {
    await inStore((s) => {
      s.footprintsSweep();
      s.sql.exec('UPDATE path_claims SET ended = ? WHERE ended IS NOT NULL', Date.now() - 25 * 3_600_000);
      s.footprintsSweep();
    });
    expect((await sql('SELECT COUNT(*) AS n FROM path_claims WHERE ended IS NOT NULL'))[0].n).toBe(0);
  });

  it('the hit rate: the share of each merged task’s files its prediction covered, the last 20 per repository', async () => {
    const repo = await inStore((s) => s.defaultRepoSlug());
    const before = await inStore((s) => s.footprintHitRate(repo));
    // A task predicted to touch one file of the two its pull request changed: half covered.
    const made = await body(
      await api('tasks', {
        method: 'POST',
        body: {
          description: 'Mend the sprocket',
          brief: 'In apps/sprocket/mend.js.',
          project: 'ops',
          tags: ['agent'],
          horizon: 'now',
          force: true,
        },
      }),
    );
    const wid = made.tasks[0].wid;
    expect((await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent: 'claude-fp-dee' } })).status).toBe(200);
    await hook(wid, 'claude-fp-dee');
    await sql(
      'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES (?, 902, ?, ?, ?)',
      repo,
      new Date().toISOString(),
      'merged',
      JSON.stringify({
        number: 902,
        title: `${wid}: Mend the sprocket`,
        state: 'merged',
        url: 'https://github.com/acme/widgets/pull/902',
        closes: [wid],
        mentions: [],
        checks: { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
        headSha: 'ccc333',
        files: ['apps/sprocket/mend.js', 'apps/sprocket/other.js'],
        filesHead: 'ccc333',
      }),
    );
    expect((await api(`tasks/${wid}/done`, { method: 'POST', body: { note: 'merged' } })).status).toBe(200);
    const after = await inStore((s) => s.footprintHitRate(repo));
    expect(after.count).toBe(before.count + 1);
    expect(after.tasks[0]).toMatchObject({ task: wid, rate: 0.5 });
    expect(after.trusted).toBe(after.rate >= 0.5);
  });

  it('refuses a footprint for no task', async () => {
    expect((await api('tasks/NOPE-404/footprint')).status).toBe(404);
  });
});

describe('a footprint in words (IDEA-55 section 5)', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('marks each path predicted, claimed with when it runs out, changed, or from the pull request', () => {
    const lines = footprintLines(
      {
        kind: 'actual',
        paths: [
          { pattern: 'src/a.js', source: 'claim', state: 'claimed', agent: 'claude-x', until: '2026-10-09T12:07:00Z' },
          { pattern: 'src/b.js', source: 'dirty', state: 'dirty' },
          { pattern: 'src/c.js', source: 'pull', state: 'pull', holds: false },
        ],
        pull: { number: 12, partial: false },
        conflicts: [{ path: 'src/b.js', agent: 'claude-y', task: 'OPS-2', pattern: 'src/' }],
        shared: ['pnpm-lock.yaml'],
        hitRate: { rate: 0.78, count: 20 },
      },
      now,
    );
    expect(lines).toEqual([
      '  Footprint (actual)',
      '    src/a.js  claimed by claude-x, runs out in 7 min',
      '    src/b.js  changed, not claimed',
      '    src/c.js  pull request, quiet over a day: holds nothing',
      '    from #12',
      '    conflict: changed src/b.js, which claude-y claims on OPS-2 (src/)',
      '    left out, shared: pnpm-lock.yaml',
      '    predictions here covered 78% of the files the last 20 merged tasks changed',
    ]);
    expect(footprintLines({ kind: 'unknown', paths: [] }, now)[0]).toMatch(/unknown: nothing names a path yet/u);
    expect(footprintLines({ kind: 'predicted', trusted: false, paths: [] }, now)[0]).toMatch(/not trusted/u);
  });

  it('says what a claim granted, held, and refused, with who holds it', () => {
    expect(
      claimLines(
        {
          granted: [{ pattern: 'docs/', until: '2026-10-09T12:10:00Z' }],
          held: ['src/a.js'],
          refused: [
            {
              pattern: 'src/b.js',
              holder: { agent: 'claude-y', task: 'OPS-2', pattern: 'src/**', active: '2026-10-09T11:58:00Z' },
            },
          ],
        },
        now,
      ),
    ).toEqual([
      'Claimed docs/ (runs out in 10 min without a heartbeat).',
      'Already yours: src/a.js.',
      'Refused src/b.js: claude-y claims src/** on OPS-2, active 11:58 UTC. Change other files, ask @claude-y on the peloton, or comment why and release your task.',
    ]);
    expect(claimLines({ released: [] })).toEqual(['Nothing to release.']);
  });
});

describe('every open task’s footprint at once, for the Graph view (WEB-130)', () => {
  let one;
  let two;
  let none;
  let shut;
  beforeAll(async () => {
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Tune the doohickey', brief: 'Change apps/doohickey/tune.js.', project: 'ops', force: true },
          { description: 'Test the doohickey', brief: 'Cover apps/doohickey/tune.js.', project: 'ops', force: true },
          { description: 'Think about the doohickey', project: 'ops', force: true },
          { description: 'Retire the doohickey', brief: 'Delete apps/doohickey/old.js.', project: 'ops', force: true },
        ],
      }),
    );
    [one, two, none, shut] = created.tasks.map((t) => t.wid);
    expect((await api(`tasks/${shut}/done`, { method: 'POST', body: { note: 'not needed' } })).status).toBe(200);
  });

  it('lists each open task’s footprint by repository, with the shared files and the hit rate', async () => {
    const res = await body(await api('footprints'));
    expect(res.status).toBe(200);
    const [repo] = res.repos;
    expect(repo).toMatchObject({ repo: expect.any(String), shared: expect.any(Array) });
    expect(repo.hitRate).toMatchObject({ count: expect.any(Number), trusted: expect.any(Boolean) });
    const of = (wid) => repo.footprints.find((f) => f.task === wid);
    expect(of(one)).toMatchObject({ kind: 'predicted', patterns: ['apps/doohickey/tune.js'] });
    expect(of(one).paths[0]).toMatchObject({ pattern: 'apps/doohickey/tune.js', state: 'predicted' });
    expect(of(two).patterns).toEqual(['apps/doohickey/tune.js']);
    expect(of(none)).toMatchObject({ kind: 'unknown', patterns: [] });
    expect(of(shut)).toBeUndefined();
    const narrowed = await body(await api(`footprints?repo=${encodeURIComponent(repo.repo)}`));
    expect(narrowed.repos.map((r) => r.repo)).toEqual([repo.repo]);
    expect((await body(await api('footprints?repo=acme%2Fnowhere'))).repos).toEqual([]);
  });

  it('only reads: a task’s prediction isn’t stored by it', async () => {
    const uuid = await inStore((s) => s.resolve(one));
    await inStore((s) => s.sql.exec('DELETE FROM footprints WHERE uuid = ?', uuid));
    await api('footprints');
    expect(await sql('SELECT kind FROM footprints WHERE uuid = ?', uuid)).toEqual([]);
  });
});
