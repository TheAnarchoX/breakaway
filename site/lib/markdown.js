// A small Markdown for the docs in site/content: headings, paragraphs, lists, fenced code, tables, notes, and
// inline code, bold, and links. Pure, so the build and its test share it. Anything fancier is written as HTML:
// a block that starts with `<` passes through to its next blank line.

/** @param {string} text */
export const escape = (text) =>
  text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** The id a heading gets: lowercase words joined by dashes. @param {string} text */
export const slug = (text) =>
  text
    .replace(/[`'’]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/** Inline Markdown to HTML: `code`, **bold**, and [text](url). @param {string} text */
export function inline(text) {
  const parts = [];
  // Code spans first, so nothing inside them is touched.
  const withCode = text.replace(
    /`([^`]+)`/gu,
    (_, code) => `\u0000${parts.push(`<code>${escape(code)}</code>`) - 1}\u0000`,
  );
  const html = escape(withCode)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  return html.replace(/\u0000(\d+)\u0000/gu, (_, i) => parts[Number(i)]);
}

/** Front matter (`key: value` lines between `---` lines) and the rest. @param {string} source */
export function frontMatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]),
  );
  return { meta, body: source.slice(match[0].length) };
}

const cells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/gu, '')
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replace(/\\\|/gu, '|'));

/**
 * Renders Markdown. Returns the HTML and the `##` and `###` headings, for the page's contents.
 * @param {string} markdown
 * @returns {{ html: string, headings: { level: number, id: string, text: string }[] }}
 */
export function render(markdown) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const out = [];
  const headings = [];
  const used = new Set();
  let i = 0;

  const paragraphEnds = (line) =>
    line === undefined || line.trim() === '' || /^(#{2,3} |```|> |[-*] |\d+\. |\||<)/u.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = /^```(\w*)\s*$/u.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/u.test(lines[i])) code.push(lines[i++]);
      i += 1;
      const lang = fence[1] ? ` data-lang="${fence[1]}"` : '';
      out.push(`<pre${lang}><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{2,3}) (.+)$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      let id = slug(text);
      for (let n = 2; used.has(id); n += 1) id = `${slug(text)}-${n}`;
      used.add(id);
      headings.push({ level, id, text: text.replace(/`/gu, '') });
      out.push(
        `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inline(text)}</h${level}>`,
      );
      i += 1;
      continue;
    }
    if (line.startsWith('<')) {
      const raw = [];
      while (i < lines.length && lines[i].trim() !== '') raw.push(lines[i++]);
      out.push(raw.join('\n'));
      continue;
    }
    if (line.startsWith('> ')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('> ')) quote.push(lines[i++].slice(2));
      out.push(`<aside class="note">${render(quote.join('\n')).html}</aside>`);
      continue;
    }
    if (line.startsWith('|') && /^\|?[\s:|-]+\|?$/u.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const th = head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('');
      const tr = rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('');
      out.push(
        `<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`,
      );
      continue;
    }
    const list = /^([-*]|\d+\.) /u.exec(line);
    if (list) {
      const ordered = /\d/u.test(list[1]);
      const items = [];
      while (i < lines.length && /^([-*]|\d+\.) /u.test(lines[i])) {
        const item = [lines[i++].replace(/^([-*]|\d+\.) /u, '')];
        while (i < lines.length && /^ {2,}\S/u.test(lines[i])) item.push(lines[i++].trim());
        items.push(`<li>${inline(item.join(' '))}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && (para.length === 0 || !paragraphEnds(lines[i]))) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), headings };
}
