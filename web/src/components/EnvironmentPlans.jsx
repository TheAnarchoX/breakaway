import { useEffect, useState } from 'preact/hooks';
import { ChevronRight, FileDiff } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { hashFor } from '../lib/store.js';
import { PlanState, amount } from '../views/PlanView.jsx';

/** Plans an environment's page lists, newest first. */
const SHOWN = 10;

/** A plan's page (WEB-62), under its environment: the address a waiting plan's push links to. */
export const planHref = (/** @type {{ id: string, environment: { id: number } }} */ plan) =>
  hashFor({ view: 'infrastructure', environment: String(plan.environment.id), plan: plan.id, task: null });

/**
 * An environment's plans (WEB-62), on its page: the ones still open first, then the newest, each linking to its page,
 * where the owner approves or rejects it.
 * @param {{ env: { id: number, name: string, observeOnly?: boolean } }} props
 */
export function EnvironmentPlans({ env }) {
  const [state, setState] = useState(
    /** @type {{ plans: any[], more: boolean, error: string | null, loading: boolean }} */ ({
      plans: [],
      more: false,
      error: null,
      loading: true,
    }),
  );
  useEffect(() => {
    let live = true;
    api(`infra/plans?environment=${enc(env.id)}&limit=${SHOWN}`).then(
      ({ plans, more }) => live && setState({ plans, more, error: null, loading: false }),
      (error) => live && setState({ plans: [], more: false, error: error.message, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [env.id]);
  if (env.observeOnly && !state.plans.length) return null;
  const open = (/** @type {any} */ p) => p.state === 'waiting' || p.state === 'draft' || p.state === 'applying';
  const plans = [...state.plans.filter(open), ...state.plans.filter((p) => !open(p))];
  return (
    <section class="infra-section" aria-labelledby="infra-plans">
      <h2 id="infra-plans">
        <FileDiff size={18} aria-hidden="true" />
        Plans
      </h2>
      {state.error ? (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      ) : state.loading ? (
        <p class="muted" aria-busy="true">
          Loading its plans…
        </p>
      ) : plans.length ? (
        <ul class="infra-plan-list">
          {plans.map((p) => (
            <li key={p.id}>
              <a class={`infra-plan-row ${p.state === 'waiting' ? 'is-waiting' : ''}`} href={planHref(p)}>
                <span class="infra-plan-row-head">
                  <PlanState state={p.state} />
                  <span class="infra-plan-id">{p.id}</span>
                </span>
                <span class="meta">
                  {p.changes} {p.changes === 1 ? 'change' : 'changes'}
                  {typeof p.cost?.delta === 'number' && p.cost.delta !== 0 && (
                    <> · {amount(p.cost.delta, p.cost.currency, { signed: true })} a month</>
                  )}
                  {!p.reversible && ' · can’t be undone'}
                  {p.created && <> · {ago(p.created)}</>}
                </span>
                <ChevronRight size={16} aria-hidden="true" class="infra-plan-row-go" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">
          None yet. A pull request that changes <code>.github/breakaway-infra/{env.name}.json</code>, or drift, makes
          one, and it waits here for you.
        </p>
      )}
    </section>
  );
}
