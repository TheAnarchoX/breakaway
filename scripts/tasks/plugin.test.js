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
    expect(manifest).toMatchObject({ name: 'breakaway', license: 'PolyForm-Noncommercial-1.0.0' });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    for (const name of ['claim', 'next', 'hand-over']) {
      const skill = read(`${PLUGIN_DIR}skills/${name}/SKILL.md`);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\n`, 'u'));
      expect(skill).toContain(`npx --yes ${CLI_PACKAGE} `);
      // Commands do what an agent may already do: they never force a claim or finish a task themselves.
      expect(skill).not.toMatch(/breakaway@2 (?:claim|next|release)\b[^`]*--force|breakaway@2 done\b/u);
    }
    expect(read(`${PLUGIN_DIR}README.md`).split(/\s+/u).length).toBeGreaterThan(40);
  });

  it('asks for the board’s address, token, and agent name, the token kept secret (CLI-8)', () => {
    const { userConfig } = json(`${PLUGIN_DIR}.claude-plugin/plugin.json`);
    expect(Object.keys(userConfig)).toEqual(['board_url', 'token', 'agent_name']);
    for (const option of Object.values(userConfig)) {
      expect(option).toMatchObject({ type: 'string', title: expect.any(String), description: expect.any(String) });
      // Claude Code refuses an option with a key it doesn't know.
      for (const key of Object.keys(option))
        expect(['type', 'title', 'description', 'required', 'default', 'sensitive']).toContain(key);
    }
    expect(userConfig.board_url.required).toBe(true);
    expect(userConfig.token.sensitive).toBe(true);
    expect(userConfig.agent_name.sensitive).toBeFalsy();
  });

  it('connects the board’s MCP server with its settings, and the CLI’s headers for the checkout (CLI-9)', () => {
    const { mcpServers } = json(`${PLUGIN_DIR}.mcp.json`);
    expect(Object.keys(mcpServers)).toEqual(['breakaway']);
    const server = mcpServers.breakaway;
    expect(server).toMatchObject({
      type: 'http',
      url: '${user_config.board_url}/mcp',
      headers: {
        Authorization: 'Bearer ${user_config.token}',
        // The helper can't see agent_name, so it goes as a static header, empty when it isn't set (CLI-16).
        'X-Breakaway-Agent': '${user_config.agent_name}',
      },
    });
    expect(json(`${PLUGIN_DIR}.claude-plugin/plugin.json`).userConfig.agent_name.default).toBe('');
    // The helper runs in the plugin's folder, through a shell, and can't name an option. The CLI finds the session's
    // checkout itself: the plugin directory refuses a helper that computes a path, like cd "${CLAUDE_PROJECT_DIR}" (CLI-20).
    expect(server.headersHelper).toBe(`npx --yes ${CLI_PACKAGE} mcp --headers`);
    const { userConfig } = json(`${PLUGIN_DIR}.claude-plugin/plugin.json`);
    for (const [, key] of JSON.stringify(server).matchAll(/\$\{user_config\.(\w+)\}/gu))
      expect(Object.keys(userConfig)).toContain(key);
  });

  it('has a square PNG icon the plugin directory takes (CLI-20)', () => {
    const png = readFileSync(new URL(`${PLUGIN_DIR}.claude-plugin/icon.png`, ROOT));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(png.length).toBeLessThan(2 * 1024 * 1024);
  });

  it('links its privacy policy, a page of the docs (CLI-20)', () => {
    const { privacyPolicyUrl } = json(`${PLUGIN_DIR}.claude-plugin/plugin.json`);
    expect(privacyPolicyUrl).toBe('https://leavethepack.dev/docs/privacy/');
    expect(read('site/content/docs/privacy.md')).toMatch(/^---\ntitle: Privacy\n/u);
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
