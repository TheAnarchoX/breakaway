// Finishing a decision is answering it (BRK-347, docs/specs/BRK-299-people-and-roles.md, point 3): a person's write
// that completes a who: decision task, opens a decided one again, or moves who away from decision needs
// decision.answer in its repository, as Send answers does. Fixtures are made-up people (ana, max) and the
// made-up repository widgets.
import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

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
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** Invites a made-up person with `grants`, and signs them in: their cookie and a personal token. */
async function person(session, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: session, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const joined = await call(`/api/join/${code}`, {
    method: 'POST',
    body: { challengeId, credential: await auth.create(publicKey) },
  });
  expect(joined.status).toBe(201);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  const tokens = await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } });
  return { handle, cookie, token: (await tokens.json()).token };
}

/** A decision without questions (an older +decide task), or with `body`'s questions. */
async function decision(body = {}) {
  const res = await owner('/api/tasks', {
    method: 'POST',
    body: { description: unique('Pick one'), project: 'product', who: 'decision', force: true, ...body },
  });
  expect(res.status).toBe(201);
  return (await res.json()).tasks[0];
}

const task = async (uuid) => (await (await owner(`/api/tasks/${uuid}`)).json()).task;

const WHO_CAN = /^only a maintainer in widgets can answer or reopen a decision/u;

let ana;
let max;
let fetchSpy;

beforeAll(async () => {
  // Nothing reaches the network.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  ana = await person(session, unique('ana'), [{ repository: 'widgets', role: 'member' }]);
  max = await person(session, unique('max'), [{ repository: 'widgets', role: 'maintainer' }]);
});

afterAll(() => fetchSpy.mockRestore());

describe('finishing a decision without questions', () => {
  it('refuses a member’s Decide…, with who can, and leaves the decision open', async () => {
    const { uuid } = await decision();
    for (const credential of [{ cookie: ana.cookie }, { token: ana.token }]) {
      const res = await call(`/api/tasks/${uuid}`, {
        method: 'PATCH',
        ...credential,
        body: { annotate: 'Decided: yes', status: 'completed' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(WHO_CAN);
    }
    const done = await call(`/api/tasks/${uuid}/done`, { method: 'POST', cookie: ana.cookie, body: {} });
    expect(done.status).toBe(403);
    expect((await done.json()).error).toMatch(WHO_CAN);
    const after = await task(uuid);
    expect(after.status).toBe('pending');
    expect(after.who).toBe('decision');
  });

  it('refuses a member moving who away from decision, by who or by an older CLI’s tags', async () => {
    const { uuid } = await decision();
    for (const body of [{ who: 'agent' }, { who: null }, { removeTags: ['decide'] }, { addTags: ['agent'] }]) {
      const res = await call(`/api/tasks/${uuid}`, { method: 'PATCH', cookie: ana.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect((await res.json()).error).toMatch(WHO_CAN);
    }
    expect((await task(uuid)).who).toBe('decision');
  });

  it('refuses a member finishing a decision with questions without answering it', async () => {
    const { uuid } = await decision({ decision: [{ id: 'q', prompt: 'Which?', type: 'yesno' }] });
    const res = await call(`/api/tasks/${uuid}`, {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { status: 'completed' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(WHO_CAN);
  });

  it('refuses a member opening a decided decision again, as Change my answers would', async () => {
    const { uuid } = await decision();
    expect((await owner(`/api/tasks/${uuid}`, { method: 'PATCH', body: { status: 'completed' } })).status).toBe(200);
    const res = await call(`/api/tasks/${uuid}`, { method: 'PATCH', cookie: ana.cookie, body: { status: 'pending' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(WHO_CAN);
    expect((await task(uuid)).status).toBe('completed');
  });

  it('still lets a member change the rest of a decision', async () => {
    const { uuid } = await decision();
    const res = await call(`/api/tasks/${uuid}`, {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { priority: 'H', annotate: 'More context' },
    });
    expect(res.status).toBe(200);
    const after = await task(uuid);
    expect(after.priority).toBe('H');
    expect(after.who).toBe('decision');
  });

  it('lets a maintainer decide one, named as them', async () => {
    const { uuid } = await decision();
    const res = await call(`/api/tasks/${uuid}`, {
      method: 'PATCH',
      cookie: max.cookie,
      body: { annotate: `Decided by ${max.handle}: yes`, status: 'completed' },
    });
    expect(res.status).toBe(200);
    const after = await task(uuid);
    expect(after.status).toBe('completed');
    expect(after.comments.at(-1).by).toBe(max.handle);
    const other = await decision();
    expect(
      (await call(`/api/tasks/${other.uuid}`, { method: 'PATCH', cookie: max.cookie, body: { who: 'agent' } })).status,
    ).toBe(200);
  });

  it('lets the owner decide one, on the cookie and the token, as before', async () => {
    const session = await ownerCookie();
    const first = await decision();
    const res = await call(`/api/tasks/${first.uuid}`, {
      method: 'PATCH',
      cookie: session,
      body: { annotate: 'Decided by the owner: yes', status: 'completed' },
    });
    expect(res.status).toBe(200);
    const second = await decision();
    expect((await owner(`/api/tasks/${second.uuid}/done`, { method: 'POST', body: {} })).status).toBe(200);
    expect((await task(second.uuid)).status).toBe('completed');
  });

  it('leaves a member’s writes on other tasks as they were', async () => {
    const build = async () => {
      const made = await owner('/api/tasks', {
        method: 'POST',
        body: { description: unique('Build it'), project: 'product', who: 'agent', force: true },
      });
      return (await made.json()).tasks[0].uuid;
    };
    const asked = await build();
    const res = await call(`/api/tasks/${asked}`, { method: 'PATCH', cookie: ana.cookie, body: { who: 'decision' } });
    expect(res.status).toBe(200);
    const done = await call(`/api/tasks/${await build()}/done`, { method: 'POST', cookie: ana.cookie, body: {} });
    expect(done.status).toBe(200);
  });
});
