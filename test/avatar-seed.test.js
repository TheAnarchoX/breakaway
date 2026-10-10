// Avatar seeds (WEB-134, docs/specs/ID-9-avatars.md): a person's handle is their seed until they press Shuffle, which
// picks a new one they keep, the owner's too; the people list carries each one's and /api/me/avatar the owner's, so the
// board draws everyone the same.
// Fixtures are made-up people (ana, ben).
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

/** A new person, joined by the owner's invite as a member everywhere; gives back their cookie and handle. */
async function person(owner, handle, name) {
  const made = await call('/api/people/invites', {
    method: 'POST',
    cookie: owner,
    body: { grants: [{ repository: '*', role: 'member' }] },
  });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name, handle } });
  const { challengeId, publicKey } = await options.json();
  const res = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential: await auth.create(publicKey) },
  });
  expect(res.status).toBe(201);
  return { cookie: cookieOf(res), handle };
}

const seedOf = async (who) => (await (await call('/api/me/avatar', who)).json()).avatar;

describe('avatar seeds', () => {
  it('start as the handle, and Shuffle picks a new one that a person keeps', async () => {
    const owner = await ownerCookie();
    const ana = await person(owner, 'ana', 'Ana');
    const ben = await person(owner, 'ben', 'Ben');

    expect(await seedOf({ cookie: ana.cookie })).toBe('ana');
    const shuffled = await call('/api/me/avatar', { method: 'POST', cookie: ana.cookie, body: {} });
    expect(shuffled.status).toBe(200);
    const { avatar } = await shuffled.json();
    expect(avatar).toMatch(/^[\w-]{12}$/u);
    expect(avatar).not.toBe('ana');
    // Kept: the next read, and the next sign-in's, draw the same.
    expect(await seedOf({ cookie: ana.cookie })).toBe(avatar);
    // Each press is a new one.
    const again = (await (await call('/api/me/avatar', { method: 'POST', cookie: ana.cookie, body: {} })).json())
      .avatar;
    expect(again).not.toBe(avatar);
    expect(await seedOf({ cookie: ana.cookie })).toBe(again);
    // Only their own: Ben's is still his handle.
    expect(await seedOf({ cookie: ben.cookie })).toBe('ben');

    // Everyone who sees the people list sees each one's seed, and the owner's.
    const list = await (await call('/api/people', { cookie: ben.cookie })).json();
    expect(list.people.find((p) => p.handle === 'ana').avatar).toBe(again);
    expect(list.people.find((p) => p.handle === 'ben').avatar).toBe('ben');
    expect((await (await call('/api/me/avatar', { cookie: ben.cookie })).json()).owner).toBe('owner');
    const owners = await (await call('/api/people', { token: TEST_API_TOKEN })).json();
    expect(owners.people.find((p) => p.handle === 'ana').avatar).toBe(again);

    // A personal token only reads it.
    const made = await call('/api/me/tokens', { method: 'POST', cookie: ana.cookie, body: { name: 'laptop' } });
    const { token } = await made.json();
    expect(await seedOf({ token })).toBe(again);
    expect((await call('/api/me/avatar', { method: 'POST', token, body: {} })).status).toBe(403);
    expect(await seedOf({ cookie: ana.cookie })).toBe(again);
  });

  it('lets the owner shuffle theirs, on the signed-in board only, and leaves /api/me as it was', async () => {
    const owner = await ownerCookie();
    expect(await seedOf({ token: TEST_API_TOKEN })).toBe('owner');
    expect((await call('/api/me/avatar', { method: 'POST', token: TEST_API_TOKEN, body: {} })).status).toBe(403);
    const shuffled = await call('/api/me/avatar', { method: 'POST', cookie: owner, body: {} });
    expect(shuffled.status).toBe(200);
    const { avatar } = await shuffled.json();
    expect(avatar).not.toBe('owner');
    expect(await seedOf({ token: TEST_API_TOKEN })).toBe(avatar);
    // Everyone draws the owner's new one.
    const ana = await person(owner, 'ana2', 'Ana Two');
    expect(await (await call('/api/me/avatar', { cookie: ana.cookie })).json()).toEqual({
      avatar: 'ana2',
      owner: avatar,
    });
    expect((await (await call('/api/me', { token: TEST_API_TOKEN })).json()).person).toEqual({
      handle: 'owner',
      name: null,
      label: 'the owner',
      owner: true,
    });
  });
});
