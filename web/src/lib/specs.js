// The Specs view (WEB-25, docs/specs/IDEA-31-specs-view.md section 3): what it works out without the page, kept
// free of JSX so it's tested in the Worker test runtime. The server's side is src/specs.js.

/** Where a repository keeps its specs when its settings don't say (src/specs.js has the same). */
export const DEFAULT_SPECS_DIR = 'docs/specs';
const SLUG = /^[a-z][a-z0-9-]{0,31}$/u;
const PATH = /^(?!\/)(?!.*\.\.)[\w./-]{1,400}\.md$/u;

/** The directory, in repository `repo` (a row from /api/repos), its specs are in. */
export const specsDirOf = (repo) => repo?.settings?.specs || DEFAULT_SPECS_DIR;

const normal = (path) =>
  String(path ?? '')
    .trim()
    .replace(/^(?:\.\/|\/)+/u, '');

/** Whether a task's `spec` field names a Markdown file directly in `dir`, so the Specs view can open it. */
export function inSpecsDir(dir, path) {
  const p = normal(path);
  if (!p.startsWith(`${dir}/`)) return false;
  return /^[\w.-]{1,200}\.md$/u.test(p.slice(dir.length + 1)) && !p.slice(dir.length + 1).startsWith('.');
}

/**
 * The `spec` a link to the view carries: the path for the default repository's spec, `<slug>:<path>` for
 * another's, as the GitHub view's `pr` does. `slug` null is the default's.
 */
export function specParam(path, slug, fallback) {
  if (!path) return null;
  return slug && slug !== fallback ? `${slug}:${path}` : path;
}

/** `{ slug, path }` from the address's `spec` (slug null for the default repository's), or null when it can't be one. */
export function readSpecParam(value) {
  const m = /^(?:([^:]+):)?(.+)$/u.exec(String(value ?? ''));
  if (!m) return null;
  const [, slug = null, path] = m;
  if (slug !== null && !SLUG.test(slug)) return null;
  if (!PATH.test(path) || path.split('/').some((part) => part === '' || part === '.')) return null;
  return { slug, path };
}

/** The specs whose title, work ID, or file name has `q` in it, ignoring case; all of them for an empty `q`. */
export function filterSpecs(list, q) {
  const needle = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return list;
  return list.filter((s) => [s.title, s.wid, s.name].some((v) => v && String(v).toLowerCase().includes(needle)));
}

/** How many tasks link a spec, and how many of them are open (not done). */
export function specTaskCounts(tasks) {
  const list = tasks ?? [];
  return { total: list.length, open: list.filter((t) => t.status !== 'completed').length };
}

/**
 * A spec's Markdown without its first `# ` heading, which the view shows as the title: the same line the server
 * reads the title from (src/specs.js, specMeta).
 */
export function withoutTitle(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => /^#\s+\S/u.test(l));
  if (at >= 0) lines.splice(at, 1);
  return lines.join('\n');
}

/** A spec's title as it shows beside its work ID: without that work ID and the mark after it, when it starts so. */
export function shortTitle(title, wid) {
  const t = String(title ?? '');
  if (!wid || !t.startsWith(wid)) return t;
  const rest = t.slice(wid.length);
  const m = /^\s*[·:—–-]?\s+(\S.*)$/su.exec(rest);
  return m ? m[1] : t;
}

/**
 * The open general task refining spec `path` in repository `slug` (WEB-26), if there is one: the board starts one
 * per spec at a time (src/store-agents.js). A task's `repo` is empty for the default repository's, `fallback`.
 * @param {any[]} list the board's tasks
 */
export function refiningSpec(list, slug, path, fallback) {
  const want = normal(path);
  return (
    (list ?? []).find(
      (t) =>
        t.status === 'pending' &&
        t.tags?.includes('general') &&
        t.spec &&
        normal(t.spec) === want &&
        (t.repo || fallback) === slug,
    ) ?? null
  );
}

/** The longest request the board keeps for a spec's agent (src/spec-prompt.js clips it there). */
export const SPEC_REQUEST_MAX = 4000;
