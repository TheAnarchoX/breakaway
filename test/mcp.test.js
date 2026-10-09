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
        // It names where MCP apps sign in instead (BRK-157).
        expect(res.headers.get('WWW-Authenticate')).toBe(
          `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        );
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
    it('lists section 3’s tools, each with a JSON Schema, and readOnlyHint on the ones that only read', async () => {
      const { result } = await json(await modern('tools/list'));
      expect(result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' });
      expect(result.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      expect(TOOL_NAMES).toEqual([
        'health',
        'list_tasks',
        'show_task',
        'next_task',
        'claim_task',
        'release_task',
        'comment',
        'quote_owner',
        'add_task',
        'modify_task',
        'ping_owner',
        'review',
        'peloton',
        'peloton_post',
        'messages',
        'list_specs',
        'show_spec',
        'features',
        'pull_request',
        'infra_environments',
        'infra_environment',
        'infra_plans',
        'infra_plan',
        'infra_signals',
        'infra_incidents',
      ]);
      const writes = [
        'next_task',
        'claim_task',
        'release_task',
        'comment',
        'quote_owner',
        'add_task',
        'modify_task',
        'ping_owner',
        'review',
        'peloton_post',
      ];
      for (const tool of result.tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
        expect(tool.annotations.readOnlyHint, tool.name).toBe(!writes.includes(tool.name));
        expect(tool.description).toBeTruthy();
        expect(tool.run).toBeUndefined();
        // No tool takes force, autostart, or a status, whatever a client sends (section 3).
        for (const never of ['force', 'autostart', 'status', 'done'])
          expect(Object.keys(tool.inputSchema.properties), tool.name).not.toContain(never);
      }
      // The client of the revision before gets the same list.
      expect((await json(await legacy('tools/list'))).result.tools).toHaveLength(TOOL_NAMES.length);
    });

    it('never has a tool for what is the owner’s, and refuses a name it doesn’t know', async () => {
      for (const name of [
        'done',
        'merge',
        'start_agent',
        'release',
        'promote',
        'answer_decision',
        'resolve_ping',
        'message_agent',
        'chase',
        'repos_add',
      ]) {
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

  describe('the tools that write (BRK-155)', () => {
    const WRITER = 'claude-mcp-w';
    const as = (agent) => ({ agent });
    let fix;
    let keys;
    let waits;
    beforeAll(async () => {
      const created = await json(
        await api('tasks', {
          method: 'POST',
          body: [
            { description: 'Fix the pager', project: 'ops', tags: ['agent'], horizon: 'now' },
            { description: 'Rotate the keys', project: 'ops', tags: ['agent'], horizon: 'now' },
          ],
        }),
      );
      [fix, keys] = created.tasks;
      const later = await json(
        await api('tasks', {
          method: 'POST',
          body: { description: 'Audit the keys', project: 'ops', tags: ['agent'], depends: [keys.wid] },
        }),
      );
      [waits] = later.tasks;
    });

    it('claim_task, comment, and release_task: the loop, always as the agent the header names', async () => {
      const claimed = await call('claim_task', { task: fix.wid }, as(WRITER));
      expect(claimed.isError).toBeUndefined();
      expect(claimed.structuredContent.task).toMatchObject({ wid: fix.wid, claim: WRITER });
      expect(text(claimed)).toBe(`Claimed ${fix.wid} as ${WRITER}: Fix the pager`);
      // Claiming again is the same claim, not a conflict.
      expect((await call('claim_task', { task: fix.wid }, as(WRITER))).isError).toBeUndefined();

      const commented = await call('comment', { task: fix.wid, text: 'The pager rotates at noon.' }, as(WRITER));
      expect(text(commented)).toBe(`Commented on ${fix.wid}.`);
      expect(commented.structuredContent.task.comments.at(-1)).toMatchObject({
        by: WRITER,
        text: 'The pager rotates at noon.',
      });

      const released = await call('release_task', { task: fix.wid, comment: 'Stopped at the config.' }, as(WRITER));
      expect(text(released)).toBe(`Released ${fix.wid}.`);
      expect(released.structuredContent.task.claim).toBeFalsy();
      expect(released.structuredContent.task.comments.at(-1)).toMatchObject({
        by: WRITER,
        text: 'Stopped at the config.',
      });
    });

    it('claims as the plugin’s agent_name, else the name its headersHelper sends for the branch (CLI-16)', async () => {
      // The plugin's .mcp.json sends agent_name as a static X-Breakaway-Agent, empty when it isn't set, and the
      // helper's X-Breakaway-Agent-Default is claude-<branch>.
      const plugin = (agentName) => ({
        agent: null,
        headers: { 'X-Breakaway-Agent': agentName, 'X-Breakaway-Agent-Default': 'claude-inbox-sort' },
      });
      for (const [agentName, name] of [
        ['claude-wid-2', 'claude-wid-2'],
        ['', 'claude-inbox-sort'],
        ['${user_config.agent_name}', 'claude-inbox-sort'],
      ]) {
        const claimed = await call('claim_task', { task: fix.wid }, plugin(agentName));
        expect(claimed.isError, agentName).toBeUndefined();
        expect(claimed.structuredContent.task.claim).toBe(name);
        expect((await call('release_task', { task: fix.wid }, plugin(agentName))).isError).toBeUndefined();
      }
      // The default is only a default: a name of the client's own comes first, and it's checked like one.
      const own = await call('claim_task', { task: fix.wid }, { headers: { 'X-Breakaway-Agent-Default': 'claude-x' } });
      expect(own.structuredContent.task.claim).toBe(AGENT);
      expect((await call('release_task', { task: fix.wid })).isError).toBeUndefined();
      const reserved = await call(
        'claim_task',
        { task: fix.wid },
        { agent: null, headers: { 'X-Breakaway-Agent-Default': 'owner' } },
      );
      expect(reserved.isError).toBe(true);
      expect(text(reserved)).toMatch(/your own name/u);
    });

    it('refuses a claim with no agent name, on another repository’s task, on a claimed task, and with force', async () => {
      const nameless = await call('claim_task', { task: keys.wid }, as(null));
      expect(nameless.isError).toBe(true);
      expect(text(nameless)).toMatch(/set the X-Breakaway-Agent header/u);

      const elsewhereClaim = await call('claim_task', { task: elsewhere.wid }, as(WRITER));
      expect(elsewhereClaim.isError).toBe(true);
      expect(text(elsewhereClaim)).toMatch(/belongs to gadgets/u);

      // The agent that holds it keeps it: another's claim is refused, and so is its release.
      expect((await call('claim_task', { task: keys.wid }, as(WRITER))).isError).toBeUndefined();
      const taken = await call('claim_task', { task: keys.wid }, as('claude-mcp-other'));
      expect(taken.isError).toBe(true);
      expect(text(taken)).toMatch(/claimed by claude-mcp-w/u);
      const dropped = await call('release_task', { task: keys.wid }, as('claude-mcp-other'));
      expect(dropped.isError).toBe(true);
      expect(text(dropped)).toMatch(/claimed by claude-mcp-w/u);

      const forced = await call('claim_task', { task: keys.wid, force: true }, as('claude-mcp-other'));
      expect(forced.isError).toBe(true);
      expect(text(forced)).toMatch(/there is no argument force/u);

      const blocked = await call('claim_task', { task: waits.wid }, as('claude-mcp-other'));
      expect(blocked.isError).toBe(true);
      expect(text(blocked)).toMatch(/blocked by/u);

      const show = await call('show_task', { task: keys.wid });
      expect(show.structuredContent.task.claim).toBe(WRITER);
    });

    it('never writes as the owner or the board: those names are refused', async () => {
      for (const name of ['owner', 'board', 'routine:nightly', 'Owner']) {
        const result = await call('comment', { task: fix.wid, text: 'Hi.' }, as(name));
        expect(result.isError, name).toBe(true);
        expect(text(result)).toMatch(/your own name/u);
      }
      const { task } = (await call('show_task', { task: fix.wid })).structuredContent;
      expect(task.comments.map((c) => c.text)).not.toContain('Hi.');
    });

    it('next_task: the best ready agent task in the repository, claimed in the same step when asked', async () => {
      const peek = await call('next_task', {}, { repo: 'gadgets', agent: 'claude-gadget' });
      expect(peek.structuredContent.task).toMatchObject({ wid: elsewhere.wid });
      expect(peek.structuredContent.task.claim).toBeFalsy();
      expect(text(peek)).toMatch(/^Next up: /u);

      const taken = await call('next_task', { claim: true }, { repo: 'gadgets', agent: 'claude-gadget' });
      expect(taken.structuredContent.task).toMatchObject({ wid: elsewhere.wid, claim: 'claude-gadget' });
      expect(text(taken)).toMatch(/^Claimed: /u);

      const none = await call('next_task', { claim: true }, { repo: 'gadgets', agent: 'claude-gadget-2' });
      expect(none.structuredContent.task).toBeNull();
      expect(text(none)).toBe('Nothing ready for an agent right now.');

      // In widgets it never hands out a gadget's task, and it needs the agent's name.
      const widgets = await call('next_task', {}, as(WRITER));
      expect(widgets.structuredContent.task.repo).toBe('widgets');
      expect((await call('next_task', { claim: true }, as(null))).isError).toBe(true);
      expect((await call('next_task', { autostart: true }, as(WRITER))).isError).toBe(true);
    });

    it('add_task: a new task in the repository, made by the agent, never with a horizon-* tag or autostart', async () => {
      const added = await call(
        'add_task',
        {
          title: 'Document the pager',
          project: 'ops',
          horizon: 'next',
          tags: ['agent'],
          depends: [fix.wid],
          brief: 'Nobody knows how it rotates.',
          done_when: 'docs/pager.md says how.',
        },
        as(WRITER),
      );
      expect(added.isError).toBeUndefined();
      const task = added.structuredContent.task;
      expect(task).toMatchObject({
        repo: 'widgets',
        project: 'ops',
        horizon: 'next',
        brief: 'Nobody knows how it rotates.',
        doneWhen: 'docs/pager.md says how.',
      });
      expect(task.wid).toMatch(/^OPS-\d+$/u);
      expect(task.tags).toContain('agent');
      expect(task.dependsOn.map((d) => d.wid)).toEqual([fix.wid]);
      expect(text(added)).toBe(`Added ${task.wid}: Document the pager`);

      const asked = await call(
        'add_task',
        {
          title: 'Pick the pager’s vendor',
          project: 'ops',
          tags: ['owner'],
          decision: [{ id: 'vendor', type: 'open', prompt: 'Which vendor?' }],
        },
        as(WRITER),
      );
      expect(asked.isError).toBeUndefined();
      expect(asked.structuredContent.task.decision).toEqual([expect.objectContaining({ id: 'vendor' })]);

      const horizon = await call('add_task', { title: 'Sneak in', tags: ['horizon-now'] }, as(WRITER));
      expect(horizon.isError).toBe(true);
      expect(text(horizon)).toMatch(/horizon-\* tag/u);
      for (const extra of [{ autostart: 'yes' }, { status: 'completed' }, { repo: 'gadgets' }]) {
        const refused = await call('add_task', { title: 'Sneak in', ...extra }, as(WRITER));
        expect(refused.isError, JSON.stringify(extra)).toBe(true);
      }
      expect((await call('add_task', { title: 'Nameless' }, as(null))).isError).toBe(true);
      const sneaked = (await call('list_tasks')).structuredContent.tasks.map((t) => t.description);
      expect(sneaked).not.toContain('Sneak in');
      expect(sneaked).not.toContain('Nameless');
    });

    it('add_task: names the open tasks it resembles, and adds it linked or anyway (BRK-283)', async () => {
      const refused = await call('add_task', { title: 'Document how the pager works', project: 'ops' }, as(WRITER));
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(
        /resembles open tasks: OPS-\d+ Document the pager.*with related, or with add_anyway/u,
      );
      const pager = text(refused).match(/(OPS-\d+) Document the pager/u)[1];
      const linked = await call(
        'add_task',
        { title: 'Document how the pager works', project: 'ops', related: [pager] },
        as(WRITER),
      );
      expect(linked.isError).toBeUndefined();
      expect(linked.structuredContent.task.relatedTasks.map((r) => r.wid)).toEqual([pager]);
      const anyway = await call(
        'add_task',
        { title: 'Document the pager again', project: 'ops', add_anyway: true },
        as(WRITER),
      );
      expect(anyway.isError).toBeUndefined();
    });

    it('modify_task: the agent’s own fields on a task it holds, and the description on one it made', async () => {
      const changed = await call(
        'modify_task',
        { task: keys.wid, pr: 12, spec: 'docs/specs/OPS-2-keys.md', tag: ['runbooks'], related: [fix.wid] },
        as(WRITER),
      );
      expect(changed.isError).toBeUndefined();
      expect(changed.structuredContent.task).toMatchObject({ pr: '12', spec: 'docs/specs/OPS-2-keys.md' });
      expect(changed.structuredContent.task.tags).toContain('runbooks');

      // Another agent's task, or one nobody holds, is refused.
      const unheld = await call('modify_task', { task: fix.wid, tag: ['runbooks'] }, as(WRITER));
      expect(unheld.isError).toBe(true);
      expect(text(unheld)).toMatch(/unclaimed: claim it first/u);
      const theirs = await call('modify_task', { task: keys.wid, tag: ['x'] }, as('claude-mcp-other'));
      expect(theirs.isError).toBe(true);
      expect(text(theirs)).toMatch(/claimed by claude-mcp-w/u);

      // Never a horizon-* tag, its status, or autostart.
      for (const args of [
        { tag: ['horizon-later'] },
        { untag: ['horizon-now'] },
        { status: 'completed' },
        { autostart: 'yes' },
        { horizon: 'later' },
        {},
      ]) {
        const refused = await call('modify_task', { task: keys.wid, ...args }, as(WRITER));
        expect(refused.isError, JSON.stringify(args)).toBe(true);
      }
      expect((await call('show_task', { task: keys.wid })).structuredContent.task.status).toBe('pending');

      // The description of a task it made, without holding it; another's description stays the owner's.
      const made = (
        await call(
          'add_task',
          { title: 'Write the pager runbook', project: 'ops', brief: 'A runbook.', add_anyway: true },
          as(WRITER),
        )
      ).structuredContent.task;
      const brief = await call('modify_task', { task: made.wid, brief: 'Step by step.' }, as(WRITER));
      expect(brief.structuredContent.task.brief).toBe('Step by step.');
      const owners = await call('modify_task', { task: fix.wid, brief: 'Rewritten.' }, as(WRITER));
      expect(owners.isError).toBe(true);
      expect(text(owners)).toMatch(/only on a task you made/u);
      // Whatever the agent's name looks like.
      const plain = await call('modify_task', { task: fix.wid, done_when: 'Never.' }, as('pager-bot'));
      expect(plain.isError).toBe(true);
      expect((await call('show_task', { task: fix.wid })).structuredContent.task.doneWhen).toBeFalsy();
    });

    it('ping_owner: a ping on the task the agent holds, and only that', async () => {
      const pinged = await call(
        'ping_owner',
        { task: keys.wid, kind: 'question', message: 'Which key store holds the old keys?' },
        as(WRITER),
      );
      expect(pinged.isError).toBeUndefined();
      expect(pinged.structuredContent.ping).toMatchObject({ kind: 'question', task: keys.wid });
      expect(text(pinged)).toMatch(new RegExp(`^Pinged the owner about ${keys.wid} \\(question\\)`, 'u'));
      const inbox = await json(await api('pings'));
      expect(inbox.pings.map((p) => p.message)).toContain('Which key store holds the old keys?');

      const notHeld = await call('ping_owner', { task: fix.wid, kind: 'blocked', message: 'Help.' }, as(WRITER));
      expect(notHeld.isError).toBe(true);
      expect(text(notHeld)).toMatch(/only the agent that holds/u);
      const secret = await call(
        'ping_owner',
        { task: keys.wid, kind: 'fyi', message: 'The token is ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        as(WRITER),
      );
      expect(secret.isError).toBe(true);
      expect(text(secret)).toMatch(/token or key/u);
      expect((await call('ping_owner', { task: keys.wid, kind: 'urgent', message: 'x' }, as(WRITER))).isError).toBe(
        true,
      );
    });

    it('review: the agent’s verdict goes to the store as the agent, which wants an open pull request', async () => {
      const none = await call('review', { task: keys.wid, verdict: 'ready', note: 'Looks right.' }, as(WRITER));
      expect(none.isError).toBe(true);
      expect(text(none)).toMatch(/no open pull request to review/u);
      const notHeld = await call('review', { task: fix.wid, verdict: 'ready', note: 'Looks right.' }, as(WRITER));
      expect(notHeld.isError).toBe(true);
      expect(text(notHeld)).toMatch(/claim it first/u);
      expect((await call('review', { task: keys.wid, verdict: 'lgtm', note: 'x' }, as(WRITER))).isError).toBe(true);
    });

    it('peloton_post: a check-in, a step, and a reply, as the holder of a claimed task', async () => {
      const checkin = await call(
        'peloton_post',
        { kind: 'checkin', text: 'Rotating the keys in ops/keys.json' },
        as(WRITER),
      );
      expect(checkin.isError).toBeUndefined();
      const [post] = checkin.structuredContent.posts;
      expect(post).toMatchObject({ peloton: 'widgets', agent: WRITER, kind: 'checkin' });
      expect(text(checkin)).toBe(`Posted #${post.id} on widgets.`);

      const reply = await call('peloton_post', { kind: 'reply', reply_to: post.id, text: 'Go first.' }, as(AGENT));
      expect(reply.isError).toBeUndefined();
      expect(reply.structuredContent.posts[0]).toMatchObject({ peloton: 'widgets', replyTo: post.id });

      const step = await call('peloton_post', { kind: 'step', text: 'Rotated; does this affect anyone?' }, as(WRITER));
      expect(step.structuredContent.posts[0]).toMatchObject({ peloton: 'widgets', kind: 'step' });

      const idle = await call('peloton_post', { kind: 'checkin', text: 'Here.' }, as('claude-idle'));
      expect(idle.isError).toBe(true);
      expect(text(idle)).toMatch(/rides no peloton/u);
      expect((await call('peloton_post', { kind: 'reply', text: 'No post.' }, as(WRITER))).isError).toBe(true);
      expect((await call('peloton_post', { kind: 'leave', text: 'Bye.' }, as(WRITER))).isError).toBe(true);
    });
  });
});
