/**
 * TaskStore's footprints and path claims (docs/specs/IDEA-55-footprints.md, sections 1, 1a, 1b, and 5): what each
 * task will touch, predicted before an agent starts, claimed as it works, and actual once it changes files or opens a
 * pull request. Claims are advisory: the board's record and its answer, never a lock on the file system or git.
 *
 * Every claim runs out: it lasts LEASE_MS after its task's last heartbeat (every session hook post, check-in, peloton
 * listen, and wait-hook poll by the task's holder is one), never past CEILING_MS from when it was made, and all of a
 * task's claims end with its task claim. Reads check that as they go, so a claim is gone the moment it runs out; the
 * alarm's sweep (footprintsSweep) writes it down and prunes. Nothing here is on the task, so sync is untouched.
 */
import { AgentError } from './store-agents.js';
import { InputError, relatedOf, view } from './model.js';
import { repoSlugOf } from './repos.js';
import {
  footprintsOverlap,
  hitRate,
  isShared,
  matches,
  normalize,
  pathsNamed,
  predictFootprint,
  sharedFiles,
} from './footprint.js';

/**
 * How long a claim lives after its task's last heartbeat. A session hook posts after every tool call, so ten quiet
 * minutes mean the session stopped or is waiting (an open pull request covers a waiting agent). Checked against this
 * install's own agent sessions: see the BRK-318 pull request.
 */
export const LEASE_MS = 10 * 60_000;
/** The most a claim lives from when it was made, however busy its agent: an agent in a loop gives its paths back. */
export const CEILING_MS = 4 * 3_600_000;
/** An open pull request's files hold starts while its head moved within this long, or an agent holds its task. */
export const PULL_HOLD_MS = 24 * 3_600_000;
/** Ended claims and flagged conflicts are kept this long, for Activity, then pruned. */
const KEEP_MS = 24 * 3_600_000;
/** The hit rate reads this many of a repository's latest merged tasks; under HIT_TRUST, predictions there aren't trusted. */
export const HIT_WINDOW = 20;
export const HIT_TRUST = 0.5;
/**
 * The common-file rule of `sharedFiles` needs a history to mean anything: with a handful of merged pull requests
 * every file is in "most" of them. Below this many, only lockfiles are shared.
 */
const SHARED_MIN_HISTORY = 10;
const PATTERN_MAX = 300;
const PATTERNS_A_REQUEST = 50;
const DIRTY_A_REPORT = 500;
const AGENT = /^[\w.@:/-]{1,64}$/u;

/**
 * The sweep's steps, in order, each `this[step](now)`. The lapse of silent task claims and the stale mark on people's
 * (BRK-321, src/store-claim-lapse.js) are steps here rather than a second alarm.
 */
export const FOOTPRINT_SWEEP = [
  'endPathClaims',
  'refreshPullHeads',
  'prunePathClaims',
  'lapseSilentClaims',
  'markStaleClaims',
];

/**
 * A pattern as the board keeps it, or an InputError naming what's wrong. No braces or negation (a list says the
 * same), no `..`, and nothing outside the repository.
 * @param {unknown} raw
 */
export function cleanPattern(raw) {
  const pattern = normalize(String(raw ?? ''));
  if (!pattern)
    throw new InputError('a path pattern is a file, a folder ending in /, or a glob, from the repository’s root');
  if (pattern.length > PATTERN_MAX) throw new InputError(`a path pattern is up to ${PATTERN_MAX} characters`);
  if (/[{}]|^!/u.test(pattern))
    throw new InputError(`"${pattern}": no braces or negation in a pattern; list the paths instead`);
  if (pattern.split('/').some((part) => part === '..' || part === '.'))
    throw new InputError(`"${pattern}": a pattern is from the repository’s root, without . or ..`);
  return pattern;
}

/** @param {unknown} value a list, or one comma-separated string */
function listOf(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
}

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
/** @param {number} ms */
function ago(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const footprintsMethods = {
  initFootprints() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS footprints (
        uuid TEXT NOT NULL, kind TEXT NOT NULL, paths TEXT NOT NULL, agent TEXT, head TEXT, moved INTEGER,
        updated INTEGER NOT NULL, PRIMARY KEY (uuid, kind)
      );
      CREATE TABLE IF NOT EXISTS path_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL, agent TEXT NOT NULL, pattern TEXT NOT NULL,
        source TEXT NOT NULL, start TEXT, claimed INTEGER NOT NULL, heartbeat INTEGER NOT NULL, ceiling INTEGER NOT NULL,
        ended INTEGER, why TEXT
      );
      CREATE INDEX IF NOT EXISTS path_claims_open ON path_claims (ended, uuid);
      CREATE TABLE IF NOT EXISTS task_heartbeats (uuid TEXT PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS path_conflicts (
        uuid TEXT NOT NULL, path TEXT NOT NULL, other TEXT NOT NULL, agent TEXT NOT NULL, other_agent TEXT NOT NULL,
        pattern TEXT NOT NULL, at INTEGER NOT NULL, noted INTEGER, PRIMARY KEY (uuid, path, other)
      );
    `);
  },

  // ---- heartbeats ----------------------------------------------------------------------------

  /**
   * The task's holder is still there: renews every live claim it holds on the task, and freezes the task's predicted
   * footprint the first time, for the hit rate. Called by the session hook's post, the wait hook's poll, peloton
   * posts and listens, and path claims; anything else is ignored.
   * @param {string} uuid
   * @param {string} agent
   */
  heartbeat(uuid, agent, now = Date.now()) {
    const map = this.tasks.get(uuid);
    if (!agent || map?.status !== 'pending' || map.claim !== agent) return false;
    this.sql.exec(
      'INSERT INTO task_heartbeats (uuid, agent, at) VALUES (?, ?, ?) ON CONFLICT (uuid) DO UPDATE SET agent = excluded.agent, at = excluded.at',
      uuid,
      agent,
      now,
    );
    this.sql.exec(
      'UPDATE path_claims SET heartbeat = ? WHERE uuid = ? AND agent = ? AND ended IS NULL AND heartbeat > ? AND ceiling > ?',
      now,
      uuid,
      agent,
      now - LEASE_MS,
      now,
    );
    if (!this.sql.exec("SELECT 1 FROM footprints WHERE uuid = ? AND kind = 'predicted'", uuid).toArray().length)
      this.storePrediction(uuid, this.predictionFor(uuid));
    return true;
  },

  /**
   * When the task's holder last showed it was there, or null: `{ agent, at }` (ms). The one read of "is this agent
   * silent" that the starters (BRK-319) and the lapse of task claims (BRK-321) share.
   * @param {string} uuid
   * @returns {{ agent: string, at: number } | null}
   */
  lastHeartbeat(uuid) {
    const row = this.sql.exec('SELECT agent, at FROM task_heartbeats WHERE uuid = ?', uuid).toArray()[0];
    return row ? { agent: String(row.agent), at: Number(row.at) } : null;
  },

  // ---- claims --------------------------------------------------------------------------------

  /** Why a claim row is no longer live, or null while it is. */
  claimEnd(row, now = Date.now()) {
    if (row.ended !== null && row.ended !== undefined) return row.why ?? 'ended';
    const map = this.tasks.get(row.uuid);
    // Its task claim ended: released, finished, taken over, or released and claimed again.
    if (map?.status !== 'pending' || map.claim !== row.agent || String(map.start ?? '') !== String(row.start ?? ''))
      return 'task released';
    if (now >= row.ceiling) return 'ceiling';
    if (now >= row.heartbeat + LEASE_MS) return 'lapsed';
    return null;
  },

  /** Live claims, oldest first: of one task, or (with `repo`) of every task in one repository. */
  livePathClaims({ uuid = null, repo = null, now = Date.now() } = {}) {
    const rows = uuid
      ? this.sql.exec('SELECT * FROM path_claims WHERE ended IS NULL AND uuid = ? ORDER BY id', uuid).toArray()
      : this.sql.exec('SELECT * FROM path_claims WHERE ended IS NULL ORDER BY id').toArray();
    const fallback = this.defaultRepoSlug();
    return rows.filter(
      (row) => !this.claimEnd(row, now) && (!repo || repoSlugOf(this.tasks.get(row.uuid), fallback) === repo),
    );
  },

  /** A claim as the API shows it. */
  claimView(row) {
    return {
      pattern: row.pattern,
      agent: row.agent,
      source: row.source,
      claimed: iso(row.claimed),
      active: iso(row.heartbeat),
      until: iso(Math.min(row.heartbeat + LEASE_MS, row.ceiling)),
    };
  },

  /** Who holds `row`, for a refusal or a conflict. */
  holderOf(row) {
    return {
      task: this.widOf(row.uuid),
      agent: row.agent,
      pattern: row.pattern,
      active: iso(row.heartbeat),
      until: iso(Math.min(row.heartbeat + LEASE_MS, row.ceiling)),
    };
  },

  /** The task the agent holds, or a 403 that says why it can't claim paths on it. */
  pathsHolder(uuid, agent) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) throw new InputError('say who is claiming: agent is your name on the board');
    const map = this.tasks.get(uuid);
    if (map?.status !== 'pending' || map.claim !== name)
      throw new AgentError(
        `${name} doesn’t hold ${this.widOf(uuid)}: claim the task first, then the paths you’ll change`,
        403,
      );
    return { name, map };
  },

  /**
   * Claims patterns for the task its agent holds (section 1a): each one that overlaps no other task's live claim in
   * the repository is granted, the rest are refused with who holds what. Two patterns of one task never conflict,
   * and a pattern the task already holds is no new claim. Shared files never conflict.
   * @param {string} uuid
   * @param {string} agent
   * @param {unknown} patterns
   * @returns {{ granted: { pattern: string, until: string }[], held: string[], refused: { pattern: string, holder: any }[] }}
   */
  claimPaths(uuid, agent, patterns, { source = 'claim', now = Date.now(), context = null } = {}) {
    const { name, map } = this.pathsHolder(uuid, agent);
    const wanted = [...new Set(listOf(patterns).map(cleanPattern))];
    if (wanted.length > PATTERNS_A_REQUEST)
      throw new InputError(`claim up to ${PATTERNS_A_REQUEST} patterns at a time`);
    this.heartbeat(uuid, name, now);
    const repo = repoSlugOf(map, this.defaultRepoSlug());
    const shared = (context ?? this.footprintContext(repo)).shared;
    const live = this.livePathClaims({ repo, now });
    const own = new Set(live.filter((row) => row.uuid === uuid).map((row) => row.pattern));
    const others = live.filter((row) => row.uuid !== uuid);
    /** @type {{ pattern: string, until: string }[]} */
    const granted = [];
    /** @type {string[]} */
    const held = [];
    /** @type {{ pattern: string, holder: any }[]} */
    const refused = [];
    for (const pattern of wanted) {
      if (own.has(pattern)) {
        held.push(pattern);
        continue;
      }
      const holder = others.find((row) => footprintsOverlap([pattern], [row.pattern], { shared }));
      if (holder) {
        refused.push({ pattern, holder: this.holderOf(holder) });
        continue;
      }
      this.sql.exec(
        'INSERT INTO path_claims (uuid, agent, pattern, source, start, claimed, heartbeat, ceiling) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        uuid,
        name,
        pattern,
        source,
        map.start === undefined || map.start === null ? null : String(map.start),
        now,
        now,
        now + CEILING_MS,
      );
      own.add(pattern);
      granted.push({ pattern, until: iso(Math.min(now + LEASE_MS, now + CEILING_MS)) });
    }
    return { granted, held, refused };
  },

  /**
   * Gives claims back: the agent its own, on the task it holds; the owner any. No patterns gives back every claim the
   * task holds.
   * @param {string} uuid
   * @param {{ agent?: string | null, owner?: boolean, patterns?: unknown }} options
   */
  releasePaths(uuid, { agent = null, owner = false, patterns = [] } = {}, now = Date.now()) {
    const name = owner ? null : this.pathsHolder(uuid, agent).name;
    const asked = new Set(listOf(patterns).map(cleanPattern));
    const rows = this.livePathClaims({ uuid, now }).filter(
      (row) => (!asked.size || asked.has(row.pattern)) && (owner || row.agent === name),
    );
    for (const row of rows)
      this.sql.exec(
        'UPDATE path_claims SET ended = ?, why = ? WHERE id = ?',
        now,
        owner ? 'released by the owner' : 'released',
        row.id,
      );
    return { released: rows.map((row) => row.pattern) };
  },

  /**
   * The session hook's report of what the agent changed (section 1b): `git status` and the diff against the default
   * branch's merge base, paths only. They become the task's dirty paths; one nobody else claims is claimed for the
   * task, and one another task's live claim matches is a conflict, flagged once per task, path, and other task.
   * @param {string} uuid
   * @param {string} agent
   * @param {unknown} paths
   */
  reportDirty(uuid, agent, paths, now = Date.now()) {
    const { name, map } = this.pathsHolder(uuid, agent);
    /** @type {string[]} */
    const files = [];
    for (const raw of listOf(paths).slice(0, DIRTY_A_REPORT)) {
      try {
        const file = cleanPattern(raw);
        if (!/[*?]/u.test(file) && !file.endsWith('/') && !files.includes(file)) files.push(file);
      } catch {
        /* a path the hook can't have meant: left out */
      }
    }
    this.heartbeat(uuid, name, now);
    this.sql.exec(
      "INSERT INTO footprints (uuid, kind, paths, agent, updated) VALUES (?, 'dirty', ?, ?, ?) ON CONFLICT (uuid, kind) DO UPDATE SET paths = excluded.paths, agent = excluded.agent, updated = excluded.updated",
      uuid,
      JSON.stringify(files),
      name,
      now,
    );
    const repo = repoSlugOf(map, this.defaultRepoSlug());
    const context = this.footprintContext(repo);
    const live = this.livePathClaims({ repo, now });
    const own = live.filter((row) => row.uuid === uuid);
    const others = live.filter((row) => row.uuid !== uuid);
    /** @type {string[]} */
    const free = [];
    /** @type {any[]} */
    const conflicts = [];
    for (const file of files) {
      if (isShared(file, context.shared) || own.some((row) => matches(row.pattern, file))) continue;
      const holder = others.find((row) => matches(row.pattern, file));
      if (!holder) {
        free.push(file);
        continue;
      }
      const before = this.sql
        .exec('SELECT at FROM path_conflicts WHERE uuid = ? AND path = ? AND other = ?', uuid, file, holder.uuid)
        .toArray()[0];
      if (!before)
        this.sql.exec(
          'INSERT INTO path_conflicts (uuid, path, other, agent, other_agent, pattern, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          uuid,
          file,
          holder.uuid,
          name,
          holder.agent,
          holder.pattern,
          now,
        );
      conflicts.push({
        path: file,
        task: this.widOf(holder.uuid),
        agent: holder.agent,
        pattern: holder.pattern,
        at: iso(before ? Number(before.at) : now),
        new: !before,
      });
    }
    const claimed = free.length
      ? this.claimPaths(uuid, name, free, { source: 'dirty', now, context }).granted.map((g) => g.pattern)
      : [];
    return { claimed, conflicts };
  },

  /** The conflicts flagged on a task in the last day, newest first: what it changed that another task claims. */
  pathConflicts(uuid) {
    return this.sql
      .exec('SELECT * FROM path_conflicts WHERE uuid = ? ORDER BY at DESC, path', uuid)
      .toArray()
      .map((row) => ({
        path: row.path,
        task: this.widOf(row.other),
        agent: row.other_agent,
        pattern: row.pattern,
        at: iso(Number(row.at)),
      }));
  },

  // ---- what a task touches -------------------------------------------------------------------

  /**
   * What the footprints of one repository's tasks are read with, once: its merged pull requests' files (newest
   * first), the shared files, the completed tasks with the files their pull requests changed, and its open pull
   * requests by the work IDs they close.
   * @param {string} repo
   */
  footprintContext(repo) {
    const pulls = this.sql
      .exec('SELECT number, state, updated, data FROM gh_pulls WHERE repo = ?', repo)
      .toArray()
      .map((row) => ({ ...JSON.parse(String(row.data)), rowUpdated: String(row.updated) }));
    const at = (/** @type {any} */ p) => Date.parse(p.mergedAt ?? p.rowUpdated) || 0;
    const merged = pulls
      .filter((p) => p.state === 'merged' && Array.isArray(p.files))
      .sort((x, y) => at(y) - at(x) || y.number - x.number);
    const shared = sharedFiles(merged, merged.length < SHARED_MIN_HISTORY ? { share: 1 } : {});
    /** @type {Map<string, string[]>} */
    const filesByWid = new Map();
    for (const p of merged)
      for (const wid of p.closes ?? []) filesByWid.set(wid, [...(filesByWid.get(wid) ?? []), ...p.files]);
    const fallback = this.defaultRepoSlug();
    const history = [];
    for (const [uuid, map] of this.tasks) {
      if (map.status !== 'completed' || !map.wid || !filesByWid.has(map.wid)) continue;
      if (repoSlugOf(map, fallback) !== repo) continue;
      history.push({
        ...this.footprintTask(uuid, map),
        files: filesByWid.get(map.wid),
        uuid,
        end: Number(map.end ?? 0),
      });
    }
    return { repo, pulls, merged, shared, filesByWid, history };
  },

  /** A task in the words the prediction reads. */
  footprintTask(uuid, map) {
    const v = view(uuid, map, this.tasks);
    return { description: v.description, brief: v.brief, done_when: v.doneWhen, comments: v.comments };
  },

  /** The task's predicted footprint (section 2), from its words, its related tasks', and tasks like it. */
  predictionFor(uuid, context = null) {
    const map = this.tasks.get(uuid);
    if (!map) return { known: false, paths: [], shared: [] };
    const ctx = context ?? this.footprintContext(repoSlugOf(map, this.defaultRepoSlug()));
    const related = relatedOf(map)
      .map((id) => this.tasks.get(id))
      .filter(Boolean)
      .map((other) => this.footprintTask('', other));
    // A spec's text isn't kept on the board (it's read from GitHub when shown): its path is named, and its tasks' words.
    return predictFootprint(this.footprintTask(uuid, map), {
      related,
      history: ctx.history.filter((/** @type {any} */ t) => t.uuid !== uuid),
      shared: ctx.shared,
    });
  },

  storePrediction(uuid, predicted, now = Date.now()) {
    this.sql.exec(
      "INSERT INTO footprints (uuid, kind, paths, updated) VALUES (?, 'predicted', ?, ?) ON CONFLICT (uuid, kind) DO UPDATE SET paths = excluded.paths, updated = excluded.updated",
      uuid,
      JSON.stringify(predicted),
      now,
    );
  },

  storedPrediction(uuid) {
    const row = this.sql.exec("SELECT paths FROM footprints WHERE uuid = ? AND kind = 'predicted'", uuid).toArray()[0];
    return row ? JSON.parse(String(row.paths)) : null;
  },

  /**
   * The task's open pull request and its files, or null, with whether they hold starts: while its head moved in the
   * last PULL_HOLD_MS or an agent holds the task. A head the board hasn't seen before counts as a move.
   */
  pullFootprint(uuid, context, now = Date.now()) {
    const map = this.tasks.get(uuid);
    if (!map) return null;
    const number = /^\d+$/u.test(String(map.pr ?? '')) ? Number(map.pr) : null;
    const pr = context.pulls.find(
      (/** @type {any} */ p) =>
        p.state === 'open' &&
        Array.isArray(p.files) &&
        ((map.wid && (p.closes ?? []).includes(map.wid)) || p.number === number),
    );
    if (!pr) return null;
    const head = pr.headSha ?? pr.filesHead ?? null;
    const row = this.sql.exec("SELECT head, moved FROM footprints WHERE uuid = ? AND kind = 'pull'", uuid).toArray()[0];
    let moved = row ? Number(row.moved) : null;
    if (!row || row.head !== head) {
      moved = row ? now : Math.min(now, Date.parse(pr.rowUpdated) || now);
      this.sql.exec(
        "INSERT INTO footprints (uuid, kind, paths, head, moved, updated) VALUES (?, 'pull', ?, ?, ?, ?) ON CONFLICT (uuid, kind) DO UPDATE SET paths = excluded.paths, head = excluded.head, moved = excluded.moved, updated = excluded.updated",
        uuid,
        JSON.stringify(pr.files),
        head,
        moved,
        now,
      );
    }
    const agentHolds = map.status === 'pending' && Boolean(map.claim);
    return {
      number: pr.number,
      head,
      files: pr.files.map(normalize),
      partial: Boolean(pr.filesPartial),
      moved: iso(Number(moved)),
      holds: agentHolds || now - Number(moved) < PULL_HOLD_MS,
    };
  },

  /**
   * A task's footprint (section 1): its live claims, dirty paths, and open pull request's files together when it has
   * any (`claimed`, or `actual` once it changed files), else its prediction (`predicted`, or `unknown` when nothing
   * was found). `patterns` is what holds starts now; `trusted` is false when the repository's predictions cover
   * under half of what its tasks changed, so the starters treat a prediction there as unknown.
   * @param {string} uuid
   */
  taskFootprint(uuid, { context = null, now = Date.now() } = {}) {
    const map = this.tasks.get(uuid);
    const repo = repoSlugOf(map, this.defaultRepoSlug());
    const ctx = context ?? this.footprintContext(repo);
    const claims = this.livePathClaims({ uuid, now });
    const dirtyRow = this.sql
      .exec("SELECT paths, agent FROM footprints WHERE uuid = ? AND kind = 'dirty'", uuid)
      .toArray()[0];
    const dirty =
      dirtyRow && map?.status === 'pending' && map.claim === dirtyRow.agent ? JSON.parse(String(dirtyRow.paths)) : [];
    const pull = this.pullFootprint(uuid, ctx, now);
    /** @type {Map<string, any>} */
    const paths = new Map();
    /** @type {Set<string>} */
    const left = new Set();
    for (const row of claims)
      paths.set(row.pattern, {
        pattern: row.pattern,
        source: row.source,
        state: 'claimed',
        agent: row.agent,
        until: iso(Math.min(row.heartbeat + LEASE_MS, row.ceiling)),
      });
    for (const file of dirty) {
      if (isShared(file, ctx.shared)) left.add(file);
      else if (!paths.has(file)) paths.set(file, { pattern: file, source: 'dirty', state: 'dirty' });
    }
    for (const file of pull?.files ?? []) {
      if (isShared(file, ctx.shared)) left.add(file);
      else if (!paths.has(file)) paths.set(file, { pattern: file, source: 'pull', state: 'pull', holds: pull.holds });
    }
    const pending = map?.status === 'pending';
    let predicted = this.storedPrediction(uuid);
    if (pending && !map.claim && !paths.size) {
      // Before an agent starts, the prediction follows the task's words; once one does, it's kept as it was.
      predicted = this.predictionFor(uuid, ctx);
      this.storePrediction(uuid, predicted, now);
    }
    predicted ??= this.predictionFor(uuid, ctx);
    const rate = this.footprintHitRate(repo, ctx);
    const current = [...paths.values()];
    const kind = current.length
      ? current.some((p) => p.state !== 'claimed')
        ? 'actual'
        : 'claimed'
      : predicted.known
        ? 'predicted'
        : 'unknown';
    const list = current.length
      ? current
      : predicted.paths.map((/** @type {any} */ p) => ({ pattern: p.pattern, source: p.source, state: 'predicted' }));
    for (const file of predicted.shared ?? []) if (!current.length) left.add(file);
    return {
      task: this.widOf(uuid),
      repo,
      kind,
      known: list.length > 0,
      trusted: kind !== 'predicted' || rate.trusted,
      paths: list,
      patterns: list.filter((p) => p.holds !== false).map((p) => p.pattern),
      pull,
      predicted,
      shared: [...left].sort(),
      conflicts: this.pathConflicts(uuid),
      hitRate: { rate: rate.rate, count: rate.count, trusted: rate.trusted },
    };
  },

  /**
   * How well predictions did in a repository: for each of its latest HIT_WINDOW completed tasks with a frozen
   * prediction and a merged pull request's files, the share of those files the prediction covered (shared files
   * aside), and their mean. Under HIT_TRUST, the starters stop trusting predictions there.
   * @param {string} repo
   */
  footprintHitRate(repo, context = null) {
    const ctx = context ?? this.footprintContext(repo);
    const tasks = [];
    for (const done of [...ctx.history].sort((x, y) => y.end - x.end)) {
      const predicted = this.storedPrediction(done.uuid);
      if (!predicted) continue;
      const rate = hitRate(predicted.paths ?? [], done.files, { shared: ctx.shared });
      if (rate === null) continue;
      tasks.push({ task: this.widOf(done.uuid), rate });
      if (tasks.length >= HIT_WINDOW) break;
    }
    const rate = tasks.length ? tasks.reduce((sum, t) => sum + t.rate, 0) / tasks.length : null;
    return { rate, count: tasks.length, trusted: rate === null || rate >= HIT_TRUST, tasks };
  },

  // ---- the sweep -----------------------------------------------------------------------------

  /** The alarm's sweep: every step in FOOTPRINT_SWEEP, in order. */
  footprintsSweep(now = Date.now()) {
    for (const step of FOOTPRINT_SWEEP) this[step](now);
  },

  /** Writes down the claims that ran out or whose task claim ended, with why and when. */
  endPathClaims(now = Date.now()) {
    for (const row of this.sql.exec('SELECT * FROM path_claims WHERE ended IS NULL').toArray()) {
      const why = this.claimEnd(row, now);
      if (!why) continue;
      const at = why === 'ceiling' ? row.ceiling : why === 'lapsed' ? Math.min(row.heartbeat + LEASE_MS, now) : now;
      this.sql.exec('UPDATE path_claims SET ended = ?, why = ? WHERE id = ?', at, why, row.id);
    }
  },

  /** Ends a task's claims whose task claim ended, at once: change() calls it when a claim or a status changes. */
  endPathClaimsOf(uuid, now = Date.now()) {
    for (const row of this.sql.exec('SELECT * FROM path_claims WHERE uuid = ? AND ended IS NULL', uuid).toArray())
      if (this.claimEnd(row, now) === 'task released')
        this.sql.exec("UPDATE path_claims SET ended = ?, why = 'task released' WHERE id = ?", now, row.id);
  },

  /** Notes a moved head on every open task's pull request, so its 24 hours count from the move. */
  refreshPullHeads(now = Date.now()) {
    const fallback = this.defaultRepoSlug();
    /** @type {Map<string, any>} */
    const contexts = new Map();
    for (const row of this.sql.exec("SELECT uuid FROM footprints WHERE kind = 'pull'").toArray()) {
      const map = this.tasks.get(row.uuid);
      if (map?.status !== 'pending') {
        this.sql.exec("DELETE FROM footprints WHERE uuid = ? AND kind IN ('pull', 'dirty')", row.uuid);
        continue;
      }
      const repo = repoSlugOf(map, fallback);
      if (!contexts.has(repo)) contexts.set(repo, this.footprintContext(repo));
      this.pullFootprint(row.uuid, contexts.get(repo), now);
    }
  },

  /** Ended claims and conflicts older than a day, and dirty paths of tasks that closed. */
  prunePathClaims(now = Date.now()) {
    this.sql.exec('DELETE FROM path_claims WHERE ended IS NOT NULL AND ended < ?', now - KEEP_MS);
    this.sql.exec('DELETE FROM path_conflicts WHERE at < ?', now - KEEP_MS);
    for (const row of this.sql.exec("SELECT uuid FROM footprints WHERE kind = 'dirty'").toArray())
      if (this.tasks.get(row.uuid)?.status !== 'pending')
        this.sql.exec("DELETE FROM footprints WHERE uuid = ? AND kind = 'dirty'", row.uuid);
  },

  // ---- the API -------------------------------------------------------------------------------

  /** GET /api/tasks/:id/footprint, and the MCP server's footprint read. */
  footprintApi(ref) {
    return this.run(() => ({ status: 200, body: { footprint: this.taskFootprint(this.resolve(ref)) } }));
  },

  /**
   * POST /api/tasks/:id/paths: `claim` patterns, `release` them (none: every one), and report `dirty` paths, as the
   * task's agent; with no agent, the owner, who only releases. A refused claim answers 409, with the rest granted.
   * @param {string} ref
   * @param {any} body
   * @param {{ owner?: boolean }} [options]
   */
  pathsApi(ref, body, { owner = false } = {}) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      const agent = String(body?.agent ?? '').trim();
      const asOwner = owner || !agent;
      const claim = listOf(body?.claim);
      const dirty = body?.dirty === undefined ? null : listOf(body.dirty);
      const releasing = body?.release !== undefined && body?.release !== null && body?.release !== false;
      if (asOwner && (claim.length || dirty))
        throw new InputError('say who is claiming: agent is your name on the board (the owner only releases claims)');
      if (!claim.length && !dirty && !releasing) throw new InputError('send claim, release, or dirty');
      /** @type {any} */
      const out = {};
      if (releasing)
        Object.assign(
          out,
          this.releasePaths(uuid, {
            agent,
            owner: asOwner,
            patterns: body.release === true ? [] : body.release,
          }),
        );
      if (dirty) Object.assign(out, this.reportDirty(uuid, agent, dirty));
      if (claim.length) Object.assign(out, this.claimPaths(uuid, agent, claim));
      if (out.refused?.length) {
        const [first] = out.refused;
        const h = first.holder;
        const more = out.refused.length > 1 ? ` (and ${out.refused.length - 1} more)` : '';
        return {
          status: 409,
          body: {
            error: `\`${first.pattern}\` is claimed by ${h.agent} on ${h.task} (\`${h.pattern}\`, active ${ago(Date.now() - Date.parse(h.active))})${more}. Back off: change other files, ask @${h.agent} on the peloton, or if your task can’t go on without it, comment why and release it.`,
            ...out,
          },
        };
      }
      return { status: 200, body: out };
    });
  },
};
