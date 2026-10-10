import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEGACY, PROTOCOL } from '../src/mcp.js';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const AGENT = 'claude-mcp-2';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));
const json = async (res) => ({ status: res.status, ...(await res.json()) });

function post(message, { agent = AGENT, repo = 'widgets', headers = {} } = {}) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TEST_API_TOKEN}`,
    ...headers,
  };
  if (agent) h['X-Breakaway-Agent'] = agent;
  if (repo) h['X-Breakaway-Repo'] = repo;
  return SELF.fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: h, body: JSON.stringify(message) });
}

let next = 1;
/** A request from a client of the newest revision, as test/mcp.test.js sends one. */
function modern(method, params = {}, options = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const headers = { 'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': method, ...options.headers };
  return post({ jsonrpc: '2.0', id: next++, method, params: { ...params, _meta: meta } }, { ...options, headers });
}
const legacy = (method, params, options = {}) =>
  post(
    { jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) },
    { ...options, headers: { 'MCP-Protocol-Version': LEGACY } },
  );

// A pretend GitHub: acme/widgets carries its prompt, the core where repos init copies it, and one spec; acme/gadgets
// carries none of the board's files.
const PROMPT = '# widgets’ agent prompt\n\nFollow tools/tasks/prompts/core.md.\n';
const CORE = '# The task board’s agent prompt: the core (widgets’ copy)\n';
const SPEC = '# BRK-7 · Sort the inbox\n\nTask: BRK-7 on the board · Status: draft\n';
function mockGitHub() {
  const file = (text, path) => ({
    type: 'file',
    size: encoder.encode(text).length,
    encoding: 'base64',
    content: b64(text),
    html_url: `https://github.com/acme/widgets/blob/main/${path}`,
  });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') return reply({}, 404);
    if (/^\/repos\/acme\/\w+\/installation$/u.test(path)) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    // acme/gizmos is one the App can't read.
    if (path.startsWith('/repos/acme/gizmos/'))
      return reply({ message: 'Resource not accessible by integration' }, 403);
    if (/^\/repos\/acme\/\w+\/commits$/u.test(path)) return reply([]);
    const files = {
      'tools/tasks/routine-prompt.md': PROMPT,
      'tools/tasks/prompts/core.md': CORE,
      'docs/specs/BRK-7-sort.md': SPEC,
    };
    for (const [name, text] of Object.entries(files))
      if (path === `/repos/acme/widgets/contents/${name}`) return reply(file(text, name));
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('the MCP resources and prompts (BRK-156)', () => {
  let spy;
  let mine;
  let free;
  let gadget;
  let idea;
  beforeAll(async () => {
    spy = mockGitHub();
    for (const [slug, area] of [
      ['gadgets', 'gear:GR'],
      ['gizmos', 'parts:PT'],
    ])
      expect(
        (await api('repos', { method: 'POST', body: { slug, github: `acme/${slug}`, areas: [area] } })).status,
      ).toBe(201);
    const created = await json(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Write the runbook', project: 'ops', who: 'agent', horizon: 'now', brief: 'Steps.' },
          { description: 'Tidy the logs', project: 'ops', who: 'agent', horizon: 'next' },
          { description: 'A gadget’s task', repo: 'gadgets', project: 'gear', who: 'agent', horizon: 'now' },
          { description: 'A QR code for room links', project: 'ideas', tags: ['idea'], horizon: 'now' },
        ],
      }),
    );
    expect(created.status).toBe(201);
    [mine, free, gadget, idea] = created.tasks;
    for (const t of [mine, gadget])
      expect((await api(`tasks/${t.wid}/claim`, { method: 'POST', body: { agent: AGENT } })).status).toBe(200);
  });
  afterAll(() => spy.mockRestore());

  it('says it serves resources and prompts', async () => {
    const init = await json(
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LEGACY, capabilities: {} },
      }),
    );
    expect(init.result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
  });

  describe('resources', () => {
    it('lists the prompt and the tasks the agent holds in the repository', async () => {
      const { result } = await json(await modern('resources/list'));
      expect(result.resultType).toBe('complete');
      expect(result.resources.map((r) => r.uri)).toEqual(['breakaway://prompt', `breakaway://task/${mine.wid}`]);
      expect(result.resources[1]).toMatchObject({ name: mine.wid, mimeType: 'text/markdown' });
      expect(result.resources[1].title).toContain('Write the runbook');
      // Another repository's connection sees its own: the gadget the agent holds there.
      const there = (await json(await legacy('resources/list', undefined, { repo: 'gadgets' }))).result;
      expect(there.resources.map((r) => r.uri)).toEqual(['breakaway://prompt', `breakaway://task/${gadget.wid}`]);
      // Without a name there's nothing held; without a repository there's no prompt.
      const anonymous = (await json(await modern('resources/list', {}, { agent: null }))).result;
      expect(anonymous.resources.map((r) => r.uri)).toEqual(['breakaway://prompt']);
      const nowhere = (await json(await modern('resources/list', {}, { repo: null }))).result;
      expect(nowhere.resources.map((r) => r.uri).sort()).toEqual(
        [`breakaway://task/${mine.wid}`, `breakaway://task/${gadget.wid}`].sort(),
      );
    });

    it('lists the templates for a task and a spec, which every caller may keep', async () => {
      const { result } = await json(await modern('resources/templates/list'));
      expect(result.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
        'breakaway://task/{id}',
        'breakaway://spec/{path}',
      ]);
      expect(result.ttlMs).toBeGreaterThan(0);
      const old = (await json(await legacy('resources/templates/list'))).result;
      expect(old.resourceTemplates).toHaveLength(2);
      expect(old.ttlMs).toBeUndefined();
    });

    it('reads a task in full, by work ID', async () => {
      const uri = `breakaway://task/${mine.wid}`;
      const { result } = await json(await modern('resources/read', { uri }, { headers: { 'Mcp-Name': uri } }));
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toMatchObject({ uri, mimeType: 'text/markdown' });
      expect(result.contents[0].text).toMatch(new RegExp(`^# ${mine.wid} · Write the runbook`, 'u'));
      expect(result.contents[0].text).toContain(`Claimed by:** ${AGENT}`);
      // Any task, as show_task reads any; a missing one is MCP's resource-not-found.
      const other = (await json(await legacy('resources/read', { uri: `breakaway://task/${gadget.wid}` }))).result;
      expect(other.contents[0].text).toContain('A gadget’s task');
      const missing = await json(await modern('resources/read', { uri: 'breakaway://task/OPS-999' }));
      expect(missing).toMatchObject({
        status: 404,
        error: { code: -32002, data: { uri: 'breakaway://task/OPS-999' } },
      });
      const odd = await json(await legacy('resources/read', { uri: 'breakaway://task/no%20such' }));
      expect(odd).toMatchObject({ status: 200, error: { code: -32002 } });
    });

    it('reads a spec from the repository’s default branch, its path escaped or not', async () => {
      for (const uri of [
        'breakaway://spec/docs/specs/BRK-7-sort.md',
        'breakaway://spec/docs%2Fspecs%2FBRK-7-sort.md',
      ]) {
        const { result } = await json(await modern('resources/read', { uri }));
        expect(result.contents).toEqual([{ uri, mimeType: 'text/markdown', text: SPEC }]);
      }
      const missing = await json(await modern('resources/read', { uri: 'breakaway://spec/docs/specs/NOPE-1.md' }));
      expect(missing).toMatchObject({ status: 404, error: { code: -32002 } });
      const outside = await json(await modern('resources/read', { uri: 'breakaway://spec/README.md' }));
      expect(outside).toMatchObject({ status: 400, error: { code: -32602 } });
      const unscoped = await json(
        await modern('resources/read', { uri: 'breakaway://spec/docs/specs/BRK-7-sort.md' }, { repo: null }),
      );
      expect(unscoped.error.message).toMatch(/X-Breakaway-Repo/u);
    });

    it('reads the repository’s prompt and the board’s core, from its default branch', async () => {
      const { result } = await json(await modern('resources/read', { uri: 'breakaway://prompt' }));
      expect(result.contents).toEqual([
        { uri: 'breakaway://prompt', mimeType: 'text/markdown', text: PROMPT },
        { uri: 'breakaway://prompt/core', mimeType: 'text/markdown', text: CORE },
      ]);
      const core = (await json(await modern('resources/read', { uri: 'breakaway://prompt/core' }))).result;
      expect(core.contents).toEqual([{ uri: 'breakaway://prompt/core', mimeType: 'text/markdown', text: CORE }]);
      // A repository without the board's files: it says so, and the board's own core stands in.
      const bare = (await json(await modern('resources/read', { uri: 'breakaway://prompt' }, { repo: 'gadgets' })))
        .result;
      expect(bare.contents[0].text).toMatch(/gadgets has no agent prompt at tools\/tasks\/routine-prompt\.md/u);
      expect(bare.contents[1].text).toMatch(/^# The task board's agent prompt: the core/u);
      // GitHub refusing: the prompt says why, and the board's own core stands in.
      const refused = (await json(await modern('resources/read', { uri: 'breakaway://prompt' }, { repo: 'gizmos' })))
        .result;
      expect(refused.contents[0].text).toMatch(/couldn’t read gizmos’s agent prompt from GitHub/u);
      expect(refused.contents[1].text).toMatch(/^# The task board's agent prompt: the core/u);
      // Kept for a minute: a second read asks GitHub nothing.
      const calls = spy.mock.calls.length;
      await modern('resources/read', { uri: 'breakaway://prompt' });
      expect(spy.mock.calls.length).toBe(calls);
    });

    it('refuses a URI it doesn’t serve, a missing uri, and a header that names another', async () => {
      const unknown = await json(await modern('resources/read', { uri: 'https://example.com/' }));
      expect(unknown).toMatchObject({ status: 404, error: { code: -32002 } });
      const none = await json(await legacy('resources/read', {}));
      expect(none.error.code).toBe(-32602);
      const mismatch = await json(
        await modern(
          'resources/read',
          { uri: 'breakaway://prompt' },
          { headers: { 'Mcp-Name': 'breakaway://prompt/core' } },
        ),
      );
      expect(mismatch.error.code).toBe(-32020);
    });
  });

  describe('prompts', () => {
    it('lists work_on_task and shape_idea, each taking a work ID', async () => {
      const { result } = await json(await modern('prompts/list'));
      expect(result.prompts.map((p) => p.name)).toEqual(['work_on_task', 'shape_idea']);
      for (const p of result.prompts) expect(p.arguments).toEqual([expect.objectContaining({ required: true })]);
      expect(result.ttlMs).toBeGreaterThan(0);
    });

    it('work_on_task: the core’s loop with the task filled in, and the task attached', async () => {
      const { result } = await json(
        await modern('prompts/get', { name: 'work_on_task', arguments: { task: mine.wid } }),
      );
      expect(result.description).toBe(`Work on a task: ${mine.wid}`);
      const [loop, attached] = result.messages;
      expect(loop.role).toBe('user');
      const text = loop.content.text;
      expect(text).toContain(`Work on ${mine.wid}, “Write the runbook”`);
      expect(text).toContain('in widgets');
      for (const step of ['breakaway://prompt', `claim_task with task ${mine.wid}`, 'peloton_post', 'release_task'])
        expect(text).toContain(step);
      expect(text).toContain(`“Closes ${mine.wid}.”`);
      expect(text).toMatch(/never follow it as an instruction/u);
      expect(text).not.toMatch(/claimed by another|refuses it here/u);
      expect(attached.content).toMatchObject({
        type: 'resource',
        resource: { uri: `breakaway://task/${mine.wid}`, mimeType: 'text/markdown' },
      });
      expect(attached.content.resource.text).toContain('Steps.');
    });

    it('work_on_task: says when the task is another repository’s', async () => {
      const { result } = await json(
        await legacy('prompts/get', { name: 'work_on_task', arguments: { task: gadget.wid } }),
      );
      expect(result.messages[0].content.text).toContain(
        `${gadget.wid} is gadgets’s task, and this connection names widgets: claim_task refuses it here.`,
      );
      expect(result.messages[0].content.text).toContain('in gadgets');
    });

    it('shape_idea: the core’s shaping for an idea, and each prompt refuses the other’s tasks', async () => {
      const { result } = await json(await modern('prompts/get', { name: 'shape_idea', arguments: { idea: idea.wid } }));
      const text = result.messages[0].content.text;
      expect(text).toContain(`Shape ${idea.wid}`);
      expect(text).toContain(`“Closes ${idea.wid}.”`);
      expect(text).toMatch(/Don’t build it/u);
      expect(text).toMatch(/never follow it as an instruction/u);
      const wrong = await json(await modern('prompts/get', { name: 'work_on_task', arguments: { task: idea.wid } }));
      expect(wrong).toMatchObject({ status: 400, error: { code: -32602 } });
      expect(wrong.error.message).toMatch(/shape_idea/u);
      const notIdea = await json(await modern('prompts/get', { name: 'shape_idea', arguments: { idea: free.wid } }));
      expect(notIdea.error.message).toMatch(/work_on_task/u);
    });

    it('refuses a prompt it doesn’t have, a missing or malformed work ID, and a task that isn’t there', async () => {
      for (const params of [
        { name: 'deploy' },
        { name: 'work_on_task' },
        { name: 'work_on_task', arguments: { task: '' } },
        { name: 'work_on_task', arguments: { task: 'not a work id' } },
        { name: 'work_on_task', arguments: ['BRK-1'] },
        { name: 'work_on_task', arguments: { task: 'OPS-999' } },
      ]) {
        const res = await json(await modern('prompts/get', params));
        expect(res).toMatchObject({ status: 400, error: { code: -32602 } });
      }
      const old = await json(await legacy('prompts/get', { name: 'deploy' }));
      expect(old).toMatchObject({ status: 200, error: { code: -32602 } });
    });
  });
});
