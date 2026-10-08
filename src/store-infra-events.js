/**
 * TaskStore's infrastructure triggers for routines (BRK-293): Architect's stores say what happened with
 * `infraEvent` (a plan waits, applies, fails, or is rolled back; drift is found; a change is proposed or merges; a
 * deploy or promote lands; an environment is added or removed; an inventory goes stale; a budget passes a share; an
 * envelope's restarts are used up; an incident opens), and each routine that listens for it gets the event the way a
 * GitHub event reaches it: noted on its open run, or a new run under its own caps and gap, which starts the agent only
 * when the routine says auto. Runbooks (store-infra-runbooks.js) stay as they are; this is the general form.
 *
 * `infraEvent` is synchronous, so a store calls it inside its own transaction: the event is queued only if the write
 * that caused it is kept. Delivery follows on its own, right after, and the cron delivers whatever is still queued.
 * A routine hears only its own repository's events, each once per thing within INFRA_EVENT_DEDUPE_MS, and never an
 * event its own run caused (the pull request a run opened, or a run's work ID on the plan), so it can't loop.
 */
import { AgentError } from './store-agents.js';
import { triggerComment } from './store-routines.js';
import {
  INFRA_EVENTS,
  INFRA_EVENT_DEDUPE_MS,
  INFRA_EVENT_FRESH_MS,
  infraEventData,
  infraEventMatches,
  infraEventOf,
  keptInfraEvents,
} from './infra-events.js';

const DAY_MS = 86_400_000;
/** A queued event a delivery took but didn't finish (the object went away) is taken again after this long. */
const RETAKE_MS = 10 * 60_000;

const READ_ONLY =
  'This is an event from Architect. Read only: look into it, note what you find on the task, and propose any change by pull request; never change infrastructure or production yourself.';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraEventsMethods = {
  initInfraEvents() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, taken INTEGER
      );
      CREATE TABLE IF NOT EXISTS infra_event_seen (
        slug TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, key)
      );
      CREATE TABLE IF NOT EXISTS infra_event_budget (
        environment INTEGER NOT NULL, month TEXT NOT NULL, used REAL NOT NULL, PRIMARY KEY (environment, month)
      );
    `);
  },

  /** Whether any routine listens for infrastructure events: with none, nothing is queued. */
  infraEventsHeard() {
    return this.sql.exec("SELECT 1 FROM routines WHERE infra_events NOT IN ('', '[]') LIMIT 1").toArray().length > 0;
  },

  /**
   * Says what happened, for Architect's stores to call where it happens, inside their transaction. Queues it when a
   * routine listens, and delivers it right after the caller's synchronous work.
   * @param {string} key one of INFRA_EVENTS
   * @param {{ repo: string, name: string, kind?: string | null }} env the environment's row
   * @param {Parameters<typeof infraEventOf>[2]} [what]
   */
  infraEvent(key, env, what = {}) {
    if (!this.infraEventsHeard()) return;
    const event = infraEventOf(key, env, what);
    this.sql.exec('INSERT INTO infra_events (at, event) VALUES (?, ?)', Date.now(), JSON.stringify(event));
    queueMicrotask(() => {
      this.flushInfraEvents().catch((/** @type {any} */ error) =>
        console.error(`infrastructure events weren’t delivered: ${error.message}`),
      );
    });
  },

  /** An environment's kind by its ID, for an event a store says without the row at hand; null once it's gone. */
  infraEnvironmentKind(id) {
    return this.sql.exec('SELECT kind FROM infra_environments WHERE id = ?', Number(id)).toArray()[0]?.kind ?? null;
  },

  /** Delivers what's queued, one delivery at a time; resolves when everything queued so far is through. */
  flushInfraEvents(now) {
    this.infraEventsFlushing = (this.infraEventsFlushing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliverInfraEvents(now));
    return this.infraEventsFlushing;
  },

  /**
   * Offers each queued event to every routine that listens for it, in the routine's own repository only. A refusal
   * (caps, the gap, the board's limits) is logged in Activity and never stops the next event or routine.
   * @param {number} [now]
   */
  async deliverInfraEvents(now = Date.now()) {
    this.sql.exec('DELETE FROM infra_events WHERE at < ?', now - INFRA_EVENT_FRESH_MS);
    const rows = this.sql
      .exec(
        'UPDATE infra_events SET taken = ? WHERE taken IS NULL OR taken < ? RETURNING id, event',
        now,
        now - RETAKE_MS,
      )
      .toArray()
      .sort((a, b) => Number(a.id) - Number(b.id));
    const started = [];
    if (!rows.length) return { started };
    const routines = this.sql.exec("SELECT * FROM routines WHERE infra_events NOT IN ('', '[]')").toArray();
    for (const row of rows) {
      /** @type {import('./infra-events.js').InfraEvent} */
      const event = JSON.parse(row.event);
      for (const routine of routines) {
        if (!routine.enabled) continue; // a routine that's off starts nothing
        if ((routine.repo || this.defaultRepoSlug()) !== event.repo) continue;
        const entry = keptInfraEvents(routine.infra_events).find((e) => infraEventMatches(e, event));
        if (!entry) continue;
        const key = entry.percent === undefined ? event.dedupe : `${event.dedupe}:${entry.percent}`;
        const seen = this.sql
          .exec('SELECT at FROM infra_event_seen WHERE slug = ? AND key = ?', routine.slug, key)
          .toArray()[0];
        if (seen && now - seen.at < INFRA_EVENT_DEDUPE_MS) continue; // a duplicate
        const label = `Infrastructure: ${INFRA_EVENTS[event.key]}, in ${event.environment}`;
        if (this.infraEventCausedBy(routine.slug, event)) {
          this.routineEvent(routine.slug, 'trigger_refused', {
            detail: `${label}: its own run caused it, so it doesn’t start again`,
          });
          continue;
        }
        this.sql.exec(
          'INSERT OR REPLACE INTO infra_event_seen (slug, key, at) VALUES (?, ?, ?)',
          routine.slug,
          key,
          now,
        );
        const refuse = (/** @type {string} */ message, /** @type {number} */ status) => {
          this.routineEvent(routine.slug, 'trigger_refused', { detail: `${label}: ${message}` });
          throw new AgentError(message, status);
        };
        try {
          const comment = `${triggerComment(label, { data: infraEventData(event) })}\n\n${READ_ONLY}`;
          const result = await this.deliverTrigger(this.routineRow(routine.slug), label, comment, 'infra', refuse);
          started.push({ routine: routine.slug, event: event.key, ...result });
        } catch {
          /* refused and logged */
        }
      }
      this.sql.exec('DELETE FROM infra_events WHERE id = ?', row.id);
    }
    this.sql.exec('DELETE FROM infra_event_seen WHERE at < ?', now - 30 * DAY_MS);
    return { started };
  },

  /**
   * Whether routine `slug`'s own run caused `event`: the pull request behind it closes one of the routine's runs, or
   * the work ID on it is one of them. Such an event never starts the routine again, so a routine can't loop.
   * @param {string} slug
   * @param {import('./infra-events.js').InfraEvent} event
   */
  infraEventCausedBy(slug, event) {
    const tasks = new Set();
    if (event.cause.wid) {
      for (const [uuid, map] of this.tasks) if (map.wid === event.cause.wid) tasks.add(uuid);
    }
    if (event.cause.pull) {
      const kept = this.sql
        .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', event.repo, event.cause.pull)
        .toArray()[0];
      const pr = kept ? JSON.parse(kept.data) : {};
      for (const uuid of this.closingTasks({
        closes: [],
        ...pr,
        number: event.cause.pull,
        repo: event.repo,
      }))
        tasks.add(uuid);
    }
    if (!tasks.size) return false;
    return (
      this.sql
        .exec(
          'SELECT 1 FROM routine_runs WHERE slug = ? AND task IN (SELECT value FROM json_each(?)) LIMIT 1',
          slug,
          JSON.stringify([...tasks]),
        )
        .toArray().length > 0
    );
  },

  /**
   * A month's share of its budget, for `budget.crossed`: called with each environment's total as costs are added up.
   * Says the event when the share moved up since the last look, with where it was, so a routine's own share decides.
   * @param {{ id: number, repo: string, name: string, kind: string }} env
   * @param {string} month
   * @param {number} used the share used, in percent
   */
  infraBudgetUsed(env, month, used) {
    if (!Number.isFinite(used)) return;
    const before = this.sql
      .exec('SELECT used FROM infra_event_budget WHERE environment = ? AND month = ?', env.id, month)
      .toArray()[0]?.used;
    this.sql.exec(
      `INSERT INTO infra_event_budget (environment, month, used) VALUES (?, ?, ?)
       ON CONFLICT (environment, month) DO UPDATE SET used = excluded.used`,
      env.id,
      month,
      used,
    );
    // Only this month's share is kept: a new month starts from nothing.
    this.sql.exec(
      'DELETE FROM infra_event_budget WHERE (environment = ? AND month != ?) OR environment NOT IN (SELECT id FROM infra_environments)',
      env.id,
      month,
    );
    if (before !== undefined && used <= Number(before)) return;
    this.infraEvent('budget.crossed', env, {
      fields: { used: Math.round(used), before: Math.round(Number(before ?? 0)) },
      dedupe: month,
    });
  },
};
