// Renders the board's app icons (tools/tasks/web/public/icons) from the logo files build.mjs makes in
// brand/logo, so the installed app, the tab, and the home screen all show the gap (BRD-28).
//
// The SVGs are copied as they are; each PNG is rendered in Chromium. The apple-touch icon is the
// tile without its rounded corners, since iOS rounds them itself. The Claude Code plugin's icon is that square tile too,
// at 1024 px, as Anthropic's plugin directory asks for a square PNG (CLI-20).
//
//   cd brand/tools && npm install && npm run icons      (CHROMIUM=<path> if Chromium isn't at /usr/sbin/chromium)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const LOGO = new URL('../logo/', import.meta.url);
const ICONS = new URL('../../web/public/icons/', import.meta.url);
const PLUGIN = new URL('../../plugin/.claude-plugin/', import.meta.url);
const read = (name) => readFileSync(new URL(name, LOGO), 'utf8');

const SVGS = {
  'icon.svg': read('icon.svg'),
  'favicon.svg': read('favicon.svg'),
  'icon-maskable.svg': read('icon-maskable.svg'),
  'icon-monochrome.svg': read('icon-monochrome.svg'),
};
const SOURCES = { ...SVGS, 'apple-touch-icon.svg': SVGS['icon.svg'].replace(/ rx="[\d.]+"/u, '') };

const PNGS = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-192.png', 192],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon-monochrome.svg', 'icon-monochrome-512.png', 512],
  ['apple-touch-icon.svg', 'apple-touch-icon.png', 180],
  ['apple-touch-icon.svg', new URL('icon.png', PLUGIN), 1024],
];

mkdirSync(ICONS, { recursive: true });
for (const [name, source] of Object.entries(SVGS)) writeFileSync(new URL(name, ICONS), source);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/sbin/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
for (const [from, to, size] of PNGS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${SOURCES[from]}`,
  );
  const file = new URL(to, ICONS);
  writeFileSync(file, await page.screenshot({ omitBackground: true }));
  console.log(file.pathname.slice(new URL('../../', import.meta.url).pathname.length));
}
await browser.close();
