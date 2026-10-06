/**
 * Architect's environments (docs/specs/IDEA-19-architect.md, "Environments"; BRK-174): a named target in one of the
 * board's repositories that plans apply to. Pure, so the rules are tested without the Durable Object; the table and
 * the API are in store-infra-environments.js.
 */
import { RESERVED_FILES } from './infra-desired.js';
import { InputError } from './model.js';

/** What an environment is for; production gates apply to `production` unless the owner says otherwise. */
export const ENVIRONMENT_KINDS = ['production', 'staging', 'short-lived'];
/** Per repository: enough for staging, production, and a handful of short-lived ones at once. */
export const MAX_ENVIRONMENTS = 50;

/** A name that's also a file name: `.github/breakaway-infra/<environment>.json` (BRK-180). */
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** A provider's ID in the registry (BRK-173), like `cloudflare`. */
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/u;
/** What the environment points at on its provider, like a Worker's name. */
const TARGET = /^[\w.:/-]{1,100}$/u;

/** @param {unknown} value */
export function checkEnvironmentName(value) {
  const name = String(value ?? '').trim();
  if (!NAME.test(name))
    throw new InputError(
      'name the environment with lowercase letters, digits, and - (up to 40), like staging or preview-12: it’s also its desired-state file’s name',
    );
  if (RESERVED_FILES.includes(name))
    throw new InputError(
      `${name} is the name of Architect’s ${name} file, so an environment can’t have it: pick another`,
    );
  return name;
}

/** @param {unknown} value */
export function checkEnvironmentKind(value) {
  const kind = String(value ?? '').trim();
  if (!ENVIRONMENT_KINDS.includes(kind)) throw new InputError('kind is production, staging, or short-lived');
  return kind;
}

/** @param {unknown} value */
export function checkProvider(value) {
  const provider = String(value ?? '').trim();
  if (!PROVIDER.test(provider))
    throw new InputError('provider is the ID of the provider the environment runs on, like cloudflare');
  return provider;
}

/** @param {unknown} value @returns {string | null} */
export function checkTarget(value) {
  if (value === null || value === undefined || value === '') return null;
  const target = String(value).trim();
  if (!TARGET.test(target))
    throw new InputError(
      'target is what the environment runs on at its provider, like a Worker’s name (up to 100 characters)',
    );
  return target;
}

/** @param {unknown} value @param {string} field */
export function checkSwitch(value, field) {
  if (typeof value !== 'boolean') throw new InputError(`${field} is true or false`);
  return value;
}

/**
 * Whether an environment runs the board's own install: it points at the install's Worker (src/install.js). That one
 * is always observe only (BRK-169), whatever its row says, so Architect never applies to the board it runs on.
 * @param {{ target: string | null }} row
 * @param {string} worker the install's Worker
 */
export const runsTheBoard = (row, worker) => Boolean(row.target) && row.target === worker;

/**
 * The environment as the API shows it.
 * @param {{ id: number, repo: string, name: string, kind: string, provider: string | null, target: string | null, task: string | null, frozen: number, frozen_at: number | null, gates: number | null, observe_only: number, pipeline?: string | null, created: number, edited: number }} row
 * @param {{ worker: string, task?: { uuid: string, wid: string | null, description: string } | null }} context
 */
export function environmentView(row, { worker, task = null }) {
  const own = runsTheBoard(row, worker);
  return {
    id: row.id,
    repo: row.repo,
    name: row.name,
    kind: row.kind,
    provider: row.provider ?? null,
    target: row.target ?? null,
    task,
    frozen: Boolean(row.frozen),
    frozenAt: row.frozen && row.frozen_at ? new Date(row.frozen_at).toISOString() : null,
    gates: row.gates === null || row.gates === undefined ? row.kind === 'production' : Boolean(row.gates),
    observeOnly: own || Boolean(row.observe_only),
    runsTheBoard: own,
    // `staging` or `production` when it's its repository's pipeline's (BRK-195), else null.
    pipeline: row.pipeline ?? null,
    created: new Date(row.created).toISOString(),
    edited: new Date(row.edited).toISOString(),
  };
}
