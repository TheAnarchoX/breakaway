/**
 * A repository's specs (docs/specs/IDEA-31-specs-view.md, sections 1 and 2): where they are, and what the board
 * reads from each file. Pure, so it's tested without the Durable Object; reading them through GitHub is in
 * store-specs.js. The board never stores a spec: it reads the files on the default branch when asked.
 */
import { InputError } from './model.js';

/** Where a repository keeps its specs when its settings don't say: where breakaway and the template put them. */
export const DEFAULT_SPECS_DIR = 'docs/specs';
/** The largest spec the board reads; a bigger one is a link to GitHub. */
export const SPEC_MAX_BYTES = 1_048_576;
const SPECS_DIR = /^(?!\/)(?!.*\.\.)[\w./-]{1,200}$/u;
const SPEC_NAME = /^[\w.-]{1,200}\.md$/u;
const WID = /^([A-Z]{2,8}-\d+)(?:[-.]|$)/u;

/**
 * A repository's specs directory as the owner sets it (`settings.specs`): a relative directory, with no `..`,
 * of at most 200 characters, checked like `routine.prompt`. Empty or null means the default, so it's left out.
 * @param {unknown} value
 * @returns {string | null}
 */
export function checkSpecsDir(value) {
  if (value === null || value === undefined || value === '') return null;
  const dir = String(value).trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!SPECS_DIR.test(dir) || dir.split('/').some((part) => part === '' || part === '.'))
    throw new InputError('settings.specs is a directory in the repository, like docs/specs');
  return dir;
}

/**
 * A repository's `settings`, checked: its specs directory (`specs`) when it has one; the rest is kept as it is.
 * @param {Record<string, any> | null} settings
 */
export function checkSettings(settings) {
  if (!settings) return null;
  const out = { ...settings };
  const specs = checkSpecsDir(out.specs);
  if (specs) out.specs = specs;
  else delete out.specs;
  return Object.keys(out).length ? out : null;
}

/** The directory, in the repository, its specs are in. */
export const specsDirOf = (repo) => repo?.settings?.specs || DEFAULT_SPECS_DIR;

/** A path as a task's `spec` field or a request may give it: no leading `./` or `/`. */
export const normalPath = (path) =>
  String(path ?? '')
    .trim()
    .replace(/^(?:\.\/|\/)+/u, '');

/**
 * Whether `path` is a file the board reads as one of the repository's specs: a Markdown file directly in `dir`
 * (its README.md too). Subdirectories, other files, and anything outside it are refused.
 * @param {string} dir
 * @param {string} path
 */
export function inSpecsDir(dir, path) {
  const p = normalPath(path);
  if (!p.startsWith(`${dir}/`)) return false;
  const name = p.slice(dir.length + 1);
  return SPEC_NAME.test(name) && !name.startsWith('.');
}

/** Whether a file in the directory is a spec, not its introduction. */
export const isSpecFile = (name) => SPEC_NAME.test(name) && !name.startsWith('.') && name.toLowerCase() !== 'readme.md';

/**
 * What the list shows for one spec: its title (the first `# ` heading, else the file name), its status (the
 * first word after `Status:` on the line under the heading, as the template has it, else null), and the work ID
 * its file name starts with, if any. `text` is null for a file the board didn't read (too large).
 * @param {string} name the file name
 * @param {string | null} text
 */
export function specMeta(name, text) {
  const wid = WID.exec(name)?.[1] ?? null;
  const fallback = name.replace(/\.md$/u, '');
  if (text === null || text === undefined) return { wid, title: fallback, status: null };
  const lines = String(text).split(/\r?\n/u);
  const at = lines.findIndex((l) => /^#\s+\S/u.test(l));
  if (at < 0) return { wid, title: fallback, status: null };
  const title =
    lines[at]
      .replace(/^#\s+/u, '')
      .replace(/\s+#+\s*$/u, '')
      .trim() || fallback;
  const under = lines.slice(at + 1).find((l) => l.trim() !== '') ?? '';
  const status = /\bStatus:\s*\**\s*([A-Za-z][\w-]*)/u.exec(under)?.[1]?.toLowerCase() ?? null;
  return { wid, title, status };
}

/** The step a status takes when the owner marks a spec (BRK-215): draft to approved, approved to built. */
export const NEXT_STATUS = Object.freeze({ draft: 'approved', approved: 'built' });

/** The status after `status`, or null when it has none (built, or a word the board doesn't know). */
export const nextStatus = (status) => (Object.hasOwn(NEXT_STATUS, status) ? NEXT_STATUS[status] : null);

/** `Status:`, its word, and what its brackets say, as the template writes it: `Status: approved (1 Oct 2026)`. */
const STATUS = /(\bStatus:\s*\**\s*)([A-Za-z][\w-]*)(?:\s*\(([^)\n]*)\))?/u;

/** The index of the line under a spec's title (its first `# ` heading), or -1. */
function statusLineAt(lines) {
  const at = lines.findIndex((l) => /^#\s+\S/u.test(l));
  if (at < 0) return -1;
  return lines.findIndex((l, i) => i > at && l.trim() !== '');
}

/**
 * The status on the line under a spec's title, lowercased, and what its brackets say (null without them), or
 * null when that line has no `Status:`, as specMeta reads it.
 * @param {string} text
 * @returns {{ status: string, detail: string | null } | null}
 */
export function readStatus(text) {
  const lines = String(text).split('\n');
  const at = statusLineAt(lines);
  const m = at < 0 ? null : STATUS.exec(lines[at]);
  return m ? { status: m[2].toLowerCase(), detail: m[3]?.trim() || null } : null;
}

/**
 * `text` with the status on the line under its title set to `status (detail)`, and nothing else changed: the rest
 * of that line, a later `Status:` in the body, and the line endings stay. Null when that line has no `Status:`.
 * @param {string} text
 * @param {string} status
 * @param {string} detail
 */
export function withStatus(text, status, detail) {
  const lines = String(text).split('\n');
  const at = statusLineAt(lines);
  if (at < 0 || !STATUS.test(lines[at])) return null;
  lines[at] = lines[at].replace(STATUS, (_, lead) => `${lead}${status} (${detail})`);
  return lines.join('\n');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day as the specs and the decision log write it, in UTC: `29 Sep 2026`. */
export function specDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * What a built spec's brackets say: the merged pull requests of the tasks that link it (`#41, #42`), else the day,
 * and then when it was approved, from the brackets it had (`approved 1 Oct 2026, by the owner`).
 * @param {number[]} pulls
 * @param {string | null} approved
 * @param {number} now
 */
export function builtDetail(pulls, approved, now) {
  const numbers = [...new Set(pulls.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const built = numbers.length ? numbers.map((n) => `#${n}`).join(', ') : `as of ${specDate(now)}`;
  return approved ? `${built}; approved ${approved}` : built;
}

/** Newest first by the work ID's number, then by path; specs without a work ID last. */
export function bySpecOrder(a, b) {
  const n = (s) => (s.wid ? Number(s.wid.split('-')[1]) : -1);
  return n(b) - n(a) || a.path.localeCompare(b.path);
}
