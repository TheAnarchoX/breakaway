import { describe, expect, it } from 'vitest';
import {
  blocksOf,
  diffBlocks,
  diffPieces,
  languageOf,
  pairBlocks,
  parseTable,
  previewOf,
  toLines,
} from '../web/src/lib/code.js';

// Code on the board (WEB-86): languages for highlight.js, its markup as tokens, Preview's kinds, and the rendered diff.

describe('which language a file is', () => {
  it('maps extensions, names, and fence tags to highlight.js languages', () => {
    expect(languageOf('src/worker.js')).toBe('javascript');
    expect(languageOf('web/src/App.jsx')).toBe('javascript');
    expect(languageOf('types.d.ts')).toBe('typescript');
    expect(languageOf('docs/specs/WEB-1-a.md')).toBe('markdown');
    expect(languageOf('.github/workflows/ci.yml')).toBe('yaml');
    expect(languageOf('wrangler.jsonc')).toBe('json');
    expect(languageOf('main.go')).toBe('go');
    expect(languageOf('lib.rs')).toBe('rust');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('docker/Dockerfile.dev')).toBe('dockerfile');
    expect(languageOf('Makefile')).toBe('makefile');
    expect(languageOf('index.html')).toBe('xml');
    // A code fence's tag is a language or an extension.
    expect(languageOf('js')).toBe('javascript');
    expect(languageOf('Python')).toBe('python');
    expect(languageOf('sql')).toBe('sql');
  });

  it('says plain text for text, no name, and anything that isn’t a language name', () => {
    expect(languageOf('notes.txt')).toBeNull();
    expect(languageOf('data.csv')).toBeNull();
    expect(languageOf('')).toBeNull();
    expect(languageOf(null)).toBeNull();
    expect(languageOf('notes.c++')).toBeNull();
  });
});

describe('what Preview shows', () => {
  it('knows documents, text, tables, and images, and nothing else', () => {
    expect(previewOf('README.md')).toBe('markdown');
    expect(previewOf('docs/page.mdx')).toBe('markdown');
    expect(previewOf('notes.txt')).toBe('text');
    expect(previewOf('LICENSE')).toBe('text');
    expect(previewOf('data/rows.csv')).toBe('csv');
    expect(previewOf('rows.tsv')).toBe('tsv');
    expect(previewOf('brand/logo/mark.svg')).toBe('svg');
    expect(previewOf('icon.PNG')).toBe('image');
    expect(previewOf('src/worker.js')).toBeNull();
    expect(previewOf('Makefile')).toBeNull();
  });
});

describe("highlight.js's markup as tokens", () => {
  it('keeps the innermost scope, unescapes text, and carries a scope over line breaks', () => {
    const html =
      '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &amp; y&quot;</span>;\n' +
      '<span class="hljs-comment">/* one\ntwo */</span>\n' +
      '<span class="hljs-string">`a <span class="hljs-subst">$' +
      '{b}</span>`</span>';
    expect(toLines(html)).toEqual([
      [
        { cls: 'hljs-keyword', text: 'const' },
        { cls: null, text: ' a = ' },
        { cls: 'hljs-string', text: '"x & y"' },
        { cls: null, text: ';' },
      ],
      [{ cls: 'hljs-comment', text: '/* one' }],
      [{ cls: 'hljs-comment', text: 'two */' }],
      [
        { cls: 'hljs-string', text: '`a ' },
        { cls: 'hljs-subst', text: '$' + '{b}' },
        { cls: 'hljs-string', text: '`' },
      ],
    ]);
  });

  it('gives an empty line no tokens, and never turns text into markup', () => {
    expect(toLines('a\n\nb')).toEqual([[{ cls: null, text: 'a' }], [], [{ cls: null, text: 'b' }]]);
    expect(toLines('&lt;script&gt;')).toEqual([[{ cls: null, text: '<script>' }]]);
  });
});

describe("a patch's code to highlight", () => {
  it("puts each hunk's old and new sides together, and says where each row's line is", () => {
    const rows = [
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: '/* start' },
      { kind: 'removed', text: 'old */' },
      { kind: 'added', text: 'new */' },
      { kind: 'note', text: 'No newline at end of file' },
      { kind: 'hunk', text: '@@ -9 +9 @@' },
      { kind: 'added', text: 'x' },
    ];
    expect(diffPieces(rows)).toEqual({
      pieces: ['/* start\nold */', '/* start\nnew */', '', 'x'],
      at: [null, [1, 0], [0, 1], [1, 1], null, null, [3, 0]],
    });
  });
});

describe('the rendered diff', () => {
  it('splits a document into blocks at blank lines, keeping a fenced block whole', () => {
    expect(blocksOf('# Title\n\nOne\ntwo\n\n```js\na\n\nb\n```\n\n- item')).toEqual([
      '# Title',
      'One\ntwo',
      '```js\na\n\nb\n```',
      '- item',
    ]);
  });

  it('marks blocks the same, removed, or added, a removal before what replaced it', () => {
    const before = '# Guide\n\nKeep this.\n\nOld line.\n\nEnd.';
    const after = '# Guide\n\nKeep this.\n\nNew line.\n\nAdded too.\n\nEnd.';
    expect(diffBlocks(before, after)).toEqual([
      { kind: 'same', text: '# Guide' },
      { kind: 'same', text: 'Keep this.' },
      { kind: 'removed', text: 'Old line.' },
      { kind: 'added', text: 'New line.' },
      { kind: 'added', text: 'Added too.' },
      { kind: 'same', text: 'End.' },
    ]);
    expect(diffBlocks(null, 'A\n\nB').map((b) => b.kind)).toEqual(['added', 'added']);
    expect(diffBlocks('A', null)).toEqual([{ kind: 'removed', text: 'A' }]);
  });

  it('pairs a change side by side, the shorter side left empty', () => {
    const before = '# Guide\n\nOld line.\n\nEnd.';
    const after = '# Guide\n\nNew line.\n\nAdded too.\n\nEnd.';
    expect(pairBlocks(diffBlocks(before, after))).toEqual([
      { left: '# Guide', right: '# Guide', kind: 'same' },
      { left: 'Old line.', right: 'New line.', kind: 'changed' },
      { left: null, right: 'Added too.', kind: 'changed' },
      { left: 'End.', right: 'End.', kind: 'same' },
    ]);
  });
});

describe('a table file', () => {
  it('reads CSV with quoted cells, doubled quotes, and line breaks in a cell', () => {
    expect(parseTable('name,note\r\nwidgets,"a, b"\n"say ""hi""","two\nlines"\n', ',')).toEqual([
      ['name', 'note'],
      ['widgets', 'a, b'],
      ['say "hi"', 'two\nlines'],
    ]);
    expect(parseTable('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
