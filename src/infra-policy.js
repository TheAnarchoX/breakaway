/**
 * Architect's policy (docs/specs/IDEA-19-architect.md, "Policy"; BRK-181): the rules that decide whether a plan waits
 * for the owner, as code beside the desired state, at `.github/breakaway-infra/policy.json` on the repository's default
 * branch. A repository with no policy file gets DEFAULT_POLICY, from the owner's answers on BRK-171: every plan, in
 * every environment, waits for the owner.
 *
 * Every plan is checked against the policy when it's made, and each rule's result is kept on the plan in words, so the
 * plan says why it waits ("Production needs you."). The guards (production, destructive, access, cost, budget) always
 * ask when they apply: a policy sets the cost limit and the budget, and names more access and exposure changes, but
 * can't turn a guard off. A plan none of them catch waits too, unless one of the policy's `allow` rules lets it
 * through, and then the plan names that rule. Envelopes (BRK-186) are the only standing exception, and aren't here. A
 * frozen environment refuses every plan.
 *
 * A file is:
 *
 *   { "version": 1, "costLimit": 5, "budget": 20,
 *     "environments": { "production": { "costLimit": 50, "budget": 200, "allow": [] } },
 *     "access": { "kinds": ["route"], "settings": ["public"] },
 *     "allow": [ { "name": "small staging changes", "environments": ["staging"], "changes": ["update", "scale"] } ] }
 *
 * Two levels (WEB-123): the top of the file is the repository's rules, and `environments` overrides them for one
 * environment by name. An environment's `costLimit` and `budget` replace the repository's, its `access` adds kinds and
 * settings to the repository's (it can't take one away), and its `allow`, when it has one, replaces the repository's
 * rules for that environment: `"allow": []` makes every plan there wait for the owner whatever the repository allows.
 *
 * Limits are a month, in the board's currency (BRK-226): the owner's, set in Settings, which the plan's cost change is
 * converted into before it's checked (infra-currency.js). Pure and Node-safe, so `npx
 * breakaway infra check` (CLI-14) can use it: no store and no network.
 */
import { CHANGE_KINDS } from './infra-provider.js';
import { DESIRED_DIR, parseWithLines } from './infra-desired.js';
import { rateWords } from './infra-currency.js';
import { ENVIRONMENT_KINDS } from './infra-environments.js';

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */
/** @typedef {import('./infra-provider.js').Change} Change */
/** @typedef {import('./infra-plans.js').CostChange} CostChange */

/** Where the policy file is, on the default branch, beside the environments' files. */
export const POLICY_FILE = 'policy.json';
export const POLICY_PATH = `${DESIRED_DIR}/${POLICY_FILE}`;
export const POLICY_VERSION = 1;
export const POLICY_MAX_BYTES = 64 * 1024;
/** The most `allow` rules one policy holds, and the most names in any one list. */
export const POLICY_MAX_RULES = 50;
const LIST_MAX = 100;

/** The cost limit and budget a policy starts with (BRK-172), a month, in the board's currency (BRK-226). */
export const DEFAULT_COST_LIMIT = 5;
export const DEFAULT_BUDGET = 20;

/** The guards every policy keeps, in the order a plan lists them, and `every`: what waits when no rule lets it through. */
export const GUARDS = ['frozen', 'production', 'destructive', 'access', 'cost', 'budget'];
export const EVERY = 'every';

/** What a plan's policy result says it does next. */
export const OUTCOMES = ['refused', 'needs-owner', 'allowed'];

/**
 * The policy a repository without a policy file gets (BRK-171): no `allow` rule, so every plan waits for the owner.
 * @type {Policy}
 */
export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  costLimit: DEFAULT_COST_LIMIT,
  budget: DEFAULT_BUDGET,
  environments: {},
  access: { kinds: [], settings: [] },
  allow: [],
});

/**
 * @typedef {object} AllowRule
 * @property {string} name what the plan and the audit trail call it
 * @property {string[]} [environments] the environments it covers, by name; every one when left out
 * @property {string[]} [environmentKinds] the kinds of environment it covers (ENVIRONMENT_KINDS), like `short-lived`
 *   for the environments tasks ask for (BRK-200), whose names aren't known ahead; every kind when left out
 * @property {string[]} [changes] the change kinds it covers (CHANGE_KINDS); every one when left out
 * @property {string[]} [kinds] the resource kinds it covers; every one when left out
 * @property {number} [maxChanges] the most changes a plan it lets through has
 */

/**
 * One environment's rules (WEB-123): limits that replace the repository's, access kinds and settings added to the
 * repository's, and allow rules that replace the repository's for it when present.
 * @typedef {object} EnvironmentRules
 * @property {number} [costLimit]
 * @property {number} [budget]
 * @property {{ kinds: string[], settings: string[] }} [access]
 * @property {AllowRule[]} [allow]
 */

/**
 * @typedef {object} Policy
 * @property {number} version
 * @property {number} costLimit the most one plan may add to an environment's monthly cost before it waits
 * @property {number} budget what one environment may cost a month
 * @property {Record<string, EnvironmentRules>} environments one environment's rules by name, over the repository's
 * @property {{ kinds: string[], settings: string[] }} access resource kinds and settings that decide who or what can
 *   reach something, on top of the ones the provider declares
 * @property {AllowRule[]} allow
 */

const TOP = ['version', 'costLimit', 'budget', 'environments', 'access', 'allow'];
const LIMITS = ['costLimit', 'budget'];
const ACCESS = ['kinds', 'settings'];
const RULE = ['name', 'environments', 'environmentKinds', 'changes', 'kinds', 'maxChanges'];
/** An environment's own rule names no environments: it's already that environment's. */
const ENV_RULE = ['name', 'changes', 'kinds', 'maxChanges'];
const ENV_KEYS = [...LIMITS, 'access', 'allow'];
const ENV_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const KIND = /^[a-z][a-z0-9-]{0,39}$/u;
const SETTING = /^[A-Za-z_][\w.-]{0,79}$/u;
const RULE_NAME_MAX = 80;
const LIMIT_MAX = 1_000_000;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * What's wrong with a policy file: its line (1-based, or null when it's about the whole file), the field as a path
 * like `allow[1].changes`, and what to change.
 * @typedef {import('./infra-desired.js').DesiredError} PolicyError
 */

/**
 * Checks a policy file's text. The result is the policy, with what the file leaves out filled in from the default, or
 * the first thing wrong with it, with its line and field.
 * @param {string} source
 * @returns {{ ok: true, policy: Policy } | { ok: false, error: PolicyError }}
 */
export function checkPolicyFile(source) {
  /** @type {Map<string, number>} */
  let lines = new Map();
  /** @param {string | null} field @param {string} message @param {number | null} [at] */
  const wrong = (field, message, at) => ({
    ok: /** @type {const} */ (false),
    error: { line: at ?? (field === null ? null : (lines.get(field) ?? null)), field, message },
  });
  const raw = String(source ?? '');
  if (new TextEncoder().encode(raw).length > POLICY_MAX_BYTES)
    return wrong(null, `the file is over ${POLICY_MAX_BYTES / 1024} KB: trim it`);
  let file;
  try {
    ({ value: file, lines } = parseWithLines(raw));
  } catch (error) {
    if (error instanceof Error && 'line' in error)
      return wrong(null, `it isn’t JSON: ${error.message}`, Number(error.line));
    throw error;
  }
  const top = lines.get('') ?? 1;
  if (!isObject(file)) return wrong(null, 'the file is one JSON object: { "version": 1, "allow": [ … ] }', top);
  for (const key of Object.keys(file))
    if (!TOP.includes(key)) return wrong(key, `“${key}” isn’t part of a policy: it has ${TOP.join(', ')}`);
  if (file.version !== POLICY_VERSION)
    return wrong(
      file.version === undefined ? null : 'version',
      `version is ${POLICY_VERSION}: add "version": ${POLICY_VERSION}`,
      file.version === undefined ? top : undefined,
    );

  /** @param {unknown} value @param {string} field */
  const limit = (value, field) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= LIMIT_MAX
      ? null
      : wrong(field, `${field.split('.').pop()} is an amount a month, from 0 to ${LIMIT_MAX}, like 5`);
  for (const key of LIMITS)
    if (file[key] !== undefined) {
      const bad = limit(file[key], key);
      if (bad) return bad;
    }

  /** @param {unknown} value @param {string} field @param {RegExp} shape @param {string} what */
  const names = (value, field, shape, what) => {
    if (Array.isArray(value) && value.length === 0)
      return wrong(field, `${field.split('.').pop()} is empty: leave it out, or list ${what}`);
    if (!Array.isArray(value)) return wrong(field, `${field.split('.').pop()} is a list of ${what}`);
    if (value.length > LIST_MAX)
      return wrong(field, `${field.split('.').pop()} has ${value.length}: at most ${LIST_MAX}`);
    for (let n = 0; n < value.length; n += 1)
      if (typeof value[n] !== 'string' || !shape.test(value[n])) return wrong(`${field}[${n}]`, `each one is ${what}`);
    return null;
  };

  /**
   * An `access` object, at the top or for one environment.
   * @param {any} value @param {string} at
   */
  const accessOf = (value, at) => {
    const out = { kinds: /** @type {string[]} */ ([]), settings: /** @type {string[]} */ ([]) };
    if (!isObject(value))
      return {
        bad: wrong(at, 'access names more resource kinds and settings that decide who or what can reach something'),
      };
    for (const key of Object.keys(value))
      if (!ACCESS.includes(key))
        return { bad: wrong(`${at}.${key}`, `“${key}” isn’t part of access: it has kinds and settings`) };
    if (value.kinds !== undefined) {
      const bad = names(value.kinds, `${at}.kinds`, KIND, 'a resource kind, lowercase, like route');
      if (bad) return { bad };
      out.kinds = [...value.kinds];
    }
    if (value.settings !== undefined) {
      const bad = names(value.settings, `${at}.settings`, SETTING, 'a setting’s name, like public');
      if (bad) return { bad };
      out.settings = [...value.settings];
    }
    return { access: out };
  };

  /**
   * An `allow` list, at the top or for one environment, whose rules may not name environments.
   * @param {unknown} list @param {string} at @param {string[]} keys
   */
  const allowOf = (list, at, keys) => {
    /** @type {AllowRule[]} */
    const allow = [];
    if (!Array.isArray(list))
      return { bad: wrong(at, 'allow is a list of rules that let a kind of plan through: [ { "name": …, … } ]') };
    if (list.length > POLICY_MAX_RULES)
      return { bad: wrong(at, `allow has ${list.length} rules: at most ${POLICY_MAX_RULES}`) };
    const seen = new Map();
    for (let n = 0; n < list.length; n += 1) {
      const here = `${at}[${n}]`;
      const r = list[n];
      if (!isObject(r)) return { bad: wrong(here, 'each rule is an object with a name, and what it covers') };
      for (const key of Object.keys(r))
        if (!keys.includes(key))
          return {
            bad: wrong(
              `${here}.${key}`,
              RULE.includes(key)
                ? `“${key}” isn’t part of an environment’s own rule: it’s already that environment’s`
                : `“${key}” isn’t part of a rule: it has ${keys.join(', ')}`,
            ),
          };
      if (typeof r.name !== 'string' || r.name.trim() === '' || r.name.length > RULE_NAME_MAX)
        return {
          bad: wrong(
            r.name === undefined ? here : `${here}.name`,
            `name says what the rule lets through, up to ${RULE_NAME_MAX} characters, like small staging changes`,
          ),
        };
      const name = r.name.trim();
      if (seen.has(name))
        return { bad: wrong(`${here}.name`, `${name} is the name of ${at}[${seen.get(name)}] too: give each its own`) };
      seen.set(name, n);
      if (GUARDS.includes(name) || name === EVERY)
        return { bad: wrong(`${here}.name`, `${name} is the name of one of the board’s own rules: pick another`) };
      /** @type {AllowRule} */
      const rule = { name };
      if (r.environments !== undefined) {
        const bad = names(r.environments, `${here}.environments`, ENV_NAME, 'an environment’s name, like staging');
        if (bad) return { bad };
        rule.environments = [...r.environments];
      }
      if (r.environmentKinds !== undefined) {
        const bad = names(
          r.environmentKinds,
          `${here}.environmentKinds`,
          KIND,
          `a kind of environment: ${ENVIRONMENT_KINDS.join(', ')}`,
        );
        if (bad) return { bad };
        const unknown = r.environmentKinds.findIndex((k) => !ENVIRONMENT_KINDS.includes(k));
        if (unknown >= 0)
          return {
            bad: wrong(
              `${here}.environmentKinds[${unknown}]`,
              `${r.environmentKinds[unknown]} isn’t a kind of environment: ${ENVIRONMENT_KINDS.join(', ')}`,
            ),
          };
        rule.environmentKinds = [...r.environmentKinds];
      }
      if (r.changes !== undefined) {
        const bad = names(r.changes, `${here}.changes`, KIND, `a change kind: ${CHANGE_KINDS.join(', ')}`);
        if (bad) return { bad };
        const unknown = r.changes.findIndex((c) => !CHANGE_KINDS.includes(c));
        if (unknown >= 0)
          return {
            bad: wrong(
              `${here}.changes[${unknown}]`,
              `${r.changes[unknown]} isn’t a change kind: ${CHANGE_KINDS.join(', ')}`,
            ),
          };
        rule.changes = [...r.changes];
      }
      if (r.kinds !== undefined) {
        const bad = names(r.kinds, `${here}.kinds`, KIND, 'a resource kind, lowercase, like service');
        if (bad) return { bad };
        rule.kinds = [...r.kinds];
      }
      if (r.maxChanges !== undefined) {
        if (!Number.isInteger(r.maxChanges) || r.maxChanges < 1 || r.maxChanges > 1000)
          return { bad: wrong(`${here}.maxChanges`, 'maxChanges is a whole number from 1 to 1000') };
        rule.maxChanges = r.maxChanges;
      }
      allow.push(rule);
    }
    return { allow };
  };

  /** @type {Policy['environments']} */
  const environments = {};
  if (file.environments !== undefined) {
    if (!isObject(file.environments))
      return wrong(
        'environments',
        'environments is an object of rules by environment: { "production": { "budget": 200 } }',
      );
    for (const [name, rules] of Object.entries(file.environments)) {
      const at = `environments.${name}`;
      if (!ENV_NAME.test(name))
        return wrong(at, `${name} isn’t an environment’s name: lowercase letters, digits, and -, like staging`);
      if (!isObject(rules))
        return wrong(at, 'each environment has a costLimit, a budget, access, allow, or some of them');
      for (const key of Object.keys(rules))
        if (!ENV_KEYS.includes(key))
          return wrong(`${at}.${key}`, `“${key}” isn’t an environment’s rule: it has ${ENV_KEYS.join(', ')}`);
      /** @type {EnvironmentRules} */
      const own = {};
      for (const key of LIMITS)
        if (rules[key] !== undefined) {
          const bad = limit(rules[key], `${at}.${key}`);
          if (bad) return bad;
          own[key] = rules[key];
        }
      if (rules.access !== undefined) {
        const got = accessOf(rules.access, `${at}.access`);
        if (got.bad) return got.bad;
        own.access = got.access;
      }
      if (rules.allow !== undefined) {
        const got = allowOf(rules.allow, `${at}.allow`, ENV_RULE);
        if (got.bad) return got.bad;
        own.allow = got.allow;
      }
      environments[name] = own;
    }
  }

  let access = { kinds: /** @type {string[]} */ ([]), settings: /** @type {string[]} */ ([]) };
  if (file.access !== undefined) {
    const got = accessOf(file.access, 'access');
    if (got.bad) return got.bad;
    access = got.access;
  }

  /** @type {AllowRule[]} */
  let allow = [];
  if (file.allow !== undefined) {
    const got = allowOf(file.allow, 'allow', RULE);
    if (got.bad) return got.bad;
    allow = got.allow;
  }

  return {
    ok: true,
    policy: {
      version: POLICY_VERSION,
      costLimit: file.costLimit ?? DEFAULT_COST_LIMIT,
      budget: file.budget ?? DEFAULT_BUDGET,
      environments,
      access,
      allow,
    },
  };
}

/** The cost limit and budget for one environment under a policy. */
export function limitsFor(policy, environment) {
  const own = policy.environments?.[environment] ?? {};
  return { costLimit: own.costLimit ?? policy.costLimit, budget: own.budget ?? policy.budget };
}

/**
 * The allow rules that decide for one environment (WEB-123): its own when it has an `allow`, else the repository's.
 * @param {Policy} policy
 * @param {string} environment
 * @returns {{ allow: AllowRule[], level: 'environment' | 'repository' }}
 */
export function allowFor(policy, environment) {
  const own = policy.environments?.[environment]?.allow;
  return own ? { allow: own, level: 'environment' } : { allow: policy.allow ?? [], level: 'repository' };
}

/**
 * The access kinds and settings a policy names for one environment: the repository's, with the environment's added.
 * @param {Policy} policy
 * @param {string} environment
 */
export function accessFor(policy, environment) {
  const own = policy.environments?.[environment]?.access;
  const union = (a = [], b = []) => [...new Set([...a, ...b])];
  return {
    kinds: union(policy.access?.kinds, own?.kinds),
    settings: union(policy.access?.settings, own?.settings),
  };
}

/**
 * An amount in words, in the plan's currency when it has one: "$6", "€4.60".
 * @param {number} amount
 * @param {string | null} currency
 */
export function money(amount, currency) {
  const whole = Number.isInteger(amount);
  if (currency)
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // A currency Intl doesn't know is named after the amount.
    }
  return `${whole ? amount : amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

/**
 * Whether a change is about access or exposure: who or what can reach something. Its kind is one the provider marks
 * `access` or the policy names, or it changes a setting the provider lists in the kind's `accessSettings` or the policy
 * names.
 * @param {Change} change
 * @param {{ kinds: Set<string>, settings: Map<string, Set<string>>, anyKind: Set<string> }} access
 * @returns {string[] | null} the settings it changes that matter (none when the whole kind does), or null
 */
function accessChange(change, access) {
  if (access.kinds.has(change.kind)) return [];
  const watched = new Set([...(access.settings.get(change.kind) ?? []), ...access.anyKind]);
  if (watched.size === 0) return null;
  const before = change.before ?? {};
  const after = change.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => watched.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return keys.length ? keys : null;
}

/** The provider's access kinds and settings, with the policy's for the environment added. */
function accessOf(policy, provider, environment) {
  const named = accessFor(policy, environment);
  const kinds = new Set(named.kinds);
  /** @type {Map<string, Set<string>>} */
  const settings = new Map();
  for (const [kind, spec] of Object.entries(provider?.kinds ?? {})) {
    if (spec?.access) kinds.add(kind);
    if (Array.isArray(spec?.accessSettings)) settings.set(kind, new Set(spec.accessSettings));
  }
  return { kinds, settings, anyKind: new Set(named.settings) };
}

/** A change in a few words, for a reason: "deletes the `main` database". */
const verb = { create: 'adds', update: 'changes', delete: 'deletes', scale: 'scales', restart: 'restarts' };
const what = (c) => `${verb[c.op] ?? c.op} the \`${c.name}\` ${c.kind}`;
const andMore = (list) =>
  list.length > 2 ? `${list.slice(0, 2).join(', ')}, and ${list.length - 2} more` : list.join(' and ');

/** @param {string} s */
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One rule's result on a plan. `applies` is whether it caught the plan; `effect` is what it did about it: `refuse`,
 * `ask` (the plan waits for the owner), `allow`, or null when it didn't apply.
 * @typedef {{ rule: string, applies: boolean, effect: 'refuse' | 'ask' | 'allow' | null, reason: string }} RuleResult
 */

/**
 * @typedef {object} PolicyResult
 * @property {'default' | 'repository'} policy which policy decided: the default, or the repository's file
 * @property {string | null} sha the commit the repository's file was read at
 * @property {PolicyError | null} error what's wrong with the repository's file, when the default decided because of it
 * @property {string} outcome one of OUTCOMES
 * @property {string} rule the rule that decided: the first that refused, else the first that asked, else the allow rule
 * @property {string[]} reasons why, in words, one rule a line: what a plan page shows
 * @property {RuleResult[]} rules every guard, in GUARDS order, then `every` or the allow rule that let it through
 * @property {{ costLimit: number, budget: number, currency: string | null, rate: import('./infra-currency.js').Rate | null }} limits
 *   in the board's currency, with the rate the plan's cost was converted at (null when it wasn't)
 */

/**
 * Checks a plan against a policy: each guard in turn, then the policy's `allow` rules. The result is what the plan
 * keeps and shows. Pure: the caller gives the environment as it is now, and the plan's diff and cost change.
 * @param {Policy} policy
 * @param {object} plan
 * @param {{ name: string, kind?: string, frozen: boolean, gates: boolean }} plan.environment `gates` is production's
 *   gates (environmentView's `gates`: on for a production environment unless the owner turned them off); `kind` is
 *   what an allow rule's `environmentKinds` matches
 * @param {PlanDiff} plan.diff
 * @param {CostChange} plan.cost
 * @param {import('./infra-provider.js').Provider | null} [plan.provider] for the kinds and settings it marks as access
 * @param {string | null} [plan.currency] the board's currency, which the limits are in, for a plan with no cost change
 * @param {{ policy?: 'default' | 'repository', sha?: string | null, error?: PolicyError | null }} [from] which policy
 *   it is, and the repository file's error when the default stands in for a file that doesn't check
 * @returns {PolicyResult}
 */
export function evaluatePolicy(
  policy,
  { environment, diff, cost, provider = null, currency: board = null },
  from = {},
) {
  const { costLimit, budget } = limitsFor(policy, environment.name);
  const currency = cost?.currency ?? board;
  /** @type {import('./infra-currency.js').Rate | null} */
  const rate = /** @type {any} */ (cost)?.rate ?? null;
  const env = environment.name;
  /** @type {RuleResult[]} */
  const rules = [];
  const add = (rule, applies, effect, reason) => rules.push({ rule, applies, effect: applies ? effect : null, reason });

  add(
    'frozen',
    Boolean(environment.frozen),
    'refuse',
    environment.frozen
      ? `${upper(env)} is frozen: nothing changes there until the owner unfreezes it.`
      : `${upper(env)} isn’t frozen.`,
  );

  add(
    'production',
    Boolean(environment.gates),
    'ask',
    environment.gates ? 'Production needs you.' : `${upper(env)} has no production gates.`,
  );

  const destroys = diff.changes.filter((c) => c.op === 'delete' || !c.reversible);
  const undo = destroys.map((c) => (c.op === 'delete' ? what(c) : `${what(c)}${c.why ? ` (${c.why})` : ''}`));
  add(
    'destructive',
    destroys.length > 0,
    'ask',
    destroys.length ? `Can’t be undone: it ${andMore(undo)}.` : 'Every change can be undone, and nothing is deleted.',
  );

  const access = accessOf(policy, provider, env);
  const reaching = diff.changes.map((c) => ({ c, keys: accessChange(c, access) })).filter((x) => x.keys !== null);
  add(
    'access',
    reaching.length > 0,
    'ask',
    reaching.length
      ? `Changes who or what can reach it: it ${andMore(reaching.map(({ c, keys }) => (keys.length ? `${what(c)}’s ${keys.join(', ')}` : what(c))))}.`
      : 'Changes nothing about who or what can reach it.',
  );

  const delta = cost?.delta ?? null;
  const unknownCost = !cost?.complete && diff.changes.some((c) => c.op !== 'delete' && c.op !== 'restart');
  let costReason;
  let overLimit = false;
  if (delta !== null && delta > costLimit) {
    overLimit = true;
    costReason = `Adds ${money(delta, currency)} a month, over your ${money(costLimit, currency)} limit.`;
  } else if (unknownCost) {
    overLimit = true;
    costReason = `Its cost change isn’t known${cost?.unknown?.length ? ` for ${cost.unknown.length} of its changes` : ''}, so it can’t be checked against your ${money(costLimit, currency)} limit.`;
  } else if (delta !== null && delta > 0)
    costReason = `Adds ${money(delta, currency)} a month, inside your ${money(costLimit, currency)} limit.`;
  else
    costReason =
      delta !== null && delta < 0 ? `Saves ${money(-delta, currency)} a month.` : 'Adds nothing to the monthly cost.';
  if (rate) costReason += ` ${upper(rateWords(rate))}.`;
  add('cost', overLimit, 'ask', costReason);

  const after = cost?.after ?? null;
  const overBudget = after !== null && after > budget && (delta ?? 0) > 0;
  add(
    'budget',
    overBudget,
    'ask',
    overBudget
      ? `Takes ${env} to ${money(after, currency)} a month, over its ${money(budget, currency)} budget.`
      : after !== null
        ? `Keeps ${env} at ${money(after, currency)} a month, inside its ${money(budget, currency)} budget.`
        : `${upper(env)}’s cost isn’t known yet, so its ${money(budget, currency)} budget can’t be checked.`,
  );

  const refused = rules.find((r) => r.effect === 'refuse');
  const asked = rules.filter((r) => r.effect === 'ask');
  let outcome;
  let rule;
  if (refused) {
    outcome = 'refused';
    rule = refused.rule;
  } else if (asked.length) {
    outcome = 'needs-owner';
    rule = asked[0].rule;
  } else {
    const { allow, level } = allowFor(policy, env);
    const allowed = allow.find((a) => allows(a, env, diff, environment.kind));
    if (allowed) {
      outcome = 'allowed';
      rule = allowed.name;
      add(
        allowed.name,
        true,
        'allow',
        level === 'environment'
          ? `Allowed by ${env}’s own rule “${allowed.name}” in your policy.`
          : `Allowed by your policy’s rule “${allowed.name}”.`,
      );
    } else {
      outcome = 'needs-owner';
      rule = EVERY;
      add(
        EVERY,
        true,
        'ask',
        allow.length
          ? 'No rule in your policy lets it through, so it needs you.'
          : level === 'environment'
            ? `Every plan in ${env} needs you: your policy lets nothing through there.`
            : 'Every plan needs you: the default policy lets nothing through.',
      );
    }
  }
  const reasons = rules.filter((r) => r.applies).map((r) => r.reason);
  if (from.error)
    reasons.push(
      `${POLICY_PATH} has an error${from.error.line ? ` on line ${from.error.line}` : ''}, so the default policy decides until it’s fixed: ${from.error.message}`,
    );
  return {
    policy: from.policy ?? 'default',
    sha: from.sha ?? null,
    error: from.error ?? null,
    outcome,
    rule,
    reasons,
    rules,
    limits: { costLimit, budget, currency, rate },
  };
}

/**
 * Whether an allow rule covers every change in a plan for an environment.
 * @param {AllowRule} rule
 * @param {string} environment
 * @param {PlanDiff} diff
 * @param {string} [kind] the environment's kind, for a rule with `environmentKinds`
 */
export function allows(rule, environment, diff, kind) {
  if (rule.environments && !rule.environments.includes(environment)) return false;
  if (rule.environmentKinds && !rule.environmentKinds.includes(String(kind))) return false;
  if (rule.maxChanges !== undefined && diff.changes.length > rule.maxChanges) return false;
  return diff.changes.every(
    (c) => (!rule.changes || rule.changes.includes(c.op)) && (!rule.kinds || rule.kinds.includes(c.kind)),
  );
}
