import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import {
  encryptPayload,
  fromB64u,
  generateVapidKeys,
  pingMessage,
  toB64u,
  vapidAuthorization,
  vapidKeys,
} from '../src/push.js';

const dec = new TextDecoder();

/** A browser's push subscription: keys the test holds, so it can read what the board sends. */
async function browser(endpoint = 'https://push.example.com/send/abc') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh: toB64u(p256dh), auth: toB64u(auth) }, pair, p256dh, auth };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** What a browser does with a push body (RFC 8291 §3.4 and RFC 8188). */
async function decrypt(sub, body) {
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const record = body.slice(21 + idLength);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.pair.privateKey, 256),
  );
  const info = new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...sub.p256dh, ...asPublic]);
  const ikm = await hkdf(sub.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  expect(plain.at(-1)).toBe(2); // the last (and only) record's delimiter
  return dec.decode(plain.slice(0, -1));
}

describe('Web Push primitives', () => {
  it('encrypts so the subscribed browser, and only it, can read the message', async () => {
    const sub = await browser();
    const body = await encryptPayload(sub.keys, new TextEncoder().encode('CLD-1 needs you: blocked'));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(sub, body)).toBe('CLD-1 needs you: blocked');
    const other = await browser();
    await expect(decrypt(other, body)).rejects.toThrow();
  });

  it('signs a VAPID header the push service can verify with the public key', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization('https://push.example.com/send/abc', keys, 1_790_000_000_000);
    const [, jwt, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/u.exec(header);
    expect(k).toBe(keys.publicKey);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(dec.decode(fromB64u(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(dec.decode(fromB64u(p)))).toEqual({
      aud: 'https://push.example.com',
      exp: 1_790_000_000 + 12 * 3600,
      sub: 'https://tasks.samewave.dev',
    });
    const pub = await crypto.subtle.importKey(
      'raw',
      fromB64u(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        fromB64u(sig),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });

  it('treats a missing, empty, or `unset` key as push being off', async () => {
    const keys = await generateVapidKeys();
    expect(await vapidKeys({})).toBeNull();
    expect(await vapidKeys({ TASKS_VAPID_PUBLIC: 'unset', TASKS_VAPID_KEY: keys.privateKey })).toBeNull();
    expect(await vapidKeys({ TASKS_VAPID_PUBLIC: keys.publicKey, TASKS_VAPID_KEY: 'unset' })).toBeNull();
    expect(await vapidKeys({ TASKS_VAPID_PUBLIC: keys.publicKey })).toBeNull();
    expect(await vapidKeys({ TASKS_VAPID_PUBLIC: keys.publicKey, TASKS_VAPID_KEY: 'not a key' })).toBeNull();
    expect(
      await vapidKeys({ TASKS_VAPID_PUBLIC: keys.publicKey, TASKS_VAPID_KEY: { get: async () => keys.privateKey } }),
    ).toEqual({ ...keys, subject: 'https://tasks.samewave.dev' });
    // An install on workers.dev has no URL until it's been opened, and push services want a subject (CLD-139).
    const ready = { TASKS_VAPID_PUBLIC: keys.publicKey, TASKS_VAPID_KEY: keys.privateKey };
    expect(await vapidKeys(ready, null)).toBeNull();
    expect((await vapidKeys(ready, 'https://breakaway.someone.workers.dev')).subject).toBe(
      'https://breakaway.someone.workers.dev',
    );
  });

  it('words the notification: task, kind, and the first line cut to 80 characters', () => {
    expect(
      pingMessage({ id: 7, task: 'CLD-1', kind: 'blocked', message: 'Needs a change.\nMore detail here.' }),
    ).toEqual({
      title: 'samewave tasks',
      body: 'CLD-1 needs you: blocked\nNeeds a change.',
      tag: 'CLD-1',
      url: '/?inbox=7',
    });
    const long = pingMessage({ id: 1, task: 'CLD-1', kind: 'done', message: 'x'.repeat(200) });
    expect(long.body.split('\n')[1]).toHaveLength(80);
  });
});

async function signIn() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return (path, method, payload) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
}

const held = async (description, by) => {
  const made = await api('tasks', {
    method: 'POST',
    body: { description, project: 'cloud', horizon: 'now', tags: ['agent'] },
  });
  const wid = (await made.json()).tasks[0].wid;
  await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent: by } });
  return wid;
};
const ping = (wid, by, body) => api(`tasks/${wid}/pings`, { method: 'POST', body: { by, ...body } });

/** Stands in for the push service: records each message, answers with `status(endpoint)`. */
function pushService(status = () => 201) {
  const sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith('https://push.example.com/')) throw new Error(`unexpected fetch to ${url}`);
    sent.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body) });
    return new Response(null, { status: status(url) });
  });
  return sent;
}

describe('subscriptions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are the owner’s: the cookie may subscribe, the bearer token may not', async () => {
    const sub = await browser('https://push.example.com/send/owner-only');
    const viaToken = await api('push/subscriptions', {
      method: 'POST',
      body: { endpoint: sub.endpoint, keys: sub.keys },
    });
    expect(viaToken.status).toBe(403);
    expect((await api('push')).status).toBe(403);
    const owner = await signIn();
    expect((await owner('push/subscriptions', 'POST', { endpoint: sub.endpoint, keys: sub.keys })).status).toBe(200);
    const config = await (await owner('push', 'GET')).json();
    expect(config).toMatchObject({ available: true, publicKey: env.TASKS_VAPID_PUBLIC });
    expect(config.subscriptions).toBeGreaterThan(0);
    expect((await owner('push/subscriptions', 'DELETE', { endpoint: sub.endpoint })).status).toBe(200);
  });

  it('refuse endpoints the board shouldn’t call, bad keys, and more than 5 browsers', async () => {
    const owner = await signIn();
    const sub = await browser();
    for (const endpoint of [
      'http://push.example.com/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://[::1]/x',
      'https://user:pw@push.example.com/x',
      'nope',
      '',
    ]) {
      expect((await owner('push/subscriptions', 'POST', { endpoint, keys: sub.keys })).status).toBe(400);
    }
    expect(
      (
        await owner('push/subscriptions', 'POST', {
          endpoint: sub.endpoint,
          keys: { p256dh: 'AAAA', auth: sub.keys.auth },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner('push/subscriptions', 'POST', {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: 'AA' },
        })
      ).status,
    ).toBe(400);
    const endpoints = Array.from({ length: 5 }, (_, i) => `https://push.example.com/send/cap-${i}`);
    for (const endpoint of endpoints)
      expect((await owner('push/subscriptions', 'POST', { endpoint, keys: sub.keys })).status).toBe(200);
    const sixth = await owner('push/subscriptions', 'POST', {
      endpoint: 'https://push.example.com/send/cap-6',
      keys: sub.keys,
    });
    expect(sixth.status).toBe(409);
    expect((await owner('push/subscriptions', 'POST', { endpoint: endpoints[0], keys: sub.keys })).status).toBe(200); // the same browser again is fine
    for (const endpoint of endpoints) await owner('push/subscriptions', 'DELETE', { endpoint });
  });
});

describe('sending a push for a ping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reaches a subscribed browser, encrypted, for each kind that needs the owner and not for fyi', async () => {
    const owner = await signIn();
    const sub = await browser('https://push.example.com/send/deliver');
    await owner('push/subscriptions', 'POST', { endpoint: sub.endpoint, keys: sub.keys });
    const sent = pushService();
    const wid = await held('Needs the owner', 'claude-push');
    const res = await ping(wid, 'claude-push', {
      kind: 'blocked',
      message: 'Needs a dashboard change only you can make.',
    });
    expect(res.status).toBe(201);
    const { ping: made } = await res.json();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [call] = sent;
    expect(call.url).toBe(sub.endpoint);
    expect(call.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(call.headers.get('Authorization')).toMatch(/^vapid t=[\w.-]+, k=/u);
    expect(JSON.parse(await decrypt(sub, call.body))).toEqual({
      title: 'samewave tasks',
      body: `${wid} needs you: blocked\nNeeds a dashboard change only you can make.`,
      tag: wid,
      url: `/?inbox=${made.id}`,
    });

    const quiet = await held('Only good to know', 'claude-push-fyi');
    await ping(quiet, 'claude-push-fyi', { kind: 'fyi', message: 'Good to know.' });
    const done = await held('Looks finished', 'claude-push-done');
    await ping(done, 'claude-push-done', { kind: 'done', message: 'Already behaves as expected.' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(JSON.parse(await decrypt(sub, sent[1].body)).tag).toBe(done);
    await owner('push/subscriptions', 'DELETE', { endpoint: sub.endpoint });
  });

  it('drops a subscription the push service says is gone, keeps one that only failed, and never fails the ping', async () => {
    const owner = await signIn();
    const gone = await browser('https://push.example.com/send/gone');
    const flaky = await browser('https://push.example.com/send/flaky');
    for (const s of [gone, flaky]) await owner('push/subscriptions', 'POST', { endpoint: s.endpoint, keys: s.keys });
    const sent = pushService((url) => (url.endsWith('/gone') ? 410 : 503));
    const wid = await held('Dead ends', 'claude-dead');
    expect((await ping(wid, 'claude-dead', { kind: 'question', message: 'Which one?' })).status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await vi.waitFor(async () => expect((await (await owner('push', 'GET')).json()).subscriptions).toBe(1));

    const again = await held('Again', 'claude-dead-2');
    await ping(again, 'claude-dead-2', { kind: 'stale', message: 'Does not reproduce.' });
    await vi.waitFor(() => expect(sent.filter((c) => c.url.endsWith('/flaky'))).toHaveLength(2));
    expect(sent.filter((c) => c.url.endsWith('/gone'))).toHaveLength(1);
    await owner('push/subscriptions', 'DELETE', { endpoint: flaky.endpoint });
  });
});
