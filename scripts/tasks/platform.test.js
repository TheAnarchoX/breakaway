import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsupportedSystem, WSL_URL, wranglerFailure } from './platform.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));

describe('unsupportedSystem (CLI-3)', () => {
  it('lets macOS and Linux (WSL is linux) through', () => {
    expect(unsupportedSystem('setup', 'darwin')).toBeNull();
    expect(unsupportedSystem('setup', 'linux')).toBeNull();
  });

  it('stops Windows itself with WSL named, the command, and nothing changed', () => {
    const message = unsupportedSystem('github-connect', 'win32');
    expect(message).toContain('npx breakaway github-connect');
    expect(message).toContain('WSL');
    expect(message).toContain(WSL_URL);
    expect(message).toContain('nothing was changed');
  });
});

describe('wranglerFailure (CLI-3)', () => {
  it('says npx is missing when the spawn itself fails', () => {
    const res = spawnSync('breakaway-no-such-command-for-the-test', ['wrangler'], { encoding: 'utf8' });
    expect(res.error).toBeDefined();
    const reason = wranglerFailure(res);
    expect(reason).toContain("npx isn't on this machine's PATH");
    expect(reason).not.toContain('logged in');
  });

  it('says why any other spawn error happened', () => {
    const error = Object.assign(new Error('spawnSync npx EACCES'), { code: 'EACCES' });
    expect(wranglerFailure({ error, status: null })).toBe("npx couldn't run (spawnSync npx EACCES)");
  });

  it("reports wrangler's own [ERROR] line, without its colours or box", () => {
    const stderr = [
      '\u001b[33m▲ [WARNING]\u001b[0m something minor',
      '',
      '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m You are not authenticated. Please run `wrangler login`.',
      '',
    ].join('\n');
    expect(wranglerFailure({ status: 1, stdout: '\n ⛅️ wrangler 4.40.0\n───────────\n', stderr })).toBe(
      'wrangler said: You are not authenticated. Please run `wrangler login`.',
    );
  });

  it("falls back to wrangler's last line, past its banner and npm's warnings", () => {
    expect(
      wranglerFailure({
        status: 1,
        stdout: ' ⛅️ wrangler 4.40.0\n',
        stderr: 'Could not resolve the store abc123\nnpm warn exec The following package was not found\n',
      }),
    ).toBe('wrangler said: Could not resolve the store abc123');
  });

  it('says the exit code or signal when wrangler printed nothing', () => {
    expect(wranglerFailure({ status: 7, stdout: '', stderr: '' })).toBe('wrangler stopped with exit code 7');
    expect(wranglerFailure({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })).toBe(
      'wrangler stopped (SIGTERM)',
    );
  });
});

describe('the secret-writing commands and setup on Windows itself (CLI-3)', () => {
  /** @type {string} */
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'breakaway-platform-'));
    // Pretends to be Windows before the CLI loads.
    writeFileSync(join(home, 'win32.mjs'), "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    writeFileSync(
      join(home, 'tasks.env'),
      'BREAKAWAY_TOKEN=fake-token-for-the-test\nBREAKAWAY_CLIENT_ID=00000000-0000-0000-0000-000000000000\nBREAKAWAY_SECRET=fake\n',
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** Runs the CLI as if on Windows, against a board address nothing listens on. */
  function run(...argv) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BREAKAWAY_')));
    return spawnSync(process.execPath, ['--import', join(home, 'win32.mjs'), CLI, ...argv], {
      encoding: 'utf8',
      env: { ...env, BREAKAWAY_HOME: home, HOME: home, BREAKAWAY_URL: 'http://127.0.0.1:9' },
    });
  }

  it.each([['setup'], ['rotate-sync'], ['rotate-token'], ['agents-connect'], ['github-connect', 'a-code']])(
    '%s stops before doing anything, naming WSL',
    (...argv) => {
      const before = readdirSync(home).sort();
      const result = run(...argv);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`npx breakaway ${argv[0]} doesn't run on Windows itself`);
      expect(result.stderr).toContain(WSL_URL);
      // It never reached the board (nothing listens there) and wrote nothing.
      expect(result.stderr).not.toContain("can't reach");
      expect(readdirSync(home).sort()).toEqual(before);
      expect(existsSync(join(home, 'taskrc'))).toBe(false);
    },
  );
});
