#!/usr/bin/env node
/**
 * The CLI's lockfile (CLI-21): writes npm-shrinkwrap.json, the lockfile npm publishes with a package, just before the
 * release stages the CLI on npm. The plugin runs the CLI with npx at an exact version, and Anthropic's plugin directory
 * holds a pinned package for review unless it ships a lockfile, since its dependencies would resolve at install time.
 * The CLI has no dependencies, so the lockfile names only the package: what installs is exactly what was published.
 *   node scripts/release/shrinkwrap.mjs [package.json]
 * Writes the lockfile beside package.json, and adds it to package.json's files when an older commit's doesn't list it.
 * Imports only Node, so the stable job runs main's copy on the commit it publishes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SHRINKWRAP = 'npm-shrinkwrap.json';

const DEPENDENCIES = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'];

/**
 * The lockfile for a package with no dependencies.
 * @param {{ name: string, version: string, license?: string, bin?: unknown, engines?: unknown } & Record<string, unknown>} pkg package.json
 */
export function shrinkwrap(pkg) {
  for (const field of DEPENDENCIES) {
    const value = pkg[field];
    if (value && Object.keys(value).length)
      throw new Error(
        `package.json has ${field}: a lockfile of the package alone would leave them to resolve at install time. Write them into ${SHRINKWRAP} in scripts/release/shrinkwrap.mjs.`,
      );
  }
  const { name, version, license, bin, engines } = pkg;
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version, license, bin, engines } },
  };
}

/**
 * package.json with the lockfile in its files, so npm packs it.
 * @param {{ files?: string[] } & Record<string, unknown>} pkg package.json
 */
export function withShrinkwrap(pkg) {
  const files = pkg.files ?? [];
  return files.includes(SHRINKWRAP) ? pkg : { ...pkg, files: [...files, SHRINKWRAP] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const path = process.argv[2] ?? 'package.json';
    const text = readFileSync(path, 'utf8');
    const pkg = JSON.parse(text);
    const lock = shrinkwrap(pkg);
    writeFileSync(join(dirname(path), SHRINKWRAP), `${JSON.stringify(lock, null, 2)}\n`);
    const listed = withShrinkwrap(pkg);
    if (listed !== pkg) writeFileSync(path, `${JSON.stringify(listed, null, 2)}\n`);
    console.error(`Wrote ${SHRINKWRAP} for ${lock.name}@${lock.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
