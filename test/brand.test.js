import { describe, expect, it } from 'vitest';
import GUIDE from '../brand/README.md?raw';
import TOKENS from '../brand/tokens.css?raw';
import APP_CSS from '../web/src/styles/app.css?raw';
import BASE_CSS from '../web/src/styles/base.css?raw';
import MAIN from '../web/src/main.jsx?raw';
import HTML from '../web/index.html?raw';
import MANIFEST from '../web/public/manifest.webmanifest?raw';

// breakaway's palette (BRD-27): contrast in both themes, the guide's tables against the tokens, and
// the board wearing them (BRD-28): every token it reads is breakaway's, and nothing of samewave's is left.

const BOARD_CSS = `${BASE_CSS}\n${APP_CSS}`;

const SCRIPTS = import.meta.glob('../web/src/**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true });

const declarations = (block) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map(([, name, value]) => [name, value.trim()]));
const block = (pattern) => {
  const match = pattern.exec(TOKENS);
  if (!match) throw new Error(`no ${pattern} block in tokens.css`);
  return declarations(match[1]);
};
const BASE = block(/^:root\s*\{([^}]*)\}/mu);
const SYSTEM_LIGHT = block(
  /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme=['"]dark['"]\]\)\s*\{([^}]*)\}/u,
);
const SWITCH_LIGHT = block(/^:root\[data-theme=['"]light['"]\]\s*\{([^}]*)\}/mu);
const THEMES = { carbon: BASE, chalk: { ...BASE, ...SWITCH_LIGHT } };

/** [r, g, b, a] from #rrggbb or rgba(r, g, b, a), with channels 0–1. */
function rgba(value) {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) return [0, 2, 4].map((at) => Number.parseInt(hex[1].slice(at, at + 2), 16) / 255).concat(1);
  const fn = /^rgba?\(([^)]+)\)$/u.exec(value);
  if (!fn) throw new Error(`can't read ${value} as a color`);
  const [r, g, b, a = '1'] = fn[1].split(',').map((part) => part.trim());
  return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
}
/** A translucent color as it shows over an opaque one. */
const over = (top, under) => {
  const [a, b] = [rgba(top), rgba(under)];
  return [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
};
const luminance = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
/** WCAG 2.2 contrast ratio between two opaque colors (strings or channel arrays). */
const contrast = (x, y) => {
  const [a, b] = [x, y].map((c) => luminance(typeof c === 'string' ? rgba(c) : c)).sort((m, n) => n - m);
  return (a + 0.05) / (b + 0.05);
};

const GROUNDS = ['--bg', '--bg-2', '--surface', '--surface-2', '--surface-3'];
const TEXT = ['--text', '--muted', '--accent', '--danger', '--success', '--warn'];

describe('breakaway tokens', () => {
  it('are read from the files themselves', () => {
    // An empty import would make every check below pass by checking nothing.
    expect(TOKENS).toContain('--red:');
    expect(BOARD_CSS).toContain('.topbar');
    expect(GUIDE).toContain('# breakaway brand guide');
    expect(Object.keys(SCRIPTS).length).toBeGreaterThan(5);
  });

  it('give the light theme the same values from the system setting and from the switch', () => {
    expect(SYSTEM_LIGHT).toEqual(SWITCH_LIGHT);
  });

  it('keep the brand colors the same in both themes', () => {
    for (const name of ['--red', '--on-red', '--carbon', '--chalk']) {
      expect(BASE[name], name).toMatch(/^#[0-9a-f]{6}$/u);
      expect(SWITCH_LIGHT[name], `${name} belongs to both themes`).toBeUndefined();
    }
  });

  for (const [theme, tokens] of Object.entries(THEMES)) {
    describe(`in ${theme}`, () => {
      it('pass 4.5:1 for every text color on every background and surface', () => {
        for (const text of TEXT) {
          for (const ground of GROUNDS) {
            expect(contrast(tokens[text], tokens[ground]), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it('pass 4.5:1 for status colors on their own tinted pills', () => {
        for (const status of ['--danger', '--success', '--warn']) {
          for (const ground of ['--bg', '--surface', '--surface-2']) {
            const pill = over(tokens[`${status}-bg`], tokens[ground]);
            expect(contrast(tokens[status], pill), `${status} on ${status}-bg over ${ground}`).toBeGreaterThanOrEqual(
              4.5,
            );
          }
        }
      });

      it('pass 4.5:1 for text on the filled colors', () => {
        expect(contrast(tokens['--on-red'], tokens['--red'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--on-accent'], tokens['--accent'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--on-invert'], tokens['--invert'])).toBeGreaterThanOrEqual(4.5);
      });

      it('pass 3:1 for the UI-only colors: --faint for edges and icons, red for marks and fills', () => {
        for (const ground of ['--bg', '--bg-2', '--surface', '--surface-2']) {
          expect(contrast(tokens['--faint'], tokens[ground]), `--faint on ${ground}`).toBeGreaterThanOrEqual(3);
          expect(contrast(tokens['--red'], tokens[ground]), `--red on ${ground}`).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});

describe('the brand guide', () => {
  /** The guide's table rows that start with a token in backticks: `--name` and the cells after it. */
  const rows = [...GUIDE.matchAll(/^\| `(--[\w-]+)` \|(.*)\|\s*$/gmu)].map(([, name, cells]) => [
    name,
    cells.split('|').map((cell) => cell.trim()),
  ]);

  it('lists each palette color with the value it has in tokens.css', () => {
    const listed = rows.filter(([, cells]) => /^`#[0-9a-f]{6}`$/u.test(cells[0]));
    expect(listed.length).toBeGreaterThan(10);
    for (const [name, [carbon, chalk]] of listed) {
      expect(carbon, `${name} in carbon`).toBe(`\`${THEMES.carbon[name]}\``);
      if (/^`#/u.test(chalk)) expect(chalk, `${name} in chalk`).toBe(`\`${THEMES.chalk[name]}\``);
    }
  });

  it('states contrast against --bg that matches the tokens', () => {
    const stated = rows.filter(([, cells]) => /^\d+\.\d:1$/u.test(cells[0]));
    expect(stated.length).toBeGreaterThan(4);
    for (const [name, [carbon, chalk]] of stated) {
      expect(carbon, `${name} in carbon`).toBe(`${contrast(THEMES.carbon[name], THEMES.carbon['--bg']).toFixed(1)}:1`);
      expect(chalk, `${name} in chalk`).toBe(`${contrast(THEMES.chalk[name], THEMES.chalk['--bg']).toFixed(1)}:1`);
    }
  });
});

describe("the board in breakaway's identity", () => {
  it('reads its tokens from brand/tokens.css, and has no copy of its own', () => {
    expect(MAIN).toContain(`import '../../brand/tokens.css';`);
    expect(Object.keys(import.meta.glob('../web/src/**/tokens.css'))).toEqual([]);
  });

  it('defines every custom property the board reads without a fallback', () => {
    const own = new Set([...BOARD_CSS.matchAll(/(--[\w-]+)\s*:/gu)].map(([, name]) => name));
    for (const source of Object.values(SCRIPTS))
      for (const [, name] of source.matchAll(/'(--[\w-]+)'\s*:/gu)) own.add(name);
    const read = [...BOARD_CSS.matchAll(/var\((--[\w-]+)\)/gu)].map(([, name]) => name);
    const missing = [...new Set(read)].filter((name) => !own.has(name) && !(name in BASE));
    expect(missing).toEqual([]);
  });

  it('uses only tokens for color in its stylesheets', () => {
    // A hex value or rgb() in a rule is a color the tokens don't know; masks and the dialog's dim are the exceptions.
    const colors = [...BOARD_CSS.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/giu)].map(([m]) => m);
    expect(colors.filter((c) => !['#000', 'rgb(0 0 0 / .78)', 'rgb(0 0 0 / 0.78)'].includes(c))).toEqual([]);
  });

  it('sets its type in Archivo and Chivo Mono, self-hosted', () => {
    expect(MAIN).toContain('@fontsource-variable/archivo/wdth.css');
    expect(MAIN).toContain('@fontsource-variable/archivo/wdth-italic.css');
    expect(MAIN).toContain('@fontsource-variable/chivo-mono/wght.css');
  });

  it("keeps nothing of samewave's look: its fonts, member colors, wave, or grain", () => {
    const sources = { 'main.jsx': MAIN, 'base.css': BASE_CSS, 'app.css': APP_CSS, 'index.html': HTML, ...SCRIPTS };
    const old =
      /bricolage|figtree|jetbrains|instrument serif|--(?:violet|coral|mint|sky|sun|tangerine|magenta|spotify)\b|--font-serif|--grain|#0d0c12|#f7f3ec/iu;
    for (const [file, source] of Object.entries(sources)) expect(old.exec(source)?.[0], file).toBeUndefined();
  });

  it("names itself breakaway, with breakaway's colors, on the page and the installed app", () => {
    const manifest = JSON.parse(MANIFEST);
    expect(manifest.name).toBe('breakaway');
    expect(manifest.theme_color).toBe(BASE['--carbon']);
    expect(manifest.background_color).toBe(BASE['--carbon']);
    expect(HTML).toContain('<title>breakaway</title>');
    expect(HTML).toContain(`<meta name="theme-color" content="${BASE['--carbon']}">`);
    for (const source of [MANIFEST, HTML]) expect(source).not.toMatch(/samewave/iu);
  });
});
