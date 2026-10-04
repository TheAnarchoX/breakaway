/**
 * Checking a release before an install may use it (BRK-52, docs/specs/IDEA-20-self-updating-installs.md section 3,
 * step 1). The feed only says where a release's files are; this decides whether they are breakaway's: the manifest
 * must verify against the key the running version ships (release-key.js), the bundle must match the checksum the
 * signed manifest holds and the release's SHA256SUMS, and the running version must be at or above `updatesFrom`.
 * Nothing here installs anything. The first check that fails stops, and says which step and what to do.
 */
import { verifyManifest } from './release-key.js';
import { isVersion } from './versions.js';
import { tooOld } from './updates.js';

const MAX_BYTES = { manifest: 64 * 1024, checksums: 64 * 1024, signature: 4 * 1024, bundle: 25 * 1024 * 1024 };

/** @param {ArrayBuffer | Uint8Array} bytes @returns {Promise<string>} the SHA-256, as lowercase hex */
async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The checksum SHA256SUMS lists for `name` (`<hex>  <name>` lines), or null. */
function listed(text, name) {
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

/**
 * @param {'feed' | 'download' | 'signature' | 'checksum' | 'release'} step
 * @param {string} message
 * @returns {{ ok: false, step: 'feed' | 'download' | 'signature' | 'checksum' | 'release', message: string }}
 */
const refuse = (step, message) => ({ ok: false, step, message });

/**
 * @typedef {{ version: string, manifest?: string | null, signature?: string | null, bundle?: string | null, checksums?: string | null }} ReleaseEntry
 * @typedef {{ ok: true, manifest: any, bundle: ArrayBuffer } | { ok: false, step: 'feed' | 'download' | 'signature' | 'checksum' | 'release', message: string }} Verdict
 */

/**
 * Downloads the release's files and checks them.
 * @param {ReleaseEntry} entry the channel's entry from the feed
 * @param {{ running: string, publicKey?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Verdict>}
 */
export async function verifyRelease(entry, { running, publicKey, fetchImpl = fetch }) {
  if (!entry.signature)
    return refuse(
      'signature',
      `${entry.version} was released before releases were signed, so it can’t be installed from the board. Update by hand once.`,
    );
  if (!entry.manifest || !entry.bundle || !entry.checksums)
    return refuse(
      'feed',
      'The update feed doesn’t list all of this release’s files. Nothing changed; try again later.',
    );

  /** @param {'manifest' | 'signature' | 'checksums' | 'bundle'} what */
  const get = async (what) => {
    const res = await fetchImpl(/** @type {string} */ (entry[what]), { redirect: 'follow' });
    if (!res.ok) throw new Error(`${what} answered ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES[what]) throw new Error(`${what} is larger than expected`);
    return bytes;
  };
  let files;
  try {
    const [manifest, signature, checksums, bundle] = await Promise.all([
      get('manifest'),
      get('signature'),
      get('checksums'),
      get('bundle'),
    ]);
    files = { manifest, signature, checksums, bundle };
  } catch (error) {
    return refuse(
      'download',
      `Couldn’t download ${entry.version}: ${error.message}. Nothing changed; try again later.`,
    );
  }

  const signed = await verifyManifest(
    new Uint8Array(files.manifest),
    new TextDecoder().decode(files.signature),
    publicKey,
  );
  if (!signed)
    return refuse(
      'signature',
      'This release didn’t pass its signature check, so it wasn’t installed. Nothing changed.',
    );

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(files.manifest));
  } catch {
    manifest = null;
  }
  if (manifest?.version !== entry.version || typeof manifest.bundleSha256 !== 'string')
    return refuse(
      'signature',
      'The signed manifest doesn’t match the release the feed named, so it wasn’t installed. Nothing changed.',
    );

  const sums = new TextDecoder().decode(files.checksums);
  const [bundleSum, manifestSum] = await Promise.all([sha256(files.bundle), sha256(files.manifest)]);
  if (
    bundleSum !== manifest.bundleSha256 ||
    listed(sums, 'breakaway-bundle.tar.gz') !== bundleSum ||
    listed(sums, 'manifest.json') !== manifestSum
  )
    return refuse(
      'checksum',
      'This release’s files didn’t match their checksums, so it wasn’t installed. Nothing changed.',
    );

  if (manifest.manual === true)
    return refuse(
      'release',
      `${entry.version} needs steps by hand: ${(manifest.manualSteps ?? []).join('; ') || 'see its notes'}.`,
    );
  if (!isVersion(running) || !isVersion(manifest.updatesFrom))
    return refuse(
      'release',
      `This board runs ${running}, which isn’t a release, so it can’t update itself. Update by hand once.`,
    );
  if (tooOld(running, manifest.updatesFrom))
    return refuse(
      'release',
      `This board runs ${running}, which is too old to update to ${entry.version} directly (from ${manifest.updatesFrom}). Update by hand once.`,
    );

  return { ok: true, manifest, bundle: files.bundle };
}
