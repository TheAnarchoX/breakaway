/**
 * The key releases are signed with (docs/specs/IDEA-20-self-updating-installs.md, section 1). The Release
 * workflow signs each release's manifest.json with the private half (Ed25519, the RELEASE_SIGNING_KEY secret of
 * its npm environment) and publishes the signature as the asset manifest.json.sig. An install that updates itself
 * installs a bundle only if its manifest verifies against the key the running version already carries, so
 * whoever controls the feed can hide an update but never push one. To rotate the key, ship a release, signed by
 * the old key, that changes RELEASE_PUBLIC_KEY here: installs trust the new key from then on.
 */

/** The public half: the raw 32 bytes, as base64. */
export const RELEASE_PUBLIC_KEY = 'Wm9awQpuzit22NgnRGCd1CTsn1mn71JEzzzPndUlaHs=';

// An SPKI wrapper for a raw Ed25519 key: this prefix, then the 32 bytes.
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

/** @param {string} text @returns {Uint8Array<ArrayBuffer>} */
const fromBase64 = (text) => Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0)).slice();

/**
 * Whether `signature` (base64) is a valid signature of the manifest's exact bytes by `publicKey`.
 * Never throws: a malformed key or signature is a refusal.
 * @param {string | Uint8Array} manifest the manifest.json as it was downloaded
 * @param {string} signature the contents of manifest.json.sig
 * @param {string} [publicKey] the raw key as base64; the shipped key unless a test passes another
 * @returns {Promise<boolean>}
 */
export async function verifyManifest(manifest, signature, publicKey = RELEASE_PUBLIC_KEY) {
  try {
    const raw = fromBase64(publicKey);
    if (raw.length !== 32) return false;
    const spki = new Uint8Array(SPKI_PREFIX.length + raw.length);
    spki.set(SPKI_PREFIX);
    spki.set(raw, SPKI_PREFIX.length);
    const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    const bytes = typeof manifest === 'string' ? new TextEncoder().encode(manifest) : new Uint8Array(manifest);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(signature), bytes);
  } catch {
    return false;
  }
}
