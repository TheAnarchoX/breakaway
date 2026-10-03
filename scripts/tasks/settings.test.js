import { describe, expect, it } from 'vitest';
import {
  boardUrl,
  configDir,
  nameFor,
  parseEnvFile,
  readSetting,
  taskrcFixes,
  taskrcUrl,
  tildePath,
  usesLegacyNames,
} from './settings.js';

describe('settings (CLD-136)', () => {
  it('reads the breakaway name first and the first install’s as the fallback, the environment before the file', () => {
    expect(readSetting('TOKEN', { env: { BREAKAWAY_TOKEN: 'a', SAMEWAVE_TASKS_TOKEN: 'b' } })).toBe('a');
    expect(readSetting('TOKEN', { env: { SAMEWAVE_TASKS_TOKEN: 'b' } })).toBe('b');
    expect(readSetting('TOKEN', { env: { SAMEWAVE_TASKS_TOKEN: 'env' }, file: { BREAKAWAY_TOKEN: 'file' } })).toBe(
      'env',
    );
    expect(readSetting('AGENT', { file: { SAMEWAVE_AGENT: 'claude-x' } })).toBe('claude-x');
    expect(readSetting('REPO', { env: {}, file: {} }, 'fallback')).toBe('fallback');
    expect(readSetting('URL', { env: { BREAKAWAY_URL: '' }, file: { SAMEWAVE_TASKS_URL: 'u' } })).toBe('u');
    expect(() => readSetting('NOPE', {})).toThrow();
  });

  it('writes an env file back with the names it already uses', () => {
    expect(usesLegacyNames({ SAMEWAVE_TASKS_TOKEN: 't' })).toBe(true);
    expect(usesLegacyNames({ BREAKAWAY_TOKEN: 't' })).toBe(false);
    expect(usesLegacyNames({})).toBe(false);
    expect(nameFor('CLIENT_ID', true)).toBe('SAMEWAVE_TASKS_CLIENT_ID');
    expect(nameFor('CLIENT_ID', false)).toBe('BREAKAWAY_CLIENT_ID');
  });

  it('keeps machines set up before breakaway in ~/.config/samewave and puts new ones in ~/.config/breakaway', () => {
    const has =
      (...dirs) =>
      (path) =>
        dirs.includes(path);
    expect(configDir({ home: '/h', exists: has('/h/.config/samewave') })).toBe('/h/.config/samewave');
    expect(configDir({ home: '/h', exists: has() })).toBe('/h/.config/breakaway');
    expect(configDir({ home: '/h', exists: has('/h/.config/samewave', '/h/.config/breakaway') })).toBe(
      '/h/.config/breakaway',
    );
    expect(configDir({ env: { BREAKAWAY_HOME: '/x/board/' }, home: '/h', exists: has('/h/.config/samewave') })).toBe(
      '/x/board',
    );
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
    expect(boardUrl({ file: { SAMEWAVE_TASKS_URL: 'https://s.example' }, taskrc }).url).toBe('https://s.example');
    expect(boardUrl({ taskrc, config: { url: 'https://c.example' } })).toEqual({
      url: 'https://b.example',
      from: '.taskrc',
    });
    expect(boardUrl({ config: { url: 'https://c.example' } })).toEqual({ url: 'https://c.example', from: 'config' });
    expect(boardUrl({})).toEqual({ url: null, from: 'default' });
  });

  it('parses an env file', () => {
    expect(parseEnvFile('# c\nBREAKAWAY_TOKEN=abc\nSAMEWAVE_TASKS_URL="https://x"\n  \nlower=no\n')).toEqual({
      BREAKAWAY_TOKEN: 'abc',
      SAMEWAVE_TASKS_URL: 'https://x',
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
