import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import RUNNER_TEMPLATE from '../src/infra-runner-template.json';
import { RUNNER_WORKFLOW } from '../src/infra-runner.js';
import { RUNNER_NEEDS_WORKFLOWS, renderRunner } from '../src/infra-runner-render.js';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry, checkProvider } from '../src/infra-provider.js';
import { cloudflare } from '../src/infra-cloudflare.js';
import { TEMPLATE_BASE, WRITE_SECRET, tokenTemplate, writePermissions } from '../src/infra-cloudflare-tokens.js';
import { branchRuleFix, canMakeEnvironments, environmentSteps, stepsDone } from '../src/infra-tokens.js';

// Guided token setup (BRK-304): what each token needs, and the checklist for each GitHub environment, against a
// pretend GitHub. Nothing reaches the network, and no test ever handles a write token.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const REPO = 'acme/widgets';

describe('what Cloudflare’s write token needs (BRK-304)', () => {
  const names = (list) => list.map((p) => p.name);

  it('is the read token’s permissions and Workers Editor on the environment’s own Workers, with no desired state', () => {
    const list = writePermissions(null);
    expect(names(list)).toContain('Workers Metadata Read-Only');
    expect(list.find((p) => p.name === 'Workers Editor')).toMatchObject({ scope: 'workers-product' });
    expect(names(list).filter((n) => /Write|Admin/u.test(n))).toEqual([]);
  });

  it('adds only the Write permissions for the kinds the desired state declares, and Admin only for a new Worker', () => {
    const desired = {
      resources: [
        { kind: 'worker', name: 'acme-api' },
        { kind: 'worker', name: 'acme-jobs' },
        { kind: 'd1', name: 'acme-db' },
        { kind: 'queue', name: 'acme-q' },
      ],
    };
    const list = writePermissions(desired, { running: ['acme-api'] });
    expect(list.find((p) => p.name === 'Workers Editor')).toMatchObject({
      scope: 'workers',
      workers: ['acme-api', 'acme-jobs'],
    });
    expect(names(list)).toEqual(expect.arrayContaining(['D1 Write', 'Queues Write']));
    expect(names(list)).not.toContain('Workers KV Storage Write');
    expect(names(list)).not.toContain('Workers Routes Write');
    const admin = list.find((p) => p.name === 'Workers Admin');
    expect(admin).toMatchObject({ once: true, scope: 'workers-product' });
    expect(admin.for).toMatch(/making acme-jobs, which doesn’t run yet/u);
    expect(names(writePermissions(desired, { running: ['acme-api', 'acme-jobs'] }))).not.toContain('Workers Admin');
  });

  it('scopes Editor to the Workers product and asks for Routes Write on zones when it declares custom domains', () => {
    const list = writePermissions({
      resources: [
        { kind: 'worker', name: 'acme-api' },
        { kind: 'custom-domain', name: 'api.acme.example' },
      ],
    });
    expect(list.find((p) => p.name === 'Workers Editor')).toMatchObject({ scope: 'workers-product' });
    expect(list.find((p) => p.name === 'Workers Routes Write')).toMatchObject({ scope: 'zones' });
  });

  it('prefills only the permissions Cloudflare’s template URL takes, never a Workers role', () => {
    const t = tokenTemplate(
      writePermissions({ resources: [{ kind: 'kv', name: 'acme-kv' }] }),
      'widgets staging write',
    );
    expect(t.url.startsWith(`${TEMPLATE_BASE}&permissionGroupKeys=`)).toBe(true);
    const keys = JSON.parse(
      new URL(t.url.replace('/?to=/:account/api-tokens&', '/?')).searchParams.get('permissionGroupKeys'),
    );
    expect(keys).toContainEqual({ key: 'workers_kv_storage', type: 'edit' });
    expect(keys.some((k) => k.key === 'workers_scripts')).toBe(false);
    expect(t.byHand).toEqual(expect.arrayContaining(['Workers Metadata Read-Only', 'Workers Editor']));
    expect(t.url).toContain('name=widgets%20staging%20write');
  });

  it('is part of Cloudflare’s provider, and a provider’s declaration is checked', () => {
    expect(cloudflare.writeToken?.secret).toBe(WRITE_SECRET);
    expect(() => checkProvider(cloudflare)).not.toThrow();
    const bad = { ...fakeProvider(), writeToken: { secret: 'not a name', permissions: () => [] } };
    expect(() => checkProvider(bad)).toThrow(/writeToken secret/u);
  });
});

describe('the checklist for one GitHub environment', () => {
  const base = { github: REPO, name: 'staging', branch: 'main', secret: WRITE_SECRET };
  const custom = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const main = [{ name: 'main', type: 'branch' }];

  it('says what to make when the environment is missing', () => {
    const steps = environmentSteps({ ...base, environment: null });
    expect(steps.map((s) => [s.id, s.ok])).toEqual([
      ['environment', false],
      ['branch', false],
      ['secret', false],
    ]);
    expect(steps[0].fix).toMatch(/New environment, name it staging; .* add only main/u);
    expect(steps[2].fix).toMatch(/name it CLOUDFLARE_API_TOKEN and paste the write token there, never on the board/u);
  });

  it('is done with the default branch only and a secret of that name', () => {
    const steps = environmentSteps({ ...base, environment: custom, policies: main, secrets: [WRITE_SECRET] });
    expect(stepsDone(steps)).toBe(true);
  });

  it('flags a rule that lets other branches deploy, and a missing secret', () => {
    const steps = environmentSteps({
      ...base,
      environment: custom,
      policies: [...main, { name: 'dev', type: 'branch' }],
      secrets: ['OTHER'],
    });
    expect(steps[1]).toMatchObject({ ok: false });
    expect(steps[1].fix).toMatch(/also lets dev deploy/u);
    expect(steps[2]).toMatchObject({ ok: false });
  });

  it('can’t check what GitHub refused, and says which permission', () => {
    const steps = environmentSteps({
      ...base,
      environment: custom,
      policies: main,
      problems: { secrets: 'GitHub refused to show staging’s secrets: give the board’s GitHub App Environments: read' },
    });
    expect(steps[2]).toMatchObject({ ok: null });
    expect(stepsDone(steps)).toBe(false);
  });

  it('only ever adds the default branch to an existing rule, and only when the rule names none', () => {
    expect(branchRuleFix(custom, [], 'main')).toBe('add-branch');
    expect(branchRuleFix(custom, main, 'main')).toBe('none');
    expect(branchRuleFix(custom, [{ name: 'dev' }], 'main')).toBe('by-hand');
    expect(branchRuleFix({ deployment_branch_policy: null }, null, 'main')).toBe('by-hand');
    expect(branchRuleFix({ deployment_branch_policy: { protected_branches: true } }, null, 'main')).toBe('by-hand');
  });

  it('needs Administration write to make one', () => {
    expect(canMakeEnvironments({ administration: 'write' })).toBe(true);
    expect(canMakeEnvironments({ administration: 'read' })).toBe(false);
    expect(canMakeEnvironments(undefined)).toBe(false);
  });
});

describe('guided token setup on the board (BRK-304)', () => {
  const PROVIDER = 'faketok';
  let cookie;
  /** The pretend GitHub: its environments, what the App may do, and every write it was asked for. */
  const gh = {
    environments: {},
    administration: 'write',
    writes: [],
    secretsStatus: 200,
    policyStatus: 200,
    /** The apply workflow on the default branch (BRK-307), null when there's none, or a status GitHub answers. */
    /** @type {string | number | null} */ workflow: null,
  };

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const provider = {
      ...fakeProvider({ id: PROVIDER }),
      writeToken: {
        secret: 'FAKE_WRITE_TOKEN',
        permissions: (desired, { running }) => [
          { name: 'Fake Services Read', for: 'what runs', scope: 'account' },
          { name: 'Fake Services Write', for: 'changing it', scope: 'account' },
          ...(desired?.resources ?? [])
            .filter((r) => r.kind === 'service' && !running.includes(r.name))
            .map((r) => ({ name: 'Fake Admin', for: `making ${r.name}`, scope: 'account', once: true })),
        ],
        template: (permissions, name) => ({
          url: `https://fake.example/tokens/new?name=${encodeURIComponent(name)}`,
          prefilled: [],
          byHand: permissions.map((p) => p.name),
        }),
      },
    };
    await runInDurableObject(store(), (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
    });
    for (const [name, kind] of [
      ['tok-staging', 'staging'],
      ['tok-watch', 'staging'],
    ])
      expect(
        (
          await board('infra/environments', {
            method: 'POST',
            body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api' },
          })
        ).status,
      ).toBe(201);
    await runInDurableObject(store(), (s) => {
      s.sql.exec("UPDATE infra_environments SET observe_only = 1 WHERE name = 'tok-watch'");
    });
  });

  beforeEach(async () => {
    gh.environments = {};
    gh.administration = 'write';
    gh.writes = [];
    gh.secretsStatus = 200;
    gh.policyStatus = 200;
    gh.workflow = null;
    await runInDurableObject(store(), (s) => {
      s.tokenSetupKept = new Map();
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = init.method ?? 'GET';
      const reply = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.host !== 'api.github.com') return reply({ message: 'Not Found' }, 404);
      const path = decodeURIComponent(url.pathname);
      if (path === `/repos/${REPO}/installation`)
        return reply({ id: 77, permissions: { metadata: 'read', administration: gh.administration } });
      if (path.startsWith('/app/installations/'))
        return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (path === `/repos/${REPO}/contents/${RUNNER_WORKFLOW}`) {
        if (url.searchParams.get('ref') !== 'main') return reply({ message: 'Not Found' }, 404);
        if (typeof gh.workflow === 'number') return reply({ message: 'Resource not accessible' }, gh.workflow);
        if (gh.workflow === null) return reply({ message: 'Not Found' }, 404);
        return reply({ type: 'file', encoding: 'base64', content: btoa(gh.workflow) });
      }
      const m = /^\/repos\/acme\/widgets\/environments\/([^/]+)(\/[a-z-]+)?$/u.exec(path);
      if (!m) return reply({ message: 'Not Found' }, 404);
      const [, name, rest] = m;
      if (method !== 'GET') {
        const sent = JSON.parse(init.body ?? '{}');
        gh.writes.push([method, path, sent]);
        if (method === 'PUT' && !rest) {
          gh.environments[name] = { rule: sent.deployment_branch_policy, policies: [], secrets: [] };
          return reply({ name });
        }
        if (method === 'POST' && rest === '/deployment-branch-policies') {
          if (gh.policyStatus !== 200) return reply({ message: 'Server Error' }, gh.policyStatus);
          gh.environments[name].policies.push({ name: sent.name, type: sent.type });
          return reply({ id: 1, ...sent });
        }
        return reply({ message: 'Not Found' }, 404);
      }
      const found = gh.environments[name];
      if (!found) return reply({ message: 'Not Found' }, 404);
      if (!rest) return reply({ name, deployment_branch_policy: found.rule, protection_rules: [] });
      if (rest === '/deployment-branch-policies')
        return reply({ total_count: found.policies.length, branch_policies: found.policies });
      if (rest === '/secrets')
        return gh.secretsStatus === 200
          ? reply({ total_count: found.secrets.length, secrets: found.secrets.map((n) => ({ name: n })) })
          : reply({ message: 'Resource not accessible by integration' }, gh.secretsStatus);
      return reply({ message: 'Not Found' }, 404);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function board(path, { method = 'GET', body: b } = {}) {
    return SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  }
  const checklist = async () => body(await api('infra/tokens?repo=widgets&fresh=1'));

  it('lists the read token and each environment that applies, never an observe-only one', async () => {
    const res = await checklist();
    expect(res.status).toBe(200);
    expect(res.done).toBe(false);
    expect(res.canMake).toBe(true);
    expect(res.read).toEqual([
      expect.objectContaining({ provider: PROVIDER, ok: false, connected: false, url: 'https://fake.example/tokens' }),
    ]);
    expect(res.environments.map((e) => e.name)).toEqual(['tok-staging']);
    const [staging] = res.environments;
    expect(staging).toMatchObject({ secret: 'FAKE_WRITE_TOKEN', ok: false, canMake: true, desired: false });
    expect(staging.steps.map((s) => s.ok)).toEqual([false, false, false]);
    expect(staging.permissions.map((p) => p.name)).toEqual(['Fake Services Read', 'Fake Services Write']);
    expect(staging.template.url).toContain('name=widgets%20tok-staging%20write');
  });

  it('makes the GitHub environment with only the default branch, on the owner’s press, and audits it', async () => {
    const res = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(res.status).toBe(201);
    expect(res.made).toBe('made');
    expect(gh.writes).toEqual([
      [
        'PUT',
        `/repos/${REPO}/environments/tok-staging`,
        { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
      ],
      ['POST', `/repos/${REPO}/environments/tok-staging/deployment-branch-policies`, { name: 'main', type: 'branch' }],
    ]);
    const staging = res.environments.find((e) => e.name === 'tok-staging');
    expect(staging.steps.map((s) => s.ok)).toEqual([true, true, false]);
    const audit = (await body(await api('infra/audit?environment=tok-staging'))).entries;
    const made = audit.filter((e) => e.outcome.startsWith('github-'));
    expect(made.map((e) => e.outcome).sort()).toEqual(['github-branch', 'github-environment']);
    expect(made.every((e) => e.kind === 'environment' && e.by === 'owner' && e.environmentId)).toBe(true);
  });

  it('audits a half-made environment and finishes it on the next press', async () => {
    const madeCount = async () =>
      (await body(await api('infra/audit?environment=tok-staging'))).entries.filter(
        (e) => e.outcome === 'github-environment',
      ).length;
    const before = await madeCount();
    gh.policyStatus = 500;
    const failed = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(failed.status).toBe(502);
    expect(failed.error).toMatch(
      /^tok-staging was made, but GitHub answered 500 .*Press Make it on GitHub again to add main/u,
    );
    expect(gh.environments['tok-staging'].policies).toEqual([]);
    expect(await madeCount()).toBe(before + 1);
    gh.policyStatus = 200;
    const again = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(again.made).toBe('branch');
    expect(again.environments[0].steps.map((s) => s.ok)).toEqual([true, true, false]);
  });

  it('is done once the secret is there, by name only', async () => {
    gh.environments['tok-staging'] = {
      rule: { protected_branches: false, custom_branch_policies: true },
      policies: [{ name: 'main', type: 'branch' }],
      secrets: ['FAKE_WRITE_TOKEN'],
    };
    const staging = (await checklist()).environments[0];
    expect(staging.ok).toBe(true);
    expect(staging.canMake).toBe(false);
  });

  it('checks the apply workflow on the default branch offers every environment that needs a write token (BRK-307)', async () => {
    const render = (environments) =>
      renderRunner({ environments, branch: 'main', version: '2.0.0' }, RUNNER_TEMPLATE.text).text;
    const step = async () => (await checklist()).workflow;
    expect(await step()).toEqual({
      id: 'workflow',
      label: 'The apply workflow on main',
      ok: false,
      fix: RUNNER_NEEDS_WORKFLOWS.replace(/\.$/u, ''),
    });
    gh.workflow = render(['tok-other']);
    expect(await step()).toMatchObject({ ok: false, fix: expect.stringMatching(/doesn’t offer tok-staging\./u) });
    gh.workflow = render(['tok-staging']);
    expect(await step()).toMatchObject({ ok: true, fix: null });
    gh.workflow = 403;
    expect(await step()).toMatchObject({ ok: null, fix: expect.stringMatching(/Contents: read/u) });
    // Every other step done, the checklist waits on the workflow too.
    gh.environments['tok-staging'] = {
      rule: { protected_branches: false, custom_branch_policies: true },
      policies: [{ name: 'main', type: 'branch' }],
      secrets: ['FAKE_WRITE_TOKEN'],
    };
    gh.workflow = null;
    const view = await checklist();
    expect(view.environments[0].ok).toBe(true);
    expect(view.done).toBe(false);
  });

  it('says which permission it needs when GitHub won’t list the secrets', async () => {
    gh.environments['tok-staging'] = {
      rule: { protected_branches: false, custom_branch_policies: true },
      policies: [{ name: 'main', type: 'branch' }],
      secrets: [],
    };
    gh.secretsStatus = 403;
    const secret = (await checklist()).environments[0].steps[2];
    expect(secret.ok).toBeNull();
    expect(secret.fix).toMatch(/Environments: read/u);
  });

  it('refuses without Administration write, naming it and giving the steps, and writes nothing', async () => {
    gh.administration = 'read';
    expect((await checklist()).environments[0].canMake).toBe(false);
    const res = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/Administration: write/u);
    expect(res.error).toMatch(/New environment, name it tok-staging/u);
    expect(gh.writes).toEqual([]);
  });

  it('never changes an existing environment’s rule it didn’t make, beyond adding the default branch to none', async () => {
    gh.environments['tok-staging'] = {
      rule: { protected_branches: true, custom_branch_policies: false },
      policies: [],
      secrets: [],
    };
    const res = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(res.status).toBe(409);
    expect(gh.writes).toEqual([]);
    gh.environments['tok-staging'].rule = { protected_branches: false, custom_branch_policies: true };
    const added = await body(
      await board('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: { by: 'owner' } }),
    );
    expect(added.made).toBe('branch');
    expect(gh.writes).toEqual([
      ['POST', `/repos/${REPO}/environments/tok-staging/deployment-branch-policies`, { name: 'main', type: 'branch' }],
    ]);
  });

  it('is the owner’s: refuses the bearer token, an agent’s by, an observe-only environment, and a made-up one', async () => {
    expect((await api('infra/tokens/environments/tok-staging?repo=widgets', { method: 'POST', body: {} })).status).toBe(
      403,
    );
    expect(
      (
        await board('infra/tokens/environments/tok-staging?repo=widgets', {
          method: 'POST',
          body: { by: 'claude-x' },
        })
      ).status,
    ).toBe(403);
    expect((await board('infra/tokens/environments/tok-watch?repo=widgets', { method: 'POST', body: {} })).status).toBe(
      404,
    );
    expect((await board('infra/tokens/environments/nope?repo=widgets', { method: 'POST', body: {} })).status).toBe(404);
    expect(gh.writes).toEqual([]);
  });
});
