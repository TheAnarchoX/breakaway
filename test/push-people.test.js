// People's own notifications (BRK-340, docs/specs/BRK-299-people-and-roles.md, point 3): each person turns push on
// for their own browsers, and gets the pushes meant for them. Fixtures are made-up people and push endpoints.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { toB64u } from '../src/push.js';

const unique = (base) => `${base}${Math.random().toString(36).slice(2, 8)}`;
const storeRun = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);

/** A request with a cookie or a bearer token, from the board's own origin. */
function call(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0] ?? null;

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return cookieOf(res);
}

/** Invites a person with `grants` and has them join: their handle and their signed-in cookie. */
async function person(owner, base, grants) {
  const handle = unique(base);
  const made = await call('/api/people/invites', { method: 'POST', cookie: owner, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: base, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const res = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential, passkeyName: 'Phone' },
  });
  expect(res.status).toBe(201);
  return { handle, cookie: cookieOf(res) };
}

/** A browser's subscription: a real P-256 key and auth secret, so the board can encrypt to it. */
async function browser(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh: toB64u(p256dh), auth: toB64u(crypto.getRandomValues(new Uint8Array(16))) } };
}

const subscribe = async (cookie, sub) =>
  call('/api/push/subscriptions', { method: 'POST', cookie, body: { endpoint: sub.endpoint, keys: sub.keys } });

/** Stands in for the push service: records the endpoint of each message. */
function pushService() {
  const sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith('https://push.example.com/')) throw new Error(`unexpected fetch to ${url}`);
    sent.push(url);
    return new Response(null, { status: 201 });
  });
  return sent;
}

/** A task claimed by `agent`, whose run the board started for `forPerson`. Its work ID. */
async function heldFor(agent, forPerson, description) {
  const made = await api('tasks', {
    method: 'POST',
    body: { description, project: 'cloud', horizon: 'now', who: 'agent' },
  });
  const answer = await made.json();
  if (!answer.tasks) throw new Error(JSON.stringify(answer));
  const { wid, uuid } = answer.tasks[0];
  await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
  await storeRun((s) =>
    s.sql.exec(
      "INSERT INTO agent_runs (task, agent, trigger, status, started, for_person) VALUES (?, ?, 'manual', 'started', ?, ?)",
      uuid,
      agent,
      Date.now(),
      forPerson,
    ),
  );
  return wid;
}

/** A second repository, so a person can hold a grant somewhere they can't see the widgets. */
let registered = false;
async function elsewhere() {
  if (!registered) {
    const res = await api('repos', {
      method: 'POST',
      body: { slug: 'pushgadgets', github: 'acme/pushgadgets', areas: ['product:PGD'] },
    });
    expect(res.status).toBe(201);
    registered = true;
  }
  return 'pushgadgets';
}

const ping = (wid, by) =>
  api(`tasks/${wid}/pings`, { method: 'POST', body: { by, kind: 'blocked', message: 'Needs a hand.' } });

afterEach(async () => {
  vi.restoreAllMocks();
  await storeRun((s) =>
    s.sql.exec("DELETE FROM push_subscriptions WHERE endpoint LIKE 'https://push.example.com/people/%'"),
  );
});

describe('a person’s own notifications', () => {
  it('are turned on and off from their signed-in browser, never their token, and counted as theirs', async () => {
    const owner = await ownerCookie();
    const ana = await person(owner, 'ana', [{ repository: 'widgets', role: 'viewer' }]);
    const sub = await browser(`https://push.example.com/people/${ana.handle}`);
    const tokenRes = await call('/api/me/tokens', { method: 'POST', cookie: ana.cookie, body: { name: 'cli' } });
    const { token } = await tokenRes.json();
    expect((await call('/api/push', { token })).status).toBe(403);
    expect((await call('/api/push/subscriptions', { method: 'POST', token, body: sub })).status).toBe(403);

    expect((await call('/api/push', { cookie: ana.cookie })).status).toBe(200);
    expect((await subscribe(ana.cookie, sub)).status).toBe(200);
    const theirs = await (await call('/api/push', { cookie: ana.cookie })).json();
    expect(theirs).toMatchObject({ available: true, publicKey: env.TASKS_VAPID_PUBLIC, subscriptions: 1 });
    // The owner's count is the owner's browsers, and the owner can't turn ana's off.
    const before = (await (await call('/api/push', { cookie: owner })).json()).subscriptions;
    await call('/api/push/subscriptions', { method: 'DELETE', cookie: owner, body: { endpoint: sub.endpoint } });
    expect((await (await call('/api/push', { cookie: ana.cookie })).json()).subscriptions).toBe(1);
    expect((await (await call('/api/push', { cookie: owner })).json()).subscriptions).toBe(before);

    expect(
      (
        await call('/api/push/subscriptions', {
          method: 'DELETE',
          cookie: ana.cookie,
          body: { endpoint: sub.endpoint },
        })
      ).status,
    ).toBe(200);
    expect((await (await call('/api/push', { cookie: ana.cookie })).json()).subscriptions).toBe(0);
  });

  it('allow five browsers each, apart from the owner’s', async () => {
    const owner = await ownerCookie();
    const ben = await person(owner, 'ben', [{ repository: 'widgets', role: 'member' }]);
    const subs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => browser(`https://push.example.com/people/${ben.handle}-${i}`)),
    );
    for (const sub of subs.slice(0, 5)) expect((await subscribe(ben.cookie, sub)).status).toBe(200);
    expect((await subscribe(ben.cookie, subs[5])).status).toBe(409);
    const ownerSub = await browser('https://push.example.com/people/owner-beside-ben');
    expect((await subscribe(owner, ownerSub)).status).toBe(200);
  });
});

describe('who a push goes to', () => {
  it('sends a ping to the owner and to the person the agent was started for, while they can see it', async () => {
    const owner = await ownerCookie();
    const ana = await person(owner, 'ana', [{ repository: 'widgets', role: 'member' }]);
    const anaSub = await browser(`https://push.example.com/people/${ana.handle}`);
    const ownerSub = await browser('https://push.example.com/people/owner');
    await subscribe(ana.cookie, anaSub);
    await subscribe(owner, ownerSub);
    const sent = pushService();

    // An agent started for ana: both get it.
    const agent = unique('claude-ana-');
    expect((await ping(await heldFor(agent, ana.handle, 'Paint the fence blue'), agent)).status).toBe(201);
    await vi.waitFor(() => expect(sent.toSorted()).toEqual([anaSub.endpoint, ownerSub.endpoint].toSorted()));

    // An agent the owner started: the owner's alone, as before.
    sent.length = 0;
    const owners = unique('claude-own-');
    await ping(await heldFor(owners, 'owner', 'Tune the orchestra quietly'), owners);
    await vi.waitFor(() => expect(sent).toEqual([ownerSub.endpoint]));

    // Once ana can't see the repository, her agent's pings stop reaching her.
    sent.length = 0;
    await call(`/api/people/${ana.handle}`, {
      method: 'PATCH',
      cookie: owner,
      body: { grants: [{ repository: await elsewhere(), role: 'member' }] },
    });
    const later = unique('claude-ana-');
    await ping(await heldFor(later, ana.handle, 'Count migrating geese'), later);
    await vi.waitFor(() => expect(sent).toEqual([ownerSub.endpoint]));
  });

  it('drops a removed person’s browsers', async () => {
    const owner = await ownerCookie();
    const cy = await person(owner, 'cy', [{ repository: '*', role: 'member' }]);
    const sub = await browser(`https://push.example.com/people/${cy.handle}`);
    await subscribe(cy.cookie, sub);
    expect((await call(`/api/people/${cy.handle}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    const sent = pushService();
    const agent = unique('claude-cy-');
    await ping(await heldFor(agent, cy.handle, 'Polish brass lanterns'), agent);
    await vi.waitFor(() =>
      storeRun((s) =>
        expect(s.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person = ?', cy.handle).one().n).toBe(0),
      ),
    );
    expect(sent).not.toContain(sub.endpoint);
  });

  it('sends a waiting plan to the owner and everyone who may approve it, not to who may not', async () => {
    const owner = await ownerCookie();
    const keeper = await person(owner, 'kim', [{ repository: 'widgets', role: 'maintainer' }]);
    const member = await person(owner, 'mo', [{ repository: 'widgets', role: 'member' }]);
    const other = await person(owner, 'eli', [{ repository: await elsewhere(), role: 'maintainer' }]);
    const people = await storeRun((s) => {
      s.planRow = () => ({ n: 987654, environment: 987654, repo: 'widgets' });
      return s.planPushPeople({ id: 'plan-987654' });
    });
    expect(people).toContain('owner');
    expect(people).toContain(keeper.handle);
    expect(people).not.toContain(member.handle);
    expect(people).not.toContain(other.handle);
  });

  it('words a person’s ping push as their read of it: hidden work IDs and repositories taken out', async () => {
    const owner = await ownerCookie();
    const repo = await elsewhere();
    const ana = await person(owner, 'ana', [{ repository: 'widgets', role: 'member' }]);
    const made = await api('tasks', {
      method: 'POST',
      body: { description: 'Sort hidden gadget crates', repo, project: 'product', horizon: 'now', who: 'agent' },
    });
    const hidden = (await made.json()).tasks[0].wid;
    const agent = unique('claude-ana-');
    const wid = await heldFor(agent, ana.handle, 'Weigh the copper kettles');
    const res = await api(`tasks/${wid}/pings`, {
      method: 'POST',
      body: { by: agent, kind: 'blocked', message: `Waits for ${hidden} first.` },
    });
    const { ping: made2 } = await res.json();
    const seen = await storeRun(async (s) => {
      let got = null;
      const real = s.pushTo;
      s.pushTo = async (people, message) => {
        got = { people, owner: message('owner'), ana: message(ana.handle) };
      };
      try {
        await s.pushPing(made2.id);
      } finally {
        s.pushTo = real;
      }
      return got;
    });
    expect(seen.people).toEqual(['owner', ana.handle]);
    expect(seen.owner.body).toBe(`${wid} needs you: blocked\nWaits for ${hidden} first.`);
    expect(seen.ana.body).toBe(`${wid} needs you: blocked\nWaits for a task you can’t see first.`);

    const ref = await api(`tasks/${wid}/pings`, {
      method: 'POST',
      body: { by: agent, kind: 'question', message: 'See acme/pushgadgets#12 for why.' },
    });
    const { ping: third } = await ref.json();
    const line = await storeRun(async (s) => {
      let got = null;
      const real = s.pushTo;
      s.pushTo = async (_people, message) => {
        got = message(ana.handle);
      };
      try {
        await s.pushPing(third.id);
      } finally {
        s.pushTo = real;
      }
      return got;
    });
    expect(line.body).toBe(`${wid} needs you: question`);
  });

  it('ends a person’s browsers with the session that turned them on: sign out and Reset', async () => {
    const owner = await ownerCookie();
    const dee = await person(owner, 'dee', [{ repository: 'widgets', role: 'member' }]);
    const sub = await browser(`https://push.example.com/people/${dee.handle}`);
    await subscribe(dee.cookie, sub);
    const count = () =>
      storeRun((s) => {
        s.pushPrune();
        return s.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person = ?', dee.handle).one().n;
      });
    expect(await count()).toBe(1);
    await SELF.fetch(`${ORIGIN}/logout`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: dee.cookie } });
    expect(await count()).toBe(0);

    const eve = await person(owner, 'eve', [{ repository: 'widgets', role: 'member' }]);
    const other = await browser(`https://push.example.com/people/${eve.handle}`);
    await subscribe(eve.cookie, other);
    expect(await (await call(`/api/people/${eve.handle}/reset`, { method: 'POST', cookie: owner })).status).toBe(200);
    expect(
      await storeRun((s) => {
        s.pushPrune();
        return s.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person = ?', eve.handle).one().n;
      }),
    ).toBe(0);
  });

  it('keeps a browser with whoever turned it on until someone presses the switch there', async () => {
    const owner = await ownerCookie();
    const fay = await person(owner, 'fay', [{ repository: 'widgets', role: 'member' }]);
    const sub = await browser('https://push.example.com/people/shared-browser');
    await subscribe(owner, sub);
    const holder = () =>
      storeRun(
        (s) => s.sql.exec('SELECT person FROM push_subscriptions WHERE endpoint = ?', sub.endpoint).one().person,
      );
    // The page's own re-save when fay loads the board there leaves it the owner's.
    const refresh = await call('/api/push/subscriptions', {
      method: 'POST',
      cookie: fay.cookie,
      body: { endpoint: sub.endpoint, keys: sub.keys, refresh: true },
    });
    expect(await refresh.json()).toEqual({ ok: true, mine: false });
    expect(await holder()).toBe('owner');
    // Her press takes it.
    expect(await (await subscribe(fay.cookie, sub)).json()).toEqual({ ok: true, mine: true });
    expect(await holder()).toBe(fay.handle);
  });
});
