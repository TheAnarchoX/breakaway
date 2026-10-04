import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFeed, newestFirst } from '../site/src/feed.js';
import worker from '../site/src/worker.js';

const DL = 'https://github.com/acme/widgets/releases/download';
const release = (tag, { prerelease = false, draft = false, assets = true, signed = true } = {}) => ({
  tag_name: tag,
  prerelease,
  draft,
  html_url: `https://github.com/acme/widgets/releases/tag/${tag}`,
  published_at: '2026-10-03T09:00:00Z',
  assets: assets
    ? ['breakaway-bundle.tar.gz', 'manifest.json', 'SHA256SUMS', ...(signed ? ['manifest.json.sig'] : [])].map(
        (name) => ({
          name,
          browser_download_url: `${DL}/${tag}/${name}`,
        }),
      )
    : [],
});
const manifest = (version, extra = {}) => ({
  version,
  channel: 'main',
  commit: 'abc',
  manual: false,
  updatesFrom: '0.1.0',
  ...extra,
});
const FIXTURE = [
  release('v0.2.1-main.2', { prerelease: true }),
  release('v0.2.1-main.10', { prerelease: true }),
  release('v0.2.0-main.9', { prerelease: true }),
  release('v0.2.0'),
  release('v0.1.0', { signed: false }),
  release('v0.3.0', { draft: true }),
  release('v0.2.2-main.1', { prerelease: true, draft: true }),
];
const manifests = {
  [`${DL}/v0.2.1-main.10/manifest.json`]: manifest('0.2.1-main.10', {
    manual: true,
    manualSteps: ['Add the new binding.'],
    updatesFrom: '0.2.0',
  }),
  [`${DL}/v0.2.0/manifest.json`]: manifest('0.2.0', { channel: 'stable' }),
};
const fetchJson = async (url) => {
  if (!(url in manifests)) throw new Error('nope');
  return manifests[url];
};

describe('the update feed', () => {
  it('orders by version and pre-release number, skips drafts, never by date', () => {
    expect(newestFirst(FIXTURE, 'main').map((r) => r.tag_name)).toEqual([
      'v0.2.1-main.10',
      'v0.2.1-main.2',
      'v0.2.0-main.9',
    ]);
    expect(newestFirst(FIXTURE, 'stable').map((r) => r.tag_name)).toEqual(['v0.2.0', 'v0.1.0']);
  });

  it('answers both channels with urls, manual steps, and the lowest version it updates from', async () => {
    const { channels } = await buildFeed(FIXTURE, fetchJson);
    expect(channels.stable).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      bundle: `${DL}/v0.2.0/breakaway-bundle.tar.gz`,
      manifest: `${DL}/v0.2.0/manifest.json`,
      checksums: `${DL}/v0.2.0/SHA256SUMS`,
      signature: `${DL}/v0.2.0/manifest.json.sig`,
      notes: 'https://github.com/acme/widgets/releases/tag/v0.2.0',
      manual: false,
      updatesFrom: '0.1.0',
    });
    expect(channels.stable).not.toHaveProperty('manualSteps');
    expect(channels.main).toMatchObject({
      version: '0.2.1-main.10',
      manual: true,
      manualSteps: ['Add the new binding.'],
      updatesFrom: '0.2.0',
    });
  });

  it('gives null for a release from before signing', async () => {
    const releases = [release('v0.1.0', { signed: false })];
    const m = { [`${DL}/v0.1.0/manifest.json`]: manifest('0.1.0', { channel: 'stable' }) };
    const { channels } = await buildFeed(releases, async (u) => m[u]);
    expect(channels.stable.signature).toBeNull();
  });

  it('falls back to the next release when the newest has no readable manifest, and to null when none do', async () => {
    const releases = [
      release('v0.2.1-main.3', { prerelease: true, assets: false }),
      release('v0.2.1-main.2', { prerelease: true }),
    ];
    const m = { [`${DL}/v0.2.1-main.2/manifest.json`]: manifest('0.2.1-main.2') };
    expect((await buildFeed(releases, async (u) => m[u] ?? Promise.reject(new Error('x')))).channels.main.version).toBe(
      '0.2.1-main.2',
    );
    expect(await buildFeed(releases, async () => ({ version: 'wrong' }))).toEqual({
      channels: { stable: null, main: null },
    });
    expect(await buildFeed([], fetchJson)).toEqual({ channels: { stable: null, main: null } });
  });
});

describe('the feed worker', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ctx = { waitUntil: () => {} };
  const env = { RELEASES_REPO: 'acme/widgets', GITHUB_API: 'https://api.test' };
  const stubGitHub = (ok = true) => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push({ url: String(url), init });
      if (!ok) return new Response('rate limited', { status: 403 });
      if (String(url) === 'https://api.test/repos/acme/widgets/releases?per_page=100') return Response.json(FIXTURE);
      return String(url) in manifests
        ? Response.json(manifests[String(url)])
        : new Response('missing', { status: 404 });
    });
    return seen;
  };

  it('serves /releases.json with open CORS, a short cache, and no cookies', async () => {
    const seen = stubGitHub();
    const response = await worker.fetch(
      new Request('https://breakaway.test/releases.json', {
        headers: { cookie: 'a=b', authorization: 'Bearer secret' },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    expect(response.headers.has('set-cookie')).toBe(false);
    const body = await response.json();
    expect(body.repository).toBe('acme/widgets');
    expect(body.channels.main.version).toBe('0.2.1-main.10');
    // Nothing about the asker goes upstream.
    for (const { init } of seen) expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/secret|cookie/iu);
  });

  it('answers preflight, refuses other methods and paths', async () => {
    stubGitHub();
    expect(
      (await worker.fetch(new Request('https://breakaway.test/releases.json', { method: 'OPTIONS' }), env, ctx)).status,
    ).toBe(204);
    expect(
      (await worker.fetch(new Request('https://breakaway.test/releases.json', { method: 'POST' }), env, ctx)).status,
    ).toBe(405);
    const missing = await worker.fetch(new Request('https://breakaway.test/nope'), env, ctx);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/\/releases\.json/u);
  });

  it('says what failed and when to retry when GitHub cannot be read', async () => {
    stubGitHub(false);
    const response = await worker.fetch(new Request('https://down.breakaway.test/releases.json'), env, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('120');
    expect((await response.json()).error).toMatch(/Try again/u);
  });
});
