/**
 * Architect's short-lived environments, the pure part (docs/specs/IDEA-19-architect.md, "Short-lived environments";
 * BRK-200): a task asks for an environment of its own, the board makes it from the repository's template through a
 * plan, and removes it through a plan when the task closes, or once it has outlived the grace period.
 *
 * The template is `.github/breakaway-infra/short-lived.json` on the repository's default branch, a reserved name
 * (RESERVED_FILES in infra-desired.js): a desired-state file with a `provider` and a `target`, where `{environment}` in
 * a resource's id or name, or in the target, becomes the new environment's name, so each task's resources are its own:
 *
 *   { "version": 1, "provider": "cloudflare", "target": "app-{environment}",
 *     "resources": [ { "id": "app-{environment}", "kind": "worker", "name": "app-{environment}" } ] }
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network. The store's part is
 * store-infra-short-lived.js.
 */
import { checkDesiredFile, DESIRED_DIR } from './infra-desired.js';
import { checkTarget } from './infra-environments.js';
import { InputError } from './model.js';

/** @typedef {import('./infra-provider.js').DesiredState} DesiredState */
/** @typedef {import('./infra-desired.js').DesiredError} DesiredError */

export const SHORT_LIVED_FILE = 'short-lived.json';
export const SHORT_LIVED_PATH = `${DESIRED_DIR}/${SHORT_LIVED_FILE}`;
/** What a template's names put the environment's name in place of. */
export const PLACEHOLDER = '{environment}';
/** The tag a task asks for its own environment with. The owner can ask for one from the board too. */
export const ASK_TAG = 'environment';
/** The most short-lived environments one repository has at once, so a tag on many tasks can't make many. */
export const MAX_SHORT_LIVED = 3;
/** How long a task's environment lasts while the task stays open, and how long a removal the owner rejected waits. */
export const GRACE_MS = 14 * 86_400_000;
/** How long the board waits to try again when a plan couldn't be made: the provider didn't answer, or it's frozen. */
export const RETRY_MS = 15 * 60_000;
/** How long a request the board couldn't take (no template, the cap) waits before the board looks at it again. */
export const REFUSED_RETRY_MS = 60 * 60_000;

/**
 * Where a request is: `creating` until the plan that makes it ends, `ready` after, `removing` once the plan that
 * removes it is made, `removed` once it's gone (the row stays, so a tag doesn't ask again), and `refused` when the
 * board couldn't make it (no template, no provider, the cap), with why.
 */
export const SHORT_LIVED_STATES = ['creating', 'ready', 'removing', 'removed', 'refused'];

/** A plan's states that are still open: one in these hasn't ended yet. */
export const OPEN_PLAN_STATES = ['draft', 'waiting', 'approved', 'applying'];

/** The longest name an environment has (infra-environments.js), which a template's names must still fit with. */
const LONGEST = 'x'.repeat(40);

/**
 * The name a task's environment takes: its work ID, lowercased (`brk-12`), or `task-` and the start of its UUID when
 * it has none yet.
 * @param {{ uuid: string, wid?: string | null }} task
 */
export function shortLivedName(task) {
  const wid = String(task.wid ?? '')
    .trim()
    .toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,39}$/u.test(wid)) return wid;
  return `task-${String(task.uuid).replace(/-/gu, '').slice(0, 8).toLowerCase()}`;
}

/** @param {string} text @param {string} name */
const fill = (text, name) => text.split(PLACEHOLDER).join(name);

/**
 * Checks a template's text. The result is the template, or the first thing wrong with it, with its line and field,
 * the way a desired-state file's are (infra-desired.js). With `provider` (the template's provider from the registry,
 * when it's connected), each resource's kind must be one it declares.
 * @param {string} source
 * @param {{ provider?: import('./infra-provider.js').Provider | null }} [options]
 * @returns {{ ok: true, template: { provider: string, target: string, resources: DesiredState['resources'] } } | { ok: false, error: DesiredError }}
 */
export function checkShortLivedTemplate(source, { provider = null } = {}) {
  const checked = checkDesiredFile(source, { provider, extra: ['target'] });
  if ('error' in checked) return { ok: false, error: checked.error };
  const file = JSON.parse(String(source));
  const wrong = (field, message) => ({ ok: /** @type {const} */ (false), error: { line: null, field, message } });
  if (!checked.provider)
    return wrong('provider', 'provider is the ID of the provider short-lived environments run on, like cloudflare');
  if (typeof file.target !== 'string' || !file.target.includes(PLACEHOLDER))
    return wrong(
      'target',
      `target is what each environment runs on at its provider, with ${PLACEHOLDER} in it, like app-${PLACEHOLDER}`,
    );
  try {
    checkTarget(fill(file.target, LONGEST));
  } catch (error) {
    return wrong('target', error.message);
  }
  const ids = checked.desired.resources.filter((r) => !r.id.includes(PLACEHOLDER));
  if (ids.length)
    return wrong(
      'resources',
      `${ids[0].id} has no ${PLACEHOLDER} in its id: every task’s environment would share it, so put the name in`,
    );
  return {
    ok: true,
    template: { provider: checked.provider, target: file.target, resources: checked.desired.resources },
  };
}

/**
 * One environment's provider, target, and desired state, from the template and its name.
 * @param {{ provider: string, target: string, resources: DesiredState['resources'] }} template
 * @param {string} name
 * @returns {{ provider: string, target: string, desired: DesiredState }}
 */
export function renderShortLived(template, name) {
  const target = checkTarget(fill(template.target, name));
  if (!target) throw new InputError('the template’s target is empty');
  return {
    provider: template.provider,
    target,
    desired: {
      resources: template.resources.map((r) => ({
        ...structuredClone(r),
        id: fill(r.id, name),
        name: fill(r.name, name),
      })),
    },
  };
}

/**
 * What the board does next for a request, from where it is and its task (pure, so the order is tested on its own):
 * `create` (make the plan that makes it), `reject-create` (the task closed while that plan still waits for the owner),
 * `remove` (make the plan that removes it), `removed` (its removal applied, or its environment is gone), `ready` (the
 * plan that made it ended), `keep` (the owner rejected a removal or it failed: wait out the grace), or `wait`.
 * @param {{ state: string, created: number, next_try: number | null, create_plan: number | null, remove_plan: number | null }} row
 * @param {{ closed: boolean, environment: boolean, createPlan: string | null, removePlan: string | null, now: number }} at
 *   `createPlan` and `removePlan` are those plans' states, when there are any
 */
export function shortLivedNext(row, { closed, environment, createPlan, removePlan, now }) {
  if (row.state === 'removed' || row.state === 'refused') return 'wait';
  if (!environment) return 'removed';
  const due = !row.next_try || row.next_try <= now;
  if (removePlan) {
    if (removePlan === 'applied') return 'removed';
    if (OPEN_PLAN_STATES.includes(removePlan)) return 'wait';
    return 'keep';
  }
  if (createPlan && OPEN_PLAN_STATES.includes(createPlan)) {
    if (closed && ['draft', 'waiting'].includes(createPlan)) return 'reject-create';
    return 'wait';
  }
  const expired = now - row.created >= GRACE_MS;
  if ((closed || expired) && due) return 'remove';
  if (row.state === 'creating' && createPlan) return 'ready';
  if (row.state === 'creating' && !createPlan && !closed && due) return 'create';
  return 'wait';
}

/**
 * A request as the API shows it.
 * @param {Record<string, any>} row
 * @param {{ task: { uuid: string, wid: string | null, description: string } | null }} context
 */
export function shortLivedView(row, { task }) {
  const at = (/** @type {number | null} */ ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  return {
    task,
    repo: row.repo,
    name: row.name,
    environment: row.environment === null || row.environment === undefined ? null : Number(row.environment),
    state: row.state,
    askedBy: row.asked_by,
    createPlan: row.create_plan ? `plan-${row.create_plan}` : null,
    removePlan: row.remove_plan ? `plan-${row.remove_plan}` : null,
    error: row.error ?? null,
    nextTry: at(row.next_try),
    removeBy: row.state === 'removed' ? null : at(Number(row.created) + GRACE_MS),
    created: at(row.created),
    updated: at(row.updated),
  };
}
