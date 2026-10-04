import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimedTask, dropClaim } from './hook-config.js';

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
