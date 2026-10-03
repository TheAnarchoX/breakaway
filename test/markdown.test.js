import { describe, expect, it } from 'vitest';
import { tokenize } from '../web/src/lib/links.js';
import { markdown } from '../web/src/lib/markdown.js';

// A pull request's description as Markdown (WEB-8): the blocks GitHub renders, parsed to plain data the page turns
// into elements. Nothing becomes HTML, and only http(s) and repository links get an address.

const B = 'https://github.com/acme/widgets';
const text = (tokens) => tokens.map((t) => t.text ?? '').join('');

describe('a description’s blocks', () => {
  it('reads headings, paragraphs with their line breaks, and rules', () => {
    const doc = markdown('## What changed and why\n\nThe page kept the button.\nNow it doesn’t.\n\n---\n\nDone.');
    expect(doc.map((b) => b.type)).toEqual(['h', 'p', 'hr', 'p']);
    expect(doc[0]).toMatchObject({ level: 2 });
    expect(text(doc[0].tokens)).toBe('What changed and why');
    expect(doc[1].lines.map(text)).toEqual(['The page kept the button.', 'Now it doesn’t.']);
  });

  it('nests lists by indent, numbers ordered ones from their start, and reads task items', () => {
    const doc = markdown(
      [
        '- **Server:** counts a start.',
        '  - and the page names it.',
        '- [x] Carbon and chalk.',
        '- [ ] Not checked.',
        '',
        '3. Third',
        '4. Fourth',
      ].join('\n'),
    );
    expect(doc.map((b) => b.type)).toEqual(['list', 'list']);
    const [bullets, numbers] = doc;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items).toHaveLength(3);
    expect(bullets.items[0].blocks[0].lines[0][0]).toMatchObject({ type: 'bold' });
    expect(bullets.items[0].blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(text(bullets.items[0].blocks[1].items[0].blocks[0].lines[0])).toBe('and the page names it.');
    expect(bullets.items.map((item) => item.task)).toEqual([null, true, false]);
    expect(text(bullets.items[1].blocks[0].lines[0])).toBe('Carbon and chalk.');
    expect(numbers).toMatchObject({ ordered: true, start: 3 });
    expect(numbers.items).toHaveLength(2);
  });

  it('keeps a list together across a blank line between its items', () => {
    const doc = markdown('1. One\n\n2. Two\n\nAfter.');
    expect(doc.map((b) => b.type)).toEqual(['list', 'p']);
    expect(doc[0].items).toHaveLength(2);
  });

  it('keeps code blocks as text, with their language, and nothing inside them parsed', () => {
    const doc = markdown('```sh\nnpx breakaway **claim** BRK-12\n<script>alert(1)</script>\n```\nAfter.');
    expect(doc[0]).toEqual({
      type: 'code',
      lang: 'sh',
      text: 'npx breakaway **claim** BRK-12\n<script>alert(1)</script>',
    });
    expect(doc[1].type).toBe('p');
  });

  it('reads quotes and tables, with each column’s alignment', () => {
    const doc = markdown(
      '> A quote\n> **in two** lines\n\n| Area | Prefix |\n| :--- | ---: |\n| board | `BRK` |\n| web | WEB |',
    );
    expect(doc[0].type).toBe('quote');
    expect(doc[0].blocks[0].lines).toHaveLength(2);
    expect(doc[1]).toMatchObject({ type: 'table', align: ['left', 'right'] });
    expect(doc[1].head.map(text)).toEqual(['Area', 'Prefix']);
    expect(doc[1].rows).toHaveLength(2);
    expect(doc[1].rows[0][1][0]).toMatchObject({ type: 'code', text: 'BRK' });
  });

  it('leaves out HTML comments and shows any other HTML as text', () => {
    const doc = markdown('<!-- a template note -->\nHi <b>there</b>');
    expect(doc).toHaveLength(1);
    expect(text(doc[0].lines[0])).toBe('Hi <b>there</b>');
  });

  it('links relative paths into the pull request’s own repository', () => {
    const [p] = markdown('See [the guide](docs/self-hosting.md).', { base: B });
    expect(p.lines[0][1]).toMatchObject({ type: 'link', href: `${B}/blob/main/docs/self-hosting.md` });
  });
});

describe('inline Markdown', () => {
  it('reads italics, and leaves snake_case and spaced stars alone', () => {
    expect(tokenize('a *fix* and _this_')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'em', children: [{ type: 'text', text: 'fix' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'this' }] },
    ]);
    expect(tokenize('HOOKS_FROM_COPY and 2 * 3 * 4')).toEqual([
      { type: 'text', text: 'HOOKS_FROM_COPY and 2 * 3 * 4' },
    ]);
    expect(tokenize('**bold** stays bold')[0]).toMatchObject({ type: 'bold' });
  });

  it('turns an image into a link to it, since the board shows no outside images', () => {
    expect(tokenize('![The board](https://example.com/a.png)')).toEqual([
      { type: 'image', alt: 'The board', href: 'https://example.com/a.png' },
    ]);
    expect(tokenize('![x](javascript:alert(1))')[0]).toEqual({ type: 'image', alt: 'x' });
  });
});
