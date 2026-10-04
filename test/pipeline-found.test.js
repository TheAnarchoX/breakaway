import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_PATH, pipelineFound, samePipeline } from '../src/pipeline-found.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, setPipeline } from './helpers.js';

// Turn on deploys (WEB-13, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 5).
const body = async (res) => ({ code: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

const CONFIG = {
  workers: { staging: 'widgets-staging', production: 'widgets' },
  checks: ['CI'],
  install: 'npm ci',
  build: 'npm run build',
  deployPaths: { widgets: '^src/' },
};
const RENDERED = ['deploy.yml', 'promote.yml', 'rollback.yml'];
const PIPELINE = {
  workers: { staging: 'widgets-staging', production: 'widgets' },
  workflows: { deploy: 'deploy.yml', promote: 'promote.yml', rollback: 'rollback.yml' },
  deployPaths: '.github/deploy-paths.json',
};

describe('what the default branch says', () => {
  it('is nothing without the config: the repository hasn’t moved', () => {
    expect(pipelineFound({ config: null, workflows: RENDERED })).toBeNull();
  });

  it('works out the pipeline from the config and the rendered workflows', () => {
    const found = pipelineFound({
      config: JSON.stringify(CONFIG),
      github: ['breakaway-pipeline.json', 'deploy-paths.json'],
      workflows: ['ci.yml', ...RENDERED],
    });
    expect(found).toEqual({
      config: CONFIG_PATH,
      workers: CONFIG.workers,
      package: null,
      files: [
        '.github/workflows/deploy.yml',
        '.github/workflows/promote.yml',
        '.github/workflows/rollback.yml',
        '.github/deploy-paths.json',
      ],
      missing: [],
      pipeline: PIPELINE,
      problem: null,
    });
  });

  it('says which rendered files aren’t there yet, and offers nothing', () => {
    const found = pipelineFound({ config: JSON.stringify(CONFIG), github: [], workflows: ['deploy.yml'] });
    expect(found.pipeline).toBeNull();
    expect(found.missing).toEqual([
      '.github/workflows/promote.yml',
      '.github/workflows/rollback.yml',
      '.github/deploy-paths.json',
    ]);
    expect(found.problem).toMatch(
      /^Not on the default branch yet: \.github\/workflows\/promote\.yml, .+ Run npx breakaway pipeline init/u,
    );
  });

  it('refuses a config that isn’t JSON, names nothing, or names a Worker the board wouldn’t take', () => {
    expect(pipelineFound({ config: '{ nope', workflows: RENDERED }).problem).toMatch(/isn’t a JSON object/u);
    expect(pipelineFound({ config: '[]', workflows: RENDERED }).problem).toMatch(/isn’t a JSON object/u);
    expect(pipelineFound({ config: '{"checks":["CI"]}', workflows: RENDERED }).problem).toMatch(
      /names no Workers and no package/u,
    );
    const bad = pipelineFound({
      config: JSON.stringify({ workers: { staging: 'a b', production: 'widgets' } }),
      workflows: RENDERED,
    });
    expect(bad.pipeline).toBeNull();
    expect(bad.problem).toMatch(
      /doesn’t make a pipeline the board takes: pipeline\.workers\.staging is a Worker name/u,
    );
  });

  it('needs the Release workflow for a package', () => {
    const config = JSON.stringify({ ...CONFIG, package: { name: 'widgets-cli' } });
    const found = pipelineFound({ config, github: ['deploy-paths.json'], workflows: RENDERED });
    expect(found.package).toBe('widgets-cli');
    expect(found.missing).toEqual(['.github/workflows/release.yml']);
    expect(found.pipeline).toBeNull();
  });

  it('compares pipelines whatever their keys’ order', () => {
    const shuffled = { deployPaths: PIPELINE.deployPaths, workflows: PIPELINE.workflows, workers: PIPELINE.workers };
    expect(samePipeline(shuffled, PIPELINE)).toBe(true);
    expect(samePipeline({ ...PIPELINE, deployPaths: '.github/other.json' }, PIPELINE)).toBe(false);
  });
});

// GitHub, mocked for acme/widgets: the default branch's .github files, and every other read empty.
const REPO = '/repos/acme/widgets';
const gh = { config: null, github: [], workflows: [], head: 'sha1', calls: [] };

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) throw new Error(`unexpected write ${path}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const rest = path.slice(REPO.length);
    if (rest.startsWith('/contents/')) {
      gh.calls.push(rest);
      if (url.searchParams.get('ref') !== 'main') return reply({ message: 'Not Found' }, 404);
      const listing = (names) => names.map((name) => ({ name, type: 'file' }));
      if (rest === `/contents/${CONFIG_PATH}`)
        return gh.config === null
          ? reply({ message: 'Not Found' }, 404)
          : reply({ type: 'file', encoding: 'base64', content: b64(gh.config) });
      if (rest === '/contents/.github') return reply([...listing(gh.github), { name: 'workflows', type: 'dir' }]);
      if (rest === '/contents/.github/workflows') return reply(listing(gh.workflows));
      return reply({ message: 'Not Found' }, 404);
    }
    if (rest === '/actions/runs') return reply({ workflow_runs: [] });
    if (rest === '/commits')
      return reply([
        {
          sha: gh.head,
          html_url: `https://github.com/acme/widgets/commit/${gh.head}`,
          commit: { message: 'Move to the deploy flow', author: { name: 'x', date: '2026-10-04T10:00:00Z' } },
        },
      ]);
    if (['/pulls', '/dependabot/alerts', '/deployments', '/releases', '/tags'].includes(rest)) return reply([]);
    return reply({ message: 'Not Found' }, 404);
  });
}

const sync = async () => body(await api('github/sync', { method: 'POST' }));
const overview = async () => body(await api('github'));
const moved = () => {
  gh.config = JSON.stringify(CONFIG);
  gh.github = ['breakaway-pipeline.json', 'deploy-paths.json'];
  gh.workflows = ['ci.yml', ...RENDERED];
};

/** The signed-in browser: the cookie from /login, from this origin. */
async function press(payload = {}, { origin = ORIGIN } = {}) {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  return body(
    await SELF.fetch(`${ORIGIN}/api/repos/widgets/pipeline`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload),
    }),
  );
}

const repoRow = async () => (await body(await api('repos/widgets'))).repo;

describe('Turn on deploys', () => {
  let spy;
  let heads = 0;
  beforeEach(async () => {
    spy = mockGitHub();
    // The store lasts the whole file: each test starts on a new commit, with no pipeline.
    heads += 1;
    Object.assign(gh, { config: null, github: [], workflows: [], head: `head${heads}`, calls: [] });
    await api('repos/widgets', { method: 'PATCH', body: { pipeline: null } });
  });
  afterEach(() => spy.mockRestore());

  it('finds nothing for a repository that hasn’t moved, with one read', async () => {
    const view = await sync();
    expect(view.pipelineFound).toBeNull();
    expect(gh.calls).toEqual([`/contents/${CONFIG_PATH}`]);
  });

  it('shows what the default branch says once the move merged, and changes nothing until the press', async () => {
    moved();
    const view = await sync();
    expect(view.pipeline).toBeNull();
    expect(view.pipelineFound).toMatchObject({ workers: CONFIG.workers, pipeline: PIPELINE, problem: null });
    expect((await repoRow()).pipeline).toBeNull();
    // Read once per commit on the default branch: a sync with the same head reads nothing.
    gh.calls = [];
    await sync();
    expect(gh.calls).toEqual([]);
    gh.head = `${gh.head}-next`;
    await sync();
    expect(gh.calls).toContain(`/contents/${CONFIG_PATH}`);
    expect((await overview()).pipelineFound.pipeline).toEqual(PIPELINE);
  });

  it('sets the pipeline on the owner’s press, as repos modify --pipeline would', async () => {
    moved();
    await sync();
    const turned = await press({ pipeline: PIPELINE });
    expect(turned).toMatchObject({ code: 200, pipeline: PIPELINE });
    expect((await repoRow()).pipeline).toEqual(PIPELINE);
    const view = await overview();
    expect(view.pipeline).toEqual({ staging: 'widgets-staging', production: 'widgets' });
    expect(view.pipelineFound).toBeNull();
    // A second press changes nothing.
    expect(await press({ pipeline: PIPELINE })).toMatchObject({ code: 409, error: /has a pipeline already/u });
  });

  it('refuses the bearer token, another origin, and an agent', async () => {
    moved();
    await sync();
    const bearer = await body(await api('repos/widgets/pipeline', { method: 'POST', body: {} }));
    expect(bearer).toMatchObject({ code: 403, error: /only the signed-in web board can turn on deploys/u });
    expect(await press({}, { origin: 'https://elsewhere.example' })).toMatchObject({ code: 403 });
    expect(await press({ by: 'claude-x' })).toMatchObject({ code: 403, error: /only the owner/u });
    expect((await repoRow()).pipeline).toBeNull();
  });

  it('reads the default branch again on the press, and refuses what changed or isn’t there', async () => {
    moved();
    await sync();
    // The branch changed since the page loaded: a different pipeline is a 409 with what's there now.
    gh.config = JSON.stringify({ ...CONFIG, workers: { staging: 'w-staging', production: 'w' } });
    const changed = await press({ pipeline: PIPELINE });
    expect(changed).toMatchObject({ code: 409, error: /changed since you loaded the page/u });
    expect(changed.found.pipeline.workers).toEqual({ staging: 'w-staging', production: 'w' });
    // A rendered file went missing.
    gh.workflows = ['deploy.yml'];
    expect(await press({})).toMatchObject({ code: 409, error: /Not on the default branch yet/u });
    // The config is gone.
    gh.config = null;
    expect(await press({})).toMatchObject({ code: 409, error: /isn’t on main\. Merge the move’s pull request first/u });
    expect((await repoRow()).pipeline).toBeNull();
  });

  it('keeps nothing for a repository with a pipeline already', async () => {
    moved();
    await setPipeline();
    gh.calls = [];
    const view = await sync();
    expect(view.pipelineFound).toBeNull();
    expect(gh.calls).not.toContain(`/contents/${CONFIG_PATH}`);
    expect(await press({})).toMatchObject({ code: 409, error: /has a pipeline already/u });
  });
});
