import { describe, expect, it } from 'vitest';
import { wranglerConfig } from '../../src/install.js';
import {
  bumpBody,
  checkManifest,
  compareVersions,
  configStop,
  deployTarget,
  isHealthy,
  latestReleases,
  parseState,
  previousVersionId,
  workerMissing,
  shapeChanges,
  shapeOf,
  updatePlan,
} from './lib.js';

const feed = (stable, main) => ({
  channels: { stable: stable && { version: stable }, main: main && { version: main } },
});

describe('versions', () => {
  it('orders releases, with a pre-release below its stable and main.10 above main.9', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-main.3', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-main.10', '0.2.0-main.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/isn't a version/u);
  });
});

describe('breakaway.json', () => {
  it('takes a pinned stable release or a main channel', () => {
    expect(parseState({ version: '0.2.0', channel: 'stable' })).toEqual({ version: '0.2.0', channel: 'stable' });
    expect(parseState({ version: '0.2.1-main.4', channel: 'main' }).channel).toBe('main');
  });

  it('says what is wrong', () => {
    expect(() => parseState([])).toThrow(/JSON object/u);
    expect(() => parseState({ version: '0.2.0', channel: 'beta' })).toThrow(/"stable" or "main"/u);
    expect(() => parseState({ version: 'latest', channel: 'stable' })).toThrow(/version is a release/u);
    expect(() => parseState({ version: '0.2.1-main.4', channel: 'stable' })).toThrow(/pins a stable version/u);
  });
});

describe('finding releases', () => {
  it('reads the feed', () => {
    expect(latestReleases(feed('0.2.0', '0.2.1-main.4'))).toEqual({
      stable: { version: '0.2.0' },
      main: { version: '0.2.1-main.4' },
    });
    expect(latestReleases(feed(null, null))).toEqual({ stable: null, main: null });
  });

  it('reads GitHub’s releases when the feed has none, by version and never by date, skipping drafts', () => {
    const list = [
      { tag_name: 'v0.2.1-main.2', prerelease: true },
      { tag_name: 'v0.2.1-main.10', prerelease: true },
      { tag_name: 'v0.2.1-main.9', prerelease: true },
      { tag_name: 'v0.2.0', prerelease: false },
      { tag_name: 'v0.1.0', prerelease: false },
      { tag_name: 'v0.3.0', prerelease: false, draft: true },
      { tag_name: 'v0.2.5', prerelease: true },
    ];
    expect(latestReleases(list)).toEqual({ stable: { version: '0.2.0' }, main: { version: '0.2.1-main.10' } });
  });

  it('refuses something else', () => {
    expect(() => latestReleases('nope')).toThrow(/neither the feed/u);
  });
});

describe('what deploy puts on the Worker', () => {
  it('is the pinned release on stable and the latest pre-release on main', () => {
    expect(deployTarget({ channel: 'stable', version: '0.2.0' }, latestReleases(feed('0.3.0', null)))).toEqual({
      version: '0.2.0',
      tag: 'v0.2.0',
      channel: 'stable',
    });
    expect(deployTarget({ channel: 'main', version: '0.2.0' }, latestReleases(feed('0.3.0', '0.3.1-main.2'))).tag).toBe(
      'v0.3.1-main.2',
    );
  });

  it('says so when main has nothing yet', () => {
    expect(() => deployTarget({ channel: 'main', version: '0.2.0' }, latestReleases(feed('0.3.0', null)))).toThrow(
      /no pre-release yet/u,
    );
  });
});

describe('a release that may deploy by itself', () => {
  const manifest = { version: '0.2.0', manual: false, updatesFrom: '0.1.0' };

  it('passes', () => {
    expect(checkManifest(manifest, { version: '0.2.0', running: '0.1.5' })).toEqual({ ok: true });
    expect(checkManifest(manifest, { version: '0.2.0' })).toEqual({ ok: true });
  });

  it('stops for a manual release, with its steps', () => {
    const verdict = checkManifest(
      { ...manifest, manual: true, manualSteps: ['Add the new binding.', 'Run the migration.'] },
      { version: '0.2.0' },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('needs steps by hand');
    expect(verdict.message).toContain('- Add the new binding.');
    expect(verdict.message).toContain('- Run the migration.');
  });

  it('stops for a manifest of another release, and for a running release that is too old', () => {
    expect(checkManifest({ ...manifest, version: '0.1.0' }, { version: '0.2.0' }).message).toContain(
      'manifest is for 0.1.0',
    );
    expect(
      checkManifest({ ...manifest, updatesFrom: '0.1.5' }, { version: '0.2.0', running: '0.1.0' }).message,
    ).toContain('updates from 0.1.5');
    expect(checkManifest(null, { version: '0.2.0' }).ok).toBe(false);
  });
});

describe('a config change the workflow can’t deploy', () => {
  const base = { name: 'board', worker: 'board' };
  const shape = (config) => shapeOf(wranglerConfig(config));

  it('is none for a rename, a secrets prefix, or the same config', () => {
    expect(shapeChanges(shape(base), shape({ ...base, name: 'Other', secretsPrefix: 'OTHER_' }))).toEqual([]);
    expect(configStop([])).toBeNull();
  });

  it('is the address, the Durable Object, and the jurisdiction', () => {
    expect(shapeChanges(shape(base), shape({ ...base, url: 'https://tasks.example.com' }))).toEqual([
      'its address (routes)',
      'its workers.dev address',
    ]);
    expect(shapeChanges(shape(base), shape({ ...base, jurisdiction: 'eu' }))).toEqual(['its jurisdiction']);
    expect(configStop(['its address (routes)'])).toContain(
      "changed its address (routes), which the workflow doesn't deploy",
    );
  });
});

describe('rollback', () => {
  it('goes to the version the newest deployment ran before', () => {
    const deployments = [
      { created_on: '2026-10-01T10:00:00Z', versions: [{ version_id: 'old', percentage: 100 }] },
      { created_on: '2026-10-02T10:00:00Z', versions: [{ version_id: 'new', percentage: 100 }] },
    ];
    expect(previousVersionId(deployments)).toBe('new');
    expect(previousVersionId([])).toBeNull();
    expect(previousVersionId({})).toBeNull();
  });

  it('takes a failed list for a first deploy only when the Worker does not exist', () => {
    expect(workerMissing('✘ [ERROR] This Worker does not exist on your account. [code: 10007]')).toBe(true);
    expect(
      workerMissing('✘ [ERROR] A request to the Cloudflare API failed. Invalid account identifier [code: 7003]'),
    ).toBe(false);
    expect(workerMissing('')).toBe(false);
  });

  it('accepts only the release it expects from /api/ping', () => {
    expect(isHealthy({ ok: true, release: '0.2.0' }, '0.2.0')).toBe(true);
    expect(isHealthy({ ok: true, release: '0.1.0' }, '0.2.0')).toBe(false);
    expect(isHealthy(null, '0.2.0')).toBe(false);
  });
});

describe('updating', () => {
  const stable = { channel: 'stable', version: '0.2.0' };

  it('bumps stable to a newer stable release, and never to an older one or a pre-release', () => {
    expect(updatePlan(stable, latestReleases(feed('0.3.0', '0.3.1-main.1')))).toEqual({
      action: 'bump',
      version: '0.3.0',
      tag: 'v0.3.0',
    });
    expect(updatePlan(stable, latestReleases(feed('0.2.0', '0.2.1-main.1'))).action).toBe('none');
    expect(updatePlan(stable, latestReleases(feed('0.1.0', null))).action).toBe('none');
    expect(updatePlan(stable, latestReleases(feed(null, null))).reason).toContain('no stable release');
  });

  it('deploys main when a newer pre-release than the running one exists', () => {
    const main = { channel: 'main', version: '0.2.1-main.1' };
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), '0.2.1-main.1')).toEqual({
      action: 'deploy',
      version: '0.2.1-main.3',
      tag: 'v0.2.1-main.3',
    });
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), '0.2.1-main.3').action).toBe('none');
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), null).reason).toContain(
      'running release is unknown',
    );
  });

  it('writes the pull request’s description, with a manual release’s steps', () => {
    const plain = bumpBody({
      from: '0.2.0',
      to: '0.3.0',
      repository: 'acme/breakaway',
      notes: '### Board\n- a change',
      manifest: { manual: false },
    });
    expect(plain).toContain('Updates breakaway from 0.2.0 to 0.3.0. Merging this deploys it.');
    expect(plain).toContain('https://github.com/acme/breakaway/releases/tag/v0.3.0');
    expect(plain).toContain('- a change');
    const manual = bumpBody({
      from: '0.2.0',
      to: '0.3.0',
      repository: 'acme/breakaway',
      notes: '',
      manifest: { manual: true, manualSteps: ['Do this.'] },
    });
    expect(manual).toContain("won't deploy it");
    expect(manual).toContain('- Do this.');
  });
});
