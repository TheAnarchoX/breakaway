// Builds the launch videos (30 fps, with a poster frame): launch/media/launch.mp4 (1080 x 1080, 16 s), and 2.0.0's
// film (LCH-38, film.mjs): the hero film, launch/media/2-0-0-film.mp4 (1920 x 1080) and -square.mp4 (1080 x 1080), and
// its 16 s cut, launch/media/2-0-0.mp4. Each scene is one HTML page whose render(t) draws the exact frame for time t,
// so the render is deterministic. Motion follows the guide: fast out, no bounce, arrive from the left, leave to the
// right. Run: node video.mjs [launch|film|film-square|2-0-0]; the film's need footage.mjs's captures first.
import { readFileSync } from 'node:fs';
import { page, video, withBrowser } from './kit.mjs';

const OUT = new URL('../media/', import.meta.url);
const DURATION = 16;

// Each beat is [start, end] in seconds: what the board does, never what someone shipped with it (ID-3).
const VIDEOS = {
  launch: {
    beats: [
      { at: [0.3, 2.9], big: 'Write the<br>work down.', label: 'Tasks, or an idea an agent shapes' },
      { at: [2.9, 5.5], big: 'Agents<br>claim it.', label: 'One claim per task' },
      { at: [5.5, 8.1], big: 'You<br><span class="red">merge it.</span>', label: 'Pull requests close tasks' },
      { at: [8.1, 10.7], big: 'Yours<br>to run.', label: 'On your own Cloudflare account' },
    ],
  },
};
const NAME = process.argv[2] ?? 'launch';

// 2.0.0's film (LCH-38): the hero film, wide and square, and its 16 s cut for 9a, which replaces LCH-32's 2.0.0 video.
// They're drawn over the real board's views, from footage.mjs's captures (film.mjs).
const FILMS = {
  film: { format: 'wide', out: '2-0-0-film' },
  'film-square': { format: 'square', out: '2-0-0-film-square' },
  '2-0-0': { format: 'square', cut: true, out: '2-0-0' },
};
if (FILMS[NAME]) {
  const { filmPage } = await import('./film.mjs');
  const { format, cut, out } = FILMS[NAME];
  const film = filmPage({ format, cut });
  await withBrowser(async (context) => {
    await video(context, film.html, {
      duration: film.duration,
      size: film.size,
      file: new URL(`footage/${out}.html`, import.meta.url).pathname,
      out: new URL(`${out}.mp4`, OUT).pathname,
      poster: { t: film.poster, out: new URL(`${out}-poster.png`, OUT).pathname },
    });
  });
  console.log(`media/${out}.mp4`);
  process.exit(0);
}
const SCENE = VIDEOS[NAME];
if (!SCENE) throw new Error(`no video ${NAME}: ${Object.keys(VIDEOS).join(', ')}`);
const BEATS = SCENE.beats;

// The logo from the brand's own file: the pack, the rider off the front, and the name. The rider starts against the
// pack, closing the gap, and snaps off into its place.
const LOGO = readFileSync(new URL('../../brand/logo/logo-on-dark.svg', import.meta.url), 'utf8');
const [pack, rider, name] = LOGO.match(/<path [^>]+\/>/gu);
const VIEW = LOGO.match(/viewBox="([^"]+)"/u)[1];
const [, , VW, VH] = VIEW.split(' ').map(Number);
const GAP = 16; // the gap between the slabs, in the logo's units (the rider's edge sits 16 to the right of the pack's)
const BIG = 440 / 72.48; // px per unit while the mark is alone and big: 440 px tall
const END = 760 / VW; // px per unit at the end: the whole logo, 760 px wide

const css = `
.beat{position:absolute;left:84px;right:0;top:300px;opacity:0}
.beat .display{font-size:128px;line-height:.95;white-space:nowrap}
.beat .label{margin-top:34px;font-size:34px}
.ticks{position:absolute;left:84px;bottom:84px;display:flex;gap:14px}
.tick{width:56px;height:14px;background:var(--surface-3);transform:skewX(-10deg)}
.tick.on{background:var(--red)}
.logo-move{position:absolute;left:0;top:0;opacity:0;transform-origin:0 0}
.logo-move svg{width:${VW * BIG}px;height:${VH * BIG}px;display:block}
.join{position:absolute;left:84px;right:84px;opacity:0}
.join.display{top:480px;font-size:132px;line-height:1}
.join.cmd{top:810px;font:600 44px var(--font-mono)}
.join.cmd i{font-style:normal;color:var(--muted)}
.join.label{top:900px}
${SCENE.css ?? ''}`;

const body = `
<div class="stage">
  ${BEATS.map((b, i) => `<div class="beat" id="b${i}"><div class="display">${b.big}</div><div class="label">${b.label}</div></div>`).join('')}
  <div class="ticks" id="ticks">${BEATS.map(() => '<i class="tick"></i>').join('')}</div>
  <div class="logo-move" id="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}" role="img" aria-label="breakaway">
    ${pack}<g id="rider">${rider}</g><g id="name" opacity="0">${name}</g></svg></div>
  <div class="join display" id="line">Leave the pack.</div>
  <div class="join cmd" id="cmd"><i>$</i> npx breakaway</div>
  <div class="join label" id="note">Free · the source is public</div>
</div>`;

const script = `
const BEATS = ${JSON.stringify(BEATS.map((b) => b.at))};
const GAP = ${GAP}, SHRINK = ${END / BIG};
const clamp = (x) => Math.max(0, Math.min(1, x));
const out = (x) => 1 - Math.pow(1 - clamp(x), 4);       // fast out, no overshoot
const IN = 0.28, OUT = 0.18;                             // the guide's 280 ms and 180 ms
const lerp = (a, b, k) => a + (b - a) * k;
// 0 before the window, rises over IN, holds, falls over OUT: and where it sits on the x axis.
function show(el, t, [a, b], last) {
  const inn = out((t - a) / IN), gone = last ? 0 : out((t - (b - OUT)) / OUT);
  el.style.opacity = inn * (1 - gone);
  el.style.transform = 'translateX(' + (-70 * (1 - inn) + 90 * gone) + 'px)';
}
// The ending: the mark arrives big, one piece; the rider snaps off into its place; the mark becomes the logo and the
// name appears beside it; then the line, the command, and the note join it one after another.
const ARRIVE = 10.9, SNAP = [11.6, 11.8], SETTLE = [12.3, 12.8], NAME = 12.75, JOIN = [13.05, 13.3, 13.55];
window.render = (t) => {
  BEATS.forEach((w, i) => show(document.getElementById('b' + i), t, w));
  document.querySelectorAll('.tick').forEach((el, i) => el.classList.toggle('on', t >= BEATS[i][0] && t < BEATS[i][1]));
  document.getElementById('ticks').style.opacity = t < BEATS.at(-1)[1] ? 1 : 0;

  const logo = document.getElementById('logo');
  const arrive = out((t - ARRIVE) / IN);
  const settle = out((t - SETTLE[0]) / (SETTLE[1] - SETTLE[0]));
  logo.style.opacity = arrive;
  logo.style.transform =
    'translate(' + (84 - 70 * (1 - arrive)) + 'px,' + lerp(320, 250, settle) + 'px) scale(' + lerp(1, SHRINK, settle) + ')';
  const snap = out((t - SNAP[0]) / (SNAP[1] - SNAP[0]));
  document.getElementById('rider').setAttribute('transform', 'translate(' + -GAP * (1 - snap) + ' 0)');
  const named = out((t - NAME) / IN);
  const nameEl = document.getElementById('name');
  nameEl.setAttribute('opacity', named);
  nameEl.setAttribute('transform', 'translate(' + -24 * (1 - named) + ' 0)');

  ['line', 'cmd', 'note'].forEach((id, i) => show(document.getElementById(id), t, [JOIN[i], 99], true));
};
window.render(0);`;

await withBrowser(async (context) => {
  await video(context, page({ body, css, script }), {
    duration: DURATION,
    out: new URL(`${NAME}.mp4`, OUT).pathname,
    poster: { t: SCENE.poster ?? 15, out: new URL(`${NAME}-poster.png`, OUT).pathname },
  });
  console.log(`media/${NAME}.mp4`);
});
