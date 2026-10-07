// Seeds Architect on the launch board (board/worker.js), after seed.sh's tasks: acme/widgets's staging and production
// on a made-up Cloudflare account, a change that was approved and applied in staging, one waiting for the owner, an
// envelope on production, and an incident there. Every step goes through the board's own API and code: the owner's
// presses with the signed-in cookie, the apply as the runner does it, and the platform and GitHub moved along with
// /__launch. Nothing here is real. seed.sh runs it; it needs BREAKAWAY_URL and BREAKAWAY_TOKEN.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { planDigest, RUNNER_HEADER, runReport, runnerEnvironment } from '../../src/infra-runner.js';

const URL_ = process.env.BREAKAWAY_URL;
const TOKEN = process.env.BREAKAWAY_TOKEN;
if (!URL_ || !TOKEN) throw new Error('Set BREAKAWAY_URL and BREAKAWAY_TOKEN to the launch board’s.');
const REPO = 'acme/widgets';
const WORKFLOW = `${REPO}/.github/workflows/breakaway-infra.yml@refs/heads/main`;
const file = (environment) => `.github/breakaway-infra/${environment}.json`;

async function call(path, { method = 'GET', body, cookie = false, headers = {} } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: session, Origin: URL_ } : { Authorization: `Bearer ${TOKEN}` }),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}
const launch = (action, body = {}) => call(`/__launch/${action}`, { method: 'POST', body });
const owner = (path, method, body = {}) => call(`/api/${path}`, { method, body, cookie: true });
const sync = () => call('/api/github/sync', { method: 'POST', body: {} });

// The owner, signed in on the board.
const login = await fetch(`${URL_}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { Origin: URL_, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: TOKEN }),
});
const session = String(login.headers.get('set-cookie')).split(';')[0];

// A throwaway key for the runner's OIDC token: the made-up GitHub serves its public half.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'launch', alg: 'RS256', use: 'sig' };
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function oidc(environment, runId) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: 'launch' });
  const claims = b64u({
    iss: 'https://token.actions.githubusercontent.com',
    aud: new URL(URL_).origin,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    repository: REPO,
    environment: runnerEnvironment(environment),
    ref: 'refs/heads/main',
    workflow_ref: WORKFLOW,
    job_workflow_ref: WORKFLOW,
    event_name: 'workflow_dispatch',
    run_id: String(runId),
    run_attempt: '1',
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKey).toString('base64url');
  return `${head}.${claims}.${sig}`;
}
let runs = 18200;
/** What the repository's apply workflow does for one approved plan: the board dispatched it, and it reports back. */
async function applyAsRunner(planId, environment) {
  await launch('tick');
  const runId = ++runs;
  const runner = (method, report) =>
    call(`/api/infra/runs/${planId}`, {
      method,
      body: report,
      headers: { [RUNNER_HEADER]: oidc(environment, runId), Authorization: '' },
    });
  const { plan } = await runner('GET');
  const digest = await planDigest(plan.diff);
  await runner('POST', runReport({ run: String(runId), digest, step: 'applying' }));
  const result = await launch('apply', { environment: environment.name, target: environment.target, diff: plan.diff });
  await runner(
    'POST',
    runReport({ run: String(runId), digest, step: result.ok ? 'applied' : 'failed', steps: result.steps }),
  );
}

/** The desired-state file for what an environment's platform runs, with `change` by resource ID. */
const desired = (resources, change = {}) =>
  `${JSON.stringify(
    {
      version: 1,
      provider: 'cloudflare',
      resources: resources.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        attrs: { ...r.attrs, ...(change[r.id] ?? {}) },
      })),
    },
    null,
    2,
  )}\n`;
const plansOf = async (environment) => (await call(`/api/infra/plans?environment=${environment.id}&limit=50`)).plans;

// The made-up account, connected read only, and what runs on it.
await launch('github', { keys: [jwk] });
const staging = await launch('platform', { environment: 'staging', fresh: { render: 2, consumers: 2 } });
const production = await launch('platform', { environment: 'production', fresh: { render: 3, consumers: 4 } });
await owner('infra/connections/cloudflare', 'PUT', { token: 'launch-read-token' });
const envs = {};
for (const [name, target] of [
  ['staging', 'widgets-api-staging'],
  ['production', 'widgets-api'],
]) {
  envs[name] = (
    await owner('infra/environments', 'POST', { repo: 'widgets', provider: 'cloudflare', name, kind: name, target })
  ).environment;
}

// The default branch describes what runs now.
await launch('github', {
  files: {
    [file('staging')]: desired(staging.resources),
    [file('production')]: desired(production.resources),
    // The repository's policy: the default's limits, and room for production's bill.
    '.github/breakaway-infra/policy.json': `${JSON.stringify({ version: 1, costLimit: 5, budget: 20, environments: { production: { budget: 60 } } }, null, 2)}\n`,
  },
  sha: 'a1c3e5f',
  message: 'Describe staging and production as code',
});
await sync();
await launch('platform', {
  environment: 'production',
  events: [
    { resource: null, kind: 'cost', level: 'info', value: 31.4, minutesAgo: 300, text: 'this month so far' },
    {
      resource: 'd1:widgets-db',
      kind: 'alert',
      level: 'warning',
      value: 81,
      minutesAgo: 140,
      text: 'widgets-db is 81% full',
    },
    {
      resource: 'queue:widgets-exports',
      kind: 'alert',
      level: 'info',
      value: 12,
      minutesAgo: 70,
      text: 'widgets-exports has 12 messages waiting',
    },
  ],
});
await launch('platform', {
  environment: 'staging',
  events: [{ resource: null, kind: 'cost', level: 'info', value: 12.1, minutesAgo: 280, text: 'this month so far' }],
});
await launch('refresh');

// Yesterday's change, applied: an agent's pull request let staging's export queue run 3 at a time.
const ids = {
  queue: 'queue:widgets-exports-staging',
  render: 'container:widgets-render-staging',
};
await launch('github', {
  pulls: [
    {
      number: 38,
      title: 'API-6: Run three exports at a time in staging',
      sha: 'b38',
      state: 'closed',
      merged: true,
      hoursAgo: 26,
    },
  ],
  files: { [file('staging')]: desired(staging.resources, { [ids.queue]: { maxConcurrency: 3 } }) },
  sha: 'merge-38',
  message: 'API-6: Run three exports at a time in staging (#38)',
});
await sync();
await launch('drift');
const first = (await plansOf(envs.staging)).find((p) => ['draft', 'waiting'].includes(p.state));
if (first.state === 'draft') await owner(`infra/plans/${first.id}`, 'PATCH', { state: 'waiting' });
await owner(`infra/plans/${first.id}/approve`, 'POST');
await applyAsRunner(first.id, envs.staging);
await launch('refresh');

// The one waiting now: room for four render containers in staging, from an agent's merged pull request.
const now = (await launch('platform', { environment: 'staging' })).resources;
await launch('github', {
  pulls: [
    {
      number: 41,
      title: 'API-7: Give staging’s render containers room for four',
      sha: 'b41',
      state: 'closed',
      merged: true,
      hoursAgo: 1,
    },
  ],
  pullFiles: { 41: [{ filename: file('staging'), status: 'modified', additions: 2, deletions: 2 }] },
  files: { [file('staging')]: desired(now, { [ids.render]: { maxInstances: 4 }, [ids.queue]: { maxConcurrency: 4 } }) },
  sha: 'merge-41',
  message: 'API-7: Give staging’s render containers room for four (#41)',
});
await sync();
await launch('drift');

// Production's envelope: the owner's bounds, set once.
await owner(`infra/envelopes/${envs.production.id}`, 'PUT', {
  envelope: {
    scale: [{ kind: 'container', resource: 'widgets-render', min: 2, max: 10 }],
    monthly: 60,
    restarts: { cap: 3, hours: 24 },
  },
});

// And an incident: production's render containers stop answering.
await launch('platform', { environment: 'production', health: { 'container:widgets-render': 'down' } });
await launch('signals', {
  signals: [
    {
      source: 'cloudflare',
      environment: 'production',
      environmentId: envs.production.id,
      resource: 'container:widgets-render',
      kind: 'health',
      level: 'critical',
      minutesAgo: 6,
      text: 'widgets-render is down: 3 of 3 instances failed their health check',
    },
  ],
});
await launch('refresh');
const incidents = (await call(`/api/infra/incidents?environment=${envs.production.id}&open=true`)).incidents;
console.log(
  `Seeded Architect: staging ${envs.staging.id}, production ${envs.production.id}; plans ${(await plansOf(envs.staging)).map((p) => `${p.id} ${p.state}`).join(', ')}; incident ${incidents.map((i) => i.task?.wid).join(', ')}.`,
);
