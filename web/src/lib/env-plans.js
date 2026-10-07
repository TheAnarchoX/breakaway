// An environment's Plans panel (WEB-115): everything about its plans, from what the console already reads. The console
// change still the board's (its pull request waiting for you, merging, or merged with no plan yet), the open plans
// (waiting, draft, approved and queued, applying, with the run's progress), then the last few that ended. Pure, so the
// tests can check it; the console hands it what it polled.
import { cardState, changePlanId, recentChange } from './infra-change.js';
import { runWords, stepsText } from './env-stream.js';

/** The plan states that are still open, in the order the panel lists them. */
export const OPEN_PLANS = ['applying', 'approved', 'waiting', 'draft'];
/** The plan states that ended. */
const ENDED_PLANS = ['applied', 'failed', 'rolled back', 'rejected'];
/** How many plans that ended the panel lists. */
export const RECENT_PLANS = 5;

/**
 * @typedef {{ change: any, card: { state: string } }} ChangeRow a console change and its card's state
 * @typedef {{ plan: any, run: any, progress: string | null, change: any }} PlanRow a plan, its run while it applies,
 *   and the console change it came from
 */

/**
 * Where a plan's run is, in words, without repeating the plan's own state: "Waiting to apply" under an approved plan,
 * "1 of 3 changes applied" under one applying, or which change failed.
 * @param {{ phase: string, steps?: { resource: string, op: string, ok: boolean }[] | null }} run
 * @param {{ state: string, changes?: number }} plan
 */
export function runProgress(run, plan) {
  const steps = run.steps ?? [];
  const words = runWords(run);
  const where = plan.state === 'applying' && words === 'Applying' ? '' : words;
  if (!steps.length) return where;
  const total = Math.max(plan.changes ?? 0, steps.length);
  const done = steps.some((s) => !s.ok)
    ? stepsText(steps)
    : `${steps.filter((s) => s.ok).length} of ${total} ${total === 1 ? 'change' : 'changes'} applied`;
  return [where, done].filter(Boolean).join(' · ');
}

/**
 * The panel's rows.
 * @param {{ plans?: any[], runs?: any[], changes?: { open: any, changes: any[] } | null, checks?: (change: any) => string | null, now?: number }} data
 *   `checks` gives a change's pull request checks (`pending`, `success`, `failure`), when the console has them
 * @returns {{ changes: ChangeRow[], open: PlanRow[], recent: PlanRow[] }}
 */
export function plansPanel({ plans = [], runs = [], changes = null, checks = () => null, now = Date.now() }) {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const live = new Map(runs.filter((r) => r.phase !== 'done').map((r) => [r.plan, r]));
  // Every change the board has, the open one first; a plan made from one says which.
  const all = [...(changes?.open ? [changes.open] : []), ...(changes?.changes ?? [])].filter(
    (c, i, list) => list.findIndex((d) => d.n === c.n) === i,
  );
  const fromChange = new Map(all.flatMap((c) => (changePlanId(c) ? [[changePlanId(c), c]] : [])));

  // A change shows on its own while it's the board's (its pull request open or merging), or merged in the last day and
  // not yet a plan the panel lists: the board hasn't compared it yet, or the environment holds it for you.
  const changeRows = all.flatMap((change) => {
    const id = changePlanId(change);
    if (id && byId.has(id)) return [];
    const mine = change.state === 'open' || change.state === 'approved';
    const merged =
      change.state === 'merged' && (!change.outcome || change.outcome.kind === 'waits') && recentChange(change, now);
    return mine || merged ? [{ change, card: cardState(change, { checks: checks(change) }) }] : [];
  });

  /** @returns {PlanRow} */
  const row = (/** @type {any} */ plan) => {
    const run = live.get(plan.id) ?? null;
    const progress = run ? runProgress(run, plan) : null;
    return { plan, run, progress, change: fromChange.get(plan.id) ?? null };
  };
  // A run still going whose plan is older than the ones read shows from the run alone.
  const runOnly = [...live.values()]
    .filter((r) => !byId.has(r.plan))
    .map((r) => ({
      id: r.plan,
      state: 'applying',
      environment: r.environment,
      created: r.created,
      updated: r.updated,
    }));
  const open = [...plans.filter((p) => OPEN_PLANS.includes(p.state)), ...runOnly]
    .sort((a, b) => OPEN_PLANS.indexOf(a.state) - OPEN_PLANS.indexOf(b.state))
    .map(row);
  const recent = plans
    .filter((p) => ENDED_PLANS.includes(p.state))
    .slice(0, RECENT_PLANS)
    .map(row);
  return { changes: changeRows, open, recent };
}
