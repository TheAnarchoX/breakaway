// What a sync spends of GitHub's rate limits (BRK-271), per repository: each budget's last known state from
// GitHub's x-ratelimit-* headers, and the calls the last sync made and the free 304s it got. The store keeps it
// in meta after each reconcile, so it survives the Durable Object restarting; Connections and the GitHub view
// show it in words. Pure, so the web app uses the same words.

/** The budgets the board shows, in order, with their names in the words. */
export const BUDGETS = [
  ['core', 'REST'],
  ['graphql', 'GraphQL'],
];

/**
 * A repository's budgets after its last sync.
 * @typedef {{
 *   at: string,
 *   limits: Record<string, { remaining: number, limit?: number, reset: string }>,
 *   calls: Record<string, number>,
 *   free: number,
 * }} GitHubBudget
 */

/**
 * What a client has counted so far, to subtract after a sync.
 * @param {{ calls?: Record<string, number>, free?: number } | null | undefined} cache
 */
export const countsOf = (cache) => ({ calls: { ...(cache?.calls ?? {}) }, free: cache?.free ?? 0 });

/**
 * The budgets to keep after a sync: each one's state from the client (else the last kept, for a budget this
 * sync didn't touch), and what the sync spent, the client's counts since `before`.
 * @param {GitHubBudget | null} previous
 * @param {{ limits?: Record<string, { remaining: number, limit?: number, reset: number }>, calls?: Record<string, number>, free?: number } | null | undefined} cache
 * @param {{ calls: Record<string, number>, free: number }} before
 * @returns {GitHubBudget}
 */
export function budgetAfterSync(previous, cache, before, at = Date.now()) {
  /** @type {GitHubBudget['limits']} */
  const limits = { ...(previous?.limits ?? {}) };
  for (const [name, state] of Object.entries(cache?.limits ?? {})) {
    const limit = state.limit ?? limits[name]?.limit;
    limits[name] = {
      remaining: state.remaining,
      ...(limit ? { limit } : {}),
      reset: new Date(state.reset).toISOString(),
    };
  }
  /** @type {Record<string, number>} */
  const calls = { core: 0, graphql: 0 };
  for (const [name, n] of Object.entries(cache?.calls ?? {})) calls[name] = Math.max(0, n - (before.calls[name] ?? 0));
  return { at: new Date(at).toISOString(), limits, calls, free: Math.max(0, (cache?.free ?? 0) - before.free) };
}

const count = (n) => Number(n).toLocaleString('en-US');
const clock = (iso) => `${iso.slice(11, 16)} UTC`;

/**
 * The budgets in a line: "REST 4,812 of 5,000 left · GraphQL 4,990 of 5,000 left · resets 20:00 UTC · last
 * sync 6 calls (4 REST, 2 GraphQL), 9 free". The reset is the soonest still to come; null when nothing is known.
 * @param {GitHubBudget | null | undefined} budget
 */
export function budgetWords(budget, now = Date.now()) {
  if (!budget) return null;
  const parts = [];
  for (const [name, label] of BUDGETS) {
    const b = budget.limits?.[name];
    if (b) parts.push(`${label} ${count(b.remaining)}${b.limit ? ` of ${count(b.limit)}` : ''} left`);
  }
  const resets = BUDGETS.map(([name]) => budget.limits?.[name]?.reset)
    .filter((r) => r && Date.parse(r) > now)
    .sort();
  if (resets.length) parts.push(`resets ${clock(resets[0])}`);
  const spent = BUDGETS.filter(([name]) => budget.calls?.[name]);
  const total = spent.reduce((n, [name]) => n + budget.calls[name], 0);
  const calls =
    spent.length > 1
      ? `${count(total)} calls (${spent.map(([name, label]) => `${count(budget.calls[name])} ${label}`).join(', ')})`
      : spent.length
        ? `${count(total)} ${spent[0][1]} ${total === 1 ? 'call' : 'calls'}`
        : null;
  const free = budget.free ? `${count(budget.free)} free` : null;
  parts.push(
    calls || free ? `last sync ${[calls ?? 'no calls', free ?? '0 free'].join(', ')}` : 'last sync made no calls',
  );
  return parts.join(' · ');
}

/** REST's budget as Connections' low-limit check reads it, or null. */
export function restBudget(budget) {
  const core = budget?.limits?.core;
  return core?.limit ? { remaining: core.remaining, limit: core.limit, reset: core.reset } : null;
}
