import { describe, expect, it } from 'vitest';
import { SIZES, TINTS, agent, hash, person, svg, tokenColors } from '../brand/avatar.js';

// Avatars (ID-9, docs/specs/ID-9-avatars.md): a person's pattern from their seed, an agent's glyph from its name, the
// same every time, and never alike.

const HANDLES = ['ada', 'bram', 'cleo', 'dev', 'eli', 'fenna', 'gus', 'hana', 'iker', 'juno', 'kofi', 'lior', 'owner'];
const AGENTS = ['claude-brk-12', 'claude-web-4', 'codex-doc-7', 'claude-captain-widgets-1'];

/** Every point of path data made of M, L, H, V, Q, h, v, and Z, in absolute units. */
function points(d) {
  const out = [];
  let [x, y] = [0, 0];
  for (const [, command, args] of d.matchAll(/([MLHVQZhv])([^MLHVQZhv]*)/gu)) {
    const n = args
      .trim()
      .split(/[\s,]+/u)
      .filter(Boolean)
      .map(Number);
    if (command === 'M' || command === 'L') [x, y] = n;
    else if (command === 'Q') [x, y] = n.slice(2);
    else if (command === 'H') x = n[0];
    else if (command === 'V') y = n[0];
    else if (command === 'h') x += n[0];
    else if (command === 'v') y += n[0];
    else continue;
    out.push([x, y]);
  }
  return out;
}

describe('avatars', () => {
  it('draw the same avatar for the same seed, and pin what a seed draws', () => {
    // Changing the generator changes everyone's avatar: these pin it. Change them only on purpose, in the spec too.
    expect(hash('ada')).toBe(0x7633be0e);
    expect(person('ada', 40)).toEqual(person('ada', 40));
    expect(
      person('ada', 40)
        .shapes.slice(1)
        .map((s) => s.d),
    ).toEqual(['M20.41 100L32.41 100L50.04 0L38.04 0Z', 'M48.22 100L60.22 100L77.86 0L65.86 0Z']);
    expect(agent('claude-web-4', 24).shapes[1].d).toBe(
      'M20 20h16v16h-16ZM42 20h16v16h-16ZM64 20h16v16h-16ZM20 64h16v16h-16ZM64 64h16v16h-16Z',
    );
    expect(HANDLES.map((h) => person(h, 32).tint)).toEqual([6, 1, 1, 3, 2, 6, 2, 3, 5, 3, 6, 7, 5]);
  });

  it('give each person one of the eight tints, and spread them', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const { tint } = person(`person-${i}`, 32);
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThan(TINTS);
      seen.add(tint);
    }
    expect(seen.size).toBe(TINTS);
  });

  it('change with the seed: Shuffle draws another pattern', () => {
    const drawn = new Set(['ada', 'k3v9q2', 'p0x7mm', 'zz81ab', 'r4t2wq'].map((seed) => svg(person(seed, 40))));
    expect(drawn.size).toBe(5);
  });

  it('cut a person’s chip with leaning gaps that never reach a corner', () => {
    for (let i = 0; i < 300; i++)
      for (const size of SIZES) {
        const avatar = person(`seed-${i}`, size);
        const [chip, ...cuts] = avatar.shapes;
        expect(chip.role).toBe('tint');
        expect(cuts.length).toBeGreaterThan(0);
        for (const cut of cuts) {
          expect(cut.role).toBe('ink');
          for (const [x, y] of points(cut.d)) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(100);
            // A corner is the 14 units square at each of the box's corners; nothing ink goes in one.
            const inCorner = (x < 14 || x > 86) && (y < 14 || y > 86);
            expect(inCorner, `${avatar.seed} at ${size}: ${x} ${y}`).toBe(false);
          }
        }
        // The gaps lean right as they rise: the top edge sits further right than the bottom.
        const gap = points(cuts[0].d);
        expect(gap[3][0] - gap[0][0]).toBeCloseTo(100 * Math.tan((10 * Math.PI) / 180), 1);
      }
  });

  it('keep only the widest gap below 24 px', () => {
    for (let i = 0; i < 200; i++) {
      expect(person(`seed-${i}`, 16).shapes).toHaveLength(2);
      expect(person(`seed-${i}`, 20).shapes).toHaveLength(2);
      const wide = person(`seed-${i}`, 32).shapes.slice(1);
      const width = (shape) => points(shape.d)[1][0] - points(shape.d)[0][0];
      const widest = Math.max(...wide.filter((s) => points(s.d)[0][1] === 100).map(width));
      expect(width(person(`seed-${i}`, 16).shapes[1])).toBeCloseTo(widest, 5);
      expect(widest).toBeGreaterThanOrEqual(12 - 1e-9);
    }
  });

  it('never draw an agent like a person: no tint, no lean, an upright glyph in one neutral', () => {
    for (const name of AGENTS)
      for (const size of SIZES) {
        const avatar = agent(name, size);
        expect(avatar.tint).toBeNull();
        expect(avatar.shapes.map((s) => s.role)).toEqual(['edge', 'glyph']);
        const glyph = avatar.shapes[1].d;
        // Square cells only: every move is level or upright.
        expect(glyph).toMatch(/^(M[\d.]+ [\d.]+h16v16h-16Z)+$/u);
        const cells = glyph.match(/M/gu).length;
        expect(cells).toBeGreaterThanOrEqual(4);
        expect(svg(avatar)).not.toContain('--avatar-');
      }
    for (let i = 0; i < 200; i++) {
      // Mirrored left to right, and never two bars with an empty middle.
      const cells = points(agent(`claude-x-${i}`, 24).shapes[1].d).filter((_, k) => k % 4 === 0);
      const at = new Set(cells.map(([x, y]) => `${x},${y}`));
      for (const [x, y] of cells) expect(at.has(`${100 - 16 - x},${y}`), `claude-x-${i}`).toBe(true);
      expect(cells.some(([x]) => x === 42)).toBe(true);
    }
  });

  it('draw in the board’s tokens by default, so an avatar follows the theme', () => {
    expect(tokenColors(2)).toEqual({
      tint: 'var(--avatar-3)',
      ink: 'var(--bg)',
      edge: 'var(--faint)',
      glyph: 'var(--muted)',
    });
    const drawn = svg(person('ada', 24));
    expect(drawn).toContain(`var(--avatar-${person('ada', 24).tint + 1})`);
    expect(drawn).toContain('aria-hidden="true"');
    expect(drawn).toContain('width="24" height="24"');
    expect(drawn).not.toMatch(/#[0-9a-f]{3,6}\b/iu);
  });
});
