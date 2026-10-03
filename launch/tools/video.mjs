// Builds the launch video: launch/media/launch.mp4 (1080 x 1080, 30 fps, 16 s) and launch-poster.png.
// The scene is one HTML page whose render(t) draws the exact frame for time t, so the render is
// deterministic. Motion follows the guide: fast out, no bounce, arrive from the left, leave to the right.
// Run: node video.mjs
import { logoOnDark, page, video, withBrowser } from './kit.mjs';

const OUT = new URL('../media/', import.meta.url);
const DURATION = 16;

// Each beat is [start, end] in seconds. The numbers are the three approved facts, in the past tense.
const BEATS = [
  { at: [0.3, 2.9], big: '160', label: 'pull requests', red: true },
  { at: [2.9, 5.5], big: 'Under 48', label: 'hours', size: 168 },
  { at: [5.5, 8.1], big: 'One', label: 'person' },
  { at: [8.1, 10.7], big: '0', label: 'editors opened' },
];

const css = `
.beat{position:absolute;left:84px;right:0;top:330px;opacity:0}
.beat .display{font-size:250px;line-height:.95;white-space:nowrap}
.beat .label{margin-top:26px;font-size:34px}
.ticks{position:absolute;left:84px;bottom:84px;display:flex;gap:14px}
.tick{width:56px;height:14px;background:var(--surface-3);transform:skewX(-10deg)}
.tick.on{background:var(--red)}
.claim{position:absolute;left:84px;right:0;top:300px;opacity:0}
.claim .display{font-size:104px;line-height:1;white-space:nowrap}
.end{position:absolute;left:84px;right:84px;top:0;bottom:0;opacity:0}
.end .logo-big{position:absolute;left:0;top:250px;width:760px}
.end .logo-big svg{width:100%;height:auto;display:block}
.end .display{position:absolute;left:0;top:480px;font-size:132px}
.end .cmd{position:absolute;left:0;top:810px;font:600 44px var(--font-mono)}
.end .cmd i{font-style:normal;color:var(--muted)}
.end .label{position:absolute;left:0;top:900px}`;

const body = `
<div class="stage">
  ${BEATS.map((b, i) => `<div class="beat" id="b${i}"><div class="display ${b.red ? 'red' : ''}" style="${b.size ? `font-size:${b.size}px` : ''}">${b.big}</div><div class="label">${b.label}</div></div>`).join('')}
  <div class="ticks" id="ticks">${BEATS.map(() => '<i class="tick"></i>').join('')}</div>
  <div class="claim" id="claim"><div class="display">Agents claim<br>the work.<br><span class="red">You merge it.</span></div></div>
  <div class="end" id="end"><div class="logo-big">${logoOnDark}</div><div class="display">Leave the <span class="red">pack.</span></div>
    <div class="cmd"><i>$</i> npx breakaway</div><div class="label">Free · the source is public</div></div>
</div>`;

const script = `
const BEATS = ${JSON.stringify(BEATS.map((b) => b.at))};
const clamp = (x) => Math.max(0, Math.min(1, x));
const out = (x) => 1 - Math.pow(1 - clamp(x), 4);       // fast out, no overshoot
const IN = 0.28, OUT = 0.18;                             // the guide's 280 ms and 180 ms
// 0 before the window, rises over IN, holds, falls over OUT: and where it sits on the x axis.
function show(el, t, [a, b], last) {
  const inn = out((t - a) / IN), gone = last ? 0 : out((t - (b - OUT)) / OUT);
  el.style.opacity = inn * (1 - gone);
  el.style.transform = 'translateX(' + (-70 * (1 - inn) + 90 * gone) + 'px)';
}
window.render = (t) => {
  BEATS.forEach((w, i) => show(document.getElementById('b' + i), t, w));
  document.querySelectorAll('.tick').forEach((el, i) => el.classList.toggle('on', t >= BEATS[i][0] && t < BEATS[i][1]));
  document.getElementById('ticks').style.opacity = t < 10.7 ? 1 : 0;
  show(document.getElementById('claim'), t, [10.9, 13.2]);
  show(document.getElementById('end'), t, [13.4, 99], true);
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
