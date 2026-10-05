/**
 * TaskStore's features (docs/specs/IDEA-28-features-and-chase.md, section 1 and 4): a small record
 * (slug, title, brief, release, state) that tasks join by carrying its slug as a tag. Progress is
 * computed from the tasks, never typed. Tags on open tasks that aren't features yet are suggested,
 * and nothing is made until someone presses for it. Tasks gain no field, so Taskwarrior carries
 * membership as it is. Adding a feature is anyone's (agents shaping an idea add theirs); aiming it
 * at a release, changing it, and deleting it are the owner's.
 */
import { AgentError } from './store-agents.js';
import { featureIdea } from './feature-prompt.js';
import { InputError, diffOps, rank, withChanges } from './model.js';

/** A feature's slug is a tag: lowercase letters, digits, hyphens, and underscores, starting with a letter. */
const SLUG = /^[a-z][a-z0-9_-]{0,39}$/u;
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
/** A release tag on a task, like `v1_2-0` (Taskwarrior tags can't hold dots). */
const RELEASE_TAG = /^v(\d{1,4})_(\d{1,4})-(\d{1,4})$/u;
/** Tags the board and its agents use for something else: never a feature, never suggested. */
const BOARD_TAGS = new Set(['agent', 'owner', 'decide', 'idea', 'general', 'routine', 'security']);
const STATES = ['open', 'shipped'];
/** The horizons the owner may give an idea's tasks: `auto` lets its agent choose. */
const IDEA_HORIZONS = ['auto', 'now', 'next', 'later'];
const MAX_TITLE = 200;
const MAX_BRIEF = 4000;

/** `v1_2-0` → `1.2.0`, or null for any other tag. */
export function releaseOfTag(tag) {
  const m = RELEASE_TAG.exec(tag);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** Why a tag can't be a feature, or null if it can. */
export function featureTagProblem(tag) {
  if (!SLUG.test(tag))
    return 'the slug is a tag: lowercase letters, digits, hyphens, and underscores, starting with a letter (up to 40)';
  if (BOARD_TAGS.has(tag) || tag.startsWith('horizon-'))
    return `"${tag}" is one of the board’s own tags, so it can’t be a feature`;
  if (releaseOfTag(tag)) return `"${tag}" is a release tag: give a feature its release instead`;
  return null;
}

/** Releases in version order, then none. */
export function byRelease(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** `self-update` → `Self update`. */
const titleOf = (slug) => {
  const words = slug.replace(/[-_]+/gu, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The release most of these tasks' release tags name (the lower one on a tie), or null. */
function sharedRelease(tasks) {
  const counts = new Map();
  for (const t of tasks)
    for (const tag of t.tags) {
      const release = releaseOfTag(tag);
      if (release) counts.set(release, (counts.get(release) ?? 0) + 1);
    }
  return [...counts].sort((a, b) => b[1] - a[1] || byRelease(a[0], b[0]))[0]?.[0] ?? null;
}

const inReview = (t) => Boolean(t.github?.some((p) => p.closes && p.state === 'open'));
const label = (t) => t.wid ?? t.short;

/**
 * Where a task stands in its feature, and why in words when it can't move: `done`, `in-review`,
 * `running` (someone has it), `waiting` (on another task or a date), `needs-you` (a decision or a
 * step for the owner), or `ready`.
 */
function standing(t, names) {
  if (t.status === 'completed') return { state: 'done', why: null };
  if (inReview(t)) return { state: 'in-review', why: 'its pull request is open: merging is yours' };
  if (t.claim) return { state: 'running', why: `${t.claim} has it` };
  if (t.blocked) return { state: 'waiting', why: `it waits for ${t.blockedBy.map((u) => names.get(u)).join(', ')}` };
  if (t.waiting) return { state: 'waiting', why: `it waits until ${t.wait?.slice(0, 10)}` };
  if (t.tags.includes('decide') || (t.decision && !t.decisionAnswers))
    return { state: 'needs-you', why: 'it waits on your decision' };
  if (t.tags.includes('owner')) return { state: 'needs-you', why: 'it’s a step for you (+owner)' };
  return { state: 'ready', why: null };
}

const COUNT_OF = {
  done: 'done',
  'in-review': 'inReview',
  running: 'running',
  waiting: 'waiting',
  'needs-you': 'needsYou',
  ready: 'ready',
};

/** The tasks in dependency order: a task after the ones in the feature it waits for, the rest by rank. */
function dependencyOrder(tasks) {
  const inside = new Set(tasks.map((t) => t.uuid));
  const waitsFor = new Map(tasks.map((t) => [t.uuid, t.depends.filter((d) => inside.has(d))]));
  const placed = new Set();
  const out = [];
  let left = [...tasks].sort(rank);
  while (left.length) {
    // A cycle can't hold the list up: when nothing is free, the first by rank goes next.
    const next = left.find((t) => waitsFor.get(t.uuid).every((d) => placed.has(d))) ?? left[0];
    placed.add(next.uuid);
    out.push(next);
    left = left.filter((t) => t !== next);
  }
  return out;
}

/**
 * The group task `uuid` is in, as the Dependencies view draws it: the open tasks that wait for another
 * or hold one up, with the tasks right next to them, joined by `depends`. Null when it's in none.
 * @param {any[]} views every task that isn't deleted
 * @param {string} uuid
 * @returns {string[] | null}
 */
export function dependencyGroup(views, uuid) {
  const all = new Map(views.map((t) => [t.uuid, t]));
  const nodes = new Set();
  for (const t of views) if (t.status === 'pending' && (t.depends.length || t.blocking.length)) nodes.add(t.uuid);
  for (const u of [...nodes])
    for (const d of [...all.get(u).depends, ...all.get(u).blocking]) if (all.has(d)) nodes.add(d);
  if (!nodes.has(uuid)) return null;
  const neighbours = new Map([...nodes].map((u) => [u, []]));
  for (const u of nodes)
    for (const d of all.get(u).depends)
      if (nodes.has(d)) {
        neighbours.get(u).push(d);
        neighbours.get(d).push(u);
      }
  const seen = new Set([uuid]);
  const stack = [uuid];
  while (stack.length)
    for (const v of neighbours.get(stack.pop()))
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
  return [...seen];
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const featuresMethods = {
  initFeatures() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS features (
        slug TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT, release TEXT, state TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL, created INTEGER NOT NULL, edited_by TEXT NOT NULL, edited_at INTEGER NOT NULL
      );
    `);
  },

  featureRows() {
    return this.sql.exec('SELECT * FROM features').toArray();
  },

  featureRow(slug) {
    const row = this.sql.exec('SELECT * FROM features WHERE slug = ?', String(slug ?? '').toLowerCase()).toArray()[0];
    if (!row) throw new AgentError(`there’s no feature "${slug}"`, 404);
    return row;
  },

  ownerOnlyFeatures(by, what) {
    if (by !== undefined && by !== null && by !== '' && by !== 'owner')
      throw new AgentError(`only the owner can ${what}`, 403);
  },

  /** The checked fields of `input`, over `base` for the ones it doesn't give. */
  featureFields(input, base) {
    const out = { ...base };
    if ('title' in input) {
      const title = String(input.title ?? '').trim();
      if (title.length > MAX_TITLE) throw new InputError(`the title is too long (up to ${MAX_TITLE} characters)`);
      if (title) out.title = title;
    }
    if ('brief' in input) {
      const brief = String(input.brief ?? '').trim();
      if (brief.length > MAX_BRIEF) throw new InputError(`the brief is too long (up to ${MAX_BRIEF} characters)`);
      out.brief = brief || null;
    }
    if ('release' in input) {
      const release = String(input.release ?? '').trim();
      if (release && !RELEASE.test(release))
        throw new InputError(`the release is a version like 1.2.0, or empty for unplanned (not "${release}")`);
      out.release = release || null;
    }
    if ('state' in input) {
      if (!STATES.includes(input.state)) throw new InputError(`the state is ${STATES.join(' or ')}`);
      out.state = input.state;
    }
    return out;
  },

  async createFeature(input) {
    const slug = String(input.slug ?? '').trim();
    const problem = featureTagProblem(slug);
    if (problem) throw new InputError(problem);
    const owner = !input.by || input.by === 'owner';
    if (!owner && 'release' in input && input.release)
      throw new AgentError('only the owner aims a feature at a release; add it without one', 403);
    if (!owner && 'state' in input) throw new AgentError('only the owner marks a feature shipped', 403);
    const by = owner ? 'owner' : String(input.by).trim();
    if (!/^[\w.@:/-]{1,64}$/u.test(by))
      throw new InputError('say who is adding it: a name of letters, digits, and . _ - @ : / (up to 64)');
    if (this.sql.exec('SELECT 1 FROM features WHERE slug = ?', slug).toArray().length)
      throw new AgentError(`the feature "${slug}" already exists`);
    const f = this.featureFields(input, { title: titleOf(slug), brief: null, release: null, state: 'open' });
    const picked = this.featurePick(input, owner);
    const shape = this.featureShape(input, owner, picked, f);
    // Made from a suggestion or a group: the release its tasks' tags share, unless the owner said otherwise.
    if (owner && !('release' in input))
      f.release = sharedRelease(picked ? picked.join : this.views((t) => t.tags.includes(slug)));
    // The idea first: when the board can't make it, there's no feature without the agent the owner asked for.
    let idea = null;
    if (shape) {
      const written = featureIdea({ slug, ...f });
      const res = await this.create([
        {
          description: written.title,
          project: 'ideas',
          horizon: 'now',
          tags: ['agent', 'idea', `horizon-${shape.horizon}`, slug],
          autostart: 'yes',
          brief: written.brief,
          ...(shape.repo ? { repo: shape.repo } : {}),
          by: 'owner',
        },
      ]);
      if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make the idea', res.status);
      idea = res.body.tasks[0];
    }
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO features (slug, title, brief, release, state, created_by, created, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      slug,
      f.title,
      f.brief,
      f.release,
      f.state,
      by,
      now,
      by,
      now,
    );
    if (picked) {
      const at = new Date();
      this.commit(
        picked.join
          .filter((t) => !t.tags.includes(slug))
          .flatMap((t) => {
            const before = this.tasks.get(t.uuid);
            return diffOps(t.uuid, before, withChanges(before, { addTags: [slug] }, at), at.toISOString());
          }),
      );
      return {
        feature: this.featureDetail(slug),
        joined: picked.join.map(label),
        kept: picked.kept.map((x) => ({ wid: label(x.task), feature: x.feature })),
      };
    }
    if (idea) return { feature: this.featureDetail(slug), idea: this.detail(idea.uuid) };
    return { feature: this.featureDetail(slug) };
  },

  /**
   * Shape a new feature as an idea (WEB-42): `shape` asks for an IDEA that carries the feature's tag, with its brief
   * as the owner's words and what the feature is under them, which starts its agent by itself. `shape` is true or
   * `{ repo, horizon }`: the idea's repository (needed when the board runs more than one) and the horizon for the
   * tasks it makes (`auto` by default). The owner's, with a brief, and not with picked tasks. Null when not asked.
   */
  featureShape(input, owner, picked, fields) {
    if (!input.shape) return null;
    if (!owner) throw new AgentError('only the owner shapes a feature with an agent', 403);
    if (picked) throw new InputError('a feature made from tasks has its tasks already: shape one without picking any');
    if (!fields.brief) throw new InputError('write the brief first: it’s what the agent shapes the feature from');
    const options = typeof input.shape === 'object' ? input.shape : {};
    const horizon = String(options.horizon ?? 'auto');
    if (!IDEA_HORIZONS.includes(horizon)) throw new InputError(`the horizon is ${IDEA_HORIZONS.join(', ')}`);
    const repo = options.repo ? String(options.repo) : null;
    if (!repo && this.repos().length > 1)
      throw new InputError(
        `say which repository the idea is for: ${this.repos()
          .map((r) => r.slug)
          .join(', ')}`,
      );
    this.checkRepoSlug(repo);
    return { repo, horizon };
  },

  /**
   * The tasks a new feature is made from (WEB-15): `tasks`, some of a group, or `from`, the whole group a
   * task is in on the Dependencies view. Its open tasks join, except those already in another feature, which
   * stay there (one feature per task). Null when neither is given. Checked before anything is written.
   */
  featurePick(input, owner) {
    if (!('tasks' in input) && !('from' in input)) return null;
    if (!owner) throw new AgentError('only the owner makes a feature from tasks; tag your own with --tag', 403);
    this.writable();
    const views = this.views((t) => t.status !== 'deleted');
    let uuids;
    if ('from' in input) {
      const from = this.resolve(String(input.from ?? ''));
      uuids = dependencyGroup(views, from);
      if (!uuids) {
        const t = views.find((x) => x.uuid === from);
        throw new InputError(`${label(t)} waits for nothing and nothing waits for it, so it isn't in a group`);
      }
    } else {
      const refs = Array.isArray(input.tasks) ? input.tasks : [input.tasks];
      if (!refs.filter(Boolean).length) throw new InputError('pick at least one task for the feature');
      uuids = refs.filter(Boolean).map((r) => this.resolve(String(r)));
    }
    const slugs = new Set(this.featureRows().map((r) => r.slug));
    const order = new Map(dependencyOrder(views.filter((t) => uuids.includes(t.uuid))).map((t, i) => [t.uuid, i]));
    const open = views.filter((t) => order.has(t.uuid) && t.status === 'pending');
    open.sort((a, b) => order.get(a.uuid) - order.get(b.uuid));
    const kept = [];
    const join = [];
    for (const t of open) {
      const other = t.tags.filter((tag) => slugs.has(tag)).sort()[0];
      if (other) kept.push({ task: t, feature: other });
      else join.push(t);
    }
    if (!join.length)
      throw new InputError(
        'none of these tasks can join: they’re done or already in another feature, and a task is in one feature',
      );
    return { join, kept };
  },

  modifyFeature(slug, input) {
    this.ownerOnlyFeatures(input.by, 'change a feature');
    const row = this.featureRow(slug);
    const f = this.featureFields(input, row);
    this.sql.exec(
      'UPDATE features SET title = ?, brief = ?, release = ?, state = ?, edited_by = ?, edited_at = ? WHERE slug = ?',
      f.title,
      f.brief,
      f.release,
      f.state,
      'owner',
      Date.now(),
      row.slug,
    );
    return this.featureDetail(row.slug);
  },

  deleteFeature(slug, input) {
    this.ownerOnlyFeatures(input.by, 'delete a feature');
    const row = this.featureRow(slug);
    this.sql.exec('DELETE FROM features WHERE slug = ?', row.slug);
    return { deleted: row.slug };
  },

  /**
   * Every feature's tasks, worked out once: a task is in the feature whose slug it carries as a tag,
   * the first alphabetically when it carries more than one (the rest are a warning).
   */
  featureMembership() {
    const rows = this.featureRows();
    const slugs = new Set(rows.map((r) => r.slug));
    const views = this.views((t) => t.status !== 'deleted');
    const names = new Map(views.map((t) => [t.uuid, label(t)]));
    const members = new Map(rows.map((r) => [r.slug, []]));
    const conflicts = [];
    const loose = [];
    for (const t of views) {
      const mine = t.tags.filter((tag) => slugs.has(tag)).sort();
      if (!mine.length) {
        loose.push(t);
        continue;
      }
      members.get(mine[0]).push({ task: t, alsoIn: mine.slice(1) });
      if (mine.length > 1) conflicts.push({ wid: label(t), features: mine });
    }
    return { rows, views, names, members, conflicts, loose };
  },

  /** A feature with its progress; `full` adds its tasks in dependency order. */
  featureView(row, membership, { full = false } = {}) {
    const { names, members, conflicts } = membership;
    const progress = { total: 0, done: 0, running: 0, ready: 0, waiting: 0, needsYou: 0, inReview: 0, shipped: 0 };
    const tasks = [];
    for (const { task: t, alsoIn } of members.get(row.slug) ?? []) {
      const { state, why } = standing(t, names);
      progress.total += 1;
      progress[COUNT_OF[state]] += 1;
      if (state === 'done' && t.shipped) progress.shipped += 1;
      tasks.push({ t, alsoIn, state, why });
    }
    const done = progress.total > 0 && progress.done === progress.total;
    const brief = (x) => ({
      uuid: x.t.uuid,
      wid: x.t.wid,
      description: x.t.description,
      repo: x.t.repo,
      project: x.t.project,
      status: x.t.status,
      state: x.state,
      why: x.why,
      claim: x.t.claim,
      alsoIn: x.alsoIn,
    });
    const ordered = dependencyOrder(tasks.map((x) => x.t)).map((t) => tasks.find((x) => x.t === t));
    return {
      slug: row.slug,
      title: row.title,
      brief: row.brief ?? null,
      release: row.release ?? null,
      state: row.state,
      createdBy: row.created_by,
      created: new Date(row.created).toISOString(),
      editedBy: row.edited_by,
      editedAt: new Date(row.edited_at).toISOString(),
      progress,
      done,
      // The repositories its tasks are in, so the roadmap can follow the repository switcher (WEB-78).
      repos: [...new Set(tasks.map((x) => x.t.repo))].sort(),
      // Shipped when the owner says so, or when every task is done and live.
      shipped: row.state === 'shipped' || (done && progress.shipped === progress.total),
      needsYou: ordered.filter((x) => x.state === 'needs-you').map(brief),
      // The chase's record (IDEA-28 section 3); the feature's own page adds who starts next and why the rest waits.
      chase: this.chaseState(row),
      conflicts: conflicts.filter((c) => c.features.includes(row.slug)),
      ...(full ? { tasks: ordered.map(brief) } : {}),
    };
  },

  featureDetail(slug) {
    const row = this.featureRow(slug);
    return this.featureView(row, this.featureMembership(), { full: true });
  },

  /**
   * The roadmap's data: features in release order then unplanned, the tags that could be features,
   * and the tasks with a release tag and no feature, under their release.
   */
  listFeatures() {
    const membership = this.featureMembership();
    const features = membership.rows
      .sort((a, b) => byRelease(a.release, b.release) || a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug))
      .map((row) => this.featureView(row, membership));
    const slugs = new Set(membership.rows.map((r) => r.slug));
    const tagged = new Map();
    for (const t of membership.views)
      for (const tag of t.tags) {
        if (slugs.has(tag) || featureTagProblem(tag)) continue;
        tagged.set(tag, [...(tagged.get(tag) ?? []), t]);
      }
    const releases = new Map();
    for (const t of membership.loose) {
      const release = sharedRelease([t]);
      if (release)
        releases.set(release, [
          ...(releases.get(release) ?? []),
          { uuid: t.uuid, wid: t.wid, description: t.description, repo: t.repo, status: t.status },
        ]);
    }
    const suggestions = [...tagged]
      .map(([slug, tasks]) => ({
        slug,
        tasks: tasks.length,
        open: tasks.filter((t) => t.status === 'pending').length,
        release: sharedRelease(tasks),
        repos: [...new Set(tasks.map((t) => t.repo))].sort(),
      }))
      .filter((s) => s.open > 0)
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const releaseTasks = [...releases]
      .sort((a, b) => byRelease(a[0], b[0]))
      .map(([release, tasks]) => ({ release, tasks }));
    const first = (into) => {
      const pull = this.releasePulls(membership, into)[0];
      return pull ? { release: pull.release, tasks: pull.moves.length } : null;
    };
    return { features, suggestions, releaseTasks, nextPull: first('now'), stagePull: first('next') };
  },

  /**
   * What pulling each release into `into` would move (BRK-126; next is BRK-209), for the releases that have
   * any, in version order: the release's open tasks (its features' and its loose ones') and every open task
   * they wait for, whatever its release or feature, that isn't in `into` or a nearer horizon yet. A task's
   * release is its feature's, else its tag's.
   */
  releasePulls(given, into = 'now') {
    const there = new Set(into === 'next' ? ['now', 'next'] : ['now']);
    const membership = given ?? this.featureMembership();
    const open = (t) => t.status === 'pending';
    const byUuid = new Map(membership.views.map((t) => [t.uuid, t]));
    const aimed = new Map();
    const aim = (release, t) => {
      if (release && open(t)) aimed.set(release, [...(aimed.get(release) ?? []), t]);
    };
    for (const row of membership.rows) for (const { task } of membership.members.get(row.slug)) aim(row.release, task);
    for (const t of membership.loose) aim(sharedRelease([t]), t);
    const pulls = [];
    for (const [release, tasks] of [...aimed].sort((a, b) => byRelease(a[0], b[0]))) {
      const own = new Set(tasks.map((t) => t.uuid));
      const seen = new Set(own);
      const stack = [...own];
      while (stack.length)
        for (const d of byUuid.get(stack.pop())?.depends ?? [])
          if (!seen.has(d) && byUuid.has(d) && open(byUuid.get(d))) {
            seen.add(d);
            stack.push(d);
          }
      const moves = dependencyOrder([...seen].map((u) => byUuid.get(u)).filter((t) => !there.has(t.horizon)));
      if (moves.length) pulls.push({ release, moves: moves.map((t) => ({ task: t, chain: !own.has(t.uuid) })) });
    }
    return pulls;
  },

  /**
   * Pulls `release` into now (BRK-126), or stages it in next (BRK-209) when `input.into` is `next`: the
   * owner's. Only the first release with work outside that horizon can be pulled, so the roadmap fills now
   * and next in version order. `dryRun` only says what would move.
   */
  pullRelease(release, input) {
    const into = input.into ?? 'now';
    if (into !== 'now' && into !== 'next') throw new InputError(`a release is pulled into now or next (not "${into}")`);
    this.ownerOnlyFeatures(input.by, `pull a release into ${into}`);
    const version = String(release ?? '').trim();
    if (!RELEASE.test(version)) throw new InputError(`the release is a version like 1.2.0 (not "${version}")`);
    this.writable();
    const pulls = this.releasePulls(undefined, into);
    const pull = pulls.find((p) => p.release === version);
    if (!pull)
      throw new InputError(
        `${version}’s open tasks, and what they wait for, are already in ${into === 'next' ? 'now or next' : 'now'}`,
      );
    if (pulls[0] !== pull)
      throw new AgentError(
        `pull ${pulls[0].release} into ${into} first: the next release goes in before a later one`,
        409,
      );
    const tasks = pull.moves.map(({ task, chain }) => ({
      uuid: task.uuid,
      wid: task.wid ?? null,
      description: task.description,
      horizon: task.horizon ?? null,
      chain,
    }));
    if (!input.dryRun) {
      const now = new Date();
      const ops = [];
      for (const { task } of pull.moves) {
        const before = this.tasks.get(task.uuid);
        ops.push(...diffOps(task.uuid, before, withChanges(before, { horizon: into }, now), now.toISOString()));
      }
      this.commit(ops);
    }
    return { release: version, into, tasks, dryRun: Boolean(input.dryRun) };
  },
};
