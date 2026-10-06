// Code on the board (WEB-86): which language a file is, highlight.js's markup as plain tokens, what a file can show
// as a preview, and a rendered diff of two documents by block. Kept free of JSX and of highlight.js itself, so it's
// tested in the Worker test runtime, like markdown.js; highlight.js is loaded by highlight.js in this folder.

/**
 * File extensions and names whose highlight.js language has another name. Anything else is tried as its own name
 * (`go`, `rust`, `sql`) and then as plain text.
 */
const ALIASES = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  fs: 'fsharp',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  m: 'objectivec',
  mm: 'objectivec',
  pl: 'perl',
  pm: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  clj: 'clojure',
  cljs: 'clojure',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  xsd: 'xml',
  plist: 'xml',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  editorconfig: 'ini',
  gitconfig: 'ini',
  gradle: 'gradle',
  proto: 'protobuf',
  vim: 'vim',
  tex: 'latex',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  taskrc: 'ini',
  txt: 'plaintext',
  text: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
  lock: 'plaintext',
};

/**
 * The highlight.js language for a file path or a code fence's tag, lowercase, or null for plain text. Whether
 * highlight.js has it is only known once it's loaded, so a name it lacks shows as plain text there.
 * @param {string | null | undefined} pathOrTag
 */
export function languageOf(pathOrTag) {
  const value = String(pathOrTag ?? '')
    .trim()
    .toLowerCase();
  if (!value) return null;
  const name = value.split('/').pop() ?? '';
  // Dockerfile, Makefile, and Dockerfile.dev name their language before any dot.
  const [stem] = name.split('.');
  if (stem === 'dockerfile' || stem === 'containerfile') return 'dockerfile';
  if (stem === 'makefile' || stem === 'gnumakefile') return 'makefile';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : name;
  const lang = ALIASES[ext] ?? ext;
  if (lang === 'plaintext' || !/^[a-z][\w-]*$/u.test(lang)) return null;
  return lang;
}

/**
 * What Preview shows for a file, by its extension: a Markdown document, plain text, a table, or an image. Null for a
 * file with nothing to preview: its diff is all there is.
 * @param {string} path
 * @returns {'markdown' | 'text' | 'csv' | 'tsv' | 'svg' | 'image' | null}
 */
export function previewOf(path) {
  const name = String(path ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (['txt', 'text'].includes(ext) || /(^|\/)(licen[cs]e|copying|notice|authors)$/u.test(name)) return 'text';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv') return 'tsv';
  if (ext === 'svg') return 'svg';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp'].includes(ext)) return 'image';
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x27': "'", '#39': "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#x27|#39);/gu, (_, name) => ENTITIES[name]);

/**
 * highlight.js's markup as lines of tokens, so the board renders elements and never inserts HTML. A token's `cls` is
 * the innermost scope it sits in (a string's interpolation is the interpolation, not the string), or null for plain
 * text; a scope that spans lines carries on into the next. The markup is only ever highlight.js's: `<span class="…">`,
 * `</span>`, and escaped text.
 * @param {string} html
 * @returns {{ cls: string | null, text: string }[][]}
 */
export function toLines(html) {
  /** @type {{ cls: string | null, text: string }[][]} */
  const lines = [[]];
  /** @type {string[]} */
  const scopes = [];
  for (const [, open, close, text] of String(html).matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/gu)) {
    if (open !== undefined) scopes.push(open);
    else if (close) scopes.pop();
    else {
      const parts = decode(text).split('\n');
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ cls: scopes.at(-1) ?? null, text: part });
      });
    }
  }
  return lines;
}

/**
 * A document as blocks for a rendered diff: runs of lines split at blank lines, with a fenced code block kept whole
 * however many blank lines it holds.
 * @param {string} text
 * @returns {string[]}
 */
export function blocksOf(text) {
  const out = [];
  let current = [];
  let fence = null;
  for (const line of String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      current.push(line);
      if (marker?.[1].startsWith(fence)) fence = null;
      continue;
    }
    if (marker) fence = marker[1];
    if (!line.trim() && !fence) {
      if (current.length) out.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) out.push(current.join('\n'));
  return out;
}

/** Past this many blocks a side, the rendered diff marks everything after the shared start and end as changed. */
const MAX_BLOCKS = 1500;

/**
 * Two versions of a document, block by block (a longest common subsequence): each block is the same in both,
 * removed, or added, in reading order, with a removal before the addition that replaced it.
 * @param {string | null} before
 * @param {string | null} after
 * @returns {{ kind: 'same' | 'removed' | 'added', text: string }[]}
 */
export function diffBlocks(before, after) {
  const a = before === null ? [] : blocksOf(before);
  const b = after === null ? [] : blocksOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  /** @type {{ kind: 'same' | 'removed' | 'added', text: string }[]} */
  const middle = [];
  if (midA.length > MAX_BLOCKS || midB.length > MAX_BLOCKS) {
    for (const text of midA) middle.push({ kind: 'removed', text });
    for (const text of midB) middle.push({ kind: 'added', text });
  } else {
    // lengths[i][j]: the longest common run of midA from i and midB from j.
    const lengths = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1)
      for (let j = midB.length - 1; j >= 0; j -= 1)
        lengths[i][j] =
          midA[i] === midB[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        middle.push({ kind: 'same', text: midA[i] });
        i += 1;
        j += 1;
      } else if (j >= midB.length || (i < midA.length && lengths[i + 1][j] >= lengths[i][j + 1])) {
        middle.push({ kind: 'removed', text: midA[i] });
        i += 1;
      } else {
        middle.push({ kind: 'added', text: midB[j] });
        j += 1;
      }
    }
  }
  return [
    ...a.slice(0, start).map((text) => ({ kind: /** @type {const} */ ('same'), text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ kind: /** @type {const} */ ('same'), text })),
  ];
}

/**
 * A block diff as rows of two sides for the split view: a block that stayed is on both, and within each change the
 * removed blocks pair with the added ones in order, the shorter side left empty.
 * @param {{ kind: 'same' | 'removed' | 'added', text: string }[]} blocks
 * @returns {{ left: string | null, right: string | null, kind: 'same' | 'changed' }[]}
 */
export function pairBlocks(blocks) {
  const rows = [];
  for (let i = 0; i < blocks.length; ) {
    if (blocks[i].kind === 'same') {
      rows.push({ left: blocks[i].text, right: blocks[i].text, kind: /** @type {const} */ ('same') });
      i += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (blocks[i]?.kind === 'removed') removed.push(blocks[i++].text);
    while (blocks[i]?.kind === 'added') added.push(blocks[i++].text);
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1)
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null, kind: /** @type {const} */ ('changed') });
  }
  return rows;
}

/**
 * A CSV or TSV file as rows of cells: quoted cells may hold the delimiter, quotes (doubled), and line breaks.
 * @param {string} text
 * @param {',' | '\t'} delimiter
 * @returns {string[][]}
 */
export function parseTable(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text ?? '').replace(/\r\n?/gu, '\n');
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * A patch's rows as the code to highlight: each hunk's old side and new side on their own, so a comment or a string
 * that opens in one line closes in the next as it does in the file. `at[i]` says where row `i`'s line is (the piece
 * and the line in it: a removed row on the old side, an added or unchanged one on the new), or null for a hunk header
 * or a note.
 * @param {{ kind: string, text?: string }[]} rows
 * @returns {{ pieces: string[], at: ([number, number] | null)[] }}
 */
export function diffPieces(rows) {
  /** @type {string[][]} */
  const pieces = [];
  let oldSide = -1;
  let newSide = -1;
  const open = () => {
    oldSide = pieces.push([]) - 1;
    newSide = pieces.push([]) - 1;
  };
  const at = rows.map((r) => {
    if (r.kind === 'hunk') {
      open();
      return null;
    }
    if (!['context', 'removed', 'added'].includes(r.kind)) return null;
    if (oldSide < 0) open();
    const text = r.text ?? '';
    if (r.kind === 'context') pieces[oldSide].push(text);
    const side = r.kind === 'removed' ? oldSide : newSide;
    pieces[side].push(text);
    return /** @type {[number, number]} */ ([side, pieces[side].length - 1]);
  });
  return { pieces: pieces.map((lines) => lines.join('\n')), at };
}
