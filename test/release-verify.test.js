import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRelease } from '../src/release-verify.js';
import { latestIn } from '../src/updates.js';

// BRK-52: an install checks a release from the feed (signature, checksums, updatesFrom) before it may use it.
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const hex = async (text) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const BUNDLE = 'pretend tarball';
const URLS = {
  bundle: 'https://dl.test/v/breakaway-bundle.tar.gz',
  manifest: 'https://dl.test/v/manifest.json',
  checksums: 'https://dl.test/v/SHA256SUMS',
  signature: 'https://dl.test/v/manifest.json.sig',
};

/** A signed release, as the Release workflow makes one, with `change` applied to what's served. */
async function release({ version = '0.2.0-main.5', manifest = {}, change = {}, running = '0.2.0-main.3' } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const text = `${JSON.stringify({ version, manual: false, updatesFrom: '0.1.0-main.1', bundleSha256: await hex(BUNDLE), ...manifest })}\n`;
  const sign = async (t) =>
    b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(t)));
  const files = {
    bundle: BUNDLE,
    manifest: text,
    checksums: `${await hex(BUNDLE)}  breakaway-bundle.tar.gz\n${await hex(text)}  manifest.json\n`,
    signature: await sign(text),
    ...change,
  };
  const served = new Map(Object.entries(URLS).map(([k, url]) => [url, files[k]]));
  const fetchImpl = vi.fn(async (url) =>
    served.has(url) ? new Response(served.get(url)) : new Response('gone', { status: 404 }),
  );
  return { entry: { version, ...URLS }, options: { running, publicKey, fetchImpl }, sign, text };
}

describe('verifying a release from the feed', () => {
  it('accepts a good release and hands back its manifest and bundle', async () => {
    const r = await release();
    const verdict = await verifyRelease(r.entry, r.options);
    expect(verdict).toMatchObject({ ok: true, manifest: { version: '0.2.0-main.5' } });
    expect(new TextDecoder().decode(verdict.bundle)).toBe(BUNDLE);
  });

  it('refuses a bad signature: a manifest changed after signing, and one signed by another key', async () => {
    const changed = await release();
    changed.options.fetchImpl.mockImplementation(async (url) =>
      url === URLS.manifest ? new Response(changed.text.replace('0.1.0-main.1', '0.0.1')) : new Response('x'),
    );
    expect(await verifyRelease(changed.entry, changed.options)).toMatchObject({ ok: false, step: 'signature' });
    const other = await release();
    const r = await release({ change: { signature: await other.sign(other.text) } });
    expect(await verifyRelease(r.entry, r.options)).toMatchObject({ ok: false, step: 'signature' });
  });

  it('refuses a release from before signing, naming the one manual update', async () => {
    const r = await release();
    const verdict = await verifyRelease({ ...r.entry, signature: null }, r.options);
    expect(verdict).toMatchObject({ ok: false, step: 'signature' });
    expect(verdict.message).toContain('Update by hand once');
    expect(r.options.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a bundle that is not the one the signed manifest names, even if SHA256SUMS agrees with it', async () => {
    const r = await release({ change: { bundle: 'swapped tarball' } });
    expect(await verifyRelease(r.entry, r.options)).toMatchObject({ ok: false, step: 'checksum' });
    const swapped = await release({
      change: { bundle: 'swapped tarball', checksums: `${await hex('swapped tarball')}  breakaway-bundle.tar.gz\n` },
    });
    expect(await verifyRelease(swapped.entry, swapped.options)).toMatchObject({ ok: false, step: 'checksum' });
  });

  it('refuses when SHA256SUMS disagrees, or a signed manifest names no bundle checksum', async () => {
    const r = await release({ change: { checksums: `${'0'.repeat(64)}  breakaway-bundle.tar.gz\n` } });
    expect(await verifyRelease(r.entry, r.options)).toMatchObject({ ok: false, step: 'checksum' });
    const old = await release({ manifest: { bundleSha256: undefined } });
    expect(await verifyRelease(old.entry, old.options)).toMatchObject({ ok: false, step: 'signature' });
  });

  it('refuses when the running version is below updatesFrom, or is not a release', async () => {
    const r = await release({ manifest: { updatesFrom: '0.2.0-main.4' } });
    const verdict = await verifyRelease(r.entry, r.options);
    expect(verdict).toMatchObject({ ok: false, step: 'release' });
    expect(verdict.message).toContain('too old');
    expect(await verifyRelease(r.entry, { ...r.options, running: 'dev' })).toMatchObject({
      ok: false,
      step: 'release',
    });
    const ok = await release({ manifest: { updatesFrom: '0.2.0-main.3' } });
    expect((await verifyRelease(ok.entry, ok.options)).ok).toBe(true);
  });

  it('refuses a manual release with its steps, and a manifest for another version', async () => {
    const manual = await release({ manifest: { manual: true, manualSteps: ['Add the cron trigger.'] } });
    const verdict = await verifyRelease(manual.entry, manual.options);
    expect(verdict).toMatchObject({ ok: false, step: 'release' });
    expect(verdict.message).toContain('Add the cron trigger.');
    const wrong = await release({ manifest: { version: '0.2.0-main.4' } });
    expect(await verifyRelease(wrong.entry, wrong.options)).toMatchObject({ ok: false, step: 'signature' });
  });

  it('stops with nothing changed when a file can’t be downloaded or the feed lists too little', async () => {
    const r = await release();
    r.options.fetchImpl.mockImplementation(async () => new Response('gone', { status: 404 }));
    expect(await verifyRelease(r.entry, r.options)).toMatchObject({ ok: false, step: 'download' });
    expect(await verifyRelease({ ...r.entry, bundle: null }, r.options)).toMatchObject({ ok: false, step: 'feed' });
  });
});

describe('the feed entry', () => {
  it('carries the release’s file URLs, and drops anything that isn’t https', () => {
    const feed = {
      channels: { main: { version: '0.2.0-main.5', ...URLS, bundle: 'http://dl.test/b', signature: null } },
    };
    expect(latestIn(feed, 'main')).toMatchObject({
      manifest: URLS.manifest,
      checksums: URLS.checksums,
      bundle: null,
      signature: null,
    });
  });
});

describe('an install with no install repository keeps the verdict for Connections', () => {
  let spy;
  const stub = () => env.STORE.get(env.STORE.idFromName('acme-board'));
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => spy.mockRestore());

  it('reads the feed, verifies the newest release, and sends nothing but the requests for those files', async () => {
    const r = await release();
    const feed = { channels: { stable: null, main: { ...r.entry, manual: false, updatesFrom: '0.1.0-main.1' } } };
    const urls = [];
    spy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      urls.push(url);
      return url.endsWith('releases.json') ? Response.json(feed) : r.options.fetchImpl(url);
    });
    // The pretend key isn't the shipped one, so this release is refused: the shipped key never signed it.
    const state = await runInDurableObject(stub(), async (s) => {
      s.env = { ...s.env, BREAKAWAY_VERSION: '0.2.0-main.3' };
      return s.updatesVerify();
    });
    expect(state).toMatchObject({ channel: 'main', verdict: { ok: false, step: 'signature' } });
    expect(urls.filter((u) => !u.includes('leavethepack.dev') && !u.includes('dl.test'))).toEqual([]);
    await runInDurableObject(stub(), async (s) => expect(s.updateVerified()).toMatchObject({ verdict: { ok: false } }));
  });

  it('says nothing is wrong when there is nothing newer', async () => {
    spy.mockImplementation(async () => Response.json({ channels: { main: { version: '0.2.0-main.3' } } }));
    const state = await runInDurableObject(stub(), async (s) => {
      s.env = { ...s.env, BREAKAWAY_VERSION: '0.2.0-main.3' };
      return s.updatesVerify('main');
    });
    expect(state.verdict).toBeNull();
  });
});
