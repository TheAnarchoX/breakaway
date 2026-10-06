/**
 * Architect's cost attribution and budgets, the pure part (docs/specs/IDEA-19-architect.md, "Cost"; BRK-199). Each
 * resource's estimate from the inventory (BRK-177) is summed by environment, by repository, and by the task that owns
 * a short-lived environment, in the board's currency (BRK-226), and each environment's total is checked against its
 * budget from the repository's policy (BRK-181; 20 a month by default, BRK-172). src/store-infra-costs.js keeps a
 * monthly series and sends one signal when an environment's month goes near or over its budget.
 *
 * Every amount is an estimate, per month. A resource with no estimate, or one in a currency no rate covers, is counted
 * as unknown: a total with unknowns is a floor, so it can say an environment is over (or near) its budget, but never
 * that it's inside it. Pure and Node-safe, so the CLI can import it.
 */
import { convert } from './infra-currency.js';
import { money } from './infra-policy.js';

/** An environment is near its budget from this share of it. */
export const BUDGET_NEAR = 0.8;
/** How many months of each environment's series are kept. */
export const COST_MONTHS = 24;
/** A budget's states, from best to worst: `unknown` sits apart, since it can't be compared. */
export const BUDGET_STATES = ['inside', 'near', 'over', 'unknown'];

/**
 * A resource's estimate, as the inventory keeps it, with what owns it.
 * @typedef {{ environmentId: number, environment: string, repo: string, task: string | null,
 *   amount: number | null, currency: string | null }} CostRow
 */

/**
 * What a group of resources costs a month, in the board's currency: `amount` adds up what could be converted, and
 * `unknown` counts the resources that couldn't (no estimate, or no rate for their currency).
 * @typedef {{ amount: number, currency: string, resources: number, unknown: number, estimate: true }} CostTotal
 */

const round = (n) => Math.round(n * 100) / 100;

/** The UTC month a time falls in, as YYYY-MM. */
export function monthOf(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** An empty total in `currency`. @returns {CostTotal} */
const empty = (currency) => ({ amount: 0, currency, resources: 0, unknown: 0, estimate: true });

/**
 * Sums the inventory's estimates by environment, repository, and owning task, in the board's currency. A task's total
 * is its short-lived environments'; an environment no task owns counts only toward its repository.
 * @param {CostRow[]} rows
 * @param {import('./infra-currency.js').CurrencySetting} setting
 * @returns {{ environments: Map<number, CostTotal>, repositories: Map<string, CostTotal>, tasks: Map<string, CostTotal> }}
 */
export function sumCosts(rows, setting) {
  const environments = new Map();
  const repositories = new Map();
  const tasks = new Map();
  const add = (map, key, amount) => {
    if (!map.has(key)) map.set(key, empty(setting.currency));
    const total = map.get(key);
    total.resources++;
    if (amount === null) total.unknown++;
    else total.amount = round(total.amount + amount);
  };
  for (const row of rows) {
    const amount = convert(row.amount, row.currency, setting);
    add(environments, row.environmentId, amount);
    add(repositories, row.repo, amount);
    if (row.task) add(tasks, row.task, amount);
  }
  return { environments, repositories, tasks };
}

/**
 * Where a total stands against a budget: `over` past it, `near` from BUDGET_NEAR of it, `inside` below that, and
 * `unknown` when unknowns could still take it near or over. A total with unknowns that's already near or over says so.
 * @param {{ amount: number, unknown: number }} total
 * @param {number} budget
 * @returns {'inside' | 'near' | 'over' | 'unknown'}
 */
export function budgetState(total, budget) {
  if (total.amount > budget) return 'over';
  if (total.amount >= budget * BUDGET_NEAR) return 'near';
  return total.unknown > 0 ? 'unknown' : 'inside';
}

/**
 * Whether going from `before` to `now` in one month is worth a signal: only into `near` or `over`, and only further than
 * the month has already been. Coming back inside, or staying where it was, sends nothing.
 * @param {string | null} before the worst state this month has signalled, or null
 * @param {string} now
 */
export function budgetCrossed(before, now) {
  const rank = { near: 1, over: 2 };
  return (rank[now] ?? 0) > (rank[before] ?? 0);
}

/**
 * The signal for an environment's month crossing into `near` or `over` its budget, for the signals stream (BRK-190):
 * kind `cost`, on the environment as a whole, a warning when near and critical when over (which opens an incident,
 * BRK-197). Its value is the month's estimate, in the board's currency.
 * @param {{ source: string, environment: string, environmentId: number }} where
 * @param {'near' | 'over'} state
 * @param {CostTotal} total
 * @param {number} budget
 * @param {number} now
 * @returns {import('./infra-signals.js').SignalInput}
 */
export function budgetSignal({ source, environment, environmentId }, state, total, budget, now) {
  const amount = money(total.amount, total.currency);
  const limit = money(budget, total.currency);
  const floor = total.unknown ? ', or more: some resources have no estimate' : '';
  return {
    source,
    environment,
    environmentId,
    resource: null,
    kind: 'cost',
    level: state === 'over' ? 'critical' : 'warning',
    value: total.amount,
    at: new Date(now).toISOString(),
    text:
      state === 'over'
        ? `${environment} is over its ${limit} budget: an estimated ${amount} a month${floor}.`
        : `${environment} is near its ${limit} budget: an estimated ${amount} a month${floor}.`,
  };
}
