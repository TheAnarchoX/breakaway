import { describe, expect, it } from 'vitest';
import SITE from '../.github/workflows/site.yml?raw';
import RELEASE from '../.github/workflows/release.yml?raw';
import CI from '../.github/workflows/ci.yml?raw';
import WRANGLER from '../site/wrangler.jsonc?raw';
import TEMPLATE_DEPLOY from '../template/.github/workflows/deploy.yml?raw';
import { parseJsonc } from '../src/install.js';

// The site deploys from this repository (LCH-15): Cloudflare's Workers Builds deploys the site branch, and the Site
// workflow moves that branch, with a deploy key only main can use, to a commit that's already on main. No Cloudflare
// credentials live in this repository.

const uses = (text) => [...text.matchAll(/uses: (\S+)/gu)].map((m) => m[1]);
const secrets = (text) => new Set([...text.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]));

describe('the site’s deploy', () => {
  it('moves the site branch when the stable release calls it, or by hand', () => {
    expect(SITE).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+ref:/u);
    expect(SITE).toMatch(/workflow_call:\n\s+inputs:\n\s+ref:/u);
    expect(SITE).not.toMatch(/^\s+(push|schedule|pull_request):/mu);
    expect(RELEASE).toMatch(
      / {2}site:\n[\s\S]*?needs: stable\n[\s\S]*?uses: \.\/\.github\/workflows\/site\.yml\n\s+with:\n\s+ref: v\$\{\{ needs\.stable\.outputs\.version \}\}/u,
    );
  });

  it('puts only a commit that’s on main on the site', () => {
    expect(SITE).toContain("if: github.ref == 'refs/heads/main'");
    expect(SITE).toContain('git merge-base --is-ancestor "$commit" origin/main');
    expect(SITE).toContain('git push --force "git@github.com:$GITHUB_REPOSITORY.git" "$commit:refs/heads/site"');
  });

  it('pushes with the site environment’s deploy key, to GitHub’s own host key, and nothing else', () => {
    expect(SITE).toMatch(/^ {4}environment: site$/mu);
    expect([...secrets(SITE)]).toEqual(['SITE_DEPLOY_KEY']);
    expect(SITE).toContain('StrictHostKeyChecking=yes');
    expect(SITE).toContain(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    );
  });

  it('keeps Cloudflare credentials out of this repository', () => {
    for (const [name, text] of Object.entries({ SITE, RELEASE, CI }))
      for (const secret of secrets(text)) expect(secret, name).not.toMatch(/CLOUDFLARE/u);
  });

  it('pins its actions to the same versions as the template’s Deploy', () => {
    const pinned = new Set(uses(TEMPLATE_DEPLOY));
    expect(uses(SITE).length).toBeGreaterThan(0);
    for (const action of uses(SITE)) expect(pinned, action).toContain(action);
  });

  it('answers only on its own domain: no workers.dev, no preview URLs', () => {
    const config = parseJsonc(WRANGLER);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([{ pattern: 'leavethepack.dev', custom_domain: true }]);
  });
});
