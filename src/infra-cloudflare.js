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
 * Plan and apply (BRK-192), observe and events (BRK-191), and cost (BRK-193) aren't built yet: each says so, naming
 * its task, and the store keeps the last health and cost when one fails. Pure apart from `fetch`, so the CLI can
 * import it.
 */
import { checkApply } from './infra-provider.js';

/** @typedef {import('./infra-provider.js').Provider} Provider */
/** @typedef {import('./infra-provider.js').ProviderContext} ProviderContext */
/** @typedef {import('./infra-provider.js').Resource} Resource */
/** @typedef {import('./infra-provider.js').Relation} Relation */
/** @typedef {import('./infra-provider.js').Discovery} Discovery */

export const API = 'https://api.cloudflare.com/client/v4';

const BASE = ['create', 'update', 'delete'];
/** BRK-227 adds `scale` to queues and `scale` and `restart` to containers. */
export const CLOUDFLARE_KINDS = Object.fromEntries(
  ['worker', 'durable-object', 'd1', 'kv', 'r2', 'queue', 'container', 'route', 'custom-domain'].map((k) => [
    k,
    { changes: [...BASE] },
  ]),
);

/**
 * The board's read-only token (BRK-188, "Tokens"; BRK-194 keeps it). Read only: no permission ends in Edit or Write.
 * @type {import('./infra-provider.js').ReadToken['permissions']}
 */
export const READ_PERMISSIONS = [
  { name: 'Workers Scripts Read', for: 'Workers, their settings, deployments, secret names, and cron triggers' },
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
function reader(ctx) {
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
        new CloudflareError(`Cloudflare refused GET ${path.split('?')[0]}: the token needs ${permission}`, 403),
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
async function accountOf(cf, ctx) {
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

/**
 * Discovers what the environment's target Worker runs on, as resources and relations. `missing` names a permission
 * the token lacks for a kind a repository may leave out (queues, containers): that kind isn't read, and discovery goes
 * on (BRK-188, "Tokens").
 * @param {ProviderContext} ctx
 * @returns {Promise<Discovery & { missing: string[] }>}
 */
export async function discover(ctx) {
  const target = typeof ctx.scope?.target === 'string' ? ctx.scope.target : null;
  /** @type {Map<string, Resource>} */
  const resources = new Map();
  /** @type {Map<string, Relation>} */
  const relations = new Map();
  /** @type {string[]} */
  const missing = [];
  const add = (r) => resources.set(r.id, r);
  const relate = (from, to, kind) => relations.set(`${from} ${kind} ${to}`, { from, to, kind });
  const done = () => ({
    resources: [...resources.values()],
    relations: [...relations.values()].filter((r) => resources.has(r.from) && resources.has(r.to)),
    missing,
  });
  if (!target) return done();

  const cf = reader(ctx);
  const a = enc(await accountOf(cf, ctx));
  const scripts = new Map(
    (
      await cf.get(`/accounts/${a}/workers/scripts`, { permission: 'Workers Scripts Read' }).then((j) => j.result ?? [])
    ).map((s) => [String(s.id), s]),
  );
  if (!scripts.has(target)) return done();

  // The Workers in scope: the target, and the Workers it calls or whose Durable Objects it binds.
  /** @type {Map<string, any[]>} */
  const bindingsOf = new Map();
  const queue = [target];
  while (queue.length && bindingsOf.size < MAX_WORKERS) {
    const name = /** @type {string} */ (queue.shift());
    if (bindingsOf.has(name) || !scripts.has(name)) continue;
    const p = `/accounts/${a}/workers/scripts/${enc(name)}`;
    const opts = { permission: 'Workers Scripts Read' };
    const settings = (await cf.get(`${p}/settings`, opts)).result ?? {};
    const deployments = (await cf.get(`${p}/deployments`, opts)).result ?? {};
    const secrets = (await cf.get(`${p}/secrets`, opts)).result ?? [];
    const schedules = (await cf.get(`${p}/schedules`, opts)).result ?? {};
    const bindings = settings.bindings ?? [];
    bindingsOf.set(name, bindings);
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
          consumers: consumers.map((c) => ({
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
    permission: 'Workers Scripts Read',
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
    const routes =
      (await cf.get(`/zones/${enc(zone.id)}/workers/routes`, { permission: 'Workers Routes Read' })).result ?? [];
    for (const route of routes) {
      if (!workers.has(String(route.script))) continue;
      add({ id: rid('route', route.id), kind: 'route', name: String(route.pattern), attrs: { zone: zone.name } });
      relate(rid('worker', String(route.script)), rid('route', route.id), 'serves');
    }
  }

  // Custom domains attached to a Worker in scope.
  const domains = (await cf.get(`/accounts/${a}/workers/domains`, { permission: 'Workers Scripts Read' })).result ?? [];
  for (const d of domains) {
    if (!workers.has(String(d.service))) continue;
    add({
      id: rid('custom-domain', d.id),
      kind: 'custom-domain',
      name: String(d.hostname),
      attrs: { zone: d.zone_name ?? null, environment: d.environment ?? null },
    });
    relate(rid('worker', String(d.service)), rid('custom-domain', d.id), 'serves');
  }

  return done();
}

/** A step that isn't built yet, naming the task that builds it. */
const notYet = (step, task) => async () => {
  throw new Error(`cloudflare ${step} isn't built yet (${task})`);
};

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
  discover,
  plan: notYet('plan', 'BRK-192'),
  async apply(ctx, p) {
    checkApply(cloudflare, ctx, p);
    return notYet('apply', 'BRK-192')();
  },
  observe: notYet('observe', 'BRK-191'),
  cost: notYet('cost', 'BRK-193'),
  events: notYet('events', 'BRK-191'),
};
