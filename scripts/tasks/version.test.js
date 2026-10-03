import { describe, expect, it } from 'vitest';
import { copiedSources, fingerprint } from './init.js';
import { CLI_FINGERPRINT, CLI_VERSION } from '../../src/cli-version.js';

// The files repos init copies, keyed by their path from the repository's root (as init.test.js reads them).
const RAW = import.meta.glob(
  [
    '../tasks.mjs',
    '../*.mjs',
    '../lib/*.js',
    '../install/*.js',
    '../task',
    './*.js',
    './*.mjs',
    '../../src/*.js',
    '../../prompts/*.md',
    '../../taskrc',
    '../../.agents/skills/tasks/SKILL.md',
  ],
  { query: '?raw', import: 'default', eager: true },
);
const FILES = new Map(
  Object.entries(RAW).map(([key, text]) => [
    key
      .replace(/^\.\.\/\.\.\//u, '')
      .replace(/^\.\.\//u, 'scripts/')
      .replace(/^\.\//u, 'scripts/tasks/'),
    text,
  ]),
);
const read = (path) => {
  if (!FILES.has(path)) throw new Error(`no ${path} in the fixture`);
  return FILES.get(path);
};

describe('the CLI version (CLD-193)', () => {
  it('changes whenever a file repos init copies does', async () => {
    const now = await fingerprint(copiedSources(read), read);
    expect(
      CLI_FINGERPRINT,
      `The files repos init copies changed, so copies in other repositories are now older. In src/cli-version.js, set CLI_VERSION to ${CLI_VERSION + 1} and CLI_FINGERPRINT to '${now}'.`,
    ).toBe(now);
    expect(Number.isInteger(CLI_VERSION) && CLI_VERSION > 0).toBe(true);
  });
});
