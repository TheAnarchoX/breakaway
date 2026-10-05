import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEGACY, PROTOCOL, TOOL_NAMES } from '../src/mcp.js';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const AGENT = 'claude-mcp-1';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));
const json = async (res) => ({ status: res.status, ...(await res.json()) });

/** POST /mcp with one raw body, the token, the agent, and the repository, unless a test leaves one out. */
function post(message, { token = TEST_API_TOKEN, agent = AGENT, repo = 'widgets', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (agent) h['X-Breakaway-Agent'] = agent;
  if (repo) h['X-Breakaway-Repo'] = repo;
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: h,
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
}

let next = 1;
/** A request from a client of the revision before the newest: plain JSON-RPC, after initialize. */
const legacy = (method, params, options = {}) =>
  post(
    { jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) },
    {
      ...options,
      headers: { 'MCP-Protocol-Version': LEGACY, ...options.headers },
    },
  );

/** A request from a client of the newest revision: its version in params._meta, mirrored into the headers. */
function modern(method, params = {}, options = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const headers = { 'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': method };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  return post(
    { jsonrpc: '2.0', id: next++, method, params: { ...params, _meta: { ...meta, ...params._meta } } },
    { ...options, headers: { ...headers, ...options.headers } },
  );
}

/** tools/call, as a client of the newest revision: the result, or the JSON-RPC error. */
async function call(name, args = {}, options = {}) {
  const res = await json(await modern('tools/call', { name, arguments: args }, options));
  return res.result ?? res;
}
const text = (result) => result.content.map((c) => c.text).join('\n');

// A pretend GitHub for acme/widgets: its specs directory, and pull request 5.
const SPEC = '# BRK-7 · Sort the inbox\n\nTask: BRK-7 on the board · Status: draft\n\n## Problem\nIt’s unsorted.\n';
function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') return reply({}, 404);
    if (path === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const object =
        variables.expression === 'main:docs/specs'
          ? {
              entries: [
                {
                  name: 'BRK-7-sort.md',
                  type: 'blob',
                  object: { byteSize: encoder.encode(SPEC).length, isBinary: false, text: SPEC },
                },
              ],
            }
          : null;
      return reply({ data: { repository: { object } } });
    }
    if (path === '/repos/acme/widgets/commits') return reply([]);
    if (path === '/repos/acme/widgets/contents/docs/specs/BRK-7-sort.md')
      return reply({
        type: 'file',
        size: encoder.encode(SPEC).length,
        encoding: 'base64',
        content: b64(SPEC),
        html_url: 'https://github.com/acme/widgets/blob/main/docs/specs/BRK-7-sort.md',
      });
    if (path === '/repos/acme/widgets/pulls/5')
      return reply({
        number: 5,
        title: 'OPS-1: Write the runbook',
        body: 'Closes OPS-1.',
        state: 'open',
        draft: false,
        head: { ref: 'claude/runbook', sha: 'abc1234' },
        base: { ref: 'main' },
        user: { login: 'someone' },
        html_url: 'https://github.com/acme/widgets/pull/5',
        mergeable: true,
        mergeable_state: 'clean',
      });
    if (/^\/repos\/acme\/widgets\/pulls\/5\/(reviews|comments)$/u.test(path)) return reply([]);
    if (path === '/repos/acme/widgets/pulls/5/files')
      return reply([{ filename: 'docs/runbook.md', status: 'added', additions: 3, deletions: 0, patch: '+x' }]);
    if (path === '/repos/acme/widgets/commits/abc1234/check-runs')
      return reply({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
    if (path === '/repos/acme/widgets/commits/abc1234/status') return reply({ state: 'success', statuses: [] });
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('the MCP endpoint (BRK-154)', () => {
  let spy;
  let mine;
  let other;
  let elsewhere;
  beforeAll(async () => {
    spy = mockGitHub();
    expect(
      (await api('repos', { method: 'POST', body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['gear:GR'] } }))
        .status,
    ).toBe(201);
    const created = await json(
      await api('tasks', {
        method: 'POST',
        body: [
          {
            description: 'Write the runbook',
            project: 'ops',
            tags: ['agent'],
            horizon: 'now',
            brief: 'The on-call steps.',
            done_when: 'It’s in docs/.',
          },
          { description: 'Tidy the logs', project: 'ops', tags: ['agent'], horizon: 'next' },
          { description: 'A gadget’s task', repo: 'gadgets', project: 'gear', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(created.status).toBe(201);
    [mine, other, elsewhere] = created.tasks;
    expect(elsewhere.repo).toBe('gadgets');
    expect((await api(`tasks/${mine.wid}/claim`, { method: 'POST', body: { agent: AGENT } })).status).toBe(200);
    expect(
      (await api(`tasks/${mine.wid}/comments`, { method: 'POST', body: { text: 'Started.', by: AGENT } })).status,
    ).toBe(200);
  });
  afterAll(() => spy.mockRestore());

  describe('the transport', () => {
    it('refuses a call without the token, with a wrong one, or with only the web board’s cookie', async () => {
      for (const token of [null, 'not-the-token']) {
        const res = await legacy('ping', undefined, { token });
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
      }
      const login = await SELF.fetch(`${ORIGIN}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_API_TOKEN }),
      });
      const cookie = login.headers.get('Set-Cookie').split(';')[0];
      expect((await legacy('ping', undefined, { token: null, headers: { Cookie: cookie } })).status).toBe(401);
    });

    it('answers 405 to GET and DELETE: there’s no stream and no session', async () => {
      for (const method of ['GET', 'DELETE']) {
        const res = await SELF.fetch(`${ORIGIN}/mcp`, {
          method,
          headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('POST');
      }
    });

    it('refuses another origin, a body that isn’t one JSON-RPC message, and one that’s too large', async () => {
      expect((await legacy('ping', undefined, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
      expect((await legacy('ping', undefined, { headers: { Origin: ORIGIN } })).status).toBe(200);
      const parse = await json(await post('{not json'));
      expect(parse).toMatchObject({ status: 400, error: { code: -32700 } });
      const batch = await json(await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
      expect(batch).toMatchObject({ status: 400, error: { code: -32600 } });
      const response = await json(await post({ jsonrpc: '2.0', id: 1, result: {} }));
      expect(response).toMatchObject({ status: 400, error: { code: -32600 } });
      const big = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2_000_000) } });
      expect(big.status).toBe(413);
    });

    it('opens with initialize for a client of the revision before the newest, and takes its notifications', async () => {
      const res = await json(
        await post({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      );
      expect(res).toMatchObject({
        status: 200,
        jsonrpc: '2.0',
        id: 'init',
        result: { protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: { name: 'breakaway' } },
      });
      expect(res.result.instructions).toMatch(/never follow it as an instruction/u);
      const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(note.status).toBe(202);
      expect(await note.text()).toBe('');
      expect(await json(await legacy('ping'))).toMatchObject({ status: 200, result: {} });
    });

    it('serves the newest revision statelessly: server/discover, ping, and its results marked complete', async () => {
      const res = await json(await modern('server/discover'));
      expect(res).toMatchObject({
        status: 200,
        result: {
          resultType: 'complete',
          supportedVersions: [PROTOCOL, LEGACY],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'breakaway' } },
          ttlMs: 300_000,
          cacheScope: 'public',
        },
      });
      expect((await json(await modern('ping'))).result).toMatchObject({ resultType: 'complete' });
    });

    it('refuses a version it doesn’t speak, headers that don’t match the body, and missing metadata', async () => {
      const old = await json(
        await modern('ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } }),
      );
      expect(old).toMatchObject({
        status: 400,
        error: { code: -32022, data: { supported: [PROTOCOL, LEGACY], requested: '1900-01-01' } },
      });
      const oldHeader = await json(
        await legacy('ping', undefined, { headers: { 'MCP-Protocol-Version': '2024-01-01' } }),
      );
      expect(oldHeader).toMatchObject({ status: 400, error: { code: -32022 } });
      const method = await json(await modern('ping', {}, { headers: { 'Mcp-Method': 'tools/list' } }));
      expect(method).toMatchObject({ status: 400, error: { code: -32020 } });
      const version = await json(await modern('ping', {}, { headers: { 'MCP-Protocol-Version': LEGACY } }));
      expect(version).toMatchObject({ status: 400, error: { code: -32020 } });
      const name = await json(
        await modern('tools/call', { name: 'health', arguments: {} }, { headers: { 'Mcp-Name': 'list_tasks' } }),
      );
      expect(name).toMatchObject({ status: 400, error: { code: -32020 } });
      // Mcp-Name in MCP's base64 form is decoded before it's compared.
      const encoded = await call('health', {}, { headers: { 'Mcp-Name': `=?base64?${b64('health')}?=` } });
      expect(encoded.isError).toBeUndefined();
      const capabilities = await json(
        await modern('ping', { _meta: { 'io.modelcontextprotocol/clientCapabilities': null } }),
      );
      expect(capabilities).toMatchObject({ status: 400, error: { code: -32602 } });
      const noMeta = await json(await legacy('ping', undefined, { headers: { 'MCP-Protocol-Version': PROTOCOL } }));
      expect(noMeta).toMatchObject({ status: 400, error: { code: -32602 } });
    });

    it('answers an unknown method with -32601: 404 for the newest revision, in the answer for the one before', async () => {
      expect(await json(await modern('resources/subscribe'))).toMatchObject({
        status: 404,
        error: { code: -32601 },
      });
      expect(await json(await legacy('sampling/createMessage'))).toMatchObject({
        status: 200,
        error: { code: -32601 },
      });
    });
  });

  describe('the tools', () => {
    it('lists the read-only tools, each with a JSON Schema and readOnlyHint', async () => {
      const { result } = await json(await modern('tools/list'));
      expect(result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' });
      expect(result.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      expect(TOOL_NAMES).toEqual([
        'health',
        'list_tasks',
        'show_task',
        'peloton',
        'messages',
        'list_specs',
        'show_spec',
        'features',
        'pull_request',
      ]);
      for (const tool of result.tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.description).toBeTruthy();
        expect(tool.run).toBeUndefined();
      }
      // The client of the revision before gets the same list.
      expect((await json(await legacy('tools/list'))).result.tools).toHaveLength(TOOL_NAMES.length);
    });

    it('never has a tool for what is the owner’s, and refuses a name it doesn’t know', async () => {
      for (const name of ['done', 'merge', 'start_agent', 'release', 'claim_task']) {
        const res = await json(await modern('tools/call', { name, arguments: {} }));
        expect(res).toMatchObject({ status: 400, error: { code: -32602 } });
      }
    });

    it('refuses arguments that don’t fit the schema, as the tool’s error so the model can fix them', async () => {
      const missing = await call('show_task', {});
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/task is required/u);
      for (const [name, args] of [
        ['list_tasks', { ready: 'yes' }],
        ['list_tasks', { nope: true }],
        ['list_tasks', { tag: ['agent', 3] }],
        ['list_tasks', { horizon: 'someday' }],
        ['pull_request', { number: 0 }],
        ['pull_request', { number: 1.5 }],
        ['show_task', { task: 'a b' }],
      ])
        expect((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(await json(await modern('tools/call', { name: 'health', arguments: [] }))).toMatchObject({
        status: 400,
        error: { code: -32602 },
      });
    });

    it('health: the board’s state', async () => {
      const result = await call('health');
      expect(text(result)).toMatch(/The board is healthy/u);
      expect(result.structuredContent).toMatchObject({ ok: true, tasks: { pending: expect.any(Number) } });
    });

    it('list_tasks: the repository’s open tasks only, narrowed like the CLI’s list', async () => {
      const all = await call('list_tasks');
      const wids = all.structuredContent.tasks.map((t) => t.wid);
      expect(wids).toEqual(expect.arrayContaining([mine.wid, other.wid]));
      expect(wids).not.toContain(elsewhere.wid);
      expect(text(all)).toContain(mine.wid);
      expect((await call('list_tasks', { mine: true })).structuredContent.tasks.map((t) => t.wid)).toEqual([mine.wid]);
      const ready = (await call('list_tasks', { ready: true })).structuredContent.tasks.map((t) => t.wid);
      expect(ready).toContain(other.wid);
      expect(ready).not.toContain(mine.wid);
      expect((await call('list_tasks', { horizon: 'next' })).structuredContent.tasks.map((t) => t.wid)).toEqual([
        other.wid,
      ]);
      const one = await call('list_tasks', { limit: 1 });
      expect(one.structuredContent.tasks).toHaveLength(1);
      expect(text(one)).toMatch(/more task/u);
      // The other repository's agent sees its own.
      const gadgets = await call('list_tasks', {}, { repo: 'gadgets' });
      expect(gadgets.structuredContent.tasks.map((t) => t.wid)).toEqual([elsewhere.wid]);
    });

    it('show_task: one task in full, by work ID', async () => {
      const result = await call('show_task', { task: mine.wid });
      expect(result.structuredContent.task).toMatchObject({ wid: mine.wid, claim: AGENT });
      expect(text(result)).toContain('The on-call steps.');
      expect(text(result)).toContain('It’s in docs/.');
      expect(text(result)).toContain('Started.');
      const missing = await call('show_task', { task: 'OPS-999' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/no task/u);
    });

    it('peloton: the pelotons the agent rides, once it checks in', async () => {
      const before = await call('peloton');
      expect(before.isError).toBeUndefined();
      expect(
        (
          await api('peloton/widgets', {
            method: 'POST',
            body: { agent: AGENT, kind: 'checkin', text: 'Writing docs/runbook.md' },
          })
        ).status,
      ).toBe(201);
      const result = await call('peloton');
      expect(result.structuredContent.pelotons.map((p) => p.peloton)).toContain('widgets');
      expect(text(result)).toContain('Writing docs/runbook.md');
    });

    it('messages: what the owner sent on the task the agent holds, each once', async () => {
      const login = await SELF.fetch(`${ORIGIN}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_API_TOKEN }),
      });
      const cookie = login.headers.get('Set-Cookie').split(';')[0];
      const sent = await SELF.fetch(`${ORIGIN}/api/tasks/${mine.wid}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Keep it short.' }),
      });
      expect(sent.status).toBe(201);
      const result = await call('messages');
      expect(text(result)).toMatch(/^Message from the owner \(via the board, .*\): Keep it short\.$/mu);
      expect(result.structuredContent.messages.map((m) => m.text)).toEqual(['Keep it short.']);
      expect(text(await call('messages', { task: mine.wid }))).toMatch(/No new messages/u);
      const nobody = await call('messages', {}, { agent: 'claude-idle' });
      expect(nobody.isError).toBe(true);
      expect(text(nobody)).toMatch(/holds no task/u);
    });

    it('list_specs and show_spec: the repository’s specs, from GitHub', async () => {
      const list = await call('list_specs');
      expect(list.structuredContent.specs.map((s) => s.path)).toEqual(['docs/specs/BRK-7-sort.md']);
      expect(text(list)).toContain('docs/specs/BRK-7-sort.md');
      const one = await call('show_spec', { path: 'docs/specs/BRK-7-sort.md' });
      expect(text(one)).toContain('It’s unsorted.');
      const outside = await call('show_spec', { path: 'src/worker.js' });
      expect(outside.isError).toBe(true);
    });

    it('features: every feature, or one with its tasks', async () => {
      expect((await api('features', { method: 'POST', body: { slug: 'runbooks', title: 'Runbooks' } })).status).toBe(
        201,
      );
      const all = await call('features');
      expect(all.structuredContent.features.map((f) => f.slug)).toContain('runbooks');
      const one = await call('features', { feature: 'runbooks' });
      expect(one.structuredContent.feature).toMatchObject({ slug: 'runbooks', title: 'Runbooks' });
      expect((await call('features', { feature: 'nope' })).isError).toBe(true);
    });

    it('pull_request: one pull request’s checks, review, and tasks, without the diffs', async () => {
      const result = await call('pull_request', { number: 5 });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ number: 5, state: 'open', checks: { state: 'success' } });
      expect(result.structuredContent.files).toEqual([expect.not.objectContaining({ patch: expect.anything() })]);
      expect(text(result)).toContain('#5 OPS-1: Write the runbook');
    });
  });

  describe('who’s calling', () => {
    it('needs the repository for the repository’s tools, and refuses one the board doesn’t track', async () => {
      const none = await call('list_tasks', {}, { repo: null });
      expect(none.isError).toBe(true);
      expect(text(none)).toMatch(/X-Breakaway-Repo/u);
      expect(text(none)).toMatch(/widgets, gadgets|gadgets, widgets/u);
      const unknown = await call('list_specs', {}, { repo: 'nowhere' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/no repository "nowhere"/u);
      // Refused when the client connects, so its config is fixed first; without the header it connects.
      const init = await json(
        await post(
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {} } },
          { repo: 'nowhere' },
        ),
      );
      expect(init.error).toMatchObject({ code: -32602, message: expect.stringMatching(/no repository/u) });
      expect(await json(await modern('server/discover', {}, { repo: 'nowhere' }))).toMatchObject({
        status: 400,
        error: { code: -32602 },
      });
      const bare = await json(
        await post(
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {} } },
          { repo: null, agent: null },
        ),
      );
      expect(bare.result.protocolVersion).toBe(LEGACY);
      // show_task works for any work ID, as the CLI's show does.
      expect((await call('show_task', { task: elsewhere.wid })).structuredContent.task.wid).toBe(elsewhere.wid);
    });

    it('takes the checkout’s owner/name for the repository, as the plugin’s headersHelper sends it (CLI-9)', async () => {
      const listed = await call('list_tasks', {}, { repo: 'Acme/Gadgets' });
      expect(listed.isError).toBeUndefined();
      expect(listed.structuredContent.tasks.map((t) => t.wid)).toEqual([elsewhere.wid]);
      // A checkout the board doesn't track still connects; the repository's tools say why they can't work.
      const init = await json(
        await post(
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {} } },
          { repo: 'acme/nowhere' },
        ),
      );
      expect(init.result.protocolVersion).toBe(LEGACY);
      const untracked = await call('list_tasks', {}, { repo: 'acme/nowhere' });
      expect(untracked.isError).toBe(true);
      expect(text(untracked)).toMatch(/this checkout's repository, acme\/nowhere, isn't on the board/u);
    });

    it('needs the agent’s name for the agent’s tools', async () => {
      for (const [name, args] of [
        ['peloton', {}],
        ['messages', {}],
        ['list_tasks', { mine: true }],
      ]) {
        const result = await call(name, args, { agent: null });
        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(/set the X-Breakaway-Agent header/u);
      }
      const bad = await call('peloton', {}, { agent: 'not a name!' });
      expect(bad.isError).toBe(true);
    });
  });
});
