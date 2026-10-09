/**
 * TaskStore's peloton (docs/specs/IDEA-32-peloton.md, sections 1, 2, 3, and 6, and IDEA-36-peloton-planning.md,
 * sections 2 to 5, 7, and 10): where running agents talk with each other. A peloton is a channel: every repository
 * has one (named by its slug), and a chase opens one of its own (`chase:<feature>`) that closes when the chase
 * stops or ends. Only the holder of a claimed task that rides a peloton can post on it as an agent, and the owner
 * posts from the signed-in board. Who rides is worked out, never stored: the agents that checked in and still
 * hold their claim. Posts are notes, never tasks and never synced, kept a day. A chase's peloton also holds huddles
 * (all heads on one question, one at a time) and the chase's plan (one text, every revision kept).
 */
import { AgentError } from './store-agents.js';
import { commentsOf, InputError } from './model.js';
import { looksLikeSecret } from './ping.js';
import { repoSlugOf } from './repos.js';
import { pathsNamed } from './footprint.js';
import { cleanPattern } from './store-footprints.js';

const AGENT = /^[\w.@:/-]{1,64}$/u;
const CHASE = 'chase:';
const DAY = 86_400_000;
export const POST_MAX = 2000;
export const POSTS_AN_HOUR = 120; // per agent
export const POSTS_KEPT = 200; // per repository's peloton
export const CHASE_POSTS_KEPT = 1000; // per chase's peloton
/** How many posts a read hands back at once: the newest of what's kept. */
const POSTS_SHOWN = 50;
/**
 * How close together an agent's two posts of the same kind and text on different pelotons are one post on both, its
 * twin (BRK-278): a check-in goes to the repository's and the chase's, and a reader riding both hears it once.
 */
export const TWIN_MS = 5 * 60_000;
/** How many unseen posts the session hooks get at once (IDEA-36 section 3): more in a chase. */
export const HOOK_POSTS = 5;
export const CHASE_HOOK_POSTS = 10;
const AGENT_KINDS = [
  'checkin',
  'step',
  'reply',
  'leave',
  'note',
  'ask',
  'propose',
  'review',
  'huddle',
  'in',
  'outcome',
];
/** The owner talks; they don't ride, so they never check in, leave, or say they're in a huddle (IDEA-36 section 7). */
const OWNER_KINDS = AGENT_KINDS.filter((k) => k !== 'checkin' && k !== 'leave' && k !== 'in');
/** The kinds only a chase's peloton takes (IDEA-36 section 1); `plan` is the board's line, never posted. */
const HUDDLE_KINDS = new Set(['huddle', 'in', 'outcome']);
/** A huddle closes by itself after 20 minutes, and an agent calls at most one every 30 (IDEA-36 section 4). */
export const HUDDLE_MS = 20 * 60_000;
export const HUDDLE_EVERY_MS = 30 * 60_000;
export const PLAN_MAX = 4000;
const WHY_MAX = 300;
/** The board's lines that reach agents as urgently as the owner's: GitHub going down and working again (BRK-279). */
const BOARD_URGENT = new Set(['outage', 'clear']);
/** Names no agent posts as: the owner's posts and the board's lines carry them. */
const RESERVED = new Set(['owner', 'board']);
/** `@<agent name>` or `@captain`, not inside a word or an address; a name's trailing punctuation isn't part of it. */
const MENTION = /(?<![\w.@:/-])@([\w.:/-]{1,64})/gu;

const iso = (ms) => new Date(Number(ms)).toISOString();

/** The board's comment on a task its agent left with posts to it unanswered (BRK-281). */
function openNote(agent, posts) {
  const lines = posts.map((p) => {
    const text = p.text.length > 160 ? `${p.text.slice(0, 157)}…` : p.text;
    return `- peloton #${p.id} on ${p.peloton}, from ${p.agent}: ${text}`;
  });
  return `${agent} left with ${posts.length === 1 ? 'a post' : `${posts.length} posts`} to it unanswered on the peloton:\n${lines.join('\n')}`;
}

/** The names a stored post mentions. */
function mentionsOf(row) {
  if (!row.mentions) return [];
  try {
    const names = JSON.parse(row.mentions);
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const pelotonMethods = {
  initPeloton() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS peloton_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, peloton TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT NOT NULL,
        task TEXT, repo TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER
      );
      CREATE INDEX IF NOT EXISTS peloton_posts_peloton ON peloton_posts (peloton, id);
      CREATE INDEX IF NOT EXISTS peloton_posts_agent ON peloton_posts (agent, at);
      CREATE TABLE IF NOT EXISTS peloton_seen (
        peloton TEXT NOT NULL, agent TEXT NOT NULL, last_id INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (peloton, agent)
      );
      CREATE TABLE IF NOT EXISTS peloton_huddles (
        post INTEGER PRIMARY KEY, peloton TEXT NOT NULL, caller TEXT NOT NULL, task TEXT, opened INTEGER NOT NULL,
        closes INTEGER NOT NULL, closed INTEGER, outcome INTEGER
      );
      CREATE INDEX IF NOT EXISTS peloton_huddles_peloton ON peloton_huddles (peloton, closed);
      CREATE TABLE IF NOT EXISTS peloton_plans (
        peloton TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, agent TEXT NOT NULL, task TEXT,
        at INTEGER NOT NULL, why TEXT NOT NULL, PRIMARY KEY (peloton, version)
      );
      CREATE TABLE IF NOT EXISTS peloton_pr_seen (
        agent TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent, task)
      );
    `);
    // The riders a post mentions, as JSON (IDEA-36 section 10). Posts from before mention nobody.
    const columns = this.sql
      .exec('PRAGMA table_info(peloton_posts)')
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('mentions')) this.sql.exec('ALTER TABLE peloton_posts ADD COLUMN mentions TEXT');
    // The first of the same post on another peloton (BRK-278). Posts from before have none.
    if (!columns.includes('twin')) this.sql.exec('ALTER TABLE peloton_posts ADD COLUMN twin INTEGER');
    this.sql.exec('CREATE INDEX IF NOT EXISTS peloton_posts_twin ON peloton_posts (twin)');
  },

  /** A peloton's name as given → its canonical name and what it is, or a 404 for one the board doesn't have. */
  pelotonOf(raw) {
    const name = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (name.startsWith(CHASE)) {
      const row = this.featureRow(name.slice(CHASE.length));
      return { name: `${CHASE}${row.slug}`, kind: 'chase', feature: row, open: row.chase === 'on' };
    }
    if (name && (this.repoBySlug(name) || name === this.defaultRepoSlug())) return { name, kind: 'repo', open: true };
    throw new AgentError(`there’s no peloton "${raw}": it’s a repository’s slug, or chase:<feature>`, 404);
  },

  /** The chases that are on, each with the tasks it rides on (its own and the blockers it pulled in). */
  openChases(views) {
    const rows = this.sql.exec("SELECT * FROM features WHERE chase = 'on' ORDER BY slug").toArray();
    if (!rows.length) return [];
    const all = views ?? this.views();
    return rows.map((row) => ({ row, tasks: new Set(this.chaseMembers(row, all).map((e) => e.t.uuid)) }));
  },

  /** Whether `agent` holds task `uuid` now: open, claimed by it. */
  holdsTask(agent, uuid) {
    const map = this.tasks.get(uuid);
    return map?.status === 'pending' && map.claim === agent;
  },

  /** The pelotons task `uuid` rides: its repository's, and every open chase it's in. */
  pelotonsOfTask(uuid, chases) {
    const map = this.tasks.get(uuid);
    if (!map) return [];
    const names = [repoSlugOf(map, this.defaultRepoSlug())];
    for (const { row, tasks } of chases) if (tasks.has(uuid)) names.push(`${CHASE}${row.slug}`);
    return names;
  },

  /** Every peloton `agent` rides now, each with the task it rides on: a Map of name → task uuid. */
  ridesOf(agent, chases = null) {
    const rides = new Map();
    const held = [...this.tasks].filter(([, map]) => map.status === 'pending' && map.claim === agent);
    if (!held.length) return rides;
    const open = chases ?? (this.chasing() ? this.openChases() : []);
    for (const [uuid] of held)
      for (const name of this.pelotonsOfTask(uuid, open)) if (!rides.has(name)) rides.set(name, uuid);
    return rides;
  },

  /**
   * Who rides `peloton` now, by name: every agent holding a claimed task that rides it, checked in or not, and which
   * of them is the chase's road captain (the agent the owner started as one, BRK-137), or null.
   */
  ridersOf(peloton) {
    const chases = this.chasing() ? this.openChases() : [];
    const riders = new Map();
    for (const [uuid, map] of this.tasks)
      if (map.status === 'pending' && map.claim && this.pelotonsOfTask(uuid, chases).includes(peloton))
        riders.set(map.claim.toLowerCase(), { agent: map.claim, uuid });
    let captain = null;
    if (peloton.startsWith(CHASE)) {
      // The board's road captain holds a +captain task (BRK-275); one the owner started before it, a road-captain run.
      const captains = new Set(
        this.sql
          .exec("SELECT DISTINCT task FROM agent_runs WHERE trigger = 'road-captain'")
          .toArray()
          .map((r) => r.task),
      );
      captain =
        [...riders.values()].find((r) => this.tasks.get(r.uuid)?.tag_captain || captains.has(r.uuid))?.agent ?? null;
    }
    return { riders, captain };
  },

  /** The riders of `peloton` that `text` mentions, by their names on the board, each once in the order written. */
  mentionsIn(peloton, text) {
    const asked = [...text.matchAll(MENTION)].map((m) => m[1].replace(/[.:/-]+$/u, '').toLowerCase());
    if (!asked.length) return [];
    const { riders, captain } = this.ridersOf(peloton);
    const names = [];
    for (const name of asked) {
      const who = name === 'captain' ? captain : (riders.get(name)?.agent ?? null);
      if (who && !names.includes(who)) names.push(who);
    }
    return names;
  },

  postView(row) {
    const map = row.task ? this.tasks.get(row.task) : null;
    return {
      id: row.id,
      at: iso(row.at),
      peloton: row.peloton,
      agent: row.agent,
      task: row.task ? (map?.wid ?? row.task.slice(0, 8)) : null,
      repo: row.repo,
      kind: row.kind,
      text: row.text,
      replyTo: row.reply_to ?? null,
      mentions: mentionsOf(row),
    };
  },

  addPost(peloton, { agent, task = null, repo = null, kind, text, replyTo = null, mentions = [] }) {
    const now = Date.now();
    // The same post its author just made on another peloton makes this one its twin (BRK-278).
    const first = this.sql
      .exec(
        'SELECT id, twin FROM peloton_posts WHERE agent = ? AND at > ? AND peloton != ? AND kind = ? AND text = ? ORDER BY id DESC LIMIT 1',
        agent,
        now - TWIN_MS,
        peloton,
        kind,
        text,
      )
      .toArray()[0];
    const row = this.sql
      .exec(
        'INSERT INTO peloton_posts (peloton, at, agent, task, repo, kind, text, reply_to, mentions, twin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        peloton,
        now,
        agent,
        task,
        repo,
        kind,
        text,
        replyTo,
        mentions.length ? JSON.stringify(mentions) : null,
        first ? (first.twin ?? first.id) : null,
      )
      .one();
    // 1,000 kept on a chase's peloton and 200 on a repository's: the oldest go first.
    this.sql.exec(
      'DELETE FROM peloton_posts WHERE peloton = ? AND id <= (SELECT id FROM peloton_posts WHERE peloton = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
      peloton,
      peloton,
      peloton.startsWith(CHASE) ? CHASE_POSTS_KEPT : POSTS_KEPT,
    );
    return row;
  },

  /** Each agent's last check-in on each peloton that no `leave` of theirs has followed. */
  checkedIn(peloton = null) {
    return this.sql
      .exec(
        `SELECT c.* FROM peloton_posts c
         WHERE c.kind = 'checkin' ${peloton ? 'AND c.peloton = ?' : ''}
           AND c.id = (SELECT MAX(id) FROM peloton_posts WHERE peloton = c.peloton AND agent = c.agent AND kind = 'checkin')
           AND NOT EXISTS (SELECT 1 FROM peloton_posts l WHERE l.peloton = c.peloton AND l.agent = c.agent AND l.kind = 'leave' AND l.id > c.id)
         ORDER BY c.id`,
        ...(peloton ? [peloton] : []),
      )
      .toArray();
  },

  /**
   * Takes off the roster every agent that checked in but no longer rides: it released its task, its pull request
   * merged, or the claim moved. Each gets a `leave` post saying why. A closed chase's peloton keeps quiet.
   */
  pelotonSweep() {
    this.closeHuddles();
    const rows = this.checkedIn();
    if (!rows.length) return;
    let chases = null;
    const features = new Map();
    const noted = new Set();
    for (const row of rows) {
      let stays = this.holdsTask(row.agent, row.task);
      if (row.peloton.startsWith(CHASE)) {
        const slug = row.peloton.slice(CHASE.length);
        if (!features.has(slug))
          features.set(slug, this.sql.exec('SELECT chase FROM features WHERE slug = ?', slug).toArray()[0]);
        if (features.get(slug)?.chase !== 'on') continue; // closed: nobody rides it, and it says so once
        if (stays) {
          chases ??= this.openChases();
          stays = chases.some(({ row: f, tasks }) => f.slug === slug && tasks.has(row.task));
        }
      }
      if (stays) continue;
      const map = this.tasks.get(row.task);
      const id = map?.wid ?? String(row.task ?? '').slice(0, 8);
      let why;
      if (!map || map.status === 'deleted') why = `${id} was deleted`;
      else if (map.status === 'completed') why = map.pr ? `${id}’s pull request #${map.pr} merged` : `${id} is done`;
      else if (!map.claim) why = `released ${id}`;
      else if (map.claim !== row.agent) why = `${id}’s claim moved to ${map.claim}`;
      else why = `${id} isn’t in this chase any more`;
      // What it left unanswered (BRK-281): the riders hear it in the leave post, and the task keeps it, once.
      const open = this.openPosts(row.agent, row.task);
      const ids = open.map((p) => `#${p.id}`).join(', ');
      this.addPost(row.peloton, {
        agent: row.agent,
        task: row.task,
        repo: row.repo,
        kind: 'leave',
        text: open.length
          ? `Left: ${why}, with ${open.length === 1 ? 'a post' : `${open.length} posts`} to it unanswered (${ids}).`
          : `Left: ${why}.`,
      });
      const once = `${row.agent}\n${row.task}`;
      if (open.length && map && !noted.has(once) && !this.meta('replica_error')) {
        noted.add(once);
        this.change(row.task, { annotate: openNote(row.agent, open), by: 'board' });
      }
    }
  },

  /** Who rides `peloton` now (after a sweep): agent, task, since when, and its last post. */
  pelotonRoster(peloton, open = true) {
    if (!open) return [];
    return this.checkedIn(peloton).map((row) => {
      const last = this.sql
        .exec(
          'SELECT * FROM peloton_posts WHERE peloton = ? AND agent = ? ORDER BY id DESC LIMIT 1',
          peloton,
          row.agent,
        )
        .one();
      const view = this.postView(row);
      return {
        agent: row.agent,
        task: view.task,
        repo: row.repo,
        since: view.at,
        last: this.postView(last),
        // Read by rosterFootprints (IDEA-55 section 4), which takes it off again.
        uuid: row.task ?? null,
      };
    });
  },

  pelotonPosts(peloton, limit = POSTS_KEPT) {
    return this.sql
      .exec('SELECT * FROM peloton_posts WHERE peloton = ? ORDER BY id DESC LIMIT ?', peloton, limit)
      .toArray()
      .reverse()
      .map((row) => this.postView(row));
  },

  /** GET /api/peloton/<peloton>: its roster and posts, newest last, for the board. Marks nothing seen. */
  pelotonDetail(raw) {
    const p = this.pelotonOf(raw);
    this.pelotonSweep();
    return {
      peloton: p.name,
      kind: p.kind,
      ...(p.feature ? { feature: p.feature.slug, title: p.feature.title } : {}),
      open: p.open,
      // Each rider with what it's changing (IDEA-55 section 4).
      roster: this.rosterFootprints(this.pelotonRoster(p.name, p.open)),
      huddle: this.huddleOf(p),
      plan: this.planOf(p),
      posts: this.pelotonPosts(p.name),
    };
  },

  /** GET /api/peloton: every peloton with something to show, for the board. */
  pelotonList() {
    this.pelotonSweep();
    const names = new Set(this.repos().map((r) => r.slug));
    for (const row of this.sql.exec("SELECT slug FROM features WHERE chase = 'on'").toArray())
      names.add(`${CHASE}${row.slug}`);
    for (const row of this.sql.exec('SELECT DISTINCT peloton FROM peloton_posts').toArray()) names.add(row.peloton);
    const list = [];
    for (const name of [...names].sort()) {
      let p;
      try {
        p = this.pelotonOf(name);
      } catch {
        continue; // a deleted feature's posts, until they age out
      }
      const roster = this.pelotonRoster(p.name, p.open);
      const posts = this.sql
        .exec('SELECT COUNT(*) AS n, MAX(at) AS last FROM peloton_posts WHERE peloton = ?', p.name)
        .one();
      list.push({
        peloton: p.name,
        kind: p.kind,
        ...(p.feature ? { feature: p.feature.slug, title: p.feature.title } : {}),
        open: p.open,
        riders: roster.length,
        posts: posts.n,
        lastAt: posts.last ? iso(posts.last) : null,
      });
    }
    return { pelotons: list };
  },

  seenMark(peloton, agent) {
    return (
      this.sql.exec('SELECT last_id FROM peloton_seen WHERE peloton = ? AND agent = ?', peloton, agent).toArray()[0]
        ?.last_id ?? 0
    );
  },

  markSeen(peloton, agent, lastId) {
    if (!lastId) return;
    this.sql.exec(
      `INSERT INTO peloton_seen (peloton, agent, last_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (peloton, agent) DO UPDATE SET last_id = MAX(last_id, excluded.last_id), at = excluded.at`,
      peloton,
      agent,
      lastId,
      Date.now(),
    );
  },

  /** The posts on `peloton` that `agent` hasn't seen: everyone else's, after its last read. */
  unseenRows(peloton, agent) {
    return this.sql
      .exec(
        'SELECT * FROM peloton_posts WHERE peloton = ? AND id > ? AND agent != ? ORDER BY id',
        peloton,
        this.seenMark(peloton, agent),
        agent,
      )
      .toArray();
  },

  /** The same post as `row` on the other pelotons: its twins, and the first of them (BRK-278). */
  twinsOf(row) {
    const first = row.twin ?? row.id;
    return this.sql
      .exec('SELECT id, peloton FROM peloton_posts WHERE (id = ? OR twin = ?) AND id != ?', first, first, row.id)
      .toArray();
  },

  /** Whether `agent` has already seen `row` as its twin on another peloton: each post reaches a reader once. */
  seenAsTwin(row, agent) {
    return this.twinsOf(row).some((t) => this.seenMark(t.peloton, agent) >= t.id);
  },

  /**
   * GET /api/peloton?agent=<name>: the pelotons `agent` rides, each with its roster and newest posts (the ones it
   * hadn't seen flagged `unseen`), and marks them seen.
   */
  agentPelotons(agent) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) throw new InputError('say which agent: ?agent=<name>');
    this.pelotonSweep();
    const pelotons = [];
    for (const [peloton, uuid] of this.ridesOf(name)) pelotons.push(this.agentView(peloton, name, uuid));
    return { agent: name, pelotons };
  },

  agentView(peloton, agent, uuid) {
    const p = this.pelotonOf(peloton);
    // A post the agent saw on another peloton isn't new here: the room still lists it, unstarred.
    const fresh = new Set(
      this.unseenRows(p.name, agent)
        .filter((row) => !this.seenAsTwin(row, agent))
        .map((row) => row.id),
    );
    const posts = this.pelotonPosts(p.name, POSTS_SHOWN).map((post) => ({
      ...post,
      unseen: fresh.has(post.id),
    }));
    const unseen = fresh.size;
    this.markSeen(p.name, agent, posts.at(-1)?.id ?? 0);
    const map = this.tasks.get(uuid);
    return {
      peloton: p.name,
      kind: p.kind,
      ...(p.feature ? { feature: p.feature.slug, title: p.feature.title } : {}),
      open: p.open,
      task: map?.wid ?? uuid.slice(0, 8),
      // Each rider with what it's changing, and where the reader's own paths meet it (IDEA-55 section 4).
      roster: this.rosterFootprints(this.pelotonRoster(p.name, p.open), uuid),
      huddle: this.huddleOf(p),
      plan: this.planOf(p),
      posts,
      unseen,
    };
  },

  /**
   * The posts in `agent`'s pelotons it hasn't seen, for its session hooks, each once (IDEA-36 section 3): the owner's
   * first, then huddles opening and closing, mentions of and replies to the agent, plan changes, then the rest in order; up to 10 when it rides a chase and 5
   * elsewhere. A post on two of its pelotons comes once, and not at all when it saw the other already (BRK-278). Every
   * one is marked seen, and `more` says how many weren't handed over (`tasks peloton` shows them).
   * `urgent`: the wait hook's ask, which takes them only when one of them is urgent (any but the rest), so a busy
   * peloton doesn't wake an idle agent. `listen`: the listen route's ask, which takes every post on a chase's peloton
   * and a repository's only when one of them there is urgent.
   * @returns {{ posts: any[], more: number }}
   */
  takePeloton(agent, { urgent = false, listen = false } = {}) {
    const none = { posts: [], more: 0 };
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) return none;
    const rides = this.ridesOf(name);
    if (!rides.size) return none;
    this.closeHuddles();
    const mine = new Set(
      this.sql
        .exec("SELECT id FROM peloton_posts WHERE agent = ? AND kind != 'leave'", name)
        .toArray()
        .map((r) => r.id),
    );
    const toYou = (row) => row.kind === 'reply' && mine.has(row.reply_to);
    const mentionsYou = (row) => mentionsOf(row).includes(name);
    // The spec's order: the owner's (and the board's outage lines), huddles opening and closing, mentions and replies, plan changes, the rest.
    const rank = (row) =>
      (row.agent === 'owner' && !row.task) || (row.agent === 'board' && BOARD_URGENT.has(row.kind))
        ? 0
        : row.kind === 'huddle' || row.kind === 'outcome'
          ? 1
          : mentionsYou(row) || toYou(row)
            ? 2
            : row.kind === 'plan'
              ? 3
              : 4;
    const taken = [];
    for (const peloton of rides.keys()) {
      const unseen = this.unseenRows(peloton, name);
      if (listen && !peloton.startsWith(CHASE) && !unseen.some((row) => rank(row) < 4)) continue;
      taken.push(...unseen);
    }
    // One post on two pelotons is one post: the first of it taken here, unless the agent saw a twin before.
    const firsts = new Set();
    const rows = taken.filter((row) => {
      const first = row.twin ?? row.id;
      if (firsts.has(first)) return false;
      firsts.add(first);
      return !this.seenAsTwin(row, name);
    });
    if (!taken.length || (urgent && !rows.some((row) => rank(row) < 4))) return none;
    for (const peloton of rides.keys()) {
      const last = taken.filter((r) => r.peloton === peloton).at(-1);
      if (last) this.markSeen(peloton, name, last.id);
    }
    if (!rows.length) return none;
    const batch = [...rides.keys()].some((p) => p.startsWith(CHASE)) ? CHASE_HOOK_POSTS : HOOK_POSTS;
    const posts = rows
      .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
      .slice(0, batch)
      .map((row) => ({
        ...this.postView(row),
        toYou: toYou(row),
        mentionsYou: mentionsYou(row),
        urgent: rank(row) < 4,
      }));
    return { posts, more: rows.length - posts.length };
  },

  /**
   * GET /api/peloton/listen?agent=<name>: what's waiting for `agent` now (IDEA-36 sections 3 and 10), answered at
   * once; the CLI asks every few seconds while the agent waits. It hands over, and marks delivered, the posts in its
   * pelotons (every one on its chase's, a repository's only with an urgent one, as `takePeloton` sorts them), the
   * owner's messages for its task, and a change to its task's pull request since it last asked. `urgent` says
   * whether to answer the agent now: an urgent post, a message, or the pull request. `stop` says why to stop
   * listening: the claim is gone, the pull request merged, or the chase stopped. `task` picks one when the agent
   * holds more than one.
   */
  listenPeloton(agent, task = null) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) throw new InputError('say which agent is listening: ?agent=<name>');
    const uuid = task !== null && task !== undefined && task !== '' ? this.resolve(task) : this.listenTask(name);
    const quiet = { urgent: false, posts: [], more: 0, messages: [], pr: null };
    if (!uuid || !this.holdsTask(name, uuid))
      return {
        agent: name,
        task: uuid ? this.widOf(uuid) : null,
        ...quiet,
        stop: this.listenGone(name, uuid),
        open: uuid ? this.openPosts(name, uuid) : [],
      };
    // A listening agent is there: each ask is a heartbeat for its path claims.
    this.heartbeat(uuid, name);
    const chases = this.chasing() ? this.openChases() : [];
    const pull = this.pullOfTask(uuid);
    const peloton = this.takePeloton(name, { listen: true });
    const messages = this.takeMessages(uuid, name, { poll: true });
    const pr = pull ? this.pullChange(name, uuid, pull) : null;
    const id = this.widOf(uuid);
    let stop = null;
    if (pull?.state === 'merged') stop = `${id}’s pull request #${pull.number} merged`;
    else if (!chases.some(({ tasks }) => tasks.has(uuid)))
      stop = `${id} isn’t in an open chase: the chase stopped, or it was never in one`;
    return {
      agent: name,
      task: id,
      urgent: peloton.posts.some((p) => p.urgent) || messages.length > 0 || pr !== null,
      posts: peloton.posts,
      more: peloton.more,
      messages,
      pr,
      stop,
      ...(stop ? { open: this.openPosts(name, uuid) } : {}),
    };
  },

  widOf(uuid) {
    return this.tasks.get(uuid)?.wid ?? uuid.slice(0, 8);
  },

  /** The task `agent` listens on: the one it holds in an open chase, else any it holds, else the last it held. */
  listenTask(agent) {
    const held = [...this.tasks].filter(([, map]) => map.status === 'pending' && map.claim === agent);
    if (held.length > 1 && this.chasing()) {
      const chases = this.openChases();
      const inChase = held.find(([uuid]) => chases.some(({ tasks }) => tasks.has(uuid)));
      if (inChase) return inChase[0];
    }
    if (held.length) return held[0][0];
    const last = [...this.tasks]
      .filter(([, map]) => map.claim === agent)
      .sort(([, a], [, b]) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')))[0];
    return last?.[0] ?? null;
  },

  /** Why `agent` no longer listens on task `uuid`, which it doesn't hold: its pull request merged, or the claim is gone. */
  listenGone(agent, uuid) {
    const map = uuid ? this.tasks.get(uuid) : null;
    if (!map) return `${agent} holds no claimed task: the claim is gone`;
    const id = this.widOf(uuid);
    if (map.status === 'completed') {
      const pull = this.pullOfTask(uuid);
      if (pull?.state === 'merged') return `${id}’s pull request #${pull.number} merged`;
      return `${id} is done: the claim is gone`;
    }
    if (map.status !== 'pending') return `${id} is ${map.status}: the claim is gone`;
    if (map.claim && map.claim !== agent) return `the claim on ${id} moved to ${map.claim}`;
    return `the claim on ${id} is gone: it was released`;
  },

  /**
   * The posts to `agent` it hasn't answered or handed over, as it leaves task `uuid` (BRK-281): someone else's post
   * that mentions it, or replies to a post it made on the task, with no reply of its own to it (or to the same post
   * on another peloton) and no comment of its own on the task naming it as `peloton #<id>`, which `peloton handover`
   * writes. A reply to one of its replies doesn't count, so a thank-you ends a thread; the board's lines never ask.
   * Oldest first, each once.
   */
  openPosts(agent, uuid) {
    const name = String(agent ?? '').trim();
    if (!name || !uuid) return [];
    const own = this.sql
      .exec('SELECT id, kind, reply_to FROM peloton_posts WHERE agent = ? AND task = ?', name, uuid)
      .toArray();
    const mine = new Set(own.filter((r) => r.kind !== 'leave').map((r) => r.id));
    const myReplies = new Set(own.filter((r) => r.kind === 'reply').map((r) => r.id));
    const answered = new Set(
      this.sql
        .exec("SELECT reply_to FROM peloton_posts WHERE agent = ? AND kind = 'reply'", name)
        .toArray()
        .map((r) => r.reply_to),
    );
    const map = this.tasks.get(uuid);
    for (const c of map ? commentsOf(map) : [])
      if (c.by === name) for (const m of c.text.matchAll(/peloton #(\d+)/gu)) answered.add(Number(m[1]));
    const candidates = this.sql
      .exec(
        `SELECT * FROM peloton_posts WHERE agent != ? AND agent != 'board' AND kind != 'leave'
           AND (mentions LIKE ? OR (kind = 'reply' AND reply_to IN (SELECT id FROM peloton_posts WHERE agent = ? AND task = ?)))
         ORDER BY id`,
        name,
        `%${JSON.stringify(name)}%`,
        name,
        uuid,
      )
      .toArray();
    const firsts = new Set();
    const open = [];
    for (const row of candidates) {
      const toMe = row.kind === 'reply' && mine.has(row.reply_to);
      if (!toMe && !mentionsOf(row).includes(name)) continue;
      if (row.kind === 'reply' && myReplies.has(row.reply_to)) continue;
      const first = row.twin ?? row.id;
      if (firsts.has(first)) continue;
      firsts.add(first);
      const ids = [row.id, ...this.twinsOf(row).map((t) => t.id)];
      if (ids.some((id) => answered.has(id))) continue;
      open.push(this.postView(row));
    }
    return open;
  },

  /** GET /api/peloton/open?agent=<name>: the posts to `agent` still open on the task it holds or last held (BRK-281). */
  openPostsOf(agent, task = null) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) throw new InputError('say which agent: ?agent=<name>');
    const uuid = task !== null && task !== undefined && task !== '' ? this.resolve(task) : this.listenTask(name);
    return { agent: name, task: uuid ? this.widOf(uuid) : null, posts: uuid ? this.openPosts(name, uuid) : [] };
  },

  /**
   * Task `uuid`'s pull request as the board keeps it from GitHub: the one its `pr` names, else the newest that
   * closes it, open ones first. Null when there's none.
   * @returns {{ number: number, state: string, data: any } | null}
   */
  pullOfTask(uuid) {
    const map = this.tasks.get(uuid);
    if (!map) return null;
    const repo = repoSlugOf(map, this.defaultRepoSlug());
    const row = map.pr
      ? this.sql
          .exec('SELECT number, state, data FROM gh_pulls WHERE repo = ? AND number = ?', repo, Number(map.pr))
          .toArray()[0]
      : map.wid
        ? this.sql
            .exec(
              `SELECT number, state, data FROM gh_pulls WHERE repo = ?
                 AND EXISTS (SELECT 1 FROM json_each(data, '$.closes') WHERE value = ?)
               ORDER BY state = 'open' DESC, updated DESC LIMIT 1`,
              repo,
              map.wid,
            )
            .toArray()[0]
        : null;
    return row ? { number: row.number, state: row.state, data: JSON.parse(row.data) } : null;
  },

  /**
   * What changed on `agent`'s pull request since it last asked (IDEA-36 section 3): its checks finished (on a new
   * head, or with a new result), a review came in, or it started to conflict. Null when nothing did. A first ask
   * reports what's already there, so an agent that starts listening late still hears a failure or a review.
   */
  pullChange(agent, uuid, pull) {
    const { data } = pull;
    const now = {
      number: pull.number,
      head: data.headSha ?? null,
      checks: data.checks?.state ?? 'none',
      review: data.review?.decision ?? 'none',
      reviews: (data.review?.reviewers?.length ?? 0) + (data.review?.comments ?? 0),
      conflict: data.mergeable === false || data.mergeableState === 'dirty',
    };
    const row = this.sql
      .exec('SELECT state FROM peloton_pr_seen WHERE agent = ? AND task = ?', agent, uuid)
      .toArray()[0];
    let last = row ? JSON.parse(row.state) : null;
    if (last?.number !== now.number) last = null;
    const changed = [];
    if (
      (now.checks === 'success' || now.checks === 'failure') &&
      (!last || last.checks !== now.checks || last.head !== now.head)
    )
      changed.push('checks');
    if (now.review && now.review !== 'none' && (!last || last.review !== now.review || now.reviews > last.reviews))
      changed.push('review');
    if (now.conflict && !last?.conflict) changed.push('conflict');
    this.sql.exec(
      `INSERT INTO peloton_pr_seen (agent, task, state, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent, task) DO UPDATE SET state = excluded.state, at = excluded.at`,
      agent,
      uuid,
      JSON.stringify(now),
      Date.now(),
    );
    if (!changed.length) return null;
    return {
      number: now.number,
      url: data.url ?? null,
      checks: now.checks,
      review: now.review,
      conflict: now.conflict,
      changed,
    };
  },

  /**
   * POST /api/peloton/<peloton>: `agent` checks in, says what it did, talks, replies, or leaves, as the holder of a
   * claimed task that rides the peloton (`task` picks one when it holds more). Answers with the post and the agent's
   * view. With `owner` (the signed-in board, never the bearer token: the worker decides), it's the owner's post,
   * stored as `owner`, and answers with the post and the peloton.
   */
  postPeloton(
    raw,
    { kind, text, reply_to: replyTo = null, agent, task = null, files = null } = {},
    { owner = false, person = 'owner' } = {},
  ) {
    this.writable();
    // From the board, a press names whoever pressed (BRK-303): the owner, or a person by handle. Only the owner's
    // post is the owner's: a person's huddles and outcomes follow an agent's rules.
    const name = owner ? person || 'owner' : String(agent ?? '').trim();
    const theOwner = owner && name === 'owner';
    if (owner && agent !== undefined && agent !== null && agent !== '')
      throw new InputError('from the board you post as the owner: leave agent out');
    if (!owner && !AGENT.test(name)) throw new InputError('say which agent is posting: agent is its name on the board');
    if (!owner && RESERVED.has(name.toLowerCase()))
      throw new AgentError('owner and board are the board’s names: post as your agent’s name', 403);
    const kinds = owner ? OWNER_KINDS : AGENT_KINDS;
    if (!kinds.includes(kind)) throw new InputError(`kind is one of ${kinds.join(', ')}`);
    const clean = String(text ?? '')
      .replace(/\r\n?/gu, '\n')
      .trim();
    if (!clean) throw new InputError('write the post first');
    if (clean.length > POST_MAX) throw new InputError(`a post is up to ${POST_MAX.toLocaleString('en-GB')} characters`);
    if (looksLikeSecret(clean))
      throw new InputError(
        `that post looks like it holds a token or key; say what ${owner ? 'you mean' : 'you did'} without it`,
      );
    const p = this.pelotonOf(raw);
    if (!p.open) throw new AgentError(`the chase on ${p.feature.title} has ended: its peloton takes no new posts`, 409);
    if (HUDDLE_KINDS.has(kind) && p.kind !== 'chase')
      throw new InputError('huddle, in, and outcome are only on a chase’s peloton: talk it through with ask or note');
    this.pelotonSweep();
    if (owner) {
      const huddle = this.huddleRule(p, kind, name, { owner: theOwner });
      const row = this.addPost(p.name, {
        agent: name,
        kind,
        text: clean,
        replyTo: huddle?.post ?? this.replyTarget(p.name, kind, replyTo)?.id ?? null,
        mentions: this.mentionsIn(p.name, clean),
      });
      this.huddleAfter(p, kind, row, null);
      return { post: this.postView(row), peloton: this.pelotonDetail(p.name) };
    }
    const rides = this.ridesOf(name);
    let uuid = rides.get(p.name) ?? null;
    if (task !== null && task !== undefined && task !== '') {
      const asked = this.resolve(task);
      if (
        !this.holdsTask(name, asked) ||
        !this.pelotonsOfTask(asked, this.chasing() ? this.openChases() : []).includes(p.name)
      )
        throw new AgentError(`${name} doesn’t hold ${task}, or it doesn’t ride ${p.name}`, 403);
      uuid = asked;
    }
    if (!uuid)
      throw new AgentError(
        `${name} holds no claimed task that rides ${p.name}: claim your task first, and post on its repository’s or its chase’s peloton`,
        403,
      );
    // A check-in claims the paths it names, or its --files (IDEA-55 section 1a); a bad pattern refuses the post first.
    const claims =
      kind !== 'checkin'
        ? []
        : files !== null && files !== undefined && files !== ''
          ? (Array.isArray(files) ? files : String(files).split(',')).map(cleanPattern)
          : pathsNamed(clean).flatMap((named) => {
              try {
                return [cleanPattern(named)];
              } catch {
                return [];
              }
            });
    const huddle = this.huddleRule(p, kind, name);
    const reply = this.replyTarget(p.name, kind, replyTo);
    const hour = this.sql
      .exec(
        "SELECT COUNT(*) AS n FROM peloton_posts WHERE agent = ? AND at > ? AND kind != 'leave'",
        name,
        Date.now() - 3_600_000,
      )
      .one().n;
    if (kind !== 'leave' && hour >= POSTS_AN_HOUR)
      throw new AgentError(
        `${POSTS_AN_HOUR} posts in the last hour is the most an agent makes: write it in a comment on your task instead`,
        429,
      );
    const map = this.tasks.get(uuid);
    const row = this.addPost(p.name, {
      agent: name,
      task: uuid,
      repo: repoSlugOf(map, this.defaultRepoSlug()),
      kind,
      text: clean,
      replyTo: huddle?.post ?? reply?.id ?? null,
      mentions: this.mentionsIn(p.name, clean),
    });
    this.huddleAfter(p, kind, row, uuid);
    // Every post by a task's holder is a heartbeat for its path claims.
    this.heartbeat(uuid, name);
    const paths = claims.length ? this.claimPaths(uuid, name, claims.slice(0, 50), { source: 'checkin' }) : undefined;
    return { post: this.postView(row), peloton: this.agentView(p.name, name, uuid), ...(paths ? { paths } : {}) };
  },

  /** The open huddle on `peloton`, as stored, or null. */
  openHuddle(peloton) {
    return (
      this.sql
        .exec('SELECT * FROM peloton_huddles WHERE peloton = ? AND closed IS NULL ORDER BY post DESC LIMIT 1', peloton)
        .toArray()[0] ?? null
    );
  },

  /**
   * Whether `name` may post `kind` on chase peloton `p` as far as huddles go (IDEA-36 section 4), and the open huddle
   * an `in` or `outcome` answers. One huddle at a time, an agent calls one every 30 minutes (the owner isn't held to
   * it), and an outcome is its caller's, the road captain's, or the owner's.
   */
  huddleRule(p, kind, name, { owner = false } = {}) {
    if (!HUDDLE_KINDS.has(kind)) return null;
    const open = this.openHuddle(p.name);
    if (kind === 'huddle') {
      if (open)
        throw new AgentError(
          `one huddle at a time: #${open.post} is open on ${p.name}; join it, or wait for its outcome`,
          409,
        );
      if (!owner) {
        const last = this.sql.exec('SELECT MAX(opened) AS at FROM peloton_huddles WHERE caller = ?', name).one().at;
        if (last && Date.now() - last < HUDDLE_EVERY_MS)
          throw new AgentError(
            `an agent calls one huddle every 30 minutes: ask on the peloton instead, or call it after ${new Date(last + HUDDLE_EVERY_MS).toISOString().slice(11, 16)} UTC`,
            429,
          );
      }
      return null;
    }
    if (!open)
      throw new AgentError(
        `no huddle is open on ${p.name}: there’s nothing to ${kind === 'in' ? 'join' : 'close'}`,
        409,
      );
    if (kind === 'outcome' && !owner && open.caller !== name && this.ridersOf(p.name).captain !== name)
      throw new AgentError(
        `a huddle is closed by its caller, the road captain, or the owner: post what you’d agree with as a note`,
        403,
      );
    return open;
  },

  /** A huddle post opens one, and an outcome closes the open one. */
  huddleAfter(p, kind, row, uuid) {
    if (kind === 'huddle')
      this.sql.exec(
        'INSERT INTO peloton_huddles (post, peloton, caller, task, opened, closes) VALUES (?, ?, ?, ?, ?, ?)',
        row.id,
        p.name,
        row.agent,
        uuid,
        row.at,
        row.at + HUDDLE_MS,
      );
    else if (kind === 'outcome')
      this.sql.exec(
        'UPDATE peloton_huddles SET closed = ?, outcome = ? WHERE peloton = ? AND closed IS NULL',
        row.at,
        row.id,
        p.name,
      );
  },

  /**
   * Closes the huddles whose 20 minutes are up, each with a line from the board saying it ended without an outcome,
   * and, quietly, any on a chase that's no longer on.
   */
  closeHuddles() {
    const open = this.sql.exec('SELECT * FROM peloton_huddles WHERE closed IS NULL').toArray();
    if (!open.length) return;
    const now = Date.now();
    for (const h of open) {
      const on =
        this.sql.exec('SELECT chase FROM features WHERE slug = ?', h.peloton.slice(CHASE.length)).toArray()[0]
          ?.chase === 'on';
      if (!on) {
        this.sql.exec('UPDATE peloton_huddles SET closed = ? WHERE post = ?', now, h.post);
        continue;
      }
      if (h.closes > now) continue;
      const row = this.addPost(h.peloton, {
        agent: 'board',
        kind: 'outcome',
        text: `The huddle #${h.post} ended without an outcome after 20 minutes.`,
        replyTo: h.post,
      });
      this.sql.exec('UPDATE peloton_huddles SET closed = ?, outcome = ? WHERE post = ?', row.at, row.id, h.post);
    }
  },

  /** The open huddle on peloton `p` for the board and agents: its question, caller, times, and who's in; or null. */
  huddleOf(p) {
    if (p.kind !== 'chase' || !p.open) return null;
    const h = this.openHuddle(p.name);
    if (!h) return null;
    const question = this.sql.exec('SELECT text FROM peloton_posts WHERE id = ?', h.post).toArray()[0]?.text ?? '';
    const map = h.task ? this.tasks.get(h.task) : null;
    return {
      id: h.post,
      question,
      caller: h.caller,
      task: h.task ? (map?.wid ?? h.task.slice(0, 8)) : null,
      opened: iso(h.opened),
      closes: iso(h.closes),
      in: this.sql
        .exec(
          "SELECT agent FROM peloton_posts WHERE peloton = ? AND kind = 'in' AND reply_to = ? GROUP BY agent ORDER BY MIN(id)",
          p.name,
          h.post,
        )
        .toArray()
        .map((r) => r.agent),
    };
  },

  planView(row) {
    const map = row.task ? this.tasks.get(row.task) : null;
    return {
      version: row.version,
      text: row.text,
      agent: row.agent,
      task: row.task ? (map?.wid ?? row.task.slice(0, 8)) : null,
      at: iso(row.at),
      why: row.why,
    };
  },

  /** The chase's plan as it stands on peloton `p` (IDEA-36 section 5), or null: a repository's has none. */
  planOf(p) {
    if (p.kind !== 'chase') return null;
    const row = this.sql
      .exec('SELECT * FROM peloton_plans WHERE peloton = ? ORDER BY version DESC LIMIT 1', p.name)
      .toArray()[0];
    return row ? this.planView(row) : null;
  },

  /** GET /api/peloton/<peloton>/plan: the plan and every revision of it, newest first. */
  planRevisions(raw) {
    const p = this.pelotonOf(raw);
    return {
      peloton: p.name,
      plan: this.planOf(p),
      revisions: this.sql
        .exec('SELECT * FROM peloton_plans WHERE peloton = ? ORDER BY version DESC', p.name)
        .toArray()
        .map((row) => this.planView(row)),
    };
  },

  /**
   * PUT /api/peloton/<peloton>/plan: revises the chase's plan (IDEA-36 section 5). The owner may at any time (the
   * signed-in board, `owner`); while a road captain runs on the chase, only it; with none, any agent riding the chase.
   * Every revision is kept, and the board posts its line as a `plan` post.
   */
  revisePlan(raw, { text, why, agent } = {}, { owner = false, person = 'owner' } = {}) {
    this.writable();
    // A maintainer revises it from the board under their own handle (BRK-303); the owner as the owner.
    const name = owner ? person || 'owner' : String(agent ?? '').trim();
    if (owner && agent !== undefined && agent !== null && agent !== '')
      throw new InputError('from the board you revise the plan as the owner: leave agent out');
    if (!owner && !AGENT.test(name)) throw new InputError('say which agent revises it: agent is its name on the board');
    if (!owner && RESERVED.has(name.toLowerCase()))
      throw new AgentError('owner and board are the board’s names: revise it as your agent’s name', 403);
    const p = this.pelotonOf(raw);
    if (p.kind !== 'chase') throw new InputError('only a chase’s peloton has a plan: this is a repository’s');
    if (!p.open) throw new AgentError(`the chase on ${p.feature.title} has ended: its plan stays as it is`, 409);
    const clean = String(text ?? '')
      .replace(/\r\n?/gu, '\n')
      .trim();
    if (!clean) throw new InputError('write the plan first');
    if (clean.length > PLAN_MAX)
      throw new InputError(`the plan is up to ${PLAN_MAX.toLocaleString('en-GB')} characters`);
    const line = String(why ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!line) throw new InputError('say in a line what changed: why');
    if (line.length > WHY_MAX) throw new InputError(`say what changed in up to ${WHY_MAX} characters`);
    if (looksLikeSecret(clean) || looksLikeSecret(line))
      throw new InputError('that plan looks like it holds a token or key; write it without it');
    this.pelotonSweep();
    let uuid = null;
    if (!owner) {
      uuid = this.ridesOf(name).get(p.name) ?? null;
      if (!uuid)
        throw new AgentError(`${name} holds no claimed task in this chase: only its riders revise its plan`, 403);
      const { captain } = this.ridersOf(p.name);
      if (captain && captain !== name)
        throw new AgentError(
          `${captain} keeps the plan while it runs as the chase’s road captain: post a propose with your change instead`,
          403,
        );
      const hour = this.sql
        .exec(
          "SELECT COUNT(*) AS n FROM peloton_posts WHERE agent = ? AND at > ? AND kind != 'leave'",
          name,
          Date.now() - 3_600_000,
        )
        .one().n;
      if (hour >= POSTS_AN_HOUR)
        throw new AgentError(
          `${POSTS_AN_HOUR} posts in the last hour is the most an agent makes: revise it later`,
          429,
        );
    }
    const version =
      (this.sql.exec('SELECT MAX(version) AS v FROM peloton_plans WHERE peloton = ?', p.name).one().v ?? 0) + 1;
    const now = Date.now();
    const row = this.sql
      .exec(
        'INSERT INTO peloton_plans (peloton, version, text, agent, task, at, why) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
        p.name,
        version,
        clean,
        name,
        uuid,
        now,
        line,
      )
      .one();
    const map = uuid ? this.tasks.get(uuid) : null;
    const post = this.addPost(p.name, {
      agent: name,
      task: uuid,
      repo: map ? repoSlugOf(map, this.defaultRepoSlug()) : null,
      kind: 'plan',
      text: `Plan v${version}: ${line}`,
    });
    return {
      plan: this.planView(row),
      post: this.postView(post),
      peloton: owner ? this.pelotonDetail(p.name) : this.agentView(p.name, name, uuid),
    };
  },

  /** The plan of the open chase task `uuid` is in, if it has one: what an agent the chase starts reads first. */
  planForTask(uuid) {
    if (!this.chasing()) return null;
    for (const { row, tasks } of this.openChases()) {
      if (!tasks.has(uuid)) continue;
      const plan = this.planOf({ kind: 'chase', name: `${CHASE}${row.slug}` });
      if (plan) return { peloton: `${CHASE}${row.slug}`, ...plan };
    }
    return null;
  },

  /** The post a `reply` answers on `peloton`, or null for any other kind; a 400 or 404 when there's none. */
  replyTarget(peloton, kind, replyTo) {
    if (kind !== 'reply') return null;
    if (replyTo === null || replyTo === undefined || replyTo === '')
      throw new InputError('a reply says which post it answers: reply_to');
    const reply = this.sql
      .exec('SELECT id FROM peloton_posts WHERE peloton = ? AND id = ?', peloton, Number(replyTo))
      .toArray()[0];
    if (!reply) throw new AgentError(`there’s no post ${replyTo} on ${peloton} to reply to: it may have aged out`, 404);
    return reply;
  },

  /** A chase's peloton opens and closes with it: a line from the board says so. */
  pelotonLine(slug, kind, text) {
    this.addPost(`${CHASE}${slug}`, { agent: 'board', kind, text });
  },

  /** Posts are kept a day; a chase's while it's on and for a day after it closes. Seen marks go with them. */
  prunePeloton() {
    this.loadTasks();
    this.pelotonSweep();
    const now = Date.now();
    this.sql.exec("DELETE FROM peloton_posts WHERE peloton NOT LIKE 'chase:%' AND at < ?", now - DAY);
    const features = new Map(
      this.sql
        .exec('SELECT slug, chase, chase_ended FROM features')
        .toArray()
        .map((r) => [r.slug, r]),
    );
    for (const { peloton } of this.sql
      .exec("SELECT DISTINCT peloton FROM peloton_posts WHERE peloton LIKE 'chase:%'")
      .toArray()) {
      const row = features.get(peloton.slice(CHASE.length));
      if (row?.chase === 'on') continue;
      if (row?.chase_ended && now - row.chase_ended < DAY) continue;
      // Closed over a day ago, or a feature that's gone: what's past a day goes.
      const before = row?.chase_ended ? now : now - DAY;
      this.sql.exec('DELETE FROM peloton_posts WHERE peloton = ? AND at < ?', peloton, before);
    }
    this.sql.exec('DELETE FROM peloton_seen WHERE at < ?', now - 2 * DAY);
    this.sql.exec('DELETE FROM peloton_pr_seen WHERE at < ?', now - 2 * DAY);
    // The plan and the huddles go with the chase's posts: once it's been closed a day, or its feature is gone.
    for (const { peloton } of this.sql
      .exec('SELECT peloton FROM peloton_plans UNION SELECT peloton FROM peloton_huddles')
      .toArray()) {
      const row = features.get(peloton.slice(CHASE.length));
      if (row?.chase === 'on') continue;
      if (row?.chase_ended && now - row.chase_ended < DAY) continue;
      this.sql.exec('DELETE FROM peloton_plans WHERE peloton = ?', peloton);
      this.sql.exec('DELETE FROM peloton_huddles WHERE peloton = ?', peloton);
    }
  },
};
