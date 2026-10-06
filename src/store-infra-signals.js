/**
 * TaskStore's signals (docs/specs/IDEA-19-architect.md, "Signals"; BRK-190): one stream of what providers and the
 * deploy flow report (health, the platform's alerts, and cost), each signal checked and redacted by
 * src/infra-signals.js before it's stored, and readable by environment and resource. Raw signals are kept
 * SIGNAL_RAW_DAYS; the cron folds older ones into daily summaries, kept SIGNAL_SUMMARY_DAYS.
 *
 * Runbooks (BRK-196) and incidents (BRK-197) hear the stream by registering on `signalSubscribers`: each new batch
 * reaches every subscriber after it's stored, and a subscriber that throws never loses a signal or stops the others.
 * Nothing outside the board writes signals: the API reads only, and providers report inside the store.
 *
 * A platform's alert can reach the board twice, by its webhook as it fires and from its alert history when the
 * inventory refreshes (BRK-191): `recordAlertSignals` keeps one of each. GET /api/infra/alerts reads which of a
 * provider's alerts are set up and which reach the board.
 */
import { AgentError } from './store-agents.js';
import { checkSignals } from './infra-provider.js';
import { redact } from './redact.js';
import {
  ALERT_SAME_MS,
  DAY,
  SIGNAL_KINDS,
  SIGNAL_LEVELS,
  SIGNAL_RAW_DAYS,
  SIGNAL_SUMMARY_DAYS,
  dayKey,
  dayOf,
  foldSignals,
  signalEntry,
} from './infra-signals.js';

export { SIGNAL_RAW_DAYS, SIGNAL_SUMMARY_DAYS } from './infra-signals.js';

const SHOWN = 50;
const SHOWN_MAX = 200;

/**
 * A signal as stored and shown.
 * @typedef {{ id: number, source: string, environment: string, environmentId: number | null,
 *   resource: string | null, kind: string, level: string, value: number | null, at: string, text: string }} StoredSignal
 */

/**
 * What hears the stream: the store, and the signals just stored, oldest first.
 * @typedef {(store: any, signals: StoredSignal[]) => void | Promise<void>} SignalSubscriber
 */

/** The stream's subscribers, by name: runbooks and incidents register here as they're built. */
export class SignalSubscribers {
  /** @type {Map<string, SignalSubscriber>} */
  #subscribers = new Map();

  /**
   * Adds a subscriber; refuses a second one with the same name. Returns a function that removes it.
   * @param {string} name
   * @param {SignalSubscriber} fn
   */
  subscribe(name, fn) {
    if (typeof fn !== 'function') throw new Error(`signal subscriber ${name} is not a function`);
    if (this.#subscribers.has(name)) throw new Error(`signal subscriber ${name} is already registered`);
    this.#subscribers.set(name, fn);
    return () => this.#subscribers.delete(name);
  }

  /** The subscribers, in the order they registered. */
  list() {
    return [...this.#subscribers.entries()].map(([name, fn]) => ({ name, fn }));
  }
}

/** The Worker's subscribers: runbooks (BRK-196, src/store-infra-runbooks.js) and incidents (BRK-197) add theirs. */
export const signalSubscribers = new SignalSubscribers();

/** @returns {StoredSignal} */
function shown(row) {
  return {
    id: Number(row.id),
    source: row.source,
    environment: row.environment,
    environmentId: row.environment_id === null || row.environment_id === undefined ? null : Number(row.environment_id),
    resource: row.resource ?? null,
    kind: row.kind,
    level: row.level,
    value: row.value ?? null,
    at: new Date(Number(row.at)).toISOString(),
    text: row.text,
  };
}

/** @returns {import('./infra-signals.js').SignalDay} */
function dayRow(row) {
  return {
    day: row.day,
    source: row.source,
    environment: row.environment,
    environmentId: Number(row.environment_id) || null,
    resource: row.resource === '' ? null : row.resource,
    kind: row.kind,
    count: Number(row.count),
    info: Number(row.info),
    warning: Number(row.warning),
    critical: Number(row.critical),
    min: row.min ?? null,
    max: row.max ?? null,
    last: row.last ?? null,
    lastAt: Number(row.last_at),
    text: row.text,
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

/** The WHERE clause for the filters both reads share. */
function filters(query) {
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
  if (query.resource) {
    where.push('resource = ?');
    args.push(String(query.resource));
  }
  if (query.source) {
    where.push('source = ?');
    args.push(String(query.source));
  }
  if (query.kind) {
    if (!SIGNAL_KINDS.includes(String(query.kind)))
      throw new AgentError(`kind must be one of ${SIGNAL_KINDS.join(', ')}`, 400);
    where.push('kind = ?');
    args.push(String(query.kind));
  }
  return { where, args };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraSignalsMethods = {
  initInfraSignals() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        received INTEGER NOT NULL,
        source TEXT NOT NULL,
        environment TEXT NOT NULL,
        environment_id INTEGER,
        resource TEXT,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        value REAL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_signals_by_environment ON infra_signals (environment, at);
      CREATE INDEX IF NOT EXISTS infra_signals_by_environment_id ON infra_signals (environment_id, at);
      CREATE INDEX IF NOT EXISTS infra_signals_by_resource ON infra_signals (resource, at);
      CREATE INDEX IF NOT EXISTS infra_signals_by_age ON infra_signals (at);
      CREATE TABLE IF NOT EXISTS infra_signal_days (
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        environment TEXT NOT NULL,
        environment_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        kind TEXT NOT NULL,
        count INTEGER NOT NULL,
        info INTEGER NOT NULL,
        warning INTEGER NOT NULL,
        critical INTEGER NOT NULL,
        min REAL,
        max REAL,
        last REAL,
        last_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (day, source, environment, environment_id, resource, kind)
      );
      CREATE INDEX IF NOT EXISTS infra_signal_days_by_environment ON infra_signal_days (environment, day);
      CREATE INDEX IF NOT EXISTS infra_signal_days_by_environment_id ON infra_signal_days (environment_id, day);
    `);
  },

  /**
   * Stores signals, for providers and the deploy flow to call inside the store; there is no API to write. Every
   * signal is checked first, so a batch with one the stream can't take (another kind, a bad time) stores none of it.
   * Then each subscriber hears the batch. Returns the signals as stored, oldest first.
   * @param {import('./infra-signals.js').SignalInput[]} signals
   * @returns {Promise<StoredSignal[]>}
   */
  async recordSignals(signals) {
    if (!Array.isArray(signals)) throw new AgentError('signals must be a list', 400);
    const now = Date.now();
    const entries = signals.map((s) => signalEntry(s, now)).sort((a, b) => a.at - b.at);
    const stored = entries.map((e) =>
      shown(
        this.sql
          .exec(
            'INSERT INTO infra_signals (at, received, source, environment, environment_id, resource, kind, level, value, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            e.at,
            now,
            e.source,
            e.environment,
            e.environmentId,
            e.resource,
            e.kind,
            e.level,
            e.value,
            e.text,
          )
          .one(),
      ),
    );
    if (stored.length)
      for (const { name, fn } of signalSubscribers.list()) {
        try {
          await fn(this, stored);
        } catch (error) {
          // The signals are stored either way; a subscriber's failure is its own, and the next one still hears them.
          console.error(`signal subscriber ${name} failed: ${error.message}`);
        }
      }
    return stored;
  },

  /**
   * Asks a provider for its signals in one environment since `since`, checks them against the provider contract,
   * and stores them.
   * @param {import('./infra-provider.js').Provider} provider
   * @param {import('./infra-provider.js').ProviderContext} ctx
   * @param {string} since ISO 8601
   */
  async pullProviderSignals(provider, ctx, since) {
    const signals = checkSignals(provider, ctx, since, await provider.events(ctx, since));
    return this.recordAlertSignals(signals);
  },

  /**
   * Stores signals like `recordSignals`, but keeps one of each alert: an alert already stored (the same source,
   * environment, resource, and text, within ALERT_SAME_MS) is left out, so an alert heard by its webhook and again
   * from the platform's history is one signal. Other kinds go through as they are.
   * @param {import('./infra-signals.js').SignalInput[]} signals
   */
  async recordAlertSignals(signals) {
    if (!Array.isArray(signals)) throw new AgentError('signals must be a list', 400);
    const now = Date.now();
    /** @type {import('./infra-signals.js').SignalEntry[]} */
    const kept = [];
    const fresh = signals.filter((input) => {
      const e = signalEntry(input, now);
      if (e.kind !== 'alert') return true;
      const same = (o) =>
        o.source === e.source &&
        o.environment === e.environment &&
        o.environmentId === e.environmentId &&
        o.resource === e.resource &&
        o.text === e.text &&
        Math.abs(o.at - e.at) <= ALERT_SAME_MS;
      if (kept.some(same)) return false;
      const stored = this.sql
        .exec(
          "SELECT 1 FROM infra_signals WHERE kind = 'alert' AND source = ? AND environment = ? AND environment_id IS ? AND resource IS ? AND text = ? AND at BETWEEN ? AND ? LIMIT 1",
          e.source,
          e.environment,
          e.environmentId,
          e.resource,
          e.text,
          e.at - ALERT_SAME_MS,
          e.at + ALERT_SAME_MS,
        )
        .toArray();
      if (stored.length) return false;
      kept.push(e);
      return true;
    });
    return this.recordSignals(fresh);
  },

  /**
   * A platform's alert, heard by its webhook (src/store-routines.js), as an `alert` signal: on `resource` in each of the
   * provider's environments whose inventory has it, or, when it names none or no inventory has it, on each of the
   * provider's environments in `repo` as a whole. An environment that isn't on the board hears nothing. Returns the
   * signals stored.
   * @param {string} providerId
   * @param {string} repo the repository whose routine the alert fired
   * @param {{ at: string | null, resource: string | null, text: string }} alert
   */
  async recordProviderAlert(providerId, repo, { at, resource, text }) {
    const now = Date.now();
    const t = at ? Date.parse(at) : Number.NaN;
    const when = new Date(Number.isNaN(t) || t > now + DAY ? now : t).toISOString();
    let on = resource;
    let environments = resource
      ? this.sql
          .exec(
            'SELECT DISTINCT e.id, e.name FROM infra_inventory i JOIN infra_environments e ON e.id = i.environment WHERE i.provider = ? AND i.rid = ? ORDER BY e.id',
            providerId,
            resource,
          )
          .toArray()
      : [];
    if (!environments.length) {
      on = null;
      environments = this.sql
        .exec('SELECT id, name FROM infra_environments WHERE provider = ? AND repo = ? ORDER BY id', providerId, repo)
        .toArray();
    }
    return this.recordAlertSignals(
      environments.map((e) => ({
        source: providerId,
        environment: e.name,
        environmentId: Number(e.id),
        resource: on,
        kind: 'alert',
        level: 'warning',
        value: null,
        at: when,
        text,
      })),
    );
  },

  /**
   * GET /api/infra/alerts?provider=: which of the provider's alerts are set up and which reach the board, read live
   * with the board's read-only token. Read only; names, never an address.
   */
  infraAlertsApi(query = {}) {
    return this.run(async () => {
      const id = String(query.provider ?? '').trim();
      if (!id) throw new AgentError('say which provider, like ?provider=<its id>', 400);
      const registry = this.infraRegistry();
      if (!registry.has(id)) throw new AgentError(`no provider ${id.slice(0, 40)} is connected`, 404);
      const provider = registry.get(id);
      if (typeof provider.alerts !== 'function')
        throw new AgentError(`${provider.name} doesn’t send alerts to the board`, 404);
      const token = await this.providerReadToken(id);
      if (!token)
        throw new AgentError(
          `connect ${provider.name} on Connections first: the board reads its alerts with that token`,
          409,
        );
      const board = [this.homeUrl(), this.meta('conn_origin')].flatMap((u) => {
        try {
          return u ? [new URL(u).origin] : [];
        } catch {
          return [];
        }
      });
      /** @type {import('./infra-provider.js').AlertSetup} */
      let setup;
      try {
        setup = await provider.alerts({ environment: '', token }, { board: [...new Set(board)] });
      } catch (error) {
        const message = `${provider.name} couldn’t say which alerts are set up: ${redact(error?.message ?? error)}`;
        if (typeof error?.permission === 'string')
          await this.infraConnectionSeen(id, 'signal', { ok: false, error: message, missing: [error.permission] });
        throw new AgentError(message, error?.status === 429 ? 429 : 502);
      }
      return {
        status: 200,
        body: {
          provider: id,
          alerts: setup.alerts.map((a) => ({ ...a, name: redact(a.name) })),
          policies: setup.policies.map((p) => ({ ...p, name: redact(p.name) })),
          webhooks: setup.webhooks,
        },
      };
    });
  },

  /**
   * Raw signals newest first (as they came in), filtered by environment, resource, source, kind, and level, paged with `before` (a
   * signal's id).
   * @param {{ environment?: string, environmentId?: string | number, resource?: string, source?: string, kind?: string, level?: string,
   *   before?: string | number, limit?: string | number }} query
   * @returns {{ signals: StoredSignal[], more: boolean }}
   */
  infraSignals(query = {}) {
    const { where, args } = filters(query);
    if (query.level) {
      if (!SIGNAL_LEVELS.includes(String(query.level)))
        throw new AgentError(`level must be one of ${SIGNAL_LEVELS.join(', ')}`, 400);
      where.push('level = ?');
      args.push(String(query.level));
    }
    const before = whole(query.before, 'before', 1, Number.MAX_SAFE_INTEGER);
    if (before !== null) {
      where.push('id < ?');
      args.push(before);
    }
    const limit = whole(query.limit, 'limit', 1, SHOWN_MAX) ?? SHOWN;
    const rows = this.sql
      .exec(
        `SELECT * FROM infra_signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray();
    return { signals: rows.slice(0, limit).map(shown), more: rows.length > limit };
  },

  /**
   * Daily summaries newest day first, filtered like the raw signals.
   * @param {{ environment?: string, environmentId?: string | number, resource?: string, source?: string, kind?: string }} query
   * @returns {{ days: Array<Omit<import('./infra-signals.js').SignalDay, 'lastAt'> & { lastAt: string }> }}
   */
  infraSignalDays(query = {}) {
    const { where, args } = filters(query);
    const rows = this.sql
      .exec(
        `SELECT * FROM infra_signal_days ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day DESC, environment, resource, kind`,
        ...args,
      )
      .toArray();
    return { days: rows.map(dayRow).map((d) => ({ ...d, lastAt: new Date(d.lastAt).toISOString() })) };
  },

  /** GET /api/infra/signals: the raw stream, for the CLI, agents, and the environment's page. Read only. */
  infraSignalsApi(query) {
    return this.run(async () => ({ status: 200, body: this.infraSignals(query) }));
  },

  /** GET /api/infra/signals/days: the daily summaries. Read only. */
  infraSignalDaysApi(query) {
    return this.run(async () => ({ status: 200, body: this.infraSignalDays(query) }));
  },

  /**
   * Retention, on the cron: raw signals older than SIGNAL_RAW_DAYS fold into their day's summary and go, and
   * summaries older than SIGNAL_SUMMARY_DAYS go.
   */
  foldInfraSignals(now = Date.now()) {
    const cutoff = now - SIGNAL_RAW_DAYS * DAY;
    const old = this.sql.exec('SELECT * FROM infra_signals WHERE at < ? ORDER BY at, id', cutoff).toArray();
    if (old.length) {
      const entries = old.map((r) => ({
        ...r,
        at: Number(r.at),
        environmentId: r.environment_id === null || r.environment_id === undefined ? null : Number(r.environment_id),
        resource: r.resource ?? null,
        value: r.value ?? null,
      }));
      const keys = new Set(entries.map((e) => dayKey(dayOf(e.at), e)));
      const existing = [];
      for (const key of keys) {
        const [day, source, environment, environmentId, resource, kind] = JSON.parse(key);
        const row = this.sql
          .exec(
            'SELECT * FROM infra_signal_days WHERE day = ? AND source = ? AND environment = ? AND environment_id = ? AND resource = ? AND kind = ?',
            day,
            source,
            environment,
            environmentId,
            resource,
            kind,
          )
          .toArray()[0];
        if (row) existing.push(dayRow(row));
      }
      for (const d of foldSignals(entries, existing))
        this.sql.exec(
          'INSERT OR REPLACE INTO infra_signal_days (day, source, environment, environment_id, resource, kind, count, info, warning, critical, min, max, last, last_at, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          d.day,
          d.source,
          d.environment,
          d.environmentId ?? 0,
          d.resource ?? '',
          d.kind,
          d.count,
          d.info,
          d.warning,
          d.critical,
          d.min,
          d.max,
          d.last,
          d.lastAt,
          d.text,
        );
      this.sql.exec('DELETE FROM infra_signals WHERE at < ?', cutoff);
    }
    this.sql.exec('DELETE FROM infra_signal_days WHERE day < ?', dayOf(now - SIGNAL_SUMMARY_DAYS * DAY));
  },
};
