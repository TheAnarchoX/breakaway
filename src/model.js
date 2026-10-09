/**
 * The board's view of a TaskChampion task, and how changes become properties.
 *
 * Properties follow what Taskwarrior 3.5 writes: epoch-second strings for dates, `tag_<name>`
 * plus a `tags` list, `dep_<uuid>` plus a `depends` list, `annotation_<epoch>`, and UDAs
 * (`wid`, `horizon`, `spec`, `claim`, `pr`) as plain properties. The task structure (IDEA-5): `brief`
 (the current description), `brief_by`, `done_when`, `rel_<uuid>` plus a `related` list, and `by_<epoch>`
 beside `annotation_<epoch>` for a comment's author. The owner's words (BRK-284): `said_<epoch>` (the quote),
 `said_from_<epoch>` (where it came from), and `said_by_<epoch>` (who put it on the task).
 */

import { keepAnswers, validateQuestions } from './decision.js';

/**
 * Taskwarrior project → work ID prefix, as the first install had them before repositories (IDEA-14): what
 * the registry's default repository starts with, plus the install-wide ideas and routines. Prefixes come
 * from the task's repository now (repos.js, store-repos.js).
 */
export const PROJECTS = {
  product: 'PRD',
  brand: 'BRD',
  moderation: 'MOD',
  ops: 'OPS',
  cloud: 'CLD',
  debt: 'DEBT',
  compliance: 'CMP',
  ideas: 'IDEA',
  routines: 'RUN',
};
/** Area names people read, for messages the server writes. */
export const AREA_NAMES = {
  product: 'Product',
  brand: 'Brand',
  moderation: 'Moderation',
  ops: 'Operations',
  cloud: 'Cloud',
  debt: 'Tech debt',
  compliance: 'Compliance',
  ideas: 'Ideas',
  routines: 'Routines',
};
export const HORIZONS = ['now', 'next', 'later', 'archive'];
export const PRIORITIES = ['H', 'M', 'L'];
export const STATUSES = ['pending', 'completed', 'deleted'];
/** Properties the API may set directly (strings, or null to remove). */
export const PLAIN = [
  'description',
  'project',
  'priority',
  'horizon',
  'spec',
  'pr',
  'claim',
  'wid',
  'autostart',
  'session',
  'alert',
  'brief',
  'done_when',
  'repo',
];
/** The longest a description, done-when, or comment may be. */
export const MAX_TEXT = 10000;
/** The author stored for a note that was written before comments had authors (shown as "earlier note"). */
export const EARLIER = '?';
/** The author of an annotation nobody signed: only the owner uses Taskwarrior. */
export const DEFAULT_AUTHOR = 'owner';
const DATES = ['due', 'wait', 'scheduled'];

const WID = /^([A-Z]+)-(\d+)$/u;
const TAG = /^[A-Za-z][\w-]*$/u;

const iso = (epoch) => (epoch ? new Date(Number(epoch) * 1000).toISOString() : null);
const list = (value) =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

export function tagsOf(map) {
  const tags = new Set(list(map.tags));
  for (const key of Object.keys(map)) if (key.startsWith('tag_')) tags.add(key.slice(4));
  return [...tags].sort();
}

export function dependsOf(map) {
  const deps = new Set(list(map.depends));
  for (const key of Object.keys(map)) if (key.startsWith('dep_')) deps.add(key.slice(4));
  return [...deps].sort();
}

export function relatedOf(map) {
  const rel = new Set(list(map.related));
  for (const key of Object.keys(map)) if (key.startsWith('rel_')) rel.add(key.slice(4));
  return [...rel].sort();
}

/** A task's comments, oldest first: annotations with their authors. `by` is null for an earlier note. */
export function commentsOf(map) {
  return Object.keys(map)
    .filter((key) => key.startsWith('annotation_'))
    .map((key) => ({ epoch: Number(key.slice(11)), text: map[key] }))
    .sort((a, b) => a.epoch - b.epoch)
    .map(({ epoch, text }) => {
      const by = map[`by_${epoch}`];
      return { by: by === EARLIER ? null : by || DEFAULT_AUTHOR, at: iso(epoch), text };
    });
}

/** The longest one quote of the owner's words may be, and how many a task keeps (BRK-284). */
export const MAX_SAID = 2000;
export const MAX_SAID_COUNT = 20;
/** Where the owner's words came from: the task on the board, a message, a peloton post, a ping, a decision, or a comment. */
export const SAID_FROM = ['board', 'message', 'peloton', 'ping', 'decision', 'comment'];
/** A source, with an optional pointer to it: `peloton #2243`, `decision BRK-12`, `message 2026-10-09`. */
const SAID_SOURCE = new RegExp(`^(${SAID_FROM.join('|')})(?: [#\\w.:/-]{1,48})?$`, 'u');
const SAID_KEY = /^said_(\d+)$/u;

/**
 * The owner's words on a task (BRK-284), oldest first: `{ id, text, from, by, at }`. `by` is `owner` when the owner put
 * them there on the board, or the agent that quoted them; `id` is what removing one names.
 */
export function ownerSaidOf(map) {
  return Object.keys(map)
    .map((key) => SAID_KEY.exec(key))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((epoch) => ({
      id: epoch,
      text: map[`said_${epoch}`],
      from: map[`said_from_${epoch}`] ?? 'board',
      by: map[`said_by_${epoch}`] ?? DEFAULT_AUTHOR,
      at: iso(epoch),
    }));
}

/** A JSON property Taskwarrior may have mangled → its value, or null. */
function parseJson(text, shape) {
  try {
    const value = JSON.parse(text);
    return shape(value) ? value : null;
  } catch {
    return null;
  }
}
const isList = (v) => Array.isArray(v);
const isRecord = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.answers === 'object' && v.answers !== null;

const isOpen = (map) => map && (map.status === 'pending' || map.status === 'recurring');

/** The JSON shape the API and web app use. `all` is the Map of every task, for dependencies. */
export function view(uuid, map, all, now = new Date()) {
  const depends = dependsOf(map);
  const blockedBy = depends.filter((dep) => isOpen(all.get(dep)));
  const nowSec = Math.floor(now.getTime() / 1000);
  const waiting = Boolean(map.wait) && Number(map.wait) > nowSec;
  const status = map.status ?? 'pending';
  const annotations = Object.keys(map)
    .filter((key) => key.startsWith('annotation_'))
    .map((key) => ({ epoch: Number(key.slice(11)), text: map[key] }))
    .sort((a, b) => a.epoch - b.epoch)
    .map(({ epoch, text }) => ({ entry: iso(epoch), text }));
  // A comment that repeats the description word for word is the same text: hide it from the thread.
  const comments = commentsOf(map).filter((c) => !map.brief || c.text.trim() !== map.brief.trim());
  return {
    uuid,
    short: uuid.slice(0, 8),
    wid: map.wid ?? null,
    description: map.description ?? '',
    brief: map.brief ?? null,
    briefBy: map.brief_by ?? null,
    doneWhen: map.done_when ?? null,
    related: relatedOf(map),
    ownerSaid: ownerSaidOf(map),
    status,
    project: map.project ?? null,
    priority: map.priority ?? '',
    horizon: map.horizon ?? null,
    tags: tagsOf(map),
    depends,
    blockedBy,
    blocked: blockedBy.length > 0,
    waiting,
    active: Boolean(map.start),
    ready: status === 'pending' && blockedBy.length === 0 && !waiting,
    claim: map.claim ?? null,
    spec: map.spec ?? null,
    pr: map.pr ?? null,
    autostart: map.autostart === 'yes',
    session: map.session ?? null,
    alert: map.alert ?? null,
    decision: map.decision ? parseJson(map.decision, isList) : null,
    decisionAnswers: map.decision_answers ? parseJson(map.decision_answers, isRecord) : null,
    entry: iso(map.entry),
    modified: iso(map.modified),
    start: iso(map.start),
    end: iso(map.end),
    due: iso(map.due),
    wait: iso(map.wait),
    annotations,
    comments,
  };
}

const HORIZON_ORDER = { now: 0, next: 1, later: 2, archive: 3 };
const PRIORITY_ORDER = { H: 0, M: 1, L: 2 };

/** Sort order for views: horizon, priority, then work ID number, then age. */
export function rank(a, b) {
  const h = (HORIZON_ORDER[a.horizon] ?? 4) - (HORIZON_ORDER[b.horizon] ?? 4);
  if (h) return h;
  const p = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
  if (p) return p;
  const wa = WID.exec(a.wid ?? '');
  const wb = WID.exec(b.wid ?? '');
  if (wa && wb) return Number(wa[2]) - Number(wb[2]) || wa[1].localeCompare(wb[1]);
  if (wa || wb) return wa ? -1 : 1;
  return String(a.entry).localeCompare(String(b.entry));
}

export function nextWid(prefix, all) {
  let max = 0;
  for (const map of all.values()) {
    const m = WID.exec(map.wid ?? '');
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}-${max + 1}`;
}

/** A work ID (any case), a full UUID, or a UUID prefix of at least 4 characters → UUID or null. */
export function resolveRef(ref, all) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (WID.test(upper)) {
    for (const [uuid, map] of all) if (map.wid === upper) return uuid;
  }
  const lower = value.toLowerCase();
  if (all.has(lower)) return lower;
  if (!/^[0-9a-f-]{4,}$/u.test(lower)) return null;
  const hits = [...all.keys()].filter((uuid) => uuid.startsWith(lower));
  if (hits.length > 1) throw new RefError(`"${value}" matches more than one task; use more of the UUID`);
  return hits[0] ?? null;
}

export class RefError extends Error {}
export class InputError extends Error {}

/**
 * A date people type → epoch seconds: YYYY-MM-DD (midnight UTC), an ISO date-time, `now`,
 * `today`, `tomorrow`, or a duration from now like `3d`, `2w`, `12h`.
 */
export function toEpoch(value, now = new Date()) {
  const nowSec = Math.floor(now.getTime() / 1000);
  const text = String(value).trim().toLowerCase();
  if (text === 'now') return nowSec;
  if (text === 'today') return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  if (text === 'tomorrow') return toEpoch('today', now) + 86400;
  const span = /^(\d+)(h|d|w)$/u.exec(text);
  if (span) return nowSec + Number(span[1]) * { h: 3600, d: 86400, w: 604800 }[span[2]];
  if (/^\d{9,11}$/u.test(text)) return Number(text);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(text) ? `${text}T00:00:00Z` : String(value));
  if (Number.isNaN(ms)) throw new InputError(`"${value}" isn't a date I can read (try 2026-10-10, 3d, or tomorrow)`);
  return Math.floor(ms / 1000);
}

function checkTag(tag) {
  if (!TAG.test(tag)) throw new InputError(`"${tag}" isn't a valid tag (letters, digits, - and _)`);
  return tag;
}

function setTags(map, tags) {
  for (const key of Object.keys(map)) if (key.startsWith('tag_')) delete map[key];
  for (const tag of tags) map[`tag_${tag}`] = 'x';
  if (tags.length) map.tags = [...tags].sort().join(',');
  else delete map.tags;
}

function setDepends(map, deps) {
  for (const key of Object.keys(map)) if (key.startsWith('dep_')) delete map[key];
  for (const dep of deps) map[`dep_${dep}`] = 'x';
  if (deps.length) map.depends = [...deps].sort().join(',');
  else delete map.depends;
}

function setRelated(map, rel) {
  for (const key of Object.keys(map)) if (key.startsWith('rel_')) delete map[key];
  for (const r of rel) map[`rel_${r}`] = 'x';
  if (rel.length) map.related = [...rel].sort().join(',');
  else delete map.related;
}

/**
 * Returns a new property map with `changes` applied (the input isn't modified).
 * changes: {description, project, priority, horizon, spec, pr, claim, wid (string or null),
 *   status, due, wait, scheduled (date text or null), start: true|false, entry, end (epoch),
 *   brief, done_when (text or null), addTags, removeTags, addDepends, removeDepends, addRelated,
 *   removeRelated (arrays), annotate (text), by (who wrote the annotation or the brief),
 *   said ({ text, from, by }: the owner's words, quoted), unsay (a quote's id, to remove it)}
 */
export function withChanges(before, changes, now = new Date()) {
  const map = { ...(before ?? {}) };
  const nowSec = String(Math.floor(now.getTime() / 1000));
  if (!before) {
    map.status = 'pending';
    map.entry = nowSec;
  }
  for (const key of PLAIN) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (value === null || value === '') delete map[key];
    else map[key] = String(value);
  }
  for (const key of ['brief', 'done_when'])
    if (map[key] && map[key].length > MAX_TEXT)
      throw new InputError(`${key === 'brief' ? 'a description' : 'done when'} can be up to ${MAX_TEXT} characters`);
  if ('brief' in changes && changes.by && map.brief) map.brief_by = String(changes.by);
  if (!map.brief) delete map.brief_by;
  if (map.priority && !PRIORITIES.includes(map.priority)) throw new InputError('priority is H, M, or L');
  if (map.horizon && !HORIZONS.includes(map.horizon)) throw new InputError('horizon is now, next, later, or archive');
  if (map.wid && !WID.test(map.wid)) throw new InputError('a work ID looks like PRD-12');
  if (map.repo && !/^[a-z][a-z0-9-]{0,31}$/u.test(map.repo))
    throw new InputError("repo is a repository's slug, like web");
  if (map.autostart && map.autostart !== 'yes') throw new InputError('autostart is yes, or empty to turn it off');
  if (map.session && !/^https:\/\/claude\.ai\/code\//u.test(map.session))
    throw new InputError('session is a claude.ai/code link');
  if (map.alert && !/^https:\/\/github\.com\//u.test(map.alert)) throw new InputError('alert is a github.com link');
  for (const key of DATES) {
    if (!(key in changes)) continue;
    if (changes[key] === null || changes[key] === '') delete map[key];
    else map[key] = String(toEpoch(changes[key], now));
  }
  if ('entry' in changes && changes.entry) map.entry = String(changes.entry);
  if ('decision' in changes) {
    if (changes.decision === null || changes.decision === '') {
      delete map.decision;
      delete map.decision_answers;
    } else {
      let input = changes.decision;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          throw new InputError('the decision must be JSON: a list of questions');
        }
      }
      const questions = validateQuestions(input);
      map.decision = JSON.stringify(questions);
      const old = map.decision_answers ? parseJson(map.decision_answers, isRecord) : null;
      if (old) {
        const { answers } = keepAnswers(questions, old.answers);
        map.decision_answers = JSON.stringify({ ...old, answers });
      }
      setTags(map, [...new Set([...tagsOf(map), 'decide'])]);
    }
  }
  if ('decisionAnswers' in changes) {
    if (changes.decisionAnswers === null) delete map.decision_answers;
    else map.decision_answers = JSON.stringify(changes.decisionAnswers);
  }
  if (changes.addTags || changes.removeTags) {
    const tags = new Set(tagsOf(map));
    for (const tag of changes.addTags ?? []) tags.add(checkTag(tag));
    for (const tag of changes.removeTags ?? []) tags.delete(tag);
    setTags(map, [...tags]);
  }
  if (changes.addDepends || changes.removeDepends) {
    const deps = new Set(dependsOf(map));
    for (const dep of changes.addDepends ?? []) deps.add(dep);
    for (const dep of changes.removeDepends ?? []) deps.delete(dep);
    setDepends(map, [...deps]);
  }
  if (changes.addRelated || changes.removeRelated) {
    const rel = new Set(relatedOf(map));
    for (const r of changes.addRelated ?? []) rel.add(r);
    for (const r of changes.removeRelated ?? []) rel.delete(r);
    setRelated(map, [...rel]);
  }
  if (changes.start === true && !map.start) map.start = nowSec;
  if (changes.start === false) delete map.start;
  if ('status' in changes && changes.status !== (before?.status ?? null)) {
    if (!STATUSES.includes(changes.status)) throw new InputError('status is pending, completed, or deleted');
    map.status = changes.status;
    if (changes.status === 'pending') delete map.end;
    else {
      map.end = changes.end ? String(changes.end) : nowSec;
      delete map.start;
    }
  }
  if (changes.annotate) {
    let key = Number(nowSec);
    while (map[`annotation_${key}`] !== undefined) key += 1;
    if (String(changes.annotate).length > MAX_TEXT)
      throw new InputError(`a comment can be up to ${MAX_TEXT} characters`);
    map[`annotation_${key}`] = String(changes.annotate);
    if (changes.by) map[`by_${key}`] = String(changes.by);
  }
  if (changes.said) {
    const text = String(changes.said.text ?? '').trim();
    const from = String(changes.said.from ?? 'board').trim();
    if (!text) throw new InputError("say what the owner said: the quote can't be empty");
    if (text.length > MAX_SAID) throw new InputError(`a quote can be up to ${MAX_SAID} characters`);
    if (!SAID_SOURCE.test(from))
      throw new InputError(
        `say where the owner said it: ${SAID_FROM.join(', ')}, optionally with a pointer like "peloton #12"`,
      );
    const held = ownerSaidOf(map);
    if (held.some((q) => q.text === text)) throw new InputError('the task already quotes those words');
    if (held.length >= MAX_SAID_COUNT)
      throw new InputError(`a task keeps up to ${MAX_SAID_COUNT} quotes; the owner removes one first`);
    let key = Number(nowSec);
    while (map[`said_${key}`] !== undefined) key += 1;
    map[`said_${key}`] = text;
    map[`said_from_${key}`] = from;
    map[`said_by_${key}`] = String(changes.said.by ?? DEFAULT_AUTHOR);
  }
  if (changes.unsay !== undefined && changes.unsay !== null) {
    const key = String(changes.unsay);
    if (!/^\d+$/u.test(key) || map[`said_${key}`] === undefined) throw new InputError(`the task has no quote ${key}`);
    for (const prop of [`said_${key}`, `said_from_${key}`, `said_by_${key}`]) delete map[prop];
  }
  if (!map.description) throw new InputError('a task needs a description');
  map.modified = nowSec;
  return map;
}

/** The TaskChampion operations that turn `before` (or nothing) into `after`. */
export function diffOps(uuid, before, after, timestamp) {
  const ops = [];
  if (!before) ops.push({ type: 'create', uuid });
  const old = before ?? {};
  const keys = new Set([...Object.keys(old), ...Object.keys(after)]);
  for (const property of [...keys].sort()) {
    if (old[property] === after[property]) continue;
    ops.push({ type: 'update', uuid, property, value: after[property] ?? null, timestamp });
  }
  return ops;
}
