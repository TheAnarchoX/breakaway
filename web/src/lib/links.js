// Parsing for task titles and notes (small Markdown), kept free of JSX so it can be tested
// in the Worker test runtime. richtext.jsx renders the tokens.

let repoBase = null;

/**
 * The GitHub address of the repository the board's notes and pull request numbers point into: the board's
 * default repository, set once the board has loaded its repositories (`owner/name`, or null for none).
 */
export function setRepoBase(github) {
  repoBase = /^[\w.-]+\/[\w.-]+$/u.test(String(github ?? '')) ? `https://github.com/${github}` : null;
}

/** The repository's GitHub address, or null while the board doesn't know one. */
export const repoBaseUrl = () => repoBase;

const ROOT_DIRS = [
  'src',
  'docs',
  'brand',
  'scripts',
  'tools',
  'test',
  'public',
  'migrations',
  '.github',
  '.agents',
  '.claude',
];
const ROOT_FILES = [
  'AGENTS.md',
  'WORK.md',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'wrangler.jsonc',
  'wrangler.dev.jsonc',
  'wrangler.test.jsonc',
  'vite.config.js',
  'vitest.config.js',
  'index.html',
  '.taskrc',
  '.envrc',
  '.gitignore',
];

/**
 * A path in the repository (from its root, as the board's notes write them) → its GitHub URL
 * on main, or null (also when the board has no repository yet). A bare #anchor points into WORK.md, where the notes were written.
 * `base` is another repository's GitHub address, for text that belongs to it (a pull request's description).
 */
export function repoUrl(target, base = repoBase) {
  let path = String(target ?? '').trim();
  if (!path || /^[a-z][a-z0-9+.-]*:/iu.test(path) || path.startsWith('//')) return null;
  let anchor = '';
  const hash = path.indexOf('#');
  if (hash >= 0) {
    anchor = path.slice(hash);
    path = path.slice(0, hash);
  }
  if (!base) return null;
  if (!path) return /^#[\w-]+$/u.test(anchor) ? `${base}/blob/main/WORK.md${anchor}` : null;
  if (path.startsWith('/')) return null; // a path on the website, like /about
  if (anchor && !/^#[\w-]+$/u.test(anchor)) return null;
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (!parts.length || parts.some((p) => !/^[\w.@-]+$/u.test(p))) return null;
  const clean = parts.join('/');
  if (!ROOT_DIRS.includes(parts[0]) && !ROOT_FILES.includes(clean)) return null;
  const isDir =
    path.endsWith('/') || (parts.length > 0 && !/\.[A-Za-z0-9]+$/u.test(parts.at(-1)) && !ROOT_FILES.includes(clean));
  return `${base}/${isDir ? 'tree' : 'blob'}/main/${clean}${anchor}`;
}

/** An absolute http(s) URL, normalised, or null. */
export function webUrl(target) {
  try {
    const url = new URL(String(target ?? '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export const linkFor = (target, base = repoBase) => webUrl(target) ?? repoUrl(target, base);

// Order matters: code first (nothing inside it is parsed), then ![images](…) and [links](…), <autolinks>, bare
// URLs (allowing balanced parentheses, as in Wikipedia links), **bold**, and *italics* or _italics_ (not inside a
// word, so snake_case stays as it is, and not around spaces, so 2 * 3 * 4 does too).
const TARGET = '([^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)';
const TOKEN = new RegExp(
  [
    '(`+)([^`]+?)\\1',
    `!\\[([^\\]]*)\\]\\(${TARGET}\\)`,
    `\\[([^\\]]+)\\]\\(${TARGET}\\)`,
    '<(https?:\\/\\/[^\\s>]+)>',
    '(https?:\\/\\/[^\\s<>()]+(?:\\([^\\s<>()]*\\)[^\\s<>()]*)*)',
    '\\*\\*([^*]+)\\*\\*',
    '(?<![*\\w])\\*(?![\\s*])([^*\\n]+?)(?<![\\s*])\\*(?![*\\w])',
    '(?<!\\w)_(?![\\s_])([^_\\n]+?)(?<![\\s_])_(?!\\w)',
  ].join('|'),
  'gu',
);

/**
 * One line → tokens:
 *   {type: 'text', text} | {type: 'code', text, href?} | {type: 'link', label: tokens, href?}
 *   | {type: 'image', alt, href?} | {type: 'url', text, href?} | {type: 'bold', children: tokens}
 *   | {type: 'em', children: tokens}
 * `href` is set only for http(s) URLs and repository paths, and only when `links` is on; `base` is the repository
 * paths point into (repoUrl), when it isn't the board's own.
 */
export function tokenize(text, { links = true, base = repoBase } = {}) {
  const source = String(text ?? '');
  const out = [];
  let last = 0;
  const push = (token) => {
    if (token.type === 'text' && out.at(-1)?.type === 'text') out.at(-1).text += token.text;
    else if (token.type !== 'text' || token.text) out.push(token);
  };
  for (const m of source.matchAll(TOKEN)) {
    push({ type: 'text', text: source.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      const href = links && (m[2].includes('/') || ROOT_FILES.includes(m[2])) ? repoUrl(m[2], base) : null;
      push(href ? { type: 'code', text: m[2], href } : { type: 'code', text: m[2] });
    } else if (m[3] !== undefined) {
      // An image is a link to it: the board shows no outside images (its CSP), and they could track who looks.
      const href = links ? linkFor(m[4], base) : null;
      push(href ? { type: 'image', alt: m[3], href } : { type: 'image', alt: m[3] });
    } else if (m[5] !== undefined) {
      const href = links ? linkFor(m[6], base) : null;
      const label = tokenize(m[5], { links: false });
      push(href ? { type: 'link', label, href } : { type: 'link', label });
    } else if (m[7] !== undefined) {
      const href = links ? webUrl(m[7]) : null;
      push(href ? { type: 'url', text: m[7], href } : { type: 'text', text: m[7] });
    } else if (m[8] !== undefined) {
      let url = m[8];
      let trail = '';
      // A sentence's full stop or comma isn't part of the URL.
      while (/[.,;:!?'"*]$/u.test(url)) {
        trail = url.slice(-1) + trail;
        url = url.slice(0, -1);
      }
      const href = links ? webUrl(url) : null;
      push(href ? { type: 'url', text: url, href } : { type: 'text', text: url });
      push({ type: 'text', text: trail });
    } else if (m[9] !== undefined) {
      push({ type: 'bold', children: tokenize(m[9], { links, base }) });
    } else {
      push({ type: 'em', children: tokenize(m[10] ?? m[11], { links, base }) });
    }
  }
  push({ type: 'text', text: source.slice(last) });
  return out;
}

/** A note → blocks: {type: 'p', lines: [tokens]} and {type: 'ul', items: [tokens]}. */
export function blocks(text) {
  const out = [];
  let list = null;
  let para = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const item = /^\s*[-*] (.*)$/u.exec(line);
    if (item) {
      para = null;
      if (!list) out.push((list = { type: 'ul', items: [] }));
      list.items.push(tokenize(item[1]));
    } else if (!line.trim()) {
      para = null;
      list = null;
    } else {
      list = null;
      if (!para) out.push((para = { type: 'p', lines: [] }));
      para.lines.push(tokenize(line));
    }
  }
  return out;
}
