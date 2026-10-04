#!/usr/bin/env node
/**
 * The Release workflow's version numbers for a repository's npm package (scripts/lib/package-release.js). Prints
 * key=value lines for $GITHUB_OUTPUT.
 *   node scripts/package-release.mjs prerelease --dir <path> --prefix <tag prefix> [--sha <commit>]
 *       the next pre-release's version and tag, from <path>/package.json and the repository's tags; with --sha,
 *       exists=true when that commit already has a pre-release (a second run for one merge stages nothing)
 *   node scripts/package-release.mjs stable <pre-release tag> --prefix <tag prefix>
 *       the stable version and tag it becomes, and the commit it was staged from; stops if that stable exists
 *   node scripts/package-release.mjs next <stable> <patch|minor|major> --dir <path>
 *       the version to set <path>/package.json to after the stable, empty for none (WEB-39)
 * Reads the tags with git, so run it in a checkout with its tags (fetch-depth: 0). Copied by `repos init`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { nextPrerelease, nextVersion, prereleaseAmong, stableOf } from './lib/package-release.js';

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string', default: '.' }, prefix: { type: 'string', default: 'v' }, sha: { type: 'string' } },
});
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);

try {
  const [command, tag] = positionals;
  if (command === 'prerelease') {
    const current = JSON.parse(readFileSync(join(o.dir, 'package.json'), 'utf8')).version;
    const staged = o.sha ? prereleaseAmong(git('tag', '--points-at', o.sha), o.prefix) : null;
    if (staged) {
      console.error(`${o.sha.slice(0, 7)} already has a pre-release, ${staged.tag}, so this run stages nothing.`);
      console.log(`version=${staged.version}\ntag=${staged.tag}\nexists=true`);
    } else {
      const next = nextPrerelease(current, git('tag', '-l'), o.prefix);
      console.log(`version=${next.version}\ntag=${next.tag}\nexists=false`);
    }
  } else if (command === 'stable' && tag) {
    const version = stableOf(tag, o.prefix);
    const tags = git('tag', '-l');
    if (!tags.includes(tag)) throw new Error(`There is no pre-release ${tag}. Pick one the Release workflow staged.`);
    if (tags.includes(`${o.prefix}${version}`))
      throw new Error(`${o.prefix}${version} is already released. Pick a newer pre-release.`);
    const [commit] = git('rev-list', '-n', '1', `refs/tags/${tag}`);
    console.log(`version=${version}\ntag=${o.prefix}${version}\ncommit=${commit}`);
  } else if (command === 'next' && tag) {
    const current = JSON.parse(readFileSync(join(o.dir, 'package.json'), 'utf8')).version;
    const version = nextVersion(tag, positionals[2] ?? 'patch', current);
    if (!version && positionals[2] && positionals[2] !== 'patch')
      console.error(`package.json already says ${current}, at or past the next ${positionals[2]} after ${tag}.`);
    console.log(`version=${version ?? ''}`);
  } else {
    throw new Error(
      'Usage: package-release.mjs prerelease --dir <path> --prefix <p> [--sha <commit>] | stable <tag> --prefix <p> | next <stable> <patch|minor|major> --dir <path>',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
