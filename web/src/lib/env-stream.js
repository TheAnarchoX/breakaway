// An environment's stream (WEB-94; docs/specs/WEB-94-environment-console.md): what's happening there, newest first, from
// the routes the board already has: signals (BRK-190), the audit trail (BRK-175), the executor's runs (BRK-183), and
// incidents (BRK-197). Pure, so the tests can check it; the console polls and hands it what came back.
import { auditActor, auditSummary, auditWords, summaryText } from './infra-audit.js';

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

/** How long a started run may take to ask for its plan before the words say it's waiting for it (BRK-308). */
const CHECK_IN_MS = 60_000;

/**
 * A run in words: where it is, or how it ended. A run started a while ago that hasn't asked for its plan says so,
 * with how long, rather than "Starting the apply"; one that ended having applied nothing says that (BRK-308).
 * @param {{ phase: string, outcome?: string | null, rollback?: boolean, dispatched?: string | null, startAgain?: boolean }} run
 * @param {number} [now]
 */
export function runWords(run, now = Date.now()) {
  if (run.phase === 'done') {
    if (run.startAgain && run.outcome === 'failed') return 'Failed: nothing applied';
    return RUN_OUTCOME[run.outcome ?? ''] ?? 'Done';
  }
  if (run.phase === 'dispatched' && run.dispatched) {
    const waited = now - ms(run.dispatched);
    if (waited >= CHECK_IN_MS) return `Waiting for the run to check in, ${Math.floor(waited / 60_000)} min`;
  }
  return RUN_PHASE[run.phase] ?? run.phase;
}

/**
 * A run on the status band's Plan tile, which has room for a word or two: the value, and what follows under it, or
 * null when the value says it all (BRK-308).
 * @param {Parameters<typeof runWords>[0]} run
 * @param {number} [now]
 * @returns {{ value: string, detail: string | null }}
 */
export function runTile(run, now = Date.now()) {
  const words = runWords(run, now);
  const waiting = /^Waiting for the run to check in, (\d+ min)$/u.exec(words);
  if (waiting) return { value: 'Waiting', detail: `for the run, ${waiting[1]}` };
  if (words === 'Failed: nothing applied') return { value: 'Failed', detail: 'nothing applied' };
  return { value: words, detail: null };
}

/**
 * The run's page on GitHub, in words, once the board knows it: while it goes, "Running on GitHub"; when it ended
 * there before it asked for its plan, how (BRK-308). Null when the board doesn't know the run yet.
 * @param {{ phase: string, github?: { url?: string | null, conclusion?: string | null } | null }} run
 * @returns {{ url: string, text: string } | null}
 */
export function githubRun(run) {
  const url = run.github?.url;
  if (!url) return null;
  if (run.github?.conclusion) return { url, text: `Ended on GitHub: ${run.github.conclusion}, open the run` };
  return { url, text: run.phase === 'done' ? 'Open the run on GitHub' : 'Running on GitHub: open the run' };
}

/**
 * @typedef {{
 *   key: string, at: number, type: 'signal' | 'audit' | 'run' | 'incident', kind: StreamKind, label: string,
 *   outcome?: string, text?: string, parts?: (string | { plan: string })[], level?: string, who?: string, plan?: string | null, envelope?: string | null,
 *   resource?: string | null, task?: { uuid: string, wid: string | null, description: string } | null, live?: boolean,
 *   count?: number, firstAt?: number, link?: { url: string, text: string } | null,
 * }} StreamItem
 */

/** @typedef {'alert' | 'deploy' | 'plan' | 'agent' | 'change'} StreamKind what the stream's filter calls an entry */

/** The stream's filter by kind (WEB-97), in order; a change that's none of them shows under All only. */
export const STREAM_KINDS = /** @type {const} */ ({
  alert: 'Alerts',
  deploy: 'Deploys',
  plan: 'Plans',
  agent: 'Agents',
});

/** The stream's filter by level: everything, warnings and worse, or only what's critical. */
export const STREAM_LEVELS = /** @type {const} */ ({ all: 'Any level', warning: 'Warning+', critical: 'Critical' });

/** A deploy flow's audit entry: Deploy, Promote, or Roll back, by its summary. */
const FLOW = /^(Deploy|Promote|Roll back) of /u;

/**
 * What an audit entry is, for the filter: a deploy flow's, an agent's, a plan's, or another change.
 * @param {{ kind: string, by: string, plan?: string | null, summary?: string | null }} e
 * @returns {StreamKind}
 */
function auditKind(e) {
  if (FLOW.test(e.summary ?? '')) return 'deploy';
  if (e.by === 'agent') return 'agent';
  if (e.plan || e.kind === 'plan' || e.kind === 'envelope') return 'plan';
  return 'change';
}

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
      kind: s.source === 'deploy' ? 'deploy' : 'alert',
      label: SIGNAL_KIND[s.kind] ?? s.kind,
      outcome: LEVEL[s.level] ?? s.level,
      level: s.level,
      text: s.text,
      who: s.source,
      resource: s.resource ?? null,
    });
  for (const e of audit) {
    const { label, outcome } = auditWords(e);
    const parts = auditSummary(e);
    items.push({
      key: `audit:${e.id}`,
      at: ms(e.at),
      type: 'audit',
      kind: auditKind(e),
      label,
      outcome,
      text: summaryText(parts),
      parts,
      who: auditActor(e),
      plan: e.plan ?? null,
      envelope: e.envelope ?? null,
    });
  }
  for (const r of runs) {
    const steps = r.rollback && r.rollbackSteps ? r.rollbackSteps : r.steps;
    const failedOnGitHub = r.phase === 'done' && r.outcome === 'failed' && r.github?.conclusion;
    items.push({
      key: `run:${r.plan}`,
      at: ms(r.updated ?? r.created),
      type: 'run',
      kind: 'plan',
      label: failedOnGitHub ? 'The run failed on GitHub before applying' : runWords(r),
      outcome: r.phase === 'done' ? '' : 'now',
      text: failedOnGitHub
        ? `${r.github.conclusion}: nothing applied. Start the run again on ${r.plan}.`
        : [stepsText(steps), r.error ?? ''].filter(Boolean).join(' · '),
      who: 'the executor',
      plan: r.plan,
      live: r.phase !== 'done',
      level: r.phase === 'done' && ['failed', 'rollback failed'].includes(r.outcome) ? 'critical' : undefined,
      link: failedOnGitHub && r.github.url ? { url: r.github.url, text: 'Open the run' } : githubRun(r),
    });
  }
  for (const i of incidents)
    items.push({
      key: `incident:${i.id}`,
      at: ms(i.opened),
      type: 'incident',
      kind: 'alert',
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
 * The stream with repeats folded (WEB-97): a signal that says the same thing again (the same source, kind, level,
 * resource, and words) joins the newest one's row, which keeps its place and counts them, with when the first came.
 * An account-wide signal names no resource, so its repeats fold into one row too. Everything else stays one row each.
 * @param {StreamItem[]} items newest first
 * @returns {StreamItem[]}
 */
export function groupStream(items) {
  /** @type {Map<string, StreamItem>} */
  const rows = new Map();
  /** @type {StreamItem[]} */
  const out = [];
  for (const item of items) {
    if (item.type !== 'signal') {
      out.push(item);
      continue;
    }
    const key = [item.who ?? '', item.label, item.level ?? '', item.resource ?? '', item.text ?? ''].join('\u0000');
    const row = rows.get(key);
    if (row) {
      row.count = (row.count ?? 1) + 1;
      row.firstAt = Math.min(row.firstAt ?? row.at, item.at);
      continue;
    }
    const first = { ...item, count: 1, firstAt: item.at };
    rows.set(key, first);
    out.push(first);
  }
  return out;
}

/** How bad each level is, for the level filter; an entry with none counts as info. */
const RANK = { info: 0, warning: 1, critical: 2 };

/**
 * The entries a filter keeps: one kind or all of them, at a level or worse.
 * @param {StreamItem[]} items
 * @param {{ kind?: keyof typeof STREAM_KINDS | 'all', level?: keyof typeof STREAM_LEVELS }} filter
 */
export function filterStream(items, { kind = 'all', level = 'all' } = {}) {
  const least = level === 'all' ? 0 : RANK[level];
  return items.filter(
    (i) => (kind === 'all' || i.kind === kind) && (RANK[/** @type {keyof typeof RANK} */ (i.level)] ?? 0) >= least,
  );
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
