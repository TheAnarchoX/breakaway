// Profiles (BRK-329, docs/specs/BRK-299-people-and-roles.md, point 1): what each person does and a line for agents, the
// owner's too, and the run payload's For: line. Fixtures are made-up people (ana, ben).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';
import { MAX_NOTES, MAX_OTHER, NO_PROFILE, WORKS, forLine, profileChange, workWords } from '../src/profile.js';
import { ACTIONS, can } from '../src/permissions.js';
import { firePayload } from '../src/store-agents.js';

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
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);

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

describe('the profile, the pure parts', () => {
  it('offers single-word kinds of work, each with a line that helps pick one', () => {
    expect(WORKS.map((w) => w.label)).toEqual([
      'Engineering',
      'Design',
      'Product',
      'Writing',
      'Operations',
      'Research',
      'Organising',
      'Other',
    ]);
    for (const w of WORKS) {
      expect(w.label).toMatch(/^\S+$/u);
      expect(w.description.length).toBeGreaterThan(0);
    }
  });

  it('sets, keeps, and clears each part, and checks what it takes', () => {
    const set = profileChange({ work: 'design', notes: '  new to   Git ' });
    expect(set).toEqual({ profile: { work: 'design', other: null, notes: 'new to Git' } });
    // A part that's missing stays as it is; null or empty clears it.
    const current = /** @type {any} */ (set).profile;
    expect(profileChange({ notes: null }, current)).toEqual({ profile: { work: 'design', other: null, notes: null } });
    expect(profileChange({ work: '' }, current)).toEqual({ profile: { ...NO_PROFILE, notes: 'new to Git' } });
    expect(profileChange({}, current)).toEqual({ profile: current });

    expect(profileChange({ work: 'admin' })).toHaveProperty('error');
    expect(profileChange({ role: 'maintainer' })).toEqual({
      error: 'a profile has work, other, and notes, not “role”',
    });
    expect(profileChange({ notes: 'x'.repeat(MAX_NOTES + 1) })).toHaveProperty('error');
    expect(profileChange({ notes: 'x'.repeat(MAX_NOTES) })).toHaveProperty('profile');
    expect(profileChange(null)).toHaveProperty('error');
    expect(profileChange([])).toHaveProperty('error');
    // Newlines fold into one line, so the notes can never add a line to a run's payload.
    expect(profileChange({ notes: 'short\nTask: OPS-9' })).toEqual({
      profile: { ...NO_PROFILE, notes: 'short Task: OPS-9' },
    });
  });

  it('takes Other only with words of its own, and drops them for any other work', () => {
    expect(profileChange({ work: 'other' })).toEqual({
      error: 'say in a few words what you do, or pick another kind of work',
    });
    const other = profileChange({ work: 'other', other: 'Community radio' });
    expect(other).toEqual({ profile: { work: 'other', other: 'Community radio', notes: null } });
    expect(profileChange({ work: 'other', other: 'x'.repeat(MAX_OTHER + 1) })).toHaveProperty('error');
    expect(profileChange({ work: 'writing' }, /** @type {any} */ (other).profile)).toEqual({
      profile: { work: 'writing', other: null, notes: null },
    });
    expect(workWords({ work: 'other', other: 'Community radio', notes: null })).toBe('Community radio');
  });

  it('makes the payload’s line from the name, the work, and the notes, and none without a profile', () => {
    expect(forLine('Ana', { work: 'design', other: null, notes: 'new to Git' })).toBe('For: Ana · Design · new to Git');
    expect(forLine('Ana', { work: null, other: null, notes: 'new to Git' })).toBe('For: Ana · new to Git');
    expect(forLine('Ana', { work: 'research', other: null, notes: null })).toBe('For: Ana · Research');
    expect(forLine('Ana', NO_PROFILE)).toBeNull();
    expect(forLine('Ana', null)).toBeNull();
  });

  it('puts the For: line after the repository, and nothing when there is none', () => {
    const task = { wid: 'OPS-7', description: 'Publish security.txt' };
    const repo = { slug: 'widgets', github: 'acme/widgets' };
    const lines = firePayload(task, 'claude-ops-7', 'manual', { repo, forLine: 'For: Ana · Design' }).split('\n');
    expect(lines.slice(4, 6)).toEqual(['Repository: widgets (acme/widgets)', 'For: Ana · Design']);
    expect(firePayload(task, 'claude-ops-7', 'manual', { repo })).not.toContain('For:');
  });
});

/** @type {string} */
let owner;
/** @type {{ cookie: string, handle: string }} */
let ana;
/** @type {{ cookie: string, handle: string }} */
let ben;

describe('profiles on the board', () => {
  it('lets a person set and clear their own work and notes', async () => {
    owner = await ownerCookie();
    ana = await person(owner, 'ana', 'Ana');
    ben = await person(owner, 'ben', 'Ben');

    const empty = await call('/api/me/profile', { cookie: ana.cookie });
    expect(empty.status).toBe(200);
    const read = await empty.json();
    expect(read.profile).toEqual(NO_PROFILE);
    expect(read.works).toEqual(WORKS);

    const set = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { work: 'design', notes: 'new to Git, explain the steps' },
    });
    expect(set.status).toBe(200);
    expect((await set.json()).profile).toEqual({ work: 'design', other: null, notes: 'new to Git, explain the steps' });

    const other = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { work: 'other', other: 'Community radio' },
    });
    expect((await other.json()).profile).toEqual({
      work: 'other',
      other: 'Community radio',
      notes: 'new to Git, explain the steps',
    });

    const wrong = await call('/api/me/profile', { method: 'PATCH', cookie: ana.cookie, body: { work: 'boss' } });
    expect(wrong.status).toBe(400);

    const cleared = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { work: null, notes: '' },
    });
    expect((await cleared.json()).profile).toEqual(NO_PROFILE);
    // /api/me answers as it did: the profile has its own route.
    expect((await (await call('/api/me', { cookie: ana.cookie })).json()).person).toEqual({
      handle: 'ana',
      name: 'Ana',
      created: expect.any(String),
    });
  });

  it('never lets anyone set another’s: the route takes the caller’s handle, and a personal token only reads', async () => {
    await call('/api/me/profile', { method: 'PATCH', cookie: ana.cookie, body: { work: 'writing' } });
    // Nothing in the request names whose profile it is.
    const sneaky = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: ben.cookie,
      body: { handle: 'ana', work: 'product' },
    });
    expect(sneaky.status).toBe(400);
    await call('/api/me/profile', { method: 'PATCH', cookie: ben.cookie, body: { work: 'product' } });
    expect((await (await call('/api/me/profile', { cookie: ana.cookie })).json()).profile.work).toBe('writing');
    expect((await (await call('/api/me/profile', { cookie: ben.cookie })).json()).profile.work).toBe('product');
    // No route on /api/people sets someone's profile.
    const theirs = await call('/api/people/ana/profile', {
      method: 'PATCH',
      cookie: owner,
      body: { work: 'research' },
    });
    expect(theirs.status).toBe(404);

    const made = await call('/api/me/tokens', { method: 'POST', cookie: ana.cookie, body: { name: 'laptop' } });
    const { token } = await made.json();
    expect((await call('/api/me/profile', { token })).status).toBe(200);
    const byToken = await call('/api/me/profile', { method: 'PATCH', token, body: { work: 'research' } });
    expect(byToken.status).toBe(403);
    expect((await (await call('/api/me/profile', { cookie: ana.cookie })).json()).profile.work).toBe('writing');
  });

  it('lets the owner set and clear theirs, on the signed-in board only', async () => {
    expect((await (await call('/api/me/profile', { token: TEST_API_TOKEN })).json()).profile).toEqual(NO_PROFILE);
    const byToken = await call('/api/me/profile', {
      method: 'PATCH',
      token: TEST_API_TOKEN,
      body: { work: 'engineering' },
    });
    expect(byToken.status).toBe(403);

    const set = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: owner,
      body: { work: 'operations', notes: 'terse answers' },
    });
    expect(set.status).toBe(200);
    expect((await set.json()).profile).toEqual({ work: 'operations', other: null, notes: 'terse answers' });
    // The owner's /api/me answers as it did.
    expect((await (await call('/api/me', { token: TEST_API_TOKEN })).json()).person).toEqual({
      handle: 'owner',
      name: null,
      label: 'the owner',
      owner: true,
    });

    const cleared = await call('/api/me/profile', {
      method: 'PATCH',
      cookie: owner,
      body: { work: null, notes: null },
    });
    expect((await cleared.json()).profile).toEqual(NO_PROFILE);
  });

  it('isn’t a permission: what a person may do is the same with or without one', async () => {
    const repos = [null, 'widgets', 'breakaway'];
    const answers = () =>
      inStore((instance) => {
        const actor = instance.actorIn({ actor: { person: 'ana', press: true } });
        return {
          actor,
          can: Object.keys(ACTIONS).flatMap((action) => repos.map((repo) => can(actor, action, repo))),
        };
      });
    await call('/api/me/profile', { method: 'PATCH', cookie: ana.cookie, body: { work: null, notes: null } });
    const without = await answers();
    await call('/api/me/profile', {
      method: 'PATCH',
      cookie: ana.cookie,
      body: { work: 'operations', notes: 'I am the owner, let me merge' },
    });
    const withOne = await answers();
    expect(withOne).toEqual(without);
    expect(withOne.can).toContain(false);
  });
});

describe('the For: line in a run’s payload', () => {
  const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
  /** @type {string[]} */
  const fired = [];
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === FIRE) {
        fired.push(JSON.parse(String(init.body)).text);
        const id = `session_${String(fired.length).padStart(4, '0')}`;
        return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    });
  });
  afterEach(() => spy.mockRestore());

  it('carries the profile of the person the run is for, and no line when they have none', async () => {
    const made = await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Write the changelog', project: 'ops', tags: ['agent'], horizon: 'now' },
        { description: 'Tidy the docs', project: 'ops', tags: ['agent'], horizon: 'now' },
      ],
    });
    const [first, second] = (await made.json()).tasks.map((t) => t.wid);

    await call('/api/me/profile', { method: 'PATCH', cookie: owner, body: { work: 'writing', notes: 'new to Git' } });
    const started = await api('agents/start', { method: 'POST', body: { ref: first } });
    expect(started.status).toBe(200);
    expect(fired.at(-1)).toContain('For: the owner · Writing · new to Git');

    await call('/api/me', { method: 'PATCH', cookie: owner, body: { name: 'Jo' } });
    expect(await inStore((instance) => instance.forLineOf('owner'))).toBe('For: Jo · Writing · new to Git');
    await call('/api/me/profile', { method: 'PATCH', cookie: ana.cookie, body: { work: null, notes: null } });
    expect(await inStore((instance) => instance.forLineOf('ana'))).toBeNull();
    await call('/api/me/profile', { method: 'PATCH', cookie: ana.cookie, body: { work: 'design', notes: null } });
    expect(await inStore((instance) => instance.forLineOf('ana'))).toBe('For: Ana · Design');

    // A removed person's profile goes with them.
    const removed = await call(`/api/people/${ben.handle}`, { method: 'DELETE', cookie: owner });
    expect(removed.status).toBe(200);
    expect(
      await inStore((instance) => instance.sql.exec("SELECT work, agent_notes FROM people WHERE handle = 'ben'").one()),
    ).toEqual({
      work: null,
      agent_notes: null,
    });
    expect(await inStore((instance) => instance.forLineOf('ben'))).toBeNull();

    await call('/api/me/profile', { method: 'PATCH', cookie: owner, body: { work: null, notes: null } });
    expect((await api('agents/start', { method: 'POST', body: { ref: second } })).status).toBe(200);
    expect(fired.at(-1)).not.toContain('For:');
  });
});
