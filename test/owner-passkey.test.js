// The owner's own sign-in (BRK-328, docs/specs/BRK-299-people-and-roles.md, points 1 and 2): passkeys the owner adds
// beside the board's token, and a display name, with the handle still `owner`. Fixtures are made-up people (ana).
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  expect(res.status).toBe(303);
  return res.headers.get('Set-Cookie').split(';')[0];
}

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

const cookieOf = (res) => res.headers.get('Set-Cookie')?.split(';')[0] ?? null;
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 8)}`;

/** The owner adds a passkey on the signed-in board; gives back the authenticator and the answer. */
async function ownerAddsPasskey(owner, name = 'Laptop') {
  const auth = await makeAuthenticator();
  const options = await call('/api/me/passkeys/options', { method: 'POST', cookie: owner, body: {} });
  expect(options.status).toBe(200);
  const { challengeId, publicKey } = await options.json();
  const res = await call('/api/me/passkeys', {
    method: 'POST',
    cookie: owner,
    body: { challengeId, credential: await auth.create(publicKey), name },
  });
  return { auth, res, publicKey };
}

async function signIn(auth) {
  const options = await call('/api/signin/options', { method: 'POST', body: {} });
  expect(options.status).toBe(200);
  const { challengeId, publicKey } = await options.json();
  const res = await call('/api/signin', {
    method: 'POST',
    body: { challengeId, credential: await auth.get(publicKey) },
  });
  return { res, cookie: res.status === 200 ? cookieOf(res) : null };
}

/** The board's token still signs in as the owner, by cookie and as a bearer. */
async function tokenStillSignsIn() {
  const res = await call('/api/session', { cookie: await ownerCookie() });
  expect(res.status).toBe(200);
  expect((await res.json()).via).toBe('cookie');
  expect((await (await call('/api/session', { token: TEST_API_TOKEN })).json()).via).toBe('token');
}

/** A new person, joined by the owner's invite; gives back their cookie. */
async function person(owner, handle = unique('ana')) {
  const made = await call('/api/people/invites', {
    method: 'POST',
    cookie: owner,
    body: { grants: [{ repository: '*', role: 'member' }] },
  });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: 'Ana', handle } });
  const { challengeId, publicKey } = await options.json();
  const res = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential: await auth.create(publicKey) },
  });
  expect(res.status).toBe(201);
  return { cookie: cookieOf(res), code, handle };
}

describe('the owner, before any passkey', () => {
  it('has no name and no passkeys, and the sign-in page offers none', async () => {
    expect(await (await call('/api/signin')).json()).toEqual({ passkeys: false });
    const me = await call('/api/me', { token: TEST_API_TOKEN });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      person: { handle: 'owner', name: null, label: 'the owner', owner: true },
      passkeys: [],
    });
  });
});

describe('the owner’s passkeys', () => {
  it('are added on the signed-in board and sign the owner in as the owner, press-only rights intact', async () => {
    const owner = await ownerCookie();
    const { auth, res, publicKey } = await ownerAddsPasskey(owner);
    expect(res.status).toBe(201);
    expect(publicKey.user.name).toBe('owner');
    expect(publicKey.authenticatorSelection.userVerification).toBe('required');
    expect(await (await call('/api/signin')).json()).toEqual({ passkeys: true });

    const { res: signed, cookie } = await signIn(auth);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ ok: true, owner: true, person: { handle: 'owner' } });
    // The owner's own cookie, the token's, never a person's session.
    expect(signed.headers.get('Set-Cookie')).toMatch(
      /^__Host-sw_tasks=\d+\.[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000$/u,
    );
    const session = await (await call('/api/session', { cookie })).json();
    expect(session.via).toBe('cookie');
    expect(session.person).toBeUndefined();
    // A press only the owner's cookie passes.
    const invite = await call('/api/people/invites', {
      method: 'POST',
      cookie,
      body: { grants: [{ repository: '*', role: 'viewer' }] },
    });
    expect(invite.status).toBe(201);

    const me = await (await call('/api/me', { cookie })).json();
    const mine = me.passkeys.find((p) => p.id === auth.id);
    expect(mine).toMatchObject({ name: 'Laptop' });
    expect(mine.used).not.toBeNull();
    await tokenStillSignsIn();
  });

  it('are renamed and removed, the last one too, and the token signs in after every change', async () => {
    const owner = await ownerCookie();
    const first = await ownerAddsPasskey(owner, 'Laptop');
    const second = await ownerAddsPasskey(owner, 'Phone');
    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(201);
    await tokenStillSignsIn();

    const renamed = await call(`/api/me/passkeys/${second.auth.id}`, {
      method: 'PATCH',
      cookie: owner,
      body: { name: 'Old phone' },
    });
    expect(renamed.status).toBe(200);
    await tokenStillSignsIn();

    for (const { auth } of [first, second]) {
      expect((await call(`/api/me/passkeys/${auth.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
      await tokenStillSignsIn();
    }
    const ids = (await (await call('/api/me', { cookie: owner })).json()).passkeys.map((p) => p.id);
    expect(ids).not.toContain(first.auth.id);
    expect(ids).not.toContain(second.auth.id);
    // A removed passkey no longer signs anyone in.
    expect((await signIn(first.auth)).res.status).toBe(401);
  });

  it('change only on the owner’s press: never with the token, and never from another site', async () => {
    const owner = await ownerCookie();
    const bearer = await call('/api/me/passkeys/options', { method: 'POST', token: TEST_API_TOKEN, body: {} });
    expect(bearer.status).toBe(403);
    const named = await call('/api/me', { method: 'PATCH', token: TEST_API_TOKEN, body: { name: 'Jo' } });
    expect(named.status).toBe(403);
    const cross = await call('/api/me/passkeys/options', {
      method: 'POST',
      cookie: owner,
      body: {},
      origin: 'https://evil.example',
    });
    expect(cross.status).toBe(403);
    // A challenge made for a person's passkey can't add one to the owner.
    const { cookie } = await person(owner);
    const theirs = await call('/api/me/passkeys/options', { method: 'POST', cookie, body: {} });
    const { challengeId, publicKey } = await theirs.json();
    const auth = await makeAuthenticator();
    const crossed = await call('/api/me/passkeys', {
      method: 'POST',
      cookie: owner,
      body: { challengeId, credential: await auth.create(publicKey) },
    });
    expect(crossed.status).toBe(400);
  });

  it('a person can’t see, rename, or remove them, or sign in as the owner with their own', async () => {
    const owner = await ownerCookie();
    const { auth } = await ownerAddsPasskey(owner);
    const { cookie } = await person(owner);

    const me = await (await call('/api/me', { cookie })).json();
    expect(me.passkeys.map((p) => p.id)).not.toContain(auth.id);
    expect(
      (await call(`/api/me/passkeys/${auth.id}`, { method: 'PATCH', cookie, body: { name: 'Mine now' } })).status,
    ).toBe(404);
    expect((await call(`/api/me/passkeys/${auth.id}`, { method: 'DELETE', cookie })).status).toBe(404);
    // The People routes don't reach the owner either.
    expect((await call('/api/people/owner/reset', { method: 'POST', cookie: owner })).status).toBe(404);
    expect((await call('/api/people/owner', { method: 'DELETE', cookie: owner })).status).toBe(404);

    const still = await (await call('/api/me', { cookie: owner })).json();
    expect(still.passkeys.find((p) => p.id === auth.id)).toMatchObject({ name: 'Laptop' });
    // The person's session is theirs, never the owner's.
    const session = await (await call('/api/session', { cookie })).json();
    expect(session.via).toBe('person-cookie');
    expect((await signIn(auth)).res.status).toBe(200);
  });
});

describe('the owner’s display name', () => {
  it('is the owner’s to set, shows to people as “<name> (owner)”, and the handle stays owner', async () => {
    const owner = await ownerCookie();
    const { cookie, handle } = await person(owner);

    // A person sets their own name, never the owner's.
    expect((await call('/api/me', { method: 'PATCH', cookie, body: { name: 'Jo' } })).status).toBe(200);
    expect((await (await call('/api/me', { token: TEST_API_TOKEN })).json()).person.name).toBeNull();
    expect((await (await call('/api/me', { cookie })).json()).person).toMatchObject({ handle, name: 'Jo' });

    const set = await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: '  Jo   Silva ' } });
    expect(set.status).toBe(200);
    expect((await set.json()).person).toEqual({
      handle: 'owner',
      name: 'Jo Silva',
      label: 'Jo Silva (owner)',
      owner: true,
    });

    // Where people see the owner: their own settings, and an invite's page.
    const theirs = await (await call('/api/me', { cookie })).json();
    expect(theirs.owner).toEqual({ handle: 'owner', name: 'Jo Silva', label: 'Jo Silva (owner)' });
    const made = await call('/api/people/invites', {
      method: 'POST',
      cookie: owner,
      body: { grants: [{ repository: '*', role: 'viewer' }] },
    });
    const info = await (await call(`/api/join/${(await made.json()).invite.code}`)).json();
    expect(info).toMatchObject({ invitedBy: 'owner', inviter: 'Jo Silva (owner)' });

    expect((await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: 'x'.repeat(81) } })).status).toBe(
      400,
    );
    const cleared = await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: '' } });
    expect((await cleared.json()).person).toMatchObject({ name: null, label: 'the owner' });
    expect((await (await call('/api/me', { cookie })).json()).owner.label).toBe('the owner');
    await tokenStillSignsIn();
  });

  it('nobody else can take it: a person’s name can’t end in “(owner)” or be the owner’s', async () => {
    const owner = await ownerCookie();
    expect((await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: 'Jo Silva' } })).status).toBe(200);
    const { cookie } = await person(owner);
    for (const name of ['Jo Silva', 'jo silva', 'Ana (owner)', 'Ana ( Owner )']) {
      const res = await call('/api/me', { method: 'PATCH', cookie, body: { name } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/owner’s/u);
    }
    expect((await call('/api/me', { method: 'PATCH', cookie, body: { name: 'Ana, owner of widgets' } })).status).toBe(
      200,
    );
    // Joining by invite, the same.
    const made = await call('/api/people/invites', {
      method: 'POST',
      cookie: owner,
      body: { grants: [{ repository: '*', role: 'viewer' }] },
    });
    const { code } = (await made.json()).invite;
    for (const name of ['Jo Silva', 'Ben (owner)']) {
      const res = await call(`/api/join/${code}/options`, { method: 'POST', body: { name, handle: unique('ben') } });
      expect(res.status).toBe(400);
    }
    await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: null } });
  });

  it('the owner has no personal tokens or sessions to manage: the token is theirs', async () => {
    const owner = await ownerCookie();
    expect((await call('/api/me/tokens', { method: 'POST', cookie: owner, body: { name: 'x' } })).status).toBe(404);
    expect((await call('/api/me/sessions', { method: 'DELETE', cookie: owner })).status).toBe(404);
  });
});
