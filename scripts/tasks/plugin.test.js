import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_PACKAGE, sessionHooks } from '../../src/init.js';
import { BOARD, PLUGIN_DIR, pluginFiles, pluginSkill } from '../plugin.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const json = (path) => JSON.parse(read(path));

describe('the breakaway plugin (CLI-7)', () => {
  it('is what node scripts/plugin.mjs writes: the tasks skill, the hooks, and the licence', () => {
    for (const [path, content] of Object.entries(pluginFiles(read)))
      expect(read(path), `${path} is behind its source: run node scripts/plugin.mjs and commit it.`).toBe(content);
  });

  it('runs the session hooks repos init writes into .claude/settings.json, from sessionHooks()', () => {
    expect(json(`${PLUGIN_DIR}hooks/hooks.json`).hooks).toEqual(sessionHooks());
  });

  it('writes the tasks skill for any repository: no link into breakaway’s checkout, and no breakaway rules', () => {
    const skill = read(`${PLUGIN_DIR}skills/tasks/SKILL.md`);
    expect(skill).not.toMatch(/\]\(\.\.\//u);
    expect(skill).not.toMatch(/breakaway's areas|breakaway's work is on the board|prompts\/breakaway\.md/u);
    expect(skill).toContain(`(https://github.com/${BOARD}/blob/main/prompts/core.md)`);
    expect(skill).toMatch(/^---\nname: tasks\n/u);
  });

  it('fails loudly when the skill is reworded where the plugin changes it', () => {
    expect(() => pluginSkill('---\nname: tasks\n---\nNothing to change.')).toThrow(/tasks skill/u);
  });

  it('has a manifest, three commands that run the CLI on npm, and a README', () => {
    const manifest = json(`${PLUGIN_DIR}.claude-plugin/plugin.json`);
    expect(manifest).toMatchObject({ name: 'breakaway', license: 'FSL-1.1-Apache-2.0' });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    for (const name of ['claim', 'next', 'hand-over']) {
      const skill = read(`${PLUGIN_DIR}skills/${name}/SKILL.md`);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\n`, 'u'));
      expect(skill).toContain(`npx --yes ${CLI_PACKAGE} `);
      // Commands do what an agent may already do: they never force a claim or finish a task themselves.
      expect(skill).not.toMatch(/breakaway@1 (?:claim|next|release)\b[^`]*--force|breakaway@1 done\b/u);
    }
    expect(read(`${PLUGIN_DIR}README.md`).split(/\s+/u).length).toBeGreaterThan(40);
  });

  it('is offered by this repository’s marketplace, from the plugin branch', () => {
    const market = json('.claude-plugin/marketplace.json');
    expect(market.name).toBe('breakaway');
    expect(market.plugins).toEqual([
      expect.objectContaining({
        name: 'breakaway',
        source: { source: 'git-subdir', url: `https://github.com/${BOARD}.git`, path: 'plugin', ref: 'plugin' },
      }),
    ]);
  });
});
