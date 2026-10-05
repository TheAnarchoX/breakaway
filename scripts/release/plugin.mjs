#!/usr/bin/env node
/**
 * The Plugin workflow's helper (LCH-24, .github/workflows/plugin.yml): sets plugin.json's version to the release's, so
 * the plugin directory and the marketplace see a new version exactly when a release moves the plugin branch.
 *   node scripts/release/plugin.mjs <ref> <plugin.json> [tag...]
 * <ref> is what the workflow was given; the tags are the release tags on its commit. Writes the version into
 * plugin.json and prints version=<it> for $GITHUB_OUTPUT. Imports nothing, so it runs from main's checkout on any commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Orders release versions, a stable after its pre-releases, and pre-releases by their numbers. */
const byVersion = (/** @type {string} */ a, /** @type {string} */ b) => {
  const parts = (/** @type {string} */ v) => v.split(/[.-]/u);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (pa.length === 3 || pb.length === 3) return pb.length - pa.length;
  return a.localeCompare(b, 'en', { numeric: true });
};

/**
 * The version the plugin goes out as: the ref's own, when it's a release tag; else the release tag on its commit, a
 * stable before a pre-release. A commit no release was made from has none, and the workflow stops.
 * @param {string} ref a tag or commit
 * @param {string[]} tags the tags on the ref's commit
 */
export function pluginVersion(ref, tags) {
  const own = RELEASE_TAG.exec(ref);
  if (own) return own[1];
  const versions = tags.flatMap((tag) => RELEASE_TAG.exec(tag)?.[1] ?? []).sort(byVersion);
  const version = versions.at(-1);
  if (!version)
    throw new Error(
      `${ref} has no release tag: no release was made from it. Run it with a release's tag, like v1.6.0.`,
    );
  return version;
}

/**
 * plugin.json with its version set.
 * @param {string} text plugin.json
 * @param {string} version like 1.6.0, or a pre-release's 1.6.1-main.3
 */
export function withVersion(text, version) {
  if (!VERSION.test(version)) throw new Error(`${version} isn't a release's version, like 1.6.0.`);
  const manifest = JSON.parse(text);
  if (typeof manifest.version !== 'string') throw new Error('plugin.json has no version to set.');
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [ref, path, ...tags] = process.argv.slice(2);
    if (!ref || !path) throw new Error('Usage: plugin.mjs <ref> <plugin.json> [tag...]');
    const version = pluginVersion(ref, tags);
    writeFileSync(path, withVersion(readFileSync(path, 'utf8'), version));
    console.log(`version=${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
