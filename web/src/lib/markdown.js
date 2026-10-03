// A document in Markdown, as GitHub renders a pull request's description (WEB-8), parsed to plain blocks that
// richtext.jsx turns into elements. Kept free of JSX so it's tested in the Worker test runtime, like links.js.
// Nothing here becomes HTML: an HTML comment is left out and any other HTML stays text.
import { tokenize } from './links.js';

/**
 * Blocks:
 *   {type: 'h', level, tokens} | {type: 'p', lines: [tokens]} | {type: 'hr'} | {type: 'code', lang, text}
 *   | {type: 'quote', blocks} | {type: 'table', align: [left|center|right|null], head: [tokens], rows: [[tokens]]}
 *   | {type: 'list', ordered, start, items: [{task: true|false|null, blocks}]}
 * `opts` go to tokenize: `base` is the repository relative links point into.
 * @param {string} text
 * @param {{ links?: boolean, base?: string | null }} [opts]
 */
export function markdown(text, opts = {}) {
  const source = String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '');
  return parse(source.split('\n'), opts);
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const QUOTE = /^\s{0,3}>/u;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/u;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/u;

const indentOf = (line) => line.length - line.trimStart().length;
const isTable = (lines, i) =>
  lines[i].includes('|') && i + 1 < lines.length && DELIMITER.test(lines[i + 1]) && lines[i + 1].includes('-');
const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) ||
  HEADING.test(lines[i]) ||
  RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) ||
  ITEM.test(lines[i]) ||
  isTable(lines, i);

/** A table row's cells, without the outer pipes; `\|` stays a pipe inside a cell. */
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/u, '')
    .replace(/(?<!\\)\|$/u, '')
    .split(/(?<!\\)\|/u)
    .map((c) => c.trim().replace(/\\\|/gu, '|'));

function parse(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[2])) {
        body.push(lines[i].slice(Math.min(fence[1].length, indentOf(lines[i]))));
        i += 1;
      }
      i += 1; // the closing fence, or the end of the text
      out.push({ type: 'code', lang: fence[3] || null, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: 'h', level: heading[1].length, tokens: tokenize(heading[2], opts) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: 'hr' });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/u, ''));
        i += 1;
      }
      out.push({ type: 'quote', blocks: parse(body, opts) });
      continue;
    }
    if (isTable(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
      );
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i]);
        rows.push(head.map((_, k) => tokenize(row[k] ?? '', opts)));
        i += 1;
      }
      out.push({ type: 'table', align, head: head.map((c) => tokenize(c, opts)), rows });
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, opts, out);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(tokenize(lines[i].trim(), opts));
      i += 1;
    }
    out.push({ type: 'p', lines: para });
  }
  return out;
}

/**
 * A list from line `i`: its items at the first item's indent, each item's own lines (deeper ones, dedented) parsed
 * as blocks, so a nested list is a block inside its item. A blank line ends it unless the next item or an indented
 * line follows. Pushes the list to `out` and returns the line after it.
 */
function list(lines, i, opts, out) {
  const first = ITEM.exec(lines[i]);
  const indent = first[1].length;
  const ordered = first[3] !== undefined;
  const block = { type: 'list', ordered, start: ordered ? Number(first[3]) : null, items: [] };
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || (m[3] !== undefined) !== ordered) break;
    const content = m[1].length + m[2].length + 1; // where the item's text starts
    const task = /^\[([ xX])\]\s+(.*)$/u.exec(m[4]);
    const own = [task ? task[2] : m[4]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line: the item goes on only if what follows is indented under it.
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (
          next < lines.length &&
          indentOf(lines[next]) > indent &&
          !(ITEM.test(lines[next]) && indentOf(lines[next]) === indent)
        ) {
          own.push('');
          i += 1;
          continue;
        }
        break;
      }
      if (indentOf(line) > indent) {
        own.push(line.slice(Math.min(content, indentOf(line))));
        i += 1;
        continue;
      }
      break;
    }
    block.items.push({ task: task ? task[1] !== ' ' : null, blocks: parse(own, opts) });
    // Items of one list may have a blank line between them.
    let next = i;
    while (next < lines.length && !lines[next].trim()) next += 1;
    const after = next < lines.length && ITEM.exec(lines[next]);
    if (after && after[1].length === indent && (after[3] !== undefined) === ordered) i = next;
  }
  out.push(block);
  return i;
}
