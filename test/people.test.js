// People sign in (BRK-300, docs/specs/BRK-299-people-and-roles.md, points 1, 2, and 9): invites, passkeys, personal
// tokens, sessions, Reset, and the board's token always the owner. Fixtures are made-up people (ana, ben).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import workerSource from '../src/worker.js?raw';
import { NOT_YET } from '../src/people.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const COOKIE = '__Host-sw_tasks';

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toBe('/');
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** A request with a cookie (the owner's or a person's) or a bearer token, from the board's own origin. */
function call(path, { method = 'GET', body, cookie, token, origin = ORIGIN } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function invite(owner, grants = [{ repository: '*', role: 'member' }], days) {
  const res = await call('/api/people/invites', {
    method: 'POST',
    cookie: owner,
    body: { grants, ...(days ? { days } : {}) },
  });
  expect(res.status).toBe(201);
  return (await res.json()).invite;
}

const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0] ?? null;

/** Opens an invite as a new person and makes their first passkey; gives back their cookie and the response. */
async function join(code, { name = 'Ana', handle = 'ana', authenticator, createWith = {} } = {}) {
  const auth = authenticator ?? (await makeAuthenticator());
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name, handle } });
  if (options.status !== 200) return { res: options, auth };
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey, createWith);
  const res = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential, passkeyName: 'Laptop' },
  });
  return { res, auth, cookie: res.status === 201 ? cookieOf(res) : null };
}

async function signIn(auth, getWith = {}) {
  const options = await call('/api/signin/options', { method: 'POST', body: {} });
  expect(options.status).toBe(200);
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.get(publicKey, getWith);
  const res = await call('/api/signin', { method: 'POST', body: { challengeId, credential } });
  return { res, cookie: res.status === 200 ? cookieOf(res) : null };
}

const session = (cookie) => call('/api/session', { cookie });
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 8)}`;

/** The owner's token still signs in as the owner, after whatever a test did. */
async function ownerStillSignsIn() {
  const owner = await ownerCookie();
  const res = await session(owner);
  expect(res.status).toBe(200);
  expect((await res.json()).via).toBe('cookie');
  const bearer = await call('/api/session', { token: TEST_API_TOKEN });
  expect((await bearer.json()).via).toBe('token');
}

function storeRun(fn) {
  return runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
}

describe('an install with nobody invited', () => {
  it('behaves as today: no passkeys to offer, nobody in People, and the token is the owner', async () => {
    expect(await (await call('/api/signin')).json()).toEqual({ passkeys: false });
    const owner = await ownerCookie();
    const people = await call('/api/people', { cookie: owner });
    expect(people.status).toBe(200);
    expect(await people.json()).toEqual({ people: [], invites: [] });
    await ownerStillSignsIn();
  });
});

describe('invites', () => {
  it('are the owner’s, made on the signed-in board', async () => {
    const res = await call('/api/people/invites', {
      method: 'POST',
      token: TEST_API_TOKEN,
      body: { grants: [{ repository: '*', role: 'member' }] },
    });
    expect(res.status).toBe(403);
    const owner = await ownerCookie();
    const fromElsewhere = await call('/api/people/invites', {
      method: 'POST',
      cookie: owner,
      origin: 'https://evil.example',
      body: { grants: [{ repository: '*', role: 'member' }] },
    });
    expect(fromElsewhere.status).toBe(403);
  });

  it('check the grants and how long they last', async () => {
    const owner = await ownerCookie();
    const bad = async (body) => (await call('/api/people/invites', { method: 'POST', cookie: owner, body })).status;
    expect(await bad({ grants: [] })).toBe(400);
    expect(await bad({ grants: [{ repository: 'nowhere', role: 'member' }] })).toBe(400);
    expect(await bad({ grants: [{ repository: '*', role: 'owner' }] })).toBe(400);
    expect(
      await bad({
        grants: [
          { repository: '*', role: 'member' },
          { repository: '*', role: 'viewer' },
        ],
      }),
    ).toBe(400);
    expect(await bad({ grants: [{ repository: '*', role: 'viewer' }], days: 31 })).toBe(400);
    expect(await bad({ grants: [{ repository: '*', role: 'viewer' }], days: 0 })).toBe(400);
  });

  it('make a one-time link: opened once, it adds the person with the grants, signs them in, and is used up', async () => {
    const owner = await ownerCookie();
    const made = await invite(owner, [{ repository: '*', role: 'viewer' }], 3);
    expect(made.code).toMatch(/^[\w-]{43}$/u);
    expect(made.state).toBe('open');
    expect(Date.parse(made.expires) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);

    const info = await call(`/api/join/${made.code}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      invitedBy: 'owner',
      grants: [{ repository: '*', role: 'viewer' }],
      person: null,
    });

    const handle = unique('ana');
    const { res, cookie } = await join(made.code, { name: '  Ana   Lima ', handle });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, person: { handle, name: 'Ana Lima' } });
    expect(res.headers.get('Set-Cookie')).toMatch(
      /^__Host-sw_tasks=p[\w-]+\.[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/u,
    );
    const me = await session(cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ via: 'person-cookie', person: { handle, name: 'Ana Lima' } });

    // Used: the link says so, and a second person can't use it.
    const again = await call(`/api/join/${made.code}`);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ state: 'used' });
    expect((await join(made.code, { handle: unique('ben') })).res.status).toBe(410);

    const list = await (await call('/api/people', { token: TEST_API_TOKEN })).json();
    const ana = list.people.find((p) => p.handle === handle);
    expect(ana).toMatchObject({
      name: 'Ana Lima',
      grants: [{ repository: '*', role: 'viewer' }],
      invitedBy: 'owner',
      passkeys: 1,
    });
    expect(list.invites.find((i) => i.id === made.id).state).toBe('used');
    expect(JSON.stringify(list)).not.toContain(made.code);
    expect(await (await call('/api/signin')).json()).toEqual({ passkeys: true });
    await ownerStillSignsIn();
  });

  it('can be revoked, and run out', async () => {
    const owner = await ownerCookie();
    const revoked = await invite(owner);
    expect((await call(`/api/people/invites/${revoked.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    expect((await call(`/api/people/invites/${revoked.id}`, { method: 'DELETE', cookie: owner })).status).toBe(409);
    const r = await call(`/api/join/${revoked.code}`);
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({ state: 'revoked' });
    expect((await join(revoked.code, { handle: unique('ana') })).res.status).toBe(410);

    const expired = await invite(owner);
    await storeRun(async (s) => {
      s.sql.exec('UPDATE invites SET expires = ? WHERE id = ?', Date.now() - 1, expired.id);
    });
    const e = await call(`/api/join/${expired.code}`);
    expect(e.status).toBe(410);
    expect(await e.json()).toMatchObject({ state: 'expired' });

    expect((await call('/api/join/not-a-real-code-at-all-not-at-all')).status).toBe(404);
  });

  it('refuse a handle that’s taken, or one an agent or the board uses', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    expect((await join((await invite(owner)).code, { handle })).res.status).toBe(201);
    const next = (await invite(owner)).code;
    for (const taken of [
      handle,
      'owner',
      'board',
      'routine',
      'claude-brk-1',
      'codex-x',
      'Ana',
      '1ana',
      'a'.repeat(33),
      'ana_b',
    ])
      expect((await join(next, { handle: taken })).res.status, taken).toBeGreaterThanOrEqual(400);
    expect((await join(next, { handle: unique('ben'), name: '' })).res.status).toBe(400);
    expect((await join(next, { handle: unique('ben') })).res.status).toBe(201);
  });

  it('use the invite once, even when two people open it together', async () => {
    const owner = await ownerCookie();
    const { code } = await invite(owner);
    const a = await makeAuthenticator();
    const b = await makeAuthenticator();
    const optionsA = await (
      await call(`/api/join/${code}/options`, { method: 'POST', body: { name: 'A', handle: unique('a') } })
    ).json();
    const optionsB = await (
      await call(`/api/join/${code}/options`, { method: 'POST', body: { name: 'B', handle: unique('b') } })
    ).json();
    const [ra, rb] = await Promise.all([
      call(`/api/join/${code}`, {
        method: 'POST',
        body: { challengeId: optionsA.challengeId, credential: await a.create(optionsA.publicKey) },
      }),
      call(`/api/join/${code}`, {
        method: 'POST',
        body: { challengeId: optionsB.challengeId, credential: await b.create(optionsB.publicKey) },
      }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 410]);
  });
});

describe('passkeys', () => {
  it('sign a person in with the passkey they made, and count its uses', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    const { auth } = await join((await invite(owner)).code, { handle });
    const { res, cookie } = await signIn(auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, person: { handle, name: 'Ana' } });
    expect((await (await session(cookie)).json()).person.handle).toBe(handle);
    // A copied passkey: its count went backwards.
    const copied = await signIn(auth, { count: 1 });
    expect(copied.res.status).toBe(401);
    expect((await copied.res.json()).error).toMatch(/copied/u);
  });

  it('work with EdDSA and with passkeys that don’t count', async () => {
    const owner = await ownerCookie();
    const auth = await makeAuthenticator({ alg: -8, counter: 0 });
    expect((await join((await invite(owner)).code, { handle: unique('ana'), authenticator: auth })).res.status).toBe(
      201,
    );
    expect((await signIn(auth)).res.status).toBe(200);
    expect((await signIn(auth)).res.status).toBe(200);
  });

  it('refuse one made for another site, without the person’s check, or answering another challenge', async () => {
    const owner = await ownerCookie();
    const { code } = await invite(owner);
    const elsewhere = await join(code, { handle: unique('ana'), createWith: { origin: 'https://evil.example' } });
    expect(elsewhere.res.status).toBe(400);
    expect((await elsewhere.res.json()).error).toMatch(/another site/u);
    expect((await join(code, { handle: unique('ana'), createWith: { rpId: 'evil.example' } })).res.status).toBe(400);
    const unverified = await join(code, { handle: unique('ana'), createWith: { flags: 0x41 } });
    expect(unverified.res.status).toBe(400);
    expect((await unverified.res.json()).error).toMatch(/check it was you/u);

    const handle = unique('ana');
    const { auth } = await join(code, { handle });
    expect((await signIn(auth, { flags: 0x01 })).res.status).toBe(401);
    expect((await signIn(auth, { origin: 'https://evil.example' })).res.status).toBe(401);

    // A challenge works once, and only the one it was made for.
    const options = await (await call('/api/signin/options', { method: 'POST', body: {} })).json();
    const credential = await auth.get(options.publicKey);
    expect(
      (await call('/api/signin', { method: 'POST', body: { challengeId: options.challengeId, credential } })).status,
    ).toBe(200);
    expect(
      (await call('/api/signin', { method: 'POST', body: { challengeId: options.challengeId, credential } })).status,
    ).toBe(400);
    const other = await (await call('/api/signin/options', { method: 'POST', body: {} })).json();
    expect(
      (await call('/api/signin', { method: 'POST', body: { challengeId: other.challengeId, credential } })).status,
    ).toBe(401);
  });

  it('refuse a passkey the board doesn’t know, and a sign-in posted from another site', async () => {
    const stranger = await makeAuthenticator();
    const options = await (await call('/api/signin/options', { method: 'POST', body: {} })).json();
    const res = await call('/api/signin', {
      method: 'POST',
      body: { challengeId: options.challengeId, credential: await stranger.get(options.publicKey) },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(
      (await call('/api/signin/options', { method: 'POST', body: {}, origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await call('/api/signin/options', { method: 'POST', body: {}, origin: null })).status).toBe(403);
  });

  it('a person adds, renames, and removes any but their last', async () => {
    const owner = await ownerCookie();
    const { cookie } = await join((await invite(owner)).code, { handle: unique('ana') });
    const second = await makeAuthenticator();
    const options = await call('/api/me/passkeys/options', { method: 'POST', cookie, body: {} });
    expect(options.status).toBe(200);
    const { challengeId, publicKey } = await options.json();
    expect(publicKey.excludeCredentials).toHaveLength(1);
    expect(publicKey.authenticatorSelection.userVerification).toBe('required');
    expect(publicKey.attestation).toBe('none');
    const added = await call('/api/me/passkeys', {
      method: 'POST',
      cookie,
      body: { challengeId, credential: await second.create(publicKey), name: 'Phone' },
    });
    expect(added.status).toBe(201);
    expect((await signIn(second)).res.status).toBe(200);

    const me = await (await call('/api/me', { cookie })).json();
    expect(me.passkeys.map((p) => p.name)).toEqual(['Laptop', 'Phone']);
    const [first, phone] = me.passkeys;
    expect(
      (await call(`/api/me/passkeys/${phone.id}`, { method: 'PATCH', cookie, body: { name: 'Old phone' } })).status,
    ).toBe(200);
    expect((await call(`/api/me/passkeys/${first.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    const last = await call(`/api/me/passkeys/${phone.id}`, { method: 'DELETE', cookie });
    expect(last.status).toBe(409);
  });
});

describe('personal tokens', () => {
  it('are shown once, read the person’s own settings, and stop working once revoked', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    const { cookie } = await join((await invite(owner)).code, { handle });
    const made = await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'laptop' } });
    expect(made.status).toBe(201);
    const { id, token } = await made.json();
    expect(token).toMatch(/^bkp_[\w-]{43}$/u);

    const me = await (await call('/api/me', { cookie })).json();
    expect(me.tokens).toEqual([expect.objectContaining({ id, name: 'laptop' })]);
    expect(JSON.stringify(me)).not.toContain(token);

    const viaToken = await call('/api/session', { token });
    expect(await viaToken.json()).toMatchObject({ via: 'person-token', person: { handle } });
    expect((await call('/api/me', { token })).status).toBe(200);
    // A token can't make itself company: no new tokens, passkeys, or sessions ended with it.
    expect((await call('/api/me/tokens', { method: 'POST', token, body: { name: 'more' } })).status).toBe(403);
    expect((await call(`/api/me/tokens/${id}`, { method: 'DELETE', token })).status).toBe(403);
    // Nor can it sign in to the web board.
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    expect(login.headers.get('Location')).toBe('/?signin=failed');

    expect((await call(`/api/me/tokens/${id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call('/api/session', { token })).status).toBe(401);
    await ownerStillSignsIn();
  });

  it('don’t open /mcp yet', async () => {
    const owner = await ownerCookie();
    const { cookie } = await join((await invite(owner)).code, { handle: unique('ana') });
    const { token } = await (await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'mcp' } })).json();
    const rpc = (headers) =>
      SELF.fetch(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const res = await rpc({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/personal tokens/u);
    expect((await rpc({ Cookie: cookie })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('sign out here, or everywhere', async () => {
    const owner = await ownerCookie();
    const { cookie, auth } = await join((await invite(owner)).code, { handle: unique('ana') });
    const second = (await signIn(auth)).cookie;
    const third = (await signIn(auth)).cookie;
    const me = await (await call('/api/me', { cookie: second })).json();
    expect(me.sessions).toHaveLength(3);
    expect(me.sessions.filter((s) => s.current)).toHaveLength(1);

    // /logout ends that session on the board, not only in the browser.
    const out = await SELF.fetch(`${ORIGIN}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, Cookie: third },
    });
    expect(out.headers.get('Set-Cookie')).toMatch(/Max-Age=0/u);
    expect((await session(third)).status).toBe(401);

    const everywhere = await call('/api/me/sessions', { method: 'DELETE', cookie });
    expect(everywhere.status).toBe(200);
    expect(everywhere.headers.get('Set-Cookie')).toMatch(/Max-Age=0/u);
    expect((await session(cookie)).status).toBe(401);
    expect((await session(second)).status).toBe(401);
    await ownerStillSignsIn();
  });

  it('refuse a forged or run-out session, and changes from another site', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    const { cookie } = await join((await invite(owner)).code, { handle });
    const [id] = cookie.slice(COOKIE.length + 2).split('.');
    expect((await session(`${COOKIE}=p${id}.${'A'.repeat(43)}`)).status).toBe(401);
    const cross = await call('/api/me', {
      method: 'PATCH',
      cookie,
      body: { name: 'X' },
      origin: 'https://evil.example',
    });
    expect(cross.status).toBe(403);
    expect((await call('/api/me', { method: 'PATCH', cookie, body: { name: 'Ana B' } })).status).toBe(200);
    await storeRun(async (s) => {
      s.sql.exec('UPDATE sessions SET expires = ? WHERE handle = ?', Date.now() - 1, handle);
    });
    expect((await session(cookie)).status).toBe(401);
  });
});

describe('Reset and remove', () => {
  it('Reset revokes everything and makes a new link that gives the same person back', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    const { cookie, auth } = await join((await invite(owner, [{ repository: '*', role: 'maintainer' }])).code, {
      handle,
    });
    const { token } = await (await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } })).json();

    expect((await call(`/api/people/${handle}/reset`, { method: 'POST', token: TEST_API_TOKEN })).status).toBe(403);
    const reset = await call(`/api/people/${handle}/reset`, { method: 'POST', cookie: owner });
    expect(reset.status).toBe(200);
    const { invite: link, person } = await reset.json();
    expect(person).toMatchObject({ handle, passkeys: 0, tokens: 0, sessions: 0 });
    expect(link).toMatchObject({ person: handle, grants: [{ repository: '*', role: 'maintainer' }], state: 'open' });

    expect((await session(cookie)).status).toBe(401);
    expect((await call('/api/session', { token })).status).toBe(401);
    expect((await signIn(auth)).res.status).toBe(401);

    const info = await (await call(`/api/join/${link.code}`)).json();
    expect(info.person).toEqual({ handle, name: 'Ana' });
    // The handle and name are the person's: what the form sends is ignored.
    const back = await join(link.code, { handle: 'someone-else', name: 'Someone' });
    expect(back.res.status).toBe(201);
    expect(await back.res.json()).toEqual({ ok: true, person: { handle, name: 'Ana' } });
    const list = await (await call('/api/people', { cookie: owner })).json();
    expect(list.people.find((p) => p.handle === handle).grants).toEqual([{ repository: '*', role: 'maintainer' }]);
    await ownerStillSignsIn();
  });

  it('a second Reset revokes the first one’s link', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    await join((await invite(owner)).code, { handle });
    const first = (await (await call(`/api/people/${handle}/reset`, { method: 'POST', cookie: owner })).json()).invite;
    await call(`/api/people/${handle}/reset`, { method: 'POST', cookie: owner });
    expect((await call(`/api/join/${first.code}`)).status).toBe(410);
  });

  it('remove signs the person out for good and keeps their handle from anyone else', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    const { cookie, auth } = await join((await invite(owner)).code, { handle });
    expect((await call(`/api/people/${handle}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    expect((await session(cookie)).status).toBe(401);
    expect((await signIn(auth)).res.status).toBe(401);
    expect((await call(`/api/people/${handle}/reset`, { method: 'POST', cookie: owner })).status).toBe(404);
    expect((await join((await invite(owner)).code, { handle })).res.status).toBe(409);
    const list = await (await call('/api/people', { cookie: owner })).json();
    expect(list.people.find((p) => p.handle === handle)).toMatchObject({ grants: [], removed: expect.any(String) });
    await ownerStillSignsIn();
  });

  it('grants change on the owner’s press', async () => {
    const owner = await ownerCookie();
    const handle = unique('ana');
    await join((await invite(owner)).code, { handle });
    const grants = [{ repository: '*', role: 'viewer' }];
    expect(
      (await call(`/api/people/${handle}`, { method: 'PATCH', token: TEST_API_TOKEN, body: { grants } })).status,
    ).toBe(403);
    const res = await call(`/api/people/${handle}`, { method: 'PATCH', cookie: owner, body: { grants } });
    expect(res.status).toBe(200);
    expect((await res.json()).person.grants).toEqual(grants);
    expect((await call('/api/people/nobody-here', { method: 'PATCH', cookie: owner, body: { grants } })).status).toBe(
      404,
    );
  });
});

describe('deny by default: reads until BRK-323, and writes by role since BRK-301', () => {
  // Every first path segment the API routes on, read from the Worker's own source, so a route added later is covered.
  const segments = [...new Set([...workerSource.matchAll(/parts\[0\] === '([\w-]+)'/gu)].map((m) => m[1]))].filter(
    (s) => !['session', 'me', 'signin', 'join'].includes(s),
  );

  it('finds the routes it checks', () => {
    for (const s of ['tasks', 'github', 'infra', 'agents', 'routines', 'repos', 'features', 'oauth', 'admin'])
      expect(segments).toContain(s);
  });

  it('refuses a viewer’s cookie and personal token every read and every write, the owner’s cookie-only ones included', async () => {
    const owner = await ownerCookie();
    const { cookie } = await join((await invite(owner, [{ repository: 'widgets', role: 'viewer' }])).code, {
      handle: unique('ana'),
    });
    const { token } = await (await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } })).json();
    // Every route the Worker has sits under one of these segments; the gate is ahead of all of them.
    const tails = ['', '/1/approve'];
    const passed = [];
    let tries = 0;
    for (const segment of [...segments, 'people'])
      for (const tail of tails)
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE'])
          for (const credential of [{ cookie }, { token }]) {
            tries++;
            const res = await call(`/api/${segment}${tail}`, {
              method,
              ...credential,
              body: method === 'GET' ? undefined : {},
            });
            const body = await res.json().catch(() => ({}));
            // A read waits for BRK-323. A write is the viewer's role's to answer: it changes nothing, and asking for
            // the next task is a read (src/permissions.js).
            const read = method === 'GET' || segment === 'next';
            if (read ? method === 'GET' && (res.status !== 403 || body.error !== NOT_YET) : res.status < 400)
              passed.push(`${method} /api/${segment}${tail} ${res.status}`);
            if (res.status >= 500) passed.push(`${method} /api/${segment}${tail} ${res.status}`);
          }
    expect(passed).toEqual([]);
    expect(tries).toBeGreaterThan(400);
    await ownerStillSignsIn();
  }, 90_000);

  // The owner's cookie-only gates today (`via !== 'cookie'` and `via === 'cookie'` in src/worker.js), one request each.
  const COOKIE_GATED = [
    ['POST', '/api/kickoffs/IDEA-1/images'],
    ['POST', '/api/planning/1/undo'],
    ['POST', '/api/connections/check'],
    ['POST', '/api/connections/github-status/override'],
    ['POST', '/api/connections/notices/x/dismiss'],
    ['PUT', '/api/infra/connections/fake'],
    ['DELETE', '/api/infra/connections/fake'],
    ['POST', '/api/selfupdate/enable'],
    ['POST', '/api/selfupdate/rollback'],
    ['POST', '/api/repos/widgets/init'],
    ['PUT', '/api/repos/widgets/routine'],
    ['POST', '/api/repos/widgets/pipeline'],
    ['POST', '/api/repos/widgets/move'],
    ['POST', '/api/kickoffs'],
    ['POST', '/api/infra/environments/staging/describe'],
    ['POST', '/api/infra/environments/staging/changes'],
    ['POST', '/api/infra/changes/1/reject'],
    ['POST', '/api/infra/changes/1/approve'],
    ['POST', '/api/infra/environments'],
    ['PATCH', '/api/infra/environments/staging'],
    ['POST', '/api/infra/policy/changes'],
    ['PUT', '/api/infra/currency'],
    ['POST', '/api/infra/currency/rate'],
    ['POST', '/api/infra/inventory/refresh'],
    ['DELETE', '/api/infra/locks/1'],
    ['PUT', '/api/infra/envelopes/1'],
    ['POST', '/api/infra/plans/1/approve'],
    ['POST', '/api/infra/plans/1/reject'],
    ['POST', '/api/infra/plans/1/start-again'],
    ['PATCH', '/api/infra/plans/1'],
    ['POST', '/api/infra/drift/1'],
    ['POST', '/api/infra/break-glass/1'],
    ['POST', '/api/infra/tokens/environments/staging'],
    ['POST', '/api/infra/short-lived/1'],
    ['PATCH', '/api/features/x'],
    ['PUT', '/api/infra/runbooks/x'],
    ['POST', '/api/specs/x/approve'],
    ['POST', '/api/oauth/requests/x/approve'],
    ['POST', '/api/peloton/breakaway'],
    ['PUT', '/api/peloton/breakaway/plan'],
    ['POST', '/api/push'],
    ['POST', '/api/pings/1/apply'],
    ['POST', '/api/github/pulls/1/merge'],
    ['POST', '/api/github/promote'],
    ['POST', '/api/github/rollback'],
    ['POST', '/api/github/release'],
    ['POST', '/api/github/prerelease'],
    ['POST', '/api/github/workflows/run'],
    ['POST', '/api/tasks/BRK-1/messages'],
    ['POST', '/api/tasks/BRK-1/said'],
    ['DELETE', '/api/tasks/BRK-1/said/1'],
    ['POST', '/api/tasks/BRK-1/decision/answers'],
    ['POST', '/api/tasks/BRK-1/risk/1/answer'],
    ['POST', '/api/tasks/BRK-1/paths'],
    ['POST', '/api/people/invites'],
    ['POST', '/api/admin/rekey'],
  ];

  it('never takes a person’s personal token for a press, on each of the owner’s cookie-only routes', async () => {
    const owner = await ownerCookie();
    const { cookie } = await join((await invite(owner, [{ repository: '*', role: 'maintainer' }])).code, {
      handle: unique('ana'),
    });
    const { token } = await (await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } })).json();
    const passed = [];
    for (const [method, path] of COOKIE_GATED) {
      const res = await call(path, { method, token, body: { carryOn: true } });
      // Refused, or a route that's no press at all and answers on its own terms; never done.
      if (res.status < 400 || res.status >= 500) passed.push(`${method} ${path} ${res.status}`);
    }
    expect(passed).toEqual([]);
  }, 30_000);

  it('a person’s cookie is never the owner’s, on the sync server or /mcp either', async () => {
    const owner = await ownerCookie();
    const { cookie } = await join((await invite(owner)).code, { handle: unique('ana') });
    const images = await call('/api/kickoffs/IDEA-1/images', { method: 'POST', cookie });
    expect(images.status).toBe(403);
    const sync = await SELF.fetch(`${ORIGIN}/v1/client/get-child-version/00000000-0000-0000-0000-000000000000`, {
      headers: { Cookie: cookie },
    });
    expect(sync.status).toBeGreaterThanOrEqual(400);
  });
});
