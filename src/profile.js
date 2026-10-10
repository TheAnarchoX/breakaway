/**
 * A person's profile (BRK-329, docs/specs/BRK-299-people-and-roles.md, point 1): what they do (their **work**) and a
 * line for agents (their **notes**), the owner's too. It's for pitching how an agent answers, never a permission:
 * src/permissions.js never reads it.
 *
 * Pure: the store keeps the values (people's columns, the owner's in the board's settings) and this checks them and
 * turns them into the run payload's `For:` line.
 */

/** What a person does: one choice, each a single word with a line that helps them pick. `other` takes its own words. */
export const WORKS = [
  { id: 'engineering', label: 'Engineering', description: 'Builds and fixes software' },
  { id: 'design', label: 'Design', description: 'How things look and work for people' },
  { id: 'product', label: 'Product', description: 'Decides what gets built and why' },
  { id: 'writing', label: 'Writing', description: 'Docs, copy, posts' },
  { id: 'operations', label: 'Operations', description: 'Runs infrastructure and keeps things up' },
  { id: 'research', label: 'Research', description: 'Finds things out and reports back' },
  { id: 'organising', label: 'Organising', description: 'Runs a group’s work: campaigns, events, members' },
  { id: 'other', label: 'Other', description: 'A few words of your own' },
];

export const MAX_OTHER = 40;
export const MAX_NOTES = 200;

/**
 * @typedef {{ work: string | null, other: string | null, notes: string | null }} Profile
 */

/** An empty profile: what everyone has until they set one. */
export const NO_PROFILE = Object.freeze({ work: null, other: null, notes: null });

/** One line of text, trimmed, or null when empty; an error when it's too long or holds control characters. */
function cleanLine(value, what, max) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: `${what} must be text` };
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) return { value: null };
  if (text.length > max) return { error: `${what} is at most ${max} characters` };
  if (/[\u0000-\u001f\u007f]/u.test(text)) return { error: `${what} can’t hold control characters` };
  return { value: text };
}

/**
 * A profile change, checked against the current profile: `{ work?, other?, notes? }`, each left as it is when it's
 * missing and cleared by null or empty. `other` is kept only with `work: 'other'`, which needs it.
 * @param {unknown} body
 * @param {Profile} current
 * @returns {{ profile: Profile } | { error: string }}
 */
export function profileChange(body, current = NO_PROFILE) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the profile must be a JSON object' };
  const given = /** @type {Record<string, unknown>} */ (body);
  const unknown = Object.keys(given).find((k) => !['work', 'other', 'notes'].includes(k));
  if (unknown) return { error: `a profile has work, other, and notes, not “${unknown}”` };

  let work = current.work;
  if ('work' in given) {
    if (given.work === null || given.work === '') work = null;
    else if (!WORKS.some((w) => w.id === given.work))
      return { error: `work is one of ${WORKS.map((w) => w.id).join(', ')}, or null` };
    else work = /** @type {string} */ (given.work);
  }
  let other = current.other;
  if ('other' in given) {
    const cleaned = cleanLine(given.other, 'your own words for your work', MAX_OTHER);
    if ('error' in cleaned) return { error: cleaned.error };
    other = cleaned.value;
  }
  if (work !== 'other') other = null;
  else if (!other) return { error: 'say in a few words what you do, or pick another kind of work' };

  let notes = current.notes;
  if ('notes' in given) {
    const cleaned = cleanLine(given.notes, 'your notes for agents', MAX_NOTES);
    if ('error' in cleaned) return { error: cleaned.error };
    notes = cleaned.value;
  }
  return { profile: { work, other, notes } };
}

/** The words for a profile's work: its label, or the person's own words for Other; null when there's none. */
export function workWords(profile) {
  if (!profile?.work) return null;
  if (profile.work === 'other') return profile.other ?? null;
  return WORKS.find((w) => w.id === profile.work)?.label ?? null;
}

/**
 * The run payload's line for the person a run is for: `For: Ana · Design · new to Git`, then whose Claude it runs on
 * when it isn't the owner's start (BRK-302): `For: Ana · on their own Claude routine`. Null when there's nothing to
 * say, so a run for someone who set no profile, on the repository's routine, carries no line.
 * @param {string} name who the run is for, as the board names them
 * @param {Profile | null} profile
 * @param {string | null} [claude] whose Claude it runs on
 */
export function forLine(name, profile, claude = null) {
  const work = workWords(profile);
  const notes = profile?.notes ?? null;
  if (!work && !notes && !claude) return null;
  return `For: ${[name, work, notes, claude].filter(Boolean).join(' · ')}`;
}
