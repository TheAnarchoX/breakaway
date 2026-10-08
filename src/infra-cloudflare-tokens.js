/**
 * Cloudflare's tokens for guided setup (BRK-304; docs/specs/IDEA-19-architect.md, "Tokens"): which permissions each
 * environment's write token needs, from the kinds its desired state declares, and the link that opens Cloudflare's
 * create-token page with as many of them filled in as Cloudflare allows. Pure: no store, no network, and it runs in
 * Node as well as the Worker. The board never makes, sees, or keeps a write token: it only says what to make.
 *
 * Cloudflare's template URLs ("API token template URLs", developers.cloudflare.com/fundamentals/api/how-to/
 * account-owned-token-template/, read 8 Oct 2026) prefill an account API token's permissions by key, but only the
 * keys that page lists. Workers roles (Metadata Read-Only, Editor, Admin; BRK-243), Containers, and Notifications have
 * no listed key, and the legacy `workers_scripts` key would give Content Read-Only (code) or Editor on every Worker, so
 * those are never prefilled: the setup names them to add by hand.
 */
import { READ_PERMISSIONS, WORKERS_READ } from './infra-cloudflare.js';

/** The secret the apply workflow reads the write token from, in each environment's GitHub environment. */
export const WRITE_SECRET = 'CLOUDFLARE_API_TOKEN';

/** Where an account API token is made, with `permissionGroupKeys` and `name` added (the account is picked there). */
export const TEMPLATE_BASE = 'https://dash.cloudflare.com/?to=/:account/api-tokens';

/** The permissions a template URL can prefill, by the name the token page gives them. */
export const TEMPLATE_KEYS = {
  'Workers KV Storage Read': { key: 'workers_kv_storage', type: 'read' },
  'Workers KV Storage Write': { key: 'workers_kv_storage', type: 'edit' },
  'Workers R2 Storage Read': { key: 'workers_r2', type: 'read' },
  'Workers R2 Storage Write': { key: 'workers_r2', type: 'edit' },
  'D1 Read': { key: 'd1', type: 'read' },
  'D1 Write': { key: 'd1', type: 'edit' },
  'Queues Read': { key: 'queues', type: 'read' },
  'Queues Write': { key: 'queues', type: 'edit' },
  'Account Analytics Read': { key: 'account_analytics', type: 'read' },
  'Zone Read': { key: 'zone', type: 'read' },
  'Workers Routes Read': { key: 'workers_routes', type: 'read' },
  'Workers Routes Write': { key: 'workers_routes', type: 'edit' },
};

/** The permissions that are given on zones, not the account: only the zones the environments use. */
const ZONE = new Set(['Zone Read', 'Workers Routes Read', 'Workers Routes Write']);

/**
 * One permission a token needs, where it's given, and why.
 * @typedef {object} SetupPermission
 * @property {string} name as Cloudflare's token page names it
 * @property {string} scope where it's given: `account`, `zones`, `workers` (only the Workers named in `workers`), or
 *   `workers-product` (every Worker on the account)
 * @property {string} for what it's for, in a few words
 * @property {string[]} [legacy] older names for the same access
 * @property {string[]} [workers] with scope `workers`, the Workers to choose
 * @property {boolean} [once] only for the first apply that makes a Worker: give it, then take it away
 */

/** The board's read token, with where each permission is given. */
export const readPermissions = () =>
  READ_PERMISSIONS.map(
    (p) =>
      /** @type {SetupPermission} */ ({
        ...p,
        scope: p.name === WORKERS_READ ? 'workers-product' : ZONE.has(p.name) ? 'zones' : 'account',
      }),
  );

/** The Write permission each kind needs beyond Workers Editor, and what it's for. */
const KIND_WRITES = [
  { kinds: ['route', 'custom-domain'], name: 'Workers Routes Write', for: 'routes and custom domains, on their zones' },
  { kinds: ['d1'], name: 'D1 Write', for: 'D1 databases' },
  { kinds: ['kv'], name: 'Workers KV Storage Write', for: 'KV namespaces' },
  { kinds: ['r2'], name: 'Workers R2 Storage Write', for: 'R2 buckets' },
  { kinds: ['queue'], name: 'Queues Write', for: 'queues' },
  { kinds: ['container'], name: 'Containers Write', for: 'container applications' },
];

/**
 * What one environment's write token needs: the read token's permissions (apply discovers again with it), Workers
 * Editor on its Workers (on the Workers product when it declares custom domains, which have no per-Worker role yet),
 * and only the Write permissions for the kinds it declares. A Worker the desired state names that doesn't run yet
 * needs Workers Admin for the apply that makes it, never as part of the standing token.
 * @param {{ resources?: Array<{ kind: string, name: string }> } | null} desired the environment's desired state, null
 *   when it has none yet
 * @param {{ running?: string[] }} [options] the Workers that already run in the environment, by name
 * @returns {SetupPermission[]}
 */
export function writePermissions(desired, { running = [] } = {}) {
  const resources = desired?.resources ?? [];
  const kinds = new Set(resources.map((r) => r.kind));
  const workers = [...new Set(resources.filter((r) => r.kind === 'worker').map((r) => r.name))].sort();
  const domains = kinds.has('custom-domain');
  /** @type {SetupPermission[]} */
  const out = readPermissions();
  out.push({
    name: 'Workers Editor',
    legacy: ['Workers Scripts Write'],
    scope: domains || !workers.length ? 'workers-product' : 'workers',
    ...(domains || !workers.length ? {} : { workers }),
    for: domains
      ? 'changing its Workers and their custom domains (custom domains have no per-Worker role yet)'
      : 'changing its Workers and their Durable Objects',
  });
  for (const w of KIND_WRITES)
    if (w.kinds.some((k) => kinds.has(k)))
      out.push({ name: w.name, scope: ZONE.has(w.name) ? 'zones' : 'account', for: w.for });
  const have = new Set(running);
  const missing = workers.filter((w) => !have.has(w));
  if (missing.length)
    out.push({
      name: 'Workers Admin',
      scope: 'workers-product',
      once: true,
      for: `making ${missing.join(', ')}, which ${missing.length === 1 ? 'doesn’t' : 'don’t'} run yet: give it for the first apply, then take it away`,
    });
  return out;
}

/**
 * The link that opens Cloudflare's create-token page for an account API token with every permission it can prefill,
 * and the ones to add by hand. Workers Editor scoped to chosen Workers, and Workers Admin, are always by hand.
 * @param {Array<{ name: string }>} permissions
 * @param {string} name the token's name, prefilled
 * @returns {{ url: string, prefilled: string[], byHand: string[] }}
 */
export function tokenTemplate(permissions, name) {
  const keys = [];
  const prefilled = [];
  const byHand = [];
  for (const p of permissions) {
    const key = TEMPLATE_KEYS[/** @type {keyof typeof TEMPLATE_KEYS} */ (p.name)];
    if (key) {
      keys.push(key);
      prefilled.push(p.name);
    } else byHand.push(p.name);
  }
  const query = `permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&name=${encodeURIComponent(name)}`;
  return { url: `${TEMPLATE_BASE}&${query}`, prefilled, byHand };
}
