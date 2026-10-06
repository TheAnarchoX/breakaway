/**
 * Architect's providers (docs/specs/IDEA-19-architect.md, "Providers"): one adapter per platform behind one interface,
 * so the core never names a vendor. A provider discovers what exists, plans desired against actual, applies one plan
 * (only inside the apply runner), observes health, estimates cost, and reports events as signals. Adapters call their
 * platform's API directly, with no infrastructure-as-code tool or state file (BRK-169).
 *
 * This module holds the shapes they exchange, the checks every provider's answers pass (the contract test in
 * test/infra-provider-contract.js runs them against each provider), and the registry the store reads. Pure: no vendor
 * code and no network.
 */

/** What a change does to a resource. `scale` and `restart` only where a provider declares them per kind (BRK-186). */
export const CHANGE_KINDS = ['create', 'update', 'delete', 'scale', 'restart'];
/** The change kinds every resource kind has. */
export const BASE_CHANGES = ['create', 'update', 'delete'];
/** The change kinds a provider may add per resource kind, for envelopes. */
export const ENVELOPE_CHANGES = ['scale', 'restart'];
/** A resource's health, from `observe`. */
export const HEALTH_STATES = ['healthy', 'degraded', 'down', 'unknown'];
/** What a signal is about: health, the platform's alerts, and cost (BRK-172: no metrics, logs, or traces yet). */
export const SIGNAL_KINDS = ['health', 'alert', 'cost'];
/** How loud a signal is. */
export const SIGNAL_LEVELS = ['info', 'warning', 'critical'];

const ID = /^[a-z][a-z0-9-]{0,39}$/u;
/** A signal's short text, at most this long. */
export const SIGNAL_TEXT_MAX = 500;

/**
 * Something that exists on a platform. `id` is the provider's own stable ID for it, unique within the provider.
 * @typedef {object} Resource
 * @property {string} id
 * @property {string} kind a kind the provider declares, like `service` or `database`
 * @property {string} name what the platform calls it
 * @property {Record<string, unknown>} [attrs] its settings, compared by `plan`; never a secret's value
 */

/**
 * One resource leaning on another: this service `uses` that database, `binds` that secret by name, `serves` that route.
 * Both ends are resource IDs in the same discovery.
 * @typedef {object} Relation
 * @property {string} from
 * @property {string} to
 * @property {string} kind
 */

/**
 * What `discover` found in one environment's scope (BRK-169: nothing outside it).
 * @typedef {object} Discovery
 * @property {Resource[]} resources
 * @property {Relation[]} relations
 */

/**
 * What should exist in one environment, from its desired-state file (BRK-180).
 * @typedef {object} DesiredState
 * @property {Resource[]} resources
 */

/**
 * One step of a plan.
 * @typedef {object} Change
 * @property {string} op one of CHANGE_KINDS
 * @property {string} resource the resource's ID
 * @property {string} kind the resource's kind
 * @property {string} name the resource's name
 * @property {Record<string, unknown> | null} before its settings now, null when it's created
 * @property {Record<string, unknown> | null} after its settings once applied, null when it's deleted
 * @property {boolean} reversible whether applying the reverse change undoes it
 * @property {string} [why] why it can't be undone, when it can't
 */

/**
 * The exact difference an apply would make, as a provider sees it (BRK-178 adds cost, blast radius, and policy).
 * @typedef {object} PlanDiff
 * @property {string} provider the provider's ID
 * @property {string} environment the environment it was planned for
 * @property {Change[]} changes in the order they're applied
 * @property {boolean} reversible every change can be undone
 */

/**
 * What one apply did, step by step. A failed step stops it; the steps after it aren't tried.
 * @typedef {object} ApplyResult
 * @property {boolean} ok
 * @property {Array<{ resource: string, op: string, ok: boolean, error?: string }>} steps
 */

/**
 * A resource's health from `observe`.
 * @typedef {object} Health
 * @property {string} resource
 * @property {string} state one of HEALTH_STATES
 * @property {string} at when it was seen, ISO 8601
 * @property {string} [text] what's wrong, in a few words
 */

/**
 * A resource's cost from `cost`, always an estimate, per month, in the provider's currency until BRK-226.
 * @typedef {object} Cost
 * @property {string} resource
 * @property {number} amount
 * @property {string} currency ISO 4217, like USD
 * @property {true} estimate
 */

/**
 * One signal from `events` (BRK-190 redacts and stores them).
 * @typedef {object} Signal
 * @property {string} source the provider's ID
 * @property {string} environment
 * @property {string | null} resource the resource's ID, or null for the whole environment
 * @property {string} kind one of SIGNAL_KINDS
 * @property {string} level one of SIGNAL_LEVELS
 * @property {number | null} value
 * @property {string} at ISO 8601
 * @property {string} text short, at most SIGNAL_TEXT_MAX characters
 */

/**
 * What every call gets: the environment it works on and its scope on the platform, and the token for this call.
 * Discover, observe, cost, and events get the board's read-only token (BRK-171); apply gets the runner's write token,
 * which only the apply runner holds. `observeOnly` environments (the board's own install, BRK-169) refuse apply.
 * @typedef {object} ProviderContext
 * @property {string} environment
 * @property {Record<string, unknown>} [scope] which of the platform's resources belong to the environment
 * @property {boolean} [observeOnly]
 * @property {string} [token]
 * @property {typeof fetch} [fetch] the fetch to call the platform with; tests pass a mock
 */

/**
 * A resource kind a provider knows, and which change kinds it can make to it.
 * @typedef {object} KindSpec
 * @property {string[]} changes BASE_CHANGES, plus any of ENVELOPE_CHANGES it supports
 */

/**
 * A provider: one platform's adapter.
 * @typedef {object} Provider
 * @property {string} id short and lowercase, like `fake`
 * @property {string} name what people see
 * @property {Record<string, KindSpec>} kinds the resource kinds it discovers and plans
 * @property {(ctx: ProviderContext) => Promise<Discovery>} discover
 * @property {(ctx: ProviderContext, desired: DesiredState) => Promise<PlanDiff>} plan
 * @property {(ctx: ProviderContext, plan: PlanDiff) => Promise<ApplyResult>} apply
 * @property {(ctx: ProviderContext) => Promise<Health[]>} observe
 * @property {(ctx: ProviderContext) => Promise<Cost[]>} cost
 * @property {(ctx: ProviderContext, since: string) => Promise<Signal[]>} events
 */

const METHODS = ['discover', 'plan', 'apply', 'observe', 'cost', 'events'];

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** @param {string} what @param {string} problem */
function fail(what, problem) {
  throw new Error(`${what}: ${problem}`);
}

/**
 * Checks a provider's shape, or throws saying what's wrong.
 * @param {Provider} provider
 * @returns {Provider}
 */
export function checkProvider(provider) {
  if (!isObject(provider)) fail('provider', 'not an object');
  const what = `provider ${provider.id ?? '(no id)'}`;
  if (typeof provider.id !== 'string' || !ID.test(provider.id))
    fail(what, 'id must be lowercase letters, digits, and dashes, starting with a letter');
  if (!text(provider.name)) fail(what, 'no name');
  for (const m of METHODS) if (typeof provider[m] !== 'function') fail(what, `no ${m}()`);
  if (!isObject(provider.kinds) || Object.keys(provider.kinds).length === 0) fail(what, 'declares no resource kinds');
  for (const [kind, spec] of Object.entries(provider.kinds)) {
    if (!ID.test(kind)) fail(what, `resource kind "${kind}" isn't lowercase letters, digits, and dashes`);
    if (!Array.isArray(spec?.changes)) fail(what, `${kind} lists no changes`);
    for (const c of BASE_CHANGES) if (!spec.changes.includes(c)) fail(what, `${kind} can't ${c}`);
    for (const c of spec.changes) if (!CHANGE_KINDS.includes(c)) fail(what, `${kind} has unknown change "${c}"`);
  }
  return provider;
}

/**
 * Whether `provider` can make change `op` to resources of `kind`: envelopes ask before they scale or restart.
 * @param {Provider} provider
 * @param {string} kind
 * @param {string} op
 */
export function declares(provider, kind, op) {
  return provider.kinds[kind]?.changes.includes(op) ?? false;
}

/**
 * Checks a list of resources (discovered or desired): IDs unique, kinds the provider declares.
 * @param {Provider} provider
 * @param {Resource[]} resources
 * @param {string} what
 */
function checkResources(provider, resources, what) {
  if (!Array.isArray(resources)) fail(what, 'resources is not a list');
  const ids = new Set();
  for (const r of resources) {
    if (!isObject(r) || !text(r.id)) fail(what, 'a resource has no id');
    if (ids.has(r.id)) fail(what, `resource ${r.id} is listed twice`);
    ids.add(r.id);
    if (!provider.kinds[r.kind])
      fail(what, `resource ${r.id} has kind "${r.kind}", which ${provider.id} doesn't declare`);
    if (!text(r.name)) fail(what, `resource ${r.id} has no name`);
    if (r.attrs !== undefined && !isObject(r.attrs)) fail(what, `resource ${r.id}'s attrs isn't an object`);
  }
  return ids;
}

/**
 * Checks what `discover` returned, or throws saying what's wrong.
 * @param {Provider} provider
 * @param {Discovery} discovery
 * @returns {Discovery}
 */
export function checkDiscovery(provider, discovery) {
  const what = `${provider.id} discover`;
  if (!isObject(discovery)) fail(what, 'not an object');
  const ids = checkResources(provider, discovery.resources, what);
  if (!Array.isArray(discovery.relations)) fail(what, 'relations is not a list');
  for (const rel of discovery.relations) {
    if (!isObject(rel) || !text(rel.kind)) fail(what, 'a relation has no kind');
    for (const end of [rel.from, rel.to])
      if (!ids.has(end))
        fail(what, `relation ${rel.from} ${rel.kind} ${rel.to} names ${end}, which it didn't discover`);
  }
  return discovery;
}

/**
 * Checks a desired state against the provider's kinds, or throws saying what's wrong.
 * @param {Provider} provider
 * @param {DesiredState} desired
 * @returns {DesiredState}
 */
export function checkDesired(provider, desired) {
  const what = `${provider.id} desired state`;
  if (!isObject(desired)) fail(what, 'not an object');
  checkResources(provider, desired.resources, what);
  return desired;
}

/**
 * Checks what `plan` returned, or throws saying what's wrong: every change is one its resource's kind declares, an
 * irreversible change says why, and the plan's `reversible` agrees with its changes.
 * @param {Provider} provider
 * @param {PlanDiff} plan
 * @param {ProviderContext} [ctx] when given, the plan must be for its environment
 * @returns {PlanDiff}
 */
export function checkPlan(provider, plan, ctx) {
  const what = `${provider.id} plan`;
  if (!isObject(plan)) fail(what, 'not an object');
  if (plan.provider !== provider.id) fail(what, `made by ${plan.provider}, not ${provider.id}`);
  if (!text(plan.environment)) fail(what, 'names no environment');
  if (ctx && plan.environment !== ctx.environment) fail(what, `is for ${plan.environment}, not ${ctx.environment}`);
  if (!Array.isArray(plan.changes)) fail(what, 'changes is not a list');
  for (const c of plan.changes) {
    if (!isObject(c) || !text(c.resource)) fail(what, 'a change names no resource');
    if (!CHANGE_KINDS.includes(c.op)) fail(what, `${c.resource} has unknown change "${c.op}"`);
    if (!declares(provider, c.kind, c.op)) fail(what, `${c.kind} ${c.resource} can't ${c.op}`);
    if (!text(c.name)) fail(what, `${c.resource} has no name`);
    if (c.op === 'create' ? c.before !== null : !isObject(c.before))
      fail(what, `${c.op} ${c.resource} has the wrong before`);
    if (c.op === 'delete' ? c.after !== null : !isObject(c.after))
      fail(what, `${c.op} ${c.resource} has the wrong after`);
    if (typeof c.reversible !== 'boolean') fail(what, `${c.resource} doesn't say whether it can be undone`);
    if (!c.reversible && !text(c.why)) fail(what, `${c.resource} can't be undone and doesn't say why`);
  }
  if (plan.reversible !== plan.changes.every((c) => c.reversible)) fail(what, "reversible doesn't match its changes");
  return plan;
}

/**
 * Whether `plan` may be applied in `ctx`, or throws saying why not. Every provider's `apply` calls it first, so a plan
 * for another provider or environment, or one for an observe-only environment, never reaches a platform.
 * @param {Provider} provider
 * @param {ProviderContext} ctx
 * @param {PlanDiff} plan
 */
export function checkApply(provider, ctx, plan) {
  if (ctx?.observeOnly) fail(`${provider.id} apply`, `${ctx.environment} is observe only`);
  checkPlan(provider, plan, ctx);
}

/**
 * Checks what `apply` returned, or throws saying what's wrong: one step per change tried, in order, and `ok` only when
 * every change was applied.
 * @param {Provider} provider
 * @param {PlanDiff} plan
 * @param {ApplyResult} result
 * @returns {ApplyResult}
 */
export function checkApplyResult(provider, plan, result) {
  const what = `${provider.id} apply`;
  if (!isObject(result) || !Array.isArray(result.steps)) fail(what, 'returned no steps');
  if (result.steps.length > plan.changes.length) fail(what, 'returned more steps than the plan has changes');
  result.steps.forEach((s, i) => {
    const c = plan.changes[i];
    if (s.resource !== c.resource || s.op !== c.op) fail(what, `step ${i + 1} isn't the plan's change ${i + 1}`);
    if (typeof s.ok !== 'boolean') fail(what, `step ${i + 1} doesn't say whether it worked`);
    if (!s.ok && !text(s.error)) fail(what, `step ${i + 1} failed without saying why`);
    if (!s.ok && i !== result.steps.length - 1) fail(what, `step ${i + 1} failed but later steps ran`);
  });
  const all = result.steps.length === plan.changes.length && result.steps.every((s) => s.ok);
  if (result.ok !== all) fail(what, "ok doesn't match its steps");
  return result;
}

/**
 * Checks what `observe` returned, or throws saying what's wrong.
 * @param {Provider} provider
 * @param {Health[]} health
 * @returns {Health[]}
 */
export function checkHealth(provider, health) {
  const what = `${provider.id} observe`;
  if (!Array.isArray(health)) fail(what, 'not a list');
  for (const h of health) {
    if (!isObject(h) || !text(h.resource)) fail(what, 'a health entry names no resource');
    if (!HEALTH_STATES.includes(h.state)) fail(what, `${h.resource} has unknown state "${h.state}"`);
    if (!isTime(h.at)) fail(what, `${h.resource} has no time`);
  }
  return health;
}

/**
 * Checks what `cost` returned, or throws saying what's wrong. Every amount is an estimate.
 * @param {Provider} provider
 * @param {Cost[]} costs
 * @returns {Cost[]}
 */
export function checkCosts(provider, costs) {
  const what = `${provider.id} cost`;
  if (!Array.isArray(costs)) fail(what, 'not a list');
  for (const c of costs) {
    if (!isObject(c) || !text(c.resource)) fail(what, 'a cost names no resource');
    if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount < 0)
      fail(what, `${c.resource} has no amount`);
    if (typeof c.currency !== 'string' || !/^[A-Z]{3}$/u.test(c.currency)) fail(what, `${c.resource} has no currency`);
    if (c.estimate !== true) fail(what, `${c.resource} isn't marked as an estimate`);
  }
  return costs;
}

/**
 * Checks what `events` returned, or throws saying what's wrong: signals from this provider and environment, at or after
 * `since`, oldest first.
 * @param {Provider} provider
 * @param {ProviderContext} ctx
 * @param {string} since
 * @param {Signal[]} signals
 * @returns {Signal[]}
 */
export function checkSignals(provider, ctx, since, signals) {
  const what = `${provider.id} events`;
  if (!Array.isArray(signals)) fail(what, 'not a list');
  let last = Date.parse(since);
  for (const s of signals) {
    if (!isObject(s)) fail(what, 'a signal is not an object');
    if (s.source !== provider.id) fail(what, `a signal is from ${s.source}, not ${provider.id}`);
    if (s.environment !== ctx.environment) fail(what, `a signal is for ${s.environment}, not ${ctx.environment}`);
    if (s.resource !== null && !text(s.resource)) fail(what, 'a signal has a resource that is neither an id nor null');
    if (!SIGNAL_KINDS.includes(s.kind)) fail(what, `a signal has unknown kind "${s.kind}"`);
    if (!SIGNAL_LEVELS.includes(s.level)) fail(what, `a signal has unknown level "${s.level}"`);
    if (s.value !== null && (typeof s.value !== 'number' || !Number.isFinite(s.value)))
      fail(what, 'a signal has a value that is neither a number nor null');
    if (!isTime(s.at)) fail(what, 'a signal has no time');
    if (Date.parse(s.at) < last) fail(what, `a signal at ${s.at} is before ${since} or out of order`);
    last = Date.parse(s.at);
    if (!text(s.text) || s.text.length > SIGNAL_TEXT_MAX)
      fail(what, `a signal's text is empty or longer than ${SIGNAL_TEXT_MAX}`);
  }
  return signals;
}

/**
 * The desired state that matches a discovery exactly: planning it against the same platform changes nothing.
 * @param {Discovery} discovery
 * @returns {DesiredState}
 */
export function desiredFrom(discovery) {
  return {
    resources: discovery.resources.map(({ id, kind, name, attrs }) => ({
      id,
      kind,
      name,
      ...(attrs ? { attrs: structuredClone(attrs) } : {}),
    })),
  };
}

/**
 * A registry of providers: the connected ones, by ID. The store reads one to find the provider an environment names.
 */
export class ProviderRegistry {
  /** @type {Map<string, Provider>} */
  #providers = new Map();

  /**
   * Adds a provider, checked; refuses a second one with the same ID.
   * @param {Provider} provider
   */
  register(provider) {
    checkProvider(provider);
    if (this.#providers.has(provider.id)) throw new Error(`provider ${provider.id} is already registered`);
    this.#providers.set(provider.id, provider);
    return provider;
  }

  /** @param {string} id */
  has(id) {
    return this.#providers.has(id);
  }

  /**
   * The provider with this ID, or throws naming the ones there are.
   * @param {string} id
   * @returns {Provider}
   */
  get(id) {
    const p = this.#providers.get(id);
    if (!p) {
      const known = [...this.#providers.keys()].sort().join(', ') || 'none';
      throw new Error(`no provider ${id} (registered: ${known})`);
    }
    return p;
  }

  /** The registered providers, by ID. */
  list() {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** The Worker's registry. Real providers register here as they're built (BRK-189 onwards); none yet. */
export const providers = new ProviderRegistry();
