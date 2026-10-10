// Avatars on the board (WEB-134, docs/specs/ID-9-avatars.md): a person's pattern from their seed, an agent's upright
// glyph from its name, drawn by the brand's own generator (brand/avatar.js), so the board shows what the brand sheet
// does. An avatar is decoration: the name always shows beside it, or in the label of what holds it.
import { computed, signal } from '@preact/signals';
import { agent, person, tokenColors } from '../../../brand/avatar.js';
import { api } from './api.js';
import { loadPeople, people, whoami } from './people.js';

/** The signed-in person's seed and the owner's, from GET /api/me/avatar. Null until it answers. */
export const ownSeeds = signal(/** @type {null | { avatar: string, owner: string }} */ (null));

/**
 * Who draws as a person, and from which seed: the owner, and everyone in the people list. A person's handle is their
 * seed until they shuffle. Everyone else (an agent, the board, a routine) draws as an agent, from its name.
 */
export const seeds = computed(() => {
  const map = new Map([['owner', ownSeeds.value?.owner ?? 'owner']]);
  for (const p of people.value.data?.people ?? []) map.set(p.handle, p.avatar ?? p.handle);
  const w = whoami.value;
  if (w && !w.owner && ownSeeds.value) map.set(w.handle, ownSeeds.value.avatar);
  return map;
});

/** Loads the seeds: the signed-in person's and the owner's, and the people list's. */
export async function loadAvatars() {
  try {
    ownSeeds.value = await api('me/avatar');
  } catch {
    // Without them, everyone draws from their handle: the same as before anyone shuffled.
  }
  if (!people.value.loaded) await loadPeople();
}

/** Shuffle: a new random seed for the signed-in person, kept until they shuffle again. */
export async function shuffleAvatar() {
  ownSeeds.value = await api('me/avatar', { method: 'POST', body: {} });
}

/** The avatars drawn so far, by kind, seed, and size: the generator is pure, so each is drawn once. */
const drawn = new Map();

/**
 * One avatar, `size` px square, for `name`: a person's handle (or `owner`), or an agent's name.
 * @param {{ name: string, size?: number, class?: string }} props
 */
export function Avatar({ name, size = 24, class: extra = '' }) {
  const handle = String(name ?? '');
  const known = seeds.value.get(handle);
  const key = `${known === undefined ? 'a' : 'p'}:${known ?? handle}:${size}`;
  let avatar = drawn.get(key);
  if (!avatar) {
    avatar = known === undefined ? agent(handle, size) : person(known, size);
    drawn.set(key, avatar);
  }
  const colors = tokenColors(avatar.tint);
  return (
    <svg
      class={`avatar avatar-${avatar.kind} ${extra}`.trim()}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {avatar.shapes.map(({ d, role }) =>
        role === 'edge' ? (
          <path key={role} d={d} fill="none" stroke={colors.edge} stroke-width={100 / size} />
        ) : (
          <path key={d} d={d} fill={colors[role]} />
        ),
      )}
    </svg>
  );
}

/**
 * A name with its avatar before it, for a line of text: `label` is how the name reads there ("You", "The board"),
 * `name` whose avatar it is.
 * @param {{ name: string, label?: import('preact').ComponentChildren, size?: number, class?: string }} props
 */
export function Named({ name, label = name, size = 24, class: extra = '' }) {
  return (
    <span class={`named ${extra}`.trim()}>
      <Avatar name={name} size={size} />
      {label}
    </span>
  );
}
