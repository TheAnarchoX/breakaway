/**
 * Similar open tasks (BRK-283): before a task is added, the open tasks in its repository whose title reads much the
 * same, or whose title or description names the same files. Cheap text similarity, no index: a board holds hundreds
 * of open tasks, not millions. Pure, so the Worker refuses with it and the web app shows the same list as you type.
 */

/** Words too common in task titles to say two tasks are alike. */
const STOP = new Set(
  (
    'a an and are as at be by can for from has have how in into is it its of on or so that the their them then ' +
    'there these this to was we when where which while who why will with without you your our not no do does ' +
    'make makes made get gets new add adds added adding task tasks one any all more less'
  ).split(' '),
);

/** A path with a folder (`src/store.js`, `web/src/components/`) or a file with a known extension (`store.js`). */
const FILE = /(?:[\w.-]+\/)+[\w.-]*|[\w-]+\.(?:c?js|mjs|jsx|ts|tsx|json|jsonc|md|css|html|ya?ml|toml|sql|sh)\b/giu;

/** @param {string} word */
function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The words of a title that say what it's about: lowercased, roughly stemmed, without the common ones.
 * @param {unknown} text
 */
export function titleWords(text) {
  const out = new Set();
  for (const raw of String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const word = stem(raw);
    if (!STOP.has(word)) out.add(word);
  }
  return out;
}

/**
 * The files and folders a text names.
 * @param {unknown} text
 */
export function filesNamed(text) {
  const out = new Set();
  for (const match of String(text ?? '').matchAll(FILE)) {
    const parts = match[0]
      .toLowerCase()
      .replace(/[./]+$/u, '')
      .split('/')
      .filter(Boolean);
    const last = parts.at(-1);
    if (!last || !/[a-z]/u.test(last)) continue;
    // A file goes by its name, so `src/store.js` and `store.js` meet; a folder by its whole path, and a single
    // word with a slash (`web/`, `and/or`) names nothing.
    if (last.includes('.')) out.add(last);
    else if (parts.length >= 2 && !/^(?:and|or)$/u.test(last)) out.add(parts.join('/'));
  }
  return out;
}

/**
 * How alike two sets of words are: Dice's coefficient, from 0 to 1.
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function dice(a, b) {
  if (!a.size || !b.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return { score: (2 * shared) / (a.size + b.size), shared };
}

/**
 * The open tasks a new one resembles, most alike first: a title that shares most of its words (at least two), or
 * the same file named with a third of the words in common, or two files named by both.
 * @template {{ description?: string | null, brief?: string | null }} T
 * @param {{ description?: unknown, brief?: unknown }} item the task about to be added
 * @param {T[]} candidates the open tasks to compare it with
 * @param {{ limit?: number }} [options]
 * @returns {{ task: T, score: number, files: string[] }[]}
 */
export function similarTasks(item, candidates, { limit = 5 } = {}) {
  const words = titleWords(item.description);
  const files = filesNamed(`${item.description ?? ''}\n${item.brief ?? ''}`);
  if (!words.size && !files.size) return [];
  const found = [];
  for (const task of candidates) {
    const title = dice(words, titleWords(task.description));
    const theirs = filesNamed(`${task.description ?? ''}\n${task.brief ?? ''}`);
    const both = [...files].filter((f) => theirs.has(f));
    const alike =
      (title.shared >= 2 && title.score >= 0.5) || (both.length >= 1 && title.score >= 0.3) || both.length >= 2;
    if (alike) found.push({ task, score: title.score + both.length / 10, files: both });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * One line per similar task, the way the CLI and the MCP server say it: `BRK-264 Title (claimed by x)`.
 * @param {{ wid?: string | null, short?: string, description?: string, claim?: string | null }} task
 */
export function similarLine(task) {
  return `${task.wid ?? task.short ?? '?'} ${task.description ?? ''}${task.claim ? ` (claimed by ${task.claim})` : ''}`;
}
