import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { distTags, registryUrl, stagedIn } from '../src/packages.js';
import { TEST_GITHUB_APP_ID } from './constants.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const LINE = (name, version, tag) =>
  `${name}@${version} goes live on ${tag} once the owner approves it with 2FA: npm stage approve <id>, or Staged Packages on npmjs.com.`;

describe('reading what a run staged', () => {
  it('reads the release flow’s notice, scoped packages too', () => {
    expect(stagedIn(LINE('widgets-cli', '1.2.0-main.1', 'next'))).toEqual([
      { name: 'widgets-cli', version: '1.2.0-main.1', tag: 'next' },
    ]);
    expect(stagedIn(LINE('@acme/widgets', '2.0.0', 'latest'))).toEqual([
      { name: '@acme/widgets', version: '2.0.0', tag: 'latest' },
    ]);
  });

  it('ignores other notices and anything npm wouldn’t accept', () => {
    expect(stagedIn('Deployed widgets-staging, version a1111111')).toEqual([]);
    expect(stagedIn(LINE('Widgets', '1.0.0', 'next'))).toEqual([]);
    expect(stagedIn(LINE('widgets', 'one', 'next'))).toEqual([]);
    expect(stagedIn(LINE('../widgets', '1.0.0', 'next'))).toEqual([]);
    expect(stagedIn(null)).toEqual([]);
  });

  it('builds the registry’s URLs and keeps only real dist-tags', () => {
    expect(registryUrl('@acme/widgets', '1.0.0')).toBe('https://registry.npmjs.org/@acme%2fwidgets/1.0.0');
    expect(registryUrl('widgets')).toBe('https://registry.npmjs.org/widgets');
    expect(distTags({ 'dist-tags': { latest: '1.0.0', next: '1.1.0-main.2', bad: '<script>' } })).toEqual({
      latest: '1.0.0',
      next: '1.1.0-main.2',
    });
    expect(distTags(null)).toEqual({});
  });
});

// GitHub and npm's registry, mocked: nothing reaches the network.
const REPO = '/repos/acme/widgets';
const state = {
  runs: [],
  checkRuns: {}, // suite id → check runs
  annotations: {}, // check run id → annotations
  published: new Set(), // "name@version" npm answers 200 for
  tags: {}, // name → dist-tags
  registryDown: false,
  calls: [],
};

function run(id, { status = 'completed', suite = id * 10, created = `2026-10-0${id % 9 || 1}T10:00:00Z` } = {}) {
  return {
    id,
    name: 'Release',
    display_title: `Release ${id}`,
    head_branch: 'main',
    head_sha: `sha${id}`,
    event: 'push',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
    created_at: created,
    updated_at: created,
    run_number: id,
    check_suite_id: suite,
  };
}

/** A run whose job printed the release flow's notice for each [name, version, tag]. */
function staging(id, ...lines) {
  state.runs.push(run(id));
  state.checkRuns[id * 10] = [{ id: id * 100, output: { annotations_count: lines.length } }];
  state.annotations[id * 100] = lines.map(([name, version, tag]) => ({
    annotation_level: 'notice',
    title: 'Staged on npm',
    message: LINE(name, version, tag),
  }));
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
  const claims = JSON.parse(atob(p.replaceAll('-', '+').replaceAll('_', '/')));
  return valid && claims.iss === TEST_GITHUB_APP_ID;
}

function mockServices() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    state.calls.push(`${url.host}${path}`);
    if (url.host === 'registry.npmjs.org') {
      if (state.registryDown) return reply({ error: 'Service Unavailable' }, 503);
      const name = decodeURIComponent(path.slice(1)).replace(/\/(\d[^/]*)$/u, '');
      const version = /\/(\d[^/]*)$/u.exec(path)?.[1];
      if (version)
        return state.published.has(`${name}@${version}`)
          ? reply({ name, version })
          : reply({ error: 'Not found' }, 404);
      return state.tags[name] ? reply({ name, 'dist-tags': state.tags[name] }) : reply({ error: 'Not found' }, 404);
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) throw new Error(`unexpected write ${path}`);
    if (path === `${REPO}/installation` || path.startsWith('/app/installations/')) {
      if (!(await verifyJwt(auth))) return reply({ message: 'Bad credentials' }, 401);
      return path.endsWith('/installation')
        ? reply({ id: 77 })
        : reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (auth !== 'Bearer ghs_test') return reply({ message: 'Bad credentials' }, 401);
    if (!path.startsWith(`${REPO}/`)) return reply({ message: 'Not Found' }, 404);
    const rest = path.slice(REPO.length);
    if (rest === '/actions/runs') return reply({ workflow_runs: state.runs });
    if (['/pulls', '/commits', '/dependabot/alerts', '/deployments', '/releases', '/tags'].includes(rest))
      return reply([]);
    let m = /^\/check-suites\/(\d+)\/check-runs$/u.exec(rest);
    if (m) return reply({ check_runs: state.checkRuns[m[1]] ?? [] });
    m = /^\/check-runs\/(\d+)\/annotations$/u.exec(rest);
    if (m) return reply(state.annotations[m[1]] ?? []);
    return reply({ message: 'Not Found' }, 404);
  });
}

const sync = async () => body(await api('github/sync', { method: 'POST' }));
const feed = async () => body(await api('github/packages'));
const npmRow = async () => (await body(await api('connections'))).connections.filter((c) => c.id === 'npm');

describe('the Packages feed', () => {
  let spy;
  beforeEach(() => {
    spy = mockServices();
    state.calls = [];
  });
  afterEach(() => spy.mockRestore());

  it('shows nothing, and asks npm nothing, for a repository whose runs stage no package', async () => {
    state.runs.push(run(1));
    state.checkRuns[10] = [{ id: 100, output: { annotations_count: 1 } }];
    state.annotations[100] = [{ annotation_level: 'notice', message: 'Deployed widgets-staging' }];
    const overview = await sync();
    expect(overview.packages).toEqual([]);
    expect(await feed()).toMatchObject({ status: 200, versions: [], packages: [] });
    expect(state.calls.some((c) => c.startsWith('registry.npmjs.org'))).toBe(false);
    expect(await npmRow()).toEqual([]);
  });

  it('reads a staged version from a run’s notice, and says it waits for approval on npm', async () => {
    staging(2, ['widgets-cli', '1.2.0-main.1', 'next']);
    state.tags['widgets-cli'] = { latest: '1.1.0', next: '1.1.1-main.4' };
    state.runs.push(run(3, { status: 'in_progress' })); // not read until it finishes
    const overview = await sync();
    expect(overview.packages).toEqual([
      expect.objectContaining({
        repo: 'widgets',
        name: 'widgets-cli',
        version: '1.2.0-main.1',
        tag: 'next',
        state: 'staged',
        published: null,
        url: 'https://www.npmjs.com/package/widgets-cli',
        run: expect.objectContaining({
          id: 2,
          url: 'https://github.com/acme/widgets/actions/runs/2',
          workflow: 'Release',
        }),
      }),
    ]);
    const { packages } = await feed();
    expect(packages).toEqual([
      expect.objectContaining({ name: 'widgets-cli', tags: { latest: '1.1.0', next: '1.1.1-main.4' }, waiting: 1 }),
    ]);
    expect(state.calls).not.toContain(`api.github.com${REPO}/check-suites/30/check-runs`);
    // Each run's annotations are read once.
    state.calls = [];
    await sync();
    expect(state.calls).not.toContain(`api.github.com${REPO}/check-suites/20/check-runs`);
    const [row] = await npmRow();
    expect(row).toMatchObject({ group: 'npm', state: 'working' });
    expect(row.detail).toContain('1 version staged, waiting for approval on npm');
  });

  it('turns a staged version published once npm’s registry has it, and stops asking', async () => {
    state.published.add('widgets-cli@1.2.0-main.1');
    state.tags['widgets-cli'] = { latest: '1.1.0', next: '1.2.0-main.1' };
    // A later check, after the owner approved it on npm: a version staged days ago is asked about hourly.
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    await runInDurableObject(stub, (store) => store.checkRegistry('widgets', Date.now() + 2 * 3_600_000));
    const { versions } = await feed();
    expect(versions[0]).toMatchObject({
      name: 'widgets-cli',
      version: '1.2.0-main.1',
      state: 'published',
      url: 'https://www.npmjs.com/package/widgets-cli/v/1.2.0-main.1',
    });
    expect(versions[0].published).toBeTruthy();
    state.calls = [];
    await sync();
    expect(state.calls.some((c) => c.startsWith('registry.npmjs.org'))).toBe(false);
  });

  it('says on Connections when npm’s registry is down, and keeps the version staged to ask again', async () => {
    staging(4, ['@acme/widgets', '3.0.0', 'latest']);
    state.registryDown = true;
    await sync();
    const { versions } = await feed();
    expect(versions.find((v) => v.name === '@acme/widgets')).toMatchObject({ state: 'staged', checked: null });
    const [row] = await npmRow();
    expect(row.state).toBe('attention');
    expect(row.detail).toContain('503');
    expect(row.fix).toContain('status.npmjs.org');
    state.registryDown = false;
    state.published.add('@acme/widgets@3.0.0');
    await sync();
    expect((await feed()).versions.find((v) => v.name === '@acme/widgets').state).toBe('published');
    expect((await npmRow())[0].state).toBe('working');
  });
});
