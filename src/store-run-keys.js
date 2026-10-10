/**
 * TaskStore's run keys (BRK-324, src/run-keys.js): the key a start on a repository's lent routine hands its agent, and
 * who a key is when a request carries one. The board keeps only each key's SHA-256, with the run's task, the agent it
 * started, and the person the run is for. A key is that person, with their rights and no more, while the agent it was
 * made for holds the task's claim, for RUN_KEY_MS at most. Any change to the task's claim or status ends it (a release,
 * a claim by anyone, even the same agent name again, a merge, a delete); so does a new start, or removing the person.
 */
import { RUN_KEY, RUN_KEY_MS, makeRunKey, runKeyHash } from './run-keys.js';

/** What a request with a key that doesn't work is told. Never the key, and never whose it was. */
const KEY_ENDED =
  'this run key has ended: its run’s claim is over, or it’s more than a day old. Only a new start gets a new one';
const NOT_A_KEY = 'that isn’t a run key the board made: send the Run key from your payload, as it came';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const runKeysMethods = {
  initRunKeys() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_keys (
        task TEXT PRIMARY KEY, agent TEXT NOT NULL, handle TEXT NOT NULL, repo TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
      );
    `);
  },

  /**
   * A new run key for a start on repository `repo`'s lent routine, as `agent`, for person `handle`. It replaces the
   * task's last one, so only the latest start's agent has a key that works. It goes in the run's payload and nowhere
   * else.
   * @param {string} uuid the run's task
   * @param {string} agent
   * @param {string} handle
   * @param {string} repo
   * @returns {Promise<string>}
   */
  async runKeyMake(uuid, agent, handle, repo) {
    const key = makeRunKey();
    const hash = await runKeyHash(key);
    const now = Date.now();
    this.sql.exec('DELETE FROM run_keys WHERE created < ?', now - RUN_KEY_MS);
    this.sql.exec(
      'INSERT OR REPLACE INTO run_keys (task, agent, handle, repo, hash, created) VALUES (?, ?, ?, ?, ?, ?)',
      uuid,
      agent,
      handle,
      repo,
      hash,
      now,
    );
    return key;
  },

  /**
   * Who run key `key` is (the Worker's and /mcp's check): `{ person }` with the person's handle and name and the run's
   * agent, task, and repository, or `{ error }` when it isn't a key, or has ended. `tokenToo` is whether the same
   * request carried the board's token as well: the lent routine's environment adds it, which the owner should hear of.
   * @param {string} key
   * @param {{ tokenToo?: boolean }} [options]
   * @returns {Promise<{ person: { handle: string, name: string, agent: string, task: string, repo: string } } | { error: string }>}
   */
  async personOfRunKey(key, { tokenToo = false } = {}) {
    if (!RUN_KEY.test(String(key))) return { error: NOT_A_KEY };
    const row = this.sql.exec('SELECT * FROM run_keys WHERE hash = ?', await runKeyHash(key)).toArray()[0];
    if (!row) return { error: KEY_ENDED };
    const person = this.personRow(row.handle);
    const task = this.tasks.get(row.task);
    const ended =
      Date.now() - Number(row.created) > RUN_KEY_MS ||
      !person ||
      task?.status !== 'pending' ||
      task?.claim !== row.agent;
    if (ended) {
      this.sql.exec('DELETE FROM run_keys WHERE task = ?', row.task);
      return { error: KEY_ENDED };
    }
    if (tokenToo) this.lentTokenSeen(row.repo);
    this.personSeen(person, Date.now());
    return {
      person: { handle: person.handle, name: person.name, agent: row.agent, task: row.task, repo: row.repo },
    };
  },

  /**
   * Ends the run keys of tasks `uuids`: their claim or status changed, so the run each key was made for is over, even
   * when the same agent name claims the task again (the replica's applyOps calls it).
   * @param {string[]} uuids
   */
  endRunKeysOf(uuids) {
    for (const uuid of uuids) this.sql.exec('DELETE FROM run_keys WHERE task = ?', uuid);
  },

  /** Ends every run key person `handle`'s runs hold: they've left the board. */
  dropRunKeys(handle) {
    this.sql.exec('DELETE FROM run_keys WHERE handle = ?', String(handle));
  },
};
