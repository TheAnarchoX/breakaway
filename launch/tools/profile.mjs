// Builds the X profile images for @leavethepackdev (LCH-28): launch/media/profile/avatar.png, the app icon full
// bleed at 400 px (800 px at 2x), and launch/media/profile/header.png, 1500 by 500. Run: node profile.mjs [name ...]
//
// X crops the avatar to a circle, so the avatar is the maskable icon: the mark sits inside the safe circle. The
// header keeps its words on the right: X lays the avatar over its lower left, and crops its top and bottom on phones.
import { readFileSync } from 'node:fs';
import { page, still, withBrowser } from './kit.mjs';

const OUT = new URL('../media/profile/', import.meta.url);
const maskable = readFileSync(new URL('../../brand/logo/icon-maskable.svg', import.meta.url), 'utf8');

const SCENES = {
  avatar: {
    alt: 'The breakaway mark on carbon: a white slab and a narrow red slab with a gap between them, both leaning forward.',
    size: { width: 400, height: 400 },
    scale: 2,
    css: `html,body,.stage{width:400px;height:400px}.stage svg{display:block;width:400px;height:400px}`,
    body: `<div class="stage">${maskable}</div>`,
  },
  header: {
    alt: 'Leave the pack. in big white italic type with "pack." in red, on carbon. Below it: A task board for you and your coding agents. And: leavethepack.dev, npx breakaway.',
    size: { width: 1500, height: 500 },
    scale: 1,
    css: `
html,body,.stage{width:1500px;height:500px}
.copy{position:absolute;right:96px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right}
.copy .display{font-size:132px}
.copy .lede{margin-top:22px;font-size:32px}
.copy .mono{margin-top:14px;font:600 24px var(--font-mono);color:var(--muted)}`,
    body: `
<div class="stage">
  <div class="copy">
    <div class="display">Leave the <span class="red">pack.</span></div>
    <p class="lede">A task board for you and your coding agents.</p>
    <p class="mono">leavethepack.dev · npx breakaway</p>
  </div>
</div>`,
  },
};

const only = process.argv.slice(2);
for (const [name, scene] of Object.entries(SCENES)) {
  if (only.length && !only.includes(name)) continue;
  await withBrowser(
    async (context) => {
      await still(
        context,
        page({ body: scene.body, css: scene.css }),
        new URL(`${name}.png`, OUT).pathname,
        scene.size,
      );
      console.log(`media/profile/${name}.png`);
    },
    { scale: scene.scale },
  );
}
