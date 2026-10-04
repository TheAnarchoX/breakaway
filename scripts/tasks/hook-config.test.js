import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimedTask, dropClaim, projectRoot } from './hook-config.js';

describe('dropClaim', () => {
  it('clears the marker so the next hook call posts nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-'));
    try {
      writeFileSync(join(root, '.task-session'), JSON.stringify({ uuid: 'u1', wid: 'BRK-79', agent: 'a' }));
      expect(claimedTask(root)?.uuid).toBe('u1');
      dropClaim({ uuid: 'u1' }, root);
      expect(existsSync(join(root, '.task-session'))).toBe(false);
      expect(claimedTask(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a marker for a different task alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-'));
    try {
      writeFileSync(join(root, '.task-session'), JSON.stringify({ uuid: 'u2', agent: 'a' }));
      dropClaim({ uuid: 'u1' }, root);
      expect(existsSync(join(root, '.task-session'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// BRK-88: a cloud session can run hooks with CLAUDE_PROJECT_DIR empty. The hooks then find the checkout by its git root,
// where `tasks claim` writes .task-session, rather than the folder they happen to run in.
describe('the hooks’ project root (BRK-88)', () => {
  it('is CLAUDE_PROJECT_DIR when Claude Code gives it', () => {
    expect(projectRoot({ CLAUDE_PROJECT_DIR: '/work/repo' }, () => '/elsewhere', '/work/repo/web')).toBe('/work/repo');
  });

  it('is the git root without it, not the folder the hook runs in', () => {
    expect(projectRoot({}, () => '/work/repo', '/work/repo/web/src')).toBe('/work/repo');
    expect(projectRoot({ CLAUDE_PROJECT_DIR: '' }, () => '/work/repo', '/work/repo/web/src')).toBe('/work/repo');
  });

  it('is the current folder outside a repository', () => {
    expect(projectRoot({}, () => null, '/tmp/somewhere')).toBe('/tmp/somewhere');
  });
});
