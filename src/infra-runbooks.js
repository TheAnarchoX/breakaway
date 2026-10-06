/**
 * Runbooks, the pure part (docs/specs/IDEA-19-architect.md, "Runbooks"; BRK-196): a runbook is a routine with a
 * signal trigger. The trigger says which signals start it (environments, resource kinds, signal kinds, and the
 * lowest level), whether it's on, and whether a match starts the agent or makes a run that waits for the owner's
 * Start. src/store-infra-runbooks.js keeps the triggers and hears the signals stream.
 *
 * A runbook is the only way an agent starts by itself on an incident (BRK-172), so a trigger is off until the owner
 * turns it on and waits for the owner's Start unless they set it to start by itself. What reaches the run is the
 * allowlist below and nothing else; a signal's text is already redacted when it's stored (src/infra-signals.js).
 */
import { AgentError } from './store-agents.js';
import { SIGNAL_KINDS, SIGNAL_LEVELS } from './infra-provider.js';

/** A duplicate (the same environment, resource, kind, and level) within this long starts nothing and notes nothing. */
export const RUNBOOK_DEDUPE_MS = 24 * 3_600_000;
/** A signal older than this when it reaches the board starts nothing: a runbook is for what's happening now. */
export const RUNBOOK_FRESH_MS = 24 * 3_600_000;
/** What a signal trigger hands its run: these fields, in this order, and nothing else. */
export const RUNBOOK_FIELDS = [
  'signal',
  'source',
  'environment',
  'resource',
  'resourceKind',
  'kind',
  'level',
  'value',
  'at',
  'text',
];
export const RUNBOOK_STARTS = ['wait', 'auto'];

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const KIND = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MOST = 20;

/**
 * A signal trigger as kept: an empty list matches anything.
 * @typedef {{ environments: string[], resourceKinds: string[], kinds: string[], level: string, on: boolean,
 *   start: string }} SignalTrigger
 */

/** A list from an array or a comma-separated string, each entry checked, lowercased, and kept once. */
function listOf(value, field, test, says) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const list = [...new Set(raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  if (list.length > MOST) throw new AgentError(`${field} has up to ${MOST} entries`, 400);
  const bad = list.find((v) => !test(v));
  if (bad !== undefined) throw new AgentError(`${field} ${says}, not "${bad.slice(0, 40)}"`, 400);
  return list;
}

/**
 * The trigger to keep: `input` over `current`, every field checked. A new trigger is off and waits.
 * @param {Partial<SignalTrigger> & Record<string, unknown>} input
 * @param {SignalTrigger} [current]
 * @returns {SignalTrigger}
 */
export function signalTrigger(input, current) {
  const out = current
    ? { ...current }
    : { environments: [], resourceKinds: [], kinds: [], level: 'critical', on: false, start: 'wait' };
  if ('environments' in input)
    out.environments = listOf(input.environments, 'environments', (v) => NAME.test(v), 'are environments’ names');
  if ('resourceKinds' in input)
    out.resourceKinds = listOf(input.resourceKinds, 'resourceKinds', (v) => KIND.test(v), 'are resource kinds');
  if ('kinds' in input)
    out.kinds = listOf(input.kinds, 'kinds', (v) => SIGNAL_KINDS.includes(v), `are ${SIGNAL_KINDS.join(', ')}`);
  if ('level' in input) {
    if (!SIGNAL_LEVELS.includes(String(input.level)))
      throw new AgentError(`level is the lowest that starts it: ${SIGNAL_LEVELS.join(', ')}`, 400);
    out.level = String(input.level);
  }
  if ('on' in input) {
    if (typeof input.on !== 'boolean') throw new AgentError('on is true or false', 400);
    out.on = input.on;
  }
  if ('start' in input) {
    if (!RUNBOOK_STARTS.includes(String(input.start)))
      throw new AgentError('start is wait (a run waits for your Start) or auto (it starts the agent)', 400);
    out.start = String(input.start);
  }
  return out;
}

/**
 * Whether `signal` starts a runbook with `trigger`: on, at or above its level, and in its lists.
 * @param {SignalTrigger} trigger
 * @param {{ environment: string, kind: string, level: string }} signal
 * @param {string | null} resourceKind the resource's kind from the inventory, or null when it isn't known
 */
export function signalMatches(trigger, signal, resourceKind) {
  if (!trigger.on) return false;
  if (SIGNAL_LEVELS.indexOf(signal.level) < SIGNAL_LEVELS.indexOf(trigger.level)) return false;
  if (trigger.environments.length && !trigger.environments.includes(signal.environment)) return false;
  if (trigger.kinds.length && !trigger.kinds.includes(signal.kind)) return false;
  if (trigger.resourceKinds.length && !(resourceKind && trigger.resourceKinds.includes(resourceKind))) return false;
  return true;
}

/** What makes two signals the same for a runbook: where, what, and how loud, never when or the words. */
export function signalKey(signal) {
  return JSON.stringify([signal.environmentId ?? signal.environment, signal.resource ?? '', signal.kind, signal.level]);
}

/**
 * The trigger data a run gets: RUNBOOK_FIELDS only, each a string, number, or boolean, so nothing else a signal
 * carries reaches the agent.
 * @param {{ id: number, source: string, environment: string, resource: string | null, kind: string, level: string,
 *   value: number | null, at: string, text: string }} signal a stored signal
 * @param {string | null} resourceKind
 * @returns {Record<string, string | number>}
 */
export function runbookData(signal, resourceKind) {
  const all = { ...signal, signal: signal.id, resourceKind };
  /** @type {Record<string, string | number>} */
  const data = {};
  for (const field of RUNBOOK_FIELDS) {
    const value = all[field];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) data[field] = value;
  }
  return data;
}
