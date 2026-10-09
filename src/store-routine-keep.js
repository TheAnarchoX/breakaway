/**
 * TaskStore's routines kept on the board (docs/specs/IDEA-26-kickoff.md, BRK-133): a repository's routine URL and
 * token, connected from the board's owner-only form, kept sealed in `kept_routines` (src/routine-keep.js). A routine
 * `agents-connect` put in the Secrets Store wins over one kept here; neither is ever returned by an API.
 */
import { AgentError, routineCredentials } from './store-agents.js';
import { checkRoutine, openRoutine, routineKey, sealRoutine } from './routine-keep.js';

/**
 * A repository's routine as the board sees it: `secrets` (agents-connect) or `board` (the form); `broken` is a kept
 * routine that can't be opened, so it starts nothing and Connections says to connect it again.
 * @typedef {{ url: string, token: string, source: 'secrets' | 'board' } | { broken: true, source: 'board' }} RepoRoutine
 */

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const routineKeepMethods = {
  initRoutineKeep() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kept_routines (
        slug TEXT PRIMARY KEY, sealed TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER NOT NULL
      );
    `);
  },

  /** The key routines are sealed with, from the sync key in use (it changes only with a rotation, which re-seals them). */
  async keptRoutineKey(syncKey = null) {
    const key = syncKey ?? (await this.credentials()).key;
    if (this.keptKeyCache?.syncKey !== key) this.keptKeyCache = { syncKey: key, key: await routineKey(key) };
    return this.keptKeyCache.key;
  },

  /** Repository `slug`'s kept routine: its URL and token, `{ broken: true }` when it can't be opened, or null. */
  async keptRoutine(slug) {
    const row = this.sql.exec('SELECT sealed FROM kept_routines WHERE slug = ?', slug).toArray()[0];
    if (!row) return null;
    try {
      return await openRoutine(await this.keptRoutineKey(), slug, row.sealed);
    } catch {
      return { broken: true };
    }
  },

  /**
   * Repository `slug`'s routine, or null while it has none: the Secrets Store's when agents-connect put one there
   * (the default repository's two secrets, or its entry in ROUTINES), else the one kept on the board.
   * @returns {Promise<RepoRoutine | null>}
   */
  async repoRoutine(slug) {
    const fromSecrets = await routineCredentials(this.env, slug === this.defaultRepoSlug() ? null : slug);
    if (fromSecrets) return { ...fromSecrets, source: 'secrets' };
    const kept = await this.keptRoutine(slug);
    return kept ? { ...kept, source: 'board' } : null;
  },

  /** Drops repository `slug`'s kept routine, if it has one. */
  dropKeptRoutine(slug) {
    this.sql.exec('DELETE FROM kept_routines WHERE slug = ?', slug);
  },

  /**
   * The kept routines sealed again under `newSyncKey`, for a rotation to write in its transaction (WebCrypto is
   * async, so it can't run inside one). One that can't be opened stays as it is: it was broken already.
   * @returns {Promise<{ slug: string, sealed: string }[]>}
   */
  async resealedRoutines(newSyncKey) {
    const rows = this.sql.exec('SELECT slug, sealed FROM kept_routines').toArray();
    if (!rows.length) return [];
    const [from, to] = await Promise.all([this.keptRoutineKey(), routineKey(newSyncKey)]);
    const out = [];
    for (const row of rows) {
      try {
        out.push({
          slug: row.slug,
          sealed: await sealRoutine(to, row.slug, await openRoutine(from, row.slug, row.sealed)),
        });
      } catch {
        // Can't be opened with the key in use either; Connections already says to connect it again.
      }
    }
    return out;
  },

  /**
   * Whether the request's person may do `what`: connections and secrets are the owner's (BRK-301), and a GitHub
   * environment a maintainer's of `repo`. An agent never does.
   */
  ownerOnlyRoutineKeep(body, what, action = 'repo.routine', repo = null) {
    this.allow(body, action, repo, `only the owner ${what}`);
  },

  /**
   * PUT /api/repos/<slug>/routine (the signed-in owner; the Worker refuses the bearer token): connects or replaces
   * the repository's routine from its /fire URL and token, checked the way agents-connect checks them, sealed, and
   * never given back. Says whether the Secrets Store's routine, from agents-connect, wins over it.
   */
  repoRoutineConnectApi(slug, body) {
    return this.run(async () => {
      this.ownerOnlyRoutineKeep(body, 'connects a routine');
      const repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      const checked = checkRoutine(body ?? {});
      if ('error' in checked) throw new AgentError(`${checked.error}. Nothing was stored.`, 400);
      const sealed = await sealRoutine(await this.keptRoutineKey(), repo.slug, checked);
      const now = Date.now();
      const replaced = this.sql.exec('SELECT 1 FROM kept_routines WHERE slug = ?', repo.slug).toArray().length > 0;
      this.sql.exec(
        'INSERT INTO kept_routines (slug, sealed, created, edited) VALUES (?, ?, ?, ?) ON CONFLICT (slug) DO UPDATE SET sealed = excluded.sealed, edited = excluded.edited',
        repo.slug,
        sealed,
        now,
        now,
      );
      const routine = await this.repoRoutine(repo.slug);
      return { status: replaced ? 200 : 201, body: { ok: true, ...this.routineState(repo.slug, routine, replaced) } };
    });
  },

  /** DELETE /api/repos/<slug>/routine (the signed-in owner): forgets the routine kept on the board. */
  repoRoutineForgetApi(slug, body) {
    return this.run(async () => {
      this.ownerOnlyRoutineKeep(body, 'forgets a routine');
      const name = String(slug).toLowerCase();
      const repo = this.repoBySlug(name);
      if (!repo) throw new AgentError(`no repository "${name.slice(0, 40)}"`, 404);
      const had = this.sql.exec('DELETE FROM kept_routines WHERE slug = ? RETURNING slug', repo.slug).toArray().length;
      if (!had) throw new AgentError(`${repo.slug} has no routine kept on the board`, 404);
      return { status: 200, body: { ok: true, ...this.routineState(repo.slug, await this.repoRoutine(repo.slug)) } };
    });
  },

  /** What the form may know about a repository's routine: never its URL or token. */
  routineState(slug, routine, replaced = false) {
    return {
      repo: slug,
      connected: Boolean(routine && !('broken' in routine)),
      source: routine?.source ?? null,
      ...(replaced ? { replaced: true } : {}),
      // agents-connect's routine wins while it's in the Secrets Store: the one kept here waits behind it.
      secretsStoreWins: routine?.source === 'secrets',
    };
  },
};
