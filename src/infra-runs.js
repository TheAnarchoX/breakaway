/**
 * The executor, the pure part (docs/specs/IDEA-19-architect.md, "Executor"; BRK-183): the one path that changes
 * infrastructure. For a plan the owner approved, the board takes the environment's lock, starts the apply runner (CLI-12,
 * src/infra-runner.js) by workflow_dispatch, answers that run and only that run, records each step it reports, checks
 * health through the provider afterwards, rolls back by itself when the check fails (BRK-171), releases the lock, and
 * writes the outcome. The board holds no write credentials: a rollback is a second run of the same workflow, applying
 * the reverse of what the first applied.
 *
 * This module holds what needs no store: checking the run's GitHub OIDC token and its claims, the reverse of an apply,
 * the health verdict, and a run as the API shows it. The table and the routes are store-infra-runs.js's.
 *
 * Pure and Node-safe: no store, and no network (the store fetches GitHub's keys and passes them in).
 */
import { HEALTH_STATES } from './infra-provider.js';
import { RUNNER_WORKFLOW } from './infra-runner.js';
import { redact } from './redact.js';

/** Who signs a run's OIDC token, and where its public keys are. */
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const OIDC_KEYS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
/** How far the run's clock and the board's may differ, in seconds. */
export const CLOCK_SKEW = 60;
/** The largest token the board reads. */
const TOKEN_MAX = 8192;

/**
 * A run's phases, in order. `queued` waits for the environment's lock (or for GitHub); `dispatched` has started the
 * workflow and waits for its check; `checked` has handed the plan to that run; `applying` has its first report. A
 * rollback goes through the same three with `rollback-` in front. `done` is the end, whatever the outcome.
 */
export const RUN_PHASES = [
  'queued',
  'dispatched',
  'checked',
  'applying',
  'rollback-dispatched',
  'rollback-checked',
  'rollback-applying',
  'done',
];
/** How the run ended: the plan's state says the same, this says why. */
export const RUN_OUTCOMES = ['applied', 'unverified', 'rolled back', 'failed', 'rollback failed', 'expired'];

/** The health states that fail the check after an apply. `unknown` doesn't: the platform can't tell yet. */
export const UNHEALTHY = ['down', 'degraded'];
/** How long a run that couldn't start waits before the board tries again, in minutes. */
export const RETRY_MINUTES = 10;
/** How long the executor holds the environment's lock for a run, renewed on each of its calls, in minutes. */
export const RUN_LOCK_MINUTES = 30;

/** Why the runner's call is refused: `status` is the HTTP status the route answers. */
export class RunRefused extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const refuse = (message, status = 401) => {
  throw new RunRefused(message, status);
};

/** @param {string} text */
function fromB64u(text) {
  const b64 = text.replace(/-/gu, '+').replace(/_/gu, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The claims of a GitHub OIDC token, once its signature checks against one of GitHub's keys and it's for `audience`,
 * from GitHub, and current. Anything else is a 401.
 * @param {string} token
 * @param {{ keys: Array<Record<string, any>>, audience: string, now?: number }} input `keys` is GitHub's JWKS `keys`
 * @returns {Promise<Record<string, any>>}
 */
export async function verifyRunToken(token, { keys, audience, now = Date.now() }) {
  const text = String(token ?? '').trim();
  if (!text || text.length > TOKEN_MAX) refuse('the run sent no OIDC token');
  const parts = text.split('.');
  if (parts.length !== 3) refuse('the run’s OIDC token isn’t a JWT');
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64u(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64u(parts[1])));
  } catch {
    refuse('the run’s OIDC token can’t be read');
  }
  if (header?.alg !== 'RS256') refuse('the run’s OIDC token isn’t signed with RS256');
  const jwk = keys.find((k) => k?.kid === header.kid && k?.kty === 'RSA');
  if (!jwk) refuse('the run’s OIDC token is signed with a key GitHub doesn’t list');
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      fromB64u(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    ok = false;
  }
  if (!ok) refuse('the run’s OIDC token isn’t signed by GitHub');
  if (claims?.iss !== OIDC_ISSUER) refuse('the run’s OIDC token isn’t from GitHub’s Actions');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) refuse('the run’s OIDC token is for another audience: set BREAKAWAY_URL to this board');
  const at = now / 1000;
  if (!(Number(claims.exp) > at - CLOCK_SKEW)) refuse('the run’s OIDC token has expired');
  if (claims.nbf !== undefined && Number(claims.nbf) > at + CLOCK_SKEW) refuse('the run’s OIDC token isn’t valid yet');
  return claims;
}

/**
 * Checks a verified token's claims are the run the board started: the repository, the environment, the runner's
 * workflow on the default branch, started by workflow_dispatch, its first attempt, after the board dispatched it, and,
 * once a run has checked, that same run. A mismatch is a 403 naming the claim; a second run or attempt, a 409.
 * @param {Record<string, any>} claims
 * @param {{ repository: string, environment: string, branch: string, dispatched: number, run: string | null }} expected
 * @returns {{ run: string }}
 */
export function checkRunClaims(claims, { repository, environment, branch, dispatched, run }) {
  const repo = String(repository).toLowerCase();
  if (String(claims.repository ?? '').toLowerCase() !== repo) refuse(`the run isn’t in ${repository}`, 403);
  if (claims.environment !== environment) refuse(`the run isn’t in the GitHub environment ${environment}`, 403);
  const ref = `refs/heads/${branch}`;
  if (claims.ref !== ref) refuse(`the run isn’t on ${branch}, the default branch`, 403);
  const workflow = `${repo}/${RUNNER_WORKFLOW}@${ref}`;
  for (const name of ['workflow_ref', 'job_workflow_ref'])
    if (String(claims[name] ?? '').toLowerCase() !== workflow.toLowerCase())
      refuse(`the run isn’t ${RUNNER_WORKFLOW} on ${branch}`, 403);
  if (claims.event_name !== 'workflow_dispatch') refuse('the run wasn’t started by the board', 403);
  const id = String(claims.run_id ?? '');
  if (!/^\d{1,20}$/u.test(id)) refuse('the run’s OIDC token names no run', 403);
  if (String(claims.run_attempt ?? '1') !== '1') refuse('a re-run doesn’t apply a plan: a plan runs once', 409);
  if (Number(claims.iat) < Math.floor(dispatched / 1000) - CLOCK_SKEW)
    refuse('the run started before the board started it', 403);
  if (run && run !== id) refuse(`another run has this plan: ${run}`, 409);
  return { run: id };
}

/**
 * What's wrong with the deployment branch rule of the GitHub environment a run applies in, or null when only the
 * default branch can deploy to it (BRK-250). The runner's `github.ref` check is read from the branch that runs, so an
 * edited copy dispatched on another branch would reach the write token: only the environment's own rule stops it.
 * "Selected branches and tags" naming exactly the default branch passes; no rule, protected branches, another branch
 * or pattern, or a tag doesn't.
 * @param {string} name the GitHub environment
 * @param {string} branch the default branch
 * @param {{ deployment_branch_policy?: { protected_branches?: boolean, custom_branch_policies?: boolean } | null } | null} environment
 *   GitHub's answer for the environment, null when there's none
 * @param {Array<{ name?: string, type?: string }> | null} [policies] its selected branches and tags, read only when it has them
 * @returns {string | null}
 */
export function deployBranchProblem(name, branch, environment, policies = null) {
  const fix = `under Deployment branches and tags, choose Selected branches and tags and allow only ${branch}`;
  if (!environment) return `there’s no GitHub environment ${name}: make it with its write token, and ${fix}`;
  const rule = environment.deployment_branch_policy;
  if (!rule) return `the GitHub environment ${name} lets any branch deploy: ${fix}`;
  if (rule.protected_branches || !rule.custom_branch_policies)
    return `the GitHub environment ${name} lets every protected branch deploy: ${fix}`;
  const list = policies ?? [];
  const others = list.filter((p) => p.name !== branch || (p.type ?? 'branch') !== 'branch');
  if (others.length) {
    const named = others.map((p) => `${p.type === 'tag' ? 'tag ' : ''}${p.name}`).join(', ');
    return `the GitHub environment ${name} also lets ${named} deploy: ${fix}`;
  }
  if (!list.length) return `the GitHub environment ${name} lets no branch deploy: ${fix}`;
  return null;
}

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */
/** @typedef {import('./infra-provider.js').Change} Change */

/**
 * The changes that would undo what an apply did, newest first: a create becomes a delete, a delete a create, and an
 * update or scale goes back to its settings before. A restart needs no undoing. Only steps that applied are undone.
 * With a step that can't be undone, or no steps known, nothing is rolled back and `problem` says why.
 * @param {PlanDiff} diff the plan the run applied
 * @param {Array<{ resource: string, op: string, ok: boolean }> | null} steps what it reported, or null when it didn't say
 * @returns {{ diff: PlanDiff | null, problem: string | null }}
 */
export function rollbackDiff(diff, steps) {
  if (!steps) return { diff: null, problem: 'the run didn’t say which changes it applied' };
  const applied = diff.changes.filter((c, i) => steps[i]?.ok && steps[i].resource === c.resource);
  const stuck = applied.filter((c) => !c.reversible);
  if (stuck.length)
    return {
      diff: null,
      problem: `it can’t be undone: ${stuck.map((c) => `${c.op} ${c.name}${c.why ? ` (${c.why})` : ''}`).join('; ')}`,
    };
  /** @type {Change[]} */
  const changes = [];
  for (const c of [...applied].reverse()) {
    if (c.op === 'restart') continue;
    const op = c.op === 'create' ? 'delete' : c.op === 'delete' ? 'create' : c.op;
    changes.push({
      op,
      resource: c.resource,
      kind: c.kind,
      name: c.name,
      before: c.after,
      after: c.before,
      reversible: true,
    });
  }
  if (!changes.length) return { diff: null, problem: 'nothing it applied needs undoing' };
  return { diff: { provider: diff.provider, environment: diff.environment, changes, reversible: true }, problem: null };
}

/**
 * Whether what an apply touched is healthy: every resource it created, updated, scaled, or restarted that the provider
 * reports down or degraded fails the check. `unknown` names the touched resources the provider can't tell about yet
 * (unknown, or not reported, like a Worker with no requests): when every one is unknown, the apply is unverified.
 * @param {PlanDiff} diff
 * @param {import('./infra-provider.js').Health[]} health
 * @returns {{ ok: boolean, problems: string[], unknown: string[], touched: number }}
 */
export function healthVerdict(diff, health) {
  const byId = new Map(health.map((h) => [h.resource, h]));
  const problems = [];
  const unknown = [];
  const seen = new Set();
  for (const c of diff.changes) {
    if (c.op === 'delete' || seen.has(c.resource)) continue;
    seen.add(c.resource);
    const h = byId.get(c.resource);
    if (h && UNHEALTHY.includes(h.state))
      problems.push(`${c.name} is ${h.state}${h.text ? ` (${redact(h.text).slice(0, 120)})` : ''}`);
    else if (!h || !HEALTH_STATES.includes(h.state) || h.state === 'unknown') unknown.push(c.name);
  }
  return { ok: problems.length === 0, problems, unknown, touched: seen.size };
}

/** What a run's steps did, in a few words for the audit trail. */
export function stepsSummary(steps) {
  if (!steps?.length) return 'no changes applied';
  const ok = steps.filter((s) => s.ok).length;
  const failed = steps.find((s) => !s.ok);
  return `${ok} change${ok === 1 ? '' : 's'} applied${failed ? `; ${failed.op} ${failed.resource} failed: ${redact(String(failed.error ?? '')).slice(0, 200)}` : ''}`;
}

/**
 * A run as the API shows it: never its lock's token. `steps` and `rollbackSteps` are what each run reported, one per
 * change it tried, in order: `{ resource, op, ok, error? }`, or null until it reports them.
 * @param {Record<string, any>} row
 */
export function runView(row) {
  const at = (/** @type {number | null} */ ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  return {
    plan: `plan-${Number(row.n)}`,
    repo: row.repo,
    environment: { id: Number(row.environment), name: row.env_name },
    githubEnvironment: row.github_env ?? row.env_name,
    phase: row.phase,
    rollback:
      String(row.phase).startsWith('rollback-') || row.outcome === 'rolled back' || row.outcome === 'rollback failed',
    run: row.run_id ?? null,
    rollbackRun: row.rollback_run_id ?? null,
    steps: row.steps ? JSON.parse(row.steps) : null,
    rollbackSteps: row.rollback_steps ? JSON.parse(row.rollback_steps) : null,
    outcome: row.outcome ?? null,
    error: row.error ?? null,
    nextTry: row.phase === 'queued' ? at(row.next_try) : null,
    dispatched: at(row.dispatched),
    created: at(row.created),
    updated: at(row.updated),
  };
}
