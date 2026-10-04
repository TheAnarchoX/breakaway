/**
 * TaskStore's peloton (docs/specs/IDEA-32-peloton.md, sections 1, 2, 3, and 6): where running agents check in
 * with each other. A peloton is a channel: every repository has one (named by its slug), and a chase opens one
 * of its own (`chase:<feature>`) that closes when the chase stops or ends. Only the holder of a claimed task that
 * rides a peloton can post on it. Who rides is worked out, never stored: the agents that checked in and still
 * hold their claim. Posts are short notes, never tasks and never synced, kept a day.
 */
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';
import { looksLikeSecret } from './ping.js';
import { repoSlugOf } from './repos.js';

const AGENT = /^[\w.@:/-]{1,64}$/u;
const CHASE = 'chase:';
const DAY = 86_400_000;
export const POST_MAX = 1000;
export const POSTS_AN_HOUR = 30; // per agent
export const POSTS_KEPT = 200; // per peloton
/** How many posts a read hands back at once: the newest of what's kept. */
const POSTS_SHOWN = 50;
const AGENT_KINDS = ['checkin', 'step', 'reply', 'leave'];

const iso = (ms) => new Date(Number(ms)).toISOString();

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
    `);
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
    };
  },

  addPost(peloton, { agent, task = null, repo = null, kind, text, replyTo = null }) {
    const row = this.sql
      .exec(
        'INSERT INTO peloton_posts (peloton, at, agent, task, repo, kind, text, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        peloton,
        Date.now(),
        agent,
        task,
        repo,
        kind,
        text,
        replyTo,
      )
      .one();
    // 200 kept per peloton: the oldest go first.
    this.sql.exec(
      'DELETE FROM peloton_posts WHERE peloton = ? AND id <= (SELECT id FROM peloton_posts WHERE peloton = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
      peloton,
      peloton,
      POSTS_KEPT,
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
    const rows = this.checkedIn();
    if (!rows.length) return;
    let chases = null;
    const features = new Map();
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
      this.addPost(row.peloton, {
        agent: row.agent,
        task: row.task,
        repo: row.repo,
        kind: 'leave',
        text: `Left: ${why}.`,
      });
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
      return { agent: row.agent, task: view.task, repo: row.repo, since: view.at, last: this.postView(last) };
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
      roster: this.pelotonRoster(p.name, p.open),
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
    const mark = this.seenMark(p.name, agent);
    const posts = this.pelotonPosts(p.name, POSTS_SHOWN).map((post) => ({
      ...post,
      unseen: post.id > mark && post.agent !== agent,
    }));
    const unseen = this.unseenRows(p.name, agent).length;
    this.markSeen(p.name, agent, posts.at(-1)?.id ?? 0);
    const map = this.tasks.get(uuid);
    return {
      peloton: p.name,
      kind: p.kind,
      ...(p.feature ? { feature: p.feature.slug, title: p.feature.title } : {}),
      open: p.open,
      task: map?.wid ?? uuid.slice(0, 8),
      roster: this.pelotonRoster(p.name, p.open),
      posts,
      unseen,
    };
  },

  /**
   * The posts in `agent`'s pelotons it hasn't seen, for its session hooks, each once: replies to its own posts first,
   * then the rest in order, and every one is marked seen. `replies`: the wait hook's ask, which takes them only when
   * one of them is a reply to the agent (so a busy peloton doesn't wake an idle agent).
   */
  takePeloton(agent, { replies = false } = {}) {
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) return [];
    const rides = this.ridesOf(name);
    if (!rides.size) return [];
    const mine = new Set(
      this.sql
        .exec("SELECT id FROM peloton_posts WHERE agent = ? AND kind != 'leave'", name)
        .toArray()
        .map((r) => r.id),
    );
    const rows = [];
    for (const peloton of rides.keys()) rows.push(...this.unseenRows(peloton, name));
    const toYou = (row) => row.kind === 'reply' && mine.has(row.reply_to);
    if (!rows.length || (replies && !rows.some(toYou))) return [];
    for (const peloton of rides.keys()) {
      const last = rows.filter((r) => r.peloton === peloton).at(-1);
      if (last) this.markSeen(peloton, name, last.id);
    }
    return rows
      .sort((a, b) => Number(toYou(b)) - Number(toYou(a)) || a.id - b.id)
      .slice(0, POSTS_SHOWN)
      .map((row) => ({ ...this.postView(row), toYou: toYou(row) }));
  },

  /**
   * POST /api/peloton/<peloton>: `agent` checks in, says what it did, replies, or leaves, as the holder of a claimed
   * task that rides the peloton (`task` picks one when it holds more). Answers with the post and the agent's view.
   */
  postPeloton(raw, { kind, text, reply_to: replyTo = null, agent, task = null } = {}) {
    this.writable();
    const name = String(agent ?? '').trim();
    if (!AGENT.test(name)) throw new InputError('say which agent is posting: agent is its name on the board');
    if (!AGENT_KINDS.includes(kind)) throw new InputError(`kind is one of ${AGENT_KINDS.join(', ')}`);
    const clean = String(text ?? '')
      .replace(/\r\n?/gu, '\n')
      .trim();
    if (!clean) throw new InputError('write the post first');
    if (clean.length > POST_MAX) throw new InputError(`a post is up to ${POST_MAX.toLocaleString('en-GB')} characters`);
    if (looksLikeSecret(clean))
      throw new InputError('that post looks like it holds a token or key; say what you did without it');
    const p = this.pelotonOf(raw);
    if (!p.open) throw new AgentError(`the chase on ${p.feature.title} has ended: its peloton takes no new posts`, 409);
    this.pelotonSweep();
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
    let reply = null;
    if (kind === 'reply') {
      if (replyTo === null || replyTo === undefined || replyTo === '')
        throw new InputError('a reply says which post it answers: reply_to');
      reply = this.sql
        .exec('SELECT id FROM peloton_posts WHERE peloton = ? AND id = ?', p.name, Number(replyTo))
        .toArray()[0];
      if (!reply)
        throw new AgentError(`there’s no post ${replyTo} on ${p.name} to reply to: it may have aged out`, 404);
    }
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
      replyTo: reply?.id ?? null,
    });
    return { post: this.postView(row), peloton: this.agentView(p.name, name, uuid) };
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
  },
};
