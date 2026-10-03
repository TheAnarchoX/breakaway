/**
 * TaskChampion's encryption envelope (taskchampion src/server/encryption.rs).
 *
 * envelope = 0x01 | nonce (12 bytes) | ChaCha20-Poly1305 ciphertext and tag
 * aad      = 0x01 (the task app ID) | version ID (16 bytes)
 *
 * The key is PBKDF2-HMAC-SHA256(encryption secret, client ID bytes, 600000 rounds, 32 bytes).
 * Workers' WebCrypto caps PBKDF2 well below 600000 rounds, so the Worker is given the derived
 * key (TASKS_SYNC_KEY) instead of the secret; `scripts/tasks.mjs` derives it with Node.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

export const NIL = '00000000-0000-0000-0000-000000000000';
const ENVELOPE_VERSION = 1;
const APP_ID = 1;
const NONCE_LEN = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function uuidBytes(uuid) {
  if (!isUuid(uuid)) throw new Error(`not a UUID: ${uuid}`);
  return Uint8Array.from(uuid.replaceAll('-', '').match(/../gu), (b) => parseInt(b, 16));
}

export function keyFromBase64(b64) {
  const key = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  if (key.length !== 32) throw new Error('the sync key must be 32 bytes');
  return key;
}

function aad(versionId) {
  const out = new Uint8Array(17);
  out[0] = APP_ID;
  out.set(uuidBytes(versionId), 1);
  return out;
}

/** Encrypts `payload` for `versionId` (a history segment's parent, or a snapshot's own version). */
export function seal(key, versionId, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const sealed = chacha20poly1305(key, nonce, aad(versionId)).encrypt(payload);
  const out = new Uint8Array(1 + NONCE_LEN + sealed.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_LEN);
  return out;
}

/** Decrypts an envelope sealed for `versionId`; throws if it wasn't, or the key is wrong. */
export function unseal(key, versionId, envelope) {
  if (envelope.length <= 1 + NONCE_LEN) throw new Error('envelope is too small');
  if (envelope[0] !== ENVELOPE_VERSION) throw new Error(`unrecognized envelope version ${envelope[0]}`);
  const nonce = envelope.subarray(1, 1 + NONCE_LEN);
  return chacha20poly1305(key, nonce, aad(versionId)).decrypt(envelope.subarray(1 + NONCE_LEN));
}
