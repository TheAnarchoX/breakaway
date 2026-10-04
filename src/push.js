/**
 * Web Push for pings (docs/specs/IDEA-12-agent-pings.md): VAPID (RFC 8292) and message encryption
 * (RFC 8291, aes128gcm) with WebCrypto only, from ./web-push.js: the board's own web-push
 * code, so the package builds on its own. The private key is the Secrets Store's
 * `TASKS_VAPID_KEY` (32 bytes, base64url); the public key is the var `TASKS_VAPID_PUBLIC` (the 65-byte
 * uncompressed point, base64url). Either one missing, empty, or `unset` means push is off and pings
 * carry on without it.
 */
import {
  encryptPayload,
  fromB64u,
  generateVapidKeys,
  vapidAuthorization as sharedVapidAuthorization,
  toB64u,
  validVapidKeys,
} from './web-push.js';
import { DEFAULTS, install } from './install.js';
import { secret } from './secrets.js';

const enc = new TextEncoder();
/** How long the push service keeps an undelivered message: a day is long enough to be useful, short enough to not be stale. */
const TTL = 86_400;

export { encryptPayload, fromB64u, generateVapidKeys, toB64u };

/**
 * The board's VAPID keys and its URL (the subject), or null while the owner hasn't set them up. `home` is where
 * the board answers (the store's homeUrl(), for an install on workers.dev); push services want a subject.
 */
export async function vapidKeys(env, home = install(env).url) {
  if (!home) return null;
  const publicKey = String(env.TASKS_VAPID_PUBLIC ?? '').trim();
  if (!publicKey || publicKey === 'unset') return null;
  let privateKey;
  try {
    privateKey = (await secret(env, 'TASKS_VAPID_KEY')).trim();
  } catch {
    return null;
  }
  if (!privateKey || privateKey === 'unset') return null;
  if (!validVapidKeys(publicKey, privateKey)) return null;
  return { publicKey, privateKey, subject: home };
}

/** The `Authorization` header that proves the push comes from the board (RFC 8292). */
export function vapidAuthorization(endpoint, keys, now = Date.now()) {
  return sharedVapidAuthorization(endpoint, keys, { subject: keys.subject, now });
}

/** Sends one message to one subscription. Returns the push service's status (0 when it couldn't be reached). */
export async function sendPush(subscription, message, keys) {
  try {
    const body = await encryptPayload(subscription, enc.encode(JSON.stringify(message)));
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL),
        Urgency: 'high',
      },
      body,
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/** What a ping's notification says: the install's name, the task and kind, then the message's first line, cut short. */
export function pingMessage(ping, title = /** @type {string} */ (DEFAULTS.name)) {
  const first = String(ping.message).split('\n')[0].trim();
  const line = first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
  return {
    title,
    body: `${ping.task} needs you: ${ping.kind}${line ? `\n${line}` : ''}`,
    tag: ping.task,
    url: `/?inbox=${ping.id}`,
  };
}
