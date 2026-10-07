/**
 * TaskStore's Packages feed (BRK-101): the npm versions a repository's workflow runs say they staged, read from the
 * runs' annotations through the GitHub App, and whether each is published yet, from npm's public registry. Read-only:
 * the board never publishes or approves anything on npm. Approving a staged version needs the owner's 2FA there, so the
 * feed only says a version waits and links to its package's page on npm.
 *
 * The registry is read only for the packages a repository's runs name, and only while one of their versions is still
 * staged (or its dist-tags were never read). Its last read and any failure show on Connections.
 *
 * Each package's active versions, its latest pre-release and its latest release, are kept in gh_package_active
 * (BRK-152): they're never pruned and always in the feed, however many pre-releases came after them.
 */
import { GitHubError } from './github.js';
import { REGISTRY, distTags, packageUrl, registryUrl, stagedIn } from './packages.js';
import { clip } from './connections.js';
import {
  aheadOfPrerelease,
  packageOf,
  prereleaseBuild,
  prereleaseByHand,
  releaseOffer,
  releasedFrom,
} from './release.js';

/** Runs whose annotations are read per sync, newest first; the rest wait for the next one. */
const MAX_RUNS = 5;
/** Registry reads per sync, at most. */
const MAX_READS = 10;
/** How often a staged version is asked about again: soon after it's staged, then hourly once it's a day old. */
const RECHECK_MS = 5 * 60_000;
const RECHECK_OLD_MS = 3_600_000;
const OLD_MS = 86_400_000;
/** Versions kept per repository, and how many the feed shows. */
const KEEP = 100;
const SHOWN = 50;
/** Pre-releases whose Release dialog says what main has since them (WEB-113), newest first. */
const BEHIND_SHOWN = 10;
/** How long the read of whether a release workflow builds pre-releases by hand is kept (WEB-113). */
const RELEASE_MODE_MS = 86_400_000;
/** How long a registry read may take before it counts as failed. */
const TIMEOUT_MS = 10_000;

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** Whether a version is a pre-release (`1.3.0-main.4`): a hyphen before any build metadata. */
const kindOf = (version) => (String(version).split('+')[0].includes('-') ? 'prerelease' : 'release');

/** Matches a gh_packages row that is one of its package's active versions. */
const ACTIVE = `EXISTS (SELECT 1 FROM gh_package_active a
  WHERE a.repo = gh_packages.repo AND a.name = gh_packages.name AND a.version = gh_packages.version)`;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const packagesMethods = {
  initPackages() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gh_packages (
        repo TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, tag TEXT NOT NULL, state TEXT NOT NULL,
        run INTEGER NOT NULL, data TEXT NOT NULL, staged TEXT NOT NULL, checked INTEGER, published INTEGER,
        PRIMARY KEY (repo, name, version)
      );
      CREATE TABLE IF NOT EXISTS gh_package_tags (repo TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL, checked INTEGER NOT NULL, PRIMARY KEY (repo, name));
      CREATE TABLE IF NOT EXISTS gh_annotated (repo TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (repo, id));
      CREATE TABLE IF NOT EXISTS gh_package_active (repo TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (repo, name, kind));
    `);
  },

  /**
   * Reads the annotations of `runs` (GitHub's workflow runs, as the sync fetched them) that finished and weren't read
   * yet, and keeps each version they say was staged. A run is read once; one GitHub won't show (403, 404) is skipped.
   * Throws a GitHubError for anything else, and the run is tried again on the next sync.
   */
  async readPackages(client, slug, runs) {
    const done = new Set(
      this.sql
        .exec('SELECT id FROM gh_annotated WHERE repo = ?', slug)
        .toArray()
        .map((r) => r.id),
    );
    const todo = runs
      .filter((r) => r.status === 'completed' && r.check_suite_id && !done.has(r.id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, MAX_RUNS);
    for (const run of todo) {
      let found;
      try {
        found = await this.stagedInRun(client, run);
      } catch (error) {
        if (!(error instanceof GitHubError && [403, 404].includes(error.status))) throw error;
        found = [];
      }
      this.ctx.storage.transactionSync(() => {
        for (const p of found) {
          // A version staged again (a re-run) keeps its first run and what the registry already said.
          this.sql.exec(
            `INSERT OR IGNORE INTO gh_packages (repo, name, version, tag, state, run, data, staged)
             VALUES (?, ?, ?, ?, 'staged', ?, ?, ?)`,
            slug,
            p.name,
            p.version,
            p.tag,
            run.id,
            // The commit it was built from (WEB-113), so main's merges since a pre-release can be counted.
            JSON.stringify({
              url: run.html_url ?? null,
              workflow: run.name ?? null,
              number: run.run_number ?? null,
              sha: run.head_sha ?? null,
            }),
            run.created_at ?? new Date().toISOString(),
          );
        }
        this.sql.exec('INSERT OR IGNORE INTO gh_annotated (repo, id) VALUES (?, ?)', slug, run.id);
      });
    }
    this.keepActive(slug);
    this.sql.exec(
      `DELETE FROM gh_packages WHERE repo = ?1 AND rowid NOT IN (SELECT rowid FROM gh_packages WHERE repo = ?1 ORDER BY staged DESC LIMIT ${KEEP}) AND NOT ${ACTIVE}`,
      slug,
    );
    // The runs the sync keeps are the ones worth remembering as read.
    this.sql.exec(
      'DELETE FROM gh_annotated WHERE repo = ?1 AND id NOT IN (SELECT id FROM gh_runs WHERE repo = ?1)',
      slug,
    );
  },

  /**
   * Records each of `slug`'s packages' active versions: its newest pre-release and newest release, staged or published.
   * The active ones are never pruned, so the newest kept version of each kind is always the active one or newer.
   */
  keepActive(slug) {
    const seen = new Set();
    const rows = this.sql
      .exec('SELECT name, version FROM gh_packages WHERE repo = ? ORDER BY staged DESC, rowid DESC', slug)
      .toArray();
    for (const r of rows) {
      const kind = kindOf(r.version);
      const key = `${r.name}\n${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.sql.exec(
        'INSERT OR REPLACE INTO gh_package_active (repo, name, kind, version) VALUES (?, ?, ?, ?)',
        slug,
        r.name,
        kind,
        r.version,
      );
    }
  },

  /** What one run's notices say it staged: its check runs with annotations, then their notice annotations. */
  async stagedInRun(client, run) {
    const { check_runs: checks = [] } = await client.get(`/check-suites/${run.check_suite_id}/check-runs?per_page=100`);
    const found = [];
    for (const check of checks) {
      if (!check.output?.annotations_count) continue;
      const annotations = await client.get(`/check-runs/${check.id}/annotations?per_page=100`);
      for (const a of Array.isArray(annotations) ? annotations : []) {
        if (a.annotation_level === 'notice') found.push(...stagedIn(a.message));
      }
    }
    return found;
  },

  /**
   * Asks npm's registry about `slug`'s staged versions that are due a check: 200 for a version means it's published,
   * 404 that it's still staged. Reads each such package's dist-tags too. Never throws: a failure is kept for
   * Connections, and the versions are asked about again on the next sync.
   */
  async checkRegistry(slug, now = Date.now()) {
    const due = this.sql
      .exec("SELECT name, version, staged, checked FROM gh_packages WHERE repo = ? AND state = 'staged'", slug)
      .toArray()
      .filter((r) => {
        const every = now - Date.parse(r.staged) > OLD_MS ? RECHECK_OLD_MS : RECHECK_MS;
        return !r.checked || now - r.checked >= every;
      });
    const untagged = this.sql
      .exec(
        'SELECT DISTINCT p.name FROM gh_packages p LEFT JOIN gh_package_tags t ON t.repo = p.repo AND t.name = p.name WHERE p.repo = ? AND t.name IS NULL',
        slug,
      )
      .toArray()
      .map((r) => r.name);
    const names = [...new Set([...due.map((r) => r.name), ...untagged])];
    if (!names.length) return { reads: 0 };
    const base = this.env.TASKS_NPM_REGISTRY || REGISTRY;
    let reads = 0;
    try {
      for (const name of names) {
        if (reads >= MAX_READS) break;
        const meta = await registryGet(registryUrl(name, null, base), true);
        reads += 1;
        // A 404 (nothing published under the name yet) is kept as no tags, so it isn't read on every sync.
        this.sql.exec(
          'INSERT OR REPLACE INTO gh_package_tags (repo, name, tags, checked) VALUES (?, ?, ?, ?)',
          slug,
          name,
          JSON.stringify(meta.status === 200 ? distTags(meta.body) : {}),
          now,
        );
      }
      for (const row of due) {
        if (reads >= MAX_READS) break;
        const { status } = await registryGet(registryUrl(row.name, row.version, base));
        reads += 1;
        if (status === 200)
          this.sql.exec(
            "UPDATE gh_packages SET state = 'published', published = ?, checked = ? WHERE repo = ? AND name = ? AND version = ?",
            now,
            now,
            slug,
            row.name,
            row.version,
          );
        else
          this.sql.exec(
            'UPDATE gh_packages SET checked = ? WHERE repo = ? AND name = ? AND version = ?',
            now,
            slug,
            row.name,
            row.version,
          );
      }
      this.setMeta('npm_last', now);
      this.setMeta('npm_error', null);
      this.setMeta('npm_error_at', null);
    } catch (error) {
      this.setMeta('npm_error', clip(error.message));
      this.setMeta('npm_error_at', now);
    }
    return { reads };
  },

  /** `slug`'s Packages feed, newest first (the newest versions, and each package's active ones however old), and each package's dist-tags as npm last said them. */
  packagesOf(slug) {
    const tags = new Map(
      this.sql
        .exec('SELECT name, tags, checked FROM gh_package_tags WHERE repo = ?', slug)
        .toArray()
        .map((r) => [r.name, { tags: JSON.parse(r.tags), checked: r.checked }]),
    );
    const versions = this.sql
      .exec(
        `SELECT * FROM gh_packages WHERE repo = ?1 AND (rowid IN (SELECT rowid FROM gh_packages WHERE repo = ?1 ORDER BY staged DESC LIMIT ${SHOWN}) OR ${ACTIVE})
         ORDER BY staged DESC`,
        slug,
      )
      .toArray()
      .map((r) => {
        const run = JSON.parse(r.data);
        return {
          repo: slug,
          name: r.name,
          version: r.version,
          tag: r.tag,
          state: r.state,
          staged: r.staged,
          published: iso(r.published),
          checked: iso(r.checked),
          run: { id: r.run, url: run.url, workflow: run.workflow, number: run.number },
          url: packageUrl(r.name, r.state === 'published' ? r.version : null),
        };
      });
    // Release on each pre-release of the package the pipeline names (WEB-39), worked out from every version kept.
    const offers = this.releaseOffers(slug);
    for (const v of versions) {
      const offer = offers?.(v);
      if (offer) v.release = offer;
    }
    const packages = [...new Set(versions.map((v) => v.name))].map((name) => ({
      repo: slug,
      name,
      url: packageUrl(name),
      tags: tags.get(name)?.tags ?? {},
      checked: iso(tags.get(name)?.checked),
      waiting: versions.filter((v) => v.name === name && v.state === 'staged').length,
    }));
    return { versions, packages };
  },

  /**
   * Release for `slug`'s pre-releases (WEB-39): a function from a feed version to its offer (src/release.js
   * releaseOffer), or null when the repository's pipeline names no package. Only that package's pre-releases get one.
   */
  releaseOffers(slug) {
    const pkg = packageOf(this.repoBySlug(slug));
    if (!pkg) return null;
    const versions = this.sql
      .exec('SELECT version, state FROM gh_packages WHERE repo = ? AND name = ?', slug, pkg.name)
      .toArray()
      .map((r) => ({ version: String(r.version), state: String(r.state) }));
    const events = this.sql
      .exec('SELECT data FROM gh_events WHERE repo = ? AND data LIKE \'%"release_started"%\'', slug)
      .toArray()
      .map((r) => JSON.parse(r.data))
      .filter((e) => e.kind === 'release_started' && e.package === pkg.name);
    const from = releasedFrom(JSON.parse(this.ghMeta('gh_tags', slug) ?? '[]'), events, pkg.prefix);
    const preparing = this.preparingVersion(slug);
    return (v) => (v.name === pkg.name ? releaseOffer(versions, v.version, { from, preparing }) : null);
  },

  /**
   * Build a pre-release (WEB-113) for repository `repo`: null unless its pipeline names a package and its release
   * workflow builds pre-releases only by hand (as the last read of it said, `gh_release_mode`). Else what main has
   * since the latest pre-release, CI on main's latest commit, the build the owner last started, and `behind`: for each
   * of the package's pre-releases whose commit is known, what main has since it, for the Release dialog's warning.
   * `prs` are the view's pull requests with their tasks, `runs` the stored runs. Reads nothing from GitHub.
   * @param {any} repo
   * @param {{ prs?: any[], runs?: any[], now?: number }} [context]
   */
  releaseBuildOf(repo, { prs = [], runs = [], now = Date.now() } = {}) {
    const pkg = packageOf(repo);
    if (!pkg) return null;
    const mode = JSON.parse(this.ghMeta('gh_release_mode', repo.slug) ?? 'null');
    if (!mode?.byHand || mode.workflow !== pkg.workflow) return null;
    const commits = this.sql
      .exec('SELECT data FROM gh_commits WHERE repo = ? ORDER BY date DESC', repo.slug)
      .toArray()
      .map((r) => JSON.parse(r.data));
    const tags = new Map(JSON.parse(this.ghMeta('gh_tags', repo.slug) ?? '[]').map((t) => [t.name, t.sha ?? null]));
    const runSha = new Map(runs.map((r) => [r.id, r.sha ?? null]));
    const pres = this.sql
      .exec(
        'SELECT version, run, data, staged FROM gh_packages WHERE repo = ? AND name = ? ORDER BY staged DESC',
        repo.slug,
        pkg.name,
      )
      .toArray()
      .filter((r) => String(r.version).includes('-'))
      .map((r) => ({
        version: String(r.version),
        staged: String(r.staged),
        // The run's commit, else its tag's, else the run's as the board still has it.
        sha: JSON.parse(r.data).sha ?? tags.get(`${pkg.prefix}${r.version}`) ?? runSha.get(r.run) ?? null,
      }));
    /** @type {Record<string, any>} */
    const behind = {};
    // The newest few: an older pre-release's stable is usually out, so Release doesn't offer it.
    for (const p of pres.slice(0, BEHIND_SHOWN)) {
      const ahead = aheadOfPrerelease({ commits, sha: p.sha, prs });
      if (ahead) behind[p.version] = ahead;
    }
    const latest = pres[0] ?? null;
    const started = this.sql
      .exec(
        `SELECT at FROM gh_events WHERE repo = ? AND data LIKE '%"prerelease_started"%' ORDER BY at DESC LIMIT 1`,
        repo.slug,
      )
      .toArray()[0]?.at;
    const build = prereleaseBuild({
      workflow: pkg.workflow,
      branch: pkg.branch,
      ahead: latest ? (behind[latest.version] ?? null) : null,
      runs,
      started: started ? Number(started) : null,
      latest,
      headSha: commits[0]?.sha ?? null,
      now,
    });
    return {
      ...build,
      package: pkg.name,
      latest: latest && { version: latest.version, staged: latest.staged },
      behind,
    };
  },

  /**
   * Reads whether `repo`'s release workflow builds pre-releases only by hand (WEB-113), from its file on the default
   * branch: one read, kept until a push changes a workflow or a day passes. Nothing without a package. A file the
   * board can't read builds nothing by hand, so Build a pre-release stays hidden.
   */
  async refreshReleaseMode(client, repo) {
    const pkg = packageOf(repo);
    if (!pkg) {
      this.setGhMeta('gh_release_mode', repo.slug, null);
      return;
    }
    const kept = JSON.parse(this.ghMeta('gh_release_mode', repo.slug) ?? 'null');
    if (kept && kept.workflow === pkg.workflow && kept.branch === pkg.branch && Date.now() - kept.at < RELEASE_MODE_MS)
      return;
    let byHand = false;
    try {
      const file = await client.get(
        `/contents/.github/workflows/${encodeURIComponent(pkg.workflow)}?ref=${encodeURIComponent(pkg.branch)}`,
      );
      const bytes = Uint8Array.from(atob(String(file.content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0));
      byHand = prereleaseByHand(new TextDecoder().decode(bytes));
    } catch (error) {
      if (!(error instanceof GitHubError) || ![403, 404].includes(error.status)) throw error;
    }
    this.setGhMeta(
      'gh_release_mode',
      repo.slug,
      JSON.stringify({ workflow: pkg.workflow, branch: pkg.branch, byHand, at: Date.now() }),
    );
  },

  /** What Connections shows for npm: when the registry last answered, and its last failure. */
  npmState() {
    const packages = this.sql.exec('SELECT COUNT(DISTINCT name) AS n FROM gh_packages').one().n;
    const waiting = this.sql.exec("SELECT COUNT(*) AS n FROM gh_packages WHERE state = 'staged'").one().n;
    return {
      packages,
      waiting,
      last: Number(this.meta('npm_last') ?? 0) || null,
      error: this.meta('npm_error') ?? null,
      errorAt: Number(this.meta('npm_error_at') ?? 0) || null,
    };
  },

  /** GET /api/github/packages: one repository's feed (the default's when none), or every repository's with `all`. */
  async packagesApi(slug = null) {
    await this.ready();
    const repos = slug === 'all' ? this.repos() : [this.githubRepo(slug)];
    if (!repos[0]) return { status: 404, body: { error: `no repository "${String(slug).slice(0, 40)}"` } };
    const feeds = repos.map((r) => this.packagesOf(r.slug));
    const npm = this.npmState();
    return {
      status: 200,
      body: {
        versions: feeds.flatMap((f) => f.versions).sort((a, b) => b.staged.localeCompare(a.staged)),
        packages: feeds.flatMap((f) => f.packages),
        npm: { lastRead: iso(npm.last), error: npm.error },
      },
    };
  },
};

/** One read of npm's public registry: its status, and the JSON body of a 200. Throws on anything but 200 or 404. */
async function registryGet(url, abbreviated = false) {
  const res = await fetch(url, {
    headers: { Accept: abbreviated ? 'application/vnd.npm.install-v1+json' : 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) await res.body?.cancel();
  if (res.status === 404) return { status: 404, body: null };
  if (res.status !== 200) throw new Error(`npm's registry answered ${res.status} for ${new URL(url).pathname}`);
  return { status: 200, body: await res.json() };
}
