/**
 * The launch board's platform: made-up Cloudflare resources for acme/widgets, in memory, so the screenshots show
 * Architect the way a person sees it (Cloudflare first) without a real account. It follows the test suite's fake
 * provider (test/fake-infra-provider.js) and never reaches the network. Nothing here is real: the names, the
 * settings, the health, and the costs are all made up.
 *
 * Each environment is its own slice of the state, keyed by its name, and the launch board's `/__launch` route
 * changes it (seed.sh, through architect.mjs).
 */
import { CLOUDFLARE_KINDS, creatable, editable, READ_PERMISSIONS } from '../../../src/infra-cloudflare.js';
import { checkApply } from '../../../src/infra-provider.js';

/** The only token the made-up account knows: plainly fake, and read only. */
export const LAUNCH_TOKEN = 'launch-read-token';

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** What acme/widgets runs in one environment: an API Worker and what it binds, and the route in front of it. */
export function platformOf(environment, { render = 2, consumers = 2, worker = 'widgets-api' } = {}) {
  const host = environment === 'production' ? 'api.widgets.example' : `${environment}.api.widgets.example`;
  const name = (base) => (environment === 'production' ? base : `${base}-${environment}`);
  return {
    resources: [
      {
        id: `worker:${name(worker)}`,
        kind: 'worker',
        name: name(worker),
        attrs: {
          compatibilityDate: '2026-09-01',
          usageModel: 'standard',
          observability: { enabled: true },
          placement: null,
          bindings: ['DB', 'CACHE', 'EXPORTS', 'FILES', 'RENDER'],
          crons: ['0 3 * * *'],
        },
      },
      { id: `d1:${name('widgets-db')}`, kind: 'd1', name: name('widgets-db'), attrs: {} },
      { id: `kv:${name('widgets-cache')}`, kind: 'kv', name: name('widgets-cache'), attrs: {} },
      {
        id: `r2:${name('widgets-files')}`,
        kind: 'r2',
        name: name('widgets-files'),
        attrs: { cors: null, lifecycle: null },
      },
      {
        id: `queue:${name('widgets-exports')}`,
        kind: 'queue',
        name: name('widgets-exports'),
        attrs: {
          deliveryDelay: 0,
          deliveryPaused: false,
          retention: 345600,
          maxConcurrency: consumers,
          consumers: [{ type: 'worker', script: name(worker) }],
        },
      },
      {
        id: `container:${name('widgets-render')}`,
        kind: 'container',
        name: name('widgets-render'),
        attrs: { maxInstances: render, schedulingPolicy: 'default' },
      },
      { id: `route:${host}/*`, kind: 'route', name: `${host}/*`, attrs: { worker: name(worker) } },
    ],
    relations: [
      { from: `worker:${name(worker)}`, to: `d1:${name('widgets-db')}`, kind: 'uses' },
      { from: `worker:${name(worker)}`, to: `kv:${name('widgets-cache')}`, kind: 'uses' },
      { from: `worker:${name(worker)}`, to: `r2:${name('widgets-files')}`, kind: 'uses' },
      { from: `worker:${name(worker)}`, to: `queue:${name('widgets-exports')}`, kind: 'uses' },
      { from: `worker:${name(worker)}`, to: `container:${name('widgets-render')}`, kind: 'uses' },
      { from: `worker:${name(worker)}`, to: `route:${host}/*`, kind: 'serves' },
    ],
    /** @type {Record<string, string>} */
    health: {},
    /** Made-up monthly estimates, in USD, by resource ID. */
    costs: {
      [`worker:${name(worker)}`]: environment === 'production' ? 9.4 : 5,
      [`d1:${name('widgets-db')}`]: environment === 'production' ? 2.1 : 0.4,
      [`kv:${name('widgets-cache')}`]: 0.6,
      [`r2:${name('widgets-files')}`]: environment === 'production' ? 1.8 : 0.3,
      [`queue:${name('widgets-exports')}`]: 0.8,
      [`container:${name('widgets-render')}`]: 3.2 * render,
      [`route:${host}/*`]: 0,
    },
    /** @type {Array<{ resource: string | null, kind: string, level: string, value: number | null, at: string, text: string }>} */
    events: [],
    /** @type {Set<string>} resource IDs whose change the platform refuses */
    failOn: new Set(),
  };
}

/**
 * The film's world (LCH-38; launch/2.0.0.md, piece 6): acme/widgets's web app, `widgets-web`, one Worker behind two
 * custom domains, holding two Durable Objects and a D1 database (scale S). Scale M adds a queue, a container, an R2
 * bucket, and a KV namespace; staging gets them through a plan, so `scale` here is what runs before it. A short-lived
 * environment is empty until its plan makes it. Prices are made up, in USD a month: a container's per instance.
 * @param {string} environment
 * @param {{ scale?: 's' | 'm' | 'empty', render?: number }} [options]
 */
export function filmPlatformOf(environment, { scale = 's', render = 3 } = {}) {
  const production = environment === 'production';
  const name = (base) => (production ? base : `${base}-${environment}`);
  const worker = name('widgets-web');
  const host = production ? 'widgets.example' : `${environment}.widgets.example`;
  const prices = { container: 2.4, queue: 0.8, r2: 0.3, kv: 0.5, d1: 0.4, 'durable-object': 0.3, worker: 0.9 };
  /** @type {any[]} */
  const resources = [];
  /** @type {any[]} */
  const relations = [];
  const add = (kind, base, attrs = {}, relation = 'uses') => {
    const id = `${kind}:${kind === 'custom-domain' ? base : name(base)}`;
    resources.push({ id, kind, name: kind === 'custom-domain' ? base : name(base), attrs });
    if (kind === 'custom-domain') relations.push({ from: `worker:${worker}`, to: id, kind: 'serves' });
    else if (kind !== 'worker') relations.push({ from: `worker:${worker}`, to: id, kind: relation });
  };
  if (scale !== 'empty') {
    add('custom-domain', host, { worker, environment: 'production' });
    add('custom-domain', `www.${host}`, { worker, environment: 'production' });
    add('worker', 'widgets-web', {
      compatibilityDate: '2026-09-01',
      usageModel: 'standard',
      observability: { enabled: true },
      placement: null,
      bindings: ['ROOMS', 'COUNTERS', 'DB'],
      crons: [],
    });
    add('durable-object', 'WidgetRoom');
    add('durable-object', 'WidgetCounter');
    add('d1', 'widgets-db');
  }
  if (scale === 'm') {
    add(
      'queue',
      'widgets-exports',
      {
        deliveryDelay: 0,
        deliveryPaused: false,
        retention: 345600,
        maxConcurrency: 2,
        consumers: [{ type: 'worker', script: worker }],
      },
      'produces',
    );
    add('container', 'widgets-render', { maxInstances: render, schedulingPolicy: 'default' });
    add('r2', 'widgets-files', { cors: null, lifecycle: null });
    add('kv', 'widgets-cache');
  }
  /** @type {Record<string, number>} */
  const costs = {};
  for (const r of resources)
    costs[r.id] =
      r.kind === 'container'
        ? prices.container * r.attrs.maxInstances
        : r.kind === 'custom-domain'
          ? 0
          : r.kind === 'worker' && production
            ? 1.2
            : (prices[r.kind] ?? 0);
  return {
    resources,
    relations,
    /** @type {Record<string, string>} */
    health: {},
    costs,
    prices,
    worker,
    /** @type {Array<{ resource: string | null, kind: string, level: string, value: number | null, at: string, text: string }>} */
    events: [],
    /** @type {Set<string>} */
    failOn: new Set(),
  };
}

/** Every environment's slice, by name. The launch board fills it before the first refresh. */
export const platforms = /** @type {Record<string, ReturnType<typeof platformOf>>} */ ({});

const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const clone = (v) => (v == null ? null : structuredClone(v));
const slice = (ctx) => {
  const found = platforms[ctx.environment];
  if (!found) throw new Error(`the made-up account has nothing for ${ctx.environment}`);
  return found;
};
/** What a setting scales, by kind: a change to only that is a `scale`. */
const scales = (kind) => CLOUDFLARE_KINDS[kind]?.scales ?? null;

/** @type {import('../../../src/infra-provider.js').Provider} */
export const launchProvider = {
  id: 'cloudflare',
  name: 'Cloudflare',
  kinds: CLOUDFLARE_KINDS,
  // What the console may change and add (BRK-262, BRK-270): Cloudflare's own, so the console reads as it does there.
  editable,
  creatable,
  readToken: {
    permissions: READ_PERMISSIONS,
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    async check({ token }) {
      return token === LAUNCH_TOKEN
        ? { ok: true, permissions: READ_PERMISSIONS.map((p) => ({ name: p.name, level: 'read' })) }
        : { ok: false, error: 'the made-up account doesn’t know this token' };
    },
  },

  async discover(ctx) {
    const p = slice(ctx);
    return { resources: p.resources.map((r) => structuredClone(r)), relations: structuredClone(p.relations) };
  },

  async plan(ctx, desired) {
    const p = slice(ctx);
    const changes = [];
    const wanted = new Set(desired.resources.map((r) => r.id));
    for (const r of desired.resources) {
      const now = p.resources.find((x) => x.id === r.id);
      if (!now) {
        changes.push({
          op: 'create',
          resource: r.id,
          kind: r.kind,
          name: r.name,
          before: null,
          after: clone(r.attrs ?? {}),
          reversible: true,
        });
        continue;
      }
      if (same(now.attrs, r.attrs) && now.name === r.name) continue;
      const moved = Object.keys({ ...now.attrs, ...r.attrs }).filter((k) => !same(now.attrs?.[k], r.attrs?.[k]));
      const scale = now.name === r.name && moved.length > 0 && moved.every((k) => k === scales(r.kind));
      changes.push({
        op: scale ? 'scale' : 'update',
        resource: r.id,
        kind: r.kind,
        name: r.name,
        before: clone(now.attrs ?? {}),
        after: clone(r.attrs ?? {}),
        reversible: true,
      });
    }
    for (const r of p.resources)
      if (!wanted.has(r.id)) {
        const reversible = !['d1', 'kv', 'r2'].includes(r.kind);
        changes.push({
          op: 'delete',
          resource: r.id,
          kind: r.kind,
          name: r.name,
          before: clone(r.attrs ?? {}),
          after: null,
          reversible,
          ...(reversible ? {} : { why: `deleting ${r.name} deletes what it holds` }),
        });
      }
    return {
      provider: 'cloudflare',
      environment: ctx.environment,
      changes,
      reversible: changes.every((c) => c.reversible),
    };
  },

  async apply(ctx, plan) {
    checkApply(launchProvider, ctx, plan);
    const p = slice(ctx);
    const steps = [];
    for (const c of plan.changes) {
      if (p.failOn.has(c.resource)) {
        steps.push({ resource: c.resource, op: c.op, ok: false, error: `Cloudflare refused to ${c.op} ${c.name}` });
        return { ok: false, steps };
      }
      if (c.op === 'create') {
        p.resources.push({ id: c.resource, kind: c.kind, name: c.name, attrs: clone(c.after) });
        // What the film's Worker binds: a new resource joins the map behind it, at the slice's price.
        if (p.worker && c.kind !== 'worker' && p.resources.some((r) => r.id === `worker:${p.worker}`))
          p.relations.push({
            from: `worker:${p.worker}`,
            to: c.resource,
            kind: c.kind === 'custom-domain' ? 'serves' : c.kind === 'queue' ? 'produces' : 'uses',
          });
        if (p.prices && c.kind !== 'container') p.costs[c.resource] = p.prices[c.kind] ?? 0;
      } else if (c.op === 'delete') {
        p.resources = p.resources.filter((r) => r.id !== c.resource);
        p.relations = p.relations.filter((r) => r.from !== c.resource && r.to !== c.resource);
        delete p.costs[c.resource];
      } else if (c.op !== 'restart')
        Object.assign(
          p.resources.find((r) => r.id === c.resource),
          { attrs: clone(c.after) },
        );
      if (c.kind === 'container' && c.after?.maxInstances)
        p.costs[c.resource] = (p.prices?.container ?? 3.2) * Number(c.after.maxInstances);
      steps.push({ resource: c.resource, op: c.op, ok: true });
    }
    return { ok: true, steps };
  },

  async observe(ctx) {
    const p = slice(ctx);
    const at = new Date().toISOString();
    return p.resources.map((r) => ({ resource: r.id, state: p.health[r.id] ?? 'healthy', at }));
  },

  async cost(ctx) {
    const p = slice(ctx);
    return p.resources.map((r) => ({ resource: r.id, amount: p.costs[r.id] ?? 0, currency: 'USD', estimate: true }));
  },

  /**
   * A container costs 3.20 a month an instance (the film's 1.60) and a queue's concurrency nothing more; the film's
   * world prices a new resource of any kind from its table; anything else it can't say.
   */
  async estimate(ctx, change) {
    const p = slice(ctx);
    if (change.kind === 'container')
      return {
        resource: change.resource,
        amount: (p.prices?.container ?? 3.2) * Number(change.after?.maxInstances ?? 1),
        currency: 'USD',
        estimate: true,
      };
    if (change.kind === 'queue')
      return {
        resource: change.resource,
        amount: p.costs[change.resource] ?? p.prices?.queue ?? 0.8,
        currency: 'USD',
        estimate: true,
      };
    if (p.prices && change.op === 'create' && change.kind in p.prices)
      return { resource: change.resource, amount: p.prices[change.kind], currency: 'USD', estimate: true };
    return null;
  },

  async events(ctx, since) {
    const from = Date.parse(since);
    return slice(ctx)
      .events.filter((e) => Date.parse(e.at) >= from)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((e) => ({ source: 'cloudflare', environment: ctx.environment, ...e }));
  },
};

export { minutesAgo };
