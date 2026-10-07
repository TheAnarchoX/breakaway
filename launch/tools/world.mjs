// The launch board's made-up world, as a client: the board's own API with its token, the owner signed in with the
// cookie, the made-up GitHub and platform moved along with /__launch, the apply runner's path, and the CLI. Used by
// architect.mjs (the README's world and the film's) and footage.mjs. Nothing here is real. It needs BREAKAWAY_URL and
// BREAKAWAY_TOKEN, the launch board's (board.mjs prints them).
import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planDigest, RUNNER_HEADER, runReport, runnerEnvironment } from '../../src/infra-runner.js';

export const URL_ = process.env.BREAKAWAY_URL;
export const TOKEN = process.env.BREAKAWAY_TOKEN;
if (!URL_ || !TOKEN) throw new Error('Set BREAKAWAY_URL and BREAKAWAY_TOKEN to the launch board’s.');
export const REPO = 'acme/widgets';
const WORKFLOW = `${REPO}/.github/workflows/breakaway-infra.yml@refs/heads/main`;
export const file = (environment) => `.github/breakaway-infra/${environment}.json`;

let session = '';
/** fetch, once more when the board closed the kept-alive socket before the request reached it (it never saw it). */
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
    return fetch(url, init);
  }
}
export async function call(path, { method = 'GET', body, cookie = false, headers = {} } = {}) {
  const res = await send(`${URL_}${path}`, {
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
export const launch = (action, body = {}) => call(`/__launch/${action}`, { method: 'POST', body });
export const owner = (path, method, body = {}) => call(`/api/${path}`, { method, body, cookie: true });
export const sync = () => call('/api/github/sync', { method: 'POST', body: {} });

// The owner, signed in on the board.
const login = await fetch(`${URL_}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { Origin: URL_, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: TOKEN }),
});
session = String(login.headers.get('set-cookie')).split(';')[0];

/** The checkout's note of the task it works on (scripts/tasks.mjs): the made-up world's claims leave it as it was. */
const SESSION = fileURLToPath(new URL('../../.task-session', import.meta.url));

/** The board's CLI, as an agent (`as`) or the owner, against the launch board; its first line of output. */
export function cli(args, { as } = {}) {
  const before = existsSync(SESSION) ? readFileSync(SESSION) : null;
  try {
    const out = execFileSync('node', [fileURLToPath(new URL('../../scripts/tasks.mjs', import.meta.url)), ...args], {
      env: { ...process.env, BREAKAWAY_AGENT: as ?? '', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n')[0];
  } finally {
    if (before) writeFileSync(SESSION, before);
    else rmSync(SESSION, { force: true });
  }
}

// A throwaway key for the runner's OIDC token: the made-up GitHub serves its public half.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'launch', alg: 'RS256', use: 'sig' };
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
export async function applyAsRunner(planId, environment) {
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
export const desired = (resources, change = {}, extra = {}) =>
  `${JSON.stringify(
    {
      version: 1,
      provider: 'cloudflare',
      ...extra,
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
export const plansOf = async (environment) =>
  (await call(`/api/infra/plans?environment=${environment.id}&limit=50`)).plans;
export const environments = async () => (await call('/api/infra/environments')).environments;
