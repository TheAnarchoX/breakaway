import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pluginVersion, withVersion } from './plugin.mjs';

// LCH-24: the Plugin workflow moves the plugin branch, which the plugin directory and this repository's marketplace
// follow, the way the Site workflow moves site: the stable release calls it with the released tag, and only the owner
// runs it by hand. The commit it puts there is the tag's, with plugin.json's version set to the release's.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const PLUGIN = read('.github/workflows/plugin.yml');
const CHECK = read('.github/workflows/plugin-check.yml');
const RELEASE = read('.github/workflows/release.yml');
const AGENTS = read('AGENTS.md');
const secrets = (text) => new Set([...text.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]));
const uses = (text) => [...text.matchAll(/uses: (\S+)/gu)].map((m) => m[1]);
const claude = (text) => [...text.matchAll(/@anthropic-ai\/claude-code@(\S+)/gu)].map((m) => m[1]);

describe('the plugin’s version (LCH-24)', () => {
  it('is the release’s, from a stable or pre-release tag', () => {
    expect(pluginVersion('v1.6.0', [])).toBe('1.6.0');
    expect(pluginVersion('v1.6.1-main.3', [])).toBe('1.6.1-main.3');
  });

  it('for a commit, is the release tag on it, a stable before a pre-release', () => {
    const commit = '1e0bd0c';
    expect(pluginVersion(commit, ['v1.6.0-main.4', 'v1.6.0'])).toBe('1.6.0');
    expect(pluginVersion(commit, ['v1.6.1-main.2'])).toBe('1.6.1-main.2');
    expect(pluginVersion('main', ['other', 'v1.6.1-main.2', 'v1.6.1-main.10'])).toBe('1.6.1-main.10');
  });

  it('refuses a commit no release was made from', () => {
    expect(() => pluginVersion('1e0bd0c', [])).toThrow(/no release/u);
    expect(() => pluginVersion('main', ['latest', 'v1.6'])).toThrow(/no release/u);
  });

  it('is written into plugin.json, and nothing else changes', () => {
    const before = read('plugin/.claude-plugin/plugin.json');
    const after = JSON.parse(withVersion(before, '1.6.0'));
    expect(after).toEqual({ ...JSON.parse(before), version: '1.6.0' });
    expect(() => withVersion(before, 'next')).toThrow(/version/u);
    expect(() => withVersion('{}', '1.6.0')).toThrow(/version/u);
  });
});

describe('the Plugin workflow (LCH-24)', () => {
  it('runs when the stable release calls it with the tag, or by hand, and on nothing else', () => {
    expect(PLUGIN).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+ref:/u);
    expect(PLUGIN).toMatch(/workflow_call:\n\s+inputs:\n\s+ref:/u);
    expect(PLUGIN).not.toMatch(/^\s+(push|schedule|pull_request|workflow_run):/mu);
    expect(RELEASE).toMatch(
      / {2}plugin:\n[\s\S]*?needs: stable\n[\s\S]*?uses: \.\/\.github\/workflows\/plugin\.yml\n\s+with:\n\s+ref: v\$\{\{ needs\.stable\.outputs\.version \}\}\n\s+secrets: inherit\n/u,
    );
  });

  it('puts only a commit that’s on main on the plugin branch', () => {
    expect(PLUGIN).toContain("if: github.ref == 'refs/heads/main'");
    expect(PLUGIN).toContain('git merge-base --is-ancestor "$commit" origin/main');
    expect(PLUGIN).toMatch(/git push --force "git@github\.com:\$GITHUB_REPOSITORY\.git" "HEAD:refs\/heads\/plugin"/u);
  });

  it('sets the version with main’s helper, and validates what it pushes as the plugin check does', () => {
    expect(PLUGIN).toContain('node scripts/release/plugin.mjs "$REF" "$tree/plugin/.claude-plugin/plugin.json"');
    expect(claude(PLUGIN).length).toBeGreaterThan(0);
    expect(new Set([...claude(PLUGIN), ...claude(CHECK)]).size).toBe(1);
    expect(PLUGIN).toContain('plugin validate --strict plugin');
    expect(PLUGIN.indexOf('plugin validate --strict')).toBeLessThan(PLUGIN.indexOf('git push --force'));
  });

  it('pushes with the plugin environment’s deploy key, to GitHub’s own host key, and nothing else', () => {
    expect(PLUGIN).toMatch(/^ {4}environment: plugin$/mu);
    expect([...secrets(PLUGIN)]).toEqual(['PLUGIN_DEPLOY_KEY']);
    expect(PLUGIN).toContain('StrictHostKeyChecking=yes');
    expect(PLUGIN).toContain(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    );
    expect(PLUGIN).toMatch(/^permissions: \{\}$/mu);
  });

  it('pins its actions as the plugin check does', () => {
    const pinned = new Set(uses(CHECK));
    expect(uses(PLUGIN).length).toBeGreaterThan(0);
    for (const action of uses(PLUGIN)) expect(pinned, action).toContain(action);
  });

  it('is the owner’s to run, beside Site, in AGENTS.md', () => {
    expect(AGENTS).toMatch(/the \*\*Site\*\* and \*\*Plugin\*\* workflows are the owner's to run/u);
  });
});
