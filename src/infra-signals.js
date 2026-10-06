/**
 * Architect's signals, the pure part (docs/specs/IDEA-19-architect.md, "Signals"; BRK-190): whatever a provider or
 * the deploy flow reports becomes one shape (source, environment, resource, kind, level, value, time, short text),
 * checked and scrubbed before src/store-infra-signals.js stores it. The first version takes health, the platform's
 * alerts, and cost (BRK-172: no metrics, logs, or traces); any other kind is refused. Raw signals are kept
 * SIGNAL_RAW_DAYS, then fold into daily summaries kept SIGNAL_SUMMARY_DAYS.
 *
 * Nothing secret or personal is kept: every text is redacted the way Connections redacts (src/redact.js), and email
 * addresses are dropped, as the audit trail does.
 */
import { AgentError } from './store-agents.js';
import { redact } from './redact.js';
import { SIGNAL_KINDS, SIGNAL_LEVELS, SIGNAL_TEXT_MAX } from './infra-provider.js';

export { SIGNAL_KINDS, SIGNAL_LEVELS, SIGNAL_TEXT_MAX } from './infra-provider.js';

export const DAY = 86_400_000;
/** Raw signals, kept this long (BRK-172). */
export const SIGNAL_RAW_DAYS = 7;
/** Daily summaries, kept this long (BRK-172). */
export const SIGNAL_SUMMARY_DAYS = 90;
/** A signal from further ahead than this is refused: a platform's clock is a little off, never a day. */
const FUTURE_MS = DAY;

const SOURCE = /^[a-z][a-z0-9-]{0,39}$/u;
const ENVIRONMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const EMAIL = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/gu;
const RESOURCE_MAX = 200;

/**
 * A signal as it comes in: a provider's `events`, its health and cost turned into signals, or the deploy flow.
 * @typedef {import('./infra-provider.js').Signal} SignalInput
 */

/**
 * A signal ready to store: `at` in milliseconds, every text scrubbed.
 * @typedef {{ source: string, environment: string, resource: string | null, kind: string, level: string,
 *   value: number | null, at: number, text: string }} SignalEntry
 */

/**
 * One day's signals for a source, environment, resource, and kind.
 * @typedef {{ day: string, source: string, environment: string, resource: string | null, kind: string, count: number,
 *   info: number, warning: number, critical: number, min: number | null, max: number | null, last: number | null,
 *   lastAt: number, text: string }} SignalDay
 */

/** Text from outside the board, safe to keep: secrets and email addresses redacted, one line, short. */
export function scrub(text, max) {
  const s = redact(String(text ?? ''))
    .replace(EMAIL, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The signal to store, or an AgentError that says what's wrong with it.
 * @param {SignalInput} input
 * @param {number} [now]
 * @returns {SignalEntry}
 */
export function signalEntry(input, now = Date.now()) {
  const source = String(input?.source ?? '');
  if (!SOURCE.test(source)) throw new AgentError('source must be a provider’s ID', 400);
  const environment = String(input?.environment ?? '').toLowerCase();
  if (!ENVIRONMENT.test(environment)) throw new AgentError('environment must be an environment’s name', 400);
  const kind = String(input?.kind ?? '');
  if (!SIGNAL_KINDS.includes(kind))
    throw new AgentError(`kind must be one of ${SIGNAL_KINDS.join(', ')}, not "${scrub(kind, 40)}"`, 400);
  const level = String(input?.level ?? '');
  if (!SIGNAL_LEVELS.includes(level)) throw new AgentError(`level must be one of ${SIGNAL_LEVELS.join(', ')}`, 400);
  const raw = input?.resource;
  if (raw !== null && raw !== undefined && (typeof raw !== 'string' || raw.trim() === ''))
    throw new AgentError('resource must be a resource’s ID, or null for the whole environment', 400);
  const value = input?.value ?? null;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
    throw new AgentError('value must be a number, or null', 400);
  const at = typeof input?.at === 'string' ? Date.parse(input.at) : Number.NaN;
  if (Number.isNaN(at)) throw new AgentError('at must be a time, in ISO 8601', 400);
  if (at > now + FUTURE_MS) throw new AgentError('at is more than a day ahead of the board’s clock', 400);
  const text = scrub(input?.text, SIGNAL_TEXT_MAX);
  if (!text) throw new AgentError('text must say what happened', 400);
  return {
    source,
    environment,
    resource: raw ? scrub(raw, RESOURCE_MAX) : null,
    kind,
    level,
    value,
    at,
    text,
  };
}

/** The UTC day a time falls on, as YYYY-MM-DD. */
export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const keyOf = (s) => JSON.stringify([dayOf(s.at), s.source, s.environment, s.resource ?? '', s.kind]);

/**
 * Folds signals into daily summaries, one per day, source, environment, resource, and kind, merged into `existing`
 * (summaries already stored for those keys) so folding the same day twice adds up instead of overwriting.
 * @param {SignalEntry[]} signals
 * @param {SignalDay[]} [existing]
 * @returns {SignalDay[]}
 */
export function foldSignals(signals, existing = []) {
  /** @type {Map<string, SignalDay>} */
  const days = new Map();
  for (const d of existing)
    days.set(JSON.stringify([d.day, d.source, d.environment, d.resource ?? '', d.kind]), { ...d });
  for (const s of signals) {
    const key = keyOf(s);
    let d = days.get(key);
    if (!d) {
      d = {
        day: dayOf(s.at),
        source: s.source,
        environment: s.environment,
        resource: s.resource,
        kind: s.kind,
        count: 0,
        info: 0,
        warning: 0,
        critical: 0,
        min: null,
        max: null,
        last: null,
        lastAt: s.at,
        text: s.text,
      };
      days.set(key, d);
    }
    d.count++;
    d[s.level]++;
    if (s.value !== null) {
      d.min = d.min === null ? s.value : Math.min(d.min, s.value);
      d.max = d.max === null ? s.value : Math.max(d.max, s.value);
    }
    if (s.at >= d.lastAt) {
      d.lastAt = s.at;
      d.text = s.text;
      if (s.value !== null) d.last = s.value;
    }
  }
  return [...days.values()];
}
