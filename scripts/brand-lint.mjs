#!/usr/bin/env node
/**
 * Lint breakaway's words against the brand guide's mechanical rules (scripts/lib/brand-lint.js).
 *   node scripts/brand-lint.mjs [path ...]
 * Paths are files or folders; with none, the web app, brand/, the docs, launch/, the plugin, and the README and root
 * markdown files. Exits 1 and prints each finding. A line opts out with `brand-lint-ignore <rule>`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { format, lint } from './lib/brand-lint.js';

const DEFAULT = [
  'web/src',
  'web/index.html',
  'brand',
  'docs',
  'launch',
  'plugin',
  'site/README.md',
  'site/content',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
];
const KINDS = new Set(['.md', '.html', '.js', '.jsx', '.mjs', '.css', '.json']);
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist', 'previews', 'logo', 'package-lock.json']);

function walk(path, out) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) if (!SKIP.has(name)) walk(join(path, name), out);
  } else if (KINDS.has(extname(path))) out.push(path);
}

const paths = process.argv.slice(2);
const found = [];
for (const p of paths.length ? paths : DEFAULT) walk(p, found);
const findings = lint(found.map((path) => ({ path, text: readFileSync(path, 'utf8') })));
if (findings.length) {
  console.error(findings.map(format).join('\n'));
  console.error(
    `\n${findings.length} brand ${findings.length === 1 ? 'finding' : 'findings'}. Fix the copy, or opt a line out with a "brand-lint-ignore <rule>" comment.`,
  );
  process.exit(1);
}
console.log(`Brand lint passed (${found.length} files).`);
