/**
 * Health you can trust (BRK-266; docs/specs/IDEA-19-architect.md, "Health and alerts, as built"): what the inventory
 * keeps when a read fails, and the environment's own health URL.
 *
 * A provider's `observe` says `unknown` only when it couldn't read a resource, and says which call. The inventory then
 * keeps the resource's last known health with its age (`keepLastHealth`), and notes what failed, instead of replacing
 * it with unknown. A quiet resource is `idle`, which counts as healthy.
 *
 * An environment's desired state may name a health URL (`"health": { "url": "https://staging.example/health" }`): the
 * owner's own service, which the board GETs on each refresh as an active check of the front door, with no credentials
 * and a short timeout (`readHealthUrl`). What it answers becomes the health of the environment's routes and custom
 * domains (`withHealthUrl`). Pure apart from the `fetch` it's handed, so the CLI's `infra check` can use the field check.
 */

/** @typedef {import('./infra-provider.js').Health} Health */

/** How long the board waits for a health URL before calling the front door down. */
export const HEALTH_URL_TIMEOUT_MS = 5000;
/** The longest health URL a desired state may name. */
export const HEALTH_URL_MAX = 300;

/** Worst first. Idle ranks with healthy: a quiet resource is fine. */
const RANK = { down: 0, degraded: 1, unknown: 2, healthy: 3, idle: 3 };

/**
 * What's wrong with a desired state's `health`, in words, or null when it's fine: `{ "url": "https://…" }`, an https
 * URL with no user name or password in it, up to HEALTH_URL_MAX characters.
 * @param {unknown} value
 * @returns {{ field: string, message: string } | null}
 */
export function checkHealthField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { field: 'health', message: 'health is an object: { "url": "https://staging.example/health" }' };
  for (const key of Object.keys(value))
    if (key !== 'url') return { field: `health.${key}`, message: `“${key}” isn’t part of health: it has url` };
  const url = /** @type {any} */ (value).url;
  const said = {
    field: 'health.url',
    message: `url is an https address the board GETs on each refresh, up to ${HEALTH_URL_MAX} characters, like https://staging.example/health`,
  };
  if (typeof url !== 'string' || !url || url.length > HEALTH_URL_MAX) return said;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return said;
  }
  if (parsed.protocol !== 'https:') return said;
  if (parsed.username || parsed.password)
    return {
      field: 'health.url',
      message: 'url has a user name or password in it: the repository is read by the board, so leave credentials out',
    };
  return null;
}

/**
 * GETs an environment's health URL once: no credentials, no redirects followed, and HEALTH_URL_TIMEOUT_MS at most.
 * An answer under 400 is healthy; a 4xx is degraded (it answers, but not at that address); a 5xx, a timeout, or no
 * answer is down. The text names the host, so the owner sees what the board calls.
 * @param {string} url
 * @param {typeof fetch} doFetch
 * @param {{ timeoutMs?: number, now?: () => number }} [options]
 * @returns {Promise<{ state: 'healthy' | 'degraded' | 'down', text: string }>}
 */
export async function readHealthUrl(url, doFetch, { timeoutMs = HEALTH_URL_TIMEOUT_MS, now = Date.now } = {}) {
  const host = new URL(url).host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: '*/*' },
      redirect: 'manual',
      signal: controller.signal,
    });
    await res.body?.cancel().catch(() => {});
    const ms = Math.max(0, Math.round(now() - started));
    const said = `The health URL on ${host} answered ${res.status} in ${ms} ms`;
    if (res.status >= 500) return { state: 'down', text: said };
    if (res.status >= 400) return { state: 'degraded', text: `${said}: check the address in the desired state` };
    return { state: 'healthy', text: said };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      state: 'down',
      text: timedOut
        ? `The health URL on ${host} didn’t answer within ${Math.round(timeoutMs / 1000)} s`
        : `The health URL on ${host} couldn’t be reached (${String(/** @type {any} */ (error)?.message ?? error).slice(0, 80)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Puts a health URL's answer on the environment's front door: the routes and custom domains whose host is the URL's,
 * or every route and custom domain when none matches. A front door's health is then the worse of its own and the
 * URL's, and a passing check lifts an idle or unknown one to healthy, since it just served a request. With no front
 * door, nothing changes.
 * @param {Array<{ id: string, kind: string, name: string, attrs?: Record<string, unknown> }>} resources
 * @param {Health[]} health from `observe`
 * @param {string} url
 * @param {{ state: string, text: string }} check from `readHealthUrl`
 * @param {string} at when it was checked, ISO 8601
 * @returns {Health[]}
 */
export function withHealthUrl(resources, health, url, check, at) {
  const host = new URL(url).hostname.toLowerCase();
  const front = resources.filter((r) => r.kind === 'route' || r.kind === 'custom-domain');
  if (!front.length) return health;
  const hostOf = (r) => {
    const a = /** @type {any} */ (r.attrs ?? {});
    const raw = String(r.kind === 'custom-domain' ? (a.hostname ?? r.name) : (a.pattern ?? r.name));
    return raw
      .toLowerCase()
      .replace(/^\*\.?/u, '')
      .split('/')[0];
  };
  const matched = front.filter((r) => hostOf(r) === host);
  const on = new Set((matched.length ? matched : front).map((r) => r.id));
  const byId = new Map(health.map((h) => [h.resource, h]));
  for (const id of on) {
    const own = byId.get(id);
    const ownRank = own ? (RANK[own.state] ?? 2) : 2;
    const urlRank = RANK[check.state] ?? 2;
    let state = check.state;
    let text = check.text;
    // Its own health stays when it's worse than the URL's: a passing check doesn't hide failing requests.
    if (own && ownRank < urlRank && own.state !== 'unknown') {
      state = own.state;
      text = `${own.text ?? ''}; ${check.text}`.replace(/^; /u, '');
    }
    byId.set(id, { resource: id, state, at, text });
  }
  return health.map((h) => byId.get(h.resource) ?? h);
}

/**
 * What the inventory stores for a resource's health (BRK-266): what `observe` said, unless it said unknown (or failed
 * altogether) and the resource had a known health before. Then the last health stays, with its time, so its age shows,
 * and `note` says what couldn't be read.
 * @param {Health | null} h what observe said about it, or null when observe failed
 * @param {{ health?: string | null, health_at?: number | null, health_text?: string | null } | undefined} last
 * @param {string | null} failed why observe failed, when it did
 * @returns {{ state: string | null, at: number | null, text: string | null, note: string | null }}
 */
export function keepLastHealth(h, last, failed = null) {
  const known = last?.health && last.health !== 'unknown';
  const kept = () => ({
    state: last?.health ?? null,
    at: last?.health_at ?? null,
    text: last?.health_text ?? null,
  });
  if (!h) return { ...kept(), note: failed ? `Couldn’t read its health: ${failed}` : null };
  if (h.state === 'unknown' && known) return { ...kept(), note: h.text ?? 'Couldn’t read its health' };
  return { state: h.state, at: Date.parse(h.at), text: h.text ?? null, note: null };
}

/**
 * An environment's health from its resources' (BRK-266): down and degraded win, with how many; otherwise healthy
 * when any resource is healthy or idle (idle alone reads idle), with how many couldn't be read (unknown, or kept from
 * an earlier read) as `notRead`; unknown only when none is healthy or idle.
 * @param {Array<{ state?: string | null, note?: string | null } | null | undefined>} healths
 * @returns {{ state: string, count: number, total: number, notRead: number } | null}
 */
export function rollUpHealth(healths) {
  if (!healths.length) return null;
  const states = healths.map((h) => h?.state ?? 'unknown');
  const total = states.length;
  for (const bad of ['down', 'degraded']) {
    const count = states.filter((s) => s === bad).length;
    if (count) return { state: bad, count, total, notRead: 0 };
  }
  const notRead = healths.filter((h) => !h?.state || h.state === 'unknown' || h?.note).length;
  const healthy = states.filter((s) => s === 'healthy').length;
  const idle = states.filter((s) => s === 'idle').length;
  if (healthy) return { state: 'healthy', count: healthy + idle, total, notRead };
  if (idle) return { state: 'idle', count: idle, total, notRead };
  return { state: 'unknown', count: total, total, notRead };
}
