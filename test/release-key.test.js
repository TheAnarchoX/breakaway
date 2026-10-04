import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEY, verifyManifest } from '../src/release-key.js';

// BRK-51: the Worker checks a release's manifest against the key it ships with, in the Workers runtime.
const MANIFEST = '{"version":"0.2.0-main.1","manual":false,"updatesFrom":"0.1.0"}\n';
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { pair, raw: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}
const signWith = async (pair, text) =>
  b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(text)));

describe('verifying a release', () => {
  it('accepts a manifest signed by the key and refuses a changed one, another key, and junk', async () => {
    const { pair, raw } = await keyPair();
    const signature = await signWith(pair, MANIFEST);
    expect(await verifyManifest(MANIFEST, signature, raw)).toBe(true);
    expect(await verifyManifest(new TextEncoder().encode(MANIFEST), signature, raw)).toBe(true);
    expect(await verifyManifest(MANIFEST.replace('0.1.0', '0.0.1'), signature, raw)).toBe(false);
    expect(await verifyManifest(MANIFEST, signature, (await keyPair()).raw)).toBe(false);
    expect(await verifyManifest(MANIFEST, signature)).toBe(false);
    expect(await verifyManifest(MANIFEST, '%%%', raw)).toBe(false);
  });

  it('ships a key the runtime loads as Ed25519', async () => {
    const raw = Uint8Array.from(atob(RELEASE_PUBLIC_KEY), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    expect(key.algorithm.name).toBe('Ed25519');
  });
});
