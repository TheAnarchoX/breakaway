/**
 * Incidents, the pure part (docs/specs/IDEA-19-architect.md, "Incidents"; BRK-197): a signal that crosses the rule
 * opens an incident, an ordinary task tagged +incident in the repository that owns the environment, with the signal
 * and what the inventory knows about the resource. Its steps are diagnose (read only), propose (a plan), approve,
 * apply, verify, and a write-up with follow-up tasks; each step's state comes from the plan linked to the incident
 * (source `incident`, ref the task's work ID) and from the signals since. src/store-infra-incidents.js keeps the
 * incidents and hears the signals stream.
 *
 * An incident never starts an agent: a diagnosis agent starts only from a runbook the owner turned on (BRK-172,
 * BRK-196). A production incident pushes to the owner's phone; any other goes to the inbox quietly.
 */
import { SIGNAL_LEVELS } from './infra-provider.js';

/** The lowest level that opens an incident: a warning is the stream's, a critical signal needs someone. */
export const INCIDENT_LEVEL = 'critical';
/** A signal older than this when it reaches the board opens nothing: an incident is about what's happening now. */
export const INCIDENT_FRESH_MS = 24 * 3_600_000;
/** A repeat within this long of the last comment is counted, not commented, so a noisy signal can't flood the task. */
export const INCIDENT_REPEAT_MS = 15 * 60_000;
/** The steps on every incident, in order. */
export const INCIDENT_STEPS = ['diagnose', 'propose', 'approve', 'apply', 'verify', 'write-up'];
/** A step's state: finished, the one to do now, not yet, skipped (the task closed first), or failed. */
export const STEP_STATES = ['done', 'now', 'next', 'skipped', 'failed'];

const TITLE_MAX = 200;

/** Whether a signal crosses the rule. */
export const crossesRule = (level) => SIGNAL_LEVELS.indexOf(level) >= SIGNAL_LEVELS.indexOf(INCIDENT_LEVEL);

/**
 * What makes two signals the same incident: the environment, the resource, and the kind, never the level, the time,
 * or the words, so a warning that turns critical and back is still the one incident.
 * @param {number} environmentId
 * @param {{ resource: string | null, kind: string }} signal
 */
export const incidentKey = (environmentId, signal) =>
  JSON.stringify([environmentId, signal.resource ?? '', signal.kind]);

/**
 * Whether an environment's incidents push: production's do, and any environment the owner put production gates on.
 * @param {{ kind: string, gates?: number | boolean | null }} environment
 */
export const pushes = (environment) =>
  environment.gates === null || environment.gates === undefined
    ? environment.kind === 'production'
    : Boolean(environment.gates);

/**
 * The incident's task title: what, how loud, and where, then the signal's words, cut to fit.
 * @param {{ kind: string, level: string, environment: string, resource: string | null, text: string }} signal
 * @param {{ name: string } | null} resource the inventory's resource, when it knows it
 */
export function incidentTitle(signal, resource) {
  const where = resource?.name ?? signal.resource;
  const title = `Incident: ${signal.kind}, ${signal.level}, in ${signal.environment}${where ? ` (${where})` : ''}: ${signal.text}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

/**
 * The incident's brief: the signal, what the inventory knows about the resource, and the steps, with the rule that
 * nobody but the owner's approval changes infrastructure.
 * @param {{ id: number, source: string, environment: string, resource: string | null, kind: string, level: string,
 *   value: number | null, at: string, text: string }} signal
 * @param {{ name: string, environmentKind: string, resource: { id: string, kind: string, name: string,
 *   health: string | null, healthText: string | null } | null, dependents: number }} context
 */
export function incidentBrief(signal, context) {
  const r = context.resource;
  const lines = [
    `A ${signal.level} ${signal.kind} signal from ${signal.source} in ${context.name} (${context.environmentKind}) at ${signal.at}: ${signal.text}`,
    signal.value === null ? null : `Value: ${signal.value}.`,
    r
      ? `Resource: ${r.name} (${r.kind}, ${r.id})${r.health ? `, health ${r.health}${r.healthText ? `: ${r.healthText}` : ''}` : ''}. ${
          context.dependents === 1 ? '1 resource leans on it.' : `${context.dependents} resources lean on it.`
        }`
      : signal.resource
        ? `Resource: ${signal.resource}, not in the inventory yet.`
        : 'The whole environment.',
    '',
    'Steps:',
    '1. Diagnose, read only: the signals, the inventory, and the code. Note what you find here.',
    `2. Propose a fix: a plan with source incident and ref this task's work ID, or a pull request.`,
    '3. Approve: the owner approves the plan on the board.',
    '4. Apply: the board applies what was approved; nobody applies by hand.',
    '5. Verify: health is back, from the signals.',
    '6. Write up what happened and why here, and add a task for each follow-up.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Each step's state, from the plan linked to the incident and what the signals say since.
 * @param {{ plan: { state: string, updated: string } | null, recovered: string | null, closed: boolean }} input
 *   `plan` the newest linked plan that wasn't rejected, else the newest; `recovered` when a signal below the rule
 *   last came in after the last one that crossed it.
 * @returns {Array<{ step: string, state: string }>}
 */
export function incidentSteps({ plan, recovered, closed }) {
  const s = plan?.state ?? null;
  const approved = ['approved', 'applying', 'applied', 'failed', 'rolled back'].includes(s);
  const verified = s === 'applied' && Boolean(recovered) && Date.parse(recovered) >= Date.parse(plan.updated);
  /** @type {Record<string, string>} */
  const state = {
    diagnose: s ? 'done' : 'now',
    propose: !s ? 'next' : s === 'draft' || s === 'rejected' ? 'now' : 'done',
    approve: s === 'waiting' ? 'now' : approved ? 'done' : 'next',
    apply:
      s === 'approved' || s === 'applying'
        ? 'now'
        : s === 'applied'
          ? 'done'
          : s === 'failed' || s === 'rolled back'
            ? 'failed'
            : 'next',
    verify: verified ? 'done' : s === 'applied' ? 'now' : 'next',
    'write-up': closed ? 'done' : verified ? 'now' : 'next',
  };
  return INCIDENT_STEPS.map((step) => ({
    step,
    state: closed && (state[step] === 'now' || state[step] === 'next') ? 'skipped' : state[step],
  }));
}
