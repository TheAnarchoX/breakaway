/**
 * Run keys (BRK-324, docs/specs/BRK-299-people-and-roles.md, point 4): what caps an agent the board starts on a
 * repository's lent routine to the rights of the person the run is for, by credential rather than by the name it gives.
 *
 * A start on a lent routine gets a key of its own, handed only to that run in its payload (`Run key:`), as a runbook's
 * run gets its act key. The agent sends it in its own header, X-Breakaway-Run-Key, which a cloud session's proxy leaves
 * alone: the proxy replaces any Authorization header with the credential its environment holds (checked on 10 Oct 2026,
 * BRK-345). A request that carries a key is that person's, with their rights and no more, whatever else it carries. The
 * board keeps only the key's SHA-256; it works while the agent it was made for holds the run's task, for RUN_KEY_MS at
 * most, and a new start on the task replaces it.
 *
 * Pure: the shape, the header, and how a key is made and hashed, for the Worker, /mcp, and the store.
 */

/** The header a run key travels in: never Authorization, which a cloud session's proxy replaces (BRK-345). */
export const RUN_KEY_HEADER = 'X-Breakaway-Run-Key';
/** Where a run key starts, so it's told from a personal token (`bkp_`) and an act key (`act_`) at a glance. */
export const RUN_KEY_PREFIX = 'bkr_';
/** A run key's shape: the prefix and 64 hex digits. */
export const RUN_KEY = /^bkr_[0-9a-f]{64}$/u;
const HOUR_MS = 3_600_000;
/**
 * How long a run key works at most, the board's choice: a day covers a run that builds, opens its pull request, and
 * watches it; a run that goes on longer is started again for a new key. The run's claim ending ends it sooner.
 */
export const RUN_KEY_MS = 24 * HOUR_MS;

const encoder = new TextEncoder();

/** A new run key. */
export function makeRunKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${RUN_KEY_PREFIX}${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A run key's SHA-256, in hex: all the board keeps of it. */
export async function runKeyHash(key) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(key))))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The run key a request carries, trimmed: `''` when it carries none, else whatever its header holds (the store says
 * whether it's a key at all). The board takes one as `Authorization: Bearer bkr_…` too (BRK-345), which reaches it only
 * from an environment whose proxy adds no credential; the CLI always sends the header.
 * @param {Request} request
 */
export function runKeyOf(request) {
  const own = (request.headers.get(RUN_KEY_HEADER) ?? '').trim();
  if (own) return own;
  const bearer = /^Bearer\s+(bkr_\S*)$/u.exec((request.headers.get('Authorization') ?? '').trim());
  return bearer ? bearer[1] : '';
}
