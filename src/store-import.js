/**
 * TaskStore's import (BRK-234): `npx breakaway export`'s JSON read back into an empty board, for a board redeployed on
 * a new Cloudflare account or with a new store. Every task keeps its UUID, work ID, repository, area, horizon, tags,
 * dependencies, decision, the owner's quoted words, and comments with their authors and times. Claims, an agent's
 * session, and autostart are cleared: nobody holds work on a board that just came back, and whether a task starts an
 * agent by itself is the owner's to turn on again. It's the owner's alone (an agent's `by` is refused), and only into a
 * board with no tasks, so it never merges two boards or writes over one.
 */
import { isUuid, seal } from './crypto.js';
import { DEFAULT_AUTHOR, EARLIER, InputError, STATUSES, diffOps, withChanges } from './model.js';
import { encodeSegment } from './ops.js';
import { AgentError } from './store-agents.js';

/**
 * The most one version's operations may take as JSON before the import starts another. Each version is one SQLite row,
 * and "Workers SQLite rows have a hard maximum size of 2 MB"
 * (https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/#row-size-protection,
 * https://developers.cloudflare.com/durable-objects/platform/limits/): 1 MB leaves room for the seal and the encoding.
 */
const VERSION_BYTES = 1_000_000;

/** An ISO time from the export → epoch seconds as Taskwarrior stores them, or undefined when there is none. */
function epochOf(value, what) {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new InputError(`${what} "${String(value).slice(0, 40)}" isn't a time`);
  return String(Math.floor(ms / 1000));
}

const text = (value) => (value === undefined || value === null ? undefined : String(value));
const list = (value) => (Array.isArray(value) ? value.map(String) : []);

/**
 * One exported task (the board's JSON, as `GET /api/tasks?status=all` gives it) → its Taskwarrior properties.
 * `repo` is the task's stored repository (null for the board's default). Claims, sessions, and autostart are left out.
 * @param {any} task
 * @param {string | null} repo
 * @param {Date} now
 */
export function importedMap(task, repo, now) {
  const label = task.wid ?? task.uuid;
  if (!STATUSES.includes(task.status)) throw new InputError(`${label}: status is pending, completed, or deleted`);
  const changes = {
    description: text(task.description),
    brief: text(task.brief),
    by: text(task.briefBy),
    done_when: text(task.doneWhen),
    project: text(task.project),
    priority: text(task.priority),
    horizon: text(task.horizon),
    spec: text(task.spec),
    pr: text(task.pr),
    wid: text(task.wid)?.toUpperCase(),
    alert: text(task.alert),
    repo,
    due: text(task.due),
    wait: text(task.wait),
    status: task.status,
    end: epochOf(task.end, `${label}'s end`),
    addTags: list(task.tags),
    addDepends: list(task.depends).map((d) => d.toLowerCase()),
    addRelated: list(task.related).map((r) => r.toLowerCase()),
  };
  // withChanges sets every key it's given, so a field the export doesn't have is left out, not set to "undefined".
  const map = withChanges(null, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)), now);
  map.entry = epochOf(task.entry, `${label}'s entry`) ?? map.entry;
  // The decision as it was asked and answered: setting it through withChanges would tag it +decide again.
  if (Array.isArray(task.decision)) map.decision = JSON.stringify(task.decision);
  if (task.decisionAnswers && typeof task.decisionAnswers === 'object')
    map.decision_answers = JSON.stringify(task.decisionAnswers);
  // Comments: every annotation (the export's `annotations` keep the ones `comments` hides for repeating the
  // description), with its author from `comments` where it shows there.
  const authors = new Map();
  for (const c of Array.isArray(task.comments) ? task.comments : [])
    authors.set(`${epochOf(c.at, `${label}'s comment`)}\n${c.text}`, c.by);
  const notes = Array.isArray(task.annotations)
    ? task.annotations.map((a) => ({ at: a.entry, text: a.text }))
    : (Array.isArray(task.comments) ? task.comments : []).map((c) => ({ at: c.at, text: c.text }));
  for (const note of notes) {
    let key = Number(epochOf(note.at, `${label}'s comment`) ?? map.entry);
    const body = String(note.text ?? '');
    const by = authors.has(`${key}\n${body}`) ? authors.get(`${key}\n${body}`) : undefined;
    while (map[`annotation_${key}`] !== undefined) key += 1;
    map[`annotation_${key}`] = body;
    // `by` null is an earlier note; a comment the export hid has no author to read back, so it's one too.
    if (by === undefined || by === null) map[`by_${key}`] = EARLIER;
    else if (by !== DEFAULT_AUTHOR) map[`by_${key}`] = String(by);
  }
  for (const said of Array.isArray(task.ownerSaid) ? task.ownerSaid : []) {
    const id = String(said.id ?? '');
    if (!/^\d+$/u.test(id)) throw new InputError(`${label}: a quote of the owner's words has no id`);
    map[`said_${id}`] = String(said.text ?? '');
    map[`said_from_${id}`] = String(said.from ?? 'board');
    map[`said_by_${id}`] = String(said.by ?? DEFAULT_AUTHOR);
  }
  map.modified = epochOf(task.modified, `${label}'s modified`) ?? map.modified;
  return map;
}

export const importMethods = {
  /**
   * Restores the board from an export into an empty board: `{ tasks, count? }` as `npx breakaway export` writes it.
   * Refused to an agent, on a board with any task, and for an export whose repositories aren't registered yet.
   * @param {any} body
   */
  importApi(body) {
    return this.run(() => {
      this.allow(body, 'install.admin', null, 'only the owner restores the board from an export');
      this.writable();
      const tasks = body?.tasks;
      if (!Array.isArray(tasks) || !tasks.length)
        throw new InputError('send the export: the JSON npx breakaway export wrote, with its tasks');
      if (body.count !== undefined && Number(body.count) !== tasks.length)
        throw new InputError(
          `the export says ${body.count} tasks but holds ${tasks.length}: it's incomplete, so export it again`,
        );
      if (this.tasks.size)
        throw new AgentError(
          `the board already has ${this.tasks.size === 1 ? 'a task' : `${this.tasks.size} tasks`}: an export only restores into an empty board`,
          409,
        );
      this.checkRepoSlug(undefined); // a board with no repository yet says how to register one
      const fallback = this.defaultRepoSlug();
      const missing = new Set();
      for (const task of tasks) {
        const slug = String(task?.repo || fallback).toLowerCase();
        if (!this.repoBySlug(slug)) missing.add(slug);
      }
      if (missing.size)
        throw new InputError(
          `register ${[...missing].join(', ')} first: the export has their tasks. The owner registers one with npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>, with the same areas as before`,
        );
      const now = new Date();
      const stamp = now.toISOString();
      const uuids = new Set();
      const wids = new Set();
      /** @type {any[][]} */
      const versions = [[]];
      let size = 0;
      let comments = 0;
      let cleared = 0;
      for (const task of tasks) {
        if (!task || typeof task !== 'object') throw new InputError('each task in the export is an object');
        const uuid = String(task.uuid ?? '').toLowerCase();
        if (!isUuid(uuid)) throw new InputError(`${task.wid ?? 'a task'} has no UUID`);
        if (uuids.has(uuid)) throw new InputError(`${uuid} is in the export twice`);
        uuids.add(uuid);
        const slug = String(task.repo || fallback).toLowerCase();
        const map = importedMap(task, this.storedRepo(slug), now);
        if (map.wid) {
          if (wids.has(map.wid)) throw new InputError(`${map.wid} is in the export twice`);
          wids.add(map.wid);
          this.checkWidPrefix(slug, map.wid);
        }
        comments += Object.keys(map).filter((k) => k.startsWith('annotation_')).length;
        if (task.claim || task.autostart || task.session || task.active) cleared += 1;
        const ops = diffOps(uuid, null, map, stamp);
        const bytes = JSON.stringify(ops).length;
        if (size && size + bytes > VERSION_BYTES) {
          versions.push([]);
          size = 0;
        }
        versions.at(-1).push(...ops);
        size += bytes;
      }
      // One version per batch, all in one transaction: either the whole export is on the board or none of it is.
      this.atomically(() => {
        for (const ops of versions) {
          const parent = this.latest();
          this.insertVersion(crypto.randomUUID(), parent, seal(this.key, parent, encodeSegment(ops)), 'import');
          this.applyOps(ops);
        }
      });
      this.maybeSnapshot();
      return {
        status: 201,
        body: { imported: tasks.length, comments, cleared, versions: versions.length, total: this.tasks.size },
      };
    });
  },
};
