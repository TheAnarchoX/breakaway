/**
 * TaskStore's lapse of silent task claims (docs/specs/IDEA-55-footprints.md, section 1c): an agent's claim on a task
 * with no open pull request is given back after LAPSE_MS without a heartbeat, and a person's claim is marked stale for
 * the owner after STALE_MS without a change. Both are steps of the footprints sweep (FOOTPRINT_SWEEP), not an alarm of
 * their own, and both read the one heartbeat BRK-318 keeps (lastHeartbeat). Claiming stays atomic: a lapse is the
 * board releasing for a holder that's gone, and an agent that comes back finds the task released and claims it again.
 */
import { commentsOf } from './model.js';

/**
 * How long an agent's claim lives without a heartbeat, when it has no open pull request. Releasing a task costs more
 * than freeing a path (LEASE_MS is 10 minutes), so this leaves room for a long test run and a cloud session's idle
 * pause. Checked against this session's own log: see the BRK-321 pull request.
 */
export const LAPSE_MS = 60 * 60_000;
/** How long a person's claim goes without a change on the task before the owner sees it marked stale. */
export const STALE_MS = 3 * 86_400_000;

/** An agent's name, as the board starts them and as `claude-<branch>` names a local one: its claims lapse. */
const AGENT_CLAIM = /^(claude|codex)-/u;
const NOT_PUSHED = /^\s*not pushed:\s*([^\s,]+)/iu;

/** `14:20 UTC on 9 Oct 2026`, the way the board writes a time in a comment. */
function when(ms) {
  const d = new Date(ms);
  const time = d.toISOString().slice(11, 16);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${time} UTC on ${date}`;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const claimLapseMethods = {
  initClaimLapse() {
    // One mark per person's claim (task, holder, and when it started), so the owner hears about it once.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS claim_stale (uuid TEXT NOT NULL, claim TEXT NOT NULL, start INTEGER NOT NULL, ping INTEGER, at INTEGER NOT NULL, PRIMARY KEY (uuid, claim, start))',
    );
  },

  /**
   * When task `map`'s holder last showed it was there (ms): its last heartbeat while it held the task, else when it
   * claimed it. A heartbeat from an earlier holder, or from before this claim started, doesn't count.
   * @param {string} uuid
   * @param {any} map
   */
  claimActiveAt(uuid, map) {
    const start = Number(map.start ?? 0) * 1000;
    const beat = this.lastHeartbeat(uuid);
    return beat && beat.agent === map.claim && beat.at >= start ? beat.at : start;
  },

  /**
   * Whether task `map` has a pull request that holds its claim: one that closes it and is open, or the one in its
   * `pr` field while the board hasn't seen it closed yet (a pull request just opened, before GitHub's next sync).
   * @param {any} map
   * @param {any} links githubLinks(), read once a sweep
   */
  claimHeldByPull(map, links) {
    const pulls = this.githubFor(map, links);
    if (pulls.some((p) => p.closes && p.state === 'open')) return true;
    if (!map.pr || !/^\d+$/u.test(String(map.pr))) return false;
    return !pulls.some((p) => p.number === Number(map.pr) && p.state !== 'open');
  },

  /** The branch an agent pushed for task `map`, if the board knows one: its `Not pushed:` handover's, or a pull request's. */
  claimBranch(map, links) {
    const since = Number(map.start ?? 0) * 1000;
    const handover = commentsOf(map)
      .filter((c) => Date.parse(c.at) >= since)
      .map((c) => NOT_PUSHED.exec(c.text)?.[1])
      .filter(Boolean)
      .at(-1);
    const pulled = this.githubFor(map, links).find((p) => p.closes && typeof p.branch === 'string' && p.branch);
    return { handover: Boolean(handover), branch: handover ?? pulled?.branch ?? null };
  },

  /**
   * A sweep step: every agent's claim with no open pull request and no heartbeat for LAPSE_MS is released, with a
   * comment that says who went silent when, and the task is ready again. A person's claim, and a claim a pull request
   * holds, are left as they are. While GitHub or Claude reports trouble nothing lapses: an agent may be waiting on it.
   */
  lapseSilentClaims(now = Date.now()) {
    if (this.githubOutage() || this.claudeOutage()) return;
    /** @type {any} */
    let links = null;
    for (const [uuid, map] of this.tasks) {
      if (map.status !== 'pending' || !map.claim || !AGENT_CLAIM.test(map.claim)) continue;
      const active = this.claimActiveAt(uuid, map);
      if (now - active < LAPSE_MS) continue;
      links ??= this.githubLinks();
      if (this.claimHeldByPull(map, links)) continue;
      const { handover, branch } = this.claimBranch(map, links);
      const words = [
        `Lapsed: ${map.claim} silent since ${when(active)}, with no open pull request, so the board released ${map.wid ?? 'the task'} and it's ready to start again.`,
        branch ? `Its branch: ${branch}.` : null,
        handover ? 'Read its Not pushed handover above before you pick it up.' : null,
      ].filter(Boolean);
      this.change(uuid, { claim: null, start: false, annotate: words.join(' '), by: 'board' });
    }
  },

  /**
   * A sweep step: a person's claim with no change on the task for STALE_MS is marked stale for the owner, once a claim:
   * a quiet ping in their inbox, with no push and no comment, so the task's own last change still shows its age. The
   * claim stays: the owner asks the person, or releases it.
   */
  markStaleClaims(now = Date.now()) {
    for (const [uuid, map] of this.tasks) {
      if (map.status !== 'pending' || !map.claim || AGENT_CLAIM.test(map.claim)) continue;
      const start = Number(map.start ?? 0);
      const last = Math.max(Number(map.modified ?? 0), start) * 1000;
      if (now - last < STALE_MS) continue;
      const marked = this.sql
        .exec('SELECT 1 FROM claim_stale WHERE uuid = ? AND claim = ? AND start = ?', uuid, map.claim, start)
        .toArray();
      if (marked.length) continue;
      const days = Math.floor((now - last) / 86_400_000);
      const message = `${map.claim} has held ${map.wid ?? 'this task'} for ${days} days with no change on it. The board leaves the claim as it is: ask them, or release it from the task.`;
      const ping = this.sql
        .exec(
          "INSERT INTO pings (task, kind, message, agent, created, quiet) VALUES (?, 'stale', ?, 'board', ?, 1) RETURNING id",
          uuid,
          message,
          now,
        )
        .one().id;
      this.sql.exec(
        'INSERT INTO claim_stale (uuid, claim, start, ping, at) VALUES (?, ?, ?, ?, ?)',
        uuid,
        map.claim,
        start,
        ping,
        now,
      );
    }
    // Marks of claims that ended are no use: a new claim of the same task starts its own count.
    for (const row of this.sql.exec('SELECT uuid, claim, start FROM claim_stale').toArray()) {
      const map = this.tasks.get(row.uuid);
      if (map?.status !== 'pending' || map.claim !== row.claim || Number(map.start ?? 0) !== Number(row.start))
        this.sql.exec(
          'DELETE FROM claim_stale WHERE uuid = ? AND claim = ? AND start = ?',
          row.uuid,
          row.claim,
          row.start,
        );
    }
  },
};
