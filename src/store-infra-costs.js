/**
 * TaskStore's cost attribution and budgets (docs/specs/IDEA-19-architect.md, "Cost"; BRK-199). After each inventory
 * refresh, every environment's estimates are added up (src/infra-costs.js) into its month in `infra_costs`, a series
 * kept COST_MONTHS, and checked against the budget its repository's policy sets (BRK-181). The first time a month goes
 * near or over its budget, one `cost` signal joins the stream (BRK-190): near is a warning, over is critical, which
 * opens an incident (BRK-197). Coming back inside sends nothing, and a new month starts again.
 *
 * The series keeps each month's estimates as the providers gave them, by currency, and converts them on read, like the
 * inventory (BRK-226), so changing the board's currency rewrites nothing. Its budget and state are kept as they were
 * checked. GET /api/infra/costs reads it for anyone signed in; nothing outside the board writes it.
 */
import { limitsFor } from './infra-policy.js';
import {
  BUDGET_STATES,
  COST_MONTHS,
  budgetCrossed,
  budgetSignal,
  budgetState,
  monthOf,
  sumCosts,
} from './infra-costs.js';

/** @typedef {import('./infra-costs.js').CostTotal} CostTotal */

/** No resources yet: nothing to add up. @returns {CostTotal} */
const emptyTotal = (currency) => ({ amount: 0, currency, resources: 0, unknown: 0, estimate: true });

/** The first month kept, COST_MONTHS back from `now`'s, as YYYY-MM. */
function firstMonth(now) {
  const d = new Date(now);
  return monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (COST_MONTHS - 1), 1));
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraCostsMethods = {
  initInfraCosts() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_costs (
        environment INTEGER NOT NULL, month TEXT NOT NULL, amounts TEXT NOT NULL, resources INTEGER NOT NULL,
        missing INTEGER NOT NULL, budget REAL NOT NULL, budget_currency TEXT NOT NULL, state TEXT NOT NULL,
        signalled TEXT, updated INTEGER NOT NULL,
        PRIMARY KEY (environment, month)
      );
    `);
  },

  /**
   * The inventory's estimates for each environment that has any, with what owns them. Removed environments' rows
   * never show (the join), and an environment without a target has no inventory.
   * @param {number | null} [environmentId]
   * @returns {import('./infra-costs.js').CostRow[]}
   */
  costRows(environmentId = null) {
    return this.sql
      .exec(
        'SELECT i.environment, i.cost, i.currency, e.name, e.repo, e.task FROM infra_inventory i JOIN infra_environments e ON e.id = i.environment WHERE (? IS NULL OR i.environment = ?) ORDER BY e.repo, e.name, i.rid',
        environmentId,
        environmentId,
      )
      .toArray()
      .map((r) => ({
        environmentId: Number(r.environment),
        environment: r.name,
        repo: r.repo,
        task: r.task ?? null,
        amount: r.cost === null || r.cost === undefined ? null : Number(r.cost),
        currency: r.currency ?? null,
      }));
  },

  /** An environment's budget a month, in the board's currency, from its repository's policy. */
  environmentBudget(env) {
    const { policy, from } = this.infraPolicyFor(env.repo);
    return { amount: limitsFor(policy, env.name).budget, policy: from };
  },

  /**
   * Adds up each environment's estimates into this month's row, and sends a signal when the month goes near or over
   * its budget for the first time. The inventory's refresh calls it for the environments it just refreshed.
   * @param {number[]} environmentIds
   * @param {number} [now]
   * @returns {Promise<import('./store-infra-signals.js').StoredSignal[]>} the signals sent
   */
  async recordInfraCosts(environmentIds, now = Date.now()) {
    const month = monthOf(now);
    const setting = this.infraCurrency();
    const sent = [];
    for (const id of environmentIds) {
      const env = this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', id).toArray()[0];
      if (!env) continue;
      const rows = this.costRows(env.id);
      /** @type {Record<string, number>} */
      const amounts = {};
      for (const r of rows)
        if (r.amount !== null && r.currency)
          amounts[r.currency] = Math.round(((amounts[r.currency] ?? 0) + r.amount) * 100) / 100;
      const sum = sumCosts(rows, setting).environments.get(Number(env.id)) ?? emptyTotal(setting.currency);
      const budget = this.environmentBudget(env).amount;
      const state = budgetState(sum, budget);
      const before = this.sql
        .exec('SELECT signalled FROM infra_costs WHERE environment = ? AND month = ?', env.id, month)
        .toArray()[0];
      let signalled = before?.signalled ?? null;
      if (budgetCrossed(signalled, state)) {
        const where = { source: env.provider, environment: env.name, environmentId: Number(env.id) };
        const crossed = /** @type {'near' | 'over'} */ (state);
        sent.push(...(await this.recordSignals([budgetSignal(where, crossed, sum, budget, now)])));
        signalled = state;
      }
      this.sql.exec(
        `INSERT INTO infra_costs (environment, month, amounts, resources, missing, budget, budget_currency, state, signalled, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment, month) DO UPDATE SET amounts = excluded.amounts, resources = excluded.resources,
           missing = excluded.missing, budget = excluded.budget, budget_currency = excluded.budget_currency,
           state = excluded.state, signalled = excluded.signalled, updated = excluded.updated`,
        env.id,
        month,
        JSON.stringify(amounts),
        rows.length,
        rows.filter((r) => r.amount === null || !r.currency).length,
        budget,
        setting.currency,
        state,
        signalled,
        now,
      );
    }
    this.sql.exec(
      'DELETE FROM infra_costs WHERE month < ? OR environment NOT IN (SELECT id FROM infra_environments)',
      firstMonth(now),
    );
    return sent;
  },

  /** One month of an environment's series as the API shows it, converted at the board's rate now. */
  costMonthOut(row, setting) {
    const amounts = JSON.parse(row.amounts);
    const rows = Object.entries(amounts).map(([currency, amount]) => ({
      environmentId: 0,
      environment: '',
      repo: '',
      task: null,
      amount: Number(amount),
      currency,
    }));
    const total = sumCosts(rows, setting).environments.get(0);
    const unknown = Number(row.missing) + (total?.unknown ?? 0);
    return {
      month: row.month,
      cost: {
        amount: total?.amount ?? 0,
        currency: setting.currency,
        resources: Number(row.resources),
        unknown,
        estimate: true,
      },
      budget: { amount: Number(row.budget), currency: row.budget_currency, state: row.state },
    };
  },

  /**
   * GET /api/infra/costs[?repo=&environment=]: what each environment, repository, and owning task costs a month now,
   * from the inventory in the board's currency, each environment with its budget and its monthly series. Read only.
   */
  costsApi({ repo, environment } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const one = environment ? this.environmentRow(environment, slug) : null;
      const setting = this.infraCurrency();
      const rows = this.costRows(one?.id ?? null).filter((r) => !slug || r.repo === slug);
      const sums = sumCosts(rows, setting);
      const envs = one
        ? [one]
        : this.sql
            .exec('SELECT * FROM infra_environments WHERE (? IS NULL OR repo = ?) ORDER BY repo, name', slug, slug)
            .toArray();
      const environments = envs.map((env) => {
        const cost = sums.environments.get(Number(env.id)) ?? emptyTotal(setting.currency);
        const budget = this.environmentBudget(env);
        const months = this.sql
          .exec('SELECT * FROM infra_costs WHERE environment = ? ORDER BY month DESC', env.id)
          .toArray()
          .map((row) => this.costMonthOut(row, setting));
        return {
          environmentId: Number(env.id),
          environment: env.name,
          repo: env.repo,
          kind: env.kind,
          task: this.inventoryTask(env.task),
          cost,
          budget: {
            amount: budget.amount,
            currency: setting.currency,
            policy: budget.policy,
            used: budget.amount > 0 ? Math.round((cost.amount / budget.amount) * 100) / 100 : null,
            state: budgetState(cost, budget.amount),
          },
          months,
        };
      });
      const repositories = [...sums.repositories.entries()].map(([r, cost]) => ({ repo: r, cost }));
      const tasks = [...sums.tasks.entries()].map(([uuid, cost]) => ({
        task: this.inventoryTask(uuid) ?? { uuid, wid: null, description: '' },
        repo: rows.find((r) => r.task === uuid)?.repo ?? null,
        cost,
      }));
      return {
        status: 200,
        body: { currency: this.currencyOut(), states: BUDGET_STATES, environments, repositories, tasks },
      };
    });
  },
};
