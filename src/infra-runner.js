/**
 * The apply runner's contract (docs/specs/IDEA-19-architect.md, "Executor"; CLI-12): the one path that changes
 * infrastructure is a workflow in the repository, `.github/workflows/breakaway-infra.yml`, that the board starts for
 * exactly one approved plan, with the environment's write token in a GitHub environment of the same name (BRK-171).
 * `npx breakaway infra init` renders it; the executor (BRK-183) starts it and answers it.
 *
 * The runner and the board share no secret. The runner proves where it runs with a GitHub OIDC token, whose audience
 * is the board's origin, in the RUNNER_HEADER of every call to `runPath(plan)`:
 *
 * - `GET` answers `{ plan: RunPlan }` only when the token's repository, environment, workflow, and run are the ones
 *   the board started for that plan, and the plan is approved for that environment; anything else is a 4xx with
 *   `{ error }`, and the runner stops before it reads its write token.
 * - `POST` takes a RunReport for each step: `applying` before the provider's first call, then `applied` or `failed`
 *   with the provider's steps. Each carries `planDigest(diff)` of the diff the run applies, so the board refuses steps
 *   for a plan that changed since it was approved. The board records them, verifies health, and rolls back (BRK-183).
 *
 * The board also checks the token's ref is the default branch, and a plan runs once: a second run, or a re-run, for
 * the same approval gets a 409.
 *
 * Pure: no store and no network, so the Worker and the CLI share it.
 */
import { redact } from './redact.js';

/** Where the rendered runner lives in a repository, and its `name:` line. */
export const RUNNER_WORKFLOW = '.github/workflows/breakaway-infra.yml';
export const RUNNER_NAME = 'Apply infrastructure';
/** The header the runner's GitHub OIDC token travels in: never the board's own Authorization. */
export const RUNNER_HEADER = 'Breakaway-Runner-Token';
/** A plan's ID as the runner takes it (BRK-178's IDs fit it). */
export const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** An environment's name, as its desired-state file is named (BRK-180). */
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** The states a plan may be in when the board hands it to its run: approved, or applying once the board started it. */
export const RUNNABLE_STATES = ['approved', 'applying'];
/** What a run reports, in order: about to apply, then one of the two ends. */
export const RUN_STEPS = ['applying', 'applied', 'failed'];
/** A reported error, at most this long. */
export const RUN_ERROR_MAX = 500;

/** @param {string} plan */
export const runPath = (plan) => `/api/infra/runs/${encodeURIComponent(plan)}`;

/**
 * The plan the board hands its run.
 * @typedef {object} RunPlan
 * @property {string} id
 * @property {string} environment
 * @property {string} state one of RUNNABLE_STATES
 * @property {Record<string, unknown>} [scope] the environment's scope on the platform, as discovery uses it
 * @property {import('./infra-provider.js').PlanDiff} diff the provider's diff, applied as it is
 */

/**
 * What a run reports about one step.
 * @typedef {object} RunReport
 * @property {string} run the workflow run's ID
 * @property {string} step one of RUN_STEPS
 * @property {string} digest planDigest() of the diff the run applies
 * @property {import('./infra-provider.js').ApplyResult['steps']} [steps] the provider's steps, with `applied` and
 *   `failed`
 * @property {string} [error] what failed, redacted, with `failed`
 */

/** A reason the runner stops, in words for the run's log. */
export class RunnerError extends Error {}

const stop = (message) => {
  throw new RunnerError(message);
};
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The run's inputs, checked: the plan's ID and the environment the board started it with, and the board's origin.
 * @param {{ plan?: string, environment?: string, board?: string, run?: string }} input
 * @returns {{ plan: string, environment: string, origin: string, run: string }}
 */
export function checkRunInputs({ plan, environment, board, run }) {
  if (!plan) stop('There is no plan: this workflow applies one plan the owner approved, and the board starts it.');
  if (!PLAN_ID.test(plan)) stop(`${String(plan).slice(0, 80)} isn't a plan's ID.`);
  if (!environment || !ENVIRONMENT.test(environment))
    stop(`${String(environment ?? '').slice(0, 80) || 'No environment'} isn't an environment's name.`);
  if (!run || !/^\d{1,20}$/u.test(run)) stop("There is no run ID: this runs only inside GitHub's Actions.");
  let origin;
  try {
    const url = new URL(String(board ?? ''));
    if (url.protocol !== 'https:') throw new Error('not https');
    origin = url.origin;
  } catch {
    stop("BREAKAWAY_URL isn't the board's https address: set it as a repository variable.");
  }
  return { plan, environment, origin, run };
}

/**
 * The plan the board answered with, checked against what the run was started for; refuses anything that isn't one
 * approved plan for this environment, so the write token is never read for it.
 * @param {unknown} body
 * @param {{ plan: string, environment: string }} expected
 * @returns {RunPlan}
 */
export function checkRunPlan(body, { plan, environment }) {
  const found = isObject(body) ? /** @type {Record<string, any>} */ (body).plan : null;
  if (!isObject(found)) stop(`The board sent no plan ${plan}.`);
  if (found.id !== plan) stop(`The board sent plan ${String(found.id).slice(0, 80)}, not ${plan}.`);
  if (found.environment !== environment)
    stop(`Plan ${plan} is for ${String(found.environment).slice(0, 80)}, not ${environment}.`);
  if (!RUNNABLE_STATES.includes(found.state))
    stop(`Plan ${plan} is ${String(found.state).slice(0, 40)}, not approved: only an approved plan runs.`);
  const diff = found.diff;
  if (!isObject(diff) || !Array.isArray(diff.changes)) stop(`Plan ${plan} has no changes to apply.`);
  if (diff.environment !== environment) stop(`Plan ${plan}'s changes are for another environment.`);
  if (found.scope != null && !isObject(found.scope)) stop(`Plan ${plan}'s scope isn't an object.`);
  return /** @type {RunPlan} */ (found);
}

/** JSON with every object's keys sorted, so the same plan always reads the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The SHA-256 of a plan's diff, in hex: what the board approved and what the run applied must have the same one.
 * @param {import('./infra-provider.js').PlanDiff} diff
 */
export async function planDigest(diff) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(diff)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A report for the board, checked; an error is cut to RUN_ERROR_MAX and redacted, since it may quote the platform.
 * @param {{ run: string, step: string, digest: string, steps?: RunReport['steps'], error?: string }} report
 * @returns {RunReport}
 */
export function runReport({ run, step, digest, steps, error }) {
  if (!RUN_STEPS.includes(step)) throw new Error(`a run reports ${RUN_STEPS.join(', ')}, not ${step}`);
  if (!/^[0-9a-f]{64}$/u.test(String(digest))) throw new Error('a report carries the digest of the plan it applies');
  /** @type {RunReport} */
  const out = { run, step, digest };
  if (steps) out.steps = steps.map((s) => (s.error ? { ...s, error: redact(s.error).slice(0, RUN_ERROR_MAX) } : s));
  if (error) out.error = redact(error).slice(0, RUN_ERROR_MAX);
  return out;
}
