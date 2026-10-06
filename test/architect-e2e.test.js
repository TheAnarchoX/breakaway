import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, setPipeline } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider, fakeState } from './fake-infra-provider.js';
import { DESIRED_DIR } from '../src/infra-desired.js';
import { DRIFT_EVERY_MS } from '../src/infra-drift.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { INFRA_CHECK_NAME } from '../src/infra-pulls.js';
import {
  RUNNER_HEADER,
  SHORT_LIVED_GITHUB_ENVIRONMENT,
  planDigest,
  runReport,
  runnerEnvironment,
} from '../src/infra-runner.js';
import { OIDC_ISSUER, OIDC_KEYS_URL } from '../src/infra-runs.js';
import { SHORT_LIVED_PATH } from '../src/infra-short-lived.js';
import { INFRA_TOOL_NAMES } from '../src/mcp-infra.js';
import { PROTOCOL } from '../src/mcp.js';
import { toB64u } from '../src/push.js';

// Architect's whole loop in one place (BRK-228; docs/specs/IDEA-19-architect.md): every piece has its own unit tests,
// and this walks them together, in order, on one board. A pull request changes an environment's desired state, the
// board shows its plan as a check, the merge becomes a plan, the owner approves it from the board, the executor applies
// it through the runner under the environment's lock and verifies it, and the audit trail holds each step. Then the
// branches off it: a rollback and a failure in production, drift and break-glass, a signal becoming an incident, a
// runbook and an envelope, a short-lived environment and its cost, the deploy flow and its pause, and the reads agents
// use (the API and the MCP server) agreeing.
//
// Nothing reaches the network: GitHub (its API, its OIDC keys), the push service, and Claude's routines are answered
// here, and the platform is the fake provider. The tests in this file run in order and build on each other.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);

const REPO = 'acme/widgets';
const GH = `/repos/${REPO}`;
const WORKFLOW = `${REPO}/.github/workflows/breakaway-infra.yml@refs/heads/main`;
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const PUSH = 'https://push.example.com/send/e2e';
const STAGING = 'e2e-staging';
const PRODUCTION = 'e2e-production';
const PATHS = {
  staging: `${DESIRED_DIR}/${STAGING}.json`,
  production: `${DESIRED_DIR}/${PRODUCTION}.json`,
  policy: `${DESIRED_DIR}/policy.json`,
};

const b64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** A throwaway signing key standing in for GitHub's OIDC key: the runner's token is signed with it. */
async function signer(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const enc = (value) => b64u(new TextEncoder().encode(JSON.stringify(value)));
  return {
    jwk: { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
    async sign(claims) {
      const head = enc({ alg: 'RS256', typ: 'JWT', kid });
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

/**
 * GitHub as the board sees it: the default branch's commits and files, the pull requests with their files and the
 * files at their heads, and what the board writes (check runs, workflow dispatches, variables). Deployments and their
 * statuses are for the deploy flow.
 */
const gh = {
  /** @type {Array<{ sha: string }>} */ commits: [],
  /** @type {Record<string, string>} the default branch's files, by path */ main: {},
  /** @type {Record<string, Record<string, string>>} a pull request's files at its head, by head sha then path */ heads:
    {},
  /** @type {any[]} */ pulls: [],
  /** @type {Record<string, Array<{ filename: string, status: string }>>} */ pullFiles: {},
  /** @type {any[]} */ checkRuns: [],
  /** @type {any[]} */ dispatches: [],
  /** @type {Record<string, string>} */ variables: {},
  /** @type {any[]} */ deployments: [],
  /** @type {Record<string, any[]>} */ statuses: {},
};
/** What else reached the mocked network: pushes to the owner's browser and routine fires. */
const sent = { pushes: /** @type {string[]} */ ([]), fires: /** @type {string[]} */ ([]) };

/** A pull request as GitHub lists it. */
const pull = (number, sha, { state = 'open', merged = false } = {}) => ({
  number,
  title: `Change ${STAGING}`,
  body: '',
  draft: false,
  state,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  node_id: `PR_${number}`,
  head: { ref: `branch-${number}`, sha },
  base: { ref: 'main' },
  user: { login: 'claude[bot]' },
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  updated_at: new Date().toISOString(),
  merge_commit_sha: merged ? `merge-${number}` : null,
  merged_at: merged ? new Date().toISOString() : null,
  closed_at: state === 'closed' ? new Date().toISOString() : null,
});

/** The fake GitHub, the push service, and Claude's routines, behind one fetch. */
function network(key) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.href === OIDC_KEYS_URL) return reply({ keys: [key.jwk] });
    if (url.href.startsWith('https://push.example.com/')) {
      sent.pushes.push(url.href);
      return new Response(null, { status: 201 });
    }
    if (url.href === FIRE) {
      sent.fires.push(JSON.parse(init.body).text);
      const id = `session_e2e_${sent.fires.length}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    const path = decodeURIComponent(url.pathname);
    if (path === `${GH}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (!path.startsWith(`${GH}/`)) return reply({ message: 'Not Found' }, 404);
    const rest = path.slice(GH.length);
    const sentBody = init.body ? JSON.parse(init.body) : null;

    if (method !== 'GET') {
      if (rest === '/check-runs' && method === 'POST') {
        gh.checkRuns.push(sentBody);
        return reply({
          id: 900 + gh.checkRuns.length,
          html_url: `https://github.com/${REPO}/runs/${gh.checkRuns.length}`,
        });
      }
      if (rest === '/actions/workflows/breakaway-infra.yml/dispatches' && method === 'POST') {
        gh.dispatches.push(sentBody);
        return new Response(null, { status: 204 });
      }
      if (rest === '/actions/variables/DEPLOYS_PAUSED' && method === 'PATCH') {
        if (!('DEPLOYS_PAUSED' in gh.variables)) return reply({ message: 'Not Found' }, 404);
        gh.variables.DEPLOYS_PAUSED = sentBody.value;
        return new Response(null, { status: 204 });
      }
      if (rest === '/actions/variables' && method === 'POST') {
        gh.variables[sentBody.name] = sentBody.value;
        return reply({}, 201);
      }
      return new Response(null, { status: 204 });
    }

    if (rest === '/pulls') return reply(gh.pulls);
    let m = /^\/pulls\/(\d+)$/u.exec(rest);
    if (m) {
      const found = gh.pulls.find((p) => String(p.number) === m[1]);
      return found
        ? reply({ ...found, mergeable: true, mergeable_state: 'clean' })
        : reply({ message: 'Not Found' }, 404);
    }
    m = /^\/pulls\/(\d+)\/files$/u.exec(rest);
    if (m) return reply(gh.pullFiles[m[1]] ?? []);
    if (/^\/pulls\/\d+\/(reviews|comments)$/u.test(rest)) return reply([]);
    if (/^\/commits\/[^/]+\/check-runs$/u.test(rest)) return reply({ check_runs: [] });
    if (/^\/commits\/[^/]+\/status$/u.test(rest)) return reply({ state: 'success', statuses: [] });
    if (rest === '/commits') return reply(gh.commits);
    if (rest === '/actions/runs') return reply({ workflow_runs: [] });
    if (rest === '/actions/workflows/breakaway-infra.yml')
      return reply({ id: 9, path: '.github/workflows/breakaway-infra.yml' });
    if (rest === '/actions/variables/DEPLOYS_PAUSED')
      return 'DEPLOYS_PAUSED' in gh.variables
        ? reply({ name: 'DEPLOYS_PAUSED', value: gh.variables.DEPLOYS_PAUSED })
        : reply({ message: 'Not Found' }, 404);
    if (rest === '/deployments') return reply(gh.deployments);
    m = /^\/deployments\/(\d+)\/statuses$/u.exec(rest);
    if (m) return reply(gh.statuses[m[1]] ?? []);
    if (['/dependabot/alerts', '/releases', '/tags'].includes(rest)) return reply([]);
    if (/^\/compare\//u.test(rest)) return reply({ commits: [], files: [] });
    m = /^\/contents\/(.+)$/u.exec(rest);
    if (m) {
      const ref = url.searchParams.get('ref') ?? 'main';
      const files = ref === 'main' ? gh.main : (gh.heads[ref] ?? {});
      const name = m[1];
      if (name in files) return reply({ type: 'file', size: files[name].length, content: b64(files[name]) });
      // A folder: what's directly in it.
      const inside = Object.keys(files).filter(
        (p) => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes('/'),
      );
      if (inside.length)
        return reply(
          inside.map((p) => ({ type: 'file', name: p.slice(name.length + 1), path: p, size: files[p].length })),
        );
      return reply({ message: 'Not Found' }, 404);
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('Architect’s whole loop (BRK-228)', () => {
  let cookie;
  let key;
  let spy;
  /** The platforms: staging's and production's, each its own fake account. */
  let platform;
  /** @type {Record<string, any>} the environments, as the board made them */
  const envs = {};
  let shas = 0;
  let runs = 7000;

  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const sync = async () => {
    const res = await body(await api('github/sync', { method: 'POST' }));
    expect(res.status).toBe(200);
    return res;
  };
  /** The desired-state file for what `provider` runs now, with `change` applied by resource ID (null drops one). */
  const fileOf = (provider, change = {}) =>
    JSON.stringify(
      {
        version: 1,
        provider: provider.id,
        resources: provider.state.resources
          .filter((r) => change[r.id] !== null)
          .map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) })),
      },
      null,
      2,
    );
  /** A new commit on the default branch with `files` changed: the next sync reads it. */
  const commit = (files) => {
    Object.assign(gh.main, files);
    gh.commits = [
      { sha: `e2e-main-${++shas}`, commit: { message: 'Merge', author: { date: new Date().toISOString() } } },
      ...gh.commits,
    ];
    return gh.commits[0].sha;
  };
  const tick = () => inStore((s) => s.infraRunsTick());
  /** The cron's drift comparison, as if the next one were due. */
  const driftTick = () => inStore((s) => s.driftTick(Date.now() + DRIFT_EVERY_MS));
  const plan = async (id) => (await body(await api(`infra/plans/${id}`))).plan;
  const plans = async (environment) =>
    (await body(await api(`infra/plans?environment=${environment.id}&limit=200`))).plans;
  const run = async (id) => (await body(await api(`infra/runs/${id}`))).run;
  const lock = async (environment) => (await body(await api(`infra/locks/${environment.name}`))).lock;
  const audit = async (environment, extra = '') =>
    (await body(await api(`infra/audit?environmentId=${environment.id}&limit=200${extra}`))).entries.reverse();
  const trail = async (environment, id) =>
    (await audit(environment)).filter((e) => e.plan === id).map((e) => [e.kind, e.by, e.outcome]);
  const signals = async (environment, query = '') =>
    (await body(await api(`infra/signals?environmentId=${environment.id}${query}`))).signals ?? [];
  const incidents = async (query = '') => (await body(await api(`infra/incidents${query}`))).incidents;
  const freeze = (environment, frozen) =>
    board(`infra/environments/${environment.id}`, { method: 'PATCH', body: { frozen } }).then(body);
  /** The owner presses Approve on a plan that waits for them, from the signed-in board. */
  const approve = async (id) => body(await board(`infra/plans/${id}/approve`, { method: 'POST', body: {} }));

  /** The runner's call for plan `id`, as run `runId` in `environment`: its OIDC token in the runner's header. */
  async function runner(id, environment, { method = 'GET', report, runId, claims = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const token = await key.sign({
      iss: OIDC_ISSUER,
      aud: ORIGIN,
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      repository: REPO,
      // The GitHub environment the run applies in: a short-lived one's is shared (BRK-242).
      environment: runnerEnvironment(environment),
      ref: 'refs/heads/main',
      workflow_ref: WORKFLOW,
      job_workflow_ref: WORKFLOW,
      event_name: 'workflow_dispatch',
      run_id: String(runId),
      run_attempt: '1',
      ...claims,
    });
    return body(
      await SELF.fetch(`${ORIGIN}/api/infra/runs/${id}`, {
        method,
        headers: { [RUNNER_HEADER]: token, 'Content-Type': 'application/json' },
        body: report ? JSON.stringify(report) : undefined,
      }),
    );
  }
  /**
   * What the apply workflow does for one dispatch: asks the board for its plan, applies it with the environment's
   * write token (only the runner holds one), and reports each step. Returns the board's answers.
   */
  async function applyAsRunner(id, environment, provider, { afterCheck } = {}) {
    const runId = String(++runs);
    const checked = await runner(id, environment, { runId });
    expect(checked.status).toBe(200);
    await afterCheck?.();
    const digest = await planDigest(checked.plan.diff);
    const send = (fields) =>
      runner(id, environment, { method: 'POST', runId, report: runReport({ run: runId, digest, ...fields }) });
    expect((await send({ step: 'applying' })).status).toBe(200);
    const result = await provider.apply(
      { environment: environment.name, scope: { target: environment.target }, writeToken: 'fake-write-token' },
      checked.plan.diff,
    );
    const end = await send({ step: result.ok ? 'applied' : 'failed', steps: result.steps });
    return { runId, checked, end };
  }

  beforeAll(async () => {
    key = await signer('e2e');
    spy = network(key);
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = login.headers.get('Set-Cookie').split(';')[0];

    // The owner's phone, subscribed to the board's pushes.
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const subscription = {
      endpoint: PUSH,
      keys: { p256dh: toB64u(p256dh), auth: toB64u(crypto.getRandomValues(new Uint8Array(16))) },
    };
    expect((await board('push/subscriptions', { method: 'POST', body: subscription })).status).toBe(200);

    // Two platforms, connected read only, and the two environments that run on them.
    platform = {
      staging: fakeProvider({ id: 'fakee2e', state: { ...fakeState(), events: [] } }),
      production: fakeProvider({ id: 'fakee2eprod', state: { ...fakeState(), events: [] } }),
    };
    for (const [name, kind, provider] of [
      [STAGING, 'staging', platform.staging],
      [PRODUCTION, 'production', platform.production],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: provider.id, name, kind, target: 'svc-api' },
        }),
      );
      expect(made.status).toBe(201);
      envs[kind] = made.environment;
    }
    await inStore(async (s) => {
      s.infraProviders = new ProviderRegistry();
      for (const provider of Object.values(platform)) {
        s.infraProviders.register(provider);
        await s.refreshInventory(provider.id);
      }
    });

    // The repository's default branch describes what runs now, and has no policy yet.
    commit({ [PATHS.staging]: fileOf(platform.staging) });
    await sync();
  });
  afterAll(() => spy.mockRestore());

  it('starts with nothing to do: the desired state is what runs, so there’s no drift and no plan', async () => {
    const desired = (await body(await api('infra/desired?repo=widgets'))).desired ?? [];
    expect(JSON.stringify(desired)).toContain(STAGING);
    const compared = await driftTick();
    expect(compared.find((d) => d.environment.id === envs.staging.id)).toMatchObject({ count: 0, plan: null });
    expect(await plans(envs.staging)).toEqual([]);
    expect(sent.pushes).toEqual([]);
  });

  let planId;
  it('a pull request that changes the file gets its plan as a check, and so does infra check, keeping nothing', async () => {
    // An agent's change: three instances of the service, from the checkout, with infra check first.
    const file = fileOf(platform.staging, { 'svc-api': { attrs: { instances: 3, version: '1.0.0' } } });
    const preview = await body(
      await api('infra/check', { method: 'POST', body: { environment: STAGING, repo: 'widgets', file, policy: null } }),
    );
    expect(preview).toMatchObject({
      status: 200,
      preview: { changes: 1, policy: { policy: 'default', outcome: 'needs-owner' } },
    });
    expect(preview.preview.diff.changes).toEqual([
      expect.objectContaining({ op: 'scale', resource: 'svc-api', after: { instances: 3, version: '1.0.0' } }),
    ]);

    // Its pull request, as the sync finds it.
    gh.heads['e2e-pr-31'] = { ...gh.main, [PATHS.staging]: file };
    gh.pulls = [pull(31, 'e2e-pr-31')];
    gh.pullFiles[31] = [{ filename: PATHS.staging, status: 'modified', additions: 1, deletions: 1 }];
    await sync();
    const checks = gh.checkRuns.filter((c) => c.name === INFRA_CHECK_NAME);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      head_sha: 'e2e-pr-31',
      status: 'completed',
      conclusion: 'success',
      output: { title: `1 change to ${STAGING}` },
    });
    expect(checks[0].output.summary).toMatch(/\*\*Policy:\*\* Waits for you, by the default policy\./u);
    expect(checks[0].output.summary).toMatch(/Merging applies nothing\./u);
    // A check is a preview: no plan, no push, and the platform untouched.
    expect(await plans(envs.staging)).toEqual([]);
    expect(sent.pushes).toEqual([]);
    expect(platform.staging.calls.filter((c) => c.method === 'apply')).toEqual([]);
    // The same head isn't checked twice.
    await sync();
    expect(gh.checkRuns.filter((c) => c.name === INFRA_CHECK_NAME)).toHaveLength(1);
  });

  it('merging it makes one plan from the new desired state, which the default policy puts in front of the owner', async () => {
    gh.pulls = [pull(31, 'e2e-pr-31', { state: 'closed', merged: true })];
    const sha = commit({ [PATHS.staging]: gh.heads['e2e-pr-31'][PATHS.staging] });
    await sync();
    const desired = (await body(await api(`infra/desired/${STAGING}?repo=widgets`))).desired;
    expect(desired).toMatchObject({ state: 'valid', validSha: sha });

    // The desired state moved, so the next comparison is due at once: one drift plan, by the board.
    const compared = await inStore((s) => s.driftTick());
    expect(compared.find((d) => d.environment.id === envs.staging.id)).toMatchObject({ count: 1 });
    const [made] = await plans(envs.staging);
    expect(made).toMatchObject({
      source: { kind: 'drift' },
      by: 'board',
      changes: 1,
      policy: { policy: 'default', outcome: 'needs-owner', rule: 'every' },
    });
    planId = made.id;
    // TODO(BRK-246): a merged change's plan stays a draft, with no push, until the owner opens it.
    expect(made.state).toBe('draft');
    expect(sent.pushes).toEqual([]);
    // Nothing applies by itself.
    expect(platform.staging.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(2);
    // A second comparison makes no second plan.
    await driftTick();
    expect(await plans(envs.staging)).toHaveLength(1);

    // The owner opens it: it waits for them, with one push.
    const waiting = await body(await board(`infra/plans/${planId}`, { method: 'PATCH', body: { state: 'waiting' } }));
    expect(waiting.plan.state).toBe('waiting');
    expect(sent.pushes).toEqual([PUSH]);
  });

  it('approving is the owner’s from the board: an agent’s token and an agent’s by are refused', async () => {
    const token = await body(await api(`infra/plans/${planId}/approve`, { method: 'POST', body: {} }));
    expect(token).toMatchObject({ status: 403, error: 'only the signed-in web board can approve a plan' });
    const agent = await body(
      await board(`infra/plans/${planId}/approve`, { method: 'POST', body: { by: 'claude-e2e' } }),
    );
    expect(agent.status).toBe(403);
    expect((await plan(planId)).state).toBe('waiting');
  });

  it('a frozen environment refuses the approval, and an out-of-date plan is refused until it’s planned again', async () => {
    expect((await freeze(envs.staging, true)).environment.frozen).toBe(true);
    expect(await approve(planId)).toMatchObject({ status: 409, error: expect.stringMatching(/frozen/u) });
    await freeze(envs.staging, false);

    // The file moves on after the plan was made (another merge): the plan no longer says what the file wants.
    const file = fileOf(platform.staging, {
      'svc-api': { attrs: { instances: 3, version: '1.0.0' } },
      'route-api': { attrs: { path: '/v1/*' } },
    });
    commit({ [PATHS.staging]: file });
    await sync();
    expect(await approve(planId)).toMatchObject({ status: 409, error: expect.stringMatching(/is out of date/u) });
    const rejected = await body(
      await board(`infra/plans/${planId}/reject`, { method: 'POST', body: { reason: 'out of date' } }),
    );
    expect(rejected.plan.state).toBe('rejected');

    // The next comparison plans what the file says now, and the owner approves that one.
    await driftTick();
    const fresh = (await plans(envs.staging)).find((p) => p.state === 'draft');
    expect(fresh.changes).toBe(2);
    planId = fresh.id;
    await board(`infra/plans/${planId}`, { method: 'PATCH', body: { state: 'waiting', quiet: true } });
    const approved = await approve(planId);
    expect(approved).toMatchObject({ status: 200, plan: { state: 'approved' } });
    expect(await run(planId)).toMatchObject({ phase: 'queued' });
  });

  it('a freeze after the approval holds the run until it’s lifted', async () => {
    await freeze(envs.staging, true);
    await tick();
    expect(gh.dispatches).toEqual([]);
    expect(await run(planId)).toMatchObject({ phase: 'queued', error: expect.stringMatching(/frozen/u) });
    await freeze(envs.staging, false);
    await inStore((s) => s.sql.exec('UPDATE infra_runs SET next_try = NULL WHERE n = ?', Number(planId.slice(5))));
  });

  it('applies under the environment’s lock through the runner, once, verifies health, and audits each step', async () => {
    await tick();
    expect(gh.dispatches).toEqual([
      expect.objectContaining({ ref: 'main', inputs: expect.objectContaining({ plan: planId, environment: STAGING }) }),
    ]);
    expect((await plan(planId)).state).toBe('applying');
    expect(await lock(envs.staging)).toMatchObject({ holder: `executor:${planId}`, plan: planId });

    const { runId, checked, end } = await applyAsRunner(planId, envs.staging, platform.staging, {
      // The first run to ask has the plan: any other run is refused while it applies.
      afterCheck: async () => expect((await runner(planId, envs.staging, { runId: '1' })).status).toBe(409),
    });
    expect(checked.plan.diff.changes.map((c) => [c.op, c.resource])).toEqual([
      ['scale', 'svc-api'],
      ['update', 'route-api'],
    ]);
    expect(end).toMatchObject({ status: 200, outcome: 'applied' });
    // A plan runs once: another run, or the same one again, gets nothing.
    expect((await runner(planId, envs.staging, { runId: '1' })).status).toBe(404);
    expect((await runner(planId, envs.staging, { runId })).status).toBe(404);

    const runs = platform.staging.state.resources;
    expect(runs.find((r) => r.id === 'svc-api').attrs.instances).toBe(3);
    expect(runs.find((r) => r.id === 'route-api').attrs.path).toBe('/v1/*');
    expect((await plan(planId)).state).toBe('applied');
    expect(await run(planId)).toMatchObject({ phase: 'done', outcome: 'applied', run: runId });
    expect(await lock(envs.staging)).toBeNull();
    expect(await trail(envs.staging, planId)).toEqual([
      ['plan', 'board', 'draft'],
      ['plan', 'owner', 'waiting'],
      ['approve', 'owner', 'approved'],
      ['apply', 'executor', 'started'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'applied'],
      ['lock-release', 'executor', 'applied'],
    ]);
    // What runs is what the file says again: no drift, no new plan.
    await driftTick();
    expect((await plans(envs.staging)).filter((p) => ['draft', 'waiting'].includes(p.state))).toEqual([]);
  });

  /** Merges a change to production's file, and returns the plan the next comparison makes, waiting for the owner. */
  const productionPlan = async (change) => {
    commit({ [PATHS.production]: fileOf(platform.production, change) });
    await sync();
    await inStore((s) => s.driftTick());
    const made = (await plans(envs.production)).find((p) => p.state === 'draft');
    expect(made.policy).toMatchObject({ outcome: 'needs-owner', rule: 'production' });
    await board(`infra/plans/${made.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    return made.id;
  };

  it('in production, a failed health check rolls the apply back by itself, and says so as a signal', async () => {
    const pushed = sent.pushes.length;
    const id = await productionPlan({ 'svc-api': { attrs: { instances: 4, version: '1.0.0' } } });
    expect(sent.pushes.length).toBe(pushed + 1);
    expect((await approve(id)).plan.state).toBe('approved');
    await tick();
    platform.production.state.health['svc-api'] = 'down';
    const first = await applyAsRunner(id, envs.production, platform.production);
    expect(first.end).toMatchObject({ status: 200, phase: 'rollback-dispatched' });
    // The second run gets the reverse of what applied, under the same lock.
    platform.production.state.health['svc-api'] = 'healthy';
    expect(await lock(envs.production)).toMatchObject({ holder: `executor:${id}` });
    const second = await applyAsRunner(id, envs.production, platform.production);
    expect(second.end).toMatchObject({ outcome: 'rolled back' });
    expect(platform.production.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(2);
    expect((await plan(id)).state).toBe('rolled back');
    expect(await lock(envs.production)).toBeNull();
    expect((await trail(envs.production, id)).slice(3)).toEqual([
      ['apply', 'executor', 'started'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'unhealthy'],
      ['rollback', 'executor', 'started'],
      ['rollback', 'executor', 'applying'],
      ['apply', 'executor', 'failed'],
      ['rollback', 'executor', 'rolled back'],
      ['lock-release', 'executor', 'rolled back'],
    ]);
    const [signal] = await signals(envs.production, '&source=executor');
    expect(signal).toMatchObject({
      level: 'warning',
      text: expect.stringMatching(new RegExp(`^${id} was rolled back`, 'u')),
    });
    // A rollback put things back, so it's a warning: no incident and no push of its own.
    expect(await incidents(`?environment=${envs.production.id}`)).toEqual([]);
    expect(sent.pushes.length).toBe(pushed + 1);
  });

  it('in production, an apply that fails becomes a critical signal, an incident task, and one push', async () => {
    // What the rolled-back file still asks for differs from what runs: the next comparison plans it again.
    await driftTick();
    const again = (await plans(envs.production)).find((p) => p.state === 'draft');
    expect(again.source.kind).toBe('drift');
    const pushed = sent.pushes.length;
    await board(`infra/plans/${again.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    expect((await approve(again.id)).plan.state).toBe('approved');
    await tick();
    platform.production.failOn.add('svc-api');
    const { end } = await applyAsRunner(again.id, envs.production, platform.production);
    platform.production.failOn.clear();
    expect(end).toMatchObject({ outcome: 'failed' });
    expect((await plan(again.id)).state).toBe('failed');

    const [incident] = await incidents(`?environment=${envs.production.id}&open=true`);
    expect(incident).toMatchObject({
      repo: 'widgets',
      environment: PRODUCTION,
      environmentKind: 'production',
      level: 'critical',
      pushed: true,
    });
    const task = (await body(await api(`tasks/${incident.task.wid}`))).task;
    expect(task.tags).toEqual(['incident']);
    expect(task.autostart).toBeFalsy();
    // The plan's push, then the incident's: the executor sends none of its own.
    expect(sent.pushes.length).toBe(pushed + 2);
    expect(await lock(envs.production)).toBeNull();
  });

  it('a change by hand shows as drift and one draft plan back, and nothing changes by itself', async () => {
    const pushed = sent.pushes.length;
    platform.staging.state.resources.find((r) => r.id === 'db-main').attrs.size = 'large';
    const applies = platform.staging.calls.filter((c) => c.method === 'apply').length;
    const compared = await driftTick();
    expect(compared.find((d) => d.environment.id === envs.staging.id)).toMatchObject({ count: 1 });
    const drift = (await plans(envs.staging)).filter((p) => p.state === 'draft');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ source: { kind: 'drift' }, by: 'board' });
    expect((await plan(drift[0].id)).diff.changes).toEqual([
      expect.objectContaining({ op: 'update', resource: 'db-main', after: { size: 'small' } }),
    ]);
    expect(platform.staging.calls.filter((c) => c.method === 'apply')).toHaveLength(applies);
    expect(sent.pushes.length).toBe(pushed);
  });

  it('break-glass records the change by hand once, rejects the plan that would undo it, and asks for it in code', async () => {
    const [drift] = (await plans(envs.staging)).filter((p) => p.state === 'draft');
    const note = 'Sized the database up by hand during a load test';
    expect((await api(`infra/break-glass/${envs.staging.id}`, { method: 'POST', body: { note } })).status).toBe(403);
    const marked = await body(await board(`infra/break-glass/${envs.staging.id}`, { method: 'POST', body: { note } }));
    expect(marked).toMatchObject({ status: 201, already: false, breakGlass: { note, changes: 1 } });
    expect((await plan(drift.id)).state).toBe('rejected');
    const task = (await body(await api(`tasks/${marked.breakGlass.task}`))).task;
    expect(task.tags).toEqual(expect.arrayContaining(['agent', 'break-glass']));
    expect(task.brief).toContain(PATHS.staging);
    const [entry] = await audit(envs.staging, '&kind=break-glass');
    expect(entry).toMatchObject({
      by: 'owner',
      outcome: 'recorded',
      environment: STAGING,
      environmentId: envs.staging.id,
    });
    // The next comparisons keep showing it, and never plan it back.
    await driftTick();
    expect((await plans(envs.staging)).filter((p) => ['draft', 'waiting'].includes(p.state))).toEqual([]);
    expect(platform.staging.state.resources.find((r) => r.id === 'db-main').attrs.size).toBe('large');
  });

  let runbookRun;
  it('a critical signal opens an incident, and a runbook that’s on starts one run for it, under its cap', async () => {
    expect(
      (
        await api('routines', {
          method: 'POST',
          body: {
            slug: 'e2e-runbook',
            name: 'Scale api when it is down',
            prompt: 'Look into api.',
            gapMinutes: 0,
            dailyCap: 1,
          },
        })
      ).status,
    ).toBe(201);
    const setRunbook = (fields) => board('infra/runbooks/e2e-runbook', { method: 'PUT', body: fields }).then(body);
    expect((await body(await api('infra/runbooks/e2e-runbook', { method: 'PUT', body: { on: true } }))).status).toBe(
      403,
    );
    expect(await setRunbook({ environments: [PRODUCTION], kinds: ['health'], on: true, start: 'auto' })).toMatchObject({
      status: 200,
    });

    const pushed = sent.pushes.length;
    const signal = (over) => ({
      source: platform.production.id,
      environment: PRODUCTION,
      environmentId: envs.production.id,
      resource: 'svc-api',
      kind: 'health',
      level: 'critical',
      value: null,
      at: new Date(Date.now() - 30_000).toISOString(),
      text: 'api is down',
      ...over,
    });
    await inStore((s) => s.recordSignals([signal()]));
    const open = await incidents(`?environment=${envs.production.id}&open=true`);
    const incident = open.find((i) => i.resource === 'svc-api' && i.kind === 'health');
    expect(incident).toMatchObject({ level: 'critical', pushed: true, signals: 1 });
    expect(sent.pushes.length).toBe(pushed + 1);
    // The runbook started its agent once, with the task in the payload and the signal's words only on the task.
    expect(sent.fires).toHaveLength(1);
    const routine = (await body(await api('routines'))).routines.find((r) => r.slug === 'e2e-runbook');
    expect(routine.recentRuns).toHaveLength(1);
    runbookRun = (await body(await api(`tasks/${routine.recentRuns[0].wid}`))).task;
    expect(sent.fires[0]).toContain(`Task: ${runbookRun.wid}`);
    expect(sent.fires[0]).not.toContain('api is down');

    // Another one while the run is open is noted on it, not a second run.
    await inStore((s) => s.recordSignals([signal({ resource: 'route-api', text: 'the route is down' })]));
    expect(sent.fires).toHaveLength(1);
    expect((await body(await api(`tasks/${runbookRun.wid}`))).task.comments.at(-1).text).toContain('the route is down');
  });

  it('the runbook’s agent scales inside the envelope with no press, and outside it the plan waits with a push', async () => {
    // The board claimed the run for the agent it started.
    const agent = runbookRun.claim;
    expect(agent).toBe(`claude-${runbookRun.wid.toLowerCase()}`);
    const act = (fields) =>
      api(`infra/envelopes/${envs.production.id}/act`, {
        method: 'POST',
        body: { by: agent, task: runbookRun.wid, ...fields },
      }).then(body);
    // The envelope is the owner's, from the board.
    const envelope = { scale: [{ kind: 'service', min: 2, max: 6 }] };
    expect((await api(`infra/envelopes/${envs.production.id}`, { method: 'PUT', body: { envelope } })).status).toBe(
      403,
    );
    expect(
      (await board(`infra/envelopes/${envs.production.id}`, { method: 'PUT', body: { envelope } }).then(body)).status,
    ).toBe(200);

    const pushed = sent.pushes.length;
    const inside = await act({ resource: 'api', change: 'scale', value: 4 });
    expect(inside).toMatchObject({ status: 200, act: { inside: true, plan: { state: 'approved', agent } } });
    const id = inside.act.plan.id;
    expect(sent.pushes.length).toBe(pushed);
    await tick();
    expect((await applyAsRunner(id, envs.production, platform.production)).end.outcome).toBe('applied');
    expect(platform.production.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(4);
    expect(await trail(envs.production, id)).toEqual([
      ['plan', 'agent', 'draft'],
      ['envelope', 'agent', 'inside'],
      ['plan', 'envelope', 'waiting'],
      ['approve', 'envelope', 'approved'],
      ['apply', 'executor', 'started'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'applied'],
      ['lock-release', 'executor', 'applied'],
    ]);

    const outside = await act({ resource: 'api', change: 'scale', value: 12 });
    expect(outside).toMatchObject({ status: 200, act: { inside: false, plan: { state: 'waiting' } } });
    expect(sent.pushes.length).toBe(pushed + 1);
    expect(await run(outside.act.plan.id)).toBeUndefined();
    // Anyone but the run's agent is refused.
    expect(
      (
        await api(`infra/envelopes/${envs.production.id}/act`, {
          method: 'POST',
          body: { by: 'claude-someone-else', task: runbookRun.wid, resource: 'api', change: 'scale', value: 3 },
        })
      ).status,
    ).toBe(403);
    await board(`infra/plans/${outside.act.plan.id}/reject`, { method: 'POST', body: { reason: 'too many' } });

    // The run done, the next signal the same day finds the routine's daily cap spent: no second run.
    expect((await api(`tasks/${runbookRun.wid}/done`, { method: 'POST', body: {} })).status).toBe(200);
    await inStore((s) =>
      s.recordSignals([
        {
          source: platform.production.id,
          environment: PRODUCTION,
          environmentId: envs.production.id,
          resource: 'db-main',
          kind: 'health',
          level: 'critical',
          value: null,
          at: new Date().toISOString(),
          text: 'main is down',
        },
      ]),
    );
    expect(sent.fires).toHaveLength(1);
    const refused = (await body(await api('activity?limit=100'))).events.filter(
      (e) =>
        e.source === 'routines' && e.changes[0].kind === 'trigger_refused' && e.changes[0].routine === 'e2e-runbook',
    );
    expect(refused[0].changes[0].detail).toMatch(/daily cap/u);
  });

  let preview;
  let short;
  const shortTick = () => inStore((s) => s.shortLivedTick());
  const shortRequest = async () =>
    (await body(await api('infra/short-lived?repo=widgets'))).shortLived.find((r) => r.task?.uuid === preview.uuid);
  /** Approves a plan the board made, and has the runner apply it; returns the run's outcome. */
  const approveAndApply = async (id, environment, provider) => {
    expect((await approve(id)).plan.state).toBe('approved');
    await tick();
    const { end } = await applyAsRunner(id, environment, provider);
    expect((await plan(id)).state).toBe('applied');
    return end.outcome;
  };

  it('a task that asks for an environment gets one of its own, made once the owner approves it', async () => {
    // A third platform for the environments tasks ask for: the fake plans only what the environment's target reaches.
    platform.short = fakeProvider({
      id: 'fakee2eshort',
      state: { resources: [], relations: [], health: {}, costs: {}, restarts: {}, events: [] },
    });
    const planAll = platform.short.plan;
    platform.short.plan = async (ctx, desired) => {
      const all = platform.short.state.resources;
      platform.short.state.resources = all.filter((r) => r.id.startsWith(ctx.scope.target));
      try {
        return await planAll(ctx, desired);
      } finally {
        platform.short.state.resources = all;
      }
    };
    await inStore((s) => s.infraProviders.register(platform.short));
    commit({
      [SHORT_LIVED_PATH]: JSON.stringify({
        version: 1,
        provider: platform.short.id,
        target: 'app-{environment}',
        resources: [
          { id: 'app-{environment}', kind: 'service', name: 'app-{environment}', attrs: { instances: 1 } },
          { id: 'app-{environment}-route', kind: 'route', name: '{environment}.acme.example', attrs: { path: '/*' } },
        ],
      }),
    });
    await sync();

    const pushed = sent.pushes.length;
    preview = (
      await body(
        await api('tasks', {
          method: 'POST',
          body: [{ description: 'Preview the new checkout', project: 'ops', horizon: 'now', tags: ['environment'] }],
        }),
      )
    ).tasks[0];
    await shortTick();
    const name = preview.wid.toLowerCase();
    short = (await body(await api('infra/environments?repo=widgets'))).environments.find((e) => e.name === name);
    expect(short).toMatchObject({ kind: 'short-lived', target: `app-${name}`, task: { uuid: preview.uuid } });
    const request = await shortRequest();
    expect(request).toMatchObject({ state: 'creating', environment: short.id });
    const created = await plan(request.createPlan);
    expect(created).toMatchObject({
      state: 'waiting',
      source: { kind: 'short-lived', ref: preview.wid },
      policy: { outcome: 'needs-owner' },
    });
    expect(sent.pushes.length).toBe(pushed + 1);
    expect(platform.short.state.resources).toEqual([]);

    // What it made has no health yet (nothing has reached it), so the apply is unverified, with a warning.
    expect(await approveAndApply(created.id, short, platform.short)).toBe('unverified');
    expect(gh.dispatches.at(-1).inputs).toMatchObject({
      plan: created.id,
      environment: name,
      github_environment: SHORT_LIVED_GITHUB_ENVIRONMENT,
    });
    expect((await signals(short, '&source=executor'))[0]).toMatchObject({ level: 'warning' });
    await shortTick();
    expect(await shortRequest()).toMatchObject({ state: 'ready' });
    expect(platform.short.state.resources.map((r) => r.id)).toEqual([`app-${name}`, `app-${name}-route`]);
  });

  it('costs add up by environment and by the task that owns one, and a budget gone near and over is a signal', async () => {
    const name = preview.wid.toLowerCase();
    platform.short.state.costs[`app-${name}`] = 2.5;
    await inStore((s) => s.refreshInventory(platform.short.id));
    await inStore((s) => s.refreshInventory(platform.staging.id));
    const costs = await body(await api('infra/costs?repo=widgets'));
    const of = (id) => costs.environments.find((e) => e.environmentId === id);
    expect(of(short.id)).toMatchObject({ task: { wid: preview.wid }, cost: { amount: 2.5, currency: 'USD' } });
    expect(costs.tasks).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ wid: preview.wid }),
        cost: expect.objectContaining({ amount: 2.5 }),
      }),
    ]);
    expect(of(envs.staging.id)).toMatchObject({
      cost: { amount: 6.5, currency: 'USD' },
      budget: { amount: 20, policy: 'default', state: 'inside' },
    });

    // Staging's month goes near its budget, then over: one signal each, a warning then a critical one.
    const pushed = sent.pushes.length;
    platform.staging.state.costs['svc-api'] = 15;
    await inStore((s) => s.refreshInventory(platform.staging.id));
    platform.staging.state.costs['svc-api'] = 30;
    await inStore((s) => s.refreshInventory(platform.staging.id));
    await inStore((s) => s.refreshInventory(platform.staging.id));
    const budget = (await signals(envs.staging)).filter((s) => s.kind === 'cost');
    expect(budget.map((s) => s.level)).toEqual(['critical', 'warning']);
    expect(budget[0].text).toMatch(/over its \$20 budget/u);
    // Over budget in staging is an incident on the board, with no push: only production's push.
    const incident = (await incidents(`?environment=${envs.staging.id}&open=true`)).find((i) => i.kind === 'cost');
    expect(incident).toMatchObject({ level: 'critical', pushed: false });
    expect(sent.pushes.length).toBe(pushed);
    platform.staging.state.costs['svc-api'] = 5;
  });

  it('closing the task makes the plan that removes its environment, and once applied the environment goes', async () => {
    const name = preview.wid.toLowerCase();
    expect((await api(`tasks/${preview.wid}/done`, { method: 'POST', body: {} })).status).toBe(200);
    await shortTick();
    const request = await shortRequest();
    expect(request).toMatchObject({ state: 'removing', environment: short.id });
    const removal = await plan(request.removePlan);
    // All deletes, so the destructive guard asks, whatever the policy says.
    expect(removal).toMatchObject({ state: 'waiting', policy: { outcome: 'needs-owner', rule: 'destructive' } });
    expect(removal.diff.changes.every((c) => c.op === 'delete')).toBe(true);
    expect(await approveAndApply(removal.id, short, platform.short)).toBe('applied');
    await shortTick();
    expect(await shortRequest()).toMatchObject({ state: 'removed', environment: null });
    expect(platform.short.state.resources).toEqual([]);
    const environments = (await body(await api('infra/environments?repo=widgets'))).environments;
    expect(environments.find((e) => e.name === name)).toBeUndefined();
  });

  it('a pipeline’s deploy is recorded on its environment, and freezing its production sets the deploy pause', async () => {
    await setPipeline();
    await sync();
    const named = async () =>
      Object.fromEntries(
        (await body(await api('infra/environments?repo=widgets'))).environments.map((e) => [e.name, e]),
      );
    const { staging, production } = await named();
    expect(staging).toMatchObject({ kind: 'staging', provider: 'cloudflare', target: 'widgets-staging' });
    expect(production).toMatchObject({ kind: 'production', provider: 'cloudflare', target: 'widgets' });

    // A Deploy that finished on staging's Worker is on staging's trail, as the executor's.
    gh.deployments = [
      {
        id: 4401,
        environment: 'widgets-staging',
        sha: 'a'.repeat(40),
        task: 'deploy',
        created_at: new Date().toISOString(),
        creator: { login: 'bot' },
      },
    ];
    gh.statuses[4401] = [
      {
        state: 'success',
        description: 'version 0a1b2c3d-1111-2222-3333-444455556666 · migrations none',
        created_at: new Date().toISOString(),
        log_url: `https://github.com/${REPO}/actions/runs/44`,
      },
    ];
    await sync();
    await sync();
    const deploys = (await audit(staging)).filter((e) => e.kind === 'apply');
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toMatchObject({
      environment: 'staging',
      environmentId: staging.id,
      by: 'executor',
      outcome: 'applied',
      summary: expect.stringContaining('Deploy of aaaaaaa to widgets-staging'),
    });

    // Freeze is one switch with DEPLOYS_PAUSED: on for production, and off again; staging's leaves it alone.
    expect(await freeze(production, true)).toMatchObject({ status: 200, pause: { value: true, synced: true } });
    expect(gh.variables.DEPLOYS_PAUSED).toBe('true');
    expect(await freeze(production, false)).toMatchObject({ pause: { value: false, synced: true } });
    expect(gh.variables.DEPLOYS_PAUSED).toBe('false');
    await freeze(staging, true);
    expect(gh.variables.DEPLOYS_PAUSED).toBe('false');
    await freeze(staging, false);
    expect((await audit(production, '&kind=freeze')).map((e) => [e.by, e.outcome])).toEqual([
      ['owner', 'on'],
      ['owner', 'off'],
    ]);
  });

  it('the audit trail holds every step, each with its environment', async () => {
    const all = [];
    let before = '';
    for (;;) {
      const page = await body(await api(`infra/audit?repo=widgets&limit=200${before}`));
      all.push(...page.entries);
      if (!page.more) break;
      before = `&before=${page.entries.at(-1).id}`;
    }
    for (const entry of all) {
      expect(entry.environment, JSON.stringify(entry)).toEqual(expect.any(String));
      expect(entry.environmentId, JSON.stringify(entry)).toEqual(expect.any(Number));
    }
    const kinds = new Set(all.map((e) => e.kind));
    for (const kind of [
      'plan',
      'approve',
      'apply',
      'rollback',
      'lock-release',
      'break-glass',
      'envelope',
      'freeze',
      'environment',
    ])
      expect(kinds, kind).toContain(kind);
    // Every plan's trail starts with it being made, and every apply that started ended and let its lock go.
    const byPlan = Map.groupBy(all.filter((e) => e.plan).reverse(), (e) => e.plan);
    for (const [id, entries] of byPlan) {
      expect(entries[0], id).toMatchObject({ kind: 'plan', outcome: 'draft' });
      if (entries.some((e) => e.kind === 'apply' && e.outcome === 'started'))
        expect(entries.at(-1), id).toMatchObject({ kind: 'lock-release' });
    }
    // No agent ever approved, and only the owner, the board's policy, or an envelope did.
    expect(new Set(all.filter((e) => e.kind === 'approve').map((e) => e.by))).toEqual(new Set(['owner', 'envelope']));
  });

  it('the reads agents use, the API and the MCP server, agree, and change nothing', async () => {
    let next = 1;
    const called = new Set();
    const call = async (name, args = {}) => {
      const res = await SELF.fetch(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TEST_API_TOKEN}`,
          'X-Breakaway-Agent': 'claude-e2e-reader',
          'X-Breakaway-Repo': 'widgets',
          'MCP-Protocol-Version': PROTOCOL,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: next++,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL,
              'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      const { result } = await res.json();
      expect(result.isError, name).toBeUndefined();
      called.add(name);
      return result.structuredContent;
    };
    const trailBefore = await audit(envs.staging);

    const environments = (await body(await api('infra/environments?repo=widgets'))).environments;
    expect((await call('infra_environments')).environments.map((e) => e.id)).toEqual(environments.map((e) => e.id));

    const one = await call('infra_environment', { environment: STAGING });
    expect(one.environment).toMatchObject({ id: envs.staging.id, name: STAGING });
    expect(one.desired).toMatchObject({ sha: gh.commits[0].sha });
    const inventory = (await body(await api(`infra/inventory?environment=${envs.staging.id}&repo=widgets`))).resources;
    expect(one.resources.map((r) => r.id).sort()).toEqual(inventory.map((r) => r.id).sort());

    const listed = (await body(await api('infra/plans?repo=widgets&limit=200'))).plans;
    expect((await call('infra_plans', { limit: 200 })).plans.map((p) => [p.id, p.state])).toEqual(
      listed.map((p) => [p.id, p.state]),
    );
    const shown = await call('infra_plan', { plan: planId });
    expect(shown.plan).toMatchObject({ id: planId, state: 'applied' });
    expect(shown.plan.diff).toEqual((await plan(planId)).diff);

    const apiSignals = (await body(await api(`infra/signals?repo=widgets&environment=${STAGING}`))).signals;
    expect((await call('infra_signals', { environment: STAGING })).signals.map((s) => s.id)).toEqual(
      apiSignals.map((s) => s.id),
    );
    const open = await incidents('?repo=widgets&open=true');
    expect((await call('infra_incidents')).incidents.map((i) => i.id)).toEqual(open.map((i) => i.id));

    // Every tool was asked, and each is a read: the trail is as it was.
    expect([...called].sort()).toEqual([...INFRA_TOOL_NAMES].sort());
    expect(await audit(envs.staging)).toEqual(trailBefore);
  });
});
