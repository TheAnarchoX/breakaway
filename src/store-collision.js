/**
 * TaskStore's one scheduling rule for every starter (docs/specs/IDEA-55-footprints.md, section 3): `collision(t,
 * beside)` says why a ready task waits for the agents running beside it and what the starter starts this tick, or
 * null. The chase (chaseQueue), auto-start (autostartQueue), and `agents next` (startNext) all ask it, and the owner's
 * Start asks it only to warn (startAgent's `warn`).
 *
 * - Two tasks whose footprints are both known (and trusted) wait for each other only when they overlap, whatever
 *   their area and whether or not they're related.
 * - When either footprint is unknown, or its repository's predictions aren't trusted, the starter's old rule holds:
 *   one agent per area outside a chase, never two related tasks in one area inside one.
 * - A security fix, a general agent, and a kickoff's run never wait for files; a general agent or a kickoff's run
 *   holds others only once it claims paths. Refine and review agents neither hold nor wait. A fix uses its pull
 *   request's files, which taskFootprint already prefers.
 * - An open pull request whose task no agent runs holds starts only with its files, and only while they hold
 *   (section 1: its head moved in the last day).
 *
 * How many agents per area is the starter's ceiling, not this rule: a chase's `parallel`, else Agents per area.
 */
import { isKickoffIdea } from './kickoff.js';
import { footprintsOverlap } from './footprint.js';

/** Agents on these runs change no code: they neither hold a task back nor count in an area. */
export const NO_FILES = new Set(['refine', 'review', 'pr-review']);

const label = (t) => t.wid ?? t.short ?? String(t.uuid ?? '').slice(0, 8);
const areaOf = (t) => `${t.repo}:${t.project}`;
const hasGlob = (p) => /[*?]|\/$/u.test(p);

/** Starts that never wait for files: a security fix, and what the owner pressed (a general agent, a kickoff's run). */
export function exemptFromFiles(t) {
  return Boolean(t.alert) || t.tags.includes('general') || isKickoffIdea(t);
}

export const collisionMethods = {
  /**
   * A cache for one pass of a starter: each repository's footprint context and each task's footprint, so a tick reads
   * them once however many tasks it weighs.
   */
  footprintBook() {
    return { contexts: new Map(), prints: new Map() };
  },

  /**
   * What `t`'s footprint holds for scheduling: `known` is false when it's unknown or its repository's predictions
   * aren't trusted, and `onlyActual` keeps just what the agent claimed, changed, or its pull request touches.
   * @param {any} t a task's view
   * @param {{ contexts: Map<string, any>, prints: Map<string, any> }} book
   * @param {{ onlyActual?: boolean }} [options]
   */
  schedulingFootprint(t, book, { onlyActual = false } = {}) {
    const key = `${t.uuid}:${onlyActual ? 'actual' : 'any'}`;
    if (book.prints.has(key)) return book.prints.get(key);
    if (!book.contexts.has(t.repo)) book.contexts.set(t.repo, this.footprintContext(t.repo));
    const context = book.contexts.get(t.repo);
    const print = this.taskFootprint(t.uuid, { context });
    const actual = print.kind === 'actual' || print.kind === 'claimed';
    const known = print.known && print.trusted && print.patterns.length > 0 && (!onlyActual || actual);
    const out = { known, patterns: known ? print.patterns : [], shared: context.shared, kind: print.kind };
    book.prints.set(key, out);
    return out;
  },

  /**
   * Why ready task `t` waits for one of `beside`, or null. `beside` is what runs and what this pass starts, each
   * `{ task, agent, kind, starting, review }`: `kind` is the run's (refine and review hold nothing), `starting` is set
   * for a start of this pass, and `review` for an open pull request no agent runs (it holds only with its files).
   * `chase` picks the fallback for unknown footprints: never two related tasks in one area, instead of one per area.
   * Answers `{ reason, why: 'files'|'area'|'related', task, agent, path }`, the path only for files.
   * @param {any} t
   * @param {any[]} beside
   * @param {{ chase?: boolean, book?: any }} [options]
   */
  collision(t, beside, { chase = false, book = null } = {}) {
    if (exemptFromFiles(t)) return null;
    book ??= this.footprintBook();
    let mine = null;
    // A fix mends a pull request that's already written: another one nobody runs doesn't hold it back.
    const fixing = Boolean(t.github?.some((p) => p.closes && p.state === 'open'));
    for (const b of beside) {
      const other = b.task;
      if (!other || other.uuid === t.uuid || other.repo !== t.repo || NO_FILES.has(b.kind)) continue;
      if (fixing && b.review) continue;
      mine ??= this.schedulingFootprint(t, book);
      // A general agent or a kickoff's run, and a pull request nobody runs, hold only with what they really touch.
      const actualOnly = Boolean(b.review) || exemptFromFiles(other);
      const theirs = this.schedulingFootprint(other, book, { onlyActual: actualOnly });
      if (mine.known && theirs.known) {
        const hit = footprintsOverlap(mine.patterns, theirs.patterns, { shared: mine.shared });
        if (!hit) continue;
        // Name the narrower of the two: the file, rather than the folder or glob it falls under.
        const path = hasGlob(hit.b) && !hasGlob(hit.a) ? hit.a : hit.b;
        const who = b.review
          ? `which ${label(other)}’s open pull request changes`
          : b.starting
            ? `which ${label(other)} starts on now`
            : `which ${label(other)} is changing${b.agent ? ` (${b.agent})` : ''}`;
        return {
          reason: `it would touch ${path}, ${who}`,
          why: 'files',
          task: label(other),
          agent: b.agent ?? null,
          path,
        };
      }
      if (actualOnly || !t.project || areaOf(other) !== areaOf(t)) continue;
      if (!chase) return { reason: null, why: 'area', task: label(other), agent: b.agent ?? null, path: null };
      if (t.related.includes(other.uuid) || other.related.includes(t.uuid))
        return { reason: null, why: 'related', task: label(other), agent: b.agent ?? null, path: null };
    }
    return null;
  },

  /**
   * What runs beside a starter's pass: the agents running now (with their run's kind) and, in each repository, the
   * open pull requests no agent runs, whose files may hold starts.
   * @param {any[]} views
   * @param {{ run: any, task: any }[]} running
   */
  besideNow(views, running) {
    const runs = new Set(running.map(({ task }) => task.uuid));
    const reviews = views
      .filter(
        (t) => t.status === 'pending' && !runs.has(t.uuid) && t.github?.some((p) => p.closes && p.state === 'open'),
      )
      .map((task) => ({ task, agent: null, kind: 'review-pull', review: true }));
    return [...running.map(({ run, task }) => ({ task, agent: run.agent, kind: run.kind })), ...reviews];
  },

  /** How many agents that change code run in `t`'s area among `beside` (a task's own run aside). */
  inAreaBeside(t, beside) {
    if (!t.project) return 0;
    return beside.filter(
      (b) =>
        !b.review &&
        !NO_FILES.has(b.kind) &&
        b.task.uuid !== t.uuid &&
        areaOf(b.task) === areaOf(t) &&
        // What the owner pressed (a general agent, a kickoff's run) has no area of its own to fill.
        (b.task.alert || !exemptFromFiles(b.task)),
    ).length;
  },
};
