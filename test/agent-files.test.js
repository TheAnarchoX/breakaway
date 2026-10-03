import { describe, expect, it } from 'vitest';
import PKG from '../package.json';
import CORE from '../prompts/core.md?raw';
import PROMPT from '../prompts/breakaway.md?raw';
import { promptPlaceholders } from '../src/wizard.js';

// breakaway's own agent files (CLD-137). root/ holds what goes at the root of breakaway's repository, outside
// this package: root/AGENTS.md becomes AGENTS.md and root/skills/<name>/ becomes .agents/skills/<name>/ (with
// .claude/skills linking to it). They wait here, where no agent working on this package picks them up as its own,
// until the export (CLD-138) places them; the package's own files keep their paths. prompts/breakaway.md is
// breakaway's agent prompt, beside the core it starts with. The test reads them in either layout: in root/ here, and
// at the root of breakaway's tree, where scripts/breakaway-export.mjs puts them.

const ROOT = import.meta.glob(['../root/**/*.md', '../AGENTS.md', '../.agents/skills/**/*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
// Every file in breakaway's tree, by its path there: the package's own, then root/ moved into place.
const PACKAGE = Object.keys(
  import.meta.glob(['../*', '../{brand,prompts,src,test,web}/**/*', '!../web/public/**'], {
    query: '?url',
    eager: false,
  }),
);
const placed = (key) =>
  key
    .replace(/^\.\.\/root\/skills\//u, '.agents/skills/')
    .replace(/^\.\.\/root\//u, '')
    .replace(/^\.\.\//u, '');
const FILES = {
  ...Object.fromEntries(Object.entries(ROOT).map(([key, text]) => [placed(key), text])),
  'prompts/breakaway.md': PROMPT,
};
const TREE = new Set([...PACKAGE.map(placed), ...Object.keys(FILES)]);

/** `a/b/../c` → `a/c`. */
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

describe("breakaway's agent files (CLD-137)", () => {
  it('has AGENTS.md, the tasks and brand-guide skills, and the prompt', () => {
    expect(Object.keys(FILES).sort()).toEqual([
      '.agents/skills/brand-guide/SKILL.md',
      '.agents/skills/tasks/SKILL.md',
      'AGENTS.md',
      'prompts/breakaway.md',
    ]);
  });

  it('names each skill after its folder', () => {
    for (const [path, text] of Object.entries(FILES).filter(([path]) => path.startsWith('.agents/'))) {
      const name = /^---\nname: ([\w-]+)\ndescription: .+\n---\n/u.exec(text)?.[1];
      expect(name, path).toBe(path.split('/')[2]);
    }
  });

  it('never mentions samewave: breakaway stands on its own', () => {
    for (const [path, text] of Object.entries(FILES)) expect(text, path).not.toMatch(/samewave/iu);
  });

  it('links only to files breakaway has', () => {
    for (const [path, text] of Object.entries(FILES)) {
      const dir = path.split('/').slice(0, -1).join('/');
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)) {
        if (/^https?:/u.test(target)) continue;
        const file = normalize(`${dir}/${target}`);
        expect(TREE.has(file) || [...TREE].some((f) => f.startsWith(`${file}/`)), `${path} links to ${target}`).toBe(
          true,
        );
      }
    }
  });

  it('names only pnpm scripts the package has', () => {
    for (const [path, text] of Object.entries(FILES))
      for (const [, script] of text.matchAll(/`pnpm ([a-z:-]+)/gu))
        expect(PKG.scripts, `${path}: pnpm ${script}`).toHaveProperty(script);
  });

  it('gives the prompt every section the core refers to, and nothing left to fill in', () => {
    const headings = [...PROMPT.matchAll(/^## (.+)$/gmu)].map(([, heading]) => heading);
    expect(headings).toEqual([
      'Repository',
      'Building',
      'Checks',
      'Pull requests',
      'Direction',
      'Dependency updates',
      'Never share',
    ]);
    for (const named of [
      ...CORE.matchAll(/\*\*(Checks|Pull requests|Direction|Building|Dependency updates|Never share)\*\*/gu),
    ])
      expect(headings).toContain(named[1]);
    expect(promptPlaceholders(PROMPT)).toEqual([]);
  });

  it('lists the areas the owner chose (CLD-134) in AGENTS.md and the prompt', () => {
    const areas = 'board (`BRK`), web (`WEB`), docs (`DOC`), launch (`LCH`), and brand (`ID`)';
    expect(FILES['AGENTS.md']).toContain(areas);
    expect(PROMPT).toContain(areas);
  });
});
