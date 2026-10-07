// The film's footage (LCH-38): the real board's views, captured from the launch board while architect.mjs's film steps
// move its made-up world along, so video.mjs can animate what the board really shows. Each capture is a view at one
// point in time, kept as layers: `base.png` (the view with its layers hidden), one PNG per layer (the view with only
// that layer showing, cut to its box), and `manifest.json` with each layer's box. A scene moves the layers; the view
// under them stays still. Run it against a fresh launch board, with the web app up (README.md in this folder):
//
//   node board.mjs                      # one shell
//   pnpm dev                            # another, from the repository's root
//   BREAKAWAY_URL=http://127.0.0.1:8787 BREAKAWAY_TOKEN=<its token> node footage.mjs
//
// It writes launch/tools/footage/ (not committed), then `node video.mjs film` renders from it.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { FILM_STEPS } from './architect.mjs';
import { TOKEN, URL_ } from './world.mjs';

const OUT = new URL('./footage/', import.meta.url);
const BOARD = process.env.BOARD ?? 'http://localhost:5173';
/** A 1080p screen: the film is 1080p, and its views are the board as it looks on one. */
const DESKTOP = { width: 1920, height: 1080 };
/** Everything right of the sidebar and under the top bar: the view itself. */
const MAIN = { x: 236, y: 60, width: 1684, height: 1020 };
const PHONE = { width: 390, height: 844 };
/** A task's panel runs taller than the screen: its agent's output fits in this one. */
const TALL = { width: 1920, height: 1200 };
const node = (name) => `g.topo-node[aria-label^="${name},"]`;
const card = (id) => `a.card-task[href$="task=${id}"]`;
/** The map's lines between its nodes, drawn as one layer. */
const EDGES = 'svg.topo-map > g:last-of-type > g:not(.topo-node)';
/** The parts of a view a shot frames (film.mjs's `focus`), each the box around what its selector matches. */
const LANE = '.col-head.col-decide, .col-head.col-active, .cell-ready a.card-task, .cell-active a.card-task';
const CONSOLE = {
  console: 'section.console-status, section.console-panel.topo, section.console-panel.stream',
  map: 'section.console-panel.topo',
};
const REGIONS = {
  's-board': { lane: LANE },
  's-board-claimed': { lane: LANE },
  'l-board': { lane: LANE },
  's-board-done': { done: `.col-head.col-blocked, .col-head.col-done, ${card('WGT-12')}` },
  's-github': { prs: 'div.gh-intro, section.gh-dash-prs' },
  's-production': CONSOLE,
  's-staging': CONSOLE,
  'm-staging': CONSOLE,
  'm-production': CONSOLE,
  'm-staging-applied': CONSOLE,
  'l-staging-scaled': CONSOLE,
  'l-production-down': CONSOLE,
  'l-infra': { envs: 'div.conn-top, ul.infra-envs' },
  'l-infra-closed': { envs: 'div.conn-top, ul.infra-envs' },
};

/**
 * What to capture after each step: a view (its hash), the part of it the film shows (`clip`, CSS px, or `element`),
 * what to do first (`prepare`), and its layers, by key: a selector (every match is one layer, `key-0`, `key-1`, ...,
 * unless `merge` makes them one).
 */
const CAPTURES = {
  shape: [
    {
      name: 's-board',
      hash: '#/board',
      clip: MAIN,
      layers: {
        idea: card('IDEA-7'),
        t12: card('WGT-12'),
        t13: card('WGT-13'),
        t14: card('WGT-14'),
      },
    },
    { name: 's-task', hash: '#/board?task=WGT-12', viewport: TALL, element: 'aside.panel' },
  ],
  claim: [
    {
      name: 's-task-claimed',
      hash: '#/board?task=WGT-12',
      viewport: TALL,
      element: 'aside.panel',
      layers: { out: 'li.log-entry' },
    },
    {
      name: 's-board-claimed',
      hash: '#/board',
      clip: MAIN,
      layers: { t12: card('WGT-12') },
    },
  ],
  pr: [
    { name: 's-github', hash: '#/github', clip: MAIN },
    { name: 's-task-pr', hash: '#/board?task=WGT-12', viewport: TALL, element: 'aside.panel' },
  ],
  merge: [
    {
      name: 's-board-done',
      hash: '#/board',
      clip: MAIN,
      layers: { t12: card('WGT-12') },
    },
    {
      name: 's-production',
      hash: '#/infrastructure/2',
      clip: MAIN,
      layers: {
        d1: node('widgets.example'),
        d2: node('www.widgets.example'),
        w: node('widgets-web'),
        o1: node('WidgetRoom'),
        o2: node('WidgetCounter'),
        db: node('widgets-db'),
        edges: EDGES,
        stream: 'li.stream-entry',
      },
    },
    {
      name: 's-staging',
      hash: '#/infrastructure/1',
      clip: MAIN,
      layers: { stream: { sel: 'li.stream-entry' } },
    },
  ],
  propose: [
    {
      name: 'm-staging',
      hash: '#/infrastructure/1',
      clip: MAIN,
      layers: {
        q: node('widgets-exports-staging'),
        c: node('widgets-render-staging'),
        r2: node('widgets-files-staging'),
        kv: node('widgets-cache-staging'),
        edges: EDGES,
        plan: 'a.infra-plan-row',
        stream: 'li.stream-entry',
      },
    },
    {
      name: 'm-plan-phone',
      hash: '#/infrastructure/1?plan=plan-2',
      viewport: PHONE,
      mobile: true,
      layers: { approve: { sel: 'button:has-text("Approve")' } },
    },
    {
      name: 'm-production',
      hash: '#/infrastructure/2',
      clip: MAIN,
      layers: { c: node('widgets-render') },
    },
    // Shot 6: you change production's render container yourself, on its console; the plan forms beside it.
    {
      name: 'm-change',
      hash: '#/infrastructure/2',
      viewport: TALL,
      signedIn: true,
      element: 'section.console-panel:has(:text-is("Your change"))',
      prepare: async (page) => {
        await page.locator(node('widgets-render')).click();
        await page
          .getByRole('button', { name: /^Change/ })
          .first()
          .click();
        await page.locator('#change-maxInstances').fill('6');
        await page.getByRole('button', { name: 'Add to the change' }).click();
        await page.waitForTimeout(2000);
        // The panel scrolls inside itself beside the map; the film shows all of it, Propose the change included.
        await page
          .locator('section.console-panel:has(:text-is("Your change"))')
          .evaluate((el) => Object.assign(el.style, { maxHeight: 'none', height: 'auto', overflow: 'visible' }));
        await page
          .locator('section.console-panel:has(:text-is("Your change"))')
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(300);
      },
      layers: { propose: 'section.console-panel:has(:text-is("Your change")) button:has-text("Propose")' },
    },
    // ... and before that, the field you typed in.
    {
      name: 'm-change-field',
      hash: '#/infrastructure/2',
      viewport: TALL,
      signedIn: true,
      element: 'section.console-panel:has(:text-is("Your change"))',
      prepare: async (page) => {
        await page.locator(node('widgets-render')).click();
        await page
          .getByRole('button', { name: /^Change/ })
          .first()
          .click();
        await page.locator('#change-maxInstances').fill('6');
        await page
          .locator('section.console-panel:has(:text-is("Your change"))')
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(300);
      },
    },
  ],
  approve: [{ name: 'm-plan-phone-approved', hash: '#/infrastructure/1?plan=plan-2', viewport: PHONE, mobile: true }],
  apply: [
    {
      name: 'm-staging-applied',
      hash: '#/infrastructure/1',
      clip: MAIN,
      layers: {
        q: node('widgets-exports-staging'),
        c: node('widgets-render-staging'),
        r2: node('widgets-files-staging'),
        kv: node('widgets-cache-staging'),
        stream: { sel: 'li.stream-entry' },
      },
    },
  ],
  chase: [
    {
      name: 'l-chase-ready',
      hash: '#/roadmap?feature=exports',
      clip: MAIN,
      layers: { row: 'main li' },
    },
  ],
  claims: [
    {
      name: 'l-chase',
      hash: '#/roadmap?feature=exports',
      clip: MAIN,
      layers: { row: 'main li' },
    },
  ],
  shortLived: [
    {
      name: 'l-infra',
      hash: '#/infrastructure',
      clip: MAIN,
      layers: { env: 'li.infra-env' },
    },
  ],
  closeOne: [
    {
      name: 'l-infra-closed',
      hash: '#/infrastructure',
      clip: MAIN,
      layers: { env: 'li.infra-env' },
    },
  ],
  envelope: [
    {
      name: 'l-staging-scaled',
      hash: '#/infrastructure/1',
      clip: MAIN,
      layers: {
        c: node('widgets-render-staging'),
        stream: { sel: 'li.stream-entry' },
      },
    },
  ],
  incident: [
    {
      name: 'l-production-down',
      hash: '#/infrastructure/2',
      clip: MAIN,
      layers: {
        c: node('widgets-render'),
        stream: { sel: 'li.stream-entry' },
      },
    },
    {
      name: 'l-incident',
      hash: '#/board?task=WGT-41',
      viewport: TALL,
      element: 'aside.panel',
      prepare: (page) =>
        page
          .locator('aside.panel h3:has-text("Incident"), aside.panel :text-is("Incident")')
          .first()
          .evaluate((el) => el.scrollIntoView({ block: 'start' })),
    },
    { name: 'l-inbox-phone', hash: '#/inbox', viewport: PHONE, mobile: true },
  ],
  followUp: [
    { name: 'l-roadmap', hash: '#/roadmap', clip: MAIN },
    {
      name: 'l-board',
      hash: '#/board',
      clip: MAIN,
      layers: { t42: card('WGT-42') },
    },
  ],
};

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ||
    ['/usr/sbin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)),
});

/** One capture: the view, its layers' boxes, the base without them, and each layer alone. */
async function capture(c) {
  const viewport = c.viewport ?? DESKTOP;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: Boolean(c.mobile),
    hasTouch: Boolean(c.mobile),
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    // The owner's presses (`signedIn`) ride on the cookie alone, as in their browser; the rest read with the token.
    // The app's service worker would make its requests out of the page's sight, so it stays off.
    ...(c.signedIn ? { serviceWorkers: 'block' } : { extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } }),
  });
  // A change from the console is the signed-in owner's (the bearer token only reads it): sign in as the owner does.
  // Behind Vite's proxy here, the Worker sees its own origin, not the page's, and takes a write only from it: the sign-in
  // and the presses say so, as they do when the Worker serves the app.
  const origin = new URL(URL_).origin;
  if (c.signedIn)
    await context.request.post(`${BOARD}/login`, {
      form: { token: TOKEN },
      headers: { Origin: origin },
      maxRedirects: 0,
    });
  const page = await context.newPage();
  if (c.signedIn)
    // The browser won't send another Origin, so Playwright makes the request itself and hands back its answer.
    await page.route('**/api/**', async (route) =>
      route.fulfill({ response: await route.fetch({ headers: { ...route.request().headers(), origin } }) }),
    );
  // As screens.mjs does: a set-up board's hints and counts stay out of the shot.
  await page.route('**/api/agents', async (route) => {
    const json = await (await route.fetch()).json();
    await route.fulfill({ json: { ...json, connected: true } });
  });
  await page.route(/\/api\/(health|connections)$/u, async (route) => {
    const json = await (await route.fetch()).json();
    if (json.connections && !Array.isArray(json.connections)) json.connections.attention = 0;
    else json.attention = 0;
    await route.fulfill({ json });
  });
  await page.goto(`${BOARD}/${c.hash}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  if (c.prepare) await c.prepare(page);
  // The film's views hold still: no caret, no hover.
  // A layer shows by itself even inside another one that's hidden (the map's lines wrap its target's node).
  await page.addStyleTag({
    content:
      '*{caret-color:transparent!important} .film-hide{visibility:hidden!important} [data-film-layer]:not(.film-hide){visibility:visible!important}',
  });
  await page.mouse.move(0, 0);

  const found = c.element
    ? await page.locator(c.element).first().boundingBox()
    : (c.clip ?? { x: 0, y: 0, ...viewport });
  // Only what's on the screen.
  const clip = { ...found, height: Math.min(found.height, viewport.height - found.y) };
  /** @type {Record<string, { x: number, y: number, width: number, height: number }>} */
  const regions = {};
  for (const [name, sel] of Object.entries(REGIONS[c.name] ?? {})) {
    const boxes = (await Promise.all((await page.locator(sel).all()).map((l) => l.boundingBox()))).filter(Boolean);
    if (!boxes.length) {
      console.warn(`  ${c.name}: no region ${name} (${sel})`);
      continue;
    }
    const x = Math.max(clip.x, Math.min(...boxes.map((b) => b.x)));
    const y = Math.max(clip.y, Math.min(...boxes.map((b) => b.y)));
    const right = Math.min(clip.x + clip.width, Math.max(...boxes.map((b) => b.x + b.width)));
    const bottom = Math.min(clip.y + clip.height, Math.max(...boxes.map((b) => b.y + b.height)));
    regions[name] = { x: x - clip.x, y: y - clip.y, width: right - x, height: bottom - y };
  }
  const dir = new URL(`${c.name}/`, OUT);
  mkdirSync(dir, { recursive: true });
  const layers = [];
  for (const [key, spec] of Object.entries(c.layers ?? {})) {
    const sel = typeof spec === 'string' ? spec : spec.sel;
    const handles = await page.locator(sel).elementHandles();
    if (!handles.length) console.warn(`  ${c.name}: no ${key} (${sel})`);
    for (const [i, h] of handles.entries()) {
      const box = await h.boundingBox();
      if (!box || box.width < 1) continue;
      const id = handles.length === 1 ? key : `${key}-${i}`;
      await h.evaluate((el, id) => el.setAttribute('data-film-layer', id), id);
      layers.push({ key: id, group: key, box });
    }
  }
  const hideAll = (except) =>
    page.evaluate(
      (except) =>
        document.querySelectorAll('[data-film-layer]').forEach((el) => {
          el.classList.toggle('film-hide', el.getAttribute('data-film-layer') !== except);
        }),
      except,
    );
  const shot = (path, region) => page.screenshot({ path: new URL(path, dir).pathname, clip: region });
  await shot('full.png', clip);
  await hideAll(null);
  await shot('base.png', clip);
  for (const l of layers) {
    await hideAll(l.key);
    // Only what's inside the capture: a layer that runs past it is cut at its edge.
    const x = Math.max(l.box.x, clip.x);
    const y = Math.max(l.box.y, clip.y);
    const region = {
      x,
      y,
      width: Math.min(l.box.x + l.box.width, clip.x + clip.width) - x,
      height: Math.min(l.box.y + l.box.height, clip.y + clip.height) - y,
    };
    if (region.width < 1 || region.height < 1) continue;
    await shot(`${l.key}.png`, region);
    l.box = { x: region.x - clip.x, y: region.y - clip.y, width: region.width, height: region.height };
    l.file = `${l.key}.png`;
  }
  writeFileSync(
    new URL('manifest.json', dir),
    `${JSON.stringify({ name: c.name, width: clip.width, height: clip.height, scale: 2, regions, layers: layers.filter((l) => l.file).map(({ key, group, box, file }) => ({ key, group, box, file })) }, null, 2)}\n`,
  );
  console.log(`  ${c.name}: ${layers.length} layers`);
  await context.close();
}

rmSync(OUT, { recursive: true, force: true });
try {
  for (const [step, run] of Object.entries(FILM_STEPS)) {
    await run();
    console.log(`film: ${step}`);
    for (const c of CAPTURES[step] ?? []) await capture(c);
  }
} finally {
  await browser.close();
}
