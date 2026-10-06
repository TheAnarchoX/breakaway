import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unknownSubcommand } from './cli.js';
import { INFRA_READS, InfraReadError, environmentText, infraRead, money, planText } from './infra-read.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const TOKEN = 'fake-token-for-tests-0123456789abcdef';
const AT = '2026-10-06T14:02:00.000Z';

const env = (fields = {}) => ({
  id: 1,
  repo: 'widgets',
  name: 'production',
  kind: 'production',
  provider: 'fake',
  target: 'widgets-api',
  task: null,
  frozen: false,
  frozenAt: null,
  gates: true,
  observeOnly: false,
  runsTheBoard: false,
  created: AT,
  edited: AT,
  waitingPlan: null,
  ...fields,
});

const resource = (id, kind, name, fields = {}) => ({
  id,
  provider: 'fake',
  kind,
  name,
  attrs: {},
  owner: { repo: 'widgets', environment: 'production', environmentId: 1, task: null },
  health: { state: 'healthy', at: AT },
  cost: { amount: 4.6, currency: 'USD', perMonth: true, estimate: true },
  seen: AT,
  ...fields,
});

const plan = (fields = {}) => ({
  id: 'plan-3',
  repo: 'widgets',
  environment: { id: 1, name: 'production' },
  provider: 'fake',
  target: 'widgets-api',
  desiredSha: 'abcdef1234567',
  source: { kind: 'pull-request', ref: '12' },
  state: 'waiting',
  changes: 2,
  cost: {
    currency: 'USD',
    now: 10,
    delta: 4,
    after: 14,
    complete: true,
    unknown: [],
    changes: [],
    perMonth: true,
    estimate: true,
  },
  blastRadius: { changed: 2, affected: 1, deletesInUse: [] },
  reversible: false,
  irreversible: [{ resource: 'db-old', name: 'widgets-old', op: 'delete', why: 'it destroys its data' }],
  by: 'agent',
  agent: 'claude-wid-7',
  created: AT,
  updated: AT,
  ...fields,
});

const fullPlan = plan({
  diff: {
    provider: 'fake',
    environment: 'production',
    reversible: false,
    changes: [
      {
        op: 'update',
        resource: 'svc-api',
        kind: 'service',
        name: 'widgets-api',
        before: { memory: 128, region: 'eu' },
        after: { memory: 256, region: 'eu' },
        reversible: true,
      },
      {
        op: 'delete',
        resource: 'db-old',
        kind: 'database',
        name: 'widgets-old',
        before: { size: 1 },
        after: null,
        reversible: false,
        why: 'it destroys its data',
      },
    ],
  },
  blastRadius: {
    resources: [
      { id: 'svc-api', kind: 'service', name: 'widgets-api', changed: true, depth: 0, leansOn: null },
      { id: 'db-old', kind: 'database', name: 'widgets-old', changed: true, depth: 0, leansOn: null },
      {
        id: 'svc-web',
        kind: 'service',
        name: 'widgets-web',
        changed: false,
        depth: 1,
        leansOn: { id: 'svc-api', relation: 'calls' },
      },
    ],
    changed: 2,
    affected: 1,
    deletesInUse: [{ resource: 'db-old', name: 'widgets-old', by: ['svc-web'] }],
    seen: AT,
  },
  policy: { outcome: 'needs-owner', rule: 'production', reasons: ['Production needs you.'], rules: [], limits: {} },
});

const signal = (id, fields = {}) => ({
  id,
  source: 'fake',
  environment: 'production',
  environmentId: 1,
  resource: 'svc-api',
  kind: 'health',
  level: 'critical',
  value: null,
  at: AT,
  text: 'Failed its health check.',
  ...fields,
});

const task = (wid, fields = {}) => ({
  uuid: `${wid.toLowerCase()}-0000-0000-0000-000000000000`,
  wid,
  description: `Task ${wid}`,
  status: 'pending',
  tags: [],
  claim: null,
  repo: 'widgets',
  ...fields,
});

/** The board's answers, by path; anything else is the board's own 404. */
const ROUTES = {
  'infra/environments?repo=widgets': {
    environments: [env({ waitingPlan: 'plan-3', driftCount: 1 }), env({ id: 2, name: 'staging', kind: 'staging' })],
  },
  'infra/environments': {
    environments: [env(), env({ id: 9, repo: 'gadgets', name: 'production', target: 'gadgets-api' })],
  },
  'infra/environments/production?repo=widgets': {
    environment: env({
      waitingPlan: 'plan-3',
      driftCount: 1,
      drift: {
        checked: AT,
        desiredSha: 'abcdef1',
        count: 1,
        resources: [{ id: 'svc-api', kind: 'service', name: 'widgets-api', op: 'update' }],
        plan: 'plan-3',
        planMatches: true,
        error: null,
      },
    }),
  },
  'infra/inventory?repo=widgets&environment=1': {
    resources: [
      resource('svc-api', 'service', 'widgets-api'),
      resource('db-main', 'database', 'widgets-db', { health: null, cost: null }),
    ],
    relations: [{ environmentId: 1, from: 'svc-api', to: 'db-main', kind: 'binding' }],
  },
  'infra/desired/production?repo=widgets': {
    desired: {
      repo: 'widgets',
      environment: 'production',
      environmentId: 1,
      path: '.github/breakaway-infra/production.json',
      state: 'valid',
      sha: 'abcdef1234567',
    },
  },
  'infra/plans?repo=widgets': {
    plans: [plan(), plan({ id: 'plan-2', state: 'applied', reversible: true })],
    more: true,
  },
  'infra/plans?repo=widgets&state=rejected': { plans: [], more: false },
  'infra/plans/plan-3': { plan: fullPlan },
  'infra/signals': {
    signals: [signal(7), signal(6, { environmentId: 9, text: 'Another repository’s.' })],
    more: false,
  },
  'infra/signals?environmentId=1&level=critical': { signals: [signal(7)], more: true },
  'infra/signals/days': {
    days: [
      {
        day: '2026-09-28',
        source: 'fake',
        environment: 'production',
        environmentId: 1,
        resource: 'svc-api',
        kind: 'health',
        count: 4,
        info: 1,
        warning: 0,
        critical: 3,
        min: null,
        max: null,
        last: null,
        lastAt: AT,
        text: 'Failed its health check.',
      },
    ],
  },
  'tasks?status=pending': {
    tasks: [
      task('WID-41', {
        tags: ['incident'],
        description: 'widgets-api failed its health check',
        claim: 'claude-wid-41',
      }),
      task('WID-42'),
      task('GAD-3', { tags: ['incident'], repo: 'gadgets' }),
    ],
  },
};

/** A mocked board: answers ROUTES (or `routes`), and records every path it was asked. */
function board(routes = ROUTES) {
  const asked = [];
  const get = async (path) => {
    asked.push(path);
    if (path in routes) return { ok: true, status: 200, data: structuredClone(routes[path]) };
    return { ok: false, status: 404, data: { error: `no route for GET /api/${path.split('?')[0]}` } };
  };
  return { get, asked };
}

const read = (args, { repo = 'widgets', opts = {}, routes } = {}) => {
  const b = board(routes);
  return infraRead(args, { get: b.get, repo, opts, inRepo: (t) => t.repo === repo }).then((r) => ({ ...r, b }));
};

describe('infra: the environments (CLI-13)', () => {
  it('lists the checkout’s environments, with a plan waiting, drift, and freeze', async () => {
    const { text, data } = await read([]);
    expect(data.environments).toHaveLength(2);
    expect(text).toContain('production      production · fake · widgets-api  (drift: 1; plan-3 waits for you)');
    expect(text).toContain('staging         staging · fake · widgets-api');
    expect(text).toContain('npx breakaway infra show <environment>');
    expect((await read(['environments'])).text).toBe(text);
  });

  it('names each one’s repository when the board doesn’t know the checkout', async () => {
    const { text, b } = await read([], { repo: null });
    expect(b.asked).toEqual(['infra/environments']);
    expect(text).toContain('widgets/production');
    expect(text).toContain('gadgets/production');
  });

  it('says how an environment is added when there are none', async () => {
    const { text } = await read([], { routes: { 'infra/environments?repo=widgets': { environments: [] } } });
    expect(text).toBe('No environments in widgets yet. The owner adds one on the board’s Infrastructure view.');
  });

  it('marks one that runs the board as observe only', async () => {
    const routes = {
      'infra/environments?repo=widgets': {
        environments: [env({ frozen: true, observeOnly: true, runsTheBoard: true })],
      },
    };
    expect((await read([], { routes })).text).toContain('(frozen; observe only: runs this board)');
  });
});

describe('infra show <environment>: its desired state, drift, and inventory (CLI-13)', () => {
  it('prints the environment, its drift and the plan that puts it back, and each resource with what it uses', async () => {
    const { text, data, b } = await read(['show', 'production']);
    expect(b.asked).toEqual([
      'infra/environments/production?repo=widgets',
      'infra/inventory?repo=widgets&environment=1',
      'infra/desired/production?repo=widgets',
    ]);
    expect(data.resources).toHaveLength(2);
    expect(data.desired.state).toBe('valid');
    expect(text).toContain('production · widgets');
    expect(text).toContain('  Plan        plan-3 waits for you: npx breakaway infra plan plan-3');
    expect(text).toContain('  Desired     .github/breakaway-infra/production.json at abcdef1: valid');
    expect(text).toContain('  Drift       1 resource differs from the repository, checked 6 Oct 2026, 14:02 UTC');
    expect(text).toContain('              update service widgets-api');
    expect(text).toContain('              plan-3 puts it back: npx breakaway infra plan plan-3');
    expect(text).toContain('Resources (2)');
    expect(text).toMatch(/service widgets-api\s+healthy · \$4\.60 a month, estimated/u);
    expect(text).toContain('    uses database widgets-db (binding)');
    expect(text).toMatch(/^ {2}database widgets-db$/mu);
    expect(text).not.toMatch(/ +$/mu);
  });

  it('says drift isn’t compared yet, and how to add a desired state when there’s none', async () => {
    const routes = {
      ...ROUTES,
      'infra/environments/production?repo=widgets': { environment: env() },
      'infra/inventory?repo=widgets&environment=1': { resources: [], relations: [] },
      'infra/desired/production?repo=widgets': undefined,
    };
    delete routes['infra/desired/production?repo=widgets'];
    const { text, data } = await read(['show', 'production'], { routes });
    expect(data.desired).toBeNull();
    expect(text).toContain(
      '  Desired     none yet: add .github/breakaway-infra/production.json to the default branch by pull request',
    );
    expect(text).toContain('  Drift       not compared yet');
    expect(text).toContain('No resources yet: the board reads them from the provider on its next refresh.');
  });

  it('needs an environment, and passes on the board’s answer when there’s no such one', async () => {
    await expect(read(['show'])).rejects.toThrow(/infra show <environment>: name one/u);
    const b = board({});
    b.get = async () => ({ ok: false, status: 404, data: { error: 'no environment prod in widgets' } });
    await expect(infraRead(['show', 'prod'], { get: b.get, repo: 'widgets' })).rejects.toThrow(
      'no environment prod in widgets',
    );
  });
});

describe('infra plans and infra plan <id> (CLI-13)', () => {
  it('lists plans newest first, in the brand’s words, with how to see older ones', async () => {
    const { text, data } = await read(['plans']);
    expect(data.plans).toHaveLength(2);
    expect(text).toContain(
      'plan-3    Waiting for you  production    2 changes · adds $4.00 a month · can’t be undone · from a pull request (#12)  6 Oct 2026, 14:02 UTC',
    );
    expect(text).toMatch(/plan-2 {4}Applied/u);
    expect(text).toContain('Older: npx breakaway infra plans --before plan-2');
  });

  it('filters by state, and says when nothing matches', async () => {
    const { text, b } = await read(['plans'], { opts: { state: 'rejected' } });
    expect(b.asked).toEqual(['infra/plans?repo=widgets&state=rejected']);
    expect(text).toBe('No plans rejected in widgets.');
  });

  it('shows one plan: what changes, the cost, the policy’s answer, what else it touches, and that it can’t be undone', async () => {
    const { text, data } = await read(['plan', 'plan-3']);
    expect(data.plan.diff.changes).toHaveLength(2);
    expect(text).toContain('plan-3 · Waiting for you · production · widgets');
    expect(text).toContain('  From        a pull request (#12)');
    expect(text).toContain('  Made by     claude-wid-7 (an agent)');
    expect(text).toContain('  Cost        adds $4.00 a month: $10.00 a month → $14.00 a month, estimated');
    expect(text).toContain('  Undo        can’t be undone: delete widgets-old (it destroys its data)');
    expect(text).toContain('  Policy      it waits for you\n              Production needs you.');
    expect(text).toContain('  update   service widgets-api\n      memory: 128 → 256');
    expect(text).not.toContain('region');
    expect(text).toContain('  delete   database widgets-old  (can’t be undone)');
    expect(text).toContain('What else it touches\n  service widgets-web, through calls to widgets-api');
    expect(text).toContain('  It deletes widgets-old, and widgets-web still uses it.');
    expect(text).not.toMatch(/blast radius/iu);
  });

  it('needs a plan’s ID', async () => {
    await expect(read(['plan'])).rejects.toThrow(/infra plan <id>: name one/u);
  });

  it('shows a converted cost in the board’s currency, with the rate once (BRK-226)', () => {
    const rate = { from: 'USD', to: 'EUR', rate: 0.92, setAt: '2026-10-03T09:00:00.000Z' };
    const euros = plan({ cost: { ...plan().cost, currency: 'EUR', now: 9.2, delta: 3.68, after: 12.88, rate } });
    expect(planText({ plan: euros })).toMatch(
      / {2}Cost {8}adds €3\.68 a month: €9\.20 a month → €12\.88 a month, estimated, at 1 USD = 0\.92 EUR, set 3 Oct/u,
    );
    const cost = { amount: 4.23, currency: 'EUR', perMonth: true, estimate: true, rate: { ...rate, amount: 4.6 } };
    const text = environmentText({
      environment: env(),
      resources: [resource('svc-api', 'service', 'widgets-api', { cost })],
      relations: [],
      desired: null,
    });
    expect(text).toMatch(/Resources \(1\)\n {2}Estimated costs at 1 USD = 0\.92 EUR, set 3 Oct/u);
    expect(text).toContain('€4.23 a month, estimated');
  });
});

describe('infra signals (CLI-13)', () => {
  it('shows the checkout’s signals, newest first, leaving out other repositories’', async () => {
    const { text, data, b } = await read(['signals']);
    expect(b.asked).toEqual(['infra/environments?repo=widgets', 'infra/signals']);
    expect(data.signals.map((s) => s.id)).toEqual([7]);
    expect(text).toBe('6 Oct 2026, 14:02 UTC  critical  health  production · svc-api  Failed its health check.');
  });

  it('names an environment by its ID, filters by level, and pages', async () => {
    const { text, b } = await read(['signals'], { opts: { environment: 'production', level: 'critical' } });
    expect(b.asked).toEqual([
      'infra/environments/production?repo=widgets',
      'infra/signals?environmentId=1&level=critical',
    ]);
    expect(text).toContain('Older: npx breakaway infra signals --before 7');
  });

  it('shows the daily summaries with --days', async () => {
    const { text } = await read(['signals'], { opts: { days: true } });
    expect(text).toBe(
      '2026-09-28  health  production · svc-api  4 signals (3 critical, 1 info)  last: Failed its health check.',
    );
  });

  it('says so on a board from before signals', async () => {
    const routes = { 'infra/environments?repo=widgets': ROUTES['infra/environments?repo=widgets'] };
    await expect(read(['signals'], { routes })).rejects.toThrow(
      'this board doesn’t have signals yet: its owner updates it to a release that does, then try again.',
    );
  });
});

describe('infra incidents (CLI-13)', () => {
  it('lists the checkout’s open tasks tagged +incident', async () => {
    const { text, data } = await read(['incidents']);
    expect(data.incidents.map((t) => t.wid)).toEqual(['WID-41']);
    expect(text).toContain('WID-41    widgets-api failed its health check  (claimed by claude-wid-41)');
  });

  it('says what an incident is when there are none', async () => {
    const { text } = await read(['incidents'], { routes: { 'tasks?status=pending': { tasks: [task('WID-42')] } } });
    expect(text).toBe(
      'No open incidents in widgets. A signal that crosses a rule opens one, as a task tagged +incident.',
    );
  });
});

describe('infra: what it takes', () => {
  it('knows its reads and init, and nothing else', async () => {
    for (const sub of ['init', ...INFRA_READS]) expect(unknownSubcommand('infra', sub)).toBeNull();
    expect(unknownSubcommand('infra', 'apply')).toMatch(/^infra has no "apply"/u);
    await expect(read(['apply'])).rejects.toBeInstanceOf(InfraReadError);
  });

  it('writes amounts the brand’s way', () => {
    expect(money(4.6, 'USD')).toBe('$4.60 a month');
    expect(money(-1.2, 'EUR')).toBe('−€1.20 a month');
    expect(money(null, 'USD')).toBeNull();
  });
});

// ---- the CLI itself, against a fake board -------------------------------------------------

/** A board on localhost that answers ROUTES with the token, and records every request's method and path. */
function fakeBoard() {
  const requests = [];
  const server = createServer((req, res) => {
    const path = req.url.replace(/^\/api\//u, '');
    requests.push({ method: req.method, path });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'sign in first' });
    // An agent's token reads Architect, and never writes it.
    if (req.method !== 'GET') return send(403, { error: 'an agent’s token only reads infrastructure' });
    if (path === 'repos')
      return send(200, { default: 'widgets', repos: [{ slug: 'widgets', github: 'acme/widgets', projects: [] }] });
    if (path in ROUTES) return send(200, ROUTES[path]);
    if (path.startsWith('infra/plans/')) return send(404, { error: `no plan ${path.slice(12)}` });
    return send(404, { error: `no route for ${req.method} /api/${path.split('?')[0]}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

describe('npx breakaway infra, against a mocked board (CLI-13)', () => {
  /** @type {{ url: string, requests: Array<{ method: string, path: string }>, close: () => void }} */
  let b;
  let dir;
  let home;
  beforeAll(async () => {
    b = await fakeBoard();
    dir = mkdtempSync(join(tmpdir(), 'breakaway-infra-'));
    home = mkdtempSync(join(tmpdir(), 'breakaway-infra-home-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  });
  afterAll(() => {
    b.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs the CLI in the checkout with only the fake board's settings. */
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

  const reads = [
    [[], 'production'],
    [['show', 'production'], 'Resources (2)'],
    [['plans'], 'plan-3'],
    [['plan', 'plan-3'], 'What changes (2)'],
    [['signals'], 'Failed its health check.'],
    [['incidents'], 'WID-41'],
  ];

  it.each(reads)('infra %j prints text, and valid JSON with --json', async (args, shows) => {
    const text = await run('infra', ...args);
    expect(text.stderr).toBe('');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(shows);
    const json = await run('infra', ...args, '--json');
    expect(json.status).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  });

  it('only ever reads: every request it sent was a GET', () => {
    expect(b.requests.length).toBeGreaterThan(reads.length);
    expect(b.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('fails with what went wrong, as JSON too', async () => {
    const out = await run('infra', 'plan', 'plan-99', '--json');
    expect(out.status).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ error: 'no plan plan-99' });
    expect(out.stderr).toContain('tasks: no plan plan-99');
  });
});
