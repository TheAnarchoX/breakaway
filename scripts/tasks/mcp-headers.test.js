import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headersRepo, mcpHeaders } from './mcp.js';
import { settingFrom } from './settings.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const TOKEN = 'fake-token-for-tests-0123456789abcdef';

describe('mcpHeaders: what the plugin’s headersHelper hands Claude Code (CLI-9)', () => {
  it('sends the token, the agent, and the repository in a tracked checkout', () => {
    expect(mcpHeaders({ token: TOKEN, named: 'claude-wid-2', agent: 'claude-wid-2', repo: 'widgets' })).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent': 'claude-wid-2',
      'X-Breakaway-Repo': 'widgets',
    });
  });

  it('sends claude-<branch> only as the default when the CLI has no name of its own, so agent_name comes first (CLI-16)', () => {
    expect(mcpHeaders({ token: TOKEN, agent: 'claude-inbox-sort', repo: 'widgets' })).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent-Default': 'claude-inbox-sort',
      'X-Breakaway-Repo': 'widgets',
    });
  });

  it('sends only Authorization outside a repository the board tracks', () => {
    expect(mcpHeaders({ token: TOKEN, agent: 'me@host' })).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('sends no Authorization without a token, so a session’s proxy can add it', () => {
    expect(mcpHeaders({ agent: 'me@host', repo: 'widgets' })).not.toHaveProperty('Authorization');
    expect(mcpHeaders({ agent: 'me@host' })).toEqual({});
  });

  it('sends a lent run’s key in its own header, beside whatever token the proxy adds (BRK-324)', () => {
    const runKey = `bkr_${'4d'.repeat(32)}`;
    expect(mcpHeaders({ runKey, agent: 'claude-wid-3', named: 'claude-wid-3', repo: 'widgets' })).toEqual({
      'X-Breakaway-Run-Key': runKey,
      'X-Breakaway-Agent': 'claude-wid-3',
      'X-Breakaway-Repo': 'widgets',
    });
  });
});

describe('headersRepo: the repository the headers name', () => {
  const registry = { default: 'widgets', repos: [{ slug: 'widgets', github: 'acme/widgets' }] };
  /** A fetch that answers /api/repos with `status` and the registry, recording each URL and its Authorization. */
  const board = (status = 200) => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization ?? null });
      return Response.json(status === 200 ? registry : { error: 'sign in first' }, { status });
    };
    return { fetch, calls };
  };
  const base = 'https://board.example.com/';

  it('is the board’s slug for the checkout, asked with the token', async () => {
    const b = board();
    expect(await headersRepo({ base, token: TOKEN, remote: 'git@github.com:Acme/widgets.git', fetch: b.fetch })).toBe(
      'widgets',
    );
    expect(b.calls).toEqual([{ url: 'https://board.example.com/api/repos', auth: `Bearer ${TOKEN}` }]);
  });

  it('is null for a checkout the board doesn’t track, or a --repo it doesn’t have', async () => {
    const { fetch } = board();
    expect(await headersRepo({ base, token: TOKEN, remote: 'git@github.com:acme/gadgets.git', fetch })).toBeNull();
    expect(await headersRepo({ base, token: TOKEN, remote: null, fetch })).toBeNull();
    expect(await headersRepo({ base, token: TOKEN, named: 'gadgets', fetch })).toBeNull();
  });

  it('is the checkout’s owner/name when the board can’t be asked: no token, or no answer', async () => {
    const remote = 'https://github.com/Acme/Widgets.git';
    expect(await headersRepo({ base, remote, fetch: board(401).fetch })).toBe('acme/widgets');
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await headersRepo({ base, token: TOKEN, remote, fetch: down })).toBe('acme/widgets');
    expect(await headersRepo({ remote, fetch: down })).toBe('acme/widgets');
    expect(await headersRepo({ named: 'Widgets', remote, fetch: down })).toBe('widgets');
    expect(await headersRepo({ remote: null, fetch: down })).toBeNull();
  });
});

/** A board on localhost that tracks acme/widgets as `widgets`, for the token TOKEN. */
function fakeBoard() {
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'sign in first' });
    if (req.url === '/api/repos')
      return send(200, { default: 'widgets', repos: [{ slug: 'widgets', github: 'acme/widgets' }] });
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/** A git checkout whose origin is `remote`, on the branch inbox-sort. */
function checkout(remote) {
  const dir = mkdtempSync(join(tmpdir(), 'breakaway-mcp-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'inbox-sort');
  git('remote', 'add', 'origin', remote);
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
  return dir;
}

/**
 * Runs `mcp --headers` in `cwd` with only `settings` from the environment: nothing from this machine's own. With `via`,
 * it runs the way Claude Code runs the plugin's helper: from a process working in `via` (the session's checkout).
 */
function headers(cwd, home, settings, via = null) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('BREAKAWAY_') && !key.startsWith('CLAUDE_PLUGIN_') && !/proxy/iu.test(key),
    ),
  );
  return new Promise((resolve) => {
    const parent = `const r = require('node:child_process').spawnSync(process.execPath, [process.argv[1], 'mcp', '--headers'], { cwd: process.argv[2], stdio: 'inherit' }); process.exit(r.status ?? 1);`;
    const child = spawn(process.execPath, via ? ['-e', parent, CLI, cwd] : [CLI, 'mcp', '--headers'], {
      cwd: via ?? cwd,
      env: {
        ...env,
        BREAKAWAY_HOME: home,
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        ...settings,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('npx breakaway mcp --headers (CLI-9)', () => {
  /** @type {{ url: string, close: () => void }} */
  let board;
  /** @type {string[]} */
  const dirs = [];
  const temp = (dir) => {
    dirs.push(dir);
    return dir;
  };
  beforeAll(async () => {
    board = await fakeBoard();
  });
  afterAll(() => {
    board.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('prints the three headers as JSON in a checkout the board tracks, and nothing else', async () => {
    const out = await headers(
      temp(checkout('git@github.com:acme/widgets.git')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      {
        BREAKAWAY_URL: board.url,
        BREAKAWAY_TOKEN: TOKEN,
      },
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent-Default': 'claude-inbox-sort',
      'X-Breakaway-Repo': 'widgets',
    });
    expect(out.stderr).not.toContain(TOKEN);
  });

  it('takes the token and the agent’s name from the plugin’s settings', async () => {
    const out = await headers(
      temp(checkout('https://github.com/acme/widgets')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      {
        BREAKAWAY_URL: board.url,
        CLAUDE_PLUGIN_OPTION_TOKEN: TOKEN,
        CLAUDE_PLUGIN_OPTION_AGENT_NAME: 'claude-wid-2',
      },
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent': 'claude-wid-2',
      'X-Breakaway-Repo': 'widgets',
    });
  });

  it('prints only Authorization in a checkout the board doesn’t track', async () => {
    const out = await headers(
      temp(checkout('git@github.com:acme/gadgets.git')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      {
        BREAKAWAY_URL: board.url,
        BREAKAWAY_TOKEN: TOKEN,
      },
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('names the checkout’s owner/name when it has no token to ask the board with', async () => {
    const out = await headers(
      temp(checkout('git@github.com:acme/widgets.git')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      {
        BREAKAWAY_URL: board.url,
      },
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      'X-Breakaway-Agent-Default': 'claude-inbox-sort',
      'X-Breakaway-Repo': 'acme/widgets',
    });
  });

  it('works in the session’s checkout when Claude Code runs it in the plugin’s folder (CLI-20)', async () => {
    const plugin = temp(mkdtempSync(join(tmpdir(), 'plugin-')));
    const expected = {
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent-Default': 'claude-inbox-sort',
      'X-Breakaway-Repo': 'widgets',
    };
    const settings = { BREAKAWAY_URL: board.url, BREAKAWAY_TOKEN: TOKEN, CLAUDE_PLUGIN_ROOT: plugin };
    const home = temp(mkdtempSync(join(tmpdir(), 'h-')));
    const widgets = temp(checkout('git@github.com:acme/widgets.git'));
    const found = await headers(plugin, home, settings, widgets);
    expect(found.status).toBe(0);
    expect(JSON.parse(found.stdout)).toEqual(expected);
    const named = await headers(plugin, home, { ...settings, CLAUDE_PROJECT_DIR: widgets });
    expect(JSON.parse(named.stdout)).toEqual(expected);
  });

  it('prints only Authorization outside a git checkout', async () => {
    const out = await headers(temp(mkdtempSync(join(tmpdir(), 'h-'))), temp(mkdtempSync(join(tmpdir(), 'h-'))), {
      BREAKAWAY_URL: board.url,
      BREAKAWAY_TOKEN: TOKEN,
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  /**
   * What Claude Code sends to /mcp for the plugin, as it builds it: `.mcp.json`'s static headers with the plugin's
   * options filled in (each option's default, then the person's value), under the helper's.
   */
  const sent = (options, helper) => {
    const { userConfig } = JSON.parse(
      readFileSync(new URL('../../plugin/.claude-plugin/plugin.json', import.meta.url)),
    );
    const values = {
      ...Object.fromEntries(Object.entries(userConfig).flatMap(([k, o]) => ('default' in o ? [[k, o.default]] : []))),
      ...options,
    };
    const { mcpServers } = JSON.parse(readFileSync(new URL('../../plugin/.mcp.json', import.meta.url)));
    const fill = (text) =>
      text.replace(/\$\{user_config\.(\w+)\}/gu, (all, key) => (key in values ? values[key] : all));
    const fixed = Object.fromEntries(Object.entries(mcpServers.breakaway.headers).map(([k, v]) => [k, fill(v)]));
    return { ...fixed, ...helper };
  };

  it('claims as the plugin’s agent_name over MCP, as the session’s CLI does, with nothing else set (CLI-16)', async () => {
    // The helper sees no option and no BREAKAWAY_*: only the server's URL, which Claude Code gives it.
    const out = await headers(
      temp(checkout('git@github.com:acme/widgets.git')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      { CLAUDE_CODE_MCP_SERVER_URL: `${board.url}/mcp` },
    );
    expect(out.status).toBe(0);
    const helper = JSON.parse(out.stdout);
    const options = { board_url: board.url, token: TOKEN, agent_name: 'claude-wid-2' };
    const mcp = sent(options, helper);
    expect(mcp).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent': 'claude-wid-2',
      'X-Breakaway-Repo': 'acme/widgets',
    });
    // The session's Bash gets the options from the plugin's hook (CLI-8), and the CLI claims with the same name.
    const cli = settingFrom('AGENT', { env: { CLAUDE_PLUGIN_OPTION_AGENT_NAME: options.agent_name } });
    expect(cli).toEqual({ value: mcp['X-Breakaway-Agent'], from: 'plugin' });

    // Without agent_name the static header is empty, and /mcp takes the helper's claude-<branch> (test/mcp.test.js).
    const { agent_name: _, ...unset } = options;
    expect(sent(unset, helper)).toMatchObject({
      'X-Breakaway-Agent': '',
      'X-Breakaway-Agent-Default': 'claude-inbox-sort',
    });
  });

  it('keeps a name of the CLI’s own ahead of the plugin’s agent_name, as the CLI does', async () => {
    const out = await headers(
      temp(checkout('git@github.com:acme/widgets.git')),
      temp(mkdtempSync(join(tmpdir(), 'h-'))),
      { CLAUDE_CODE_MCP_SERVER_URL: `${board.url}/mcp`, BREAKAWAY_AGENT: 'claude-mine' },
    );
    expect(sent({ agent_name: 'claude-wid-2' }, JSON.parse(out.stdout))['X-Breakaway-Agent']).toBe('claude-mine');
  });
});
