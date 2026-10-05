/**
 * What an agent run is doing, as one of the states in docs/specs/IDEA-33-onboarding-hardening.md ("When an agent
 * run goes wrong"), for a task's Agent section and the Agents view (WEB-41). Pure: the store gathers the facts,
 * and the web app says each state in words. Waiting to start is the queue's, not a run's, so it isn't here.
 */

/** Output within this long: the session is working. */
export const LIVE_MS = 120_000;
/** A started session that hasn't said anything for this long is late: the owner should open it. */
export const LATE_MS = 600_000;

/** Agent kinds that work on a pull request: an open pull request doesn't end their run. */
const ON_PR = new Set(['review', 'fix-pr', 'pr-review']);

/** Triggers whose starts come again by themselves after a refusal: auto-start and a chase. */
const AGAIN = new Set(['auto', 'chase', 'chase-fix', 'road-captain']);

/**
 * Whether started run `run` still holds task `task`: open, claimed by it, and (unless it works on a pull request)
 * not in review. The same rule as the store's runningAgents, without its 12-hour cut-off.
 * @param {{ agent: string, kind?: string | null }} run
 * @param {{ status: string, claim?: string | null, github?: Array<{ closes?: boolean, state?: string }> }} task
 */
export function holdsTask(run, task) {
  if (task?.status !== 'pending' || task.claim !== run.agent) return false;
  if (ON_PR.has(run.kind ?? '')) return true;
  return !task.github?.some((p) => p.closes && p.state === 'open');
}

/**
 * @typedef {object} RunFacts
 * @property {string} status starting, started, or failed
 * @property {number} started when it was fired, in ms
 * @property {string | null} [trigger]
 * @property {string | null} [error] why Claude wouldn't start it
 * @property {string | null} [hold] how Claude's refusal held the routine: paused, limit, or backoff (BRK-144)
 * @property {number | null} [holdUntil] when a limit or backoff ends, in ms
 * @property {number | null} [silent] Silent since, in ms (BRK-145)
 */

/**
 * The state of a run, or null when there's nothing to say about it (it finished its part).
 * `id` is one of starting, working, quiet, silent, retrying, paused, failed (Couldn't start), needs-you, or ended.
 * @param {object} facts
 * @param {RunFacts} facts.run
 * @param {boolean} facts.holding the run still holds its task (holdsTask)
 * @param {number | null} [facts.lastAt] when the session last said something, in ms
 * @param {boolean} [facts.paused] the run's repository's routine is still paused after Claude refused it
 * @param {boolean} [facts.autostart] the task starts an agent by itself when it's ready
 * @param {{ kind: 'fix', pr: number, tries: number, at: number } | { kind: 'ping', id: number, message: string, at: number } | null} [facts.needsYou]
 * @param {number} [now]
 */
export function runState(
  { run, holding, lastAt = null, paused = false, autostart = false, needsYou = null },
  now = Date.now(),
) {
  const iso = (/** @type {number | null | undefined} */ ms) => (ms ? new Date(ms).toISOString() : null);
  // A ping, or a pull request two fix agents didn't get green, is the owner's call whatever the run does.
  if (needsYou) {
    return needsYou.kind === 'fix'
      ? { id: 'needs-you', since: iso(needsYou.at), fix: { pr: needsYou.pr, tries: needsYou.tries } }
      : { id: 'needs-you', since: iso(needsYou.at), ping: { id: needsYou.id, message: needsYou.message } };
  }
  const again = autostart || AGAIN.has(run.trigger ?? '');
  if (run.status === 'failed') {
    if (run.hold === 'limit' && run.holdUntil && run.holdUntil > now)
      return { id: 'retrying', until: iso(run.holdUntil), again };
    if (run.hold === 'paused' && paused) return { id: 'paused', error: run.error ?? null };
    // Any other refusal: auto-start and chase try again after a few minutes; by hand, Try again.
    const until = run.hold === 'backoff' && again && run.holdUntil && run.holdUntil > now ? iso(run.holdUntil) : null;
    return { id: 'failed', error: run.error ?? null, until, again };
  }
  if (run.status === 'starting') return { id: 'starting', since: iso(run.started), late: false };
  if (!holding) return { id: 'ended' };
  if (run.silent) return { id: 'silent', since: iso(run.silent) };
  if (lastAt && now - lastAt < LIVE_MS) return { id: 'working', since: iso(lastAt) };
  if (lastAt) return { id: 'quiet', since: iso(lastAt) };
  return { id: 'starting', since: iso(run.started), late: now - run.started > LATE_MS };
}
