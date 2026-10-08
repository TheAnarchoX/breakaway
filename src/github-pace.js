// How fast the board syncs a busy repository (BRK-272): one with an open pull request whose checks run, or an
// agent on one, syncs each minute from the Durable Object's alarm instead of waiting for the 5-minute cron. The
// pace comes from the budgets the last syncs left (BRK-271), with no setting: the board plans to spend at most
// half of an hour's budget across every repository, less as what's left before the reset shrinks, so the owner's
// buttons (merge, update branch) always have room. Slower than the cron, it stops, and the cron carries on. Pure.

import { BUDGETS } from './github-budget.js';

/** The fastest a busy repository syncs. */
export const FAST_MS = 60_000;
/** The cron's pace: every repository syncs this often anyway. */
export const CRON_MS = 300_000;
/** The share of an hour's budget the board plans to spend on syncs. */
export const SHARE = 0.5;
const HOUR_MS = 3_600_000;

/**
 * What one sync of each repository costs from budget `name`, summed: its last sync's calls, at least one REST call.
 * @param {{ budget: import('./github-budget.js').GitHubBudget | null }[]} repos
 * @param {string} name
 */
const costOf = (repos, name) =>
  repos.reduce((n, r) => n + Math.max(name === 'core' ? 1 : 0, r.budget?.calls?.[name] ?? 0), 0);

/**
 * The calls an hour the board may plan to spend from one budget: half its hourly limit, or half of what's left
 * before it resets when that's less. A budget past its reset is whole again. Null when nothing is known of it.
 * @param {{ remaining: number, limit?: number, reset: string } | null | undefined} state
 */
export function hourlyAllowance(state, now = Date.now()) {
  if (!state) return null;
  const cap = state.limit ? state.limit * SHARE : Number.POSITIVE_INFINITY;
  const reset = Date.parse(state.reset);
  if (!(reset > now)) return state.limit ? cap : null;
  // GitHub's window is an hour: a reset further off than that is read as an hour away.
  const window = Math.min(Math.max(reset - now, FAST_MS), HOUR_MS);
  const left = Math.max(0, state.remaining) * SHARE * (HOUR_MS / window);
  return Math.min(cap, left);
}

/**
 * How often a busy repository syncs: the milliseconds between its syncs, or null when the budgets leave no room
 * to sync faster than the cron. Each repository's last sync says what a sync costs it (at least one REST call);
 * the cron's syncs of every repository are counted first, and the budget with the least room sets the pace.
 * Repositories may share one installation's budgets, so the least any of them has left is what's planned on.
 * @param {{ budget: import('./github-budget.js').GitHubBudget | null, busy: boolean }[]} repos
 */
export function syncPace(repos, now = Date.now()) {
  const busy = repos.filter((r) => r.busy);
  if (!busy.length) return null;
  let pace = FAST_MS;
  for (const [name] of BUDGETS) {
    const each = costOf(busy, name);
    if (!each) continue;
    const known = repos
      .map((r) => hourlyAllowance(r.budget?.limits?.[name], now))
      .filter((a) => a !== null)
      .map(Number);
    if (!known.length) return null;
    const cron = (costOf(repos, name) * HOUR_MS) / CRON_MS;
    const room = Math.min(...known) - cron;
    if (room <= 0) return null;
    pace = Math.max(pace, Math.ceil((each * HOUR_MS) / room / 1000) * 1000);
  }
  return pace < CRON_MS ? pace : null;
}

/**
 * The calls an hour the board plans to spend from budget `name` at `pace`: every repository's cron syncs, and each
 * busy one's at the pace. What the tests hold under half the budget.
 * @param {{ budget: import('./github-budget.js').GitHubBudget | null, busy: boolean }[]} repos
 * @param {number | null} pace
 * @param {string} name
 */
export function plannedPerHour(repos, pace, name) {
  const fast = pace
    ? (costOf(
        repos.filter((r) => r.busy),
        name,
      ) *
        HOUR_MS) /
      pace
    : 0;
  return (costOf(repos, name) * HOUR_MS) / CRON_MS + fast;
}
