import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ENTRIES, CLI_ENTRIES, importClosure } from './init.js';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the npm package (BRK-7)', () => {
  const report = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  // npm 10 prints a list with one entry per package, npm 12 an object keyed by the package's name (BRK-58).
  const packed = (Array.isArray(report) ? report[0] : report[pkg.name]).files.map((f) => f.path);

  it('is public and runs npx breakaway as the CLI', () => {
    expect(pkg.name).toBe('breakaway');
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ breakaway: 'scripts/tasks.mjs' });
    expect(pkg.publishConfig).toMatchObject({ access: 'public', provenance: true });
    expect(read('scripts/tasks.mjs').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('carries every file the CLI imports, and what repos init reads', () => {
    const needed = importClosure([...CLI_ENTRIES, ...RELEASE_ENTRIES], read);
    for (const path of [
      ...needed,
      'prompts/core.md',
      'prompts/stub.md',
      'prompts/repository.md',
      'taskrc',
      'scripts/task',
      '.agents/skills/tasks/SKILL.md',
      'scripts/install/cli.js',
      'template/README.md',
      'template/.dev.vars.example',
      'template/.github/workflows/deploy.yml',
      'template/.github/workflows/update.yml',
    ])
      expect(packed, path).toContain(path);
  });

  it('leaves out the Worker, the web app, the tests, and the install’s own files', () => {
    expect(packed.filter((p) => /\.test\.js$/u.test(p) || /vitest\.config/u.test(p))).toEqual([]);
    for (const p of packed) expect(p, p).not.toMatch(/^(web|test|dist|brand|docs)\//u);
    expect(packed).not.toContain('src/worker.js');
    expect(packed).not.toContain('breakaway.config.json');
  });

  it('needs no dependency to run: the CLI imports only Node’s own modules', () => {
    expect(pkg.dependencies).toBeUndefined();
    for (const path of importClosure(CLI_ENTRIES, read))
      for (const m of read(path).matchAll(/\bfrom\s*['"]([^.'"][^'"]*)['"]/gu))
        expect(m[1], `${path} imports ${m[1]}`).toMatch(/^node:/u);
  });
});
