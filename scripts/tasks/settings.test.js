import { describe, expect, it } from 'vitest';
import { boardUrl, configDir, parseEnvFile, readSetting, taskrcFixes, taskrcUrl, tildePath } from './settings.js';

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
      from: 'setting',
    });
    expect(boardUrl({ file: { BREAKAWAY_URL: 'https://s.example' }, taskrc }).url).toBe('https://s.example');
    expect(boardUrl({ taskrc, config: { url: 'https://c.example' } })).toEqual({
      url: 'https://b.example',
      from: '.taskrc',
    });
    expect(boardUrl({ config: { url: 'https://c.example' } })).toEqual({ url: 'https://c.example', from: 'config' });
    expect(boardUrl({})).toEqual({ url: null, from: 'default' });
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
