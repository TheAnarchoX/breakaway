import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkManifest } from '../install/lib.js';
import { compareVersions, manifestOf, importedPackages, manualSection, nextPrerelease, stableOf } from './lib.js';

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
  it('needs the steps when manual', () => {
    expect(() => manifestOf({ ...base, config: { manual: true, manualSteps: [] } })).toThrow(/manualSteps/);
    const config = { manual: true, manualSteps: ['Add the new cron trigger.'] };
    expect(manifestOf({ ...base, config }).manual).toBe(true);
    expect(manualSection(config)).toContain('### Manual steps');
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
