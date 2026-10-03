#!/usr/bin/env node
/**
 * A stable digest of a build output, for a repository that builds one environment-neutral output.
 *   node scripts/release-artifact.mjs digest <dir>     prints the sha256 over the manifest of every file under <dir>
 *   node scripts/release-artifact.mjs manifest <dir>   prints the manifest itself: "<sha256> <size> <path>" per file
 * The same tree gives the same digest on any machine. Copied into a repository by `repos init`.
 */
import { digestDir } from './lib/release-artifact.js';

const [command, dir] = process.argv.slice(2);
try {
  if (!['digest', 'manifest'].includes(command) || !dir)
    throw new Error('Usage: release-artifact.mjs digest|manifest <dir>');
  const { digest, manifest } = digestDir(dir);
  if (command === 'digest') console.log(digest);
  else process.stdout.write(manifest);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
