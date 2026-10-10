// Removed people still draw as people (WEB-138, docs/specs/ID-9-avatars.md): a person's people list carries the handle
// and avatar seed of each removed person who held a grant in a repository they see, and nothing else about them.
// Someone removed before their repositories were kept is worked out from what they wrote. Fixtures are made-up people
// (vic, rae, gil, …) and repositories (acme/widgets, acme/gadgets).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

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
const owner = (path, opts = {}) => call(path, { token: TEST_API_TOKEN, ...opts });

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** Invites a made-up person with `grants` and signs them in: their handle and cookie. */
async function person(session, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: session, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: `Name ${handle}`, handle } });
  const { challengeId, publicKey } = await options.json();
  const joined = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential: await auth.create(publicKey) },
  });
  expect(joined.status).toBe(201);
  return { handle, cookie: joined.headers.get('Set-Cookie').split(';')[0] };
}

let w;
let fetchSpy;

beforeAll(async () => {
  // Nothing reaches the network.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  const added = await owner('/api/repos', {
    method: 'POST',
    body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GAD'], defaultBranch: 'main' },
  });
  expect([201, 400]).toContain(added.status);
  const made = await owner('/api/tasks', {
    method: 'POST',
    body: { force: true, project: 'product', description: 'A widget task' },
  });
  expect(made.status).toBe(201);
  const widget = (await made.json()).tasks[0];
  w = { session, widget };
});

afterAll(() => fetchSpy.mockRestore());

describe('removed people in a person’s people list (WEB-138)', () => {
  it('carry the handle and seed of who worked where the reader sees, never their name or grants', async () => {
    const vic = await person(w.session, unique('vic'), [{ repository: 'widgets', role: 'viewer' }]);
    const rae = await person(w.session, unique('rae'), [{ repository: 'widgets', role: 'member' }]);
    const gil = await person(w.session, unique('gil'), [{ repository: 'gadgets', role: 'member' }]);
    // Rae comments on a widget task and shuffles; then both are removed.
    const said = await call(`/api/tasks/${w.widget.uuid}/comments`, {
      method: 'POST',
      cookie: rae.cookie,
      body: { text: 'Rae was here' },
    });
    expect(said.status).toBe(200);
    const { avatar } = await (await call('/api/me/avatar', { method: 'POST', cookie: rae.cookie, body: {} })).json();
    for (const p of [rae, gil])
      expect((await call(`/api/people/${p.handle}`, { method: 'DELETE', cookie: w.session })).status).toBe(200);

    const read = async () => (await (await call('/api/people', { cookie: vic.cookie })).json()).removed;
    // Vic sees widgets, where Rae worked: Rae's handle and seed, nothing more. Gil was only in gadgets.
    const removed = await read();
    expect(removed).toContainEqual({ handle: rae.handle, avatar });
    expect(removed.map((p) => p.handle)).not.toContain(gil.handle);
    for (const p of removed) expect(Object.keys(p).sort()).toEqual(['avatar', 'handle']);
    // The active list leaves them out, as before.
    const { people } = await (await call('/api/people', { cookie: vic.cookie })).json();
    expect(people.map((p) => p.handle)).not.toContain(rae.handle);

    // Someone removed before their repositories were kept: worked out from what they wrote, then kept.
    await inStore((s) =>
      s.sql.exec('UPDATE people SET removed_repos = NULL WHERE handle IN (?, ?)', rae.handle, gil.handle),
    );
    const again = await read();
    expect(again).toContainEqual({ handle: rae.handle, avatar });
    expect(again.map((p) => p.handle)).not.toContain(gil.handle);
    const kept = await inStore((s) =>
      s.sql.exec('SELECT handle, removed_repos FROM people WHERE handle IN (?, ?)', rae.handle, gil.handle).toArray(),
    );
    expect(Object.fromEntries(kept.map((r) => [r.handle, JSON.parse(r.removed_repos)]))).toEqual({
      [rae.handle]: ['widgets'],
      [gil.handle]: [],
    });

    // The owner's list is unchanged: everyone, removed people among them, with their names.
    const owners = await (await owner('/api/people')).json();
    expect(owners.people.find((p) => p.handle === rae.handle)).toMatchObject({ name: `Name ${rae.handle}`, avatar });
    expect(owners).not.toHaveProperty('removed');
  });
});
