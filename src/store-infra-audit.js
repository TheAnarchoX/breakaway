/**
 * TaskStore's infrastructure audit trail (docs/specs/IDEA-19-architect.md, "Audit trail"; BRK-175): every plan,
 * approval, apply, envelope action, lock release, break-glass, and freeze, appended once by the board's own control
 * plane and never edited. Who acted (the owner, the executor, an envelope, or the agent that proposed), what (the
 * plan, the environment, the outcome), and when. src/infra-audit.js checks and redacts each entry first.
 *
 * Append-only by construction: the store has no method that changes or removes an entry, the API reads only, and the
 * table's triggers refuse an UPDATE and a DELETE of an entry younger than a year. Retention's prune is the one path
 * that removes entries, and only those older than AUDIT_KEPT_DAYS.
 */
import { AgentError } from './store-agents.js';
import { AUDIT_KEPT_DAYS, AUDIT_KINDS, DAY, YEAR_DAYS, auditEntry } from './infra-audit.js';

export { AUDIT_KEPT_DAYS } from './infra-audit.js';

const SHOWN = 50;
const SHOWN_MAX = 200;

/**
 * An entry as stored and shown.
 * @typedef {{ id: number, at: number, kind: string, repo: string, environment: string, environmentId: number | null,
 *   plan: string | null,
 *   by: string, agent: string | null, envelope: string | null, outcome: string, summary: string }} AuditEntry
 */

/** @typedef {import('./infra-audit.js').AuditInput} AuditInput */

/** @returns {AuditEntry} */
function shown(row) {
  return {
    id: Number(row.id),
    at: Number(row.at),
    kind: row.kind,
    repo: row.repo,
    environment: row.environment,
    environmentId: row.environment_id === null || row.environment_id === undefined ? null : Number(row.environment_id),
    plan: row.plan ?? null,
    by: row.by,
    agent: row.agent ?? null,
    envelope: row.envelope ?? null,
    outcome: row.outcome,
    summary: row.summary,
  };
}

/** A whole number from a query string, or an AgentError naming it. */
function whole(value, what, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AgentError(`${what} must be a whole number from ${min} to ${max}`, 400);
  return n;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraAuditMethods = {
  initInfraAudit() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        repo TEXT NOT NULL,
        environment TEXT NOT NULL,
        environment_id INTEGER,
        plan TEXT,
        by TEXT NOT NULL,
        agent TEXT,
        envelope TEXT,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_audit_by_environment ON infra_audit (environment, id);
      CREATE INDEX IF NOT EXISTS infra_audit_by_environment_id ON infra_audit (environment_id, id);
      CREATE INDEX IF NOT EXISTS infra_audit_by_repo ON infra_audit (repo, id);
      CREATE INDEX IF NOT EXISTS infra_audit_by_age ON infra_audit (at);
      CREATE TRIGGER IF NOT EXISTS infra_audit_no_update BEFORE UPDATE ON infra_audit
      BEGIN
        SELECT RAISE(ABORT, 'the audit trail is append-only: an entry is never changed');
      END;
      CREATE TRIGGER IF NOT EXISTS infra_audit_keep_a_year BEFORE DELETE ON infra_audit
      WHEN old.at > (CAST(strftime('%s', 'now') AS INTEGER) - ${YEAR_DAYS} * 86400) * 1000
      BEGIN
        SELECT RAISE(ABORT, 'the audit trail keeps every entry for at least a year');
      END;
    `);
  },

  /**
   * Appends one entry, for the control plane (plans, approvals, the executor, envelopes, locks, break-glass) to
   * call; there is no API to append, so nothing outside the board writes the trail. Returns the entry as stored.
   * @param {AuditInput} input
   * @returns {AuditEntry}
   */
  appendInfraAudit(input) {
    const entry = auditEntry(input);
    const row = this.sql
      .exec(
        'INSERT INTO infra_audit (at, kind, repo, environment, environment_id, plan, by, agent, envelope, outcome, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        Date.now(),
        entry.kind,
        entry.repo,
        entry.environment,
        entry.environmentId,
        entry.plan,
        entry.by,
        entry.agent,
        entry.envelope,
        entry.outcome,
        entry.summary,
      )
      .toArray()[0];
    return shown(row);
  },

  /**
   * Entries newest first, filtered by environment (its name or ID), repository, and kind, paged with `before` (an entry's id).
   * @param {{ environment?: string, environmentId?: string | number, repo?: string, kind?: string, before?: string | number, limit?: string | number }} query
   * @returns {{ entries: AuditEntry[], more: boolean }}
   */
  infraAudit(query = {}) {
    const where = [];
    const args = [];
    if (query.environment) {
      where.push('environment = ?');
      args.push(String(query.environment).toLowerCase());
    }
    const environmentId = whole(query.environmentId, 'environmentId', 1, Number.MAX_SAFE_INTEGER);
    if (environmentId !== null) {
      where.push('environment_id = ?');
      args.push(environmentId);
    }
    if (query.repo) {
      where.push('repo = ?');
      args.push(String(query.repo).toLowerCase());
    }
    if (query.kind) {
      if (!AUDIT_KINDS.includes(String(query.kind)))
        throw new AgentError(`kind must be one of ${AUDIT_KINDS.join(', ')}`, 400);
      where.push('kind = ?');
      args.push(String(query.kind));
    }
    const before = whole(query.before, 'before', 1, Number.MAX_SAFE_INTEGER);
    if (before !== null) {
      where.push('id < ?');
      args.push(before);
    }
    const limit = whole(query.limit, 'limit', 1, SHOWN_MAX) ?? SHOWN;
    const rows = this.sql
      .exec(
        `SELECT * FROM infra_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray();
    return { entries: rows.slice(0, limit).map(shown), more: rows.length > limit };
  },

  /** GET /api/infra/audit: the trail, for the CLI, agents, and the environment's page. Read only. */
  infraAuditApi(query) {
    return this.run(async () => ({ status: 200, body: this.infraAudit(query) }));
  },

  /** Retention, on the cron: drops entries past AUDIT_KEPT_DAYS, and never one younger than a year. */
  pruneInfraAudit(now = Date.now()) {
    const days = Math.max(AUDIT_KEPT_DAYS, YEAR_DAYS + 1);
    this.sql.exec('DELETE FROM infra_audit WHERE at < ?', now - days * DAY);
  },
};
