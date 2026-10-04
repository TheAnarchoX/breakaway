#!/usr/bin/env node
/**
 * The release workflow's helper (.github/workflows/release.yml). Prints key=value lines for $GITHUB_OUTPUT.
 *   node scripts/release/plan.mjs prerelease <tags-file>        the next pre-release's version and tag
 *   node scripts/release/plan.mjs stable <prerelease-tag>       the stable version a pre-release becomes
 *   node scripts/release/plan.mjs manifest <channel> <version> <commit> [builtAs] [--bundle <file>]    writes manifest.json to stdout
 *   node scripts/release/plan.mjs manual                         the Manual steps section for the notes, if any
 * Reads package.json, release.json, and wrangler.jsonc from the working directory.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseJsonc } from '../../src/install.js';
import { manifestOf, manualSection, shapeOf, nextPrerelease, stableOf } from './lib.js';

const [command, ...args] = process.argv.slice(2);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
try {
  if (command === 'prerelease') {
    const tags = readFileSync(args[0], 'utf8')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const { version, tag } = nextPrerelease(json('package.json').version, tags);
    console.log(`version=${version}\ntag=${tag}`);
  } else if (command === 'stable') {
    console.log(`version=${stableOf(args[0])}`);
  } else if (command === 'manifest') {
    const flag = args.indexOf('--bundle');
    const bundle = flag >= 0 ? args.splice(flag, 2)[1] : null;
    const [channel, version, commit, builtAs] = args;
    const bundleSha256 = bundle ? createHash('sha256').update(readFileSync(bundle)).digest('hex') : undefined;
    process.stdout.write(
      `${JSON.stringify(manifestOf({ version, channel: /** @type {'main' | 'stable'} */ (channel), commit, builtAs, bundleSha256, shape: shapeOf(parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))), config: json('release.json'), created: new Date().toISOString() }), null, 2)}\n`,
    );
  } else if (command === 'manual') {
    process.stdout.write(manualSection(json('release.json')));
  } else {
    throw new Error(
      'Usage: plan.mjs prerelease <tags-file> | stable <tag> | manifest <channel> <version> <commit> [builtAs] [--bundle <file>] | manual',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
