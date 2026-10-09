/**
 * TaskStore's record of agents' planning (BRK-274): every change an agent makes to the plan that isn't its own work
 * (a feature's release, title, or brief; a release pulled into now or next; another task's description, done when,
 * area, horizon, priority, tags, or dependencies) is kept here with the agent's name and the values before and after.
 * Activity and the feature's page show each one, and the owner undoes one with a single press. Undoing puts back what
 * the agent changed, and refuses when someone has changed the same field since, so it never overwrites newer work.
 */
import { AgentError } from './store-agents.js';
import { diffOps, withChanges } from './model.js';

/** The task fields a planning change records, as the store's changes name them, with the view's key and a name. */
const TASK_FIELDS = [
  ['brief', 'brief', 'description'],
  ['done_when', 'doneWhen', 'done when'],
  ['project', 'project', 'area'],
  ['horizon', 'horizon', 'horizon'],
  ['priority', 'priority', 'priority'],
];
/** A feature's fields an agent may change: the rest (dates, shipped) stay the owner's. */
const FEATURE_FIELDS = ['title', 'brief', 'release'];
/** How many changes a feature's page lists. */
const ON_FEATURE = 20;

const label = (t) => t.wid ?? t.short ?? t.uuid?.slice(0, 8);
const added = (before, after) => after.filter((x) => !before.includes(x));
const parse = (text) => {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return {};
  }
};

/**
 * What an agent's edit changed on a task, from its view before and after: each scalar field that moved, and the tags
 * and dependencies added and removed. Null when nothing it records moved.
 * @param {any} before
 * @param {any} after
 */
export function taskPlanningDiff(before, after) {
  const fields = {};
  for (const [field, key] of TASK_FIELDS)
    if ((before[key] ?? null) !== (after[key] ?? null))
      fields[field] = {
        before: before[key] ?? null,
        after: after[key] ?? null,
        ...(field === 'brief' ? { beforeBy: before.briefBy ?? null } : {}),
      };
  for (const [field, key] of [
    ['tags', 'tags'],
    ['depends', 'depends'],
  ]) {
    const add = added(before[key], after[key]);
    const remove = added(after[key], before[key]);
    if (add.length || remove.length) fields[field] = { added: add, removed: remove };
  }
  return Object.keys(fields).length ? fields : null;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const planningMethods = {
  initPlanning() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS planning_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL,
        target TEXT NOT NULL, feature TEXT, fields TEXT NOT NULL, undone_at INTEGER, undone_by TEXT
      );
      CREATE INDEX IF NOT EXISTS planning_edits_at ON planning_edits (at);
      CREATE INDEX IF NOT EXISTS planning_edits_feature ON planning_edits (feature);
    `);
  },

  /**
   * Keeps one planning change. `kind` is `task` (target: its UUID), `feature` (its slug), or `pull` (the release);
   * `feature` is the feature it's shown on, when it's about one.
   */
  recordPlanning(agent, kind, target, fields, feature = null) {
    this.sql.exec(
      'INSERT INTO planning_edits (at, agent, kind, target, feature, fields) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(),
      String(agent),
      kind,
      String(target),
      feature,
      JSON.stringify(fields),
    );
  },

  /** An agent's edit of another task: kept when it changed what the plan holds. Tag changes show on their feature. */
  recordTaskPlanning(agent, uuid, before, after) {
    const fields = taskPlanningDiff(before, after);
    if (!fields) return;
    const slugs = new Set(this.featureRows().map((r) => r.slug));
    const tags = fields.tags ? [...fields.tags.added, ...fields.tags.removed] : [];
    const feature = tags.find((t) => slugs.has(t)) ?? after.tags.find((t) => slugs.has(t)) ?? null;
    this.recordPlanning(agent, 'task', uuid, fields, feature);
  },

  /** An agent's change of a feature's title, brief, or release: kept with the fields that moved. */
  recordFeaturePlanning(agent, slug, before, after) {
    const fields = {};
    for (const key of FEATURE_FIELDS)
      if ((before[key] ?? null) !== (after[key] ?? null))
        fields[key] = { before: before[key] ?? null, after: after[key] ?? null };
    if (Object.keys(fields).length) this.recordPlanning(agent, 'feature', slug, fields, slug);
  },

  /** One kept change as the API shows it, in words the web app and the CLI can print. */
  planningView(row) {
    const fields = parse(row.fields);
    const brief = (uuid) => {
      const map = this.tasks.get(uuid);
      return {
        uuid,
        wid: map?.wid ?? null,
        description: map?.description ?? '(deleted task)',
        status: map?.status ?? 'gone',
      };
    };
    const out = {
      id: row.id,
      at: new Date(row.at).toISOString(),
      agent: row.agent,
      kind: row.kind,
      feature: row.feature ?? null,
      undone: row.undone_at ? { at: new Date(row.undone_at).toISOString(), by: row.undone_by } : null,
    };
    if (row.kind === 'pull')
      return {
        ...out,
        release: row.target,
        into: fields.into,
        tasks: Object.entries(fields.tasks ?? {}).map(([uuid, h]) => ({ ...brief(uuid), before: h.before })),
      };
    if (row.kind === 'feature') {
      const title = this.sql.exec('SELECT title FROM features WHERE slug = ?', row.target).toArray()[0]?.title;
      return { ...out, target: { slug: row.target, title: title ?? row.target }, changes: changeList(fields) };
    }
    const changes = changeList(fields).map((c) =>
      c.field === 'depends'
        ? { ...c, added: c.added.map((u) => label(brief(u))), removed: c.removed.map((u) => label(brief(u))) }
        : c,
    );
    return { ...out, task: brief(row.target), changes };
  },

  /** Kept changes between two moments, for Activity. */
  planningEvents(after, upTo) {
    return this.sql
      .exec('SELECT * FROM planning_edits WHERE at > ? AND at <= ? ORDER BY at DESC', after, upTo)
      .toArray();
  },

  /** The newest kept changes on a feature: its own and its tasks' tags, and the pulls of its release. */
  featurePlanning(slug, release) {
    return this.sql
      .exec(
        "SELECT * FROM planning_edits WHERE feature = ? OR (kind = 'pull' AND target = ?) ORDER BY id DESC LIMIT ?",
        slug,
        release ?? '',
        ON_FEATURE,
      )
      .toArray()
      .map((row) => this.planningView(row));
  },

  /**
   * Undoes one kept change, the owner's (BRK-274): what the agent changed goes back to what it was, in one version.
   * A field someone has changed since is refused by name, so nothing newer is overwritten; a change undone once is
   * done.
   * @param {unknown} id
   * @param {{ by?: string }} input
   */
  undoPlanning(id, input = {}) {
    const words = 'only the owner undoes an agent’s change';
    if (this.actorIn(input).agent) this.allow(input, 'planning.undo', null, words);
    const row = this.sql.exec('SELECT * FROM planning_edits WHERE id = ?', Number(id)).toArray()[0];
    if (!row) throw new AgentError(`there’s no change ${id} to undo`, 404);
    // A maintainer's where the change was (BRK-301): a task's repository, a feature's, or the whole board's for a pull.
    if (!this.ownerActs(input)) {
      const repos =
        row.kind === 'task'
          ? this.targetRepos({ task: row.target })
          : row.kind === 'feature'
            ? this.targetRepos({ feature: row.target })
            : [null];
      for (const repo of repos) this.allow(input, 'planning.undo', repo, words);
    }
    if (row.undone_at) throw new AgentError('that change is already undone', 409);
    this.writable();
    const fields = parse(row.fields);
    if (row.kind === 'feature') this.undoFeaturePlanning(row, fields);
    else if (row.kind === 'pull') this.undoPull(row, fields);
    else this.undoTaskPlanning(row, fields);
    this.sql.exec(
      'UPDATE planning_edits SET undone_at = ?, undone_by = ? WHERE id = ?',
      Date.now(),
      this.actorIn(input).person,
      row.id,
    );
    return this.planningView(this.sql.exec('SELECT * FROM planning_edits WHERE id = ?', row.id).toArray()[0]);
  },

  undoFeaturePlanning(row, fields) {
    const now = this.sql.exec('SELECT * FROM features WHERE slug = ?', row.target).toArray()[0];
    if (!now) throw new AgentError(`the feature ${row.target} is gone, so there’s nothing to undo`, 409);
    for (const [key, f] of Object.entries(fields))
      if ((now[key] ?? null) !== f.after)
        throw new AgentError(
          `${row.target}’s ${key} has changed since ${row.agent} set it: change it on the feature instead`,
          409,
        );
    const back = { ...now };
    for (const [key, f] of Object.entries(fields)) back[key] = f.before ?? (key === 'title' ? now.title : null);
    this.sql.exec(
      'UPDATE features SET title = ?, brief = ?, release = ?, edited_by = ?, edited_at = ? WHERE slug = ?',
      back.title,
      back.brief,
      back.release,
      'owner',
      Date.now(),
      row.target,
    );
  },

  undoPull(row, fields) {
    const at = new Date();
    const ops = [];
    for (const [uuid, h] of Object.entries(fields.tasks ?? {})) {
      const before = this.tasks.get(uuid);
      // A task moved again since stays where it is now.
      if (!before || before.horizon !== fields.into) continue;
      ops.push(...diffOps(uuid, before, withChanges(before, { horizon: h.before ?? '' }, at), at.toISOString()));
    }
    if (!ops.length)
      throw new AgentError(`${row.target}’s tasks have all moved since ${row.agent} pulled them: nothing to undo`, 409);
    this.commit(ops);
  },

  undoTaskPlanning(row, fields) {
    const uuid = row.target;
    if (!this.tasks.get(uuid)) throw new AgentError('that task is gone, so there’s nothing to undo', 409);
    const now = this.detail(uuid);
    const changes = {};
    let briefBy = null;
    for (const [field, key, name] of TASK_FIELDS) {
      const f = fields[field];
      if (!f) continue;
      if ((now[key] ?? null) !== f.after)
        throw new AgentError(
          `${label(now)}’s ${name} has changed since ${row.agent} set it: change it on the task instead`,
          409,
        );
      changes[field] = f.before ?? '';
      if (field === 'brief') briefBy = f.beforeBy;
    }
    if (fields.tags) {
      changes.removeTags = fields.tags.added.filter((t) => now.tags.includes(t));
      changes.addTags = fields.tags.removed.filter((t) => !now.tags.includes(t));
    }
    if (fields.depends) {
      changes.removeDepends = fields.depends.added.filter((d) => now.depends.includes(d));
      changes.addDepends = fields.depends.removed.filter((d) => !now.depends.includes(d) && this.tasks.has(d));
    }
    this.change(uuid, { ...changes, by: briefBy ?? 'owner' });
    const names = changeList(fields).map((c) => c.name);
    this.change(uuid, { annotate: `You undid ${row.agent}’s change: ${names.join(', ')}.`, by: 'board' });
  },

  planningUndoApi(id, body) {
    return this.run(() => ({ status: 200, body: { change: this.undoPlanning(id, body ?? {}) } }));
  },
};

/**
 * The kept fields as a list, each with its name in words.
 * @param {Record<string, any>} fields
 * @returns {any[]}
 */
function changeList(fields) {
  const names = Object.fromEntries([
    ...TASK_FIELDS.map(([field, , name]) => [field, name]),
    ['tags', 'tags'],
    ['depends', 'dependencies'],
    ['title', 'title'],
    ['release', 'release'],
  ]);
  return Object.entries(fields).map(([field, f]) => ({
    field,
    name: field === 'brief' && !('beforeBy' in f) ? 'brief' : names[field],
    ...(f.added ? { added: f.added, removed: f.removed } : { before: f.before, after: f.after }),
  }));
}
