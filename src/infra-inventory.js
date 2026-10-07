/**
 * Architect's inventory (docs/specs/IDEA-19-architect.md, "Inventory"; BRK-177): what actually exists, from each
 * provider's `discover`, as a graph of resources with relations, ownership, last health, and last cost. Pure, so the
 * scope rule and the views are tested without the Durable Object; the tables, the refresh, and the API are in
 * store-infra-inventory.js.
 *
 * Scope (BRK-169): only what the board's repositories run on is stored. An environment's scope is its target (the
 * resource whose provider ID or name is the environment's `target`) and everything the target leans on, following
 * relations from it (this service uses that database, binds that secret by name, serves that route). A provider may
 * scope its own discovery with `ctx.scope`; this rule is applied again to whatever it returns, so a resource outside
 * every environment's scope never reaches the store.
 */
import { redact } from './redact.js';

/** @typedef {import('./infra-provider.js').Discovery} Discovery */
/** @typedef {import('./infra-provider.js').Resource} Resource */
/** @typedef {import('./infra-provider.js').Relation} Relation */

/** Per environment: far more than one repository's environment runs on, and a bound on what one refresh writes. */
export const MAX_RESOURCES = 1000;

/**
 * The part of a discovery inside an environment's scope: the target, what it reaches by relations, and the relations
 * between them. Nothing when the environment has no target.
 * @param {Discovery} discovery
 * @param {string | null} target
 * @returns {Discovery}
 */
export function scopeDiscovery(discovery, target) {
  if (!target) return { resources: [], relations: [] };
  /** @type {Map<string, Relation[]>} */
  const out = new Map();
  for (const rel of discovery.relations) out.set(rel.from, [...(out.get(rel.from) ?? []), rel]);
  const keep = new Set(discovery.resources.filter((r) => r.id === target || r.name === target).map((r) => r.id));
  const queue = [...keep];
  while (queue.length) {
    for (const rel of out.get(/** @type {string} */ (queue.shift())) ?? [])
      if (!keep.has(rel.to)) {
        keep.add(rel.to);
        queue.push(rel.to);
      }
  }
  return {
    resources: discovery.resources.filter((r) => keep.has(r.id)),
    relations: discovery.relations.filter((rel) => keep.has(rel.from) && keep.has(rel.to)),
  };
}

/**
 * A resource's settings with every string redacted (src/redact.js), so a token a platform echoes back in a setting is
 * never stored. A provider never sends a secret's value (infra-provider.js); this is the second line.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactAttrs(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactAttrs);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAttrs(v)]));
  return value;
}

/**
 * A resource as the API shows it.
 * @param {{ provider: string, rid: string, kind: string, name: string, attrs: string | null, health: string | null, health_at: number | null, health_text: string | null, cost: number | null, currency: string | null, cost_note?: string | null, seen: number }} row
 * @param {{ id: number, repo: string, name: string }} environment
 * @param {{ uuid: string, wid: string | null, description: string } | null} task the task that owns a short-lived environment
 */
export function resourceView(row, environment, task) {
  return {
    id: row.rid,
    provider: row.provider,
    kind: row.kind,
    name: row.name,
    attrs: row.attrs ? JSON.parse(row.attrs) : {},
    owner: { repo: environment.repo, environment: environment.name, environmentId: environment.id, task },
    health: row.health
      ? {
          state: row.health,
          at: row.health_at ? new Date(row.health_at).toISOString() : null,
          ...(row.health_text ? { text: row.health_text } : {}),
        }
      : null,
    cost:
      row.cost === null || row.cost === undefined
        ? null
        : {
            amount: row.cost,
            currency: row.currency,
            perMonth: true,
            estimate: true,
            ...(row.cost_note ? { note: row.cost_note } : {}),
          },
    seen: new Date(row.seen).toISOString(),
  };
}

/** The longest reason a stale environment keeps. */
const MAX_STALE_ERROR = 500;

/** @param {string} text */
export function clipError(text) {
  const t = String(text ?? '').trim() || 'no reason given';
  return t.length > MAX_STALE_ERROR ? `${t.slice(0, MAX_STALE_ERROR - 1)}…` : t;
}

/**
 * What Connections' discovery row says when some environments failed (BRK-257): how many of them discovery reached,
 * then each failure, naming its environment.
 * @param {Array<{ message: string }>} failures
 * @param {number} total the environments with a target on the provider
 */
export function discoveredWords(failures, total) {
  const reached = total - failures.length;
  return `${reached} of ${total} ${total === 1 ? 'environment' : 'environments'} discovered; ${failures.map((f) => f.message).join('; ')}`;
}

/**
 * A stale environment as the API shows it (BRK-257): its discovery failed, so its inventory is what the board saw at
 * `seen`, kept until a discovery works again.
 * @param {{ environment: number, provider: string, at: number, error: string, env_repo: string, env_name: string, seen: number | null }} row
 */
export function staleView(row) {
  return {
    environmentId: Number(row.environment),
    repo: row.env_repo,
    environment: row.env_name,
    provider: row.provider,
    at: new Date(Number(row.at)).toISOString(),
    error: row.error,
    seen: row.seen === null || row.seen === undefined ? null : new Date(Number(row.seen)).toISOString(),
  };
}

/** How often the cron refreshes a provider's inventory by itself (BRK-248). */
export const REFRESH_EVERY_MS = 15 * 60 * 1000;

/** At most this many providers refresh on one cron tick, the longest-waiting first, so they stagger. */
export const REFRESH_PER_TICK = 2;

/** A platform's answers that mean the token can't read: the cron stops trying until a new token is pasted. */
const REFUSED = new Set([401, 403]);

/**
 * Whether the cron refreshes a provider now (BRK-248): never refreshed, or not in the last 15 minutes. One whose last
 * refresh the platform refused (401 or 403) waits for a new token instead: Connections already says why.
 * @param {{ at: number, ok: boolean, status: number | null } | null} last the provider's last refresh
 * @param {number} now
 * @param {number | null} [tokenEdited] when the provider's token was last pasted
 */
export function refreshDue(last, now, tokenEdited = null) {
  if (!last) return true;
  if (!last.ok && last.status !== null && REFUSED.has(last.status) && !(tokenEdited !== null && tokenEdited > last.at))
    return false;
  return now - last.at >= REFRESH_EVERY_MS;
}
