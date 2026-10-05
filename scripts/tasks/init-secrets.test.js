import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const OLD = 'BREAKAWAY_TOKEN=old-token-for-the-test\nBREAKAWAY_SECRET=the-only-copy\n';

/** Runs the CLI with its config folder in `home`, and nothing from this machine's own. */
function run(home, ...argv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BREAKAWAY_')));
  return spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    env: { ...env, BREAKAWAY_HOME: home, HOME: home },
  });
}

describe('init-secrets never loses the sync secret (CLI-2)', () => {
  /** @type {string} */
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'breakaway-init-secrets-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('refuses when tasks.env exists, and leaves it as it was', () => {
    writeFileSync(join(home, 'tasks.env'), OLD);
    const result = run(home, 'init-secrets');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
    expect(readFileSync(join(home, 'tasks.env'), 'utf8')).toBe(OLD);
    expect(readdirSync(home)).toEqual(['tasks.env']);
  });

  it('with --force, keeps the old file as tasks.env.<time>.bak before writing the new one', () => {
    writeFileSync(join(home, 'tasks.env'), OLD);
    const result = run(home, 'init-secrets', '--force');
    expect(result.status, result.stderr).toBe(0);
    const backups = readdirSync(home).filter((f) => /^tasks\.env\..+\.bak$/u.test(f));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, backups[0]), 'utf8')).toBe(OLD);
    expect(statSync(join(home, backups[0])).mode & 0o777).toBe(0o600);
    const fresh = readFileSync(join(home, 'tasks.env'), 'utf8');
    expect(fresh).not.toContain('the-only-copy');
    expect(fresh).toMatch(/^BREAKAWAY_SECRET=/mu);
    expect(statSync(join(home, 'tasks.env')).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(`Kept the old one as ${join(home, backups[0])}`);
  });

  it('writes no backup on a first run', () => {
    const result = run(home, 'init-secrets');
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(home)).toEqual(['tasks.env']);
    expect(result.stdout).not.toContain('Kept the old one');
  });
});
