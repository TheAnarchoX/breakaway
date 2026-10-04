/**
 * TaskStore's registry of repositories (docs/specs/IDEA-14-multi-repo.md, sections 1 and 2): the `repos`
 * table, the legacy repository registered from today's settings the first time it's read on an install from before
 * repositories, and the owner-only API to add and change repositories. Tasks name their repository in the
 * `repo` property; none means the default. A fresh install starts with none, and the first one its owner
 * registers is its default (CLD-131).
 */
import { appCredentials, appGet, GitHubClient } from './github.js';
import { AgentError, routineCredentials } from './store-agents.js';
import { InputError } from './model.js';
import {
  NO_REPO,
  JSON_FIELDS,
  areasOf,
  checkRepo,
  defaultRepo,
  list,
  prefixFor,
  repoSlugOf,
  seedsDefault,
} from './repos.js';

const WID = /^([A-Z]+)-\d+$/u;
const GITHUB = /^[\w.-]{1,39}\/[\w.-]{1,100}$/u;

const parse = (text) => (text ? JSON.parse(text) : null);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const reposMethods = {
  initRepos() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        slug TEXT PRIMARY KEY, github TEXT NOT NULL, name TEXT NOT NULL, default_branch TEXT NOT NULL,
        areas TEXT NOT NULL, pipeline TEXT, routine TEXT, settings TEXT, is_default INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, edited INTEGER NOT NULL
      );
    `);
    // Taken off the board (CLD-191): the row stays, so its finished tasks keep their chip and its prefixes stay its own.
    const columns = this.sql
      .exec('PRAGMA table_info(repos)')
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('removed')) this.sql.exec('ALTER TABLE repos ADD COLUMN removed INTEGER');
    // One registration per GitHub repository among those on the board; a removed one may come back under a new slug.
    this.sql.exec('DROP INDEX IF EXISTS repos_github');
    this.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS repos_github_active ON repos (lower(github)) WHERE removed IS NULL',
    );
    if (!this.sql.exec('SELECT COUNT(*) AS n FROM repos').one().n) {
      if (seedsDefault(this.env)) this.insertRepo(defaultRepo(this.env), true);
      // A fresh install: Connections walks its owner through setting it up, from registering a repository on.
      else this.setMeta('first_run', new Date().toISOString());
    }
    this.repoCache = null;
  },

  insertRepo(row, isDefault = false) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO repos (slug, github, name, default_branch, areas, pipeline, routine, settings, is_default, created, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.slug,
      row.github,
      row.name,
      row.defaultBranch,
      JSON.stringify(row.areas),
      ...JSON_FIELDS.map((k) => (row[k] ? JSON.stringify(row[k]) : null)),
      isDefault ? 1 : 0,
      now,
      now,
    );
    this.repoCache = null;
  },

  /** Every registered repository, the default first. Cached until one changes. Removed ones aren't in it. */
  repos() {
    this.repoCache ??= this.sql
      .exec('SELECT * FROM repos WHERE removed IS NULL ORDER BY is_default DESC, slug')
      .toArray()
      .map((r) => ({
        slug: r.slug,
        github: r.github,
        name: r.name,
        defaultBranch: r.default_branch,
        areas: JSON.parse(r.areas),
        pipeline: parse(r.pipeline),
        routine: parse(r.routine),
        settings: parse(r.settings),
        isDefault: Boolean(r.is_default),
        created: new Date(r.created).toISOString(),
        edited: new Date(r.edited).toISOString(),
      }));
    return this.repoCache;
  },

  /** Repositories taken off the board (CLD-191), for their tasks' chips and the slugs and prefixes they keep. */
  removedRepos() {
    return this.sql
      .exec('SELECT slug, github, name, areas, removed FROM repos WHERE removed IS NOT NULL ORDER BY slug')
      .toArray()
      .map((r) => ({
        slug: r.slug,
        github: r.github,
        name: r.name,
        areas: JSON.parse(r.areas),
        removed: new Date(r.removed).toISOString(),
      }));
  },

  defaultRepoSlug() {
    return this.repos().find((r) => r.isDefault)?.slug ?? NO_REPO;
  },

  /** Whether this install started empty (CLD-131), so Connections shows its setup steps. */
  firstRunInstall() {
    return Boolean(this.meta('first_run'));
  },

  repoBySlug(slug) {
    return this.repos().find((r) => r.slug === slug) ?? null;
  },

  /** The registered repository a task belongs to, or null when its `repo` names one that isn't registered. */
  repoOfTask(map) {
    return this.repoBySlug(repoSlugOf(map, this.defaultRepoSlug()));
  },

  /** A `repo` someone gave → a registered slug (the default when empty). */
  checkRepoSlug(value) {
    if (!this.repos().length)
      throw new InputError(
        'no repository yet: register one first, on the Connections view or with npx breakaway repos add <slug> <owner/name> --area product:PRD',
      );
    if (value === undefined || value === null || value === '') return this.defaultRepoSlug();
    const slug = String(value).trim().toLowerCase();
    if (!this.repoBySlug(slug))
      throw new InputError(
        `no repository "${slug.slice(0, 40)}"; registered: ${this.repos()
          .map((r) => r.slug)
          .join(
            ', ',
          )}. The owner registers one with npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>`,
      );
    return slug;
  },

  /** The prefix a task's area gets in its repository; refuses an area that isn't the repository's or shared. */
  checkAreaPrefix(slug, project) {
    if (!project) return null;
    const repo = this.repoBySlug(slug);
    const prefix = prefixFor(repo, project);
    if (!prefix)
      throw new InputError(
        `project is one of ${areasOf(repo).join(', ')}${this.repos().length > 1 ? ` in ${slug}` : ''}`,
      );
    return prefix;
  },

  /** The prefix for a task as it is, or null (no area, or an area its repository doesn't have). */
  prefixOfTask(map) {
    return prefixFor(this.repoOfTask(map), map.project);
  },

  /** `repo` as it's stored on a task: nothing for the default repository, so the first install's tasks never change. */
  storedRepo(slug) {
    return slug === this.defaultRepoSlug() ? null : slug;
  },

  /** A work ID set by hand can't take another repository's prefix: an ID means one task across the install. */
  checkWidPrefix(slug, wid) {
    const prefix = WID.exec(wid)?.[1];
    const owner = prefix && this.repos().find((r) => r.areas.some((a) => a.prefix === prefix));
    if (owner && owner.slug !== slug) throw new InputError(`${prefix} belongs to ${owner.slug}`);
  },

  /** Refuses claiming a task of another repository than `slug` (the checkout's), with the fix. */
  checkClaimRepo(uuid, slug) {
    const map = this.tasks.get(uuid);
    const own = repoSlugOf(map, this.defaultRepoSlug());
    if (own === slug) return;
    const where = this.repoBySlug(own);
    const id = map.wid ?? uuid.slice(0, 8);
    throw new AgentError(
      `${id} belongs to ${own}${where ? ` (${where.github})` : ''}, and this checkout is ${slug}. Work on it from a checkout of ${own}, or claim it with --repo ${own} if you mean to.`,
      409,
    );
  },

  ownerOnlyRepos(by) {
    if (by !== undefined && by !== null && by !== '' && by !== 'owner')
      throw new AgentError('only the owner adds, changes, or removes repositories', 403);
  },

  /** prefix → the repository of a task that already has a work ID with it. */
  usedPrefixes() {
    const used = new Map();
    const fallback = this.defaultRepoSlug();
    for (const map of this.tasks.values()) {
      const m = WID.exec(map.wid ?? '');
      if (m && !used.has(m[1])) used.set(m[1], repoSlugOf(map, fallback));
    }
    return used;
  },

  reposApi() {
    return this.run(() =>
      ok({
        repos: this.repos(),
        default: this.repos().find((r) => r.isDefault)?.slug ?? null,
        firstRun: this.firstRunInstall(),
        removed: this.removedRepos(),
      }),
    );
  },

  /**
   * GET /api/repos/<slug> (anyone signed in; BRK-129): one repository for its settings page. The row (a removed
   * one's, with `removed` set, for its read-only page), each area's open and total tasks (total counts every task
   * the area-removal check counts), whether its routine is connected (a yes or no, never its URL or token), how many
   * saved routines run in it, its open tasks and running agents, and GitHub's default branch when the App can read
   * it. A removed repository says why it can't be released (`releaseBlocker`), or null when it can.
   */
  repoApi(slug) {
    return this.run(async () => {
      const name = String(slug).toLowerCase();
      const row = this.repoBySlug(name);
      const gone = row ? null : this.removedRepos().find((r) => r.slug === name);
      if (!row && !gone) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      const fallback = this.defaultRepoSlug();
      const tasks = [...this.tasks.values()].filter((m) => repoSlugOf(m, fallback) === name);
      const isOpen = (m) => ['pending', 'waiting'].includes(m.status);
      const areas = (row ?? gone).areas.map((a) => {
        const inArea = tasks.filter((m) => m.project === a.project);
        return { ...a, open: inArea.filter(isOpen).length, total: inArea.length };
      });
      const isDefault = Boolean(row?.isDefault);
      const routines = this.sql
        .exec(
          `SELECT COUNT(*) AS n FROM routines WHERE repo = ?${isDefault ? " OR repo IS NULL OR repo = ''" : ''}`,
          name,
        )
        .one().n;
      return ok({
        repo: row ?? gone,
        removed: gone?.removed ?? null,
        areas,
        ...(await this.routineConnectedState(name)),
        routines,
        open: tasks.filter(isOpen).length,
        running: row
          ? this.runningAgents(this.views()).filter(({ task }) => repoSlugOf(task, fallback) === name).length
          : 0,
        githubDefaultBranch: row ? await this.githubDefaultBranch(row.github) : null,
        ...(gone ? { releaseBlocker: this.releaseBlocker(gone) } : {}),
      });
    });
  },

  /**
   * The default branch GitHub reports for `github` (owner/name), read through the App, or null when it can't
   * be read (no App yet, not installed, GitHub unreachable): registering never waits on it.
   */
  async githubDefaultBranch(github) {
    try {
      const credentials = await appCredentials(this.env);
      const name = String(github ?? '')
        .trim()
        .replace(/^https:\/\/github\.com\//u, '')
        .replace(/\.git$/u, '');
      if (!credentials || !GITHUB.test(name)) return null;
      const base = this.env.TASKS_GITHUB_API || undefined;
      const installation = await appGet(credentials, `/repos/${name}/installation`, base);
      const [owner, repo] = name.split('/');
      const info = await new GitHubClient(
        credentials,
        { owner, repo, full: name },
        { installationId: installation.id },
        base,
      ).get('');
      return typeof info?.default_branch === 'string' && info.default_branch ? info.default_branch : null;
    } catch {
      return null;
    }
  },

  reposAddApi(body) {
    return this.run(async () => {
      this.ownerOnlyRepos(body?.by);
      // Without a branch given, take GitHub's: a repository whose default isn't main would otherwise be registered wrong.
      if (
        body &&
        typeof body === 'object' &&
        (body.defaultBranch === undefined || body.defaultBranch === null || body.defaultBranch === '')
      ) {
        const branch = await this.githubDefaultBranch(body.github);
        const { defaultBranch: _none, ...rest } = body;
        body = branch ? { ...rest, defaultBranch: branch } : rest;
      }
      let row;
      try {
        row = checkRepo(body, {
          others: this.repos(),
          usedPrefixes: this.usedPrefixes(),
          removed: this.removedRepos(),
          caps: this.repoCapCeilings(),
        });
      } catch (error) {
        // A clash with a repository taken off the board that can be released says so, for the wizard's Release button (CLD-205).
        if (!(error instanceof InputError)) throw error;
        const releasable = this.releasableClashes(body);
        if (!releasable.length) throw error;
        return ok({ error: error.message, releasable }, 400);
      }
      // The wizard checks the form as it's filled in (CLD-194): the row it would register, or the clash, and nothing saved.
      if (body?.dryRun) return ok({ repo: row, dryRun: true });
      // The first repository registered is the default: on a fresh install, tasks without a repo are its.
      // It stays the default, since those tasks, its GitHub state, and its routine's secrets are keyed to it.
      this.insertRepo(row, !this.repos().length);
      // Tasks made in Taskwarrior before it was registered may now get their work IDs.
      this.assignMissingWids();
      // A kickoff that named this repository (BRK-131) gets its IDEA here, however it was registered.
      const kickoff = await this.kickoffRegistered(this.repoBySlug(row.slug));
      return ok({ repo: this.repoBySlug(row.slug), ...(kickoff ? { kickoff: kickoff.id } : {}) }, 201);
    });
  },

  reposModifyApi(slug, body) {
    return this.run(() => {
      this.ownerOnlyRepos(body?.by);
      const current = this.repoBySlug(String(slug).toLowerCase());
      if (!current) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      // The web app sends the row's last-changed time it loaded (BRK-129); a change made since wins, and the page
      // gets the row as it is now. The CLI sends none and saves as before.
      if (body && typeof body === 'object' && body.edited !== undefined && body.edited !== null) {
        const loaded = typeof body.edited === 'string' ? Date.parse(body.edited) : Number.NaN;
        if (Number.isNaN(loaded))
          throw new InputError('edited is the repository’s last-changed time, as GET /api/repos/<slug> gave it');
        if (loaded !== Date.parse(current.edited))
          return ok(
            {
              error: `${current.slug} changed somewhere else since you loaded it. Here’s what it is now: check it, then save your change again.`,
              repo: current,
            },
            409,
          );
      }
      const fallback = this.defaultRepoSlug();
      const inUse = (project) =>
        [...this.tasks.values()].some((m) => m.project === project && repoSlugOf(m, fallback) === current.slug);
      const row = checkRepo(body, {
        current,
        others: this.repos().filter((r) => r.slug !== current.slug),
        usedPrefixes: this.usedPrefixes(),
        inUse,
        removed: this.removedRepos(),
        caps: this.repoCapCeilings(),
      });
      // Checking a change as it's typed (BRK-129), as POST does: the row it would save, or the refusal, and nothing saved.
      if (body?.dryRun) return ok({ repo: row, dryRun: true });
      this.sql.exec(
        'UPDATE repos SET github = ?, name = ?, default_branch = ?, areas = ?, pipeline = ?, routine = ?, settings = ?, edited = ? WHERE slug = ?',
        row.github,
        row.name,
        row.defaultBranch,
        JSON.stringify(row.areas),
        ...JSON_FIELDS.map((k) => (row[k] ? JSON.stringify(row[k]) : null)),
        // Always later than the last change, so two saves in one millisecond still tell a stale edit apart.
        Math.max(Date.now(), Date.parse(current.edited) + 1),
        current.slug,
      );
      this.repoCache = null;
      // A new area may give waiting tasks (made in Taskwarrior before it existed) their work IDs.
      this.assignMissingWids();
      return ok({ repo: this.repoBySlug(current.slug) });
    });
  },

  /**
   * DELETE /api/repos/<slug> (the owner; CLD-191): takes a repository off the board. Its sync, webhooks, and
   * agents stop, and its saved routines are switched off; refused while it has open tasks or running agents
   * unless `force`. Its tasks stay, finished ones readable with their chip, and its slug and prefixes stay its
   * own, since a work ID means one task forever. The default repository can't be removed: tasks without a
   * repository are its. `routine` says whether its agent routine is still in the Secrets Store, which the CLI drops.
   */
  reposRemoveApi(slug, body) {
    return this.run(async () => {
      this.ownerOnlyRepos(body?.by);
      const current = this.repoBySlug(String(slug).toLowerCase());
      if (!current) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      if (current.isDefault)
        throw new AgentError(
          `${current.slug} is the default repository: tasks without a repository are its, so it stays`,
          409,
        );
      const fallback = this.defaultRepoSlug();
      const open = [...this.tasks.values()].filter(
        (m) => repoSlugOf(m, fallback) === current.slug && ['pending', 'waiting'].includes(m.status),
      ).length;
      const running = this.runningAgents(this.views()).filter(
        ({ task }) => repoSlugOf(task, fallback) === current.slug,
      ).length;
      if ((open || running) && !body?.force) {
        const what = [
          open && `${open} open task${open === 1 ? '' : 's'}`,
          running && `${running} running agent${running === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' and ');
        throw new AgentError(
          `${current.slug} has ${what}. Finish or delete them first, or remove it anyway with --force (they stay, readable, in a repository the board no longer runs).`,
          409,
        );
      }
      this.sql.exec('UPDATE repos SET removed = ?, edited = ? WHERE slug = ?', Date.now(), Date.now(), current.slug);
      this.repoCache = null;
      const routines = this.sql
        .exec(
          "UPDATE routines SET enabled = 0, disabled_reason = 'its repository was taken off the board' WHERE repo = ? AND enabled = 1 RETURNING slug",
          current.slug,
        )
        .toArray()
        .map((r) => r.slug);
      // A routine kept on the board goes with it (BRK-133); one in the Secrets Store is the owner's to drop.
      this.dropKeptRoutine(current.slug);
      if (this.ghCache) delete this.ghCache[current.slug];
      if (this.promptCache) delete this.promptCache[current.slug];
      return ok({
        removed: this.removedRepos().find((r) => r.slug === current.slug),
        open,
        running,
        routines,
        routine: Boolean(await routineCredentials(this.env, current.slug)),
      });
    });
  },

  /** Whether repository `slug`'s routine can start agents, and where it's kept (`secrets` or `board`): never its URL or token. */
  async routineConnectedState(slug) {
    const routine = await this.repoRoutine(slug);
    return { routineConnected: Boolean(routine && !('broken' in routine)), routineSource: routine?.source ?? null };
  },

  /** Why a repository taken off the board can't be released (CLD-205), or null when it can. */
  releaseBlocker(gone) {
    const prefixes = new Set(gone.areas.map((a) => a.prefix));
    const fallback = this.defaultRepoSlug();
    const tasks = [...this.tasks.values()].filter(
      (m) => repoSlugOf(m, fallback) === gone.slug || prefixes.has(WID.exec(m.wid ?? '')?.[1]),
    ).length;
    if (tasks)
      return `${gone.slug} has ${tasks} task${tasks === 1 ? '' : 's'}, so its slug and prefixes stay its own: a work ID means one task forever`;
    const routines = this.sql
      .exec('SELECT slug FROM routines WHERE repo = ? ORDER BY slug', gone.slug)
      .toArray()
      .map((r) => r.slug);
    if (routines.length)
      return `${gone.slug} still has the saved routine${routines.length === 1 ? '' : 's'} ${routines.join(', ')}; move ${routines.length === 1 ? 'it' : 'them'} to another repository first (routines modify <slug> --repo <slug>)`;
    return null;
  },

  /** The removed repositories a registration clashes with, by slug or prefix, that could be released. */
  releasableClashes(body) {
    const slug = String(body?.slug ?? '')
      .trim()
      .toLowerCase();
    const wanted = new Set(
      [...list(body?.areas), ...list(body?.addAreas)]
        .map((a) => (typeof a === 'object' ? a?.prefix : String(a).split(':')[1])?.trim())
        .filter(Boolean),
    );
    return this.removedRepos()
      .filter((r) => r.slug === slug || r.areas.some((a) => wanted.has(a.prefix)))
      .filter((r) => !this.releaseBlocker(r))
      .map((r) => r.slug);
  },

  /**
   * POST /api/repos/<slug>/release (the owner; CLD-205): forgets a repository taken off the board, so its slug
   * and prefixes can be given again, as after registering one by mistake. Only while no task, of any status,
   * is in it or has one of its prefixes, and no saved routine names it, so a work ID still means one task
   * forever. Its leftover GitHub state goes with it.
   */
  reposReleaseApi(slug, body) {
    return this.run(() => {
      this.ownerOnlyRepos(body?.by);
      const name = String(slug).toLowerCase();
      if (this.repoBySlug(name))
        throw new AgentError(`${name} is still on the board; take it off first with repos remove ${name}`, 409);
      const gone = this.removedRepos().find((r) => r.slug === name);
      if (!gone) throw new AgentError(`no repository "${String(slug).slice(0, 40)}" taken off the board`, 404);
      const blocker = this.releaseBlocker(gone);
      if (blocker) throw new AgentError(blocker, 409);
      this.ctx.storage.transactionSync(() => {
        for (const table of ['gh_pulls', 'gh_dependabot', 'gh_runs', 'gh_commits', 'gh_deploys', 'gh_events'])
          this.sql.exec(`DELETE FROM ${table} WHERE repo = ?`, name);
        for (const key of [`conn_webhook_last:${name}`, `setup_claimed:${name}`]) this.setMeta(key, null);
        this.sql.exec('DELETE FROM repos WHERE slug = ? AND removed IS NOT NULL', name);
      });
      this.repoCache = null;
      return ok({ released: gone });
    });
  },
};

const ok = (body, status = 200) => ({ status, body });
