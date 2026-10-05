// The landing page and the docs, built from site/content into site/public (BRK-8's Worker serves the result).
// Pure over the content, so site/build.mjs writes it and test/site-pages.test.js checks the written files match.
import { escape, frontMatter, inline, render } from './markdown.js';

export const SITE = {
  name: 'breakaway',
  url: 'https://leavethepack.dev',
  repo: 'https://github.com/TheAnarchoX/breakaway',
};

/** The picture a shared link shows (LCH-12): built by launch/tools/readme.mjs, also the repository's social preview. */
const CARD = {
  path: '/social.png',
  width: 2560,
  height: 1280,
  alt: 'breakaway: Leave the pack. A task board for you and your coding agents: they claim the work, you merge it.',
};

/** The docs, in reading order, in groups. `file` is in site/content/docs. */
export const DOCS = [
  { group: 'Start', pages: ['index', 'quickstart', 'concepts', 'playbook'] },
  { group: 'Use it', pages: ['web-board', 'cli', 'agents', 'features', 'ideas-decisions-pings', 'routines'] },
  { group: 'Connect', pages: ['github', 'plugin', 'taskwarrior'] },
  { group: 'Run it', pages: ['deploying', 'operations', 'architecture', 'api'] },
  { group: 'More', pages: ['faq'] },
];

const href = (name) => (name === 'index' ? '/docs/' : `/docs/${name}/`);

const NAV = [
  ['Docs', '/docs/'],
  ['Run your own', '/docs/quickstart/'],
  ['Source', SITE.repo],
];

/** The header every page shares. @param {string} current the path of the page, to mark the current section */
const header = (current) => `<header class="site-header">
  <a class="skip" href="#main">Skip to content</a>
  <div class="bar">
    <a class="brand" href="/" aria-label="breakaway, home">
      <img class="logo-dark" src="/logo/logo-on-dark.svg" width="161" height="19" alt="breakaway">
      <img class="logo-light" src="/logo/logo-on-light.svg" width="161" height="19" alt="" aria-hidden="true">
    </a>
    <nav aria-label="Main">
      <ul>
${NAV.map(([label, to]) => `        <li><a href="${to}"${to === '/docs/' && current.startsWith('/docs/') ? ' aria-current="true"' : ''}>${label}</a></li>`).join('\n')}
      </ul>
    </nav>
    <button class="theme" type="button" data-theme-toggle aria-label="Switch to the chalk theme">Chalk</button>
  </div>
</header>`;

const footer = () => `<footer class="site-footer">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <img class="logo-dark" src="/logo/logo-on-dark.svg" width="161" height="19" alt="breakaway">
        <img class="logo-light" src="/logo/logo-on-light.svg" width="161" height="19" alt="" aria-hidden="true">
        <p class="muted">Leave the pack.</p>
      </div>
      <nav aria-label="Docs">
        <h2 class="label">Docs</h2>
        <ul>
          <li><a href="/docs/quickstart/">Run your own board</a></li>
          <li><a href="/docs/concepts/">Concepts</a></li>
          <li><a href="/docs/cli/">The CLI</a></li>
          <li><a href="/docs/deploying/">Deploying and updating</a></li>
        </ul>
      </nav>
      <nav aria-label="Project">
        <h2 class="label">Project</h2>
        <ul>
          <li><a href="${SITE.repo}">breakaway on GitHub</a></li>
          <li><a href="${SITE.repo}/blob/main/LICENSE">Licence: FSL-1.1-Apache-2.0</a></li>
          <li><a href="${SITE.repo}/blob/main/SECURITY.md">Security</a></li>
          <li><a href="/releases.json">Update feed</a></li>
        </ul>
      </nav>
    </div>
    <p class="fine">breakaway is free and fair source: free to use, change, and self-host, and each release becomes Apache 2.0 two years after it ships. This page has no accounts, pricing, ads, or analytics. breakaway works with Claude Code, GitHub, Taskwarrior, and Cloudflare; none of them made it or endorse it.</p>
  </div>
</footer>`;

/** @param {{ title: string, description: string, path: string, body: string, bodyClass?: string }} page */
function shell({ title, description, path, body, bodyClass = '' }) {
  const full = title === SITE.name ? SITE.name : `${title} · ${SITE.name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(full)}</title>
<meta name="description" content="${escape(description)}">
<meta name="color-scheme" content="dark light">
<link rel="canonical" href="${SITE.url}${path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:title" content="${escape(full)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${SITE.url}${path}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE.url}${CARD.path}">
<meta property="og:image:width" content="${CARD.width}">
<meta property="og:image:height" content="${CARD.height}">
<meta property="og:image:alt" content="${escape(CARD.alt)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="/fonts/archivo-latin-wdth-italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/site.css">
<script src="/theme.js"></script>
</head>
<body class="${bodyClass}">
${header(path)}
${body}
${footer()}
<script src="/site.js" defer></script>
</body>
</html>
`;
}

/** The sidebar of the docs: every page, grouped, with the current one marked. */
function sidebar(pages, current) {
  const groups = DOCS.map(({ group, pages: names }) => {
    const items = names
      .map((name) => {
        const page = pages.get(name);
        const here = name === current;
        return `<li><a href="${href(name)}"${here ? ' aria-current="page"' : ''}>${escape(page.meta.nav ?? page.meta.title)}</a></li>`;
      })
      .join('');
    return `<div class="side-group"><h2 class="label">${group}</h2><ul>${items}</ul></div>`;
  }).join('\n');
  return `<nav class="docs-nav" aria-label="Docs">
  <details class="docs-menu" open>
    <summary>Docs menu</summary>
    ${groups}
  </details>
</nav>`;
}

const flat = () => DOCS.flatMap((g) => g.pages);

function pager(pages, current) {
  const order = flat();
  const at = order.indexOf(current);
  const link = (name, dir) =>
    name
      ? `<a class="pager-${dir}" href="${href(name)}"><span class="label">${dir === 'prev' ? 'Previous' : 'Next'}</span><span>${escape(pages.get(name).meta.nav ?? pages.get(name).meta.title)}</span></a>`
      : '<span></span>';
  return `<nav class="pager" aria-label="Next and previous pages">${link(order[at - 1], 'prev')}${link(order[at + 1], 'next')}</nav>`;
}

/**
 * Builds every page.
 * @param {{ landing: string, docs: Record<string, string>, notFound?: string }} content file contents by name
 * @returns {Map<string, string>} the files to write, by path under site/public
 */
export function buildPages(content) {
  const files = new Map();

  const landing = frontMatter(content.landing);
  files.set(
    'index.html',
    shell({
      title: SITE.name,
      description: landing.meta.description,
      path: '/',
      body: landing.body,
      bodyClass: 'landing',
    }),
  );

  const pages = new Map();
  for (const name of flat()) {
    const source = content.docs[name];
    if (source === undefined) throw new Error(`site/content/docs/${name}.md is missing.`);
    const { meta, body } = frontMatter(source);
    if (!meta.title || !meta.description)
      throw new Error(`${name}.md needs a title and a description in its front matter.`);
    pages.set(name, { meta, ...render(body) });
  }

  for (const [name, page] of pages) {
    const path = href(name);
    const toc = page.headings.filter((h) => h.level === 2);
    const contents =
      toc.length > 2
        ? `<nav class="toc" aria-label="On this page"><h2 class="label">On this page</h2><ul>${toc.map((h) => `<li><a href="#${h.id}">${escape(h.text)}</a></li>`).join('')}</ul></nav>`
        : '';
    const body = `<div class="wrap docs">
  ${sidebar(pages, name)}
  <main id="main" class="doc" tabindex="-1">
    <p class="label kicker">${escape(DOCS.find((g) => g.pages.includes(name)).group)}</p>
    <h1>${inline(page.meta.title)}</h1>
    <p class="lede">${inline(page.meta.description)}</p>
    ${page.html}
    ${pager(pages, name)}
  </main>
  ${contents}
</div>`;
    files.set(
      `${path.slice(1)}index.html`,
      shell({
        title: page.meta.title.replace(/`/gu, ''),
        description: page.meta.description.replace(/`/gu, ''),
        path,
        body,
      }),
    );
  }

  const missing = content.notFound ?? '';
  files.set(
    '404.html',
    shell({
      title: 'Not found',
      description: 'That page isn’t here.',
      path: '/404.html',
      body: `<main id="main" class="wrap doc" tabindex="-1"><p class="label kicker">404</p><h1>Nothing here.</h1><p class="lede">That page isn’t on the site. Try <a href="/docs/">the docs</a> or go back to <a href="/">the start</a>.</p>${missing}</main>`,
    }),
  );
  return files;
}

/** The site's own links in the docs (`/docs/agents/`), made absolute, for text read away from the site. */
const absolute = (markdown) => markdown.replace(/\]\(\/(?!\/)/gu, `](${SITE.url}/`);

/** A docs page as Markdown, served at /docs/<name>.md: its title, its description, and its text. */
const pageMarkdown = (meta, body) => `# ${meta.title}\n\n> ${meta.description}\n\n${absolute(body).trim()}\n`;

/**
 * What agents and language models read (LCH-10, the llms.txt convention): /llms.txt, an index of the docs with each
 * page's description and its Markdown; /llms-full.txt, every page's text in reading order; and /docs/<name>.md, each
 * page as Markdown. Built from the same content as the pages, so they never drift. Path → text.
 * @param {{ landing: string, docs: Record<string, string> }} content
 */
export function buildLlms(content) {
  const files = new Map();
  const landing = frontMatter(content.landing);
  const meta = (name) => frontMatter(content.docs[name]).meta;
  const index = [
    `# ${SITE.name}`,
    '',
    `> ${landing.meta.description}`,
    '',
    'breakaway is one Cloudflare Worker and one Durable Object that each person runs on their own account. Agents claim tasks atomically, open pull requests that close them, and ping the person who runs the board when only they can help; that person merges and deploys. It has a web board, a CLI (`npx breakaway`), and Taskwarrior sync.',
    '',
    '## Set it up',
    '',
    `- [The install prompt](${SITE.url}/install.md): paste "Set up a breakaway board for me. Read ${SITE.url}/install.md and follow it." into Claude Code, and it sets up a board with its owner, step by step.`,
    '',
  ];
  for (const { group, pages } of DOCS) {
    index.push(`## ${group}`, '');
    for (const name of pages) {
      const m = meta(name);
      index.push(`- [${m.title}](${SITE.url}/docs/${name}.md): ${m.description}`);
    }
    index.push('');
  }
  index.push(
    '## Optional',
    '',
    `- [Every docs page in one file](${SITE.url}/llms-full.txt)`,
    `- [The source](${SITE.repo}): the Worker, the web app, the CLI, and the agents' prompts`,
    `- [The update feed](${SITE.url}/releases.json): the latest release in each channel, as JSON`,
    '',
  );
  files.set('llms.txt', index.join('\n'));

  const full = [`# ${SITE.name}: the docs`, '', `> ${landing.meta.description}`, ''];
  for (const name of flat()) {
    const { meta: m, body } = frontMatter(content.docs[name]);
    files.set(`docs/${name}.md`, pageMarkdown(m, body));
    full.push(`Source: ${SITE.url}${href(name)}`, '', pageMarkdown(m, body), '---', '');
  }
  files.set('llms-full.txt', full.join('\n'));
  return files;
}
