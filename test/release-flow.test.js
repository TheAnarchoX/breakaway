import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_API_TOKEN, TEST_GITHUB_APP_ID } from './constants.js';
import { api } from './helpers.js';
import { ORIGIN } from './constants.js';

// Promote and Roll back on the board (CLD-105), against a pretend GitHub. Its own file: the
// Deployments it records must not mix with the other tests'.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const REPO = '/repos/acme/samewave';
const gh = { pulls: [], deployments: [], statuses: {}, compares: {}, compareFiles: {}, writes: [], writeError: null };

function pr(number, { title, body: text = '', mergeSha = null } = {}) {
  return {
    number,
    title,
    body: text,
    draft: false,
    state: 'closed',
    html_url: `https://github.com/acme/samewave/pull/${number}`,
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
  beforeEach(() => {
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
      ['samewave', C, 'success', `version ${V_C} · migrations none`],
      ['samewave', A, 'success', `version ${V_A} · migrations none`],
      ['samewave-staging', B, 'success', `pre-release · version ${V_B} · artifact ${DIGEST} · migrations 0013_x.sql`],
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
    await api('tasks', { method: 'POST', body: [{ description: 'Something', project: 'cloud', tags: ['agent'] }] });
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
      ['samewave-staging', A, 'success', `pre-release · version ${V_A} · artifact ${DIGEST}`],
      ['samewave-staging', B, 'in_progress', 'Deploying'],
    ]);
    const deploying = await sync();
    expect(deploying.promote.reason).toMatch(/Staging is still deploying/u);
    expect(deploying.staging).toMatchObject({ state: 'deploying' });

    record([
      ['samewave-staging', A, 'success', `pre-release · version ${V_A} · artifact ${DIGEST}`],
      ['samewave', A, 'success', `version ${V_A} · migrations none`],
    ]);
    const same = await sync();
    expect(same.promote.reason).toMatch(/already runs/u);
    expect(same.line).toBe('Production is up to date with staging.');

    stagingAhead();
    record([['samewave', B, 'in_progress', 'promoting: migrating']]);
    const running = await sync();
    expect(running.promote.reason).toMatch(/already running/u);
    expect(running.rollback.reason).toMatch(/running/u);
    expect(running.production).toMatchObject({ state: 'deploying', step: 'migrating' });
  });

  it('says failed and rolled back in words, and warns when the candidate was tried before', async () => {
    stagingAhead();
    record([['samewave', B, 'failure', `health check failed; rolled back to ${V_A} (tried ${V_B})`]]);
    const flow = await sync();
    expect(flow.production.state).toBe('rolledback');
    expect(flow.promote).toMatchObject({ allowed: true, tried: { rolledBack: true } });
    record([['samewave', B, 'failure', 'failed before or during promote · migrations none']]);
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
      { ref: 'main', inputs: { worker: 'samewave', reason: 'sign-in is broken' } },
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
});
