import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const OLD_TOKEN = 'old-token-for-the-test';

/**
 * A board on localhost that answers health for `token` (as the template's install: the Worker breakaway, Worker
 * secrets) and takes a rekey; it records each request. `accepts` is the token /api/session takes afterwards.
 */
function fakeBoard(token, accepts = () => null) {
  /** @type {{ method: string, path: string, auth: string | null, body: any }[]} */
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const auth = req.headers.authorization ?? null;
      requests.push({ method: req.method ?? '', path: req.url ?? '', auth, body: raw ? JSON.parse(raw) : null });
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/session') return send(auth === `Bearer ${accepts()}` ? 200 : 401, { ok: true });
      if (auth !== `Bearer ${token}`) return send(401, { error: 'sign in first' });
      if (req.url === '/api/health')
        return send(200, {
          ok: true,
          install: { worker: 'breakaway', secretsPrefix: 'BREAKAWAY_', secretsStore: null, installRepository: null },
        });
      if (req.url === '/api/admin/rekey') return send(200, { versions: 3, snapshot: true });
      if (req.url === '/api/repos') return send(200, { repos: [] });
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

/**
 * Runs the CLI with its config folder in `home`, nothing from this machine's own, no proxy, and an `npx` that only
 * records what wrangler would have been asked (each call's arguments and its stdin) in `home/npx.log`.
 */
function run(home, url, ...argv) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('BREAKAWAY_') && !/proxy/iu.test(key)),
  );
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@ <<$(cat)" >> "${join(home, 'npx.log')}"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...env,
        BREAKAWAY_HOME: home,
        HOME: home,
        BREAKAWAY_URL: url,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
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

/** tasks.env's settings, by name. */
const readEnv = (home) =>
  Object.fromEntries(
    readFileSync(join(home, 'tasks.env'), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/u.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

const npxLog = (home) => {
  try {
    return readFileSync(join(home, 'npx.log'), 'utf8');
  } catch {
    return '';
  }
};

describe('rotate-sync and rotate-token work when the old value is lost (CLI-5)', () => {
  /** @type {string} */
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'breakaway-rotate-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rotate-sync re-keys the board and writes new values when tasks.env has no sync secret', async () => {
    writeFileSync(join(home, 'tasks.env'), `BREAKAWAY_TOKEN=${OLD_TOKEN}\n`);
    const board = await fakeBoard(OLD_TOKEN);
    try {
      const result = await run(home, board.url, 'rotate-sync');
      expect(result.stdout).toContain('has no sync secret');
      expect(result.stdout).toContain('Re-encrypted 3 versions and the snapshot');
      const rekey = board.requests.find((r) => r.path === '/api/admin/rekey');
      const env = readEnv(home);
      expect(rekey?.body).toEqual({ clientId: env.BREAKAWAY_CLIENT_ID, key: env.BREAKAWAY_SYNC_KEY });
      expect(env.BREAKAWAY_SECRET).toMatch(/^[\w-]{43}$/u);
      expect(env.BREAKAWAY_TOKEN).toBe(OLD_TOKEN);
      // The template's install keeps Worker secrets: the new client ID and key go on the Worker.
      expect(npxLog(home)).toContain(
        `wrangler secret put TASKS_CLIENT_ID --name breakaway <<${env.BREAKAWAY_CLIENT_ID}`,
      );
      expect(npxLog(home)).toContain(`wrangler secret put TASKS_SYNC_KEY --name breakaway <<${env.BREAKAWAY_SYNC_KEY}`);
    } finally {
      board.close();
    }
  });

  it('rotate-token with no token stops without a terminal or --worker, and writes nothing', async () => {
    const board = await fakeBoard(OLD_TOKEN);
    try {
      const result = await run(home, board.url, 'rotate-token');
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("There's no token on this machine");
      expect(result.stdout).toContain('the secret TASKS_API_TOKEN on the Worker breakaway');
      expect(result.stderr).toContain('--worker <name>');
      expect(npxLog(home)).toBe('');
    } finally {
      board.close();
    }
  });

  it('rotate-token refuses a Worker name that isn’t the config’s, and writes nothing', async () => {
    writeFileSync(join(home, 'tasks.env'), 'BREAKAWAY_TOKEN=a-token-the-board-refuses\n');
    const board = await fakeBoard(OLD_TOKEN);
    try {
      const result = await run(home, board.url, 'rotate-token', '--worker', 'acme-board');
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("The board refused this machine's token");
      expect(result.stderr).toContain('"acme-board" isn\'t the Worker breakaway');
      expect(npxLog(home)).toBe('');
      expect(readEnv(home).BREAKAWAY_TOKEN).toBe('a-token-the-board-refuses');
    } finally {
      board.close();
    }
  });

  it('rotate-token with no token sets a new one once the owner confirms the Worker', async () => {
    let stored = null;
    const board = await fakeBoard(OLD_TOKEN, () => {
      stored ??= /TASKS_API_TOKEN --name breakaway <<(\S+)/u.exec(npxLog(home))?.[1] ?? null;
      return stored;
    });
    try {
      const result = await run(home, board.url, 'rotate-token', '--worker', 'breakaway');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('The new token works');
      const token = readEnv(home).BREAKAWAY_TOKEN;
      expect(token).toMatch(/^[\w-]{43}$/u);
      expect(stored).toBe(token);
      expect(board.requests.some((r) => r.path === '/api/admin/rekey')).toBe(false);
    } finally {
      board.close();
    }
  });

  it('rotate-token with a token the board accepts still checks the install, and asks nothing', async () => {
    writeFileSync(join(home, 'tasks.env'), `BREAKAWAY_TOKEN=${OLD_TOKEN}\n`);
    let stored = null;
    const board = await fakeBoard(OLD_TOKEN, () => {
      stored ??= /TASKS_API_TOKEN --name breakaway <<(\S+)/u.exec(npxLog(home))?.[1] ?? null;
      return stored;
    });
    try {
      const result = await run(home, board.url, 'rotate-token');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("can't ask");
      expect(board.requests[0]).toMatchObject({ path: '/api/health', auth: `Bearer ${OLD_TOKEN}` });
      expect(readEnv(home).BREAKAWAY_TOKEN).toBe(stored);
    } finally {
      board.close();
    }
  });
});
