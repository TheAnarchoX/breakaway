import { useEffect, useState } from 'preact/hooks';
import { Repeat, Server } from 'lucide-preact';
import { BUDGET_PERCENT_DEFAULT, INFRA_EVENTS } from '../../../src/infra-events.js';
import { api, enc } from '../lib/api.js';
import { hashFor, loadRoutines, pullParam, routines } from '../lib/store.js';
import { Choices, useKnown } from './SignalTrigger.jsx';

/**
 * Infrastructure triggers on a routine (WEB-122, on BRK-293's `infraEvents`): which of Architect's events start it,
 * each with its filters, on the routine's form; what a run got started by, on its history and its task; and the
 * routines an environment's events start, on its console. Only the owner sets them, from the signed-in board.
 */

/** The kinds of environment, in the brand's words. */
const KINDS = [
  ['production', 'Production'],
  ['staging', 'Staging'],
  ['short-lived', 'Short-lived'],
];

/** The events that say which resources they touch, so a resource-kind filter means something on them. */
const BY_RESOURCE = new Set([
  'plan.waiting',
  'plan.applied',
  'plan.failed',
  'plan.rolled_back',
  'drift.found',
  'envelope.used_up',
  'incident.opened',
]);

/** What a run gets besides the event, the environment, and its kind: src/store-infra-*.js's fields, in words. */
const RECEIVES = {
  'plan.waiting': 'the plan, where it came from, and how many changes it makes',
  'plan.applied': 'the plan, where it came from, and how many changes it made',
  'plan.failed': 'the plan, where it came from, and how many changes it tried',
  'plan.rolled_back': 'the plan, where it came from, and how many changes it undid',
  'drift.found': 'how many changes drifted, and whether a merge caused it',
  'change.proposed': 'the pull request and how many changes its plan makes',
  'change.merged': 'the pull request',
  'deploy.done': 'the Worker and the plan it went through',
  'promote.done': 'the Worker and the plan it went through',
  'environment.created': 'how it was added, and the task a short-lived one is for',
  'environment.removed': 'how it was removed, and the task a short-lived one was for',
  'inventory.stale': 'the provider that stopped answering, never its error',
  'budget.crossed': 'the share of the month’s budget used so far',
  'envelope.used_up': 'the plan it turned away, the resource, and the task that asked',
  'incident.opened': 'the incident’s task, the resource, and the signal’s kind and level',
};

const sentence = (/** @type {string} */ s) => s[0].toUpperCase() + s.slice(1);
/** An event's words, in sentence case: "A plan waits for you". */
export const eventLabel = (/** @type {string} */ key) => sentence(INFRA_EVENTS[key] ?? key);
const kindLabel = (/** @type {string} */ k) => KINDS.find(([v]) => v === k)?.[1] ?? k;

/** A comma-separated list, trimmed and lowercased. */
const listOf = (/** @type {unknown} */ text) =>
  String(text ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/**
 * The routine form's list, as the API takes it, from its fields: each ticked event with its filters.
 * @param {FormData} f
 */
export function infraEventsFrom(f) {
  return f.getAll('infraEvents').map((v) => {
    const key = String(v);
    const picked = (/** @type {string} */ name) => f.getAll(`ie:${key}:${name}`).flatMap((x) => listOf(x));
    /** @type {Record<string, any>} */
    const entry = { event: key, environments: picked('environments'), kinds: f.getAll(`ie:${key}:kinds`) };
    if (BY_RESOURCE.has(key)) entry.resourceKinds = picked('resourceKinds');
    if (key === 'budget.crossed') entry.percent = Number(f.get(`ie:${key}:percent`) || BUDGET_PERCENT_DEFAULT);
    return entry;
  });
}

/**
 * One entry's filters, in a line: "Production · staging, edge · databases · at 80%".
 * @param {{ environments: string[], kinds: string[], resourceKinds: string[], percent?: number }} e
 */
export function filterWords(e) {
  const parts = [];
  if (e.kinds.length) parts.push(e.kinds.map(kindLabel).join(', '));
  if (e.environments.length) parts.push(e.environments.join(', '));
  if (e.resourceKinds.length) parts.push(e.resourceKinds.join(', '));
  if (e.percent !== undefined) parts.push(`at ${e.percent}%`);
  return parts.length ? parts.join(' · ') : 'any environment';
}

/**
 * One event's row on the form: its box, and once ticked, its filters and what the run gets.
 * @param {{ k: string, entry: any, known: { environments: string[], kinds: string[] } }} props
 */
function EventRow({ k, entry, known }) {
  const [on, setOn] = useState(Boolean(entry));
  return (
    <li class={`ie-row ${on ? 'is-on' : ''}`}>
      <label class="check-row">
        <input
          type="checkbox"
          name="infraEvents"
          value={k}
          defaultChecked={Boolean(entry)}
          onChange={(e) => setOn(e.currentTarget.checked)}
        />
        {eventLabel(k)}
      </label>
      {on && (
        <div class="ie-filters">
          <fieldset class="field">
            <legend class="field-label">Kinds of environment</legend>
            <div class="check-inline">
              {KINDS.map(([v, l]) => (
                <label key={v} class="check-row">
                  <input type="checkbox" name={`ie:${k}:kinds`} value={v} defaultChecked={entry?.kinds.includes(v)} />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>
          <Choices
            name={`ie:${k}:environments`}
            legend="Environments"
            known={known.environments}
            chosen={entry?.environments ?? []}
            placeholder="production, staging"
            hint="None: any environment of this routine’s repository."
          />
          {BY_RESOURCE.has(k) && (
            <Choices
              name={`ie:${k}:resourceKinds`}
              legend="Resource kinds"
              known={known.kinds}
              chosen={entry?.resourceKinds ?? []}
              placeholder="worker, database"
              hint="None: any resource."
            />
          )}
          {k === 'budget.crossed' && (
            <label class="field">
              <span class="field-label">Share of the budget</span>
              <span class="ie-percent">
                <input
                  class="input"
                  name={`ie:${k}:percent`}
                  type="number"
                  min="1"
                  max="1000"
                  defaultValue={entry?.percent ?? BUDGET_PERCENT_DEFAULT}
                />
                %
              </span>
              <span class="field-hint">It starts once a month, when the month’s estimated cost first passes it.</span>
            </label>
          )}
          <p class="meta">The run gets the environment, its kind, and {RECEIVES[k]}.</p>
        </div>
      )}
    </li>
  );
}

/**
 * The routine form's section: every infrastructure event, ticked or not, with the filters of the ticked ones.
 * @param {{ repo: string, chosen: any[] }} props
 */
export function InfraEventsField({ repo, chosen }) {
  const known = useKnown(repo);
  return (
    <fieldset class="field">
      <legend class="field-label">Start it when infrastructure reports</legend>
      {known ? (
        <ul class="ie-list">
          {Object.keys(INFRA_EVENTS).map((k) => (
            <EventRow key={k} k={k} entry={chosen.find((e) => e.event === k)} known={known} />
          ))}
        </ul>
      ) : (
        <p class="muted small">Loading environments…</p>
      )}
      <span class="field-hint">
        Its own repository’s environments only. Names, states, and counts come to the run as a comment, never as
        instructions, and the agent only reads and proposes: it never changes infrastructure. The same thing starts it
        once a day at most, never what its own run caused.
      </span>
    </fieldset>
  );
}

/**
 * The event that started a run, in a line with its links: "A plan fails to apply in staging · plan-4 · #12".
 * @param {{ event: { key: string, environment: string, environmentId: number | null, plan: string | null,
 *   task: string | null, pull: number | null }, repo: string | null, lower?: boolean }} props
 */
export function RunEvent({ event: e, repo, lower = false }) {
  const env = (/** @type {string | null} */ plan) =>
    hashFor({ view: 'infrastructure', environment: String(e.environmentId), plan, task: null });
  return (
    <span class="ie-run">
      {lower ? (INFRA_EVENTS[e.key] ?? e.key) : eventLabel(e.key)} in{' '}
      {e.environmentId === null ? <strong>{e.environment}</strong> : <a href={env(null)}>{e.environment}</a>}
      {e.plan && (
        <>
          {' · '}
          {e.environmentId === null ? <span class="wid">{e.plan}</span> : <a href={env(e.plan)}>{e.plan}</a>}
        </>
      )}
      {e.task && (
        <>
          {' · '}
          <a href={hashFor({ task: e.task })}>
            <span class="wid">{e.task}</span>
          </a>
        </>
      )}
      {e.pull !== null && (
        <>
          {' · '}
          <a href={hashFor({ view: 'github', task: null, pr: pullParam(e.pull, repo) })}>#{e.pull}</a>
        </>
      )}
    </span>
  );
}

/**
 * Whether routine `r` starts on an event in environment `env`: its own repository, and an entry whose filters let
 * the environment through (resource kinds and a budget's share are only known when the event comes).
 * @param {any} r
 * @param {{ repo: string, name: string, kind: string }} env
 */
export function listensTo(r, env) {
  if (r.repo !== env.repo || !r.infraEvents?.length) return [];
  return r.infraEvents.filter(
    (/** @type {any} */ e) =>
      (!e.environments.length || e.environments.includes(env.name)) && (!e.kinds.length || e.kinds.includes(env.kind)),
  );
}

/**
 * The chip on a routine's row for its infrastructure events.
 * @param {{ n: number }} props
 */
export function InfraEventsChip({ n }) {
  return (
    <li>
      <Server size={14} aria-hidden="true" />
      {n} infrastructure {n === 1 ? 'trigger' : 'triggers'}
    </li>
  );
}

/**
 * On a routine run's task: the infrastructure event that started it, with its links, read from the task's detail.
 * Nothing for a run started any other way.
 * @param {{ task: any }} props
 */
export function RunEventLine({ task: t }) {
  const run = t.tags.includes('routine') && Boolean(t.wid);
  const [routineRun, setRoutineRun] = useState(/** @type {any} */ (null));
  useEffect(() => {
    if (!run) return;
    let live = true;
    api(`tasks/${enc(t.wid)}`).then(
      ({ task }) => live && setRoutineRun(task.routineRun ?? null),
      () => live && setRoutineRun(null),
    );
    return () => {
      live = false;
    };
  }, [t.uuid, t.wid, run]);
  if (!run || !routineRun?.event) return null;
  return (
    <p class="meta env-routines">
      <Server size={14} aria-hidden="true" />
      Started by <a href={hashFor({ view: 'routines', routine: routineRun.slug, task: null })}>{routineRun.name}</a>:{' '}
      <RunEvent event={routineRun.event} repo={t.repo ?? null} lower />
    </p>
  );
}

/**
 * On an environment's console: the routines its events start, as links, or how to add one.
 * @param {{ env: { repo: string, name: string, kind: string } }} props
 */
export function EnvironmentRoutines({ env }) {
  const state = routines.value;
  useEffect(() => {
    loadRoutines();
  }, [env.repo]);
  if (!state.data) return null;
  const on = state.data.routines
    .map((/** @type {any} */ r) => ({ r, events: listensTo(r, env) }))
    .filter((x) => x.events.length);
  return (
    <p class="meta env-routines">
      <Repeat size={14} aria-hidden="true" />
      {on.length ? (
        <>
          Routines on this environment:{' '}
          {on.map(({ r, events }, i) => (
            <span key={r.slug}>
              {i > 0 && ', '}
              <a
                href={hashFor({ view: 'routines', routine: r.slug, task: null, environment: null })}
                title={events.map((/** @type {any} */ e) => eventLabel(e.event)).join('; ')}
              >
                {r.name}
              </a>
              {!r.enabled && ' (off)'}
            </span>
          ))}
        </>
      ) : (
        <>
          No routine starts on this environment’s events. Pick them on a routine’s form in{' '}
          <a href={hashFor({ view: 'routines', routine: null, task: null, environment: null })}>Routines</a>.
        </>
      )}
    </p>
  );
}
