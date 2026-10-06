// An environment's stream (WEB-94; docs/specs/WEB-94-environment-console.md): what's happening there, newest first, from
// the routes the board already has: signals (BRK-190), the audit trail (BRK-175), the executor's runs (BRK-183), and
// incidents (BRK-197). Pure, so the tests can check it; the console polls and hands it what came back.
import { auditActor, auditWords } from './infra-audit.js';

/** The most entries the stream keeps; older audit entries page in with Show older. */
export const STREAM_MAX = 60;

/** A signal's level in words: status colors always come with them. */
export const LEVEL = { info: 'Info', warning: 'Warning', critical: 'Critical' };

/** A signal's kind in words. */
const SIGNAL_KIND = { health: 'Health', alert: 'Alert', cost: 'Cost' };

/** Where a run is, in the brand's Infrastructure words: the board applies, the executor runs it. */
const RUN_PHASE = {
  queued: 'Waiting to apply',
  dispatched: 'Starting the apply',
  checked: 'Applying',
  applying: 'Applying',
  'rollback-dispatched': 'Rolling back',
  'rollback-checked': 'Rolling back',
  'rollback-applying': 'Rolling back',
};

/** How a run ended. */
const RUN_OUTCOME = {
  applied: 'Applied',
  unverified: 'Applied, not verified',
  'rolled back': 'Rolled back',
  failed: 'Apply failed',
  'rollback failed': 'Rollback failed',
  expired: 'Expired before it applied',
};

const ms = (/** @type {string | number | null | undefined} */ at) =>
  typeof at === 'number' ? at : at ? Date.parse(at) : Number.NaN;

/**
 * What a run's steps did so far: "2 of 3 changes applied", or which one failed.
 * @param {{ resource: string, op: string, ok: boolean }[] | null | undefined} steps
 */
export function stepsText(steps) {
  if (!steps?.length) return '';
  const ok = steps.filter((s) => s.ok).length;
  const failed = steps.find((s) => !s.ok);
  return failed
    ? `${ok} of ${steps.length} ${steps.length === 1 ? 'change' : 'changes'} applied; ${failed.op} of ${failed.resource} failed`
    : `${ok} of ${steps.length} ${steps.length === 1 ? 'change' : 'changes'} applied`;
}

/**
 * A run in words: where it is, or how it ended.
 * @param {{ phase: string, outcome?: string | null, rollback?: boolean }} run
 */
export function runWords(run) {
  if (run.phase === 'done') return RUN_OUTCOME[run.outcome ?? ''] ?? 'Done';
  return RUN_PHASE[run.phase] ?? run.phase;
}

/**
 * @typedef {{
 *   key: string, at: number, type: 'signal' | 'audit' | 'run' | 'incident', label: string, outcome?: string,
 *   text?: string, level?: string, who?: string, plan?: string | null, envelope?: string | null,
 *   resource?: string | null, task?: { uuid: string, wid: string | null, description: string } | null, live?: boolean,
 * }} StreamItem
 */

/**
 * Every source as one stream, newest first, at most `max` entries. A run keeps one entry, keyed by its plan, that
 * moves as the run does; everything else is one entry each.
 * @param {{ signals?: any[], audit?: any[], runs?: any[], incidents?: any[] }} sources
 * @param {number} [max]
 * @returns {StreamItem[]}
 */
export function streamItems({ signals = [], audit = [], runs = [], incidents = [] }, max = STREAM_MAX) {
  /** @type {StreamItem[]} */
  const items = [];
  for (const s of signals)
    items.push({
      key: `signal:${s.id}`,
      at: ms(s.at),
      type: 'signal',
      label: SIGNAL_KIND[s.kind] ?? s.kind,
      outcome: LEVEL[s.level] ?? s.level,
      level: s.level,
      text: s.text,
      who: s.source,
      resource: s.resource ?? null,
    });
  for (const e of audit) {
    const { label, outcome } = auditWords(e);
    items.push({
      key: `audit:${e.id}`,
      at: ms(e.at),
      type: 'audit',
      label,
      outcome,
      text: e.summary ?? '',
      who: auditActor(e),
      plan: e.plan ?? null,
      envelope: e.envelope ?? null,
    });
  }
  for (const r of runs) {
    const steps = r.rollback && r.rollbackSteps ? r.rollbackSteps : r.steps;
    items.push({
      key: `run:${r.plan}`,
      at: ms(r.updated ?? r.created),
      type: 'run',
      label: runWords(r),
      outcome: r.phase === 'done' ? '' : 'now',
      text: [stepsText(steps), r.error ?? ''].filter(Boolean).join(' · '),
      who: 'the executor',
      plan: r.plan,
      live: r.phase !== 'done',
      level: r.phase === 'done' && ['failed', 'rollback failed'].includes(r.outcome) ? 'critical' : undefined,
    });
  }
  for (const i of incidents)
    items.push({
      key: `incident:${i.id}`,
      at: ms(i.opened),
      type: 'incident',
      label: i.closed ? 'Incident closed' : 'Incident opened',
      outcome: LEVEL[i.level] ?? i.level,
      level: i.level,
      text: `${i.kind}${i.resource ? ` on ${i.resource}` : ''}, ${i.signals} ${i.signals === 1 ? 'signal' : 'signals'}`,
      resource: i.resource ?? null,
      task: i.task ?? null,
    });
  return items
    .filter((i) => Number.isFinite(i.at))
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
    .slice(0, max);
}

/**
 * The entries that weren't in the stream last time, so they arrive with a slide: none on the first load.
 * @param {Set<string> | null} before the keys shown last time, or null on the first load
 * @param {StreamItem[]} items
 */
export function arrived(before, items) {
  if (!before) return new Set();
  return new Set(items.filter((i) => !before.has(i.key)).map((i) => i.key));
}

/**
 * The agents at work on an environment now: the claimed, open tasks it's for (a short-lived environment's task, or
 * its incidents'), and the agents whose open plans wait or apply there.
 * @param {{ uuid: string, wid?: string | null, description: string, claim?: string | null, status: string }[]} tasks
 * @param {{ env: { task?: { uuid: string } | null }, incidents?: any[], plans?: any[] }} where
 * @returns {{ agent: string, task: any | null, why: string }[]}
 */
export function agentsAtWork(tasks, { env, incidents = [], plans = [] }) {
  const byUuid = new Map(tasks.map((t) => [t.uuid, t]));
  /** @type {Map<string, string>} */
  const why = new Map();
  if (env.task?.uuid) why.set(env.task.uuid, 'its task');
  for (const i of incidents) if (!i.closed && i.task?.uuid && !why.has(i.task.uuid)) why.set(i.task.uuid, 'incident');
  /** @type {{ agent: string, task: any | null, why: string }[]} */
  const out = [];
  for (const [uuid, reason] of why) {
    const t = byUuid.get(uuid);
    if (t?.claim && t.status === 'pending') out.push({ agent: t.claim, task: t, why: reason });
  }
  for (const p of plans)
    if (p.agent && ['draft', 'waiting', 'applying'].includes(p.state) && !out.some((o) => o.agent === p.agent))
      out.push({ agent: p.agent, task: null, why: p.id });
  return out;
}
