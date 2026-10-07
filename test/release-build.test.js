import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, TEST_API_TOKEN, TEST_GITHUB_APP_ID } from './constants.js';
import { api } from './helpers.js';
import { BUILD_SHOWN_MS, aheadOfPrerelease, prereleaseBuild, prereleaseByHand } from '../src/release.js';

// Build a pre-release (WEB-113), against a pretend GitHub: nothing reaches the network.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const REPO = '/repos/acme/widgets';

/** A release workflow that builds pre-releases only by hand, as breakaway's own does since BRK-273. */
const BY_HAND = `name: Release
on:
  workflow_dispatch:
    inputs:
      prerelease:
        description: Empty publishes a pre-release of main. A pre-release's tag promotes it
        required: false
        default: ''
        type: string
      next:
        required: false
        default: patch
        type: choice
        options: [patch, minor, major]
jobs:
  prerelease:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

/** The release flow's rendered release.yml: a pre-release after every CI on main, and stable by hand. */
const AFTER_CI = `name: Release
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      prerelease:
        description: The pre-release to release as stable
        required: true
        type: string
jobs:
  stable:
    runs-on: ubuntu-latest
    steps:
      - run: echo stable
`;

const sha = (n) => `${String(n).padStart(4, '0')}`.padEnd(40, 'a');
const commit = (n, message) => ({
  sha: sha(n),
  message,
  pr: Number(/\(#(\d+)\)$/u.exec(message)?.[1]) || null,
  wids: [],
});

describe('which release workflows build pre-releases by hand', () => {
  it('is one run only by hand, whose prerelease input may be left empty', () => {
    expect(prereleaseByHand(BY_HAND)).toBe(true);
    expect(prereleaseByHand(BY_HAND.replace("required: false\n        default: ''", 'required: false'))).toBe(true);
  });

  it('isn’t one that builds them after CI, needs a pre-release, or can’t be read', () => {
    expect(prereleaseByHand(AFTER_CI)).toBe(false);
    expect(prereleaseByHand(AFTER_CI.replace(/ {2}workflow_run:[\s\S]*?branches: \[main\]\n/u, ''))).toBe(false);
    expect(prereleaseByHand(BY_HAND.replace('on:\n', 'on:\n  push:\n    branches: [main]\n'))).toBe(false);
    expect(prereleaseByHand(BY_HAND.replace("default: ''", 'default: v1.0.0-main.1'))).toBe(false);
    expect(prereleaseByHand('name: CI\non: push\njobs: {}\n')).toBe(false);
    expect(prereleaseByHand('on: [workflow_dispatch\n')).toBe(false);
  });
});

describe('what main has since a pre-release', () => {
  const commits = [
    commit(5, 'WEB-9: Sort the list (#45)'),
    commit(4, "Merge branch 'main' into web-8"),
    commit(3, 'Fix a typo'),
    commit(2, 'BRK-7: Count the merges (#42)'),
    commit(1, 'BRK-6: First (#41)'),
  ];
  const prs = [
    {
      number: 45,
      title: 'WEB-9: Sort the list',
      state: 'merged',
      url: 'https://github.com/acme/widgets/pull/45',
      closes: ['WEB-9'],
    },
    {
      number: 42,
      title: 'BRK-7: Count the merges',
      state: 'merged',
      closes: [],
      tasks: [{ wid: 'BRK-7', closes: true }],
    },
  ];

  it('lists each pull request merged after its commit, newest first, with the work IDs it closes', () => {
    expect(aheadOfPrerelease({ commits, sha: sha(1), prs })).toEqual({
      merges: 3,
      atLeast: false,
      head: sha(5).slice(0, 7),
      prs: [
        { number: 45, title: 'WEB-9: Sort the list', url: 'https://github.com/acme/widgets/pull/45', wids: ['WEB-9'] },
        { number: null, title: 'Fix a typo', url: null, sha7: sha(3).slice(0, 7), wids: [] },
        { number: 42, title: 'BRK-7: Count the merges', url: null, wids: ['BRK-7'] },
      ],
    });
  });

  it('is nothing at main’s head, at least every kept commit when its commit is older, and unknown without one', () => {
    expect(aheadOfPrerelease({ commits, sha: sha(5), prs })).toMatchObject({ merges: 0, prs: [] });
    expect(aheadOfPrerelease({ commits, sha: sha(99), prs })).toMatchObject({ merges: 4, atLeast: true });
    expect(aheadOfPrerelease({ commits, sha: null, prs })).toBeNull();
    expect(aheadOfPrerelease({ commits: [], sha: sha(1), prs })).toBeNull();
  });
});

describe('Build a pre-release: when it may be pressed', () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const ahead = { merges: 2, atLeast: false, prs: [] };
  const base = { workflow: 'release.yml', branch: 'main', ahead, headSha: sha(9), now };
  const ci = (status, conclusion = null) => ({
    sha: sha(9),
    event: 'push',
    path: '.github/workflows/ci.yml',
    name: 'CI',
    status,
    conclusion,
    created: at(-600_000),
  });

  it('may be pressed when main has merges since the latest pre-release and CI passed on its head', () => {
    expect(prereleaseBuild({ ...base, runs: [ci('completed', 'success')] })).toMatchObject({
      allowed: true,
      reason: null,
      ci: 'success',
      build: null,
    });
    // No CI run seen on the head: the workflow checks it, so the button doesn't guess.
    expect(prereleaseBuild(base)).toMatchObject({ allowed: true, ci: null });
  });

  it('says why not: nothing new, CI running or failed on the head', () => {
    expect(prereleaseBuild({ ...base, ahead: { merges: 0, prs: [] } }).reason).toMatch(/has everything on main/u);
    expect(prereleaseBuild({ ...base, runs: [ci('in_progress')] }).reason).toMatch(/CI is still running/u);
    expect(prereleaseBuild({ ...base, runs: [ci('completed', 'failure')] }).reason).toMatch(/CI failed/u);
  });

  it('follows the run the press started, until its pre-release is staged', () => {
    const started = now - 120_000;
    const release = (status, conclusion = null) => ({
      path: '.github/workflows/release.yml',
      branch: 'main',
      event: 'workflow_dispatch',
      status,
      conclusion,
      url: 'https://github.com/acme/widgets/actions/runs/7',
      number: 7,
      created: at(-100_000),
    });
    const older = { ...release('completed', 'failure'), created: at(-3_600_000) };
    expect(prereleaseBuild({ ...base, started, runs: [older] })).toMatchObject({
      allowed: false,
      build: { state: 'starting', run: null },
    });
    expect(prereleaseBuild({ ...base, started, runs: [older, release('in_progress')] })).toMatchObject({
      allowed: false,
      build: { state: 'running', run: { number: 7 } },
    });
    expect(prereleaseBuild({ ...base, started, runs: [release('completed', 'failure')] })).toMatchObject({
      allowed: true,
      build: { state: 'failed' },
    });
    const latest = { version: '1.4.0-main.6', staged: at(-30_000) };
    expect(prereleaseBuild({ ...base, started, latest, runs: [release('completed', 'success')] })).toMatchObject({
      build: { state: 'built', version: '1.4.0-main.6' },
    });
    // An old press says nothing any more.
    expect(prereleaseBuild({ ...base, started: now - BUILD_SHOWN_MS - 1 }).build).toBeNull();
  });
});

// The board, its sync, and the press, with GitHub mocked.
const gh = { workflow: BY_HAND, commits: [], pulls: [], runs: [], tags: [], writes: [], reads: [] };

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
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === '/graphql') return reply({ errors: [{ message: 'not in this test' }] });
    if (path === `${REPO}/installation` || path.startsWith('/app/installations/')) {
      if (!(await verifyJwt(auth))) return reply({ message: 'Bad credentials' }, 401);
      return path.endsWith('/installation')
        ? reply({ id: 77 })
        : reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (init.method && init.method !== 'GET') {
      gh.writes.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      return new Response(null, { status: 204 });
    }
    gh.reads.push(path);
    if (path === `${REPO}/contents/.github/workflows/release.yml`)
      return reply({ content: btoa(gh.workflow), encoding: 'base64' });
    if (path === `${REPO}/pulls`) return reply(gh.pulls);
    if (path === `${REPO}/commits`) return reply(gh.commits);
    if (path === `${REPO}/actions/runs`) return reply({ workflow_runs: gh.runs });
    if (path === `${REPO}/tags`) return reply(gh.tags);
    if (['/dependabot/alerts', '/deployments', '/releases'].some((p) => path === `${REPO}${p}`)) return reply([]);
    if (/\/pulls\/\d+\/(files|reviews|comments)$/u.test(path)) return reply([]);
    if (/\/check-runs$/u.test(path)) return reply({ check_runs: [] });
    if (/\/status$/u.test(path)) return reply({ state: 'success', statuses: [] });
    return reply({ message: 'Not Found' }, 404);
  });
}

async function browser() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return (payload = {}) =>
    SELF.fetch(`${ORIGIN}/api/github/prerelease`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(payload),
    });
}

describe('Build a pre-release on the GitHub view (WEB-113)', () => {
  let spy;
  const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString();
  const ghCommit = (n, message, mins) => ({
    sha: sha(n),
    html_url: `https://github.com/acme/widgets/commit/${sha(n)}`,
    commit: { message, committer: { date: minutes(mins) } },
  });
  const pull = (number, title, n) => ({
    number,
    title,
    body: '',
    draft: false,
    state: 'closed',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    node_id: `PR_${number}`,
    head: { ref: `branch-${number}`, sha: `head${number}` },
    user: { login: 'claude[bot]' },
    created_at: minutes(200),
    updated_at: minutes(100),
    merge_commit_sha: sha(n),
    merged_at: minutes(100),
    closed_at: minutes(100),
  });
  const ciRun = (id, n, conclusion = 'success') => ({
    id,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: sha(n),
    event: 'push',
    status: 'completed',
    conclusion,
    html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
    created_at: minutes(30),
    updated_at: minutes(25),
    run_number: id,
  });

  async function setup({ workflow = BY_HAND, ci = 'success' } = {}) {
    const res = await api('repos/widgets', { method: 'PATCH', body: { pipeline: { package: '@acme/widgets' } } });
    expect(res.status).toBe(200);
    gh.workflow = workflow;
    gh.writes = [];
    gh.reads = [];
    gh.commits = [
      ghCommit(3, 'WEB-9: Sort the list (#45)', 40),
      ghCommit(2, 'BRK-7: Count the merges (#42)', 60),
      ghCommit(1, 'BRK-6: First (#41)', 90),
    ];
    gh.pulls = [
      pull(45, 'WEB-9: Sort the list', 3),
      pull(42, 'BRK-7: Count the merges', 2),
      pull(41, 'BRK-6: First', 1),
    ];
    gh.runs = [ciRun(901, 3, ci)];
    gh.tags = [{ name: 'v1.4.0-main.5', commit: { sha: sha(1) } }];
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    await runInDurableObject(stub, (store) => {
      store.sql.exec("DELETE FROM gh_packages WHERE repo = 'widgets'");
      store.sql.exec(`DELETE FROM gh_events WHERE repo = 'widgets' AND data LIKE '%prerelease_started%'`);
      store.setGhMeta('gh_release_mode', 'widgets', null);
      // The feed knows 1.4.0-main.5, staged from the run on BRK-6's commit (its tag names the commit).
      store.sql.exec(
        `INSERT INTO gh_packages (repo, name, version, tag, state, run, data, staged)
         VALUES ('widgets', '@acme/widgets', '1.4.0-main.5', 'next', 'published', 1, '{}', ?)`,
        minutes(80),
      );
    });
  }
  const sync = async () => body(await api('github/sync', { method: 'POST' }));

  beforeEach(() => {
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  it('says how far main is ahead of the latest pre-release, with its pull requests and work IDs', async () => {
    await setup();
    const view = await sync();
    expect(view.releaseBuild).toMatchObject({
      package: '@acme/widgets',
      workflow: 'release.yml',
      branch: 'main',
      allowed: true,
      ci: 'success',
      latest: { version: '1.4.0-main.5' },
      ahead: {
        merges: 2,
        atLeast: false,
        prs: [
          { number: 45, title: 'WEB-9: Sort the list' },
          { number: 42, title: 'BRK-7: Count the merges' },
        ],
      },
    });
    expect(view.releaseBuild.behind['1.4.0-main.5'].merges).toBe(2);
    // The workflow file is read once, and kept.
    await sync();
    expect(gh.reads.filter((p) => p.endsWith('/contents/.github/workflows/release.yml'))).toHaveLength(1);
  });

  it('offers nothing where the release workflow builds pre-releases after CI', async () => {
    await setup({ workflow: AFTER_CI });
    expect((await sync()).releaseBuild).toBeNull();
    const refused = await body(await (await browser())());
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.error).toMatch(/builds its pre-releases by itself/u);
    expect(gh.writes).toEqual([]);
  });

  it('starts the pre-release job on main with prerelease empty, records it, and follows its run', async () => {
    await setup();
    await sync();
    const ok = await body(await (await browser())());
    expect(ok).toMatchObject({ status: 200, ok: true, action: 'prerelease_started', workflow: 'release.yml' });
    expect(gh.writes).toEqual([
      ['POST', `${REPO}/actions/workflows/release.yml/dispatches`, { ref: 'main', inputs: { prerelease: '' } }],
    ]);
    expect(JSON.stringify(await body(await api('activity')))).toContain(
      '"prerelease_started","package":"@acme/widgets","branch":"main","after":"1.4.0-main.5","merges":2',
    );
    let view = await sync();
    expect(view.releaseBuild).toMatchObject({ allowed: false, build: { state: 'starting' } });
    // A second press while it builds is refused.
    expect((await (await browser())()).status).toBe(409);
    gh.runs.unshift({
      ...ciRun(902, 3),
      name: 'Release',
      path: '.github/workflows/release.yml',
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      created_at: new Date().toISOString(),
    });
    view = await sync();
    expect(view.releaseBuild.build).toMatchObject({ state: 'running', run: { number: 902 } });
  });

  it('is the owner’s from the signed-in board only: never a token, an agent, or another site', async () => {
    await setup();
    await sync();
    expect((await api('github/prerelease', { method: 'POST', body: {} })).status).toBe(403);
    expect((await (await browser())({ by: 'claude-web-1' })).status).toBe(403);
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
      redirect: 'manual',
    });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const cross = await SELF.fetch(`${ORIGIN}/api/github/prerelease`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
    expect(gh.writes).toEqual([]);
  });

  it('waits for CI on main’s head, and for something new to build', async () => {
    await setup({ ci: 'failure' });
    const view = await sync();
    expect(view.releaseBuild).toMatchObject({ allowed: false, ci: 'failure' });
    const refused = await body(await (await browser())());
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.error).toMatch(/CI failed on main/u);
    gh.runs = [ciRun(903, 3)];
    gh.tags = [{ name: 'v1.4.0-main.6', commit: { sha: sha(3) } }];
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    await runInDurableObject(stub, (store) => {
      store.sql.exec(
        `INSERT INTO gh_packages (repo, name, version, tag, state, run, data, staged)
         VALUES ('widgets', '@acme/widgets', '1.4.0-main.6', 'next', 'staged', 2, ?, ?)`,
        JSON.stringify({ sha: sha(3) }),
        new Date().toISOString(),
      );
    });
    const current = await sync();
    expect(current.releaseBuild).toMatchObject({
      allowed: false,
      latest: { version: '1.4.0-main.6' },
      ahead: { merges: 0 },
    });
    expect(current.releaseBuild.reason).toMatch(/has everything on main/u);
    expect(gh.writes).toEqual([]);
  });
});
