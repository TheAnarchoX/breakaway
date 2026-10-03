import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { importClosure } from '../tasks/init.js';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

// What the release's "Build once" step (.github/workflows/release.yml) packs for the Worker: src, package.json, and release.json.
const packed = (path) => path.startsWith('src/') || path === 'package.json' || path === 'release.json';

it("packs everything the Worker's code imports in the release bundle (BRK-60)", () => {
  const sources = readdirSync(new URL('src/', ROOT), { recursive: true })
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
    .map((file) => `src/${file}`);
  expect(importClosure(sources, read).filter((path) => !packed(path))).toEqual([]);
});
