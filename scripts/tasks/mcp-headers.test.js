import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headersRepo, mcpHeaders } from './mcp.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const TOKEN = 'fake-token-for-tests-0123456789abcdef';

describe('mcpHeaders: what the plugin’s headersHelper hands Claude Code (CLI-9)', () => {
  it('sends the token, the agent, and the repository in a tracked checkout', () => {
    expect(mcpHeaders({ token: TOKEN, agent: 'claude-wid-2', repo: 'widgets' })).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'X-Breakaway-Agent': 'claude-wid-2',
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

/** Runs `mcp --headers` in `cwd` with only `settings` from the environment: nothing from this machine's own. */
function headers(cwd, home, settings) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('BREAKAWAY_') && !key.startsWith('CLAUDE_PLUGIN_') && !/proxy/iu.test(key),
    ),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--headers'], {
      cwd,
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
      'X-Breakaway-Agent': 'claude-inbox-sort',
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
      'X-Breakaway-Agent': 'claude-inbox-sort',
      'X-Breakaway-Repo': 'acme/widgets',
    });
  });

  it('prints only Authorization outside a git checkout', async () => {
    const out = await headers(temp(mkdtempSync(join(tmpdir(), 'h-'))), temp(mkdtempSync(join(tmpdir(), 'h-'))), {
      BREAKAWAY_URL: board.url,
      BREAKAWAY_TOKEN: TOKEN,
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
});
