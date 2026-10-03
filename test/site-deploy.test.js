import { describe, expect, it } from 'vitest';
import WORKFLOW from '../site/deploy.yml?raw';
import WRANGLER from '../site/wrangler.jsonc?raw';
import TEMPLATE_DEPLOY from '../template/.github/workflows/deploy.yml?raw';
import { parseJsonc } from '../src/install.js';

// The site deploys itself (LCH-8): the workflow an install repository copies in to keep breakaway's site on its latest
// stable release. It never runs in this repository, which holds no Cloudflare credentials.

const uses = (text) => [...text.matchAll(/uses: (\S+)/gu)].map((m) => m[1]);

describe('the site’s deploy workflow', () => {
  it('looks for a stable release every hour, and runs by hand with a tag or branch', () => {
    expect(WORKFLOW).toMatch(/schedule:\n\s+- cron: '\d+ \* \* \* \*'/u);
    expect(WORKFLOW).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+ref:/u);
    expect(WORKFLOW).not.toMatch(/^\s+push:/mu);
    expect(WORKFLOW).toContain('repos/$BREAKAWAY_REPO/releases/latest');
  });

  it('reads only, with the board’s Deploy secrets and nothing else', () => {
    expect(WORKFLOW).toMatch(/^permissions:\n\s+contents: read\n\n/mu);
    expect(WORKFLOW).toContain('environment: production');
    const secrets = new Set([...WORKFLOW.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]));
    expect([...secrets].sort()).toEqual(['BREAKAWAY_READ_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  });

  it('deploys the site on its custom domain, says what it deployed, and checks it', () => {
    expect(WORKFLOW).toContain('npx --yes wrangler@4 deploy -c site/wrangler.jsonc --domain "$SITE_HOST"');
    expect(WORKFLOW).toContain('> site/public/deployed.txt');
    expect(WORKFLOW).toContain('"https://$SITE_HOST/deployed.txt"');
    expect(WORKFLOW).toContain('"https://$SITE_HOST/releases.json"');
  });

  it('pins its actions to the same versions as the template’s Deploy', () => {
    const pinned = new Set(uses(TEMPLATE_DEPLOY));
    expect(uses(WORKFLOW).length).toBeGreaterThan(0);
    for (const action of uses(WORKFLOW)) expect(pinned, action).toContain(action);
  });

  it('keeps the site off workers.dev and preview URLs, so it answers only on its own domain', () => {
    const config = parseJsonc(WRANGLER);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});
