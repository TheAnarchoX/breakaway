// Who did it (BRK-303, docs/specs/BRK-299-people-and-roles.md, point 6): every write names the person behind the
// request's credential, and the agent acting for them, in Activity, task history, the inbox, decisions, quotes,
// messages, the peloton, pull requests, and the infrastructure audit trail. Fixtures are made-up people (ana, ben, …)
// and repositories (acme/widgets).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditEntry } from '../src/infra-audit.js';
import { summarize } from '../src/decision.js';
import { messageText } from '../scripts/tasks/session-messages.js';
import { pelotonContext } from '../scripts/tasks/peloton.js';
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

/** Invites a made-up person with `grants`, and signs them in: their cookie and a personal token. */
async function person(ownerSession, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: ownerSession, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const joined = await call(`/api/join/${code}`, { method: 'POST', body: { challengeId, credential } });
  expect(joined.status).toBe(201);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  const tokens = await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } });
  return { handle, cookie, token: (await tokens.json()).token };
}

const addTask = async (description) => {
  const res = await owner('/api/tasks', { method: 'POST', body: { description, project: 'product', force: true } });
  expect(res.status).toBe(201);
  return (await res.json()).tasks[0].uuid;
};
const task = async (uuid) => (await (await owner(`/api/tasks/${uuid}`)).json()).task;

/** The Activity events about task `uuid`, newest first. */
const activityOf = async (uuid) =>
  (await (await owner('/api/activity?limit=200')).json()).events.filter((e) => e.task?.uuid === uuid);

let world;
let fetchSpy;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  world = {
    session,
    max: await person(session, unique('max'), [{ repository: 'widgets', role: 'maintainer' }]),
    mia: await person(session, unique('mia'), [{ repository: 'widgets', role: 'member' }]),
  };
}, 60_000);

afterAll(() => fetchSpy?.mockRestore());

describe('the pure parts', () => {
  it('names a person in the audit trail, and the owner only ever as owner', () => {
    const base = { kind: 'freeze', repo: 'widgets', environment: 'production', outcome: 'on' };
    expect(auditEntry({ ...base, by: 'owner' }).person).toBe('owner');
    expect(auditEntry({ ...base, by: 'owner', person: 'ana' }).person).toBe('owner');
    expect(auditEntry({ ...base, by: 'person', person: 'ana' }).person).toBe('ana');
    expect(auditEntry({ ...base, by: 'board' }).person).toBeNull();
    expect(auditEntry({ ...base, by: 'agent', agent: 'claude-x-1', person: 'ana' }).person).toBe('ana');
    expect(() => auditEntry({ ...base, by: 'person' })).toThrow(/names the person/);
    expect(() => auditEntry({ ...base, by: 'person', person: 'owner' })).toThrow(/names the person/);
    expect(() => auditEntry({ ...base, by: 'person', person: 'Not A Handle' })).toThrow(/handle/);
  });

  it('says who decided, and tells an agent who sent a message or a post', () => {
    const q = [{ id: 'q', prompt: 'Which?', type: 'yesno' }];
    expect(summarize(q, { q: { value: 'yes' } })).toBe('Decided by the owner: Which? = yes');
    expect(summarize(q, { q: { value: 'yes' } }, 'ana')).toBe('Decided by ana: Which? = yes');
    expect(messageText({ messages: [{ text: 'Hi', from: 'ana' }] })).toBe('Message from ana (via the board): Hi');
    expect(messageText({ messages: [{ text: 'Hi', from: 'owner' }] })).toBe(
      'Message from the owner (via the board): Hi',
    );
    expect(messageText({ messages: [{ text: 'Hi' }] })).toBe('Message from the owner (via the board): Hi');
    const post = { peloton: 'widgets', id: 3, agent: 'ana', task: null, kind: 'note', text: 'Hold off on the store' };
    expect(pelotonContext([post])).toMatch(/^Peloton \(widgets #3, ana via the board\): Hold off on the store/u);
    expect(pelotonContext([post])).not.toMatch(/from the owner/u);
  });
});

describe('every write names who did it (BRK-303)', () => {
  it('records the person behind each task write in Activity and the task’s history', async () => {
    const uuid = await addTask(unique('Attributed'));
    const { mia } = world;
    expect(
      (await call(`/api/tasks/${uuid}/comments`, { method: 'POST', cookie: mia.cookie, body: { text: 'from mia' } }))
        .status,
    ).toBe(200);
    expect(
      (await call(`/api/tasks/${uuid}`, { method: 'PATCH', cookie: mia.cookie, body: { priority: 'H' } })).status,
    ).toBe(200);
    // An agent on mia's own token names both: the agent, and mia behind it.
    expect(
      (
        await call(`/api/tasks/${uuid}/claim`, {
          method: 'POST',
          token: mia.token,
          body: { agent: 'claude-attr-1' },
        })
      ).status,
    ).toBe(200);
    // And the owner's own writes stay the owner's.
    expect(
      (await owner(`/api/tasks/${uuid}/comments`, { method: 'POST', body: { text: 'from the owner' } })).status,
    ).toBe(200);
    const events = await activityOf(uuid);
    const whos = events.filter((e) => e.source === 'api').map((e) => e.who);
    expect(whos).toEqual(
      expect.arrayContaining([
        { person: mia.handle, agent: null, for: null },
        { person: mia.handle, agent: 'claude-attr-1', for: null },
        { person: 'owner', agent: null, for: null },
      ]),
    );
    const t = await task(uuid);
    expect(t.comments.map((c) => [c.text, c.by])).toEqual(
      expect.arrayContaining([
        ['from mia', mia.handle],
        ['from the owner', 'owner'],
      ]),
    );
  });

  it('names who answered a decision, in the summary agents read', async () => {
    const made = await owner('/api/tasks', {
      method: 'POST',
      body: {
        description: unique('Pick one'),
        project: 'product',
        force: true,
        decision: [{ id: 'q', prompt: 'Which?', type: 'yesno' }],
      },
    });
    const { uuid } = (await made.json()).tasks[0];
    const res = await call(`/api/tasks/${uuid}/decision/answers`, {
      method: 'POST',
      cookie: world.max.cookie,
      body: { answers: { q: { value: 'yes' } } },
    });
    expect(res.status).toBe(200);
    const t = await task(uuid);
    expect(t.decisionAnswers.by).toBe(world.max.handle);
    expect(t.comments.at(-1).text).toBe(`Decided by ${world.max.handle}: Which? = yes`);
    expect((await activityOf(uuid)).find((e) => e.who?.person === world.max.handle)).toBeTruthy();
  });

  it('names who quoted, messaged, and posted, and never as the owner', async () => {
    const uuid = await addTask(unique('Messaged'));
    const { max, mia } = world;
    expect((await owner(`/api/tasks/${uuid}/claim`, { method: 'POST', body: { agent: 'claude-attr-2' } })).status).toBe(
      200,
    );
    // A quote by a maintainer is their own words.
    expect(
      (await call(`/api/tasks/${uuid}/said`, { method: 'POST', cookie: max.cookie, body: { text: 'do it this way' } }))
        .status,
    ).toBe(200);
    expect((await task(uuid)).ownerSaid.at(-1)).toMatchObject({
      text: 'do it this way',
      from: 'board',
      by: max.handle,
    });
    // A message names who sent it, to the agent too.
    const sent = await call(`/api/tasks/${uuid}/messages`, {
      method: 'POST',
      cookie: max.cookie,
      body: { text: 'hi' },
    });
    expect(sent.status).toBe(201);
    const listed = await (await owner(`/api/tasks/${uuid}/messages`)).json();
    expect(listed.messages.at(-1).from).toBe(max.handle);
    const waiting = await (await owner(`/api/tasks/${uuid}/messages/waiting?agent=claude-attr-2`)).json();
    expect(waiting.messages.map((m) => m.from)).toEqual([max.handle]);
    expect(messageText(waiting)).toMatch(new RegExp(`^Message from ${max.handle} \\(via the board`, 'u'));
    // A post is under the person's handle, never the owner's.
    const posted = await call('/api/peloton/widgets', {
      method: 'POST',
      cookie: mia.cookie,
      body: { kind: 'note', text: 'hello' },
    });
    expect(posted.status).toBe(201);
    const peloton = await (await owner('/api/peloton/widgets')).json();
    expect(peloton.posts.find((p) => p.text === 'hello')).toMatchObject({ agent: mia.handle });
  });

  it('names who resolved a ping, in the inbox and Activity', async () => {
    const uuid = await addTask(unique('Pinged'));
    const id = await inStore(
      (store) =>
        store.sql
          .exec(
            "INSERT INTO pings (task, kind, message, agent, created) VALUES (?, 'question', 'which?', 'claude-attr-3', ?) RETURNING id",
            uuid,
            Date.now(),
          )
          .one().id,
    );
    const res = await call(`/api/pings/${id}/handled`, { method: 'POST', cookie: world.max.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(
      await inStore((store) => store.sql.exec('SELECT resolved_by FROM pings WHERE id = ?', id).one().resolved_by),
    ).toBe(world.max.handle);
    const resolved = (await activityOf(uuid)).find((e) => e.changes[0]?.kind === 'ping-resolved');
    expect(resolved.changes[0].by).toBe(world.max.handle);
  });

  it('names the person in the infrastructure audit trail, beside by', async () => {
    const name = unique('attr');
    expect(
      (
        await call('/api/infra/environments', {
          method: 'POST',
          cookie: world.max.cookie,
          body: { repo: 'widgets', name, kind: 'staging', provider: 'fake' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(`/api/infra/environments/${name}?repo=widgets`, {
          method: 'PATCH',
          cookie: world.max.cookie,
          body: { frozen: true },
        })
      ).status,
    ).toBe(200);
    const trail = await (await owner(`/api/infra/audit?environment=${name}`)).json();
    const entries = trail.entries.map((e) => [e.kind, e.by, e.person]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ['environment', 'person', world.max.handle],
        ['freeze', 'person', world.max.handle],
      ]),
    );
    expect(trail.entries.find((e) => e.kind === 'environment').summary).toMatch(
      new RegExp(`^added by ${world.max.handle}: `, 'u'),
    );
  });
});

describe('path claims a person gives back (BRK-303)', () => {
  it('says who released them', async () => {
    const uuid = await addTask(unique('Paths'));
    expect((await owner(`/api/tasks/${uuid}/claim`, { method: 'POST', body: { agent: 'claude-attr-4' } })).status).toBe(
      200,
    );
    expect(
      (
        await owner(`/api/tasks/${uuid}/paths`, {
          method: 'POST',
          body: { agent: 'claude-attr-4', claim: ['src/attr/**'] },
        })
      ).status,
    ).toBe(200);
    const res = await call(`/api/tasks/${uuid}/paths`, {
      method: 'POST',
      cookie: world.max.cookie,
      body: { release: true },
    });
    expect(res.status).toBe(200);
    const why = await inStore((store) =>
      store.sql.exec('SELECT why FROM path_claims WHERE uuid = ? AND ended IS NOT NULL', uuid).toArray(),
    );
    expect(why.map((r) => r.why)).toEqual([`released by ${world.max.handle}`]);
  });
});
