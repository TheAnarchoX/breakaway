/**
 * TaskStore's account-wide alerts (BRK-255): a provider's alerts that name no Worker, zone, or hostname (a platform
 * incident, a billing alert, an account's security insight) are about the account, not any one environment. Each
 * environment's alert history reads them all, so they're kept here once per provider instead of once per environment
 * in the signal stream, and the Infrastructure overview shows them. They're raw signals in all but name: redacted the
 * same way, kept SIGNAL_RAW_DAYS, and read only (GET /api/infra/account-alerts). Runbooks and incidents don't hear
 * them: those act on one environment, and these are about none.
 */
import { AgentError } from './store-agents.js';
import { ALERT_SAME_MS, DAY, SIGNAL_RAW_DAYS, signalEntry } from './infra-signals.js';

const SHOWN = 20;
const SHOWN_MAX = 100;
/** The one-off that moves the copies older boards kept in every environment's stream here. */
const MOVED = 'infra_account_alerts_moved';

/**
 * An account-wide alert as stored and shown.
 * @typedef {{ id: number, source: string, level: string, at: string, text: string }} AccountAlert
 */

/** @returns {AccountAlert} */
function shown(row) {
  return {
    id: Number(row.id),
    source: row.source,
    level: row.level,
    at: new Date(Number(row.at)).toISOString(),
    text: row.text,
  };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraAccountAlertsMethods = {
  initInfraAccountAlerts() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_account_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        received INTEGER NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_account_alerts_by_source ON infra_account_alerts (source, at);
    `);
    if (!this.meta(MOVED)) {
      this.moveAccountAlerts();
      this.setMeta(MOVED, String(Date.now()));
    }
  },

  /**
   * Keeps the account-wide alerts in `signals` (those marked `account`), one per provider, and returns the rest for the
   * signal stream. An alert already kept (the same source and text, within ALERT_SAME_MS) is left out, so the same
   * alert read from each environment's history, or heard by the webhook too, is one.
   * @param {Array<import('./infra-signals.js').SignalInput & { account?: boolean }>} signals
   * @returns {import('./infra-signals.js').SignalInput[]}
   */
  keepAccountAlerts(signals) {
    if (!Array.isArray(signals)) throw new AgentError('signals must be a list', 400);
    const rest = [];
    for (const s of signals) {
      if (!s?.account) {
        rest.push(s);
        continue;
      }
      const { account: _, ...signal } = s;
      this.recordAccountAlert(signal);
    }
    return rest;
  },

  /**
   * Stores one account-wide alert, unless it's already kept. Returns it as stored, or null when it was already.
   * @param {import('./infra-signals.js').SignalInput} signal
   * @returns {AccountAlert | null}
   */
  recordAccountAlert(signal) {
    const now = Date.now();
    const e = signalEntry(signal, now);
    if (e.kind !== 'alert') throw new AgentError('only an alert is account-wide', 400);
    const kept = this.sql
      .exec(
        'SELECT 1 FROM infra_account_alerts WHERE source = ? AND text = ? AND at BETWEEN ? AND ? LIMIT 1',
        e.source,
        e.text,
        e.at - ALERT_SAME_MS,
        e.at + ALERT_SAME_MS,
      )
      .toArray();
    if (kept.length) return null;
    return shown(
      this.sql
        .exec(
          'INSERT INTO infra_account_alerts (at, received, source, level, text) VALUES (?, ?, ?, ?, ?) RETURNING *',
          e.at,
          now,
          e.source,
          e.level,
          e.text,
        )
        .one(),
    );
  },

  /**
   * The one-off for a board that kept account-wide alerts in every environment's stream (before BRK-255): an alert on
   * no resource that's in more than one of a provider's environments at the same time with the same text is one
   * account-wide alert copied into each. Each moves here once, and its copies leave the stream. An alert in only one
   * environment stays where it is, since nothing says it isn't that environment's.
   */
  moveAccountAlerts() {
    const copies = this.sql
      .exec(
        `SELECT source, at, text, level, COUNT(DISTINCT environment_id) AS n FROM infra_signals
         WHERE kind = 'alert' AND resource IS NULL AND environment_id IS NOT NULL
         GROUP BY source, at, text HAVING n > 1`,
      )
      .toArray();
    for (const c of copies) {
      this.recordAccountAlert({
        source: c.source,
        environment: 'account',
        resource: null,
        kind: 'alert',
        level: c.level,
        value: null,
        at: new Date(Number(c.at)).toISOString(),
        text: c.text,
      });
      this.sql.exec(
        "DELETE FROM infra_signals WHERE kind = 'alert' AND resource IS NULL AND source = ? AND at = ? AND text = ?",
        c.source,
        c.at,
        c.text,
      );
    }
    return copies.length;
  },

  /**
   * The account-wide alerts newest first, of one provider or all.
   * @param {{ source?: string, limit?: string | number }} query
   * @returns {{ alerts: AccountAlert[], more: boolean }}
   */
  infraAccountAlerts(query = {}) {
    const whole = (value, what, max) => {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > max)
        throw new AgentError(`${what} must be a whole number from 1 to ${max}`, 400);
      return n;
    };
    const where = [];
    const args = [];
    if (query.source) {
      where.push('source = ?');
      args.push(String(query.source));
    }
    const limit = whole(query.limit, 'limit', SHOWN_MAX) ?? SHOWN;
    const rows = this.sql
      .exec(
        `SELECT * FROM infra_account_alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray();
    return { alerts: rows.slice(0, limit).map(shown), more: rows.length > limit };
  },

  /** GET /api/infra/account-alerts: the account-wide alerts, for the overview, the CLI, and agents. Read only. */
  infraAccountAlertsApi(query) {
    return this.run(async () => ({ status: 200, body: this.infraAccountAlerts(query) }));
  },

  /** Retention, on the cron: account-wide alerts are kept as long as raw signals. */
  pruneInfraAccountAlerts(now = Date.now()) {
    this.sql.exec('DELETE FROM infra_account_alerts WHERE at < ?', now - SIGNAL_RAW_DAYS * DAY);
  },
};
