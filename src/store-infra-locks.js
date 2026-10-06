/**
 * TaskStore's environment locks (docs/specs/IDEA-19-architect.md, "Executor"; BRK-179): at most one per environment,
 * so the executor never runs two applies on one. Taking one is atomic like a claim: the Durable Object runs one call
 * at a time, and the check and the write happen in one synchronous transaction, so of two takes one wins and the
 * other gets a 409 naming the holder.
 *
 * Take, renew, and release are the executor's (BRK-183 wires its route): the taker gets a token once, and only that
 * token renews or releases. A lock nobody renews expires, and the next take frees it. The owner can release one by
 * force, from the signed-in board only. Every release, whichever way, appends a `lock-release` entry to the audit
 * trail (BRK-175); a release that can't be recorded is refused, never done silently.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { runsTheBoard } from './infra-environments.js';
import { checkHolder, checkPlanRef, held, lockTtl, lockView } from './infra-locks.js';

const SELECT = `SELECT l.*, e.repo, e.name FROM infra_locks l JOIN infra_environments e ON e.id = l.environment`;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraLocksMethods = {
  initInfraLocks() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_locks (
        environment INTEGER PRIMARY KEY, holder TEXT NOT NULL, token TEXT NOT NULL, plan TEXT,
        taken INTEGER NOT NULL, renewed INTEGER NOT NULL, expires INTEGER NOT NULL
      );
    `);
  },

  /** The lock row on an environment, held or expired, or null. */
  lockRow(environment) {
    return this.sql.exec(`${SELECT} WHERE l.environment = ?`, environment).toArray()[0] ?? null;
  },

  /** A release goes on the audit trail first; with no trail to write to, the release doesn't happen. */
  auditLockRelease(env, lock, { by, outcome, summary }) {
    this.appendInfraAudit({
      kind: 'lock-release',
      repo: env.repo,
      environment: env.name,
      environmentId: env.id,
      by,
      plan: lock.plan ?? null,
      outcome,
      summary,
    });
  },

  /**
   * Takes an environment's lock for one apply. Refused while another holds it, and on an environment that's frozen,
   * observe only, or runs this board. An expired lock is released (and audited) and taken in the same step.
   * @param {string | number} ref the environment's ID or name
   * @param {{ holder: unknown, plan?: unknown, minutes?: unknown, repo?: string | null }} input
   * @returns {{ lock: ReturnType<typeof lockView>, token: string }}
   */
  takeEnvironmentLock(ref, { holder, plan, minutes, repo = null } = /** @type {any} */ ({})) {
    const env = this.environmentRow(ref, repo);
    const who = checkHolder(holder);
    const planRef = checkPlanRef(plan);
    const ttl = lockTtl(minutes);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      throw new AgentError(`${env.name} is observe only: nothing applies to it, so it has no lock to take`, 409);
    if (env.frozen) throw new AgentError(`${env.name} is frozen: the owner unfreezes it on the board first`, 409);
    const token = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const current = this.lockRow(env.id);
      if (held(current, now))
        throw new AgentError(
          `${env.name} is locked by ${current.holder} until ${new Date(Number(current.expires)).toISOString()}`,
          409,
        );
      if (current) {
        this.auditLockRelease(env, current, {
          by: 'board',
          outcome: 'expired',
          summary: `${current.holder}’s lock expired unreleased; ${who} took it`,
        });
        this.sql.exec('DELETE FROM infra_locks WHERE environment = ?', env.id);
      }
      this.sql.exec(
        'INSERT INTO infra_locks (environment, holder, token, plan, taken, renewed, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
        env.id,
        who,
        token,
        planRef,
        now,
        now,
        now + ttl,
      );
    });
    return { lock: lockView(this.lockRow(env.id)), token };
  },

  /** The lock its token names, still held, or an error saying why not. */
  heldLock(env, token) {
    const lock = this.lockRow(env.id);
    if (!lock || !token || lock.token !== String(token))
      throw new AgentError(`that isn’t the lock on ${env.name}: take it first`, 409);
    if (!held(lock, Date.now()))
      throw new AgentError(`the lock on ${env.name} expired: take it again before you go on`, 409);
    return lock;
  },

  /**
   * Renews a held lock for another `minutes` from now. Only its token does, and only before it expires.
   * @param {string | number} ref
   * @param {{ token: unknown, minutes?: unknown, repo?: string | null }} input
   */
  renewEnvironmentLock(ref, { token, minutes, repo = null } = /** @type {any} */ ({})) {
    const env = this.environmentRow(ref, repo);
    const ttl = lockTtl(minutes);
    this.heldLock(env, token);
    const now = Date.now();
    this.sql.exec('UPDATE infra_locks SET renewed = ?, expires = ? WHERE environment = ?', now, now + ttl, env.id);
    return { lock: lockView(this.lockRow(env.id)) };
  },

  /**
   * Releases a held lock: the executor's, with the token it took it with, when its apply is done.
   * @param {string | number} ref
   * @param {{ token: unknown, outcome?: string, repo?: string | null }} input
   */
  releaseEnvironmentLock(ref, { token, outcome = 'released', repo = null } = /** @type {any} */ ({})) {
    const env = this.environmentRow(ref, repo);
    let lock;
    this.ctx.storage.transactionSync(() => {
      lock = this.heldLock(env, token);
      this.auditLockRelease(env, lock, { by: 'executor', outcome, summary: `${lock.holder} released the lock` });
      this.sql.exec('DELETE FROM infra_locks WHERE environment = ?', env.id);
    });
    return { released: lockView(lock) };
  },

  /** GET /api/infra/locks[?repo=]: the locks held now, by repository then environment. */
  locksApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec(
          `${SELECT} WHERE l.expires > ? AND (? IS NULL OR e.repo = ?) ORDER BY e.repo, e.name`,
          Date.now(),
          slug,
          slug,
        )
        .toArray();
      return { status: 200, body: { locks: rows.map(lockView) } };
    });
  },

  /** GET /api/infra/locks/<environment>: its lock, or null when it's free. */
  lockApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const lock = this.lockRow(env.id);
      return { status: 200, body: { lock: held(lock, Date.now()) ? lockView(lock) : null } };
    });
  },

  /**
   * DELETE /api/infra/locks/<environment>: the owner's forced release, from the signed-in board only (the worker
   * refuses the bearer token), for a lock the executor left behind. Audited as the owner's.
   */
  lockReleaseApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      let lock;
      this.ctx.storage.transactionSync(() => {
        lock = this.lockRow(env.id);
        if (!held(lock, Date.now())) throw new AgentError(`${env.name} isn’t locked`, 404);
        this.auditLockRelease(env, lock, {
          by: 'owner',
          outcome: 'forced',
          summary: `the owner released ${lock.holder}’s lock`,
        });
        this.sql.exec('DELETE FROM infra_locks WHERE environment = ?', env.id);
      });
      return { status: 200, body: { released: lockView(lock) } };
    });
  },
};
