import { describe, expect, it } from 'vitest';
import { buildLlms, buildPages, DOCS, SITE } from '../site/lib/site.js';
import { frontMatter, render, slug } from '../site/lib/markdown.js';
import { lint } from '../scripts/lib/brand-lint.js';
import TOKENS from '../brand/tokens.css?raw';
import SITE_TOKENS from '../site/public/tokens.css?raw';
import INDEX from '../site/content/index.html?raw';
import INSTALL_PROMPT from '../prompts/install.md?raw';
import SITE_INSTALL_PROMPT from '../site/public/install.md?raw';
import LLMS from '../site/public/llms.txt?raw';
import LLMS_FULL from '../site/public/llms-full.txt?raw';

// The landing page and the docs (LCH-2): the committed pages are what the content builds, every link lands,
// and the copy keeps the brand's claims and leaves out what the site must never have.

const DOC_SOURCES = import.meta.glob('../site/content/docs/*.md', { query: '?raw', import: 'default', eager: true });
const BUILT = import.meta.glob('../site/public/**/*.html', { query: '?raw', import: 'default', eager: true });
const DOCS_MD = import.meta.glob('../site/public/docs/*.md', { query: '?raw', import: 'default', eager: true });
const STATIC = import.meta.glob(['../site/public/**/*', '!../site/public/**/*.html'], {
  query: '?url',
  import: 'default',
  eager: true,
});

const docs = Object.fromEntries(
  Object.entries(DOC_SOURCES).map(([path, text]) => [path.replace(/^.*\/(.+)\.md$/u, '$1'), text]),
);
const built = buildPages({ landing: INDEX, docs });
const published = (path) => `/${path}`.replace(/index\.html$/u, '');
const known = new Set([...built.keys()].map(published));
const assets = new Set(Object.keys(STATIC).map((path) => path.replace('../site/public', '')));
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gu, '')
    .replace(/<style[\s\S]*?<\/style>/gu, '')
    .replace(/<[^>]+>/gu, ' ');

describe('the markdown', () => {
  it('renders the pieces the docs use', () => {
    const { html, headings } = render(
      '## A `code` heading\n\nText with **bold** and [a link](/x/).\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```sh\nnpx breakaway <ref>\n```\n\n> A note.',
    );
    expect(headings).toEqual([{ level: 2, id: 'a-code-heading', text: 'A code heading' }]);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="/x/">a link</a>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<th scope="col">a</th>');
    expect(html).toContain('npx breakaway &lt;ref&gt;');
    expect(html).toContain('<aside class="note"><p>A note.</p></aside>');
  });
  it('escapes what it should and leaves code alone', () => {
    expect(render('A `<b>` & <script>').html).toContain('<code>&lt;b&gt;</code> &amp; &lt;script&gt;');
    expect(slug('Run `your` own board')).toBe('run-your-own-board');
    expect(frontMatter('---\ntitle: T\n---\nbody').meta).toEqual({ title: 'T' });
  });
});

describe('the site', () => {
  it('has every page of the docs, in the list, with a title and a description', () => {
    const listed = DOCS.flatMap((group) => group.pages);
    expect(Object.keys(docs).sort()).toEqual([...listed].sort());
    for (const name of listed) {
      const { meta } = frontMatter(docs[name]);
      expect(meta.title, name).toBeTruthy();
      expect(meta.description, name).toBeTruthy();
    }
    expect(built.has('index.html') && built.has('404.html') && built.has('docs/index.html')).toBe(true);
  });

  it('serves the install prompt people paste into Claude Code, as prompts/install.md has it (DOC-8)', () => {
    expect(SITE_INSTALL_PROMPT).toBe(INSTALL_PROMPT);
    expect(INSTALL_PROMPT).toContain('Never ask for a secret in the chat');
  });

  it('serves llms.txt, llms-full.txt, and each page as Markdown, built from the docs (LCH-10)', () => {
    const llms = buildLlms({ landing: INDEX, docs });
    expect(llms.get('llms.txt')).toBe(LLMS);
    expect(llms.get('llms-full.txt')).toBe(LLMS_FULL);
    const pages = [...llms].filter(([path]) => path.endsWith('.md'));
    for (const [path, text] of pages) expect(DOCS_MD[`../site/public/${path}`], path).toBe(text);
    expect(Object.keys(DOCS_MD).length).toBe(pages.length);
    // The llmstxt.org shape: the name, a one-line summary, then sections of links. Every page and the install prompt.
    expect(LLMS).toMatch(/^# breakaway\n\n> \S/u);
    for (const name of Object.keys(docs)) expect(LLMS).toContain(`${SITE.url}/docs/${name}.md)`);
    expect(LLMS).toContain(`${SITE.url}/install.md`);
    // Read away from the site, so every link of the site's own is absolute.
    expect(LLMS_FULL).not.toMatch(/\]\(\/(?!\/)/u);
    expect(
      lint([
        { path: 'site/public/llms.txt', text: LLMS },
        { path: 'site/public/llms-full.txt', text: LLMS_FULL },
      ]),
    ).toEqual([]);
  });

  it('is committed as it builds (run node site/build.mjs)', () => {
    for (const [path, html] of built) expect(BUILT[`../site/public/${path}`], path).toBe(html);
    expect(Object.keys(BUILT).length).toBe(built.size);
  });

  it('wears the brand’s tokens exactly', () => {
    expect(SITE_TOKENS).toBe(TOKENS);
  });

  it('links only to pages, anchors, and files that exist', () => {
    for (const [path, html] of built) {
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]));
      for (const [, _attr, value] of html.matchAll(/\s(href|src)="([^"]*)"/gu)) {
        if (/^(https?:|mailto:)/u.test(value)) continue;
        const [target, hash] = value.split('#');
        if (target) {
          const ok = known.has(target) || assets.has(target) || target === '/releases.json';
          expect(ok, `${path} links to ${value}, which isn’t a page or file of the site`).toBe(true);
        }
        if (hash) {
          const page = target ? built.get(target === '/' ? 'index.html' : `${target.slice(1)}index.html`) : html;
          expect(page, `${path}: ${value}`).toBeDefined();
          expect(
            [...page.matchAll(/\sid="([^"]+)"/gu)].some((m) => m[1] === hash),
            `${path}: no #${hash} on ${target || path}`,
          ).toBe(true);
        }
      }
      expect(ids.size, path).toBeGreaterThan(0);
    }
  });

  it('has one h1, a skip link, a main landmark, and a language on every page', () => {
    for (const [path, html] of built) {
      expect(html.match(/<h1[\s>]/gu)?.length, path).toBe(1);
      expect(html, path).toContain('href="#main"');
      expect(html, path).toContain('id="main"');
      expect(html, path).toContain('<html lang="en">');
      expect(html, path).toContain('name="viewport"');
    }
  });

  it('gives every image a text alternative and every button a name', () => {
    for (const [path, html] of built) {
      for (const [tag] of html.matchAll(/<img\b[^>]*>/gu)) expect(tag, path).toMatch(/\salt="/u);
      for (const [, inner] of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gu))
        expect(inner.trim(), path).not.toBe('');
    }
  });

  it('passes the brand lint', () => {
    const files = [
      { path: 'site/content/index.html', text: INDEX },
      ...Object.entries(docs).map(([name, text]) => ({ path: `site/content/docs/${name}.md`, text })),
    ];
    expect(lint(files)).toEqual([]);
  });

  it('keeps the story to what the owner approved, and the licence to “free” and “fair source”', () => {
    const text = visible(built.get('index.html'));
    expect(text).toContain('160');
    expect(text).toMatch(/48/u);
    expect(text).toContain('editors opened');
    expect(text).toContain('FSL-1.1-Apache-2.0');
    expect(text).toContain('samewave');
    expect(text).toMatch(/non-commercial/u);
    // The FAQ may name the term once, to say why the licence isn’t called that.
    for (const html of built.values())
      expect(
        visible(html).replace(/The Open Source Initiative doesn’t count a fair source licence as open source/u, ''),
      ).not.toMatch(/open[- ]source/iu);
  });

  it('has no pricing, sign-ups, ads, analytics, or third-party requests', () => {
    for (const [path, html] of built) {
      expect(html, path).not.toMatch(/<form\b/iu);
      expect(html, path).not.toMatch(
        /googletagmanager|google-analytics|plausible|segment\.|mixpanel|hotjar|fonts\.googleapis|doubleclick/iu,
      );
      expect(html.match(/\s(?:src|href)="https?:\/\/[^"]*"/gu) ?? [], path).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.(js|css|woff2?)"$/u)]),
      );
      expect(visible(html), path).not.toMatch(/\$\d|per month|\/month|free trial|sign up|\bsubscribe\b|pricing plan/iu);
    }
    expect(SITE.url).toBe('https://breakaway.samewave.dev');
  });

  it('never says the name wrong or leans on the words the guide rules out', () => {
    for (const [path, html] of built) expect(visible(html), path).not.toMatch(/\b(Breakaway|BreakAway)\b/u);
  });
});
