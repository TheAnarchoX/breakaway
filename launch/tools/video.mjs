// Builds the launch video: launch/media/launch.mp4 (1080 x 1080, 30 fps, 16 s) and launch-poster.png.
// The scene is one HTML page whose render(t) draws the exact frame for time t, so the render is
// deterministic. Motion follows the guide: fast out, no bounce, arrive from the left, leave to the right.
// Run: node video.mjs
import { readFileSync } from 'node:fs';
import { page, video, withBrowser } from './kit.mjs';

const OUT = new URL('../media/', import.meta.url);
const DURATION = 16;

// Each beat is [start, end] in seconds: what the board does, never what someone shipped with it (ID-3).
const BEATS = [
  { at: [0.3, 2.9], big: 'Write the<br>work down.', label: 'Tasks, or an idea an agent shapes' },
  { at: [2.9, 5.5], big: 'Agents<br>claim it.', label: 'One claim per task' },
  { at: [5.5, 8.1], big: 'You<br><span class="red">merge it.</span>', label: 'Pull requests close tasks' },
  { at: [8.1, 10.7], big: 'Yours<br>to run.', label: 'On your own Cloudflare account' },
];

// The mark's two slabs from the brand's own file: the pack, and the rider off the front, which breaks away.
const MARK = readFileSync(new URL('../../brand/logo/mark-on-dark.svg', import.meta.url), 'utf8');
const [pack, rider] = MARK.match(/<path [^>]+\/>/gu);
const BREAK = 48; // how far the rider goes, in the mark's units (the mark is 94.78 wide)
const VIEW = 94.78 + BREAK;

const css = `
.beat{position:absolute;left:84px;right:0;top:300px;opacity:0}
.beat .display{font-size:128px;line-height:.95;white-space:nowrap}
.beat .label{margin-top:34px;font-size:34px}
.ticks{position:absolute;left:84px;bottom:84px;display:flex;gap:14px}
.tick{width:56px;height:14px;background:var(--surface-3);transform:skewX(-10deg)}
.tick.on{background:var(--red)}
.mark{position:absolute;left:84px;top:0;height:440px;opacity:0;transform-origin:0 0}
.mark svg{height:100%;width:auto;display:block;overflow:visible}
.join{position:absolute;left:84px;right:84px;opacity:0}
.join.display{top:430px;font-size:132px;line-height:1}
.join.cmd{top:800px;font:600 44px var(--font-mono)}
.join.cmd i{font-style:normal;color:var(--muted)}
.join.label{top:890px}`;

const body = `
<div class="stage">
  ${BEATS.map((b, i) => `<div class="beat" id="b${i}"><div class="display">${b.big}</div><div class="label">${b.label}</div></div>`).join('')}
  <div class="ticks" id="ticks">${BEATS.map(() => '<i class="tick"></i>').join('')}</div>
  <div class="mark" id="mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -72.48 ${VIEW} 72.48" role="img" aria-label="breakaway">
    ${pack}<g id="rider">${rider}</g></svg></div>
  <div class="join display" id="line">Leave the pack.</div>
  <div class="join cmd" id="cmd"><i>$</i> npx breakaway</div>
  <div class="join label" id="note">Free · the source is public</div>
</div>`;

const script = `
const BEATS = ${JSON.stringify(BEATS.map((b) => b.at))};
const BREAK = ${BREAK};
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
// The ending: the mark arrives big, the rider breaks away to the right, and the mark rises to make room for the
// line, the command, and the note, which join it one after another.
const ARRIVE = 10.9, BREAKS = [11.6, 12.1], RISE = [12.6, 13.1], JOIN = [12.9, 13.15, 13.4];
window.render = (t) => {
  BEATS.forEach((w, i) => show(document.getElementById('b' + i), t, w));
  document.querySelectorAll('.tick').forEach((el, i) => el.classList.toggle('on', t >= BEATS[i][0] && t < BEATS[i][1]));
  document.getElementById('ticks').style.opacity = t < BEATS.at(-1)[1] ? 1 : 0;

  const mark = document.getElementById('mark');
  const arrive = out((t - ARRIVE) / IN);
  const rise = out((t - RISE[0]) / (RISE[1] - RISE[0]));
  mark.style.opacity = arrive;
  mark.style.transform =
    'translate(' + -70 * (1 - arrive) + 'px,' + lerp(320, 150, rise) + 'px) scale(' + lerp(1, 0.5, rise) + ')';
  const gap = out((t - BREAKS[0]) / (BREAKS[1] - BREAKS[0]));
  document.getElementById('rider').setAttribute('transform', 'translate(' + BREAK * gap + ' 0)');

  ['line', 'cmd', 'note'].forEach((id, i) => show(document.getElementById(id), t, [JOIN[i], 99], true));
};
window.render(0);`;

await withBrowser(async (context) => {
  await video(context, page({ body, css, script }), {
    duration: DURATION,
    out: new URL('launch.mp4', OUT).pathname,
    poster: { t: 15, out: new URL('launch-poster.png', OUT).pathname },
  });
  console.log('media/launch.mp4');
});
