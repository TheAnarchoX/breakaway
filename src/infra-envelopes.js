/**
 * Architect's envelopes, the pure part (docs/specs/IDEA-19-architect.md, "Envelopes"; BRK-186): bounds the owner
 * approves once on one environment, production included (BRK-171), inside which a scale or a restart applies through
 * the executor with no press. The store (store-infra-envelopes.js) keeps them on the board, never in the repository,
 * so a pull request can't widen them, and acts inside them.
 *
 * An envelope is:
 *
 *   { "scale": [ { "kind": "service", "resource": "api", "min": 2, "max": 10 } ],
 *     "monthly": 50,
 *     "restarts": { "cap": 3, "hours": 24 } }
 *
 * `scale` bounds the setting a kind's scale changes (the provider's `scales`, like `instances`), for one resource by
 * name or every resource of the kind. `monthly` is the most the environment may cost a month once a scale is applied,
 * in the board's currency (BRK-226), or null for no cost bound. `restarts` is the restart cap: how many restarts
 * apply without a press in a window of `hours`, 3 a day by default; a cap of 0 asks the owner for every restart.
 * Anything else, or outside the bounds, is a plan that waits for the owner.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */
import { InputError } from './model.js';

/** @typedef {import('./infra-provider.js').Provider} Provider */
/** @typedef {import('./infra-provider.js').Change} Change */

/** What an envelope acts on: a scale to a whole number, or a restart. */
export const ENVELOPE_ACTS = ['scale', 'restart'];
/** The restart cap an envelope starts with (BRK-171): 3 in a day. */
export const DEFAULT_RESTARTS = Object.freeze({ cap: 3, hours: 24 });
/** The most scale bounds one envelope holds. */
export const MAX_BOUNDS = 20;
/** The most a scaled setting, and a restart cap, may be. */
export const SCALE_MAX = 10_000;
export const CAP_MAX = 100;
/** The longest a restart window is: 30 days. */
export const HOURS_MAX = 720;
const MONTHLY_MAX = 1_000_000;

const KIND = /^[a-z][a-z0-9-]{0,39}$/u;
const NAME_MAX = 100;
const TOP = ['scale', 'monthly', 'restarts'];
const BOUND = ['kind', 'resource', 'min', 'max'];
const CAP = ['cap', 'hours'];

/**
 * @typedef {{ kind: string, resource: string | null, min: number, max: number }} ScaleBound
 * @typedef {{ scale: ScaleBound[], monthly: number | null, restarts: { cap: number, hours: number } }} Envelope
 */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** A whole number from `min` to `max`, or an InputError naming the field. */
function whole(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new InputError(`${field} is a whole number from ${min} to ${max}`);
  return /** @type {number} */ (value);
}

/**
 * Checks an envelope the owner sets, against the provider's kinds: a scale bound only for a kind that scales, and
 * restarts left at the default when not given. The result is the envelope to keep.
 * @param {unknown} input
 * @param {Provider['kinds']} kinds the environment's provider's kinds
 * @returns {Envelope}
 */
export function checkEnvelope(input, kinds) {
  if (!isObject(input)) throw new InputError('an envelope is { scale, monthly, restarts }');
  const raw = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(raw))
    if (!TOP.includes(key))
      throw new InputError(`“${key.slice(0, 40)}” isn’t part of an envelope: it has ${TOP.join(', ')}`);

  const list = raw.scale ?? [];
  if (!Array.isArray(list)) throw new InputError('scale is a list of bounds: { kind, resource, min, max }');
  if (list.length > MAX_BOUNDS) throw new InputError(`an envelope has up to ${MAX_BOUNDS} scale bounds`);
  const seen = new Set();
  const scale = list.map((b, i) => {
    const at = `scale[${i}]`;
    if (!isObject(b)) throw new InputError(`${at} is { kind, resource, min, max }`);
    for (const key of Object.keys(b))
      if (!BOUND.includes(key))
        throw new InputError(`${at} has “${key.slice(0, 40)}”: a bound has ${BOUND.join(', ')}`);
    const kind = String(b.kind ?? '').trim();
    if (!KIND.test(kind)) throw new InputError(`${at}.kind is a resource kind, like service`);
    const spec = kinds?.[kind];
    if (!spec) throw new InputError(`${at}: the environment’s provider has no ${kind}`);
    if (!spec.changes.includes('scale') || !spec.scales)
      throw new InputError(`${at}: a ${kind} doesn’t scale on its provider, so an envelope can’t bound it`);
    const resource =
      b.resource === undefined || b.resource === null || b.resource === '' ? null : String(b.resource).trim();
    if (resource !== null && (resource.length === 0 || resource.length > NAME_MAX))
      throw new InputError(
        `${at}.resource is the resource’s name, up to ${NAME_MAX} characters, or left out for every ${kind}`,
      );
    const min = whole(b.min, `${at}.min`, 0, SCALE_MAX);
    const max = whole(b.max, `${at}.max`, 0, SCALE_MAX);
    if (min > max) throw new InputError(`${at}: min (${min}) is more than max (${max})`);
    const key = `${kind}\u0000${resource ?? ''}`;
    if (seen.has(key)) throw new InputError(`${at} bounds ${resource ?? `every ${kind}`} twice`);
    seen.add(key);
    return { kind, resource, min, max };
  });

  let monthly = null;
  if (raw.monthly !== undefined && raw.monthly !== null) {
    if (
      typeof raw.monthly !== 'number' ||
      !Number.isFinite(raw.monthly) ||
      raw.monthly < 0 ||
      raw.monthly > MONTHLY_MAX
    )
      throw new InputError(`monthly is the most the environment may cost a month, from 0 to ${MONTHLY_MAX}, or null`);
    monthly = Math.round(raw.monthly * 100) / 100;
  }

  /** @type {{ cap: number, hours: number }} */
  let restarts = { ...DEFAULT_RESTARTS };
  if (raw.restarts !== undefined && raw.restarts !== null) {
    if (!isObject(raw.restarts))
      throw new InputError('restarts is { cap, hours }: how many restarts in how many hours');
    const r = /** @type {Record<string, unknown>} */ (raw.restarts);
    for (const key of Object.keys(r))
      if (!CAP.includes(key)) throw new InputError(`restarts has “${key.slice(0, 40)}”: it has cap and hours`);
    restarts = {
      cap: r.cap === undefined ? DEFAULT_RESTARTS.cap : whole(r.cap, 'restarts.cap', 0, CAP_MAX),
      hours: r.hours === undefined ? DEFAULT_RESTARTS.hours : whole(r.hours, 'restarts.hours', 1, HOURS_MAX),
    };
  }
  return { scale, monthly, restarts };
}

/**
 * The bound a resource's scale falls under: its own, by name, before its kind's.
 * @param {Envelope} envelope
 * @param {{ kind: string, name: string }} resource
 */
export function boundFor(envelope, resource) {
  return (
    envelope.scale.find((b) => b.kind === resource.kind && b.resource === resource.name) ??
    envelope.scale.find((b) => b.kind === resource.kind && b.resource === null) ??
    null
  );
}

/** A window's length in words: "a day", "12 hours", "3 days". */
export function windowWords(hours) {
  if (hours === 24) return 'a day';
  if (hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/**
 * Whether one change falls inside an envelope, and why in words. A scale is inside when its kind's or its resource's
 * bound holds the new value and, with a cost bound, the environment's monthly cost after it is known and within it. A
 * restart is inside while the cap has room: `restartsUsed` is how many restarts applied inside it in the window.
 * @param {Envelope | null} envelope
 * @param {Change} change
 * @param {{ scales: string | undefined, costAfter: number | null, currency: string, restartsUsed: number }} context
 * @returns {{ inside: boolean, capUsed: boolean, why: string }}
 */
export function judgeChange(envelope, change, { scales, costAfter, currency, restartsUsed }) {
  const out = (inside, why, capUsed = false) => ({ inside, capUsed, why });
  if (!envelope) return out(false, 'the environment has no envelope');
  if (change.op === 'restart') {
    const { cap, hours } = envelope.restarts;
    if (cap === 0) return out(false, 'its envelope asks you for every restart');
    if (restartsUsed >= cap)
      return out(false, `${change.name} used its ${cap} restart${cap === 1 ? '' : 's'} in ${windowWords(hours)}`, true);
    return out(true, `restart ${restartsUsed + 1} of ${cap} in ${windowWords(hours)}`);
  }
  if (change.op !== 'scale') return out(false, `an envelope only scales and restarts, and this would ${change.op}`);
  const bound = boundFor(envelope, change);
  if (!bound) return out(false, `its envelope has no bound for ${change.name}`);
  const to = scales ? change.after?.[scales] : undefined;
  if (!Number.isInteger(to)) return out(false, `the provider doesn’t say what ${change.name} scales to`);
  if (/** @type {number} */ (to) < bound.min || /** @type {number} */ (to) > bound.max)
    return out(false, `${to} is outside its envelope’s ${bound.min} to ${bound.max}`);
  if (envelope.monthly !== null) {
    if (costAfter === null)
      return out(false, `what ${change.name} would cost a month isn’t known, and the envelope bounds it`);
    if (costAfter > envelope.monthly)
      return out(false, `it would cost ${costAfter} ${currency} a month, over the envelope’s ${envelope.monthly}`);
  }
  return out(true, `${to} is inside ${bound.min} to ${bound.max}`);
}

/**
 * What an act asks for, checked: a resource (its ID or name), a change (`scale` or `restart`), and, for a scale, the
 * whole number to scale to. Nothing else in the body reaches the plan: the board builds it.
 * @param {unknown} body
 * @returns {{ resource: string, change: 'scale' | 'restart', value: number | null }}
 */
export function checkAct(body) {
  if (!isObject(body)) throw new InputError('an act is { resource, change, value }');
  const b = /** @type {Record<string, unknown>} */ (body);
  const resource = String(b.resource ?? '').trim();
  if (!resource || resource.length > NAME_MAX) throw new InputError('resource is the resource’s ID or name');
  const change = String(b.change ?? '');
  if (!ENVELOPE_ACTS.includes(change)) throw new InputError('change is scale or restart');
  if (change === 'restart') {
    if (b.value !== undefined && b.value !== null) throw new InputError('a restart takes no value');
    return { resource, change: 'restart', value: null };
  }
  return { resource, change: 'scale', value: whole(b.value, 'value', 0, SCALE_MAX) };
}

/** The envelope's words for the inbox and the audit trail: "2 to 10 for every service; 3 restarts a day". */
export function envelopeWords(envelope) {
  const bounds = envelope.scale.map((b) => `${b.min} to ${b.max} for ${b.resource ?? `every ${b.kind}`}`);
  const { cap, hours } = envelope.restarts;
  return [
    ...bounds,
    ...(envelope.monthly === null ? [] : [`up to ${envelope.monthly} a month`]),
    cap === 0 ? 'every restart asks you' : `${cap} restart${cap === 1 ? '' : 's'} in ${windowWords(hours)}`,
  ].join('; ');
}
