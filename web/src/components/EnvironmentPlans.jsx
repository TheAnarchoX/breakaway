import { ChevronRight, FileDiff, GitPullRequest } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { github, hashFor, pullParam } from '../lib/store.js';
import { plansPanel } from '../lib/env-plans.js';
import { PlanState, amount } from '../views/PlanView.jsx';
import { CHANGE_CARD_ID, ChangeState } from './EnvironmentChange.jsx';
import { NoneYet } from './ui.jsx';

/** A plan's page (WEB-62), under its environment: the address a waiting plan's push links to. */
export const planHref = (/** @type {{ id: string, environment: { id: number } }} */ plan) =>
  hashFor({ view: 'infrastructure', environment: String(plan.environment.id), plan: plan.id, task: null });

/** @param {{ iso: string | null | undefined }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** Brings the change's card beside the map into view, and focuses it. */
function showCard() {
  const card = document.getElementById(CHANGE_CARD_ID);
  card?.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  card?.focus({ preventScroll: true });
}

/**
 * A console change still the board's: its card's state and pull request, linking to the card when it shows beside
 * the map, else to its pull request.
 * @param {{ row: import('../lib/env-plans.js').ChangeRow, onCard: boolean }} props
 */
function ChangeRow({ row, onCard }) {
  const { change, card } = row;
  const lines = change.lines?.length ?? 0;
  const body = (
    <>
      <span class="infra-plan-row-head">
        <ChangeState state={card.state} />
        <span class="infra-plan-id">
          {change.pull ? (
            <>
              <GitPullRequest size={12} aria-hidden="true" />#{change.pull.number}
            </>
          ) : (
            `Change ${change.n}`
          )}
        </span>
      </span>
      <span class="meta">
        Your change from the console · {row.making ? 'its plan is being made · ' : ''}
        {lines} {lines === 1 ? 'edit' : 'edits'} · <When iso={change.updated} />
      </span>
      <ChevronRight size={16} aria-hidden="true" class="infra-plan-row-go" />
    </>
  );
  const waiting = card.state === 'waiting' ? 'is-waiting' : '';
  if (onCard)
    return (
      <button type="button" class={`infra-plan-row ${waiting}`} onClick={showCard} title="Show its card">
        {body}
      </button>
    );
  if (change.pull)
    return (
      <a
        class={`infra-plan-row ${waiting}`}
        href={hashFor({ view: 'github', task: null, pr: pullParam(change.pull.number, change.repo) })}
      >
        {body}
      </a>
    );
  return <div class={`infra-plan-row ${waiting}`}>{body}</div>;
}

/**
 * A plan: its state, what it changes, the run's progress while it applies, and the console change it came from.
 * @param {{ row: import('../lib/env-plans.js').PlanRow, ended?: boolean }} props
 */
function PlanRow({ row, ended = false }) {
  const { plan: p, progress, change } = row;
  const parts = [
    typeof p.changes === 'number' && `${p.changes} ${p.changes === 1 ? 'change' : 'changes'}`,
    typeof p.cost?.delta === 'number' &&
      p.cost.delta !== 0 &&
      `${amount(p.cost.delta, p.cost.currency, { signed: true })} a month`,
    p.reversible === false && 'can’t be undone',
    change?.pull && `from #${change.pull.number}`,
  ].filter(Boolean);
  const when = ended ? p.updated : p.created;
  return (
    <a class={`infra-plan-row ${p.state === 'waiting' ? 'is-waiting' : ''}`} href={planHref(p)}>
      <span class="infra-plan-row-head">
        <PlanState state={p.state} />
        <span class="infra-plan-id">{p.id}</span>
      </span>
      {progress && <span class="meta infra-plan-progress">{progress}</span>}
      <span class="meta">
        {parts.join(' · ')}
        {when && (
          <>
            {parts.length ? ' · ' : ''}
            <When iso={when} />
          </>
        )}
      </span>
      <ChevronRight size={16} aria-hidden="true" class="infra-plan-row-go" />
    </a>
  );
}

/**
 * An environment's plans (WEB-62, WEB-115), on its console, from what the console already reads: the change from the
 * console still waiting for you, merging, or not compared yet (linking to its card); the open plans, applying first
 * with the run's progress, then approved, waiting, and drafts (each linking to its page, where the owner approves or
 * rejects it); and the last few that ended. Empty only when there's none of it.
 * @param {{ env: { id: number, name: string, observeOnly?: boolean }, plans: any[], runs: any[],
 *   changes: { open: any, changes: any[] } | null, card: number | null, error?: string | null }} props
 *   `card` is the number of the change whose card shows beside the map
 */
export function EnvironmentPlans({ env, plans, runs, changes, card, error = null }) {
  const open = github.value.data?.open ?? [];
  const checks = (/** @type {any} */ change) =>
    change.pull
      ? (open.find(
          (/** @type {any} */ p) => Number(p.number) === change.pull.number && (!p.repo || p.repo === change.repo),
        )?.checks?.state ?? null)
      : null;
  const rows = plansPanel({ plans, runs, changes, checks });
  const current = rows.changes.length + rows.open.length;
  if (env.observeOnly && !current && !rows.recent.length && !error) return null;
  return (
    <section class="infra-section" aria-labelledby="infra-plans">
      <h2 id="infra-plans">
        <FileDiff size={16} aria-hidden="true" />
        Plans
      </h2>
      {error && (
        <p class="field-error" role="alert">
          Couldn’t load its plans. {error}
        </p>
      )}
      {current > 0 && (
        <ul class="infra-plan-list">
          {rows.changes.map((r) => (
            <li key={`change-${r.change.n}`}>
              <ChangeRow row={r} onCard={card === r.change.n} />
            </li>
          ))}
          {rows.open.map((r) => (
            <li key={r.plan.id}>
              <PlanRow row={r} />
            </li>
          ))}
        </ul>
      )}
      {rows.recent.length > 0 && (
        <>
          <h3 class="infra-plan-recent">Recent</h3>
          <ul class="infra-plan-list">
            {rows.recent.map((r) => (
              <li key={r.plan.id}>
                <PlanRow row={r} ended />
              </li>
            ))}
          </ul>
        </>
      )}
      {!current && !rows.recent.length && !error && (
        <NoneYet>
          A change you propose from the console, a pull request to <code>.github/breakaway-infra/{env.name}.json</code>,
          or drift makes one.
        </NoneYet>
      )}
    </section>
  );
}
