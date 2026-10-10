// Passkeys in the browser (BRK-300, docs/specs/BRK-299-people-and-roles.md, point 2): the board's options come as
// JSON with base64url bytes, and its checks (src/webauthn.js) take the browser's answer back the same way.

/** Whether this browser can make and use passkeys at all. */
export const passkeysWork = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window;

/** @param {string} text base64url, no padding */
function bytesOf(text) {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** @param {ArrayBuffer | null | undefined} buffer */
function textOf(buffer) {
  if (!buffer) return null;
  let raw = '';
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** What the browser says when someone closes its passkey prompt, in the board's words; null for anything else. */
function cancelled(error) {
  return error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name);
}

/** A failure the person can act on: their words, never the browser's. */
export class PasskeyCancelled extends Error {}

/**
 * Makes a passkey from the board's creation options. Answers the credential as the board takes it.
 * @param {any} publicKey `publicKey` from an options route
 */
export async function makePasskey(publicKey) {
  let credential;
  try {
    credential = /** @type {PublicKeyCredential | null} */ (
      await navigator.credentials.create({
        publicKey: {
          ...publicKey,
          challenge: bytesOf(publicKey.challenge),
          user: { ...publicKey.user, id: bytesOf(publicKey.user.id) },
          excludeCredentials: (publicKey.excludeCredentials ?? []).map((c) => ({ ...c, id: bytesOf(c.id) })),
        },
      })
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidStateError')
      throw new Error('This device already has a passkey for you on this board.');
    if (cancelled(error)) throw new PasskeyCancelled('No passkey was made. Try again when you’re ready.');
    throw new Error('This browser couldn’t make a passkey. Try another browser or device.');
  }
  if (!credential) throw new PasskeyCancelled('No passkey was made. Try again when you’re ready.');
  const response = /** @type {AuthenticatorAttestationResponse} */ (credential.response);
  return {
    id: credential.id,
    type: credential.type,
    response: {
      clientDataJSON: textOf(response.clientDataJSON),
      attestationObject: textOf(response.attestationObject),
    },
  };
}

/**
 * Signs in with a passkey the browser picks, from the board's request options.
 * @param {any} publicKey `publicKey` from /api/signin/options
 */
export async function usePasskey(publicKey) {
  let credential;
  try {
    credential = /** @type {PublicKeyCredential | null} */ (
      await navigator.credentials.get({ publicKey: { ...publicKey, challenge: bytesOf(publicKey.challenge) } })
    );
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelled('Signing in was cancelled. Try again when you’re ready.');
    throw new Error('This browser couldn’t use a passkey. Sign in with the token, or try another browser.');
  }
  if (!credential) throw new PasskeyCancelled('Signing in was cancelled. Try again when you’re ready.');
  const response = /** @type {AuthenticatorAssertionResponse} */ (credential.response);
  return {
    id: credential.id,
    type: credential.type,
    response: {
      clientDataJSON: textOf(response.clientDataJSON),
      authenticatorData: textOf(response.authenticatorData),
      signature: textOf(response.signature),
      userHandle: textOf(response.userHandle),
    },
  };
}
