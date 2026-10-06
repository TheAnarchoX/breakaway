// Syntax highlighting (WEB-86) with highlight.js: the core and each language load the first time a diff or a code
// block needs them, so the board's first load carries none of it. Its markup becomes tokens (code.js), never HTML.
import { useEffect, useState } from 'preact/hooks';
import { languageOf, toLines } from './code.js';

/** One chunk per language, loaded when a file in it is shown. */
const LANGUAGES = import.meta.glob(['../../../node_modules/highlight.js/es/languages/*.js', '!**/*.js.js'], {
  import: 'default',
});
const loaderOf = (lang) => LANGUAGES[`../../../node_modules/highlight.js/es/languages/${lang}.js`];

/** Past this many characters, code shows plain: highlighting it would hold up the page. */
const MAX_CHARS = 300_000;

/** @type {Promise<any> | null} */
let core = null;
/** @type {Map<string, Promise<boolean>>} */
const loaded = new Map();

/**
 * highlight.js with `lang` registered, or null when it has no such language or loading failed.
 * @param {string} lang
 */
async function ready(lang) {
  const load = loaderOf(lang);
  if (!load) return null;
  core ??= import('highlight.js/lib/core').then((m) => m.default);
  if (!loaded.has(lang))
    loaded.set(
      lang,
      Promise.all([core, load()]).then(([hljs, define]) => {
        if (!hljs.getLanguage(lang)) hljs.registerLanguage(lang, define);
        return true;
      }),
    );
  try {
    const hljs = await core;
    return (await loaded.get(lang)) ? hljs : null;
  } catch {
    loaded.delete(lang);
    return null;
  }
}

/**
 * Lines of highlighted tokens for `code`, or null for plain text: an unknown language, code too long, or a failed load.
 * @param {string} code
 * @param {string | null} lang
 */
export async function highlight(code, lang) {
  if (!lang || code.length > MAX_CHARS) return null;
  const hljs = await ready(lang);
  if (!hljs) return null;
  try {
    return toLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}

/**
 * Highlighted lines for `code`, given a file path or a code fence's tag: null until they're ready, and for plain text.
 * @param {string} code
 * @param {string | null | undefined} pathOrTag
 */
export function useHighlight(code, pathOrTag) {
  const lang = languageOf(pathOrTag);
  const [lines, setLines] = useState(/** @type {ReturnType<typeof toLines> | null} */ (null));
  useEffect(() => {
    let live = true;
    setLines(null);
    highlight(code, lang).then((out) => {
      if (live) setLines(out);
    });
    return () => {
      live = false;
    };
  }, [code, lang]);
  return lines;
}

/**
 * Many pieces of code in one language at once (a diff's hunks, each side on its own): an array the same length, each
 * entry its lines or null. Null as a whole until they're ready.
 * @param {string[] | null} pieces
 * @param {string | null | undefined} path
 */
export function useHighlightAll(pieces, path) {
  const lang = languageOf(path);
  const key = pieces ? pieces.join('\u0000') : '';
  const [out, setOut] = useState(/** @type {(ReturnType<typeof toLines> | null)[] | null} */ (null));
  useEffect(() => {
    let live = true;
    setOut(null);
    if (!pieces || !lang || key.length > MAX_CHARS) return undefined;
    Promise.all(pieces.map((p) => highlight(p, lang))).then((all) => {
      if (live) setOut(all);
    });
    return () => {
      live = false;
    };
  }, [key, lang]);
  return out;
}

/**
 * One line of tokens as elements.
 * @param {{ cls: string | null, text: string }[]} tokens
 */
export function tokensOf(tokens) {
  return tokens.map((t, i) =>
    t.cls ? (
      <span key={i} class={t.cls}>
        {t.text}
      </span>
    ) : (
      t.text
    ),
  );
}

/**
 * A block of code, highlighted once its language loads and plain until then (and for a language highlight.js lacks).
 * @param {{ code: string, lang?: string | null, class?: string }} props
 */
export function CodeBlock({ code, lang = null, class: cls = 'md-code' }) {
  const lines = useHighlight(code, lang);
  return (
    <pre class={cls}>
      <code>{lines ? lines.map((line, i) => [i > 0 && '\n', ...tokensOf(line)]) : code}</code>
    </pre>
  );
}
