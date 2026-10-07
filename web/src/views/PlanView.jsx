import { useEffect, useState } from 'preact/hooks';
import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  Coins,
  FileDiff,
  History,
  Network,
  RefreshCw,
  Scale,
  Snowflake,
  TriangleAlert,
  Undo2,
} from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { auditActor, auditSummary, auditWords } from '../lib/infra-audit.js';
import { confirmDialog, environmentId, hashFor, navOrder, planRef, repoName, toast } from '../lib/store.js';
import { rateWords } from '../../../src/infra-currency.js';
import { AuditSummary } from '../components/AuditSummary.jsx';

/**
 * A plan's page (WEB-62; docs/specs/IDEA-19-architect.md, "Views" and "Approvals"), at
 * #/infrastructure/<environment>?plan=<plan>: the link a waiting plan's push carries. Reviewed like a pull request,
 * top to bottom on a phone: its state and why it waits (the policy's reasons, BRK-181), what changes (the provider's
 * diff, BRK-178), the estimated cost change in the board's currency (BRK-226), what else it touches (the blast radius,
 * from the inventory's relations), whether it can be undone, and once approved, the run's steps (BRK-183) and its
 * audit trail. Approve and Reject are the owner's, from the signed-in board only (BRK-182); apply is never a button.
 */

/** A plan's state, in the brand's words. */
export const PLAN_STATE = {
  draft: 'Draft',
  waiting: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  'rolled back': 'Rolled back',
};

/** What each change does, as a verb. */
const OP = { create: 'Create', update: 'Update', delete: 'Delete', scale: 'Scale', restart: 'Restart' };

/** Where a plan comes from, in words. */
const SOURCE = {
  'pull-request': 'a pull request',
  drift: 'drift',
  envelope: 'an envelope',
  incident: 'an incident',
  deploy: 'the deploy flow',
  'short-lived': 'a short-lived environment',
};

/** What the audit trail says each of the plan's moves was. */

/** A run's outcome (BRK-183), in words. */
const OUTCOME = {
  applied: 'Applied',
  unverified: 'Applied, health not checked',
  'rolled back': 'Rolled back',
  failed: 'Failed',
  'rollback failed': 'Roll back failed',
  expired: 'Expired',
};

/**
 * An amount a month as the brand writes it: in the browser's format, a fall with a minus sign ("−€1.20"), a rise with
 * a plus when `signed`.
 * @param {number} amount
 * @param {string | null} currency
 * @param {{ signed?: boolean }} [options]
 */
export function amount(amount, currency, { signed = false } = {}) {
  const whole = Number.isInteger(amount);
  let text;
  try {
    text = new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(amount);
  } catch {
    text = `${signed && amount > 0 ? '+' : ''}${whole ? amount : amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
  }
  return text.replace('-', '−');
}

/**
 * What one change does to a resource's settings: each setting it adds, changes, or removes, with before and after.
 * @param {{ before: Record<string, unknown> | null, after: Record<string, unknown> | null }} change
 * @returns {{ key: string, before: string | null, after: string | null }[]}
 */
export function settingChanges({ before, after }) {
  const show = (/** @type {unknown} */ v) => (v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return keys
    .map((key) => ({ key, before: show(before?.[key]), after: show(after?.[key]) }))
    .filter((c) => c.before !== c.after);
}

/** @param {{ iso: string | null }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** @param {{ state: string }} props */
export function PlanState({ state }) {
  return <span class={`infra-plan-state infra-plan-${state.replace(' ', '-')}`}>{PLAN_STATE[state] ?? state}</span>;
}

/** The policy's result: why the plan waits, one rule a line, and every rule it checked. */
function Policy({ policy, open }) {
  if (!policy)
    return (
      <section class="infra-section" aria-labelledby="plan-policy">
        <h2 id="plan-policy">
          <Scale size={18} aria-hidden="true" />
          Policy
        </h2>
        <p class="muted">Not checked: the plan was made before the board checked plans against a policy.</p>
      </section>
    );
  const lead =
    policy.outcome === 'refused'
      ? 'The policy refuses it:'
      : policy.outcome === 'allowed'
        ? 'Your policy lets it through:'
        : open
          ? 'It needs you because:'
          : 'It needed you because:';
  return (
    <section class="infra-section" aria-labelledby="plan-policy">
      <h2 id="plan-policy">
        <Scale size={18} aria-hidden="true" />
        Policy
      </h2>
      <p class="meta">
        {policy.policy === 'repository' ? (
          <>
            Checked against <code>.github/breakaway-infra/policy.json</code>
            {policy.sha && <> at {policy.sha.slice(0, 7)}</>}.
          </>
        ) : (
          'Checked against the default policy: every plan needs you.'
        )}
      </p>
      <p class="infra-plan-lead">{lead}</p>
      <ul class="infra-plan-reasons">
        {policy.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {policy.rules?.length > 0 && (
        <details class="infra-settings">
          <summary>
            Every rule <span class="count">{policy.rules.length}</span>
          </summary>
          <ul class="infra-plan-rules">
            {policy.rules.map((r) => (
              <li key={r.rule} class={r.applies ? 'is-applies' : ''}>
                {r.applies ? (
                  <TriangleAlert size={14} aria-label="Applies" />
                ) : (
                  <CircleCheck size={14} aria-label="Passes" />
                )}
                <span>
                  <code>{r.rule}</code> {r.reason}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** One change of the diff: what it does to which resource, its settings before and after, and whether it undoes. */
function Change({ c, cost, currency }) {
  const settings = settingChanges(c);
  const price = cost && (cost.before !== null || cost.after !== null) ? cost : null;
  return (
    <li class={`infra-plan-change infra-plan-op-${c.op}`}>
      <div class="infra-res-head">
        <span class="infra-plan-op">{OP[c.op] ?? c.op}</span>
        <h3 class="infra-res-name">{c.name}</h3>
        <span class="meta">{c.kind}</span>
      </div>
      <p class="meta infra-res-id">
        <code>{c.resource}</code>
        {price && (
          <>
            {' · '}
            {price.before === null || price.after === null
              ? 'cost change not known'
              : price.after === price.before
                ? 'no cost change'
                : `${amount(price.after - price.before, currency, { signed: true })} a month`}
          </>
        )}
      </p>
      {!c.reversible && (
        <p class="infra-plan-irreversible">
          <TriangleAlert size={14} aria-hidden="true" />
          Can’t be undone{c.why ? `: ${c.why}` : ''}
        </p>
      )}
      {settings.length > 0 && (
        <dl class="infra-plan-diff">
          {settings.map((s) => (
            <div key={s.key}>
              <dt>
                <code>{s.key}</code>
              </dt>
              <dd>
                {s.before !== null && <del>{s.before}</del>}
                {s.before !== null && s.after !== null && <span aria-hidden="true"> → </span>}
                {s.after !== null && <ins>{s.after}</ins>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** The estimated cost change, in the board's currency, with the rate once beside the total. */
function Cost({ cost }) {
  const currency = cost?.currency ?? null;
  return (
    <section class="infra-section" aria-labelledby="plan-cost">
      <h2 id="plan-cost">
        <Coins size={18} aria-hidden="true" />
        Estimated cost
      </h2>
      {!cost || cost.delta === null ? (
        <p class="muted">
          Not known: the provider gave no estimate for{' '}
          {cost?.unknown?.length ? `${cost.unknown.length} of its changes` : 'its changes'}.
        </p>
      ) : (
        <dl class="infra-facts">
          <div>
            <dt>Change</dt>
            <dd class="infra-num">
              {cost.delta === 0 ? 'Nothing a month' : `${amount(cost.delta, currency, { signed: true })} a month`}
            </dd>
          </div>
          {cost.now !== null && (
            <div>
              <dt>Now</dt>
              <dd class="infra-num">{amount(cost.now, currency)} a month</dd>
            </div>
          )}
          {cost.after !== null && (
            <div>
              <dt>After</dt>
              <dd class="infra-num">{amount(cost.after, currency)} a month</dd>
            </div>
          )}
        </dl>
      )}
      {cost && !cost.complete && cost.delta !== null && cost.unknown.length > 0 && (
        <p class="meta">
          Leaves out {cost.unknown.length} {cost.unknown.length === 1 ? 'change' : 'changes'} the provider couldn’t
          price.
        </p>
      )}
      {cost?.rate && <p class="meta">{rateWords(cost.rate).replace(/^a/u, 'A')}.</p>}
    </section>
  );
}

/** What else the plan touches: what leans on what it changes, nearest first, from the inventory's relations. */
function Reach({ blast, names }) {
  const reached = (blast?.resources ?? []).filter((r) => !r.changed);
  return (
    <section class="infra-section" aria-labelledby="plan-reach">
      <h2 id="plan-reach">
        <Network size={18} aria-hidden="true" />
        What else it touches {reached.length > 0 && <span class="count">{reached.length}</span>}
      </h2>
      {blast?.deletesInUse?.map((d) => (
        <p key={d.resource} class="infra-plan-irreversible">
          <TriangleAlert size={14} aria-hidden="true" />
          It deletes {d.name}, which {d.by.length === 1 ? 'something still uses' : `${d.by.length} things still use`}:{' '}
          {d.by.map((id) => names.get(id) ?? id).join(', ')}.
        </p>
      ))}
      {reached.length ? (
        <ul class="infra-plan-reach">
          {reached.map((r) => (
            <li key={r.id} style={{ '--depth': Math.min(r.depth - 1, 3) }}>
              <span class="infra-plan-reach-name">{r.name ?? r.id}</span>
              {r.kind && <span class="meta"> {r.kind}</span>}
              {r.leansOn && (
                <span class="meta">
                  {' · '}
                  {r.leansOn.relation} {names.get(r.leansOn.id) ?? r.leansOn.id}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">
          {blast?.seen
            ? 'Nothing else: nothing the board has seen uses what it changes.'
            : 'Not known: the board hadn’t listed what runs here when the plan was made.'}
        </p>
      )}
      {blast?.seen && (
        <p class="meta">
          From what the board saw <When iso={blast.seen} />.
        </p>
      )}
    </section>
  );
}

/** The run's steps once the executor applies it (BRK-183), and the plan's moves in the audit trail, oldest first. */
function Steps({ run, audit, names, envId }) {
  const lists = run
    ? [
        { title: 'Steps', steps: run.steps },
        { title: 'Roll back', steps: run.rollbackSteps },
      ].filter((l) => l.steps?.length)
    : [];
  return (
    <section class="infra-section" aria-labelledby="plan-steps">
      <h2 id="plan-steps">
        <History size={18} aria-hidden="true" />
        What happened
      </h2>
      {run && (
        <p class="meta">
          {run.outcome ? (OUTCOME[run.outcome] ?? run.outcome) : 'The executor is on it'}
          {run.error && <> · {run.error}</>}
          {run.updated && (
            <>
              {' · '}
              <When iso={run.updated} />
            </>
          )}
        </p>
      )}
      {lists.map((l) => (
        <div key={l.title} class="infra-plan-run">
          <h3>{l.title}</h3>
          <ol class="infra-plan-steps">
            {l.steps.map((s, i) => (
              <li key={`${s.resource} ${i}`} class={s.ok ? '' : 'is-failed'}>
                {s.ok ? <CircleCheck size={14} aria-label="Done" /> : <CircleX size={14} aria-label="Failed" />}
                <span>
                  {OP[s.op] ?? s.op} {names.get(s.resource) ?? <code>{s.resource}</code>}
                  {s.error && <span class="meta"> · {s.error}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {audit.length ? (
        <ol class="infra-audit">
          {audit.map((e) => {
            const { label, outcome } = auditWords(e);
            return (
              <li key={e.id} class={`infra-audit-entry infra-audit-${e.kind}`}>
                <div class="infra-audit-head">
                  <span class="infra-audit-kind">{label}</span>
                  {outcome && <span class="meta">{outcome}</span>}
                  <span class="meta infra-audit-when">
                    <When iso={new Date(e.at).toISOString()} />
                  </span>
                </div>
                <AuditSummary parts={auditSummary(e)} environment={envId} class="infra-audit-summary" />
                <p class="meta">By {auditActor(e)}</p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p class="muted">Nothing recorded yet.</p>
      )}
    </section>
  );
}

/**
 * Approve and Reject, the owner's: Approve only for a plan that can still be approved, in an environment that isn't
 * frozen. Approving a draft puts it in front of the owner first, quietly, since they're reading it.
 */
function Answer({ plan, env, outOfDate, onChange }) {
  const [busy, setBusy] = useState(/** @type {'approve' | 'reject' | null} */ (null));
  // An approved plan can still be rejected until the executor starts applying it (BRK-183).
  const open = plan.state === 'draft' || plan.state === 'waiting';
  if (!open && plan.state !== 'approved') return null;
  const refused = plan.policy?.outcome === 'refused';
  const canApprove = open && !env.frozen && !outOfDate && !refused && !env.observeOnly;
  const approve = async () => {
    const ok = await confirmDialog({
      title: `Approve this plan for ${env.name}?`,
      body: `The board applies it next${plan.reversible ? ' and rolls back if the health check fails' : ''}.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy('approve');
    try {
      if (plan.state === 'draft')
        await api(`infra/plans/${enc(plan.id)}`, {
          method: 'PATCH',
          body: { state: 'waiting', quiet: true, by: 'owner' },
        });
      await api(`infra/plans/${enc(plan.id)}/approve`, { method: 'POST', body: { by: 'owner' } });
      onChange();
      toast(`Approved. The board applies it to ${env.name} next.`, 'success');
    } catch (error) {
      toast(error.message, 'error');
      onChange();
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    const ok = await confirmDialog({
      title: 'Reject this plan?',
      body: 'Nothing changes.',
      confirmLabel: 'Reject',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('reject');
    try {
      await api(`infra/plans/${enc(plan.id)}/reject`, { method: 'POST', body: { by: 'owner' } });
      onChange();
      toast('Rejected. Nothing changes.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="infra-plan-answer">
      {!open && <p class="infra-plan-why-not">Approved: the board applies it next. Reject it to stop that.</p>}
      {open && !canApprove && (
        <p class="infra-plan-why-not">
          {env.frozen ? (
            <>
              <Snowflake size={14} aria-hidden="true" />
              {env.name} is frozen, so it can’t be approved until you unfreeze it.
            </>
          ) : env.observeOnly ? (
            'It’s observe only: the board never changes it, so there’s nothing to approve.'
          ) : refused ? (
            'The policy refuses it, so it can’t be approved.'
          ) : (
            <>Out of date: {outOfDate}. Reject it, and the next plan is made from what’s there now.</>
          )}
        </p>
      )}
      <div class="infra-plan-buttons">
        <button
          type="button"
          class="btn btn-outline"
          onClick={reject}
          disabled={busy !== null}
          aria-busy={busy === 'reject'}
        >
          <CircleX size={16} aria-hidden="true" />
          Reject
        </button>
        {canApprove && (
          <button
            type="button"
            class="btn btn-primary"
            onClick={approve}
            disabled={busy !== null}
            aria-busy={busy === 'approve'}
          >
            <CircleCheck size={16} aria-hidden="true" />
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

export function PlanView() {
  const envId = environmentId.value;
  const ref = planRef.value;
  const [state, setState] = useState(
    /** @type {{ plan: any, env: any, outOfDate: string | null, names: Map<string, string>, audit: any[], run: any, error: string | null, notFound: boolean, loading: boolean }} */ ({
      plan: null,
      env: null,
      outOfDate: null,
      names: new Map(),
      audit: [],
      run: null,
      error: null,
      notFound: false,
      loading: true,
    }),
  );
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [{ plan, outOfDate }, { environment }] = await Promise.all([
        api(`infra/plans/${enc(ref)}`),
        api(`infra/environments/${enc(envId)}`),
      ]);
      const [inventory, audit, run] = await Promise.all([
        api(`infra/inventory?environment=${enc(envId)}`).catch(() => ({ resources: [] })),
        api(`infra/audit?environmentId=${enc(plan.environment.id)}&plan=${enc(plan.id)}&limit=200`),
        // The executor's run (BRK-183): none until the plan is approved.
        ['draft', 'waiting', 'rejected'].includes(plan.state)
          ? null
          : api(`infra/runs/${enc(plan.id)}`).then(
              (r) => r.run,
              () => null,
            ),
      ]);
      const names = new Map(inventory.resources.map((r) => [r.id, r.name]));
      for (const r of plan.blastRadius.resources ?? []) if (r.name) names.set(r.id, r.name);
      for (const c of plan.diff.changes) names.set(c.resource, c.name);
      setState({
        plan,
        env: environment,
        outOfDate: outOfDate ?? null,
        names,
        audit: [...audit.entries].reverse(),
        run,
        error: null,
        notFound: false,
        loading: false,
      });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, notFound: error.status === 404, loading: false }));
    }
  };
  useEffect(() => {
    navOrder.value = [];
    load();
  }, [envId, ref]);

  const { plan, env } = state;
  const back = (
    <a class="fr-back" href={hashFor({ view: 'infrastructure', environment: envId, plan: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />
      {env?.name ?? 'The environment'}
    </a>
  );
  if (!plan || !env)
    return (
      <div class="infra-view infra-page">
        {back}
        {state.notFound ? (
          <div class="empty">
            <FileDiff size={28} aria-hidden="true" />
            <h2>No plan here.</h2>
            <p class="muted">The link may be wrong. Go back to the environment to see its plans.</p>
          </div>
        ) : state.error ? (
          <>
            <p class="field-error" role="alert">
              Couldn’t load the plan. {state.error}
            </p>
            <div class="conn-buttons">
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={load}
                disabled={state.loading}
                aria-busy={state.loading}
              >
                <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
                Try again
              </button>
            </div>
          </>
        ) : (
          <p class="muted" aria-busy="true">
            Loading the plan…
          </p>
        )}
      </div>
    );

  const costs = new Map((plan.cost?.changes ?? []).map((c) => [c.resource, c]));
  const source = SOURCE[plan.source.kind] ?? plan.source.kind;
  const misplaced = String(plan.environment.id) !== String(envId);
  return (
    <div class="infra-view infra-page infra-plan">
      {back}
      <div class="conn-top">
        <div class="view-intro">
          <div class="infra-env-head">
            <h1>
              A plan for {plan.environment.name} <span class="infra-plan-id">{plan.id}</span>
            </h1>
          </div>
          <p class="meta infra-env-where">
            {repoName(plan.repo)}
            {' · from '}
            {source}
            {plan.source.ref && (
              <>
                {' '}
                <code>{plan.source.ref}</code>
              </>
            )}
            {' · made by '}
            {auditActor(plan)} <When iso={plan.created} />
          </p>
        </div>
        <div class="conn-buttons">
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            onClick={load}
            disabled={state.loading}
            aria-busy={state.loading}
          >
            <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
            Reload
          </button>
        </div>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {misplaced && (
        <p class="meta">
          It’s {plan.environment.name}’s plan, not {env.name}’s: the link points at another environment.
        </p>
      )}

      <dl class="infra-facts infra-plan-facts">
        <div>
          <dt>State</dt>
          <dd>
            <PlanState state={plan.state} />
            {plan.approved && (
              <span class="meta">
                {' · approved '}
                <When iso={plan.approved} />
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>
            {plan.changes} {plan.changes === 1 ? 'change' : 'changes'}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd class="infra-num">
            {plan.cost?.delta === null || plan.cost?.delta === undefined
              ? 'Not known'
              : plan.cost.delta === 0
                ? 'Nothing a month'
                : `${amount(plan.cost.delta, plan.cost.currency, { signed: true })} a month, estimated`}
          </dd>
        </div>
        <div>
          <dt>Touches</dt>
          <dd>
            {plan.blastRadius.affected
              ? `${plan.blastRadius.affected} more ${plan.blastRadius.affected === 1 ? 'resource' : 'resources'}`
              : 'Nothing else'}
          </dd>
        </div>
        <div>
          <dt>Undo</dt>
          <dd>
            {plan.reversible ? (
              <span class="infra-plan-undo">
                <Undo2 size={14} aria-hidden="true" />
                Can be undone
              </span>
            ) : (
              <span class="infra-plan-irreversible">
                <TriangleAlert size={14} aria-hidden="true" />
                Can’t be undone: {plan.irreversible.length} {plan.irreversible.length === 1 ? 'change' : 'changes'}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <section class="infra-section" aria-labelledby="plan-changes">
        <h2 id="plan-changes">
          <FileDiff size={18} aria-hidden="true" />
          What changes <span class="count">{plan.changes}</span>
        </h2>
        {plan.diff.changes.length ? (
          <ol class="infra-res-list">
            {plan.diff.changes.map((c) => (
              <Change key={`${c.op} ${c.resource}`} c={c} cost={costs.get(c.resource)} currency={plan.cost?.currency} />
            ))}
          </ol>
        ) : (
          <p class="muted">Nothing: what runs already matches the repository.</p>
        )}
      </section>

      <Policy policy={plan.policy} open={plan.state === 'draft' || plan.state === 'waiting'} />
      <Cost cost={plan.cost} />
      <Reach blast={plan.blastRadius} names={state.names} />
      <Answer plan={plan} env={env} outOfDate={state.outOfDate} onChange={load} />
      <Steps run={state.run} audit={state.audit} names={state.names} envId={envId} />
    </div>
  );
}
