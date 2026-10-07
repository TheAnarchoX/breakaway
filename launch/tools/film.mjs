// 2.0.0's film (LCH-38; launch/2.0.0.md, piece 6): the hero film, wide and square, and the 16 s cut, from the footage
// footage.mjs captured of the real board. Each shot is a frame holding one capture of a view, fitted to it; the view
// stays still and its layers (a map's nodes, a stream's entries, a card, a button) move: they arrive from the left,
// fast out, no bounce, and a shot leaves to the right. The line sits beside the board (wide) or above it (square).
// One red thing at a time: the line's red words, the red of a claimed work ID, or Approve as it fills.
// video.mjs renders it: node video.mjs film | film-square | 2-0-0.
import { existsSync, readFileSync } from 'node:fs';
import { page } from './kit.mjs';

const FOOTAGE = new URL('./footage/', import.meta.url);
const manifest = (name) => {
  const file = new URL(`${name}/manifest.json`, FOOTAGE);
  if (!existsSync(file)) throw new Error(`no footage for ${name}: run footage.mjs first (README.md in this folder)`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

// The words around the loop, in its order: the whole way, on one board.
const LOOP = [
  'idea',
  'task',
  'pull request',
  'merge',
  'deploy',
  'plan',
  'approve',
  'apply',
  'what runs',
  'signal',
  'incident',
  'task',
];

// Pushes as the board sends them (src/push.js): the install's name, then the body's lines.
const PUSH_PLAN = { title: 'widgets tasks', body: 'widgets’s staging: plan-2 waits for you' };
const PUSH_INCIDENT = {
  title: 'widgets tasks',
  body: 'WGT-41 needs you: incident<br>widgets-render is down: 3 of 3 instances failed their health check',
};

/** Map and stream, the part of a console the film reads: its map's nodes and the stream beside them. */
const CONSOLE = 'console';
const MAP = 'map';
/** A chase's tasks, in order; and the three short-lived environments. */
const ROWS = { width: 760, layers: ['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6', 'row-7', 'row-8'] };
const SHORT_LIVED = { layers: ['env-2', 'env-3', 'env-4'] };

/**
 * The hero film's shots (launch/2.0.0.md, "The hero film, shot by shot"). Each has its window, its line, and frames:
 * a capture shown from `from` to `to` (seconds), fitted by its `focus` (the capture's CSS px), with `anim`, the
 * frame's motion as code run each frame with `t`, `a` (the frame's start), and the helpers below.
 */
const HERO = [
  {
    at: [0, 4],
    big: 'Write the<br>work down.',
    label: 'An idea, shaped by an agent into tasks',
    frames: [
      {
        cap: 's-board',
        focus: 'lane',
        anim: `arrive(L('idea'), t, a + 0.5); [ 't12', 't13', 't14' ].forEach((k, i) => arrive(L(k), t, a + 1.4 + 0.2 * i));`,
      },
    ],
  },
  {
    at: [4, 8],
    big: 'Agents<br>claim it.',
    label: 'One claim per task',
    frames: [
      { cap: 's-task', to: 4.9 },
      {
        cap: 's-task-claimed',
        from: 4.7,
        fade: true,
        anim: `for (let i = 0; i < 11; i++) arrive(L('out-' + i), t, a + 0.35 + 0.15 * i, -24);`,
      },
    ],
  },
  {
    at: [8, 12.5],
    big: 'You<br><span class="red">merge it.</span>',
    label: 'Pull requests close tasks',
    frames: [
      { cap: 's-github', to: 10.4, focus: 'prs' },
      {
        cap: 's-board-done',
        from: 10.2,
        focus: 'done',
        anim: `arrive(L('t12'), t, a + 0.45);`,
      },
    ],
  },
  {
    at: [12.5, 19],
    big: 'See what<br>runs.',
    label: 'Health and estimated cost, on the board',
    frames: [
      {
        cap: 's-production',
        focus: CONSOLE,
        anim: `
          ['d1', 'd2'].forEach((k, i) => arrive(L(k), t, a + 0.4 + 0.15 * i));
          wipe(L('edges'), t, a + 0.8, 0.9);
          arrive(L('w'), t, a + 0.95);
          ['o2', 'o1', 'db'].forEach((k, i) => arrive(L(k), t, a + 1.35 + 0.15 * i));
          arrive(L('stream'), t, a + 2.6, -24);`,
      },
    ],
  },
  {
    at: [19, 25],
    big: 'Agents<br>propose it.',
    label: 'In a pull request, as a check',
    frames: [
      {
        cap: 'm-staging',
        focus: CONSOLE,
        anim: `
          ['kv', 'q', 'r2', 'c'].forEach((k, i) => arrive(L(k), t, a + 0.5 + 0.25 * i));
          ['stream-2', 'stream-1', 'stream-0'].forEach((k, i) => arrive(L(k), t, a + 1.8 + 0.35 * i, -24));`,
      },
    ],
  },
  {
    at: [25, 29],
    big: 'Or change<br>it yourself.',
    label: 'On the console. The board writes the pull request.',
    frames: [
      { cap: 'm-change-field', to: 26.6, focus: { height: 520 } },
      {
        cap: 'm-change',
        from: 26.4,
        fade: true,
        // The panel is as tall as the map beside it; its content is the top of it.
        focus: { height: 520 },
        press: { key: 'propose', at: 27.6, text: 'Propose the change', red: false },
      },
    ],
  },
  {
    at: [29, 34.5],
    big: 'You<br><span class="red">approve it.</span>',
    label: 'From your phone. No agent can.',
    frames: [
      {
        cap: 'm-plan-phone',
        to: 32.4,
        phone: true,
        push: { at: 29.4, until: 30.9, ...PUSH_PLAN },
        press: { key: 'approve', at: 31.3, text: 'Approve', red: true },
      },
      { cap: 'm-plan-phone-approved', from: 32.2, fade: true, phone: true },
    ],
  },
  {
    at: [34.5, 40.5],
    big: 'The board<br>applies it.',
    label: 'Then checks its health, and rolls back if it fails',
    frames: [
      { cap: 'm-staging', to: 35.9, focus: CONSOLE },
      {
        cap: 'm-staging-applied',
        from: 35.7,
        fade: true,
        focus: CONSOLE,
        anim: `['stream-4', 'stream-3', 'stream-2', 'stream-1', 'stream-0'].forEach((k, i) => arrive(L(k), t, a + 0.3 + 0.3 * i, -24));`,
      },
    ],
  },
  {
    at: [40.5, 48],
    big: 'Many agents.<br>One claim each.',
    label: 'A chase on one feature. You merge.',
    frames: [
      { cap: 'l-chase-ready', to: 42, focus: ROWS },
      {
        cap: 'l-chase',
        from: 41.8,
        fade: true,
        focus: ROWS,
        anim: `['row-3', 'row-4', 'row-5'].forEach((k, i) => arrive(L(k), t, a + 0.4 + 0.9 * i));
          ['row-9', 'row-10'].forEach((k, i) => arrive(L(k), t, a + 0.8 + 0.9 * i, -24));`,
      },
    ],
  },
  {
    at: [48, 54],
    big: 'An environment<br>per task.',
    label: 'Short-lived: it goes when its task is done, once you approve',
    frames: [
      {
        cap: 'l-infra',
        to: 51.6,
        focus: SHORT_LIVED,
        anim: `['env-2', 'env-3', 'env-4'].forEach((k, i) => arrive(L(k), t, a + 0.5 + 0.45 * i));`,
      },
      { cap: 'l-infra-closed', from: 51.4, fade: true, focus: SHORT_LIVED },
    ],
  },
  {
    at: [54, 60],
    big: 'Bounds you<br>set once.',
    label: 'The board scales inside them and tells you after',
    frames: [
      { cap: 'm-staging-applied', to: 55.4, focus: CONSOLE },
      {
        cap: 'l-staging-scaled',
        from: 55.2,
        fade: true,
        focus: CONSOLE,
        anim: `['stream-4', 'stream-3', 'stream-2', 'stream-1', 'stream-0'].forEach((k, i) => arrive(L(k), t, a + 0.3 + 0.3 * i, -24));`,
      },
    ],
  },
  {
    at: [60, 68],
    big: 'When it breaks,<br>it’s a task.',
    label: 'In the repository that owns what broke',
    frames: [
      { cap: 'm-production', to: 61, focus: CONSOLE },
      {
        cap: 'l-production-down',
        from: 60.8,
        to: 64,
        fade: true,
        focus: CONSOLE,
        push: { at: 61.5, until: 63.6, ...PUSH_INCIDENT },
        anim: `['stream-3', 'stream-2', 'stream-1', 'stream-0'].forEach((k, i) => arrive(L(k), t, a + 0.3 + 0.25 * i, -24));`,
      },
      { cap: 'l-incident', from: 63.8, focus: { height: 470 } },
    ],
  },
  {
    at: [68, 71],
    big: 'Back on<br>the board.',
    label: 'From the incident to the next task',
    frames: [{ cap: 'l-board', focus: 'lane', anim: `arrive(L('t42'), t, a + 0.45);` }],
  },
  {
    at: [71, 76],
    loop: true,
    big: 'From idea to incident,<br>on one board.',
    label: '',
    after: 'You <span class="red">decide.</span>',
  },
  { at: [76, 84], logo: true },
];

/** The 16 s cut (launch/2.0.0.md, "The 16 s cut"), square: the same scenes, cut to the spine. */
const CUT = [
  {
    at: [0.3, 3.6],
    big: 'Agents<br>propose it.',
    label: 'In a pull request',
    frames: [
      {
        cap: 'm-staging',
        focus: MAP,
        anim: `['kv', 'q', 'r2', 'c'].forEach((k, i) => arrive(L(k), t, a + 0.5 + 0.3 * i));`,
      },
    ],
  },
  {
    at: [3.6, 6.8],
    big: 'You<br><span class="red">approve it.</span>',
    label: 'From your phone. No agent can.',
    frames: [
      { cap: 'm-plan-phone', to: 5.7, phone: true, press: { key: 'approve', at: 4.7, text: 'Approve', red: true } },
      { cap: 'm-plan-phone-approved', from: 5.5, fade: true, phone: true },
    ],
  },
  {
    at: [6.8, 9.8],
    big: 'The board<br>applies it.',
    label: 'Then checks its health',
    frames: [
      { cap: 'm-staging', to: 7.5, focus: CONSOLE },
      {
        cap: 'm-staging-applied',
        from: 7.3,
        fade: true,
        focus: CONSOLE,
        anim: `['stream-3', 'stream-2', 'stream-1', 'stream-0'].forEach((k, i) => arrive(L(k), t, a + 0.25 + 0.25 * i, -24));`,
      },
    ],
  },
  { at: [9.8, 12], loop: true, fast: true, big: 'From idea<br>to incident.', label: 'On one board. You decide.' },
  { at: [12, 16], logo: true },
];

/** Where things go in each format: the line, the board's frame, and the logo. */
const LAYOUTS = {
  wide: {
    size: { width: 1920, height: 1080 },
    line: { left: 96, top: 330, width: 560, big: 74, label: 26 },
    board: { x: 680, y: 60, width: 1180, height: 960 },
  },
  square: {
    size: { width: 1080, height: 1080 },
    line: { left: 72, top: 56, width: 936, big: 64, label: 22, oneLine: true },
    board: { x: 60, y: 300, width: 960, height: 720 },
  },
};

const fit = (focus, box) => Math.min(box.width / focus.width, box.height / focus.height);

/** A capture as HTML: its base, then every layer at its box, each `[data-k]`. */
function capture(name) {
  const m = manifest(name);
  return {
    m,
    // Bigger layers first, so what sits inside one (a map's node inside its lines' box) is drawn over it.
    html: `<img class="base" src="${name}/base.png" style="width:${m.width}px;height:${m.height}px">${[...m.layers]
      .sort((x, y) => y.box.width * y.box.height - x.box.width * x.box.height)
      .map(
        (l) =>
          `<img class="ly" data-k="${l.key}" src="${name}/${l.file}" style="left:${l.box.x}px;top:${l.box.y}px;width:${l.box.width}px;height:${l.box.height}px">`,
      )
      .join('')}`,
  };
}

/** One frame: the capture fitted to the board's box (a desk view in a panel, a phone in a phone). */
function frame(shot, f, id, layout) {
  const { m, html } = capture(f.cap);
  const box = layout.board;
  // A phone, or a capture of one part of a view (a panel), shows whole; a region's name frames that part of the view,
  // with a little room around it; and a focus that leaves out a side keeps the whole capture's.
  const whole = { x: 0, y: 0, width: m.width, height: m.height };
  // Or the box around some of its layers (`{ layers: [...] }`).
  const boxes = (f.focus?.layers ?? []).map((k) => m.layers.find((l) => l.key === k)?.box).filter(Boolean);
  // Square, a console shows its map: the whole console would be too small to read.
  const named = f.focus === CONSOLE && layout.line.oneLine ? MAP : f.focus;
  const region =
    typeof named === 'string'
      ? m.regions?.[named]
      : boxes.length
        ? {
            x: Math.min(...boxes.map((b) => b.x)),
            y: Math.min(...boxes.map((b) => b.y)),
            width: Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x)),
            height: Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y)),
          }
        : null;
  if (typeof named === 'string' && !region)
    throw new Error(`${f.cap} has no region ${named}: capture it again with footage.mjs`);
  const pad = 14;
  const focus = f.phone
    ? whole
    : region
      ? {
          x: Math.max(0, region.x - pad),
          y: Math.max(0, region.y - pad),
          width: Math.min(m.width, region.width + 2 * pad),
          height: Math.min(m.height, region.height + 2 * pad),
        }
      : { ...whole, ...f.focus };
  // A region whose content sits at its left (a list's rows) keeps only `width` of it.
  if (region && f.focus?.width) focus.width = Math.min(focus.width, f.focus.width);
  const s = fit(focus, f.phone ? { width: box.width, height: box.height - 24 } : box);
  const w = focus.width * s;
  const h = focus.height * s;
  const left = box.x + (box.width - w) / 2;
  const top = box.y + (box.height - h) / 2;
  const layer = (key) => m.layers.find((l) => l.key === key);
  const press = f.press && layer(f.press.key);
  if (f.press && !press) throw new Error(`${f.cap} has no ${f.press.key} to press: capture it again with footage.mjs`);
  return {
    id,
    from: f.from ?? shot.at[0],
    to: f.to ?? shot.at[1],
    fade: Boolean(f.fade),
    last: shot.at[1] >= 99,
    anim: f.anim ?? '',
    press: f.press ? { ...f.press } : null,
    push: f.push ?? null,
    html: `<div class="frame${f.phone ? ' phone' : ''}" id="${id}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px">
      <div class="cap" style="width:${m.width}px;height:${m.height}px;transform:scale(${s}) translate(${-focus.x}px,${-focus.y}px)">${html}${
        press
          ? `<div class="press${f.press.red ? ' is-red' : ''}" style="left:${press.box.x}px;top:${press.box.y}px;width:${press.box.width}px;height:${press.box.height}px"><i></i><em>${f.press.text}</em></div>`
          : ''
      }</div></div>${
        f.push
          ? `<div class="push" id="${id}-push" style="left:${left + (f.phone ? 12 : w - 520)}px;top:${top + 12}px;width:${f.phone ? w - 24 : 500}px"><b>${f.push.title}</b><span>now</span><p>${f.push.body}</p></div>`
          : ''
      }`,
  };
}

/** The loop: its words around a ring, arriving one after another, and the marker that travels it once. */
function loopSvg(layout, fast) {
  const { board } = layout;
  const cx = board.x + board.width / 2;
  const cy = board.y + board.height / 2 + (layout.size.width > 1080 ? 0 : 20);
  const r = Math.min(board.width, board.height) * 0.36;
  const words = LOOP.map((w, i) => {
    const angle = -Math.PI / 2 + (i / LOOP.length) * Math.PI * 2;
    const x = cx + Math.cos(angle) * (r + 64);
    const y = cy + Math.sin(angle) * (r + 64);
    const anchor = Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    return `<text class="loop-word" data-i="${i}" x="${x}" y="${y + 10}" text-anchor="${anchor}">${w}</text>`;
  }).join('');
  return `<svg class="loop" id="loop" width="${layout.size.width}" height="${layout.size.height}" data-fast="${fast ? 1 : 0}">
    <circle cx="${cx}" cy="${cy}" r="${r}" class="loop-ring" id="ring" pathLength="1"/>
    <circle cx="${cx}" cy="${cy - r}" r="14" class="loop-marker" id="marker" data-cx="${cx}" data-cy="${cy}" data-r="${r}"/>
    ${words}</svg>`;
}

const css = (layout) => `
html,body{width:${layout.size.width}px;height:${layout.size.height}px}
.stage{width:${layout.size.width}px;height:${layout.size.height}px}
.line{position:absolute;left:${layout.line.left}px;top:${layout.line.top}px;width:${layout.line.width}px;opacity:0}
.line .display{font-size:${layout.line.big}px;line-height:.98}

.line .label{margin-top:${layout.line.oneLine ? 18 : 30}px;font-size:${layout.line.label}px;line-height:1.35;letter-spacing:.08em}
.frame{position:absolute;overflow:hidden;opacity:0;border-radius:var(--radius-l);border:1px solid var(--surface-3);background:var(--bg)}
.frame.phone{border:2px solid var(--surface-3);border-radius:44px}
.cap{position:absolute;left:0;top:0;transform-origin:0 0}
.cap img{position:absolute;display:block}
.cap .base{left:0;top:0}
.press{position:absolute;overflow:hidden;border-radius:var(--radius);opacity:0;display:flex;align-items:center;justify-content:center}
.press i{position:absolute;inset:0;background:var(--text);transform-origin:0 50%;transform:scaleX(0)}
.press.is-red i{background:var(--red)}
.press em{position:relative;font:700 17px var(--font-body);font-style:normal;color:var(--bg)}
.press.is-red em{color:var(--on-red)}
.push{position:absolute;padding:16px 20px;border-radius:22px;background:var(--surface-2);border:1px solid var(--surface-3);box-shadow:0 18px 50px rgb(0 0 0 / .45);opacity:0;display:grid;grid-template-columns:1fr auto;gap:4px 12px}
.push b{font:700 19px var(--font-body)}
.push span{font:500 16px var(--font-body);color:var(--muted)}
.push p{grid-column:1/-1;font:400 18px/1.35 var(--font-body)}
.loop{position:absolute;left:0;top:0;opacity:0}
.loop-ring{fill:none;stroke:var(--surface-3);stroke-width:6;stroke-dasharray:1;stroke-dashoffset:1}
.loop-marker{fill:var(--red);opacity:0}
.loop-word{font:600 ${layout.size.width > 1080 ? 30 : 26}px var(--font-mono);fill:var(--text);opacity:0}
${LOGO_CSS(layout)}`;

// The ending, as the launch's film has it: the mark arrives big, the rider snaps off the pack into its place, and the
// name, "Leave the pack.", the command, and the note join it one after another.
const LOGO = readFileSync(new URL('../../brand/logo/logo-on-dark.svg', import.meta.url), 'utf8');
const [pack, rider, name] = LOGO.match(/<path [^>]+\/>/gu);
const VIEW = LOGO.match(/viewBox="([^"]+)"/u)[1];
const [, , VW, VH] = VIEW.split(' ').map(Number);
const GAP = 16;
const BIG = 440 / 72.48;
const LOGO_CSS = (layout) => {
  const wide = layout.size.width > 1080;
  return `
.logo-move{position:absolute;left:0;top:0;opacity:0;transform-origin:0 0}
.logo-move svg{width:${VW * BIG}px;height:${VH * BIG}px;display:block}
.join{position:absolute;left:${wide ? 240 : 84}px;right:84px;opacity:0}
.join.display{top:${wide ? 520 : 480}px;font-size:${wide ? 150 : 132}px;line-height:1}
.join.cmd{top:${wide ? 720 : 810}px;font:600 44px var(--font-mono)}
.join.cmd i{font-style:normal;color:var(--muted)}
.join.label{top:${wide ? 810 : 900}px;font-size:26px}`;
};

/** The page for one format and cut: its HTML, duration, and poster time. */
export function filmPage({ format = 'wide', cut = false } = {}) {
  const layout = LAYOUTS[format];
  const shots = cut ? CUT : HERO;
  const end = shots.at(-1).at[1];
  const frames = [];
  const lines = [];
  let loop = null;
  let logoAt = null;
  shots.forEach((shot, i) => {
    if (shot.logo) logoAt = shot.at[0];
    if (shot.loop) loop = shot;
    if (shot.big)
      lines.push({
        // A line that another follows (the loop's "You decide.") leaves first, and the next takes its place.
        at: shot.after ? [shot.at[0], shot.at[0] + 2.5] : shot.at,
        html: `<div class="line" id="line${i}"><div class="display">${layout.line.oneLine ? shot.big.replaceAll('<br>', ' ') : shot.big}</div>${shot.label ? `<div class="label">${shot.label}</div>` : ''}</div>`,
      });
    for (const [j, f] of (shot.frames ?? []).entries()) frames.push(frame(shot, f, `f${i}-${j}`, layout));
  });
  const wide = layout.size.width > 1080;
  const body = `<div class="stage">
    ${lines.map((l) => l.html).join('')}
    ${frames.map((f) => f.html).join('')}
    ${loop ? loopSvg(layout, loop.fast) : ''}
    ${loop?.after ? `<div class="line then" id="then"><div class="display">${loop.after}</div></div>` : ''}
    <div class="logo-move" id="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}" role="img" aria-label="breakaway">
      ${pack}<g id="rider">${rider}</g><g id="name" opacity="0">${name}</g></svg></div>
    <div class="join display" id="leave">Leave the pack.</div>
    <div class="join cmd" id="cmd"><i>$</i> npx breakaway</div>
    <div class="join label" id="note">Free · the source is public</div>
  </div>`;
  const script = `
const clamp = (x) => Math.max(0, Math.min(1, x));
const out = (x) => 1 - Math.pow(1 - clamp(x), 4);
const IN = 0.28, OUT = 0.18;
const lerp = (a, b, k) => a + (b - a) * k;
// In from the left over IN, out to the right over OUT; a fade only crossfades.
function show(el, t, a, b, { fade = false, last = false } = {}) {
  const inn = out((t - a) / (fade ? 0.2 : IN)), gone = last ? 0 : out((t - (b - OUT)) / OUT);
  el.style.opacity = inn * (1 - gone);
  el.style.transform = fade ? '' : 'translateX(' + (-70 * (1 - inn) + 90 * gone) + 'px)';
}
function arrive(el, t, t0, dx = -40) {
  if (!el) return;
  const k = out((t - t0) / IN);
  el.style.opacity = k;
  el.style.transform = 'translateX(' + dx * (1 - k) + 'px)';
}
function wipe(el, t, t0, d) {
  if (!el) return;
  const k = out((t - t0) / d);
  el.style.opacity = k > 0 ? 1 : 0;
  el.style.clipPath = 'inset(0 ' + (100 * (1 - k)) + '% 0 0)';
}
const LINES = ${JSON.stringify(lines.map((l) => ({ id: l.html.match(/id="(line\d+)"/u)[1], at: l.at })))};
const FRAMES = ${JSON.stringify(frames.map(({ id, from, to, fade, press, push }) => ({ id, from, to, fade, press, push })))};
const ANIMS = {${frames
    .filter((f) => f.anim)
    .map((f) => `'${f.id}': (t, a, L) => { ${f.anim} }`)
    .join(',\n')}};
const LOOPAT = ${JSON.stringify(loop ? loop.at : null)}, LOGOAT = ${JSON.stringify(logoAt)}, END = ${end};
const GAP = ${GAP}, SHRINK = ${(wide ? 900 : 760) / VW / BIG}, LOGO_X = ${wide ? 240 : 84}, LOGO_Y = ${JSON.stringify(wide ? [300, 240] : [320, 250])};
window.render = (t) => {
  LINES.forEach((l) => show(document.getElementById(l.id), t, l.at[0], l.at[1]));
  for (const f of FRAMES) {
    const el = document.getElementById(f.id);
    show(el, t, f.from, f.to, { fade: f.fade });
    const L = (k) => el.querySelector('[data-k="' + k + '"]');
    if (ANIMS[f.id]) ANIMS[f.id](t, f.from, L);
    if (f.press) {
      const p = el.querySelector('.press');
      p.style.opacity = t >= f.press.at ? 1 : 0;
      p.querySelector('i').style.transform = 'scaleX(' + out((t - f.press.at) / 0.35) + ')';
      const k = clamp((t - f.press.at) / 0.22);
      p.style.transform = 'scale(' + (1 - 0.05 * Math.sin(Math.PI * k)) + ')';
    }
    if (f.push) {
      const p = document.getElementById(f.id + '-push');
      const k = out((t - f.push.at) / IN), g = out((t - f.push.until) / OUT);
      p.style.opacity = k * (1 - g);
      p.style.transform = 'translateY(' + (-40 * (1 - k)) + 'px)';
    }
  }
  if (LOOPAT) loop(t);
  if (LOGOAT !== null) logo(t - LOGOAT);
};
function loop(t) {
  const [a, b] = LOOPAT;
  const svg = document.getElementById('loop');
  const fast = svg.dataset.fast === '1';
  show(svg, t, a, b, { fade: true });
  const words = svg.querySelectorAll('.loop-word');
  const step = fast ? 0.07 : 0.16;
  words.forEach((w, i) => {
    const k = out((t - a - 0.3 - step * i) / IN);
    w.style.opacity = k;
    w.setAttribute('transform', 'translate(' + (-24 * (1 - k)) + ' 0)');
  });
  const draw = out((t - a - 0.1) / (fast ? 0.9 : 2.2));
  document.getElementById('ring').style.strokeDashoffset = 1 - draw;
  const m = document.getElementById('marker');
  // One lap, done before the line's red word arrives: then it goes, so one red thing is on screen at a time.
  const travel = clamp((t - a - (fast ? 0.5 : 0.9)) / (fast ? 1.2 : 1.6));
  const angle = -Math.PI / 2 + travel * Math.PI * 2;
  m.setAttribute('cx', +m.dataset.cx + Math.cos(angle) * m.dataset.r);
  m.setAttribute('cy', +m.dataset.cy + Math.sin(angle) * m.dataset.r);
  m.style.opacity = travel > 0 && travel < 1 ? 1 : 0;
  const then = document.getElementById('then');
  if (then) show(then, t, a + 2.6, b);
}
// The ending, timed from its start: as the launch film's.
function logo(t) {
  const ARRIVE = 0.2, SNAP = [0.9, 1.1], SETTLE = [1.6, 2.1], NAME = 2.05, JOIN = [2.35, 2.6, 2.85];
  const el = document.getElementById('logo');
  const arrive_ = out((t - ARRIVE) / IN);
  const settle = out((t - SETTLE[0]) / (SETTLE[1] - SETTLE[0]));
  el.style.opacity = arrive_;
  el.style.transform = 'translate(' + (LOGO_X - 70 * (1 - arrive_)) + 'px,' + lerp(LOGO_Y[0], LOGO_Y[1], settle) + 'px) scale(' + lerp(1, SHRINK, settle) + ')';
  const snap = out((t - SNAP[0]) / (SNAP[1] - SNAP[0]));
  document.getElementById('rider').setAttribute('transform', 'translate(' + -GAP * (1 - snap) + ' 0)');
  const named = out((t - NAME) / IN);
  const n = document.getElementById('name');
  n.setAttribute('opacity', named);
  n.setAttribute('transform', 'translate(' + -24 * (1 - named) + ' 0)');
  ['leave', 'cmd', 'note'].forEach((id, i) => show(document.getElementById(id), t, JOIN[i], 99, { last: true }));
}
window.render(0);`;
  // The posters: the phone with Approve pressed (shot 7 in the hero film, shot 2 in the cut).
  const approve = frames.find((f) => f.press?.key === 'approve');
  return {
    html: page({ body, css: css(layout), script }),
    duration: end,
    size: layout.size,
    poster: approve.press.at + 0.5,
  };
}
