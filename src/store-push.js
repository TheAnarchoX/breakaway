/**
 * TaskStore's push subscriptions (docs/specs/IDEA-12-agent-pings.md): the browsers that asked for notifications, and
 * sending one when a ping needs them. A subscription is an endpoint and two keys; it goes away with the Notifications
 * switch, or when the push service says it's gone (404 or 410). Nothing about a task leaves the board except the
 * encrypted notification text.
 *
 * Each subscription is a person's own (BRK-340, docs/specs/BRK-299-people-and-roles.md, point 3): the owner's, or a
 * person's who turned Notifications on in their signed-in browser. The owner gets every push, as before; a person gets
 * the pings of agents started for them, in repositories they can still see, and the plans they may approve.
 */
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';
import { install } from './install.js';
import { OWNER, can } from './permissions.js';
import { repoSlugOf } from './repos.js';
import { fromB64u, pingMessage, sendPush, vapidKeys } from './push.js';

/** Browsers per person: the owner's five, and five for each person. */
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
    // Whose browser it is (BRK-340): the subscriptions from before people were the owner's, and stay theirs.
    const columns = this.sql
      .exec('PRAGMA table_info(push_subscriptions)')
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('person'))
      this.sql.exec("ALTER TABLE push_subscriptions ADD COLUMN person TEXT NOT NULL DEFAULT 'owner'");
  },

  /**
   * Whether the board can send (the owner has set the key), the public key browsers subscribe with, and how many
   * browsers `person` has subscribed.
   * @param {string} [person] `owner` or a person's handle
   */
  pushConfigApi(person = OWNER) {
    return this.run(async () => {
      const keys = await vapidKeys(this.env, this.homeUrl());
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person = ?', person).one().n;
      return {
        status: 200,
        body: { available: Boolean(keys), publicKey: keys?.publicKey ?? null, subscriptions: count },
      };
    });
  },

  /**
   * Keeps a browser's subscription as `person`'s. A browser someone else subscribed from (a shared computer) becomes
   * the newer person's: one endpoint, one person.
   * @param {any} body
   * @param {string} [person] `owner` or a person's handle
   */
  pushSubscribeApi(body, person = OWNER) {
    return this.run(async () => {
      if (!(await vapidKeys(this.env, this.homeUrl())))
        throw new AgentError('notifications need a key the owner hasn’t set up yet', 409);
      const sub = checkSubscription(body);
      const known =
        this.sql
          .exec('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND person = ?', sub.endpoint, person)
          .toArray().length > 0;
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person = ?', person).one().n;
      if (!known && count >= MAX_SUBSCRIPTIONS)
        throw new AgentError(
          `the board sends to up to ${MAX_SUBSCRIPTIONS} browsers; turn Notifications off in one of them first`,
          409,
        );
      this.sql.exec(
        'INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created, person) VALUES (?, ?, ?, ?, ?)',
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        Date.now(),
        person,
      );
      return { status: 200, body: { ok: true } };
    });
  },

  /** Turns `person`'s browser off; another person's subscription is never theirs to remove. */
  pushUnsubscribeApi(body, person = OWNER) {
    return this.run(() => {
      this.sql.exec(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND person = ?',
        String(body?.endpoint ?? ''),
        person,
      );
      return { status: 200, body: { ok: true } };
    });
  },

  /**
   * Who a ping's push goes to: the owner, and the person the pinging agent's run is for, while they can still see the
   * task's repository. A ping from the board, or from an agent the owner started, is the owner's alone.
   * @param {{ task: string, agent: string }} ping the ping's row
   * @returns {string[]}
   */
  pingPushPeople(ping) {
    const people = [OWNER];
    const person = this.runForPerson(ping.agent);
    if (!person || person === OWNER || !this.personRow(person)) return people;
    const map = this.tasks.get(ping.task);
    const repo = map ? repoSlugOf(map, this.defaultRepoSlug()) : null;
    if (repo && can({ person, grants: this.personGrants(person) }, 'read', repo)) people.push(person);
    return people;
  },

  /** Sends a ping's notification to the browsers of the people it's for. Never throws: a ping must work without push. */
  async pushPing(pingId) {
    try {
      const row = this.sql
        .exec('SELECT id, task, kind, message, agent, resolved FROM pings WHERE id = ?', Number(pingId))
        .toArray()[0];
      if (!row || row.resolved) return;
      await this.pushTo(
        this.pingPushPeople(row),
        pingMessage(
          { id: row.id, kind: row.kind, message: row.message, task: this.tasks.get(row.task)?.wid ?? 'A task' },
          install(this.env).name,
        ),
      );
    } catch {
      /* push is a convenience; the ping and its comment are the record */
    }
  },

  /**
   * Sends one notification to the owner's browsers (a chase's digest).
   * @param {{ title: string, body: string, tag: string, url: string }} message
   */
  async pushToOwner(message) {
    await this.pushTo([OWNER], message);
  },

  /**
   * Sends one notification to every browser `people` subscribed, dropping the ones the push service says are gone and
   * the ones of people who were removed. Never throws: whatever pushes (a ping, a waiting plan) keeps its own record.
   * @param {string[]} people `owner` and people's handles
   * @param {{ title: string, body: string, tag: string, url: string }} message
   */
  async pushTo(people, message) {
    try {
      const keys = await vapidKeys(this.env, this.homeUrl());
      if (!keys) return;
      const gone = this.sql
        .exec("SELECT DISTINCT person FROM push_subscriptions WHERE person != 'owner'")
        .toArray()
        .map((r) => String(r.person))
        .filter((person) => !this.personRow(person));
      for (const person of gone) this.sql.exec('DELETE FROM push_subscriptions WHERE person = ?', person);
      const wanted = new Set(people);
      const subs = this.sql
        .exec('SELECT endpoint, p256dh, auth, person FROM push_subscriptions')
        .toArray()
        .filter((sub) => wanted.has(String(sub.person)));
      if (!subs.length) return;
      const statuses = await Promise.all(subs.map((sub) => sendPush(sub, message, keys)));
      subs.forEach((sub, i) => {
        if (statuses[i] === 404 || statuses[i] === 410)
          this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
      });
      const dropped = statuses.filter((s) => s === 404 || s === 410).length;
      const sent = statuses.filter((s) => s >= 200 && s < 300).length;
      this.connectionsPushSent({ sent, gone: dropped, failed: statuses.length - sent - dropped });
    } catch {
      /* push is a convenience */
    }
  },
};
