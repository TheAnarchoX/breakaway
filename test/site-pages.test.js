import { describe, expect, it } from 'vitest';
import { ARCHITECT, buildLlms, buildPages, DOCS, LICENSING, MEDIA, SITE } from '../site/lib/site.js';
import { frontMatter, render, slug } from '../site/lib/markdown.js';
import { lint } from '../scripts/lib/brand-lint.js';
import TOKENS from '../brand/tokens.css?raw';
import SITE_TOKENS from '../site/public/tokens.css?raw';
import INDEX from '../site/content/index.html?raw';
import ARCHITECT_SOURCE from '../site/content/architect.md?raw';
import LICENSING_SOURCE from '../site/content/licensing.md?raw';
import ROADMAP from '../site/content/roadmap.json';
import ARCHITECT_MD from '../site/public/architect.md?raw';
import LICENSING_MD from '../site/public/licensing.md?raw';
import EXCEPTION_FORM from '../.github/ISSUE_TEMPLATE/licence-exception.yml?raw';
import README from '../README.md?raw';
import LICENSING_FILE from '../LICENSING.md?raw';
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
const content = { landing: INDEX, architect: ARCHITECT_SOURCE, licensing: LICENSING_SOURCE, roadmap: ROADMAP, docs };
const built = buildPages(content);
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
    const llms = buildLlms(content);
    expect(llms.get('llms.txt')).toBe(LLMS);
    expect(llms.get('llms-full.txt')).toBe(LLMS_FULL);
    expect(llms.get('architect.md')).toBe(ARCHITECT_MD);
    expect(llms.get('licensing.md')).toBe(LICENSING_MD);
    const pages = [...llms].filter(([path]) => path.startsWith('docs/'));
    for (const [path, text] of pages) expect(DOCS_MD[`../site/public/${path}`], path).toBe(text);
    expect(Object.keys(DOCS_MD).length).toBe(pages.length);
    // The llmstxt.org shape: the name, a one-line summary, then sections of links. Every page and the install prompt.
    expect(LLMS).toMatch(/^# breakaway\n\n> \S/u);
    for (const name of Object.keys(docs)) expect(LLMS).toContain(`${SITE.url}/docs/${name}.md)`);
    expect(LLMS).toContain(`${SITE.url}/install.md`);
    expect(LLMS).toContain(`${SITE.url}/architect.md)`);
    expect(LLMS).toContain(`${SITE.url}/licensing.md)`);
    expect(LLMS_FULL).toContain(`Source: ${SITE.url}${LICENSING.path}`);
    expect(LLMS_FULL).toContain(`Source: ${SITE.url}${ARCHITECT.path}`);
    // Read away from the site, so every link of the site's own is absolute.
    expect(LLMS_FULL).not.toMatch(/\]\(\/(?!\/)/u);
    expect(ARCHITECT_MD).not.toMatch(/\]\(\/(?!\/)/u);
    expect(LICENSING_MD).not.toMatch(/\]\(\/(?!\/)/u);
    expect(
      lint([
        { path: 'site/public/llms.txt', text: LLMS },
        { path: 'site/public/llms-full.txt', text: LLMS_FULL },
        { path: 'site/public/architect.md', text: ARCHITECT_MD },
        { path: 'site/public/licensing.md', text: LICENSING_MD },
      ]),
    ).toEqual([]);
  });

  it('shows the social card when a page is shared (LCH-12), and the Architect page its own (LCH-33)', () => {
    expect(assets.has('/social.png') && assets.has('/social-architect.png')).toBe(true);
    const architect = built.get(ARCHITECT.file);
    expect(architect).toContain(`<meta property="og:image" content="${SITE.url}/social-architect.png">`);
    expect(architect).toMatch(
      /<meta property="og:image:alt" content="breakaway: Agents propose it\. You approve it\. [^"]+">/u,
    );
    expect(architect).toContain('<meta name="twitter:card" content="summary_large_image">');
    for (const [path, html] of built) {
      if (path === ARCHITECT.file) continue;
      expect(html, path).toContain(`<meta property="og:image" content="${SITE.url}/social.png">`);
      expect(html, path).toContain('<meta property="og:image:width" content="2560">');
      expect(html, path).toContain('<meta property="og:image:height" content="1280">');
      expect(html, path).toMatch(/<meta property="og:image:alt" content="breakaway: Leave the pack\. [^"]+">/u);
      expect(html, path).toContain('<meta name="twitter:card" content="summary_large_image">');
    }
  });

  it('is committed as it builds (run node site/build.mjs)', () => {
    for (const [path, html] of built) expect(BUILT[`../site/public/${path}`], path).toBe(html);
    expect(Object.keys(BUILT).length).toBe(built.size);
  });

  it('tells Architect’s story on its own page, with LCH-32’s screenshots in both themes (LCH-33)', () => {
    const page = built.get(ARCHITECT.file);
    const text = visible(page);
    for (const step of [
      'The board sees what runs',
      'Agents propose by pull request',
      'You approve. The board applies.',
      'Bounds you set once',
      'When something breaks, it’s a task',
    ])
      expect(text).toContain(step);
    expect(text).toContain('Cloudflare first');
    expect(text).toContain('It only watches its own install.');
    // Apply is never a button: the page's buttons are links to read on, never an action.
    expect(page).not.toMatch(/<button[^>]*>\s*Apply/u);
    for (const name of MEDIA) {
      expect(assets.has(`/media/${name}`), name).toBe(true);
      // The landing page or the Architect page shows each one.
      expect(page + built.get('index.html'), name).toContain(`/media/${name}`);
    }
    for (const [tag] of page.matchAll(/<img\b[^>]*src="\/media\/[^>]*>/gu)) expect(tag).toMatch(/\salt="[^"]{20,}"/u);
    expect(built.get('index.html')).toContain(`href="${ARCHITECT.path}"`);
  });

  it('says who uses breakaway free, what counts as commercial, and how to ask for an exception, on its own page (DOC-43)', () => {
    const page = built.get(LICENSING.file);
    const text = visible(page);
    for (const heading of [
      'Who uses it free',
      'What counts as commercial',
      'Exceptions',
      'How to ask',
      'Releases before 2.0.0',
    ])
      expect(text).toContain(heading);
    expect(text).toContain('PolyForm Noncommercial License 1.0.0');
    expect(text).toContain('Worker co-ops');
    expect(text).toContain('Digital rights and privacy groups');
    expect(text).toContain('venture capital');
    expect(text).toContain('no promise of a yes');
    expect(text).toContain('FSL-1.1-Apache-2.0');
    expect(text).toContain('It isn’t legal advice');
    // How to ask is the issue form in this repository, which asks for what the page lists.
    expect(page).toContain(`${SITE.repo}/issues/new?template=licence-exception.yml`);
    for (const label of [
      'Who you are',
      'What kind of group you are',
      'How you’re owned and funded',
      'What you’d use breakaway for',
    ]) {
      expect(text).toContain(label);
      expect(EXCEPTION_FORM).toContain(`label: ${label.replace('’', "'")}`);
    }
    // Or in private, by email (DOC-45): the public issue first, then the address and the subject as text people
    // can select and copy, on the page, in LICENSING.md, and in the form's intro.
    const email = 'theanarchox@proton.me';
    const subject = 'breakaway licence exception: &lt;who you are&gt;';
    expect(page.indexOf('issues/new?template=licence-exception.yml')).toBeLessThan(page.indexOf(email));
    expect(page).toContain(`<pre><code>${email}</code></pre>`);
    expect(page).toContain(`<pre><code>${subject}</code></pre>`);
    for (const text of [LICENSING_FILE, EXCEPTION_FORM]) {
      expect(text).toContain(email);
      expect(text).toContain('breakaway licence exception: <who you are>');
    }
    // An exception is granted by a signed agreement (DOC-47): the page, LICENSING.md, and the form link its template.
    expect(page).toContain(`href="${SITE.repo}/blob/main/docs/licence-exception-agreement.md"`);
    expect(LICENSING_FILE).toContain('](docs/licence-exception-agreement.md)');
    expect(EXCEPTION_FORM).toContain('docs/licence-exception-agreement.md');
    // Linked from every page's footer, the landing page's licence line, the README, and LICENSING.md.
    for (const [path, html] of built) expect(html, path).toContain(`href="${LICENSING.path}"`);
    expect(INDEX).toContain(`<a href="${LICENSING.path}">`);
    expect(README).toContain(`${SITE.url}${LICENSING.path}`);
    expect(LICENSING_FILE).toContain(`${SITE.url}${LICENSING.path}`);
  });

  it('renders an image on its own line as a figure, in both themes when it’s a carbon screenshot', () => {
    const { html } = render('![A plan.](/media/plan-dark.png "On a phone.")\n\n![A logo.](/logo.svg)');
    expect(html).toContain('<img class="shot-dark" src="/media/plan-dark.png" alt="A plan."');
    expect(html).toContain('<img class="shot-light" src="/media/plan-light.png" alt="A plan."');
    expect(html).toContain('<figcaption>On a phone.</figcaption>');
    expect(html).toContain('<figure class="shot"><img src="/logo.svg" alt="A logo."');
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
      { path: 'site/content/architect.md', text: ARCHITECT_SOURCE },
      { path: 'site/content/licensing.md', text: LICENSING_SOURCE },
      ...Object.entries(docs).map(([name, text]) => ({ path: `site/content/docs/${name}.md`, text })),
    ];
    expect(lint(files)).toEqual([]);
  });

  it('says what the board does, never what someone shipped with it (ID-3), and names the licence without calling it open or fair source', () => {
    for (const [path, html] of built)
      expect(visible(html), path).not.toMatch(/\b160\b|pull requests in|editors? opened|real run/iu);
    const text = visible(built.get('index.html'));
    expect(text).toContain('PolyForm Noncommercial 1.0.0');
    expect(text).toMatch(/free for personal and noncommercial use/iu);
    expect(text).toMatch(/no accounts, pricing, ads, or analytics/u);
    for (const [path, html] of built)
      expect(visible(html), path).not.toMatch(/open[- ]source|fair source|Apache 2\.0 in two years/iu);
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
    expect(SITE.url).toBe('https://leavethepack.dev');
  });

  it('never says the name wrong or leans on the words the guide rules out', () => {
    // As the brand lint: not inside an identifier, like the X-Breakaway-Agent header the MCP page names.
    for (const [path, html] of built)
      expect(visible(html), path).not.toMatch(/(?<![\w./-])(Breakaway|BreakAway)(?![\w-])/u);
  });
});
