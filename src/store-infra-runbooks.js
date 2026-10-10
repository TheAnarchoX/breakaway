/**
 * TaskStore's runbooks (docs/specs/IDEA-19-architect.md, "Runbooks"; BRK-196): a signal trigger on a routine, next
 * to its schedule, GitHub events, and webhooks. It hears the signals stream (BRK-190) through `signalSubscribers`,
 * and a signal that matches an owner-turned-on trigger is delivered the way a GitHub event is: noted on the routine's
 * open run, or a new run under the routine's own caps and gap, which starts the agent only when the trigger says auto.
 * Each run gets only the allowlisted fields (src/infra-runbooks.js), and a duplicate within RUNBOOK_DEDUPE_MS does
 * nothing at all.
 *
 * Turning a trigger on, changing it, and removing it are the owner's alone: from the signed-in web board
 * (src/worker.js), with an agent's `by` refused here as a second line. A routine maker never makes one (BRK-172:
 * only runbooks the owner turns on, one by one).
 */
import { AgentError } from './store-agents.js';
import { triggerComment } from './store-routines.js';
import { signalSubscribers } from './store-infra-signals.js';
import {
  RUNBOOK_DEDUPE_MS,
  RUNBOOK_FRESH_MS,
  runbookData,
  signalKey,
  signalMatches,
  signalTrigger,
} from './infra-runbooks.js';

const DAY_MS = 86_400_000;

const READ_ONLY =
  'This is a signal from Architect. Read only: diagnose, note what you find on the task, and propose any change by pull request; never change infrastructure or production yourself. The one change this run may ask for is a scale or restart, with `npx breakaway infra act <environment> <resource> scale <n>|restart` and BREAKAWAY_ACT_KEY set to the Act key in the run’s payload (a secret: never write it anywhere else): it applies only inside the envelope the owner approved, and otherwise waits for the owner.';

/** @returns {import('./infra-runbooks.js').SignalTrigger} */
function triggerOf(row) {
  return {
    environments: JSON.parse(row.environments),
    resourceKinds: JSON.parse(row.resource_kinds),
    kinds: JSON.parse(row.kinds),
    level: row.level,
    on: Boolean(row.enabled),
    start: row.start,
  };
}

/** What Activity says changed, in a few words. */
function describeTrigger(t) {
  const any = (list, what) => (list.length ? list.join(', ') : `any ${what}`);
  return `${t.on ? 'on' : 'off'}, ${t.start === 'auto' ? 'starts by itself' : 'waits for your Start'}, ${t.level} and up, ${any(t.kinds, 'kind')}, in ${any(t.environments, 'environment')}, ${any(t.resourceKinds, 'resource kind')}`;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraRunbooksMethods = {
  initInfraRunbooks() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_runbooks (
        slug TEXT PRIMARY KEY, environments TEXT NOT NULL, resource_kinds TEXT NOT NULL, kinds TEXT NOT NULL,
        level TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, start TEXT NOT NULL DEFAULT 'wait',
        edited_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS infra_runbook_seen (
        slug TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, key)
      );
    `);
  },

  /** A routine's signal trigger, or null when it has none. */
  runbookOf(slug) {
    const row = this.sql.exec('SELECT * FROM infra_runbooks WHERE slug = ?', slug).toArray()[0];
    return row ? triggerOf(row) : null;
  },

  /**
   * Adds or changes a routine's signal trigger. The owner's only: an agent's `by` is refused. A new one is off and
   * waits until the owner says otherwise.
   * @param {string} slug
   * @param {Record<string, unknown>} input
   */
  setRunbook(slug, input) {
    const words = 'only the owner adds, changes, or turns on a routine’s signal trigger';
    if (this.actorIn(input).agent) this.allow(input, 'runbook.trigger', null, words);
    const routine = this.routineRow(slug);
    this.allow(input, 'runbook.trigger', this.routineRepo(routine.repo), words);
    const t = signalTrigger(input, this.runbookOf(routine.slug) ?? undefined);
    this.sql.exec(
      'INSERT OR REPLACE INTO infra_runbooks (slug, environments, resource_kinds, kinds, level, enabled, start, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      routine.slug,
      JSON.stringify(t.environments),
      JSON.stringify(t.resourceKinds),
      JSON.stringify(t.kinds),
      t.level,
      t.on ? 1 : 0,
      t.start,
      Date.now(),
    );
    this.routineEvent(routine.slug, 'runbook_changed', { detail: describeTrigger(t) });
    return { slug: routine.slug, signal: t };
  },

  /** Removes a routine's signal trigger. The owner's only. */
  removeRunbook(slug, input) {
    const words = 'only the owner removes a routine’s signal trigger';
    if (this.actorIn(input).agent) this.allow(input, 'runbook.trigger', null, words);
    const routine = this.routineRow(slug);
    this.allow(input, 'runbook.trigger', this.routineRepo(routine.repo), words);
    const gone = this.sql.exec('DELETE FROM infra_runbooks WHERE slug = ? RETURNING slug', routine.slug).toArray();
    if (!gone.length) throw new AgentError(`“${routine.name}” has no signal trigger`, 404);
    this.sql.exec('DELETE FROM infra_runbook_seen WHERE slug = ?', routine.slug);
    this.routineEvent(routine.slug, 'runbook_changed', { detail: 'removed' });
    return { slug: routine.slug, signal: null };
  },

  /** Every runbook: its routine and its signal trigger. */
  runbooks() {
    return this.sql
      .exec('SELECT b.*, r.name, r.repo FROM infra_runbooks b JOIN routines r ON r.slug = b.slug ORDER BY r.name')
      .toArray()
      .map((row) => ({
        slug: row.slug,
        name: row.name,
        repo: row.repo || this.defaultRepoSlug(),
        signal: triggerOf(row),
      }));
  },

  /** The repository an environment belongs to, by its ID or, without one, its name in `repo`; null when unknown. */
  runbookEnvironmentRepo(signal, repo) {
    const row = signal.environmentId
      ? this.sql.exec('SELECT repo FROM infra_environments WHERE id = ?', signal.environmentId).toArray()[0]
      : this.sql
          .exec('SELECT repo FROM infra_environments WHERE repo = ? AND name = ?', repo, signal.environment)
          .toArray()[0];
    return row?.repo ?? null;
  },

  /** The kind of the resource a signal names, from the inventory, or null. */
  runbookResourceKind(signal, repo) {
    if (!signal.resource) return null;
    const id =
      signal.environmentId ??
      this.sql
        .exec('SELECT id FROM infra_environments WHERE repo = ? AND name = ?', repo, signal.environment)
        .toArray()[0]?.id;
    if (!id) return null;
    return (
      this.sql
        .exec('SELECT kind FROM infra_inventory WHERE environment = ? AND rid = ?', id, signal.resource)
        .toArray()[0]?.kind ?? null
    );
  },

  /**
   * The signals stream's subscriber: offers each new signal to every runbook that's on, in the routine's own
   * repository's environments only. A match is delivered once per key within RUNBOOK_DEDUPE_MS, under the routine's
   * caps; a refusal is logged in Activity and never stops the next signal or runbook.
   * @param {import('./store-infra-signals.js').StoredSignal[]} signals oldest first
   */
  async runbookSignals(signals, now = Date.now()) {
    const rows = this.sql
      .exec(
        'SELECT b.*, r.enabled AS routine_on FROM infra_runbooks b JOIN routines r ON r.slug = b.slug WHERE b.enabled = 1',
      )
      .toArray();
    const started = [];
    if (!rows.length) return { started };
    for (const book of rows) {
      if (!book.routine_on) continue; // a routine that's off starts nothing, so its runbook doesn't either
      const trigger = triggerOf(book);
      const routine = this.routineRow(book.slug);
      const repo = routine.repo || this.defaultRepoSlug();
      for (const signal of signals) {
        if (now - Date.parse(signal.at) > RUNBOOK_FRESH_MS) continue;
        if (this.runbookEnvironmentRepo(signal, repo) !== repo) continue;
        const resourceKind = this.runbookResourceKind(signal, repo);
        if (!signalMatches(trigger, signal, resourceKind)) continue;
        const key = signalKey(signal);
        const seen = this.sql
          .exec('SELECT at FROM infra_runbook_seen WHERE slug = ? AND key = ?', book.slug, key)
          .toArray()[0];
        if (seen && now - seen.at < RUNBOOK_DEDUPE_MS) continue; // a duplicate
        this.sql.exec(
          'INSERT OR REPLACE INTO infra_runbook_seen (slug, key, at) VALUES (?, ?, ?)',
          book.slug,
          key,
          now,
        );
        const label = `Signal: ${signal.kind}, ${signal.level}, in ${signal.environment}`;
        const refuse = (message, status) => {
          this.routineEvent(routine.slug, 'trigger_refused', { detail: `${label}: ${message}` });
          throw new AgentError(message, status);
        };
        try {
          const comment = `${triggerComment(label, { data: runbookData(signal, resourceKind) })}\n\n${READ_ONLY}`;
          const result = await this.deliverTrigger(
            this.routineRow(book.slug),
            label,
            comment,
            'signal',
            refuse,
            trigger.start === 'auto',
          );
          started.push({ routine: routine.slug, signal: signal.id, ...result });
        } catch {
          /* refused and logged */
        }
      }
    }
    this.sql.exec('DELETE FROM infra_runbook_seen WHERE at < ?', now - 30 * DAY_MS);
    return { started };
  },

  /** GET /api/infra/runbooks: every routine with a signal trigger. */
  runbooksApi() {
    return this.run(async () => ({ status: 200, body: { runbooks: this.runbooks() } }));
  },

  /** PUT /api/infra/runbooks/<slug>: the owner adds or changes one, from the signed-in web board. */
  runbookSetApi(slug, body) {
    return this.run(async () => ({ status: 200, body: this.setRunbook(slug, body ?? {}) }));
  },

  /** DELETE /api/infra/runbooks/<slug>: the owner removes one, from the signed-in web board. */
  runbookRemoveApi(slug, body) {
    return this.run(async () => ({ status: 200, body: this.removeRunbook(slug, body ?? {}) }));
  },
};

// Runbooks hear every batch the stream stores.
signalSubscribers.subscribe('runbooks', (store, signals) => store.runbookSignals(signals));
