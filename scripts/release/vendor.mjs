#!/usr/bin/env node
/**
 * Puts the packages the Worker imports, and what they depend on, into a release bundle's node_modules, so an install's
 * Deploy workflow runs no npm install (BRK-56). Run by .github/workflows/release.yml after `pnpm install`.
 *   node scripts/release/vendor.mjs <bundle-dir>
 * Reads src/ and node_modules/ from the working directory.
 */
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { importedPackages } from './lib.js';

const out = process.argv[2];
if (!out) {
  console.error('Usage: vendor.mjs <bundle-dir>');
  process.exit(1);
}

/** The folder of package `name` as `from` resolves it (pnpm keeps a package's dependencies beside it, not above it). */
function packageDir(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Can't find the package ${name} from ${from}. Run pnpm install first.`);
    dir = parent;
  }
}

const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
  .map((file) => readFileSync(join('src', file), 'utf8'));
const copied = new Set();
const queue = importedPackages(sources).map((name) => [name, process.cwd()]);
while (queue.length) {
  const [name, from] = queue.shift();
  if (copied.has(name)) continue;
  copied.add(name);
  const real = realpathSync(packageDir(name, from));
  cpSync(real, join(out, 'node_modules', name), { recursive: true, dereference: true });
  const { dependencies = {} } = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
  // pnpm keeps a package's dependencies beside its real folder, so they are looked up from there.
  for (const dep of Object.keys(dependencies)) queue.push([dep, real]);
}
console.log(`Vendored ${[...copied].sort().join(', ')} into ${join(out, 'node_modules')}.`);
