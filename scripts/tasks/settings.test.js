import { describe, expect, it } from 'vitest';
import {
  RUN_KEY,
  RUN_KEY_HEADER,
  authHeaders,
  boardUrl,
  configDir,
  parseEnvFile,
  readSetting,
  settingFrom,
  taskrcFixes,
  taskrcUrl,
  tildePath,
} from './settings.js';

describe('settings (CLD-136)', () => {
  it('reads each setting’s breakaway name, the environment before the file', () => {
    expect(readSetting('TOKEN', { env: { BREAKAWAY_TOKEN: 'env' }, file: { BREAKAWAY_TOKEN: 'file' } })).toBe('env');
    expect(readSetting('TOKEN', { env: {}, file: { BREAKAWAY_TOKEN: 'file' } })).toBe('file');
    expect(readSetting('AGENT', { file: { BREAKAWAY_AGENT: 'claude-x' } })).toBe('claude-x');
    expect(readSetting('REPO', { env: {}, file: {} }, 'fallback')).toBe('fallback');
    expect(readSetting('URL', { env: { BREAKAWAY_URL: '' }, file: { BREAKAWAY_URL: 'u' } })).toBe('u');
    expect(() => readSetting('NOPE', {})).toThrow();
  });

  it('keeps the board’s files in ~/.config/breakaway, or BREAKAWAY_HOME', () => {
    expect(configDir({ home: '/h' })).toBe('/h/.config/breakaway');
    expect(configDir({ env: { BREAKAWAY_HOME: '/x/board/' }, home: '/h' })).toBe('/x/board');
    expect(tildePath('/h/.config/breakaway/taskrc', '/h')).toBe('~/.config/breakaway/taskrc');
    expect(tildePath('/x/board/taskrc', '/h')).toBe('/x/board/taskrc');
  });

  it('finds the board: a setting, then the checkout’s .taskrc, then the install’s config, else none', () => {
    const taskrc =
      'include tools/tasks/taskrc\nsync.server.url=https://old.example\nsync.server.url = https://b.example/\n';
    expect(taskrcUrl(taskrc)).toBe('https://b.example/');
    expect(taskrcUrl('# nothing')).toBe(null);
    expect(boardUrl({ env: { BREAKAWAY_URL: 'https://a.example/' }, taskrc })).toEqual({
      url: 'https://a.example',
      from: 'environment',
    });
    expect(boardUrl({ file: { BREAKAWAY_URL: 'https://s.example' }, taskrc })).toEqual({
      url: 'https://s.example',
      from: 'tasks.env',
    });
    expect(boardUrl({ taskrc, config: { url: 'https://c.example' } })).toEqual({
      url: 'https://b.example',
      from: '.taskrc',
    });
    expect(boardUrl({ config: { url: 'https://c.example' } })).toEqual({ url: 'https://c.example', from: 'config' });
    expect(boardUrl({})).toEqual({ url: null, from: 'default' });
  });

  it('reads the plugin’s settings last: the environment, tasks.env, .taskrc, then the plugin (CLI-8)', () => {
    const plugin = {
      CLAUDE_PLUGIN_OPTION_BOARD_URL: 'https://p.example/',
      CLAUDE_PLUGIN_OPTION_TOKEN: 'plugin-token',
      CLAUDE_PLUGIN_OPTION_AGENT_NAME: 'claude-plugin',
    };
    const taskrc = 'sync.server.url=https://b.example\n';
    const file = { BREAKAWAY_URL: 'https://s.example', BREAKAWAY_TOKEN: 'file-token', BREAKAWAY_AGENT: 'claude-file' };
    const env = { ...plugin, BREAKAWAY_URL: 'https://a.example', BREAKAWAY_TOKEN: 'env-token', BREAKAWAY_AGENT: 'e' };

    expect(boardUrl({ env, file, taskrc }).from).toBe('environment');
    expect(boardUrl({ env: plugin, file, taskrc }).from).toBe('tasks.env');
    expect(boardUrl({ env: plugin, taskrc }).from).toBe('.taskrc');
    expect(boardUrl({ env: plugin, config: { url: 'https://c.example' } }).from).toBe('config');
    expect(boardUrl({ env: plugin })).toEqual({ url: 'https://p.example', from: 'plugin' });

    expect(settingFrom('TOKEN', { env, file })).toEqual({ value: 'env-token', from: 'environment' });
    expect(settingFrom('TOKEN', { env: plugin, file })).toEqual({ value: 'file-token', from: 'tasks.env' });
    expect(settingFrom('TOKEN', { env: plugin })).toEqual({ value: 'plugin-token', from: 'plugin' });
    expect(settingFrom('AGENT', { env: plugin, file: {} })).toEqual({ value: 'claude-plugin', from: 'plugin' });
    expect(settingFrom('AGENT', { env: { ...plugin, CLAUDE_PLUGIN_OPTION_AGENT_NAME: '' } })).toEqual({
      value: undefined,
      from: null,
    });
    // Only the three the plugin asks for: the rest stay the CLI's own.
    expect(settingFrom('REPO', { env: { CLAUDE_PLUGIN_OPTION_REPO: 'x' } }).from).toBe(null);
    // readSetting is the CLI's own settings only.
    expect(readSetting('TOKEN', { env: plugin, file: {} })).toBe(undefined);
    expect(() => settingFrom('NOPE', {})).toThrow();
  });

  it('parses an env file', () => {
    expect(parseEnvFile('# c\nBREAKAWAY_TOKEN=abc\nBREAKAWAY_URL="https://x"\n  \nlower=no\n')).toEqual({
      BREAKAWAY_TOKEN: 'abc',
      BREAKAWAY_URL: 'https://x',
    });
  });
});

describe('taskrcFixes (CLD-136)', () => {
  const where = {
    url: 'https://b.example',
    include: '~/.config/breakaway/taskrc',
    file: '/h/.config/breakaway/taskrc',
  };
  it('says nothing when .taskrc syncs with the CLI’s board and includes this machine’s credentials', () => {
    expect(taskrcFixes('sync.server.url=https://b.example/\ninclude ~/.config/breakaway/taskrc\n', where)).toEqual([]);
    expect(taskrcFixes('sync.server.url=https://b.example\ninclude /h/.config/breakaway/taskrc', where)).toEqual([]);
  });
  it('names each line to change', () => {
    const fixes = taskrcFixes('sync.server.url=https://old.example\ninclude ~/.config/elsewhere/taskrc\n', where);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toContain('sync.server.url=https://b.example');
    expect(fixes[1]).toContain('include ~/.config/breakaway/taskrc');
    expect(taskrcFixes(null, where)).toHaveLength(1);
  });
});

describe('a lent run’s key (BRK-324)', () => {
  const key = `bkr_${'9e'.repeat(32)}`;

  it('goes in its own header beside any token, since a cloud session’s proxy replaces Authorization', () => {
    expect(RUN_KEY_HEADER).toBe('X-Breakaway-Run-Key');
    expect(authHeaders('tok', key)).toEqual({ Authorization: 'Bearer tok', [RUN_KEY_HEADER]: key });
    expect(authHeaders(undefined, key)).toEqual({ [RUN_KEY_HEADER]: key });
    expect(authHeaders('tok')).toEqual({ Authorization: 'Bearer tok' });
    expect(authHeaders(null, '  ')).toEqual({});
  });

  it('is a setting like the token: the environment, then tasks.env, where run-key saves it for the hooks', () => {
    expect(settingFrom('RUN_KEY', { env: { BREAKAWAY_RUN_KEY: key } })).toEqual({ value: key, from: 'environment' });
    expect(settingFrom('RUN_KEY', { file: { BREAKAWAY_RUN_KEY: key } })).toEqual({ value: key, from: 'tasks.env' });
    expect(RUN_KEY.test(key)).toBe(true);
    expect(RUN_KEY.test(`act_${'9e'.repeat(32)}`)).toBe(false);
  });
});
