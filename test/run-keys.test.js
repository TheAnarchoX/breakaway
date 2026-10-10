// Run keys (BRK-324, docs/specs/BRK-299-people-and-roles.md, point 4): a start on a routine the owner lends hands its
// agent a key of its own, and a request with that key is the run's person, with their rights and no more, whatever
// token a cloud session's proxy added beside it. The key ends with the run's claim, and never shows in what the board
// keeps. Fixtures are made-up people (ana) and repositories (acme/widgets); nothing reaches the network.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL } from '../src/mcp.js';
import { redact } from '../src/redact.js';
import { RUN_KEY, RUN_KEY_HEADER, runKeyOf } from '../src/run-keys.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const fireOf = (name) => `https://api.anthropic.com/v1/claude_code/routines/trig_${name}/fire`;
const LENT = { url: fireOf('lentkeys'), token: 'sk-ant-oat01-lent-keys-made-up' };
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

/** A request to the board, with any of: the owner's token or a person's cookie, and a run key in its own header. */
function call(path, { method = 'GET', body, cookie, token, key } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers[RUN_KEY_HEADER] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const owner = (path, opts = {}) => call(path, { token: TEST_API_TOKEN, ...opts });
const json = async (res) => ({ status: res.status, ...(await res.json()) });

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** Invites a made-up person with `grants` and signs them in. */
async function person(session, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: session, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const joined = await call(`/api/join/${code}`, { method: 'POST', body: { challengeId, credential } });
  expect(joined.status).toBe(201);
  return { handle, cookie: joined.headers.get('Set-Cookie').split(';')[0] };
}

const fires = [];
let fetchSpy;
let session;
let ana;
const tasks = [];

async function task(description) {
  const res = await owner('/api/tasks', {
    method: 'POST',
    body: { description, project: 'product', who: 'agent', horizon: 'now', force: true },
  });
  expect(res.status).toBe(201);
  const made = (await res.json()).tasks[0];
  tasks.push(made.uuid);
  return made;
}

/** Starts ana's agent on a new task, on the lent routine: the task, the agent's name, and its run key. */
async function lentStart(description) {
  const t = await task(unique(description));
  fires.length = 0;
  const res = await json(
    await call('/api/agents/start', { method: 'POST', cookie: ana.cookie, body: { ref: t.uuid } }),
  );
  expect(res.status).toBe(200);
  expect(fires).toHaveLength(1);
  const key = /^Run key: (\S+)$/mu.exec(fires[0].text)?.[1];
  expect(key).toMatch(RUN_KEY);
  return { task: t, agent: res.run.agent, key };
}

const release = (uuid) => owner(`/api/tasks/${uuid}/release`, { method: 'POST', body: { force: true } });

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\/v1\/claude_code\/routines\/trig_\w+\/fire$/u.test(url)) {
      fires.push({ url, text: JSON.parse(init.body).text });
      const id = `session_k${String(fires.length).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  session = await ownerCookie();
  ana = await person(session, unique('ana'), [{ repository: 'widgets', role: 'member' }]);
  const lent = await call('/api/repos/widgets/routine/lend', { method: 'PUT', cookie: session, body: LENT });
  expect([200, 201]).toContain(lent.status);
});

// A lent routine runs 1 agent at once for a person, and starts 5 an hour: each test's run gives its claim back, passed
// or not, and its start is moved back an hour, as if the tests were spread out.
afterEach(async () => {
  for (const uuid of tasks) await release(uuid);
  await inStore((store) =>
    store.sql.exec('UPDATE agent_runs SET started = started - 3600000 WHERE for_person = ?', ana.handle),
  );
});

afterAll(async () => {
  await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
  for (const uuid of tasks) await release(uuid);
  fetchSpy.mockRestore();
});

describe('run keys', () => {
  it('make a lent start’s agent its person, by the key alone', async () => {
    const run = await lentStart('Sort the widgets');
    const who = await json(await call('/api/session', { key: run.key }));
    expect(who).toMatchObject({ status: 200, via: 'run-key', person: { handle: ana.handle } });
    // It works on the run's own task: a claim and a comment, with no name sent, are its agent's.
    expect((await call(`/api/tasks/${run.task.uuid}/claim`, { method: 'POST', key: run.key, body: {} })).status).toBe(
      200,
    );
    const said = await call(`/api/tasks/${run.task.uuid}/annotate`, {
      method: 'POST',
      key: run.key,
      body: { text: 'Found the sort order.' },
    });
    expect(said.status).toBe(200);
    const t = (await json(await owner(`/api/tasks/${run.task.uuid}`))).task;
    expect(t.comments.at(-1)).toMatchObject({ by: run.agent, text: 'Found the sort order.' });
    await release(run.task.uuid);
  });

  it('hold the agent to its person even beside the board’s token, and tell the owner the environment adds it', async () => {
    const run = await lentStart('Count the widgets');
    // The owner's token alone reads the install's health; with the run key beside it, it's ana's request.
    expect((await owner('/api/health')).status).toBe(200);
    const capped = await call('/api/health', { token: TEST_API_TOKEN, key: run.key });
    expect([403, 404]).toContain(capped.status);
    const who = await json(await call('/api/session', { token: TEST_API_TOKEN, key: run.key }));
    expect(who).toMatchObject({ via: 'run-key', person: { handle: ana.handle } });
    // Starting a release is beyond a member, and an agent never does it.
    const released = await call('/api/github/release', {
      method: 'POST',
      token: TEST_API_TOKEN,
      key: run.key,
      body: { repo: 'widgets', version: '1.0.0' },
    });
    expect(released.status).toBe(403);
    // Lending's state says a lent agent arrived with the board's token, so the owner takes it out of the environment.
    const page = await json(await owner('/api/repos/widgets'));
    expect(page.lend.tokenSeenAt).toEqual(expect.any(String));
    await release(run.task.uuid);
  });

  it('name only their own agent, and never take their person’s settings', async () => {
    const run = await lentStart('Name the widgets');
    const other = await json(
      await call(`/api/tasks/${run.task.uuid}/annotate`, {
        method: 'POST',
        key: run.key,
        body: { text: 'As someone else.', by: 'claude-someone-else' },
      }),
    );
    expect(other.status).toBe(403);
    expect(other.error).toBe(`this run key is ${run.agent}’s: name that agent, or none`);
    expect((await call('/api/me', { key: run.key })).status).toBe(403);
    expect((await call('/api/me/tokens', { method: 'POST', key: run.key, body: { name: 'mine' } })).status).toBe(403);
    await release(run.task.uuid);
  });

  it('refuse a request that holds the key itself, so it never reaches a comment or Activity', async () => {
    const run = await lentStart('Hide the widgets');
    const leaked = await json(
      await call(`/api/tasks/${run.task.uuid}/annotate`, {
        method: 'POST',
        key: run.key,
        body: { text: `My key is ${run.key}` },
      }),
    );
    expect(leaked.status).toBe(400);
    expect(leaked.error).toMatch(/that holds your run key/u);
    const t = (await json(await owner(`/api/tasks/${run.task.uuid}`))).task;
    expect(JSON.stringify(t)).not.toContain(run.key);
    const activity = await json(await owner('/api/activity'));
    expect(JSON.stringify(activity)).not.toContain(run.key);
    // The board keeps only its hash.
    const kept = await inStore((store) => store.sql.exec('SELECT * FROM run_keys WHERE task = ?', run.task.uuid).one());
    expect(JSON.stringify(kept)).not.toContain(run.key);
    expect(kept).toMatchObject({ agent: run.agent, handle: ana.handle, repo: 'widgets' });
    await release(run.task.uuid);
  });

  it('end with the run’s claim, and when a new start replaces them', async () => {
    const run = await lentStart('Wash the widgets');
    expect((await call('/api/session', { key: run.key })).status).toBe(200);
    await release(run.task.uuid);
    const ended = await json(await call('/api/session', { key: run.key }));
    expect(ended.status).toBe(401);
    expect(ended.error).toMatch(/this run key has ended/u);
    // With the board's token beside it, an ended key is still refused, never the owner.
    expect((await call('/api/session', { token: TEST_API_TOKEN, key: run.key })).status).toBe(401);
    // A key the board never made says so.
    const made = await json(await call('/api/session', { key: `bkr_${'0'.repeat(64)}` }));
    expect(made).toMatchObject({ status: 401 });
    expect((await json(await call('/api/session', { key: 'bkr_nope' }))).error).toMatch(/isn’t a run key/u);
  });

  it('work on /mcp as the run’s agent, and end there too', async () => {
    const run = await lentStart('Polish the widgets');
    const rpc = (key, method, params = {}) =>
      SELF.fetch(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL,
          'Mcp-Method': method,
          ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
          Authorization: `Bearer ${TEST_API_TOKEN}`,
          [RUN_KEY_HEADER]: key,
          'X-Breakaway-Agent': 'claude-someone-else',
          'X-Breakaway-Repo': 'widgets',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL,
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
    const said = await rpc(run.key, 'tools/call', {
      name: 'comment',
      arguments: { task: run.task.uuid, text: 'From the MCP server.' },
    });
    expect(said.status).toBe(200);
    const t = (await json(await owner(`/api/tasks/${run.task.uuid}`))).task;
    // The run's agent, whatever the headers named.
    expect(t.comments.at(-1)).toMatchObject({ by: run.agent, text: 'From the MCP server.' });
    const leaked = await rpc(run.key, 'tools/call', {
      name: 'comment',
      arguments: { task: run.task.uuid, text: run.key },
    });
    expect(leaked.status).toBe(400);
    await release(run.task.uuid);
    expect((await rpc(run.key, 'tools/list')).status).toBe(401);
  });

  it('end when their person leaves the board', async () => {
    const run = await lentStart('Stack the widgets');
    await inStore((store) => store.dropRunKeys(ana.handle));
    expect((await call('/api/session', { key: run.key })).status).toBe(401);
    await release(run.task.uuid);
  });

  it('are left out of what an agent session shows', () => {
    const key = `bkr_${'ab'.repeat(32)}`;
    expect(redact(`Run key: ${key}`)).toBe('Run key: [redacted]');
    expect(redact(`npx breakaway run-key ${key}`)).toBe('npx breakaway run-key [redacted]');
    expect(redact(`BREAKAWAY_RUN_KEY=${key}`)).toBe('BREAKAWAY_RUN_KEY=[redacted]');
  });

  it('come from their own header, or a bearer that is one', () => {
    const key = `bkr_${'cd'.repeat(32)}`;
    const request = (headers) => new Request(ORIGIN, { headers });
    expect(runKeyOf(request({ [RUN_KEY_HEADER]: ` ${key} ` }))).toBe(key);
    expect(runKeyOf(request({ Authorization: `Bearer ${key}` }))).toBe(key);
    expect(runKeyOf(request({ Authorization: `Bearer ${TEST_API_TOKEN}` }))).toBe('');
    expect(runKeyOf(request({}))).toBe('');
  });
});

describe('lending, from before run keys', () => {
  it('stays off where it was on, with the reason, until the owner connects a lent routine', async () => {
    await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
    await inStore((store) => store.setMeta('routine_lent:widgets', 'on'));
    try {
      const page = await json(await owner('/api/repos/widgets'));
      expect(page.routineLent).toBe(false);
      expect(page.lend).toMatchObject({ lent: false, waits: expect.stringMatching(/a routine of its own/u) });
      const t = await task(unique('Lent before'));
      const refused = await json(
        await call('/api/agents/start', { method: 'POST', cookie: ana.cookie, body: { ref: t.uuid } }),
      );
      expect(refused.status).toBe(403);
      const back = await json(
        await call('/api/repos/widgets/routine/lend', { method: 'PUT', cookie: session, body: LENT }),
      );
      expect(back).toMatchObject({ status: 201, lent: true, waits: null });
    } finally {
      await inStore((store) => store.setMeta('routine_lent:widgets', null));
    }
  });
});
