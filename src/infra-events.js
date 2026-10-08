/**
 * Infrastructure triggers for routines, the pure part (BRK-293): a routine can start on what Architect does, as it
 * starts on a schedule, a GitHub event, a webhook, or a signal (a runbook, BRK-196). Each routine keeps a list of the
 * events it listens for, each with optional filters: the environments, their kinds, and the resource kinds an event
 * touches, and for `budget.crossed` the share of the budget it waits for. src/store-infra-events.js queues what
 * happens and delivers it.
 *
 * What reaches the run is the allowlist below and nothing else: names, IDs, states, and counts, never a value, a
 * setting, a text from a provider, or a token. Every string is checked against a short pattern, and one that looks like
 * a secret is left out, so even a field on the list can't carry anything else.
 */
import { InputError } from './model.js';
import { ENVIRONMENT_KINDS } from './infra-environments.js';
import { redact } from './redact.js';

/** The events a routine can start on, each with what Activity and the run's trigger say about it. */
export const INFRA_EVENTS = {
  'plan.waiting': 'a plan waits for you',
  'plan.applied': 'a plan is applied',
  'plan.failed': 'a plan fails to apply',
  'plan.rolled_back': 'a plan is rolled back',
  'drift.found': 'drift is found',
  'change.proposed': 'a change is proposed from the console',
  'change.merged': 'a change from the console merges',
  'deploy.done': 'a deploy lands',
  'promote.done': 'a promote lands',
  'environment.created': 'an environment is added',
  'environment.removed': 'an environment is removed',
  'inventory.stale': 'an inventory goes stale',
  'budget.crossed': 'a month passes a share of its budget',
  'envelope.used_up': 'an envelope’s restarts are used up',
  'incident.opened': 'an incident opens',
};

/** A duplicate (the same event for the same thing) within this long starts nothing for a routine that already had it. */
export const INFRA_EVENT_DEDUPE_MS = 24 * 3_600_000;
/** An event still queued after this long starts nothing: a routine is for what's happening now. */
export const INFRA_EVENT_FRESH_MS = 24 * 3_600_000;
/** What an event hands its run: these fields, in this order, and nothing else (at most ten, as a trigger comment shows). */
export const INFRA_EVENT_FIELDS = [
  'event',
  'environment',
  'kind',
  'plan',
  'state',
  'source',
  'pull',
  'resource',
  'resourceKind',
  'task',
  'count',
  'used',
];
/** The share of its budget a `budget.crossed` waits for, when the routine doesn't say. */
export const BUDGET_PERCENT_DEFAULT = 100;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RESOURCE_KIND = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const VALUE = /^[\w .:#/@-]{1,100}$/u;
const WID = /^[A-Z][A-Z0-9]*-\d+$/u;
const MOST = 20;

/**
 * One event a routine listens for: an empty list matches anything.
 * @typedef {{ event: string, environments: string[], kinds: string[], resourceKinds: string[],
 *   percent?: number }} InfraEventTrigger
 */

/**
 * What happened, as queued: where (the repository, the environment, its kind), the resource kinds it touches, the
 * fields its run gets, what makes it the same as another, and what caused it (a pull request, a task's work ID) so a
 * routine's own run never starts it again.
 * @typedef {{ key: string, repo: string, environment: string, environmentKind: string | null,
 *   resourceKinds: string[], fields: Record<string, string | number>, dedupe: string,
 *   cause: { pull?: number | null, wid?: string | null } }} InfraEvent
 */

/** A list from an array or a `+`-separated string, each entry checked, lowercased, and kept once. */
function listOf(value, field, test, says) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split('+');
  const list = [...new Set(raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  if (list.length > MOST) throw new InputError(`${field} has up to ${MOST} entries`);
  const bad = list.find((v) => !test(v));
  if (bad !== undefined) throw new InputError(`${field} ${says}, not "${bad.slice(0, 40)}"`);
  return list;
}

/**
 * One entry, from an object or the CLI's text: `budget.crossed:percent=80:environment=staging+production`.
 * @param {unknown} raw
 * @returns {InfraEventTrigger}
 */
function entryOf(raw) {
  /** @type {Record<string, unknown>} */
  let input;
  if (typeof raw === 'string') {
    const [event, ...filters] = raw.split(':').map((s) => s.trim());
    input = { event };
    for (const filter of filters) {
      const at = filter.indexOf('=');
      if (at < 1) throw new InputError(`a filter is name=value, not "${filter.slice(0, 40)}"`);
      const name = filter.slice(0, at).trim();
      const field = { environment: 'environments', resource: 'resourceKinds' }[name] ?? name;
      input[field] = filter.slice(at + 1).trim();
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) input = /** @type {any} */ (raw);
  else throw new InputError('each infrastructure event is a key, or an object with an event and its filters');
  const event = String(input.event ?? '').trim();
  if (!(event in INFRA_EVENTS))
    throw new InputError(
      `infrastructure events are ${Object.keys(INFRA_EVENTS).join(', ')}, not "${event.slice(0, 40)}"`,
    );
  const known = new Set(['event', 'environments', 'kinds', 'resourceKinds', 'percent', 'kind']);
  const unknown = Object.keys(input).find((k) => !known.has(k));
  if (unknown) throw new InputError(`${event} has no filter "${unknown.slice(0, 40)}"`);
  /** @type {InfraEventTrigger} */
  const out = {
    event,
    environments: listOf(input.environments, 'environments', (v) => NAME.test(v), 'are environments’ names'),
    kinds: listOf(
      input.kinds ?? input.kind,
      'kinds',
      (v) => ENVIRONMENT_KINDS.includes(v),
      `are ${ENVIRONMENT_KINDS.join(', ')}`,
    ),
    resourceKinds: listOf(input.resourceKinds, 'resourceKinds', (v) => RESOURCE_KIND.test(v), 'are resource kinds'),
  };
  if (event === 'budget.crossed') {
    const given = input.percent === undefined || input.percent === '' ? BUDGET_PERCENT_DEFAULT : Number(input.percent);
    if (!Number.isInteger(given) || given < 1 || given > 1000)
      throw new InputError('percent is the share of the budget, a whole number from 1 to 1000');
    out.percent = given;
  } else if (input.percent !== undefined) throw new InputError('percent is for budget.crossed only');
  return out;
}

/**
 * The events a routine listens for, from the API's list (keys or objects) or the CLI's comma-separated text. Each event
 * once; an empty value clears them.
 * @param {unknown} value
 * @returns {InfraEventTrigger[]}
 */
export function infraEventsOf(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const list = raw.map(entryOf);
  const twice = list.find((e, i) => list.findIndex((o) => o.event === e.event) !== i);
  if (twice) throw new InputError(`${twice.event} is listed twice: give it one set of filters`);
  return list;
}

/** A routine's kept list, from its column: a list that no longer reads is none at all. */
export function keptInfraEvents(text) {
  try {
    const list = JSON.parse(String(text || '[]'));
    return Array.isArray(list) ? infraEventsOf(list) : [];
  } catch {
    return [];
  }
}

/** One entry as the CLI and Activity say it: the inverse of the CLI's text. */
export function infraEventText(entry) {
  const parts = [entry.event];
  if (entry.environments.length) parts.push(`environment=${entry.environments.join('+')}`);
  if (entry.kinds.length) parts.push(`kind=${entry.kinds.join('+')}`);
  if (entry.resourceKinds.length) parts.push(`resource=${entry.resourceKinds.join('+')}`);
  if (entry.percent !== undefined) parts.push(`percent=${entry.percent}`);
  return parts.join(':');
}

/**
 * Whether `event` starts a routine through `entry`: the same key, in its lists, and for a budget, the month went past
 * the share it waits for since the last look (`before` below it, `used` at or over it).
 * @param {InfraEventTrigger} entry
 * @param {InfraEvent} event
 */
export function infraEventMatches(entry, event) {
  if (entry.event !== event.key) return false;
  if (entry.environments.length && !entry.environments.includes(event.environment)) return false;
  if (entry.kinds.length && !(event.environmentKind && entry.kinds.includes(event.environmentKind))) return false;
  if (entry.resourceKinds.length && !event.resourceKinds.some((k) => entry.resourceKinds.includes(k))) return false;
  if (event.key === 'budget.crossed') {
    const percent = entry.percent ?? BUDGET_PERCENT_DEFAULT;
    const used = Number(event.fields.used);
    const before = Number(event.fields.before ?? 0);
    if (!(used >= percent && before < percent)) return false;
  }
  return true;
}

/**
 * The event to queue: its fields cut down to INFRA_EVENT_FIELDS, each a short plain string that doesn't look like a
 * secret or a finite number, so nothing else a store hands it reaches the agent.
 * @param {string} key one of INFRA_EVENTS
 * @param {{ repo: string, name: string, kind?: string | null }} env
 * @param {{ fields?: Record<string, unknown>, dedupe?: string, resourceKinds?: (string | null | undefined)[],
 *   cause?: { pull?: number | null, wid?: string | null } }} [what]
 * @returns {InfraEvent}
 */
export function infraEventOf(key, env, { fields = {}, dedupe = '', resourceKinds = [], cause = {} } = {}) {
  if (!(key in INFRA_EVENTS)) throw new Error(`infraEventOf: unknown event ${key}`);
  /** @type {Record<string, unknown>} */
  const all = { ...fields, event: key, environment: env.name, kind: env.kind ?? null };
  /** @type {Record<string, string | number>} */
  const kept = {};
  for (const field of [...INFRA_EVENT_FIELDS, 'before']) {
    const value = all[field];
    if (typeof value === 'number' && Number.isFinite(value)) kept[field] = value;
    // A string that redacting would change held something secret-looking: it stays behind whole.
    else if (typeof value === 'string' && VALUE.test(value) && redact(value) === value) kept[field] = value;
  }
  return {
    key,
    repo: env.repo,
    environment: env.name,
    environmentKind: env.kind ?? null,
    resourceKinds: [...new Set(resourceKinds.filter((k) => typeof k === 'string' && RESOURCE_KIND.test(k)))],
    fields: kept,
    dedupe: JSON.stringify([key, env.repo, env.name, dedupe]),
    cause: {
      pull: Number.isSafeInteger(cause.pull) ? cause.pull : null,
      wid: typeof cause.wid === 'string' && WID.test(cause.wid) ? cause.wid : null,
    },
  };
}

/**
 * The trigger data a run gets: INFRA_EVENT_FIELDS only, in their order. `before` (a budget's last share) only helps
 * the match, so it stays behind.
 * @param {InfraEvent} event
 * @returns {Record<string, string | number>}
 */
export function infraEventData(event) {
  /** @type {Record<string, string | number>} */
  const data = {};
  for (const field of INFRA_EVENT_FIELDS) if (field in event.fields) data[field] = event.fields[field];
  return data;
}

/**
 * Which pull request or task caused a plan, from where it came from: a merged pull request (`#12`), or a task's work
 * ID (an envelope's act, a short-lived environment, an incident).
 * @param {string | null} ref the plan's source reference
 */
export function planCause(ref) {
  const s = String(ref ?? '');
  const pull = /^#(\d+)$/u.exec(s);
  if (pull) return { pull: Number(pull[1]) };
  return WID.test(s) ? { wid: s } : {};
}

/** The plan state each event key follows, for moveInfraPlan. */
export const PLAN_EVENTS = {
  waiting: 'plan.waiting',
  applied: 'plan.applied',
  failed: 'plan.failed',
  'rolled back': 'plan.rolled_back',
};

/**
 * What a run keeps about the event that started it (WEB-122), for its history and its task to name it and link to it:
 * the key and its words, the environment, and the plan, task, and pull request on it. `environmentId` is the board's
 * own environment, looked up by the store, or null when it doesn't know it.
 * @typedef {{ key: string, label: string, environment: string, environmentId: number | null, plan: string | null,
 *   task: string | null, pull: number | null }} InfraRunEvent
 */

/**
 * @param {InfraEvent} event
 * @param {number | null} environmentId
 * @returns {InfraRunEvent}
 */
export function infraRunEvent(event, environmentId) {
  const { plan, task, pull } = event.fields;
  const number = /^#(\d+)$/u.exec(String(pull ?? ''));
  return {
    key: event.key,
    label: INFRA_EVENTS[event.key],
    environment: event.environment,
    environmentId,
    plan: typeof plan === 'string' && /^plan-\d+$/u.test(plan) ? plan : null,
    task: typeof task === 'string' && WID.test(task) ? task : null,
    pull: number ? Number(number[1]) : null,
  };
}

/** A run's kept event, from its column: one that no longer reads is none at all. */
export function keptRunEvent(text) {
  if (!text) return null;
  try {
    const event = JSON.parse(String(text));
    return event && typeof event.key === 'string' && event.key in INFRA_EVENTS
      ? { ...event, label: INFRA_EVENTS[event.key] }
      : null;
  } catch {
    return null;
  }
}
