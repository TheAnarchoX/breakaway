import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// BRK-74: npm says why its trusted publishing didn't apply only in its verbose log, and the release's Actions logs are
// public. Both jobs that publish keep that log to the runner and show only npm's usual lines and its oidc lines.
const WORKFLOW = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const publishes = WORKFLOW.split('\n').filter((line) => /^\s+if npm publish\b/u.test(line));

describe('the release’s npm publish (BRK-74)', () => {
  it('runs in both jobs, with its verbose log kept to a file', () => {
    expect(publishes).toHaveLength(2);
    for (const line of publishes) expect(line).toMatch(/--loglevel verbose > "\$RUNNER_TEMP\/npm\.log" 2>&1/u);
    expect(publishes.join('\n')).toMatch(/--tag next/u);
    expect(publishes.join('\n')).toMatch(/--tag latest/u);
  });

  it('on a failure, shows the oidc lines and the fields to check, and never the whole log', () => {
    expect(WORKFLOW.match(/grep -i 'oidc' "\$RUNNER_TEMP\/npm\.log" \| grep -v 'eyJ'/gu)).toHaveLength(2);
    expect(WORKFLOW.match(/::error title=npm refused the publish::/gu)).toHaveLength(2);
    expect(WORKFLOW).not.toMatch(/cat "\$RUNNER_TEMP\/npm\.log"/u);
    expect(WORKFLOW).not.toMatch(/--loglevel (silly|sill)/u);
  });
});
