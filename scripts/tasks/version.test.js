import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../../src/cli-version.js';

describe('the CLI number (CLD-193, BRK-148)', () => {
  it('is frozen: the release version replaced it, so a pull request that changes a copied file bumps nothing', () => {
    expect(
      CLI_VERSION,
      'CLI_VERSION is frozen (BRK-148): old copies of the CLI read it, and nothing else moves it. Leave it at 73.',
    ).toBe(73);
  });
});
