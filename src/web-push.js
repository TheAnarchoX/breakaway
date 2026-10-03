/**
 * Web Push with WebCrypto only (PRD-51, for PRD-13's live notifications): VAPID (RFC 8292) and
 * message encryption (RFC 8291, aes128gcm). Pure crypto, no keys, storage, or fetch: push.js brings
 * the board's keys and subject. The board's own web-push code.
 *
 * Keys travel as base64url strings: the VAPID public key and a subscription's `p256dh` are the
 * 65-byte uncompressed P-256 point, the VAPID private key is the 32-byte scalar (a JWK's `d`).
 */

const enc = new TextEncoder();
/** RFC 8188 record size we announce; a push message is one record well under it. */
const RECORD_SIZE = 4096;
/** How long a VAPID token is good for (RFC 8292 §2 allows up to 24 hours). */
const VAPID_LIFETIME = 12 * 3600;

/**
 * @typedef {{ publicKey: string, privateKey: string }} VapidKeys
 * @typedef {{ p256dh: string, auth: string }} SubscriptionKeys
 */

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toB64u(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromB64u(text) {
  const b64 = String(text).trim().replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

/**
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A P-256 private key as a JWK, from the scalar and the uncompressed public point.
 * @param {string} privateKey
 * @param {string} publicKey
 * @returns {JsonWebKey}
 */
const privateJwk = (privateKey, publicKey) => {
  const point = fromB64u(publicKey);
  return { kty: 'EC', crv: 'P-256', d: privateKey, x: toB64u(point.slice(1, 33)), y: toB64u(point.slice(33, 65)) };
};

/**
 * A fresh VAPID key pair as the two strings an owner stores.
 * @returns {Promise<VapidKeys>}
 */
export async function generateVapidKeys() {
  const pair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  );
  const jwk = /** @type {JsonWebKey} */ (await crypto.subtle.exportKey('jwk', pair.privateKey));
  return { privateKey: jwk.d, publicKey: toB64u(concat(Uint8Array.of(4), fromB64u(jwk.x), fromB64u(jwk.y))) };
}

/**
 * Whether two strings are a usable VAPID key pair by length (65-byte point, 32-byte scalar).
 * @param {string} publicKey
 * @param {string} privateKey
 * @returns {boolean}
 */
export function validVapidKeys(publicKey, privateKey) {
  try {
    return fromB64u(publicKey).length === 65 && fromB64u(privateKey).length === 32;
  } catch {
    return false;
  }
}

/**
 * The `Authorization` header that proves a push comes from the key holder (RFC 8292 §3).
 * @param {string} endpoint the subscription's endpoint; its origin is the token's audience
 * @param {VapidKeys} keys
 * @param {{ subject: string, now?: number }} options `subject` is a `mailto:` or `https:` contact
 * @returns {Promise<string>}
 */
export async function vapidAuthorization(endpoint, { publicKey, privateKey }, { subject, now = Date.now() }) {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk(privateKey, publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_LIFETIME, sub: subject };
  const signing = `${toB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${toB64u(enc.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signing)),
  );
  return `vapid t=${signing}.${toB64u(signature)}, k=${publicKey}`;
}

/**
 * @param {Uint8Array} salt
 * @param {Uint8Array} ikm
 * @param {Uint8Array} info
 * @param {number} bytes
 * @returns {Promise<Uint8Array>}
 */
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * Encrypts `plaintext` to a subscription's keys as one aes128gcm record (RFC 8291 §3.4 and RFC 8188).
 * A fresh sender key pair and salt are made for every message; `fixed` pins them, for tests only
 * (the RFC 8291 test vector).
 * @param {SubscriptionKeys} subscription
 * @param {Uint8Array} plaintext
 * @param {{ salt: Uint8Array, sender: VapidKeys }} [fixed]
 * @returns {Promise<Uint8Array>} the request body
 */
export async function encryptPayload({ p256dh, auth }, plaintext, fixed) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  let senderPrivate;
  let asPublic;
  if (fixed) {
    senderPrivate = await crypto.subtle.importKey(
      'jwk',
      privateJwk(fixed.sender.privateKey, fixed.sender.publicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    asPublic = fromB64u(fixed.sender.publicKey);
  } else {
    const pair = /** @type {CryptoKeyPair} */ (
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    );
    senderPrivate = pair.privateKey;
    asPublic = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey('raw', pair.publicKey)));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // WebCrypto's ECDH takes `public`; the Workers types spell it `$public`, so cast past them.
  const ecdh = /** @type {SubtleCryptoDeriveKeyAlgorithm} */ (/** @type {unknown} */ ({ name: 'ECDH', public: uaKey }));
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, senderPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, Uint8Array.of(2))),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, record);
}
