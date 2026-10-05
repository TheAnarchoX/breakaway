#!/usr/bin/env node
/**
 * Writes src/board-files.json (BRK-132): the board's files repos init reads (boardSources in src/init.js), by path,
 * so the Worker renders an empty repository's first commit from the same files as the CLI. It's generated, never
 * committed (BRK-148): `pnpm install`, `build`, `typecheck`, `test`, and `deploy` run this first, and the release
 * workflow's build puts it in the bundle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { boardSources } from '../src/init.js';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

export const boardFiles = () => Object.fromEntries(boardSources(read).map((path) => [path, read(path)]));

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('src/board-files.json', ROOT), `${JSON.stringify(boardFiles(), null, 2)}\n`);
  // On stderr: npm pack and npm publish run it (prepare), and their --json goes to stdout.
  console.error('Wrote src/board-files.json.');
}
