import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_PROTOCOL, checkMcp, mcpAgent, mcpConfig, mcpLines } from './mcp.js';

const TOKEN = 'fake-token-for-tests-0123456789abcdef';
const URL = 'https://board.example.com';

describe('mcpAgent: the name an MCP connection claims as', () => {
  it('takes --as or BREAKAWAY_AGENT first', () => {
    expect(mcpAgent({ named: 'claude-wid-2', branch: 'main', fallback: 'me@host' })).toBe('claude-wid-2');
  });

  it('is claude-<branch> otherwise, as a name the board takes', () => {
    expect(mcpAgent({ branch: 'inbox-sort', fallback: 'me@host' })).toBe('claude-inbox-sort');
    expect(mcpAgent({ branch: 'feature/inbox sort', fallback: 'me@host' })).toBe('claude-feature-inbox-sort');
    expect(mcpAgent({ branch: 'claude/wid-2', fallback: 'me@host' })).toBe('claude-wid-2');
    expect(mcpAgent({ branch: 'x'.repeat(80), fallback: 'me@host' })).toHaveLength(64);
  });

  it('falls back to the CLI’s default outside a branch', () => {
    expect(mcpAgent({ branch: 'HEAD', fallback: 'me@host' })).toBe('me@host');
    expect(mcpAgent({ branch: null, fallback: 'me@host' })).toBe('me@host');
  });
});

describe('mcpConfig: the claude mcp add line and the .mcp.json entry (IDEA-24, section 5)', () => {
  const config = mcpConfig({ url: `${URL}/`, agent: 'claude-wid-2', repo: 'widgets', tokenVar: 'BREAKAWAY_TOKEN' });

  it('prints a line that connects Claude Code with the three headers, and the token as a variable', () => {
    expect(config.command).toBe(
      [
        `claude mcp add --transport http breakaway ${URL}/mcp`,
        '  --header "Authorization: Bearer $BREAKAWAY_TOKEN"',
        '  --header "X-Breakaway-Agent: claude-wid-2"',
        '  --header "X-Breakaway-Repo: widgets"',
      ].join(' \\\n'),
    );
  });

  it('writes the .mcp.json entry with ${…} for Claude Code to fill in', () => {
    expect(config.json).toEqual({
      mcpServers: {
        breakaway: {
          type: 'http',
          url: `${URL}/mcp`,
          headers: {
            Authorization: 'Bearer ${BREAKAWAY_TOKEN}',
            'X-Breakaway-Agent': 'claude-wid-2',
            'X-Breakaway-Repo': 'widgets',
          },
        },
      },
    });
  });

  it('leaves out X-Breakaway-Repo outside a tracked repository, and says so', () => {
    const bare = mcpConfig({ url: URL, agent: 'me@host', tokenVar: 'BREAKAWAY_TOKEN' });
    expect(bare.command).not.toContain('X-Breakaway-Repo');
    expect(bare.json.mcpServers.breakaway.headers).not.toHaveProperty('X-Breakaway-Repo');
    const text = mcpLines(bare, { tokenVar: 'BREAKAWAY_TOKEN' }).join('\n');
    expect(text).toContain('isn’t a repository the board tracks');
  });

  it('never holds a token’s value', () => {
    const text = mcpLines(config, { repo: 'widgets', tokenVar: 'BREAKAWAY_TOKEN' }).join('\n');
    expect(text).toContain(config.command);
    expect(text).toContain('"Authorization": "Bearer ${BREAKAWAY_TOKEN}"');
    expect(text).not.toMatch(/Bearer [^$]/u);
  });
});

/** A fake /mcp: answers each JSON-RPC method from `answers`, recording what it was sent. */
function fakeBoard(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    const message = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, message });
    const answer = answers[message.method];
    if (answer instanceof Error) throw answer;
    const { status = 200, body } = typeof answer === 'function' ? answer(message) : answer;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const rpc = (message, result) => ({ body: { jsonrpc: '2.0', id: message.id, result } });

describe('checkMcp: whether the board’s MCP server answers (--check)', () => {
  const endpoint = `${URL}/mcp`;

  it('speaks the revision /mcp takes an initialize in', () => {
    const server = readFileSync(new globalThis.URL('../../src/mcp.js', import.meta.url), 'utf8');
    expect(server).toContain(`export const LEGACY = '${CHECK_PROTOCOL}';`);
  });

  it('calls initialize and tools/list with the config’s headers, and reports the server and its tools', async () => {
    const board = fakeBoard({
      initialize: (m) =>
        rpc(m, { protocolVersion: CHECK_PROTOCOL, serverInfo: { name: 'breakaway', version: '1.6.0' } }),
      'tools/list': (m) => rpc(m, { tools: [{ name: 'health' }, { name: 'list_tasks' }] }),
    });
    const out = await checkMcp({ endpoint, token: TOKEN, agent: 'claude-wid-2', repo: 'widgets', fetch: board.fetch });
    expect(out.ok).toBe(true);
    expect(out.lines.join('\n')).toBe(
      [
        `The board's MCP server answers at ${endpoint}: breakaway 1.6.0, MCP ${CHECK_PROTOCOL}.`,
        '2 tools: health, list_tasks.',
        'As claude-wid-2, in widgets.',
      ].join('\n'),
    );
    expect(board.calls.map((c) => c.message.method)).toEqual(['initialize', 'tools/list']);
    expect(board.calls[0].url).toBe(endpoint);
    expect(board.calls[0].headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent': 'claude-wid-2',
      'X-Breakaway-Repo': 'widgets',
    });
    expect(board.calls[1].headers['MCP-Protocol-Version']).toBe(CHECK_PROTOCOL);
    expect(out.lines.join('\n')).not.toContain(TOKEN);
  });

  it('sends no Authorization without a token, so a session’s proxy can add it', async () => {
    const board = fakeBoard({
      initialize: (m) => rpc(m, { protocolVersion: CHECK_PROTOCOL, serverInfo: { name: 'breakaway' } }),
      'tools/list': (m) => rpc(m, { tools: [] }),
    });
    const out = await checkMcp({ endpoint, agent: 'me@host', fetch: board.fetch });
    expect(out.ok).toBe(true);
    expect(board.calls[0].headers).not.toHaveProperty('Authorization');
    expect(board.calls[0].headers).not.toHaveProperty('X-Breakaway-Repo');
    expect(out.lines[2]).toContain('in no repository');
  });

  it('reports the board’s error when it refuses the token', async () => {
    const board = fakeBoard({
      initialize: { status: 401, body: { error: 'send the board’s token as "Authorization: Bearer <token>"' } },
    });
    const out = await checkMcp({ endpoint, token: 'wrong', agent: 'me@host', fetch: board.fetch });
    expect(out.ok).toBe(false);
    expect(out.lines[0]).toBe(
      `The board's MCP server didn't answer: ${endpoint} refused the token (401): send the board’s token as "Authorization: Bearer <token>"`,
    );
  });

  it('reports a JSON-RPC error in the board’s words, like a repository it doesn’t track', async () => {
    const board = fakeBoard({
      initialize: (m) => ({
        status: 400,
        body: {
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32602, message: 'no repository "gadgets" on the board; it has widgets.' },
        },
      }),
    });
    const out = await checkMcp({ endpoint, token: TOKEN, agent: 'me@host', repo: 'gadgets', fetch: board.fetch });
    expect(out.ok).toBe(false);
    expect(out.lines[0]).toContain(
      'initialize failed: no repository "gadgets" on the board; it has widgets. (HTTP 400)',
    );
  });

  it('says to update an install from before /mcp', async () => {
    for (const answer of [
      { status: 404, body: 'Not found' },
      { status: 200, body: '<!doctype html>' },
    ]) {
      const out = await checkMcp({
        endpoint,
        token: TOKEN,
        agent: 'me@host',
        fetch: fakeBoard({ initialize: answer }).fetch,
      });
      expect(out.ok).toBe(false);
      expect(out.lines[0]).toContain('this install has no MCP server yet. Update and deploy it');
    }
  });

  it('says when tools/list fails after initialize', async () => {
    const board = fakeBoard({
      initialize: (m) => rpc(m, { protocolVersion: CHECK_PROTOCOL, serverInfo: { name: 'breakaway' } }),
      'tools/list': { status: 500, body: { error: 'the board failed' } },
    });
    const out = await checkMcp({ endpoint, token: TOKEN, agent: 'me@host', fetch: board.fetch });
    expect(out.ok).toBe(false);
    expect(out.lines[0]).toContain('tools/list failed: the board failed (HTTP 500)');
  });

  it('says when the board can’t be reached', async () => {
    const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const out = await checkMcp({
      endpoint,
      token: TOKEN,
      agent: 'me@host',
      fetch: fakeBoard({ initialize: down }).fetch,
    });
    expect(out).toEqual({
      ok: false,
      lines: [`The board's MCP server didn't answer: can't reach ${endpoint} (ECONNREFUSED)`],
    });
  });
});
