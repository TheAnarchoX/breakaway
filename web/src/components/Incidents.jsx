import { useEffect, useState } from 'preact/hooks';
import { Circle, CircleCheck, CircleDot, CircleMinus, CircleX, Siren } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { hashFor } from '../lib/store.js';
import { planHref } from './EnvironmentPlans.jsx';
import { NoneYet } from './ui.jsx';

/**
 * Incidents on the board (WEB-63; docs/specs/IDEA-19-architect.md, "Incidents" and "Views"): an incident is a task
 * tagged +incident that the board opens when a signal crosses a rule (BRK-197). This file shows one on its task, as
 * its steps with the signals that opened it and its linked plans, and an environment's incidents on its page. The
 * inbox's incident pings use `currentStep` and `IncidentWhere` from here. Read only: the API is GET
 * /api/infra/incidents, and nothing here approves or applies.
 */

/** The steps every incident has, in order, in the brand's Infrastructure words, with what each one means. */
export const STEP = {
  diagnose: { label: 'Diagnose', help: 'Read the signals, the inventory, and the code. Nothing changes.' },
  propose: { label: 'Propose', help: 'A plan, or a pull request, that fixes it.' },
  approve: { label: 'Approve', help: 'Only you, on the board.' },
  apply: { label: 'Apply', help: 'The board applies the plan you approved.' },
  verify: { label: 'Verify', help: 'Health is back, from the signals.' },
  'write-up': { label: 'Write up', help: 'What happened and why, on the task, and a task for each follow-up.' },
};

/** A step's state, in words, with its icon. */
const STEP_STATE = {
  done: { label: 'Done', Icon: CircleCheck },
  now: { label: 'Now', Icon: CircleDot },
  next: { label: 'Next', Icon: Circle },
  skipped: { label: 'Skipped', Icon: CircleMinus },
  failed: { label: 'Failed', Icon: CircleX },
};

/** A plan's state (brand/README.md, "Infrastructure words"). */
const PLAN_STATE = {
  draft: 'Draft',
  waiting: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  'rolled back': 'Rolled back',
};

/** How loud a signal was: the levels below the rule are the stream's, and only critical opens an incident. */
const LEVEL = { info: 'Info', warning: 'Warning', critical: 'Critical' };

/** Signals a task's incident shows at a time: the newest of its environment, resource, and kind. */
const SIGNALS_SHOWN = 10;
/** Incidents an environment's page shows at a time; Show older pages back with `before`. */
const INCIDENTS_PAGE = 10;

/** @param {{ iso: string | null }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/**
 * The step to do now, else the one that failed, else null (every step done or skipped).
 * @param {{ steps: { step: string, state: string }[] }} incident
 */
export const currentStep = (incident) =>
  incident.steps.find((s) => s.state === 'now') ?? incident.steps.find((s) => s.state === 'failed') ?? null;

/**
 * The step it's on, in words ("Now: Approve", "Failed: Apply"), or null once every step is done or skipped.
 * @param {{ steps: { step: string, state: string }[] }} incident
 */
export function stepNote(incident) {
  const step = currentStep(incident);
  if (!step) return null;
  return `${step.state === 'failed' ? 'Failed' : 'Now'}: ${STEP[step.step]?.label ?? step.step}`;
}

/**
 * Open, recovered (open, but the last signal is below the rule), or closed (its task finished or was deleted).
 * @param {any} incident
 */
export function incidentStatus(incident) {
  if (incident.closed) return { id: 'closed', label: 'Closed' };
  if (incident.recovered) return { id: 'recovered', label: 'Recovered' };
  return { id: 'open', label: 'Open' };
}

/**
 * Production first, then open before closed, then newest: what needs the owner reads first.
 * @param {any[]} incidents
 */
export function sortIncidents(incidents) {
  const rank = (/** @type {any} */ i) => (i.environmentKind === 'production' ? 0 : 1) * 2 + (i.closed ? 1 : 0);
  return [...incidents].sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}

/**
 * Where the incident is: its environment, linked to the environment's page, and the resource.
 * @param {{ incident: any }} props
 */
export function IncidentWhere({ incident: i }) {
  return (
    <>
      {i.environment ? (
        <a href={hashFor({ view: 'infrastructure', environment: String(i.environmentId), task: null })}>
          {i.environment}
        </a>
      ) : (
        'an environment that’s gone'
      )}
      {i.environmentKind === 'production' && i.environment !== 'production' && ' (production)'}
      {i.resource && (
        <>
          {' · '}
          <code>{i.resource}</code>
        </>
      )}
    </>
  );
}

/** @param {{ steps: { step: string, state: string }[] }} props */
export function IncidentSteps({ steps }) {
  return (
    <ol class="incident-steps">
      {steps.map((s) => {
        const state = STEP_STATE[s.state] ?? STEP_STATE.next;
        const step = STEP[s.step] ?? { label: s.step, help: '' };
        return (
          <li
            key={s.step}
            class={`incident-step incident-step-${s.state}`}
            aria-current={s.state === 'now' ? 'step' : undefined}
          >
            <state.Icon size={16} aria-hidden="true" class="incident-step-icon" />
            <span class="incident-step-text">
              <span class="incident-step-label">
                {step.label}
                <span class="incident-step-state"> · {state.label}</span>
              </span>
              {step.help && <span class="meta">{step.help}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The signals for the incident's environment, resource, and kind since the one that opened it, newest first. Raw
 * signals are kept a week; older ones are in the daily summaries.
 * @param {{ incident: any }} props
 */
function IncidentSignals({ incident: i }) {
  const [state, setState] = useState(
    /** @type {{ signals: any[], error: string | null, loaded: boolean }} */ ({
      signals: [],
      error: null,
      loaded: false,
    }),
  );
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({
      environmentId: String(i.environmentId),
      kind: i.kind,
      limit: String(SIGNALS_SHOWN),
    });
    if (i.resource) q.set('resource', i.resource);
    api(`infra/signals?${q}`).then(
      ({ signals }) =>
        live &&
        setState({
          signals: signals.filter((/** @type {any} */ s) => s.id >= i.signal && (s.resource ?? null) === i.resource),
          error: null,
          loaded: true,
        }),
      (error) => live && setState({ signals: [], error: error.message, loaded: true }),
    );
    return () => {
      live = false;
    };
  }, [i.id, i.lastSignal]);
  return (
    <div class="incident-signals">
      <h4 class="kicker">
        Signals <span class="count">{i.signals}</span>
      </h4>
      {state.error ? (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      ) : !state.loaded ? (
        <p class="meta" aria-busy="true">
          Loading the signals…
        </p>
      ) : state.signals.length ? (
        <ol class="incident-signal-list">
          {state.signals.map((s) => (
            <li key={s.id} class={`incident-signal${s.id === i.signal ? ' is-first' : ''}`}>
              <span class={`incident-level incident-level-${s.level}`}>{LEVEL[s.level] ?? s.level}</span>
              <span class="incident-signal-text">{s.text}</span>
              <span class="meta">
                {s.source}
                {s.value !== null && ` · ${s.value}`}
                {' · '}
                <When iso={s.at} />
                {s.id === i.signal && ' · opened it'}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="meta">None in the last week: the board keeps each signal for 7 days, then only its day’s summary.</p>
      )}
    </div>
  );
}

/** @param {{ plans: any[] }} props */
function IncidentPlans({ plans }) {
  return (
    <div class="incident-plans">
      <h4 class="kicker">Plans</h4>
      {plans.length ? (
        <ul class="incident-plan-list">
          {plans.map((p) => (
            <li key={p.id}>
              <a href={planHref(p)}>
                <code>{p.id}</code>
              </a>
              <span class={`incident-plan-state incident-plan-${p.state.replace(' ', '-')}`}>
                {PLAN_STATE[p.state] ?? p.state}
              </span>
              <span class="meta">
                {p.changes === 1 ? '1 change' : `${p.changes} changes`}
                {' · '}
                <When iso={p.updated ?? p.created} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="meta">
          None yet. A plan with source <code>incident</code> and this task’s work ID as its ref shows here, and moves
          the steps on.
        </p>
      )}
    </div>
  );
}

/**
 * The incident on its task's page: where, how loud, whether it pushed, its steps, its plans, and its signals. It
 * shows on a task tagged +incident, read by the task's work ID.
 * @param {{ task: any }} props
 */
export function IncidentSection({ task: t }) {
  const tagged = t.tags.includes('incident') && Boolean(t.wid);
  const [state, setState] = useState(
    /** @type {{ incident: any, error: string | null, loaded: boolean }} */ ({
      incident: null,
      error: null,
      loaded: false,
    }),
  );
  useEffect(() => {
    if (!tagged) return;
    let live = true;
    setState((s) => ({ ...s, loaded: false }));
    api(`infra/incidents/${enc(t.wid)}`).then(
      ({ incident }) => live && setState({ incident, error: null, loaded: true }),
      // A task someone tagged +incident by hand has no incident behind it: the section stays away.
      (error) => live && setState({ incident: null, error: error.status === 404 ? null : error.message, loaded: true }),
    );
    return () => {
      live = false;
    };
  }, [t.uuid, t.wid, t.modified, tagged]);
  if (!tagged || (state.loaded && !state.incident && !state.error)) return null;
  const i = state.incident;
  const status = i && incidentStatus(i);
  return (
    <section class="panel-section incident" aria-labelledby={`incident-${t.uuid}`}>
      <h3 id={`incident-${t.uuid}`}>
        <Siren size={14} aria-hidden="true" /> Incident
      </h3>
      {state.error ? (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      ) : !i ? (
        <p class="meta" aria-busy="true">
          Loading the incident…
        </p>
      ) : (
        <>
          <p class="incident-line">
            <span class={`incident-status incident-status-${status.id}`}>{status.label}</span>
            <span class="meta">
              {i.kind}, {LEVEL[i.level]?.toLowerCase() ?? i.level}, in <IncidentWhere incident={i} />
            </span>
          </p>
          <p class="meta incident-facts">
            Opened <When iso={i.opened} />
            {' · last signal '}
            <When iso={i.lastSignal} />
            {i.recovered && (
              <>
                {' · recovered '}
                <When iso={i.recovered} />
              </>
            )}
            {' · '}
            {i.pushed ? 'pushed to your phone' : 'in the inbox only, not pushed'}
          </p>
          <IncidentSteps steps={i.steps} />
          <IncidentPlans plans={i.plans} />
          <IncidentSignals incident={i} />
        </>
      )}
    </section>
  );
}

/** @param {{ incident: any }} props */
function IncidentRow({ incident: i }) {
  const status = incidentStatus(i);
  const note = !i.closed && stepNote(i);
  const ref = i.task?.wid ?? i.task?.uuid?.slice(0, 8);
  return (
    <li class={`incident-row incident-row-${status.id}`}>
      <div class="incident-row-head">
        <span class={`incident-status incident-status-${status.id}`}>{status.label}</span>
        {i.task ? (
          <a class="incident-row-task" href={hashFor({ task: ref })}>
            <span class="wid">{ref}</span> {i.task.description}
          </a>
        ) : (
          <span class="meta">Its task is gone.</span>
        )}
      </div>
      <p class="meta">
        {i.kind}
        {i.resource && (
          <>
            {' · '}
            <code>{i.resource}</code>
          </>
        )}
        {' · '}
        {i.signals === 1 ? '1 signal' : `${i.signals} signals`}
        {' · opened '}
        <When iso={i.opened} />
        {note && ` · ${note}`}
      </p>
    </li>
  );
}

/**
 * An environment's incidents, on its page: open ones first, then the ones whose task is finished, newest first.
 * A new `tick` reads again (the console's poll, WEB-94).
 * @param {{ env: any, tick?: number }} props
 */
export function IncidentsSection({ env, tick = 0 }) {
  const [state, setState] = useState(
    /** @type {{ incidents: any[], more: boolean, error: string | null, loaded: boolean }} */ ({
      incidents: [],
      more: false,
      error: null,
      loaded: false,
    }),
  );
  const [older, setOlder] = useState(false);
  const page = (/** @type {number | null} */ before) =>
    api(`infra/incidents?environment=${enc(env.id)}&limit=${INCIDENTS_PAGE}${before ? `&before=${enc(before)}` : ''}`);
  useEffect(() => {
    let live = true;
    page(null).then(
      ({ incidents, more }) => live && setState({ incidents, more, error: null, loaded: true }),
      (error) => live && setState({ incidents: [], more: false, error: error.message, loaded: true }),
    );
    return () => {
      live = false;
    };
  }, [env.id, tick]);
  const loadOlder = async () => {
    const last = state.incidents.at(-1);
    if (!last) return;
    setOlder(true);
    try {
      const { incidents, more } = await page(last.id);
      setState((s) => ({ ...s, incidents: [...s.incidents, ...incidents], more }));
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setOlder(false);
    }
  };
  const open = state.incidents.filter((i) => !i.closed);
  const shown = sortIncidents(state.incidents);
  return (
    <section class="infra-section" aria-labelledby="infra-incidents">
      <h2 id="infra-incidents">
        <Siren size={18} aria-hidden="true" />
        Incidents {open.length > 0 && <span class="count">{open.length} open</span>}
      </h2>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loaded ? (
        <p class="muted" aria-busy="true">
          Loading the incidents…
        </p>
      ) : shown.length ? (
        <>
          <ul class="incident-list">
            {shown.map((i) => (
              <IncidentRow key={i.id} incident={i} />
            ))}
          </ul>
          {state.more && (
            <button
              type="button"
              class="btn btn-quiet btn-sm infra-audit-more"
              onClick={loadOlder}
              disabled={older}
              aria-busy={older}
            >
              {older ? 'Loading…' : 'Show older'}
            </button>
          )}
        </>
      ) : (
        !state.error && <NoneYet>A critical signal here opens one, in your inbox.</NoneYet>
      )}
    </section>
  );
}
