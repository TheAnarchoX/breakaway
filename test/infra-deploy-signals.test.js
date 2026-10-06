import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setPipeline } from './helpers.js';
import { DEPLOY_SOURCE, deploySignal } from '../src/infra-deploy-signals.js';

// The deploy flow's failed health checks and roll backs as signals (BRK-198), against a pretend GitHub. Its own
// file: the Deployments it records must not mix with the other tests'.
const REPO = '/repos/acme/widgets';
const gh = { deployments: [], statuses: {} };
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => fn(instance));

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === `${REPO}/deployments`) return reply(gh.deployments);
    const m = /\/deployments\/(\d+)\/statuses$/u.exec(path);
    if (m) return reply(gh.statuses[m[1]] ?? []);
    if (path === `${REPO}/actions/runs`) return reply({ workflow_runs: [] });
    if (['/pulls', '/commits', '/releases', '/tags', '/dependabot/alerts'].some((p) => path === `${REPO}${p}`))
      return reply([]);
    return reply({ message: 'Not Found' }, 404);
  });
}

let next = 5000;
const at = () => new Date(Date.now() - 60_000).toISOString();
/** Adds a Deployment, newest first as GitHub lists them, with its latest status. */
function record(environment, sha, state, description, task = 'deploy') {
  next += 1;
  gh.statuses[next] = [{ state, description, created_at: at(), log_url: 'https://github.com/x/actions/runs/9' }];
  gh.deployments = [
    { id: next, environment, sha, task, created_at: at(), creator: { login: 'github-actions[bot]' } },
    ...gh.deployments,
  ];
  return next;
}
/** Moves a Deployment on to a new latest status. */
const update = (id, state, description) => {
  gh.statuses[id] = [{ state, description, created_at: at(), log_url: 'https://github.com/x/actions/runs/9' }];
};
const sync = async () => {
  const res = await api('github/sync', { method: 'POST' });
  expect(res.status).toBe(200);
  return res.json();
};
const signals = async (query) => {
  const res = await api(`infra/signals?source=deploy&${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).signals;
};

describe('deploySignal', () => {
  const staging = { name: 'staging', id: 3, production: false };
  const production = { name: 'production', id: null, production: true };
  const deploy = (over = {}) => ({
    env: 'widgets-staging',
    sha: 'a'.repeat(40),
    task: 'deploy',
    state: 'failure',
    description: 'rolled back: version 0a1b2c3d failed its check',
    version: null,
    created: '2026-10-06T10:00:00Z',
    updated: '2026-10-06T10:05:00Z',
    ...over,
  });

  it('turns a staging deploy that failed its check and went back into one alert, a warning', () => {
    expect(deploySignal(deploy(), 'in_progress', staging)).toEqual({
      source: DEPLOY_SOURCE,
      environment: 'staging',
      environmentId: 3,
      resource: 'widgets-staging',
      kind: 'alert',
      level: 'warning',
      value: null,
      at: '2026-10-06T10:05:00Z',
      text: 'widgets-staging deploy of aaaaaaa failed its check and went back: rolled back: version 0a1b2c3d failed its check',
    });
  });

  it('makes a failed production deploy critical', () => {
    expect(deploySignal(deploy({ env: 'widgets' }), 'in_progress', production)).toMatchObject({
      environment: 'production',
      environmentId: null,
      kind: 'alert',
      level: 'critical',
    });
  });

  it('says a failed deploy failed, and an error counts as failed', () => {
    const s = deploySignal(deploy({ state: 'error', description: 'failed: the run says why' }), null, staging);
    expect(s).toMatchObject({
      kind: 'alert',
      level: 'warning',
      text: 'widgets-staging deploy of aaaaaaa failed: failed: the run says why',
    });
  });

  it('marks a roll back that landed as health info, and a failed one as a critical alert', () => {
    const rollback = { task: 'rollback', env: 'widgets', version: '0a1b2c3d-1111-2222-3333-444455556666' };
    expect(
      deploySignal(
        deploy({ ...rollback, state: 'success', description: 'rolled back: 500s' }),
        'in_progress',
        production,
      ),
    ).toMatchObject({
      environment: 'production',
      environmentId: null,
      kind: 'health',
      level: 'info',
      text: 'widgets rolled back to version 0a1b2c3d: rolled back: 500s',
    });
    expect(deploySignal(deploy({ ...rollback, description: null }), 'in_progress', production)).toMatchObject({
      kind: 'alert',
      level: 'critical',
      text: 'widgets roll back to version 0a1b2c3d failed',
    });
  });

  it('sends nothing for a successful deploy, a state it already saw, or a deploy still running', () => {
    expect(deploySignal(deploy({ state: 'success' }), 'in_progress', staging)).toBeNull();
    expect(deploySignal(deploy(), 'failure', staging)).toBeNull();
    expect(deploySignal(deploy({ state: 'error' }), 'failure', staging)).toBeNull();
    expect(deploySignal(deploy({ state: 'in_progress' }), null, staging)).toBeNull();
    expect(deploySignal(deploy({ task: 'rollback', state: 'in_progress' }), null, staging)).toBeNull();
  });
});

describe("the deploy flow's signals", () => {
  let spy;
  let stagingId;
  beforeAll(async () => {
    await setPipeline();
    const created = await inStore((store) =>
      store.environmentsCreateApi({
        repo: 'widgets',
        name: 'staging',
        kind: 'staging',
        provider: 'cloudflare',
        target: 'widgets-staging',
      }),
    );
    expect(created.status).toBe(201);
    stagingId = created.body.environment.id;
  });
  beforeEach(() => {
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  it('records history on the first sync, then a failed staging deploy becomes a signal on staging', async () => {
    record('widgets-staging', 'b'.repeat(40), 'failure', 'rolled back: version 0a1b2c3d failed its check');
    await sync();
    expect(await signals('environment=staging')).toEqual([]);

    const id = record('widgets-staging', 'c'.repeat(40), 'in_progress', 'pre-release · deploying');
    await sync();
    expect(await signals('environment=staging')).toEqual([]);

    update(id, 'failure', 'rolled back: version 1a2b3c4d failed its check');
    await sync();
    expect(await inStore((store) => store.ghMeta('gh_error', 'widgets'))).toBeNull();
    const [signal, ...rest] = await signals('environment=staging');
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      source: 'deploy',
      environment: 'staging',
      environmentId: stagingId,
      resource: 'widgets-staging',
      kind: 'alert',
      level: 'warning',
      value: null,
      text: 'widgets-staging deploy of ccccccc failed its check and went back: rolled back: version 1a2b3c4d failed its check',
    });

    // The same failure seen again sends nothing more.
    await sync();
    expect(await signals('environment=staging')).toHaveLength(1);
  });

  it("puts production's on production by name until an environment targets its Worker, and skips a Worker nothing names", async () => {
    // An environment called production that targets no Worker isn't the pipeline's: its ID is never guessed from a name.
    const named = await inStore((store) =>
      store.environmentsCreateApi({ repo: 'widgets', name: 'production', kind: 'production', provider: 'cloudflare' }),
    );
    expect(named.status).toBe(201);
    record('widgets', 'd'.repeat(40), 'success', 'rolled back: 500s', 'rollback');
    record('widgets', 'e'.repeat(40), 'success', 'version 2a3b4c5d-1111-2222-3333-444455556666 · migrations none');
    record('widgets', '2'.repeat(40), 'failure', 'rolled back: version 3a4b5c6d failed its check');
    record('somewhere-else', 'f'.repeat(40), 'failure', 'failed: the run says why');
    await sync();
    const production = await signals('environment=production');
    expect(production.map((s) => [s.kind, s.level, s.environmentId, s.resource])).toEqual([
      ['alert', 'critical', null, 'widgets'],
      ['health', 'info', null, 'widgets'],
    ]);
    expect(await signals('resource=somewhere-else')).toEqual([]);
  });

  it('uses the environment whose target is the Worker, by its own name', async () => {
    const created = await inStore((store) =>
      store.environmentsCreateApi({
        repo: 'widgets',
        name: 'edge',
        kind: 'staging',
        provider: 'cloudflare',
        target: 'widgets-edge',
      }),
    );
    record('widgets-edge', '1'.repeat(40), 'failure', 'failed: the run says why');
    await sync();
    expect(await signals('environment=edge')).toMatchObject([
      { environment: 'edge', environmentId: created.body.environment.id, level: 'warning' },
    ]);
  });
});
