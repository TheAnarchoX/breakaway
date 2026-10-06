/**
 * Plan and apply for Architect's first provider, Cloudflare (docs/specs/IDEA-19-architect.md, "First provider:
 * Cloudflare" and "Plan and apply, as built"; BRK-192).
 *
 * Cloudflare has no dry run, so `plan` is the provider's own diff: it discovers the environment with the board's read
 * token and compares it with the desired state, without writing anything. A desired resource matches a discovered one
 * by its ID, or by its kind and name (a new database has no Cloudflare ID until it's made). Only the settings Architect
 * manages are compared, and only those the desired state gives, so a file can leave the rest to the Worker's deploy;
 * a discovered resource the desired state doesn't list is deleted. Deleting a Worker, D1 database, KV namespace, R2
 * bucket, queue, or container application is marked irreversible, with why.
 *
 * Only Workers can be scoped one by one (Workers Editor, BRK-243); a database, namespace, bucket, or queue permission
 * reaches every one on the account. So the provider keeps every change inside the environment's scope itself: it
 * refuses to make a resource that already exists on the account outside the scope, a database, namespace, bucket, or
 * queue no Worker in the desired state binds, and a delete of something a remaining Worker still binds. Discovery
 * follows bindings to other Workers, so the plan also refuses a change to the install's own Worker (`scope.board`), to
 * another environment's target (`scope.others`), or to anything reached only through one of them, never deletes them,
 * and sends a route or custom domain only to the environment's own Workers, on a pattern or hostname nobody else has
 * (BRK-251).
 *
 * `apply` runs only inside the apply runner (CLI-12), with the environment's write token. It discovers again first
 * and refuses a change whose resource moved since it was planned, then calls Cloudflare one change at a time, in the
 * plan's order, stopping at the first that fails. A Worker's bindings and settings change through
 * `PATCH …/scripts/{name}/settings`, which makes a new version and deploys it: the versions endpoint needs the Worker's
 * modules, and the provider never reads a Worker's code. Pure apart from `fetch`, so the CLI can import it.
 */
import { checkApply } from './infra-provider.js';
import { redact } from './redact.js';
import {
  API,
  BINDING_TARGETS,
  CloudflareError,
  MANAGED,
  PRICES,
  accountOf,
  bindingTarget,
  cloudflare,
  cost,
  discover,
  ownership,
  priceResource,
  reader,
  refuses,
  round,
  workerConsumer,
} from './infra-cloudflare.js';

/** @typedef {import('./infra-provider.js').ProviderContext} ProviderContext */
/** @typedef {import('./infra-provider.js').Resource} Resource */
/** @typedef {import('./infra-provider.js').DesiredState} DesiredState */
/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */
/** @typedef {import('./infra-provider.js').Change} Change */
/** @typedef {import('./infra-provider.js').ApplyResult} ApplyResult */
/** @typedef {import('./infra-cloudflare.js').LiveAccount} LiveAccount */

/** The settings Architect manages, by kind: infra-cloudflare.js keeps them, on each kind. */
export { MANAGED };

/** Kinds Cloudflare names by their name, so a rename is a change of its own (KV's title, a route's pattern). */
const RENAMES = new Set(['kv', 'route']);

/**
 * What the write token needs to change a Worker (BRK-243): Cloudflare's Workers Editor role, scoped to the
 * environment's Workers. It replaces the legacy Workers Scripts Write (Editor at the Workers product scope), and a
 * token made with that still works. Editor can't make or delete a Worker: that's Admin at the Workers product scope,
 * which the owner gives the write token by hand for the one apply that needs it. Custom domains have no per-Worker
 * role yet, so an environment that declares them scopes Editor to the Workers product.
 */
export const WORKERS_WRITE = {
  edit: 'Workers Editor on this Worker (or the legacy Workers Scripts Write)',
  create:
    'Workers Admin at the Workers product scope, because Workers Editor can’t make a Worker: give the write token Admin for this apply, then take it away',
  delete:
    'Workers Admin, because Workers Editor can’t delete a Worker: give the write token Admin for this apply, then take it away',
  domain:
    'Workers Editor at the Workers product scope (custom domains have no per-Worker role yet; or the legacy Workers Scripts Write) and Workers Routes Write on its zone',
};

/** Why deleting each kind can't be undone. Routes and custom domains hold nothing, so they can be made again. */
const LOST = {
  worker:
    'deleting a Worker deletes every version of it, so it can’t be rolled back; it needs Workers Admin on the write token, which Workers Editor doesn’t have, so give it for this apply and take it away after',
  d1: 'deleting a D1 database deletes its data; Time Travel can’t restore a deleted database',
  kv: 'deleting a KV namespace deletes every key in it',
  r2: 'deleting an R2 bucket deletes it for good (Cloudflare refuses unless it’s empty)',
  queue: 'deleting a queue deletes the messages in it',
  container: 'deleting a container application stops its instances and deletes its configuration',
};

/** The order a plan applies in: what's bound is made first and deleted last. */
const ORDER = [
  ['create', ['d1', 'kv', 'r2', 'queue']],
  ['update', ['d1', 'kv', 'r2', 'queue', 'container']],
  ['scale', ['queue', 'container']],
  ['restart', ['container']],
  ['create', ['worker']],
  ['update', ['worker']],
  ['create', ['route', 'custom-domain']],
  ['update', ['route', 'custom-domain']],
  ['delete', ['route', 'custom-domain']],
  ['delete', ['worker']],
  ['delete', ['container', 'queue', 'r2', 'kv', 'd1']],
];
/**
 * Settings Cloudflare moves by itself between a plan and its apply (a container application's instance counts), so
 * they never make a change look out of date.
 */
const LIVE = { container: ['instances', 'active', 'assigned'] };
const settled = (kind, attrs) =>
  Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !(LIVE[kind] ?? []).includes(k)));
const rank = (c) => ORDER.findIndex(([op, kinds]) => op === c.op && kinds.includes(c.kind));

/** Binding types whose targets are a resource of a kind Architect makes, and the field that names it. */
const BOUND_KIND = {
  d1: ['d1', 'id'],
  kv_namespace: ['kv', 'namespace_id'],
  r2_bucket: ['r2', 'bucket_name'],
  queue: ['queue', 'queue_name'],
};

/** Settings as a stored plan keeps them (BRK-178 redacts its diff), so a fresh discovery compares with them. */
function redactAttrs(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactAttrs);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactAttrs(x)]));
  return v;
}
const cfId = (id) => id.slice(id.indexOf(':') + 1);
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
/** JSON with sorted keys, so two settings compare the same however they were written. */
const same = (a, b) => canon(a) === canon(b);
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Thrown when a plan can't be made: what the desired state asks for, and what to change in it. */
export class PlanRefused extends Error {}
const refuse = (message) => {
  throw new PlanRefused(message);
};

/**
 * A discovery as plan reads it: each resource with the settings its relations carry (the Worker a route or custom
 * domain serves), by ID.
 * @param {import('./infra-provider.js').Discovery} found
 * @returns {Map<string, Resource>}
 */
function viewOf(found) {
  const byId = new Map(found.resources.map((r) => [r.id, { ...r, attrs: clone(r.attrs ?? {}) }]));
  for (const rel of found.relations)
    if (rel.kind === 'serves') {
      const r = byId.get(rel.to);
      if (r) r.attrs.worker = cfId(rel.from);
    }
  return byId;
}

/**
 * A desired binding, checked: managed bindings name what they bind to, by Cloudflare's field or, for a database or
 * namespace the plan makes, by its desired resource's ID in `resource`.
 * @param {string} worker
 * @param {any} b
 */
function desiredBinding(worker, b) {
  if (!isObject(b) || typeof b.name !== 'string' || typeof b.type !== 'string')
    refuse(`${worker}’s bindings each need a name and a type`);
  for (const f of ['text', 'json'])
    if (f in b)
      refuse(
        `${worker}’s binding ${b.name} gives its ${f}: variables and secrets stay in the Worker’s own config, never in the desired state`,
      );
  /** @type {Record<string, string>} */
  const out = bindingTarget(b);
  if (typeof b.resource === 'string' && BOUND_KIND[b.type]) out.resource = b.resource;
  return out;
}

/**
 * A Worker's desired bindings, checked, each filled in with what its live binding of the same name and type binds to
 * when it doesn't say: a binding that gives only its name and type keeps its target.
 * @param {string} worker
 * @param {Array<Record<string, string>>} live
 * @param {unknown[]} wanted
 */
function filledIn(worker, live, wanted) {
  const liveBy = new Map(live.map((b) => [b.name, b]));
  return wanted.map((x) => {
    const b = desiredBinding(worker, x);
    const have = liveBy.get(b.name);
    if (!have || have.type !== b.type || b.resource !== undefined) return b;
    const given = (BINDING_TARGETS[b.type] ?? []).some((f) => b[f] !== undefined);
    return given ? b : { ...have, ...b };
  });
}

/**
 * Whether a live binding is what a desired one asks for: the same name and type, and every target the desired one
 * gives. `resolve` turns a desired `resource` into its Cloudflare target, or null while it's still to be made.
 * @param {Record<string, string>} want
 * @param {Record<string, string> | undefined} have
 * @param {(b: Record<string, string>) => string | null} resolve
 */
function bindingMatches(want, have, resolve) {
  if (!have || have.type !== want.type) return false;
  for (const f of BINDING_TARGETS[want.type] ?? []) if (want[f] !== undefined && want[f] !== have[f]) return false;
  if (want.resource !== undefined) {
    const [, field] = BOUND_KIND[want.type];
    const target = resolve(want);
    if (target === null || have[field] !== target) return false;
  }
  return true;
}

/**
 * The bindings a Worker's settings change keeps, changes, and drops, by name. Variables and secrets (any type
 * BINDING_TARGETS doesn't list) are never changed: a desired state that adds, drops, or retypes one is refused.
 * @param {string} worker
 * @param {Array<Record<string, string>>} live
 * @param {unknown[]} wanted
 * @param {(b: Record<string, string>) => string | null} resolve
 */
function bindingChange(worker, live, wanted, resolve) {
  const want = filledIn(worker, live, wanted);
  const names = new Set();
  for (const b of want) {
    if (names.has(b.name)) refuse(`${worker} binds ${b.name} twice`);
    names.add(b.name);
  }
  const liveBy = new Map(live.map((b) => [b.name, b]));
  const managed = (t) => t in BINDING_TARGETS;
  for (const b of live)
    if (!managed(b.type) && !names.has(b.name))
      refuse(
        `${worker}’s ${b.type} binding ${b.name} isn’t in the desired state: Architect never removes a variable or a secret`,
      );
  let changed = false;
  for (const b of want) {
    const have = liveBy.get(b.name);
    if (!managed(b.type) || (have && !managed(have.type))) {
      if (!have || have.type !== b.type)
        refuse(
          `${worker}’s binding ${b.name} is a ${b.type}: Architect changes only bindings to Cloudflare resources, never a variable or a secret`,
        );
      continue;
    }
    if (!bindingMatches(b, have, resolve)) changed = true;
  }
  for (const b of live) if (managed(b.type) && !names.has(b.name)) changed = true;
  return { want, changed };
}

/**
 * Plans the desired state against what the environment runs: the exact changes an apply would make, in the order it
 * makes them. Refuses, saying what to change, anything outside the environment's scope or Architect can't change.
 * @param {ProviderContext} ctx
 * @param {DesiredState} desired
 * @returns {Promise<PlanDiff>}
 */
export async function plan(ctx, desired) {
  const found = await discover(ctx, { live: true });
  const live = /** @type {LiveAccount} */ (found.live);
  if (!live.account || !live.scripts.includes(String(ctx.scope?.target ?? '')))
    refuse(`${ctx.scope?.target ?? 'the target'} isn’t a Worker on the account yet: deploy it first, then plan`);
  if (ctx.scope?.board && ctx.scope.board === ctx.scope.target)
    refuse(
      `${ctx.scope.target} is the Worker this board runs on: Architect only observes it, so it never plans for it`,
    );
  const have = viewOf(found);
  const own = ownership(found, ctx.scope);
  /** Why the environment can't change a resource it found, or null when it's its own (BRK-251). */
  const notOurs = (h) => own.why(ctx.environment, h);
  const cf = reader(ctx);

  // Match each desired resource to what's there: by ID, else by kind and name.
  /** @type {Map<string, Resource>} desired resource ID → the discovered one */
  const match = new Map();
  const taken = new Set();
  for (const r of desired.resources) {
    let h = have.get(r.id);
    if (h && h.kind !== r.kind) refuse(`${r.id} is a ${h.kind}, not a ${r.kind}`);
    if (!h) h = [...have.values()].find((x) => x.kind === r.kind && x.name === r.name && !taken.has(x.id));
    if (h) {
      if (taken.has(h.id)) refuse(`${r.id} and another desired resource are both ${h.id}`);
      taken.add(h.id);
      match.set(r.id, h);
    }
  }
  /** What a desired `resource` reference binds to on Cloudflare, or null while it's still to be made. */
  const resolve = (b) => {
    const [kind] = BOUND_KIND[b.type];
    const target = desired.resources.find((r) => r.id === b.resource);
    if (!target || target.kind !== kind)
      refuse(`binding ${b.name} names ${b.resource}, which the desired state has no ${kind} for`);
    const h = match.get(target.id);
    if (!h) return null;
    return kind === 'r2' ? h.name : kind === 'queue' ? h.name : cfId(h.id);
  };
  /** The Cloudflare names and IDs the desired Workers bind, once applied, by binding type. */
  const boundAfter = {
    d1: new Set(),
    kv_namespace: new Set(),
    r2_bucket: new Set(),
    queue: new Set(),
    service: new Set(),
    resources: new Set(),
  };
  const desiredWorkers = desired.resources.filter((r) => r.kind === 'worker');
  for (const w of desiredWorkers) {
    const h = match.get(w.id);
    const now = h ? (live.bindings[h.name] ?? []) : [];
    const bindings = Array.isArray(w.attrs?.bindings) ? filledIn(w.name, now, w.attrs.bindings) : now;
    for (const b of bindings) {
      if (isObject(b) && b.type === 'service' && b.service) boundAfter.service.add(String(b.service));
      if (!isObject(b) || !BOUND_KIND[b.type]) continue;
      if (typeof b.resource === 'string') boundAfter.resources.add(b.resource);
      const [, field] = BOUND_KIND[b.type];
      if (b[field]) boundAfter[b.type].add(String(b[field]));
    }
  }
  const stillBound = (r) => {
    const type = Object.keys(BOUND_KIND).find((t) => BOUND_KIND[t][0] === r.kind);
    if (!type) return false;
    return boundAfter[type].has(r.kind === 'r2' || r.kind === 'queue' ? r.name : cfId(r.id));
  };

  /** Whether a route or custom domain may send to this Worker: one of the environment's, or one this plan makes. */
  const mine = (worker) => own.workers.has(worker) || desiredWorkers.some((w) => w.name === worker && !match.has(w.id));
  /** Refuses a route pattern or custom domain hostname another Worker already has: it's that Worker's traffic. */
  const inUse = (r) => {
    const held =
      r.kind === 'route'
        ? live.routes.find((x) => x.pattern === r.name)
        : live.domains.find((x) => x.hostname === r.name);
    if (held)
      refuse(
        `${r.name} already sends to ${held.worker}: a ${r.kind} can’t take a ${r.kind === 'route' ? 'pattern' : 'hostname'} that’s already in use, so remove it there first or pick another`,
      );
  };

  /** @type {Change[]} */
  const changes = [];
  for (const r of desired.resources) {
    const h = match.get(r.id);
    const managed = MANAGED[r.kind] ?? [];
    const wanted = isObject(r.attrs) ? r.attrs : {};
    if (!h) {
      changes.push(await created(ctx, cf, live, r, wanted, boundAfter, { mine, inUse }));
      continue;
    }
    /** @type {Record<string, unknown>} */
    const after = clone(h.attrs ?? {});
    let changed = RENAMES.has(r.kind) && r.name !== h.name;
    if (r.name !== h.name && !RENAMES.has(r.kind))
      refuse(`${h.id} is named ${h.name}: Cloudflare can’t rename a ${r.kind}, so give it its current name`);
    if (r.kind === 'durable-object') continue;
    // A Worker with no live version takes its settings from its first deploy.
    const deployed = r.kind !== 'worker' || /** @type {any[]} */ (h.attrs?.versions ?? []).length > 0;
    for (const key of managed) {
      if (!(key in wanted) || !deployed) continue;
      if (r.kind === 'worker' && key === 'bindings') {
        if (!Array.isArray(wanted.bindings)) refuse(`${r.name}’s bindings must be a list`);
        const b = bindingChange(
          r.name,
          live.bindings[h.name] ?? [],
          /** @type {unknown[]} */ (wanted.bindings),
          resolve,
        );
        if (b.changed) {
          // A binding to something that exists names it; only one to something this plan makes keeps `resource`.
          after.bindings = b.want.map((x) => {
            if (x.resource === undefined) return x;
            const target = resolve(x);
            const { resource, ...rest } = x;
            return target === null ? x : { ...rest, [BOUND_KIND[x.type][1]]: target };
          });
          changed = true;
        }
        continue;
      }
      if (!same(wanted[key], h.attrs?.[key])) {
        after[key] = clone(wanted[key]);
        changed = true;
      }
    }
    if (changed && notOurs(h)) refuse(/** @type {string} */ (notOurs(h)));
    if ((r.kind === 'route' || r.kind === 'custom-domain') && changed) {
      if (!live.scripts.includes(String(after.worker)))
        refuse(`${r.kind} ${r.name} would send to ${after.worker}, which isn’t a Worker on the account`);
      if (!mine(String(after.worker)))
        refuse(`${r.kind} ${r.name} would send to ${after.worker}, which isn’t one of ${ctx.environment}’s Workers`);
      if (r.name !== h.name) inUse(r);
    }
    if (changed)
      changes.push({
        op: 'update',
        resource: h.id,
        kind: h.kind,
        name: r.name,
        before: clone(h.attrs ?? {}),
        after,
        reversible: true,
      });
  }
  for (const h of have.values()) {
    if (taken.has(h.id)) continue;
    // What only the install's Worker or another environment reaches isn't this environment's to delete (BRK-251).
    if (notOurs(h)) continue;
    if (h.kind === 'durable-object')
      refuse(
        `${h.name} isn’t in the desired state: a Durable Object class is deleted by a migration in its Worker’s code, so keep it listed and remove it in the code`,
      );
    if (h.kind === 'worker' && h.name === ctx.scope?.target)
      refuse(`${h.name} is the environment’s target: Architect never deletes it; keep it listed`);
    if (stillBound(h))
      refuse(`${h.name} is still bound by a Worker: remove the binding in the desired state before you delete it`);
    if (h.kind === 'worker' && boundAfter.service.has(h.name))
      refuse(`${h.name} is still called by a Worker’s service binding: remove the binding before you delete it`);
    const outsider = found.relations.find(
      (rel) => rel.to === h.id && rel.from.startsWith('worker:') && !own.workers.has(cfId(rel.from)),
    );
    if (outsider)
      refuse(
        `${h.name} is still used by ${cfId(outsider.from)}, which is outside ${ctx.environment}: Architect never deletes what another Worker relies on`,
      );
    const reversible = !LOST[h.kind];
    changes.push({
      op: 'delete',
      resource: h.id,
      kind: h.kind,
      name: h.name,
      before: clone(h.attrs ?? {}),
      after: null,
      reversible,
      ...(reversible ? {} : { why: LOST[h.kind] }),
    });
  }
  changes.sort((a, b) => rank(a) - rank(b));
  return {
    provider: 'cloudflare',
    environment: ctx.environment,
    changes,
    reversible: changes.every((c) => c.reversible),
  };
}

/**
 * A resource to make, checked against the scope: nothing of the same name already on the account, and every
 * database, namespace, bucket, and queue bound by a desired Worker, so the next discovery finds it. A route or custom
 * domain sends to one of the environment's Workers, on a pattern or hostname no other Worker has (BRK-251).
 * @returns {Promise<Change>}
 */
async function created(ctx, cf, live, r, wanted, boundAfter, { mine, inUse }) {
  const a = encodeURIComponent(live.account);
  const outside = `${r.name} already exists on the account outside ${ctx.environment}’s scope: Architect never takes over a resource another environment may run on`;
  /** @type {Record<string, unknown>} */
  const after = {};
  for (const key of MANAGED[r.kind] ?? []) if (key in wanted) after[key] = clone(wanted[key]);
  if (r.kind === 'worker') {
    if (live.scripts.includes(r.name)) refuse(outside);
  } else if (r.kind === 'durable-object') {
    refuse(
      `${r.name} is a Durable Object class: it’s made by a migration in its Worker’s code, so add it there and deploy`,
    );
  } else if (r.kind === 'container') {
    refuse(`${r.name} is a container application: it’s made by its Worker’s deploy, not by Architect`);
  } else if (r.kind === 'route' || r.kind === 'custom-domain') {
    if (typeof wanted.worker !== 'string' || !wanted.worker)
      refuse(`${r.kind} ${r.name} needs attrs.worker, the Worker it sends to`);
    if (typeof wanted.zone !== 'string' || !live.zones[wanted.zone])
      refuse(
        `${r.kind} ${r.name} needs attrs.zone, one of the zones the token reaches (${Object.keys(live.zones).sort().join(', ') || 'none'})`,
      );
    if (!mine(wanted.worker))
      refuse(
        `${r.kind} ${r.name} would send to ${wanted.worker}, which isn’t one of ${ctx.environment}’s Workers: send it to the target or a Worker it calls`,
      );
    inUse(r);
    after.zone = wanted.zone;
  } else {
    const type = Object.keys(BOUND_KIND).find((t) => BOUND_KIND[t][0] === r.kind);
    const bound = boundAfter.resources.has(r.id) || (type && boundAfter[type].has(r.name));
    if (!bound)
      refuse(
        `${r.kind} ${r.name} isn’t bound by any Worker in the desired state, so it would be outside ${ctx.environment}’s scope: bind it`,
      );
    if (await existsOnAccount(cf, a, r.kind, r.name)) refuse(outside);
    if (r.kind === 'r2' && typeof wanted.location === 'string') after.location = wanted.location;
  }
  return { op: 'create', resource: r.id, kind: r.kind, name: r.name, before: null, after, reversible: true };
}

/** Whether the account already has a database, namespace, bucket, or queue of this name. */
async function existsOnAccount(cf, a, kind, name) {
  if (kind === 'd1')
    return (
      await cf.all(`/accounts/${a}/d1/database?name=${encodeURIComponent(name)}`, { permission: 'D1 Read' })
    ).some((d) => d.name === name);
  if (kind === 'kv')
    return (await cf.all(`/accounts/${a}/storage/kv/namespaces`, { permission: 'Workers KV Storage Read' })).some(
      (n) => n.title === name,
    );
  if (kind === 'r2')
    return Boolean(
      await cf.get(`/accounts/${a}/r2/buckets/${encodeURIComponent(name)}`, {
        permission: 'Workers R2 Storage Read',
        missingOk: true,
      }),
    );
  if (kind === 'queue')
    return (await cf.all(`/accounts/${a}/queues`, { permission: 'Queues Read' })).some((q) => q.queue_name === name);
  return false;
}

/**
 * The context an apply or rollback calls Cloudflare with: the environment's write token for every call, reads too.
 * Only the apply runner sets `writeToken` (CLI-12); the board never does, so without it nothing is sent.
 * @param {ProviderContext} ctx
 * @param {string} step
 * @returns {ProviderContext}
 */
function withWriteToken(ctx, step) {
  if (typeof ctx?.writeToken !== 'string' || !ctx.writeToken)
    throw new Error(
      `cloudflare ${step} needs ${ctx?.environment ?? 'the environment'}’s write token, which only the apply runner holds: nothing was sent to Cloudflare`,
    );
  return { ...ctx, token: ctx.writeToken };
}

/**
 * What a resource would cost a month once `change` is applied (BRK-178's plans read it): a new resource from its
 * settings alone, since it has no usage yet; a changed one from its last week of use (BRK-193's `cost`) with its new
 * settings. null for a delete or a restart, which the plan prices itself.
 * @param {ProviderContext} ctx
 * @param {Change} change
 * @returns {Promise<import('./infra-provider.js').Cost | null>}
 */
export async function estimate(ctx, change) {
  const r = { id: change.resource, kind: change.kind, name: change.name, attrs: change.after ?? {} };
  if (change.op === 'create') {
    const { amount } = priceResource(r);
    return { resource: r.id, amount: round(amount), currency: PRICES.currency, estimate: true };
  }
  if (change.op !== 'update' && change.op !== 'scale') return null;
  const [priced] = await cost({ ...ctx, resources: [r] });
  return priced ?? null;
}

/**
 * A writer for one apply: each call made with the write token, stopping on a 429 and saying which permission a 403
 * wants.
 * @param {ProviderContext} ctx
 */
function writer(ctx) {
  const doFetch = ctx.fetch ?? fetch;
  /**
   * @param {string} method
   * @param {string} path under API
   * @param {{ permission: string, json?: unknown, form?: FormData }} opts
   */
  return async function call(method, path, { permission, json, form }) {
    let res;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ctx.token}`,
          accept: 'application/json',
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(json === undefined ? (form ? { body: form } : {}) : { body: JSON.stringify(json) }),
      });
    } catch (error) {
      throw new CloudflareError(`couldn’t reach Cloudflare (${String(error?.message ?? error).slice(0, 100)})`, 502);
    }
    const body = await res.json().catch(() => null);
    const what = `${method} ${path.split('?')[0]}`;
    if (res.status === 429)
      throw new CloudflareError(
        `Cloudflare’s rate limit was reached at ${what}: wait 5 minutes, then run the plan again`,
        429,
      );
    if (res.status === 403)
      throw new CloudflareError(`Cloudflare refused ${what}: the write token needs ${permission}`, 403);
    if (!res.ok || body?.success === false) {
      const said = (Array.isArray(body?.errors) ? body.errors : [])
        .map((e) => e?.message)
        .filter(Boolean)
        .join('; ')
        .slice(0, 200);
      throw new CloudflareError(`Cloudflare answered ${res.status} to ${what}${said ? `: ${said}` : ''}`, res.status);
    }
    return body?.result ?? null;
  };
}

/** A Worker's settings, as `PATCH …/settings` takes them, from a change's `after` and its live bindings. */
function workerSettings(after, live, resolve) {
  const byName = new Map(live.map((b) => [b.name, b]));
  const bindings = /** @type {Array<Record<string, string>>} */ (after.bindings ?? live)
    .filter((b) => b.type in BINDING_TARGETS)
    .map((b) => {
      const out = { ...(byName.get(b.name)?.type === b.type ? byName.get(b.name) : {}), ...b };
      if (out.resource !== undefined) {
        out[BOUND_KIND[b.type][1]] = resolve(out.resource);
        delete out.resource;
      }
      return out;
    });
  return {
    bindings,
    // Variables and secrets carry over from the live version without the board ever reading them.
    keep_bindings: [...new Set(live.filter((b) => !(b.type in BINDING_TARGETS)).map((b) => b.type))].sort(),
    compatibility_date: after.compatibilityDate ?? undefined,
    compatibility_flags: after.compatibilityFlags ?? undefined,
    usage_model: after.usageModel ?? undefined,
    observability: after.observability === undefined ? undefined : { enabled: Boolean(after.observability) },
    placement: after.placement === undefined ? undefined : after.placement ? { mode: after.placement } : {},
  };
}

/**
 * Applies one plan, in its order, stopping at the first change that fails. Discovers first, with the write token,
 * and refuses a change whose resource isn't what it was when the plan was made.
 * @param {ProviderContext} ctx
 * @param {PlanDiff} p
 * @returns {Promise<ApplyResult>}
 */
export async function apply(ctx, p) {
  checkApply(cloudflare, ctx, p);
  ctx = withWriteToken(ctx, 'apply');
  if (p.changes.length === 0) return { ok: true, steps: [] };
  const found = await discover(ctx, { live: true });
  const live = /** @type {LiveAccount} */ (found.live);
  const have = viewOf(found);
  const call = writer(ctx);
  const a = `/accounts/${encodeURIComponent(live.account)}`;
  /** Cloudflare's ID (or name, for buckets and queues) of each resource this apply made, by its plan ID. */
  const made = new Map();
  /** A binding's `resource`: always one this plan makes, before the Worker that binds it. */
  const resolve = (id) => {
    if (!made.get(id)) throw new Error(`a binding names ${id}, which this plan hasn’t made`);
    return made.get(id);
  };

  /** @type {ApplyResult['steps']} */
  const steps = [];
  for (const c of p.changes) {
    try {
      const h = have.get(c.resource);
      if (c.op === 'create') {
        const exists = h ?? [...have.values()].find((x) => x.kind === c.kind && x.name === c.name);
        if (exists) throw new Error(`${c.name} already exists: plan again`);
      } else if (!h) throw new Error(`${c.name} is no longer in ${ctx.environment}: plan again`);
      else if (!same(settled(c.kind, redactAttrs(h.attrs ?? {})), settled(c.kind, c.before)))
        throw new Error(`${c.name} changed since it was planned: plan again`);
      const refused = h ? refuses(h, c.op) : null;
      if (refused) throw new Error(refused);
      await applyChange(c, { call, a, live, have, made, resolve });
      steps.push({ resource: c.resource, op: c.op, ok: true });
    } catch (error) {
      steps.push({
        resource: c.resource,
        op: c.op,
        ok: false,
        error: String(error?.message ?? error).slice(0, 300) || 'it failed',
      });
      return { ok: false, steps };
    }
  }
  return { ok: true, steps };
}

/** The calls one change makes (BRK-188's Apply rows). */
async function applyChange(c, { call, a, live, have, made, resolve }) {
  const after = /** @type {Record<string, any>} */ (c.after ?? {});
  const before = /** @type {Record<string, any>} */ (c.before ?? {});
  const id = encodeURIComponent(cfId(c.resource));
  const changed = (key) => key in after && !same(after[key], before[key]);
  switch (c.kind) {
    case 'worker': {
      const p = `${a}/workers/scripts/${encodeURIComponent(c.name)}`;
      const perm = { permission: WORKERS_WRITE.edit };
      if (c.op === 'delete') return call('DELETE', p, { permission: WORKERS_WRITE.delete });
      if (c.op === 'create') {
        // The Worker alone: its first version, with its code, comes from its deploy.
        await call('POST', `${a}/workers/workers`, { permission: WORKERS_WRITE.create, json: { name: c.name } });
        if (Array.isArray(after.crons) && after.crons.length)
          await call('PUT', `${p}/schedules`, { ...perm, json: after.crons.map((cron) => ({ cron })) });
        return;
      }
      const settings = [
        'compatibilityDate',
        'compatibilityFlags',
        'usageModel',
        'observability',
        'placement',
        'bindings',
      ];
      if (settings.some(changed)) {
        const form = new FormData();
        const body = workerSettings(after, live.bindings[c.name] ?? [], resolve);
        form.append('settings', new Blob([JSON.stringify(body)], { type: 'application/json' }));
        await call('PATCH', `${p}/settings`, { ...perm, form });
      }
      if (changed('crons'))
        await call('PUT', `${p}/schedules`, { ...perm, json: after.crons.map((cron) => ({ cron })) });
      return;
    }
    case 'd1': {
      const perm = { permission: 'D1 Write' };
      if (c.op === 'delete') return call('DELETE', `${a}/d1/database/${id}`, perm);
      const db = await call('POST', `${a}/d1/database`, { ...perm, json: { name: c.name } });
      made.set(c.resource, String(db?.uuid ?? ''));
      return;
    }
    case 'kv': {
      const perm = { permission: 'Workers KV Storage Write' };
      if (c.op === 'delete') return call('DELETE', `${a}/storage/kv/namespaces/${id}`, perm);
      if (c.op === 'update')
        return call('PUT', `${a}/storage/kv/namespaces/${id}`, { ...perm, json: { title: c.name } });
      const ns = await call('POST', `${a}/storage/kv/namespaces`, { ...perm, json: { title: c.name } });
      made.set(c.resource, String(ns?.id ?? ''));
      return;
    }
    case 'r2': {
      const perm = { permission: 'Workers R2 Storage Write' };
      const p = `${a}/r2/buckets/${encodeURIComponent(c.name)}`;
      if (c.op === 'delete') return call('DELETE', p, perm);
      if (c.op === 'create') {
        await call('POST', `${a}/r2/buckets`, {
          ...perm,
          json: { name: c.name, ...(after.location ? { locationHint: after.location } : {}) },
        });
        made.set(c.resource, c.name);
      }
      if (c.op === 'create' ? after.cors : changed('cors'))
        await call('PUT', `${p}/cors`, { ...perm, json: { rules: after.cors } });
      if (c.op === 'create' ? after.lifecycle : changed('lifecycle'))
        await call('PUT', `${p}/lifecycle`, { ...perm, json: { rules: after.lifecycle } });
      return;
    }
    case 'queue': {
      const perm = { permission: 'Queues Write' };
      if (c.op === 'delete') return call('DELETE', `${a}/queues/${id}`, perm);
      if (c.op === 'scale') return scaleConsumer(call, `${a}/queues/${id}`, c.name, after.maxConcurrency, perm);
      const settings = Object.fromEntries(
        [
          ['delivery_delay', after.deliveryDelay],
          ['delivery_paused', after.deliveryPaused],
          ['message_retention_period', after.retention],
        ].filter(([, v]) => v !== undefined && v !== null),
      );
      if (c.op === 'update') {
        if (['deliveryDelay', 'deliveryPaused', 'retention'].some(changed))
          await call('PATCH', `${a}/queues/${id}`, { ...perm, json: { settings } });
        if (changed('maxConcurrency'))
          await scaleConsumer(call, `${a}/queues/${id}`, c.name, after.maxConcurrency, perm);
        return;
      }
      await call('POST', `${a}/queues`, {
        ...perm,
        json: { queue_name: c.name, ...(Object.keys(settings).length ? { settings } : {}) },
      });
      made.set(c.resource, c.name);
      return;
    }
    case 'container': {
      const perm = { permission: 'Containers Write' };
      const p = `${a}/containers/applications/${id}`;
      if (c.op === 'delete') return call('DELETE', p, perm);
      if (c.op === 'restart') return restartContainer(call, p, c.name, perm);
      await call('PATCH', p, { ...perm, json: { max_instances: after.maxInstances } });
      // Read it back: the scale is done only once Cloudflare reports the new maximum.
      const app = await call('GET', p, perm);
      if (app?.max_instances !== after.maxInstances)
        throw new Error(
          `Cloudflare still reports ${c.name} at ${app?.max_instances ?? 'no'} max instances, not ${after.maxInstances}`,
        );
      return;
    }
    case 'route': {
      const perm = { permission: 'Workers Routes Write' };
      const zone = live.zones[c.op === 'create' ? after.zone : (have.get(c.resource)?.attrs?.zone ?? before.zone)];
      if (!zone) throw new Error(`the token reaches no zone ${after.zone ?? before.zone}`);
      const p = `/zones/${encodeURIComponent(zone)}/workers/routes`;
      if (c.op === 'delete') return call('DELETE', `${p}/${id}`, perm);
      const json = { pattern: c.name, script: after.worker };
      if (c.op === 'update') return call('PUT', `${p}/${id}`, { ...perm, json });
      return call('POST', p, { ...perm, json });
    }
    case 'custom-domain': {
      // Attaching makes a DNS record and a certificate, so it needs Workers Routes Write on the zone too.
      const perm = { permission: WORKERS_WRITE.domain };
      if (c.op === 'delete') return call('DELETE', `${a}/workers/domains/${id}`, perm);
      const zone = after.zone ?? before.zone;
      return call('PUT', `${a}/workers/domains`, {
        ...perm,
        json: {
          hostname: c.name,
          service: after.worker,
          zone_id: live.zones[zone],
          zone_name: zone,
          environment: after.environment ?? 'production',
        },
      });
    }
    default:
      throw new Error(`Architect can’t ${c.op} a ${c.kind}`);
  }
}

/**
 * Sets a queue's Worker consumer's `max_concurrency` (BRK-188: `PUT …/consumers/{consumer}`, which replaces the
 * consumer, so its other settings are sent as Cloudflare has them), then reads it back. The consumer is read with the
 * write token at apply, so the plan never holds its ID.
 * @param {ReturnType<typeof writer>} call
 * @param {string} q the queue's path
 * @param {string} name
 * @param {unknown} to
 * @param {{ permission: string }} perm
 */
async function scaleConsumer(call, q, name, to, perm) {
  const consumer = workerConsumer(await call('GET', `${q}/consumers`, perm));
  if (!consumer?.consumer_id) throw new Error(`${name} has no Worker consuming it, so there’s no concurrency to scale`);
  const p = `${q}/consumers/${encodeURIComponent(String(consumer.consumer_id))}`;
  await call('PUT', p, {
    ...perm,
    json: {
      type: 'worker',
      script_name: String(consumer.script ?? consumer.script_name ?? consumer.service),
      ...(consumer.dead_letter_queue ? { dead_letter_queue: consumer.dead_letter_queue } : {}),
      settings: { ...(consumer.settings ?? {}), max_concurrency: to ?? undefined },
    },
  });
  const now = workerConsumer(await call('GET', `${q}/consumers`, perm));
  if ((now?.settings?.max_concurrency ?? null) !== (to ?? null))
    throw new Error(
      `Cloudflare still reports ${name}’s consumer at ${now?.settings?.max_concurrency ?? 'automatic'} concurrency, not ${to ?? 'automatic'}`,
    );
}

/**
 * Restarts a container application (BRK-188's Restart row): a rollout of the configuration it runs now, so every
 * instance is replaced step by step, each after SIGTERM and up to 15 minutes to drain. The body is the one Wrangler
 * sends for a deploy's rollout (`strategy: rolling`, `kind: full_auto`); Cloudflare's API reference shows the endpoint
 * but not its body, so BRK-207's staging run confirms it. The configuration is read with the write token at apply and
 * passed through as it is: the board never stores it.
 * @param {ReturnType<typeof writer>} call
 * @param {string} p the application's path
 * @param {string} name
 * @param {{ permission: string }} perm
 */
async function restartContainer(call, p, name, perm) {
  const app = await call('GET', p, perm);
  if (!isObject(app?.configuration)) throw new Error(`Cloudflare didn’t say what ${name} runs, so it wasn’t restarted`);
  const max = Number(app.max_instances ?? 0);
  const rollout = await call('POST', `${p}/rollouts`, {
    ...perm,
    json: {
      description: 'Restarted by breakaway',
      strategy: 'rolling',
      kind: 'full_auto',
      // One step for a single instance, as Wrangler does; otherwise a tenth at a time.
      step_percentage: max < 2 ? 100 : 10,
      target_configuration: app.configuration,
    },
  });
  if (!rollout?.id) throw new Error(`Cloudflare didn’t start a rollout of ${name}`);
}

/**
 * Rolls a Worker back to the versions that were live before an apply (`before.versions` of its change): a deployment
 * of them, as they were split. Cloudflare refuses a rollback across a secret change unless it's forced, and only the
 * executor's own rollback (BRK-183) asks for that, never a plan.
 * @param {ProviderContext} ctx
 * @param {{ worker: string, versions: Array<{ id: string, percentage: number }>, force?: boolean }} input
 */
export async function rollbackWorker(ctx, { worker, versions, force = false }) {
  if (ctx?.observeOnly) throw new Error(`cloudflare rollback: ${ctx.environment} is observe only`);
  ctx = withWriteToken(ctx, 'rollback');
  if (!Array.isArray(versions) || versions.length === 0)
    throw new Error(`there is no earlier version of ${worker} to roll back to`);
  const account = await accountOf(reader(ctx), ctx);
  const p = `/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(worker)}/deployments${force ? '?force=true' : ''}`;
  return writer(ctx)('POST', p, {
    permission: WORKERS_WRITE.edit,
    json: {
      strategy: 'percentage',
      versions: versions.map((v) => ({ version_id: v.id, percentage: v.percentage })),
      annotations: { 'workers/message': 'Rolled back by breakaway' },
    },
  });
}
