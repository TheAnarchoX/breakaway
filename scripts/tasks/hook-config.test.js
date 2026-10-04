import { describe, expect, it } from 'vitest';
import { projectRoot } from './hook-config.js';

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
