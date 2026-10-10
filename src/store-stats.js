/**
 * The Activity view's dashboard (CLD-185): GET /api/stats?days=30&tz=Europe/Amsterdam.
 *
 * GitHub's tables keep only the latest rows (KEEP in store-github.js) and agent runs go after 30
 * days, so every tick copies the finished ones into `stats_log`: one small row per merged pull
 * request, finished workflow run, finished deployment, and agent run, kept for STATS_KEEP_DAYS.
 * Rows hold counts and times only: no titles, no task text, no output.
 */
import { view } from './model.js';
import { pipelineOf } from './release.js';
import { repoSlugOf } from './repos.js';
import { computeStats, STATS_DAYS, zoneOf } from './stats.js';

const STATS_KEEP_DAYS = 400;
const FINAL_DEPLOY = new Set(['success', 'failure', 'error', 'inactive']);

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const statsMethods = {
  initStats() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stats_log (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE INDEX IF NOT EXISTS stats_log_at ON stats_log (kind, at);
    `);
    // The repository a row came from. Rows logged before this have none: the default repository's.
    if (
      !this.sql
        .exec('PRAGMA table_info(stats_log)')
        .toArray()
        .some((c) => c.name === 'repo')
    )
      this.sql.exec('ALTER TABLE stats_log ADD COLUMN repo TEXT');
  },

  /** Writes a row only when it's new or changed, so a quiet tick writes nothing. */
  logStat(kind, key, at, data, repo) {
    if (!Number.isFinite(at)) return;
    this.sql.exec(
      'INSERT INTO stats_log (kind, key, at, data, repo) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET at = excluded.at, data = excluded.data, repo = excluded.repo WHERE stats_log.at != excluded.at OR stats_log.data != excluded.data OR stats_log.repo IS NOT excluded.repo',
      kind,
      String(key),
      at,
      JSON.stringify(data),
      repo,
    );
  },

  /** Copies what the GitHub and agent tables hold now into the long-lived log, then trims it. */
  archiveStats() {
    const fallback = this.defaultRepoSlug();
    for (const row of this.sql.exec("SELECT repo, data FROM gh_pulls WHERE state = 'merged'").toArray()) {
      const pr = JSON.parse(row.data);
      // Pull requests are numbered per repository: the default's keep the bare number they were logged with.
      this.logStat(
        'pr',
        row.repo === fallback ? pr.number : `${row.repo}#${pr.number}`,
        ms(pr.mergedAt),
        { created: ms(pr.created), author: pr.author ?? null },
        row.repo,
      );
    }
    for (const row of this.sql.exec('SELECT repo, data FROM gh_runs').toArray()) {
      const r = JSON.parse(row.data);
      if (r.status !== 'completed') continue;
      const started = ms(r.started);
      const updated = ms(r.updated);
      this.logStat(
        'run',
        r.id,
        ms(r.created),
        {
          name: r.name,
          event: r.event ?? null,
          branch: r.branch ?? null,
          conclusion: r.conclusion ?? null,
          duration: started && updated && updated >= started ? updated - started : null,
        },
        row.repo,
      );
    }
    for (const row of this.sql.exec('SELECT repo, state, data FROM gh_deploys').toArray()) {
      if (!FINAL_DEPLOY.has(row.state)) continue;
      const d = JSON.parse(row.data);
      // `inactive` is a success a newer deploy replaced: it still landed.
      this.logStat(
        'deploy',
        d.id,
        ms(d.created),
        {
          env: d.env,
          task: d.task ?? 'deploy',
          state: row.state,
          landed: row.state === 'success' || row.state === 'inactive' || Boolean(d.landed),
        },
        row.repo,
      );
    }
    for (const r of this.sql
      .exec('SELECT id, task, agent, trigger, kind, status, started, repo FROM agent_runs')
      .toArray()) {
      this.logStat(
        'agent',
        r.id,
        r.started,
        { task: r.task, agent: r.agent, trigger: r.trigger, kind: r.kind, status: r.status },
        r.repo ?? fallback,
      );
    }
    this.sql.exec('DELETE FROM stats_log WHERE at < ?', Date.now() - STATS_KEEP_DAYS * 86_400_000);
  },

  /** `repo` limits every number to one registered repository; empty is the whole board. */
  async statsApi({ days, tz, repo } = {}) {
    await this.ready();
    const fallback = this.defaultRepoSlug();
    const scope = repo && repo !== 'all' ? this.githubRepoOr404(repo) : { repo: null };
    if (scope.error) return scope.error;
    const slug = scope.repo?.slug ?? null;
    const n = Math.round(Number(days));
    const span = Number.isFinite(n) && n >= STATS_DAYS.min && n <= STATS_DAYS.max ? n : STATS_DAYS.fallback;
    const zone = zoneOf(tz);
    this.archiveStats();
    const now = Date.now();
    // Two windows of `span` days, plus a day each side for time zones.
    const since = now - (2 * span + 2) * 86_400_000;
    const log = (kind) =>
      this.sql
        .exec(
          'SELECT at, data FROM stats_log WHERE kind = ? AND at >= ? AND (? IS NULL OR COALESCE(repo, ?) = ?)',
          kind,
          since,
          slug,
          fallback,
          slug,
        )
        .toArray()
        .map((r) => ({ at: r.at, ...JSON.parse(r.data) }));
    // A pipeline's Deployments (and the ships they record) are named after its Workers: count them as staging and production.
    const role = new Map();
    for (const p of this.repos().map(pipelineOf)) {
      if (!p) continue;
      role.set(p.staging, 'staging');
      role.set(p.production, 'production');
    }
    const envOf = (env) => role.get(env) ?? env;

    // The plain task views: GitHub's links and agent runs aren't needed to count.
    const at = new Date(now);
    const views = [...this.tasks]
      .filter(([, map]) => !slug || repoSlugOf(map, fallback) === slug)
      .map(([uuid, map]) => view(uuid, map, this.tasks, at));
    const tasks = views.map((t) => ({
      wid: t.wid,
      project: t.project,
      status: t.status,
      horizon: t.horizon,
      tags: t.tags,
      who: t.who,
      claim: t.claim,
      entry: ms(t.entry),
      end: ms(t.end),
      ready: t.ready,
      blocked: t.blocked,
    }));
    const done = new Map(views.map((t) => [t.uuid, t.status === 'completed']));
    const wids = new Set(tasks.map((t) => t.wid));
    const openPrs = this.sql
      .exec("SELECT data FROM gh_pulls WHERE state = 'open' AND (? IS NULL OR repo = ?)", slug, slug)
      .toArray()
      .map((r) => JSON.parse(r.data));

    const body = computeStats({
      now,
      days: span,
      tz: zone,
      tasks,
      prs: log('pr').map((p) => ({ merged: p.at, created: p.created, author: p.author })),
      runs: log('run').map((r) => ({ ...r, created: r.at })),
      deploys: log('deploy').map((d) => ({ ...d, env: envOf(d.env) })),
      ships: this.sql
        .exec('SELECT wid, env, at FROM gh_ships')
        .toArray()
        .filter((s) => !slug || wids.has(s.wid))
        .map((s) => ({ wid: s.wid, env: envOf(s.env), at: ms(s.at) })),
      agentRuns: log('agent').map((r) => ({
        kind: r.kind,
        trigger: r.trigger,
        status: r.status,
        at: r.at,
        taskDone: done.get(r.task) ?? false,
      })),
      routineRuns: this.sql
        .exec(
          'SELECT slug, failed, started FROM routine_runs WHERE started >= ? AND (? IS NULL OR slug = ?)',
          since,
          slug,
          slug,
        )
        .toArray()
        .map((r) => ({ slug: r.slug, failed: Boolean(r.failed), at: r.started })),
      open: {
        prs: openPrs.filter((p) => !p.draft).length,
        drafts: openPrs.filter((p) => p.draft).length,
        alerts: this.sql
          .exec("SELECT COUNT(*) AS n FROM gh_dependabot WHERE state = 'open' AND (? IS NULL OR repo = ?)", slug, slug)
          .one().n,
      },
    });
    return { status: 200, body: { ...body, github: Boolean(this.meta('gh_initialized')) } };
  },
};
