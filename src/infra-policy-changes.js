/**
 * Policy changes from the board (WEB-123, docs/specs/WEB-123-policy-manager.md): the rules a repository's plans are
 * checked against (infra-policy.js), in words, and what a change to them loosens or tightens. Pure and Node-safe: the
 * store (store-infra-policy-changes.js) reads the files and writes the pull request.
 *
 * A change loosens the policy when it lets a plan through that the policy before it would have kept waiting for the
 * owner: a cost limit or budget raised, a kind or setting no longer counted as access, or an allow rule that covers a
 * plan no rule before it covered. It tightens when it does the opposite. One change can do both. Loosening is never one
 * press: the owner confirms the exact lines `comparePolicies` names, and the board won't approve it while a plan it
 * would let through is waiting.
 */
import { accessFor, allowFor, checkPolicyFile, limitsFor, money, POLICY_PATH, POLICY_VERSION } from './infra-policy.js';

/** @typedef {import('./infra-policy.js').Policy} Policy */
/** @typedef {import('./infra-policy.js').AllowRule} AllowRule */

/** The policy change's branch: the board's own, beside an environment's (infra-changes.js's changeBranch). */
export const policyBranch = (n) => `breakaway/infra/policy-${n}`;

/** The line a policy change's pull request ends with. */
export const POLICY_PROPOSED_LINE =
  'Proposed on the board’s Policy view. Approving it on the board merges it. A policy change applies nothing and approves no plan: plans made after it merges are checked against it.';

/** What a change does to a policy, each line one thing. */
export const EFFECTS = ['loosens', 'tightens'];

const OP_WORDS = { create: 'add', update: 'change', delete: 'delete', scale: 'scale', restart: 'restart' };

/** @param {string} s */
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** @param {string[]} list */
const andList = (list) =>
  list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
/** @param {string[]} list */
const orList = (list) =>
  list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;

/**
 * The text the board writes for a policy: its own keys in the file's order, two spaces, a newline at the end. What a
 * policy leaves at the default is left out where it's empty, so a small policy stays a small file.
 * @param {Policy} policy
 */
export function policyText(policy) {
  /** @type {Record<string, any>} */
  const out = { version: POLICY_VERSION, costLimit: policy.costLimit, budget: policy.budget };
  const environments = Object.entries(policy.environments ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, own]) => {
      /** @type {Record<string, any>} */
      const rules = {};
      if (own.costLimit !== undefined) rules.costLimit = own.costLimit;
      if (own.budget !== undefined) rules.budget = own.budget;
      if (own.access && (own.access.kinds?.length || own.access.settings?.length))
        rules.access = accessText(own.access);
      if (own.allow) rules.allow = own.allow.map(ruleText);
      return [name, rules];
    })
    .filter(([, rules]) => Object.keys(rules).length);
  if (environments.length) out.environments = Object.fromEntries(environments);
  if (policy.access?.kinds?.length || policy.access?.settings?.length) out.access = accessText(policy.access);
  if (policy.allow?.length) out.allow = policy.allow.map(ruleText);
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * A policy as the Policy view sends it to propose (WEB-128): what `policyText` writes, without its version. Empty access
 * lists, an empty access, and an environment with no rules of its own are left out, so the form never sends what
 * `checkPolicyEdit` refuses.
 * @param {Policy} policy
 * @returns {Record<string, any>}
 */
export function policyEdit(policy) {
  const { version: _version, ...rest } = JSON.parse(policyText(policy));
  return rest;
}

/** @param {{ kinds?: string[], settings?: string[] }} access */
function accessText(access) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (access.kinds?.length) out.kinds = [...access.kinds];
  if (access.settings?.length) out.settings = [...access.settings];
  return out;
}

/** @param {AllowRule} rule */
function ruleText(rule) {
  /** @type {Record<string, any>} */
  const out = { name: rule.name };
  for (const key of ['environments', 'environmentKinds', 'changes', 'kinds']) if (rule[key]) out[key] = [...rule[key]];
  if (rule.maxChanges !== undefined) out.maxChanges = rule.maxChanges;
  return out;
}

/**
 * Checks a policy the board was sent as an object, the way the file is checked once it's committed.
 * @param {unknown} value
 * @returns {{ ok: true, policy: Policy, text: string } | { ok: false, error: import('./infra-policy.js').PolicyError }}
 */
export function checkPolicyEdit(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: { line: null, field: null, message: 'send the policy as one object' } };
  const checked = checkPolicyFile(JSON.stringify({ version: POLICY_VERSION, ...value }));
  if ('error' in checked) return { ok: false, error: { ...checked.error, line: null } };
  return { ok: true, policy: checked.policy, text: policyText(checked.policy) };
}

/**
 * What an allow rule lets through, in words: "plans that only scale or restart a service, up to 3 changes".
 * @param {AllowRule} rule
 * @param {{ scoped?: boolean }} [options] `scoped` leaves out the environments it names, when a line names them
 */
export function ruleWords(rule, { scoped = false } = {}) {
  const ops = rule.changes ? orList(rule.changes.map((c) => OP_WORDS[c] ?? c)) : null;
  const kinds = rule.kinds ? orList(rule.kinds.map((k) => `a ${k}`)) : null;
  let what;
  if (ops && kinds) what = `plans that only ${ops} ${kinds}`;
  else if (ops) what = `plans that only ${ops} resources`;
  else if (kinds) what = `plans that only touch ${kinds}`;
  else what = 'any plan';
  if (rule.maxChanges !== undefined) what += `, up to ${rule.maxChanges} change${rule.maxChanges === 1 ? '' : 's'}`;
  if (!scoped && rule.environments) what += `, in ${andList(rule.environments)}`;
  if (!scoped && rule.environmentKinds) what += `, in ${orList(rule.environmentKinds)} environments`;
  return what;
}

/**
 * @typedef {object} Scope
 * @property {string | null} name an environment's name, or null for every other environment
 * @property {string | null} kind its kind, when the board knows it
 */

/**
 * Every place a policy can say something different: each environment the board knows or either policy names, then
 * every other environment.
 * @param {Policy[]} policies
 * @param {Array<{ name: string, kind?: string | null }>} environments
 * @returns {Scope[]}
 */
function scopesOf(policies, environments) {
  /** @type {Map<string, string | null>} */
  const named = new Map(environments.map((e) => [e.name, e.kind ?? null]));
  for (const p of policies) {
    for (const name of Object.keys(p.environments ?? {})) if (!named.has(name)) named.set(name, null);
    for (const rule of p.allow ?? [])
      for (const name of rule.environments ?? []) if (!named.has(name)) named.set(name, null);
  }
  return [
    ...[...named].sort(([a], [b]) => a.localeCompare(b)).map(([name, kind]) => ({ name, kind })),
    { name: null, kind: null },
  ];
}

/**
 * A rule as the sets it covers, for one scope: the environments it names are settled by the scope, and so is the kind
 * when the board knows it.
 * @param {AllowRule} rule
 * @param {Scope} scope
 */
function shapeOf(rule, scope) {
  return {
    rule,
    changes: rule.changes ? new Set(rule.changes) : null,
    kinds: rule.kinds ? new Set(rule.kinds) : null,
    environmentKinds: scope.kind === null && rule.environmentKinds ? new Set(rule.environmentKinds) : null,
    max: rule.maxChanges ?? Number.POSITIVE_INFINITY,
  };
}

/** Whether a set covers another: null is everything. */
const covers = (outer, inner) => outer === null || (inner !== null && [...inner].every((x) => outer.has(x)));

/** Whether one rule lets through every plan another does. */
const within = (inner, outer) =>
  covers(outer.changes, inner.changes) &&
  covers(outer.kinds, inner.kinds) &&
  covers(outer.environmentKinds, inner.environmentKinds) &&
  inner.max <= outer.max;

/**
 * The allow rules that decide in one scope, as shapes: an environment's own, or the repository's that cover it.
 * @param {Policy} policy
 * @param {Scope} scope
 */
function rulesIn(policy, scope) {
  if (scope.name === null) return policy.allow.filter((r) => !r.environments).map((r) => shapeOf(r, scope));
  const { allow, level } = allowFor(policy, scope.name);
  return allow
    .filter(
      (r) =>
        level === 'environment' ||
        ((!r.environments || r.environments.includes(scope.name ?? '')) &&
          (!r.environmentKinds || scope.kind === null || r.environmentKinds.includes(scope.kind))),
    )
    .map((r) => shapeOf(r, scope));
}

/**
 * @typedef {object} PolicyLine
 * @property {'loosens' | 'tightens'} effect
 * @property {string} line what changes, in words, with where
 * @property {string[]} environments the environments it's about by name; empty for every environment
 */

/**
 * What a change from `before` to `after` does, one thing a line, each marked loosens or tightens. The same thing in
 * several environments is one line naming them all. `loosens` is the lines the owner confirms before a loosening change
 * is approved: what will no longer wait for them.
 * @param {Policy} before
 * @param {Policy} after
 * @param {{ environments?: Array<{ name: string, kind?: string | null }>, currency?: string | null }} [options]
 * @returns {{ lines: PolicyLine[], loosens: string[], tightens: string[] }}
 */
export function comparePolicies(before, after, { environments = [], currency = null } = {}) {
  const scopes = scopesOf([before, after], environments);
  /** @type {Map<string, { effect: 'loosens' | 'tightens', words: string, scopes: Scope[], order: number }>} */
  const found = new Map();
  const note = (effect, words, scope) => {
    const key = `${effect}\n${words}`;
    const had = found.get(key);
    if (had) had.scopes.push(scope);
    else found.set(key, { effect, words, scopes: [scope], order: found.size });
  };

  for (const scope of scopes) {
    const name = scope.name ?? '';
    const was = scope.name === null ? before : { ...before, ...limitsFor(before, name) };
    const now = scope.name === null ? after : { ...after, ...limitsFor(after, name) };
    if (now.costLimit > was.costLimit)
      note(
        'loosens',
        `a plan can add up to ${money(now.costLimit, currency)} a month before it waits for you (it was ${money(was.costLimit, currency)})`,
        scope,
      );
    else if (now.costLimit < was.costLimit)
      note(
        'tightens',
        `a plan that adds more than ${money(now.costLimit, currency)} a month waits for you (it was ${money(was.costLimit, currency)})`,
        scope,
      );
    if (now.budget > was.budget)
      note(
        'loosens',
        `the budget is ${money(now.budget, currency)} a month, so a plan waits for you only past that (it was ${money(was.budget, currency)})`,
        scope,
      );
    else if (now.budget < was.budget)
      note(
        'tightens',
        `the budget is ${money(now.budget, currency)} a month: a plan past it waits for you (it was ${money(was.budget, currency)})`,
        scope,
      );

    const accessWas = scope.name === null ? before.access : accessFor(before, name);
    const accessNow = scope.name === null ? after.access : accessFor(after, name);
    for (const kind of accessWas.kinds.filter((k) => !accessNow.kinds.includes(k)))
      note('loosens', `a change to a ${kind} no longer counts as an access change by itself`, scope);
    for (const kind of accessNow.kinds.filter((k) => !accessWas.kinds.includes(k)))
      note('tightens', `a change to a ${kind} counts as an access change, so it waits for you`, scope);
    for (const setting of accessWas.settings.filter((k) => !accessNow.settings.includes(k)))
      note('loosens', `changing ${setting} no longer counts as an access change by itself`, scope);
    for (const setting of accessNow.settings.filter((k) => !accessWas.settings.includes(k)))
      note('tightens', `changing ${setting} counts as an access change, so it waits for you`, scope);

    const rulesWas = rulesIn(before, scope);
    const rulesNow = rulesIn(after, scope);
    for (const r of rulesNow)
      if (!rulesWas.some((w) => within(r, w)))
        note('loosens', `${ruleWords(r.rule, { scoped: true })} no longer wait for you (“${r.rule.name}”)`, scope);
    for (const r of rulesWas)
      if (!rulesNow.some((w) => within(r, w)))
        note(
          'tightens',
          `${ruleWords(r.rule, { scoped: true })} wait for you again (“${r.rule.name}” is gone or narrower)`,
          scope,
        );
  }

  const every = scopes.length;
  const lines = [...found.values()]
    .sort((a, b) => (a.effect === b.effect ? a.order - b.order : a.effect === 'loosens' ? -1 : 1))
    .map(({ effect, words, scopes: at }) => {
      const names = at.filter((s) => s.name !== null).map((s) => /** @type {string} */ (s.name));
      const others = at.some((s) => s.name === null);
      const where =
        at.length === every
          ? 'In every environment'
          : others
            ? `In every environment but ${andList(scopes.filter((s) => s.name !== null && !names.includes(s.name)).map((s) => /** @type {string} */ (s.name)))}`
            : `In ${andList(names)}`;
      return {
        effect: /** @type {'loosens' | 'tightens'} */ (effect),
        line: `${where}: ${words}.`,
        environments: at.length === every || others ? [] : names,
      };
    });
  return {
    lines,
    loosens: lines.filter((l) => l.effect === 'loosens').map((l) => l.line),
    tightens: lines.filter((l) => l.effect === 'tightens').map((l) => l.line),
  };
}

/**
 * One environment's rules, as the Policy view lists them: where each comes from (`environment` for its own, else the
 * repository's file, or `default` when the board's default decides), and what it does, in words.
 * @param {Policy} policy
 * @param {{ name: string, kind?: string | null, gates?: boolean, frozen?: boolean }} environment
 * @param {{ from?: 'default' | 'repository', currency?: string | null }} [options]
 * @returns {Array<{ rule: string, level: 'environment' | 'repository' | 'default' | 'board', words: string }>}
 */
export function environmentRules(policy, environment, { from = 'repository', currency = null } = {}) {
  const repo = from === 'default' ? 'default' : 'repository';
  const own = policy.environments?.[environment.name] ?? {};
  const name = environment.name;
  const { costLimit, budget } = limitsFor(policy, name);
  /** @type {Array<{ rule: string, level: 'environment' | 'repository' | 'default' | 'board', words: string }>} */
  const out = [];
  out.push({
    rule: 'frozen',
    level: 'board',
    words: environment.frozen
      ? `${upper(name)} is frozen: every plan is refused until you unfreeze it.`
      : `Freezing ${name} refuses every plan there, envelopes included, until you unfreeze it.`,
  });
  out.push({
    rule: 'production',
    level: 'board',
    words: environment.gates
      ? 'Every plan here waits for you: production needs you.'
      : `${upper(name)} has no production gates.`,
  });
  out.push({
    rule: 'destructive',
    level: 'board',
    words: 'A plan that deletes something, or can’t be undone, waits for you.',
  });
  const access = accessFor(policy, name);
  const named = [...access.kinds.map((k) => `a ${k}`), ...access.settings];
  out.push({
    rule: 'access',
    level: own.access ? 'environment' : repo,
    words: `A plan that changes who or what can reach something waits for you${named.length ? `, including ${andList(named)}` : ''}.`,
  });
  out.push({
    rule: 'cost',
    level: own.costLimit !== undefined ? 'environment' : repo,
    words: `A plan that adds more than ${money(costLimit, currency)} a month, or whose cost isn’t known, waits for you.`,
  });
  out.push({
    rule: 'budget',
    level: own.budget !== undefined ? 'environment' : repo,
    words: `A plan that takes ${name} past ${money(budget, currency)} a month waits for you.`,
  });
  const { allow, level } = allowFor(policy, name);
  const covering = allow.filter(
    (r) =>
      level === 'environment' ||
      ((!r.environments || r.environments.includes(name)) &&
        (!r.environmentKinds || !environment.kind || r.environmentKinds.includes(environment.kind))),
  );
  const at = level === 'environment' ? 'environment' : repo;
  for (const r of covering)
    out.push({
      rule: r.name,
      level: at,
      words: `${upper(ruleWords(r, { scoped: true }))} pass without you, when nothing above catches them (“${r.name}”).`,
    });
  out.push({
    rule: 'every',
    level: at,
    words: covering.length
      ? 'Any other plan waits for you.'
      : level === 'environment'
        ? `Every plan in ${name} waits for you: its own rules let nothing through.`
        : 'Every plan waits for you: no rule lets one through.',
  });
  return out;
}

/** The pull request's title for a policy change. */
export function policyChangeTitle({ loosens, tightens }) {
  if (loosens.length && tightens.length) return 'Change the infrastructure policy';
  if (loosens.length) return 'Loosen the infrastructure policy';
  if (tightens.length) return 'Tighten the infrastructure policy';
  return 'Rewrite the infrastructure policy';
}

/**
 * The pull request's description: what the change loosens and tightens, in words, and that merging applies nothing.
 * @param {{ lines: PolicyLine[], created?: boolean, page?: string | null }} args `created` when the repository has no
 *   policy file yet
 */
export function policyChangeBody({ lines, created = false, page = null }) {
  const out = [
    created
      ? `Adds \`${POLICY_PATH}\`, the rules this repository’s plans are checked against. Until now the board’s default decided: every plan waits for you.`
      : `Changes \`${POLICY_PATH}\`, the rules this repository’s plans are checked against.`,
    '',
  ];
  const loosens = lines.filter((l) => l.effect === 'loosens');
  const tightens = lines.filter((l) => l.effect === 'tightens');
  if (loosens.length) {
    out.push('**Loosens your policy.** These will no longer wait for you:', '');
    for (const l of loosens) out.push(`- ${l.line}`);
    out.push('');
  }
  if (tightens.length) {
    out.push('**Tightens it:**', '');
    for (const l of tightens) out.push(`- ${l.line}`);
    out.push('');
  }
  if (!lines.length) out.push('It changes how the file is written, not what waits for you.', '');
  out.push('---', POLICY_PROPOSED_LINE);
  if (page) out.push('', `[See it on the board](${page})`);
  return out.join('\n');
}

/** The commit message for a policy change. */
export function policyCommitMessage({ lines, loosens, tightens }) {
  const title = policyChangeTitle({ loosens, tightens });
  return lines.length ? `${title}\n\n${lines.map((l) => `- ${l.line}`).join('\n')}\n` : title;
}
