// Who is signed in, and what they may do (WEB-124, docs/specs/BRK-299-people-and-roles.md, points 1 to 3): the owner
// (the board's token, or a passkey of theirs) or a person the owner invited, with a role in each repository. The
// role checks are src/permissions.js's, the same table every gate on the Worker asks, so a control the board shows as
// not yours is one the Worker would refuse.
import { computed, signal } from '@preact/signals';
import { ACTIONS, OWNER, ROLE_RANK, refusal, roleIn } from '../../../src/permissions.js';
import { api } from './api.js';

/**
 * Who this browser is signed in as: the owner, or a person with their grants. Null until /api/me answers.
 * @type {import('@preact/signals').Signal<null | { owner: boolean, handle: string, name: string | null, label: string, grants: { repository: string, role: string }[] }>}
 */
export const whoami = signal(null);

/** Whether the signed-in person is the owner. An install where nobody is invited is always the owner's. */
export const isOwner = computed(() => whoami.value === null || whoami.value.owner);

/** The signed-in person's own settings, from GET /api/me: their passkeys, and a person's tokens and sessions. */
export const mine = signal({ loaded: false, data: /** @type {any} */ (null), error: null });

/** Who's on the board, from GET /api/people: people and invites. Only for whoever may see them. */
export const people = signal({ loaded: false, data: /** @type {any} */ (null), error: null });

/** Loads who's signed in. `session` is /api/session's answer: a person's carries them, the owner's doesn't. */
export async function loadWhoami(session) {
  if (session?.person) {
    whoami.value = {
      owner: false,
      handle: session.person.handle,
      name: session.person.name,
      label: session.person.name,
      grants: [],
    };
  }
  await loadMine();
}

export async function loadMine() {
  try {
    const data = await api('me');
    mine.value = { loaded: true, data, error: null };
    const p = data.person;
    whoami.value = p.owner
      ? { owner: true, handle: OWNER, name: p.name ?? null, label: p.name ?? 'You', grants: [] }
      : { owner: false, handle: p.handle, name: p.name, label: p.name, grants: data.grants ?? [] };
  } catch (error) {
    mine.value = { ...mine.value, loaded: true, error: error.message };
  }
}

/** Loads who's on the board once, for the views that name people (an assignee, the filter); Settings reloads it. */
let asked = false;
export function ensurePeople() {
  if (asked || people.value.loaded) return;
  asked = true;
  loadPeople();
}

export async function loadPeople() {
  try {
    people.value = { loaded: true, data: await api('people'), error: null };
  } catch (error) {
    people.value = { ...people.value, loaded: true, error: error.message };
  }
}

/** The roles, highest first, with what each adds (the spec's point 3), for the invite form and the grants editor. */
export const ROLES = [
  { id: 'maintainer', label: 'Maintainer', hint: 'Merges, deploys, approves, and starts agents' },
  { id: 'member', label: 'Member', hint: 'Works on tasks and starts agents on their own Claude' },
  { id: 'viewer', label: 'Viewer', hint: 'Sees everything in the repository, changes nothing' },
];

/** The signed-in person as the permissions module takes them: a press, since this is the signed-in web board. */
const actor = () => {
  const w = whoami.value;
  return w && !w.owner
    ? { person: w.handle, grants: w.grants, press: true }
    : { person: OWNER, grants: [], press: true };
};

/** The signed-in person's role in a repository (null with none), or 'owner'. */
export const roleHere = (repository) => (isOwner.value ? 'owner' : roleIn(whoami.value?.grants, repository));

/** Whether the signed-in person may do `action` in `repository` (null: an install-wide action). */
export const may = (action, repository = null) => refusal(actor(), action, repository) === null;

/**
 * Who can, when the signed-in person can't: "Only a maintainer of widgets can merge a pull request." Null when they
 * can. It's what a control a role can't use says, instead of hiding without a word.
 * @param {string} action an action in src/permissions.js
 * @param {string | null} [repository] the repository's slug, or null for an install-wide action
 * @param {{ what?: string, name?: string }} [words] the action in the control's own words, when they say it better
 *   than the table does, and the repository's name for people
 */
export function whoCan(action, repository = null, { what, name } = {}) {
  const no = refusal(actor(), action, repository);
  if (!no) return null;
  const rule = ACTIONS[action];
  const doing = what ?? rule?.what ?? action;
  if (no.code === 'owner') return `Only the owner can ${doing}.`;
  if (no.code !== 'role') return `${no.message.charAt(0).toUpperCase()}${no.message.slice(1)}.`;
  const role = rule.role === 'maintainer' ? 'a maintainer' : rule.role === 'member' ? 'a member' : 'a viewer';
  return repository
    ? `Only ${role} of ${name ?? repository} or the owner can ${doing}.`
    : `Only ${role} of every repository or the owner can ${doing}.`;
}

/** A role, as people read it. */
export const roleLabel = (role) => ROLES.find((r) => r.id === role)?.label ?? role;

/** A grant's repository, as people read it: `*` is every repository. */
export const repoWords = (repository, nameOf = (s) => s) =>
  repository === '*' ? 'every repository' : nameOf(repository);

/** How long ago, in words, for last seen and last used: "today", "yesterday", "3 days ago", or a date. */
export function ago(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString();
}

/** The link an invite's code makes, to copy and share by hand. Shown once: the board keeps only its hash. */
export const inviteLink = (code) => `${location.origin}/#/join/${code}`;

// ---- Who does it (WEB-133, docs/specs/BRK-299-people-and-roles.md, section 11) ----------------------------------

/** The signed-in person's handle, as a task's assignee names them: `owner` for the owner. */
export const myHandle = computed(() => (isOwner.value ? OWNER : whoami.value.handle));

/** The people on the board by handle, removed ones too (their handle stays on what they did). */
const byHandle = computed(() => new Map((people.value.data?.people ?? []).map((p) => [p.handle, p])));

/**
 * A person as the board names them in a sentence: "you", "the owner", their name, or their handle while the people
 * list hasn't loaded (or they share no repository with you).
 * @param {string} handle
 */
export function personName(handle) {
  if (handle === myHandle.value) return 'you';
  if (handle === OWNER) return 'the owner';
  return byHandle.value.get(handle)?.name ?? handle;
}

/** The same, at the start of a sentence or as a label: "You", "The owner", or their name. */
export const personLabel = (handle) => {
  const name = personName(handle);
  return handle === myHandle.value || handle === OWNER ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
};

/**
 * Who a person's task in `repository` can be assigned to, the way the Worker checks it (src/store.js,
 * checkAssignee): the owner, and everyone holding member or maintainer there (a viewer reads the board, so the work
 * can't be theirs). You first, then the owner, then the rest by name. A handle that's assigned already stays in the
 * list, so the picker shows it even after their role changed.
 * @param {string} repository the task's repository's slug
 * @param {string | null} [keep] the task's assignee now
 * @returns {{ handle: string, label: string }[]}
 */
export function assignable(repository, keep = null) {
  const can = (p) => !p.removed && (ROLE_RANK[roleIn(p.grants, repository)] ?? 0) >= ROLE_RANK.member;
  const handles = new Set([myHandle.value, OWNER]);
  for (const p of [...byHandle.value.values()].filter(can).sort((a, b) => a.name.localeCompare(b.name)))
    handles.add(p.handle);
  if (keep) handles.add(keep);
  // A person who can't take the work (a viewer) never sees themselves offered.
  const mine = isOwner.value ? ROLE_RANK.maintainer : (ROLE_RANK[roleIn(whoami.value?.grants, repository)] ?? 0);
  if (mine < ROLE_RANK.member && keep !== myHandle.value) handles.delete(myHandle.value);
  return [...handles].map((handle) => ({ handle, label: personLabel(handle) }));
}

/**
 * Whether the next step of an open task is the signed-in person's: a decision they may answer, or a person's task
 * assigned to them, or to nobody in a repository where they may do the work.
 * @param {{ who?: string | null, assignee?: string | null, decision?: any, decisionAnswers?: any }} t
 * @param {string} repository the task's repository's slug
 */
export function forMe(t, repository) {
  if (t.who === 'decision' || (t.decision && !t.decisionAnswers)) return may('decision.answer', repository);
  if (t.who !== 'person') return false;
  return t.assignee ? t.assignee === myHandle.value : may('task.write', repository);
}
