import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkManifest } from '../install/lib.js';
import {
  compareVersions,
  manifestOf,
  shapeOf,
  importedPackages,
  manualSection,
  nextPrerelease,
  nextVersion,
  stableOf,
} from './lib.js';

describe('nextPrerelease', () => {
  it("starts at main.1 of package.json's version", () => {
    expect(nextPrerelease('0.1.0', [])).toEqual({ version: '0.1.0-main.1', base: '0.1.0', tag: 'v0.1.0-main.1' });
  });
  it('counts on from the last pre-release of that version', () => {
    expect(
      nextPrerelease('0.1.0', ['v0.1.0-main.1', 'v0.1.0-main.9', 'v0.1.0-main.10', 'v0.0.9-main.40']).version,
    ).toBe('0.1.0-main.11');
  });
  it('moves to the next patch once the stable exists, so it never sorts below it', () => {
    expect(nextPrerelease('0.1.0', ['v0.1.0-main.3', 'v0.1.0']).version).toBe('0.1.1-main.1');
    expect(nextPrerelease('0.2.0', ['v0.1.0', 'v0.1.1']).version).toBe('0.2.0-main.1');
  });
  it('refuses a version that is not X.Y.Z', () => {
    expect(() => nextPrerelease('1.0', [])).toThrow(/isn't a version/);
  });
});

describe('stableOf', () => {
  it('drops the pre-release suffix', () => expect(stableOf('v1.4.0-main.37')).toBe('1.4.0'));
  it('refuses anything else', () => {
    expect(() => stableOf('v1.4.0')).toThrow();
    expect(() => stableOf('main')).toThrow();
  });
});

// BRK-118: promoting a stable with next minor or major opens the pull request that sets package.json to it, so the
// pre-releases after it count toward the version being built instead of the stable's next patch.
describe('nextVersion (BRK-118)', () => {
  it('picks the next minor or major after the stable', () => {
    expect(nextVersion('1.3.0', 'minor', '1.3.0')).toBe('1.4.0');
    expect(nextVersion('1.3.0', 'major', '1.3.0')).toBe('2.0.0');
    expect(nextVersion('1.3.2', 'minor', '1.3.2')).toBe('1.4.0');
    expect(nextVersion('1.9.4', 'minor', '1.9.4')).toBe('1.10.0');
    expect(nextVersion('0.4.1', 'major', '0.4.1')).toBe('1.0.0');
  });
  it('sets nothing for a patch: the pre-releases count patches by themselves', () => {
    expect(nextVersion('1.3.0', 'patch', '1.3.0')).toBeNull();
  });
  it('sets nothing when package.json is already there or past it', () => {
    expect(nextVersion('1.3.0', 'minor', '1.4.0')).toBeNull();
    expect(nextVersion('1.3.0', 'minor', '2.0.0')).toBeNull();
    expect(nextVersion('1.3.0', 'major', '2.0.0')).toBeNull();
    // An older pre-release promoted after main moved on: main already works toward the next minor.
    expect(nextVersion('1.2.0', 'minor', '1.3.0')).toBeNull();
  });
  it('moves past a package.json below the choice', () => {
    expect(nextVersion('1.3.0', 'major', '1.4.0')).toBe('2.0.0');
  });
  it('refuses another choice or a version that is not X.Y.Z', () => {
    expect(() => nextVersion('1.3.0', 'feature', '1.3.0')).toThrow(/patch, minor, or major/);
    expect(() => nextVersion('1.3', 'minor', '1.3.0')).toThrow(/isn't a version/);
    expect(() => nextVersion('1.3.0', 'minor', '1.3.0-main.2')).toThrow(/isn't a version/);
  });
});

it('compares versions numerically', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
});

describe('manifest and manual steps', () => {
  const base = { version: '1.4.0-main.37', channel: 'main', commit: 'abc', created: '2026-10-03T00:00:00Z' };
  it('says manual false by default', () => {
    expect(manifestOf({ ...base, config: { updatesFrom: '1.0.0' } })).toMatchObject({
      manual: false,
      updatesFrom: '1.0.0',
    });
    expect(manualSection({})).toBe('');
  });
  it('carries the bundle’s checksum when it has one (BRK-52)', () => {
    expect(manifestOf({ ...base, config: {}, bundleSha256: 'ab'.repeat(32) }).bundleSha256).toBe('ab'.repeat(32));
    expect(manifestOf({ ...base, config: {} })).not.toHaveProperty('bundleSha256');
  });
  it('needs the steps when manual', () => {
    expect(() => manifestOf({ ...base, config: { manual: true, manualSteps: [] } })).toThrow(/manualSteps/);
    const config = { manual: true, manualSteps: ['Add the new cron trigger.'] };
    expect(manifestOf({ ...base, config }).manual).toBe(true);
    expect(manualSection(config)).toContain('### Manual steps');
  });
  it('says when a manual release’s only step is wrangler deploy (BRK-62)', () => {
    const config = {
      manual: true,
      manualSteps: ['Deploy with wrangler deploy: it adds a class.'],
      wranglerDeploy: true,
    };
    expect(manifestOf({ ...base, config }).wranglerDeploy).toBe(true);
    expect(manualSection(config)).toContain('wrangler deploy');
    expect(manifestOf({ ...base, config: { manual: true, manualSteps: ['x'] } })).not.toHaveProperty('wranglerDeploy');
    expect(() => manifestOf({ ...base, config: { wranglerDeploy: true } })).toThrow(/manual/);
  });
  it('updates from the first release there was unless release.json says otherwise', () => {
    expect(manifestOf({ ...base, config: {} }).updatesFrom).toBe('0.1.0-main.1');
  });
});

describe("release.json's updatesFrom (BRK-67)", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
  it('lets an install on the main channel take the next pre-release', () => {
    // A stable floor like 0.1.0 is above all of 0.1.0's own pre-releases, so a main-channel install could never update.
    const { version } = json('package.json');
    const next = `${version}-main.8`;
    const manifest = manifestOf({
      version: next,
      channel: 'main',
      commit: 'abc',
      config: json('release.json'),
      created: '2026-10-03T00:00:00Z',
    });
    expect(checkManifest(manifest, { version: next, running: `${version}-main.7` })).toEqual({ ok: true });
  });
});

describe('importedPackages', () => {
  it('names the packages, not their files, and skips relative and runtime imports', () => {
    const text = [
      "import { unzlibSync } from 'fflate';",
      "import { chacha20poly1305 } from '@noble/ciphers/chacha.js';",
      "import { DurableObject } from 'cloudflare:workers';",
      "import { x } from './model.js';",
      "import fs from 'node:fs';",
      "export { y } from 'fflate/browser';",
      "import '@scope/side-effect';",
    ].join('\n');
    expect(importedPackages([text])).toEqual(['@noble/ciphers', '@scope/side-effect', 'fflate']);
  });
});

describe('the shape a release expects (BRK-54)', () => {
  const wrangler = {
    durable_objects: { bindings: [{ name: 'STORE', class_name: 'TaskStore' }] },
    version_metadata: { binding: 'VERSION' },
    assets: { binding: 'ASSETS' },
    migrations: [{ tag: 'v1' }, { tag: 'v2' }],
    triggers: { crons: ['*/5 * * * *'] },
    routes: [{ pattern: 'board.example.com/*' }],
  };
  it('lists bindings, classes, migrations, crons, and routes from the wrangler config', () => {
    expect(shapeOf(wrangler)).toEqual({
      bindings: ['assets:ASSETS', 'durable_object_namespace:STORE', 'version_metadata:VERSION'],
      durableObjects: ['TaskStore'],
      migrations: ['v1', 'v2'],
      crons: ['*/5 * * * *'],
      routes: ['board.example.com/*'],
    });
    expect(shapeOf({})).toMatchObject({ bindings: [], crons: [], migrations: [] });
  });
  it('goes in the manifest when given', () => {
    const base = {
      version: '1.4.0-main.37',
      channel: 'main',
      commit: 'abc',
      created: '2026-10-03T00:00:00Z',
      config: {},
    };
    expect(manifestOf({ ...base, shape: shapeOf(wrangler) }).shape.durableObjects).toEqual(['TaskStore']);
    expect(manifestOf(base)).not.toHaveProperty('shape');
  });
});
