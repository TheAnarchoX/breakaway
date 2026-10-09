/**
 * Footprints (IDEA-55, sections 1 and 2): the files a task will touch, as patterns, and whether two of them can meet.
 * Pure: no store, no network. A pattern is a file (`src/store-chase.js`), a folder ending in `/` (`web/src/views/`,
 * every file under it), or a glob (`apps/web/api/**`, `test/*.test.js`, `src/infra-?.js`) with `*` (any name in one
 * folder), `**` (any depth), and `?` (one character), from the repository's root. No braces or negation.
 */

import { similarTasks } from './similar.js';

/** @typedef {'named' | 'spec' | 'related' | 'similar'} FootprintSource where a pattern came from */
/** @typedef {{ pattern: string, source: FootprintSource }} FootprintPath */
/**
 * A predicted footprint: `known` is false when nothing was found, and the task is scheduled the old way. `shared` is
 * the shared files left out, shown with it so nobody wonders why a file was ignored.
 * @typedef {{ known: boolean, paths: FootprintPath[], shared: string[] }} Footprint
 */
/**
 * A task as the prediction reads it: its title, description, done when, and comments.
 * @typedef {{ description?: string | null, brief?: string | null, done_when?: string | null,
 *   comments?: ({ text?: string | null } | string)[] | null }} FootprintTask
 */
/** A completed task with the files its merged pull requests changed. @typedef {FootprintTask & { files: string[] }} Done */
/** @typedef {{ path: string, why: 'lockfile' | 'common', share: number }} SharedFile */

/** How many merged pull requests `sharedFiles` reads, and the share of them a file must exceed to count as shared. */
export const SHARED_WINDOW = 50;
export const SHARED_SHARE = 0.4;
/** How many of the closest similar tasks the prediction reads, and how many must have changed a file to keep it. */
const SIMILAR = 5;
const SIMILAR_AGREE = 2;

/** Lockfiles, in any folder: git merges them badly but tools regenerate them, so they never make footprints meet. */
const LOCKFILE =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|flake\.lock|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/u;

/**
 * A pattern a text names: like `filesNamed` in src/similar.js (a path with a folder, or a file with a known
 * extension), with globs allowed, and never a URL's or a route's tail, a package scope, or a home folder.
 */
const NAMED =
  /(?<![\w.*?:/@~-])(?:[\w.*?-]+\/)+[\w.*?-]*|(?<![\w.*?:/@~-])[\w*?-]+\.(?:c?js|mjs|jsx|ts|tsx|json|jsonc|md|css|html|ya?ml|toml|sql|sh)\b/gu;
/** Runtimes and libraries that read like a file. */
const NOT_A_FILE = /^(?:node|next|nuxt|vue|deno|bun|three|chart|express|socket\.io)\.js$/iu;

/**
 * A pattern as the board keeps it: from the root, no `./`, one slash at a time, a folder ending in `/`.
 * @param {string} pattern
 */
export function normalize(pattern) {
  return String(pattern ?? '')
    .trim()
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/^(?:\.\/|\/)+/u, '');
}

/** @param {string} pattern a normalized pattern, as segments, a folder ending in `**` */
function segments(pattern) {
  const clean = normalize(pattern);
  if (!clean) return [];
  const parts = clean.split('/');
  if (parts.at(-1) === '') parts[parts.length - 1] = '**';
  // Two `**` in a row say no more than one.
  return parts.filter((part, i) => part !== '' && !(part === '**' && parts[i - 1] === '**'));
}

/** @param {string} segment */
const wild = (segment) => /[*?]/u.test(segment);

/** @param {string} segment one segment of a glob, as a regular expression for one segment of a path */
function segmentRegex(segment) {
  const body = segment
    .replace(/\*+/gu, '*')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '[^/]');
  return new RegExp(`^${body}$`, 'u');
}

/**
 * Whether two segments of a pattern can match one segment of a path. A literal against a glob is exact; two globs
 * meet unless their fixed starts or ends disagree, which is conservative: `a*b` and `*c` never meet, `a*` and `*b`
 * might.
 * @param {string} a
 * @param {string} b
 */
function segmentsMeet(a, b) {
  if (!wild(a) && !wild(b)) return a === b;
  if (!wild(a)) return segmentRegex(b).test(a);
  if (!wild(b)) return segmentRegex(a).test(b);
  const head = (/** @type {string} */ s) => s.slice(0, s.search(/[*?]/u));
  const tail = (/** @type {string} */ s) => s.slice(Math.max(s.lastIndexOf('*'), s.lastIndexOf('?')) + 1);
  const [ha, hb, ta, tb] = [head(a), head(b), tail(a), tail(b)];
  return (ha.startsWith(hb) || hb.startsWith(ha)) && (ta.endsWith(tb) || tb.endsWith(ta));
}

/**
 * Whether two lists of segments can match one path, `**` matching any number of segments.
 * @param {string[]} a
 * @param {string[]} b
 * @param {(x: string, y: string) => boolean} meet
 */
function sequencesMeet(a, b, meet) {
  /** @type {Map<number, boolean>} */
  const seen = new Map();
  /** @param {number} i @param {number} j @returns {boolean} */
  const from = (i, j) => {
    const key = i * (b.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) return known;
    let out;
    if (i === a.length && j === b.length) out = true;
    else if (a[i] === '**') out = from(i + 1, j) || (j < b.length && from(i, j + 1));
    else if (b[j] === '**') out = from(i, j + 1) || (i < a.length && from(i + 1, j));
    else if (i === a.length || j === b.length) out = false;
    else out = meet(a[i], b[j]) && from(i + 1, j + 1);
    seen.set(key, out);
    return out;
  };
  return from(0, 0);
}

/**
 * Whether a pattern matches a path from the repository's root. A folder matches itself and everything under it.
 * @param {string} pattern
 * @param {string} path
 */
export function matches(pattern, path) {
  const file = normalize(path).replace(/\/$/u, '').split('/').filter(Boolean);
  if (!file.length) return false;
  const glob = segments(pattern);
  if (!glob.length) return false;
  return sequencesMeet(glob, file, (part, name) => segmentRegex(part).test(name));
}

/**
 * Whether two patterns can match the same path, without a file list: segment by segment, conservative, so it says
 * yes unless some segment rules it out. A false overlap only makes a task wait; a missed one costs a merge conflict.
 * @param {string} a
 * @param {string} b
 */
export function overlaps(a, b) {
  const [x, y] = [segments(a), segments(b)];
  if (!x.length || !y.length) return false;
  return sequencesMeet(x, y, segmentsMeet);
}

/**
 * Whether a file is shared: a lockfile, or one of `sharedFiles`' list. Shared files never make footprints overlap.
 * @param {string} path
 * @param {Iterable<string | SharedFile>} [shared]
 */
export function isShared(path, shared = []) {
  const file = normalize(path);
  if (LOCKFILE.test(file)) return true;
  for (const item of shared) if (normalize(typeof item === 'string' ? item : item.path) === file) return true;
  return false;
}

/**
 * The shared file a pattern names, or null: a file by its path, or a bare file name (`**\/pnpm-lock.yaml`) that's a
 * lockfile. A folder or any other glob is never shared, even when it covers a shared file.
 * @param {string} pattern
 * @param {(string | SharedFile)[]} shared
 */
function sharedPath(pattern, shared) {
  const file = normalize(pattern).replace(/^\*\*\//u, '');
  if (!file || wild(file) || file.endsWith('/')) return null;
  if (file !== normalize(pattern) && !LOCKFILE.test(file)) return null;
  return isShared(file, shared) ? file : null;
}

/**
 * The files most changes touch, which git merges cleanly or tools regenerate: lockfiles, and the files more than
 * `share` of the last `window` merged pull requests changed. Most common first.
 * Checked on breakaway's own history (9 Oct 2026, the last 50 merges to main): docs/tasks.md was in 22 (44%), the
 * next ones in 15 (site/public/llms-full.txt, 30%) and 13 (src/store.js, web/src/styles/app.css, 26%), so 40% keeps
 * the manual and nothing that's code.
 * @param {{ files?: string[] | null }[]} history merged pull requests, newest first
 * @param {{ window?: number, share?: number }} [options]
 * @returns {SharedFile[]}
 */
export function sharedFiles(history, { window = SHARED_WINDOW, share = SHARED_SHARE } = {}) {
  const pulls = (history ?? []).slice(0, window);
  /** @type {Map<string, number>} */
  const count = new Map();
  for (const pull of pulls) {
    for (const file of new Set((pull.files ?? []).map(normalize).filter(Boolean))) {
      count.set(file, (count.get(file) ?? 0) + 1);
    }
  }
  /** @type {SharedFile[]} */
  const out = [];
  for (const [path, n] of count) {
    const part = n / pulls.length;
    if (LOCKFILE.test(path)) out.push({ path, why: 'lockfile', share: part });
    else if (part > share) out.push({ path, why: 'common', share: part });
  }
  return out.sort((a, b) => b.share - a.share || a.path.localeCompare(b.path));
}

/**
 * The patterns a text names, kept as named: a file by its path, a bare file name in any folder (`store.js` is
 * `**\/store.js`), and a path whose last part has no extension as a folder.
 * @param {unknown} text
 */
export function pathsNamed(text) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const match of String(text ?? '').matchAll(NAMED)) {
    let pattern = normalize(match[0].replace(/[.?:,;]+$/u, ''));
    const parts = pattern.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (!last || !/[a-z]/iu.test(pattern) || NOT_A_FILE.test(pattern)) continue;
    if (parts.length === 1) {
      // A file named alone, or a one-word folder (`web/`), which names too little to keep.
      if (pattern.endsWith('/') || !last.includes('.')) continue;
      pattern = `**/${last}`;
    } else if (!last.includes('.') && !wild(last)) {
      if (/^(?:and|or)$/iu.test(last)) continue;
      pattern = `${parts.join('/')}/`;
    }
    out.add(pattern);
  }
  return [...out];
}

/** @param {FootprintTask} task its own words: title, description, done when, and comments */
function taskText(task) {
  const comments = (task.comments ?? []).map((c) => (typeof c === 'string' ? c : (c?.text ?? '')));
  return [task.description, task.brief, task.done_when, ...comments].filter(Boolean).join('\n');
}

/** @param {string} pattern the folder a pattern is in, or itself if it's a folder; null for a bare file name */
function folderOf(pattern) {
  if (pattern.startsWith('**/')) return null;
  if (pattern.endsWith('/')) return pattern;
  const cut = pattern.lastIndexOf('/');
  return cut < 0 ? null : pattern.slice(0, cut + 1);
}

/**
 * What a task will touch, before an agent starts, in order of weight: the paths it names (description, done when,
 * comments, and its spec); paths its related tasks name in the same folder; then the files the closest similar
 * completed tasks changed (`similarTasks`' scoring, the five closest with files): a file two of them changed is
 * kept, otherwise its folder, so a weak guess is wide rather than wrong. Shared files are left out. A prediction is
 * never a claim: it only decides what starts.
 * @param {FootprintTask} task
 * @param {{ spec?: string | null, related?: FootprintTask[], history?: Done[],
 *   shared?: Iterable<string | SharedFile> }} [context]
 * @returns {Footprint}
 */
export function predictFootprint(task, { spec = null, related = [], history = [], shared = [] } = {}) {
  const sharedList = [...shared];
  /** @type {Map<string, FootprintSource>} */
  const found = new Map();
  /** @type {Set<string>} */
  const left = new Set();
  /** @param {string} pattern @param {FootprintSource} source */
  const keep = (pattern, source) => {
    const file = sharedPath(pattern, sharedList);
    if (file) left.add(file);
    else if (!found.has(pattern)) found.set(pattern, source);
  };

  for (const pattern of pathsNamed(taskText(task))) keep(pattern, 'named');
  for (const pattern of pathsNamed(spec)) keep(pattern, 'spec');

  const folders = new Set([...found.keys()].map(folderOf).filter(Boolean));
  for (const other of related ?? []) {
    for (const pattern of pathsNamed(taskText(other))) {
      if (folders.has(folderOf(pattern))) keep(pattern, 'related');
    }
  }

  const done = (history ?? []).filter((t) => t.files?.length);
  /** @type {Map<string, number>} */
  const changed = new Map();
  for (const { task: like } of similarTasks(task, done, { limit: SIMILAR })) {
    for (const file of new Set(like.files.map(normalize).filter(Boolean))) {
      if (isShared(file, sharedList)) left.add(file);
      else changed.set(file, (changed.get(file) ?? 0) + 1);
    }
  }
  for (const [file, n] of changed) {
    const folder = folderOf(file);
    keep(n >= SIMILAR_AGREE || !folder ? file : folder, 'similar');
  }

  const paths = [...found].map(([pattern, source]) => ({ pattern, source }));
  return { known: paths.length > 0, paths, shared: [...left].sort() };
}

/**
 * The first pair of patterns two footprints share, or null. Shared files never count.
 * @param {(string | FootprintPath)[]} a
 * @param {(string | FootprintPath)[]} b
 * @param {{ shared?: Iterable<string | SharedFile> }} [options]
 * @returns {{ a: string, b: string } | null}
 */
export function footprintsOverlap(a, b, { shared = [] } = {}) {
  const sharedList = [...shared];
  const own = (/** @type {(string | FootprintPath)[]} */ list) =>
    (list ?? [])
      .map((p) => normalize(typeof p === 'string' ? p : p.pattern))
      .filter((p) => p && !sharedPath(p, sharedList));
  const theirs = own(b);
  for (const x of own(a)) for (const y of theirs) if (overlaps(x, y)) return { a: x, b: y };
  return null;
}

/**
 * How well a prediction did: the share of the files a pull request changed that it covered, shared files aside.
 * Null when it changed nothing that counts.
 * @param {(string | FootprintPath)[]} predicted
 * @param {string[]} changed
 * @param {{ shared?: Iterable<string | SharedFile> }} [options]
 */
export function hitRate(predicted, changed, { shared = [] } = {}) {
  const sharedList = [...shared];
  const patterns = (predicted ?? []).map((p) => (typeof p === 'string' ? p : p.pattern));
  const files = [...new Set((changed ?? []).map(normalize).filter(Boolean))].filter((f) => !isShared(f, sharedList));
  if (!files.length) return null;
  return files.filter((f) => patterns.some((p) => matches(p, f))).length / files.length;
}
