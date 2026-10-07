// The README's screenshots of the board (DOC-7, DOC-36): docs/media/<name>-dark.png and -light.png, in carbon and chalk.
// They're of a local board seeded with made-up work (seed.sh), never a real one. Run: node screens.mjs [name ...]
// with the board's web app at BOARD (default http://localhost:5173) and its token in BREAKAWAY_TOKEN.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('../../docs/media/', import.meta.url);
const BOARD = process.env.BOARD ?? 'http://localhost:5173';
const TOKEN = process.env.BREAKAWAY_TOKEN;
if (!TOKEN) throw new Error('Set BREAKAWAY_TOKEN to the local board’s token.');

const VIEWS = {
  // The board, as you first see it.
  board: { hash: '#/board', viewport: { width: 1440, height: 900 } },
  // A task with an agent's live output: the panel only.
  task: {
    hash: '#/board?task=APP-2',
    viewport: { width: 1440, height: 1020 },
    clip: { x: 982, y: 168, width: 458, height: 852 },
  },
  // An agent's question in the inbox: the card only.
  inbox: { hash: '#/inbox', viewport: { width: 1440, height: 900 }, clip: { x: 236, y: 158, width: 852, height: 164 } },
  // The board on a phone.
  phone: { hash: '#/board', viewport: { width: 390, height: 844 }, mobile: true },
  // A chased feature (DOC-36): its tasks in order, and the chase with its plan and who rides it.
  chase: { hash: '#/roadmap?feature=inbox-filters', viewport: { width: 1440, height: 1000 } },
  // Architect (LCH-32), on the launch board seeded by seed.sh and architect.mjs: the Infrastructure view, ...
  infra: { hash: '#/infrastructure', viewport: { width: 1440, height: 600 } },
  // ... staging's page, with the plan that waits and the change before it in the stream, ...
  environment: { hash: '#/infrastructure/1', viewport: { width: 1440, height: 900 } },
  // ... that plan on a phone, with Approve, ...
  plan: { hash: '#/infrastructure/1?plan=plan-2', viewport: { width: 390, height: 844 }, mobile: true },
  // ... production's envelope in the repository's settings, ...
  envelope: { hash: '#/settings/widgets', viewport: { width: 1440, height: 1400 }, element: '.ifs-envs' },
  // ... and production's incident, a task on the board: the panel only.
  incident: {
    hash: '#/board?task=APP-9',
    viewport: { width: 1440, height: 1020 },
    clip: { x: 982, y: 168, width: 458, height: 852 },
  },
};

const only = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ||
    ['/usr/sbin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)),
});
try {
  for (const [name, v] of Object.entries(VIEWS)) {
    if (only.length && !only.includes(name)) continue;
    for (const scheme of ['dark', 'light']) {
      const context = await browser.newContext({
        viewport: v.viewport,
        deviceScaleFactor: 2,
        isMobile: Boolean(v.mobile),
        hasTouch: Boolean(v.mobile),
        colorScheme: scheme,
        reducedMotion: 'reduce',
        extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
      });
      const page = await context.newPage();
      // A local board has no agent routine; a set-up board does, so its hints for setting one up stay out of the shot.
      await page.route('**/api/agents', async (route) => {
        const json = await (await route.fetch()).json();
        await route.fulfill({ json: { ...json, connected: true } });
      });
      // A local board has no cron, push, or Taskwarrior replica, which a set-up board has: its count of connections
      // that need attention stays out of the shot too.
      await page.route(/\/api\/(health|connections)$/u, async (route) => {
        const json = await (await route.fetch()).json();
        if (json.connections && !Array.isArray(json.connections)) json.connections.attention = 0;
        else json.attention = 0;
        await route.fulfill({ json });
      });
      await page.goto(`${BOARD}/${v.hash}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1200);
      const path = new URL(`${name}-${scheme}.png`, OUT).pathname;
      if (v.element) await page.locator(v.element).screenshot({ path });
      else await page.screenshot({ path, ...(v.clip ? { clip: v.clip } : {}) });
      console.log(`wrote docs/media/${name}-${scheme}.png`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
