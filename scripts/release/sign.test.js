import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEY, verifyManifest } from '../../src/release-key.js';
import { signManifest } from './sign.mjs';

// BRK-51: releases are signed, so an install that updates itself can check a bundle came from breakaway.
const MANIFEST = JSON.stringify({ version: '0.2.0-main.1', channel: 'main', manual: false, updatesFrom: '0.1.0' });
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
};

describe('release signing', () => {
  const { pem, raw } = pair();

  it('verifies a signed manifest and refuses a changed one', async () => {
    const signature = signManifest(MANIFEST, pem);
    expect(await verifyManifest(MANIFEST, signature, raw)).toBe(true);
    expect(await verifyManifest(MANIFEST.replace('0.1.0', '0.0.1'), signature, raw)).toBe(false);
  });

  it('refuses a signature from another key, and the shipped key does not verify it', async () => {
    const other = pair();
    const signature = signManifest(MANIFEST, other.pem);
    expect(await verifyManifest(MANIFEST, signature, raw)).toBe(false);
    expect(await verifyManifest(MANIFEST, signature)).toBe(false);
  });

  it('refuses malformed signatures and keys without throwing', async () => {
    expect(await verifyManifest(MANIFEST, 'not base64!', raw)).toBe(false);
    expect(await verifyManifest(MANIFEST, '', raw)).toBe(false);
    expect(await verifyManifest(MANIFEST, signManifest(MANIFEST, pem), 'AAAA')).toBe(false);
  });

  it('ships a public key that is 32 bytes', () => {
    expect(Buffer.from(RELEASE_PUBLIC_KEY, 'base64')).toHaveLength(32);
  });

  it('the script refuses a key that is not the shipped one, and says the secret is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sign-'));
    const file = join(dir, 'manifest.json');
    writeFileSync(file, MANIFEST);
    const run = (env) =>
      execFileSync('node', ['scripts/release/sign.mjs', file, `${file}.sig`], {
        env: { PATH: process.env.PATH, ...env },
        stdio: 'pipe',
      });
    expect(() => run({})).toThrow(/RELEASE_SIGNING_KEY isn't set/u);
    expect(() => run({ RELEASE_SIGNING_KEY: pem })).toThrow(/shipped public key/u);
  });
});
