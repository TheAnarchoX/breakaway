/**
 * Architect's scaling rules, the pure part (docs/specs/IDEA-19-architect.md, "Envelopes"; BRK-241): rules in the
 * repository, at `.github/breakaway-infra/scaling.json` on its default branch, that turn a signal into one scale or
 * restart. A rule only asks: the board acts through the environment's envelope (BRK-186), whose bounds the owner set on
 * the board, so inside them the act applies with no press and outside them it's a plan that waits for the owner. A rule
 * can't widen an envelope, and a repository without the file acts on nothing.
 *
 * A file is:
 *
 *   { "version": 1,
 *     "rules": [
 *       { "name": "api is busy", "environments": ["production"], "resource": "api",
 *         "kinds": ["alert"], "level": "warning", "above": 80, "act": "scale", "step": 1 },
 *       { "name": "worker is down", "resourceKinds": ["container"], "kinds": ["health"], "act": "restart" } ] }
 *
 * A rule hears signals about one resource (`resource`, by name or ID) or every resource of its `resourceKinds`, in its
 * `environments` (every one when left out), of its signal `kinds` (health or alert, never cost), at or above `level` (critical when left out), and,
 * with `above` or `below`, only when the signal's value is past it. It acts on the resource the signal is about: `act`
 * is `scale`, to a whole number (`to`) or by one (`step`, from what the inventory says it runs), or `restart`.
 *
 * Pure and Node-safe, so `npx breakaway infra check` (CLI-14) can use it: no store and no network.
 */
import { DESIRED_DIR, parseWithLines } from './infra-desired.js';
import { SIGNAL_KINDS, SIGNAL_LEVELS } from './infra-provider.js';

/** Where the rules are, on the default branch, beside the environments' files and the policy. */
export const SCALING_FILE = 'scaling.json';
export const SCALING_PATH = `${DESIRED_DIR}/${SCALING_FILE}`;
export const SCALING_VERSION = 1;
export const SCALING_MAX_BYTES = 64 * 1024;
/** The most rules one file holds, and the most names in any one list. */
export const SCALING_MAX_RULES = 50;
/** What a rule does: the acts an envelope bounds. */
export const SCALING_ACTS = ['scale', 'restart'];
/** The signal kinds a rule hears: never cost, so a budget's alert never scales anything up. */
export const SCALING_KINDS = SIGNAL_KINDS.filter((k) => k !== 'cost');
const LIST_MAX = 20;
const SCALE_MAX = 10_000;
const VALUE_MAX = 1e12;
const NAME_MAX = 80;
const RESOURCE_MAX = 100;

const TOP = ['version', 'rules'];
const RULE = [
  'name',
  'environments',
  'resource',
  'resourceKinds',
  'kinds',
  'level',
  'above',
  'below',
  'act',
  'to',
  'step',
];
const ENV_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const KIND = /^[a-z][a-z0-9-]{0,39}$/u;

/**
 * A rule as kept: empty lists match anything.
 * @typedef {object} ScalingRule
 * @property {string} name what the audit trail and the board call it
 * @property {string[]} environments
 * @property {string | null} resource the resource's name or ID, or null for any of `resourceKinds`
 * @property {string[]} resourceKinds
 * @property {string[]} kinds the signal kinds it hears
 * @property {string} level the lowest level it hears
 * @property {number | null} above
 * @property {number | null} below
 * @property {'scale' | 'restart'} act
 * @property {number | null} to a scale's whole number
 * @property {number | null} step a scale's step, up or down
 */

/** @typedef {import('./infra-desired.js').DesiredError} ScalingError */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks a scaling file's text. The result is its rules, with what each leaves out filled in, or the first thing wrong
 * with it, with its line and field.
 * @param {string} source
 * @returns {{ ok: true, rules: ScalingRule[] } | { ok: false, error: ScalingError }}
 */
export function checkScalingFile(source) {
  /** @type {Map<string, number>} */
  let lines = new Map();
  /** @param {string | null} field @param {string} message @param {number | null} [at] */
  const wrong = (field, message, at) => ({
    ok: /** @type {const} */ (false),
    error: { line: at ?? (field === null ? null : (lines.get(field) ?? null)), field, message },
  });
  const raw = String(source ?? '');
  if (new TextEncoder().encode(raw).length > SCALING_MAX_BYTES)
    return wrong(null, `the file is over ${SCALING_MAX_BYTES / 1024} KB: trim it`);
  let file;
  try {
    ({ value: file, lines } = parseWithLines(raw));
  } catch (error) {
    if (error instanceof Error && 'line' in error)
      return wrong(null, `it isn’t JSON: ${error.message}`, Number(error.line));
    throw error;
  }
  const top = lines.get('') ?? 1;
  if (!isObject(file)) return wrong(null, 'the file is one JSON object: { "version": 1, "rules": [ … ] }', top);
  for (const key of Object.keys(file))
    if (!TOP.includes(key)) return wrong(key, `“${key}” isn’t part of scaling rules: it has ${TOP.join(', ')}`);
  if (file.version !== SCALING_VERSION)
    return wrong(
      file.version === undefined ? null : 'version',
      `version is ${SCALING_VERSION}: add "version": ${SCALING_VERSION}`,
      file.version === undefined ? top : undefined,
    );
  if (!Array.isArray(file.rules))
    return wrong(
      file.rules === undefined ? null : 'rules',
      'rules is a list of what to scale or restart on a signal: [ { "name": …, "act": "scale", … } ]',
      file.rules === undefined ? top : undefined,
    );
  if (file.rules.length > SCALING_MAX_RULES)
    return wrong('rules', `rules has ${file.rules.length}: at most ${SCALING_MAX_RULES}`);

  /** @param {unknown} value @param {string} field @param {(v: string) => boolean} test @param {string} what */
  const names = (value, field, test, what) => {
    if (!Array.isArray(value) || value.length === 0)
      return wrong(field, `${field.split('.').pop()} is a list of ${what}`);
    if (value.length > LIST_MAX)
      return wrong(field, `${field.split('.').pop()} has ${value.length}: at most ${LIST_MAX}`);
    for (let n = 0; n < value.length; n += 1)
      if (typeof value[n] !== 'string' || !test(value[n])) return wrong(`${field}[${n}]`, `each one is ${what}`);
    return null;
  };

  /** @type {ScalingRule[]} */
  const rules = [];
  const seen = new Map();
  for (let n = 0; n < file.rules.length; n += 1) {
    const at = `rules[${n}]`;
    const r = file.rules[n];
    if (!isObject(r)) return wrong(at, 'each rule is an object with a name, what it hears, and what it does');
    for (const key of Object.keys(r))
      if (!RULE.includes(key)) return wrong(`${at}.${key}`, `“${key}” isn’t part of a rule: it has ${RULE.join(', ')}`);
    if (typeof r.name !== 'string' || r.name.trim() === '' || r.name.length > NAME_MAX)
      return wrong(
        r.name === undefined ? at : `${at}.name`,
        `name says what the rule does, up to ${NAME_MAX} characters, like api is busy`,
      );
    const name = r.name.trim();
    if (seen.has(name))
      return wrong(`${at}.name`, `${name} is the name of rules[${seen.get(name)}] too: give each its own`);
    seen.set(name, n);

    /** @type {ScalingRule} */
    const rule = {
      name,
      environments: [],
      resource: null,
      resourceKinds: [],
      kinds: [],
      level: 'critical',
      above: null,
      below: null,
      act: 'restart',
      to: null,
      step: null,
    };
    if (r.environments !== undefined) {
      const bad = names(r.environments, `${at}.environments`, (v) => ENV_NAME.test(v), 'an environment’s name');
      if (bad) return bad;
      rule.environments = [...new Set(/** @type {string[]} */ (r.environments))];
    }
    if (r.resource !== undefined) {
      if (typeof r.resource !== 'string' || r.resource.trim() === '' || r.resource.length > RESOURCE_MAX)
        return wrong(`${at}.resource`, `resource is the resource’s name or ID, up to ${RESOURCE_MAX} characters`);
      rule.resource = r.resource.trim();
    }
    if (r.resourceKinds !== undefined) {
      const bad = names(r.resourceKinds, `${at}.resourceKinds`, (v) => KIND.test(v), 'a resource kind, like container');
      if (bad) return bad;
      rule.resourceKinds = [...new Set(/** @type {string[]} */ (r.resourceKinds))];
    }
    if (rule.resource === null && rule.resourceKinds.length === 0)
      return wrong(at, 'a rule names the resource it acts on (resource), or the kinds it acts on (resourceKinds)');
    if (r.kinds !== undefined) {
      const bad = names(
        r.kinds,
        `${at}.kinds`,
        (v) => SCALING_KINDS.includes(v),
        `a signal kind: ${SCALING_KINDS.join(' or ')} (a cost signal never scales or restarts anything)`,
      );
      if (bad) return bad;
      rule.kinds = [...new Set(/** @type {string[]} */ (r.kinds))];
    }
    if (r.level !== undefined) {
      if (!SIGNAL_LEVELS.includes(r.level))
        return wrong(`${at}.level`, `level is the lowest a signal is to count: ${SIGNAL_LEVELS.join(', ')}`);
      rule.level = r.level;
    }
    for (const key of /** @type {const} */ (['above', 'below']))
      if (r[key] !== undefined) {
        if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || Math.abs(r[key]) > VALUE_MAX)
          return wrong(`${at}.${key}`, `${key} is a number the signal’s value has to be ${key}, like 80`);
        rule[key] = r[key];
      }
    if (rule.above !== null && rule.below !== null && rule.above >= rule.below)
      return wrong(`${at}.below`, `no value is above ${rule.above} and below ${rule.below}: pick one, or widen them`);

    if (!SCALING_ACTS.includes(r.act))
      return wrong(r.act === undefined ? at : `${at}.act`, 'act is scale or restart: what the rule asks for');
    rule.act = r.act;
    if (rule.act === 'restart') {
      for (const key of ['to', 'step'])
        if (r[key] !== undefined) return wrong(`${at}.${key}`, `a restart takes no ${key}: leave it out`);
    } else {
      if ((r.to === undefined) === (r.step === undefined))
        return wrong(at, 'a scale has to (a whole number) or step (up or down by a whole number), not both');
      if (r.to !== undefined) {
        if (!Number.isInteger(r.to) || r.to < 0 || r.to > SCALE_MAX)
          return wrong(`${at}.to`, `to is a whole number from 0 to ${SCALE_MAX}`);
        rule.to = r.to;
      } else {
        if (!Number.isInteger(r.step) || r.step === 0 || Math.abs(r.step) > SCALE_MAX)
          return wrong(`${at}.step`, `step is a whole number up or down, like 1 or -1, and never 0`);
        rule.step = r.step;
      }
    }
    rules.push(rule);
  }
  return { ok: true, rules };
}

/**
 * Whether a rule hears a signal about a resource. A cost signal never matches. A signal with no resource, or one the inventory doesn't know, never
 * matches a rule that names kinds; a rule's `resource` matches the resource's name or its ID.
 * @param {ScalingRule} rule
 * @param {{ environment: string, kind: string, level: string, value: number | null }} signal
 * @param {{ id: string, name: string | null, kind: string | null }} resource
 */
export function ruleMatches(rule, signal, resource) {
  if (!SCALING_KINDS.includes(signal.kind)) return false;
  if (SIGNAL_LEVELS.indexOf(signal.level) < SIGNAL_LEVELS.indexOf(rule.level)) return false;
  if (rule.environments.length && !rule.environments.includes(signal.environment)) return false;
  if (rule.kinds.length && !rule.kinds.includes(signal.kind)) return false;
  if (rule.resource !== null && rule.resource !== resource.id && rule.resource !== resource.name) return false;
  if (rule.resourceKinds.length && !(resource.kind && rule.resourceKinds.includes(resource.kind))) return false;
  if (rule.above !== null && !(typeof signal.value === 'number' && signal.value > rule.above)) return false;
  if (rule.below !== null && !(typeof signal.value === 'number' && signal.value < rule.below)) return false;
  return true;
}

/**
 * What a matching rule asks the envelope for: a restart, or a scale to a whole number. A step needs what the resource
 * runs now; when that isn't known, the answer says so and nothing is asked.
 * @param {ScalingRule} rule
 * @param {number | null} current what the resource's scaled setting is now, from the inventory
 * @returns {{ change: 'scale' | 'restart', value: number | null } | { unknown: string }}
 */
export function ruleAct(rule, current) {
  if (rule.act === 'restart') return { change: 'restart', value: null };
  if (rule.to !== null) return { change: 'scale', value: rule.to };
  if (!Number.isInteger(current)) return { unknown: 'what it runs now isn’t known yet, so a step can’t be worked out' };
  return {
    change: 'scale',
    value: Math.min(SCALE_MAX, Math.max(0, /** @type {number} */ (current) + /** @type {number} */ (rule.step))),
  };
}

/** A rule in words, for the board: "scale api by 1 on an alert, warning and up, above 80, in production". */
export function ruleWords(rule) {
  const what =
    rule.act === 'restart'
      ? 'restart'
      : rule.to !== null
        ? `scale to ${rule.to}`
        : `scale ${/** @type {number} */ (rule.step) > 0 ? 'up' : 'down'} by ${Math.abs(/** @type {number} */ (rule.step))}`;
  const on = rule.resource ?? `every ${rule.resourceKinds.join(' or ')}`;
  const heard = rule.kinds.length
    ? `${rule.kinds[0] === 'alert' ? 'an' : 'a'} ${rule.kinds.join(' or ')} signal`
    : 'a signal';
  const past = [
    ...(rule.above === null ? [] : [`above ${rule.above}`]),
    ...(rule.below === null ? [] : [`below ${rule.below}`]),
  ];
  const where = rule.environments.length ? `, in ${rule.environments.join(', ')}` : '';
  return `${what} ${on} on ${heard}, ${rule.level}${rule.level === 'critical' ? '' : ' and up'}${past.length ? `, ${past.join(' and ')}` : ''}${where}`;
}
