import { describe, expect, it } from 'vitest';
import { sessionDir } from './session-dir.js';

// CLI-20: the plugin's headersHelper runs in the plugin's folder and can't cd, so `mcp --headers` finds the checkout.
const PLUGIN = '/home/me/.claude/plugins/cache/breakaway/breakaway/1.6.0';
/** A process tree: Claude Code (40) in the checkout, a shell (41) and npx (42) in the plugin's folder, the CLI (43). */
const TREE = {
  43: { parent: 42, cwd: PLUGIN },
  42: { parent: 41, cwd: PLUGIN },
  41: { parent: 40, cwd: PLUGIN },
  40: { parent: 1, cwd: '/work/widgets' },
};
const lookups = (tree) => ({
  parentOf: (pid) => tree[pid]?.parent ?? null,
  cwdOf: (pid) => tree[pid]?.cwd ?? null,
});

describe('sessionDir: where mcp --headers works (CLI-20)', () => {
  it('is CLAUDE_PROJECT_DIR when the environment has it', () => {
    const env = { CLAUDE_PROJECT_DIR: '/work/widgets', CLAUDE_PLUGIN_ROOT: PLUGIN };
    expect(sessionDir({ env, cwd: PLUGIN, pid: 43, ...lookups({}) })).toBe('/work/widgets');
  });

  it('is Claude Code’s folder when the helper runs in the plugin’s', () => {
    expect(sessionDir({ env: { CLAUDE_PLUGIN_ROOT: PLUGIN }, cwd: PLUGIN, pid: 43, ...lookups(TREE) })).toBe(
      '/work/widgets',
    );
  });

  it('stays put outside the plugin’s folder: run by hand, it works where it runs', () => {
    expect(sessionDir({ env: {}, cwd: '/work/gadgets', pid: 43, ...lookups(TREE) })).toBeNull();
    expect(
      sessionDir({ env: { CLAUDE_PLUGIN_ROOT: PLUGIN }, cwd: '/work/gadgets', pid: 43, ...lookups(TREE) }),
    ).toBeNull();
  });

  it('stays put when it can’t read the processes above it, or none works elsewhere', () => {
    const env = { CLAUDE_PLUGIN_ROOT: PLUGIN };
    expect(sessionDir({ env, cwd: PLUGIN, pid: 43, ...lookups({}) })).toBeNull();
    const all = { 43: { parent: 42, cwd: PLUGIN }, 42: { parent: 1, cwd: PLUGIN } };
    expect(sessionDir({ env, cwd: PLUGIN, pid: 43, ...lookups(all) })).toBeNull();
    const loop = { 43: { parent: 43, cwd: PLUGIN } };
    expect(sessionDir({ env, cwd: PLUGIN, pid: 43, ...lookups(loop) })).toBeNull();
  });
});
