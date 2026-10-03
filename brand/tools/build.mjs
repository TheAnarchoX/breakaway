// Builds breakaway's logo files and preview sheets in brand/ (BRD-27): the logo (the gap, which the
// owner picked on BRD-32), the wordmark, the app icons, and sheets for the logo, the palette, and the type.
//
// The geometry lives here, the colors come from brand/tokens.css, and every word is drawn as
// outlines (Archivo and Chivo Mono, shaped with HarfBuzz), so the files look the same everywhere,
// GitHub included, with no fonts installed.
//
//   cd brand/tools && npm install && npm run build
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fontverter from 'fontverter';
import * as hb from 'harfbuzzjs';

const require = createRequire(import.meta.url);
const BRAND = new URL('../', import.meta.url);

// ---------- colors, from tokens.css ----------

const TOKENS = readFileSync(new URL('tokens.css', BRAND), 'utf8');
const declarations = (block) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map(([, name, value]) => [name, value.trim()]));
const CARBON_THEME = declarations(/^:root\s*\{([^}]*)\}/mu.exec(TOKENS)[1]);
const CHALK_THEME = {
  ...CARBON_THEME,
  ...declarations(/^:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/mu.exec(TOKENS)[1]),
};
const RED = CARBON_THEME['--red'];
// Red as small text fails on carbon (4.2:1), so labels in red use the accent, like the board does.
const ACCENT = CARBON_THEME['--accent'];
const ON_RED = CARBON_THEME['--on-red'];
const CARBON = CARBON_THEME['--carbon'];
const CHALK = CARBON_THEME['--chalk'];

// ---------- type, as outlines ----------

const fontFile = (name) => readFileSync(require.resolve(`@fontsource-variable/${name}`));
const face = async (woff2) => new hb.Face(new hb.Blob(await fontverter.convert(woff2, 'truetype')));
const FACES = {
  upright: await face(fontFile('archivo/files/archivo-latin-wdth-normal.woff2')),
  italic: await face(fontFile('archivo/files/archivo-latin-wdth-italic.woff2')),
  mono: await face(fontFile('chivo-mono/files/chivo-mono-latin-wght-normal.woff2')),
};

// The roles from the guide's Type section. Tracking is in em.
const STYLES = {
  display: { face: 'italic', axes: { wght: 850, wdth: 125 }, tracking: -0.02 },
  heading: { face: 'upright', axes: { wght: 700, wdth: 100 }, tracking: -0.015 },
  body: { face: 'upright', axes: { wght: 400, wdth: 100 } },
  label: { face: 'mono', axes: { wght: 650 }, tracking: 0.12, upper: true },
  mono: { face: 'mono', axes: { wght: 500 } },
  number: { face: 'mono', axes: { wght: 700 } },
};

const round = (n) => +n.toFixed(2);

/** Applies `fn` to every point of path data made of absolute M, L, Q, C, and Z (HarfBuzz's output and ours). */
function mapPath(d, fn) {
  return [...d.matchAll(/([MLQCZ])([^MLQCZ]*)/gu)]
    .map(([, command, args]) => {
      const numbers = args
        .trim()
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map(Number);
      const points = [];
      for (let i = 0; i < numbers.length; i += 2)
        points.push(
          fn(numbers[i], numbers[i + 1])
            .map(round)
            .join(' '),
        );
      return command + points.join(' ');
    })
    .join('');
}

/** The exact bounding box of such path data, curves included: [x0, y0, x1, y1]. */
function bounds(d) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  };
  let at = [0, 0];
  for (const [, command, args] of d.matchAll(/([MLQCZ])([^MLQCZ]*)/gu)) {
    const n = args
      .trim()
      .split(/[\s,]+/u)
      .filter(Boolean)
      .map(Number);
    if (command === 'M' || command === 'L') at = [n[0], n[1]];
    if (command === 'Q' || command === 'C') {
      const points = [at];
      for (let i = 0; i < n.length; i += 2) points.push([n[i], n[i + 1]]);
      for (let step = 0; step <= 64; step++) add(...bezier(points, step / 64));
      at = points.at(-1);
    }
    add(...at);
  }
  return box;
}
const bezier = (points, t) =>
  points.length === 1
    ? points[0]
    : bezier(
        points.slice(1).map((p, i) => [0, 1].map((k) => points[i][k] + (p[k] - points[i][k]) * t)),
        t,
      );

/** Text as one outline path: { d, width } in px, with the baseline at y = 0 and the pen starting at x = 0. */
function text(words, role, size, { tracking } = {}) {
  const style = STYLES[role];
  const hbFace = FACES[style.face];
  const font = new hb.Font(hbFace);
  font.setVariations(Object.entries(style.axes).map(([tag, value]) => new hb.Variation(tag, value)));
  const buffer = new hb.Buffer();
  buffer.addText(style.upper ? words.toUpperCase() : words);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const k = size / hbFace.upem;
  const gap = (tracking ?? style.tracking ?? 0) * hbFace.upem;
  const glyphs = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  let pen = 0;
  const parts = glyphs.map((glyph, i) => {
    const x = pen + positions[i].xOffset;
    pen += positions[i].xAdvance + (i < glyphs.length - 1 ? gap : 0);
    return mapPath(font.glyphToPath(glyph.codepoint), (px, py) => [(x + px) * k, -py * k]);
  });
  return { d: parts.join(''), width: pen * k };
}

/** A line of text placed at (x, y) (the baseline), aligned 'start', 'middle', or 'end'. */
function line(words, role, size, x, y, fill, { align = 'start', tracking } = {}) {
  const shaped = text(words, role, size, { tracking });
  const left = align === 'middle' ? x - shaped.width / 2 : align === 'end' ? x - shaped.width : x;
  return {
    svg: `<path transform="translate(${round(left)} ${round(y)})" d="${shaped.d}" fill="${fill}"/>`,
    width: shaped.width,
  };
}

// ---------- geometry ----------

// Everything that moves leans 10°, like Archivo's italic (9.9°, measured on its stems).
const LEAN = Math.tan((10 * Math.PI) / 180);

const WORDMARK = text('breakaway', 'display', 100);
const WORDMARK_BOX = bounds(WORDMARK.d);
// The marks stand on the wordmark's baseline and reach its ascender: the top of the b.
const CAP = -bounds(text('b', 'display', 100).d)[1];

const unit = ([x, y]) => {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
};

/** A polygon with each corner rounded by `r`, as path data. */
function rounded(points, r) {
  return `${points
    .map((p, i) => {
      const [a, b] = [points.at(i - 1), points[(i + 1) % points.length]];
      const [ua, ub] = [unit([a[0] - p[0], a[1] - p[1]]), unit([b[0] - p[0], b[1] - p[1]])];
      const start = [p[0] + ua[0] * r, p[1] + ua[1] * r].map(round);
      const end = [p[0] + ub[0] * r, p[1] + ub[1] * r].map(round);
      return `${i ? 'L' : 'M'}${start.join(' ')}Q${p.map(round).join(' ')} ${end.join(' ')}`;
    })
    .join('')}Z`;
}

/** A leaning slab from x0 to x1 on the baseline, `h` tall. */
const slab = (x0, x1, h, r) =>
  rounded(
    [
      [x0, 0],
      [x1, 0],
      [x1 + h * LEAN, -h],
      [x0 + h * LEAN, -h],
    ],
    r,
  );

// ---------- the logo: the gap ----------

// A slab for the pack, a gap, and a narrow red slab for the rider off the front, standing on the
// wordmark's baseline and as tall as its ascender. The gap is the point, so it's wide on purpose:
// wide enough to hold at 16 px. `ink` is the color that isn't red: chalk on carbon, carbon on chalk;
// `one` draws both slabs in one color.
const PACK = slab(0, 44, CAP, 3);
const RIDER = slab(60, 82, CAP, 3);
const MARK_BOX = [0, -CAP, 82 + CAP * LEAN, 0];
const mark = ({ ink, one }) => `<path d="${PACK}" fill="${one ?? ink}"/><path d="${RIDER}" fill="${one ?? RED}"/>`;

// ---------- files ----------

const TILE = 512;
const TILE_RADIUS = 96;
const svg = (viewBox, body, { title } = {}) => {
  const [, , w, h] = viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.map(round).join(' ')}" width="${round(w)}" height="${round(h)}"${title ? ' role="img"' : ''}>${title ? `<title>${title}</title>` : ''}\n${body}\n</svg>\n`;
};
const viewOf = ([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0];

/** The mark centered in a size×size square, `share` of the square's width wide. */
function centered(size, share, ink) {
  const [x0, y0, x1, y1] = MARK_BOX;
  const scale = (size * share) / (x1 - x0);
  const x = size / 2 - ((x0 + x1) / 2) * scale;
  const y = size / 2 - ((y0 + y1) / 2) * scale;
  return `<g transform="translate(${round(x)} ${round(y)}) scale(${round(scale * 1000) / 1000})">${mark(ink)}</g>`;
}

const tile = (radius) =>
  radius === undefined
    ? `<rect width="${TILE}" height="${TILE}" fill="${CARBON}"/>`
    : `<rect width="${TILE}" height="${TILE}" rx="${radius}" fill="${CARBON}"/>`;
const ICONS = {
  // The mark on a carbon tile, for browsers, desktops, and the install prompt.
  'icon.svg': `${tile(TILE_RADIUS)}${centered(TILE, 0.64, { ink: CHALK })}`,
  // A little bigger, for the 16 and 32 px a tab gives it.
  'favicon.svg': `${tile(TILE_RADIUS)}${centered(TILE, 0.78, { ink: CHALK })}`,
  // Full bleed: launchers crop to their own shape, so the mark sits inside the safe circle.
  'icon-maskable.svg': `${tile()}${centered(TILE, 0.5, { ink: CHALK })}`,
  // One color for themed icons: the launcher uses its shape.
  'icon-monochrome.svg': centered(TILE, 0.5, { one: '#fff' }),
};

const LOCKUP_GAP = 24;
/** The mark, then the wordmark, on the wordmark's baseline: the box and the body. */
function lockup(ink) {
  const [x0, y0, x1, y1] = MARK_BOX;
  const shift = x1 - x0 + LOCKUP_GAP - WORDMARK_BOX[0];
  const box = [0, Math.min(y0, WORDMARK_BOX[1]), shift + WORDMARK_BOX[2], Math.max(y1, WORDMARK_BOX[3])];
  const body = `<g transform="translate(${round(-x0)} 0)">${mark({ ink })}</g><path transform="translate(${round(shift)} 0)" d="${WORDMARK.d}" fill="${ink}"/>`;
  return { box, body };
}

const written = [];
function write(path, contents) {
  const url = new URL(path, BRAND);
  mkdirSync(new URL('./', url), { recursive: true });
  writeFileSync(url, contents);
  written.push(path);
}

rmSync(new URL('logo/', BRAND), { recursive: true, force: true });
rmSync(new URL('previews/', BRAND), { recursive: true, force: true });

for (const [name, ink] of [
  ['on-dark', CHALK],
  ['on-light', CARBON],
]) {
  const { box, body } = lockup(ink);
  write(`logo/logo-${name}.svg`, svg(viewOf(box), body, { title: 'breakaway' }));
  write(`logo/mark-${name}.svg`, svg(viewOf(MARK_BOX), mark({ ink }), { title: 'breakaway' }));
  write(
    `logo/wordmark-${name}.svg`,
    svg(viewOf(WORDMARK_BOX), `<path d="${WORDMARK.d}" fill="${ink}"/>`, { title: 'breakaway' }),
  );
}
write('logo/mark-one-color.svg', svg(viewOf(MARK_BOX), mark({ one: CARBON }), { title: 'breakaway' }));
for (const [name, body] of Object.entries(ICONS)) write(`logo/${name}`, svg([0, 0, TILE, TILE], body));

// ---------- preview sheets ----------

const W = 1600;
const PAD = 72;
const MUTED_DARK = CARBON_THEME['--muted'];
const MUTED_LIGHT = CHALK_THEME['--muted'];

/** An icon at `size` px, drawn from its body. */
const iconAt = (body, x, y, size) =>
  `<g transform="translate(${round(x)} ${round(y)}) scale(${round((size / TILE) * 10000) / 10000})">${body}</g>`;
/** The mark `height` px tall, with its left edge at x and its baseline at `bottom`. */
const markAt = (x, bottom, height, ink) => {
  const [x0, y0, , y1] = MARK_BOX;
  const scale = height / (y1 - y0);
  return `<g transform="translate(${round(x - x0 * scale)} ${round(bottom - y1 * scale)}) scale(${round(scale * 1000) / 1000})">${mark(ink)}</g>`;
};

function logoSheet() {
  const rows = [];
  // 1. On carbon, big.
  const dark = lockup(CHALK);
  const [, dy0, dx1, dy1] = dark.box;
  const bigScale = 1000 / dx1;
  rows.push(`<rect width="${W}" height="470" fill="${CARBON}"/>`);
  rows.push(line('Logo · The gap', 'label', 15, PAD, 74, ACCENT).svg);
  rows.push(line('The pack, the gap, and one rider off the front in red.', 'body', 24, PAD, 112, MUTED_DARK).svg);
  rows.push(
    `<g transform="translate(${round((W - dx1 * bigScale) / 2)} ${round(300 - ((dy0 + dy1) / 2) * bigScale)}) scale(${round(bigScale * 1000) / 1000})">${dark.body}</g>`,
  );
  // 2. App icons and the mark, on carbon and on chalk.
  rows.push(
    `<rect y="470" width="${W / 2}" height="330" fill="${CARBON_THEME['--bg-2']}"/><rect x="${W / 2}" y="470" width="${W / 2}" height="330" fill="${CHALK_THEME['--bg']}"/>`,
  );
  for (const [half, muted, ink] of [
    [0, MUTED_DARK, CHALK],
    [W / 2, MUTED_LIGHT, CARBON],
  ]) {
    rows.push(line('App icon · 160 · 96 · 48 · 32 · 16 px', 'label', 13, half + PAD, 524, muted).svg);
    let x = half + PAD;
    for (const size of [160, 96, 48, 32, 16]) {
      rows.push(iconAt(ICONS[size < 48 ? 'favicon.svg' : 'icon.svg'], x, 730 - size, size));
      x += size + 26;
    }
    rows.push(line('Mark', 'label', 13, half + 600, 524, muted).svg);
    rows.push(markAt(half + 600, 616, 56, { ink }));
    rows.push(line(half ? 'One color' : 'Monochrome', 'label', 13, half + 600, 664, muted).svg);
  }
  rows.push(iconAt(ICONS['icon-monochrome.svg'], 600 - 8, 674, 64));
  rows.push(markAt(W / 2 + 600, 730, 40, { one: CARBON }));
  // 3. On white.
  const light = lockup(CARBON);
  const [, ly0, lx1, ly1] = light.box;
  const midScale = 760 / lx1;
  rows.push(`<rect y="800" width="${W}" height="300" fill="${CHALK_THEME['--surface']}"/>`);
  rows.push(
    `<g transform="translate(${PAD} ${round(950 - ((ly0 + ly1) / 2) * midScale)}) scale(${round(midScale * 1000) / 1000})">${light.body}</g>`,
  );
  rows.push(
    line(
      'Clear space: the mark’s height on every side. Smallest: 16 px for the icon, 24 px for the mark, 96 px wide for the logo.',
      'body',
      17,
      PAD,
      1062,
      MUTED_LIGHT,
    ).svg,
  );
  return svg([0, 0, W, 1100], rows.join('\n'), { title: 'breakaway logo: the gap' });
}
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5]
      .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

function paletteSheet() {
  const parts = [`<rect width="${W}" height="1120" fill="${CARBON}"/>`];
  parts.push(line('Palette', 'label', 15, PAD, 74, ACCENT).svg);
  const head = line('Red is the rider. ', 'display', 50, PAD, 150, CHALK);
  parts.push(head.svg, line('Everything else is the pack.', 'display', 50, PAD + head.width, 150, MUTED_DARK).svg);
  // The three brand colors.
  const brand = [
    ['breakaway red', RED, ON_RED, `${RED} · the rider · white on it ${contrast(ON_RED, RED).toFixed(1)}:1`],
    ['Carbon', CARBON, CHALK, `${CARBON} · the dark ground, text on chalk`],
    ['Chalk', CHALK, CARBON, `${CHALK} · the light ground, text on carbon`],
  ];
  brand.forEach(([name, fill, ink, note], i) => {
    const x = PAD + i * 492;
    parts.push(
      `<rect x="${x}" y="200" width="468" height="220" rx="16" fill="${fill}"${fill === CARBON ? ' stroke="#ffffff" stroke-opacity=".16"' : ''}/>`,
    );
    parts.push(line(name, 'display', 34, x + 28, 300, ink).svg);
    parts.push(line(note, 'mono', 16, x + 28, 392, ink).svg);
  });
  // The two themes.
  for (const [i, theme, title] of [
    [0, CARBON_THEME, 'Carbon · dark, the default'],
    [1, CHALK_THEME, 'Chalk · light'],
  ]) {
    const x = PAD + i * 738;
    const w = 714;
    const ground = theme['--bg'];
    const ink = theme['--text'];
    parts.push(
      `<rect x="${x}" y="460" width="${w}" height="600" rx="16" fill="${ground}" stroke="#ffffff" stroke-opacity="${i ? 0 : 0.12}"/>`,
    );
    parts.push(line(title, 'label', 13, x + 28, 500, theme['--muted']).svg);
    ['--bg', '--bg-2', '--surface', '--surface-2', '--surface-3'].forEach((name, k) => {
      const sx = x + 28 + k * 132;
      parts.push(
        `<rect x="${sx}" y="524" width="120" height="84" rx="8" fill="${theme[name]}" stroke="${i ? CARBON : '#ffffff'}" stroke-opacity=".14"/>`,
      );
      parts.push(line(name, 'mono', 13, sx + 10, 596, theme['--muted']).svg);
    });
    const textTokens = [
      ['--text', 'Text'],
      ['--muted', 'Secondary text'],
      ['--accent', 'Links, focus, the active item'],
      ['--success', 'Ready, merged, passing'],
      ['--warn', 'Blocked, waiting'],
      ['--danger', 'Failing, broken (with an icon)'],
      ['--faint', 'Edges and icons only, never text'],
    ];
    textTokens.forEach(([name, use], k) => {
      const y = 662 + k * 54;
      const ratio = contrast(theme[name], ground).toFixed(1);
      parts.push(line('Aa', 'heading', 30, x + 28, y + 6, theme[name]).svg);
      parts.push(line(name, 'mono', 15, x + 100, y, ink).svg);
      parts.push(line(use, 'body', 16, x + 260, y, theme['--muted']).svg);
      parts.push(line(`${ratio}:1`, 'mono', 15, x + w - 28, y, ink, { align: 'end' }).svg);
    });
  }
  return svg([0, 0, W, 1120], parts.join('\n'), {
    title: 'breakaway palette: red, carbon, and chalk, with both themes and their contrast',
  });
}

function typeSheet() {
  const parts = [`<rect width="${W}" height="1240" fill="${CARBON}"/>`];
  parts.push(line('Type', 'label', 15, PAD, 74, ACCENT).svg);
  const leave = line('Leave the ', 'display', 150, PAD - 6, 250, CHALK);
  parts.push(leave.svg, line('pack.', 'display', 150, PAD - 6 + leave.width, 250, RED).svg);
  parts.push(
    line(
      'Archivo · width 125 · weight 850 · italic: headlines, big numbers, the wordmark',
      'mono',
      16,
      PAD,
      308,
      MUTED_DARK,
    ).svg,
  );
  parts.push(line('Agents claim the work. You merge it.', 'heading', 52, PAD, 420, CHALK).svg);
  parts.push(line('Archivo · width 100 · weight 700: headings in the board', 'mono', 16, PAD, 462, MUTED_DARK).svg);
  const body = [
    'A task board for you and your coding agents. Every task has one claim at a time,',
    'so two agents never take the same one. Each pull request links to its task, and',
    'the task is done when the pull request merges.',
  ];
  body.forEach((words, i) => parts.push(line(words, 'body', 24, PAD, 540 + i * 36, CHALK).svg));
  parts.push(line('Archivo · width 100 · weight 400: everything you read', 'mono', 16, PAD, 680, MUTED_DARK).svg);
  // Labels and the red number.
  parts.push(line('In review · 3 agents running · 2 pings', 'label', 15, PAD, 760, CARBON_THEME['--accent']).svg);
  const chip = text('BRK-27', 'number', 22);
  parts.push(
    `<rect x="${PAD}" y="796" width="${round(chip.width + 28)}" height="40" rx="4" fill="${RED}"/><path transform="translate(${PAD + 14} 824)" d="${chip.d}" fill="${ON_RED}"/>`,
  );
  parts.push(line('BRK-28   WEB-4   DOC-12', 'number', 22, PAD + chip.width + 52, 824, MUTED_DARK).svg);
  parts.push(
    line(
      'Chivo Mono: work IDs, labels, numbers, commands. The task being worked wears the red number.',
      'mono',
      16,
      PAD,
      876,
      MUTED_DARK,
    ).svg,
  );
  // The headline rhythm: short sentences in a row, in display type.
  parts.push(line('Write the work down.', 'display', 76, PAD - 4, 1000, CHALK).svg);
  parts.push(line('Agents claim it. You merge it.', 'display', 76, PAD - 4, 1096, CHALK).svg);
  parts.push(
    line('The headline rhythm: short sentences in a row, each with a full stop.', 'mono', 16, PAD, 1190, MUTED_DARK)
      .svg,
  );

  return svg([0, 0, W, 1240], parts.join('\n'), { title: 'breakaway type: Archivo and Chivo Mono' });
}

write('previews/logo.svg', logoSheet());
write('previews/palette.svg', paletteSheet());
write('previews/type.svg', typeSheet());

console.log(written.map((path) => `brand/${path}`).join('\n'));
