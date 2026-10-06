import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, CircleDashed, CircleX, TriangleAlert, Wallet } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { hashFor, inScope, repoName } from '../lib/store.js';
import { rateWords } from '../../../src/infra-currency.js';

/**
 * Cost on the Infrastructure view (WEB-65; docs/specs/IDEA-19-architect.md, "Cost" and "Views"), from BRK-199's
 * GET /api/infra/costs: what each environment, repository, and short-lived environment's task costs a month, each
 * environment against its budget, and an environment's months as a trend. Every amount is an estimate, in the board's
 * currency (BRK-226), said once per view with the rate beside the total.
 */

/** How many months the trend shows, newest last. */
const TREND_MONTHS = 12;
/** How many tasks the overview lists, costliest first. */
const TOP_TASKS = 5;

/** A budget's state in words, with its icon: status colors always come with both. */
export const BUDGET = {
  inside: { label: 'Inside budget', Icon: CircleCheck },
  near: { label: 'Near budget', Icon: TriangleAlert },
  over: { label: 'Over budget', Icon: CircleX },
  unknown: { label: 'Not all known', Icon: CircleDashed },
};

/**
 * An amount the way the browser formats its currency, with a minus sign for a fall: "€4.60".
 * @param {number} n
 * @param {string} currency
 */
export function amountText(n, currency) {
  let text;
  try {
    text = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(n));
  } catch {
    text = `${Math.abs(n).toFixed(2)} ${currency}`;
  }
  return n < 0 ? `−${text}` : text;
}

/**
 * A total's amount, and "or more" when some of its resources have no estimate: a total with unknowns is a floor.
 * @param {{ amount: number, currency: string, unknown: number }} cost
 */
export function costText(cost) {
  return `${amountText(cost.amount, cost.currency)}${cost.unknown ? ' or more' : ''}`;
}

/**
 * The board's rate beside a total, when it converts: "At 1 USD = 0.92 EUR, set 3 Oct." Nothing in US dollars.
 * @param {{ currency: string, rate: number, from: string, setAt: string | null } | null | undefined} currency
 */
export function rateLine(currency) {
  if (!currency || currency.currency === currency.from) return '';
  const words = rateWords({ from: currency.from, to: currency.currency, rate: currency.rate, setAt: currency.setAt });
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : '';
}

/** A month (YYYY-MM) as the browser names it: "Oct", or "Oct 2025" when asked for the year. */
export function monthText(/** @type {string} */ month, year = false) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: year ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

/** @param {{ state: string }} props */
export function BudgetBadge({ state }) {
  const { label, Icon } = BUDGET[state] ?? BUDGET.unknown;
  return (
    <span class={`infra-budget infra-budget-${state in BUDGET ? state : 'unknown'}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * An environment's month against its budget: the estimate, the budget, its state, and a bar of how much is used. The
 * words carry it all, so the bar is hidden from screen readers.
 * @param {{ entry: any, compact?: boolean }} props
 */
export function BudgetLine({ entry, compact = false }) {
  const { cost, budget } = entry;
  const used = budget.amount > 0 ? Math.min(cost.amount / budget.amount, 1) : cost.amount > 0 ? 1 : 0;
  return (
    <div class={`infra-cost ${compact ? 'is-compact' : ''}`}>
      <p class="infra-cost-line">
        <span class="infra-cost-amount">{costText(cost)}</span>
        <span class="meta"> a month · budget {amountText(budget.amount, budget.currency)}</span>
      </p>
      <div class={`infra-meter infra-meter-${budget.state}`} aria-hidden="true">
        <span style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
      <BudgetBadge state={budget.state} />
      {!compact && cost.unknown > 0 && (
        <p class="meta infra-cost-note">
          {cost.unknown === 1 ? '1 resource has' : `${cost.unknown} resources have`} no estimate yet, so this is the
          least it costs.
        </p>
      )}
    </div>
  );
}

/**
 * An environment's months as bars, oldest first, with its budget as a line. One series, so no legend: the heading
 * names it. Each bar says its month, amount, and state on hover and focus, and the table under it holds the same.
 * @param {{ months: any[] }} props
 */
export function CostTrend({ months }) {
  const shown = months.slice(0, TREND_MONTHS).reverse();
  if (shown.length < 2)
    return <p class="muted infra-trend-empty">The trend shows once the board has seen more than one month.</p>;
  const budget = shown.at(-1).budget;
  // Headroom over the tallest mark, so neither the bars nor the budget's line touch the top.
  const top = (Math.max(budget.amount, ...shown.map((m) => m.cost.amount)) || 1) * 1.15;
  const pct = (/** @type {number} */ n) => `${Math.round((n / top) * 1000) / 10}%`;
  const label = (/** @type {any} */ m) =>
    `${monthText(m.month, true)}: ${costText(m.cost)}, ${(BUDGET[m.budget.state] ?? BUDGET.unknown).label.toLowerCase()}`;
  return (
    <figure class="infra-trend">
      <figcaption class="meta">Estimated cost a month, the last {shown.length} months</figcaption>
      <div class="infra-trend-plot">
        <span class="infra-trend-budget" style={{ bottom: pct(budget.amount) }}>
          <span class="meta">Budget {amountText(budget.amount, budget.currency)}</span>
        </span>
        <ol class="infra-trend-bars">
          {shown.map((m) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: each bar is focusable so its tooltip reads by keyboard.
            <li key={m.month} class={`infra-trend-bar is-${m.budget.state}`} tabIndex={0} aria-label={label(m)}>
              <span class="infra-trend-fill" style={{ height: pct(m.cost.amount) }} />
              <span class="infra-trend-tip" role="tooltip">
                {label(m)}
              </span>
              <span class="infra-trend-month" aria-hidden="true">
                {monthText(m.month)}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <details class="infra-trend-table">
        <summary>Show as a table</summary>
        <table class="infra-cost-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Estimated cost</th>
              <th scope="col">Budget</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {[...shown].reverse().map((m) => (
              <tr key={m.month}>
                <th scope="row">{monthText(m.month, true)}</th>
                <td class="num">{costText(m.cost)}</td>
                <td class="num">{amountText(m.budget.amount, m.budget.currency)}</td>
                <td>{(BUDGET[m.budget.state] ?? BUDGET.unknown).label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/**
 * The Infrastructure view's cost overview: each repository in scope, then the tasks whose short-lived environments
 * cost the most. Each environment's own line is on its card.
 * @param {{ costs: any }} props
 */
export function CostOverview({ costs }) {
  if (!costs) return null;
  const repositories = costs.repositories.filter((r) => inScope(r.repo));
  const tasks = costs.tasks
    .filter((t) => inScope(t.repo))
    .sort((a, b) => b.cost.amount - a.cost.amount)
    .slice(0, TOP_TASKS);
  const environments = costs.environments.filter((e) => inScope(e.repo));
  if (!repositories.length && !environments.length) return null;
  const over = environments.filter((e) => e.budget.state === 'over').length;
  const near = environments.filter((e) => e.budget.state === 'near').length;
  const rate = rateLine(costs.currency);
  return (
    <section class="infra-section infra-costs" aria-labelledby="infra-costs">
      <h2 id="infra-costs">
        <Wallet size={18} aria-hidden="true" />
        Estimated cost
      </h2>
      <p class="muted">
        A month, from what each provider’s usage says, before anything its plan includes.
        {rate && ` ${rate}`}
        {(over > 0 || near > 0) &&
          ` ${[over && `${over} over budget`, near && `${near} near it`].filter(Boolean).join(', ')}.`}
      </p>
      {repositories.length > 0 && (
        <table class="infra-cost-table">
          <caption class="meta">By repository</caption>
          <tbody>
            {repositories.map((r) => (
              <tr key={r.repo}>
                <th scope="row">{repoName(r.repo)}</th>
                <td class="num">{costText(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tasks.length > 0 && (
        <table class="infra-cost-table">
          <caption class="meta">Tasks whose short-lived environments cost the most</caption>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.task.uuid}>
                <th scope="row">
                  <a href={hashFor({ task: t.task.wid ?? t.task.uuid })}>{t.task.wid ?? 'Task'}</a>
                  {t.task.description && <span class="meta"> {t.task.description}</span>}
                </th>
                <td class="num">{costText(t.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * An environment's cost on its page: this month against its budget, the trend, and the rate. One line in
 * EnvironmentView.
 * A new `tick` reads again (the console's poll, WEB-94).
 * @param {{ env: any, tick?: number }} props
 */
export function CostSection({ env, tick = 0 }) {
  const [state, setState] = useState(
    /** @type {{ costs: any, error: string | null }} */ ({ costs: null, error: null }),
  );
  useEffect(() => {
    let live = true;
    api(`infra/costs?environment=${enc(String(env.id))}`).then(
      (costs) => live && setState({ costs, error: null }),
      (error) => live && setState({ costs: null, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [env.id, tick]);
  const entry = state.costs?.environments.find((e) => e.environmentId === env.id) ?? null;
  const rate = rateLine(state.costs?.currency);
  return (
    <section class="infra-section infra-costs" aria-labelledby="infra-env-cost">
      <h2 id="infra-env-cost">
        <Wallet size={18} aria-hidden="true" />
        Estimated cost
      </h2>
      {state.error ? (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      ) : !state.costs ? (
        <p class="muted" aria-busy="true">
          Adding up the cost…
        </p>
      ) : !entry || entry.cost.resources === 0 ? (
        <p class="console-quiet">Nothing to add up yet: the board estimates it once it sees what runs.</p>
      ) : (
        <>
          <p class="muted">
            A month, from what the provider’s usage says, before anything its plan includes.
            {rate && ` ${rate}`} The budget is from{' '}
            {entry.budget.policy === 'repository' ? 'the repository’s policy' : 'the default policy'}.
          </p>
          <BudgetLine entry={entry} />
          <CostTrend months={entry.months} />
          {entry.task && (
            <p class="meta">
              Counted for{' '}
              <a href={hashFor({ task: entry.task.wid ?? entry.task.uuid })}>
                {entry.task.wid ?? entry.task.description}
              </a>
              , the task it’s for.
            </p>
          )}
        </>
      )}
    </section>
  );
}
