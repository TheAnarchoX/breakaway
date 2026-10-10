// breakaway's avatars (ID-9, docs/specs/ID-9-avatars.md): a pattern for each person, drawn from a seed, and a plainer
// glyph for each agent, so the two never look alike.
//
// A person's avatar is a chip like a race number: a flat square in one of the eight avatar tints, with tight corners,
// cut by gaps that lean 10° like the type, and sometimes a level cut across. The cuts are the ground showing through
// (`--bg`). An agent's is an outlined chip with an upright mono glyph of 3 by 3 cells, mirrored, and no tint.
//
// It's pure: geometry in a 100-unit box and color roles, no DOM and no fonts, so the brand script draws the previews
// with it (brand/tools/build.mjs) and the board draws the same avatars (WEB-134). Changing what a seed draws changes
// everyone's avatar, so test/avatar.test.js pins a few.

/** How many avatar tints there are: `--avatar-1` to `--avatar-8` in brand/tokens.css. */
export const TINTS = 8;

/** The sizes the board draws, in px: the claim chip (16 to 20), lists (24), the header and People (32 to 40). */
export const SIZES = [16, 20, 24, 32, 40];

// Everything leans like the type: Archivo's italic angle. Over the box's 100 units a cut moves this far right.
const LEAN = 100 * Math.tan((10 * Math.PI) / 180);

/**
 * 32-bit FNV-1a over the seed's UTF-8 bytes, then murmur3's finalizer, so short seeds that differ by a letter still
 * land on different tints (FNV-1a's low bits alone barely move).
 * @param {string} seed
 */
export function hash(seed) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(seed)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32: a small, fast generator, enough to pick a pattern's parts. Returns numbers in [0, 1).
 * @param {number} state
 */
function random(state) {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @template T @param {() => number} next @param {T[]} list @returns {T} */
const pick = (next, list) => list[Math.floor(next() * list.length)];

// A gap's edges stay this far in from the box's sides, and the slabs between gaps are at least this wide.
const EDGE = 14;
const SLAB = 10;

const round = (/** @type {number} */ n) => +n.toFixed(2);

/** @param {number[][]} points */
const polygon = (points) => `M${points.map((p) => p.map(round).join(' ')).join('L')}Z`;

/**
 * A gap from x0 to x1 on the box's bottom edge, leaning to the right as it rises to the top edge.
 * @param {number} x0 @param {number} x1
 */
const gap = (x0, x1) =>
  polygon([
    [x0, 100],
    [x1, 100],
    [x1 + LEAN, 0],
    [x0 + LEAN, 0],
  ]);

/**
 * The corner radius in px: tight, like a race number, and at most `--radius-xs` (4 px).
 * @param {number} size
 */
export const radiusAt = (size) => (size < 24 ? 2 : size < 32 ? 3 : 4);

/**
 * The chip: the box with its corners rounded by `radiusAt(size)`, inset by `inset` units on every side.
 * @param {number} size @param {number} inset
 */
function chip(size, inset) {
  const r = Math.max(0, (radiusAt(size) * 100) / size - inset);
  const [a, b] = [round(inset), round(100 - inset)];
  const [ar, br] = [round(a + r), round(b - r)];
  return `M${ar} ${a}H${br}Q${b} ${a} ${b} ${ar}V${br}Q${b} ${b} ${br} ${b}H${ar}Q${a} ${b} ${a} ${br}V${ar}Q${a} ${a} ${ar} ${a}Z`;
}

/**
 * @typedef {{ d: string, role: 'tint' | 'ink' | 'edge' | 'glyph' }} Shape
 *   `tint` fills with the person's avatar tint, `ink` with the ground (`--bg`), `edge` strokes with `--faint`, and
 *   `glyph` fills with `--muted`.
 * @typedef {{ kind: 'person' | 'agent', seed: string, size: number, radius: number, tint: number | null,
 *   shapes: Shape[] }} Avatar
 */

/**
 * A person's avatar: the tint and cuts from their seed. Their handle is the seed until Shuffle picks a new one.
 * Below 24 px only the widest gap is drawn, so the chip stays a clean color with one cut.
 * @param {string} seed
 * @param {number} size in px
 * @returns {Avatar}
 */
export function person(seed, size) {
  const h = hash(seed);
  const next = random(h);
  const tint = h % TINTS;
  // One to three gaps, laid out from the left. Each gap's bottom edge stays at least 14 units in from the left and
  // its top edge 14 in from the right, past the largest corner (4 px at 32 px is 12.5 units), so a cut never reaches a
  // corner; the slabs between gaps are at least 10.
  const count = pick(next, [1, 2, 2, 3]);
  const widths = Array.from({ length: count }, () => pick(next, [8, 12, 16]));
  // The widest gap is never narrower than 12, so it still shows at 16 px (2 px).
  const widest = widths.indexOf(Math.max(...widths));
  if (widths[widest] < 12) widths[widest] = 12;
  const free = () => 100 - 2 * EDGE - LEAN - widths.reduce((sum, w) => sum + w, 0) - SLAB * (count - 1);
  // Three wide gaps don't fit: narrow the others first, then the widest, never below 8 and 12.
  for (let i = 0; free() < 4 && i < count * 2; i++) {
    const j = widths.findIndex((w, k) => k !== widest && w > 8);
    if (j >= 0) widths[j] -= 4;
    else if (widths[widest] > 12) widths[widest] -= 4;
  }
  const room = free();
  // Share the room left over at random among the margins and slabs.
  const shares = Array.from({ length: count + 1 }, () => next() + 0.25);
  const total = shares.reduce((sum, s) => sum + s, 0);
  /** @type {[number, number][]} */
  const gaps = [];
  let x = EDGE + (shares[0] / total) * room;
  for (let i = 0; i < count; i++) {
    gaps.push([x, x + widths[i]]);
    x += widths[i] + SLAB + (shares[i + 1] / total) * room;
  }
  /** @type {Shape[]} */
  const shapes = [{ d: chip(size, 0), role: 'tint' }];
  if (size < 24) {
    const [x0, x1] = gaps[widest];
    shapes.push({ d: gap(x0, x1), role: 'ink' });
  } else {
    for (const [x0, x1] of gaps) shapes.push({ d: gap(x0, x1), role: 'ink' });
    // Half the time, a level cut across: the whole width, or from one edge to the nearest gap. It stays between 30
    // and 70 units down, clear of the corners.
    if (next() < 0.5) {
      const height = pick(next, [8, 12]);
      const y = 30 + next() * (40 - height);
      // Where a leaning gap crosses the cut's middle.
      const at = (/** @type {number} */ x0) => x0 + LEAN * (1 - (y + height / 2) / 100);
      const reach = pick(next, ['across', 'left', 'right']);
      const left = reach === 'right' ? at(gaps.at(-1)?.[1] ?? 0) : 0;
      const right = reach === 'left' ? at(gaps[0][0]) : 100;
      shapes.push({
        d: polygon([
          [left, y],
          [right, y],
          [right, y + height],
          [left, y + height],
        ]),
        role: 'ink',
      });
    }
  }
  return { kind: 'person', seed, size, radius: radiusAt(size), tint, shapes };
}

/**
 * An agent's avatar: an outlined chip with an upright glyph of 3 by 3 cells from its name, mirrored left to right, in
 * one neutral. No tint and no lean, so an agent never looks like a person.
 * @param {string} name the agent's name, like claude-web-4
 * @param {number} size in px
 * @returns {Avatar}
 */
export function agent(name, size) {
  const h = hash(name);
  // Six cells decide the glyph (the left and middle columns; the right mirrors the left). At least four of the nine
  // are on, and the middle column always has one, so it never reads as two bars.
  let bits = h & 0b111111;
  const on = (/** @type {number} */ b) => [0, 1, 2, 3, 4, 5].filter((i) => b & (1 << i)).length;
  const cells = (/** @type {number} */ b) => on(b & 0b000111) * 2 + on(b & 0b111000);
  if (!(bits & 0b111000)) bits |= 0b010000;
  for (let i = 0; cells(bits) < 4; i++) bits |= 1 << ((h >>> (6 + i * 3)) % 6);
  // A 3 by 3 grid of cells 16 units square with 6 between, centered: 26 to 74.
  const cell = 16;
  const step = 22;
  const start = 50 - cell / 2 - step;
  const parts = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const source = col === 2 ? 0 : col;
      const lit = source === 0 ? bits & (1 << row) : bits & (1 << (3 + row));
      if (lit) {
        const [x, y] = [start + col * step, start + row * step];
        parts.push(`M${x} ${y}h${cell}v${cell}h-${cell}Z`);
      }
    }
  // The edge is 1 px wide whatever the size, its stroke drawn just inside the box.
  const edge = chip(size, 50 / size);
  return {
    kind: 'agent',
    seed: name,
    size,
    radius: radiusAt(size),
    tint: null,
    shapes: [
      { d: edge, role: 'edge' },
      { d: parts.join(''), role: 'glyph' },
    ],
  };
}

/**
 * The colors an avatar's roles are drawn in. By default the board's tokens, so an avatar follows the theme; the brand
 * script passes each theme's values to draw the previews.
 * @param {number | null} tint
 */
export const tokenColors = (tint) => ({
  tint: tint === null ? 'none' : `var(--avatar-${tint + 1})`,
  ink: 'var(--bg)',
  edge: 'var(--faint)',
  glyph: 'var(--muted)',
});

/**
 * An avatar as an SVG string, `size` px square. It's decoration: the name always shows beside it or in its label, so
 * it's hidden from screen readers.
 * @param {Avatar} avatar
 * @param {{ colors?: Record<Shape['role'], string> }} [options]
 */
export function svg(avatar, { colors = tokenColors(avatar.tint) } = {}) {
  const { size, shapes } = avatar;
  const body = shapes
    .map(({ d, role }) =>
      role === 'edge'
        ? `<path d="${d}" fill="none" stroke="${colors.edge}" stroke-width="${round(100 / size)}"/>`
        : `<path d="${d}" fill="${colors[role]}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}
