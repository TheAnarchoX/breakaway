import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHRINKWRAP, shrinkwrap, withShrinkwrap } from './shrinkwrap.mjs';

// CLI-21: the plugin runs the CLI with npx at the release's exact version, and the plugin directory holds a pinned
// package for review unless it ships a lockfile, since its dependencies would resolve at install time. The CLI has no
// dependencies, so its lockfile names only itself: what installs is exactly what was published.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const RELEASE = read('.github/workflows/release.yml');
const PACKAGE = JSON.parse(read('package.json'));

describe('the CLI’s lockfile (CLI-21)', () => {
  it('names only the package, at its version', () => {
    const lock = shrinkwrap({ ...PACKAGE, version: '1.6.0' });
    expect(lock).toEqual({
      name: 'breakaway',
      version: '1.6.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'breakaway',
          version: '1.6.0',
          license: PACKAGE.license,
          bin: PACKAGE.bin,
          engines: PACKAGE.engines,
        },
      },
    });
  });

  it('refuses a package with dependencies, which a lockfile of one package would leave unpinned', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'])
      expect(() => shrinkwrap({ ...PACKAGE, [field]: { tiny: '^1.0.0' } })).toThrow(new RegExp(field, 'u'));
    expect(() => shrinkwrap({ ...PACKAGE, dependencies: {} })).not.toThrow();
  });

  it('goes in the package, from package.json’s files', () => {
    expect(PACKAGE.files).toContain(SHRINKWRAP);
    expect(PACKAGE.dependencies ?? {}).toEqual({});
    // An older commit's package.json, which the stable job may publish, gets it too.
    const older = { ...PACKAGE, files: ['scripts/tasks.mjs'] };
    expect(withShrinkwrap(older).files).toEqual(['scripts/tasks.mjs', SHRINKWRAP]);
    expect(withShrinkwrap(PACKAGE).files).toEqual(PACKAGE.files);
  });

  it('is written before both of the release’s npm publishes, by main’s helper', () => {
    const steps = RELEASE.split(/\n {6}- /u).filter((step) => step.startsWith('name: Stage the CLI on npm\n'));
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const write = step.indexOf('node "$RUNNER_TEMP/shrinkwrap.mjs"');
      expect(write).toBeGreaterThan(-1);
      expect(write).toBeLessThan(step.indexOf('npm stage publish'));
      // After the version is set (the pre-release sets it in an earlier step), so the lockfile names the one published.
      const set = step.indexOf('p.version=process.env.');
      if (set !== -1) expect(write).toBeGreaterThan(set);
    }
    // Copied from the workflow's own checkout, so the stable job has it after it checks out an older commit.
    expect(RELEASE.match(/cp scripts\/release\/shrinkwrap\.mjs "\$RUNNER_TEMP\/shrinkwrap\.mjs"/gu)).toHaveLength(2);
  });

  it('isn’t committed: it’s written for the version being published', () => {
    expect(read('.gitignore')).toMatch(/^\/npm-shrinkwrap\.json$/mu);
  });
});
