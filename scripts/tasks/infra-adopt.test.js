import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unknownSubcommand } from './cli.js';
import { infraAdopt } from './infra-adopt.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const TOKEN = 'fake-token-for-tests-0123456789abcdef';

const JSON_TEXT = `${JSON.stringify(
  {
    version: 1,
    provider: 'fake',
    resources: [{ id: 'svc-api', kind: 'service', name: 'acme-api', attrs: { instances: 2 } }],
  },
  null,
  2,
)}\n`;

/** What the board's draft route answers (BRK-240). */
const draft = (fields = {}) => ({
  repo: 'widgets',
  environment: 'staging',
  environmentId: 2,
  path: '.github/breakaway-infra/staging.json',
  json: JSON_TEXT,
  resources: 1,
  observeOnly: false,
  notes: ['Left out acme-api’s token: it looked like a secret’s value. Name the secret in the file, never its value.'],
  ...fields,
});

/** The board's preview of a plan, as infra check reads it. */
const preview = {
  repo: 'widgets',
  environment: { id: 2, name: 'staging' },
  provider: 'fake',
  target: 'svc-api',
  changes: 0,
  diff: { changes: [], reversible: true },
  cost: { currency: 'USD', now: 5, after: 5, delta: 0, complete: true, unknown: [], perMonth: true, estimate: true },
  blastRadius: { changed: 0, affected: 0, resources: [], deletesInUse: [], seen: null },
  reversible: true,
  irreversible: [],
  policy: { policy: 'default', outcome: 'needs-owner', rule: 'every', reasons: ['Every plan needs you.'] },
};

/** A `get` answering the draft route with `answer`, and a `post` answering infra check's preview; both record. */
const board = (answer = { ok: true, status: 200, data: { draft: draft() } }) => {
  const gets = [];
  const posts = [];
  return {
    gets,
    posts,
    get: async (path) => {
      gets.push(path);
      return answer;
    },
    post: async (path, body) => {
      posts.push({ path, body });
      return { ok: true, status: 200, data: { preview } };
    },
  };
};

describe('infra adopt (CLI-23)', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'breakaway-infra-adopt-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const file = () => join(root, '.github/breakaway-infra/staging.json');

  it('writes the board’s draft where it goes, checks it like infra check, and prints the next step', async () => {
    const b = board();
    const out = await infraAdopt(['staging'], { root, repo: 'widgets', get: b.get, post: b.post });
    expect(b.gets).toEqual(['infra/environments/staging/draft?repo=widgets']);
    expect(readFileSync(file(), 'utf8')).toBe(JSON_TEXT);
    expect(out.code).toBe(0);
    expect(out.text).toContain('Wrote .github/breakaway-infra/staging.json, 1 resource.');
    expect(out.text).toContain('- Left out acme-api’s token');
    expect(out.text).toContain('.github/breakaway-infra/staging.json: checks, 1 resource');
    expect(out.text).toContain('Next: commit .github/breakaway-infra/staging.json and open a pull request.');
    expect(b.posts).toEqual([
      { path: 'infra/check', body: { environment: 'staging', repo: 'widgets', file: JSON_TEXT, policy: null } },
    ]);
    expect(out.data).toMatchObject({ ok: true, written: true, replaced: false, environment: 'staging' });
  });

  it('refuses to overwrite a file without --force, and replaces it with --force', async () => {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), '{ "version": 1, "provider": "fake", "resources": [] }\n');
    const b = board();
    const kept = await infraAdopt(['staging'], { root, repo: 'widgets', get: b.get, post: b.post });
    expect(kept.code).toBe(1);
    expect(kept.text).toContain('Nothing was written: .github/breakaway-infra/staging.json is already there.');
    expect(kept.text).toContain('--force');
    expect(readFileSync(file(), 'utf8')).not.toBe(JSON_TEXT);
    expect(b.posts).toEqual([]);

    const forced = await infraAdopt(['staging'], { root, repo: 'widgets', get: b.get, post: b.post, force: true });
    expect(forced.code).toBe(0);
    expect(forced.text).toContain('Replaced .github/breakaway-infra/staging.json');
    expect(readFileSync(file(), 'utf8')).toBe(JSON_TEXT);
  });

  it('prints the draft and writes nothing with --dry-run', async () => {
    const b = board();
    const out = await infraAdopt(['staging'], { root, repo: 'widgets', get: b.get, post: b.post, dryRun: true });
    expect(out.code).toBe(0);
    expect(out.text).toContain('Would write .github/breakaway-infra/staging.json, 1 resource:');
    expect(out.text).toContain('"name": "acme-api"');
    expect(existsSync(file())).toBe(false);
    expect(b.posts).toEqual([]);
  });

  it('writes nothing for an observe-only environment', async () => {
    const b = board({ ok: true, status: 200, data: { draft: draft({ observeOnly: true }) } });
    const out = await infraAdopt(['staging'], { root, repo: 'widgets', get: b.get, post: b.post, force: true });
    expect(out.code).toBe(1);
    expect(out.text).toContain('staging is observe only');
    expect(existsSync(file())).toBe(false);
  });

  it('says the board’s fix when it has nothing to draft, and when it has no draft route yet', async () => {
    const none = await infraAdopt(['staging'], {
      root,
      repo: 'widgets',
      ...board({
        ok: false,
        status: 409,
        data: { error: 'staging has no inventory yet: connect fake on Connections and refresh the inventory' },
      }),
    });
    expect(none).toMatchObject({ code: 1, text: expect.stringContaining('connect fake on Connections') });
    const old = await infraAdopt(['staging'], {
      root,
      repo: 'widgets',
      ...board({
        ok: false,
        status: 404,
        data: { error: 'no route for GET /api/infra/environments/staging/draft' },
      }),
    });
    expect(old).toMatchObject({ code: 1, text: expect.stringContaining('can’t draft a desired state yet') });
    expect(existsSync(file())).toBe(false);
  });

  it('writes only to the environment’s own file, whatever path the board names, and nothing that doesn’t check', async () => {
    const elsewhere = board({
      ok: true,
      status: 200,
      data: { draft: draft({ environment: '../../evil', path: '../../evil.json' }) },
    });
    const bad = await infraAdopt(['staging'], { root, repo: 'widgets', get: elsewhere.get, post: elsewhere.post });
    expect(bad.code).toBe(1);
    expect(existsSync(join(root, '..', 'evil.json'))).toBe(false);

    const moved = board({ ok: true, status: 200, data: { draft: draft({ path: 'src/index.js' }) } });
    await infraAdopt(['staging'], { root, repo: 'widgets', get: moved.get, post: moved.post });
    expect(existsSync(join(root, 'src/index.js'))).toBe(false);
    expect(existsSync(file())).toBe(true);
    rmSync(file());

    const broken = board({ ok: true, status: 200, data: { draft: draft({ json: '{ "version": 1 }\n' }) } });
    const out = await infraAdopt(['staging'], { root, repo: 'widgets', get: broken.get, post: broken.post });
    expect(out.code).toBe(1);
    expect(out.text).toContain('doesn’t check here');
    expect(existsSync(file())).toBe(false);
  });

  it('needs an environment, and is one of infra’s subcommands', async () => {
    const b = board();
    const out = await infraAdopt([], { root, repo: 'widgets', get: b.get, post: b.post });
    expect(out).toMatchObject({ code: 1, text: expect.stringContaining('infra adopt <environment>') });
    expect(b.gets).toEqual([]);
    expect(unknownSubcommand('infra', 'adopt')).toBeNull();
  });
});

/** A board that answers the draft route and infra check's preview, and nothing else. */
function fakeBoard() {
  const requests = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/api\//u, '');
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      requests.push({ method: req.method, path, body: raw ? JSON.parse(raw) : null });
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'sign in first' });
      if (path === 'repos')
        return send(200, { default: 'widgets', repos: [{ slug: 'widgets', github: 'acme/widgets', projects: [] }] });
      if (path === 'infra/environments/staging/draft?repo=widgets' && req.method === 'GET')
        return send(200, { draft: draft() });
      if (path === 'infra/check' && req.method === 'POST') return send(200, { preview });
      return send(404, { error: `no route for ${req.method} /api/${path.split('?')[0]}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

describe('npx breakaway infra adopt, against a mocked board (CLI-23)', () => {
  /** @type {{ url: string, requests: Array<{ method: string, path: string, body: any }>, close: () => void }} */
  let b;
  let dir;
  let home;
  beforeAll(async () => {
    b = await fakeBoard();
    dir = mkdtempSync(join(tmpdir(), 'breakaway-infra-adopt-cli-'));
    home = mkdtempSync(join(tmpdir(), 'breakaway-infra-adopt-home-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  });
  afterAll(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const run = (...args) => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('BREAKAWAY_') && !key.startsWith('CLAUDE_') && !/proxy/iu.test(key),
      ),
    );
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: {
          ...clean,
          HOME: home,
          BREAKAWAY_HOME: home,
          BREAKAWAY_URL: b.url,
          BREAKAWAY_TOKEN: TOKEN,
          BREAKAWAY_AGENT: 'claude-wid-7',
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
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
  };

  it('writes the file into the checkout, checks it with the board, and says what to commit', async () => {
    const out = await run('infra', 'adopt', 'staging');
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(readFileSync(join(dir, '.github/breakaway-infra/staging.json'), 'utf8')).toBe(JSON_TEXT);
    expect(out.stdout).toContain('.github/breakaway-infra/staging.json: checks, 1 resource');
    expect(out.stdout).toContain('Next: commit .github/breakaway-infra/staging.json');
    expect(b.requests.find((r) => r.path === 'infra/check').body).toEqual({
      environment: 'staging',
      repo: 'widgets',
      file: JSON_TEXT,
      policy: null,
    });
  });

  it('refuses the second time, and exits 1, unless --force', async () => {
    const again = await run('infra', 'adopt', 'staging');
    expect(again.status).toBe(1);
    expect(again.stdout).toContain('is already there');
    const forced = await run('infra', 'adopt', 'staging', '--force', '--json');
    expect(forced.status).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({ ok: true, written: true, replaced: true });
  });
});
