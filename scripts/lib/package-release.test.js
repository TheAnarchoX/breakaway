import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nextPrerelease, prereleaseAmong, stableOf, tagPrefix } from './package-release.js';

// BRK-90: a repository's npm release flow counts its versions the way breakaway's own does, under its tag prefix.
describe('a package’s version numbers (BRK-90)', () => {
  it('counts pre-releases from package.json, and the next patch once a stable is out', () => {
    expect(nextPrerelease('1.2.0', [], 'v')).toEqual({ version: '1.2.0-main.1', base: '1.2.0', tag: 'v1.2.0-main.1' });
    expect(nextPrerelease('1.2.0', ['v1.2.0-main.1', 'v1.2.0-main.2'], 'v').version).toBe('1.2.0-main.3');
    expect(nextPrerelease('1.2.0', ['v1.2.0-main.4', 'v1.2.0'], 'v').version).toBe('1.2.1-main.1');
  });

  it('reads only its own prefix’s tags, so production’s v… tags never count', () => {
    const tags = ['v20261004-abc1234', 'v1.2.0', 'widgets@1.2.0-main.2', 'other@1.2.0-main.9'];
    expect(nextPrerelease('1.2.0', tags, 'widgets@')).toEqual({
      version: '1.2.0-main.3',
      base: '1.2.0',
      tag: 'widgets@1.2.0-main.3',
    });
    expect(nextPrerelease('1.0.0', ['@acme/widgets@1.0.0', '@acme/widgets@1.0.1-main.1'], '@acme/widgets@').tag).toBe(
      '@acme/widgets@1.0.1-main.2',
    );
  });

  it('uses v, or <package>@ when production deploys already tag v…', () => {
    expect(tagPrefix('widgets')).toBe('v');
    expect(tagPrefix('@acme/widgets', { workers: true })).toBe('@acme/widgets@');
  });

  it('finds a pre-release already staged from a commit, so a second run stages nothing', () => {
    expect(prereleaseAmong(['latest', 'v1.0.0-main.3'], 'v')).toEqual({
      tag: 'v1.0.0-main.3',
      version: '1.0.0-main.3',
    });
    expect(prereleaseAmong(['v1.0.0'], 'v')).toBeNull();
  });

  it('promotes a pre-release tag to its stable, and refuses anything else', () => {
    expect(stableOf('widgets@1.4.0-main.37', 'widgets@')).toBe('1.4.0');
    expect(() => stableOf('v1.4.0-main.37', 'widgets@')).toThrow(/widgets@1\.4\.0-main\.37/u);
    expect(() => nextPrerelease('1.4', [], 'v')).toThrow(/isn't a version/u);
  });
});

// The helper the Release workflow runs, against a real repository's tags.
describe('scripts/package-release.mjs (BRK-90)', () => {
  const script = fileURLToPath(new URL('../package-release.mjs', import.meta.url));
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const helper = (...args) => spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' });

  it('picks the next pre-release, sees one already staged, and finds a stable’s commit', () => {
    dir = mkdtempSync(join(tmpdir(), 'package-release-'));
    git('init', '-q');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'widgets', version: '1.2.0' }));
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one', '--allow-empty');
    const first = git('rev-parse', 'HEAD');
    git('tag', 'widgets@1.2.0-main.1');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'two', '--allow-empty');
    const second = git('rev-parse', 'HEAD');

    expect(helper('prerelease', '--prefix', 'widgets@', '--sha', second).stdout).toBe(
      'version=1.2.0-main.2\ntag=widgets@1.2.0-main.2\nexists=false\n',
    );
    expect(helper('prerelease', '--prefix', 'widgets@', '--sha', first).stdout).toBe(
      'version=1.2.0-main.1\ntag=widgets@1.2.0-main.1\nexists=true\n',
    );
    expect(helper('stable', 'widgets@1.2.0-main.1', '--prefix', 'widgets@').stdout).toBe(
      `version=1.2.0\ntag=widgets@1.2.0\ncommit=${first}\n`,
    );
    git('tag', 'widgets@1.2.0', first);
    const again = helper('stable', 'widgets@1.2.0-main.1', '--prefix', 'widgets@');
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/widgets@1\.2\.0 is already released/u);
    expect(helper('stable', 'widgets@9.9.9-main.1', '--prefix', 'widgets@').stderr).toMatch(/There is no pre-release/u);
    expect(helper('prerelease', '--prefix', 'widgets@').stdout).toMatch(/^version=1\.2\.1-main\.1\n/u);
  });
});
