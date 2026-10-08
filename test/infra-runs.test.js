import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { RUNNER_HEADER, planDigest, runReport } from '../src/infra-runner.js';
import {
  OIDC_ISSUER,
  OIDC_KEYS_URL,
  RunRefused,
  checkRunClaims,
  deployBranchProblem,
  healthVerdict,
  reRunRefused,
  rollbackDiff,
  runTitle,
  startAgainProblem,
  startedRun,
  verifyRunToken,
} from '../src/infra-runs.js';

// The executor (BRK-183): an approved plan applies through the runner's workflow, against a pretend GitHub and the
// fake provider. Nothing reaches the network: GitHub's API and its OIDC keys are answered here.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeexec';
const REPO = 'acme/widgets';
const WORKFLOW = `${REPO}/.github/workflows/breakaway-infra.yml@refs/heads/main`;

const b64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
const enc = (value) => b64u(new TextEncoder().encode(JSON.stringify(value)));

/** A throwaway signing key, standing in for GitHub's. */
async function signer(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwk: { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
    async sign(claims, header = {}) {
      const head = enc({ alg: 'RS256', typ: 'JWT', kid, ...header });
      const payload = enc(claims);
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${payload}`),
      );
      return `${head}.${payload}.${b64u(sig)}`;
    },
  };
}

/** The claims GitHub puts in the runner's token, for run `run` in `environment`. */
const claimsFor = (environment, run, extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: OIDC_ISSUER,
    aud: ORIGIN,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    repository: REPO,
    environment,
    ref: 'refs/heads/main',
    workflow_ref: WORKFLOW,
    job_workflow_ref: WORKFLOW,
    event_name: 'workflow_dispatch',
    run_id: String(run),
    run_attempt: '1',
    ...extra,
  };
};

describe('the runner’s token and claims', () => {
  let key;
  beforeAll(async () => {
    key = await signer('k1');
  });
  const expected = {
    repository: REPO,
    environment: 'staging',
    branch: 'main',
    dispatched: Date.now() - 1000,
    run: null,
    plan: 'plan-3',
  };

  it('takes a token GitHub signed, for this board, still current', async () => {
    const claims = await verifyRunToken(await key.sign(claimsFor('staging', 7)), { keys: [key.jwk], audience: ORIGIN });
    expect(claims.run_id).toBe('7');
    expect(checkRunClaims(claims, expected)).toEqual({ run: '7' });
  });

  it('refuses a token with another key, another audience, another issuer, or expired', async () => {
    const other = await signer('k1');
    const refused = async (token, message) => {
      const error = await verifyRunToken(token, { keys: [key.jwk], audience: ORIGIN }).catch((e) => e);
      expect(error).toBeInstanceOf(RunRefused);
      expect(error.status).toBe(401);
      expect(error.message).toMatch(message);
    };
    await refused(await other.sign(claimsFor('staging', 7)), /isn’t signed by GitHub/u);
    await refused(await key.sign(claimsFor('staging', 7), { kid: 'k9' }), /key GitHub doesn’t list/u);
    await refused(await key.sign(claimsFor('staging', 7, { aud: 'https://elsewhere.example' })), /another audience/u);
    await refused(await key.sign(claimsFor('staging', 7, { iss: 'https://evil.example' })), /isn’t from GitHub/u);
    await refused(await key.sign(claimsFor('staging', 7, { exp: 1000 })), /expired/u);
    await refused(await key.sign(claimsFor('staging', 7), { alg: 'none' }), /RS256/u);
    await refused('not-a-token', /isn’t a JWT/u);
    await refused('', /no OIDC token/u);
  });

  it('refuses a run in another repository, environment, branch, or workflow, a re-run, and a second run', () => {
    const claim = (extra, exp = expected) => {
      try {
        checkRunClaims(claimsFor('staging', 7, extra), exp);
        return null;
      } catch (error) {
        return [error.status, error.message];
      }
    };
    expect(claim({ repository: 'acme/other' })).toEqual([403, 'the run isn’t in acme/widgets']);
    expect(claim({ environment: 'production' })?.[0]).toBe(403);
    expect(claim({ ref: 'refs/heads/feature' })?.[1]).toMatch(/default branch/u);
    expect(claim({ job_workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` })?.[1]).toMatch(
      /breakaway-infra\.yml/u,
    );
    expect(claim({ event_name: 'push' })?.[0]).toBe(403);
    expect(claim({ run_attempt: '2' })).toEqual([
      409,
      'GitHub’s Re-run doesn’t apply a plan: a plan runs once per start. Press Start the run again on the board, on plan-3.',
    ]);
    expect(reRunRefused('plan-3')).toMatch(/Start the run again on the board, on plan-3\.$/u);
    expect(claim({ iat: Math.floor(Date.now() / 1000) - 3600 })?.[1]).toMatch(/before the board started it/u);
    expect(claim({}, { ...expected, run: '8' })).toEqual([409, 'another run has this plan: 8']);
    expect(claim({})).toBeNull();
  });
});

describe('a run that applied nothing, and the run GitHub lists (BRK-308)', () => {
  const done = (fields) => ({
    phase: 'done',
    outcome: 'failed',
    run_id: null,
    steps: null,
    rollback_diff: null,
    ...fields,
  });

  it('can be started again when it never had the plan, or every step it reported failed', () => {
    expect(startAgainProblem(done({}))).toBeNull();
    expect(startAgainProblem(done({ outcome: 'expired' }))).toBeNull();
    const failedSteps = JSON.stringify([{ resource: 'svc-api', op: 'scale', ok: false, error: 'refused' }]);
    expect(startAgainProblem(done({ run_id: '12', steps: failedSteps }))).toBeNull();
  });

  it('can’t once anything applied, may have, was rolled back, or the run hasn’t ended', () => {
    const okStep = JSON.stringify([{ resource: 'svc-api', op: 'scale', ok: true }]);
    expect(startAgainProblem(done({ run_id: '12', steps: okStep }))).toBe('run 12 applied changes');
    expect(startAgainProblem(done({ run_id: '12', outcome: 'expired' }))).toMatch(/didn’t say what it applied/u);
    expect(startAgainProblem(done({ rollback_diff: '{}' }))).toMatch(/rolled them back/u);
    expect(startAgainProblem(done({ outcome: 'rolled back' }))).toBe('its run ended rolled back');
    expect(startAgainProblem(done({ outcome: 'applied' }))).toBe('its run ended applied');
    expect(startAgainProblem(done({ phase: 'dispatched', outcome: null }))).toBe('its run hasn’t ended');
  });

  it('finds the board’s run by its title, after the start, newest first', () => {
    const dispatched = Date.parse('2026-10-08T12:00:00Z');
    const title = runTitle('plan-3', 'acme-staging');
    expect(title).toBe('Apply plan plan-3 to acme-staging');
    const listed = (id, at, fields = {}) => ({
      id,
      display_title: title,
      event: 'workflow_dispatch',
      created_at: at,
      status: 'completed',
      conclusion: 'failure',
      html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
      ...fields,
    });
    expect(
      startedRun(
        [
          listed(1, '2026-10-08T11:00:00Z'),
          listed(2, '2026-10-08T12:00:05Z', { status: 'in_progress', conclusion: null }),
          listed(3, '2026-10-08T12:00:30Z'),
          listed(4, '2026-10-08T12:01:00Z', { display_title: 'Apply plan plan-3 to acme-production' }),
          listed(5, '2026-10-08T12:02:00Z', { event: 'push' }),
        ],
        { title, dispatched },
      ),
    ).toEqual({
      id: '3',
      url: 'https://github.com/acme/widgets/actions/runs/3',
      completed: true,
      conclusion: 'failure',
    });
    expect(
      startedRun([listed(2, '2026-10-08T12:00:05Z', { status: 'queued', conclusion: null })], { title, dispatched }),
    ).toMatchObject({ id: '2', completed: false, conclusion: null });
    expect(startedRun([listed(1, '2026-10-08T11:00:00Z')], { title, dispatched })).toBeNull();
    expect(
      startedRun([listed(6, '2026-10-08T12:00:30Z', { html_url: 'javascript:alert(1)' })], { title, dispatched }),
    ).toMatchObject({ url: null });
    expect(startedRun(null, { title, dispatched })).toBeNull();
  });
});

describe('the GitHub environment’s deployment branches (BRK-250)', () => {
  const custom = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };

  it('passes only an environment that lets the default branch, and nothing else, deploy', () => {
    expect(deployBranchProblem('staging', 'main', custom, [{ name: 'main', type: 'branch' }])).toBeNull();
    expect(deployBranchProblem('staging', 'trunk', custom, [{ name: 'trunk' }])).toBeNull();
  });

  it('says what to set for no environment, no rule, protected branches, another branch or a tag, or none', () => {
    const fix = /under Deployment branches and tags, choose Selected branches and tags and allow only main$/u;
    const problems = [
      deployBranchProblem('staging', 'main', null),
      deployBranchProblem('staging', 'main', { deployment_branch_policy: null }),
      deployBranchProblem('staging', 'main', {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      }),
      deployBranchProblem('staging', 'main', custom, [{ name: 'main' }, { name: 'release/*', type: 'branch' }]),
      deployBranchProblem('staging', 'main', custom, [{ name: 'main' }, { name: 'main', type: 'tag' }]),
      deployBranchProblem('staging', 'main', custom, []),
    ];
    for (const problem of problems) expect(problem).toMatch(fix);
    expect(problems.map((p) => p.split(':')[0])).toEqual([
      'there’s no GitHub environment staging',
      'the GitHub environment staging lets any branch deploy',
      'the GitHub environment staging lets every protected branch deploy',
      'the GitHub environment staging also lets release/* deploy',
      'the GitHub environment staging also lets tag main deploy',
      'the GitHub environment staging lets no branch deploy',
    ]);
  });
});

describe('rolling back and the health check', () => {
  const diff = {
    provider: 'fake',
    environment: 'staging',
    reversible: false,
    changes: [
      {
        op: 'create',
        resource: 'svc-new',
        kind: 'service',
        name: 'new',
        before: null,
        after: { instances: 1 },
        reversible: true,
      },
      {
        op: 'scale',
        resource: 'svc-api',
        kind: 'service',
        name: 'api',
        before: { instances: 2 },
        after: { instances: 4 },
        reversible: true,
      },
      { op: 'restart', resource: 'svc-api', kind: 'service', name: 'api', before: {}, after: {}, reversible: true },
      {
        op: 'delete',
        resource: 'db-old',
        kind: 'database',
        name: 'old',
        before: { size: 'small' },
        after: null,
        reversible: false,
        why: 'deleting database old deletes its data',
      },
    ],
  };
  const ok = (n) => diff.changes.slice(0, n).map((c) => ({ resource: c.resource, op: c.op, ok: true }));

  it('undoes what applied, newest first, and leaves a restart', () => {
    const back = rollbackDiff(diff, ok(3));
    expect(back.problem).toBeNull();
    expect(back.diff.changes.map((c) => [c.op, c.resource, c.before, c.after])).toEqual([
      ['scale', 'svc-api', { instances: 4 }, { instances: 2 }],
      ['delete', 'svc-new', { instances: 1 }, null],
    ]);
    expect(back.diff).toMatchObject({ provider: 'fake', environment: 'staging', reversible: true });
  });

  it('rolls back nothing when a change that applied can’t be undone, or nobody knows what applied', () => {
    expect(rollbackDiff(diff, ok(4))).toEqual({
      diff: null,
      problem: 'it can’t be undone: delete old (deleting database old deletes its data)',
    });
    expect(rollbackDiff(diff, null).problem).toMatch(/didn’t say/u);
    expect(rollbackDiff(diff, [{ resource: 'svc-new', op: 'create', ok: false }]).problem).toMatch(/nothing/u);
  });

  it('fails the check on what the plan touched that is down or degraded, not on unknown or untouched', () => {
    const at = '2026-10-06T12:00:00Z';
    expect(
      healthVerdict(diff, [
        { resource: 'svc-api', state: 'down', at, text: 'no answer' },
        { resource: 'svc-new', state: 'unknown', at },
        { resource: 'route-api', state: 'down', at },
        { resource: 'db-old', state: 'down', at },
      ]),
    ).toEqual({ ok: false, problems: ['api is down (no answer)'], unknown: ['new'], touched: 2 });
    expect(healthVerdict(diff, [{ resource: 'svc-api', state: 'healthy', at }])).toEqual({
      ok: true,
      problems: [],
      unknown: ['new'],
      touched: 2,
    });
  });
});

describe('the executor (BRK-183)', () => {
  let cookie;
  let staging;
  let provider;
  let key;
  /** What the pretend GitHub was asked to do, and whether it has the runner's workflow. */
  const gh = { dispatches: [], workflow: true, dispatchStatus: 204, environments: {}, reads: [], runs: [], listed: 0 };
  /** A GitHub environment only the default branch may deploy to, as GitHub answers for it. */
  const mainOnly = () => ({
    rule: { protected_branches: false, custom_branch_policies: true },
    policies: [{ id: 1, name: 'main', type: 'branch' }],
  });

  beforeAll(async () => {
    key = await signer('gh-1');
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    staging = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name: 'exec-staging', kind: 'staging', target: 'svc-api' },
        }),
      )
    ).environment;
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
    });
  });

  beforeEach(() => {
    gh.dispatches = [];
    gh.workflow = true;
    gh.dispatchStatus = 204;
    gh.environments = { 'exec-staging': mainOnly(), 'short-lived': mainOnly() };
    gh.reads = [];
    gh.runs = [];
    gh.listed = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const reply = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.href === OIDC_KEYS_URL) return reply({ keys: [key.jwk] });
      if (url.host !== 'api.github.com') return reply({ message: 'Not Found' }, 404);
      const path = decodeURIComponent(url.pathname);
      if (path === `/repos/${REPO}/installation`) return reply({ id: 77 });
      if (path.startsWith('/app/installations/'))
        return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      const envPath = /^\/repos\/acme\/widgets\/environments\/([^/]+)(\/deployment-branch-policies)?$/u.exec(path);
      if (envPath && (init.method ?? 'GET') === 'GET') {
        gh.reads.push(path);
        const found = gh.environments[envPath[1]];
        if (!found) return reply({ message: 'Not Found' }, 404);
        if (found.status) return reply({ message: 'Resource not accessible by integration' }, found.status);
        return envPath[2]
          ? reply({ total_count: found.policies.length, branch_policies: found.policies })
          : reply({ name: envPath[1], deployment_branch_policy: found.rule, protection_rules: [] });
      }
      if (path === `/repos/${REPO}/actions/workflows/breakaway-infra.yml` && (init.method ?? 'GET') === 'GET')
        return gh.workflow
          ? reply({ id: 9, path: '.github/workflows/breakaway-infra.yml' })
          : reply({ message: 'Not Found' }, 404);
      if (path === `/repos/${REPO}/actions/workflows/breakaway-infra.yml/runs` && (init.method ?? 'GET') === 'GET') {
        gh.listed++;
        return reply({ total_count: gh.runs.length, workflow_runs: gh.runs });
      }
      if (path === `/repos/${REPO}/actions/workflows/breakaway-infra.yml/dispatches` && init.method === 'POST') {
        gh.dispatches.push(JSON.parse(init.body));
        return gh.dispatchStatus === 204
          ? new Response(null, { status: 204 })
          : reply({ message: 'Workflow does not have workflow_dispatch trigger' }, gh.dispatchStatus);
      }
      return reply({ message: 'Not Found' }, 404);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    provider.failOn.clear();
    for (const id of Object.keys(provider.state.health)) provider.state.health[id] = 'healthy';
    await runInDurableObject(store(), (s) => {
      s.sql.exec('UPDATE infra_environments SET frozen = 0, observe_only = 0 WHERE id = ?', staging.id);
    });
  });

  function board(path, { method = 'GET', body: b } = {}) {
    return SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  }
  let shas = 0;
  /** A plan for `instances` of the service, approved by the owner: the executor's queue has it. */
  async function approved(instances, path = null) {
    const sha = `exec-sha-${++shas}`;
    const wanted = {
      version: 1,
      provider: PROVIDER,
      resources: provider.state.resources.map((r) => {
        if (r.id === 'svc-api') return { ...structuredClone(r), attrs: { ...r.attrs, instances } };
        if (r.id === 'route-api' && path) return { ...structuredClone(r), attrs: { ...r.attrs, path } };
        return structuredClone(r);
      }),
    };
    await runInDurableObject(store(), (s) => {
      s.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'exec-staging.json', 'exec-staging', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify(wanted),
        sha,
        Date.now(),
      );
    });
    const made = await body(
      await api('infra/plans', {
        method: 'POST',
        body: { environment: staging.id, source: 'pull-request', ref: '#9' },
      }),
    );
    expect(made.status).toBe(201);
    await board(`infra/plans/${made.plan.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    const res = await body(await board(`infra/plans/${made.plan.id}/approve`, { method: 'POST', body: {} }));
    expect(res.plan.state).toBe('approved');
    return res.plan;
  }
  const tick = () => runInDurableObject(store(), (s) => s.infraRunsTick());
  /** The board's own alarm runs the same tick in a moment: stopped, so a test's tick is the only one (BRK-308). */
  const noAlarm = () => runInDurableObject(store(), (s) => s.ctx.storage.deleteAlarm());
  /** The owner's Start the run again, then the tick that starts it. */
  const startAgain = async (id, b = {}) => {
    const res = await body(await board(`infra/plans/${id}/start-again`, { method: 'POST', body: b }));
    await noAlarm();
    return res;
  };
  const plan = async (id) => (await body(await api(`infra/plans/${id}`))).plan;
  const run = async (id) => (await body(await api(`infra/runs/${id}`))).run;
  const audit = async (id) =>
    (await body(await api(`infra/audit?environmentId=${staging.id}`))).entries
      .filter((e) => e.plan === id)
      .reverse()
      .map((e) => [e.kind, e.by, e.outcome]);
  const lock = async () => (await body(await api('infra/locks/exec-staging'))).lock;

  let runs = 5000;
  /** The runner's call for `id`, as run `runId`: its token in the runner's header. */
  async function runner(id, { method = 'GET', report, runId, claims = {} } = {}) {
    const token = await key.sign(claimsFor('exec-staging', runId, claims));
    return body(
      await SELF.fetch(`${ORIGIN}/api/infra/runs/${id}`, {
        method,
        headers: { [RUNNER_HEADER]: token, 'Content-Type': 'application/json' },
        body: report ? JSON.stringify(report) : undefined,
      }),
    );
  }
  /** What the runner does: check, apply with the fake provider, and report each step; returns the board's answers. */
  async function applyAsRunner(id) {
    const runId = String(++runs);
    const checked = await runner(id, { runId });
    expect(checked.status).toBe(200);
    const digest = await planDigest(checked.plan.diff);
    const send = (fields) =>
      runner(id, { method: 'POST', runId, report: runReport({ run: runId, digest, ...fields }) });
    expect((await send({ step: 'applying' })).status).toBe(200);
    const result = await provider.apply(
      { environment: 'exec-staging', writeToken: 'fake-write-token', token: 'fake-write-token' },
      checked.plan.diff,
    );
    const end = await send({ step: result.ok ? 'applied' : 'failed', steps: result.steps });
    return { runId, checked, end };
  }

  it('applies an approved plan: locks, starts the workflow, hands the plan to that run once, verifies, and passes', async () => {
    const p = await approved(3);
    expect(await run(p.id)).toMatchObject({ phase: 'queued', outcome: null });
    await tick();
    expect(gh.dispatches).toEqual([{ ref: 'main', inputs: { plan: p.id, environment: 'exec-staging' } }]);
    expect((await plan(p.id)).state).toBe('applying');
    expect(await lock()).toMatchObject({ holder: `executor:${p.id}`, plan: p.id });

    const { runId, checked, end } = await applyAsRunner(p.id);
    expect(checked.plan).toMatchObject({ id: p.id, environment: 'exec-staging', state: 'applying' });
    expect(checked.plan.diff).toEqual(p.diff);
    expect(end).toMatchObject({ status: 200, outcome: 'applied' });
    expect(provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(3);
    expect((await plan(p.id)).state).toBe('applied');
    expect(await run(p.id)).toMatchObject({ phase: 'done', outcome: 'applied', run: runId });
    expect(await lock()).toBeNull();
    expect(await audit(p.id)).toEqual([
      ['plan', 'owner', 'draft'],
      ['plan', 'owner', 'waiting'],
      ['approve', 'owner', 'approved'],
      ['apply', 'executor', 'started'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'applied'],
      ['lock-release', 'executor', 'applied'],
    ]);
    // A plan runs once: once it's done, the same run asking again, or a re-run of it, gets nothing.
    expect((await runner(p.id, { runId })).status).toBe(404);
    expect((await runner(p.id, { runId, claims: { run_attempt: '2' } })).status).toBe(404);
  });

  it('refuses a token that isn’t the run it started, and says nothing about the plan to it', async () => {
    const p = await approved(4);
    await tick();
    const noToken = await body(
      await SELF.fetch(`${ORIGIN}/api/infra/runs/${p.id}`, { headers: { [RUNNER_HEADER]: 'x.y.z' } }),
    );
    expect(noToken.status).toBe(401);
    expect(noToken.plan).toBeUndefined();
    expect((await runner('plan-99999', { runId: '1' })).status).toBe(404);
    expect((await runner(p.id, { runId: '2', claims: { repository: 'acme/other' } })).status).toBe(403);
    expect((await runner(p.id, { runId: '2', claims: { environment: 'exec-production' } })).status).toBe(403);
    expect((await runner(p.id, { runId: '2', claims: { ref: 'refs/heads/feature' } })).status).toBe(403);
    // Without the runner's header, the route is the signed-in board's, and a sign-in is needed.
    expect((await SELF.fetch(`${ORIGIN}/api/infra/runs/${p.id}`)).status).toBe(401);
    // The first run to check claims it; another run gets a 409, and so does a report with another plan's digest.
    expect((await runner(p.id, { runId: '600' })).status).toBe(200);
    expect((await runner(p.id, { runId: '601' })).status).toBe(409);
    const wrong = await runner(p.id, {
      method: 'POST',
      runId: '600',
      report: runReport({ run: '600', digest: 'a'.repeat(64), step: 'applying' }),
    });
    expect(wrong).toMatchObject({ status: 409, error: /other than the one approved/u });
    // Finish it, so the environment is free for the next test.
    const digest = await planDigest(p.diff);
    const send = (fields) =>
      runner(p.id, { method: 'POST', runId: '600', report: runReport({ run: '600', digest, ...fields }) });
    await send({ step: 'applying' });
    const result = await provider.apply({ environment: 'exec-staging', writeToken: 't' }, p.diff);
    expect((await send({ step: 'applied', steps: result.steps })).outcome).toBe('applied');
  });

  it('rolls back by itself when the health check fails, and marks the plan rolled back', async () => {
    const p = await approved(6);
    await tick();
    provider.state.health['svc-api'] = 'down';
    const first = await applyAsRunner(p.id);
    expect(first.end).toMatchObject({ status: 200, phase: 'rollback-dispatched' });
    expect(gh.dispatches).toHaveLength(2);
    expect(await lock()).toMatchObject({ holder: `executor:${p.id}` });
    // The second run gets the reverse of what applied, and applies it like any plan.
    provider.state.health['svc-api'] = 'healthy';
    const second = await applyAsRunner(p.id);
    expect(second.checked.plan.diff.changes).toEqual([
      expect.objectContaining({ op: 'scale', resource: 'svc-api', before: { instances: 6, version: '1.0.0' } }),
    ]);
    expect(second.end).toMatchObject({ outcome: 'rolled back' });
    expect(provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(4);
    expect((await plan(p.id)).state).toBe('rolled back');
    expect(await run(p.id)).toMatchObject({ outcome: 'rolled back', run: first.runId, rollbackRun: second.runId });
    expect(await lock()).toBeNull();
    expect((await audit(p.id)).slice(3)).toEqual([
      ['apply', 'executor', 'started'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'unhealthy'],
      ['rollback', 'executor', 'started'],
      ['rollback', 'executor', 'applying'],
      ['apply', 'executor', 'failed'],
      ['rollback', 'executor', 'rolled back'],
      ['lock-release', 'executor', 'rolled back'],
    ]);
    const signals = (await body(await api(`infra/signals?environmentId=${staging.id}&source=executor`))).signals ?? [];
    expect(signals.some((s) => /was rolled back/u.test(s.text))).toBe(true);
  });

  it('rolls back what applied when the apply fails partway, and rolls back nothing when nothing applied', async () => {
    const p = await approved(7, '/v2/*');
    expect(p.diff.changes.map((c) => c.resource)).toEqual(['svc-api', 'route-api']);
    await tick();
    provider.failOn.add('route-api');
    const first = await applyAsRunner(p.id);
    expect(first.end).toMatchObject({ phase: 'rollback-dispatched' });
    expect(await run(p.id)).toMatchObject({
      steps: [
        { resource: 'svc-api', op: 'scale', ok: true },
        { resource: 'route-api', op: 'update', ok: false, error: 'the platform refused to update api.acme.example' },
      ],
    });
    provider.failOn.clear();
    const second = await applyAsRunner(p.id);
    expect(second.checked.plan.diff.changes.map((c) => [c.op, c.resource])).toEqual([['scale', 'svc-api']]);
    expect(second.end.outcome).toBe('rolled back');
    expect(provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(4);
    expect((await plan(p.id)).state).toBe('rolled back');

    const q = await approved(5);
    await tick();
    provider.failOn.add('svc-api');
    expect((await applyAsRunner(q.id)).end).toMatchObject({ outcome: 'failed' });
    expect((await plan(q.id)).state).toBe('failed');
    expect((await audit(q.id)).slice(-2)).toEqual([
      ['apply', 'executor', 'failed'],
      ['lock-release', 'executor', 'failed'],
    ]);
    expect(gh.dispatches.map((d) => d.inputs.plan)).toEqual([p.id, p.id, q.id]);
  });

  it('rolls back when the health check can’t be read, and leaves an apply whose health isn’t known yet unverified', async () => {
    const p = await approved(13);
    await tick();
    const observe = provider.observe;
    provider.observe = async () => {
      throw new Error('the platform timed out');
    };
    try {
      expect((await applyAsRunner(p.id)).end).toMatchObject({ phase: 'rollback-dispatched' });
    } finally {
      provider.observe = observe;
    }
    expect((await applyAsRunner(p.id)).end.outcome).toBe('rolled back');
    expect(
      (await body(await api(`infra/audit?environmentId=${staging.id}`))).entries.find(
        (e) => e.plan === p.id && e.outcome === 'unhealthy',
      ).summary,
    ).toMatch(/the health check couldn’t be read: the platform timed out/u);

    const q = await approved(14);
    await tick();
    provider.state.health['svc-api'] = 'unknown';
    expect((await applyAsRunner(q.id)).end.outcome).toBe('unverified');
    expect((await plan(q.id)).state).toBe('applied');
    expect((await audit(q.id)).slice(-2)).toEqual([
      ['apply', 'executor', 'unverified'],
      ['lock-release', 'executor', 'unverified'],
    ]);
    const signals = (await body(await api(`infra/signals?environmentId=${staging.id}&source=executor`))).signals ?? [];
    expect(
      signals.some(
        (s) => s.level === 'warning' && s.text.startsWith(`${q.id} applied, but its health isn’t known yet`),
      ),
    ).toBe(true);
  });

  it('a second apply on a locked environment waits, and starts once the lock is released', async () => {
    const a = await approved(8);
    await tick();
    const runId = '7001';
    const checked = await runner(a.id, { runId });
    expect(checked.status).toBe(200);
    const b = await approved(9);
    await tick();
    expect(gh.dispatches).toHaveLength(1);
    expect((await plan(b.id)).state).toBe('approved');
    expect(await run(b.id)).toMatchObject({
      phase: 'queued',
      error: `waits for exec-staging’s lock, held by executor:${a.id}`,
    });
    // a finishes; b starts on the next tick.
    const digest = await planDigest(checked.plan.diff);
    const send = (fields) =>
      runner(a.id, { method: 'POST', runId, report: runReport({ run: runId, digest, ...fields }) });
    await send({ step: 'applying' });
    const result = await provider.apply({ environment: 'exec-staging', writeToken: 't' }, checked.plan.diff);
    expect((await send({ step: 'applied', steps: result.steps })).outcome).toBe('applied');
    await tick();
    expect(gh.dispatches.map((d) => d.inputs.plan)).toEqual([a.id, b.id]);
    expect((await plan(b.id)).state).toBe('applying');
    // b's desired state is still the newest, so it applies too.
    expect((await applyAsRunner(b.id)).end.outcome).toBe('applied');
  });

  it('refuses a plan that isn’t approved, and any plan on an observe-only environment', async () => {
    const p = await approved(10);
    const inStore = (fn) =>
      runInDurableObject(store(), async (s) => {
        try {
          return await fn(s);
        } catch (error) {
          return { status: error.status, error: error.message };
        }
      });
    // Not approved: a draft is refused.
    const draft = await inStore((s) =>
      s.makeInfraPlan(staging.id, {
        source: 'drift',
        by: 'board',
        desired: {
          version: 1,
          provider: PROVIDER,
          resources: provider.state.resources.filter((r) => r.id !== 'route-api'),
        },
      }),
    );
    expect(draft.state).toBe('draft');
    expect(await inStore((s) => s.queueInfraRun(draft.id))).toMatchObject({
      status: 409,
      error: `${draft.id} is draft: only a plan you approved is applied`,
    });
    // Observe only: refused when queued, and an approved plan already queued never starts.
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_environments SET observe_only = 1 WHERE id = ?', staging.id),
    );
    expect(await inStore((s) => s.queueInfraRun(p.id))).toMatchObject({ status: 409, error: /observe only/u });
    await tick();
    expect(gh.dispatches).toHaveLength(0);
    expect((await plan(p.id)).state).toBe('approved');
    expect((await run(p.id)).error).toMatch(/observe only/u);
    // Frozen too; then the owner rejects it, and it leaves the queue.
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_environments SET observe_only = 0, frozen = 1 WHERE id = ?', staging.id),
    );
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(p.id.slice(5))),
    );
    await tick();
    expect((await run(p.id)).error).toMatch(/frozen/u);
    const rejected = await body(
      await board(`infra/plans/${p.id}/reject`, { method: 'POST', body: { reason: 'later' } }),
    );
    expect(rejected.plan.state).toBe('rejected');
    expect((await body(await api(`infra/runs/${p.id}`))).status).toBe(404);
    await runInDurableObject(store(), (s) => s.sql.exec("DELETE FROM infra_plans WHERE state = 'draft'"));
  });

  it('waits, saying why, while the repository has no runner or GitHub won’t start it', async () => {
    const p = await approved(11);
    gh.workflow = false;
    await tick();
    expect((await run(p.id)).error).toMatch(
      /has no \.github\/workflows\/breakaway-infra\.yml on main: render it with npx breakaway infra init/u,
    );
    expect(await lock()).toBeNull();
    gh.workflow = true;
    gh.dispatchStatus = 422;
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(p.id.slice(5))),
    );
    await tick();
    expect(await run(p.id)).toMatchObject({ phase: 'queued', error: /GitHub didn’t start/u });
    expect((await run(p.id)).error).not.toMatch(/--update/u);
    expect((await plan(p.id)).state).toBe('approved');
    expect(await lock()).toBeNull();
    expect((await audit(p.id)).at(-1)).toEqual(['lock-release', 'executor', 'not started']);
    // Once GitHub starts it, it goes as any other.
    gh.dispatchStatus = 204;
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(p.id.slice(5))),
    );
    await tick();
    expect((await applyAsRunner(p.id)).end.outcome).toBe('applied');
  });

  it('starts no run while its GitHub environment lets another branch deploy, and says what to set (BRK-250)', async () => {
    const p = await approved(15);
    const retry = () =>
      runInDurableObject(store(), (s) =>
        s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(p.id.slice(5))),
      );
    const fix = 'under Deployment branches and tags, choose Selected branches and tags and allow only main';
    const refused = async (environment, error) => {
      gh.environments['exec-staging'] = environment;
      await retry();
      await tick();
      expect(gh.dispatches).toHaveLength(0);
      expect(await run(p.id)).toMatchObject({ phase: 'queued', error });
      expect((await plan(p.id)).state).toBe('approved');
      expect(await lock()).toBeNull();
    };
    await refused({ rule: null, policies: [] }, `the GitHub environment exec-staging lets any branch deploy: ${fix}`);
    await refused(
      { rule: { protected_branches: true, custom_branch_policies: false }, policies: [] },
      `the GitHub environment exec-staging lets every protected branch deploy: ${fix}`,
    );
    await refused(
      { ...mainOnly(), policies: [...mainOnly().policies, { id: 2, name: 'claude/*', type: 'branch' }] },
      `the GitHub environment exec-staging also lets claude/* deploy: ${fix}`,
    );
    await refused(undefined, `there’s no GitHub environment exec-staging: make it with its write token, and ${fix}`);
    await refused({ status: 403 }, /^GitHub answered 403 for the GitHub environment exec-staging/u);
    // Once only main may deploy, it starts like any other.
    gh.environments['exec-staging'] = mainOnly();
    gh.reads = [];
    await retry();
    await tick();
    expect(gh.reads).toEqual([
      `/repos/${REPO}/environments/exec-staging`,
      `/repos/${REPO}/environments/exec-staging/deployment-branch-policies`,
    ]);
    expect(gh.dispatches).toEqual([{ ref: 'main', inputs: { plan: p.id, environment: 'exec-staging' } }]);
    expect((await applyAsRunner(p.id)).end.outcome).toBe('applied');
  });

  it('runs a short-lived environment’s plan in the one short-lived GitHub environment, and only there (BRK-242)', async () => {
    const kind = (k) =>
      runInDurableObject(store(), (s) =>
        s.sql.exec('UPDATE infra_environments SET kind = ? WHERE id = ?', k, staging.id),
      );
    await kind('short-lived');
    try {
      const p = await approved(13);
      expect(await run(p.id)).toMatchObject({ phase: 'queued', githubEnvironment: 'short-lived' });
      // A workflow rendered before short-lived environments refuses the input: the board says to render it again.
      gh.dispatchStatus = 422;
      await tick();
      expect(gh.dispatches.at(-1)).toEqual({
        ref: 'main',
        inputs: { plan: p.id, environment: 'exec-staging', github_environment: 'short-lived' },
      });
      expect((await run(p.id)).error).toMatch(/infra init --update/u);
      gh.dispatchStatus = 204;
      await runInDurableObject(store(), (s) =>
        s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(p.id.slice(5))),
      );
      await tick();
      expect(gh.dispatches).toHaveLength(2);
      expect(gh.dispatches[1].inputs).toEqual({
        plan: p.id,
        environment: 'exec-staging',
        github_environment: 'short-lived',
      });
      // Anyone with Actions write can dispatch with any inputs: a run in the environment's own name, staging's, or
      // production's GitHub environment gets nothing; only the short-lived one does.
      for (const environment of ['exec-staging', 'staging', 'production'])
        expect((await runner(p.id, { runId: '700', claims: { environment } })).status).toBe(403);
      const at = { claims: { environment: 'short-lived' } };
      const checked = await runner(p.id, { runId: '701', ...at });
      expect(checked).toMatchObject({ status: 200, plan: { id: p.id, environment: 'exec-staging' } });
      const digest = await planDigest(checked.plan.diff);
      const send = (fields) =>
        runner(p.id, { method: 'POST', runId: '701', ...at, report: runReport({ run: '701', digest, ...fields }) });
      expect((await send({ step: 'applying' })).status).toBe(200);
      const result = await provider.apply({ environment: 'exec-staging', writeToken: 't' }, checked.plan.diff);
      expect(await send({ step: 'applied', steps: result.steps })).toMatchObject({ status: 200, outcome: 'applied' });
      expect(await run(p.id)).toMatchObject({ phase: 'done', outcome: 'applied', githubEnvironment: 'short-lived' });
    } finally {
      await kind('staging');
    }
    // Staging still applies in its own GitHub environment, and the short-lived one gets nothing there.
    const q = await approved(14);
    await tick();
    expect(gh.dispatches.at(-1).inputs).toEqual({ plan: q.id, environment: 'exec-staging' });
    expect((await runner(q.id, { runId: '702', claims: { environment: 'short-lived' } })).status).toBe(403);
    expect((await applyAsRunner(q.id)).end.outcome).toBe('applied');
  });

  it('marks a run that stops reporting failed once its lock expires, and sends a signal', async () => {
    const p = await approved(12);
    await tick();
    // It had the plan, so what it applied is unknown.
    expect((await runner(p.id, { runId: '9099' })).status).toBe(200);
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_locks SET expires = ? WHERE environment = ?', Date.now() - 1000, staging.id),
    );
    await tick();
    expect((await plan(p.id)).state).toBe('failed');
    expect(await run(p.id)).toMatchObject({ phase: 'done', outcome: 'expired', startAgain: false });
    expect((await audit(p.id)).at(-1)).toEqual(['apply', 'executor', 'expired']);
    const signals = (await body(await api(`infra/signals?environmentId=${staging.id}&source=executor`))).signals ?? [];
    expect(signals.some((s) => s.level === 'warning' && new RegExp(`${p.id} failed`, 'u').test(s.text))).toBe(true);
    // The runner that turns up late is refused.
    expect((await runner(p.id, { runId: '9100' })).status).toBe(404);
    // And Start the run again is refused: it may have applied something.
    const again = await startAgain(p.id);
    expect(again).toMatchObject({ status: 409, error: /didn’t say what it applied/u });
  });

  it('a run that never reached the board applied nothing, when its lock expires or is released (BRK-308)', async () => {
    const p = await approved(16);
    await noAlarm();
    await tick();
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_locks SET expires = ? WHERE environment = ?', Date.now() - 1000, staging.id),
    );
    await tick();
    expect((await plan(p.id)).state).toBe('failed');
    const ended = await run(p.id);
    expect(ended).toMatchObject({ phase: 'done', outcome: 'failed', startAgain: true });
    expect(ended.error).toMatch(
      /^nothing applied: the run never reached the board before exec-staging’s lock expired/u,
    );
    expect(ended.error).not.toMatch(/unknown/u);
    expect(await lock()).toBeNull();
    // Started again, released by hand: the same.
    expect((await startAgain(p.id)).status).toBe(200);
    await tick();
    expect(gh.dispatches).toHaveLength(2);
    expect((await body(await board('infra/locks/exec-staging', { method: 'DELETE' }))).status).toBe(200);
    await tick();
    expect(await run(p.id)).toMatchObject({ outcome: 'failed', error: /lock was released/u, startAgain: true });
  });

  it('finds a run that ended on GitHub before it asked for its plan, ends it, and starts it again on the owner’s press (BRK-308)', async () => {
    const p = await approved(17);
    await noAlarm();
    await tick();
    expect(gh.dispatches).toHaveLength(1);
    // Within the first few minutes, GitHub isn't asked.
    await tick();
    expect(gh.listed).toBe(0);
    const back = 4 * 60_000;
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_runs SET dispatched = dispatched - ? WHERE n = ?', back, Number(p.id.slice(5))),
    );
    const dispatched = Date.parse((await run(p.id)).dispatched);
    const ghRun = (status, conclusion) => ({
      id: 42001,
      display_title: `Apply plan ${p.id} to exec-staging`,
      event: 'workflow_dispatch',
      created_at: new Date(dispatched + 5000).toISOString(),
      status,
      conclusion,
      html_url: `https://github.com/${REPO}/actions/runs/42001`,
    });
    // Still going on GitHub: the board links it and waits.
    gh.runs = [ghRun('in_progress', null)];
    await tick();
    expect(gh.listed).toBe(1);
    expect(await run(p.id)).toMatchObject({
      phase: 'dispatched',
      github: { id: '42001', url: `https://github.com/${REPO}/actions/runs/42001`, conclusion: null },
    });
    // Looked at again only after a few more minutes.
    await tick();
    expect(gh.listed).toBe(1);
    await runInDurableObject(store(), (s) => {
      s.runLookups = new Map();
    });
    // It failed in setup: nothing applied, the lock goes, and a signal says so.
    gh.runs = [ghRun('completed', 'failure')];
    await tick();
    expect(gh.listed).toBe(2);
    expect((await plan(p.id)).state).toBe('failed');
    const ended = await run(p.id);
    expect(ended).toMatchObject({
      phase: 'done',
      outcome: 'failed',
      startAgain: true,
      github: { id: '42001', conclusion: 'failure' },
    });
    expect(ended.error).toMatch(/^nothing applied: run 42001 ended on GitHub \(failure\) before it asked for/u);
    expect(await lock()).toBeNull();
    const signals = (await body(await api(`infra/signals?environmentId=${staging.id}&source=executor`))).signals ?? [];
    expect(
      signals.some(
        (s) =>
          s.text ===
          `${p.id}: the run failed on GitHub before applying: failure, open the run: https://github.com/${REPO}/actions/runs/42001`,
      ),
    ).toBe(true);
    // GitHub's Re-run is refused, saying what to do instead.
    const reRun = await runner(p.id, { runId: '42001', claims: { run_attempt: '2' } });
    expect(reRun.status).toBe(404);

    // Only the owner, from the signed-in board, starts it again.
    const bearer = await body(await api(`infra/plans/${p.id}/start-again`, { method: 'POST', body: {} }));
    expect(bearer.status).toBe(403);
    const agent = await startAgain(p.id, { by: 'claude-x' });
    expect(agent.status).toBe(403);
    // A plan whose digest no longer matches its approval isn't started again.
    const n = Number(p.id.slice(5));
    const digest = await runInDurableObject(store(), (s) => s.planRow(n).digest);
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_plans SET digest = ? WHERE n = ?', 'b'.repeat(64), n),
    );
    const tampered = await startAgain(p.id);
    expect(tampered).toMatchObject({ status: 409, error: /isn’t the plan that was approved/u });
    await runInDurableObject(store(), (s) => s.sql.exec('UPDATE infra_plans SET digest = ? WHERE n = ?', digest, n));
    // Nor while the environment is frozen.
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_environments SET frozen = 1 WHERE id = ?', staging.id),
    );
    expect(await startAgain(p.id)).toMatchObject({
      status: 409,
      error: /frozen/u,
    });
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_environments SET frozen = 0 WHERE id = ?', staging.id),
    );

    const again = await startAgain(p.id);
    expect(again).toMatchObject({
      status: 200,
      run: { phase: 'queued', outcome: null, github: null, startAgain: false },
    });
    expect((await plan(p.id)).state).toBe('approved');
    expect((await audit(p.id)).at(-1)).toEqual(['approve', 'owner', 'started again']);
    // Pressed twice: the second is refused, the run is queued already.
    expect((await startAgain(p.id)).status).toBe(409);
    // A new start: a new lock and a new workflow_dispatch, and the new run applies it.
    await tick();
    expect(gh.dispatches).toHaveLength(2);
    expect(gh.dispatches[1]).toEqual({ ref: 'main', inputs: { plan: p.id, environment: 'exec-staging' } });
    expect(await lock()).toMatchObject({ holder: `executor:${p.id}` });
    const { runId, end } = await applyAsRunner(p.id);
    expect(end.outcome).toBe('applied');
    expect(await run(p.id)).toMatchObject({
      github: { id: runId, url: `https://github.com/${REPO}/actions/runs/${runId}` },
    });
    // Applied: never started again.
    const applied = await startAgain(p.id);
    expect(applied).toMatchObject({ status: 409, error: /its run ended applied/u });
  });

  it('starts a run again whose every step failed, never one that applied a step (BRK-308)', async () => {
    const q = await approved(18);
    await noAlarm();
    await tick();
    provider.failOn.add('svc-api');
    expect((await applyAsRunner(q.id)).end).toMatchObject({ outcome: 'failed' });
    expect(await run(q.id)).toMatchObject({ outcome: 'failed', startAgain: true });
    provider.failOn.clear();
    expect((await startAgain(q.id)).status).toBe(200);
    await tick();
    expect((await applyAsRunner(q.id)).end.outcome).toBe('applied');

    // One step applied, then the rollback: the move from failed back to approved is refused.
    const p = await approved(19, '/v3/*');
    await noAlarm();
    await tick();
    provider.failOn.add('route-api');
    expect((await applyAsRunner(p.id)).end).toMatchObject({ phase: 'rollback-dispatched' });
    provider.failOn.clear();
    expect((await applyAsRunner(p.id)).end.outcome).toBe('rolled back');
    expect(await run(p.id)).toMatchObject({ startAgain: false });
    const refused = await startAgain(p.id);
    expect(refused).toMatchObject({ status: 409, error: /can’t be started again/u });
  });

  it('lists the runs for anyone signed in, never with the lock’s token', async () => {
    const list = await body(await api(`infra/runs?environment=${staging.id}`));
    expect(list.status).toBe(200);
    expect(list.runs.length).toBeGreaterThan(3);
    expect(JSON.stringify(list.runs)).not.toMatch(/lock_token|token/u);
  });
});
