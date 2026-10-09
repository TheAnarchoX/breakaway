/**
 * TaskStore's GitHub half (docs/specs/CLD-24-github.md): pull requests, checks, reviews, CI
 * runs, commits on main, and Dependabot alerts in the Durable Object's SQLite, kept current by
 * webhooks (debounced through an alarm) and a reconcile every few minutes. Pull requests that
 * close a task put it in review and mark it done when they merge.
 *
 * Per repository (docs/specs/IDEA-14-multi-repo.md, section 3): every registered repository has its
 * own client and token cache, its rows carry a `repo` column, and each syncs on its own, so one
 * repository's failure or rate limit never stops another. A pull request closes only tasks of its
 * own repository. The default repository keeps the meta keys it always had (`gh_last_sync`, …);
 * another's are suffixed with `:<slug>`.
 */
import {
  GitHubClient,
  GitHubError,
  MERGE_INFO_PREVIEW,
  appCredentials,
  isEmptyRepo,
  appManifest,
  byInbox,
  deployFrom,
  detailsFromGraphql,
  linkedWids,
  ownLinks,
  prNumberOf,
  prState,
  prVerdict,
  pullDetailsQuery,
  repoRef,
  reviewDecision,
  rollupChecks,
  shippedPrs,
  widsIn,
} from './github.js';
import BOARD_FILES from './board-files.json' with { type: 'json' };
import { screenshotsIn } from './chase-digest.js';
import { budgetAfterSync, countsOf } from './github-budget.js';
import { syncPace } from './github-pace.js';
import { install } from './install.js';
import { NO_REPO, promptPathOf, repoSlugOf, slugOfGithub } from './repos.js';
import { promptPlaceholders } from './wizard.js';
import { allWorkers, compileDeployPaths, workersFor } from './deploy-paths.js';
import { pullAccess } from './github-access.js';
import { buildFlow, compareFacts, NEXT_STEPS, packageOf, pipelineOf, stableOf } from './release.js';
import { candidate, productionSha } from './promote.js';
import { checkInputs, dispatchOf, validRef } from './workflows.js';

const KEEP = { closedPrs: 100, runs: 200, commits: 100, events: 300, deploys: 100 };
const MAX_COMPARES = 10;
const MAX_DETAILS = 20;
const PAGE_FILES = 3; // 300 files; more are "too many to show", with a link to GitHub
/** The most of one file the pull request page reads whole for Preview (WEB-86): GitHub's contents API sends up to 1 MB. */
const PULL_FILE_MAX_BYTES = 1_000_000;
/** Images Preview shows, by extension. SVG is text, so it's read as text and the page draws it as an image. */
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};
/**
 * Pull requests whose files are read per repository per sync (BRK-316): each read is up to FILE_PAGES calls, and a
 * Worker's subrequests are counted (10,000 per invocation on Workers Paid by default:
 * https://developers.cloudflare.com/workers/platform/limits/#subrequests), so this caps them as it capped merged
 * pull requests' reads before.
 */
const MAX_FILES = 15;
const FILE_PAGES = 5;
const DEBOUNCE_MS = 5000;
/** A busy repository's sync this close to due goes with the alarm that's running now (BRK-272). */
const DUE_SLACK_MS = 5000;
/** How long a repository's agent prompt, read for the Agents view, is kept before reading it again. */
const PROMPT_CACHE_MS = 60_000;
/** Where a repository carries the board's core: where `repos init` copies it, then breakaway's own layout. */
const CORE_PATHS = ['tools/tasks/prompts/core.md', 'prompts/core.md'];
/** How long a repository's workflows that run by hand (BRK-224) are kept before reading them again. */
const WORKFLOWS_MS = 300_000;
/** At most this many workflow files are read per listing: a Worker's subrequests are counted. */
const MAX_WORKFLOW_FILES = 40;
/** How long another repository's deploy paths (read from its default branch) are kept before reading them again. */
const DEPLOY_PATHS_MS = 3_600_000;
/** What a task's note says when a Deployment carries it: per environment (CLD-106), with its repository's Workers. */
export function shipNote(deploy, workers = { staging: null, production: null }) {
  const version = deploy.version ?? deploy.sha.slice(0, 7);
  const where =
    deploy.env === workers.staging
      ? 'On staging in'
      : deploy.env === workers.production
        ? 'Live in'
        : `Live in ${deploy.env}`;
  return `${where} ${version} (${deploy.sha.slice(0, 7)}).`;
}
const iso = (ms) => new Date(ms).toISOString();
/** A pull request that names no repository was stored before there was more than one: the default's. */
const prRepo = (pr, fallback) => pr.repo ?? fallback;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const githubMethods = {
  initGitHub() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gh_prs (number INTEGER PRIMARY KEY, updated TEXT NOT NULL, state TEXT NOT NULL, applied TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_runs (id INTEGER PRIMARY KEY, created TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_commits (sha TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_alerts (number INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_deploys (id INTEGER PRIMARY KEY, env TEXT NOT NULL, state TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_shipped (wid TEXT PRIMARY KEY, version TEXT, sha TEXT NOT NULL, env TEXT NOT NULL, at TEXT NOT NULL, deploy INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_ships (wid TEXT NOT NULL, env TEXT NOT NULL, version TEXT, sha TEXT NOT NULL, at TEXT NOT NULL, deploy INTEGER NOT NULL, merge_sha TEXT, run TEXT, PRIMARY KEY (wid, env));
      INSERT OR IGNORE INTO gh_ships (wid, env, version, sha, at, deploy) SELECT wid, env, version, sha, at, deploy FROM gh_shipped;
      CREATE TABLE IF NOT EXISTS gh_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_pulls (repo TEXT NOT NULL, number INTEGER NOT NULL, updated TEXT NOT NULL, state TEXT NOT NULL, applied TEXT, data TEXT NOT NULL, PRIMARY KEY (repo, number));
      CREATE TABLE IF NOT EXISTS gh_dependabot (repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo, number));
    `);
    // Pull requests and alerts are numbered per repository, so they moved to tables keyed by both. The
    // old ones are copied once, as the default repository's (the one TASKS_GITHUB_REPO names), and left as they were (additive).
    const first = this.env.TASKS_GITHUB_REPO ? slugOfGithub(this.env.TASKS_GITHUB_REPO) : NO_REPO;
    if (!this.meta('gh_repo_tables')) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          'INSERT OR IGNORE INTO gh_pulls (repo, number, updated, state, applied, data) SELECT ?, number, updated, state, applied, data FROM gh_prs',
          first,
        );
        this.sql.exec(
          'INSERT OR IGNORE INTO gh_dependabot (repo, number, state, data) SELECT ?, number, state, data FROM gh_alerts',
          first,
        );
        this.setMeta('gh_repo_tables', 1);
      });
    }
    // Runs, commits, deploys, and events get a repository too; what's there is the default's.
    for (const table of ['gh_runs', 'gh_commits', 'gh_deploys', 'gh_events']) {
      if (
        !this.sql
          .exec(`PRAGMA table_info(${table})`)
          .toArray()
          .some((c) => c.name === 'repo')
      ) {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN repo TEXT NOT NULL DEFAULT '${first}'`);
      }
    }
    this.ghCache = {}; // slug → { installationId, token, expires }
  },

  // ---- repositories ----------------------------------------------------------------------

  /** A meta key per repository: the default repository's is the key it always had. */
  ghKey(name, slug) {
    return slug === this.defaultRepoSlug() ? name : `${name}:${slug}`;
  },

  ghMeta(name, slug) {
    return this.meta(this.ghKey(name, slug));
  },

  setGhMeta(name, slug, value) {
    this.setMeta(this.ghKey(name, slug), value);
  },

  /** The registered repository `slug` names (the default when none), or null. */
  githubRepo(slug = null) {
    return this.repoBySlug(slug ? String(slug).toLowerCase() : this.defaultRepoSlug());
  },

  /** A client for one repository, with that repository's own token cache. */
  githubClient(credentials, repo) {
    this.ghCache[repo.slug] ??= {};
    return new GitHubClient(
      credentials,
      repoRef(repo.github),
      this.ghCache[repo.slug],
      this.env.TASKS_GITHUB_API || undefined,
    );
  },

  /** Every registered prefix and the repository it belongs to, for linking pull requests to tasks. */
  prefixOwners() {
    const owners = new Map();
    for (const repo of this.repos()) for (const area of repo.areas) owners.set(area.prefix, repo.slug);
    return owners;
  },

  /** What a pull request in `slug` closes and mentions: closing another repository's task is only a mention. */
  linksOf(p, slug) {
    const owners = this.prefixOwners();
    return ownLinks(
      linkedWids({ title: p.title, body: p.body, branch: p.head?.ref }, [...owners.keys()]),
      slug,
      owners,
    );
  },

  /** A registered repository, or a 404 the API sends as it is. */
  githubRepoOr404(slug) {
    const repo = this.githubRepo(slug);
    return repo
      ? { repo }
      : { error: { status: 404, body: { error: `no repository "${String(slug).slice(0, 40)}"` } } };
  },

  // ---- setup -----------------------------------------------------------------------------

  /** A fresh `state` for GitHub's manifest flow (one hour), and the manifest to post. */
  async githubSetup(origin) {
    const state = crypto.randomUUID();
    this.setMeta('gh_setup_state', state);
    this.setMeta('gh_setup_expires', Date.now() + 3_600_000);
    return {
      state,
      manifest: appManifest(origin, repoRef(this.githubRepo().github), install(this.env).name),
      action: `https://github.com/settings/apps/new?state=${state}`,
    };
  },

  async githubCheckState(state) {
    const ok =
      Boolean(state) &&
      state === this.meta('gh_setup_state') &&
      Date.now() < Number(this.meta('gh_setup_expires') ?? 0);
    if (ok) this.setMeta('gh_setup_state', null);
    return ok;
  },

  // ---- webhooks and the alarm ------------------------------------------------------------

  /**
   * A verified webhook only schedules a reconcile of its repository (`full`, the delivery's
   * `repository.full_name`); a burst of check events becomes one. A repository that isn't registered
   * is ignored. A delivery without a repository (the App's installation events) reconciles them all.
   * `slug` names the repository directly, for the board's own writes.
   */
  async githubWebhook(event, action, { full = null, slug = null, workflowsChanged = false } = {}) {
    let repo = null;
    if (full) {
      repo = this.repos().find((r) => r.github.toLowerCase() === String(full).toLowerCase());
      if (!repo) return { status: 'ignored' };
    } else if (slug) {
      repo = this.githubRepo(slug);
    }
    const answer = {
      status: 'scheduled',
      repo: repo?.slug ?? null,
      isDefault: !repo || repo.slug === this.defaultRepoSlug(),
    };
    // Issues are only for routines (BRK-237): the board syncs nothing from them, so nothing to reconcile.
    if (event === 'issues') return answer;
    if (workflowsChanged && repo) this.dropWorkflows(repo.slug);
    if (event === 'installation' && (action === 'deleted' || action === 'suspend')) this.ghCache = {};
    const dirty = new Set(JSON.parse(this.meta('gh_dirty') ?? '[]'));
    dirty.add(repo ? repo.slug : '*');
    this.setMeta('gh_dirty', JSON.stringify([...dirty]));
    const pending = await this.ctx.storage.getAlarm();
    if (!pending) await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    return answer;
  },

  /** The repositories webhooks asked to reconcile since the last alarm (null: all of them), and forgets them. */
  takeDirtyRepos() {
    const dirty = JSON.parse(this.meta('gh_dirty') ?? '[]');
    this.setMeta('gh_dirty', null);
    return !dirty.length || dirty.includes('*') ? null : dirty;
  },

  /**
   * The repositories an alarm reconciles: the ones webhooks named, and, when it's the fast sync's alarm (BRK-272),
   * each busy repository whose sync is due. Another alarm with nothing named reconciles every one, as it always has.
   */
  alarmRepos(now = Date.now()) {
    const named = JSON.parse(this.meta('gh_dirty') ?? '[]');
    const dirty = this.takeDirtyRepos();
    const at = Number(this.meta('gh_fast_at') ?? 0);
    if (!at || at > now + DUE_SLACK_MS) return dirty;
    this.setMeta('gh_fast_at', null);
    if (named.includes('*')) return null;
    return [...new Set([...named, ...this.githubDue(now)])];
  },

  // ---- the fast sync (BRK-272) -----------------------------------------------------------

  /** The repositories with an open pull request whose checks run, or that an agent is on right now. */
  githubBusyRepos() {
    const busy = new Set();
    for (const row of this.sql.exec("SELECT repo, number, data FROM gh_pulls WHERE state = 'open'")) {
      if (busy.has(row.repo)) continue;
      const pr = JSON.parse(String(row.data));
      if (pr.checks?.state === 'pending' || this.prAgent({ ...pr, number: row.number, repo: row.repo }))
        busy.add(row.repo);
    }
    return busy;
  },

  /** How often a busy repository syncs now (null: no faster than the cron), and which are busy. */
  githubPace(now = Date.now()) {
    const busy = this.githubBusyRepos();
    const repos = this.repos().map((r) => ({
      slug: r.slug,
      budget: this.githubBudget(r.slug),
      busy: busy.has(r.slug),
    }));
    return { pace: syncPace(repos, now), busy: repos.filter((r) => r.busy).map((r) => r.slug) };
  },

  /**
   * When each busy repository's next sync is due, a pace after its last try (a failed one too, so a failing
   * repository never retries sooner); empty when the budgets leave no room.
   */
  githubDueTimes(now = Date.now()) {
    const { pace, busy } = this.githubPace(now);
    const tried = (slug) =>
      Math.max(Number(this.ghMeta('gh_last_sync', slug) ?? 0), Date.parse(this.githubBudget(slug)?.at ?? '') || 0);
    return pace ? busy.map((slug) => ({ slug, at: tried(slug) + pace })) : [];
  },

  /** The busy repositories whose sync is due now. */
  githubDue(now = Date.now()) {
    return this.githubDueTimes(now)
      .filter((d) => d.at <= now + DUE_SLACK_MS)
      .map((d) => d.slug);
  },

  /**
   * After a tick: wakes the alarm when the next busy repository's sync is due, or forgets the fast sync when none
   * is busy or the budgets leave no room, and the cron carries on alone. Returns when, or null.
   */
  async scheduleFastSync(now = Date.now()) {
    const due = this.githubDueTimes(now);
    const at = due.length ? Math.max(now + DUE_SLACK_MS, Math.min(...due.map((d) => d.at))) : null;
    const pending = await this.ctx.storage.getAlarm();
    if (!at) {
      // An alarm set for a sync no longer due still fires: it then reconciles only what webhooks named.
      if (!pending || pending !== Number(this.meta('gh_fast_at') ?? 0)) this.setMeta('gh_fast_at', null);
      return null;
    }
    this.setMeta('gh_fast_at', at);
    if (!pending || pending > at || pending <= now) await this.ctx.storage.setAlarm(at);
    return at;
  },

  // ---- the reconcile ---------------------------------------------------------------------

  /**
   * Catches up with GitHub: every registered repository (or the slugs in `only`), one after another,
   * each on its own, so one repository's failure or rate limit never stops the next. `error` joins the
   * repositories' errors (each named once there's more than one); `repos` has each one's result.
   */
  async reconcileGitHub({ only = null } = {}) {
    await this.ready();
    const credentials = await appCredentials(this.env);
    const repos = this.repos().filter((r) => !only || only.includes(r.slug));
    if (!credentials) {
      for (const repo of repos) this.setGhMeta('gh_error', repo.slug, null);
      return { connected: false };
    }
    const results = {};
    for (const repo of repos) {
      const before = countsOf(this.ghCache[repo.slug]);
      try {
        results[repo.slug] = await this.reconcileRepo(credentials, repo);
      } catch (error) {
        this.setGhMeta('gh_error', repo.slug, error.message);
        results[repo.slug] = { connected: true, error: error.message };
      }
      this.keepGitHubBudget(repo, before);
    }
    const several = this.repos().length > 1;
    const errors = Object.entries(results)
      .filter(([, r]) => r.error)
      .map(([slug, r]) => (several ? `${slug}: ${r.error}` : r.error));
    const own = results[this.defaultRepoSlug()] ?? {};
    return { connected: true, ...own, error: errors.length ? errors.join('; ') : own.error, repos: results };
  },

  /**
   * What the sync just spent of GitHub's rate limits (BRK-271), in meta so it survives a restart: each budget's
   * last known state, and the calls and free 304s since `before`, the client's counts when the sync started.
   */
  keepGitHubBudget(repo, before) {
    const previous = JSON.parse(this.ghMeta('gh_rate', repo.slug) ?? 'null');
    this.setGhMeta('gh_rate', repo.slug, JSON.stringify(budgetAfterSync(previous, this.ghCache[repo.slug], before)));
  },

  /** A repository's budgets after its last sync, or null before one. */
  githubBudget(slug) {
    return JSON.parse(this.ghMeta('gh_rate', slug) ?? 'null');
  },

  /** One repository's reconcile: fetch, then store and move its tasks. */
  async reconcileRepo(credentials, repo) {
    const client = this.githubClient(credentials, repo);
    let fetched;
    try {
      fetched = await this.fetchGitHub(client, repo);
    } catch (error) {
      // No commits yet (CLD-191): nothing to sync, and not a failure. Connections and the GitHub view say to run repos init.
      if (isEmptyRepo(error)) {
        this.setGhMeta('gh_empty', repo.slug, 1);
        this.setGhMeta('gh_error', repo.slug, null);
        this.setGhMeta('gh_last_sync', repo.slug, Date.now());
        return { connected: true, empty: true };
      }
      if (error instanceof GitHubError && [401, 404].includes(error.status)) this.ghCache[repo.slug] = {};
      this.setGhMeta('gh_error', repo.slug, error.message);
      return { connected: true, error: error.message };
    }
    this.setGhMeta('gh_empty', repo.slug, null);
    // A pipeline's staging and production environments (BRK-195), so its deploys have somewhere to be recorded.
    this.ensurePipelineEnvironments(repo.slug);
    // Freeze and DEPLOYS_PAUSED as one switch (BRK-236): a change on either side reaches the other.
    await this.syncDeployPause(client, repo.slug);
    const { deploySignals, deployChanges, ...automation } = this.applyGitHub(fetched, repo);
    // Each finished Deploy, Promote, and Roll back on its environment's audit trail (BRK-195).
    automation.errors.push(...this.recordDeploys(deployChanges, repo.slug).map((e) => `deploys: ${e}`));
    // Failed deploys and roll backs become signals on their environment (BRK-198), once the rows are stored.
    if (deploySignals.length)
      try {
        await this.recordSignals(deploySignals);
      } catch (error) {
        automation.errors.push(`signals: ${error.message}`);
      }
    // The Packages feed (BRK-101): what the runs say they staged on npm, then whether npm has published it yet.
    try {
      await this.readPackages(client, repo.slug, fetched.runs);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    await this.checkRegistry(repo.slug);
    // Turn on deploys (WEB-13): what a repository without a pipeline has on its default branch once the move merged.
    try {
      await this.findPipeline(client, repo, fetched.commits[0]?.sha);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    // Architect's desired state (BRK-180): each environment's file on the default branch, once per new commit.
    try {
      await this.readDesiredStates(client, repo, fetched.commits[0]?.sha);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    // Plans from pull requests (BRK-185): a pull request changing that folder gets its plan as a check.
    try {
      await this.checkInfraPulls(client, repo, fetched.pulls);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    // Risky-path review (BRK-280): a pull request touching a listed path gets a separate reviewer and a check.
    try {
      const problem = await this.checkRiskyPulls(client, repo, fetched.pulls);
      if (problem) automation.errors.push(problem);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    // Changes from the console (BRK-259): each one's pull request merged, closed, or taken over, from the same list.
    this.followInfraChanges(repo.slug, fetched.pulls);
    // Policy changes from the board (WEB-123), the same way.
    this.followPolicyChanges(repo.slug, fetched.pulls);
    // Approved changes (BRK-260): lapse, say why they can't merge, merge at a green sync, and plan from the merge.
    try {
      await this.advanceInfraChanges(client, repo);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    try {
      await this.refreshFlowCompare(client, repo.slug);
      // Whether Release builds pre-releases by hand (WEB-113): one read a day, or after a push changes a workflow.
      await this.refreshReleaseMode(client, repo);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      automation.errors.push(error.message);
    }
    // Tasks from alerts are made in the default repository's debt area; another repository's come with its agents (CLD-126).
    if (repo.slug === this.defaultRepoSlug()) {
      try {
        await this.tasksForNewAlerts?.(automation.newAlerts);
      } catch (error) {
        automation.errors.push(error.message);
      }
    }
    this.setGhMeta('gh_error', repo.slug, automation.errors.length ? automation.errors.join('; ') : null);
    this.setGhMeta('gh_last_sync', repo.slug, Date.now());
    return { connected: true, ...automation };
  },

  /** All the network calls, before anything is written, so the write below is one step. */
  async fetchGitHub(client, repo) {
    const optional = (promise) =>
      promise.catch((error) => {
        if (error instanceof GitHubError && [403, 404].includes(error.status)) return null; // not permitted or not enabled (a rate limit is 429)
        throw error;
      });
    const [pulls, runs, commits, alerts, deployments, releases, tags] = await Promise.all([
      client.get('/pulls?state=all&sort=updated&direction=desc&per_page=50'),
      client.get('/actions/runs?per_page=30'),
      client.get(`/commits?sha=${encodeURIComponent(repo.defaultBranch || 'main')}&per_page=30`),
      optional(client.get('/dependabot/alerts?state=open&per_page=100')),
      // Deployments, releases, and tags need the App's `deployments` permission (or none): without it, the board just has no deploys.
      optional(client.get('/deployments?per_page=20')),
      optional(client.get('/releases?per_page=10')),
      optional(client.get('/tags?per_page=10')),
    ]);
    const stored = new Map(
      this.sql
        .exec('SELECT number, updated, data FROM gh_pulls WHERE repo = ?', repo.slug)
        .toArray()
        .map((r) => [r.number, { updated: r.updated, ...JSON.parse(r.data) }]),
    );
    const needDetails = pulls
      .filter((p) => p.state === 'open' || !stored.has(p.number) || stored.get(p.number).updated !== p.updated_at)
      .sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1))
      .slice(0, MAX_DETAILS);
    const details = await this.fetchDetails(client, needDetails);
    const deploys = await this.fetchDeploys(client, deployments ?? [], repo.slug);
    const patterns = await this.deployPatterns(client, repo);
    // The files each pull request touches (BRK-316), for footprints and for which Workers a merge changes:
    // open ones whenever their head moves, merged ones once, whether or not the repository has a pipeline,
    // and merged ones that aged out of the latest 50 before they were read. Open ones go first.
    const stale = (pr, head) => !pr?.files || pr.filesHead !== head;
    const fresh = new Set(pulls.map((p) => p.number));
    const unread = [
      ...pulls.filter((p) => p.state === 'open' && stale(stored.get(p.number), p.head?.sha ?? null)),
      ...pulls.filter((p) => prState(p) === 'merged' && stale(stored.get(p.number), p.head?.sha ?? null)),
      ...[...stored]
        .filter(([number, pr]) => !fresh.has(number) && pr.state === 'merged' && stale(pr, pr.headSha ?? null))
        .map(([number, pr]) => ({ number, head: { sha: pr.headSha ?? null } })),
    ];
    const files = await this.fetchFiles(client, unread.slice(0, MAX_FILES));
    return {
      pulls,
      runs: runs.workflow_runs ?? [],
      commits,
      alerts,
      details,
      stored,
      deploys,
      releases,
      tags,
      files,
      patterns,
    };
  },

  /**
   * Each pull request's checks, reviews, and merge state (BRK-269): one GraphQL query for all of them while
   * GraphQL's budget lasts, and REST (four calls each) for any it leaves out, when it fails, or when it's used up.
   */
  async fetchDetails(client, pulls) {
    let details = new Map();
    if (pulls.length && !client.limitedUntil('graphql')) {
      try {
        const { owner, repo: name } = client.repo;
        const data = await client.graphql(
          pullDetailsQuery(pulls.map((p) => p.number)),
          { owner, name },
          { accept: MERGE_INFO_PREVIEW },
        );
        details = detailsFromGraphql(data, new Set(pulls.filter((p) => p.state === 'open').map((p) => p.number)));
      } catch {
        // Whatever went wrong (a refusal, a used-up budget, a network failure), REST reads them below.
      }
    }
    await Promise.all(
      pulls
        .filter((p) => !details.has(p.number))
        .map(async (p) => {
          const [checks, status, reviews, full] = await Promise.all([
            client.get(`/commits/${p.head.sha}/check-runs?per_page=100`),
            client.get(`/commits/${p.head.sha}/status`),
            client.get(`/pulls/${p.number}/reviews?per_page=100`),
            p.state === 'open' ? client.get(`/pulls/${p.number}`) : null, // the list doesn't carry mergeable_state
          ]);
          details.set(p.number, {
            checks: rollupChecks(checks.check_runs, status.statuses),
            review: reviewDecision(reviews),
            mergeable: full?.mergeable ?? null,
            mergeableState: full?.mergeable_state ?? null,
          });
        }),
    );
    return details;
  },

  /**
   * The files each pull request changes, renamed files' old names included, at the head they were read at
   * (`partial` when there are more than FILE_PAGES pages of them). Left out when GitHub won't say.
   */
  async fetchFiles(client, pulls) {
    const files = new Map();
    await Promise.all(
      pulls.map(async (p) => {
        try {
          const list = [];
          for (let page = 1; page <= FILE_PAGES; page += 1) {
            const batch = await client.get(`/pulls/${p.number}/files?per_page=100&page=${page}`);
            for (const f of batch) list.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
            if (batch.length < 100) break;
          }
          files.set(p.number, { list, head: p.head?.sha ?? null, partial: list.length >= FILE_PAGES * 100 });
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
        }
      }),
    );
    return files;
  },

  /**
   * Each Deployment's latest status, and for every successful one not yet applied, the commits
   * since the previous successful Deployment of the same environment (what it shipped).
   */
  async fetchDeploys(client, deployments, slug) {
    const known = new Map(
      this.sql
        .exec('SELECT id, state, applied, data FROM gh_deploys WHERE repo = ?', slug)
        .toArray()
        .map((r) => [r.id, r]),
    );
    const done = new Set(['success', 'failure', 'error', 'inactive']);
    const deploys = await Promise.all(
      deployments.map(async (d) => {
        const prev = known.get(d.id);
        // A final state doesn't change again (a successful one may turn `inactive` when a newer one lands).
        if (prev && done.has(prev.state)) return { ...JSON.parse(prev.data), state: prev.state };
        const [latest] = await client.get(`/deployments/${d.id}/statuses?per_page=1`);
        return deployFrom(d, latest);
      }),
    );
    const all = new Map([...known].map(([id, r]) => [id, { ...JSON.parse(r.data), applied: r.applied }]));
    for (const d of deploys) all.set(d.id, { ...d, applied: known.get(d.id)?.applied ?? 0 });
    const successes = [...all.values()].filter((d) => d.landed);
    const compares = new Map();
    for (const d of successes
      .filter((x) => !x.applied && x.task === 'deploy')
      .sort((a, b) => a.id - b.id)
      .slice(0, MAX_COMPARES)) {
      const before = successes
        .filter((x) => x.env === d.env && x.id < d.id && x.task === 'deploy')
        .sort((a, b) => b.id - a.id)[0];
      try {
        const compare =
          before && before.sha !== d.sha ? await client.get(`/compare/${before.sha}...${d.sha}?per_page=100`) : null;
        compares.set(
          d.id,
          compare
            ? (compare.commits ?? []).map((c) => ({ sha: c.sha, message: c.commit?.message ?? '' }))
            : [{ sha: d.sha, message: '' }],
        );
      } catch (error) {
        if (!(error instanceof GitHubError) || ![404, 422].includes(error.status)) throw error;
        compares.set(d.id, [{ sha: d.sha, message: '' }]); // the old commit is gone from GitHub: only this one is known
      }
    }
    return { list: deploys, compares };
  },

  /**
   * The deploy-path patterns of a repository: `[]` for one without a pipeline (nothing it merges deploys), and for
   * one with a pipeline its `pipeline.deployPaths` file
   * read from its default branch, kept for an hour. null when they can't be known (no file, or one that
   * isn't `{ worker: "regex" }`): then merged pull requests say nothing about deploys.
   */
  async deployPatterns(client, repo) {
    const pipeline = pipelineOf(repo);
    if (!pipeline) return [];
    if (!pipeline.deployPaths) return null;
    const kept = JSON.parse(this.ghMeta('gh_deploy_paths', repo.slug) ?? 'null');
    if (kept && kept.path === pipeline.deployPaths && Date.now() - kept.at < DEPLOY_PATHS_MS)
      return compileDeployPaths(kept.json);
    let json = null;
    try {
      const file = await client.get(
        `/contents/${pipeline.deployPaths.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(pipeline.branch)}`,
      );
      const bytes = Uint8Array.from(atob(String(file.content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0));
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof GitHubError && ![403, 404].includes(error.status)) throw error;
      json = null; // not there, not readable, or not JSON: unknown until the next read
    }
    if (!compileDeployPaths(json)) json = null;
    this.setGhMeta('gh_deploy_paths', repo.slug, JSON.stringify({ at: Date.now(), path: pipeline.deployPaths, json }));
    return compileDeployPaths(json);
  },

  /** The patterns `deployPatterns` last read, without asking GitHub. */
  knownDeployPatterns(repo) {
    const pipeline = pipelineOf(repo);
    if (!pipeline) return [];
    const kept = JSON.parse(this.ghMeta('gh_deploy_paths', repo.slug) ?? 'null');
    return kept && kept.path === pipeline.deployPaths ? compileDeployPaths(kept.json) : null;
  },

  /**
   * What a promote would carry: the compare of production's commit and the staging candidate, read
   * once per pair (its migrations, including destructive ones, and whether a Worker config changed).
   */
  async refreshFlowCompare(client, slug) {
    const pipeline = pipelineOf(this.githubRepo(slug));
    const deploys = pipeline
      ? this.sql
          .exec('SELECT data FROM gh_deploys WHERE repo = ?', slug)
          .toArray()
          .map((r) => JSON.parse(r.data))
      : [];
    const cand = pipeline && candidate(deploys.filter((d) => d.env === pipeline.staging).sort((a, b) => b.id - a.id));
    const live =
      pipeline && productionSha(deploys.filter((d) => d.env === pipeline.production).sort((a, b) => b.id - a.id));
    const key = cand && live && cand.sha !== live ? `${live}...${cand.sha}` : null;
    if (!key) {
      this.setGhMeta('gh_flow_compare', slug, null);
      return;
    }
    const kept = JSON.parse(this.ghMeta('gh_flow_compare', slug) ?? 'null');
    if (kept && kept.from === live && kept.to === cand.sha) return;
    try {
      const compare = await client.get(`/compare/${key}?per_page=100`);
      this.setGhMeta('gh_flow_compare', slug, JSON.stringify({ from: live, to: cand.sha, ...compareFacts(compare) }));
    } catch (error) {
      if (!(error instanceof GitHubError) || ![404, 422].includes(error.status)) throw error;
      this.setGhMeta('gh_flow_compare', slug, null); // a commit GitHub no longer has: the line just says less
    }
  },

  /** Stores what was fetched, records events, and moves linked tasks. Synchronous: the deploy flow's signals and finished deploys come back to record. */
  applyGitHub(
    { pulls, runs, commits, alerts, details, stored, deploys, releases, tags, files = new Map(), patterns },
    repo,
  ) {
    const slug = repo.slug;
    // What merging deploys here: null unknown, [] nothing (no pipeline), else the files decide.
    const deployRules = patterns !== undefined ? patterns : this.knownDeployPatterns(repo);
    // A pull request's file list (BRK-316): what was read now, else what was kept. A list too long to read whole
    // could change every Worker.
    const fileFields = (number, prev) => {
      const read = files.get(number);
      if (read) return { files: read.list, filesHead: read.head, ...(read.partial ? { filesPartial: true } : {}) };
      if (!prev?.files) return {};
      return {
        files: prev.files,
        filesHead: prev.filesHead ?? null,
        ...(prev.filesPartial ? { filesPartial: true } : {}),
      };
    };
    // Which Workers a merged pull request changed: without a pipeline nothing deploys; with one whose deploy
    // paths aren't known, it's unknown; else its files decide, once they're read, and what was decided stays.
    const workersOf = (number, kept, prev) => {
      if (deployRules === null) return null;
      if (!deployRules.length) return [];
      if (prev?.workers) return prev.workers;
      if (!kept.files) return null;
      return kept.filesPartial ? allWorkers(deployRules) : workersFor(kept.files, deployRules);
    };
    const initialized = Boolean(this.ghMeta('gh_initialized', slug));
    const branch = repo.defaultBranch || 'main';
    const prefixes = [...this.prefixOwners().keys()];
    const events = [];
    const event = (kind, data) => {
      if (initialized) events.push({ at: Date.now(), data: { kind, ...data } });
    };
    const errors = [];
    const moves = [];
    const newAlerts = [];
    const closedAlerts = [];
    let shipped = [];
    let deploySignals = [];
    let deployChanges = [];

    this.ctx.storage.transactionSync(() => {
      for (const p of pulls) {
        const prev = stored.get(p.number);
        const state = prState(p);
        const { closes, mentions, elsewhere } = this.linksOf(p, slug);
        const detail = details.get(p.number);
        const images = screenshotsIn(p.body);
        const kept = fileFields(p.number, prev);
        const pr = {
          repo: slug,
          number: p.number,
          title: p.title,
          state,
          draft: Boolean(p.draft),
          branch: p.head?.ref ?? null,
          headSha: p.head?.sha ?? null,
          author: p.user?.login ?? null,
          url: p.html_url,
          created: p.created_at,
          updated: p.updated_at,
          mergedAt: p.merged_at,
          closedAt: p.closed_at,
          checks: detail?.checks ?? prev?.checks ?? { state: 'none', total: 0, passed: 0, runs: [] },
          review: detail?.review ?? prev?.review ?? { decision: 'none', reviewers: [], comments: 0 },
          mergeable: detail ? detail.mergeable : (prev?.mergeable ?? null),
          mergeableState: detail ? detail.mergeableState : (prev?.mergeableState ?? null),
          mergeSha: p.merge_commit_sha ?? null,
          autoMerge: state === 'open' && p.auto_merge ? { method: p.auto_merge.merge_method ?? null } : null, // the list carries it
          workers: state === 'merged' ? workersOf(p.number, kept, prev) : null,
          ...kept,
          closes,
          mentions,
          ...(Object.keys(elsewhere).length ? { elsewhere } : {}),
          // The screenshots its description carries, for a chase's digest (BRK-277): links to GitHub, never the images.
          ...(images.length ? { images } : {}),
        };
        const base = { number: p.number, title: p.title, url: p.html_url, wids: closes.length ? closes : mentions };
        if (!prev && state === 'open') event('pr_opened', { ...base, by: pr.author, draft: pr.draft });
        if (prev?.state === 'open' && state === 'merged') event('pr_merged', base);
        if (prev?.state === 'open' && state === 'closed') event('pr_closed', base);
        if (prev?.draft && !pr.draft && state === 'open') event('pr_ready', base);
        if (prev && prev.checks.state !== 'failure' && pr.checks.state === 'failure') {
          event('ci_failed', {
            ...base,
            failing: pr.checks.runs
              .filter((r) => !['success', 'neutral', 'skipped', 'in_progress', 'queued', 'pending'].includes(r.state))
              .map((r) => r.name),
          });
        }
        if (prev?.checks.state === 'failure' && pr.checks.state === 'success') event('ci_fixed', base);
        if (
          prev &&
          prev.review.decision !== pr.review.decision &&
          ['approved', 'changes_requested'].includes(pr.review.decision)
        ) {
          event(pr.review.decision === 'approved' ? 'review_approved' : 'review_changes', base);
        }
        const applied =
          this.sql.exec('SELECT applied FROM gh_pulls WHERE repo = ? AND number = ?', slug, p.number).toArray()[0]
            ?.applied ?? null;
        this.sql.exec(
          'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, applied, data) VALUES (?, ?, ?, ?, ?, ?)',
          slug,
          p.number,
          p.updated_at,
          state,
          applied,
          JSON.stringify(pr),
        );
        moves.push({ pr, applied });
      }

      // Older merged pull requests aren't in the latest 50: only their files were read.
      const listed = new Set(pulls.map((p) => p.number));
      for (const number of files.keys()) {
        if (listed.has(number) || !stored.get(number)) continue;
        const { updated, ...prev } = stored.get(number);
        const kept = fileFields(number, prev);
        this.sql.exec(
          'UPDATE gh_pulls SET data = ? WHERE repo = ? AND number = ?',
          JSON.stringify({ ...prev, ...kept, workers: workersOf(number, kept, prev) }),
          slug,
          number,
        );
      }

      const knownRuns = new Map(
        this.sql
          .exec('SELECT id, data FROM gh_runs WHERE repo = ?', slug)
          .toArray()
          .map((r) => [r.id, JSON.parse(r.data)]),
      );
      for (const r of runs) {
        const run = {
          id: r.id,
          sha: r.head_sha ?? null,
          name: r.name,
          // Its workflow, so the runs tab can offer Run on one that runs by hand (WEB-83).
          workflow: r.workflow_id ?? null,
          path: r.path ?? null,
          title: r.display_title,
          branch: r.head_branch,
          event: r.event,
          status: r.status,
          conclusion: r.conclusion,
          url: r.html_url,
          created: r.created_at,
          updated: r.updated_at,
          started: r.run_started_at ?? r.created_at,
          number: r.run_number,
          actor: r.actor?.login ?? null,
          prs: (r.pull_requests ?? []).map((x) => x.number),
        };
        const prev = knownRuns.get(r.id);
        const failed =
          run.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion);
        // Dependabot's own update jobs run as event "dynamic" against main; they aren't main's CI.
        if (failed && prev?.status !== 'completed') {
          if (run.event === 'dynamic')
            event('dependabot_failed', {
              title: `Dependabot couldn't finish an update: ${run.name}`,
              url: run.url,
              wids: [],
            });
          else if (run.branch === branch)
            event('main_failed', { title: `${run.name} failed on ${branch}`, url: run.url, wids: [] });
        }
        this.sql.exec(
          'INSERT OR REPLACE INTO gh_runs (id, created, data, repo) VALUES (?, ?, ?, ?)',
          r.id,
          r.created_at,
          JSON.stringify(run),
          slug,
        );
      }

      for (const c of commits) {
        const message = c.commit?.message ?? '';
        const number = prNumberOf(message);
        const commit = {
          sha: c.sha,
          message: message.split('\n')[0],
          author: c.author?.login ?? c.commit?.author?.name ?? null,
          date: c.commit?.committer?.date ?? c.commit?.author?.date,
          url: c.html_url,
          pr: number,
          wids: widsIn(message, prefixes),
        };
        this.sql.exec(
          'INSERT OR REPLACE INTO gh_commits (sha, date, data, repo) VALUES (?, ?, ?, ?)',
          c.sha,
          commit.date,
          JSON.stringify(commit),
          slug,
        );
      }

      if (alerts) {
        const open = new Set();
        for (const a of alerts) {
          open.add(a.number);
          const alert = {
            number: a.number,
            severity: a.security_advisory?.severity ?? a.security_vulnerability?.severity ?? 'unknown',
            package: a.dependency?.package?.name ?? a.security_vulnerability?.package?.name ?? '?',
            ecosystem: a.dependency?.package?.ecosystem ?? null,
            manifest: a.dependency?.manifest_path ?? null,
            summary: a.security_advisory?.summary ?? '',
            ghsa: a.security_advisory?.ghsa_id ?? null,
            fixedIn: a.security_vulnerability?.first_patched_version?.identifier ?? null,
            url: a.html_url,
            created: a.created_at,
          };
          const known = this.sql
            .exec('SELECT state FROM gh_dependabot WHERE repo = ? AND number = ?', slug, a.number)
            .toArray()[0];
          if (known?.state !== 'open') {
            event('alert_opened', { title: `${alert.severity} alert in ${alert.package}`, url: alert.url, wids: [] });
            if (initialized) newAlerts.push(a.number);
          }
          this.sql.exec(
            'INSERT OR REPLACE INTO gh_dependabot (repo, number, state, data) VALUES (?, ?, ?, ?)',
            slug,
            a.number,
            'open',
            JSON.stringify(alert),
          );
        }
        for (const row of this.sql
          .exec("SELECT number, data FROM gh_dependabot WHERE repo = ? AND state = 'open'", slug)
          .toArray()) {
          if (open.has(row.number)) continue;
          const alert = JSON.parse(row.data);
          event('alert_closed', {
            title: `${alert.severity} alert in ${alert.package} is no longer open`,
            url: alert.url,
            wids: [],
          });
          this.sql.exec("UPDATE gh_dependabot SET state = 'closed' WHERE repo = ? AND number = ?", slug, row.number);
          closedAlerts.push(alert);
        }
      }

      const changed = [];
      shipped = this.applyDeploys(deploys, event, slug, changed);
      if (initialized) {
        deploySignals = this.deploySignals(changed, slug);
        deployChanges = changed;
      }
      if (releases)
        this.setGhMeta(
          'gh_releases',
          slug,
          JSON.stringify(
            releases.map((r) => ({
              name: r.name || r.tag_name,
              tag: r.tag_name,
              url: r.html_url,
              at: r.published_at ?? r.created_at,
              prerelease: Boolean(r.prerelease),
              draft: Boolean(r.draft),
            })),
          ),
        );
      if (tags)
        this.setGhMeta(
          'gh_tags',
          slug,
          JSON.stringify(tags.map((t) => ({ name: t.name, sha: t.commit?.sha ?? null }))),
        );

      for (const e of events)
        this.sql.exec('INSERT INTO gh_events (at, data, repo) VALUES (?, ?, ?)', e.at, JSON.stringify(e.data), slug);
      this.pruneGitHub(slug);
      this.setGhMeta('gh_initialized', slug, 1);
    });

    // Tasks move after the GitHub rows are stored, each as its own version. The first sync only
    // records history: PRs merged before the board was connected never move tasks.
    for (const { pr, applied } of moves) {
      if (!initialized && pr.state !== 'open') {
        this.sql.exec('UPDATE gh_pulls SET applied = ? WHERE repo = ? AND number = ?', pr.state, slug, pr.number);
        continue;
      }
      try {
        this.moveLinkedTasks(pr, applied);
      } catch (error) {
        errors.push(`#${pr.number}: ${error.message}`);
      }
    }
    // A task made from an alert that's now closed on GitHub gets a note (its PR usually closed both).
    for (const alert of closedAlerts) {
      const uuid = this.taskForAlert?.(alert);
      if (uuid) {
        try {
          this.change(uuid, { annotate: 'The security alert is closed on GitHub.', by: 'board' }, new Date(), 'github');
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    // Merged tasks get a note once their deploy lands (the first sync only records history).
    for (const { wid, deploy } of initialized ? shipped : []) {
      const uuid = [...this.tasks].find(([, map]) => map.wid === wid)?.[0];
      if (!uuid) continue;
      try {
        this.change(
          uuid,
          { annotate: shipNote(deploy, pipelineOf(repo) ?? undefined), by: 'board' },
          new Date(),
          'github',
        );
      } catch (error) {
        errors.push(`${wid}: ${error.message}`);
      }
    }
    return { events: events.length, errors, newAlerts, deploySignals, deployChanges };
  },

  /**
   * Stores deployments, records their events, and marks the tasks a successful one shipped. Each Deployment whose
   * state changed goes in `changed`, with the state before, for the deploy flow's signals.
   */
  applyDeploys({ list, compares }, event, slug, changed = []) {
    const shipped = [];
    const prs = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ?', slug)
      .toArray()
      .map((r) => ({ repo: slug, ...JSON.parse(r.data) }));
    for (const d of [...list].sort((a, b) => a.id - b.id)) {
      const prev = this.sql.exec('SELECT state, applied FROM gh_deploys WHERE id = ?', d.id).toArray()[0];
      let applied = prev?.applied ?? 0;
      let wids = [];
      if (d.landed && !applied && compares.has(d.id)) {
        const at = d.updated ?? d.created;
        for (const pr of shippedPrs(prs, compares.get(d.id))) {
          for (const uuid of this.closingTasks(pr)) {
            const wid = this.tasks.get(uuid)?.wid;
            if (!wid || pr.state !== 'merged') continue;
            wids.push(wid);
            this.sql.exec(
              'INSERT OR REPLACE INTO gh_ships (wid, env, version, sha, at, deploy, merge_sha, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              wid,
              d.env,
              d.version,
              d.sha,
              at,
              d.id,
              pr.mergeSha ?? null,
              d.logUrl ?? null,
            );
          }
        }
        wids = [...new Set(wids)];
        applied = 1;
        shipped.push(...wids.map((wid) => ({ wid, deploy: d })));
      }
      const label = `${d.env} ${d.version ? d.version.slice(0, 8) : d.sha.slice(0, 7)}`;
      if (d.landed && prev?.state !== 'success')
        event(d.task === 'rollback' ? 'rolled_back' : 'deployed', {
          title: `${d.task === 'rollback' ? 'Rolled back to' : 'Deployed'} ${label}`,
          url: d.logUrl,
          wids,
          sha: d.sha,
          version: d.version,
          env: d.env,
        });
      if (d.state === 'failure' && prev?.state !== 'failure')
        event('deploy_failed', {
          title: `${d.env} deploy of ${d.sha.slice(0, 7)} failed${d.description ? `: ${d.description}` : ''}`,
          url: d.logUrl,
          wids: [],
          sha: d.sha,
          env: d.env,
        });
      if (prev?.state !== d.state) changed.push({ deploy: d, prev: prev?.state ?? null });
      this.sql.exec(
        'INSERT OR REPLACE INTO gh_deploys (id, env, state, applied, data, repo) VALUES (?, ?, ?, ?, ?, ?)',
        d.id,
        d.env,
        d.state,
        applied,
        JSON.stringify(d),
        slug,
      );
    }
    return shipped;
  },

  /** Keeps each repository's latest rows; one repository's activity never pushes out another's. */
  pruneGitHub(slug) {
    this.sql.exec(
      `DELETE FROM gh_pulls WHERE repo = ?1 AND state != 'open' AND number NOT IN (SELECT number FROM gh_pulls WHERE repo = ?1 AND state != 'open' ORDER BY updated DESC LIMIT ${KEEP.closedPrs})`,
      slug,
    );
    this.sql.exec(
      `DELETE FROM gh_runs WHERE repo = ?1 AND id NOT IN (SELECT id FROM gh_runs WHERE repo = ?1 ORDER BY created DESC LIMIT ${KEEP.runs})`,
      slug,
    );
    this.sql.exec(
      `DELETE FROM gh_commits WHERE repo = ?1 AND sha NOT IN (SELECT sha FROM gh_commits WHERE repo = ?1 ORDER BY date DESC LIMIT ${KEEP.commits})`,
      slug,
    );
    this.sql.exec(
      `DELETE FROM gh_deploys WHERE repo = ?1 AND id NOT IN (SELECT id FROM gh_deploys WHERE repo = ?1 ORDER BY id DESC LIMIT ${KEEP.deploys})`,
      slug,
    );
    this.sql.exec(
      `DELETE FROM gh_events WHERE repo = ?1 AND id NOT IN (SELECT id FROM gh_events WHERE repo = ?1 ORDER BY id DESC LIMIT ${KEEP.events})`,
      slug,
    );
  },

  /**
   * The tasks a PR closes: their work IDs, plus any task whose `pr` field is this PR. Only tasks of the
   * PR's own repository: `Closes PRD-12.` in another repository's pull request never finishes it.
   */
  closingTasks(pr) {
    const fallback = this.defaultRepoSlug();
    const slug = prRepo(pr, fallback);
    const uuids = new Set();
    for (const [uuid, map] of this.tasks) {
      if (repoSlugOf(map, fallback) !== slug) continue;
      if ((map.wid && pr.closes.includes(map.wid)) || map.pr === String(pr.number)) uuids.add(uuid);
    }
    return [...uuids];
  },

  moveLinkedTasks(pr, applied) {
    const now = new Date();
    for (const uuid of this.closingTasks(pr)) {
      const map = this.tasks.get(uuid);
      if (map?.status !== 'pending') continue;
      if (pr.state === 'open' && !map.pr) this.change(uuid, { pr: String(pr.number) }, now, 'github');
      if (pr.state === 'merged' && applied !== 'merged')
        this.change(
          uuid,
          { status: 'completed', pr: String(pr.number), annotate: `Merged in #${pr.number}: ${pr.title}`, by: 'board' },
          now,
          'github',
        );
      if (pr.state === 'closed' && applied !== 'closed')
        this.change(uuid, { annotate: `#${pr.number} was closed without merging.`, by: 'board' }, now, 'github');
    }
    if (pr.state !== 'open' && applied !== pr.state)
      this.sql.exec(
        'UPDATE gh_pulls SET applied = ? WHERE repo = ? AND number = ?',
        pr.state,
        prRepo(pr, this.defaultRepoSlug()),
        pr.number,
      );
  },

  // ---- reading -----------------------------------------------------------------------------

  /** Per task: the PRs that close or mention it, in short form. `byNumber` is keyed `<repo>#<number>`. */
  githubLinks() {
    const byWid = new Map();
    const byNumber = new Map();
    for (const row of this.sql.exec('SELECT repo, data FROM gh_pulls').toArray()) {
      const pr = JSON.parse(row.data);
      const short = {
        repo: row.repo,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        url: pr.url,
        branch: pr.branch,
        author: pr.author,
        checks: { state: pr.checks.state, total: pr.checks.total, passed: pr.checks.passed },
        review: pr.review.decision,
        // Whether it can merge as it stands, so the task menu offers Review with an agent only then (WEB-23).
        verdict: pr.state === 'open' ? prVerdict(pr) : null,
        mergeable: pr.mergeable ?? null,
        workers: pr.workers ?? null,
      };
      byNumber.set(`${row.repo}#${pr.number}`, short);
      for (const wid of pr.closes) byWid.set(wid, [...(byWid.get(wid) ?? []), { ...short, closes: true }]);
      for (const wid of pr.mentions) byWid.set(wid, [...(byWid.get(wid) ?? []), { ...short, closes: false }]);
    }
    return { byWid, byNumber };
  },

  /**
   * Work ID → where it shipped, for the task views: `staging` and `live` (the latest Deployment of
   * each kind that carried it) and `list`, every environment with its commits, run, and release tag.
   */
  shippedLinks() {
    const tags = this.repos().flatMap((r) => JSON.parse(this.ghMeta('gh_tags', r.slug) ?? '[]'));
    const tagOf = (sha) => tags.find((t) => t.sha === sha)?.name ?? null;
    // Each repository's staging Worker.
    const stagings = new Set(
      this.repos()
        .map((r) => pipelineOf(r)?.staging)
        .filter(Boolean),
    );
    const links = new Map();
    for (const r of this.sql
      .exec('SELECT wid, env, version, sha, at, merge_sha, run FROM gh_ships ORDER BY at')
      .toArray()) {
      const stage = stagings.has(r.env) ? 'staging' : 'live';
      const ship = {
        env: r.env,
        stage,
        version: r.version,
        sha: r.sha,
        at: r.at,
        mergeSha: r.merge_sha,
        run: r.run,
        tag: stage === 'live' ? tagOf(r.sha) : null,
      };
      const entry = links.get(r.wid) ?? { staging: null, live: null, list: [] };
      if (!entry[stage] || entry[stage].at <= ship.at) entry[stage] = ship;
      entry.list.push(ship);
      links.set(r.wid, entry);
    }
    return links;
  },

  githubFor(map, links) {
    const list = [...(map.wid ? (links.byWid.get(map.wid) ?? []) : [])];
    const own =
      map.pr && /^\d+$/u.test(map.pr)
        ? links.byNumber.get(`${repoSlugOf(map, this.defaultRepoSlug())}#${Number(map.pr)}`)
        : null;
    const same = (p) => own && p.repo === own.repo && p.number === own.number;
    if (own && !list.some(same)) list.push({ ...own, closes: true });
    for (const p of list) if (same(p)) p.closes = true;
    return list.sort((a, b) => b.number - a.number);
  },

  /**
   * The GitHub view: one repository's (the default when `slug` is empty), or with `all` every
   * registered repository's together, each item carrying its `repo` (githubOverviewAll).
   */
  async githubOverview(slug = null) {
    await this.ready();
    const connected = Boolean(await appCredentials(this.env));
    // GitHub's status page (BRK-217): the GitHub view says when it holds the board's automatic work.
    const githubStatus = connected ? this.githubStatusView() : null;
    if (slug === 'all') return { status: 200, body: { ...this.githubOverviewAll(connected), githubStatus } };
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    return { status: 200, body: { ...this.githubRepoView(repo, connected), githubStatus } };
  },

  /**
   * Every repository at once, for the board when several are registered: the lists merged (newest first,
   * open pull requests in inbox order) and not cut short, so the board can show one repository or all from
   * the same answer; `repos` has each repository's own facts (sync, pipeline, release flow, access).
   */
  githubOverviewAll(connected) {
    const views = this.repos().map((r) => this.githubRepoView(r, connected));
    const merged = (key, order) => views.flatMap((v) => v[key]).sort(order);
    const newest = (pick) => (a, b) => String(pick(b) ?? '').localeCompare(String(pick(a) ?? ''));
    const synced = views
      .map((v) => v.lastSync)
      .filter(Boolean)
      .sort();
    const lists = ['open', 'closed', 'runs', 'deploys', 'commits', 'alerts', 'packages'];
    return {
      connected,
      all: true,
      repo: null,
      slug: null,
      lastSync: synced[0] ?? null,
      error:
        views
          .filter((v) => v.error)
          .map((v) => `${v.slug}: ${v.error}`)
          .join('; ') || null,
      open: merged('open', byInbox),
      readyToMerge: views.reduce((n, v) => n + v.readyToMerge, 0),
      closed: merged(
        'closed',
        newest((p) => p.mergedAt ?? p.closedAt ?? p.updated),
      ),
      runs: merged(
        'runs',
        newest((r) => r.created),
      ),
      deploys: merged(
        'deploys',
        newest((d) => d.updated ?? d.created),
      ),
      flow: null,
      pipeline: null,
      releases: [],
      tags: [],
      commits: merged(
        'commits',
        newest((c) => c.date),
      ),
      alerts: merged('alerts', () => 0),
      packages: merged(
        'packages',
        newest((v) => v.staged),
      ),
      repos: views.map((v) => Object.fromEntries(Object.entries(v).filter(([key]) => !lists.includes(key)))),
    };
  },

  /** One repository's GitHub view; every pull request, run, deploy, commit, and alert carries its `repo`. */
  githubRepoView(repo, connected) {
    const rows = (sql, ...args) =>
      this.sql
        .exec(sql, ...args)
        .toArray()
        .map((r) => ({ ...JSON.parse(r.data), repo: repo.slug }));
    const fallback = this.defaultRepoSlug();
    const pipeline = pipelineOf(repo);
    const taskBrief = (wid) => {
      for (const [uuid, map] of this.tasks) {
        if (map.wid === wid) return { uuid, wid, description: map.description, status: map.status };
      }
      return null;
    };
    // A task whose `pr` field is this PR is closed by it, whatever the PR's text says.
    const byPrField = new Map();
    for (const map of this.tasks.values()) {
      if (map.wid && /^\d+$/u.test(map.pr ?? '') && repoSlugOf(map, fallback) === repo.slug)
        byPrField.set(Number(map.pr), [...(byPrField.get(Number(map.pr)) ?? []), map.wid]);
    }
    // Each pull request's file list stays in the store, for footprints (BRK-316): the view doesn't need it.
    /** @param {any} row */
    const withTasks = ({ files, filesHead, filesPartial, ...pr }) => {
      const closes = [...new Set([...pr.closes, ...(byPrField.get(pr.number) ?? [])])];
      const mentions = pr.mentions.filter((w) => !closes.includes(w));
      return {
        ...pr,
        verdict: pr.state === 'open' ? prVerdict(pr) : null,
        // Why Merge when green waits on its risky-path review (BRK-280), so the settings skip it.
        riskHold: pr.state === 'open' ? this.riskHoldOf(repo.slug, pr.number) : null,
        tasks: [
          ...closes.map((w) => ({ ...taskBrief(w), closes: true })),
          ...mentions.map((w) => ({ ...taskBrief(w), closes: false })),
        ].filter((t) => t.uuid),
      };
    };
    const prs = rows('SELECT data FROM gh_pulls WHERE repo = ? ORDER BY updated DESC', repo.slug).map(withTasks);
    const lastSync = Number(this.ghMeta('gh_last_sync', repo.slug) ?? 0);
    const deploys = (limit) =>
      rows(`SELECT data FROM gh_deploys WHERE repo = ? ORDER BY id DESC LIMIT ${limit}`, repo.slug);
    const runs = () => rows('SELECT data FROM gh_runs WHERE repo = ? ORDER BY created DESC LIMIT 40', repo.slug);
    // What the owner's buttons can do here, from the Connections view's last live check.
    const live = JSON.parse(this.meta('conn_live') ?? 'null');
    return {
      connected,
      repo: repo.github,
      slug: repo.slug,
      name: repo.name,
      branch: repo.defaultBranch || 'main',
      isDefault: repo.slug === fallback,
      lastSync: lastSync ? iso(lastSync) : null,
      // GitHub's rate limits after the last sync, and what it spent (BRK-271).
      rate: this.githubBudget(repo.slug),
      error: this.ghMeta('gh_error', repo.slug),
      // No commits yet (CLD-191): a neutral state, with `npx breakaway repos init <slug>` as the next step.
      empty: Boolean(this.ghMeta('gh_empty', repo.slug)),
      open: prs.filter((p) => p.state === 'open').sort(byInbox),
      readyToMerge: prs.filter((p) => p.state === 'open' && p.verdict === 'ready').length,
      closed: prs.filter((p) => p.state !== 'open').slice(0, 20),
      runs: runs(),
      // Releases, Promote, Roll back, and deploys only where the repository has a pipeline (IDEA-14 section 3).
      pipeline: pipeline && { staging: pipeline.staging, production: pipeline.production },
      // Merged, not on (WEB-13): the move's files on the default branch, and the pipeline one press would set.
      pipelineFound: this.pipelineFoundOf(repo),
      // Deploy with breakaway (WEB-12): where the move to the deploy flow is, for a repository without a pipeline.
      move: this.moveOf(repo),
      deploys: !pipeline
        ? []
        : deploys(20).map((d) => ({
            ...d,
            shipped: this.sql
              .exec('SELECT wid FROM gh_ships WHERE deploy = ? ORDER BY wid', d.id)
              .toArray()
              .map((r) => taskBrief(r.wid))
              .filter(Boolean),
          })),
      flow: !pipeline
        ? null
        : this.withFlowTasks(
            buildFlow({
              deploys: deploys(100).map((d) => ({ ...d, shipped: undefined })),
              compare: JSON.parse(this.ghMeta('gh_flow_compare', repo.slug) ?? 'null'),
              prs,
              runs: runs(),
              repoUrl: `https://github.com/${repo.github}`,
              workers: pipeline,
              frozen: this.productionFrozen(repo.slug),
            }),
          ),
      access: pullAccess(live?.repos?.[repo.slug] ?? null, {
        github: repo.github,
        at: live?.at ?? null,
        pipeline: Boolean(pipeline || packageOf(repo)),
      }),
      // What the runs staged on npm, and whether each is published yet (BRK-101); empty without a package.
      packages: this.packagesOf(repo.slug).versions,
      // The npm package Release offers on (BRK-103), or null: Packages then says how to turn it on (WEB-81).
      releasePackage: packageOf(repo)?.name ?? null,
      // Build a pre-release (WEB-113): what main has since the latest one, where Release builds them by hand.
      releaseBuild: this.releaseBuildOf(repo, { prs, runs: runs() }),
      releases: JSON.parse(this.ghMeta('gh_releases', repo.slug) ?? '[]'),
      tags: JSON.parse(this.ghMeta('gh_tags', repo.slug) ?? '[]'),
      // Prepare the next minor or major (BRK-100), where the pre-releases count from package.json's version.
      nextVersion: this.nextVersionOffer(repo.slug),
      // "Merge branch 'main' into …" commits come in with merge-commit PRs; they say nothing new.
      commits: rows('SELECT data FROM gh_commits WHERE repo = ? ORDER BY date DESC LIMIT 60', repo.slug)
        .filter((c) => !/^Merge (remote-tracking )?branch /u.test(c.message))
        .slice(0, 30),
      alerts: rows("SELECT data FROM gh_dependabot WHERE repo = ? AND state = 'open'", repo.slug).map((a) => {
        const uuid = this.taskForAlert?.(a);
        const map = uuid && this.tasks.get(uuid);
        return {
          ...a,
          task: map ? { uuid, wid: map.wid ?? null, claim: map.claim ?? null, session: map.session ?? null } : null,
        };
      }),
    };
  },

  /** The tasks each environment's live build carried (what marked them shipped there). */
  withFlowTasks(flow) {
    for (const card of [flow.staging, flow.production]) {
      if (card.build)
        card.tasks = this.sql
          .exec('SELECT wid FROM gh_ships WHERE deploy = ? ORDER BY wid', card.build.id)
          .toArray()
          .map((r) => r.wid);
    }
    return flow;
  },

  /**
   * What decides whether an agent may review pull request `number` now (BRK-111), read live from GitHub: its state,
   * draft, mergeable state, checks, reviews, head, and base. Null when GitHub isn't connected or doesn't answer,
   * so the caller goes by the last sync.
   */
  async livePull(slug, number) {
    const repo = this.githubRepo(slug);
    const credentials = repo && (await appCredentials(this.env));
    if (!credentials) return null;
    const client = this.githubClient(credentials, repo);
    try {
      const [p, reviews] = await Promise.all([
        client.get(`/pulls/${number}`),
        client.get(`/pulls/${number}/reviews?per_page=100`),
      ]);
      const [checks, status] = await Promise.all([
        client.get(`/commits/${p.head.sha}/check-runs?per_page=100`),
        client.get(`/commits/${p.head.sha}/status`),
      ]);
      return {
        state: prState(p),
        draft: Boolean(p.draft),
        mergeable: p.mergeable ?? null,
        mergeableState: p.mergeable_state ?? null,
        checks: rollupChecks(checks.check_runs, status.statuses),
        review: reviewDecision(reviews),
        headSha: p.head?.sha ?? null,
        base: p.base?.ref ?? null,
      };
    } catch (error) {
      if (error instanceof GitHubError) return null;
      throw error;
    }
  },

  /**
   * One pull request, read live for the page: GitHub's current mergeable state, checks, reviews,
   * conversation, and per-file diffs. Nothing here is stored (the diffs are the repository's code).
   */
  async githubPullApi(number, slug = null) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { error: 'GitHub isn’t connected yet' } };
    if (!/^\d+$/u.test(String(number))) return { status: 404, body: { error: 'no such pull request' } };
    const client = this.githubClient(credentials, repo);
    try {
      const [p, reviews, comments] = await Promise.all([
        client.get(`/pulls/${number}`),
        client.get(`/pulls/${number}/reviews?per_page=100`),
        client.get(`/pulls/${number}/comments?per_page=100`),
      ]);
      const [checks, status] = await Promise.all([
        client.get(`/commits/${p.head.sha}/check-runs?per_page=100`),
        client.get(`/commits/${p.head.sha}/status`),
      ]);
      const files = [];
      for (let page = 1; page <= PAGE_FILES; page += 1) {
        const batch = await client.get(`/pulls/${number}/files?per_page=100&page=${page}`);
        files.push(...batch);
        if (batch.length < 100) break;
      }
      const rollup = rollupChecks(checks.check_runs, status.statuses);
      const review = reviewDecision(reviews);
      const state = prState(p);
      const known = this.sql
        .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', repo.slug, p.number)
        .toArray()[0];
      const linked = known ? JSON.parse(known.data) : this.linksOf(p, repo.slug);
      const elsewhere = linked.elsewhere ?? {};
      // A work ID of another repository is only a mention here, and the page says where it belongs.
      const tasks = [
        ...linked.closes.map((w) => ({ wid: w, closes: true })),
        ...linked.mentions.map((w) => ({
          wid: w,
          closes: false,
          ...(elsewhere[w] ? { elsewhere: elsewhere[w] } : {}),
        })),
      ].flatMap((t) => {
        for (const [uuid, map] of this.tasks)
          if (map.wid === t.wid) return [{ ...t, uuid, description: map.description, status: map.status }];
        return [];
      });
      // What merging deploys: the repository's deploy paths (none without a pipeline; unknown → nothing said).
      const pipeline = pipelineOf(repo);
      const patterns = await this.deployPatterns(client, repo);
      const workersOf = (names) => (patterns?.length ? workersFor(names, patterns) : []);
      const workers = workersOf(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
      const byId = new Map(comments.map((c) => [c.id, c]));
      const rootOf = (c) => {
        let x = c;
        while (x.in_reply_to_id && byId.has(x.in_reply_to_id)) x = byId.get(x.in_reply_to_id);
        return x.id;
      };
      const threads = new Map();
      for (const c of comments) {
        const id = rootOf(c);
        threads.set(id, [
          ...(threads.get(id) ?? []),
          { id: c.id, by: c.user?.login ?? null, body: c.body, at: c.created_at, url: c.html_url },
        ]);
      }
      return {
        status: 200,
        body: {
          repo: repo.slug,
          number: p.number,
          title: p.title,
          body: p.body ?? '',
          state,
          draft: Boolean(p.draft),
          branch: p.head?.ref ?? null,
          base: p.base?.ref ?? null,
          headSha: p.head?.sha ?? null,
          author: p.user?.login ?? null,
          url: p.html_url,
          created: p.created_at,
          updated: p.updated_at,
          mergeable: p.mergeable ?? null,
          mergeableState: p.mergeable_state ?? null,
          verdict:
            state === 'open'
              ? prVerdict({
                  draft: p.draft,
                  mergeable: p.mergeable,
                  mergeableState: p.mergeable_state,
                  checks: rollup,
                  review,
                })
              : null,
          checks: rollup,
          review,
          reviews: reviews
            .filter((r) => r.state !== 'PENDING' && (r.body || r.state !== 'COMMENTED'))
            .map((r) => ({ by: r.user?.login ?? null, state: r.state, body: r.body ?? '', at: r.submitted_at })),
          threads: [...threads.values()].map((list) => ({ path: byId.get(list[0].id)?.path ?? null, comments: list })),
          tasks,
          // Who's on its task right now: the page shows them instead of Fix with an agent (WEB-6).
          agent: state === 'open' ? this.prAgent({ ...linked, number: p.number, repo: repo.slug }) : null,
          // Fix agents started on it since it was last green, and since when a third is Needs you (BRK-145).
          fixes: state === 'open' ? this.prFixes(repo.slug, p.number) : null,
          // The latest agent's review, shown below the description (BRK-111).
          agentReview: this.agentReviewOf(repo.slug, p.number, p.head?.sha ?? null),
          // The plan its infrastructure files would make, as its check says (BRK-185); null when it changes none.
          infra: this.infraPullOut(repo.slug, p.number),
          // Its risky-path review (BRK-280); null when it touches nothing the repository lists.
          riskReview: this.riskReviewOut(repo.slug, p.number),
          workers,
          deploys: workers.length > 0,
          // null: the repository has no deploy pipeline, so the page says nothing about deploys.
          pipeline: pipeline && {
            staging: pipeline.staging,
            production: pipeline.production,
            known: Boolean(patterns),
          },
          isDefault: repo.slug === this.defaultRepoSlug(),
          access: (() => {
            const live = JSON.parse(this.meta('conn_live') ?? 'null');
            return pullAccess(live?.repos?.[repo.slug] ?? null, {
              github: repo.github,
              at: live?.at ?? null,
              pipeline: Boolean(pipeline || packageOf(repo)),
            });
          })(),
          commits: p.commits,
          autoMerge: p.auto_merge ? { method: p.auto_merge.merge_method ?? null } : null,
          files: files.map((f) => ({
            name: f.filename,
            from: f.previous_filename ?? null,
            status: f.status,
            added: f.additions,
            removed: f.deletions,
            patch: f.patch ?? null, // absent for binary files and diffs GitHub calls too large
            worker: workersOf([f.filename, f.previous_filename].filter(Boolean)).length > 0,
          })),
          filesTruncated: files.length >= PAGE_FILES * 100 || (p.changed_files ?? 0) > files.length,
        },
      };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return { status: error.status === 404 ? 404 : 502, body: { error: error.message } };
    }
  },

  /**
   * One file a pull request changes, read whole at its head or its base commit (WEB-86), for the page's Preview and
   * rendered diff. Only the pull request's own files are read; a renamed file's base is read at its old name. Text
   * comes back as text, an image as a data URL to show, and any other binary file or one over 1 MB only says so.
   * @param {string} number
   * @param {{ path?: string | null, side?: string | null, slug?: string | null }} query
   */
  async githubPullFileApi(number, { path = null, side = null, slug = null } = {}) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { error: 'GitHub isn’t connected yet' } };
    if (!/^\d+$/u.test(String(number))) return { status: 404, body: { error: 'no such pull request' } };
    if (!['head', 'base'].includes(String(side)))
      return { status: 400, body: { error: 'side must be "head" or "base"' } };
    if (!path) return { status: 400, body: { error: 'say which file as path' } };
    const client = this.githubClient(credentials, repo);
    try {
      const p = await client.get(`/pulls/${number}`);
      let changed = null;
      for (let page = 1; page <= PAGE_FILES && !changed; page += 1) {
        const batch = await client.get(`/pulls/${number}/files?per_page=100&page=${page}`);
        changed = batch.find((f) => f.filename === path) ?? null;
        if (batch.length < 100) break;
      }
      if (!changed) return { status: 404, body: { error: `#${number} doesn’t change ${path.slice(0, 200)}` } };
      if (side === 'base' && changed.status === 'added')
        return { status: 404, body: { error: `${path} is new in this pull request, so it has no earlier version` } };
      if (side === 'head' && changed.status === 'removed')
        return { status: 404, body: { error: `this pull request removes ${path}` } };
      const at = side === 'head' ? changed.filename : (changed.previous_filename ?? changed.filename);
      const sha = side === 'head' ? p.head.sha : p.base.sha;
      const file = await client.get(
        `/contents/${at.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`,
      );
      const head = { path: at, side, sha, size: Number(file.size ?? 0) };
      if (Number(file.size ?? 0) > PULL_FILE_MAX_BYTES || file.encoding !== 'base64' || !file.content)
        return {
          status: 200,
          body: { ...head, text: null, image: null, binary: false, tooLarge: Number(file.size ?? 0) > 0 },
        };
      const raw = String(file.content).replace(/\s+/gu, '');
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      const mime = IMAGE_TYPES[at.split('.').pop()?.toLowerCase() ?? ''];
      if (mime || bytes.subarray(0, 8000).includes(0))
        return {
          status: 200,
          body: {
            ...head,
            text: null,
            image: mime ? `data:${mime};base64,${raw}` : null,
            binary: true,
            tooLarge: false,
          },
        };
      return {
        status: 200,
        body: { ...head, text: new TextDecoder().decode(bytes), image: null, binary: false, tooLarge: false },
      };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return { status: error.status === 404 ? 404 : 502, body: { error: error.message } };
    }
  },

  // ---- the owner's writes (cookie-only: the Worker refuses a bearer token) ---------------------

  /**
   * Publish (mark ready for review), Update branch, Merge, and Merge when green on one open pull request. GitHub still enforces
   * `Protect main`: a refusal comes back with GitHub's own reason and nothing changes. `sha` is the
   * head commit the owner saw, so a push in between refuses instead of merging unseen code.
   * `setting` marks a write the owner's pull request settings made (Keep branches up to date, Merge
   * when green), so Activity can say so; it changes nothing else.
   */
  async githubWrite(number, action, { sha, method, enable, setting, repo: slug = null } = {}) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { error: 'GitHub isn’t connected yet' } };
    if (!/^\d+$/u.test(String(number))) return { status: 404, body: { error: 'no such pull request' } };
    if (!/^[0-9a-f]{7,64}$/iu.test(String(sha ?? '')))
      return { status: 400, body: { error: 'send the head commit you saw as "sha"' } };
    if (
      !['update-branch', 'publish'].includes(action) &&
      !(action === 'auto-merge' && enable === false) &&
      !['merge', 'squash'].includes(method)
    )
      return { status: 400, body: { error: 'method must be "merge" or "squash"' } };
    // While GitHub is down (BRK-217), the settings wait: an update or a merge could land on checks that never ran.
    // The owner's own presses still go through.
    const held = setting === true ? this.githubHold() : null;
    if (held)
      return {
        status: 503,
        body: {
          error: `${held}: Keep branches up to date and Merge when green wait until it’s working again.`,
          held: true,
        },
      };
    const client = this.githubClient(credentials, repo);
    try {
      const p = await client.get(`/pulls/${number}`);
      const state = prState(p);
      if (state !== 'open') return { status: 409, body: { error: `#${number} is already ${state}.`, state } };
      if (action === 'publish') {
        if (!p.draft) return { status: 409, body: { error: `#${number} isn’t a draft.` } };
      } else if (p.draft) return { status: 409, body: { error: `#${number} is a draft. Publish it first.` } };
      if (p.head.sha !== sha)
        return {
          status: 409,
          body: {
            error: `#${number} changed since you looked at it. Read it again before you continue.`,
            headSha: p.head.sha,
          },
        };
      // A risky-path review holds Merge when green (BRK-280): turning it on, or a merge the settings make. The owner's
      // own Merge press goes through: merging is theirs.
      const riskHeld =
        (action === 'auto-merge' && enable !== false) || (action === 'merge' && setting === true)
          ? this.riskHoldOf(repo.slug, p.number)
          : null;
      if (riskHeld) return { status: 409, body: { error: `#${number}: ${riskHeld}.`, riskHold: true } };
      const known = this.sql
        .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', repo.slug, p.number)
        .toArray()[0];
      const linked = known ? JSON.parse(known.data) : this.linksOf(p, repo.slug);
      const base = {
        number: p.number,
        title: p.title,
        url: p.html_url,
        wids: linked.closes.length ? linked.closes : linked.mentions,
      };

      let kind;
      if (action === 'publish') {
        // Marking ready for review has no REST endpoint, only this GraphQL mutation.
        await client.graphql(
          'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
          { id: p.node_id },
        );
        kind = 'pr_published';
      } else if (action === 'update-branch') {
        if (p.mergeable_state === 'dirty' || p.mergeable === false)
          return {
            status: 409,
            body: { error: `#${number} has conflicts with ${p.base?.ref ?? 'main'}: an agent has to resolve them.` },
          };
        await client.send('PUT', `/pulls/${number}/update-branch`, { expected_head_sha: sha });
        kind = 'pr_branch_updated';
      } else if (action === 'merge') {
        if (['dirty', 'behind', 'blocked'].includes(p.mergeable_state) || p.mergeable === false) {
          return {
            status: 409,
            body: { error: `#${number} isn’t ready to merge (${p.mergeable_state ?? 'still being checked'}).` },
          };
        }
        await client.send('PUT', `/pulls/${number}/merge`, { sha, merge_method: method });
        kind = 'pr_merged_by_owner';
      } else {
        const mutation =
          enable === false
            ? 'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }'
            : 'mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha }) { clientMutationId } }';
        await client.graphql(
          mutation,
          enable === false
            ? { id: p.node_id }
            : { id: p.node_id, method: method === 'squash' ? 'SQUASH' : 'MERGE', sha },
        );
        kind = enable === false ? 'pr_auto_merge_off' : 'pr_auto_merge_on';
      }
      this.sql.exec(
        'INSERT INTO gh_events (at, data, repo) VALUES (?, ?, ?)',
        Date.now(),
        JSON.stringify({
          kind,
          ...base,
          method: ['update-branch', 'publish'].includes(action) ? undefined : method,
          setting: setting === true || undefined,
        }),
        repo.slug,
      );
      await this.githubWebhook('pull_request', null, { slug: repo.slug }); // sync 5 seconds from now
      return { status: 200, body: { ok: true, action: kind, number: p.number } };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 403 && /not accessible by integration/iu.test(error.reason ?? '')) {
        return {
          status: 403,
          body: {
            error:
              'The board’s GitHub App can’t write yet: give it read and write on Pull requests and Contents, then accept the change on the installation (docs/tasks.md#github).',
            permission: true,
          },
        };
      }
      if (error.status === 404) return { status: 404, body: { error: error.reason ?? 'no such pull request' } };
      return { status: 409, body: { error: error.reason ?? error.message, github: error.status } };
    }
  },

  /**
   * Promote or Roll back: starts the repository's promote or rollback workflow (the repository's promote.yml and
   * rollback.yml) on its default branch, with inputs the workflow checks again. Only for a repository with
   * a pipeline. The owner's, from the signed-in browser only (the Worker refuses anything else).
   */
  async githubRelease(action, { sha, destructiveOk, version, reason, next, repo: slug = null } = {}) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { error: 'GitHub isn’t connected yet' } };
    if (action === 'release') return this.packageRelease(repo, credentials, version, next);
    if (action === 'prerelease') return this.buildPrerelease(repo, credentials);
    const pipeline = pipelineOf(repo);
    if (!pipeline)
      return {
        status: 409,
        body: { error: `${repo.name} has no deploy pipeline, so there’s nothing to promote or roll back.` },
      };
    const flow = this.githubRepoView(repo, true).flow;
    let workflow;
    let inputs;
    let event;
    if (action === 'promote') {
      if (!/^[0-9a-f]{40}$/u.test(String(sha ?? '')))
        return { status: 400, body: { error: 'send the full commit of the staging build you saw as "sha"' } };
      if (!flow.promote.allowed) return { status: 409, body: { error: flow.promote.reason } };
      if (flow.promote.sha !== sha)
        return {
          status: 409,
          body: {
            error: `Staging has moved on to ${flow.candidate.sha7}. Look at it and promote that one.`,
            candidate: flow.candidate.sha,
          },
        };
      if (flow.ahead?.destructive.length && destructiveOk !== true) {
        return {
          status: 409,
          body: {
            error: `It carries a destructive migration (${flow.ahead.destructive.join(', ')}). Confirm that you’ve read it first.`,
            destructive: flow.ahead.destructive,
          },
        };
      }
      workflow = pipeline.promote;
      inputs = { sha, destructive_ok: destructiveOk === true ? 'true' : 'false' };
      event = { kind: 'promote_started', sha7: sha.slice(0, 7), tasks: flow.ahead?.tasks.map((t) => t.wid) ?? [] };
    } else {
      const text = String(reason ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!text)
        return { status: 400, body: { error: 'say what broke: it shows in Cloudflare and on the Deployment' } };
      if (text.length > 140) return { status: 400, body: { error: 'keep the reason to 140 characters' } };
      if (version && !flow.rollback.versions.some((v) => v.version === version))
        return { status: 400, body: { error: 'that isn’t a version production has run before' } };
      if (!flow.rollback.allowed) return { status: 409, body: { error: flow.rollback.reason } };
      workflow = pipeline.rollback;
      inputs = { worker: pipeline.production, reason: text, ...(version ? { version } : {}) };
      event = {
        kind: 'rollback_started',
        version: version ?? flow.rollback.versions[0]?.version ?? null,
        reason: text,
      };
    }
    return this.dispatchRelease(repo, credentials, { workflow, ref: pipeline.branch, inputs, event });
  },

  /**
   * Release (BRK-103, WEB-39, IDEA-27 section 2b): starts the stable job of the repository's release.yml with the
   * pre-release the owner chose, so that commit's files are staged on npm as `X.Y.Z` on latest, waiting for the owner's
   * 2FA there, and with `next` (patch, minor, or major), what main works toward afterwards. The board never publishes
   * or approves on npm. Refused unless the repository's pipeline names a package and the Packages feed knows the
   * pre-release; once the feed knows its stable, staged or published (npm takes a version once); and for minor or major
   * when the next version is already set, by a later pre-release or an open +version task. The workflow checks the
   * tags again.
   */
  async packageRelease(repo, credentials, version, next = null) {
    const pkg = packageOf(repo);
    if (!pkg)
      return {
        status: 409,
        body: {
          error: `${repo.name} releases no npm package: set the pipeline’s package first (repos modify --pipeline).`,
        },
      };
    const step = next === null || next === undefined || next === '' ? 'patch' : String(next);
    if (!NEXT_STEPS.includes(step)) return { status: 400, body: { error: 'next is patch, minor, or major' } };
    // Its tag (widgets@1.4.0-main.5, v1.4.0-main.5) names it too.
    const given = String(version ?? '').trim();
    const wanted = given.startsWith(`${pkg.name}@`) ? given.slice(pkg.name.length + 1) : given.replace(/^v/u, '');
    const stable = stableOf(wanted);
    if (!stable)
      return {
        status: 400,
        body: { error: 'send the pre-release to release as "version", like 1.4.0-main.5' },
      };
    const known = this.sql
      .exec('SELECT version FROM gh_packages WHERE repo = ? AND name = ?', repo.slug, pkg.name)
      .toArray();
    if (!known.some((v) => v.version === wanted))
      return {
        status: 409,
        body: {
          error: `The board hasn’t seen ${pkg.name}@${wanted} staged. Pick a pre-release from the Packages feed, or sync first.`,
        },
      };
    const offer = this.releaseOffers(repo.slug)?.({ name: pkg.name, version: wanted });
    if (offer?.superseded) {
      const from = offer.superseded.from ? `, from ${offer.superseded.from}` : '';
      return {
        status: 409,
        body: {
          error: `${pkg.name}@${stable} is already out${from}, and npm takes a version once. Release a newer pre-release.`,
          superseded: offer.superseded,
        },
      };
    }
    if (step !== 'patch' && offer?.next && !offer.next.ask) {
      const why =
        offer.next.why === 'prerelease'
          ? `${offer.next.prerelease} is already out`
          : `${offer.next.task.wid ?? offer.next.task.short} is preparing it`;
      const what = offer.next.version ? `already ${offer.next.version}` : 'already being set';
      return {
        status: 409,
        body: { error: `${repo.name}’s next version is ${what} (${why}): release it with patch.` },
      };
    }
    // Patch is the stable job's default, so it isn't sent: a release.yml rendered before it took next still runs.
    const inputs = { prerelease: `${pkg.prefix}${wanted}`, ...(step === 'patch' ? {} : { next: step }) };
    const event = { kind: 'release_started', package: pkg.name, prerelease: wanted, version: stable, next: step };
    const answer = await this.dispatchRelease(repo, credentials, {
      workflow: pkg.workflow,
      ref: pkg.branch,
      inputs,
      event,
    });
    if (answer.status === 409 && answer.body.github === 422 && /unexpected inputs/iu.test(answer.body.error ?? ''))
      return {
        status: 409,
        body: {
          error: `${repo.name}’s ${pkg.workflow} doesn’t take next yet: render it again with npx breakaway pipeline init in its checkout and merge that, or release with patch and set package.json’s version yourself.`,
          workflow: pkg.workflow,
        },
      };
    return answer;
  },

  /**
   * Build a pre-release (WEB-113): starts the pre-release job of the repository's release workflow on its default
   * branch, with `prerelease` empty, the same run Run workflow… starts (BRK-224). Only where that workflow builds
   * pre-releases by hand (BRK-273), and refused while one builds, when the latest pre-release already has everything
   * on the branch, or while CI on its latest commit isn't green: the workflow checks those again and would stop.
   */
  async buildPrerelease(repo, credentials) {
    const pkg = packageOf(repo);
    const build = this.githubRepoView(repo, true).releaseBuild;
    if (!pkg || !build)
      return {
        status: 409,
        body: {
          error: pkg
            ? `${repo.name}’s ${pkg.workflow} builds its pre-releases by itself after CI, so there’s nothing to build by hand.`
            : `${repo.name} releases no npm package: set the pipeline’s package first (repos modify --pipeline).`,
        },
      };
    if (!build.allowed) return { status: 409, body: { error: build.reason } };
    const event = {
      kind: 'prerelease_started',
      package: pkg.name,
      branch: pkg.branch,
      after: build.latest?.version ?? null,
      merges: build.ahead?.merges ?? null,
    };
    return this.dispatchRelease(repo, credentials, {
      workflow: pkg.workflow,
      ref: pkg.branch,
      inputs: { prerelease: '' },
      event,
    });
  },

  /** Starts `workflow` on `ref` with `inputs` through the GitHub App, and records `event` in Activity once it has. */
  async dispatchRelease(repo, credentials, { workflow, ref, inputs, event }) {
    const client = this.githubClient(credentials, repo);
    try {
      await client.send('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 403 && /not accessible by integration/iu.test(error.reason ?? '')) {
        return {
          status: 403,
          body: {
            error:
              'The board’s GitHub App can’t start workflows yet: give it read and write on Actions, then accept the change on the installation (docs/tasks.md#github). Until then, run the workflow from GitHub: Actions, then Run workflow.',
            permission: true,
            workflow,
          },
        };
      }
      return { status: 409, body: { error: error.reason ?? error.message, github: error.status } };
    }
    this.sql.exec(
      'INSERT INTO gh_events (at, data, repo) VALUES (?, ?, ?)',
      Date.now(),
      JSON.stringify(event),
      repo.slug,
    );
    await this.githubWebhook('workflow_run', null, { slug: repo.slug }); // sync 5 seconds from now
    return { status: 200, body: { ok: true, action: event.kind, workflow } };
  },

  /**
   * A repository's workflows that run by hand (BRK-224, docs/specs/BRK-223-run-workflows.md): its active workflows
   * under .github/workflows/, each read on the default branch for a `workflow_dispatch` trigger and its inputs. Kept
   * for 5 minutes, and dropped when a push to the default branch changes a workflow. `{ list }`, or `{ error }`, a
   * response with what to do.
   */
  async workflowList(repo, credentials) {
    this.workflowCache ??= {};
    const kept = this.workflowCache[repo.slug];
    if (kept && kept.branch === repo.defaultBranch && Date.now() - kept.at < WORKFLOWS_MS) return { list: kept.list };
    const client = this.githubClient(credentials, repo);
    const branch = encodeURIComponent(repo.defaultBranch || 'main');
    let all;
    try {
      all = await client.get('/actions/workflows?per_page=100');
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (isEmptyRepo(error)) return { list: [] };
      if (error.status === 404)
        return {
          error: {
            status: 409,
            body: {
              error: `The board’s GitHub App isn’t installed on ${repo.github}, or can’t read it. Install it there; Connections shows how.`,
            },
          },
        };
      return { error: { status: 502, body: { error: error.reason ?? error.message, github: error.status } } };
    }
    const files = (all?.workflows ?? [])
      .filter((w) => w.state === 'active' && /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(String(w.path ?? '')))
      .slice(0, MAX_WORKFLOW_FILES);
    const read = await Promise.allSettled(
      files.map((w) => client.get(`/contents/${w.path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`)),
    );
    const list = [];
    files.forEach((w, i) => {
      const got = read[i];
      if (got.status === 'rejected' && !(got.reason instanceof GitHubError)) throw got.reason;
      // Not on the default branch (a workflow only a branch has): GitHub can't run it from there either.
      if (got.status === 'rejected' && got.reason.status === 404) return;
      const base = {
        id: w.id,
        name: String(w.name ?? w.path),
        path: w.path,
        url: `https://github.com/${repo.github}/actions/workflows/${w.path.split('/').pop()}`,
      };
      if (got.status === 'rejected') {
        list.push({ ...base, readable: false, inputs: [], reason: got.reason.reason ?? got.reason.message });
        return;
      }
      const bytes = Uint8Array.from(atob(String(got.value?.content ?? '').replace(/\s+/gu, '')), (c) =>
        c.charCodeAt(0),
      );
      const found = dispatchOf(new TextDecoder().decode(bytes));
      if (!found) return;
      list.push(
        'reason' in found
          ? { ...base, readable: false, inputs: [], reason: found.reason }
          : { ...base, readable: true, inputs: found.inputs },
      );
    });
    list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    this.workflowCache[repo.slug] = { at: Date.now(), branch: repo.defaultBranch, list };
    return { list };
  },

  /** A push changed a workflow on `slug`'s default branch: read its workflows again next time. */
  dropWorkflows(slug) {
    if (this.workflowCache) delete this.workflowCache[slug];
    this.setGhMeta('gh_release_mode', slug, null);
  },

  /**
   * GET /api/github/workflows (BRK-224): repository `slug`'s workflows that run by hand (the default's when empty),
   * with the branches a run may start on (the default and its open pull requests' heads) and whether the App may start
   * workflows there. Anyone signed in reads it.
   */
  async workflowsApi(slug = null) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials)
      return {
        status: 409,
        body: { error: 'GitHub isn’t connected yet: connect it from the GitHub view, then run a workflow from here.' },
      };
    const { list, error } = await this.workflowList(repo, credentials);
    if (error) return error;
    const branch = repo.defaultBranch || 'main';
    const heads = this.sql
      .exec("SELECT data FROM gh_pulls WHERE repo = ? AND state = 'open'", repo.slug)
      .toArray()
      .map((r) => JSON.parse(r.data).branch)
      .filter((b) => typeof b === 'string' && validRef(b));
    const live = JSON.parse(this.meta('conn_live') ?? 'null');
    const access = pullAccess(live?.repos?.[repo.slug] ?? null, { github: repo.github, at: live?.at ?? null });
    return {
      status: 200,
      body: {
        repo: repo.slug,
        github: repo.github,
        workflows: list,
        branch,
        branches: [branch, ...[...new Set(heads)].filter((b) => b !== branch).sort()],
        actions: access.actions,
      },
    };
  },

  /**
   * POST /api/github/workflows/run (BRK-224): starts one of the repository's workflows that run by hand on `ref`, with
   * `inputs` checked against the ones the board read. The owner's, from the signed-in browser only (the Worker refuses
   * anything else). Activity records the workflow, the ref, and the inputs' names, never their values.
   */
  async runWorkflowApi({ repo: slug = null, workflow, ref, inputs } = {}) {
    await this.ready();
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { error: 'GitHub isn’t connected yet' } };
    const wanted = String(workflow ?? '');
    if (!wanted) return { status: 400, body: { error: 'send the workflow to run, its id or its path, as "workflow"' } };
    const { list, error } = await this.workflowList(repo, credentials);
    if (error) return error;
    const found = list.find((w) => String(w.id) === wanted || w.path === wanted);
    if (!found)
      return {
        status: 404,
        body: {
          error: `${repo.name} has no workflow ${wanted.slice(0, 80)} that runs by hand on ${repo.defaultBranch}.`,
        },
      };
    if (!found.readable)
      return {
        status: 409,
        body: { error: `The board can’t read ${found.name}’s inputs: run it on GitHub.`, url: found.url },
      };
    const on = ref === undefined || ref === null || ref === '' ? repo.defaultBranch || 'main' : ref;
    if (!validRef(on)) return { status: 400, body: { error: 'run on a branch or tag name, like main or v1.6.0' } };
    const checked = checkInputs(found.inputs, inputs);
    if ('error' in checked) return { status: 400, body: { error: checked.error } };
    const event = {
      kind: 'workflow_started',
      workflow: found.name,
      path: found.path,
      ref: on,
      inputs: Object.keys(checked.inputs),
      url: found.url,
    };
    const answer = await this.dispatchRelease(repo, credentials, {
      workflow: String(found.id),
      ref: on,
      inputs: checked.inputs,
      event,
    });
    if (answer.status !== 200) return answer;
    return { status: 200, body: { ...answer.body, name: found.name, ref: on, url: found.url } };
  },

  /**
   * Repository `slug`'s agent prompt (the default's when empty) as it is on its default branch, at the path its
   * registry entry gives, with the commit that last changed it, so the owner can copy it, and the stub that
   * points to it, from the Agents view (CLD-132). Read live through the GitHub App and kept for a minute; the
   * board's own build may be older. `missing` when the App reads the repository but the file isn't there (not
   * kept, so adding it shows at once); a 502 with GitHub's reason when it can't read the repository.
   */
  async routinePromptApi(slug = null) {
    await this.ready();
    const { repo, error: unknown } = this.githubRepoOr404(slug);
    if (unknown) return unknown;
    const path = promptPathOf(repo);
    const head = { slug: repo.slug, path };
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 409, body: { ...head, error: 'GitHub isn’t connected yet' } };
    this.promptCache ??= {};
    const kept = this.promptCache[repo.slug];
    if (kept && kept.body.path === path && Date.now() - kept.at < PROMPT_CACHE_MS)
      return { status: 200, body: kept.body };
    const client = this.githubClient(credentials, repo);
    const branch = encodeURIComponent(repo.defaultBranch);
    const [file, commits] = await Promise.allSettled([
      client.get(`/contents/${path}?ref=${branch}`),
      client.get(`/commits?sha=${branch}&path=${encodeURIComponent(path)}&per_page=1`),
    ]);
    for (const r of [file, commits]) if (r.status === 'rejected' && !(r.reason instanceof GitHubError)) throw r.reason;
    // An empty repository (CLD-191) has no prompt yet: missing, and `empty` so the view says to run repos init.
    if ([file, commits].some((r) => r.status === 'rejected' && isEmptyRepo(r.reason)))
      return { status: 200, body: { ...head, missing: true, empty: true, text: null, url: null, commit: null } };
    if (file.status === 'rejected') {
      // A 404 on the file while the history reads is a missing file; GitHub answers 404 for a repository it hides too.
      if (file.reason.status === 404 && commits.status === 'fulfilled')
        return { status: 200, body: { ...head, missing: true, text: null, url: null, commit: null } };
      return {
        status: 502,
        body: { ...head, error: file.reason.reason ?? file.reason.message, github: file.reason.status },
      };
    }
    const bytes = Uint8Array.from(atob(String(file.value.content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0));
    const last = commits.status === 'fulfilled' ? commits.value[0] : null;
    const body = {
      ...head,
      missing: false,
      text: new TextDecoder().decode(bytes),
      url: file.value.html_url ?? null,
      commit: last
        ? {
            sha: last.sha,
            url: last.html_url ?? null,
            date: last.commit?.committer?.date ?? null,
            message: String(last.commit?.message ?? '').split('\n')[0],
          }
        : null,
    };
    // The `<…>` still in it (CLD-196): the Agents view lists them, and agents don't start until they're filled in.
    /** @type {any} */ (body).placeholders = promptPlaceholders(body.text);
    this.promptCache[repo.slug] = { at: Date.now(), body };
    return { status: 200, body };
  },

  /**
   * The board's core (prompts/core.md) as repository `slug` carries it on its default branch, for MCP's
   * `breakaway://prompt` (docs/specs/IDEA-24-mcp-server.md, section 4): where `repos init` copies it, else where
   * breakaway's own checkout keeps it. Kept for a minute, as the prompt is. When the repository carries neither, or
   * GitHub can't be read, it's the board's own copy, marked `source: 'board'` (with GitHub's reason when it failed,
   * and then not kept), so a client always reads the rules it works under.
   */
  async agentCoreApi(slug = null) {
    await this.ready();
    const { repo, error: unknown } = this.githubRepoOr404(slug);
    if (unknown) return unknown;
    const board = (error = null) => ({
      slug: repo.slug,
      path: 'prompts/core.md',
      source: 'board',
      error,
      text: /** @type {Record<string, string>} */ (BOARD_FILES)['prompts/core.md'],
    });
    const credentials = await appCredentials(this.env);
    if (!credentials) return { status: 200, body: board('GitHub isn’t connected yet') };
    this.coreCache ??= {};
    const kept = this.coreCache[repo.slug];
    if (kept && Date.now() - kept.at < PROMPT_CACHE_MS) return { status: 200, body: kept.body };
    const client = this.githubClient(credentials, repo);
    const branch = encodeURIComponent(repo.defaultBranch);
    let body = null;
    for (const path of CORE_PATHS) {
      try {
        const file = await client.get(`/contents/${path}?ref=${branch}`);
        const bytes = Uint8Array.from(atob(String(file.content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0));
        body = { slug: repo.slug, path, source: 'repository', error: null, text: new TextDecoder().decode(bytes) };
        break;
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        if (error.status !== 404 && !isEmptyRepo(error))
          return { status: 200, body: board(error.reason ?? error.message) };
      }
    }
    body ??= board();
    this.coreCache[repo.slug] = { at: Date.now(), body };
    return { status: 200, body };
  },

  /** GitHub events between two times (ms), newest first, for the activity feed, each with its repository. */
  githubEvents(after, upTo) {
    return this.sql
      .exec('SELECT id, at, data, repo FROM gh_events WHERE at > ? AND at <= ? ORDER BY at DESC, id DESC', after, upTo)
      .toArray()
      .map((r) => ({ id: r.id, at: r.at, ...JSON.parse(r.data), repo: r.repo }));
  },

  /** The Sync button: one repository (the default when `slug` is empty), or `all` of them, then the view. */
  async githubSyncApi(slug = null) {
    if (slug === 'all') {
      const result = await this.reconcileGitHub();
      if (result.error) return { status: 502, body: { error: result.error } };
      return this.githubOverview('all');
    }
    const { repo, error: missing } = this.githubRepoOr404(slug);
    if (missing) return missing;
    const result = await this.reconcileGitHub({ only: [repo.slug] });
    if (result.repos?.[repo.slug]?.error) return { status: 502, body: { error: result.repos[repo.slug].error } };
    return this.githubOverview(repo.slug);
  },
};
