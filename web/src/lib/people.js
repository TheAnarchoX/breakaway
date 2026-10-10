// Who is signed in, and what they may do (WEB-124, docs/specs/BRK-299-people-and-roles.md, points 1 to 3): the owner
// (the board's token, or a passkey of theirs) or a person the owner invited, with a role in each repository. The
// role checks are src/permissions.js's, the same table every gate on the Worker asks, so a control the board shows as
// not yours is one the Worker would refuse.
import { computed, signal } from '@preact/signals';
import { ACTIONS, OWNER, refusal, roleIn } from '../../../src/permissions.js';
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
  return w && !w.owner ? { person: w.handle, grants: w.grants, press: true } : { person: OWNER, grants: [], press: true };
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
