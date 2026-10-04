/**
 * Routines the board keeps itself (docs/specs/IDEA-26-kickoff.md, BRK-133): a repository's routine /fire URL and
 * token, connected from the board's form instead of `agents-connect`, stored in the Durable Object encrypted at rest.
 *
 * This is the one place the Worker keeps a secret it was given (IDEA-14 section 4 keeps the Secrets Store the
 * owner's): routine URLs and tokens only. The key is derived with HKDF-SHA256 from the sync key the board uses (the
 * Secrets Store's TASKS_SYNC_KEY until a rotation, then the rotated one, which `rekey` re-seals these with), so an
 * install needs no new secret. Each record is bound to its repository's slug, so one can't be moved to another.
 *
 * sealed = "v1." base64(12-byte IV) "." base64(AES-256-GCM ciphertext and tag of JSON { url, token })
 */
import { keyFromBase64 } from './crypto.js';

const VERSION = 'v1';
const INFO = new TextEncoder().encode('breakaway routine tokens v1');
const encoder = new TextEncoder();

/** The /fire URL of a routine's API trigger, as `agents-connect` checks it. */
export const ROUTINE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_\w+\/fire$/u;
/** A routine's API token, as `agents-connect` checks it. */
export const ROUTINE_TOKEN = /^sk-ant-oat01-[\w-]+$/u;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * A routine's URL and token from the form, trimmed and checked the way `agents-connect` checks them, or an error
 * that says which check failed and what to do.
 * @param {{ url?: unknown, token?: unknown }} input
 * @returns {{ url: string, token: string } | { error: string }}
 */
export function checkRoutine(input) {
  const url = String(input?.url ?? '').trim();
  const token = String(input?.token ?? '').trim();
  if (!ROUTINE_URL.test(url))
    return {
      error:
        "that isn't a routine /fire URL: copy it from the routine's API trigger on claude.ai/code/routines (https://api.anthropic.com/v1/claude_code/routines/trig_…/fire)",
    };
  if (!ROUTINE_TOKEN.test(token))
    return {
      error:
        "that isn't a routine token: generate one in the routine's API trigger on claude.ai/code/routines (sk-ant-oat01-…)",
    };
  return { url, token };
}

/**
 * The AES-GCM key for routine records, from the board's sync key (base64, 32 bytes).
 * @param {string} syncKey
 * @returns {Promise<CryptoKey>}
 */
export async function routineKey(syncKey) {
  const material = await crypto.subtle.importKey('raw', keyFromBase64(syncKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seals repository `slug`'s routine.
 * @param {CryptoKey} key
 * @param {string} slug
 * @param {{ url: string, token: string }} routine
 * @returns {Promise<string>}
 */
export async function sealRoutine(key, slug, { url, token }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(slug) },
    key,
    encoder.encode(JSON.stringify({ url, token })),
  );
  return `${VERSION}.${b64(iv)}.${b64(data)}`;
}

/**
 * Opens repository `slug`'s sealed routine. Throws when it can't: another key (the sync key changed without a
 * rotation), another repository's record, or a damaged one.
 * @param {CryptoKey} key
 * @param {string} slug
 * @param {string} sealed
 * @returns {Promise<{ url: string, token: string }>}
 */
export async function openRoutine(key, slug, sealed) {
  const [version, iv, data] = String(sealed).split('.');
  if (version !== VERSION || !iv || !data) throw new Error('not a sealed routine');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(slug) },
    key,
    unb64(data),
  );
  const routine = JSON.parse(new TextDecoder().decode(plain));
  if (typeof routine?.url !== 'string' || typeof routine?.token !== 'string') throw new Error('not a routine');
  return { url: routine.url, token: routine.token };
}
