#!/usr/bin/env node
/**
 * node tools/tasks/install.mjs [--config <file>] [--out <file>] [--local]
 *
 * Turns an install's breakaway.config.json (default: the one next to this file, a new install's template) into the
 * board Worker's wrangler config and prints it, or writes it to --out. --local makes the config for
 * `wrangler dev` instead: no custom domain or Secrets Store, and absolute paths so it can live anywhere.
 * wrangler.jsonc is this output with comments (test/install.test.js checks it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, wranglerConfig } from './src/install.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const file = resolve(flag('--config') ?? join(HERE, 'breakaway.config.json'));
try {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const local = args.includes('--local');
  const out = JSON.stringify(wranglerConfig(config, { local, root: local ? HERE : '.' }), null, 2);
  const target = flag('--out');
  if (target) writeFileSync(target, `${out}\n`);
  else console.log(out);
} catch (error) {
  const why = error instanceof ConfigError || error instanceof SyntaxError ? error.message : String(error);
  console.error(`install: ${file}: ${why}`);
  process.exit(1);
}
