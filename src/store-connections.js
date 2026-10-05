/**
 * TaskStore's Connections (docs/specs/IDEA-14-multi-repo.md, section 7): the state of everything the board
 * leans on (Cloudflare, the GitHub App, the Claude routine, Taskwarrior sync, and push), what the board saw
 * and when, and the fix. Cheap checks run on every read; the live ones (GitHub's App, installations,
 * permissions, auto-merge, webhook deliveries, rate limit) run on Check now and once an hour from the cron,
 * and their results are kept here. A check never starts an agent, never writes to GitHub, and never costs a
 * Claude start. What's stored and returned is states, names, numbers, and timestamps; a message from outside
 * the board is redacted first (connections.js), and a secret is only ever "set" or "unset".
 */
import { GitHubClient, GitHubError, appCredentials, appGet } from './github.js';
import { AgentError, connectCommand } from './store-agents.js';
import { promptPathOf, repoSlugOf } from './repos.js';
import { firstResult } from './wizard.js';
import { CLAUDE_LIMITS } from './plans.js';
import { vapidKeys } from './push.js';
import { docsLink, install, secretName } from './install.js';
import { checkReport, judgeStub, reportProblems, shortHash, stubText } from './session-report.js';
import BOARD_FILES from './board-files.json' with { type: 'json' };
import {
  SECRET_BINDINGS,
  appSettingsUrl,
  clip,
  comparePermissions,
  permissionsFix,
  routineFix,
  summarizeDeliveries,
  worst,
} from './connections.js';

const LIVE_EVERY_MS = 3_600_000; // the cron re-runs the live checks hourly
const CHECK_GAP_MS = 30_000; // Check now at most this often
const CRON_LATE_MS = 15 * 60_000; // the cron runs every 5 minutes
const SYNC_LATE_MS = 15 * 60_000;
const QUIET_HOOK_MS = 10 * 60_000; // a started agent with no live output after this is the CLD-37 failure
const SEEN_EVERY_MS = 60_000; // how often a replica's visit is written down
const GONE_FOR_MS = 24 * 3_600_000; // a replica stuck on 410 Gone needs attention until a day without one
const REPORT_WITHIN_MS = 24 * 3_600_000; // a session's report counts for a start this recent
const SETTLE_MS = 10 * 60_000; // a connection needs attention this long before the inbox hears of it, so a blip stays quiet
const NOTICES_KEPT_MS = 30 * 86_400_000;
/** Connections whose "needs attention" fixes itself and isn't worth an inbox note: the hourly budget rolls over. */
const QUIET = new Set(['claude.budget']);
/**
 * Connections whose trouble is someone else's and ends by itself (BRK-219): GitHub's own outages. The board
 * already waits them out, so the inbox hears only when they end: a hidden `held` note marks the outage, and
 * "working again" replaces it.
 */
const ENDS_BY_ITSELF = new Set(['github.status']);
const ROUTINES_URL = 'https://claude.ai/code/routines';
/** A link into the install's docs (none on an install without them). */
const doc = (env, anchor) => docsLink(install(env), anchor);
/** A URL's host, or words that stand in for it before the board knows where it answers. */
const hostOf = (url) => (url ? new URL(url).host : 'the board’s host');

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));

/** The key a connection's state and notes are kept under: its id, and its repository when it has one. */
const keyOf = (c) => (c.repo ? `${c.id}:${c.repo}` : c.id);

/** A connection note as the inbox shows it. */
const noticeView = (row) => {
  const [id, repo = null] = row.conn.split(':');
  return {
    id: row.id,
    connection: id,
    repo,
    kind: row.kind,
    name: row.name,
    detail: row.detail ?? '',
    at: new Date(row.created).toISOString(),
    resolved: row.resolved ? { at: new Date(row.resolved).toISOString(), how: row.resolution } : null,
  };
};

/** One connection as the API shows it. */
function entry(
  id,
  group,
  name,
  state,
  {
    repo = null,
    detail = '',
    at = null,
    fix = null,
    link = null,
    items = undefined,
    update = undefined,
    source = undefined,
    reading = undefined,
    verified = undefined,
    hold = undefined,
    override = undefined,
  } = {},
) {
  return {
    id,
    repo,
    group,
    name,
    state,
    detail,
    at,
    fix: state === 'working' ? null : fix,
    link,
    ...(items ? { items } : {}),
    ...(update ? { update } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(reading && state === 'working' ? { reading } : {}),
    ...(verified && state === 'working' ? { verified } : {}),
    ...(hold ? { hold } : {}),
    ...(override ? { override } : {}),
  };
}

/**
 * A repository's routine row with its agent prompt's state added (CLD-196): a `<…>` left in the prompt on the
 * default branch needs attention, because no agent starts there until it's filled in. `prompt` is wizardPrompt's.
 */
function unfilledPrompt(row, repo, prompt) {
  const left = prompt?.status === 'ok' ? prompt.placeholders : [];
  if (!left.length) return row;
  const n = left.length;
  const fix = `Fill in each <…> left in ${prompt.path} on ${repo.defaultBranch ?? 'main'} (${left.join(', ')}) and merge it: agents in ${repo.slug} wait until then.`;
  const { reading: _reading, verified: _verified, ...rest } = row;
  return {
    ...rest,
    state: 'attention',
    detail: `${row.detail}; its agent prompt still has ${n === 1 ? 'a placeholder' : `${n} placeholders`}, so agents don’t start`,
    fix: row.fix ? `${fix} ${row.fix}` : fix,
    link: prompt.url ?? row.link,
  };
}

/** Whether a secret binding resolves to a value (never what the value is). */
async function bindingState(env, name) {
  const binding = env[name];
  if (binding === undefined || binding === null) return 'missing';
  try {
    const value = typeof binding === 'string' ? binding : await binding.get();
    const trimmed = String(value ?? '').trim();
    return trimmed && trimmed !== 'unset' ? 'set' : 'unset';
  } catch {
    return 'unresolved';
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const connectionsMethods = {
  initConnections() {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS connection_states (id TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL, checked INTEGER NOT NULL)',
    );
    // The inbox's notes about connections (CLD-121): one when a connection goes bad, one when it's working again.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS connection_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT,
        created INTEGER NOT NULL, resolved INTEGER, resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS connection_notices_open ON connection_notices (resolved, id);
    `);
  },

  // ---- what the rest of the board records for this view ----------------------------------

  /** A webhook reached the Worker: verified or refused (a refused one may just be noise from the internet). */
  connectionsWebhookSeen(verified, event = null) {
    const now = Date.now();
    if (verified) {
      this.setMeta('conn_webhook_last', now);
      this.setMeta('conn_webhook_event', String(event ?? '').slice(0, 40) || null);
    } else {
      this.setMeta('conn_webhook_bad', Number(this.meta('conn_webhook_bad') ?? 0) + 1);
      this.setMeta('conn_webhook_bad_last', now);
    }
  },

  /** A verified delivery was about registered repository `slug`: when, per repository (CLD-129). */
  connectionsWebhookRepo(slug) {
    if (slug && this.repoBySlug(slug)) this.setMeta(`conn_webhook_last:${slug}`, Date.now());
  },

  /** A Taskwarrior replica reached the sync server; written at most once a minute. */
  connectionsReplicaSeen() {
    const now = Date.now();
    if (now - Number(this.meta('conn_replica_seen') ?? 0) > SEEN_EVERY_MS) this.setMeta('conn_replica_seen', now);
  },

  /** The API token was used (the CLI, or a script with the token): the setup's CLI step (BRK-143); at most once a minute. */
  connectionsCliSeen() {
    const now = Date.now();
    if (now - Number(this.meta('conn_cli_seen') ?? 0) > SEEN_EVERY_MS) this.setMeta('conn_cli_seen', now);
  },

  /** A replica asked for the child of a version the board never had (410 Gone); written at most once a minute. */
  connectionsReplicaGone() {
    const now = Date.now();
    if (now - Number(this.meta('conn_replica_gone') ?? 0) > SEEN_EVERY_MS) this.setMeta('conn_replica_gone', now);
  },

  /** The cron's run: when, and the first thing that failed (redacted). */
  connectionsCronRan(errors) {
    this.setMeta('conn_cron_last', Date.now());
    this.setMeta('conn_cron_error', errors.length ? clip(errors[0]) : null);
  },

  /** The last push the board sent: how many went, failed, or were gone. */
  connectionsPushSent(result) {
    this.setMeta('conn_push_last', JSON.stringify({ at: Date.now(), ...result }));
  },

  /**
   * Where the board answers: its install's `url`, or on an install without one (a workers.dev one, CLD-139)
   * the address it was last opened at. Null until then.
   */
  homeUrl() {
    return install(this.env).url ?? this.meta('conn_origin') ?? null;
  },

  // ---- the API ---------------------------------------------------------------------------

  /** GET /api/connections: every connection, with the live checks as last run. Read only. */
  connectionsApi(origin) {
    return this.run(async () => {
      if (origin) this.setMeta('conn_origin', origin);
      return { status: 200, body: await this.connectionsReport() };
    });
  },

  /** POST /api/connections/check (the signed-in browser only): run the live checks now, then report. */
  connectionsCheckApi(origin) {
    return this.run(async () => {
      const last = Number(this.meta('conn_live_at') ?? 0);
      if (Date.now() - last < CHECK_GAP_MS)
        throw new AgentError(
          `checked ${Math.round((Date.now() - last) / 1000)} seconds ago; try again in a moment`,
          429,
        );
      if (origin) this.setMeta('conn_origin', origin);
      await this.connectionsLiveCheck();
      return { status: 200, body: await this.connectionsReport() };
    });
  },

  /**
   * From the cron: the live checks once an hour, and the report every run, so the nav's count and the
   * inbox's notes follow without anyone opening the view. Never throws.
   */
  async connectionsAutoCheck() {
    if (Date.now() - Number(this.meta('conn_live_at') ?? 0) >= LIVE_EVERY_MS) {
      try {
        await this.connectionsLiveCheck();
      } catch {
        /* the next hour tries again; the view says when it last checked */
      }
    }
    try {
      await this.connectionsReport();
    } catch {
      /* the next run tries again */
    }
  },

  // ---- live checks: GitHub ---------------------------------------------------------------

  /** Asks GitHub about the App, each repository's installation, and the webhook. Reads only. */
  async connectionsLiveCheck() {
    const origin = this.meta('conn_origin') ?? this.homeUrl();
    this.setMeta('conn_live_at', Date.now());
    const base = this.env.TASKS_GITHUB_API || undefined;
    const credentials = await appCredentials(this.env);
    const live = { at: Date.now(), app: null, repos: {}, webhook: null };
    if (credentials) {
      try {
        const app = await appGet(credentials, '/app', base);
        live.app = {
          ok: true,
          id: app.id ?? null,
          slug: app.slug ?? null,
          name: app.name ?? null,
          url: app.html_url ?? null,
        };
      } catch (error) {
        live.app = { ok: false, status: error instanceof GitHubError ? error.status : 0, message: clip(error.message) };
      }
      if (live.app.ok) {
        for (const repo of this.repos())
          live.repos[repo.slug] = await this.connectionsCheckRepo(credentials, repo, base);
        try {
          live.webhook = summarizeDeliveries(
            await appGet(credentials, '/app/hook/deliveries?per_page=50', base),
            origin,
            secretName(install(this.env), 'GITHUB_WEBHOOK_SECRET'),
          );
        } catch (error) {
          live.webhook = { error: clip(error.message), status: error instanceof GitHubError ? error.status : 0 };
        }
      }
    }
    this.setMeta('conn_live', JSON.stringify(live));
    // GitHub's status page (BRK-217) is part of Check now too.
    await this.githubStatusCheck({ force: true });
    return live;
  },

  /** One repository: installed, its permissions, Allow auto-merge, and the rate limit left. */
  async connectionsCheckRepo(credentials, repo, base) {
    const [owner, name] = repo.github.split('/');
    let installation;
    try {
      installation = await appGet(credentials, `/repos/${repo.github}/installation`, base);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return { installed: false };
      return { installed: null, error: clip(error.message) };
    }
    const out = {
      installed: true,
      suspended: Boolean(installation.suspended_at),
      permissions: installation.permissions ?? {},
      installUrl: installation.html_url ?? null,
    };
    // Its own client and cache, so a check never touches the sync's token.
    const client = new GitHubClient(
      credentials,
      { owner, repo: name, full: repo.github },
      { installationId: installation.id },
      base,
    );
    try {
      const info = await client.get('');
      out.autoMerge = Boolean(info.allow_auto_merge);
      out.defaultBranch = typeof info.default_branch === 'string' ? info.default_branch : null;
    } catch (error) {
      out.autoMergeError = clip(error.message);
    }
    try {
      const token = await client.token();
      const res = await fetch(`${client.base}/rate_limit`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'breakaway',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (res.ok) {
        const core = (await res.json())?.resources?.core;
        if (core)
          out.rate = { limit: num(core.limit), remaining: num(core.remaining), reset: iso(Number(core.reset) * 1000) };
      }
    } catch {
      /* the rate limit is a nicety */
    }
    return out;
  },

  // ---- the report ------------------------------------------------------------------------

  async connectionsReport() {
    const live = JSON.parse(this.meta('conn_live') ?? 'null');
    const connections = [
      ...this.repoConnections(),
      this.updateConnection(entry),
      ...(await this.cloudflareConnections()),
      ...(await this.githubConnections(live)),
      ...(await this.githubStatusConnection()),
      ...this.npmConnections(),
      ...(await this.claudeConnections()),
      this.cliConnection(),
      this.taskwarriorConnection(),
      await this.pushConnection(),
    ];
    this.rememberStates(connections);
    const states = new Map(
      this.sql
        .exec('SELECT id, state, since FROM connection_states')
        .toArray()
        .map((r) => [r.id, r]),
    );
    for (const c of connections) c.since = iso(states.get(keyOf(c))?.since);
    this.connectionsNotify(connections, states);
    // "Not connected" can be on purpose (push off, a feature not set up), so only "needs attention" counts.
    const attention = connections.filter((c) => c.state === 'attention').length;
    const at = Date.now();
    this.setMeta('conn_summary', JSON.stringify({ attention, at }));
    const host = hostOf(this.homeUrl());
    return {
      generated: iso(at),
      checked: iso(live?.at),
      attention,
      connections,
      setup: this.setupSteps(connections),
      cannotCheck: [
        this.repos().length > 1
          ? {
              name: 'Each routine’s cloud environment',
              why: `Every repository’s routine must allow ${host} for the CLI and live output; the board can’t see claude.ai’s settings.`,
              link: ROUTINES_URL,
            }
          : {
              name: 'The routine’s cloud environment',
              why: `It must allow ${host} for the CLI and live output; the board can’t see claude.ai’s settings.`,
              link: ROUTINES_URL,
            },
        this.routineInstructions(),
        {
          name: 'Cloudflare itself',
          why: 'The board has no Cloudflare API token, so the custom domain, Secrets Store, and dashboard settings show only as this Worker sees them.',
          link: 'https://dash.cloudflare.com',
        },
      ],
    };
  },

  /**
   * What a routine's instructions on claude.ai should be (BRK-73): the stub the Agents view gives, which sends each
   * agent to its repository's own prompt. The board can't read claude.ai, so this is in what it can't check.
   */
  routineInstructions() {
    const repos = this.repos();
    if (repos.length > 1)
      return {
        name: 'Each routine’s instructions',
        why: `Each should be its repository’s stub from the Agents view, which sends agents to that repository’s prompt (${repos.map((r) => `${r.slug}: ${promptPathOf(r)}`).join(', ')}).`,
        link: ROUTINES_URL,
      };
    return {
      name: 'The routine’s instructions',
      why: `They should be the stub from the Agents view, which sends each agent to ${promptPathOf(repos[0])} in its checkout.`,
      link: ROUTINES_URL,
    };
  },

  // ---- a fresh install's setup (CLD-131) -------------------------------------------------

  /** On a fresh install, whether it has a repository yet: the first setup step. None on an older install. */
  repoConnections() {
    if (!this.firstRunInstall()) return [];
    const repos = this.repos();
    const first = repos.find((r) => r.isDefault);
    return [
      entry('repos.registered', 'repos', 'Registered repository', first ? 'working' : 'attention', {
        detail: first
          ? `${repos.map((r) => `${r.slug} (${r.github})`).join(', ')}; tasks without a repository are ${first.slug}’s`
          : 'no repository yet: the board can’t hold tasks, sync GitHub, or start agents until it has one',
        fix: 'Register the repository the board runs, below or with npx breakaway repos add <slug> <owner/name> --area product:PRD (an area and its work-ID prefix; add more with more --area). The first one you register is the default.',
        link: doc(this.env, 'repositories'),
      }),
    ];
  },

  /**
   * A fresh install's setup steps, in order, each with the connection that shows it: register a repository,
   * connect the GitHub App, install it on that repository, add the board's files to it (repos init), connect
   * its routine, connect a machine's CLI, sync Taskwarrior (optional), and the first result (BRK-143): a first
   * agent's pull request merged when the repository has a routine, else a first task closed by its pull request,
   * from the Add a repository wizard's own facts so the two agree. `repo` is that repository's slug, so the last
   * step can open its wizard at the agent step (WEB-40). `done` once every step not `optional` is.
   * Null on an older install.
   */
  setupSteps(connections) {
    if (!this.firstRunInstall()) return null;
    const first = this.repos().find((r) => r.isDefault) ?? null;
    const state = (id, repo) =>
      connections.find((c) => c.id === id && (repo === undefined || c.repo === repo))?.state ?? null;
    const routine = Boolean(first) && state('claude.routine', first.slug) === 'working';
    const result = firstResult(first ? this.wizardWork(first.slug) : {}, routine);
    /** @type {{ id: string, name: string, connection: string | null, done: boolean, optional?: boolean, wid?: string | null, number?: number | null }[]} */
    const steps = [
      { id: 'repo', name: 'Register a repository', connection: 'repos.registered', done: Boolean(first) },
      { id: 'app', name: 'Connect the GitHub App', connection: 'github.app', done: state('github.app') === 'working' },
      {
        id: 'install',
        name: first ? `Install the App on ${first.github}` : 'Install the App on the repository',
        connection: 'github.install',
        done: Boolean(first) && state('github.install', first.slug) === 'working',
      },
      // The board's files in the repository (repos init, CLD-191): done once it syncs with commits in it.
      {
        id: 'init',
        name: 'Add the board’s files to it',
        connection: 'github.sync',
        done: Boolean(first) && state('github.sync', first.slug) === 'working',
      },
      // Routines are how the board starts agents, so this is a step to do; but a first task closed from a local
      // session is the end of setup without one, and then the routine is left optional (IDEA-33's journey).
      {
        id: 'routine',
        name: 'Connect its agent routine',
        connection: 'claude.routine',
        done: routine,
        ...(!routine && result.done ? { optional: true } : {}),
      },
      // Any call with the API token counts: Taskwarrior is a way in, not a step everyone takes (BRK-143).
      { id: 'cli', name: 'Connect the CLI', connection: 'cli', done: state('cli') === 'working' },
      {
        id: 'taskwarrior',
        name: 'Sync Taskwarrior (optional)',
        connection: 'taskwarrior',
        optional: true,
        done: Boolean(num(this.meta('conn_replica_seen'))),
      },
      {
        id: 'first',
        name: routine ? 'A first agent’s pull request merged' : 'A first task closed',
        connection: null,
        done: result.done,
        wid: result.wid,
        number: result.number,
      },
    ];
    return { steps, repo: first?.slug ?? null, done: steps.every((s) => s.done || s.optional) };
  },

  /** Keeps when each connection last changed state, so the view can say "since". */
  rememberStates(connections) {
    const now = Date.now();
    for (const c of connections) {
      const id = keyOf(c);
      const row = this.sql.exec('SELECT state FROM connection_states WHERE id = ?', id).toArray()[0];
      if (!row || row.state !== c.state)
        this.sql.exec(
          'INSERT OR REPLACE INTO connection_states (id, state, since, checked) VALUES (?, ?, ?, ?)',
          id,
          c.state,
          now,
          now,
        );
      else this.sql.exec('UPDATE connection_states SET checked = ? WHERE id = ?', now, id);
    }
  },

  /**
   * The inbox's notes (an `fyi`, never a push: the owner's decision in CLD-119). A connection that has
   * needed attention for SETTLE_MS gets one note; when it works again that note is resolved and a
   * "working again" one takes its place. One open note per connection at most. A connection in
   * ENDS_BY_ITSELF gets only the "working again" note.
   */
  connectionsNotify(connections, states) {
    const now = Date.now();
    for (const c of connections) {
      if (QUIET.has(c.id)) continue;
      const key = keyOf(c);
      const open = this.sql
        .exec(
          "SELECT id FROM connection_notices WHERE conn = ? AND kind IN ('broke', 'held') AND resolved IS NULL",
          key,
        )
        .toArray()[0];
      if (c.state === 'attention') {
        const since = Number(states.get(key)?.since ?? now);
        if (!open && now - since >= SETTLE_MS) {
          this.replaceNotices(key, now);
          this.sql.exec(
            'INSERT INTO connection_notices (conn, kind, name, detail, created) VALUES (?, ?, ?, ?, ?)',
            key,
            ENDS_BY_ITSELF.has(c.id) ? 'held' : 'broke',
            c.name,
            clip(c.detail),
            now,
          );
        }
      } else if (open) {
        this.sql.exec(
          "UPDATE connection_notices SET resolved = ?, resolution = 'recovered' WHERE id = ?",
          now,
          open.id,
        );
        this.replaceNotices(key, now);
        if (c.state === 'working')
          this.sql.exec(
            "INSERT INTO connection_notices (conn, kind, name, detail, created) VALUES (?, 'recovered', ?, ?, ?)",
            key,
            c.name,
            clip(c.detail),
            now,
          );
      }
    }
    this.sql.exec('DELETE FROM connection_notices WHERE resolved IS NOT NULL AND resolved < ?', now - NOTICES_KEPT_MS);
  },

  /** An older "working again" note has nothing left to say once a newer note about the same connection comes. */
  replaceNotices(key, now) {
    this.sql.exec(
      "UPDATE connection_notices SET resolved = ?, resolution = 'replaced' WHERE conn = ? AND kind = 'recovered' AND resolved IS NULL",
      now,
      key,
    );
  },

  /** The open notes, newest first, for the inbox. */
  connectionNotices() {
    return this.sql
      .exec("SELECT * FROM connection_notices WHERE resolved IS NULL AND kind != 'held' ORDER BY id DESC LIMIT 50")
      .toArray()
      .map(noticeView);
  },

  /** POST /api/connections/notices/<id>/dismiss: the owner clears a note (the signed-in browser only). */
  connectionNoticeDismiss(id) {
    return this.run(() => {
      const row = /^\d+$/u.test(String(id))
        ? this.sql.exec('SELECT * FROM connection_notices WHERE id = ?', Number(id)).toArray()[0]
        : null;
      if (!row) throw new AgentError(`no connection note ${id}`, 404);
      if (!row.resolved)
        this.sql.exec(
          "UPDATE connection_notices SET resolved = ?, resolution = 'dismissed' WHERE id = ?",
          Date.now(),
          row.id,
        );
      return {
        status: 200,
        body: { notice: noticeView(this.sql.exec('SELECT * FROM connection_notices WHERE id = ?', row.id).one()) },
      };
    });
  },

  /** What the nav shows without running the checks: the count from the last report (health carries it). */
  connectionsSummary() {
    const summary = JSON.parse(this.meta('conn_summary') ?? 'null');
    return summary ? { attention: summary.attention, at: iso(summary.at) } : null;
  },

  async cloudflareConnections() {
    const version = this.env.VERSION ?? null;
    const worker = entry('cloudflare.worker', 'cloudflare', 'Worker', 'working', {
      detail: version?.id
        ? `version ${version.tag || version.id.slice(0, 8)}, answering from its Durable Object`
        : 'answering from its Durable Object (no version metadata here)',
      at: version?.timestamp ?? null,
    });

    const items = await Promise.all(
      SECRET_BINDINGS.map(async (b) => ({
        name: b.name,
        state: await bindingState(this.env, b.name),
        required: b.required,
        for: b.for,
      })),
    );
    const broken = items.filter((i) => i.required && i.state !== 'set');
    const unresolved = items.filter((i) => i.state === 'unresolved' || i.state === 'missing');
    const set = items.filter((i) => i.state === 'set').length;
    const secrets = entry(
      'cloudflare.secrets',
      'cloudflare',
      'Secrets Store bindings',
      broken.length || unresolved.length ? 'attention' : 'working',
      {
        detail: `${set} of ${items.length} set${
          items.some((i) => i.state === 'unset')
            ? `; unset: ${items
                .filter((i) => i.state === 'unset')
                .map((i) => i.name)
                .join(', ')}`
            : ''
        }`,
        fix: `${[...new Set([...broken, ...unresolved])].map((i) => `${i.name} is ${i.state}`).join('; ')}. Check the binding in wrangler.jsonc and that its secret exists in the Secrets Store (Cloudflare → Secrets Store), then deploy the board. On a board without a Secrets Store (a new install’s), set it as a Worker secret instead (Cloudflare → Workers → ${install(this.env).worker} → Settings → Variables and Secrets), as .dev.vars.example describes.`,
        link: doc(this.env, 'secrets'),
        items,
      },
    );

    const cronAt = num(this.meta('conn_cron_last'));
    const cronError = this.meta('conn_cron_error');
    let cronState = 'working';
    if (!cronAt || Date.now() - cronAt > CRON_LATE_MS) cronState = 'attention';
    else if (cronError) cronState = 'attention';
    const cron = entry('cloudflare.cron', 'cloudflare', 'Cron (every 5 minutes)', cronState, {
      detail: !cronAt ? 'no run recorded yet' : cronError ? `last run failed: ${cronError}` : 'last run finished',
      at: iso(cronAt),
      fix:
        !cronAt || Date.now() - cronAt > CRON_LATE_MS
          ? `The cron hasn’t run in the last 15 minutes. Check the Worker’s Cron Triggers (Cloudflare → Workers → ${install(this.env).worker} → Settings) list */5 * * * *, as wrangler.jsonc does.`
          : 'The last run hit an error; it tries again in 5 minutes. If it repeats, the GitHub and Claude connections below say which part fails.',
    });

    const health = (await this.health()).body;
    const latest = this.sql.exec('SELECT MAX(created) AS at FROM versions').one().at;
    let syncState = 'working';
    let syncFix = null;
    if (!health.ok) {
      syncState = 'attention';
      syncFix =
        'A replica synced with the right client ID but a different secret. Set that replica’s secret right, then rebuild (docs/tasks.md, “When something’s wrong”).';
    } else if (!health.secretsStoreInSync) {
      syncState = 'attention';
      syncFix = `After a rotation the Secrets Store still has the old sync credentials. Run npx breakaway rotate-sync again on the owner’s machine, or update ${secretName(install(this.env), 'CLIENT_ID')} and ${secretName(install(this.env), 'SYNC_KEY')} to match.`;
    }
    const sync = entry('cloudflare.sync', 'cloudflare', 'TaskChampion sync server', syncState, {
      detail: health.ok
        ? `${health.versions} versions, the key reads the history`
        : `can’t read its history: ${clip(health.replicaError)}`,
      at: iso(latest),
      fix: syncFix,
      link: doc(this.env, 'when-somethings-wrong'),
    });
    return [worker, secrets, cron, sync];
  },

  async githubConnections(live) {
    const credentials = await appCredentials(this.env);
    if (!credentials) {
      return [
        entry('github.app', 'github', 'GitHub App', 'off', {
          detail: 'not connected: its secrets are unset',
          fix: 'On the board’s GitHub view press Connect GitHub, create the App, then run npx breakaway github-connect <code> with the code it shows.',
          link: doc(this.env, 'github'),
        }),
      ];
    }
    const out = [];
    const checked = iso(live?.at);
    if (!live?.app) {
      out.push(
        entry('github.app', 'github', 'GitHub App', 'attention', {
          detail: 'connected, not checked yet',
          fix: 'Press Check now on the Connections view; the cron also checks once an hour.',
        }),
      );
      return [...out, ...this.githubSyncConnections()];
    }
    const app = live.app;
    out.push(
      entry('github.app', 'github', 'GitHub App', app.ok ? 'working' : 'attention', {
        detail: app.ok
          ? `${app.name ?? 'the App'} (ID ${app.id})`
          : `GitHub refused the App (${app.status}): ${app.message}`,
        at: checked,
        fix:
          app.status === 401
            ? 'GitHub refused the App’s key: generate a new private key in the App’s settings (General → Private keys), then run npx breakaway github-connect again.'
            : 'GitHub couldn’t be asked about the App; press Check now again. If it repeats, check githubstatus.com.',
        link: app.url ?? 'https://github.com/settings/apps',
      }),
    );
    if (!app.ok) return [...out, ...this.githubSyncConnections()];

    for (const repo of this.repos())
      out.push(...this.githubRepoConnections(repo, live.repos?.[repo.slug], app, checked));

    const hook = live.webhook;
    const lastIn = num(this.meta('conn_webhook_last'));
    const bad = Number(this.meta('conn_webhook_bad') ?? 0);
    const received = `last received ${lastIn ? iso(lastIn) : 'never'}${bad ? `, ${bad} refused signature${bad === 1 ? '' : 's'} (the last ${iso(this.meta('conn_webhook_bad_last'))})` : ''}`;
    // With several repositories, when a delivery last came about each (one App, one webhook, so one row).
    const repos = this.repos();
    const each =
      repos.length > 1
        ? `; last from each repository: ${repos.map((r) => `${r.slug} ${iso(this.meta(`conn_webhook_last:${r.slug}`)) ?? 'never'}`).join(', ')}`
        : '';
    if (!hook || hook.error) {
      out.push(
        entry('github.webhook', 'github', 'Webhook', 'attention', {
          detail: `${received}${each}; GitHub’s delivery log ${hook ? `couldn’t be read: ${hook.error}` : 'not checked yet'}`,
          at: iso(lastIn),
          fix: 'Press Check now. If the delivery log stays unreadable, check the App’s webhook in its settings (General → Webhook).',
          link: app.url,
        }),
      );
    } else {
      const failures = hook.failed
        ? `; ${hook.failed} of the last ${hook.seen} failed${hook.lastFailure ? ` (last ${hook.lastFailure.at}: ${hook.lastFailure.status} ${hook.lastFailure.message})` : ''}`
        : '';
      out.push(
        entry('github.webhook', 'github', 'Webhook', hook.state, {
          detail: `${received}${each}; GitHub’s last delivery ${hook.last ? `${hook.last.at}: ${hook.last.status}` : 'none'}${failures}`,
          at: iso(lastIn) ?? hook.last?.at ?? null,
          fix: hook.fix,
          link: app.slug ? `https://github.com/settings/apps/${app.slug}/advanced` : app.url,
        }),
      );
    }
    return [...out, ...this.githubSyncConnections(live)];
  },

  /**
   * GitHub's status (BRK-217): what githubstatus.com says about the parts of GitHub the board leans on, and whether
   * the board's automatic work is waiting on it. None without GitHub connected, or when the install reads no status page.
   */
  async githubStatusConnection() {
    const v = this.githubStatusView();
    if (!v || !(await appCredentials(this.env))) return [];
    const host = new URL(v.page).host;
    const name = 'GitHub’s status';
    if (!v.checked)
      return [
        entry('github.status', 'github', name, 'attention', {
          detail: 'not checked yet',
          fix: `Press Check now; the cron reads ${host} every 5 minutes.`,
          link: v.page,
        }),
      ];
    if (v.held)
      return [
        entry('github.status', 'github', name, 'attention', {
          detail: `${v.summary}, since ${v.since}. Chases start nothing new, and Keep branches up to date and Merge when green wait`,
          at: v.at,
          fix: `Nothing to fix on the board: chases and the pull request settings carry on by themselves once ${host} says it’s working again. Agents already running may fail to push or wait on checks. If GitHub is working and the page hasn’t caught up, press Treat as working.`,
          link: v.incidents.find((i) => i.url)?.url ?? v.page,
          override: { on: false },
        }),
      ];
    // The owner said GitHub is working while the page still reports trouble (BRK-218).
    if (v.overridden)
      return [
        entry('github.status', 'github', name, 'working', {
          detail: `${v.summary}, but you marked it working. Chases and the pull request settings carry on; the board holds again if ${host} reports something new`,
          at: v.at,
          link: v.page,
          override: { on: true, at: v.overridden.at },
        }),
      ];
    if (v.error)
      return [
        entry('github.status', 'github', name, 'attention', {
          detail: `couldn’t read ${host}: ${v.error}; nothing waits on it meanwhile`,
          at: v.at,
          fix: `Press Check now. If it keeps failing, look at ${host} yourself before you chase or merge.`,
          link: v.page,
        }),
      ];
    return [
      entry('github.status', 'github', name, 'working', {
        detail: `${v.components.map((c) => c.name).join(', ') || 'GitHub'} working, as ${host} says`,
        at: v.at,
        link: v.page,
      }),
    ];
  },

  /**
   * One repository's GitHub rows (installed, permissions, Allow auto-merge) from its live check `r`, as
   * Connections shows them; the Add a repository wizard (CLD-194) shows the same rows, fixes and all, for a
   * repository it's adding, even before it's registered (`repo.slug` null then).
   */
  githubRepoConnections(repo, r, app, checked) {
    const out = [];
    const installUrl = app.slug
      ? `https://github.com/apps/${app.slug}/installations/new`
      : 'https://github.com/settings/installations';
    if (!r) {
      out.push(
        entry('github.install', 'github', `Installed on ${repo.github}`, 'attention', {
          repo: repo.slug,
          detail: 'not checked yet',
          fix: 'Press Check now.',
        }),
      );
      return out;
    }
    if (r.installed === false) {
      // A repository registered on the board but not given the App needs attention; the default repository's stays as it
      // was, while on a fresh install the default's is a setup step to do.
      const state = repo.slug === this.defaultRepoSlug() && !this.firstRunInstall() ? 'off' : 'attention';
      out.push(
        entry('github.install', 'github', `Installed on ${repo.github}`, state, {
          repo: repo.slug,
          detail:
            state === 'off'
              ? 'the App isn’t installed on this repository'
              : 'the App isn’t installed on this repository, so the board can’t sync it, link its pull requests, or merge',
          at: checked,
          fix: `Install the App on ${repo.github}: ${installUrl}, choose the repository, and save.`,
          link: installUrl,
        }),
      );
      return out;
    }
    if (r.installed === null) {
      out.push(
        entry('github.install', 'github', `Installed on ${repo.github}`, 'attention', {
          repo: repo.slug,
          detail: `couldn’t check: ${r.error}`,
          at: checked,
          fix: 'Press Check now again; if it repeats, check githubstatus.com.',
        }),
      );
      return out;
    }
    out.push(
      entry('github.install', 'github', `Installed on ${repo.github}`, r.suspended ? 'attention' : 'working', {
        repo: repo.slug,
        detail: r.suspended ? 'installed, but suspended' : 'installed',
        at: checked,
        fix: 'The installation is suspended: on GitHub, Settings → Applications → Installed GitHub Apps → the App → Unsuspend.',
        link: r.installUrl,
      }),
    );
    const items = comparePermissions(r.permissions, { pipeline: Boolean(repo.pipeline) });
    const missing = items.filter((p) => !p.ok);
    out.push(
      entry('github.permissions', 'github', `Permissions on ${repo.github}`, missing.length ? 'attention' : 'working', {
        repo: repo.slug,
        detail: missing.length
          ? `missing: ${missing.map((p) => `${p.label} ${p.need} (for ${p.for})`).join('; ')}`
          : `all ${items.length} the board needs are granted`,
        at: checked,
        fix: permissionsFix(missing, app.name ?? install(this.env).name),
        link: appSettingsUrl(app.slug),
        items,
      }),
    );
    out.push(
      entry('github.automerge', 'github', `Allow auto-merge on ${repo.github}`, r.autoMerge ? 'working' : 'attention', {
        repo: repo.slug,
        detail: r.autoMerge
          ? 'on'
          : r.autoMergeError
            ? `couldn’t read: ${r.autoMergeError}`
            : 'off: Merge when green can’t work',
        at: checked,
        fix: `On GitHub, ${repo.github} → Settings → General → Pull Requests: turn on Allow auto-merge.`,
        link: `https://github.com/${repo.github}/settings`,
      }),
    );
    // A registered branch that isn't GitHub's: init would branch from the wrong one, and the prompt would be read from it.
    if (repo.slug && r.defaultBranch && repo.defaultBranch && r.defaultBranch !== repo.defaultBranch) {
      out.push(
        entry('github.branch', 'github', `Default branch of ${repo.github}`, 'attention', {
          repo: repo.slug,
          detail: `registered as ${repo.defaultBranch}, but GitHub's default branch is ${r.defaultBranch}`,
          at: checked,
          fix: `Run npx breakaway repos modify ${repo.slug} --branch ${r.defaultBranch}, or change the default branch on GitHub back to ${repo.defaultBranch}.`,
          link: `https://github.com/${repo.github}/settings/branches`,
        }),
      );
    }
    return out;
  },

  /** The sync with GitHub, per repository: last success, last error, and the rate limit left. */
  githubSyncConnections(live = null) {
    return this.repos().map((repo) => {
      const last = num(this.ghMeta('gh_last_sync', repo.slug));
      const error = this.ghMeta('gh_error', repo.slug);
      const rate = live?.repos?.[repo.slug]?.rate ?? null;
      // No commits yet (CLD-191): neutral, never "needs attention", with the step that fixes it.
      if (this.ghMeta('gh_empty', repo.slug) && !error && last && Date.now() - last <= SYNC_LATE_MS) {
        return entry('github.sync', 'github', `Sync with ${repo.github}`, 'off', {
          repo: repo.slug,
          detail: `no commits yet, so there’s nothing to sync${rate ? `; ${rate.remaining} of ${rate.limit} requests left` : ''}`,
          at: iso(last),
          fix: `Run npx breakaway repos init ${repo.slug} in a terminal: it pushes the files the board’s agents need as the repository’s first commit.`,
          link: doc(this.env, 'adding-a-repository'),
        });
      }
      const low = rate && rate.limit ? rate.remaining / rate.limit < 0.1 : false;
      let state = 'working';
      let fix = null;
      if (error) {
        state = 'attention';
        fix = /\b40[134]\b/u.test(error)
          ? 'GitHub refused the sync: check the App’s installation and permissions above, then press Sync on the GitHub view.'
          : 'Press Sync on the GitHub view; if it fails again, the error says what GitHub answered.';
      } else if (!last) {
        // Just registered (BRK-40): the next step is the board's files, and Sync follows once it has commits.
        state = 'attention';
        fix = `Not synced yet. If ${repo.github} is new, run npx breakaway repos init ${repo.slug} from a checkout of the board; it adds the files the board’s agents need. Otherwise press Sync on the GitHub view.`;
      } else if (Date.now() - last > SYNC_LATE_MS) {
        state = 'attention';
        fix = 'No sync in the last 15 minutes: press Sync on the GitHub view, and check the cron above.';
      } else if (low) {
        state = 'attention';
        fix = `Only ${rate.remaining} of ${rate.limit} GitHub requests are left this hour; it refills at ${rate.reset}. Nothing to do unless it keeps happening.`;
      }
      return entry('github.sync', 'github', `Sync with ${repo.github}`, state, {
        repo: repo.slug,
        detail: `${last ? 'last synced' : 'never synced'}${error ? `; last error: ${clip(error)}` : ''}${rate ? `; ${rate.remaining} of ${rate.limit} requests left` : ''}`,
        at: iso(last),
        fix,
        link: doc(this.env, 'github'),
      });
    });
  },

  // ---- Claude ----------------------------------------------------------------------------

  async claudeConnections() {
    const out = [];
    const defaultSlug = this.defaultRepoSlug();
    const repos = this.repos();
    const multi = repos.length > 1;
    const off = this.sql
      .exec('SELECT slug, disabled_reason FROM routines WHERE enabled = 0 AND disabled_reason IS NOT NULL')
      .toArray();
    for (const repo of repos) {
      const isDefault = repo.slug === defaultSlug;
      // The Secrets Store's routine, else the one kept on the board (BRK-133): both show the same way.
      const credentials = await this.repoRoutine(repo.slug);
      // The last start through this repository's routine; runs from before repositories are the default's.
      const lastRun = this.sql
        .exec(
          "SELECT status, error, started FROM agent_runs WHERE status IN ('started', 'failed') AND COALESCE(repo, ?) = ? ORDER BY id DESC LIMIT 1",
          defaultSlug,
          repo.slug,
        )
        .toArray()[0];
      const verified = await this.routineVerified(repo.slug, credentials);
      await this.dropStaleHold(repo.slug);
      const row = this.routineConnection(repo, {
        isDefault,
        credentials,
        lastRun,
        off: isDefault ? off : [],
        verified,
        hold: this.routineHold(repo.slug),
      });
      // An empty repository has no prompt yet; otherwise the one on its default branch, kept for a minute.
      out.push(
        this.ghMeta('gh_empty', repo.slug) ? row : unfilledPrompt(row, repo, await this.wizardPrompt(repo.slug)),
      );
    }

    const { max, hourly } = this.agentSettings();
    const running = this.runningAgents(this.views());
    const used = this.startsThisHour();
    out.push(
      entry('claude.budget', 'claude', 'Shared agent budget', used >= hourly ? 'attention' : 'working', {
        detail: `${running.length} of ${max} agents running, ${used} of ${hourly} starts this hour`,
        fix: `This hour’s starts are used up; they free up as the hour rolls on. Raise Starts an hour on the Agents view if you want more (Claude allows ${CLAUDE_LIMITS.routineHourly} for each routine, ${CLAUDE_LIMITS.accountHourly} in all, on every plan).`,
      }),
    );

    // Live output: the default repository's row as it always was, then one for each other repository whose routine is connected.
    for (const repo of repos) {
      const isDefault = repo.slug === defaultSlug;
      const routine = isDefault ? null : await this.repoRoutine(repo.slug);
      if (!isDefault && (!routine || 'broken' in routine)) continue;
      out.push(this.liveOutputConnection(repo, { isDefault, multi, defaultSlug, running }));
    }
    return out;
  },

  /**
   * One repository's agent routine: connected or not, and its last start. The default repository's keeps
   * the name and fixes it always had; another repository's names itself, and a missing routine there
   * needs attention, since registering a repository means it should start agents (CLD-129).
   */
  routineConnection(repo, { isDefault, credentials, lastRun, off, verified = null, hold = null }) {
    const name = isDefault ? 'Agent routine' : `Agent routine for ${repo.slug}`;
    const connect = connectCommand(isDefault ? null : repo.slug);
    if (!credentials) {
      // A repository with no commits yet has no agent prompt for a routine to follow (CLD-193): not connected is the
      // normal next step of setting it up, so neutral, like its sync, and not counted as needing attention.
      if (this.ghMeta('gh_empty', repo.slug))
        return entry('claude.routine', 'claude', name, 'off', {
          repo: repo.slug,
          source: null,
          detail:
            'not connected yet: the repository has no commits, so there’s no agent prompt for a routine to follow',
          fix: `Run npx breakaway repos init ${repo.slug} first; then make its routine on claude.ai/code/routines and run ${connect}.`,
          link: doc(this.env, 'adding-a-repository'),
        });
      // The default repository's routine can be left off on purpose; any other repository's, and a fresh install's first, should start agents.
      return isDefault && !this.firstRunInstall()
        ? entry('claude.routine', 'claude', name, 'off', {
            repo: repo.slug,
            source: null,
            detail: 'not connected: its URL and token are unset',
            fix: 'Make the routine on claude.ai/code/routines with an API trigger, then connect it on Connections with its URL and token, or run npx breakaway agents-connect.',
            link: doc(this.env, 'cloud-agents-from-the-board'),
          })
        : entry('claude.routine', 'claude', name, 'attention', {
            repo: repo.slug,
            source: null,
            detail: 'not connected: this repository has no routine yet, so agents can’t start on its tasks',
            fix: `Once npx breakaway repos init ${repo.slug} has added the board’s files to ${repo.github}, make a routine in it on claude.ai/code/routines with an API trigger and a cloud environment that allows ${hostOf(this.meta('conn_origin') ?? this.homeUrl())}, then connect it on Connections with its URL and token, or run ${connect}.`,
            link: doc(this.env, 'cloud-agents-from-the-board'),
          });
    }
    // Kept on the board, but its key isn't the one it was sealed with any more: it starts nothing until it's connected again.
    if ('broken' in credentials)
      return entry('claude.routine', 'claude', name, 'attention', {
        repo: repo.slug,
        source: 'board',
        detail: 'connected from the board, but its stored URL and token can’t be read any more',
        fix: `The board’s sync key changed since the routine was connected, so its stored token can’t be decrypted. Connect the routine again from the board with its URL and a new token from claude.ai/code/routines, or run ${connect}.`,
        link: ROUTINES_URL,
      });
    const goodUrl = /^https:\/\/api\.anthropic\.com\/.+\/fire$/u.test(credentials.url);
    let state = 'working';
    let fix = null;
    let detail = 'connected; no start recorded yet';
    // Verified by the first claim of a session it started (BRK-142); a start alone, or none, isn't proof.
    const problems = verified ? reportProblems(verified, { slug: repo.slug, host: hostOf(this.homeUrl()) }) : [];
    const by = verified ? (this.tasks.get(verified.task)?.wid ?? String(verified.task).slice(0, 8)) : null;
    if (!goodUrl) {
      state = 'attention';
      fix = `The routine’s URL isn’t a Claude routine /fire URL: copy the API trigger’s URL from claude.ai/code/routines and run ${connect}.`;
      detail = 'connected, but the URL doesn’t look like a routine’s';
    } else if (hold?.kind === 'paused') {
      // Claude refused the routine (BRK-144): auto-start and chase start nothing here until it's connected again.
      state = 'attention';
      detail = `paused: ${clip(hold.error)}; auto-start and chase start nothing here until it’s connected again`;
      fix = routineFix(hold.error, connect);
    } else if (lastRun?.status === 'failed') {
      state = 'attention';
      detail = `the last start failed: ${clip(lastRun.error)}`;
      if (hold) detail += `; auto-start and chase wait until ${iso(hold.until).slice(11, 16)} UTC`;
      fix = routineFix(lastRun.error, connect);
    } else if (problems.length) {
      state = 'attention';
      detail = `${by}’s session reported a problem: ${problems.map((p) => p.what).join('; ')}`;
      fix = problems.map((p) => p.fix).join(' ');
    } else if (verified) {
      detail = `verified by ${by}’s session${lastRun ? '; the last start worked' : ''}`;
    } else {
      detail = `connected; ${lastRun ? 'the last start worked; ' : ''}not verified yet: start an agent on a task to verify it`;
    }
    if (off.length) {
      state = 'attention';
      detail += `; switched off after failing to start: ${off.map((r) => r.slug).join(', ')}`;
      fix = `${fix ? `${fix} Then ` : ''}turn ${off.length === 1 ? 'the routine' : 'the routines'} back on in the Routines view (or npx breakaway routines modify <slug> --enabled yes).`;
    }
    return entry('claude.routine', 'claude', name, state, {
      repo: repo.slug,
      source: credentials.source,
      detail,
      at: iso(lastRun?.started),
      fix,
      link: ROUTINES_URL,
      reading: goodUrl && !problems.length && verified ? 'verified' : 'unverified',
      verified: verified && !problems.length ? { task: by, at: iso(verified.at) } : undefined,
      hold: hold ? { kind: hold.kind, at: iso(hold.at), until: iso(hold.until) } : undefined,
    });
  },

  /**
   * Repository `slug`'s routine's kept session report (BRK-142), or null: none yet, or one made through a routine
   * connected before this one (its URL's hash differs), which says nothing about this one.
   */
  async routineVerified(slug, credentials) {
    if (!credentials || 'broken' in credentials) return null;
    const kept = JSON.parse(this.meta(`routine_verified:${slug}`) ?? 'null');
    if (!kept || kept.url !== (await shortHash(credentials.url))) return null;
    return kept;
  },

  /**
   * A cloud session's report on its own environment, sent with its claim (BRK-142): yes/no facts and the hash of its
   * checkout's stub, never a value (src/session-report.js). It counts only for a task the board started an agent on in
   * the last day, and only the first one from that start: the routine that started it then reads Verified, or needs
   * attention with the fix. It's kept even when the claim is refused (no agent name means the claim's name is wrong).
   * Anything else is ignored, so a claim never fails over it.
   */
  async sessionReport(ref, input) {
    const report = checkReport(input);
    if (!report) return;
    await this.ready();
    let uuid;
    try {
      uuid = this.resolve(ref);
    } catch {
      return;
    }
    const run = this.sql
      .exec(
        "SELECT id, repo FROM agent_runs WHERE task = ? AND status = 'started' AND started > ? ORDER BY id DESC LIMIT 1",
        uuid,
        Date.now() - REPORT_WITHIN_MS,
      )
      .toArray()[0];
    if (!run) return;
    const slug = run.repo ?? this.defaultRepoSlug();
    const key = `routine_verified:${slug}`;
    if (JSON.parse(this.meta(key) ?? 'null')?.run === run.id) return;
    const credentials = await this.repoRoutine(slug);
    if (!credentials || 'broken' in credentials) return;
    const board = BOARD_FILES['prompts/stub.md'];
    const stub = judgeStub(report.stub, board ? await shortHash(stubText(board)) : null);
    this.setMeta(
      key,
      JSON.stringify({
        run: run.id,
        task: uuid,
        at: Date.now(),
        token: report.token,
        agent: report.agent,
        stub,
        url: await shortHash(credentials.url),
      }),
    );
  },

  /**
   * Live output from one repository's sessions (the session hook): when the last entry arrived, and started
   * sessions that have sent nothing. The default repository's row has no `repo`, as before, so its state and
   * inbox notes carry on; with one repository registered it reads every entry, exactly as it always did.
   * `running` is runningAgents(): a run counts only while its agent still holds the task, so a run that ended
   * (merged, released, or taken over) stops counting at once rather than 12 hours later (BRK-63).
   */
  liveOutputConnection(repo, { isDefault, multi, defaultSlug, running }) {
    let lastLog;
    if (!multi) {
      lastLog = num(this.sql.exec('SELECT MAX(at) AS at FROM agent_logs').one().at);
    } else {
      lastLog = null;
      for (const row of this.sql.exec('SELECT task, MAX(at) AS at FROM agent_logs GROUP BY task').toArray()) {
        if (repoSlugOf(this.tasks.get(row.task), defaultSlug) === repo.slug && (!lastLog || row.at > lastLog))
          lastLog = num(row.at);
      }
    }
    // The claim's "Claimed …" line (a `start` entry) comes from the CLI, not the hook, so a session that sent
    // only that is quiet too: the CLI can reach the board while the hook can't (BRK-63).
    const quietSince = Date.now() - QUIET_HOOK_MS;
    const quiet = running.filter(
      ({ run }) =>
        (run.repo ?? defaultSlug) === repo.slug &&
        run.started <= quietSince &&
        !this.sql
          .exec(
            "SELECT 1 FROM agent_logs WHERE task = ? AND at >= ? AND json_extract(data, '$.kind') <> 'start' LIMIT 1",
            run.task,
            run.started,
          )
          .toArray().length,
    );
    return entry(
      'claude.output',
      'claude',
      isDefault ? 'Live output from sessions' : `Live output from ${repo.slug}’s sessions`,
      quiet.length ? 'attention' : 'working',
      {
        repo: isDefault ? null : repo.slug,
        detail: `${lastLog ? 'last entry arrived' : 'no entries yet'}${quiet.length ? `; ${quiet.length} started session${quiet.length === 1 ? ' has' : 's have'} sent nothing for over 10 minutes` : ''}`,
        at: iso(lastLog),
        fix: `A started session sends nothing back: check the routine’s cloud environment allows ${hostOf(this.homeUrl())} and has the board’s token (BREAKAWAY_TOKEN, or an API credential for that host), and that ${isDefault ? '.claude/settings.json' : `${repo.github}’s .claude/settings.json`} still has the session hook (the CLD-37 failure).`,
        link: ROUTINES_URL,
      },
    );
  },

  // ---- npm -------------------------------------------------------------------------------

  /**
   * npm's public registry (BRK-101), only once a repository's runs have staged a package: when the board last read
   * it, and its last failure. Read-only; the board holds no npm token.
   */
  npmConnections() {
    const npm = this.npmState();
    if (!npm.packages && !npm.error) return [];
    const failing = Boolean(npm.error);
    const count = `${npm.packages} package${npm.packages === 1 ? '' : 's'}`;
    const waiting = npm.waiting
      ? `; ${npm.waiting} version${npm.waiting === 1 ? '' : 's'} staged, waiting for approval on npm`
      : '';
    return [
      entry('npm', 'npm', 'npm registry', failing ? 'attention' : 'working', {
        detail: `${npm.last ? 'last read' : 'not read yet'} for ${count}${waiting}${failing ? `; last error: ${npm.error}` : ''}`,
        at: iso(failing ? npm.errorAt : npm.last),
        fix: 'The board couldn’t read npm’s public registry; it asks again on the next sync. If it keeps failing, check status.npmjs.org.',
        link: 'https://status.npmjs.org',
      }),
    ];
  },

  // ---- Taskwarrior and push --------------------------------------------------------------

  /** Whether a machine's CLI reached the board with the API token (BRK-143): the setup's CLI step. */
  cliConnection() {
    const seen = num(this.meta('conn_cli_seen'));
    if (!seen)
      return entry('cli', 'cli', 'Command line', 'off', {
        detail: 'no call with the API token yet',
        fix: 'Connect a machine: put the board’s URL and token in tasks.env in ~/.config/breakaway, then run npx breakaway health. Agents the board starts reach it through their routine’s API credential.',
        link: doc(this.env, 'another-install'),
      });
    return entry('cli', 'cli', 'Command line', 'working', {
      detail: 'the CLI, or a script with the API token, last reached the board',
      at: iso(seen),
    });
  },

  taskwarriorConnection() {
    const seen = num(this.meta('conn_replica_seen'));
    const pushed = num(this.sql.exec("SELECT MAX(created) AS at FROM versions WHERE source = 'replica'").one().at);
    const gone = num(this.meta('conn_replica_gone'));
    const stuck = gone !== null && Date.now() - gone < GONE_FOR_MS;
    // On a fresh install no machine has synced yet: an optional setup step (CLD-139, BRK-143).
    if (!seen && !pushed && !stuck && this.firstRunInstall()) {
      return entry('taskwarrior', 'taskwarrior', 'Taskwarrior sync', 'off', {
        detail: 'no replica has synced yet',
        fix: 'Optional: to use Taskwarrior, put the sync client ID and secret (from init-secrets) in tasks.env in ~/.config/breakaway next to the URL and token, then run npx breakaway setup, which writes Taskwarrior’s settings and runs the first task sync. The board and the CLI work without it.',
        link: doc(this.env, 'another-install'),
      });
    }
    return entry('taskwarrior', 'taskwarrior', 'Taskwarrior sync', stuck ? 'attention' : 'working', {
      detail: `${seen ? 'a replica last synced' : 'no replica sync recorded yet'}${pushed ? `; the last change from Taskwarrior ${iso(pushed)}` : ''}${gone ? `; a replica’s sync last failed with 410 Gone ${iso(gone)}` : ''}; replicas share one client ID, so they aren’t told apart`,
      at: iso(seen),
      fix: 'A replica’s task sync fails with 410 Gone: it last synced with another server (often pnpm tasks:interop run before CLD-195, with direnv on), so it can’t sync here again. Start it again: move its .task/ aside, then run scripts/task sync. Check the old one for changes that never reached the board first.',
      link: doc(this.env, 'when-somethings-wrong'),
    });
  },

  async pushConnection() {
    let keys = null;
    try {
      keys = await vapidKeys(this.env, this.homeUrl());
    } catch {
      keys = null;
    }
    const subs = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions').one().n;
    const last = JSON.parse(this.meta('conn_push_last') ?? 'null');
    if (!keys) {
      return entry('push', 'push', 'Push notifications', 'off', {
        detail: 'no VAPID key pair',
        fix: `Make a key pair (OPS-26): put the private key in the Secrets Store as ${secretName(install(this.env), 'VAPID_KEY')} and the public key in TASKS_VAPID_PUBLIC in wrangler.jsonc, then deploy the board.`,
        link: doc(this.env, 'pings-and-proposals'),
      });
    }
    let state = 'working';
    let fix = null;
    if (!subs) {
      state = 'attention';
      fix = 'No browser is subscribed: turn on Notifications in the board’s settings on your phone.';
    } else if (last?.failed) {
      state = 'attention';
      fix =
        'The push service refused the last notification. Turn Notifications off and on again in the board’s settings on that device.';
    }
    const lastText = last
      ? `; the last send: ${last.sent} delivered${last.failed ? `, ${last.failed} failed` : ''}${last.gone ? `, ${last.gone} gone (removed)` : ''}`
      : '; nothing sent yet';
    return entry('push', 'push', 'Push notifications', state, {
      detail: `keys set; ${subs} browser${subs === 1 ? '' : 's'} subscribed${lastText}`,
      at: iso(last?.at),
      fix,
    });
  },
};
