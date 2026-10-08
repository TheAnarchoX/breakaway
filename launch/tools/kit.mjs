// The launch kit's shared parts: the brand's tokens and fonts as one page, a still renderer, and a
// frame-by-frame video renderer. Scenes are plain HTML, so what you see in a browser is what ships.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const read = (url) => readFileSync(new URL(url, import.meta.url));
const font = (name, file) =>
  `data:font/woff2;base64,${readFileSync(require.resolve(`@fontsource-variable/${name}/files/${file}`)).toString('base64')}`;

/**
 * The licence's short line on the end cards and the self-hosting card, from the guide's short lines (brand/README.md,
 * The licence). The owner picks one; a re-render with another is this one change.
 */
export const LICENCE_LINE = 'Free for people, not for profit';

/** The brand's own files: tokens, and the logo drawn as outlines (no font needed). */
export const tokens = read('../../brand/tokens.css').toString();
export const logoOnDark = read('../../brand/logo/logo-on-dark.svg')
  .toString()
  .replace(/<title>.*?<\/title>/u, '');
export const logoOnLight = read('../../brand/logo/logo-on-light.svg')
  .toString()
  .replace(/<title>.*?<\/title>/u, '');

const FONTS = `
@font-face{font-family:'Archivo Variable';font-style:normal;font-weight:100 900;font-stretch:62% 125%;src:url(${font('archivo', 'archivo-latin-wdth-normal.woff2')}) format('woff2')}
@font-face{font-family:'Archivo Variable';font-style:italic;font-weight:100 900;font-stretch:62% 125%;src:url(${font('archivo', 'archivo-latin-wdth-italic.woff2')}) format('woff2')}
@font-face{font-family:'Chivo Mono Variable';font-style:normal;font-weight:100 900;src:url(${font('chivo-mono', 'chivo-mono-latin-wght-normal.woff2')}) format('woff2')}`;

/** Carbon grounds, flat color, hard edges: the type roles from the guide, as classes. */
const BASE = `
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1080px;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-body);-webkit-font-smoothing:antialiased}
.display{font:italic var(--display-weight) 120px/.94 var(--font-display);font-stretch:var(--display-stretch);letter-spacing:-.02em}
.red{color:var(--red)}
.label{font:600 22px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.mono{font-family:var(--font-mono)}
.lede{font:400 36px/1.4 var(--font-body);color:var(--muted)}
.chip{display:inline-block;padding:6px 14px;border-radius:var(--radius-xs);background:var(--red);color:var(--on-red);font:700 28px var(--font-mono)}
.stage{position:relative;width:1080px;height:1080px;overflow:hidden}
.logo{position:absolute;left:84px;top:84px;height:44px}
.logo svg{height:44px;width:auto;display:block}
.kicker{position:absolute;right:84px;top:92px}
.foot{position:absolute;left:84px;right:84px;bottom:72px;display:flex;justify-content:space-between;align-items:baseline}
.foot b{font:700 26px var(--font-mono)}
.foot span{font:600 20px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}`;

/** One 1080 px page: the tokens, the fonts, the base styles, then the scene's own. `theme` is dark (carbon) or light (chalk). */
export function page({ body, css = '', script = '', theme = 'dark' }) {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><style>${tokens}${FONTS}${BASE}${css}</style></head><body>${body}<script>${script}</script></body></html>`;
}

const CHROMIUM =
  process.env.CHROMIUM ||
  ['/usr/sbin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => {
    try {
      readFileSync(p, { flag: 'r' });
      return true;
    } catch {
      return false;
    }
  });

export async function withBrowser(run, { scale = 1 } = {}) {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: scale });
    return await run(context);
  } finally {
    await browser.close();
  }
}

const settle = (p) => p.evaluate(() => document.fonts.ready.then(() => document.fonts.size));

/** Renders html to a PNG at the context's scale (2x: 2160 px), or at `size` (CSS px) for a page that isn't square. */
export async function still(context, html, out, size = null) {
  const p = await context.newPage();
  if (size) await p.setViewportSize(size);
  await p.setContent(html);
  await settle(p);
  mkdirSync(dirname(out), { recursive: true });
  // A page that isn't square is shot to its .stage's own height.
  writeFileSync(out, await (size ? p.locator('.stage') : p).screenshot({ type: 'png' }));
  await p.close();
}

/**
 * Renders window.render(t, duration) for every frame and pipes the frames to ffmpeg: H.264, yuv420p, faststart, and an
 * optional poster frame at poster.t. `size` is the frame in px when it isn't the 1080 square; `file` keeps the page in
 * a file and opens it from there, so it can load images beside it (the film's footage).
 */
export async function video(context, html, { duration, fps = 30, out, poster, size, file }) {
  const p = await context.newPage();
  if (size) await p.setViewportSize(size);
  if (file) {
    writeFileSync(file, html);
    await p.goto(pathToFileURL(file).href);
  } else await p.setContent(html);
  await settle(p);
  mkdirSync(dirname(out), { recursive: true });
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      out,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise((resolve, reject) => {
    ffmpeg.on('exit', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve()));
  });
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await p.evaluate(([t, d]) => window.render(t, d), [i / fps, duration]);
    if (!ffmpeg.stdin.write(await p.screenshot({ type: 'png' })))
      await new Promise((r) => ffmpeg.stdin.once('drain', r));
  }
  ffmpeg.stdin.end();
  await done;
  if (poster) {
    await p.evaluate(([t, d]) => window.render(t, d), [poster.t, duration]);
    writeFileSync(poster.out, await p.screenshot({ type: 'png' }));
  }
  await p.close();
}
