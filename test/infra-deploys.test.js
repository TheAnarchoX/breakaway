import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import {
  PIPELINE_PROVIDER,
  deployPlanDiff,
  deployRecord,
  deployState,
  deploySummary,
  pipelineEnvironments,
} from '../src/infra-deploys.js';

// The deploy flow as Architect's first instance (BRK-195), against a pretend GitHub. Its own file: the Deployments
// and environments it makes must not mix with the other tests'.
const REPO = '/repos/acme/widgets';
const gh = { deployments: [], statuses: {} };
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => fn(instance));
const PIPELINE = {
  workers: { staging: 'widgets-staging', production: 'widgets' },
  workflows: { deploy: 'deploy.yml', promote: 'promote.yml', rollback: 'rollback.yml' },
  deployPaths: '.github/deploy-paths.json',
};

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

let next = 7000;
const at = () => new Date(Date.now() - 60_000).toISOString();
const LOG = 'https://github.com/acme/widgets/actions/runs/9';
/** Adds a Deployment, newest first as GitHub lists them, with its latest status. */
function record(environment, sha, state, description, task = 'deploy') {
  next += 1;
  gh.statuses[next] = [{ state, description, created_at: at(), log_url: LOG }];
  gh.deployments = [
    { id: next, environment, sha, task, created_at: at(), creator: { login: 'github-actions[bot]' } },
    ...gh.deployments,
  ];
  return next;
}
const update = (id, state, description) => {
  gh.statuses[id] = [{ state, description, created_at: at(), log_url: LOG }];
};
const sync = async () => {
  const res = await api('github/sync', { method: 'POST' });
  expect(res.status).toBe(200);
  expect(await inStore((store) => store.ghMeta('gh_error', 'widgets'))).toBeNull();
};
const environments = async () => {
  const res = await api('infra/environments?repo=widgets');
  expect(res.status).toBe(200);
  return (await res.json()).environments;
};
const byName = async () => Object.fromEntries((await environments()).map((e) => [e.name, e]));
const audit = async (query) => {
  const res = await api(`infra/audit?repo=widgets&${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).entries;
};
const plan = async (id) => {
  const res = await api(`infra/plans/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()).plan;
};
const setPipeline = async (pipeline) => {
  const res = await api('repos/widgets', { method: 'PATCH', body: { pipeline } });
  expect(res.status).toBe(200);
};

describe('the deploy flow, pure', () => {
  const deploy = (over = {}) => ({
    id: 1,
    env: 'widgets-staging',
    sha: 'a'.repeat(40),
    task: 'deploy',
    state: 'success',
    description: 'version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none',
    version: '0a1b2c3d-1111-2222-3333-444455556666',
    migrations: 'none',
    created: '2026-10-06T10:00:00Z',
    updated: '2026-10-06T10:05:00Z',
    logUrl: LOG,
    ...over,
  });

  it('gives a pipeline a staging and a production environment on its Workers', () => {
    expect(pipelineEnvironments({ staging: 'widgets-staging', production: 'widgets' })).toEqual([
      { role: 'staging', name: 'staging', kind: 'staging', provider: PIPELINE_PROVIDER, target: 'widgets-staging' },
      { role: 'production', name: 'production', kind: 'production', provider: PIPELINE_PROVIDER, target: 'widgets' },
    ]);
  });

  it('tells a Deploy, a Promote, a Roll back, and an automatic rollback apart, and waits for one still running', () => {
    expect(deployRecord(deploy(), 'staging')).toEqual({
      action: 'deploy',
      kind: 'apply',
      by: 'executor',
      outcome: 'applied',
      plan: false,
    });
    expect(deployRecord(deploy({ env: 'widgets' }), 'production')).toEqual({
      action: 'promote',
      kind: 'apply',
      by: 'owner',
      outcome: 'applied',
      plan: true,
    });
    expect(deployRecord(deploy({ task: 'rollback' }), 'production')).toEqual({
      action: 'rollback',
      kind: 'rollback',
      by: 'owner',
      outcome: 'applied',
      plan: true,
    });
    const back = { state: 'failure', description: 'rolled back: version 1a2b3c4d failed its check' };
    expect(deployRecord(deploy(back), 'staging')).toEqual({
      action: 'deploy',
      kind: 'rollback',
      by: 'executor',
      outcome: 'rolled back',
      plan: false,
    });
    expect(deployRecord(deploy(back), 'production')).toMatchObject({ action: 'promote', kind: 'rollback', plan: true });
    expect(deployRecord(deploy({ state: 'error', description: 'failed' }), 'staging')).toMatchObject({
      kind: 'apply',
      outcome: 'failed',
    });
    expect(deployRecord(deploy({ task: 'rollback', state: 'failure' }), 'production')).toMatchObject({
      kind: 'rollback',
      outcome: 'failed',
    });
    expect(deployRecord(deploy({ state: 'in_progress' }), 'staging')).toBeNull();
    expect(deployRecord(deploy({ state: 'pending' }), 'production')).toBeNull();
    // A landed deploy a newer one replaced before the board saw it still landed.
    expect(deployRecord(deploy({ state: 'inactive' }), 'staging')).toMatchObject({ outcome: 'applied' });
  });

  it('sums a deploy up with its commit, version, migrations, why it failed, and its log', () => {
    expect(deploySummary(deploy(), 'deploy')).toBe(
      `Deploy of aaaaaaa to widgets-staging · version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none · log ${LOG}`,
    );
    expect(
      deploySummary(
        deploy({ state: 'failure', description: 'rolled back: 500s', version: null, migrations: null }),
        'promote',
      ),
    ).toBe(`Promote of aaaaaaa to widgets-staging · rolled back: 500s · log ${LOG}`);
  });

  it("makes a Promote's plan one change to the Worker, reversible unless it ran migrations", () => {
    const before = deploy({ sha: 'b'.repeat(40), version: 'feedbeef' });
    expect(deployPlanDiff(deploy({ env: 'widgets' }), before, 'production')).toEqual({
      provider: PIPELINE_PROVIDER,
      environment: 'production',
      changes: [
        {
          op: 'update',
          resource: 'worker:widgets',
          kind: 'worker',
          name: 'widgets',
          before: { commit: 'b'.repeat(40), version: 'feedbeef' },
          after: { commit: 'a'.repeat(40), version: '0a1b2c3d-1111-2222-3333-444455556666' },
          reversible: true,
        },
      ],
      reversible: true,
    });
    const migrated = deployPlanDiff(deploy({ migrations: '0004_drop_notes' }), null, 'staging');
    expect(migrated.reversible).toBe(false);
    expect(migrated.changes[0]).toMatchObject({ before: null, reversible: false, why: /0004_drop_notes/u });
  });

  it('reads what runs from the Deployments newest first: the last that landed, and the last of all', () => {
    const list = [
      deploy({ id: 3, sha: 'c'.repeat(40), state: 'in_progress', version: null }),
      deploy({ id: 2, sha: 'b'.repeat(40), state: 'failure' }),
      deploy({ id: 1, task: 'rollback' }),
    ];
    expect(deployState(list)).toEqual({
      live: {
        sha: 'a'.repeat(40),
        version: deploy().version,
        task: 'rollback',
        state: 'success',
        at: deploy().updated,
        url: LOG,
      },
      last: {
        sha: 'c'.repeat(40),
        version: null,
        task: 'deploy',
        state: 'in_progress',
        at: deploy().updated,
        url: LOG,
      },
    });
    expect(deployState([])).toEqual({ live: null, last: null });
  });
});

describe('a pipeline’s environments', () => {
  let spy;
  beforeEach(() => {
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  it('come to a repository that already had a pipeline on its next sync', async () => {
    // A pipeline saved before BRK-195, straight into the row, with no environments made for it.
    await inStore((store) => {
      store.sql.exec('UPDATE repos SET pipeline = ? WHERE slug = ?', JSON.stringify(PIPELINE), 'widgets');
      store.repoCache = null;
    });
    expect(await environments()).toEqual([]);
    await sync();
    const made = await environments();
    expect(made.map((e) => [e.name, e.kind, e.provider, e.target, e.pipeline, e.gates, e.observeOnly])).toEqual([
      ['production', 'production', 'cloudflare', 'widgets', 'production', true, false],
      ['staging', 'staging', 'cloudflare', 'widgets-staging', 'staging', false, false],
    ]);
    // Nothing deployed yet: the view says so rather than leaving it out.
    expect(made[0].deploys).toEqual({ live: null, last: null });
    // A second sync makes nothing more.
    await sync();
    expect(await environments()).toHaveLength(2);
  });

  it('follow a changed pipeline to its new Workers, keeping their IDs', async () => {
    const before = await byName();
    await setPipeline({ ...PIPELINE, workers: { staging: 'widgets-next', production: 'widgets' } });
    const after = await byName();
    expect(after.staging).toMatchObject({ id: before.staging.id, target: 'widgets-next', pipeline: 'staging' });
    expect(after.production).toMatchObject({ id: before.production.id, target: 'widgets' });
    await setPipeline(PIPELINE);
    expect((await byName()).staging.target).toBe('widgets-staging');
  });

  it('come with turning on deploys, taking over an environment of that name with no target, and leaving one that points elsewhere', async () => {
    await setPipeline(null);
    await inStore((store) => store.sql.exec("DELETE FROM infra_environments WHERE repo = 'widgets'"));
    const owners = await inStore(async (store) => {
      const staging = await store.environmentsCreateApi({
        repo: 'widgets',
        name: 'staging',
        kind: 'staging',
        provider: 'cloudflare',
      });
      const production = await store.environmentsCreateApi({
        repo: 'widgets',
        name: 'production',
        kind: 'production',
        provider: 'cloudflare',
        target: 'something-else',
      });
      return { staging: staging.body.environment, production: production.body.environment };
    });
    // Turn on deploys saves the pipeline the way this does (src/store-pipeline.js, turnOnDeploysApi).
    await setPipeline(PIPELINE);
    const now = await byName();
    expect(now.staging).toMatchObject({ id: owners.staging.id, target: 'widgets-staging', pipeline: 'staging' });
    expect(now.production).toMatchObject({ id: owners.production.id, target: 'something-else', pipeline: null });
    expect(Object.keys(now)).toEqual(['production', 'staging']);
    // Back to the pipeline's own production for the rest of the file.
    await inStore((store) => store.sql.exec('DELETE FROM infra_environments WHERE id = ?', owners.production.id));
    await setPipeline(PIPELINE);
    expect((await byName()).production).toMatchObject({ target: 'widgets', pipeline: 'production' });
  });

  it('keep the board’s own Worker observe only', async () => {
    await setPipeline({ ...PIPELINE, workers: { staging: 'widgets-staging', production: 'widgets-tasks' } });
    expect((await byName()).production).toMatchObject({
      target: 'widgets-tasks',
      observeOnly: true,
      runsTheBoard: true,
    });
    await inStore((store) =>
      store.sql.exec("UPDATE infra_environments SET observe_only = 0 WHERE name = 'production'"),
    );
    await setPipeline(PIPELINE);
  });
});

describe('deploys on their environments', () => {
  let spy;
  let ids;
  beforeEach(async () => {
    spy = mockGitHub();
    const named = await byName();
    ids = { staging: named.staging.id, production: named.production.id };
  });
  afterEach(() => spy.mockRestore());

  it('records history on the first sync, then each finished Deploy once, on staging, by the executor', async () => {
    // The first sync of this file's store already ran above: start from a fresh GitHub history.
    expect(await audit('environment=staging')).toEqual([]);
    const id = record('widgets-staging', 'a'.repeat(40), 'in_progress', 'deploying');
    await sync();
    expect(await audit(`environmentId=${ids.staging}`)).toEqual([]);

    update(id, 'success', 'version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none');
    await sync();
    const [entry, ...rest] = await audit(`environmentId=${ids.staging}`);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      kind: 'apply',
      repo: 'widgets',
      environment: 'staging',
      environmentId: ids.staging,
      plan: null,
      by: 'executor',
      outcome: 'applied',
      summary: `Deploy of aaaaaaa to widgets-staging · version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none · log ${LOG}`,
    });

    // Seen again, or turned inactive by a newer one, it records nothing more.
    await sync();
    update(id, 'inactive', null);
    await sync();
    expect(await audit(`environmentId=${ids.staging}`)).toHaveLength(1);

    const view = (await byName()).staging;
    expect(view.deploys.live).toMatchObject({ sha: 'a'.repeat(40), version: '0a1b2c3d-1111-2222-3333-444455556666' });
  });

  it('records a Promote on production as the owner’s, and as a plan that already ran', async () => {
    record('widgets', 'f'.repeat(40), 'success', 'version feedbeef · migrations none');
    await sync();
    const [earlier] = await audit(`environmentId=${ids.production}`);
    expect(earlier).toMatchObject({ kind: 'apply', by: 'owner', outcome: 'applied' });

    record('widgets', 'a'.repeat(40), 'success', 'version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none');
    await sync();
    const [entry] = await audit(`environmentId=${ids.production}`);
    expect(entry).toMatchObject({
      kind: 'apply',
      environment: 'production',
      environmentId: ids.production,
      by: 'owner',
      outcome: 'applied',
      summary: expect.stringContaining('Promote of aaaaaaa to widgets'),
    });
    expect(entry.plan).toMatch(/^plan-\d+$/u);
    const recorded = await plan(entry.plan);
    expect(recorded).toMatchObject({
      environment: { id: ids.production, name: 'production' },
      provider: 'cloudflare',
      target: 'widgets',
      source: { kind: 'deploy', ref: 'promote:aaaaaaa' },
      state: 'applied',
      by: 'owner',
      reversible: true,
      changes: 1,
    });
    expect(recorded.diff.changes[0]).toMatchObject({
      resource: 'worker:widgets',
      before: { commit: 'f'.repeat(40), version: 'feedbeef' },
      after: { commit: 'a'.repeat(40), version: '0a1b2c3d-1111-2222-3333-444455556666' },
    });

    const view = (await byName()).production;
    expect(view.deploys).toMatchObject({
      live: { sha: 'a'.repeat(40), task: 'deploy', state: 'success' },
      last: { sha: 'a'.repeat(40), url: LOG },
    });
    expect(view.waitingPlan).toBeNull();
  });

  it('records a Roll back as the owner’s rollback, with its plan', async () => {
    record('widgets', 'f'.repeat(40), 'success', 'rolled back: version feedbeef', 'rollback');
    await sync();
    const [entry] = await audit(`environmentId=${ids.production}`);
    expect(entry).toMatchObject({
      kind: 'rollback',
      by: 'owner',
      outcome: 'applied',
      summary: expect.stringContaining('Roll back of fffffff'),
    });
    expect(await plan(entry.plan)).toMatchObject({
      source: { kind: 'deploy', ref: 'rollback:fffffff' },
      state: 'applied',
    });
    expect((await byName()).production.deploys.live).toMatchObject({ sha: 'f'.repeat(40), task: 'rollback' });
  });

  it('records an automatic rollback after a failed check as the executor’s', async () => {
    record('widgets-staging', 'b'.repeat(40), 'failure', 'rolled back: version 1a2b3c4d failed its check');
    record('widgets', 'c'.repeat(40), 'failure', 'rolled back: version 2a3b4c5d failed its check');
    await sync();
    const [staging] = await audit(`environmentId=${ids.staging}`);
    expect(staging).toMatchObject({
      kind: 'rollback',
      by: 'executor',
      outcome: 'rolled back',
      plan: null,
      summary: expect.stringMatching(
        /^Deploy of bbbbbbb to widgets-staging · .*rolled back: version 1a2b3c4d failed its check/u,
      ),
    });
    const [production] = await audit(`environmentId=${ids.production}`);
    expect(production).toMatchObject({ kind: 'rollback', by: 'executor', outcome: 'rolled back' });
    expect(await plan(production.plan)).toMatchObject({ state: 'rolled back', source: { ref: 'promote:ccccccc' } });
    // What runs is still what ran before the failed one; the last deploy says it failed.
    expect((await byName()).staging.deploys).toMatchObject({
      live: { sha: 'a'.repeat(40) },
      last: { sha: 'b'.repeat(40), state: 'failure' },
    });
  });

  it('records a Worker no environment targets nowhere', async () => {
    const count = (await audit('limit=200')).length;
    record('somewhere-else', 'd'.repeat(40), 'success', 'version 9a8b7c6d');
    await sync();
    expect(await audit('limit=200')).toHaveLength(count);
  });

  it('records the board’s own install like any other, and never puts a plan in front of anyone', async () => {
    await setPipeline({ ...PIPELINE, workers: { staging: 'widgets-staging', production: 'widgets-tasks' } });
    record('widgets-tasks', 'e'.repeat(40), 'success', 'version 5a6b7c8d');
    await sync();
    const [entry] = await audit(`environmentId=${ids.production}`);
    expect(entry).toMatchObject({
      kind: 'apply',
      by: 'owner',
      summary: expect.stringContaining('Promote of eeeeeee to widgets-tasks'),
    });
    expect(await plan(entry.plan)).toMatchObject({ state: 'applied' });
    expect((await byName()).production).toMatchObject({ observeOnly: true, waitingPlan: null });
  });
});
