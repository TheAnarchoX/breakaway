// /mcp for a person's own token (BRK-327, docs/specs/BRK-299-people-and-roles.md, point 2): their reads filtered by
// grant and their writes gated by role, exactly as the API's. Fixtures are made-up people (vic, mia) and repositories
// (acme/widgets, acme/gadgets).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL } from '../src/mcp.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const SECRET = 'GADGET-SECRET';
const SPEC = '# WID-7 · Sort the inbox\n\nStatus: draft\n';
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;
const encoder = new TextEncoder();

function api(path, { method = 'GET', body, cookie, token } = {}) {
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
const owner = (path, opts = {}) => api(path, { token: TEST_API_TOKEN, ...opts });

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** Invites a made-up person with `grants` and signs them in: their cookie and a personal token. */
async function person(session, handle, grants) {
  const made = await api('/api/people/invites', { method: 'POST', cookie: session, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await api(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const joined = await api(`/api/join/${code}`, { method: 'POST', body: { challengeId, credential } });
  expect(joined.status).toBe(201);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  const made2 = await api('/api/me/tokens', { method: 'POST', cookie, body: { name: 'mcp' } });
  const { token, id } = await made2.json();
  return { handle, cookie, token, id };
}

let next = 1;
/** A JSON-RPC request from a client of the newest revision, with `token`, as `agent`, in `repo`. */
async function rpc(method, params, { token, agent = 'claude-mcp-p', repo = 'widgets', cookie } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL,
    'Mcp-Method': method,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (agent) headers['X-Breakaway-Agent'] = agent;
  if (repo) headers['X-Breakaway-Repo'] = repo;
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  if (method === 'resources/read') headers['Mcp-Name'] = params.uri;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params: { ...params, _meta: meta } }),
  });
  return { status: res.status, ...(await res.json()) };
}

/** A tool's result: `{ text, data, error }`, where error is whether the board refused it. */
async function tool(name, args, options) {
  const res = await rpc('tools/call', { name, arguments: args ?? {} }, options);
  const result = res.result ?? { content: [{ text: res.error?.message ?? '' }], isError: true };
  return {
    text: result.content.map((c) => c.text).join('\n'),
    data: result.structuredContent,
    error: Boolean(result.isError),
    raw: JSON.stringify(res),
  };
}

let w;
let spy;

beforeAll(async () => {
  // A pretend GitHub with acme/widgets' specs; everything else, gadgets included, isn't found.
  spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.host !== 'api.github.com') return reply({}, 404);
    if (url.pathname === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (url.pathname.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const object =
        variables.expression === 'main:docs/specs'
          ? {
              entries: [
                {
                  name: 'WID-7-sort.md',
                  type: 'blob',
                  object: { byteSize: encoder.encode(SPEC).length, isBinary: false, text: SPEC },
                },
              ],
            }
          : null;
      return reply({ data: { repository: { object } } });
    }
    if (url.pathname === '/repos/acme/widgets/commits') return reply([]);
    if (url.pathname === '/repos/acme/widgets/contents/docs/specs/WID-7-sort.md')
      return reply({
        type: 'file',
        size: encoder.encode(SPEC).length,
        encoding: 'base64',
        content: btoa(SPEC.replace('·', '-')),
        html_url: 'https://github.com/acme/widgets/blob/main/docs/specs/WID-7-sort.md',
      });
    return reply({ message: 'Not Found' }, 404);
  });
  const session = await ownerCookie();
  const added = await owner('/api/repos', {
    method: 'POST',
    body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GAD'], defaultBranch: 'main' },
  });
  expect([201, 400]).toContain(added.status);
  const task = async (body) => {
    const res = await owner('/api/tasks', {
      method: 'POST',
      body: { force: true, project: 'product', tags: ['agent'], horizon: 'now', ...body },
    });
    expect(res.status).toBe(201);
    return (await res.json()).tasks[0];
  };
  const gadget = await task({ description: `${SECRET} task`, repo: 'gadgets' });
  const widget = await task({ description: 'A widget task', depends: [gadget.uuid] });
  const spare = await task({ description: 'Another widget task' });
  await owner(`/api/tasks/${gadget.uuid}/comments`, { method: 'POST', body: { text: `${SECRET} comment` } });
  // Infrastructure in each repository, made straight in the store.
  const infra = await inStore((store) => {
    const now = Date.now();
    const out = {};
    for (const repo of ['widgets', 'gadgets']) {
      const name = unique(`${repo === 'gadgets' ? 'gad' : 'wid'}-env`);
      const envId = store.sql
        .exec(
          "INSERT INTO infra_environments (repo, name, kind, created, edited) VALUES (?, ?, 'staging', ?, ?) RETURNING id",
          repo,
          name,
          now,
          now,
        )
        .one().id;
      const plan = store.sql
        .exec(
          "INSERT INTO infra_plans (environment, repo, provider, source, state, diff, cost, blast, reversible, by, created, updated) VALUES (?, ?, 'fake', 'manual', 'waiting', ?, '{}', '{}', 1, 'owner', ?, ?) RETURNING n",
          envId,
          repo,
          JSON.stringify({ changes: [] }),
          now,
          now,
        )
        .one().n;
      out[repo] = { env: envId, name, plan };
    }
    return out;
  });
  const viewer = await person(session, unique('vic'), [{ repository: 'widgets', role: 'viewer' }]);
  const member = await person(session, unique('mia'), [{ repository: 'widgets', role: 'member' }]);
  w = { session, gadget, widget, spare, viewer, member, ...infra };
}, 120_000);

afterAll(() => spy?.mockRestore());

/** Whatever names acme/gadgets or what's in it. */
const leaks = (text) =>
  [SECRET, 'gadgets', w.gadget.uuid, w.gadget.wid, w.gadgets.name].filter((needle) => text.includes(needle));

describe('a personal token on /mcp (BRK-327)', () => {
  it('opens /mcp, and a revoked or made-up one, or a person’s cookie, doesn’t', async () => {
    const listed = await rpc('tools/list', {}, { token: w.viewer.token });
    expect(listed.status).toBe(200);
    expect(listed.result.tools.map((t) => t.name)).toContain('list_tasks');

    const bad = await rpc('tools/list', {}, { token: `bkp_${'x'.repeat(43)}` });
    expect(bad.status).toBe(401);
    expect(JSON.stringify(bad)).toMatch(/personal token/u);
    // The web board's session is for the browser: /mcp takes a bearer token only.
    expect((await rpc('tools/list', {}, { cookie: w.viewer.cookie })).status).toBe(401);

    const gone = await person(w.session, unique('ron'), [{ repository: 'widgets', role: 'viewer' }]);
    expect((await rpc('ping', {}, { token: gone.token })).status).toBe(200);
    expect((await api(`/api/me/tokens/${gone.id}`, { method: 'DELETE', cookie: gone.cookie })).status).toBe(200);
    expect((await rpc('ping', {}, { token: gone.token })).status).toBe(401);
  });

  it('lets a viewer of acme/widgets list and read its tasks, and nothing of acme/gadgets', async () => {
    const as = { token: w.viewer.token };
    const list = await tool('list_tasks', {}, as);
    expect(list.error).toBe(false);
    expect(list.data.tasks.map((t) => t.uuid)).toContain(w.widget.uuid);
    expect(leaks(list.raw)).toEqual([]);

    const shown = await tool('show_task', { task: w.widget.wid }, as);
    expect(shown.error).toBe(false);
    expect(shown.data.task.description).toBe('A widget task');
    // Its link to a task in acme/gadgets is taken out.
    expect(leaks(shown.raw)).toEqual([]);

    for (const ref of [w.gadget.wid, w.gadget.uuid]) {
      const hidden = await tool('show_task', { task: ref }, as);
      expect(hidden.error).toBe(true);
      expect(hidden.text).toMatch(/no task/u);
      expect(leaks(hidden.text.replace(ref, ''))).toEqual([]);
    }
    expect((await tool('footprint', { task: w.gadget.wid }, as)).error).toBe(true);

    // acme/gadgets isn't on the board, as far as they can see: not even as a repository to name.
    const elsewhere = await tool('list_tasks', {}, { ...as, repo: 'gadgets' });
    expect(elsewhere.error).toBe(true);
    expect(elsewhere.text).toMatch(/no repository "gadgets"/u);
    expect(leaks(elsewhere.text.replace('"gadgets"', ''))).toEqual([]);
    expect((await tool('list_tasks', {}, { ...as, repo: 'acme/gadgets' })).error).toBe(true);

    // The install's own reads are the owner's and the * grant's.
    const health = await tool('health', {}, as);
    expect(health.error).toBe(true);
    expect(health.text).toMatch(/only a viewer on every repository/u);

    const features = await tool('features', {}, as);
    expect(features.error).toBe(false);
    expect(leaks(features.raw)).toEqual([]);
  });

  it('reads acme/widgets’ specs and Infrastructure, and none of acme/gadgets’', async () => {
    const as = { token: w.viewer.token };
    const specs = await tool('list_specs', {}, as);
    expect(specs.error).toBe(false);
    expect(specs.text).toMatch(/WID-7-sort\.md/u);
    expect((await tool('show_spec', { path: 'docs/specs/WID-7-sort.md' }, as)).error).toBe(false);
    expect((await tool('list_specs', {}, { ...as, repo: 'gadgets' })).error).toBe(true);

    const envs = await tool('infra_environments', {}, as);
    expect(envs.error).toBe(false);
    expect(envs.text).toContain(w.widgets.name);
    expect(leaks(envs.raw)).toEqual([]);
    const plans = await tool('infra_plans', {}, as);
    expect(plans.error).toBe(false);
    expect(plans.data.plans.map((p) => p.repo)).toEqual(['widgets']);
    expect((await tool('infra_plan', { plan: `plan-${w.widgets.plan}` }, as)).error).toBe(false);

    // Another repository's, by its ID: not there.
    const plan = await tool('infra_plan', { plan: `plan-${w.gadgets.plan}` }, as);
    expect(plan.error).toBe(true);
    expect(leaks(plan.raw)).toEqual([]);
    const environment = await tool('infra_environment', { environment: String(w.gadgets.env) }, as);
    expect(environment.error).toBe(true);
    expect(leaks(environment.raw)).toEqual([]);
    expect((await tool('infra_environments', {}, { ...as, repo: 'gadgets' })).error).toBe(true);
  });

  it('reads a task as a resource only where the person has a grant', async () => {
    const as = { token: w.viewer.token };
    const mine = await rpc('resources/read', { uri: `breakaway://task/${w.widget.wid}` }, as);
    expect(mine.result.contents[0].text).toContain('A widget task');
    const theirs = await rpc('resources/read', { uri: `breakaway://task/${w.gadget.wid}` }, as);
    expect(theirs.result).toBeUndefined();
    expect(leaks(JSON.stringify(theirs).replaceAll(w.gadget.wid, ''))).toEqual([]);
  });

  it('refuses a viewer’s writes, as the API does', async () => {
    const as = { token: w.viewer.token, agent: 'claude-vic-1' };
    const before = await (await owner(`/api/tasks/${w.spare.uuid}`)).json();
    for (const [name, args] of [
      ['claim_task', { task: w.spare.wid }],
      ['comment', { task: w.spare.wid, text: 'hello' }],
      ['add_task', { title: 'A viewer’s task', project: 'product' }],
      ['next_task', { claim: true }],
    ]) {
      const result = await tool(name, args, as);
      expect(result.error, name).toBe(true);
      expect(result.text, name).toMatch(/only a member in widgets can/u);
    }
    // Reading the next task is a viewer's.
    expect((await tool('next_task', {}, as)).error).toBe(false);
    const after = await (await owner(`/api/tasks/${w.spare.uuid}`)).json();
    expect(after.task.claim ?? null).toBe(before.task.claim ?? null);
    expect(after.task.comments?.length ?? 0).toBe(before.task.comments?.length ?? 0);
  });

  it('lets a member write in acme/widgets as their agent, recorded as theirs, and never in acme/gadgets', async () => {
    const as = { token: w.member.token, agent: 'claude-mia-1' };
    const claimed = await tool('claim_task', { task: w.spare.wid }, as);
    expect(claimed.error).toBe(false);
    expect(claimed.data.task.claim).toBe('claude-mia-1');
    const commented = await tool('comment', { task: w.spare.wid, text: 'Started.' }, as);
    expect(commented.error).toBe(false);
    const added = await tool('add_task', { title: 'A member’s task', project: 'product', add_anyway: true }, as);
    expect(added.error).toBe(false);
    expect(added.data.task.repo ?? 'widgets').toBe('widgets');
    expect((await tool('comment', { task: w.spare.wid, text: 'Started.' }, as)).error).toBe(false);

    // Who did it (BRK-303): the comment is the agent's, and the write is recorded as the person behind the token.
    const { task } = await (await owner(`/api/tasks/${w.spare.uuid}`)).json();
    expect(task.comments.at(-1)).toMatchObject({ by: 'claude-mia-1', text: 'Started.' });
    const latest = await inStore((store) =>
      store.sql.exec('SELECT person, agent FROM versions ORDER BY created DESC, rowid DESC LIMIT 1').one(),
    );
    expect(latest).toEqual({ person: w.member.handle, agent: 'claude-mia-1' });

    // acme/gadgets: no task to claim, comment on, or add to.
    for (const [name, args] of [
      ['claim_task', { task: w.gadget.wid }],
      ['comment', { task: w.gadget.wid, text: 'hello' }],
    ]) {
      const result = await tool(name, args, as);
      expect(result.error, name).toBe(true);
      // As if it weren't there: the role's refusal would name its repository.
      expect(result.text, name).toBe(`no task "${w.gadget.wid}"`);
    }
    // A task added there: the words a read of that repository gets, as the API answers (BRK-337).
    const elsewhere = await tool('add_task', { title: 'x', project: 'product' }, { ...as, repo: 'gadgets' });
    expect(elsewhere.error).toBe(true);
    expect(elsewhere.text).toMatch(/^no repository "gadgets"/u);
    const gadget = await (await owner(`/api/tasks/${w.gadget.uuid}`)).json();
    expect(gadget.task.claim ?? null).toBe(null);
    expect(gadget.task.comments.map((c) => c.text)).toEqual([`${SECRET} comment`]);

    // A member's agent never writes as the owner or as another person.
    expect((await tool('comment', { task: w.spare.wid, text: 'x' }, { ...as, agent: 'owner' })).error).toBe(true);
    const asVic = await tool('comment', { task: w.spare.wid, text: 'x' }, { ...as, agent: w.viewer.handle });
    expect(asVic.error).toBe(true);
    expect(asVic.text).toMatch(/is a person on this board/u);

    expect((await tool('release_task', { task: w.spare.wid }, as)).error).toBe(false);
  });

  it('leaves the owner’s /mcp as it was: every repository, and writes as the agent', async () => {
    const as = { token: TEST_API_TOKEN, agent: 'claude-owner-mcp' };
    expect((await tool('health', {}, as)).error).toBe(false);
    const theirs = await tool('show_task', { task: w.gadget.wid }, as);
    expect(theirs.error).toBe(false);
    expect(theirs.text).toContain(SECRET);
    expect((await tool('list_tasks', {}, { ...as, repo: 'gadgets' })).data.tasks.length).toBeGreaterThan(0);
  });
});
