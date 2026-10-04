// Signs a release's manifest (BRK-51): node scripts/release/sign.mjs <manifest.json> <manifest.json.sig>
// The private key is the RELEASE_SIGNING_KEY environment variable, a PKCS#8 PEM Ed25519 key. It never goes in a
// file or the log. The signature is base64 of the raw 64 bytes, and is checked against the shipped public key
// before it is written, so a release is never published with a signature an install would refuse.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { RELEASE_PUBLIC_KEY, verifyManifest } from '../../src/release-key.js';

/**
 * @param {Buffer | string} manifest the manifest's exact bytes
 * @param {string} pem the private key
 * @returns {string} the signature, base64
 */
export function signManifest(manifest, pem) {
  return sign(null, Buffer.from(manifest), createPrivateKey(pem)).toString('base64');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [manifestPath, outPath] = process.argv.slice(2);
  const pem = process.env.RELEASE_SIGNING_KEY;
  if (!manifestPath || !outPath) throw new Error('Usage: sign.mjs <manifest.json> <manifest.json.sig>');
  if (!pem) throw new Error("RELEASE_SIGNING_KEY isn't set. It is a secret of the npm environment (see BRK-50).");
  const manifest = readFileSync(manifestPath);
  const signature = signManifest(manifest, pem);
  if (!(await verifyManifest(manifest, signature, RELEASE_PUBLIC_KEY)))
    throw new Error(
      "The signature doesn't verify against src/release-key.js: the key and the shipped public key differ.",
    );
  writeFileSync(outPath, `${signature}\n`);
  console.log(`Signed ${manifestPath}.`);
}
