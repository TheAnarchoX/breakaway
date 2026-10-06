import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unknownSubcommand } from './cli.js';
import { infraCheck, readInfraFolder } from './infra-check.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const TOKEN = 'fake-token-for-tests-0123456789abcdef';

const STAGING = `{
  "version": 1,
  "provider": "fake",
  "resources": [
    { "id": "svc-api", "kind": "service", "name": "api", "attrs": { "instances": 4 } }
  ]
}
`;
const BROKEN = `{
  "version": 1,
  "resources": [
    { "id": "svc-api", "kind": "service" }
  ]
}
`;

/** What the board's preview answers: the plan a file would make, with no ID and no state. */
const preview = (fields = {}) => ({
  repo: 'widgets',
  environment: { id: 2, name: 'staging' },
  provider: 'fake',
  target: 'svc-api',
  changes: 1,
  diff: {
    changes: [
      {
        op: 'scale',
        resource: 'svc-api',
        kind: 'service',
        name: 'api',
        before: { instances: 2 },
        after: { instances: 4 },
        reversible: true,
      },
    ],
    reversible: true,
  },
  cost: { currency: 'USD', now: 5, after: 10, delta: 5, complete: true, unknown: [], perMonth: true, estimate: true },
  blastRadius: { changed: 1, affected: 0, resources: [], deletesInUse: [], seen: null },
  reversible: true,
  irreversible: [],
  policy: {
    policy: 'default',
    outcome: 'needs-owner',
    rule: 'every',
    reasons: ['Every plan needs you: the default policy lets nothing through.'],
  },
  ...fields,
});

/** A `post` that answers each environment from `answers`, and records what it was sent. */
const poster = (answers) => {
  const sent = [];
  const post = async (path, body) => {
    sent.push({ path, body });
    return answers[body.environment] ?? { ok: true, status: 200, data: { preview: preview() } };
  };
  return { sent, post };
};

describe('infra check (CLI-14)', () => {
  it('names the file, line, and field of a desired state that doesn’t check, and sends nothing', async () => {
    const { sent, post } = poster({});
    const out = await infraCheck([], {
      files: [
        { name: 'staging.json', text: BROKEN },
        { name: 'production.json', text: STAGING },
      ],
      repo: 'widgets',
      post,
    });
    expect(out.code).toBe(1);
    expect(out.text).toContain(
      '.github/breakaway-infra/staging.json:4: resources[0]: name is what the platform calls it',
    );
    expect(out.text).toContain('.github/breakaway-infra/production.json: checks, 1 resource');
    expect(out.text).toContain('Nothing was sent to the board');
    expect(sent).toEqual([]);
    expect(out.data.files.find((f) => f.environment === 'staging').error).toMatchObject({
      line: 4,
      field: 'resources[0]',
    });
  });

  it('checks the policy file too, by its line and field', async () => {
    const { sent, post } = poster({});
    const out = await infraCheck([], {
      files: [
        { name: 'staging.json', text: STAGING },
        { name: 'policy.json', text: '{\n  "version": 1,\n  "costLimit": "five"\n}\n' },
      ],
      repo: 'widgets',
      post,
    });
    expect(out.code).toBe(1);
    expect(out.text).toMatch(/^\.github\/breakaway-infra\/policy\.json:3: costLimit: /mu);
    expect(sent).toEqual([]);
  });

  it('prints the plan summary a valid file would make, from the board’s preview, with the policy sent along', async () => {
    const policy = '{ "version": 1 }';
    const { sent, post } = poster({});
    const out = await infraCheck([], {
      files: [
        { name: 'staging.json', text: STAGING },
        { name: 'policy.json', text: policy },
      ],
      repo: 'widgets',
      post,
    });
    expect(out.code).toBe(0);
    expect(sent).toEqual([
      { path: 'infra/check', body: { environment: 'staging', repo: 'widgets', file: STAGING, policy } },
    ]);
    expect(out.text).toContain('.github/breakaway-infra/policy.json: the policy checks');
    expect(out.text).toContain('staging · widgets · the plan it would make, a preview the board doesn’t keep');
    expect(out.text).toContain('adds $5.00 a month');
    expect(out.text).toContain('it waits for you');
    expect(out.text).toContain('Every plan needs you');
    expect(out.text).toContain('scale    service api');
    expect(out.data).toMatchObject({ ok: true, previews: [{ environment: 'staging', preview: { changes: 1 } }] });
  });

  it('sends no policy when the checkout has none, and says the default decides', async () => {
    const { sent, post } = poster({});
    const out = await infraCheck([], { files: [{ name: 'staging.json', text: STAGING }], repo: 'widgets', post });
    expect(sent[0].body.policy).toBeNull();
    expect(out.text).toContain('No policy.json: the default policy decides, and every plan waits for you.');
  });

  it('checks one environment when named, and says which it has when there’s no such file', async () => {
    const files = [
      { name: 'staging.json', text: STAGING },
      { name: 'production.json', text: STAGING },
    ];
    const { sent, post } = poster({});
    expect((await infraCheck(['production'], { files, repo: 'widgets', post })).code).toBe(0);
    expect(sent.map((s) => s.body.environment)).toEqual(['production']);
    const none = await infraCheck(['qa'], { files, repo: 'widgets', post });
    expect(none).toMatchObject({ code: 1, text: expect.stringContaining('it has production, staging') });
  });

  it('shows a file for an environment the board doesn’t have as one to add, and fails on the board’s refusal', async () => {
    const { post } = poster({
      staging: { ok: false, status: 404, data: { error: 'no environment staging in widgets' } },
      production: {
        ok: false,
        status: 422,
        data: {
          error: 'doesn’t check',
          problem: {
            path: '.github/breakaway-infra/production.json',
            line: 5,
            field: 'resources[0].kind',
            message: 'fake has no kind queue: it has database, route, service',
          },
        },
      },
    });
    const out = await infraCheck([], {
      files: [
        { name: 'staging.json', text: STAGING },
        { name: 'production.json', text: STAGING },
      ],
      repo: 'widgets',
      post,
    });
    expect(out.code).toBe(1);
    expect(out.text).toContain('staging: no environment on the board yet');
    expect(out.text).toContain(
      '.github/breakaway-infra/production.json:5: resources[0].kind: fake has no kind queue: it has database, route, service',
    );
  });

  it('says what to add when the checkout has no folder, and when a board doesn’t have the route yet', async () => {
    const missing = await infraCheck([], { files: null, repo: 'widgets', post: poster({}).post });
    expect(missing).toMatchObject({ code: 1, text: expect.stringContaining('No .github/breakaway-infra/') });
    const old = await infraCheck([], {
      files: [{ name: 'staging.json', text: STAGING }],
      repo: 'widgets',
      post: poster({ staging: { ok: false, status: 404, data: { error: 'no route for POST /api/infra/check' } } }).post,
    });
    expect(old).toMatchObject({ code: 1, text: expect.stringContaining('doesn’t have infra check yet') });
  });

  it('is one of infra’s subcommands', () => {
    expect(unknownSubcommand('infra', 'check')).toBeNull();
  });
});

/** A board that answers infra check's preview, and nothing else. */
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
      if (path === 'infra/check' && req.method === 'POST') return send(200, { preview: preview() });
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

describe('npx breakaway infra check, against a mocked board (CLI-14)', () => {
  /** @type {{ url: string, requests: Array<{ method: string, path: string, body: any }>, close: () => void }} */
  let b;
  let dir;
  let home;
  beforeAll(async () => {
    b = await fakeBoard();
    dir = mkdtempSync(join(tmpdir(), 'breakaway-infra-check-'));
    home = mkdtempSync(join(tmpdir(), 'breakaway-infra-check-home-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    mkdirSync(join(dir, '.github/breakaway-infra'), { recursive: true });
    writeFileSync(join(dir, '.github/breakaway-infra/staging.json'), STAGING);
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

  it('reads the checkout’s folder, and prints the plan summary from the board', async () => {
    const out = await run('infra', 'check');
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('.github/breakaway-infra/staging.json: checks, 1 resource');
    expect(out.stdout).toContain('What changes (1)');
    const sent = b.requests.find((r) => r.path === 'infra/check');
    expect(sent.body).toEqual({ environment: 'staging', repo: 'widgets', file: STAGING, policy: null });
  });

  it('prints valid JSON with --json', async () => {
    const out = await run('infra', 'check', '--json');
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, previews: [{ environment: 'staging' }] });
  });

  it('exits 1 and names the line when a file doesn’t check', async () => {
    writeFileSync(join(dir, '.github/breakaway-infra/production.json'), BROKEN);
    const before = b.requests.filter((r) => r.path === 'infra/check').length;
    const out = await run('infra', 'check');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('.github/breakaway-infra/production.json:4: resources[0]: ');
    expect(b.requests.filter((r) => r.path === 'infra/check').length).toBe(before);
    rmSync(join(dir, '.github/breakaway-infra/production.json'));
  });

  it('reads nothing outside the folder', () => {
    expect(readInfraFolder(join(dir, 'nowhere'))).toBeNull();
    expect(readInfraFolder(dir)?.map((f) => f.name)).toEqual(['staging.json']);
  });
});
