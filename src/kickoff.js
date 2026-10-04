/**
 * Kickoff (docs/specs/IDEA-26-kickoff.md, sections 1 to 3): a new project from a pitch. What a kickoff is, the
 * name, slug, and work-ID prefix it suggests, github.com's own form to create its repository, and the IDEA it
 * becomes once that repository is registered. Pure, so it's tested without the Durable Object; the table and
 * the API are in store-kickoffs.js, and the steps are the Add a repository wizard's (wizard.js).
 */
import { InputError } from './model.js';
import { SHARED_AREAS } from './repos.js';
import { slugFrom } from './wizard.js';

/** As long as a pitch may be: an idea's own limit on the web board. */
export const MAX_PITCH = 4000;
/** The one area a kickoff registers with, unless the person changes it under More options. */
export const KICKOFF_AREA = 'app';
/** The tag that marks a kickoff's IDEA, for the kickoff mode (BRK-134) and the Kickoff view. */
export const KICKOFF_TAG = 'kickoff-project';

const GITHUB_NAME = /^[\w.-]{1,100}$/u;
const GITHUB_OWNER = /^[\w-]{1,39}$/u;
/** Words a name is better without: "A tool for tracking plants" is plants-tracking-tool's, not a-tool-for's. */
const FILLER = new Set(
  'a an the and or but of for to in on at by with from into my our your their its i we me us it this that these those is are be want wants would like make build app something some thing way new'.split(
    ' ',
  ),
);

/** The pitch's first line with words in it, as an idea's title is (web/src/components/NewTask.jsx). */
export function pitchTitle(pitch) {
  const line =
    String(pitch ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

/** A pitch as it's kept: trimmed, not empty, and no longer than an idea may be. */
export function checkPitch(pitch) {
  const text = String(pitch ?? '').trim();
  if (!text) throw new InputError('say what you want to make first, in your own words');
  if (text.length > MAX_PITCH)
    throw new InputError(`the pitch can be up to ${MAX_PITCH} characters; put the rest in the interview`);
  return text;
}

/**
 * A repository name suggested from the pitch's first line: up to three words that say what it is, lowercase,
 * joined by hyphens. Null when the line has no word to make one from.
 */
export function suggestName(pitch) {
  const words = (
    pitchTitle(pitch)
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  ).filter((w) => !/^\d+$/u.test(w));
  const kept = words.filter((w) => !FILLER.has(w));
  const name = (kept.length ? kept : words).slice(0, 3).join('-');
  return slugFrom(name);
}

/** A repository name as GitHub takes it: letters, digits, `.`, `-`, and `_`, with spaces as hyphens. */
export function checkName(name) {
  const text = String(name ?? '')
    .trim()
    .replace(/\s+/gu, '-');
  if (!GITHUB_NAME.test(text) || /^\.+$/u.test(text))
    throw new InputError('the name is letters, digits, hyphens, dots, and underscores, like plant-diary');
  if (!slugFrom(text)) throw new InputError('the name needs a letter in it, like plant-diary');
  return text;
}

/**
 * Work-ID prefixes for a name, best first: three capitals from its words' initials, then its first letter with
 * the consonants after it, then any later letters in order, and four letters when every three-letter one is taken.
 * Never IDEA or RUN, which every repository shares.
 */
export function prefixCandidates(name) {
  const words = String(name ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .map((w) => w.replace(/[^A-Z]/gu, ''))
    .filter(Boolean);
  const letters = words.join('');
  const out = [];
  const add = (prefix) => {
    if (/^[A-Z]{3,4}$/u.test(prefix) && !Object.values(SHARED_AREAS).includes(prefix) && !out.includes(prefix))
      out.push(prefix);
  };
  if (!letters) return out;
  if (words.length >= 3)
    add(
      words
        .map((w) => w[0])
        .join('')
        .slice(0, 3),
    );
  const consonants = letters.slice(1).replace(/[AEIOU]/gu, '');
  add(letters[0] + consonants.slice(0, 2));
  add(letters.slice(0, 3));
  for (const size of [3, 4]) {
    // The first letter always leads, so the prefix still reads as the name's; then every later choice, in order.
    const rest = letters.slice(1);
    const pick = (from, need, chosen) => {
      if (out.length >= 60) return;
      if (!need) return add(letters[0] + chosen);
      for (let i = from; i <= rest.length - need; i++) pick(i + 1, need - 1, chosen + rest[i]);
    };
    pick(0, size - 1, '');
  }
  // A name too short for three letters still gets a prefix: its letters, padded with X.
  if (!out.length) for (const keep of [3, 2, 1]) add(`${letters.slice(0, keep)}XX`.slice(0, 3));
  return out;
}

/** The first of `candidates` that `taken` doesn't refuse, or null. */
export const firstFree = (candidates, taken) => candidates.find((c) => !taken(c)) ?? null;

/** A slug that `taken` doesn't refuse: `base`, then `base-2`, `base-3`, … */
export function freeSlug(base, taken) {
  if (!base) return null;
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const slug = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    if (!taken(slug)) return slug;
  }
  return null;
}

/** `owner/name` from what someone gave, or null when it isn't one. */
export function githubOf(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '');
  const [owner, name, extra] = text.split('/');
  if (extra !== undefined || !GITHUB_OWNER.test(owner ?? '') || !GITHUB_NAME.test(name ?? '')) return null;
  return `${owner}/${name}`;
}

/**
 * github.com's own form to create the repository, filled in: its name, private, and the pitch's first line as
 * its description. The board can't create one through its App on a personal account, so the person presses Create.
 */
export function createUrl({ name, github = null, pitch = '' }) {
  const params = new URLSearchParams();
  const owner = github ? github.split('/')[0] : null;
  if (owner) params.set('owner', owner);
  params.set('name', github ? github.split('/')[1] : name);
  params.set('visibility', 'private');
  const description = pitchTitle(pitch).slice(0, 350);
  if (description) params.set('description', description);
  return `https://github.com/new?${params.toString().replaceAll('+', '%20')}`;
}

/**
 * Whether a task is a kickoff's IDEA: an idea tagged as a kickoff's. Starting an agent on one sends `Mode: kickoff`
 * (BRK-134), and answering its decision keeps it open, since its plan's pull request closes it.
 */
export function isKickoffIdea(task) {
  if (!task) return false;
  const tags = Array.isArray(task.tags) ? task.tags : [];
  const tagged = tags.includes(KICKOFF_TAG) || Boolean(task[`tag_${KICKOFF_TAG}`]);
  return tagged && task.project === 'ideas';
}

/**
 * The IDEA a kickoff becomes in its new repository: the pitch as its description, word for word, its first
 * line as the title, horizon next, and tagged so the kickoff mode and the Kickoff view can find it.
 */
export function kickoffIdea(kickoff) {
  return {
    description: pitchTitle(kickoff.pitch),
    brief: kickoff.pitch,
    project: 'ideas',
    repo: kickoff.slug,
    horizon: 'next',
    tags: ['agent', 'idea', KICKOFF_TAG],
  };
}
