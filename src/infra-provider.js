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
/**
 * A resource's health, from `observe`. `idle` is deployed and reachable with no traffic and no errors seen (BRK-266):
 * it counts as healthy, never as unknown. `unknown` is only for what the provider couldn't read, and its text says
 * which call and what to do.
 */
export const HEALTH_STATES = ['healthy', 'idle', 'degraded', 'down', 'unknown'];
/** What a signal is about: health, the platform's alerts, and cost (BRK-172: no metrics, logs, or traces yet). */
export const SIGNAL_KINDS = ['health', 'alert', 'cost'];
/** How loud a signal is. */
export const SIGNAL_LEVELS = ['info', 'warning', 'critical'];

const ID = /^[a-z][a-z0-9-]{0,39}$/u;
/** A signal's short text, at most this long. */
export const SIGNAL_TEXT_MAX = 500;
/** A cost's note, at most this long. */
export const COST_NOTE_MAX = 500;

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
 * @property {string[]} [missing] permissions the token lacks for a kind the provider skipped instead of failing, by
 *   name, for the provider's Connections row
 * @property {string[]} [skipped] what the token couldn't read and discovery went on without, in words, as a quiet note
 *   on the Connections row (a zone whose routes it can't read)
 */

/**
 * What should exist in one environment, from its desired-state file (BRK-180).
 * @typedef {object} DesiredState
 * @property {Resource[]} resources
 * @property {{ url: string }} [health] the owner's health URL, checked on each refresh (BRK-266); providers ignore it
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
 * A resource's cost from `cost`, always an estimate, per month, in the provider's currency (the board converts it, BRK-226).
 * @typedef {object} Cost
 * @property {string} resource
 * @property {number} amount
 * @property {string} currency ISO 4217, like USD
 * @property {true} estimate
 * @property {string} [note] what the estimate leaves out, in a sentence or two (at most COST_NOTE_MAX characters), like
 *   usage the platform includes across the whole account rather than per resource
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
 * @property {boolean} [account] true for an alert about the provider's account or platform as a whole, not this
 *   environment (BRK-255): its resource is null, and the board keeps one per provider, not one per environment
 */

/**
 * What every call gets: the environment it works on and its scope on the platform, and the token for this call.
 * Discover, observe, cost, and events get the board's read-only token (BRK-171); apply gets the runner's write token,
 * which only the apply runner holds. `observeOnly` environments (the board's own install, BRK-169) refuse apply.
 * @typedef {object} ProviderContext
 * @property {string} environment
 * @property {Record<string, unknown>} [scope] which of the platform's resources belong to the environment: its
 *   `target`, and for a plan or an act the install's own Worker (`board`) and the other environments' targets
 *   (`others`), which are never its to change (BRK-251)
 * @property {boolean} [observeOnly]
 * @property {string} [token]
 * @property {string} [writeToken] the environment's write token: only the apply runner sets it (CLI-12, from its
 *   GitHub environment), so an apply that reaches a provider anywhere else stops before it calls the platform
 * @property {typeof fetch} [fetch] the fetch to call the platform with; tests pass a mock
 * @property {Resource[]} [resources] what `discover` just found in the environment's scope: the store passes it to
 *   `observe` and `cost` so they needn't discover again
 * @property {Resource[]} [elsewhere] what `discover` just found in the provider's other environments: `events` keeps an
 *   alert on a zone or hostname none of them, nor this one, uses as account-wide instead of leaving it out (BRK-256)
 * @property {Set<string>} [reached] the store's collector: the provider adds a permission's name when a call answers
 *   with it, so Connections puts back one an earlier refusal struck (BRK-254)
 */

/**
 * A resource kind a provider knows, and which change kinds it can make to it.
 * @typedef {object} KindSpec
 * @property {string[]} changes BASE_CHANGES, plus any of ENVELOPE_CHANGES it supports
 * @property {boolean} [access] the kind decides who or what can reach something (a route, a domain): policy asks the
 *   owner for any change to one (BRK-181)
 * @property {string[]} [accessSettings] settings of the kind that decide who or what can reach it (like `public`): policy
 *   asks the owner for a change to one
 * @property {string[]} [settings] the settings a desired state sets for the kind; the rest of a resource's attrs are what
 *   the platform reports by itself (versions, sizes, deploys), which a draft of the desired state leaves out (BRK-240).
 *   Without it, every attr is a setting.
 * @property {string} [scales] the whole-number setting a `scale` changes (like `instances`): required when the kind
 *   declares `scale`, so an envelope (BRK-186) knows what its bounds are bounds of
 * @property {boolean} [target] one of the kind can be an environment's target, what discovery starts from (a Worker):
 *   a change that adds one to an environment with no target gives it that target (BRK-291)
 */

/**
 * One permission a read-only token needs, by the name the platform's token page gives it, and what the board reads
 * with it. Never a token's value.
 * @typedef {object} TokenPermission
 * @property {string} name like `Workers Metadata Read-Only`
 * @property {string} for what the board reads with it, in a few words
 * @property {string[]} [legacy] older names for the same access (like `Workers Scripts Read`): a token made with one of
 *   them still counts as having it, and the board names them in parentheses
 */

/**
 * What a provider's own check of a read-only token found (BRK-194): whether the platform took it and, when the
 * platform says, every permission it carries, so the board can refuse one that can change things.
 * @typedef {object} TokenCheck
 * @property {boolean} ok
 * @property {Array<{ name: string, level: 'read' | 'write' }>} [permissions]
 * @property {string} [error] what the platform said, when it refused the token
 */

/**
 * The read-only token the board holds for a provider (BRK-171): the owner makes it with exactly `permissions` and
 * pastes it on Connections (BRK-194). Discover, observe, cost, and events get it; apply never does.
 * @typedef {object} ReadToken
 * @property {TokenPermission[]} permissions
 * @property {string} url where the owner makes one, on the platform
 * @property {(ctx: { token: string, fetch?: typeof fetch }) => Promise<TokenCheck>} [check] asks the platform about
 *   a pasted token before the board keeps it
 */

/**
 * A provider: one platform's adapter.
 * @typedef {object} Provider
 * @property {string} id short and lowercase, like `fake`
 * @property {string} name what people see
 * @property {Record<string, KindSpec>} kinds the resource kinds it discovers and plans
 * @property {(resource: Resource, op: string) => string | null} [refuses] why the platform can't make an envelope's
 *   `scale` or `restart` to this one resource although its kind declares it (a setting of the resource rules it out),
 *   in words, or null when it can; an act asks it before it plans (BRK-227)
 * @property {(ctx: ProviderContext, found: Discovery, resource: Resource) => string | null} [outside] why the
 *   resource, though `discover` found it, isn't the environment's to change (it's only reached through the install's
 *   Worker, `scope.board`, or another environment's target, `scope.others`), in words, or null when it is; an act asks
 *   it before it plans (BRK-251)
 * @property {ReadToken} [readToken] the read-only token it needs, if any
 * @property {(ctx: ProviderContext) => Promise<Discovery>} discover
 * @property {(ctx: ProviderContext, desired: DesiredState) => Promise<PlanDiff>} plan
 * @property {(ctx: ProviderContext, plan: PlanDiff) => Promise<ApplyResult>} apply
 * @property {(ctx: ProviderContext) => Promise<Health[]>} observe
 * @property {(ctx: ProviderContext) => Promise<Cost[]>} cost
 * @property {(ctx: ProviderContext, since: string) => Promise<Signal[]>} events
 * @property {(ctx: ProviderContext, change: Change) => Promise<Cost | null>} [estimate] what a resource would cost a
 *   month once `change` is applied, or null when the provider can't say; a plan's cost change uses it (BRK-178)
 * @property {(kind: string) => Editable | null} [editable] the settings the console may change on resources of `kind`,
 *   or null for a kind it changes nothing on; checked by `checkEditable` (BRK-262)
 * @property {(kind: string) => Creatable | null} [creatable] whether the console may add a resource of `kind`, its
 *   name's rule, and what a new one is given, or null for a kind it can't add; checked by `checkCreatable` (BRK-270)
 * @property {(ctx: ProviderContext, options: { board: string[] }) => Promise<AlertSetup>} [alerts] reads which of the
 *   platform's alerts are set up and which reach the board (`board` is its https origins), for a provider whose
 *   platform sends alerts to the board
 */

/** The kinds of field the console draws for a setting it may change (BRK-262). */
export const EDITABLE_TYPES = ['text', 'number', 'yesno', 'choice', 'names', 'resource', 'bindings', 'rules'];

/** A path into a resource's attrs: names joined by dots, with no `attrs.` prefix (like `observability` or `allowed.origins`). */
const PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;

/**
 * One setting the console may change (BRK-262): where it is, what kind of field it is, and a line of help. The console
 * draws its fields from these and never names a vendor.
 * @typedef {object} EditableField
 * @property {string} path where it is in the resource's attrs, as PATH; its first name is one of the kind's `settings`
 *   (what the plan compares), when the kind lists them. Inside a `rules` field's `fields`, the path is inside one rule.
 * @property {string} label what the field is called, in a few words
 * @property {string} type one of EDITABLE_TYPES: `text`; `number`; `yesno`; `choice` (one of `options`); `names` (a list
 *   of strings, like flags or schedules); `resource` (another resource of the environment, by its name: one of `kinds`);
 *   `bindings` (a list of named bindings, each to a resource of the environment, as `targets` says); `rules` (a list of
 *   objects, each with the `fields` the console offers: it keeps every other key of a rule as it is, and starts a new one
 *   from `template`)
 * @property {string} help one line, in plain words
 * @property {boolean} [optional] whether it can be left unset (null: the platform decides)
 * @property {number} [min] a number's least value
 * @property {number} [max] a number's greatest value
 * @property {boolean} [integer] a number must be whole
 * @property {string} [unit] what a number counts, like `seconds`
 * @property {string} [pattern] a text's, or each name's, regular expression (without slashes)
 * @property {Array<{ value: string, label: string }>} [options] a choice's options
 * @property {string[]} [kinds] the kinds a `resource` may name
 * @property {BindingTarget[]} [targets] the binding types a `bindings` field changes: a binding of any other type (a
 *   variable, a secret) is shown by its name and type, and kept as it is
 * @property {Record<string, string>} [typeLabels] a `bindings` field's words for binding types its `targets` don't
 *   list (a Durable Object, static assets), so a change reads '+ CHAT (Durable Object)' (WEB-110)
 * @property {EditableField[]} [fields] a `rules` field's fields, inside one rule
 * @property {Record<string, unknown>} [template] what a new rule starts from
 */

/**
 * One type of binding a `bindings` field changes, and how it names its resource: a binding is `{ name, type, [field]: … }`,
 * the field the provider's plan compares with what runs (BRK-285), holding the resource's ID on the platform (`by:
 * 'id'`, its inventory ID after `<kind>:`) or its name (`by: 'name'`). One the plan still makes has no platform ID yet,
 * so a `by: 'id'` binding names it by its ID in the desired state, as `{ name, type, resource }`.
 * @typedef {object} BindingTarget
 * @property {string} type the binding's type, as the platform calls it
 * @property {string} label what people call it
 * @property {string} kind the kind of resource it binds
 * @property {string} field the binding's key that names the resource
 * @property {'id' | 'name'} by
 */

/**
 * A setting the console shows by name and never changes, like a Worker's secrets.
 * @typedef {object} ShownSetting
 * @property {string} path
 * @property {string} label
 * @property {string} help why it's read only, and where it's set instead
 */

/**
 * What the console may change on resources of one kind (BRK-262), from the provider's `editable(kind)`.
 * @typedef {object} Editable
 * @property {EditableField[]} fields
 * @property {{ label: string, help: string, pattern?: string }} [name] the resource's name, when the plan compares it
 *   (a kind the platform names by what it does, like a route's pattern)
 * @property {ShownSetting[]} [shown] settings shown by name, read only
 */

/**
 * A resource kind the console may add (BRK-270), from the provider's `creatable(kind)`. A new one is the kind's
 * editable fields (BRK-262) and `fields`, with `defaults` filled in and `required` given; a `create` edit
 * (src/infra-changes.js) checks them, and the plan says what it makes.
 * @typedef {object} Creatable
 * @property {string} label what one is called, like `Queue`
 * @property {string} help one line on what it's for, in plain words
 * @property {{ label: string, help: string, pattern?: string, max?: number }} name its name's rule: a regular
 *   expression and a length, and help saying them. A name is unique among the kind in the environment's file and what
 *   runs there; the plan checks the rest of the platform's account.
 * @property {EditableField[]} [fields] what only a new one is given (like a route's zone), beyond its editable fields:
 *   the plan reads them when it makes it, and never compares them
 * @property {string[]} [required] the paths, of `fields` or the editable fields, a new one must be given
 * @property {Record<string, unknown>} [defaults] what a new one starts with, by path
 * @property {{ kind: string, list: string, target: BindingTarget, required?: boolean }} [bind] how a resource of another
 *   kind (`kind`, like a Worker) binds a new one: a binding in its `list` setting, as `target` says; `required` when the
 *   plan makes one only if something binds it, so a `create` edit must bind it. None for a kind nothing binds.
 * @property {string} [needsCode] what code must exist before the plan can make one (a class, an image), in words: the
 *   console adds it to the file, and the plan waits until the code's deploy has made it
 */

/**
 * A kind the console may add, as the board answers it (BRK-270): one list of fields, the kind's editable ones after
 * its own, each marked `required` or carrying its `default`.
 * @typedef {object} CreatableKind
 * @property {string} label
 * @property {string} help
 * @property {{ label: string, help: string, pattern?: string, max?: number }} name
 * @property {Array<EditableField & { required?: boolean, default?: unknown }>} fields
 * @property {{ kind: string, list: string, target: BindingTarget, required?: boolean }} [bind]
 * @property {string} [needsCode]
 */

/**
 * Which of a platform's alerts are set up, and which reach the board: each alert type with how many policies use it
 * and whether one sends to the board, each policy (on or off, the routines on the board it fires), and how many
 * webhooks point at the board. Names only: never an address or a destination's URL.
 * @typedef {object} AlertSetup
 * @property {Array<{ type: string, name: string, product: string, policies: number, reachesBoard: boolean }>} alerts
 * @property {Array<{ name: string, alertType: string, enabled: boolean, reachesBoard: boolean, routines: string[] }>} policies
 * @property {{ toBoard: number, other: number }} webhooks
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
    if (spec.access !== undefined && typeof spec.access !== 'boolean')
      fail(what, `${kind}'s access is not true or false`);
    if (spec.accessSettings !== undefined && (!Array.isArray(spec.accessSettings) || !spec.accessSettings.every(text)))
      fail(what, `${kind}'s accessSettings is not a list of settings' names`);
    if (spec.settings !== undefined && (!Array.isArray(spec.settings) || !spec.settings.every(text)))
      fail(what, `${kind}'s settings is not a list of settings' names`);
    if (spec.changes.includes('scale') ? !text(spec.scales) : spec.scales !== undefined)
      fail(what, `${kind}'s scales names the setting a scale changes, and only a kind that scales has one`);
    if (spec.target !== undefined && typeof spec.target !== 'boolean')
      fail(what, `${kind}'s target is not true or false`);
  }
  if (provider.readToken !== undefined) checkReadToken(what, provider.readToken);
  if (provider.refuses !== undefined && typeof provider.refuses !== 'function') fail(what, 'refuses is not a function');
  if (provider.outside !== undefined && typeof provider.outside !== 'function') fail(what, 'outside is not a function');
  if (provider.estimate !== undefined && typeof provider.estimate !== 'function')
    fail(what, 'estimate is not a function');
  if (provider.editable !== undefined) {
    if (typeof provider.editable !== 'function') fail(what, 'editable is not a function');
    for (const kind of Object.keys(provider.kinds)) checkEditable(provider, kind, provider.editable(kind));
  }
  if (provider.creatable !== undefined) {
    if (typeof provider.creatable !== 'function') fail(what, 'creatable is not a function');
    for (const kind of Object.keys(provider.kinds)) checkCreatable(provider, kind, provider.creatable(kind));
  }
  return provider;
}

/**
 * Checks what a provider's `editable(kind)` returned, or throws saying what's wrong: every field has a path, a label, a
 * type, and help; its path is one the plan compares (its first name is one of the kind's `settings`, when the kind lists
 * them); nothing is editable twice or both editable and shown; and each type carries what the console needs to draw it.
 * @param {Provider} provider
 * @param {string} kind
 * @param {Editable | null} editable
 * @returns {Editable | null}
 */
export function checkEditable(provider, kind, editable) {
  const what = `${provider.id} editable ${kind}`;
  if (editable === null) return null;
  if (!provider.kinds[kind]) fail(what, `${provider.id} doesn't declare ${kind}`);
  if (!isObject(editable) || !Array.isArray(editable.fields)) fail(what, 'fields is not a list');
  const settings = provider.kinds[kind].settings;
  const paths = checkFields(provider, what, editable.fields, settings);
  if (editable.name !== undefined) {
    if (!isObject(editable.name) || !text(editable.name.label) || !text(editable.name.help))
      fail(what, 'name has no label or no help');
    if (editable.name.pattern !== undefined) checkPattern(what, 'name', editable.name.pattern);
  }
  if (editable.shown !== undefined) {
    if (!Array.isArray(editable.shown)) fail(what, 'shown is not a list');
    for (const s of editable.shown) {
      if (!isObject(s) || !text(s.path) || !PATH.test(s.path)) fail(what, 'a shown setting has no path');
      if (!text(s.label) || !text(s.help)) fail(what, `shown ${s.path} has no label or no help`);
      if (paths.has(s.path)) fail(what, `${s.path} is both editable and shown`);
    }
  }
  return editable;
}

/**
 * @param {Provider} provider
 * @param {string} what
 * @param {any} fields
 * @param {string[] | undefined} settings the names a top-level path may start with; undefined inside a rule
 */
function checkFields(provider, what, fields, settings) {
  if (!Array.isArray(fields)) fail(what, 'fields is not a list');
  const paths = new Set();
  for (const f of fields) {
    if (!isObject(f) || !text(f.path) || !PATH.test(f.path))
      fail(what, 'a field has no path, or one that isn’t names joined by dots');
    const at = `${what} ${f.path}`;
    if (paths.has(f.path)) fail(at, 'is listed twice');
    paths.add(f.path);
    if (settings && !settings.includes(f.path.split('.')[0])) fail(at, "isn't a setting the plan compares");
    if (!text(f.label) || !text(f.help)) fail(at, 'has no label or no help');
    if (!EDITABLE_TYPES.includes(f.type)) fail(at, `has unknown type "${f.type}"`);
    if (f.optional !== undefined && typeof f.optional !== 'boolean') fail(at, 'optional is not true or false');
    if (f.pattern !== undefined) {
      if (f.type !== 'text' && f.type !== 'names') fail(at, 'only text and names take a pattern');
      checkPattern(at, 'pattern', f.pattern);
    }
    for (const k of ['min', 'max'])
      if (f[k] !== undefined && (f.type !== 'number' || typeof f[k] !== 'number' || !Number.isFinite(f[k])))
        fail(at, `${k} is not a number, or the field isn't one`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) fail(at, 'min is more than max');
    if (f.integer !== undefined && (f.type !== 'number' || typeof f.integer !== 'boolean'))
      fail(at, 'integer is not true or false, or the field isn’t a number');
    if (f.unit !== undefined && (f.type !== 'number' || !text(f.unit))) fail(at, 'only a number has a unit');
    if (f.type === 'choice') {
      if (!Array.isArray(f.options) || f.options.length === 0) fail(at, 'a choice has no options');
      const values = new Set();
      for (const o of f.options) {
        if (!isObject(o) || !text(o.value) || !text(o.label)) fail(at, 'an option has no value or no label');
        if (values.has(o.value)) fail(at, `option ${o.value} is listed twice`);
        values.add(o.value);
      }
    } else if (f.options !== undefined) fail(at, 'only a choice has options');
    if (f.type === 'resource') {
      if (!Array.isArray(f.kinds) || f.kinds.length === 0) fail(at, 'a resource field names no kinds');
      for (const k of f.kinds)
        if (!provider.kinds[k]) fail(at, `names kind ${k}, which ${provider.id} doesn't declare`);
    } else if (f.kinds !== undefined) fail(at, 'only a resource field has kinds');
    if (f.type === 'bindings') {
      if (!Array.isArray(f.targets) || f.targets.length === 0) fail(at, 'a bindings field has no targets');
      const types = new Set();
      for (const t of f.targets) {
        if (!isObject(t) || !text(t.type) || !text(t.label) || !text(t.field))
          fail(at, 'a target has no type, label, or field');
        if (types.has(t.type)) fail(at, `binding type ${t.type} is listed twice`);
        types.add(t.type);
        if (!provider.kinds[t.kind]) fail(at, `binds kind ${t.kind}, which ${provider.id} doesn't declare`);
        if (t.by !== 'id' && t.by !== 'name') fail(at, `${t.type} names its resource by neither id nor name`);
      }
    } else if (f.targets !== undefined) fail(at, 'only a bindings field has targets');
    if (f.type === 'rules') {
      if (!Array.isArray(f.fields) || f.fields.length === 0) fail(at, 'a rules field has no fields');
      checkFields(provider, at, f.fields, undefined);
      if (f.template !== undefined && !isObject(f.template)) fail(at, 'template is not an object');
    } else if (f.fields !== undefined || f.template !== undefined) fail(at, 'only a rules field has fields');
  }
  return paths;
}

/** @param {string} what @param {string} key @param {unknown} pattern */
function checkPattern(what, key, pattern) {
  if (!text(pattern)) fail(what, `${key} is empty`);
  try {
    new RegExp(/** @type {string} */ (pattern), 'u');
  } catch {
    fail(what, `${key} isn't a regular expression`);
  }
}

/**
 * What the console may change on each of a provider's kinds (BRK-262): only the kinds it changes something on, checked.
 * A provider without `editable` changes nothing from the console.
 * @param {Provider} provider
 * @returns {Record<string, Editable>}
 */
export function editableKinds(provider) {
  if (typeof provider.editable !== 'function') return {};
  /** @type {Record<string, Editable>} */
  const out = {};
  for (const kind of Object.keys(provider.kinds)) {
    const e = checkEditable(provider, kind, provider.editable(kind));
    if (e && (e.fields.length || e.name || e.shown?.length)) out[kind] = e;
  }
  return out;
}

/**
 * What's wrong with a value for one of the console's fields (BRK-262's types), in words, or null when it fits. A
 * `resource` field's value is a name: whether the environment has it is the caller's to check.
 * @param {EditableField} field
 * @param {unknown} value
 * @returns {string | null}
 */
export function fieldProblem(field, value) {
  const label = field.label;
  const fits = (pattern, v) => !pattern || new RegExp(pattern, 'u').test(v);
  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} is a number`;
      if (field.integer && !Number.isInteger(value)) return `${label} is a whole number`;
      const unit = field.unit ? ` ${field.unit}` : '';
      if (field.min !== undefined && value < field.min) return `${label} is at least ${field.min}${unit}`;
      if (field.max !== undefined && value > field.max) return `${label} is at most ${field.max}${unit}`;
      return null;
    }
    case 'yesno':
      return typeof value === 'boolean' ? null : `${label} is yes or no (true or false)`;
    case 'choice':
      return field.options?.some((o) => o.value === value)
        ? null
        : `${label} is one of ${(field.options ?? []).map((o) => o.value).join(', ')}`;
    case 'text':
    case 'resource':
      if (typeof value !== 'string' || !value.trim()) return `${label} is text`;
      return fits(field.pattern, value) ? null : `${value} doesn’t fit ${label}: ${field.help}`;
    case 'names':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return `${label} is a list of names`;
      for (const v of value) if (!fits(field.pattern, v)) return `${v} doesn’t fit ${label}: ${field.help}`;
      return null;
    default:
      return Array.isArray(value) ? null : `${label} is a list`;
  }
}

/**
 * Checks what a provider's `creatable(kind)` returned, or throws saying what's wrong: a label, help, and a name's rule;
 * its own fields are well formed and none is also editable; what's required or defaulted is one of the fields; each
 * default fits its field; and a binding names a kind the provider declares, binding this one.
 * @param {Provider} provider
 * @param {string} kind
 * @param {Creatable | null} creatable
 * @returns {Creatable | null}
 */
export function checkCreatable(provider, kind, creatable) {
  const what = `${provider.id} creatable ${kind}`;
  if (creatable === null) return null;
  if (!provider.kinds[kind]) fail(what, `${provider.id} doesn't declare ${kind}`);
  if (!isObject(creatable) || !text(creatable.label) || !text(creatable.help)) fail(what, 'has no label or no help');
  const name = creatable.name;
  if (!isObject(name) || !text(name.label) || !text(name.help)) fail(what, 'name has no label or no help');
  if (name.pattern !== undefined) checkPattern(what, 'name', name.pattern);
  if (name.max !== undefined && (!Number.isInteger(name.max) || name.max < 1))
    fail(what, 'name’s max is not a whole number of characters');
  const own = creatable.fields ?? [];
  checkFields(provider, what, own, undefined);
  const editable = typeof provider.editable === 'function' ? (provider.editable(kind)?.fields ?? []) : [];
  for (const f of own) if (editable.some((e) => e.path === f.path)) fail(`${what} ${f.path}`, 'is editable already');
  const byPath = new Map([...own, ...editable].map((f) => [f.path, f]));
  if (creatable.required !== undefined) {
    if (!Array.isArray(creatable.required)) fail(what, 'required is not a list');
    for (const p of creatable.required) if (!byPath.has(p)) fail(what, `requires ${p}, which isn't one of its fields`);
  }
  if (creatable.defaults !== undefined) {
    if (!isObject(creatable.defaults)) fail(what, 'defaults is not an object');
    for (const [p, v] of Object.entries(creatable.defaults)) {
      const f = byPath.get(p);
      if (!f) fail(what, `has a default for ${p}, which isn't one of its fields`);
      const problem = fieldProblem(/** @type {EditableField} */ (f), v);
      if (problem) fail(`${what} default ${p}`, problem);
    }
  }
  if (creatable.bind !== undefined) {
    const b = creatable.bind;
    if (!isObject(b) || !provider.kinds[b.kind]) fail(what, 'bind names no kind the provider declares');
    if (!text(b.list) || !PATH.test(b.list)) fail(what, 'bind names no list');
    const t = b.target;
    if (!isObject(t) || !text(t.type) || !text(t.label) || !text(t.field))
      fail(what, 'bind’s target has no type, label, or field');
    if (t.kind !== kind) fail(what, `bind’s target binds ${t.kind}, not ${kind}`);
    if (t.by !== 'id' && t.by !== 'name') fail(what, 'bind’s target names its resource by neither id nor name');
    if (b.required !== undefined && typeof b.required !== 'boolean') fail(what, 'bind’s required is not true or false');
  }
  if (creatable.needsCode !== undefined && !text(creatable.needsCode)) fail(what, 'needsCode is empty');
  return creatable;
}

/**
 * The kinds one of which can be an environment's target (BRK-291): the provider's kinds marked `target`.
 * @param {Provider} provider
 * @returns {string[]}
 */
export const targetKinds = (provider) =>
  Object.entries(provider.kinds)
    .filter(([, spec]) => spec.target === true)
    .map(([kind]) => kind);

/**
 * The kinds the console may add (BRK-270), checked, each with one list of fields: its own, then its editable ones,
 * marked `required` or carrying their `default`. A provider without `creatable` adds nothing from the console.
 * @param {Provider} provider
 * @returns {Record<string, CreatableKind>}
 */
export function creatableKinds(provider) {
  if (typeof provider.creatable !== 'function') return {};
  /** @type {Record<string, CreatableKind>} */
  const out = {};
  for (const kind of Object.keys(provider.kinds)) {
    const c = checkCreatable(provider, kind, provider.creatable(kind));
    if (!c) continue;
    const editable = typeof provider.editable === 'function' ? (provider.editable(kind)?.fields ?? []) : [];
    const fields = [...(c.fields ?? []), ...editable].map((f) => ({
      ...f,
      ...(c.required?.includes(f.path) ? { required: true } : {}),
      ...(c.defaults && Object.hasOwn(c.defaults, f.path) ? { default: structuredClone(c.defaults[f.path]) } : {}),
    }));
    out[kind] = {
      label: c.label,
      help: c.help,
      name: { ...c.name },
      fields,
      ...(c.bind ? { bind: structuredClone(c.bind) } : {}),
      ...(c.needsCode ? { needsCode: c.needsCode } : {}),
    };
  }
  return out;
}

/** @param {string} what @param {ReadToken} token */
function checkReadToken(what, token) {
  if (!isObject(token)) fail(what, 'readToken is not an object');
  if (!Array.isArray(token.permissions) || token.permissions.length === 0) fail(what, 'readToken names no permissions');
  for (const p of token.permissions) {
    if (!isObject(p) || !text(p.name) || !text(p.for)) fail(what, 'a readToken permission has no name or no for');
    if (p.legacy !== undefined && (!Array.isArray(p.legacy) || !p.legacy.every(text)))
      fail(what, 'a readToken permission’s legacy is not a list of names');
  }
  if (typeof token.url !== 'string' || !token.url.startsWith('https://')) fail(what, 'readToken has no https url');
  if (token.check !== undefined && typeof token.check !== 'function') fail(what, 'readToken check is not a function');
}

/**
 * Checks what a provider's `readToken.check` returned, or throws saying what's wrong.
 * @param {Provider} provider
 * @param {TokenCheck} result
 * @returns {TokenCheck}
 */
export function checkTokenCheck(provider, result) {
  const what = `${provider.id} token check`;
  if (!isObject(result) || typeof result.ok !== 'boolean') fail(what, "doesn't say whether the token works");
  if (!result.ok && !text(result.error)) fail(what, 'refused the token without saying why');
  if (result.permissions !== undefined) {
    if (!Array.isArray(result.permissions)) fail(what, 'permissions is not a list');
    for (const p of result.permissions)
      if (!isObject(p) || !text(p.name) || !['read', 'write'].includes(p.level))
        fail(what, 'a permission has no name, or a level that is neither read nor write');
  }
  return result;
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
  if (discovery.missing !== undefined && (!Array.isArray(discovery.missing) || !discovery.missing.every(text)))
    fail(what, 'missing is not a list of permission names');
  if (discovery.skipped !== undefined && (!Array.isArray(discovery.skipped) || !discovery.skipped.every(text)))
    fail(what, 'skipped is not a list of sentences');
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
    if (c.note !== undefined && (!text(c.note) || c.note.length > COST_NOTE_MAX))
      fail(what, `${c.resource}'s note is empty or longer than ${COST_NOTE_MAX}`);
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
    if (s.account !== undefined && typeof s.account !== 'boolean')
      fail(what, 'a signal has an account that isn’t true or false');
    if (s.account && (s.resource !== null || s.kind !== 'alert'))
      fail(what, 'an account signal is an alert on no resource');
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

/** The Worker's registry. This module names no vendor: src/infra-providers.js registers the real ones. */
export const providers = new ProviderRegistry();
