/**
 * GitHub for the task board (docs/specs/CLD-24-github.md): the App's credentials, its JWT and
 * installation token, the REST calls a reconcile makes, webhook signatures, and how pull
 * requests link to tasks. It reads; the only writes are the owner's Update branch, Merge, Merge when
 * green, Promote, and Roll back (workflow dispatches) (`send`, `graphql`), pressed or sent by the owner's pull request settings, which
 * the Worker allows from the signed-in browser only.
 */
import { DEFAULTS } from './install.js';
import { secret } from './secrets.js';

const API = 'https://api.github.com';
const encoder = new TextEncoder();
/** The work-ID prefixes a pull request links to when nobody says otherwise: the legacy install's areas. */
export const DEFAULT_PREFIXES = ['PRD', 'BRD', 'MOD', 'OPS', 'CLD', 'DEBT', 'CMP'];

// ---- credentials -------------------------------------------------------------------------

/** The App's credentials, or null while it isn't connected (the secrets hold `unset`). */
export async function appCredentials(env) {
  const read = async (name) => {
    try {
      const value = (await secret(env, name)).trim();
      return value && value !== 'unset' ? value : null;
    } catch {
      return null;
    }
  };
  const [appId, key, webhookSecret] = await Promise.all([
    read('TASKS_GITHUB_APP_ID'),
    read('TASKS_GITHUB_KEY'),
    read('TASKS_GITHUB_WEBHOOK_SECRET'),
  ]);
  if (!appId || !key || !webhookSecret) return null;
  return { appId, key, webhookSecret };
}

/** `owner/name` → what GitHubClient and the manifest take. */
export function repoRef(github) {
  const [owner, repo] = String(github).split('/');
  return { owner, repo, full: `${owner}/${repo}` };
}

// ---- signatures --------------------------------------------------------------------------

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Checks X-Hub-Signature-256 (`sha256=<hex HMAC of the raw body>`) in constant time. */
export async function verifyWebhook(secretValue, body, header) {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretValue),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = encoder.encode(`sha256=${hex(await crypto.subtle.sign('HMAC', key, body))}`);
  const given = encoder.encode(header);
  if (given.length !== expected.length) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

// ---- the App's JWT and installation token ------------------------------------------------

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
const b64urlJson = (value) => b64url(encoder.encode(JSON.stringify(value)));

export async function appJwt(appId, pkcs8Pem, now = Date.now()) {
  const der = Uint8Array.from(atob(pkcs8Pem.replace(/-----[^-]+-----/gu, '').replace(/\s+/gu, '')), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iat, exp: iat + 540, iss: String(appId) })}`;
  return `${unsigned}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned)))}`;
}

export class GitHubError extends Error {
  /**
   * `reason` is GitHub's own message, to show as it is. A rate limit is always status 429 (GitHub sends 403 or
   * 429), so a read that treats 403 as "not permitted" never mistakes a used-up limit for a missing permission,
   * and `resetAt` says when GitHub takes calls again (ms).
   * @param {string} message
   * @param {number} status
   * @param {string | null} [reason]
   * @param {number | null} [resetAt]
   */
  constructor(message, status, reason = null, resetAt = null) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.resetAt = resetAt;
  }
}

/** Whether GitHub refused because a rate limit is used up (BRK-269). */
export const isRateLimited = (error) => error instanceof GitHubError && error.status === 429;

// ---- rate limits (BRK-269) ---------------------------------------------------------------
//
// An installation has two budgets: REST calls (`core`) and GraphQL points (`graphql`). The board spends
// less of both without any setting: reads are conditional (a 304 for an unchanged answer costs nothing),
// a sync reads its pull requests' details in one GraphQL query instead of four REST calls each, falling
// back to REST when GraphQL fails or is used up, and once GitHub says a budget is used up, the client
// stops calling it until it resets instead of spending more refusals.

/** How many answers a client remembers for conditional reads; the least recently used goes first. */
export const ETAG_ENTRIES = 300;
/** How long to wait after a secondary rate limit that names no time. */
const SECONDARY_WAIT_MS = 60_000;

/**
 * What a client remembers between calls: the installation token, the answers it can ask about again, each
 * budget's last known state, and how many calls it has made per budget and how many came back as free 304s
 * (BRK-271: a sync keeps the difference, so Connections shows what it spent).
 * @typedef {{
 *   installationId?: number,
 *   token?: string,
 *   expires?: number,
 *   etags?: Map<string, { etag: string, text: string }>,
 *   limits?: Record<string, { remaining: number, limit?: number, reset: number }>,
 *   calls?: Record<string, number>,
 *   free?: number,
 *   pausedUntil?: number,
 * }} GitHubCache
 */

const clock = (ms) => new Date(ms).toISOString().slice(11, 16);

/** A refusal for a budget that's used up, without calling GitHub. */
function limitError(resource, resetAt) {
  const what = resource === 'graphql' ? "GitHub's GraphQL rate limit" : "GitHub's API rate limit";
  return new GitHubError(
    `${what} is used up until ${clock(resetAt)} UTC: the board reads again after that.`,
    429,
    'rate limit exceeded',
    resetAt,
  );
}

/**
 * When `resource` can't be called yet (ms), or null when it can: its budget is used up, or GitHub asked
 * for a pause (a secondary limit), and that time hasn't come.
 * @param {GitHubCache | null} cache
 * @param {string} resource
 */
export function limitedUntil(cache, resource, now = Date.now()) {
  if (!cache) return null;
  const until = Math.max(
    cache.pausedUntil ?? 0,
    cache.limits?.[resource]?.remaining === 0 ? cache.limits[resource].reset : 0,
  );
  return until > now ? until : null;
}

/** Keeps what GitHub's headers say about the budget a response came from. */
function noteLimits(cache, headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === null || reset === null) return;
  const limit = Number(headers.get('x-ratelimit-limit'));
  cache.limits ??= {};
  cache.limits[headers.get('x-ratelimit-resource') ?? 'core'] = {
    remaining: Number(remaining),
    ...(limit > 0 ? { limit } : {}),
    reset: Number(reset) * 1000,
  };
}

/** Counts a call GitHub answered: a 304 is free, anything else is spent from its budget (BRK-271). */
function countCall(cache, res, resource) {
  if (res.status === 304) {
    cache.free = (cache.free ?? 0) + 1;
    return;
  }
  const spent = res.headers.get('x-ratelimit-resource') ?? resource;
  cache.calls ??= {};
  cache.calls[spent] = (cache.calls[spent] ?? 0) + 1;
}

/** A budget GitHub says is used up until `reset`, keeping its limit. */
function usedUp(cache, resource, reset) {
  cache.limits ??= {};
  cache.limits[resource] = { ...cache.limits[resource], remaining: 0, reset };
}

/**
 * When a refusal is a rate limit, when GitHub takes calls again (ms); null when it isn't one. A primary limit
 * says so with no calls remaining; a secondary one with Retry-After, or only in its message.
 */
function rateLimitReset(res, message, now = Date.now()) {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get('retry-after'));
  if (retryAfter > 0) return now + retryAfter * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    return reset > now ? reset : now + SECONDARY_WAIT_MS;
  }
  return res.status === 429 || /rate limit/iu.test(message ?? '') ? now + SECONDARY_WAIT_MS : null;
}

/** UTF-8 text as base64, for the contents API's writes. */
export const base64 = (text) => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The contents API's base64 (wrapped in newlines) back to UTF-8 text. */
export const fromBase64 = (content) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/**
 * Whether GitHub refused because the repository has no commits yet (CLD-191): it answers 409 "Git Repository
 * is empty." to /commits and /contents until the first push, which `npx breakaway repos init` makes.
 */
export const isEmptyRepo = (error) =>
  error instanceof GitHubError && error.status === 409 && /repository is empty/iu.test(error.reason ?? error.message);

/**
 * One call to GitHub. With a client's `cache`, a read is conditional (an unchanged answer comes back as a 304,
 * which GitHub doesn't count, and is served from the cache), the budget's state is kept from the headers, and a
 * budget known to be used up is refused here, without a call.
 * @param {string} path
 * @param {string} token
 * @param {{ method?: string, scheme?: string, base?: string, body?: any, cache?: GitHubCache | null, resource?: string, accept?: string | null }} [options]
 */
async function request(
  path,
  token,
  { method = 'GET', scheme = 'Bearer', base = API, body, cache = null, resource = 'core', accept = null } = {},
) {
  const waiting = limitedUntil(cache, resource);
  if (waiting) throw limitError(resource, waiting);
  if (cache && method === 'GET') cache.etags ??= new Map();
  const etags = cache && method === 'GET' ? cache.etags : null;
  const known = etags?.get(path);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: accept ?? 'application/vnd.github+json',
      Authorization: `${scheme} ${token}`,
      'User-Agent': 'breakaway',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(known ? { 'If-None-Match': known.etag } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (cache) {
    noteLimits(cache, res.headers);
    countCall(cache, res, resource);
  }
  if (res.status === 304 && known) {
    etags.delete(path); // most recently used goes last
    etags.set(path, known);
    return JSON.parse(known.text);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data.message ?? res.statusText;
    const resetAt = rateLimitReset(res, message);
    if (resetAt === null)
      throw new GitHubError(`GitHub ${res.status} on ${path.split('?')[0]}: ${message}`, res.status, message);
    if (cache) {
      if (res.headers.get('x-ratelimit-remaining') === '0')
        usedUp(cache, res.headers.get('x-ratelimit-resource') ?? resource, resetAt);
      else cache.pausedUntil = resetAt;
    }
    throw limitError(res.headers.get('x-ratelimit-resource') ?? resource, resetAt);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const etag = res.headers.get('etag');
  if (etags && etag) {
    etags.delete(path);
    etags.set(path, { etag, text });
    if (etags.size > ETAG_ENTRIES) etags.delete(etags.keys().next().value);
  }
  return text ? JSON.parse(text) : null;
}

/** A read as the App itself (its JWT): the App, its installations, and its webhook deliveries (Connections). */
export async function appGet(credentials, path, base = API) {
  return request(path, await appJwt(credentials.appId, credentials.key), { base });
}

/** A REST client for one repository, with the installation token cached until near expiry. */
export class GitHubClient {
  /** `base` is GitHub's API, or a stand-in for local work (TASKS_GITHUB_API). */
  constructor(credentials, repo, cache = {}, base = API) {
    this.credentials = credentials;
    this.repo = repo;
    this.cache = cache; // { installationId, token, expires }
    this.base = base;
  }

  async token() {
    if (this.cache.token && this.cache.expires - Date.now() > 300_000) return this.cache.token;
    const jwt = await appJwt(this.credentials.appId, this.credentials.key);
    if (!this.cache.installationId) {
      const installation = await request(`/repos/${this.repo.full}/installation`, jwt, { base: this.base });
      this.cache.installationId = installation.id;
    }
    const { token, expires_at: expires } = await request(
      `/app/installations/${this.cache.installationId}/access_tokens`,
      jwt,
      { method: 'POST', base: this.base },
    );
    this.cache.token = token;
    this.cache.expires = Date.parse(expires);
    return token;
  }

  /** A read on the repository, conditional when GitHub gave the last answer an ETag. */
  async get(path) {
    return request(`/repos/${this.repo.full}${path}`, await this.token(), { base: this.base, cache: this.cache });
  }

  /** A write (PUT, POST) on the repository; only the owner's buttons call it. */
  async send(method, path, body) {
    return request(`/repos/${this.repo.full}${path}`, await this.token(), {
      method,
      base: this.base,
      body: body ?? {},
      cache: this.cache,
    });
  }

  /**
   * GraphQL: what auto-merge needs (the REST API has no endpoint for it), and a sync's pull request details.
   * `accept` is the media type to ask for, when a field once needed a preview's.
   */
  async graphql(query, variables, { accept = null } = {}) {
    const data = await request('/graphql', await this.token(), {
      method: 'POST',
      base: this.base,
      body: { query, variables },
      cache: this.cache,
      resource: 'graphql',
      accept,
    });
    const [first] = data?.errors ?? [];
    if (first?.type === 'RATE_LIMITED') {
      const until = limitedUntil(this.cache, 'graphql') ?? Date.now() + SECONDARY_WAIT_MS;
      usedUp(this.cache, 'graphql', until);
      throw limitError('graphql', until);
    }
    if (first) throw new GitHubError(`GitHub: ${first.message}`, 422, first.message);
    return data?.data;
  }

  /** When `resource` (`core` or `graphql`) can be called again (ms), or null when it can now. */
  limitedUntil(resource) {
    return limitedUntil(this.cache, resource);
  }
}

// ---- a sync's pull request details in one query (BRK-269) --------------------------------

const DETAILS_FIELDS = `
  number
  mergeable
  mergeStateStatus
  reviews(first: 100) { nodes { state author { login } } }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { databaseId name status conclusion permalink detailsUrl startedAt }
              ... on StatusContext { context state targetUrl createdAt }
            }
          }
        }
      }
    }
  }`;

/** `mergeStateStatus` began behind this preview: asking for it costs nothing where it has graduated. */
export const MERGE_INFO_PREVIEW = 'application/vnd.github.merge-info-preview+json, application/vnd.github+json';

/**
 * One GraphQL query for the details a sync reads per pull request (checks, reviews, and whether it can merge):
 * about one point of the GraphQL budget for up to 20 pull requests, where REST spends four calls on each.
 * @param {number[]} numbers
 */
export function pullDetailsQuery(numbers) {
  const pulls = numbers.map((n) => `pr${Number(n)}: pullRequest(number: ${Number(n)}) { ...details }`).join('\n    ');
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${pulls}
  }
}
fragment details on PullRequest {${DETAILS_FIELDS}
}`;
}

const lower = (value) => (value == null ? null : String(value).toLowerCase());

/**
 * The query's answer → the same details the REST calls give (rollupChecks, reviewDecision, mergeable, and
 * mergeable_state), by pull request number. A pull request the answer leaves out isn't in the map, so the
 * caller reads it over REST. `open` is the numbers of open pull requests: only those carry a merge state.
 * @param {any} data
 * @param {Set<number>} open
 */
export function detailsFromGraphql(data, open) {
  /** @type {Map<number, { checks: any, review: any, mergeable: boolean | null, mergeableState: string | null }>} */
  const details = new Map();
  for (const pr of Object.values(data?.repository ?? {})) {
    if (!pr || typeof pr !== 'object' || !Number.isInteger(pr.number)) continue;
    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const runs = contexts
      .filter((c) => c?.__typename === 'CheckRun')
      .map((c) => ({
        id: c.databaseId,
        name: c.name,
        status: lower(c.status),
        conclusion: lower(c.conclusion),
        html_url: c.permalink ?? null,
        details_url: c.detailsUrl ?? null,
        started_at: c.startedAt ?? null,
      }));
    const statuses = contexts
      .filter((c) => c?.__typename === 'StatusContext')
      .map((c) => ({
        context: c.context,
        // GraphQL has EXPECTED (a required status that hasn't reported yet): REST shows it as pending.
        state: c.state === 'EXPECTED' ? 'pending' : lower(c.state),
        target_url: c.targetUrl ?? null,
        created_at: c.createdAt ?? null,
      }));
    const reviews = (pr.reviews?.nodes ?? []).map((r) => ({ state: r?.state, user: r?.author ?? null }));
    const isOpen = open.has(pr.number);
    details.set(pr.number, {
      checks: rollupChecks(runs, statuses),
      review: reviewDecision(reviews),
      mergeable: !isOpen ? null : pr.mergeable === 'MERGEABLE' ? true : pr.mergeable === 'CONFLICTING' ? false : null,
      // UNKNOWN is GitHub still working it out, which REST says with null.
      mergeableState: isOpen && pr.mergeStateStatus !== 'UNKNOWN' ? lower(pr.mergeStateStatus) : null,
    });
  }
  return details;
}

// ---- linking pull requests to tasks ------------------------------------------------------

const patterns = new Map();

/** The regular expressions for a set of prefixes (every registered repository's), made once per set. */
function widPatterns(prefixes) {
  const alternation = [...new Set(prefixes?.length ? prefixes : DEFAULT_PREFIXES)].sort().join('|');
  let p = patterns.get(alternation);
  if (!p) {
    const wid = `(?:${alternation})-\\d+`;
    p = {
      wid: new RegExp(`\\b(${alternation})-(\\d+)\\b`, 'giu'),
      inlineCode: new RegExp(`\`\\s*(${wid})\\s*\``, 'giu'),
      // GitHub's closing keywords, starting a sentence or line (a list item counts) and directly
      // followed by one or more work IDs: "Closes CLD-24.", "- Fixes PRD-5, PRD-12 and OPS-1".
      // Prose never closes: "its first sync finished OPS-8" or "we fixed OPS-8's layout" only mention.
      closing: new RegExp(
        `^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*(${wid}(?:\\s*(?:,|&|\\band\\b)\\s*${wid})*)`,
        'iu',
      ),
    };
    patterns.set(alternation, p);
  }
  return p;
}

export function widsIn(text, prefixes) {
  return [
    ...new Set(
      [...String(text ?? '').matchAll(widPatterns(prefixes).wid)].map((m) => `${m[1].toUpperCase()}-${Number(m[2])}`),
    ),
  ];
}

/**
 * Text a closing keyword may be in: without fenced code blocks and quoted lines, which talk
 * about work rather than claim it. Inline code keeps a bare work ID (`CLD-24`) and loses the rest.
 */
function claimable(text, prefixes) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/gu, '\n')
    .split('\n')
    .filter((line) => !/^\s*>/u.test(line))
    .join('\n')
    .replace(widPatterns(prefixes).inlineCode, '$1')
    .replace(/`[^`\n]*`/gu, ' ');
}

/**
 * The work IDs a pull request closes (a sentence or line in its title or description that starts
 * with Closes/Fixes/Resolves and the IDs) and the ones it only mentions (anywhere else, the
 * branch name included: a spec or planning PR often carries the ID without finishing it).
 * `prefixes` are the work-ID prefixes to look for: every registered repository's.
 */
export function linkedWids({ title, body, branch }, prefixes) {
  const { closing } = widPatterns(prefixes);
  const closes = new Set();
  for (const text of [title, body]) {
    for (const sentence of claimable(text, prefixes).split(/\n|(?<=[.!?;])\s+/u)) {
      const m = closing.exec(sentence.trim().replace(/^(?:[-*+]|\d+[.)])\s+/u, ''));
      if (m) for (const wid of widsIn(m[1], prefixes)) closes.add(wid);
    }
  }
  const mentions = new Set(
    [title, body, String(branch ?? '').replace(/[/_]/gu, ' ')]
      .flatMap((t) => widsIn(t, prefixes))
      .filter((w) => !closes.has(w)),
  );
  return { closes: [...closes], mentions: [...mentions] };
}

/**
 * A pull request closes only tasks of its own repository: a closing ID whose prefix belongs to another
 * registered repository (`owners`: prefix → slug) becomes a mention, listed in `elsewhere` with where it belongs.
 */
export function ownLinks({ closes, mentions }, slug, owners) {
  const elsewhere = {};
  const own = [];
  for (const wid of closes) {
    const owner = owners.get(wid.split('-')[0]);
    if (owner && owner !== slug) elsewhere[wid] = owner;
    else own.push(wid);
  }
  for (const wid of mentions) {
    const owner = owners.get(wid.split('-')[0]);
    if (owner && owner !== slug) elsewhere[wid] = owner;
  }
  return { closes: own, mentions: [...mentions, ...closes.filter((w) => !own.includes(w))], elsewhere };
}

// ---- summaries ---------------------------------------------------------------------------

/** The states a check fails in, after each check's newest run is picked. */
export const FAILED_CHECK = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'error',
]);

/**
 * Check runs and commit statuses → one roll-up and the list of checks by name.
 * Each name's newest run wins (by start time, then id), whatever order GitHub lists them in, so a run
 * cancelled because a newer one started on the same commit doesn't count as failing (BRK-170). Runs
 * without a start time or id keep the old rule: the later one in the list wins.
 */
export function rollupChecks(checkRuns = [], statuses = []) {
  const runs = [
    ...checkRuns.map((c) => ({
      name: c.name,
      state: c.status === 'completed' ? (c.conclusion ?? 'neutral') : c.status,
      url: c.html_url ?? c.details_url ?? null,
      at: Date.parse(c.started_at ?? c.created_at ?? '') || 0,
      id: Number(c.id) || 0,
    })),
    ...statuses.map((s) => ({
      name: s.context,
      state: s.state === 'pending' ? 'in_progress' : s.state,
      url: s.target_url ?? null,
      at: Date.parse(s.updated_at ?? s.created_at ?? '') || 0,
      id: Number(s.id) || 0,
    })),
  ];
  /** @type {Map<string, typeof runs[number]>} */
  const byName = new Map();
  for (const r of runs) {
    const seen = byName.get(r.name);
    if (!seen || r.at > seen.at || (r.at === seen.at && r.id >= seen.id)) byName.set(r.name, r);
  }
  const list = [...byName.values()]
    .map(({ name, state, url }) => ({ name, state, url }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let state = 'none';
  if (list.some((r) => FAILED_CHECK.has(r.state))) state = 'failure';
  else if (list.some((r) => ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(r.state)))
    state = 'pending';
  else if (list.length) state = 'success';
  return {
    state,
    total: list.length,
    passed: list.filter((r) => ['success', 'neutral', 'skipped'].includes(r.state)).length,
    runs: list,
  };
}

/** Reviews → the decision that counts: each reviewer's latest non-comment review. */
export function reviewDecision(reviews = []) {
  const latest = new Map();
  let comments = 0;
  for (const r of reviews) {
    if (r.state === 'COMMENTED') comments += 1;
    else if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
      latest.set(r.user?.login ?? '?', r.state);
  }
  const states = [...latest.values()];
  const decision = states.includes('CHANGES_REQUESTED')
    ? 'changes_requested'
    : states.includes('APPROVED')
      ? 'approved'
      : comments
        ? 'commented'
        : 'none';
  return { decision, reviewers: [...latest.keys()], comments };
}

/** What each verdict means to the owner, in the order the inbox sorts them (ready to merge first). */
export const VERDICTS = ['ready', 'conflicts', 'failing', 'behind', 'running', 'review', 'unknown', 'draft'];

/**
 * One verdict for an open pull request, from GitHub's own `mergeable_state` (`dirty`, `behind`,
 * `blocked`, `clean`, `unstable`, `has_hooks`, or null while it computes) and the checks and
 * reviews, never a guess: null `mergeable` with no state is "unknown", shown as "checking".
 */
export function prVerdict({ draft, mergeable, mergeableState, checks, review }) {
  if (draft) return 'draft';
  if (mergeable === false || mergeableState === 'dirty') return 'conflicts';
  if (checks?.state === 'failure') return 'failing';
  if (mergeableState === 'behind') return 'behind';
  if (checks?.state === 'pending') return 'running';
  if (mergeableState === 'blocked') return 'review';
  if (review?.decision === 'changes_requested') return 'review';
  if (['clean', 'unstable', 'has_hooks'].includes(mergeableState)) return 'ready';
  return 'unknown';
}

/** Sorts pull requests by what needs the owner: their verdict's place in VERDICTS, then newest. */
export function byInbox(a, b) {
  return (
    VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) ||
    String(b.updated ?? '').localeCompare(String(a.updated ?? ''))
  );
}

export function prState(pr) {
  if (pr.merged_at) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

/** A commit message's PR number: "… (#31)" from a squash, or "Merge pull request #31". */
export function prNumberOf(message) {
  const m = /Merge pull request #(\d+)/u.exec(message) ?? /\(#(\d+)\)\s*$/mu.exec(String(message).split('\n')[0]);
  return m ? Number(m[1]) : null;
}

/**
 * A GitHub Deployment plus its latest status → what the board keeps. The Deploy workflow puts
 * the version ID and migrations in the status description ("version <id> · migrations <names>"),
 * and `task` is "deploy" or "rollback".
 */
export function deployFrom(deployment, status) {
  const description = status?.description ?? deployment.description ?? null;
  const state = status?.state ?? 'pending';
  return {
    id: deployment.id,
    env: deployment.environment,
    sha: deployment.sha,
    task: deployment.task ?? 'deploy',
    state,
    landed: state === 'success',
    description,
    version:
      /\bversion ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{6,})/iu.exec(description ?? '')?.[1] ?? null,
    migrations: /migrations ([^·]+?)\s*$/iu.exec(description ?? '')?.[1] ?? null,
    created: deployment.created_at,
    updated: status?.created_at ?? deployment.updated_at ?? deployment.created_at,
    logUrl: status?.log_url ?? null,
    by: deployment.creator?.login ?? null,
  };
}

/** The merged pull requests a set of commits shipped: by "(#31)" / "Merge pull request #31" or by merge commit. */
export function shippedPrs(prs, commits) {
  const shas = new Set(commits.map((c) => c.sha));
  const numbers = new Set(commits.map((c) => prNumberOf(c.message)).filter(Boolean));
  return prs.filter(
    (pr) => pr.state === 'merged' && (numbers.has(pr.number) || (pr.mergeSha && shas.has(pr.mergeSha))),
  );
}

/** The manifest for GitHub's "register an app from a manifest" flow, named after the install (src/install.js). */
export function appManifest(origin, repo, name = /** @type {string} */ (DEFAULTS.name)) {
  return {
    name,
    url: origin,
    description: `Link between ${repo.full} and the task board ${name}: reads it, and merges or updates a pull request, or starts Promote and Roll back, only when the owner asks.`,
    hook_attributes: { url: `${origin}/github/webhook`, active: true },
    redirect_url: `${origin}/github/connected`,
    public: false,
    default_permissions: {
      metadata: 'read',
      contents: 'write', // update branch and merge
      pull_requests: 'write',
      checks: 'write', // post an infrastructure change's plan as a check (BRK-185)
      actions: 'write', // start Promote and Roll back
      statuses: 'read',
      deployments: 'read',
      vulnerability_alerts: 'read',
      issues: 'read', // routines that start on an opened or reopened issue
      actions_variables: 'write', // Freeze sets DEPLOYS_PAUSED, and the sync reads it
    },
    default_events: [
      'pull_request',
      'pull_request_review',
      'check_suite',
      'check_run',
      'workflow_run',
      'status',
      'push',
      'dependabot_alert',
      'deployment',
      'deployment_status',
      'release',
      'issues',
    ],
  };
}

// ---- routine triggers --------------------------------------------------------------------

/** The GitHub events a routine can listen for (docs/specs/IDEA-4-routines.md): key to what it means. */
export const ROUTINE_GITHUB_EVENTS = {
  pr_merged: 'a pull request is merged',
  release_published: 'a release is published',
  workflow_failed: 'a workflow run fails',
  issue_opened: 'an issue is opened',
  issue_reopened: 'an issue is reopened',
};

/**
 * Turns a verified webhook into `{ event, key, data }` when it is one of the allowlisted events, or
 * null. `key` names the thing that happened (so a redelivery starts nothing twice); `data` holds only
 * a title, number, and URL, which the routine sees as untrusted trigger data.
 */
export function routineEventOf(event, payload) {
  const p = payload ?? {};
  const short = (v) => String(v ?? '').slice(0, 200);
  if (event === 'pull_request' && p.action === 'closed' && p.pull_request?.merged === true) {
    const pr = p.pull_request;
    return {
      event: 'pr_merged',
      key: `pr:${pr.number}`,
      data: { event: 'pull request merged', title: short(pr.title), number: pr.number, url: short(pr.html_url) },
    };
  }
  if (event === 'release' && p.action === 'published' && p.release && !p.release.draft) {
    const r = p.release;
    return {
      event: 'release_published',
      key: `release:${r.id}`,
      data: {
        event: 'release published',
        title: short(r.name || r.tag_name),
        tag: short(r.tag_name),
        url: short(r.html_url),
      },
    };
  }
  if (event === 'workflow_run' && p.action === 'completed' && p.workflow_run?.conclusion === 'failure') {
    const w = p.workflow_run;
    return {
      event: 'workflow_failed',
      key: `run:${w.id}:${w.run_attempt ?? 1}`,
      data: {
        event: 'workflow run failed',
        title: short(w.name),
        number: w.run_number,
        branch: short(w.head_branch),
        url: short(w.html_url),
      },
    };
  }
  // GitHub's `issues` events are for issues only; a pull request's own events start pr_merged.
  if (event === 'issues' && (p.action === 'opened' || p.action === 'reopened') && p.issue && !p.issue.pull_request) {
    const i = p.issue;
    const opened = p.action === 'opened';
    return {
      event: opened ? 'issue_opened' : 'issue_reopened',
      // Opened happens once per issue; each reopening is its own, told apart by when it happened.
      key: opened ? `issue:${i.number}` : `issue:${i.number}:reopened:${short(i.updated_at)}`,
      data: {
        event: opened ? 'issue opened' : 'issue reopened',
        title: short(i.title),
        number: i.number,
        url: short(i.html_url),
      },
    };
  }
  return null;
}
