/**
 * A small YAML reader for GitHub workflows (BRK-224, docs/specs/BRK-223-run-workflows.md), shared by the Worker (which
 * reads a repository's workflows to run one by hand) and the CLI (whose `pipeline` checks its rendered workflows). It
 * reads what workflows use: block mappings and sequences, `|` and `>` block scalars with their chomping, flow
 * sequences and mappings (`[a, b]`, `{ type: string }`, over several lines too), plain scalars over several lines,
 * single- and double-quoted scalars, comments, anchors and aliases, and a leading `---`. Keys stay strings, as GitHub
 * reads them (`on` is never `true`). Anything else is a `YamlError` with its line, never a guess.
 */

export class YamlError extends Error {}

/** A quoted scalar's lines folded as YAML folds them: a line break is a space, and each blank line a line break. */
const fold = (s) => s.replace(/[ \t]*\n[ \t]*/gu, '\n').replace(/\n(\n*)/gu, (_, more) => more || ' ');

/**
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  const src = String(text).replace(/\r\n?/gu, '\n').split('\n');
  let pos = 0;
  /** @type {Record<string, any>} */
  const anchors = {};
  /** @returns {never} */
  const fail = (message, at = pos) => {
    throw new YamlError(`line ${at + 1}: ${message}`);
  };
  src.forEach((line, i) => {
    if (/^\s*\t/u.test(line)) fail('a tab in the indentation; YAML indents with spaces', i);
  });
  const indentOf = (line) => line.length - line.trimStart().length;
  const blank = (line) => !line.trim() || line.trim().startsWith('#');
  const skip = () => {
    while (pos < src.length && blank(src[pos])) pos += 1;
  };
  const isItem = (t) => t === '-' || t.startsWith('- ');
  const KEY = /^("[^"]*"|'[^']*'|[^\s'"#[\]{}&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?):(?:\s+(.*))?$/u;
  const END = /^(---|\.\.\.)(\s|$)/u;
  const BLOCK = /^([|>])([+-]?)\d?([+-]?)(\s+#.*)?$/u;

  /** A plain scalar's value: a boolean, a number, null, or the text. */
  function plainValue(plain) {
    if (plain === 'true' || plain === 'false') return plain === 'true';
    if (plain === 'null' || plain === '~') return null;
    if (/^-?\d+$/u.test(plain) || /^-?\d*\.\d+$/u.test(plain)) return Number(plain);
    return plain;
  }

  function anchored(name, value) {
    if (!/^[^\s,[\]{}]+$/u.test(name)) fail(`an anchor name YAML doesn't take: ${name.slice(0, 40)}`);
    anchors[name] = value;
    return value;
  }

  function alias(name) {
    if (!Object.hasOwn(anchors, name)) fail(`*${name} names no anchor before it`);
    return structuredClone(anchors[name]);
  }

  /** `[…]` and `{…}`, which may span lines (joined with \n) and hold comments. */
  function flow(text) {
    let i = 0;
    const ws = () => {
      for (;;) {
        while (i < text.length && /\s/u.test(text[i])) i += 1;
        if (text[i] === '#' && (i === 0 || /\s/u.test(text[i - 1]))) {
          while (i < text.length && text[i] !== '\n') i += 1;
        } else return;
      }
    };
    const quoted = () => {
      const q = text[i];
      let end = i + 1;
      if (q === '"') {
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
        if (end >= text.length) fail('a double-quoted string that never ends');
        const value = doubleQuoted(text.slice(i, end + 1));
        i = end + 1;
        return value;
      }
      let out = '';
      for (;;) {
        if (end >= text.length) fail('a single-quoted string that never ends');
        if (text[end] === "'") {
          if (text[end + 1] === "'") {
            out += "'";
            end += 2;
            continue;
          }
          break;
        }
        out += text[end];
        end += 1;
      }
      i = end + 1;
      return fold(out);
    };
    const plain = (inMap) => {
      const start = i;
      while (i < text.length) {
        const c = text[i];
        if (c === ',' || c === ']' || c === '}' || c === '\n') break;
        if (c === '#' && /\s/u.test(text[i - 1] ?? ' ')) break;
        if (inMap && c === ':' && (i + 1 >= text.length || /[\s,\]}]/u.test(text[i + 1]))) break;
        i += 1;
      }
      const s = text.slice(start, i).trim();
      if (!s) fail('an empty value in a flow collection');
      return plainValue(s);
    };
    const value = (inMap = false) => {
      ws();
      const c = text[i];
      if (c === '[') return seq();
      if (c === '{') return map();
      if (c === '"' || c === "'") return quoted();
      if (c === '*') {
        const m = /^\*([^\s,[\]{}]+)/u.exec(text.slice(i));
        if (!m) fail('an alias without a name');
        i += m[0].length;
        return alias(m[1]);
      }
      if (c === '&' || c === '!' || c === '|' || c === '>' || c === '@' || c === '`')
        fail(`a value in a flow collection this reader doesn't take: ${text.slice(i, i + 40)}`);
      return plain(inMap);
    };
    const seq = () => {
      i += 1;
      const list = [];
      for (;;) {
        ws();
        if (text[i] === ']') {
          i += 1;
          return list;
        }
        list.push(value());
        ws();
        if (text[i] === ',') i += 1;
        else if (text[i] !== ']') fail(`expected , or ] in a [list]: ${text.slice(i, i + 40)}`);
      }
    };
    const map = () => {
      i += 1;
      /** @type {Record<string, any>} */
      const obj = {};
      for (;;) {
        ws();
        if (text[i] === '}') {
          i += 1;
          return obj;
        }
        const key = text[i] === '"' || text[i] === "'" ? quoted() : plain(true);
        if (typeof key === 'object' && key !== null) fail('a key that is a collection');
        const name = String(key);
        if (Object.hasOwn(obj, name)) fail(`"${name}" twice in one mapping`);
        ws();
        if (text[i] === ':') {
          i += 1;
          ws();
          obj[name] = text[i] === ',' || text[i] === '}' ? null : value(true);
        } else obj[name] = null;
        ws();
        if (text[i] === ',') i += 1;
        else if (text[i] !== '}') fail(`expected , or } in a {mapping}: ${text.slice(i, i + 40)}`);
      }
    };
    const result = value();
    ws();
    if (i < text.length) fail(`text after a flow collection: ${text.slice(i, i + 40)}`);
    return result;
  }

  /** A double-quoted scalar (with its quotes), lines folded as YAML folds them. */
  function doubleQuoted(s) {
    try {
      return JSON.parse(fold(s).replace(/\n/gu, '\\n'));
    } catch {
      return fail(`a double-quoted string with an escape this reader doesn't take: ${s.slice(0, 40)}`);
    }
  }

  /** Whether `[`/`{` text closes, outside quotes and comments. */
  function closes(text) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quote) {
        if (quote === '"' && c === '\\') i += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (i === 0 || /\s/u.test(text[i - 1]))) {
        while (i < text.length && text[i] !== '\n') i += 1;
      } else if (c === '[' || c === '{') depth += 1;
      else if (c === ']' || c === '}') depth -= 1;
    }
    return depth <= 0 && !quote;
  }

  /**
   * A value that starts on line `pos` after `key:` or `- ` (its text `first`), taking the lines it continues on when
   * they're indented past `indent`: an unclosed flow collection or quote, or a plain scalar over several lines.
   */
  function inline(first, indent) {
    const s = first.trim();
    const start = pos;
    const more = () => {
      const next = pos + 1;
      if (next >= src.length) return null;
      const line = src[next];
      if (line.trim() && indentOf(line) <= indent) return null;
      pos = next;
      return line;
    };
    if (s[0] === '[' || s[0] === '{') {
      let text = s;
      while (!closes(text)) {
        const line = more();
        if (line === null) fail(`a ${s[0] === '[' ? '[list]' : '{mapping}'} that never ends`, start);
        text += `\n${line}`;
      }
      pos += 1;
      return flow(text);
    }
    if (s[0] === '"') {
      let text = s;
      const ended = (t) => /^"(?:[^"\\]|\\.)*"/su.exec(t);
      while (!ended(text)) {
        const line = more();
        if (line === null) fail('a double-quoted string that never ends', start);
        text += `\n${line}`;
      }
      const m = ended(text);
      const rest = text.slice(m[0].length).trim();
      if (rest && !rest.startsWith('#')) fail(`text after a quoted string: ${rest.slice(0, 40)}`);
      pos += 1;
      return doubleQuoted(m[0]);
    }
    if (s[0] === "'") {
      let text = s;
      const ended = (t) => /^'((?:[^']|'')*)'(?!')/su.exec(t);
      while (!ended(text)) {
        const line = more();
        if (line === null) fail('a single-quoted string that never ends', start);
        text += `\n${line}`;
      }
      const m = ended(text);
      const rest = text.slice(m[0].length).trim();
      if (rest && !rest.startsWith('#')) fail(`text after a quoted string: ${rest.slice(0, 40)}`);
      pos += 1;
      return fold(m[1].replace(/''/gu, "'"));
    }
    if (s[0] === '*') {
      const m = /^\*(\S+)\s*(#.*)?$/u.exec(s);
      if (!m) fail(`text after an alias: ${s.slice(0, 40)}`);
      pos += 1;
      return alias(m[1]);
    }
    if (/^[!%@`]/u.test(s)) fail(`a value this reader doesn't take: ${s.slice(0, 40)}`);
    let plain = s.replace(/\s+#.*$/u, '');
    const parts = [plain];
    let comment = /\s#/u.test(s);
    for (;;) {
      const next = pos + 1;
      if (comment || next >= src.length) break;
      const line = src[next];
      if (!line.trim()) {
        // A blank line inside a plain scalar is a line break, if the scalar goes on after it.
        let k = next;
        while (k < src.length && !src[k].trim()) k += 1;
        if (k >= src.length || indentOf(src[k]) <= indent || src[k].trim().startsWith('#')) break;
        parts.push('\n'.repeat(k - next));
        pos = k - 1;
        continue;
      }
      if (indentOf(line) <= indent || line.trim().startsWith('#')) break;
      const t = line.trim();
      comment = /\s#/u.test(t);
      parts.push(t.replace(/\s+#.*$/u, ''));
      pos = next;
    }
    plain = parts.reduce((out, p) => (p.startsWith('\n') ? out + p : out.endsWith('\n') ? out + p : `${out} ${p}`));
    if (/:\s/u.test(plain) || plain.endsWith(':'))
      fail(`a plain value can't hold ": " (quote it): ${plain.slice(0, 60)}`);
    pos += 1;
    return plainValue(plain);
  }

  function blockScalar(parent, style, chomp) {
    const lines = [];
    let indent = null;
    while (pos < src.length) {
      const line = src[pos];
      if (!line.trim()) {
        lines.push('');
        pos += 1;
        continue;
      }
      const n = indentOf(line);
      if (n <= parent) break;
      indent ??= n;
      if (n < indent) fail('a line of the block less indented than its first');
      lines.push(line.slice(indent));
      pos += 1;
    }
    let trailing = 0;
    while (lines.length && lines.at(-1) === '') {
      lines.pop();
      trailing += 1;
    }
    if (!lines.length) return '';
    let body = lines[0];
    for (let i = 1; i < lines.length; i += 1) {
      const cur = lines[i];
      const prev = lines[i - 1];
      if (style === '|' || cur === '' || /^\s/u.test(cur) || /^\s/u.test(prev)) body += `\n${cur}`;
      else if (prev === '') body += cur;
      else body += ` ${cur}`;
    }
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n'.repeat(1 + trailing);
    return `${body}\n`;
  }

  /** The value after `key:` (or after `- ` for an anchor), at the key's `indent`. */
  function valueAfter(rest, indent) {
    let anchor = null;
    const a = /^&(\S+)(?:\s+(.*))?$/u.exec(rest);
    if (a) {
      anchor = a[1];
      rest = (a[2] ?? '').trim();
    }
    let value;
    const b = BLOCK.exec(rest);
    if (b) {
      if (b[2] && b[3]) fail('a block scalar with two chomping indicators');
      pos += 1;
      value = blockScalar(indent, b[1], b[2] || b[3]);
    } else if (rest && !rest.startsWith('#')) {
      value = inline(rest, indent);
    } else {
      pos += 1;
      skip();
      const next = src[pos];
      if (next !== undefined && indentOf(next) === indent && isItem(next.trim())) value = sequence(indent);
      else value = block(indent + 1);
    }
    return anchor === null ? value : anchored(anchor, value);
  }

  function entry(obj, content, indent) {
    const m = KEY.exec(content);
    if (!m) fail(`expected "key: value": ${content.slice(0, 60)}`);
    const key = /^["']/u.test(m[1]) ? m[1].slice(1, -1) : m[1].trim();
    if (Object.hasOwn(obj, key)) fail(`"${key}" twice in one mapping`);
    obj[key] = valueAfter((m[2] ?? '').trim(), indent);
  }

  function mapping(indent, obj = {}) {
    for (;;) {
      skip();
      if (pos >= src.length) return obj;
      if (END.test(src[pos])) return obj;
      const n = indentOf(src[pos]);
      if (n < indent) return obj;
      if (n > indent) fail('more indented than the lines before it');
      const t = src[pos].trim();
      if (isItem(t)) return obj;
      entry(obj, t, indent);
    }
  }

  function sequence(indent) {
    const list = [];
    for (;;) {
      skip();
      if (pos >= src.length) return list;
      if (END.test(src[pos])) return list;
      const n = indentOf(src[pos]);
      if (n < indent) return list;
      if (n > indent) fail('more indented than the lines before it');
      const t = src[pos].trim();
      if (!isItem(t)) return list;
      const content = t.slice(1).trimStart();
      const at = n + (t.length - content.length);
      if (!content) {
        pos += 1;
        list.push(block(indent + 1));
      } else if (KEY.test(content) && !/^["'[{&*]/u.test(content.split(':')[0])) {
        const obj = {};
        entry(obj, content, at);
        list.push(mapping(at, obj));
      } else {
        list.push(valueAfter(content, indent));
      }
    }
  }

  function block(min) {
    skip();
    if (pos >= src.length) return null;
    const n = indentOf(src[pos]);
    if (n < min) return null;
    return isItem(src[pos].trim()) ? sequence(n) : mapping(n);
  }

  skip();
  if (pos < src.length && /^---(\s+#.*)?\s*$/u.test(src[pos])) pos += 1;
  const doc = block(0);
  skip();
  if (pos < src.length) fail(END.test(src[pos]) ? 'a second document in one file' : 'a line outside the document');
  return doc ?? {};
}
