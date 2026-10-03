/**
 * TaskStore's messages to a running agent (docs/specs/IDEA-15-message-a-running-agent.md): the owner
 * writes a note on a task while its agent works, and the agent's session hooks collect it. Only the
 * signed-in board sends (the worker refuses the bearer token); a message goes to the agent that held
 * the claim when it was sent, once, and only while it still holds it. Kept 14 days, never in a version.
 */
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';

const AGENT = /^[\w.@:/-]{1,64}$/u;
export const MESSAGE_MAX = 2000;
export const MESSAGES_WAITING = 10; // per task
const MESSAGE_DAYS = 14;
/** The idle hook's window (CLD-146): after this long without output the agent is idle... */
const IDLE_MS = 180_000;
/** ...and if its wait hook hasn't asked within this long, nothing is listening. */
const POLL_MS = 60_000;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const messagesMethods = {
  initMessages() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, agent TEXT NOT NULL, text TEXT NOT NULL,
        sent INTEGER NOT NULL, delivered INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_messages_task ON agent_messages (task, id);
      CREATE TABLE IF NOT EXISTS agent_message_polls (task TEXT PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  },

  /** Why the owner can't message a task's agent right now, or null: it needs an open, claimed task whose pull request hasn't merged. */
  messageBlocker(uuid) {
    const t = this.views((v) => v.uuid === uuid)[0];
    if (t?.status !== 'pending') return 'it isn’t open';
    if (!t.claim) return 'no agent holds it';
    if (t.github?.some((p) => p.closes && p.state === 'merged')) return 'its pull request has merged';
    return null;
  },

  messageView(row, map) {
    const live = map?.status === 'pending' && map.claim === row.agent;
    return {
      id: row.id,
      agent: row.agent,
      text: row.text,
      sent: new Date(row.sent).toISOString(),
      delivered: row.delivered ? new Date(row.delivered).toISOString() : null,
      status: row.delivered ? 'delivered' : live ? 'waiting' : 'undelivered',
    };
  },

  /** A task's messages, oldest first, and whether anything is listening for them. */
  messagesFor(uuid) {
    this.pruneMessages();
    const map = this.tasks.get(uuid);
    const messages = this.sql
      .exec('SELECT * FROM agent_messages WHERE task = ? ORDER BY id LIMIT 200', uuid)
      .toArray()
      .map((row) => this.messageView(row, map));
    const blocker = this.messageBlocker(uuid);
    const now = Date.now();
    const last = this.sql.exec('SELECT MAX(at) AS at FROM agent_logs WHERE task = ?', uuid).one().at;
    const poll = this.sql
      .exec('SELECT at FROM agent_message_polls WHERE task = ? AND agent = ?', uuid, map?.claim ?? '')
      .toArray()[0]?.at;
    return {
      messages,
      agent: blocker ? null : map.claim,
      canSend: !blocker,
      reason: blocker,
      // Quiet past the wait hook's window, and no wait hook asking: a message waits for the agent's next turn.
      idle: !blocker && Boolean(last) && now - last > IDLE_MS && !(poll && now - poll < POLL_MS),
    };
  },

  /** The owner's message to the task's agent. The worker lets only the signed-in board call this. */
  sendMessage(uuid, text) {
    const clean = String(text ?? '')
      .replace(/\r\n?/gu, '\n')
      .trim();
    if (!clean) throw new InputError('write a message first');
    if (clean.length > MESSAGE_MAX)
      throw new InputError(`a message is up to ${MESSAGE_MAX.toLocaleString('en-GB')} characters`);
    const blocker = this.messageBlocker(uuid);
    const map = this.tasks.get(uuid);
    if (blocker) throw new AgentError(`${map?.wid ?? 'This task'} has no running agent to message: ${blocker}`, 409);
    const waiting = this.sql
      .exec(
        'SELECT COUNT(*) AS n FROM agent_messages WHERE task = ? AND agent = ? AND delivered IS NULL',
        uuid,
        map.claim,
      )
      .one().n;
    if (waiting >= MESSAGES_WAITING)
      throw new AgentError(
        `${MESSAGES_WAITING} messages are waiting already: wait for the agent to receive the first ones`,
        429,
      );
    const row = this.sql
      .exec(
        'INSERT INTO agent_messages (task, agent, text, sent) VALUES (?, ?, ?, ?) RETURNING *',
        uuid,
        map.claim,
        clean,
        Date.now(),
      )
      .one();
    return this.messageView(row, map);
  },

  /**
   * Hands the messages waiting for `agent` to its hook and marks them delivered in the same step, so each
   * arrives once. Only the agent that holds the claim, and only messages sent to it, ever come out.
   */
  takeMessages(uuid, agent, { poll = false } = {}) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) return [];
    const map = this.tasks.get(uuid);
    if (map?.status !== 'pending' || map.claim !== name) return [];
    const now = Date.now();
    if (poll)
      this.sql.exec('INSERT OR REPLACE INTO agent_message_polls (task, agent, at) VALUES (?, ?, ?)', uuid, name, now);
    const rows = this.sql
      .exec(
        'SELECT * FROM agent_messages WHERE task = ? AND agent = ? AND delivered IS NULL AND sent > ? ORDER BY id',
        uuid,
        name,
        now - MESSAGE_DAYS * 86_400_000,
      )
      .toArray();
    if (!rows.length) return [];
    this.sql.exec(
      `UPDATE agent_messages SET delivered = ? WHERE id IN (${rows.map(() => '?').join(',')})`,
      now,
      ...rows.map((r) => r.id),
    );
    return rows.map((r) => ({ id: r.id, text: r.text, sent: new Date(r.sent).toISOString() }));
  },

  pruneMessages() {
    const before = Date.now() - MESSAGE_DAYS * 86_400_000;
    this.sql.exec('DELETE FROM agent_messages WHERE sent < ?', before);
    this.sql.exec('DELETE FROM agent_message_polls WHERE at < ?', before);
  },
};
