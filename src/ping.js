/**
 * Pings and proposals (docs/specs/IDEA-12-agent-pings.md): what an agent may ask of the owner, checked
 * before anything is stored. Pure functions over the board's tasks, so the rules are tested without
 * a Durable Object. The same checks run again when the owner applies a proposal (CLD-112).
 */
import { InputError, MAX_TEXT, PROJECTS, dependsOf } from './model.js';

export const PING_KINDS = ['blocked', 'question', 'stale', 'done', 'fyi'];
/** The kinds that send a push; `fyi` only shows in the inbox. */
export const PUSH_KINDS = ['blocked', 'question', 'stale', 'done'];
/**
 * Kinds only the board itself writes, never an agent (BRK-197): an incident pushes for production and is quiet in
 * the inbox otherwise, so its row says which.
 */
export const BOARD_PING_KINDS = ['incident'];
export const MAX_MESSAGE = 500;
export const MAX_CHANGES = 10;
export const MAX_PROPOSAL_BYTES = 20 * 1024;
export const PINGS_PER_TASK_PER_DAY = 3;
export const PINGS_PER_AGENT_PER_DAY = 10;

const REF = /^[a-z][a-z0-9_-]{0,19}$/u;
const WID = /^[A-Z]+-\d+$/u;
const TAG = /^[a-z][\w-]{0,39}$/u;
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const NEW_HORIZONS = ['now', 'next', 'later'];
const PRIORITIES = ['H', 'M', 'L'];

/** Whether text looks like a token or key, so it never reaches a comment, the inbox, or a push. A commit SHA is fine. */
export function looksLikeSecret(text) {
  const value = String(text ?? '');
  if (/\b(?:gh[pousr]_|github_pat_|sk-ant-|sk_live_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}/u.test(value)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu.test(value)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) return true;
  for (const [word] of value.matchAll(/[A-Za-z0-9+/_=-]{32,}/gu)) {
    if (/^[0-9a-f]{40}$/u.test(word)) continue;
    if (looksLikePath(word)) continue;
    if (/\d/u.test(word) && /[A-Za-z]/u.test(word) && !/^[a-z]+(?:-[a-z0-9]+)+$/u.test(word)) return true;
  }
  return false;
}

/**
 * Whether a long word is a file path or a link's path (`docs/specs/IDEA-36-peloton-planning`), not a token with
 * slashes in it: it has a slash, no `+` or `=`, and every name in it splits on `.`, `_`, and `-` into short pieces,
 * a commit SHA, or pieces that don't look random (a long run of letters and digits, or of mixed case and digits).
 */
function looksLikePath(word) {
  if (!word.includes('/') || /[+=]/u.test(word)) return false;
  for (const piece of word.split(/[/._-]+/u)) {
    if (!piece || /^[0-9a-f]{40}$/u.test(piece)) continue;
    const digits = /\d/u.test(piece);
    if (digits && /[A-Za-z]/u.test(piece) && piece.length >= 16) return false;
    if (digits && /[a-z]/u.test(piece) && /[A-Z]/u.test(piece) && piece.length >= 8) return false;
  }
  return true;
}

/** A ping's kind and message, cleaned, or an InputError that says what to fix. */
export function checkPing({ kind, message }) {
  if (!PING_KINDS.includes(kind)) throw new InputError(`kind is one of ${PING_KINDS.join(', ')}`);
  const text = String(message ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  if (!text) throw new InputError('a ping needs a message: what happened and what you need');
  if (text.length > MAX_MESSAGE)
    throw new InputError(`a ping's message is up to ${MAX_MESSAGE} characters (this is ${text.length})`);
  if (looksLikeSecret(text))
    throw new InputError('that message looks like it holds a token or key; say what happened without it');
  return { kind, message: text };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strings = (v, field) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim()))
    throw new InputError(`${field} is a list of strings`);
  return v.map((s) => s.trim());
};
const only = (change, allowed, where) => {
  for (const key of Object.keys(change)) {
    if (key === 'autostart')
      throw new InputError(`${where}: an agent can't set autostart; the owner chooses that on the board`);
    if (!allowed.includes(key))
      throw new InputError(`${where}: unknown field "${key}" (fields: ${allowed.join(', ')})`);
  }
};
const text = (value, field, max, where, required = false) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InputError(`${where}: ${field} is needed`);
    return undefined;
  }
  if (typeof value !== 'string') throw new InputError(`${where}: ${field} is text`);
  if (value.length > max) throw new InputError(`${where}: ${field} is up to ${max} characters`);
  if (looksLikeSecret(value)) throw new InputError(`${where}: ${field} looks like it holds a token or key`);
  return value.trim();
};
const checkTags = (tags, where) => {
  for (const tag of tags) {
    if (!TAG.test(tag)) throw new InputError(`${where}: "${tag}" isn't a tag name`);
    if (tag.startsWith('horizon-'))
      throw new InputError(`${where}: horizon tags are the owner's choice; a proposal never sets or removes "${tag}"`);
  }
  return tags;
};

/**
 * Checks a proposal against the board as it is now. `ctx`:
 *   tasks    Map of uuid → task properties (the board's replica)
 *   resolve  (ref) → uuid or null
 *   pinged   uuid of the task the ping is about
 *   by       the agent's name
 *   inReview (uuid) → whether an open pull request will finish the task
 * Returns { changes, warnings }: the changes cleaned up, with work IDs upper-cased, and notes the owner
 * should see (a task that would stop waiting for anything). Throws an InputError naming the first problem.
 */
export function validateProposal(raw, ctx) {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.changes) ? raw.changes : null;
  if (!list) throw new InputError('a proposal is a list of changes (or { "changes": [...] })');
  if (new TextEncoder().encode(JSON.stringify(list)).length > MAX_PROPOSAL_BYTES)
    throw new InputError(`a proposal is up to ${MAX_PROPOSAL_BYTES / 1024} KB`);
  if (!list.length) throw new InputError('a proposal with no changes is just a message; leave the proposal out');
  if (list.length > MAX_CHANGES)
    throw new InputError(
      `a proposal is up to ${MAX_CHANGES} changes (this has ${list.length}); split it or ping again after the owner applies this one`,
    );

  const refs = new Set();
  for (const [i, change] of list.entries()) {
    if (change?.type !== 'add') continue;
    const name = String(change.ref ?? '');
    if (!REF.test(name)) throw new InputError(`change ${i + 1} (add): ref is a short lowercase name like n1`);
    if (refs.has(name)) throw new InputError(`change ${i + 1} (add): ref "${name}" is used twice`);
    refs.add(name);
  }

  const name = (node) =>
    node.startsWith('ref:') ? `the new task "${node.slice(4)}"` : (ctx.tasks.get(node)?.wid ?? node.slice(0, 8));
  const existing = (token, where, { open = false } = {}) => {
    const id = String(token ?? '').trim();
    if (!id) throw new InputError(`${where}: name a task`);
    const uuid = ctx.resolve(WID.test(id.toUpperCase()) ? id.toUpperCase() : id);
    if (!uuid) throw new InputError(`${where}: no task "${id}"`);
    if (open && ctx.tasks.get(uuid).status !== 'pending')
      throw new InputError(`${where}: ${name(uuid)} is already ${ctx.tasks.get(uuid).status}`);
    return uuid;
  };
  const nodeOf = (token, where) => {
    const id = String(token ?? '').trim();
    if (refs.has(id)) return { node: `ref:${id}`, token: id };
    const uuid = existing(id, where);
    return { node: uuid, token: ctx.tasks.get(uuid).wid ?? uuid };
  };

  // The open dependency graph: who waits for whom. Closed tasks block nothing, so they leave it.
  const open = (uuid) => ctx.tasks.get(uuid)?.status === 'pending';
  const graph = new Map();
  for (const [uuid, map] of ctx.tasks) if (open(uuid)) graph.set(uuid, new Set(dependsOf(map).filter(open)));
  for (const ref of refs) graph.set(`ref:${ref}`, new Set());
  const edges = (node) => graph.get(node) ?? new Set();

  /** The shortest chain of waits from one task to another, or null. `skip` hides one direct edge. */
  const path = (from, to, skip = null) => {
    const seen = new Set([from]);
    const queue = [[from]];
    while (queue.length) {
      const trail = queue.shift();
      const last = trail.at(-1);
      for (const next of edges(last)) {
        if (skip && last === skip[0] && next === skip[1]) continue;
        if (seen.has(next)) continue;
        if (next === to) return [...trail, next];
        seen.add(next);
        queue.push([...trail, next]);
      }
    }
    return null;
  };
  const chain = (nodes) => nodes.map(name).join(' → ');
  const addEdge = (from, to, where) => {
    if (from === to) throw new InputError(`${where}: ${name(from)} can't wait for itself`);
    if (edges(from).has(to)) throw new InputError(`${where}: ${name(from)} already waits for ${name(to)}`);
    const loop = path(to, from);
    if (loop) throw new InputError(`${where}: that makes a cycle (${chain([from, ...loop])})`);
    const implied = path(from, to);
    if (implied)
      throw new InputError(
        `${where}: ${name(from)} already waits for ${name(to)} through ${chain(implied)}, so the dependency is redundant`,
      );
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  };
  const before = new Map([...graph].map(([node, set]) => [node, set.size]));
  const touched = new Set();

  const changes = [];
  const finished = new Set();
  const deleted = new Set();
  for (const [i, change] of list.entries()) {
    const where = `change ${i + 1} (${change?.type ?? '?'})`;
    if (!isObject(change)) throw new InputError(`${where}: each change is an object`);
    if (change.type === 'add') {
      only(
        change,
        ['type', 'ref', 'title', 'project', 'horizon', 'tags', 'brief', 'done_when', 'depends', 'priority'],
        where,
      );
      const title = text(change.title, 'title', MAX_TITLE, where, true);
      // A new task goes in the pinged task's repository: its areas, or the default repository's when the caller doesn't say.
      const areas = ctx.areas ?? Object.keys(PROJECTS);
      if (!areas.includes(change.project)) throw new InputError(`${where}: project is one of ${areas.join(', ')}`);
      if (!NEW_HORIZONS.includes(change.horizon))
        throw new InputError(`${where}: horizon is one of ${NEW_HORIZONS.join(', ')}`);
      if (change.priority !== undefined && !PRIORITIES.includes(change.priority))
        throw new InputError(`${where}: priority is H, M, or L`);
      const tags = checkTags(strings(change.tags, 'tags'), where);
      if (!tags.some((t) => ['agent', 'owner', 'decide'].includes(t)))
        throw new InputError(`${where}: tags need agent, owner, or decide, so the board knows who does it`);
      const brief = text(change.brief, 'brief', MAX_TEXT, where, true);
      const doneWhen = text(change.done_when, 'done_when', MAX_TEXT, where, true);
      const depends = [];
      const node = `ref:${change.ref}`;
      for (const token of strings(change.depends, 'depends')) {
        const dep = nodeOf(token, `${where} depends`);
        addEdge(node, dep.node, where);
        depends.push(dep.token);
      }
      changes.push({
        type: 'add',
        ref: change.ref,
        title,
        project: change.project,
        horizon: change.horizon,
        tags,
        brief,
        done_when: doneWhen,
        depends,
        ...(change.priority ? { priority: change.priority } : {}),
      });
    } else if (change.type === 'depend') {
      only(change, ['type', 'task', 'add', 'remove'], where);
      const from = nodeOf(change.task, where);
      const add = strings(change.add, 'add');
      const remove = strings(change.remove, 'remove');
      if (!add.length && !remove.length) throw new InputError(`${where}: give add or remove`);
      if (!from.node.startsWith('ref:') && !open(from.node))
        throw new InputError(`${where}: ${name(from.node)} is already ${ctx.tasks.get(from.node).status}`);
      touched.add(from.node);
      const removed = [];
      for (const token of remove) {
        const dep = nodeOf(token, `${where} remove`);
        if (!edges(from.node).has(dep.node))
          throw new InputError(
            `${where}: ${name(from.node)} doesn't wait for ${name(dep.node)}, so there is nothing to remove`,
          );
        graph.get(from.node).delete(dep.node);
        removed.push(dep.token);
      }
      const added = [];
      for (const token of add) {
        const dep = nodeOf(token, `${where} add`);
        if (!dep.node.startsWith('ref:') && !open(dep.node))
          throw new InputError(
            `${where}: ${name(dep.node)} is already ${ctx.tasks.get(dep.node).status}, so nothing needs to wait for it`,
          );
        addEdge(from.node, dep.node, where);
        added.push(dep.token);
      }
      changes.push({ type: 'depend', task: from.token, add: added, remove: removed });
    } else if (change.type === 'modify') {
      only(change, ['type', 'task', 'horizon', 'addTags', 'removeTags', 'brief', 'done_when'], where);
      const uuid = existing(change.task, where, { open: true });
      if (ctx.tasks.get(uuid).claim === ctx.by)
        throw new InputError(
          `${where}: you hold ${name(uuid)}; change your own task directly and propose changes to others`,
        );
      const out = { type: 'modify', task: ctx.tasks.get(uuid).wid ?? uuid };
      if (change.horizon !== undefined) {
        if (!NEW_HORIZONS.includes(change.horizon))
          throw new InputError(`${where}: horizon is one of ${NEW_HORIZONS.join(', ')}`);
        out.horizon = change.horizon;
      }
      const addTags = checkTags(strings(change.addTags, 'addTags'), where);
      const removeTags = checkTags(strings(change.removeTags, 'removeTags'), where);
      if (addTags.length) out.addTags = addTags;
      if (removeTags.length) out.removeTags = removeTags;
      const brief = text(change.brief, 'brief', MAX_TEXT, where);
      const doneWhen = text(change.done_when, 'done_when', MAX_TEXT, where);
      if (brief) out.brief = brief;
      if (doneWhen) out.done_when = doneWhen;
      if (Object.keys(out).length === 2)
        throw new InputError(`${where}: say what changes (horizon, addTags, removeTags, brief, or done_when)`);
      changes.push(out);
    } else if (change.type === 'done') {
      only(change, ['type', 'task', 'note'], where);
      const uuid = existing(change.task, where, { open: true });
      if (ctx.inReview(uuid))
        throw new InputError(`${where}: ${name(uuid)} has an open pull request that finishes it when it merges`);
      if (finished.has(uuid))
        throw new InputError(
          `${where}: ${name(uuid)} is ${deleted.has(uuid) ? 'deleted and finished' : 'finished twice'} in this proposal`,
        );
      finished.add(uuid);
      const note = text(change.note, 'note', MAX_NOTE, where);
      changes.push({ type: 'done', task: ctx.tasks.get(uuid).wid ?? uuid, ...(note ? { note } : {}) });
    } else if (change.type === 'delete') {
      // For a task the agent may not delete itself (IDEA-36 section 6): the owner deletes it in one press.
      only(change, ['type', 'task', 'note'], where);
      const uuid = existing(change.task, where, { open: true });
      const holder = ctx.tasks.get(uuid).claim;
      if (holder === ctx.by) throw new InputError(`${where}: you hold ${name(uuid)}; release it instead`);
      if (holder) throw new InputError(`${where}: ${holder} has ${name(uuid)}; ask them on the peloton`);
      if (ctx.inReview(uuid))
        throw new InputError(`${where}: ${name(uuid)} has an open pull request that finishes it when it merges`);
      if (finished.has(uuid))
        throw new InputError(
          `${where}: ${name(uuid)} is ${deleted.has(uuid) ? 'deleted twice' : 'finished and deleted'} in this proposal`,
        );
      finished.add(uuid);
      deleted.add(uuid);
      const note = text(change.note, 'note', MAX_NOTE, where);
      changes.push({ type: 'delete', task: ctx.tasks.get(uuid).wid ?? uuid, ...(note ? { note } : {}) });
    } else if (change.type === 'release') {
      only(change, ['type', 'task'], where);
      const uuid = existing(change.task, where, { open: true });
      if (uuid !== ctx.pinged) throw new InputError(`${where}: a release is only for the task the ping is about`);
      if (!ctx.tasks.get(uuid).claim) throw new InputError(`${where}: ${name(uuid)} holds no claim`);
      changes.push({ type: 'release', task: ctx.tasks.get(uuid).wid ?? uuid });
    } else {
      throw new InputError(`${where}: type is one of add, depend, modify, done, delete, release`);
    }
  }

  const warnings = [];
  for (const node of touched) {
    if (before.get(node) > 0 && edges(node).size === 0)
      warnings.push(`${name(node)} would no longer wait for anything`);
  }
  for (const uuid of finished) {
    const waiting = [...graph]
      .filter(([node, set]) => set.has(uuid) && !finished.has(node))
      .map(([node]) => name(node));
    if (waiting.length)
      warnings.push(`${deleted.has(uuid) ? 'deleting' : 'finishing'} ${name(uuid)} releases ${waiting.join(', ')}`);
  }
  return { changes, warnings };
}

/** One line for a proposal: what applying it would do. */
export function summarizeProposal(changes) {
  const count = (type) => changes.filter((c) => c.type === type).length;
  const parts = [];
  if (count('add')) parts.push(`add ${count('add')} task${count('add') === 1 ? '' : 's'}`);
  if (count('depend')) parts.push(`change ${count('depend')} dependenc${count('depend') === 1 ? 'y' : 'ies'}`);
  if (count('modify')) parts.push(`edit ${count('modify')} task${count('modify') === 1 ? '' : 's'}`);
  if (count('done')) parts.push(`finish ${count('done')} task${count('done') === 1 ? '' : 's'}`);
  if (count('delete')) parts.push(`delete ${count('delete')} task${count('delete') === 1 ? '' : 's'}`);
  if (count('release')) parts.push('release a claim');
  return parts.join(', ');
}
