/**
 * Passkeys (WebAuthn), checked by the Worker itself with Web Crypto (BRK-300, docs/specs/BRK-299-people-and-roles.md,
 * point 2). No library and no outside service: the board reads the authenticator's answer, checks it was made for this
 * board's host and the challenge it handed out, with the person's verification, and keeps the public key.
 *
 * The board asks for no attestation (`attestation: "none"`): it trusts the passkey, not the device maker, so whatever
 * attestation statement an authenticator sends anyway is ignored.
 *
 * Signatures: ES256 (COSE -7), EdDSA (-8, Ed25519), and RS256 (-257), the ones Workers' Web Crypto verifies
 * (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms: ECDSA, Ed25519,
 * RSASSA-PKCS1-v1_5). The formats are WebAuthn Level 2's (https://www.w3.org/TR/webauthn-2/#sctn-registering-a-new-credential,
 * #sctn-verifying-assertion) and COSE's key parameters (RFC 9053, section 7).
 */

/** COSE algorithm numbers the board asks for, in its order of preference. */
export const ALGORITHMS = [-7, -8, -257];

/** The authenticator data's flags (WebAuthn Level 2, section 6.1). */
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED = 0x40;

const encoder = new TextEncoder();

export class PasskeyError extends Error {}

/** Bytes as base64url without padding, the way WebAuthn's JSON carries them. */
export function toBase64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** base64url (or base64) → bytes; throws PasskeyError on anything else. */
export function fromBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+/=-]*$/u.test(value)) throw new PasskeyError('not base64url');
  const plain = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    return Uint8Array.from(atob(plain + '='.repeat((4 - (plain.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    throw new PasskeyError('not base64url');
  }
}

/**
 * Just enough CBOR (RFC 8949) for an attestation object and a COSE key: definite lengths, integers, byte and text
 * strings, arrays, maps, and the simple values. Returns the value and where it ended.
 * @param {Uint8Array} bytes
 * @param {number} [at]
 * @returns {{ value: any, end: number }}
 */
export function decodeCbor(bytes, at = 0, depth = 0) {
  if (depth > 8) throw new PasskeyError('CBOR nested too deep');
  const need = (n) => {
    if (at + n > bytes.length) throw new PasskeyError('CBOR cut short');
  };
  need(1);
  const first = bytes[at++];
  const major = first >> 5;
  const info = first & 31;
  let length;
  if (info < 24) length = info;
  else if (info === 24) {
    need(1);
    length = bytes[at];
    at += 1;
  } else if (info === 25) {
    need(2);
    length = (bytes[at] << 8) | bytes[at + 1];
    at += 2;
  } else if (info === 26) {
    need(4);
    length = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
    at += 4;
  } else throw new PasskeyError('CBOR length the board doesn’t read');
  switch (major) {
    case 0:
      return { value: length, end: at };
    case 1:
      return { value: -1 - length, end: at };
    case 2:
      need(length);
      return { value: bytes.slice(at, at + length), end: at + length };
    case 3:
      need(length);
      return { value: new TextDecoder().decode(bytes.subarray(at, at + length)), end: at + length };
    case 4: {
      const list = [];
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(bytes, at, depth + 1);
        list.push(item.value);
        at = item.end;
      }
      return { value: list, end: at };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(bytes, at, depth + 1);
        const item = decodeCbor(bytes, key.end, depth + 1);
        map.set(key.value, item.value);
        at = item.end;
      }
      return { value: map, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      throw new PasskeyError('CBOR value the board doesn’t read');
    default:
      throw new PasskeyError('CBOR tag the board doesn’t read');
  }
}

/** The authenticator data (WebAuthn Level 2, section 6.1): the host's hash, the flags, the count, and a new key. */
export function parseAuthData(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) throw new PasskeyError('authenticator data is too short');
  const flags = bytes[32];
  const signCount = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  const out = { rpIdHash: bytes.subarray(0, 32), flags, signCount, credentialId: null, coseKey: null };
  if (flags & ATTESTED) {
    if (bytes.length < 55) throw new PasskeyError('authenticator data is too short for a new passkey');
    const idLength = (bytes[53] << 8) | bytes[54];
    if (bytes.length < 55 + idLength) throw new PasskeyError('authenticator data is too short for a new passkey');
    out.credentialId = bytes.slice(55, 55 + idLength);
    out.coseKey = decodeCbor(bytes, 55 + idLength).value;
  }
  return out;
}

/**
 * A COSE public key → a JWK the board keeps and Web Crypto imports (RFC 9053, sections 7.1 and 7.2; RFC 8230 for RSA).
 * @returns {{ alg: number, jwk: JsonWebKey }}
 */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new PasskeyError('the passkey’s public key isn’t a COSE key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label) => {
    const v = cose.get(label);
    if (!(v instanceof Uint8Array)) throw new PasskeyError('the passkey’s public key is missing a part');
    return toBase64url(v);
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1)
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } };
  throw new PasskeyError('the passkey uses a signature the board doesn’t check (ES256, EdDSA, and RS256 work)');
}

const IMPORT = {
  [-7]: { name: 'ECDSA', namedCurve: 'P-256' },
  [-8]: { name: 'Ed25519' },
  [-257]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
};
const VERIFY = {
  [-7]: { name: 'ECDSA', hash: 'SHA-256' },
  [-8]: { name: 'Ed25519' },
  [-257]: { name: 'RSASSA-PKCS1-v1_5' },
};

/** An ECDSA signature as WebAuthn sends it (ASN.1 DER) → the r‖s Web Crypto checks, 32 bytes each for P-256. */
export function derToRaw(der) {
  const fail = () => {
    throw new PasskeyError('the signature isn’t one the board reads');
  };
  if (der[0] !== 0x30) fail();
  let at = 2;
  if (der[1] & 0x80) at = 2 + (der[1] & 0x7f);
  const part = () => {
    if (der[at] !== 0x02) fail();
    const length = der[at + 1];
    let value = der.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) fail();
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The client data (WebAuthn Level 2, section 5.8.1): the right ceremony, the board's challenge, the board's origin. */
function checkClientData(bytes, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PasskeyError('the browser’s answer isn’t JSON');
  }
  if (data?.type !== type) throw new PasskeyError('the browser answered a different request');
  if (typeof data.challenge !== 'string' || data.challenge !== challenge)
    throw new PasskeyError('the passkey answered another challenge: start again');
  if (data.origin !== origin) throw new PasskeyError('the passkey was used on another site');
  if (data.crossOrigin === true) throw new PasskeyError('the passkey was used inside another site');
}

async function checkAuthData(auth, rpId) {
  if (!sameBytes(auth.rpIdHash, await sha256(encoder.encode(rpId))))
    throw new PasskeyError('the passkey is for another site');
  if (!(auth.flags & USER_PRESENT)) throw new PasskeyError('the passkey didn’t see you there');
  if (!(auth.flags & USER_VERIFIED))
    throw new PasskeyError('the passkey didn’t check it was you (a PIN, a fingerprint, or a face)');
}

/**
 * Checks a new passkey (navigator.credentials.create's answer).
 * @param {{ clientDataJSON: string, attestationObject: string }} response base64url, as the browser's JSON has them
 * @param {{ challenge: string, origin: string, rpId: string }} expected
 * @returns {Promise<{ credentialId: string, alg: number, jwk: JsonWebKey, signCount: number }>}
 */
export async function verifyRegistration(response, expected) {
  checkClientData(fromBase64url(response?.clientDataJSON), { type: 'webauthn.create', ...expected });
  const attestation = decodeCbor(fromBase64url(response?.attestationObject)).value;
  const authData = attestation instanceof Map ? attestation.get('authData') : null;
  if (!(authData instanceof Uint8Array)) throw new PasskeyError('the passkey sent no authenticator data');
  const auth = parseAuthData(authData);
  await checkAuthData(auth, expected.rpId);
  if (!auth.credentialId || !auth.coseKey) throw new PasskeyError('the passkey sent no public key');
  if (auth.credentialId.length < 16 || auth.credentialId.length > 1023)
    throw new PasskeyError('the passkey’s ID is the wrong length');
  const { alg, jwk } = coseToJwk(auth.coseKey);
  // Imports it once now, so a key Web Crypto refuses is refused here and not at the first sign-in.
  await crypto.subtle.importKey('jwk', jwk, IMPORT[alg], false, ['verify']).catch(() => {
    throw new PasskeyError('the passkey’s public key doesn’t load');
  });
  return { credentialId: toBase64url(auth.credentialId), alg, jwk, signCount: auth.signCount };
}

/**
 * Checks a sign-in (navigator.credentials.get's answer) against the key kept for that passkey.
 * @param {{ clientDataJSON: string, authenticatorData: string, signature: string }} response base64url
 * @param {{ challenge: string, origin: string, rpId: string, alg: number, jwk: JsonWebKey, signCount: number }} expected
 * @returns {Promise<{ signCount: number }>}
 */
export async function verifyAssertion(response, expected) {
  const clientData = fromBase64url(response?.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', ...expected });
  const authData = fromBase64url(response?.authenticatorData);
  const auth = parseAuthData(authData);
  await checkAuthData(auth, expected.rpId);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256(clientData), authData.length);
  let signature = fromBase64url(response?.signature);
  if (expected.alg === -7) signature = derToRaw(signature);
  if (!IMPORT[expected.alg]) throw new PasskeyError('the passkey uses a signature the board doesn’t check');
  const key = await crypto.subtle.importKey('jwk', expected.jwk, IMPORT[expected.alg], false, ['verify']);
  if (!(await crypto.subtle.verify(VERIFY[expected.alg], key, signature, signed)))
    throw new PasskeyError('the passkey’s signature doesn’t match');
  // A count that doesn't go up, from a passkey that counts, means a copy of it was used (section 6.1.1).
  if ((auth.signCount !== 0 || expected.signCount !== 0) && auth.signCount <= expected.signCount)
    throw new PasskeyError('this passkey may have been copied: remove it and add it again');
  return { signCount: auth.signCount };
}
