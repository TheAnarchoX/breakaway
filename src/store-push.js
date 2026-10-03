/**
 * TaskStore's push subscriptions (docs/specs/IDEA-12-agent-pings.md): the owner's browsers that asked for
 * notifications, and sending one when a ping needs them. A subscription is an endpoint and two keys; it
 * goes away with the Notifications switch, or when the push service says it's gone (404 or 410).
 * Nothing about a task leaves the board except the encrypted notification text.
 */
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';
import { install } from './install.js';
import { fromB64u, pingMessage, sendPush, vapidKeys } from './push.js';

export const MAX_SUBSCRIPTIONS = 5;
const MAX_ENDPOINT = 2048;
const IP_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/u;

/** A subscription the browser gave us, checked: an https endpoint on a real host, and keys of the right size. */
function checkSubscription(body) {
  const endpoint = String(body?.endpoint ?? '');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InputError('the subscription needs an endpoint');
  }
  if (
    endpoint.length > MAX_ENDPOINT ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    IP_HOST.test(url.hostname) ||
    url.hostname === 'localhost' ||
    !url.hostname.includes('.')
  ) {
    throw new InputError('that push endpoint isn’t one the board will send to');
  }
  const keys = body?.keys ?? {};
  const size = (value) => {
    try {
      return fromB64u(String(value)).length;
    } catch {
      return -1;
    }
  };
  if (size(keys.p256dh) !== 65 || size(keys.auth) !== 16) throw new InputError('the subscription’s keys are wrong');
  return { endpoint, p256dh: String(keys.p256dh).trim(), auth: String(keys.auth).trim() };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const pushMethods = {
  initPush() {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL)',
    );
  },

  /** Whether the board can send (the owner has set the key) and the public key browsers subscribe with. */
  pushConfigApi() {
    return this.run(async () => {
      const keys = await vapidKeys(this.env, this.homeUrl());
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions').one().n;
      return {
        status: 200,
        body: { available: Boolean(keys), publicKey: keys?.publicKey ?? null, subscriptions: count },
      };
    });
  },

  pushSubscribeApi(body) {
    return this.run(async () => {
      if (!(await vapidKeys(this.env, this.homeUrl())))
        throw new AgentError('notifications need a key the owner hasn’t set up yet', 409);
      const sub = checkSubscription(body);
      const known =
        this.sql.exec('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', sub.endpoint).toArray().length > 0;
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions').one().n;
      if (!known && count >= MAX_SUBSCRIPTIONS)
        throw new AgentError(
          `the board sends to up to ${MAX_SUBSCRIPTIONS} browsers; turn Notifications off in one of them first`,
          409,
        );
      this.sql.exec(
        'INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?)',
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        Date.now(),
      );
      return { status: 200, body: { ok: true } };
    });
  },

  pushUnsubscribeApi(body) {
    return this.run(() => {
      this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', String(body?.endpoint ?? ''));
      return { status: 200, body: { ok: true } };
    });
  },

  /** Sends a ping's notification to every subscription. Never throws: a ping must work without push. */
  async pushPing(pingId) {
    try {
      const keys = await vapidKeys(this.env, this.homeUrl());
      if (!keys) return;
      const subs = this.sql.exec('SELECT endpoint, p256dh, auth FROM push_subscriptions').toArray();
      if (!subs.length) return;
      const row = this.sql
        .exec('SELECT id, task, kind, message, resolved FROM pings WHERE id = ?', Number(pingId))
        .toArray()[0];
      if (!row || row.resolved) return;
      const message = pingMessage(
        { id: row.id, kind: row.kind, message: row.message, task: this.tasks.get(row.task)?.wid ?? 'A task' },
        install(this.env).name,
      );
      const statuses = await Promise.all(subs.map((sub) => sendPush(sub, message, keys)));
      subs.forEach((sub, i) => {
        if (statuses[i] === 404 || statuses[i] === 410)
          this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
      });
      const gone = statuses.filter((s) => s === 404 || s === 410).length;
      const sent = statuses.filter((s) => s >= 200 && s < 300).length;
      this.connectionsPushSent({ sent, gone, failed: statuses.length - sent - gone });
    } catch {
      /* push is a convenience; the ping and its comment are the record */
    }
  },
};
