// The passkey checks on their own (src/webauthn.js): the formats, each signature the board accepts, and what it refuses.
import { describe, expect, it } from 'vitest';
import {
  PasskeyError,
  coseToJwk,
  decodeCbor,
  derToRaw,
  fromBase64url,
  toBase64url,
  verifyAssertion,
  verifyRegistration,
} from '../src/webauthn.js';
import { encodeCbor, makeAuthenticator } from './authenticator.js';

const RP = { origin: 'https://tasks.acme.example', rpId: 'tasks.acme.example' };
const creation = (challenge) => ({
  challenge,
  rp: { id: RP.rpId, name: 'widgets tasks' },
  user: { id: toBase64url(new Uint8Array(16)), name: 'ana', displayName: 'Ana' },
});

describe('CBOR', () => {
  it('reads what an authenticator writes, and refuses what’s cut short', () => {
    const value = new Map([
      [1, 2],
      [-1, 1],
      ['fmt', 'none'],
      ['list', [true, false, null, 300, 70000]],
      ['bytes', new Uint8Array([1, 2, 3])],
    ]);
    const bytes = encodeCbor(value);
    expect(decodeCbor(bytes)).toEqual({ value, end: bytes.length });
    expect(() => decodeCbor(bytes.subarray(0, bytes.length - 1))).toThrow(PasskeyError);
    expect(() => decodeCbor(new Uint8Array([0xc0]))).toThrow(PasskeyError); // a tag
    expect(() => decodeCbor(new Uint8Array([0x5f]))).toThrow(PasskeyError); // an indefinite length
  });

  it('round-trips base64url, and refuses anything else', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    expect(() => fromBase64url('not base64!')).toThrow(PasskeyError);
    expect(() => fromBase64url(undefined)).toThrow(PasskeyError);
  });
});

describe('keys and signatures', () => {
  it('turns a DER signature into r‖s, leading zeros and all', () => {
    const r = new Uint8Array(32).fill(0x80);
    const s = new Uint8Array(32);
    s[31] = 7;
    const der = new Uint8Array([0x30, 38, 2, 33, 0, ...r, 2, 1, 7]);
    const raw = derToRaw(der);
    expect(raw.subarray(0, 32)).toEqual(r);
    expect(raw.subarray(32)).toEqual(s);
    expect(() => derToRaw(new Uint8Array([0x31, 0]))).toThrow(PasskeyError);
  });

  it('refuses a key type the board doesn’t check', () => {
    expect(() =>
      coseToJwk(
        new Map([
          [1, 2],
          [3, -35],
          [-1, 2],
        ]),
      ),
    ).toThrow(/ES256, EdDSA, and RS256/u);
    expect(() => coseToJwk('nope')).toThrow(PasskeyError);
  });

  it('checks an RS256 passkey', async () => {
    const keys = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const cose = new Map([
      [1, 3],
      [3, -257],
      [-1, fromBase64url(jwk.n)],
      [-2, fromBase64url(jwk.e)],
    ]);
    expect(coseToJwk(cose)).toEqual({ alg: -257, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e } });
    const enc = new TextEncoder();
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(RP.rpId)));
    const authData = new Uint8Array([...rpHash, 0x05, 0, 0, 0, 9]);
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: 'abc', origin: RP.origin }));
    const signed = new Uint8Array([...authData, ...new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))]);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, signed);
    const response = {
      clientDataJSON: toBase64url(clientData),
      authenticatorData: toBase64url(authData),
      signature: toBase64url(signature),
    };
    const expected = { ...RP, challenge: 'abc', alg: -257, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e }, signCount: 3 };
    expect(await verifyAssertion(response, expected)).toEqual({ signCount: 9 });
    await expect(verifyAssertion(response, { ...expected, challenge: 'xyz' })).rejects.toThrow(/another challenge/u);
  });
});

describe('a registration', () => {
  it('gives back the passkey’s ID, key, and count', async () => {
    const auth = await makeAuthenticator({ counter: 4 });
    const { response } = await auth.create(creation('c1'));
    const checked = await verifyRegistration(response, { ...RP, challenge: 'c1' });
    expect(checked).toMatchObject({ credentialId: auth.id, alg: -7, signCount: 4, jwk: { kty: 'EC', crv: 'P-256' } });
  });

  it('refuses an answer to a sign-in, or one missing its parts', async () => {
    const auth = await makeAuthenticator();
    await auth.create(creation('c1'));
    const { response } = await auth.get({ challenge: 'c1', rpId: RP.rpId });
    await expect(verifyRegistration(response, { ...RP, challenge: 'c1' })).rejects.toThrow(/different request/u);
    await expect(verifyRegistration({}, { ...RP, challenge: 'c1' })).rejects.toThrow(PasskeyError);
    const created = (await auth.create(creation('c2'))).response;
    await expect(
      verifyRegistration(
        { ...created, attestationObject: toBase64url(encodeCbor(new Map())) },
        { ...RP, challenge: 'c2' },
      ),
    ).rejects.toThrow(/no authenticator data/u);
  });
});
