import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { passPluginEnv, pluginEnvLines } from './plugin-env.js';

const plugin = {
  CLAUDE_PLUGIN_ROOT: '/p',
  CLAUDE_PLUGIN_OPTION_BOARD_URL: 'https://board.example',
  CLAUDE_PLUGIN_OPTION_TOKEN: "t'ok en",
  CLAUDE_PLUGIN_OPTION_AGENT_NAME: '',
};

describe('the plugin’s settings for the session’s Bash (CLI-8)', () => {
  it('exports the options that are set, quoted for the shell', () => {
    const lines = pluginEnvLines(plugin);
    expect(lines).toBe(
      "export CLAUDE_PLUGIN_OPTION_BOARD_URL='https://board.example'\nexport CLAUDE_PLUGIN_OPTION_TOKEN='t'\\''ok en'\n",
    );
    const out = execFileSync('sh', ['-c', `${lines}printf %s "$CLAUDE_PLUGIN_OPTION_TOKEN"`], { encoding: 'utf8' });
    expect(out).toBe("t'ok en");
  });

  it('does nothing outside a plugin’s hook, or with no options set', () => {
    expect(pluginEnvLines({ ...plugin, CLAUDE_PLUGIN_ROOT: undefined })).toBe('');
    expect(pluginEnvLines({ CLAUDE_PLUGIN_ROOT: '/p' })).toBe('');
  });

  it('appends to CLAUDE_ENV_FILE only when Claude Code gives one, and never throws', () => {
    const writes = [];
    const append = (path, text) => writes.push([path, text]);
    expect(passPluginEnv(plugin, append)).toBe(false);
    expect(passPluginEnv({ ...plugin, CLAUDE_ENV_FILE: '/s/env' }, append)).toBe(true);
    expect(writes).toEqual([['/s/env', pluginEnvLines(plugin)]]);
    const broken = () => {
      throw new Error('EACCES');
    };
    expect(passPluginEnv({ ...plugin, CLAUDE_ENV_FILE: '/s/env' }, broken)).toBe(false);
  });
});
