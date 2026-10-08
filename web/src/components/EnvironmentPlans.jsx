import { useState } from 'preact/hooks';
import { ChevronRight, FileDiff, GitPullRequest, TriangleAlert } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { confirmDialog, github, hashFor, pullParam, toast } from '../lib/store.js';
import { plansPanel } from '../lib/env-plans.js';
import { PlanState, StartAgain, amount } from '../views/PlanView.jsx';
import { CHANGE_CARD_ID, ChangeState } from './EnvironmentChange.jsx';
import { NoneYet } from './ui.jsx';
import { CompareNow } from './EnvironmentActions.jsx';
import { EMPTY_START } from '../lib/infra-change.js';

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
 * A new environment's first apply failed (WEB-120): its target, set when the owner approved the change that builds it
 * (BRK-291), names something that doesn't exist yet, so the console says so instead of waiting to see it. When its run
 * applied nothing, Start the run again comes first (BRK-308). Clear the target starts again: when the merged file still
 * declares that target, Compare now drafts the plan that builds it again (BRK-309); otherwise the console's next change
 * gives it a target again. Or the owner fixes what failed on the plan's page and proposes the change again.
 * @param {{ env: { id: number, name: string, target?: string | null, frozen?: boolean }, plan: any, run?: any,
 *   desired?: any, onCleared?: () => void }} props `desired` is the environment's desired state as the console read it
 */
function FirstApplyFailed({ env, plan, run = null, desired = null, onCleared }) {
  const again = plan.state === 'failed' && Boolean(run?.startAgain);
  const [busy, setBusy] = useState(false);
  const file = `${env.name}.json`;
  const declared = (desired?.desired?.resources ?? []).some(
    (/** @type {any} */ r) => String(r?.name ?? '') === String(env.target ?? ''),
  );
  const clear = async () => {
    const ok = await confirmDialog({
      title: `Clear ${env.name}’s target?`,
      body: declared
        ? `The board stops looking for ${env.target}, which doesn’t exist yet. Nothing that runs changes. ${file} still declares ${env.target}, so Compare now drafts the plan that builds it again, and approving that plan makes it ${env.name}’s target.`
        : `The board stops looking for ${env.target}, which doesn’t exist yet. Nothing that runs changes. Your next change from the console gives ${env.name} a target again.`,
      confirmLabel: 'Clear the target',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`infra/environments/${enc(env.id)}`, { method: 'PATCH', body: { target: null, by: 'owner' } });
      toast(
        declared
          ? `${env.name} has no target now. Compare now drafts the plan that builds ${env.target}.`
          : `${env.name} has no target now. Add a resource to start again.`,
        'success',
      );
      onCleared?.();
    } catch (error) {
      toast(`Couldn’t clear ${env.name}’s target: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="infra-first-apply" role="status">
      <p>
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          {again ? (
            <>
              {env.name}’s first apply failed before it applied anything, so its target, <code>{env.target}</code>,
              points at nothing yet. <a href={planHref(plan)}>See why on {plan.id}</a>, fix it, and start the run again,
              or clear the target and start over.
            </>
          ) : (
            <>
              {env.name}’s first apply {plan.state === 'rolled back' ? 'was rolled back' : 'failed'}, so its target,{' '}
              <code>{env.target}</code>, points at nothing yet. <a href={planHref(plan)}>See why on {plan.id}</a> and
              propose again, or clear the target and start over.
            </>
          )}
        </span>
      </p>
      <div class="conn-buttons">
        {again && <StartAgain plan={plan} env={env} run={run} onDone={onCleared} lead={false} size="btn-sm" />}
        <button
          type="button"
          class="btn btn-outline btn-sm"
          onClick={clear}
          disabled={busy}
          aria-busy={busy}
          aria-label={`Clear ${env.name}’s target`}
        >
          Clear the target
        </button>
      </div>
    </div>
  );
}

/**
 * An environment's plans (WEB-62, WEB-115), on its console, from what the console already reads: the change from the
 * console still waiting for you, merging, or not compared yet (linking to its card); the open plans, applying first
 * with the run's progress, then approved, waiting, and drafts (each linking to its page, where the owner approves or
 * rejects it); and the last few that ended. Empty only when there's none of it.
 * A new environment whose first apply failed says so first, with Clear the target (WEB-120).
 * @param {{ env: { id: number, name: string, observeOnly?: boolean, target?: string | null,
 *   desiredTarget?: { name: string | null, file: string, problem: string | null } | null }, plans: any[], runs: any[],
 *   changes: { open: any, changes: any[] } | null, card: number | null, error?: string | null, failed?: any,
 *   desired?: any, onChange?: () => void }} props
 *   `card` is the number of the change whose card shows beside the map; `failed` the plan whose first apply failed
 *   (firstApplyFailed); `onChange` reads the console again after the target is cleared
 */
export function EnvironmentPlans({
  env,
  plans,
  runs,
  changes,
  card,
  error = null,
  failed = null,
  desired = null,
  onChange,
}) {
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
      {failed && (
        <FirstApplyFailed
          env={env}
          plan={failed}
          run={runs.find((r) => r.plan === failed.id) ?? null}
          desired={desired}
          onCleared={onChange}
        />
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
      {!current && !rows.recent.length && !error && env.desiredTarget?.name && (
        // No target, but the merged file declares one (BRK-309): Compare plans with it.
        <div class="infra-first-apply is-declared">
          <p>
            <span>
              <code>{env.desiredTarget.file}</code> declares <code>{env.desiredTarget.name}</code>: Compare now drafts
              the plan that builds it.
            </span>
          </p>
          <div class="conn-buttons">
            <CompareNow env={env} onDone={() => onChange?.()} />
          </div>
        </div>
      )}
      {!current && !rows.recent.length && !error && !env.desiredTarget?.name && (
        <NoneYet>
          {!env.target && !env.observeOnly ? (
            env.desiredTarget?.problem ? (
              `${env.desiredTarget.problem}.`
            ) : (
              `${EMPTY_START}.`
            )
          ) : (
            <>
              A change you propose from the console, a pull request to{' '}
              <code>.github/breakaway-infra/{env.name}.json</code>, or drift makes one.
            </>
          )}
        </NoneYet>
      )}
    </section>
  );
}
