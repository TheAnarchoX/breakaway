/**
 * Architect's first provider: Cloudflare (docs/specs/IDEA-19-architect.md, "First provider: Cloudflare"; BRK-169,
 * BRK-188). It calls Cloudflare's API directly with the board's read-only token, through `ctx.fetch` so tests mock it.
 *
 * Discover (BRK-189) starts at the environment's target, a Worker's name in `ctx.scope.target`, and follows what that
 * Worker uses: its D1 databases, KV namespaces, R2 buckets, queues, Durable Object namespaces (and the containers they
 * run), the Workers it calls, and the routes and custom domains that serve it. Nothing outside that is kept, so a
 * resource no environment runs on is never returned. It keeps names and settings, never values: it never calls a KV
 * value, an R2 object, or a Worker's code, a secret is a name in its Worker's settings, and a variable's text is left
 * out. It stops on a 429 rather than retrying, since Cloudflare then refuses every call for five minutes.
 *
 * Cost (BRK-193) estimates each resource's monthly cost from its usage in Cloudflare's GraphQL analytics
 * (src/infra-cloudflare-analytics.js, one query per dataset for the whole environment), times PRICES, a price table kept
 * as data with where and when it was read. Plan and apply (BRK-192) are in infra-cloudflare-plan.js.
 *
 * Observe (BRK-191, BRK-266) reads each resource's health from the same analytics over the last few minutes, allowing
 * for their lag and looking further back for a quiet resource before it calls it idle, plus a queue's backlog and a
 * container application's instance counts; a route or custom domain takes its Worker's health. Events
 * (BRK-191) reads the account's alert history and reports each alert as a signal on the Worker it names, the same way
 * the board's alert webhook does (`alertFields`), and `alertSetup` reads which alerts are set up and which reach the
 * board. Alerts need Notifications Read; the token never has Notifications Write. Pure apart from `fetch`, so the CLI
 * can import it.
 */
import {
  COST_DATASETS,
  HEALTH_DATASETS,
  HEALTH_LAG_MINUTES,
  HEALTH_WINDOWS,
  HEALTH_WINDOW_MINUTES,
  readDataset,
} from './infra-cloudflare-analytics.js';
import { apply, estimate, plan } from './infra-cloudflare-plan.js';
import { tokenTemplate, WRITE_SECRET, writePermissions } from './infra-cloudflare-tokens.js';

/** @typedef {import('./infra-provider.js').Provider} Provider */
/** @typedef {import('./infra-provider.js').ProviderContext} ProviderContext */
/** @typedef {import('./infra-provider.js').Resource} Resource */
/** @typedef {import('./infra-provider.js').Relation} Relation */
/** @typedef {import('./infra-provider.js').Discovery} Discovery */

export const API = 'https://api.cloudflare.com/client/v4';

const BASE = ['create', 'update', 'delete'];
/**
 * The settings Architect manages, by kind. Everything else a resource carries (a Worker's handlers, secrets, and live
 * versions, a database's size, a container's instances) is Cloudflare's or the deploy's, and is never compared.
 */
export const MANAGED = {
  worker: ['compatibilityDate', 'compatibilityFlags', 'usageModel', 'observability', 'placement', 'bindings', 'crons'],
  'durable-object': [],
  d1: [],
  kv: [],
  r2: ['cors', 'lifecycle'],
  queue: ['deliveryDelay', 'deliveryPaused', 'retention', 'maxConcurrency'],
  container: ['maxInstances'],
  route: ['worker'],
  'custom-domain': ['worker', 'environment'],
};

/**
 * What envelopes may change, by kind (BRK-188's "Scale and restart, for envelopes"; BRK-227): a container application
 * scales its `max_instances` and restarts with a rollout of its configuration, and a queue scales its Worker
 * consumer's `max_concurrency`. Cloudflare scales every other kind itself, so none of them scales or restarts.
 */
const ENVELOPE = {
  container: { changes: ['scale', 'restart'], scales: 'maxInstances' },
  queue: { changes: ['scale'], scales: 'maxConcurrency' },
};
/**
 * The kinds that decide what reaches a Worker: a route or a custom domain can send a hostname somewhere else, so every
 * change to one asks the owner, whatever a repository's allow rules say (the policy's access guard; BRK-229).
 */
const ACCESS = ['route', 'custom-domain'];

export const CLOUDFLARE_KINDS = Object.fromEntries(
  Object.entries(MANAGED).map(([k, settings]) => [
    k,
    {
      ...(ENVELOPE[k]
        ? { changes: [...BASE, ...ENVELOPE[k].changes], scales: ENVELOPE[k].scales, settings: [...settings] }
        : { changes: [...BASE], settings: [...settings] }),
      ...(ACCESS.includes(k) ? { access: true } : {}),
      // A Worker is what an environment's discovery starts from (BRK-291).
      ...(k === 'worker' ? { target: true } : {}),
    },
  ]),
);

/**
 * How a Worker's binding names the resource it binds, for the console (BRK-262): in Cloudflare's own field, the one
 * the plan compares with what runs (BINDING_TARGETS; BRK-285), by the resource's ID on Cloudflare (a D1 database, a KV
 * namespace) or its name (a bucket, a queue, a Worker). A database or namespace the plan still makes has no ID yet, so
 * a binding names it by its ID in the desired state, in `resource`, until it runs.
 * @type {import('./infra-provider.js').BindingTarget[]}
 */
const BINDABLE = [
  { type: 'd1', label: 'D1 database', kind: 'd1', field: 'id', by: 'id' },
  { type: 'kv_namespace', label: 'KV namespace', kind: 'kv', field: 'namespace_id', by: 'id' },
  { type: 'r2_bucket', label: 'R2 bucket', kind: 'r2', field: 'bucket_name', by: 'name' },
  { type: 'queue', label: 'Queue', kind: 'queue', field: 'queue_name', by: 'name' },
  { type: 'service', label: 'Worker', kind: 'worker', field: 'service', by: 'name' },
];
/** The binding types BINDABLE doesn't list, in words, for a change's lines (WEB-110). */
const BINDING_WORDS = {
  durable_object_namespace: 'Durable Object',
  assets: 'static assets',
  plain_text: 'variable',
  secret_text: 'secret',
  json: 'variable',
  analytics_engine: 'Analytics Engine',
  ai: 'Workers AI',
  browser: 'Browser Rendering',
  hyperdrive: 'Hyperdrive',
  vectorize: 'Vectorize index',
  version_metadata: 'version metadata',
  workflow: 'Workflow',
  send_email: 'email',
  mtls_certificate: 'mTLS certificate',
  dispatch_namespace: 'dispatch namespace',
};
const CRON = '^\\S+( \\S+){4}$';
const VALUES_ELSEWHERE = 'Set with the Worker’s deploy, never here.';
/**
 * Where `wrangler deploy` sets a Worker's settings from: its bindings, compatibility date and flags, Workers Logs,
 * placement, and cron triggers are each a key of the wrangler config, and each deploy sets what it says (BRK-313;
 * developers.cloudflare.com/workers/wrangler/configuration/, "Source of truth").
 */
const DEPLOY_SETS = 'the wrangler config';

/**
 * The settings the console may change, by kind (BRK-262; docs/specs/BRK-258-plan-from-the-board.md): exactly what the
 * plan manages (MANAGED), and nothing it can't. A Worker's variables and secrets are shown by name and never changed;
 * a database, a KV namespace, and a Durable Object namespace have no setting Architect changes.
 * @type {Record<string, import('./infra-provider.js').Editable>}
 */
export const EDITABLE = {
  worker: {
    fields: [
      {
        path: 'compatibilityDate',
        deploy: DEPLOY_SETS,
        label: 'Compatibility date',
        type: 'text',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        help: 'The date of the Workers runtime the Worker runs as, like 2026-09-01.',
      },
      {
        path: 'compatibilityFlags',
        deploy: DEPLOY_SETS,
        label: 'Compatibility flags',
        type: 'names',
        pattern: '^[a-z0-9_]+$',
        help: 'Runtime features to turn on or off, like nodejs_compat.',
      },
      {
        path: 'usageModel',
        label: 'Usage model',
        type: 'choice',
        optional: true,
        options: [
          { value: 'standard', label: 'Standard' },
          { value: 'bundled', label: 'Bundled' },
          { value: 'unbound', label: 'Unbound' },
        ],
        help: 'How Cloudflare bills its requests. Standard is the one new Workers get.',
      },
      {
        path: 'observability',
        deploy: DEPLOY_SETS,
        label: 'Workers Logs',
        type: 'yesno',
        help: 'Keep the Worker’s logs on Cloudflare, to read in its dashboard.',
      },
      {
        path: 'placement',
        deploy: DEPLOY_SETS,
        label: 'Placement',
        type: 'choice',
        optional: true,
        options: [{ value: 'smart', label: 'Smart' }],
        help: 'Smart runs it near what it calls most. Unset runs it near whoever sent the request.',
      },
      {
        path: 'crons',
        deploy: DEPLOY_SETS,
        label: 'Cron triggers',
        type: 'names',
        pattern: CRON,
        help: 'When Cloudflare runs it on a schedule, in cron’s five fields, in UTC.',
      },
      {
        path: 'bindings',
        deploy: DEPLOY_SETS,
        label: 'Bindings',
        type: 'bindings',
        targets: BINDABLE,
        typeLabels: BINDING_WORDS,
        help: 'The environment’s databases, namespaces, buckets, queues, and Workers it reaches, each by a name its code uses. Variables and secrets are kept as they are.',
      },
    ],
    shown: [{ path: 'secrets', label: 'Secrets', help: VALUES_ELSEWHERE }],
  },
  // Bounds from Cloudflare's docs: a delivery delay of 0 to 86,400 seconds
  // (developers.cloudflare.com/queues/configuration/javascript-apis/), retention of 60 seconds to 14 days
  // (Queues changelog, 14 Feb 2025). Concurrency's 250 is Queues' limit as last read; Cloudflare refuses past its real one.
  queue: {
    fields: [
      {
        path: 'deliveryDelay',
        label: 'Delivery delay',
        type: 'number',
        integer: true,
        min: 0,
        max: 86_400,
        unit: 'seconds',
        optional: true,
        help: 'How long a message waits before its consumer gets it.',
      },
      {
        path: 'deliveryPaused',
        label: 'Delivery paused',
        type: 'yesno',
        help: 'Hold every message in the queue until delivery is turned back on.',
      },
      {
        path: 'retention',
        label: 'Retention',
        type: 'number',
        integer: true,
        min: 60,
        max: 1_209_600,
        unit: 'seconds',
        optional: true,
        help: 'How long a message is kept when nothing takes it.',
      },
      {
        path: 'maxConcurrency',
        label: 'Most consumers at once',
        type: 'number',
        integer: true,
        min: 1,
        max: 250,
        optional: true,
        help: 'How many copies of its consumer Worker run at the same time. Unset lets Cloudflare decide.',
      },
    ],
  },
  r2: {
    fields: [
      {
        path: 'cors',
        label: 'CORS rules',
        type: 'rules',
        template: { allowed: { origins: [], methods: ['GET'] } },
        fields: [
          {
            path: 'allowed.origins',
            label: 'Origins',
            type: 'names',
            help: 'The sites whose pages may read the bucket, like https://acme.example.',
          },
          {
            path: 'allowed.methods',
            label: 'Methods',
            type: 'names',
            pattern: '^(GET|PUT|POST|DELETE|HEAD)$',
            help: 'GET, PUT, POST, DELETE, or HEAD.',
          },
          { path: 'allowed.headers', label: 'Headers', type: 'names', help: 'Request headers they may send.' },
          {
            path: 'exposeHeaders',
            label: 'Exposed headers',
            type: 'names',
            help: 'Response headers their pages may read.',
          },
          {
            path: 'maxAgeSeconds',
            label: 'Cache for',
            type: 'number',
            integer: true,
            min: 0,
            unit: 'seconds',
            optional: true,
            help: 'How long a browser keeps the answer before it asks again.',
          },
        ],
        help: 'Which other sites’ pages may read the bucket from a browser.',
      },
      {
        path: 'lifecycle',
        label: 'Lifecycle rules',
        type: 'rules',
        template: {
          enabled: true,
          conditions: { prefix: '' },
          deleteObjectsTransition: { condition: { type: 'Age' } },
        },
        fields: [
          { path: 'id', label: 'Name', type: 'text', help: 'A name for the rule, unique in the bucket.' },
          { path: 'enabled', label: 'On', type: 'yesno', help: 'Whether the rule runs.' },
          {
            path: 'conditions.prefix',
            label: 'Prefix',
            type: 'text',
            help: 'The objects it applies to, by the start of their key. Empty is every object.',
          },
          {
            path: 'deleteObjectsTransition.condition.maxAge',
            label: 'Delete after',
            type: 'number',
            integer: true,
            min: 1,
            unit: 'seconds',
            optional: true,
            help: 'How old an object gets before Cloudflare deletes it.',
          },
        ],
        help: 'When Cloudflare deletes old objects from the bucket.',
      },
    ],
  },
  container: {
    fields: [
      {
        path: 'maxInstances',
        label: 'Most instances',
        type: 'number',
        integer: true,
        min: 1,
        help: 'How many of its containers may run at once: its scale.',
      },
    ],
  },
  route: {
    name: {
      label: 'Pattern',
      pattern: '^\\S+$',
      help: 'The hostname and path it sends to its Worker, like api.acme.example/*.',
    },
    fields: [
      {
        path: 'worker',
        label: 'Worker',
        type: 'resource',
        kinds: ['worker'],
        help: 'The Worker it sends requests to.',
      },
    ],
  },
  'custom-domain': {
    fields: [
      { path: 'worker', label: 'Worker', type: 'resource', kinds: ['worker'], help: 'The Worker the hostname serves.' },
    ],
  },
};

/**
 * What the console may change on a resource of `kind` (BRK-262), or null when Architect changes nothing on it.
 * @param {string} kind
 */
export const editable = (kind) => EDITABLE[kind] ?? null;

/**
 * How a Worker binds each kind the console adds, as BINDABLE says; `required` when the plan makes one only if a Worker
 * binds it.
 */
const bindAs = (kind, required = false) => {
  const target = BINDABLE.find((t) => t.kind === kind);
  return target ? { bind: { kind: 'worker', list: 'bindings', target, ...(required ? { required } : {}) } } : {};
};
/** Names Cloudflare gives Workers, queues, and containers: lowercase letters, digits, and dashes, up to 63. */
const DNS_LABEL = '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$';
const HOSTNAME = '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$';
const ZONE_FIELD = {
  path: 'zone',
  label: 'Zone',
  type: 'text',
  pattern: HOSTNAME,
  help: 'The domain on Cloudflare it’s on, like acme.example: one the environment’s token reaches.',
};

/**
 * The kinds the console may add (BRK-270), every kind Architect plans. Name rules are Cloudflare's as last read
 * (developers.cloudflare.com: Workers, Queues, R2, KV, and D1 limits). A database, namespace, bucket, or queue is made
 * only when a Worker in the environment binds it, so each says how one binds it. A Durable Object class and a container
 * application are made by their Worker's code and deploy, so the plan won't make one: the console adds it to the file,
 * `needsCode` says what code must exist, and the plan finds it by name once the deploy has made it.
 * @type {Record<string, Omit<import('./infra-provider.js').Creatable, 'defaults'> & { defaults?: () => Record<string, unknown> }>}
 */
export const CREATABLE = {
  worker: {
    label: 'Worker',
    help: 'Runs the code that answers requests. It starts with a script that answers /health, until the repository’s deploy puts its own code on it.',
    name: {
      label: 'Name',
      pattern: DNS_LABEL,
      max: 63,
      help: 'Lowercase letters, digits, and dashes, up to 63, unique in the account, like acme-jobs.',
    },
    required: ['compatibilityDate'],
    defaults: () => ({ compatibilityDate: new Date().toISOString().slice(0, 10), observability: true }),
    ...bindAs('worker'),
  },
  queue: {
    label: 'Queue',
    help: 'Holds messages one Worker sends until another takes them, one batch at a time.',
    name: {
      label: 'Name',
      pattern: DNS_LABEL,
      max: 63,
      help: 'Lowercase letters, digits, and dashes, up to 63, unique in the account, like acme-jobs.',
    },
    defaults: () => ({ deliveryDelay: 0, deliveryPaused: false, retention: 345_600 }),
    ...bindAs('queue', true),
  },
  r2: {
    label: 'R2 bucket',
    help: 'Keeps files (objects) by key: uploads, images, exports.',
    name: {
      label: 'Name',
      pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$',
      max: 63,
      help: 'Lowercase letters, digits, and dashes, 3 to 63, unique in the account, like acme-uploads.',
    },
    fields: [
      {
        path: 'location',
        label: 'Location',
        type: 'choice',
        optional: true,
        options: [
          { value: 'wnam', label: 'Western North America' },
          { value: 'enam', label: 'Eastern North America' },
          { value: 'weur', label: 'Western Europe' },
          { value: 'eeur', label: 'Eastern Europe' },
          { value: 'apac', label: 'Asia-Pacific' },
          { value: 'oc', label: 'Oceania' },
        ],
        help: 'Where Cloudflare keeps it, as a hint. Unset puts it near whoever makes it. It can’t move later.',
      },
    ],
    ...bindAs('r2', true),
  },
  kv: {
    label: 'KV namespace',
    help: 'Keeps small values by key, read often and written now and then: settings, flags, sessions.',
    name: {
      label: 'Title',
      pattern: '^\\S(?:.*\\S)?$',
      max: 512,
      help: 'Up to 512 characters, unique in the account, like acme-flags.',
    },
    ...bindAs('kv', true),
  },
  d1: {
    label: 'D1 database',
    help: 'A SQL database (SQLite) for the Worker’s data.',
    name: {
      label: 'Name',
      pattern: '^[a-z0-9][a-z0-9_-]{0,63}$',
      max: 64,
      help: 'Lowercase letters, digits, dashes, and underscores, up to 64, unique in the account, like acme-db.',
    },
    ...bindAs('d1', true),
  },
  route: {
    label: 'Route',
    help: 'Sends the requests that match a pattern on one of your domains to a Worker.',
    name: { ...EDITABLE.route.name, label: 'Pattern', max: 255 },
    fields: [ZONE_FIELD],
    required: ['zone', 'worker'],
  },
  'custom-domain': {
    label: 'Custom domain',
    help: 'Makes a hostname answer with a Worker, with its DNS record and certificate.',
    name: {
      label: 'Hostname',
      pattern: HOSTNAME,
      max: 253,
      help: 'A hostname on one of your zones, like api.acme.example, that no other Worker has.',
    },
    fields: [ZONE_FIELD],
    required: ['zone', 'worker'],
  },
  'durable-object': {
    label: 'Durable Object',
    help: 'One object per ID that keeps its own state, made from a class in a Worker’s code: a counter, a room, a lock.',
    name: {
      label: 'Name',
      pattern: '^[a-z0-9][a-z0-9-]{0,62}_[A-Za-z_$][A-Za-z0-9_$]*$',
      max: 128,
      help: 'Its Worker’s name and its class’s, joined by _, like acme-api_Counter.',
    },
    fields: [
      {
        path: 'class',
        label: 'Class',
        type: 'text',
        pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$',
        help: 'The class in the Worker’s code that each object is, like Counter.',
      },
      {
        path: 'script',
        label: 'Worker',
        type: 'resource',
        kinds: ['worker'],
        help: 'The Worker whose code has the class.',
      },
    ],
    required: ['class', 'script'],
    needsCode:
      'The Worker’s code exports the class, its wrangler config binds it and adds it in a migration, and the Worker is deployed. Until then, the plan won’t apply.',
  },
  container: {
    label: 'Container',
    help: 'Runs a container image next to a Durable Object, for code that can’t run in a Worker.',
    name: {
      label: 'Name',
      pattern: DNS_LABEL,
      max: 63,
      help: 'Lowercase letters, digits, and dashes, up to 63, unique in the account, like acme-render.',
    },
    fields: [
      {
        path: 'image',
        label: 'Image',
        type: 'text',
        help: 'What it runs: the Dockerfile in the repository, like ./Dockerfile, or an image’s address.',
      },
    ],
    required: ['image', 'maxInstances'],
    defaults: () => ({ maxInstances: 1 }),
    needsCode:
      'The image, the Durable Object class that starts it, and the container in the Worker’s wrangler config, and the Worker is deployed. Until then, the plan won’t apply.',
  },
};

/**
 * Whether the console may add a resource of `kind` (BRK-270), what a new one is given, and its name's rule.
 * @param {string} kind
 * @returns {import('./infra-provider.js').Creatable | null}
 */
export function creatable(kind) {
  const c = CREATABLE[kind];
  if (!c) return null;
  const { defaults, ...rest } = c;
  return { ...structuredClone(rest), ...(defaults ? { defaults: defaults() } : {}) };
}

/** The scheduling policy whose container applications Cloudflare scales and rolls out; any other is the code's. */
export const DEFAULT_SCHEDULING = 'default';

/**
 * Why Cloudflare can't make an envelope's change to this resource, in words, or null when it can. A kind that never
 * scales or restarts says the platform does it; a container application on another scheduling policy (the Durable
 * Object one) is started and stopped by its own code; a queue with no Worker consuming it has no concurrency to set.
 * @param {Resource} r
 * @param {string} op
 * @returns {string | null}
 */
export function refuses(r, op) {
  if (op !== 'scale' && op !== 'restart') return null;
  if (!CLOUDFLARE_KINDS[r.kind]?.changes.includes(op))
    return r.kind === 'queue'
      ? `${r.name} is a queue: Cloudflare has no restart for one, only its consumer’s concurrency scales`
      : `${r.name} is a ${r.kind}: Cloudflare scales it by itself, so there’s nothing to ${op}`;
  const attrs = /** @type {Record<string, unknown>} */ (r.attrs ?? {});
  if (r.kind === 'container' && attrs.schedulingPolicy !== DEFAULT_SCHEDULING)
    return attrs.schedulingPolicy
      ? `${r.name} runs on the ${attrs.schedulingPolicy} scheduling policy: its own code starts and stops its instances, so Cloudflare can’t ${op} it`
      : `${r.name}’s scheduling policy isn’t known, so it can’t ${op}: discover it again`;
  if (r.kind === 'queue' && !(/** @type {any[]} */ (attrs.consumers ?? []).some((c) => c?.type === 'worker')))
    return `${r.name} has no Worker consuming it, so there’s no concurrency to scale`;
  return null;
}

/**
 * What an environment owns of what discovery found (BRK-251). Discovery follows the target's service and Durable
 * Object bindings to other Workers, so it can reach the install's own Worker (`scope.board`) or another environment's
 * target (`scope.others`): those are foreign, and so is everything reached only through them. The environment's own
 * Workers are the target and the Workers it reaches without passing through a foreign one. A database, namespace,
 * bucket, or queue is its own when one of its Workers binds, sends to, or consumes it; a Durable Object namespace when
 * its class runs in one of its Workers, and a container application when its namespace is its own; a route or custom
 * domain when it serves one of its Workers.
 * @param {import('./infra-provider.js').Discovery} found
 * @param {Record<string, unknown> | undefined} scope
 */
export function ownership(found, scope) {
  const target = String(scope?.target ?? '');
  const board = typeof scope?.board === 'string' && scope.board !== target ? scope.board : null;
  const others = new Set(
    (Array.isArray(scope?.others) ? scope.others : []).filter((w) => typeof w === 'string' && w && w !== target),
  );
  const foreign = (name) => name === board || others.has(name);
  const byId = new Map(found.resources.map((r) => [r.id, r]));
  const name = (id) => id.slice(id.indexOf(':') + 1);
  const from = new Map();
  for (const rel of found.relations) from.set(rel.from, [...(from.get(rel.from) ?? []), rel]);
  /** @type {Set<string>} */
  const workers = new Set();
  const queue = byId.has(rid('worker', target)) ? [target] : [];
  while (queue.length) {
    const w = /** @type {string} */ (queue.shift());
    if (workers.has(w) || foreign(w)) continue;
    workers.add(w);
    for (const rel of from.get(rid('worker', w)) ?? []) {
      if (rel.kind === 'calls') queue.push(name(rel.to));
      if (rel.kind === 'uses' && rel.to.startsWith('durable-object:'))
        for (const runs of from.get(rel.to) ?? []) if (runs.kind === 'runs-in') queue.push(name(runs.to));
    }
  }
  /** @type {Set<string>} */
  const own = new Set([...workers].map((w) => rid('worker', w)));
  for (const rel of found.relations) {
    const r = byId.get(rel.to);
    if (!r || !own.has(rel.from) || r.kind === 'durable-object' || r.kind === 'worker') continue;
    own.add(r.id);
  }
  for (const rel of found.relations)
    if (rel.kind === 'runs-in' && own.has(rel.to)) {
      own.add(rel.from);
      for (const runs of from.get(rel.from) ?? []) if (runs.kind === 'runs') own.add(runs.to);
    }
  return {
    workers,
    /** @param {string} w a Worker's name */
    foreign,
    /**
     * Why the environment can't change this resource, in words, or null when it's its own.
     * @param {string} environment
     * @param {Resource} r
     */
    why(environment, r) {
      if (r.kind === 'worker' && r.name === board)
        return `${r.name} is the Worker this board runs on: Architect only observes it, so no plan or act changes it`;
      if (r.kind === 'worker' && others.has(r.name))
        return `${r.name} is another environment’s target: change it in that environment, not ${environment}`;
      if (own.has(r.id)) return null;
      return `${r.name} is reached only through a Worker outside ${environment} (the install’s own or another environment’s), so it isn’t ${environment}’s to change`;
    },
  };
}

/**
 * Why an act can't change this resource in the environment (BRK-251): `ownership`'s answer, and for a queue's scale,
 * the Worker consuming it, whose concurrency it sets, must be the environment's too.
 * @param {import('./infra-provider.js').ProviderContext} ctx
 * @param {import('./infra-provider.js').Discovery} found
 * @param {Resource} r
 * @returns {string | null}
 */
export function outside(ctx, found, r) {
  const own = ownership(found, ctx.scope);
  const why = own.why(ctx.environment, r);
  if (why) return why;
  const consumers = r.kind === 'queue' ? /** @type {any[]} */ (r.attrs?.consumers ?? []) : [];
  const consumer = consumers.find((c) => c?.type === 'worker');
  if (consumer && !own.workers.has(String(consumer.worker ?? '')))
    return `${r.name} is consumed by ${consumer.worker}, which is outside ${ctx.environment}, so its concurrency isn’t ${ctx.environment}’s to change`;
  return null;
}

/**
 * Cloudflare's Workers role the board reads Workers with (BRK-243): Metadata Read-Only at the Workers product scope,
 * which reads settings and never a Worker's code. It replaces the legacy Workers Scripts Read, which Cloudflare maps to
 * Content Read-Only (code included); a token made with that still works.
 */
export const WORKERS_READ = 'Workers Metadata Read-Only';

/**
 * The board's read-only token (BRK-188, "Tokens"; BRK-194 keeps it). Read only: no permission ends in Edit or Write.
 * @type {import('./infra-provider.js').ReadToken['permissions']}
 */
export const READ_PERMISSIONS = [
  {
    name: WORKERS_READ,
    legacy: ['Workers Scripts Read'],
    for: 'Workers, their settings, deployments, secret names, cron triggers, Durable Object namespaces, and custom domains, never their code',
  },
  { name: 'Workers KV Storage Read', for: 'KV namespaces, never their values' },
  { name: 'Workers R2 Storage Read', for: 'R2 buckets and their settings, never their objects' },
  { name: 'D1 Read', for: 'D1 databases' },
  { name: 'Queues Read', for: 'queues and their consumers' },
  { name: 'Containers Read', for: 'container applications' },
  { name: 'Account Analytics Read', for: 'health and usage' },
  { name: 'Notifications Read', for: 'which alerts are set up' },
  { name: 'Zone Read', for: 'naming the zones your routes are on' },
  { name: 'Workers Routes Read', for: 'routes' },
];

/** The consumer a queue's scale changes: its Worker consumer (Cloudflare allows one), or undefined. */
export const workerConsumer = (consumers) =>
  (consumers ?? []).find((c) => String(c?.type ?? 'worker') === 'worker' && (c.script ?? c.script_name ?? c.service));

/** At most this many Workers in one environment's scope, and pages of one list: far more than a repository runs. */
const MAX_WORKERS = 50;
const MAX_PAGES = 20;

/**
 * Paths discover must never call: a KV value, an R2 object, a Worker's code (BRK-188), or its logs (BRK-253). Every
 * call is checked against these before it's made, so a bug can't turn a read of settings into a read of data.
 */
export const NEVER_CALLED = [
  /\/storage\/kv\/namespaces\/[^/]+\/(values|keys|bulk)/u,
  /\/r2\/buckets\/[^/]+\/objects/u,
  /\/workers\/scripts\/[^/]+\/content/u,
  /\/workers\/scripts\/[^/]+$/u,
  /\/versions\/[^/?]+\?.*include=modules/u,
  /\/secrets\/[^/]+$/u,
  // Workers Observability's logs and telemetry, and a Worker's live tail: what its requests carried (BRK-253).
  /\/workers\/observability\//u,
  /\/workers\/scripts\/[^/]+\/tails/u,
];

/** A permission as a 403 names it: with its legacy names in parentheses, for a token made before Cloudflare renamed it. */
export function named(permission) {
  const legacy = READ_PERMISSIONS.find((p) => p.name === permission)?.legacy;
  return legacy?.length ? `${permission} (or the legacy ${legacy.join(' or ')})` : permission;
}

/** An answer Cloudflare refused, with what the token was missing when it was a 403. */
export class CloudflareError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** What Cloudflare said, from its `errors` list, in a line. */
function said(json) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  return errors
    .map((e) => e?.message)
    .filter(Boolean)
    .join('; ')
    .slice(0, 200);
}

/** What Cloudflare said, with each error's code (`10000: Authentication error`), in a line. */
function saidCodes(json) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  return errors
    .filter((e) => e?.message || e?.code != null)
    .map((e) => (e.code != null ? `${e.code}${e.message ? `: ${e.message}` : ''}` : e.message))
    .join('; ')
    .slice(0, 200);
}

/**
 * A reader for one call of the provider: GETs only, each checked against NEVER_CALLED, stopping on a 429.
 * @param {ProviderContext} ctx
 */
export function reader(ctx) {
  const doFetch = ctx.fetch ?? fetch;
  if (!ctx.token) throw new CloudflareError('no read-only token: connect Cloudflare on Connections', 401);
  /**
   * @param {string} path under API
   * @param {{ permission: string, missingOk?: boolean }} opts `missingOk`: a 404 answers null
   */
  async function get(path, { permission, missingOk = false }) {
    if (NEVER_CALLED.some((re) => re.test(path))) throw new Error(`cloudflare discover refuses to call ${path}`);
    let res;
    try {
      res = await doFetch(`${API}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
      });
    } catch (error) {
      throw new CloudflareError(`couldn’t reach Cloudflare (${String(error?.message ?? error).slice(0, 100)})`, 502);
    }
    if (res.status === 429)
      throw new CloudflareError(
        'Cloudflare’s rate limit was reached, so discovery stopped: it refuses every call for 5 minutes, then try again',
        429,
      );
    const json = await res.json().catch(() => null);
    if (res.status === 404 && missingOk) return null;
    // Cloudflare's own code and message ride along with the permission the board guesses, so the real cause shows.
    if (res.status === 403)
      throw Object.assign(
        new CloudflareError(
          `Cloudflare refused GET ${path.split('?')[0]}: the token needs ${named(permission)}${saidCodes(json) ? ` (Cloudflare said ${saidCodes(json)})` : ''}`,
          403,
        ),
        { permission, cloudflare: saidCodes(json) },
      );
    if (!res.ok || json?.success === false)
      throw new CloudflareError(
        `Cloudflare answered ${res.status} to GET ${path.split('?')[0]}${said(json) ? `: ${said(json)}` : ''}`,
        res.status,
      );
    ctx.reached?.add(permission);
    return json;
  }

  /** Every page of a paged list (`page`, `per_page`, `result_info.total_pages`). */
  async function all(path, opts, perPage = 100) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const json = await get(`${path}${sep}page=${page}&per_page=${perPage}`, opts);
      const result = Array.isArray(json?.result) ? json.result : [];
      out.push(...result);
      const pages = json?.result_info?.total_pages;
      if (!pages || page >= pages || result.length === 0) break;
    }
    return out;
  }

  return { get, all };
}

/**
 * The account the environment runs on: `ctx.scope.account`, or the one account the token reaches (an account token
 * reaches exactly one).
 * @param {ReturnType<typeof reader>} cf
 * @param {ProviderContext} ctx
 */
export async function accountOf(cf, ctx) {
  const given = ctx.scope?.account;
  if (typeof given === 'string' && given) return given;
  const accounts = await cf.all('/accounts', { permission: 'access to the account' }, 50);
  if (accounts.length === 1) return String(accounts[0].id);
  throw new CloudflareError(
    accounts.length === 0
      ? 'the token reaches no Cloudflare account: make it on the account the environments run on'
      : `the token reaches ${accounts.length} Cloudflare accounts: make it for the one account the environments run on`,
    409,
  );
}

const sorted = (list) => [...list].sort();
const enc = encodeURIComponent;

/**
 * What a Worker's settings say, without a value: each binding's name and type, never a variable's text or JSON.
 * @param {any} script from the scripts list
 * @param {any} settings
 * @param {any} deployments
 * @param {any[]} secrets
 * @param {any} schedules
 */
function workerAttrs(script, settings, deployments, secrets, schedules) {
  const live = (deployments?.deployments ?? [])[0];
  return {
    handlers: sorted(script.handlers ?? []),
    compatibilityDate: settings.compatibility_date ?? null,
    compatibilityFlags: sorted(settings.compatibility_flags ?? []),
    usageModel: settings.usage_model ?? script.usage_model ?? null,
    observability: Boolean(settings.observability?.enabled),
    placement: settings.placement?.mode ?? script.placement_mode ?? null,
    // What each binding binds, by ID or name (BINDING_TARGETS), so a draft names it as the plan compares it (BRK-285).
    bindings: (settings.bindings ?? []).map(bindingTarget).sort((a, b) => a.name.localeCompare(b.name)),
    secrets: sorted(secrets.map((s) => String(s.name))),
    crons: sorted((schedules?.schedules ?? []).map((s) => String(s.cron))),
    versions: (live?.versions ?? []).map((v) => ({ id: String(v.version_id), percentage: Number(v.percentage) })),
    deployed: live?.created_on ?? null,
  };
}

/** Resource IDs: the kind and Cloudflare's own ID, so they're unique within the provider. */
export const rid = (kind, id) => `${kind}:${id}`;

/** The fields of a binding that name what it binds to, by binding type: IDs and names, never a variable's text. */
export const BINDING_TARGETS = {
  d1: ['id'],
  kv_namespace: ['namespace_id'],
  r2_bucket: ['bucket_name', 'jurisdiction'],
  queue: ['queue_name'],
  service: ['service', 'environment', 'entrypoint'],
  durable_object_namespace: ['class_name', 'script_name'],
};

/** A binding's name, type, and what it binds to (BINDING_TARGETS), without anything else it carries. */
export function bindingTarget(b) {
  /** @type {Record<string, string>} */
  const out = { name: String(b.name), type: String(b.type) };
  for (const f of BINDING_TARGETS[b.type] ?? []) if (b[f] != null && b[f] !== '') out[f] = String(b[f]);
  return out;
}

/**
 * What plan and apply (BRK-192) need from a discovery besides its resources, never kept in the inventory: the account,
 * every Worker's name on it (to refuse one outside the scope), each Worker's bindings with what they bind to, and the
 * zones by name.
 * @typedef {object} LiveAccount
 * @property {string} account
 * @property {string[]} scripts
 * @property {Record<string, Array<Record<string, string>>>} bindings by Worker
 * @property {Record<string, string>} zones zone IDs by name
 * @property {Array<{ pattern: string, zone: string, worker: string }>} routes every route on those zones, whichever
 *   Worker it sends to, so a new one can't take a pattern another Worker already has (BRK-251)
 * @property {Array<{ hostname: string, worker: string }>} domains every custom domain on the account, likewise
 */

/**
 * The zones whose routes the token can't read, as a quiet note for Connections. An account-owned token is listed every
 * zone on the account, including ones it has no permission on, so a 403 on one is normal (BRK-254).
 * @param {Array<{ zone: string, error: any }>} refused
 */
function routesSkipped(refused) {
  const zones = refused.map((r) => r.zone);
  const list = zones.length === 1 ? zones[0] : `${zones.slice(0, -1).join(', ')} and ${zones.at(-1)}`;
  return `routes on ${list} aren’t readable with this token, so discovery skipped ${zones.length === 1 ? 'it' : 'them'}`;
}

/**
 * Discovers what the environment's target Worker runs on, as resources and relations. `missing` names a permission
 * the token lacks for a kind a repository may leave out (queues, containers): that kind isn't read, and discovery goes
 * on (BRK-188, "Tokens"). `skipped` says, in words, what the token couldn't read and discovery went on without (a
 * zone whose routes it can't read). Each permission a call answers with goes in `ctx.reached`. With `live`, it also
 * returns the LiveAccount plan and apply work from.
 * @param {ProviderContext} ctx
 * @param {{ live?: boolean }} [options]
 * @returns {Promise<Discovery & { missing: string[], skipped?: string[], live?: LiveAccount }>}
 */
export async function discover(ctx, { live = false } = {}) {
  const target = typeof ctx.scope?.target === 'string' ? ctx.scope.target : null;
  /** @type {Map<string, Resource>} */
  const resources = new Map();
  /** @type {Map<string, Relation>} */
  const relations = new Map();
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {LiveAccount} */
  const seen = { account: '', scripts: [], bindings: {}, zones: {}, routes: [], domains: [] };
  const add = (r) => resources.set(r.id, r);
  const relate = (from, to, kind) => relations.set(`${from} ${kind} ${to}`, { from, to, kind });
  const done = () => ({
    resources: [...resources.values()],
    relations: [...relations.values()].filter((r) => resources.has(r.from) && resources.has(r.to)),
    missing,
    ...(skipped.length ? { skipped } : {}),
    ...(live ? { live: seen } : {}),
  });
  if (!target) return done();

  const cf = reader(ctx);
  seen.account = await accountOf(cf, ctx);
  const a = enc(seen.account);
  const scripts = new Map(
    (await cf.get(`/accounts/${a}/workers/scripts`, { permission: WORKERS_READ }).then((j) => j.result ?? [])).map(
      (s) => [String(s.id), s],
    ),
  );
  seen.scripts = [...scripts.keys()];
  /** @param {Set<string>} workers the Workers in scope, whose routes and custom domains are resources */
  async function serving(workers) {
    // Routes, on the zones the token reaches, that send to a Worker in scope. The zones list holds every zone on the
    // account for an account-owned token, so a 403 on one zone's routes is skipped and named in `skipped`, never an
    // error (BRK-254); only when every zone refuses does discovery fail, naming the permission.
    const zones = await cf.all(`/zones?account.id=${a}`, { permission: 'Zone Read' }, 50);
    /** @type {Array<{ zone: string, error: any }>} */
    const refused = [];
    for (const zone of zones) {
      seen.zones[String(zone.name)] = String(zone.id);
      let routes;
      try {
        routes =
          (await cf.get(`/zones/${enc(zone.id)}/workers/routes`, { permission: 'Workers Routes Read' })).result ?? [];
      } catch (error) {
        if (error?.status !== 403) throw error;
        refused.push({ zone: String(zone.name), error });
        continue;
      }
      for (const route of routes) {
        seen.routes.push({
          pattern: String(route.pattern),
          zone: String(zone.name),
          worker: String(route.script ?? ''),
        });
        if (!workers.has(String(route.script))) continue;
        add({
          id: rid('route', route.id),
          kind: 'route',
          name: String(route.pattern),
          attrs: { zone: zone.name, worker: String(route.script) },
        });
        relate(rid('worker', String(route.script)), rid('route', route.id), 'serves');
      }
    }
    if (refused.length && refused.length === zones.length) throw refused[0].error;
    if (refused.length) skipped.push(routesSkipped(refused));

    // Custom domains attached to a Worker in scope.
    const domains = (await cf.get(`/accounts/${a}/workers/domains`, { permission: WORKERS_READ })).result ?? [];
    for (const d of domains) {
      seen.domains.push({ hostname: String(d.hostname), worker: String(d.service ?? '') });
      if (!workers.has(String(d.service))) continue;
      add({
        id: rid('custom-domain', d.id),
        kind: 'custom-domain',
        name: String(d.hostname),
        attrs: { zone: d.zone_name ?? null, environment: d.environment ?? null, worker: String(d.service) },
      });
      relate(rid('worker', String(d.service)), rid('custom-domain', d.id), 'serves');
    }
  }

  // A target that doesn't run yet (a new environment built from the console, BRK-291) has nothing in scope, but a plan
  // still needs the zones, routes, and domains, so its first change can serve a hostname (BRK-292).
  if (!scripts.has(target)) {
    if (live) await serving(new Set());
    return done();
  }

  // The Workers in scope: the target, and the Workers it calls or whose Durable Objects it binds.
  /** @type {Map<string, any[]>} */
  const bindingsOf = new Map();
  const queue = [target];
  while (queue.length && bindingsOf.size < MAX_WORKERS) {
    const name = /** @type {string} */ (queue.shift());
    if (bindingsOf.has(name) || !scripts.has(name)) continue;
    const p = `/accounts/${a}/workers/scripts/${enc(name)}`;
    const opts = { permission: WORKERS_READ };
    const settings = (await cf.get(`${p}/settings`, opts)).result ?? {};
    const deployments = (await cf.get(`${p}/deployments`, opts)).result ?? {};
    const secrets = (await cf.get(`${p}/secrets`, opts)).result ?? [];
    const schedules = (await cf.get(`${p}/schedules`, opts)).result ?? {};
    const bindings = settings.bindings ?? [];
    bindingsOf.set(name, bindings);
    seen.bindings[name] = bindings.map(bindingTarget);
    add({
      id: rid('worker', name),
      kind: 'worker',
      name,
      attrs: workerAttrs(scripts.get(name), settings, deployments, secrets, schedules),
    });
    for (const b of bindings) {
      if (b.type === 'service' && b.service) queue.push(String(b.service));
      if (b.type === 'durable_object_namespace' && b.script_name) queue.push(String(b.script_name));
    }
  }
  const workers = new Set(bindingsOf.keys());
  const scoped = (type) =>
    [...bindingsOf].flatMap(([worker, bindings]) =>
      bindings.filter((b) => b.type === type).map((b) => ({ worker, b })),
    );

  for (const [worker, bindings] of bindingsOf)
    for (const b of bindings)
      if (b.type === 'service' && workers.has(String(b.service)))
        relate(rid('worker', worker), rid('worker', String(b.service)), 'calls');

  // D1: each database a Worker in scope binds, by its ID.
  for (const { worker, b } of scoped('d1')) {
    const id = String(b.id ?? b.database_id ?? '');
    if (!id) continue;
    if (!resources.has(rid('d1', id))) {
      const db = (await cf.get(`/accounts/${a}/d1/database/${enc(id)}`, { permission: 'D1 Read', missingOk: true }))
        ?.result;
      if (!db) continue;
      add({
        id: rid('d1', id),
        kind: 'd1',
        name: String(db.name),
        attrs: {
          tables: db.num_tables ?? null,
          size: db.file_size ?? null,
          readReplication: db.read_replication?.mode ?? null,
          version: db.version ?? null,
        },
      });
    }
    relate(rid('worker', worker), rid('d1', id), 'uses');
  }

  // KV: the namespaces the Workers in scope bind; never their keys or values.
  const kvBound = scoped('kv_namespace');
  if (kvBound.length) {
    const namespaces = new Map(
      (await cf.all(`/accounts/${a}/storage/kv/namespaces`, { permission: 'Workers KV Storage Read' })).map((n) => [
        String(n.id),
        n,
      ]),
    );
    for (const { worker, b } of kvBound) {
      const ns = namespaces.get(String(b.namespace_id));
      if (!ns) continue;
      add({
        id: rid('kv', ns.id),
        kind: 'kv',
        name: String(ns.title),
        attrs: { urlEncoding: Boolean(ns.supports_url_encoding) },
      });
      relate(rid('worker', worker), rid('kv', ns.id), 'uses');
    }
  }

  // R2: the buckets the Workers in scope bind, with their CORS, lifecycle, and custom domains; never their objects.
  const r2Bound = scoped('r2_bucket');
  if (r2Bound.length) {
    const opts = { permission: 'Workers R2 Storage Read' };
    /** @type {Map<string, any>} */
    const buckets = new Map();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await cf.get(
        `/accounts/${a}/r2/buckets?per_page=1000${cursor ? `&cursor=${enc(cursor)}` : ''}`,
        opts,
      );
      for (const bucket of json.result?.buckets ?? []) buckets.set(String(bucket.name), bucket);
      cursor = json.result_info?.cursor ?? '';
      if (!cursor) break;
    }
    for (const { worker, b } of r2Bound) {
      const name = String(b.bucket_name);
      const bucket = buckets.get(name);
      if (!bucket) continue;
      if (!resources.has(rid('r2', name))) {
        const p = `/accounts/${a}/r2/buckets/${enc(name)}`;
        const cors = (await cf.get(`${p}/cors`, { ...opts, missingOk: true }))?.result?.rules ?? [];
        const lifecycle = (await cf.get(`${p}/lifecycle`, { ...opts, missingOk: true }))?.result?.rules ?? [];
        const domains = (await cf.get(`${p}/domains/custom`, { ...opts, missingOk: true }))?.result?.domains ?? [];
        add({
          id: rid('r2', name),
          kind: 'r2',
          name,
          attrs: {
            location: bucket.location ?? null,
            storageClass: bucket.storage_class ?? null,
            jurisdiction: bucket.jurisdiction ?? b.jurisdiction ?? null,
            cors,
            lifecycle,
            domains: sorted(domains.map((d) => String(d.domain))),
          },
        });
      }
      relate(rid('worker', worker), rid('r2', name), 'uses');
    }
  }

  // Queues: those a Worker in scope sends to, or consumes. A token without Queues Read skips them.
  try {
    const opts = { permission: 'Queues Read' };
    const produced = scoped('queue');
    const all = await cf.all(`/accounts/${a}/queues`, opts);
    for (const q of all) {
      const id = String(q.queue_id);
      const producers = produced.filter(({ b }) => String(b.queue_name) === q.queue_name).map(({ worker }) => worker);
      const consumersListed = (q.consumers ?? []).map((c) => String(c.script ?? c.service ?? ''));
      if (!producers.length && !consumersListed.some((w) => workers.has(w))) continue;
      const consumers = (await cf.get(`/accounts/${a}/queues/${enc(id)}/consumers`, opts)).result ?? [];
      add({
        id: rid('queue', id),
        kind: 'queue',
        name: String(q.queue_name),
        attrs: {
          deliveryDelay: q.settings?.delivery_delay ?? null,
          deliveryPaused: Boolean(q.settings?.delivery_paused),
          retention: q.settings?.message_retention_period ?? null,
          // The Worker consumer's concurrency, which a scale sets (null: Cloudflare picks it).
          maxConcurrency: workerConsumer(consumers)?.settings?.max_concurrency ?? null,
          consumers: consumers.map((c) => ({
            type: String(c.type ?? 'worker'),
            worker: String(c.script ?? c.service ?? ''),
            batchSize: c.settings?.batch_size ?? null,
            maxRetries: c.settings?.max_retries ?? null,
            maxWait: c.settings?.max_wait_time_ms ?? null,
            maxConcurrency: c.settings?.max_concurrency ?? null,
            deadLetter: c.dead_letter_queue ?? null,
          })),
        },
      });
      for (const w of producers) relate(rid('worker', w), rid('queue', id), 'produces');
      for (const c of consumers) {
        const w = String(c.script ?? c.service ?? '');
        if (workers.has(w)) relate(rid('worker', w), rid('queue', id), 'consumes');
      }
    }
  } catch (error) {
    if (error?.status !== 403) throw error;
    missing.push('Queues Read');
  }

  // Durable Object namespaces: those a Worker in scope binds or defines, and the Worker whose class runs them.
  const doBound = scoped('durable_object_namespace');
  const namespaces = await cf.all(`/accounts/${a}/workers/durable_objects/namespaces`, {
    permission: WORKERS_READ,
  });
  for (const ns of namespaces) {
    const id = rid('durable-object', ns.id);
    // A binding names its namespace by ID, or by class and Worker; without a Worker, the class is its own Worker's.
    const binders = doBound
      .filter(
        ({ worker, b }) =>
          (b.namespace_id ? String(b.namespace_id) === ns.id : false) ||
          (b.class_name === ns.class && String(b.script_name ?? worker) === ns.script),
      )
      .map(({ worker }) => worker);
    const definedHere = workers.has(String(ns.script));
    if (!binders.length && !definedHere) continue;
    add({
      id,
      kind: 'durable-object',
      name: String(ns.name ?? `${ns.script}_${ns.class}`),
      attrs: { class: ns.class ?? null, script: ns.script ?? null, sqlite: Boolean(ns.use_sqlite) },
    });
    for (const w of new Set(binders)) relate(rid('worker', w), id, 'uses');
    if (definedHere) {
      relate(id, rid('worker', String(ns.script)), 'runs-in');
      if (!binders.length) relate(rid('worker', String(ns.script)), id, 'defines');
    }
  }

  // Containers: the applications that belong to a Durable Object namespace in scope. A token without Containers Read
  // skips them.
  const doIds = new Set(
    [...resources.values()].filter((r) => r.kind === 'durable-object').map((r) => r.id.slice('durable-object:'.length)),
  );
  if (doIds.size)
    try {
      const apps = (await cf.get(`/accounts/${a}/containers/applications`, { permission: 'Containers Read' })).result;
      for (const app of apps ?? []) {
        const ns = String(app.durable_objects?.namespace_id ?? '');
        if (!doIds.has(ns)) continue;
        add({
          id: rid('container', app.id),
          kind: 'container',
          name: String(app.name),
          attrs: {
            schedulingPolicy: app.scheduling_policy ?? null,
            instanceType: app.configuration?.instance_type ?? null,
            instances: app.instances ?? null,
            maxInstances: app.max_instances ?? null,
            active: app.health?.instances?.active ?? null,
            assigned: app.health?.instances?.assigned ?? null,
          },
        });
        relate(rid('durable-object', ns), rid('container', app.id), 'runs');
      }
    } catch (error) {
      if (error?.status !== 403) throw error;
      missing.push('Containers Read');
    }

  await serving(workers);
  return done();
}

/**
 * Cloudflare's list prices in US dollars on the Workers Paid plan, as data: each product's prices, the page they're
 * from, and when they were read. Usage beyond what the plan includes is billed at these; what's included is counted
 * across the whole account, so `cost` doesn't take it off any one resource. Update the prices and `read` together.
 */
export const PRICES = {
  currency: 'USD',
  read: '2026-10-06',
  worker: {
    source: 'https://developers.cloudflare.com/workers/platform/pricing/#workers',
    perMillionRequests: 0.3,
    perMillionCpuMs: 0.02,
  },
  durableObject: {
    source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    perMillionRequests: 0.15,
    perMillionGbSeconds: 12.5,
    /** Duration is billed at 128 MB per object while it's active. */
    gbPerObject: 0.125,
    perGbMonth: 0.2,
  },
  d1: {
    source: 'https://developers.cloudflare.com/d1/platform/pricing/',
    perMillionRowsRead: 0.001,
    perMillionRowsWritten: 1,
    perGbMonth: 0.75,
  },
  kv: {
    source: 'https://developers.cloudflare.com/kv/platform/pricing/',
    perMillionReads: 0.5,
    perMillionWrites: 5,
    perMillionDeletes: 5,
    perMillionLists: 5,
    perGbMonth: 0.5,
  },
  r2: {
    source: 'https://developers.cloudflare.com/r2/pricing/',
    standard: { perMillionClassA: 4.5, perMillionClassB: 0.36, perGbMonth: 0.015 },
    infrequentAccess: { perMillionClassA: 9, perMillionClassB: 0.9, perGbMonth: 0.01 },
  },
  queue: {
    source: 'https://developers.cloudflare.com/queues/platform/pricing/',
    perMillionOperations: 0.4,
  },
  container: {
    source: 'https://developers.cloudflare.com/containers/platform/pricing/',
    perGibSecondMemory: 0.0000025,
    perVcpuSecond: 0.00002,
    perGbSecondDisk: 0.00000007,
    /** Memory in GiB and disk in GB for each named instance type; `dev` and `standard` are older names. */
    instanceTypes: {
      lite: { memory: 0.25, disk: 2 },
      dev: { memory: 0.25, disk: 2 },
      basic: { memory: 1, disk: 4 },
      'standard-1': { memory: 4, disk: 8 },
      standard: { memory: 4, disk: 8 },
      'standard-2': { memory: 6, disk: 12 },
      'standard-3': { memory: 8, disk: 16 },
      'standard-4': { memory: 12, disk: 20 },
    },
  },
};

/** R2's free operations; of the rest, Class B reads and anything not listed is priced as Class A, the dearer. */
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
const R2_CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

/** How many days of usage a cost estimate reads, and the month it's scaled to. */
export const COST_WINDOW_DAYS = 7;
const MONTH_DAYS = 30;
const MONTH_SECONDS = MONTH_DAYS * 86_400;
const GB = 1e9;
const M = 1e6;

/** The name a resource has in a dataset: Cloudflare's ID for most kinds, the Worker's or bucket's name for those. */
function usageKey(r) {
  const own = r.id.slice(r.kind.length + 1);
  if (r.kind === 'worker') return r.name;
  if (r.kind === 'r2') {
    const j = r.attrs?.jurisdiction;
    return j && j !== 'default' ? `${j}_${r.name}` : r.name;
  }
  return own;
}

/** A container application's memory in GiB and disk in GB, from its instance type's name or a custom one. */
function instanceSize(type) {
  if (typeof type === 'string') return PRICES.container.instanceTypes[type] ?? null;
  if (type && typeof type === 'object' && Number.isFinite(type.memory_mib) && Number.isFinite(type.disk_mb))
    return { memory: type.memory_mib / 1024, disk: type.disk_mb / 1000 };
  return null;
}

export const round = (n) => Math.round(n * 10_000) / 10_000;

/** What every estimate says, so the owner never reads it as the bill. */
export const COST_NOTE = `Estimated from the last ${COST_WINDOW_DAYS} days of use at Cloudflare’s list prices, before what your plan includes: Cloudflare counts that across the whole account, not by resource, so the bill can be lower.`;

/**
 * Prices one resource from its usage over the window: the amount a month in PRICES.currency, unrounded, and what its
 * note adds. With no usage, a container still costs its active instances' memory and disk; everything else is 0.
 * @param {Resource} r
 * @param {Record<string, number>} [u] its usage, by field (and `field:by` for a dataset grouped by `by`), as
 *   readDataset adds it up
 * @param {number} [scale] turns the window's usage into a month's
 * @returns {{ amount: number, notes: string[] }}
 */
export function priceResource(r, u = {}, scale = MONTH_DAYS / COST_WINDOW_DAYS) {
  const n = (k) => u[k] ?? 0;
  switch (r.kind) {
    case 'worker': {
      const p = PRICES.worker;
      const amount = ((n('requests') * p.perMillionRequests + (n('cpuTimeUs') / 1000) * p.perMillionCpuMs) / M) * scale;
      return { amount, notes: [] };
    }
    case 'durable-object': {
      const p = PRICES.durableObject;
      const gbSeconds = (n('activeTime') / M) * p.gbPerObject;
      const flow = ((n('requests') * p.perMillionRequests + gbSeconds * p.perMillionGbSeconds) / M) * scale;
      return { amount: flow + (n('storedBytes') / GB) * p.perGbMonth, notes: [] };
    }
    case 'd1': {
      const p = PRICES.d1;
      const flow = ((n('rowsRead') * p.perMillionRowsRead + n('rowsWritten') * p.perMillionRowsWritten) / M) * scale;
      return { amount: flow + (n('databaseSizeBytes') / GB) * p.perGbMonth, notes: [] };
    }
    case 'kv': {
      const p = PRICES.kv;
      const ops =
        n('requests:read') * p.perMillionReads +
        n('requests:write') * p.perMillionWrites +
        n('requests:delete') * p.perMillionDeletes +
        n('requests:list') * p.perMillionLists;
      return { amount: (ops / M) * scale + (n('byteCount') / GB) * p.perGbMonth, notes: [] };
    }
    case 'r2': {
      const p = r.attrs?.storageClass === 'InfrequentAccess' ? PRICES.r2.infrequentAccess : PRICES.r2.standard;
      let a = 0;
      let b = 0;
      for (const [k, v] of Object.entries(u)) {
        if (!k.startsWith('requests:')) continue;
        const action = k.slice('requests:'.length);
        if (R2_FREE.has(action)) continue;
        if (R2_CLASS_B.has(action)) b += v;
        else a += v;
      }
      const flow = ((a * p.perMillionClassA + b * p.perMillionClassB) / M) * scale;
      const stored = ((n('payloadSize') + n('metadataSize')) / GB) * p.perGbMonth;
      const notes = r.attrs?.storageClass === 'InfrequentAccess' ? ['Data retrieval isn’t counted.'] : [];
      return { amount: flow + stored, notes };
    }
    case 'queue':
      return { amount: ((n('billableOperations') * PRICES.queue.perMillionOperations) / M) * scale, notes: [] };
    case 'container': {
      const p = PRICES.container;
      const size = instanceSize(r.attrs?.instanceType);
      const active = Number(r.attrs?.active ?? 0) || 0;
      if (!size) return { amount: 0, notes: ['Its instance type isn’t in the price table, so it isn’t counted.'] };
      const perSecond = size.memory * p.perGibSecondMemory + size.disk * p.perGbSecondDisk;
      return {
        amount: active * perSecond * MONTH_SECONDS,
        notes: [
          'Counts memory and disk for the instances running now, all month; CPU isn’t counted, since Cloudflare bills it by use and doesn’t report it per application.',
        ],
      };
    }
    default:
      return { amount: 0, notes: ['No cost of its own: it’s part of its Worker’s.'] };
  }
}

/**
 * Estimates each resource's cost a month, in US dollars (converting is BRK-226's), from the last COST_WINDOW_DAYS
 * of usage in the analytics, scaled to a month, times PRICES; stored data is priced at its most over the window. Every
 * amount is an estimate, and its note says what it leaves out. Uses `ctx.resources` when the store passes what
 * discover just found, and discovers otherwise. A dataset Cloudflare won't answer is left out of the resources it
 * prices, and their notes say so; anything else (a 429, a 403, Cloudflare out of reach) stops the estimate, so the
 * store keeps the last one.
 * @param {ProviderContext} ctx
 * @returns {Promise<import('./infra-provider.js').Cost[]>}
 */
export async function cost(ctx) {
  const resources = ctx.resources ?? (await discover(ctx)).resources;
  if (!resources.length) return [];
  const cf = reader(ctx);
  const account = await accountOf(cf, ctx);
  const to = new Date();
  const from = new Date(to.getTime() - COST_WINDOW_DAYS * 86_400_000);
  const scale = MONTH_DAYS / COST_WINDOW_DAYS;
  /** @type {Map<string, Record<string, number>>} usage by resource ID */
  const usage = new Map(resources.map((r) => [r.id, {}]));
  /** @type {Map<string, string[]>} what each resource's estimate leaves out */
  const left = new Map();

  for (const d of Object.values(COST_DATASETS)) {
    const mine = resources.filter((r) => r.kind === d.kind);
    if (!mine.length) continue;
    const byKey = new Map(mine.map((r) => [usageKey(r), r.id]));
    let found;
    try {
      found = await readDataset(ctx, { account, dataset: d, keys: [...byKey.keys()], from, to });
    } catch (error) {
      if (error?.status !== 400) throw error;
      for (const r of mine) left.set(r.id, [...(left.get(r.id) ?? []), d.label]);
      continue;
    }
    for (const [key, u] of found) Object.assign(/** @type {object} */ (usage.get(byKey.get(key))), u);
  }

  return resources.map((r) => {
    const { amount, notes } = priceResource(r, /** @type {Record<string, number>} */ (usage.get(r.id)), scale);
    const missed = left.get(r.id);
    if (missed) notes.push(`Not counted, since Cloudflare’s analytics didn’t return it: ${missed.join(', ')}.`);
    return {
      resource: r.id,
      amount: round(amount),
      currency: PRICES.currency,
      estimate: /** @type {const} */ (true),
      note: [COST_NOTE, ...notes].join(' '),
    };
  });
}

/**
 * When a resource's health turns: the share of requests that fail before it's degraded or down, how slow a D1 query
 * may be on average, how long a queue's oldest message may wait, and how big a backlog may grow past its recent
 * average before it's degraded.
 */
export const HEALTH_LIMITS = {
  degradedErrors: 0.05,
  downErrors: 0.5,
  slowQueryMs: 1000,
  staleQueueMinutes: 15,
  growingBacklog: 1000,
};

const MINUTE = 60_000;
const pct = (n) => `${Math.round(n * 100)}%`;
/** A health window in words: "in the last 15 minutes", "in the last hour", "in the last day". */
const sinceWords = (minutes) =>
  minutes === 60 ? 'in the last hour' : minutes === 24 * 60 ? 'in the last day' : `in the last ${minutes} minutes`;

/**
 * Health from requests and the ones that failed over a window: idle with none (BRK-266: deployed, no traffic, no
 * errors seen), then by HEALTH_LIMITS.
 */
function byErrors(requests, errors, since, noun = 'requests', alive = '') {
  if (!requests) return { state: 'idle', text: `Idle: no ${noun} ${since}${alive}` };
  const share = errors / requests;
  const said = `${pct(share)} of ${requests} ${noun} failed ${since}`;
  if (share >= HEALTH_LIMITS.downErrors) return { state: 'down', text: said };
  if (share >= HEALTH_LIMITS.degradedErrors) return { state: 'degraded', text: said };
  return { state: 'healthy', text: `${requests} ${noun}, ${errors} failed, ${since}` };
}

/**
 * One resource's health from what the analytics and the APIs said. A quiet resource is idle, never unknown: discover
 * just found it, which is the metadata read that says it exists, and a Worker's deployment says it serves (BRK-266).
 * Unknown is only for what the board couldn't read, and says which call.
 * @param {Resource} r
 * @param {Record<string, number> | undefined} u its usage over the window
 * @param {{ result?: any, refused?: string, missing?: boolean } | undefined} backlog a queue's backlog now, or why not
 * @param {number} now
 * @param {number} minutes the window its usage came from
 * @returns {{ state: string, text: string }}
 */
function judge(r, u = {}, backlog, now, minutes = HEALTH_WINDOW_MINUTES) {
  const n = (k) => Number(u[k] ?? 0) || 0;
  const attrs = /** @type {Record<string, any>} */ (r.attrs ?? {});
  const since = sinceWords(minutes);
  switch (r.kind) {
    case 'worker': {
      if (Array.isArray(attrs.versions) && attrs.versions.length === 0)
        return { state: 'down', text: 'No deployment: it serves nothing' };
      const live = Array.isArray(attrs.versions)
        ? attrs.versions.reduce((sum, v) => sum + (Number(v?.percentage) || 0), 0)
        : 0;
      return byErrors(n('requests'), n('errors'), since, 'requests', live >= 100 ? '; deployed and serving' : '');
    }
    case 'durable-object':
      return byErrors(n('requests'), n('errors'), since);
    case 'r2': {
      let all = 0;
      let failed = 0;
      for (const [k, v] of Object.entries(u)) {
        if (!k.startsWith('requests:')) continue;
        all += v;
        if (Number(k.slice('requests:'.length)) >= 500) failed += v;
      }
      return byErrors(all, failed, since, 'operations');
    }
    case 'd1': {
      const queries = n('readQueries') + n('writeQueries');
      if (!queries) return { state: 'idle', text: `Idle: no queries ${since}` };
      const ms = Math.round(n('queryBatchTimeMs'));
      if (ms > HEALTH_LIMITS.slowQueryMs)
        return { state: 'degraded', text: `Queries took ${ms} ms on average ${since}` };
      return { state: 'healthy', text: `${queries} queries, ${ms} ms on average, ${since}` };
    }
    case 'kv':
      return n('requests')
        ? { state: 'healthy', text: `${n('requests')} operations ${since}` }
        : { state: 'idle', text: `Idle: no operations ${since}` };
    case 'queue': {
      if (attrs.deliveryPaused) return { state: 'degraded', text: 'Delivery is paused' };
      const consumers = Array.isArray(attrs.consumers) ? attrs.consumers : null;
      if (consumers && consumers.length === 0)
        return { state: 'degraded', text: 'No consumer is attached, so nothing reads its messages' };
      if (backlog?.refused) return { state: 'unknown', text: backlog.refused };
      if (!backlog?.result)
        return {
          state: 'idle',
          text: consumers
            ? 'Idle: a consumer is attached, and Cloudflare has no backlog figures for it'
            : 'Idle: Cloudflare has no backlog figures for it',
        };
      const count = Number(backlog.result.backlog_count ?? 0) || 0;
      const oldest = Number(backlog.result.oldest_message_timestamp_ms ?? 0) || 0;
      const waited = count && oldest ? Math.floor((now - oldest) / MINUTE) : 0;
      if (waited > HEALTH_LIMITS.staleQueueMinutes)
        return { state: 'degraded', text: `The oldest message has waited ${waited} minutes; ${count} in the backlog` };
      const usual = Math.round(n('messages'));
      if (count >= HEALTH_LIMITS.growingBacklog && count > 2 * usual)
        return { state: 'degraded', text: `The backlog is growing: ${count} now, about ${usual} ${since}` };
      return { state: 'healthy', text: `${count} in the backlog` };
    }
    case 'container': {
      const active = attrs.active;
      const assigned = attrs.assigned;
      if (typeof active !== 'number' || typeof assigned !== 'number')
        return {
          state: 'unknown',
          text: 'Cloudflare gave no instance counts when its application was read (GET …/containers/applications): try again at the next refresh',
        };
      if (assigned === 0 && active === 0) return { state: 'idle', text: 'Idle: no instances are assigned' };
      if (assigned > 0 && active === 0) return { state: 'down', text: `None of ${assigned} instances is running` };
      if (active < assigned) return { state: 'degraded', text: `${active} of ${assigned} instances are running` };
      return { state: 'healthy', text: `${active} of ${assigned} instances are running` };
    }
    default:
      return { state: 'unknown', text: 'Cloudflare reports no health for its kind' };
  }
}

/**
 * Each resource's health now (BRK-188's "Observe" rows; BRK-266): errors and slowness from the analytics, one query
 * per dataset for the whole environment, over a window that ends HEALTH_LAG_MINUTES back, since Cloudflare's analytics
 * arrive late. A resource with no traffic in the first of HEALTH_WINDOWS is read again over the next (an hour, then a
 * day) before it's idle, and its text names the window its verdict came from. A queue's backlog now; a container
 * application's instance counts as discover found them; and a route's or custom domain's from the Worker it serves.
 *
 * Unknown only when the board couldn't read: a dataset Cloudflare won't answer, or a queue's backlog the token may not
 * read, says which call and what to do, and the store keeps the last health with its age. A longer window Cloudflare
 * won't answer only stops the fallback. Anything else (a 429, a 403 on the analytics, Cloudflare out of reach) stops
 * it, so the store keeps the last health. Uses `ctx.resources` when the store passes what discover just found, and
 * discovers otherwise.
 * @param {ProviderContext} ctx
 * @returns {Promise<import('./infra-provider.js').Health[]>}
 */
export async function observe(ctx) {
  const resources = ctx.resources ?? (await discover(ctx)).resources;
  if (!resources.length) return [];
  const cf = reader(ctx);
  const account = await accountOf(cf, ctx);
  const now = Date.now();
  const to = new Date(now - HEALTH_LAG_MINUTES * MINUTE);
  /** @type {Map<string, Record<string, number>>} usage by resource ID */
  const usage = new Map();
  /** @type {Map<string, number>} the window each resource's verdict comes from, in minutes */
  const windowOf = new Map();
  /** @type {Map<string, string>} what the analytics didn't answer, by resource ID */
  const unread = new Map();
  for (const d of Object.values(HEALTH_DATASETS)) {
    const mine = resources.filter((r) => r.kind === d.kind);
    if (!mine.length) continue;
    const byKey = new Map(mine.map((r) => [usageKey(r), r.id]));
    let quiet = [...byKey.keys()];
    for (const [i, minutes] of (d.busy ? HEALTH_WINDOWS : HEALTH_WINDOWS.slice(0, 1)).entries()) {
      if (!quiet.length) break;
      const from = new Date(to.getTime() - minutes * MINUTE);
      let found;
      try {
        found = await readDataset(ctx, { account, dataset: d, keys: quiet, from, to });
      } catch (error) {
        if (error?.status !== 400) throw error;
        // The first window unanswered leaves them unread; a longer one only stops looking further back.
        if (i === 0)
          for (const r of mine)
            unread.set(
              r.id,
              `Couldn’t read its health: Cloudflare’s analytics didn’t answer for its ${d.label} (${d.dataset}). The last health is kept; if it lasts, check the token has Account Analytics Read`,
            );
        break;
      }
      for (const key of quiet) windowOf.set(/** @type {string} */ (byKey.get(key)), minutes);
      for (const [key, u] of found) usage.set(/** @type {string} */ (byKey.get(key)), u);
      quiet = d.busy ? quiet.filter((key) => !d.busy?.(found.get(key) ?? {})) : [];
    }
  }
  /** @type {Map<string, { result?: any, refused?: string }>} a queue's backlog now, or why it couldn't be read */
  const backlogs = new Map();
  for (const r of resources.filter((q) => q.kind === 'queue')) {
    const path = `/accounts/${enc(account)}/queues/${enc(r.id.slice('queue:'.length))}/metrics`;
    try {
      const json = await cf.get(path, { permission: 'Queues Read', missingOk: true });
      backlogs.set(r.id, json?.result ? { result: json.result } : {});
    } catch (error) {
      if (error?.status !== 403) throw error;
      backlogs.set(r.id, {
        refused:
          'Couldn’t read its backlog: Cloudflare refused GET …/queues/<id>/metrics. Give the read-only token Queues Read on Connections',
      });
    }
  }

  /** @type {Map<string, { state: string, text: string }>} */
  const health = new Map();
  for (const r of resources) {
    if (r.kind === 'route' || r.kind === 'custom-domain') continue;
    const said = unread.get(r.id);
    health.set(
      r.id,
      said
        ? { state: 'unknown', text: said }
        : judge(r, usage.get(r.id), backlogs.get(r.id), now, windowOf.get(r.id) ?? HEALTH_WINDOW_MINUTES),
    );
  }
  for (const r of resources) {
    if (r.kind !== 'route' && r.kind !== 'custom-domain') continue;
    const worker = String(/** @type {any} */ (r.attrs ?? {}).worker ?? '');
    const its = health.get(rid('worker', worker));
    health.set(
      r.id,
      its
        ? { state: its.state, text: `Its Worker, ${worker}: ${its.text}` }
        : { state: 'unknown', text: 'Its Worker isn’t in this environment, so the board can’t read its health' },
    );
  }
  const at = new Date(now).toISOString();
  return resources.map((r) => {
    const h = /** @type {{ state: string, text: string }} */ (health.get(r.id));
    return { resource: r.id, state: h.state, at, text: h.text };
  });
}

/**
 * A Cloudflare alert, cut down to what places it: its name, when it fired, and the Worker, zone, or hostname it names.
 * Everything else (its text, the rest of its data, account and policy IDs) is left out. The board's alert webhook
 * (src/store-routines.js) and the alert history (`events`) both read alerts with this, so an alert heard both ways
 * reads the same. `zoneId` is only for finding the zone's name; it's never stored.
 * @param {any} body a notification webhook's body, or an alert history entry's `alert_body`
 * @returns {{ alert: string | null, at: string | null, worker: string | null, zone: string | null,
 *   zoneId: string | null, hostname: string | null }}
 */
export function alertFields(body) {
  const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
  const first = (v) => (Array.isArray(v) ? v.find((x) => typeof x === 'string') : v);
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
  const ts = Number(body?.ts);
  const at =
    Number.isFinite(ts) && ts > 0
      ? new Date(ts < 1e11 ? ts * 1000 : ts)
      : new Date(pick(body?.timestamp, body?.time) ?? Number.NaN);
  const host = pick(data.hostname, data.host, data.domain, first(data.hostnames), first(data.hosts));
  return {
    alert: pick(body?.alert_name, body?.policy_name, body?.name, body?.alert_type),
    at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    worker: pick(data.script_name, data.worker_name, data.worker, data.service, data.script),
    zone: pick(data.zone_name, data.zone)?.toLowerCase() ?? null,
    zoneId: pick(data.zone_tag, data.zone_id),
    hostname: host ? host.toLowerCase().replace(/^\*\./u, '').replace(/\.$/u, '') : null,
  };
}

/** An alert signal's text: the alert's name and what it's on (a Worker, a zone, or a hostname). */
export function alertText(alert, on) {
  const name = String(alert ?? '').slice(0, 200) || 'unnamed alert';
  return `Cloudflare alert: ${name}${on ? ` on ${String(on).slice(0, 100)}` : ''}`;
}

/** The zones an environment's resources use: the zone of each of its routes and custom domains. */
export function zonesOf(resources) {
  const zones = new Set();
  for (const r of resources ?? []) {
    if (r.kind !== 'route' && r.kind !== 'custom-domain') continue;
    const zone = /** @type {any} */ (r.attrs)?.zone;
    if (typeof zone === 'string' && zone) zones.add(zone.toLowerCase());
  }
  return zones;
}

/**
 * Where an alert goes in one environment (BRK-255), from its fields and the environment's resources: on the Worker it
 * names when that Worker is the environment's; on the whole environment when the zone it names (or its hostname's
 * zone) is one the environment's routes or custom domains use; `account` when it names no Worker, zone, or hostname
 * (it's about the account or the platform, and the board keeps one per provider, not one per environment); or null
 * when it's another environment's, or no environment's.
 *
 * With `elsewhere`, the resources of the provider's other environments, an alert naming a zone or hostname that
 * neither this environment nor any other uses is `account` too (BRK-256), still on that zone or hostname, rather than
 * nobody's. A zone named only by its ID, which nothing here can name, stays nobody's.
 * @param {ReturnType<typeof alertFields>} fields
 * @param {Array<{ kind: string, name: string, attrs?: Record<string, unknown> }>} resources
 * @param {Array<{ kind: string, name: string, attrs?: Record<string, unknown> }>} [elsewhere]
 * @returns {{ resource: string | null, account: boolean, on: string | null } | null}
 */
export function alertPlace(fields, resources, elsewhere) {
  if (fields.worker) {
    const mine = (resources ?? []).some((r) => r.kind === 'worker' && r.name === fields.worker);
    return mine ? { resource: rid('worker', fields.worker), account: false, on: fields.worker } : null;
  }
  if (!fields.zone && !fields.hostname && !fields.zoneId) return { resource: null, account: true, on: null };
  const on = fields.hostname ?? fields.zone;
  if (zoneUsed(fields, resources)) return { resource: null, account: false, on };
  if (elsewhere && on && !zoneUsed(fields, elsewhere)) return { resource: null, account: true, on };
  return null;
}

/** Whether the zone an alert names, or its hostname's zone, is one that `resources`' routes or custom domains use. */
function zoneUsed(fields, resources) {
  const zones = zonesOf(resources);
  const host = fields.hostname;
  return Boolean(
    (fields.zone && zones.has(fields.zone)) || (host && [...zones].some((z) => host === z || host.endsWith(`.${z}`))),
  );
}

/**
 * The account's alerts since `since`, from its alert history (`GET …/alerting/v3/history`, Notifications Read), as
 * `alert` signals placed by `alertPlace` (BRK-255): on the Worker it names when that Worker is in the environment, on
 * the whole environment when it names a zone or hostname the environment uses, and marked `account` when it names
 * none of them, or (given `ctx.elsewhere`, BRK-256) a zone or hostname no environment uses; an alert about another
 * environment's Worker or zone is left out. A zone named only by its ID is looked up in the account's zones (Zone
 * Read). Oldest first. The board's alert webhook reports the same alerts as they fire; the store keeps one of each, and
 * one of each account-wide alert across the provider's environments.
 * @param {ProviderContext} ctx
 * @param {string} since ISO 8601
 * @returns {Promise<import('./infra-provider.js').Signal[]>}
 */
export async function events(ctx, since) {
  const from = Date.parse(since);
  if (Number.isNaN(from)) throw new Error('cloudflare events needs a time to read since, in ISO 8601');
  const now = Date.now();
  if (from > now) return [];
  const resources = ctx.resources ?? (await discover(ctx)).resources;
  const cf = reader(ctx);
  const account = await accountOf(cf, ctx);
  const a = enc(account);
  const window = `since=${enc(new Date(from).toISOString())}&before=${enc(new Date(now).toISOString())}`;
  const history = await cf.all(`/accounts/${a}/alerting/v3/history?${window}`, { permission: 'Notifications Read' });
  /** @type {Map<string, string> | null} zone names by ID, read only when an alert names a zone by its ID alone */
  let zoneNames = null;
  const zoneName = async (id) => {
    if (!zoneNames) {
      zoneNames = new Map();
      try {
        for (const z of await cf.all(`/zones?account.id=${a}`, { permission: 'Zone Read' }, 50))
          zoneNames.set(String(z.id), String(z.name).toLowerCase());
      } catch (error) {
        if (error?.status !== 403) throw error;
      }
    }
    return zoneNames.get(id) ?? null;
  };
  /** @type {import('./infra-provider.js').Signal[]} */
  const signals = [];
  for (const entry of history) {
    let body = entry?.alert_body;
    if (typeof body === 'string')
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    const fields = alertFields(body);
    const at = fields.at ?? (Number.isNaN(Date.parse(entry?.sent)) ? null : new Date(entry.sent).toISOString());
    if (!at || Date.parse(at) < from) continue;
    if (!fields.worker && !fields.zone && !fields.hostname && fields.zoneId)
      fields.zone = await zoneName(fields.zoneId);
    const place = alertPlace(fields, resources, ctx.elsewhere);
    if (!place) continue;
    signals.push({
      source: 'cloudflare',
      environment: ctx.environment,
      resource: place.resource,
      kind: 'alert',
      level: 'warning',
      value: null,
      at,
      text: alertText(fields.alert ?? entry?.name ?? entry?.alert_type, place.on),
      ...(place.account ? { account: true } : {}),
    });
  }
  return signals.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** The routine a webhook's URL fires on the board, or null when it points anywhere else. */
function boardRoutine(url, board) {
  try {
    const u = new URL(String(url));
    if (!board.includes(u.origin)) return null;
    return /^\/api\/routines\/([a-z][a-z0-9-]{0,39})\/fire\/?$/u.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which alerts reach the board (BRK-188, "Alerts"): the alert types the account can have (`available_alerts`), its
 * policies (on or off, and whether one sends to a webhook that fires a routine on the board), and how many webhooks
 * point at the board. Reads only, with Notifications Read: setting up a policy or a webhook is the owner's, in
 * Cloudflare's dashboard. Keeps no address: a webhook's URL is only matched against `board`, and a policy's email or
 * other destinations aren't read.
 * @param {ProviderContext} ctx
 * @param {{ board?: string[] }} [options] the board's own https origins
 */
export async function alertSetup(ctx, { board = [] } = {}) {
  const cf = reader(ctx);
  const a = enc(await accountOf(cf, ctx));
  const opts = { permission: 'Notifications Read' };
  const available = (await cf.get(`/accounts/${a}/alerting/v3/available_alerts`, opts)).result ?? {};
  const policies = (await cf.get(`/accounts/${a}/alerting/v3/policies`, opts)).result ?? [];
  const webhooks = (await cf.get(`/accounts/${a}/alerting/v3/destinations/webhooks`, opts)).result ?? [];
  /** @type {Map<string, string>} the routine each webhook to the board fires, by the webhook's ID */
  const toBoard = new Map();
  for (const w of Array.isArray(webhooks) ? webhooks : []) {
    const slug = boardRoutine(w?.url, board);
    if (slug) toBoard.set(String(w.id), slug);
  }
  const shown = (Array.isArray(policies) ? policies : []).map((p) => {
    const routines = [
      ...new Set(
        (p?.mechanisms?.webhooks ?? [])
          .map((m) => toBoard.get(String(m?.id)))
          .filter((slug) => typeof slug === 'string'),
      ),
    ];
    return {
      name: String(p?.name ?? '').slice(0, 200),
      alertType: String(p?.alert_type ?? ''),
      enabled: Boolean(p?.enabled),
      reachesBoard: Boolean(p?.enabled) && routines.length > 0,
      routines,
    };
  });
  const types =
    available && typeof available === 'object'
      ? Object.entries(available).flatMap(([product, list]) =>
          (Array.isArray(list) ? list : []).map((t) => ({
            type: String(t?.type ?? ''),
            name: String(t?.display_name ?? t?.type ?? '').slice(0, 200),
            product: String(product).slice(0, 100),
          })),
        )
      : [];
  return {
    alerts: types.map((t) => {
      const mine = shown.filter((p) => p.alertType === t.type);
      return { ...t, policies: mine.length, reachesBoard: mine.some((p) => p.reachesBoard) };
    }),
    policies: shown,
    webhooks: { toBoard: toBoard.size, other: (Array.isArray(webhooks) ? webhooks.length : 0) - toBoard.size },
  };
}

/**
 * Asks Cloudflare whether a pasted token works (BRK-194): a user token answers on /user/tokens/verify, an account
 * token on its account's. Cloudflare doesn't list a token's permissions, so the board keeps the ones it asked for.
 * @param {{ token: string, fetch?: typeof fetch }} input
 * @returns {Promise<import('./infra-provider.js').TokenCheck>}
 */
export async function checkToken({ token, fetch: doFetch = fetch }) {
  const ask = async (path) => {
    const res = await doFetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: /** @type {any} */ (await res.json().catch(() => null)) };
  };
  try {
    const user = await ask('/user/tokens/verify');
    if (user.status === 200 && user.json?.result?.status === 'active') return { ok: true };
    const accounts = await ask('/accounts?per_page=50');
    const list = Array.isArray(accounts.json?.result) ? accounts.json.result : [];
    if (list.length === 1) {
      const account = await ask(`/accounts/${enc(list[0].id)}/tokens/verify`);
      if (account.status === 200 && account.json?.result?.status === 'active') return { ok: true };
      return { ok: false, error: said(account.json) || `Cloudflare answered ${account.status}` };
    }
    if (list.length > 1) return { ok: false, error: 'it reaches more than one account: make it for one account' };
    return { ok: false, error: said(user.json) || said(accounts.json) || `Cloudflare answered ${user.status}` };
  } catch (error) {
    return { ok: false, error: `couldn’t reach Cloudflare (${String(error?.message ?? error).slice(0, 100)})` };
  }
}

/** @type {Provider} */
export const cloudflare = {
  id: 'cloudflare',
  name: 'Cloudflare',
  kinds: CLOUDFLARE_KINDS,
  readToken: {
    permissions: READ_PERMISSIONS,
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    check: checkToken,
    template: tokenTemplate,
  },
  writeToken: { secret: WRITE_SECRET, permissions: writePermissions, template: tokenTemplate },
  refuses,
  outside,
  editable,
  creatable,
  discover,
  plan: (ctx, desired) => plan(ctx, desired),
  apply: (ctx, p) => apply(ctx, p),
  estimate: (ctx, change) => estimate(ctx, change),
  observe,
  cost,
  events,
  alerts: alertSetup,
};
