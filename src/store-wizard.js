/**
 * TaskStore's side of the Add a repository wizard (CLD-194): GET /api/repos/setup gathers what the board can
 * see about one repository being added (its live GitHub installation, its sync, its agent prompt on the
 * default branch, its routine, and its first task, agent, and pull request) and wizard.js turns it into the
 * steps. Before a repository is registered it's named by `github` alone, and only the GitHub steps can tick.
 * Reads only, like Connections: it never writes to GitHub, starts an agent, or costs a Claude start.
 */
import { appCredentials, appGet, GitHubError } from './github.js';
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';
import { promptPathOf, repoSlugOf } from './repos.js';
import { clip } from './connections.js';
import { promptPlaceholders, slugFrom, wizardSteps } from './wizard.js';

const GITHUB = /^[\w.-]{1,39}\/[\w.-]{1,100}$/u;
/** A live check of one repository at most this often; the page asks about every 20 seconds while it's open. */
const LIVE_GAP_MS = 15_000;
/** How long an answer about a repository that isn't registered yet is kept for the page's next look. */
const KEEP_MS = 10 * 60_000;

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const wizardMethods = {
  /**
   * GET /api/repos/setup?slug=<slug> (a registered repository) or ?github=<owner/name> (one not registered
   * yet). `check` asks GitHub live about it (at most every 15 seconds); otherwise the last check is used.
   * Answers `{ slug, github, registered, suggestedSlug, checked, steps, now, done }`.
   */
  repoSetupApi({ slug = null, github = null, check = false } = {}) {
    return this.run(async () => {
      const facts = await this.wizardFacts({ slug, github, check });
      const { steps, now, done } = wizardSteps(facts);
      const repo = facts.registered;
      return {
        status: 200,
        body: {
          slug: repo?.slug ?? null,
          github: facts.github,
          name: repo?.name ?? null,
          registered: Boolean(repo),
          isDefault: Boolean(repo?.isDefault),
          suggestedSlug: repo ? null : slugFrom(facts.github),
          promptPath: promptPathOf(repo),
          app: facts.appInfo,
          checked: iso(facts.checkedAt),
          steps,
          now,
          done,
        },
      };
    });
  },

  async wizardFacts({ slug, github, check }) {
    let repo = null;
    if (slug) {
      repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
    } else {
      const name = String(github ?? '')
        .trim()
        .replace(/^https:\/\/github\.com\//u, '')
        .replace(/\.git$/u, '')
        .replace(/\/$/u, '');
      if (!GITHUB.test(name)) throw new InputError('say which repository: its owner/name, like your-name/web');
      // Already registered? Then it's that repository's page.
      repo = this.repos().find((r) => r.github.toLowerCase() === name.toLowerCase()) ?? {
        slug: null,
        github: name,
        pipeline: null,
        unregistered: true,
      };
    }
    const registered = repo.unregistered ? null : repo;
    const credentials = await appCredentials(this.env);
    const live = JSON.parse(this.meta('conn_live') ?? 'null');
    let app = live?.app?.ok ? live.app : null;
    let r = registered ? (live?.repos?.[registered.slug] ?? null) : null;
    let checkedAt = registered && r ? live.at : null;
    if (credentials && (check || (!registered && !this.setupLive?.[repo.github.toLowerCase()]))) {
      ({ app, r, checkedAt } = await this.wizardLiveCheck(credentials, repo, app));
    } else if (!registered) {
      ({ r, at: checkedAt } = this.setupLive?.[repo.github.toLowerCase()] ?? {});
    }

    // Connections' rows for this repository: GitHub's from the live check, the sync's and the routine's as Connections has them.
    const connections = [];
    if (app && credentials) connections.push(...this.githubRepoConnections(repo, r, app, iso(checkedAt)));
    let routine = false;
    let prompt = null;
    if (registered) {
      connections.push(...this.githubSyncConnections(live).filter((c) => c.repo === registered.slug));
      routine = (await this.routineConnectedState(registered.slug)).routineConnected;
      connections.push(
        ...(await this.claudeConnections()).filter(
          (c) =>
            (c.repo ?? this.defaultRepoSlug()) === registered.slug &&
            ['claude.routine', 'claude.output'].includes(c.id),
        ),
      );
      prompt = credentials ? await this.wizardPrompt(registered.slug) : null;
    }
    return {
      github: repo.github,
      registered,
      connections,
      app: Boolean(credentials),
      appInfo: app ? { slug: app.slug ?? null, name: app.name ?? null } : null,
      empty: registered ? Boolean(this.ghMeta('gh_empty', registered.slug)) : false,
      synced: registered ? Number(this.ghMeta('gh_last_sync', registered.slug) ?? 0) || null : null,
      prompt,
      routine,
      work: registered ? this.wizardWork(registered.slug) : {},
      checkedAt,
    };
  },

  /** Asks GitHub about one repository now (at most every 15 seconds), and keeps it where Connections reads it. */
  async wizardLiveCheck(credentials, repo, known) {
    const base = this.env.TASKS_GITHUB_API || undefined;
    const key = repo.github.toLowerCase();
    this.setupLive ??= {};
    const kept = this.setupLive[key];
    if (kept && Date.now() - kept.at < LIVE_GAP_MS && known) return { app: known, r: kept.r, checkedAt: kept.at };
    let app = known;
    if (!app) {
      try {
        const a = await appGet(credentials, '/app', base);
        app = { ok: true, id: a.id ?? null, slug: a.slug ?? null, name: a.name ?? null, url: a.html_url ?? null };
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return { app: null, r: null, checkedAt: null };
      }
    }
    const r = await this.connectionsCheckRepo(credentials, repo, base);
    const at = Date.now();
    // Only recent answers are kept, so names that were only looked up once don't pile up in memory.
    for (const [name, entry] of Object.entries(this.setupLive))
      if (at - entry.at > KEEP_MS) delete this.setupLive[name];
    this.setupLive[key] = { at, r };
    // A registered repository's check is Connections' too, so both say the same.
    if (repo.slug && !repo.unregistered) {
      const live = JSON.parse(this.meta('conn_live') ?? 'null');
      if (live?.app?.ok)
        this.setMeta('conn_live', JSON.stringify({ ...live, repos: { ...live.repos, [repo.slug]: r } }));
    }
    return { app, r, checkedAt: at };
  },

  /** The repository's agent prompt on its default branch, as the Agents view reads it, and its placeholders. */
  async wizardPrompt(slug) {
    const repo = this.repoBySlug(slug);
    const path = promptPathOf(repo);
    let result;
    try {
      result = await this.routinePromptApi(slug);
    } catch (error) {
      return { status: 'unreadable', path, error: clip(error.message), placeholders: [], url: null };
    }
    const body = result.body ?? {};
    if (result.status !== 200)
      return { status: 'unreadable', path, error: clip(body.error ?? ''), placeholders: [], url: null };
    if (body.empty) return { status: 'empty', path, placeholders: [], url: null };
    if (body.missing) return { status: 'missing', path, placeholders: [], url: null };
    return {
      status: 'ok',
      path,
      placeholders: body.placeholders ?? promptPlaceholders(body.text),
      url: body.url ?? null,
    };
  },

  /**
   * Why no agent may start in repository `slug` because of its prompt (CLD-196), or null: a `<…>` still in it on
   * the default branch is an instruction an agent would try to follow. A prompt the board can't read (no GitHub,
   * a refusal) or that's missing doesn't stop a start here; Connections and the Agents view say so.
   */
  async promptBlocker(slug) {
    const prompt = await this.wizardPrompt(slug);
    if (prompt.status !== 'ok' || !prompt.placeholders.length) return null;
    const n = prompt.placeholders.length;
    const branch = this.repoBySlug(slug)?.defaultBranch ?? 'main';
    return `${slug}’s agent prompt (${prompt.path} on ${branch}) still has ${n === 1 ? 'a placeholder' : `${n} placeholders`}, ${prompt.placeholders.join(', ')}, which an agent would take as instructions. Fill ${n === 1 ? 'it' : 'them'} in and merge, then start it again`;
  },

  /**
   * The repository's first steps of real work: how many tasks it has, whether one was claimed from its own
   * checkout (the CLI sends the checkout's repository), and its first agent start, live output, pull request
   * (a task's `pr`), and merge (that task finished, or the pull request merged). Each names a task.
   */
  wizardWork(slug) {
    const fallback = this.defaultRepoSlug();
    const own = [...this.tasks.entries()].filter(([, m]) => repoSlugOf(m, fallback) === slug && m.status !== 'deleted');
    const named = (uuid) => (uuid ? { wid: this.tasks.get(uuid)?.wid ?? uuid.slice(0, 8), uuid } : null);
    const ofRepo = new Set(own.map(([uuid]) => uuid));

    const claimedUuid = this.meta(`setup_claimed:${slug}`);
    const claimed = claimedUuid && this.tasks.has(claimedUuid) ? named(claimedUuid) : null;

    const run = this.sql
      .exec(
        "SELECT task FROM agent_runs WHERE status = 'started' AND COALESCE(repo, ?) = ? ORDER BY id LIMIT 1",
        fallback,
        slug,
      )
      .toArray()[0];
    let output = null;
    for (const row of this.sql.exec('SELECT task FROM agent_logs GROUP BY task ORDER BY MIN(id)').toArray()) {
      if (ofRepo.has(row.task)) {
        output = named(row.task);
        break;
      }
    }
    let pull = null;
    let merged = null;
    for (const [uuid, m] of own) {
      const number = Number.parseInt(String(m.pr ?? ''), 10);
      if (!number) continue;
      const row = this.sql
        .exec('SELECT state, data FROM gh_pulls WHERE repo = ? AND number = ?', slug, number)
        .toArray()[0];
      const data = row ? JSON.parse(row.data) : null;
      pull ??= {
        ...named(uuid),
        number,
        url: data?.url ?? `https://github.com/${this.repoBySlug(slug)?.github}/pull/${number}`,
      };
      if (!merged && (m.status === 'completed' || row?.state === 'merged')) merged = { ...named(uuid), number };
    }
    return { tasks: own.length, claimed, started: named(run?.task ?? null), output, pull, merged };
  },
};
