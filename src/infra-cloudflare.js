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
 * Observe (BRK-191) reads each resource's health from the same analytics over the last few minutes, plus a queue's
 * backlog and a container application's instance counts; a route or custom domain takes its Worker's health. Events
 * (BRK-191) reads the account's alert history and reports each alert as a signal on the Worker it names, the same way
 * the board's alert webhook does (`alertFields`), and `alertSetup` reads which alerts are set up and which reach the
 * board. Alerts need Notifications Read; the token never has Notifications Write. Pure apart from `fetch`, so the CLI
 * can import it.
 */
import { COST_DATASETS, HEALTH_DATASETS, HEALTH_WINDOW_MINUTES, readDataset } from './infra-cloudflare-analytics.js';
import { apply, estimate, plan } from './infra-cloudflare-plan.js';

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
    },
  ]),
);

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
 * Paths discover must never call: a KV value, an R2 object, or a Worker's code (BRK-188). Every call is checked against
 * these before it's made, so a bug can't turn a read of settings into a read of data.
 */
export const NEVER_CALLED = [
  /\/storage\/kv\/namespaces\/[^/]+\/(values|keys|bulk)/u,
  /\/r2\/buckets\/[^/]+\/objects/u,
  /\/workers\/scripts\/[^/]+\/content/u,
  /\/workers\/scripts\/[^/]+$/u,
  /\/versions\/[^/?]+\?.*include=modules/u,
  /\/secrets\/[^/]+$/u,
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
    if (res.status === 403)
      throw Object.assign(
        new CloudflareError(`Cloudflare refused GET ${path.split('?')[0]}: the token needs ${named(permission)}`, 403),
        { permission },
      );
    if (!res.ok || json?.success === false)
      throw new CloudflareError(
        `Cloudflare answered ${res.status} to GET ${path.split('?')[0]}${said(json) ? `: ${said(json)}` : ''}`,
        res.status,
      );
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
    bindings: (settings.bindings ?? [])
      .map((b) => ({ name: String(b.name), type: String(b.type) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
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
 */

/**
 * Discovers what the environment's target Worker runs on, as resources and relations. `missing` names a permission
 * the token lacks for a kind a repository may leave out (queues, containers): that kind isn't read, and discovery goes
 * on (BRK-188, "Tokens"). With `live`, it also returns the LiveAccount plan and apply work from.
 * @param {ProviderContext} ctx
 * @param {{ live?: boolean }} [options]
 * @returns {Promise<Discovery & { missing: string[], live?: LiveAccount }>}
 */
export async function discover(ctx, { live = false } = {}) {
  const target = typeof ctx.scope?.target === 'string' ? ctx.scope.target : null;
  /** @type {Map<string, Resource>} */
  const resources = new Map();
  /** @type {Map<string, Relation>} */
  const relations = new Map();
  /** @type {string[]} */
  const missing = [];
  /** @type {LiveAccount} */
  const seen = { account: '', scripts: [], bindings: {}, zones: {} };
  const add = (r) => resources.set(r.id, r);
  const relate = (from, to, kind) => relations.set(`${from} ${kind} ${to}`, { from, to, kind });
  const done = () => ({
    resources: [...resources.values()],
    relations: [...relations.values()].filter((r) => resources.has(r.from) && resources.has(r.to)),
    missing,
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
  if (!scripts.has(target)) return done();

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

  // Routes, on the zones the token reaches, that send to a Worker in scope.
  const zones = await cf.all(`/zones?account.id=${a}`, { permission: 'Zone Read' }, 50);
  for (const zone of zones) {
    seen.zones[String(zone.name)] = String(zone.id);
    const routes =
      (await cf.get(`/zones/${enc(zone.id)}/workers/routes`, { permission: 'Workers Routes Read' })).result ?? [];
    for (const route of routes) {
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

  // Custom domains attached to a Worker in scope.
  const domains = (await cf.get(`/accounts/${a}/workers/domains`, { permission: WORKERS_READ })).result ?? [];
  for (const d of domains) {
    if (!workers.has(String(d.service))) continue;
    add({
      id: rid('custom-domain', d.id),
      kind: 'custom-domain',
      name: String(d.hostname),
      attrs: { zone: d.zone_name ?? null, environment: d.environment ?? null, worker: String(d.service) },
    });
    relate(rid('worker', String(d.service)), rid('custom-domain', d.id), 'serves');
  }

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
const since = `in the last ${HEALTH_WINDOW_MINUTES} minutes`;

/** Health from requests and the ones that failed: unknown with no requests, then by HEALTH_LIMITS. */
function byErrors(requests, errors, noun = 'requests') {
  if (!requests) return { state: 'unknown', text: `No ${noun} ${since}` };
  const share = errors / requests;
  const said = `${pct(share)} of ${requests} ${noun} failed ${since}`;
  if (share >= HEALTH_LIMITS.downErrors) return { state: 'down', text: said };
  if (share >= HEALTH_LIMITS.degradedErrors) return { state: 'degraded', text: said };
  return { state: 'healthy', text: `${requests} ${noun}, ${errors} failed, ${since}` };
}

/**
 * One resource's health from what the analytics and the APIs said.
 * @param {Resource} r
 * @param {Record<string, number> | undefined} u its usage over the window
 * @param {{ backlog_count?: number, oldest_message_timestamp_ms?: number } | undefined} backlog a queue's, now
 * @param {number} now
 * @returns {{ state: string, text: string }}
 */
function judge(r, u = {}, backlog, now) {
  const n = (k) => Number(u[k] ?? 0) || 0;
  const attrs = /** @type {Record<string, any>} */ (r.attrs ?? {});
  switch (r.kind) {
    case 'worker':
      if (Array.isArray(attrs.versions) && attrs.versions.length === 0)
        return { state: 'down', text: 'No deployment: it serves nothing' };
      return byErrors(n('requests'), n('errors'));
    case 'durable-object':
      return byErrors(n('requests'), n('errors'));
    case 'r2': {
      let all = 0;
      let failed = 0;
      for (const [k, v] of Object.entries(u)) {
        if (!k.startsWith('requests:')) continue;
        all += v;
        if (Number(k.slice('requests:'.length)) >= 500) failed += v;
      }
      return byErrors(all, failed, 'operations');
    }
    case 'd1': {
      const queries = n('readQueries') + n('writeQueries');
      if (!queries) return { state: 'unknown', text: `No queries ${since}` };
      const ms = Math.round(n('queryBatchTimeMs'));
      if (ms > HEALTH_LIMITS.slowQueryMs)
        return { state: 'degraded', text: `Queries took ${ms} ms on average ${since}` };
      return { state: 'healthy', text: `${queries} queries, ${ms} ms on average, ${since}` };
    }
    case 'kv':
      return n('requests')
        ? { state: 'healthy', text: `${n('requests')} operations ${since}` }
        : { state: 'unknown', text: `No operations ${since}` };
    case 'queue': {
      if (attrs.deliveryPaused) return { state: 'degraded', text: 'Delivery is paused' };
      if (!backlog) return { state: 'unknown', text: 'Its backlog couldn’t be read' };
      const count = Number(backlog.backlog_count ?? 0) || 0;
      const oldest = Number(backlog.oldest_message_timestamp_ms ?? 0) || 0;
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
        return { state: 'unknown', text: 'Its instance counts aren’t known' };
      if (assigned > 0 && active === 0) return { state: 'down', text: `None of ${assigned} instances is running` };
      if (active < assigned) return { state: 'degraded', text: `${active} of ${assigned} instances are running` };
      return { state: 'healthy', text: `${active} of ${assigned} instances are running` };
    }
    default:
      return { state: 'unknown', text: 'Cloudflare reports no health for it' };
  }
}

/**
 * Each resource's health now (BRK-188's "Observe" rows): errors and slowness over the last HEALTH_WINDOW_MINUTES from
 * the analytics, one query per dataset for the whole environment; a queue's backlog now; a container application's
 * instance counts as discover found them; and a route's or custom domain's from the Worker it serves. A dataset
 * Cloudflare won't answer leaves its resources unknown, saying so; anything else (a 429, a 403, Cloudflare out of
 * reach) stops it, so the store keeps the last health. Uses `ctx.resources` when the store passes what discover just
 * found, and discovers otherwise.
 * @param {ProviderContext} ctx
 * @returns {Promise<import('./infra-provider.js').Health[]>}
 */
export async function observe(ctx) {
  const resources = ctx.resources ?? (await discover(ctx)).resources;
  if (!resources.length) return [];
  const cf = reader(ctx);
  const account = await accountOf(cf, ctx);
  const now = Date.now();
  const to = new Date(now);
  const from = new Date(now - HEALTH_WINDOW_MINUTES * MINUTE);
  /** @type {Map<string, Record<string, number>>} usage by resource ID */
  const usage = new Map();
  /** @type {Map<string, string>} what the analytics didn't answer, by resource ID */
  const unread = new Map();
  for (const d of Object.values(HEALTH_DATASETS)) {
    const mine = resources.filter((r) => r.kind === d.kind);
    if (!mine.length) continue;
    const byKey = new Map(mine.map((r) => [usageKey(r), r.id]));
    let found;
    try {
      found = await readDataset(ctx, { account, dataset: d, keys: [...byKey.keys()], from, to });
    } catch (error) {
      if (error?.status !== 400) throw error;
      for (const r of mine) unread.set(r.id, d.label);
      continue;
    }
    for (const [key, u] of found) usage.set(/** @type {string} */ (byKey.get(key)), u);
  }
  /** @type {Map<string, any>} a queue's backlog now, by resource ID */
  const backlogs = new Map();
  for (const r of resources.filter((q) => q.kind === 'queue')) {
    const path = `/accounts/${enc(account)}/queues/${enc(r.id.slice('queue:'.length))}/metrics`;
    try {
      const json = await cf.get(path, { permission: 'Queues Read', missingOk: true });
      if (json?.result) backlogs.set(r.id, json.result);
    } catch (error) {
      if (error?.status !== 403) throw error;
    }
  }

  /** @type {Map<string, { state: string, text: string }>} */
  const health = new Map();
  for (const r of resources) {
    if (r.kind === 'route' || r.kind === 'custom-domain') continue;
    const label = unread.get(r.id);
    health.set(
      r.id,
      label
        ? { state: 'unknown', text: `Cloudflare’s analytics didn’t answer for its ${label}` }
        : judge(r, usage.get(r.id), backlogs.get(r.id), now),
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
        : { state: 'unknown', text: 'Its Worker isn’t in this environment' },
    );
  }
  const at = to.toISOString();
  return resources.map((r) => {
    const h = /** @type {{ state: string, text: string }} */ (health.get(r.id));
    return { resource: r.id, state: h.state, at, text: h.text };
  });
}

/**
 * A Cloudflare alert, cut down to three fields: its name, when it fired, and the Worker it names. Everything else
 * (its text, data, account and policy IDs) is left out. The board's alert webhook (src/store-routines.js) and the
 * alert history (`events`) both read alerts with this, so an alert heard both ways reads the same.
 * @param {any} body a notification webhook's body, or an alert history entry's `alert_body`
 * @returns {{ alert: string | null, at: string | null, worker: string | null }}
 */
export function alertFields(body) {
  const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim()) ?? null;
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
  const ts = Number(body?.ts);
  const at =
    Number.isFinite(ts) && ts > 0
      ? new Date(ts < 1e11 ? ts * 1000 : ts)
      : new Date(pick(body?.timestamp, body?.time) ?? Number.NaN);
  return {
    alert: pick(body?.alert_name, body?.policy_name, body?.name, body?.alert_type),
    at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    worker: pick(data.script_name, data.worker_name, data.worker, data.service, data.script),
  };
}

/** An alert signal's text: the alert's name and the Worker it names. */
export function alertText(alert, worker) {
  const name = String(alert ?? '').slice(0, 200) || 'unnamed alert';
  return `Cloudflare alert: ${name}${worker ? ` on ${String(worker).slice(0, 100)}` : ''}`;
}

/**
 * The account's alerts since `since`, from its alert history (`GET …/alerting/v3/history`, Notifications Read), as
 * `alert` signals: each on the Worker it names when that Worker is in the environment, or on the whole environment
 * when it names none; an alert about a Worker outside the environment is another environment's. Oldest first. The
 * board's alert webhook reports the same alerts as they fire; the store keeps one of each.
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
  const workers = new Set(resources.filter((r) => r.kind === 'worker').map((r) => r.name));
  const cf = reader(ctx);
  const a = enc(await accountOf(cf, ctx));
  const window = `since=${enc(new Date(from).toISOString())}&before=${enc(new Date(now).toISOString())}`;
  const history = await cf.all(`/accounts/${a}/alerting/v3/history?${window}`, { permission: 'Notifications Read' });
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
    if (fields.worker && !workers.has(fields.worker)) continue;
    signals.push({
      source: 'cloudflare',
      environment: ctx.environment,
      resource: fields.worker ? rid('worker', fields.worker) : null,
      kind: 'alert',
      level: 'warning',
      value: null,
      at,
      text: alertText(fields.alert ?? entry?.name ?? entry?.alert_type, fields.worker),
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
  },
  refuses,
  discover,
  plan: (ctx, desired) => plan(ctx, desired),
  apply: (ctx, p) => apply(ctx, p),
  estimate: (ctx, change) => estimate(ctx, change),
  observe,
  cost,
  events,
  alerts: alertSetup,
};
