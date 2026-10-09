// A pretend passkey authenticator for tests: real keys made with Web Crypto, and the bytes a browser would send back
// from navigator.credentials.create and .get (WebAuthn Level 2, sections 6.1 and 6.5). Nothing here is a real secret.
import { toBase64url } from '../src/webauthn.js';

const encoder = new TextEncoder();
const b64u = toBase64url;

/** Just enough CBOR to write an attestation object and a COSE key. */
export function encodeCbor(value) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  const write = (v) => {
    if (v === false || v === true || v === null) out.push(v === false ? 0xf4 : v === true ? 0xf5 : 0xf6);
    else if (typeof v === 'number') v >= 0 ? head(0, v) : head(1, -1 - v);
    else if (v instanceof Uint8Array) {
      head(2, v.length);
      out.push(...v);
    } else if (typeof v === 'string') {
      const bytes = encoder.encode(v);
      head(3, bytes.length);
      out.push(...bytes);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      for (const item of v) write(item);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    } else throw new Error(`can't write ${v}`);
  };
  write(value);
  return new Uint8Array(out);
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const count4 = (n) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const fromB64u = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

/** r‖s → ASN.1 DER, the way an authenticator sends an ECDSA signature. */
function rawToDer(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([2, v.length]), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/**
 * One passkey on a pretend device. `alg` is -7 (ES256) or -8 (EdDSA). `flags` overrides what the authenticator
 * says it checked; `counter` is its sign count (0 for one that doesn't count, as many synced passkeys do).
 */
export async function makeAuthenticator({ alg = -7, counter = 1 } = {}) {
  const keys =
    alg === -7
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      : await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const cose =
    alg === -7
      ? new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, fromB64u(jwk.x)],
          [-3, fromB64u(jwk.y)],
        ])
      : new Map([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, fromB64u(jwk.x)],
        ]);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const id = b64u(credentialId);
  let signCount = counter;
  let userHandle = null;

  const clientData = (type, challenge, origin) =>
    encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id,
    /** navigator.credentials.create's answer to `publicKey` (the board's creation options). */
    async create(publicKey, { origin = 'https://tasks.acme.example', rpId = publicKey.rp.id, flags = 0x45 } = {}) {
      userHandle = publicKey.user.id;
      const authData = concat(
        await sha256(encoder.encode(rpId)),
        new Uint8Array([flags]),
        count4(signCount),
        new Uint8Array(16),
        new Uint8Array([credentialId.length >> 8, credentialId.length & 255]),
        credentialId,
        encodeCbor(cose),
      );
      const attestationObject = encodeCbor(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64u(clientData('webauthn.create', publicKey.challenge, origin)),
          attestationObject: b64u(attestationObject),
        },
      };
    },
    /** navigator.credentials.get's answer to `publicKey` (the board's request options). */
    async get(
      publicKey,
      {
        origin = 'https://tasks.acme.example',
        rpId = publicKey.rpId,
        flags = 0x05,
        count = signCount + (counter ? 1 : 0),
      } = {},
    ) {
      signCount = count;
      const authData = concat(await sha256(encoder.encode(rpId)), new Uint8Array([flags]), count4(signCount));
      const cd = clientData('webauthn.get', publicKey.challenge, origin);
      const signed = concat(authData, await sha256(cd));
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' },
          keys.privateKey,
          signed,
        ),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(alg === -7 ? rawToDer(raw) : raw),
          userHandle,
        },
      };
    },
  };
}
