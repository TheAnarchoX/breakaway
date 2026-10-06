/**
 * TaskStore's incidents (docs/specs/IDEA-19-architect.md, "Incidents"; BRK-197): it hears the signals stream
 * (BRK-190) through `signalSubscribers`, and a fresh signal that crosses the rule (src/infra-incidents.js) in an
 * environment the board knows opens an incident: a task tagged +incident in the environment's repository, with the
 * signal and the inventory's view of the resource, and an inbox entry that pushes for production and is quiet
 * otherwise. One incident is open per environment, resource, and kind: a repeat comments on it (counted, so a noisy
 * signal can't flood the task) and never pushes again, and a signal below the rule notes the recovery once. Closing
 * the task closes the incident; the board never closes it by itself.
 *
 * An incident never starts an agent and has no autostart: a diagnosis agent starts only from a runbook the owner
 * turned on (src/store-infra-runbooks.js). A plan links to an incident by its source, `incident`, and its ref, the
 * task's work ID, and the incident's steps follow that plan. The API reads only.
 */
import { AgentError } from './store-agents.js';
import { planView } from './infra-plans.js';
import { signalSubscribers } from './store-infra-signals.js';
import {
  INCIDENT_FRESH_MS,
  INCIDENT_REPEAT_MS,
  crossesRule,
  incidentBrief,
  incidentKey,
  incidentSteps,
  incidentTitle,
  pushes,
} from './infra-incidents.js';

const SHOWN = 50;
const SHOWN_MAX = 200;
const ISO = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** A whole number from a query string, or an AgentError naming it. */
function whole(value, what, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AgentError(`${what} must be a whole number from ${min} to ${max}`, 400);
  return n;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraIncidentsMethods = {
  initInfraIncidents() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, repo TEXT NOT NULL,
        environment INTEGER NOT NULL, key TEXT NOT NULL, resource TEXT, kind TEXT NOT NULL, level TEXT NOT NULL,
        signal INTEGER NOT NULL, last_signal INTEGER NOT NULL, signals INTEGER NOT NULL DEFAULT 1,
        uncommented INTEGER NOT NULL DEFAULT 0, commented INTEGER NOT NULL,
        pushed INTEGER NOT NULL DEFAULT 0, recovered INTEGER, opened INTEGER NOT NULL, closed INTEGER
      );
      CREATE INDEX IF NOT EXISTS infra_incidents_open ON infra_incidents (environment, key, closed);
      CREATE INDEX IF NOT EXISTS infra_incidents_by_task ON infra_incidents (task);
      CREATE INDEX IF NOT EXISTS infra_incidents_by_repo ON infra_incidents (repo, id);
    `);
  },

  /** The environment a signal is in: by its ID, else by its name when only one environment has it; else null. */
  incidentEnvironment(signal) {
    if (signal.environmentId)
      return this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', signal.environmentId).toArray()[0] ?? null;
    const rows = this.sql.exec('SELECT * FROM infra_environments WHERE name = ?', signal.environment).toArray();
    return rows.length === 1 ? rows[0] : null;
  },

  /** What the inventory knows about a signal's resource, and how many resources lean on it. */
  incidentResource(environmentId, rid) {
    if (!rid) return { resource: null, dependents: 0 };
    const row = this.sql
      .exec(
        'SELECT rid, kind, name, health, health_text FROM infra_inventory WHERE environment = ? AND rid = ?',
        environmentId,
        rid,
      )
      .toArray()[0];
    if (!row) return { resource: null, dependents: 0 };
    const dependents = Number(
      this.sql
        .exec(
          'SELECT COUNT(DISTINCT from_rid) AS n FROM infra_inventory_relations WHERE environment = ? AND to_rid = ?',
          environmentId,
          rid,
        )
        .one().n,
    );
    return {
      resource: {
        id: row.rid,
        kind: row.kind,
        name: row.name,
        health: row.health ?? null,
        healthText: row.health_text ?? null,
      },
      dependents,
    };
  },

  /** The open incident for an environment and key, closing it first if its task was finished or deleted. */
  openIncident(environmentId, key, now) {
    const row = this.sql
      .exec(
        'SELECT * FROM infra_incidents WHERE environment = ? AND key = ? AND closed IS NULL ORDER BY id DESC LIMIT 1',
        environmentId,
        key,
      )
      .toArray()[0];
    if (!row) return null;
    if (this.tasks.get(row.task)?.status === 'pending') return row;
    this.sql.exec('UPDATE infra_incidents SET closed = ? WHERE id = ?', now, row.id);
    return null;
  },

  /**
   * The signals stream's subscriber: each fresh signal that crosses the rule opens an incident or comments on the
   * open one, and one below the rule notes an open incident's recovery once. Returns what it did, for tests.
   * @param {import('./store-infra-signals.js').StoredSignal[]} signals oldest first
   */
  async incidentSignals(signals, now = Date.now()) {
    const opened = [];
    const repeated = [];
    const recovered = [];
    for (const signal of signals) {
      const at = Date.parse(signal.at);
      if (now - at > INCIDENT_FRESH_MS) continue;
      const env = this.incidentEnvironment(signal);
      if (!env) continue; // an environment the board doesn't know has no repository to own the incident
      const key = incidentKey(Number(env.id), signal);
      const open = this.openIncident(Number(env.id), key, now);
      if (!crossesRule(signal.level)) {
        if (!open || (open.recovered && open.recovered >= open.last_signal)) continue;
        if (at < Number(open.last_signal)) continue;
        this.sql.exec('UPDATE infra_incidents SET recovered = ? WHERE id = ?', at, open.id);
        this.change(open.task, {
          annotate: `Signal: ${signal.kind} is ${signal.level} again in ${signal.environment} (${signal.at}): ${signal.text}. Verify it holds, then write up what happened and close this task.`,
          by: 'board',
        });
        recovered.push(open.id);
        continue;
      }
      if (open) {
        const quiet = now - Number(open.commented) < INCIDENT_REPEAT_MS;
        this.sql.exec(
          'UPDATE infra_incidents SET last_signal = ?, signals = signals + 1, level = ?, recovered = NULL, uncommented = ?, commented = ? WHERE id = ?',
          at,
          signal.level,
          quiet ? Number(open.uncommented) + 1 : 0,
          quiet ? Number(open.commented) : now,
          open.id,
        );
        if (!quiet) {
          const more = Number(open.uncommented);
          this.change(open.task, {
            annotate: `Signal again: ${signal.kind}, ${signal.level}, in ${signal.environment} (${signal.at}): ${signal.text}${more ? ` (and ${more} more since the last comment)` : ''}.`,
            by: 'board',
          });
        }
        repeated.push(open.id);
        continue;
      }
      try {
        opened.push(await this.openNewIncident(env, key, signal, now));
      } catch (error) {
        // One that can't be opened (the repository is gone, the history can't be written) never stops the next.
        console.error(`incident for signal ${signal.id} not opened: ${error.message}`);
      }
    }
    return { opened, repeated, recovered };
  },

  /** Makes an incident's task and row, and puts it in the inbox: pushed for production, quiet otherwise. */
  async openNewIncident(env, key, signal, now) {
    const { resource, dependents } = this.incidentResource(Number(env.id), signal.resource);
    const production = pushes(env);
    const res = await this.create([
      {
        description: incidentTitle(signal, resource),
        project: this.boardArea(env.repo),
        repo: env.repo,
        horizon: 'now',
        priority: production ? 'H' : 'M',
        tags: ['incident'],
        by: 'board',
        brief: incidentBrief(signal, { name: env.name, environmentKind: env.kind, resource, dependents }),
        done_when:
          'The cause is fixed through an approved plan or a pull request, the signals show health is back, and a write-up with a task for each follow-up is on this task.',
      },
    ]);
    if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make the incident’s task', res.status);
    const uuid = res.body.tasks[0].uuid;
    const id = this.sql
      .exec(
        'INSERT INTO infra_incidents (task, repo, environment, key, resource, kind, level, signal, last_signal, commented, pushed, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        uuid,
        env.repo,
        Number(env.id),
        key,
        signal.resource ?? null,
        signal.kind,
        signal.level,
        signal.id,
        Date.parse(signal.at),
        now,
        production ? 1 : 0,
        now,
      )
      .one().id;
    const wid = this.tasks.get(uuid)?.wid ?? 'An incident';
    await this.boardPing(
      uuid,
      'incident',
      `${signal.kind}, ${signal.level}, in ${env.name}${production ? ' (production)' : ''}: ${String(signal.text).replace(/[.!?]+$/u, '')}. ${wid} has the steps: diagnose, propose a plan, approve, apply, verify.`,
      { quiet: !production },
    );
    return Number(id);
  },

  /** The plans linked to an incident's task, newest first: source `incident`, ref its work ID. */
  incidentPlans(wid) {
    if (!wid) return [];
    return this.sql
      .exec(
        "SELECT p.*, e.name AS env_name FROM infra_plans p JOIN infra_environments e ON e.id = p.environment WHERE p.source = 'incident' AND p.ref = ? ORDER BY p.n DESC",
        wid,
      )
      .toArray()
      .map((row) => planView(row, { full: false }));
  },

  /** An incident as the API shows it, with its task, its steps, and its linked plans. */
  incidentView(row) {
    const map = this.tasks.get(row.task);
    const env = this.sql.exec('SELECT name, kind FROM infra_environments WHERE id = ?', row.environment).toArray()[0];
    const closed = row.closed !== null || map?.status !== 'pending';
    const plans = this.incidentPlans(map?.wid);
    const plan = plans.find((p) => p.state !== 'rejected') ?? plans[0] ?? null;
    const recovered = row.recovered && Number(row.recovered) >= Number(row.last_signal) ? ISO(row.recovered) : null;
    return {
      id: Number(row.id),
      task: map ? { uuid: row.task, wid: map.wid ?? null, description: map.description, status: map.status } : null,
      repo: row.repo,
      environment: env?.name ?? null,
      environmentId: Number(row.environment),
      environmentKind: env?.kind ?? null,
      resource: row.resource ?? null,
      kind: row.kind,
      level: row.level,
      signal: Number(row.signal),
      signals: Number(row.signals),
      pushed: Boolean(row.pushed),
      opened: ISO(row.opened),
      lastSignal: ISO(row.last_signal),
      recovered,
      closed: closed ? (ISO(row.closed) ?? true) : null,
      steps: incidentSteps({
        plan: plan ? { state: plan.state, updated: plan.updated } : null,
        recovered,
        closed,
      }),
      plans,
    };
  },

  /** The incident whose task this is, or null: `show` and the task's page carry it. */
  incidentOfTask(uuid) {
    const row = this.sql
      .exec('SELECT * FROM infra_incidents WHERE task = ? ORDER BY id DESC LIMIT 1', uuid)
      .toArray()[0];
    return row ? this.incidentView(row) : null;
  },

  /**
   * GET /api/infra/incidents: incidents newest first, filtered by repository, environment (its ID or name), and
   * whether they're open, paged with `before` (an incident's id). Read only.
   */
  incidentsApi(query = {}) {
    return this.run(async () => {
      const where = [];
      const args = [];
      const repo = query.repo ? String(query.repo).trim().toLowerCase() : null;
      if (repo) {
        where.push('repo = ?');
        args.push(repo);
      }
      if (query.environment) {
        where.push('environment = ?');
        args.push(this.environmentRow(query.environment, repo).id);
      }
      if (
        query.open !== undefined &&
        query.open !== null &&
        query.open !== '' &&
        !['true', 'false'].includes(String(query.open))
      )
        throw new AgentError('open must be true or false', 400);
      const open =
        query.open === undefined || query.open === null || query.open === '' ? null : String(query.open) === 'true';
      const limit = whole(query.limit, 'limit', 1, SHOWN_MAX) ?? SHOWN;
      const incidents = [];
      let more = false;
      // Open is the task's state, so it's filtered after reading: a page reads on until it's full or the rows run out.
      let cursor = whole(query.before, 'before', 1, Number.MAX_SAFE_INTEGER);
      for (;;) {
        const clauses = cursor === null ? where : [...where, 'id < ?'];
        const page = this.sql
          .exec(
            `SELECT * FROM infra_incidents ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
            ...args,
            ...(cursor === null ? [] : [cursor]),
            SHOWN_MAX,
          )
          .toArray();
        for (const row of page) {
          const view = this.incidentView(row);
          if (open !== null && (view.closed === null) !== open) continue;
          if (incidents.length === limit) {
            more = true;
            break;
          }
          incidents.push(view);
        }
        if (more || page.length < SHOWN_MAX) break;
        cursor = Number(page[page.length - 1].id);
      }
      return { status: 200, body: { incidents, more } };
    });
  },

  /** GET /api/infra/incidents/<id>: one incident, by its id or its task's work ID. Read only. */
  incidentApi(ref) {
    return this.run(async () => {
      const text = String(ref ?? '').trim();
      let row = null;
      if (/^\d{1,15}$/u.test(text))
        row = this.sql.exec('SELECT * FROM infra_incidents WHERE id = ?', Number(text)).toArray()[0];
      else {
        const uuid = [...this.tasks].find(([, m]) => m.wid === text.toUpperCase())?.[0];
        if (uuid)
          row = this.sql
            .exec('SELECT * FROM infra_incidents WHERE task = ? ORDER BY id DESC LIMIT 1', uuid)
            .toArray()[0];
      }
      if (!row) throw new AgentError(`no incident ${text.slice(0, 40)}`, 404);
      return { status: 200, body: { incident: this.incidentView(row) } };
    });
  },
};

// Incidents hear every batch the stream stores.
signalSubscribers.subscribe('incidents', (store, signals) => store.incidentSignals(signals));
