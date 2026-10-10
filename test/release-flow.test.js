import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_API_TOKEN, TEST_GITHUB_APP_ID } from './constants.js';
import { api, setPipeline } from './helpers.js';
import { releaseOffer, releasedFrom } from '../src/release.js';
import { ORIGIN } from './constants.js';

// Promote and Roll back on the board (CLD-105), against a pretend GitHub. Its own file: the
// Deployments it records must not mix with the other tests'.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const REPO = '/repos/acme/widgets';
const gh = { pulls: [], deployments: [], statuses: {}, compares: {}, compareFiles: {}, writes: [], writeError: null };

function pr(number, { title, body: text = '', mergeSha = null } = {}) {
  return {
    number,
    title,
    body: text,
    draft: false,
    state: 'closed',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    node_id: `PR_${number}`,
    head: { ref: `branch-${number}`, sha: `sha${number}` },
    user: { login: 'claude[bot]' },
    created_at: '2026-09-30T09:00:00Z',
    updated_at: '2026-09-30T10:00:00Z',
    merge_commit_sha: mergeSha,
    merged_at: '2026-09-30T10:00:00Z',
    closed_at: '2026-09-30T10:00:00Z',
  };
}

async function verifyJwt(authorization) {
  const [h, p, sig] = authorization.replace('Bearer ', '').split('.');
  const der = Uint8Array.from(
    atob(env.TEST_GITHUB_PUBLIC_KEY.replace(/-----[^-]+-----/gu, '').replace(/\s+/gu, '')),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const bytes = Uint8Array.from(atob(sig.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, encoder.encode(`${h}.${p}`));
  return valid && JSON.parse(atob(p.replaceAll('-', '+').replaceAll('_', '/'))).iss === TEST_GITHUB_APP_ID;
}

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    // A GraphQL query is a sync's read of pull request details (BRK-269): refused, so it reads them over REST.
    if (path === '/graphql' && /^\s*query\b/u.test(JSON.parse(init.body ?? '{}').query ?? ''))
      return reply({ errors: [{ message: 'not in this test' }] });
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) {
      gh.writes.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      if (gh.writeError) {
        const [status, message] = gh.writeError;
        gh.writeError = null;
        return reply({ message }, status);
      }
      return new Response(null, { status: 204 });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === `${REPO}/installation` || path.startsWith('/app/installations/')) {
      if (!(await verifyJwt(auth))) return reply({ message: 'Bad credentials' }, 401);
      return path.endsWith('/installation')
        ? reply({ id: 77 })
        : reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (path === `${REPO}/pulls`) return reply(gh.pulls);
    if (path === `${REPO}/deployments`) return reply(gh.deployments);
    if (['/actions/runs', '/commits', '/releases', '/tags'].some((p) => path === `${REPO}${p}`))
      return reply(path.endsWith('/runs') ? { workflow_runs: [] } : []);
    if (path === `${REPO}/dependabot/alerts`) return reply([]);
    let m = /\/deployments\/(\d+)\/statuses$/u.exec(path);
    if (m) return reply(gh.statuses[m[1]] ?? []);
    m = /\/compare\/([^/]+)\.\.\.([^/]+)$/u.exec(path);
    if (m)
      return reply({
        commits: gh.compares[`${m[1]}...${m[2]}`] ?? [],
        files: gh.compareFiles[`${m[1]}...${m[2]}`] ?? [],
      });
    m = /\/pulls\/(\d+)$/u.exec(path);
    if (m)
      return reply(
        gh.pulls.find((p) => String(p.number) === m[1]) ?? { message: 'Not Found' },
        gh.pulls.some((p) => String(p.number) === m[1]) ? 200 : 404,
      );
    if (/\/pulls\/\d+\/(files|reviews|comments)$/u.test(path)) return reply([]);
    if (/\/check-runs$/u.test(path)) return reply({ check_runs: [] });
    if (/\/status$/u.test(path)) return reply({ state: 'success', statuses: [] });
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('the release flow: Promote and Roll back', () => {
  let spy;
  let round = 0;
  let next = 1000; // Deployment ids only go up, so the newest rows are always this step's
  const id = () => {
    next += 1;
    return next;
  };
  const hex40 = (letter) => `${letter}${String(round).padStart(3, '0')}`.padEnd(40, letter);
  const uuid = (n) => `${String(round).padStart(4, '0')}${String(n).repeat(4)}-1111-2222-3333-444455556666`;
  let A;
  let B;
  let C;
  let V_A;
  let V_B;
  let V_C;
  const DIGEST = 'd'.repeat(64);
  const deployment = (did, environment, sha, task = 'deploy') => ({
    id: did,
    environment,
    sha,
    task,
    created_at: '2026-09-30T10:00:00Z',
    creator: { login: 'github-actions[bot]' },
  });
  const status = (state, description) => [
    { state, description, created_at: '2026-09-30T10:05:00Z', log_url: 'https://github.com/x/actions/runs/9' },
  ];
  /** Adds Deployments, newest last, with their latest status. */
  function record(list) {
    const added = list.map(([environment, sha, state, description, task]) => {
      const did = id();
      gh.statuses[did] = status(state, description);
      return deployment(did, environment, sha, task);
    });
    gh.deployments = [...added.reverse(), ...gh.deployments];
  }
  const sync = async () => (await body(await api('github/sync', { method: 'POST' }))).flow;
  beforeEach(async () => {
    await setPipeline();
    round += 1;
    A = hex40('a');
    B = hex40('b');
    C = hex40('c');
    V_A = uuid(1);
    V_B = uuid(2);
    V_C = uuid(3);
    spy = mockGitHub();
    gh.writes = [];
    gh.writeError = null;
  });
  afterEach(() => {
    spy.mockRestore();
    gh.deployments = [];
    gh.statuses = {};
    gh.compares = {};
    gh.compareFiles = {};
    gh.pulls = [];
  });

  async function browser() {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
      redirect: 'manual',
    });
    const cookie = res.headers.get('Set-Cookie').split(';')[0];
    return (path, payload, origin = ORIGIN) =>
      SELF.fetch(`${ORIGIN}/api/${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(payload),
      });
  }

  /** Production ran C, then A; staging runs B, with a migration. */
  function stagingAhead({ destructive = false } = {}) {
    record([
      ['widgets', C, 'success', `version ${V_C} · migrations none`],
      ['widgets', A, 'success', `version ${V_A} · migrations none`],
      ['widgets-staging', B, 'success', `pre-release · version ${V_B} · artifact ${DIGEST} · migrations 0013_x.sql`],
    ]);
    gh.compares[`${A}...${B}`] = [{ sha: B, commit: { message: 'CLD-9: Something (#31)' } }];
    gh.compareFiles[`${A}...${B}`] = [
      {
        filename: 'migrations/0013_x.sql',
        status: 'added',
        patch: destructive
          ? '@@\n+-- owner-approved: drop later\n+DROP TABLE t;'
          : '@@\n+ALTER TABLE t ADD COLUMN c TEXT;',
      },
    ];
    gh.pulls = [pr(31, { title: 'CLD-9: Something', body: 'Closes CLD-9.', mergeSha: B })];
  }

  it('says nothing is on staging before the first deploy', async () => {
    const flow = await sync();
    expect(flow.staging.state).toBe('none');
    expect(flow.promote).toMatchObject({ allowed: false });
    expect(flow.promote.reason).toMatch(/Nothing on staging/u);
    expect(flow.line).toMatch(/Nothing on staging/u);
  });

  it('shows both environments, what a promote carries, and what may be pressed', async () => {
    await api('tasks', { method: 'POST', body: [{ description: 'Something', project: 'cloud', who: 'agent' }] });
    stagingAhead();
    const flow = await sync();
    expect(flow.staging).toMatchObject({
      state: 'live',
      build: { sha7: B.slice(0, 7), version: V_B, preRelease: true },
    });
    expect(flow.production).toMatchObject({ state: 'live', build: { sha7: A.slice(0, 7), version: V_A } });
    expect(flow.candidate.sha7).toBe(B.slice(0, 7));
    expect(flow.line).toBe('Staging is 1 merge ahead: 1 task, 1 migration.');
    expect(flow.ahead).toMatchObject({ migrations: ['0013_x.sql'], destructive: [] });
    expect(flow.promote).toMatchObject({ allowed: true, sha: B });
    expect(flow.rollback.allowed).toBe(true);
    expect(flow.rollback.versions.map((v) => v.version)).toEqual([V_C]);
  });

  it('disables Promote with a reason while staging deploys, when production is up to date, and while a promote runs', async () => {
    record([
      ['widgets-staging', A, 'success', `pre-release · version ${V_A} · artifact ${DIGEST}`],
      ['widgets-staging', B, 'in_progress', 'Deploying'],
    ]);
    const deploying = await sync();
    expect(deploying.promote.reason).toMatch(/Staging is still deploying/u);
    expect(deploying.staging).toMatchObject({ state: 'deploying' });

    record([
      ['widgets-staging', A, 'success', `pre-release · version ${V_A} · artifact ${DIGEST}`],
      ['widgets', A, 'success', `version ${V_A} · migrations none`],
    ]);
    const same = await sync();
    expect(same.promote.reason).toMatch(/already runs/u);
    expect(same.line).toBe('Production is up to date with staging.');

    stagingAhead();
    record([['widgets', B, 'in_progress', 'promoting: migrating']]);
    const running = await sync();
    expect(running.promote.reason).toMatch(/already running/u);
    expect(running.rollback.reason).toMatch(/running/u);
    expect(running.production).toMatchObject({ state: 'deploying', step: 'migrating' });
  });

  it('says failed and rolled back in words, and warns when the candidate was tried before', async () => {
    stagingAhead();
    record([['widgets', B, 'failure', `health check failed; rolled back to ${V_A} (tried ${V_B})`]]);
    const flow = await sync();
    expect(flow.production.state).toBe('rolledback');
    expect(flow.promote).toMatchObject({ allowed: true, tried: { rolledBack: true } });
    record([['widgets', B, 'failure', 'failed before or during promote · migrations none']]);
    expect((await sync()).production.state).toBe('failed');
  });

  it('refuses a bearer token, a cross-origin request, and a missing or old commit, and writes nothing', async () => {
    stagingAhead();
    await sync();
    expect((await body(await api('github/promote', { method: 'POST', body: { sha: B } }))).status).toBe(403);
    expect((await body(await api('github/rollback', { method: 'POST', body: { reason: 'x' } }))).status).toBe(403);
    const post = await browser();
    expect((await post('github/promote', { sha: B }, 'https://evil.example')).status).toBe(403);
    expect((await post('github/promote', { sha: B }, null)).status).toBe(403);
    expect((await post('github/promote', {})).status).toBe(400);
    const old = await body(await post('github/promote', { sha: A }));
    expect(old).toMatchObject({ status: 409 });
    expect(old.error).toMatch(/moved on/u);
    expect((await post('github/rollback', { reason: '  ' })).status).toBe(400);
    expect(
      (await post('github/rollback', { reason: 'broken', version: '44444444-4444-4444-4444-444444444444' })).status,
    ).toBe(400);
    expect(gh.writes).toEqual([]);
  });

  it('dispatches promote.yml on main with the commit, and records it in Activity', async () => {
    stagingAhead();
    await sync();
    const post = await browser();
    const ok = await body(await post('github/promote', { sha: B }));
    expect(ok).toMatchObject({ status: 200, ok: true, workflow: 'promote.yml' });
    expect(gh.writes).toEqual([
      [
        'POST',
        `${REPO}/actions/workflows/promote.yml/dispatches`,
        { ref: 'main', inputs: { sha: B, destructive_ok: 'false' } },
      ],
    ]);
    expect(JSON.stringify(await body(await api('activity')))).toContain(`"promote_started","sha7":"${B.slice(0, 7)}"`);
  });

  it('needs the owner to confirm a destructive migration before it dispatches', async () => {
    stagingAhead({ destructive: true });
    const flow = await sync();
    expect(flow.ahead.destructive).toEqual(['0013_x.sql']);
    const post = await browser();
    const refused = await body(await post('github/promote', { sha: B }));
    expect(refused).toMatchObject({ status: 409, destructive: ['0013_x.sql'] });
    expect(gh.writes).toEqual([]);
    expect((await post('github/promote', { sha: B, destructiveOk: true })).status).toBe(200);
    expect(gh.writes[0][2].inputs.destructive_ok).toBe('true');
  });

  it('rolls back through rollback.yml, to the previous version or one production has run', async () => {
    stagingAhead();
    await sync();
    const post = await browser();
    expect((await post('github/rollback', { reason: 'sign-in is broken' })).status).toBe(200);
    expect(gh.writes[0]).toEqual([
      'POST',
      `${REPO}/actions/workflows/rollback.yml/dispatches`,
      { ref: 'main', inputs: { worker: 'widgets', reason: 'sign-in is broken' } },
    ]);
    expect((await post('github/rollback', { reason: 'again', version: V_C })).status).toBe(200);
    expect(gh.writes[1][2].inputs.version).toBe(V_C);
    expect(JSON.stringify(await body(await api('activity')))).toContain('rollback_started');
  });

  it('answers plainly when the App can’t start workflows yet, and records nothing', async () => {
    stagingAhead();
    await sync();
    const post = await browser();
    const before = JSON.stringify(await body(await api('activity'))).split('promote_started').length;
    gh.writeError = [403, 'Resource not accessible by integration'];
    const denied = await body(await post('github/promote', { sha: B }));
    expect(denied).toMatchObject({ status: 403, permission: true });
    expect(denied.error).toMatch(/read and write on Actions/u);
    expect(JSON.stringify(await body(await api('activity'))).split('promote_started').length).toBe(before);
  });
  describe('Release: a package’s pre-release as its stable (BRK-103)', () => {
    const PACKAGE_ONLY = { package: '@acme/widgets' };
    const BOTH = {
      workers: { staging: 'widgets-staging', production: 'widgets' },
      package: '@acme/widgets',
      deployPaths: '.github/deploy-paths.json',
    };
    async function packagePipeline(pipeline) {
      const res = await api('repos/widgets', { method: 'PATCH', body: { pipeline } });
      expect(res.status).toBe(200);
    }
    /** What the Packages feed knows: [version, state] of @acme/widgets. */
    async function feed(versions) {
      const stub = env.STORE.get(env.STORE.idFromName('widgets'));
      await runInDurableObject(stub, (store) => {
        store.sql.exec("DELETE FROM gh_packages WHERE repo = 'widgets'");
        for (const [version, state] of versions)
          store.sql.exec(
            `INSERT INTO gh_packages (repo, name, version, tag, state, run, data, staged)
             VALUES ('widgets', '@acme/widgets', ?, ?, ?, 1, '{}', ?)`,
            version,
            version.includes('-') ? 'next' : 'latest',
            state,
            new Date().toISOString(),
          );
      });
    }

    it('starts release.yml’s stable job on main with the pre-release’s tag, and records it in Activity', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([
        ['1.4.0-main.4', 'published'],
        ['1.4.0-main.5', 'staged'],
      ]);
      const post = await browser();
      const ok = await body(await post('github/release', { version: '1.4.0-main.4' }));
      expect(ok).toMatchObject({ status: 200, ok: true, action: 'release_started', workflow: 'release.yml' });
      expect(gh.writes).toEqual([
        [
          'POST',
          `${REPO}/actions/workflows/release.yml/dispatches`,
          { ref: 'main', inputs: { prerelease: 'v1.4.0-main.4' } },
        ],
      ]);
      expect(JSON.stringify(await body(await api('activity')))).toContain(
        '"release_started","package":"@acme/widgets","prerelease":"1.4.0-main.4","version":"1.4.0"',
      );
    });

    it('tags it with the package’s name beside a Worker’s deploys, and takes the tag as the version', async () => {
      await packagePipeline(BOTH);
      await feed([['2.0.0-main.1', 'staged']]);
      const post = await browser();
      expect((await post('github/release', { version: '@acme/widgets@2.0.0-main.1' })).status).toBe(200);
      expect(gh.writes[0][2]).toEqual({ ref: 'main', inputs: { prerelease: '@acme/widgets@2.0.0-main.1' } });
    });

    it('the owner’s CLI may release; an agent, a cross-origin request, and a bad or unknown pre-release may not', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([
        ['1.3.1-main.2', 'staged'],
        ['1.3.1', 'staged'],
        ['1.4.0-main.1', 'staged'],
      ]);
      const asAgent = await body(
        await api('github/release', { method: 'POST', body: { version: '1.4.0-main.1', by: 'claude-brk-1' } }),
      );
      expect(asAgent).toMatchObject({ status: 403 });
      const post = await browser();
      expect((await post('github/release', { version: '1.4.0-main.1' }, 'https://evil.example')).status).toBe(403);
      expect((await post('github/release', { version: '1.4.0' })).status).toBe(400);
      expect((await post('github/release', {})).status).toBe(400);
      const unknown = await body(await post('github/release', { version: '1.4.0-main.9' }));
      expect(unknown).toMatchObject({ status: 409 });
      expect(unknown.error).toMatch(/hasn’t seen @acme\/widgets@1.4.0-main.9/u);
      // npm takes a version once: a stable staged or published blocks its pre-releases.
      const out = await body(await post('github/release', { version: '1.3.1-main.2' }));
      expect(out).toMatchObject({ status: 409 });
      expect(out.error).toMatch(/1.3.1 is already out/u);
      expect(gh.writes).toEqual([]);
      const owner = await body(await api('github/release', { method: 'POST', body: { version: '1.4.0-main.1' } }));
      expect(owner).toMatchObject({ status: 200, workflow: 'release.yml' });
      expect(gh.writes).toHaveLength(1);
    });

    it('passes next for minor or major, and leaves patch, the default, out (WEB-39)', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([['1.4.0-main.4', 'staged']]);
      const post = await browser();
      expect((await post('github/release', { version: '1.4.0-main.4', next: 'minor' })).status).toBe(200);
      expect(gh.writes[0][2]).toEqual({ ref: 'main', inputs: { prerelease: 'v1.4.0-main.4', next: 'minor' } });
      expect((await post('github/release', { version: '1.4.0-main.4', next: 'patch' })).status).toBe(200);
      expect(gh.writes[1][2]).toEqual({ ref: 'main', inputs: { prerelease: 'v1.4.0-main.4' } });
      expect(JSON.stringify(await body(await api('activity')))).toContain('"version":"1.4.0","next":"minor"');
      expect((await post('github/release', { version: '1.4.0-main.4', next: 'huge' })).status).toBe(400);
      expect(gh.writes).toHaveLength(2);
    });

    it('marks each pre-release with its Release, the later ones it leaves out, and the next version it asks', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([
        ['1.3.1-main.4', 'published'],
        ['1.3.1-main.5', 'published'],
        ['1.3.1-main.7', 'staged'],
      ]);
      const versions = (await body(await api('github?repo=widgets'))).packages;
      const of = (v) => versions.find((x) => x.version === v).release;
      expect(of('1.3.1-main.4')).toMatchObject({
        allowed: true,
        leavesOut: ['1.3.1-main.5', '1.3.1-main.7'],
        next: {
          ask: true,
          choices: [
            { next: 'patch', version: '1.3.2' },
            { next: 'minor', version: '1.4.0' },
            { next: 'major', version: '2.0.0' },
          ],
        },
      });
      expect(of('1.3.1-main.7')).toMatchObject({ allowed: true, leavesOut: [] });
    });

    it('once a stable is staged or published, blocks every pre-release of it, before and after; a failed one blocks nothing', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([
        ['1.3.1-main.3', 'published'],
        ['1.3.1-main.4', 'published'],
        ['1.3.1-main.6', 'staged'],
        ['1.3.2-main.1', 'staged'],
      ]);
      // A stable that failed was never staged, so the feed doesn't have it: nothing is blocked.
      let versions = (await body(await api('github?repo=widgets'))).packages;
      expect(versions.find((v) => v.version === '1.3.1-main.3').release.allowed).toBe(true);
      await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (store) => {
        store.setGhMeta(
          'gh_tags',
          'widgets',
          JSON.stringify([
            { name: 'v1.3.1-main.3', sha: 'c3' },
            { name: 'v1.3.1-main.4', sha: 'c4' },
            { name: 'v1.3.1', sha: 'c4' },
          ]),
        );
      });
      await feed([
        ['1.3.1-main.3', 'published'],
        ['1.3.1-main.4', 'published'],
        ['1.3.1-main.6', 'staged'],
        ['1.3.1', 'staged'],
        ['1.3.2-main.1', 'staged'],
      ]);
      versions = (await body(await api('github?repo=widgets'))).packages;
      for (const v of ['1.3.1-main.3', '1.3.1-main.4', '1.3.1-main.6'])
        expect(versions.find((x) => x.version === v).release).toMatchObject({
          allowed: false,
          superseded: { version: '1.3.1', state: 'staged', from: '1.3.1-main.4' },
        });
      expect(versions.find((x) => x.version === '1.3.2-main.1').release.allowed).toBe(true);
      expect(versions.find((x) => x.version === '1.3.1').release).toBeUndefined();
      const post = await browser();
      const refused = await body(await post('github/release', { version: '1.3.1-main.6' }));
      expect(refused).toMatchObject({ status: 409, superseded: { version: '1.3.1', from: '1.3.1-main.4' } });
      expect(refused.error).toMatch(/1.3.1 is already out, from 1.3.1-main.4/u);
      expect(gh.writes).toEqual([]);
    });

    it('doesn’t ask when a later pre-release already sets the next version, and refuses minor or major then', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([
        ['1.4.0-main.2', 'published'],
        ['1.4.1-main.1', 'staged'],
      ]);
      const versions = (await body(await api('github?repo=widgets'))).packages;
      expect(versions.find((v) => v.version === '1.4.0-main.2').release.next).toEqual({
        ask: false,
        version: '1.4.1',
        why: 'prerelease',
        prerelease: '1.4.1-main.1',
      });
      const post = await browser();
      const refused = await body(await post('github/release', { version: '1.4.0-main.2', next: 'major' }));
      expect(refused).toMatchObject({ status: 409 });
      expect(refused.error).toMatch(
        /next version is already 1.4.1 \(1.4.1-main.1 is already out\): release it with patch/u,
      );
      expect(gh.writes).toEqual([]);
      expect((await post('github/release', { version: '1.4.0-main.2' })).status).toBe(200);
    });

    it('says what to do when the repository’s release.yml doesn’t take next yet', async () => {
      await packagePipeline(PACKAGE_ONLY);
      await feed([['1.4.0-main.1', 'staged']]);
      const post = await browser();
      gh.writeError = [422, 'Unexpected inputs provided: ["next"]'];
      const old = await body(await post('github/release', { version: '1.4.0-main.1', next: 'minor' }));
      expect(old).toMatchObject({ status: 409, workflow: 'release.yml' });
      expect(old.error).toMatch(/doesn’t take next yet: render it again with npx breakaway pipeline init/u);
    });

    it('says which package a repository releases, so Packages can say how to turn Release on without one (WEB-81)', async () => {
      await feed([['1.4.0-main.1', 'staged']]);
      let view = await body(await api('github?repo=widgets'));
      expect(view.releasePackage).toBeNull();
      expect(view.packages.find((v) => v.version === '1.4.0-main.1').release).toBeUndefined();
      await packagePipeline(PACKAGE_ONLY);
      view = await body(await api('github?repo=widgets'));
      expect(view.releasePackage).toBe('@acme/widgets');
      expect(view.packages.find((v) => v.version === '1.4.0-main.1').release.allowed).toBe(true);
    });

    it('refuses a repository that releases no package, and says so plainly when the App can’t start workflows', async () => {
      const post = await browser();
      const none = await body(await post('github/release', { version: '1.4.0-main.1' }));
      expect(none).toMatchObject({ status: 409 });
      expect(none.error).toMatch(/releases no npm package/u);
      await packagePipeline(PACKAGE_ONLY);
      await feed([['1.4.0-main.1', 'staged']]);
      const count = async () => JSON.stringify(await body(await api('activity'))).split('release_started').length;
      const before = await count();
      gh.writeError = [403, 'Resource not accessible by integration'];
      const denied = await body(await post('github/release', { version: '1.4.0-main.1' }));
      expect(denied).toMatchObject({ status: 403, permission: true, workflow: 'release.yml' });
      expect(await count()).toBe(before);
    });
  });
});

describe('Release on each pre-release (WEB-39): the rules', () => {
  const feed = (...pairs) => pairs.map(([version, state = 'staged']) => ({ version, state }));

  it('asks patch, minor, or major from the stable it makes, and names the later pre-releases it leaves out', () => {
    const versions = feed(['1.3.1-main.1'], ['1.3.1-main.4'], ['1.3.1-main.7'], ['1.3.1-main.5']);
    expect(releaseOffer(versions, '1.3.1-main.4')).toEqual({
      stable: '1.3.1',
      allowed: true,
      superseded: null,
      leavesOut: ['1.3.1-main.5', '1.3.1-main.7'],
      next: {
        ask: true,
        choices: [
          { next: 'patch', version: '1.3.2' },
          { next: 'minor', version: '1.4.0' },
          { next: 'major', version: '2.0.0' },
        ],
      },
    });
    expect(releaseOffer(versions, '1.3.1-main.7').leavesOut).toEqual([]);
    expect(releaseOffer(versions, '1.3.1')).toBeNull();
  });

  it('blocks every pre-release of a stable that is staged or published, and nothing for one that failed', () => {
    const versions = feed(['1.3.1-main.3'], ['1.3.1-main.4'], ['1.3.1-main.9'], ['1.3.1', 'published']);
    for (const v of ['1.3.1-main.3', '1.3.1-main.9'])
      expect(releaseOffer(versions, v, { from: { '1.3.1': '1.3.1-main.4' } })).toMatchObject({
        allowed: false,
        superseded: { version: '1.3.1', state: 'published', from: '1.3.1-main.4' },
      });
    // A stable that failed or was never staged isn't in the feed.
    expect(releaseOffer(feed(['1.3.1-main.3']), '1.3.1-main.3').allowed).toBe(true);
    expect(releaseOffer(feed(['1.3.1-main.3'], ['1.3.0', 'published']), '1.3.1-main.3').allowed).toBe(true);
  });

  it('skips the question when a later pre-release or an open +version task already sets the next version', () => {
    expect(releaseOffer(feed(['1.4.0-main.2'], ['1.4.1-main.1'], ['1.4.1-main.3']), '1.4.0-main.2').next).toEqual({
      ask: false,
      version: '1.4.1',
      why: 'prerelease',
      prerelease: '1.4.1-main.3',
    });
    // 1.10.0 is later than 1.9.0, by number.
    expect(releaseOffer(feed(['1.9.0-main.2'], ['1.10.0-main.1']), '1.9.0-main.2').next.version).toBe('1.10.0');
    const preparing = { uuid: 'u1', wid: 'BRK-9', version: '1.5.0' };
    expect(releaseOffer(feed(['1.4.0-main.2']), '1.4.0-main.2', { preparing }).next).toEqual({
      ask: false,
      version: '1.5.0',
      why: 'preparing',
      task: preparing,
    });
  });

  it('finds which pre-release a stable came from by its tags’ commit, then by the board’s own events', () => {
    const tags = [
      { name: 'v1.3.1-main.3', sha: 'c3' },
      { name: 'v1.3.1-main.4', sha: 'c4' },
      { name: 'v1.3.1', sha: 'c4' },
      { name: 'v1.2.0', sha: 'zz' },
    ];
    expect(releasedFrom(tags, [{ prerelease: '1.2.0-main.8', version: '1.2.0' }], 'v')).toEqual({
      '1.3.1': '1.3.1-main.4',
      '1.2.0': '1.2.0-main.8',
    });
    expect(
      releasedFrom(
        [
          { name: 'w@2.0.0-main.1', sha: 'a' },
          { name: 'w@2.0.0', sha: 'a' },
        ],
        [],
        'w@',
      ),
    ).toEqual({
      '2.0.0': '2.0.0-main.1',
    });
  });
});
