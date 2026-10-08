import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { checkPolicyFile, DEFAULT_POLICY, evaluatePolicy, POLICY_PATH } from '../src/infra-policy.js';
import {
  checkPolicyEdit,
  comparePolicies,
  environmentRules,
  policyBranch,
  policyChangeBody,
  policyChangeTitle,
  policyText,
  ruleWords,
} from '../src/infra-policy-changes.js';
import { infraSummary } from '../src/infra-pulls.js';

// The policy manager (WEB-123, docs/specs/WEB-123-policy-manager.md).
const policy = (file) => {
  const checked = checkPolicyFile(JSON.stringify({ version: 1, ...file }));
  if (!checked.ok) throw new Error(JSON.stringify(checked.error));
  return checked.policy;
};
const ENVS = [
  { name: 'acme-staging', kind: 'staging' },
  { name: 'acme-prod', kind: 'production' },
];
const plan = (changes) => ({
  diff: { changes, reversible: changes.every((c) => c.reversible) },
  cost: { delta: 0, after: 0, complete: true, currency: 'USD', unknown: [] },
});
const scale = { op: 'scale', kind: 'service', name: 'api', resource: 'svc-api', reversible: true };

describe('a policy’s two levels', () => {
  it('reads an environment’s own access and allow rules, and refuses an environment named in them', () => {
    const p = policy({
      environments: {
        'acme-prod': { costLimit: 50, access: { kinds: ['route'] }, allow: [] },
        'acme-staging': { allow: [{ name: 'staging scales', changes: ['scale'] }] },
      },
      allow: [{ name: 'small changes', changes: ['update', 'scale'] }],
    });
    expect(p.environments['acme-prod']).toEqual({
      costLimit: 50,
      access: { kinds: ['route'], settings: [] },
      allow: [],
    });
    const bad = checkPolicyFile(
      JSON.stringify({
        version: 1,
        environments: { 'acme-prod': { allow: [{ name: 'x', environments: ['acme-prod'] }] } },
      }),
    );
    expect(bad).toMatchObject({
      ok: false,
      error: {
        field: 'environments.acme-prod.allow[0].environments',
        message: expect.stringMatching(/already that environment’s/u),
      },
    });
    const unknown = checkPolicyFile(JSON.stringify({ version: 1, environments: { 'acme-prod': { gates: false } } }));
    expect(unknown).toMatchObject({ ok: false, error: { field: 'environments.acme-prod.gates' } });
  });

  it('decides with an environment’s own allow rules in place of the repository’s, and its access added', () => {
    const p = policy({
      environments: { 'acme-prod': { allow: [] }, 'acme-staging': { access: { settings: ['public'] } } },
      allow: [{ name: 'scales', changes: ['scale'] }],
    });
    const at = (name, changes) =>
      evaluatePolicy(p, { environment: { name, kind: 'staging', frozen: false, gates: false }, ...plan(changes) });
    expect(at('acme-other', [scale])).toMatchObject({ outcome: 'allowed', rule: 'scales' });
    expect(at('acme-prod', [scale])).toMatchObject({
      outcome: 'needs-owner',
      rule: 'every',
      reasons: ['Every plan in acme-prod needs you: your policy lets nothing through there.'],
    });
    const open = { ...scale, op: 'update', before: { public: false }, after: { public: true } };
    expect(at('acme-staging', [open])).toMatchObject({ outcome: 'needs-owner', rule: 'access' });
    expect(at('acme-other', [open])).toMatchObject({ outcome: 'needs-owner', rule: 'every' });
  });
});

describe('what a policy change loosens and tightens', () => {
  const compare = (before, after) => comparePolicies(before, after, { environments: ENVS, currency: 'USD' });

  it('names nothing for the same rules, however they’re written', () => {
    const p = policy({ costLimit: 5 });
    expect(compare(DEFAULT_POLICY, p)).toEqual({ lines: [], loosens: [], tightens: [] });
  });

  it('loosens when a limit rises, and tightens when it falls, in every environment or one', () => {
    expect(compare(DEFAULT_POLICY, policy({ costLimit: 50 })).loosens).toEqual([
      'In every environment: a plan can add up to $50 a month before it waits for you (it was $5).',
    ]);
    const prod = compare(DEFAULT_POLICY, policy({ environments: { 'acme-prod': { budget: 10 } } }));
    expect(prod).toEqual({
      lines: [
        {
          effect: 'tightens',
          line: 'In acme-prod: the budget is $10 a month: a plan past it waits for you (it was $20).',
          environments: ['acme-prod'],
        },
      ],
      loosens: [],
      tightens: ['In acme-prod: the budget is $10 a month: a plan past it waits for you (it was $20).'],
    });
  });

  it('loosens for a new allow rule, names where it lets plans through, and tightens when one goes', () => {
    const rule = { name: 'staging scales', environments: ['acme-staging'], changes: ['scale'], maxChanges: 3 };
    const added = compare(DEFAULT_POLICY, policy({ allow: [rule] }));
    expect(added.loosens).toEqual([
      'In acme-staging: plans that only scale resources, up to 3 changes no longer wait for you (“staging scales”).',
    ]);
    expect(added.tightens).toEqual([]);
    const gone = compare(policy({ allow: [rule] }), DEFAULT_POLICY);
    expect(gone.loosens).toEqual([]);
    expect(gone.tightens).toEqual([
      'In acme-staging: plans that only scale resources, up to 3 changes wait for you again (“staging scales” is gone or narrower).',
    ]);
  });

  it('counts a wider rule as loosening and a narrower one as tightening only', () => {
    const narrow = policy({ allow: [{ name: 'r', changes: ['scale'], maxChanges: 2 }] });
    const wide = policy({ allow: [{ name: 'r', changes: ['scale', 'restart'], maxChanges: 2 }] });
    expect(compare(narrow, wide).loosens).toHaveLength(1);
    expect(compare(narrow, wide).tightens).toEqual([]);
    expect(compare(wide, narrow).loosens).toEqual([]);
    expect(compare(wide, narrow).tightens).toHaveLength(1);
    // A rule covered by one that was already there loosens nothing.
    const both = policy({ allow: [...wide.allow, { name: 's', changes: ['scale'], maxChanges: 1 }] });
    expect(compare(wide, both)).toMatchObject({ loosens: [], tightens: [] });
  });

  it('counts an environment’s own rules that let through more than the repository’s as loosening there', () => {
    const repo = policy({ allow: [{ name: 'scales', changes: ['scale'] }] });
    const override = policy({
      allow: repo.allow,
      environments: { 'acme-staging': { allow: [{ name: 'anything', maxChanges: 5 }] } },
    });
    expect(compare(repo, override).loosens).toEqual([
      'In acme-staging: any plan, up to 5 changes no longer wait for you (“anything”).',
    ]);
    // Taking production out of the repository's rules tightens it there only.
    const kept = policy({ allow: repo.allow, environments: { 'acme-prod': { allow: [] } } });
    expect(compare(repo, kept)).toMatchObject({
      loosens: [],
      tightens: ['In acme-prod: plans that only scale resources wait for you again (“scales” is gone or narrower).'],
    });
  });

  it('loosens when a kind or setting stops counting as access', () => {
    const before = policy({ access: { kinds: ['route'], settings: ['public'] } });
    const after = policy({ access: { kinds: ['route'] } });
    expect(compare(before, after).loosens).toEqual([
      'In every environment: changing public no longer counts as an access change by itself.',
    ]);
    expect(compare(after, before).tightens).toEqual([
      'In every environment: changing public counts as an access change, so it waits for you.',
    ]);
  });
});

describe('a policy in words', () => {
  it('lists each environment’s rules with the level each comes from', () => {
    const p = policy({
      costLimit: 10,
      environments: { 'acme-prod': { budget: 300, allow: [] } },
      allow: [{ name: 'scales', changes: ['scale', 'restart'], kinds: ['service'] }],
    });
    const staging = environmentRules(p, { name: 'acme-staging', kind: 'staging' }, { currency: 'USD' });
    expect(staging.map((r) => [r.rule, r.level])).toEqual([
      ['frozen', 'board'],
      ['production', 'board'],
      ['destructive', 'board'],
      ['access', 'repository'],
      ['cost', 'repository'],
      ['budget', 'repository'],
      ['scales', 'repository'],
      ['every', 'repository'],
    ]);
    expect(staging.find((r) => r.rule === 'scales')?.words).toBe(
      'Plans that only scale or restart a service pass without you, when nothing above catches them (“scales”).',
    );
    const prod = environmentRules(p, { name: 'acme-prod', kind: 'production', gates: true }, { currency: 'USD' });
    expect(prod.find((r) => r.rule === 'budget')).toEqual({
      rule: 'budget',
      level: 'environment',
      words: 'A plan that takes acme-prod past $300 a month waits for you.',
    });
    expect(prod.at(-1)).toEqual({
      rule: 'every',
      level: 'environment',
      words: 'Every plan in acme-prod waits for you: its own rules let nothing through.',
    });
    expect(prod.find((r) => r.rule === 'production')?.words).toBe(
      'Every plan here waits for you: production needs you.',
    );
    expect(environmentRules(DEFAULT_POLICY, { name: 'acme-staging' }, { from: 'default' }).at(-1)).toMatchObject({
      level: 'default',
      words: 'Every plan waits for you: no rule lets one through.',
    });
  });

  it('words a rule plainly', () => {
    expect(ruleWords({ name: 'x' })).toBe('any plan');
    expect(ruleWords({ name: 'x', kinds: ['route'], environmentKinds: ['short-lived'] })).toBe(
      'plans that only touch a route, in short-lived environments',
    );
  });

  it('writes the file it proposes small and in order, and checks what it was sent', () => {
    const p = policy({ environments: { 'acme-prod': { allow: [] } }, allow: [{ name: 'r', changes: ['scale'] }] });
    const text = policyText(p);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      costLimit: 5,
      budget: 20,
      environments: { 'acme-prod': { allow: [] } },
      allow: [{ name: 'r', changes: ['scale'] }],
    });
    expect(checkPolicyFile(text)).toEqual({ ok: true, policy: p });
    expect(checkPolicyEdit({ costLimit: -1 })).toMatchObject({ ok: false, error: { field: 'costLimit' } });
    expect(checkPolicyEdit([])).toMatchObject({ ok: false });
  });

  it('titles and describes the pull request by what it does, and the plan check says it too', () => {
    const lines = comparePolicies(DEFAULT_POLICY, policy({ costLimit: 50, budget: 10 }), {
      environments: ENVS,
      currency: 'USD',
    });
    expect(policyChangeTitle(lines)).toBe('Change the infrastructure policy');
    expect(policyChangeTitle({ loosens: ['x'], tightens: [] })).toBe('Loosen the infrastructure policy');
    const body = policyChangeBody({ lines: lines.lines, created: true });
    expect(body).toContain('**Loosens your policy.** These will no longer wait for you:');
    expect(body).toContain(
      '- In every environment: a plan can add up to $50 a month before it waits for you (it was $5).',
    );
    expect(body).toContain('**Tightens it:**');
    expect(body).toContain('applies nothing and approves no plan');
    const summary = infraSummary({
      environments: [],
      policy: { path: POLICY_PATH, ok: true, error: null, lines: lines.lines },
      problems: [],
      skipped: 0,
    });
    expect(summary).toContain('**Loosens your policy.**');
    expect(summary).toContain('**Tightens your policy:**');
    expect(policyBranch(4)).toBe('breakaway/infra/policy-4');
  });
});

// A pretend GitHub for acme/widgets: the default branch's head and files, what the board writes, and the merge.
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));
const gh = {
  /** @type {Record<string, Record<string, string>>} files by commit */ files: {},
  head: 'head-1',
  /** @type {Record<string, any>} */ pulls: {},
  /** @type {Array<{ method: string, path: string, body: any }>} */ writes: [],
};

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const method = init.method ?? 'GET';
    const local = path.replace('/repos/acme/widgets', '');
    if (method === 'GET') {
      if (local === '') return reply({ allow_squash_merge: true, allow_auto_merge: false });
      if (local === '/git/ref/heads/main') return reply({ object: { sha: gh.head } });
      if (local.startsWith('/git/commits/')) return reply({ sha: local.split('/').pop(), tree: { sha: 'tree-1' } });
      const pull = /^\/pulls\/(\d+)$/u.exec(local);
      if (pull) return gh.pulls[pull[1]] ? reply(gh.pulls[pull[1]]) : reply({ message: 'Not Found' }, 404);
      const file = /^\/contents\/(.+)$/u.exec(local);
      if (file) {
        const name = decodeURIComponent(file[1]);
        const text = gh.files[url.searchParams.get('ref') ?? '']?.[name];
        if (text !== undefined)
          return reply({ type: 'file', size: encoder.encode(text).length, encoding: 'base64', content: b64(text) });
      }
      return reply({ message: 'Not Found' }, 404);
    }
    const sent = init.body ? JSON.parse(init.body) : null;
    gh.writes.push({ method, path: local, body: sent });
    if (method === 'POST' && local === '/git/trees') return reply({ sha: `tree-${gh.writes.length}` }, 201);
    if (method === 'POST' && local === '/git/commits') {
      const sha = gh.writes.length.toString(16).padStart(40, 'c');
      const tree = [...gh.writes].reverse().find((w) => w.path === '/git/trees');
      gh.files[sha] = { ...gh.files[gh.head], ...Object.fromEntries(tree.body.tree.map((t) => [t.path, t.content])) };
      return reply({ sha }, 201);
    }
    if (method === 'POST' && local === '/git/refs') return reply({ ref: sent.ref }, 201);
    if (method === 'PATCH' && local.startsWith('/git/refs/heads/')) return reply({ object: { sha: sent.sha } });
    if (method === 'DELETE' && local.startsWith('/git/refs/heads/')) return new Response(null, { status: 204 });
    if (method === 'POST' && local === '/pulls') {
      const number = 500 + Object.keys(gh.pulls).length;
      const commit = [...gh.writes].reverse().find((w) => w.path === '/git/commits');
      gh.pulls[number] = {
        number,
        state: 'open',
        mergeable: true,
        mergeable_state: 'clean',
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        head: { ref: sent.head, sha: (gh.writes.indexOf(commit) + 1).toString(16).padStart(40, 'c') },
      };
      return reply(gh.pulls[number], 201);
    }
    const merge = /^\/pulls\/(\d+)\/merge$/u.exec(local);
    if (method === 'PUT' && merge) {
      Object.assign(gh.pulls[merge[1]], { state: 'closed', merged: true, merged_at: new Date().toISOString() });
      return reply({ sha: 'merge-1', merged: true });
    }
    const patch = /^\/pulls\/(\d+)$/u.exec(local);
    if (method === 'PATCH' && patch) {
      Object.assign(gh.pulls[patch[1]], sent);
      return reply(gh.pulls[patch[1]]);
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('policy changes from the board', () => {
  const PROVIDER = 'fakepolicy';
  const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
  const inStore = (fn) => runInDurableObject(store(), fn);
  const body = async (res) => ({ status: res.status, ...(await res.json()) });
  let cookie;
  let spy;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const change = (b) => board('infra/policy/changes', { method: 'POST', body: { repo: 'widgets', ...b } });
  const LOOSER = { allow: [{ name: 'staging scales', environments: ['pol-staging'], changes: ['scale'] }] };
  const audit = () =>
    inStore((s) =>
      s.sql
        .exec("SELECT environment, outcome, summary, by FROM infra_audit WHERE kind = 'policy' ORDER BY id")
        .toArray(),
    );
  /** A plan waiting for the owner in pol-staging that only scales a service. */
  const waiting = () =>
    inStore((s) => {
      const now = Date.now();
      return Number(
        s.sql
          .exec(
            `INSERT INTO infra_plans (environment, repo, provider, source, state, diff, cost, blast, reversible, policy, by, created, updated)
             VALUES (?, 'widgets', ?, 'drift', 'waiting', ?, ?, '{}', 1, NULL, 'board', ?, ?) RETURNING n`,
            envs['pol-staging'].id,
            PROVIDER,
            JSON.stringify({ changes: [scale], reversible: true }),
            JSON.stringify({ delta: 0, after: 0, complete: true, currency: 'USD', unknown: [] }),
            now,
            now,
          )
          .toArray()[0].n,
      );
    });

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    await inStore(async (s) => {
      s.infraProviders = new ProviderRegistry();
      s.infraProviders.register(fakeProvider({ id: PROVIDER }));
    });
    for (const [name, kind] of [
      ['pol-staging', 'staging'],
      ['pol-prod', 'production'],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api' },
        }),
      );
      envs[name] = made.environment;
    }
  });
  beforeEach(() => {
    spy = mockGitHub();
    Object.assign(gh, { files: { 'head-1': {} }, head: 'head-1', pulls: {}, writes: [] });
  });
  afterEach(async () => {
    spy.mockRestore();
    await inStore((s) => {
      s.sql.exec("UPDATE infra_policy_changes SET state = 'closed'");
      s.sql.exec("UPDATE infra_plans SET state = 'rejected' WHERE state = 'waiting'");
      s.ctx.storage.deleteAlarm();
    });
  });

  it('is the owner’s alone: the bearer token and an agent’s by are refused', async () => {
    expect((await api('infra/policy/changes', { method: 'POST', body: { repo: 'widgets', policy: {} } })).status).toBe(
      403,
    );
    expect((await change({ policy: {}, by: 'claude-x' })).status).toBe(403);
    expect((await api('infra/policy/changes/1/approve', { method: 'POST', body: {} })).status).toBe(403);
    // Reading is anyone's.
    expect((await api('infra/policy/view?repo=widgets')).status).toBe(200);
  });

  it('previews what an edit loosens, and the waiting plans it would let through, writing nothing', async () => {
    const n = await waiting();
    const res = await body(await change({ policy: LOOSER }));
    expect(res).toMatchObject({
      status: 200,
      loosens: ['In pol-staging: plans that only scale resources no longer wait for you (“staging scales”).'],
      tightens: [],
      unlocks: [{ id: `plan-${n}`, environment: 'pol-staging' }],
    });
    expect(JSON.parse(res.text)).toMatchObject({ version: 1, allow: LOOSER.allow });
    expect(gh.writes).toEqual([]);
    const bad = await body(await change({ policy: { costLimit: 'lots' } }));
    expect(bad).toMatchObject({ status: 422, field: 'costLimit' });
  });

  it('proposes it as the board’s own pull request, and a loosening approve needs the second press', async () => {
    const proposed = await body(await change({ policy: LOOSER, propose: true }));
    expect(proposed.status).toBe(201);
    expect(proposed.change).toMatchObject({
      state: 'open',
      branch: expect.stringMatching(/^breakaway\/infra\/policy-\d+$/u),
      loosens: ['In pol-staging: plans that only scale resources no longer wait for you (“staging scales”).'],
    });
    const tree = gh.writes.find((w) => w.path === '/git/trees');
    expect(tree.body.tree.map((t) => t.path)).toEqual([POLICY_PATH]);
    const opened = gh.writes.find((w) => w.path === '/pulls');
    expect(opened.body.title).toBe('Loosen the infrastructure policy');
    expect(opened.body.body).toContain('**Loosens your policy.**');
    expect((await audit()).filter((a) => a.outcome === 'proposed').map((a) => a.environment)).toEqual([
      'pol-prod',
      'pol-staging',
    ]);

    const n = proposed.change.n;
    const sha = proposed.change.commit;
    const approve = (b) => board(`infra/policy/changes/${n}/approve`, { method: 'POST', body: { sha, ...b } });

    // One press isn't enough: the board names what will no longer wait.
    const first = await body(await approve({}));
    expect(first).toMatchObject({ status: 409, confirm: true, loosens: proposed.change.loosens });
    expect(gh.writes.some((w) => w.method === 'PUT')).toBe(false);
    // A confirm of anything but those lines is the first press again.
    expect(await body(await approve({ loosens: ['something else'] }))).toMatchObject({ status: 409, confirm: true });

    // Not with a plan it would let through: that plan is answered on its own first.
    const p = await waiting();
    const held = await body(await approve({ loosens: first.loosens }));
    expect(held).toMatchObject({ status: 409, unlocks: [{ id: `plan-${p}`, environment: 'pol-staging' }] });
    expect(held.error).toMatch(/waits for you in pol-staging, and this change would let it through without you/u);
    expect(gh.writes.some((w) => w.method === 'PUT')).toBe(false);
    await inStore((s) => s.sql.exec("UPDATE infra_plans SET state = 'rejected' WHERE n = ?", p));

    const merged = await body(await approve({ loosens: first.loosens }));
    expect(merged).toMatchObject({ status: 200, change: { state: 'merged' } });
    expect(gh.writes.find((w) => w.method === 'PUT')).toMatchObject({
      path: `/pulls/${proposed.change.pull.number}/merge`,
      body: { sha, merge_method: 'squash' },
    });
    // Merging approves no plan and applies nothing.
    expect(
      await inStore((s) => s.sql.exec("SELECT COUNT(*) AS n FROM infra_plans WHERE state = 'approved'").toArray()[0].n),
    ).toBe(0);
  });

  it('tightens in one press, and refuses an approval at a head the owner didn’t see', async () => {
    gh.files['head-1'] = { [POLICY_PATH]: policyText(policy(LOOSER)) };
    const proposed = await body(await change({ policy: { ...LOOSER, budget: 10 }, propose: true }));
    expect(proposed.change.loosens).toEqual([]);
    expect(proposed.change.lines.map((l) => l.effect)).toEqual(['tightens']);
    const n = proposed.change.n;
    const moved = await body(
      await board(`infra/policy/changes/${n}/approve`, { method: 'POST', body: { sha: 'abcdef1' } }),
    );
    expect(moved).toMatchObject({ status: 409, error: expect.stringMatching(/changed since you looked/u) });
    const once = await body(
      await board(`infra/policy/changes/${n}/approve`, { method: 'POST', body: { sha: proposed.change.commit } }),
    );
    expect(once).toMatchObject({ status: 200, change: { state: 'merged' } });
  });

  it('rejects by closing its pull request, and the view shows rules, plans, and changes', async () => {
    const proposed = await body(await change({ policy: { budget: 10 }, propose: true }));
    const rejected = await body(
      await board(`infra/policy/changes/${proposed.change.n}/reject`, { method: 'POST', body: {} }),
    );
    expect(rejected).toMatchObject({ status: 200, change: { state: 'rejected' } });
    expect(gh.writes.find((w) => w.method === 'PATCH' && w.path.startsWith('/pulls/'))?.body).toEqual({
      state: 'closed',
    });
    const view = await body(await board('infra/policy/view?repo=widgets'));
    expect(view).toMatchObject({ status: 200, repo: 'widgets', policy: 'default', open: null });
    expect(view.environments.map((e) => e.name)).toEqual(['pol-prod', 'pol-staging']);
    expect(view.environments[0].rules.find((r) => r.rule === 'production').words).toBe(
      'Every plan here waits for you: production needs you.',
    );
    expect(view.changes[0]).toMatchObject({ n: proposed.change.n, state: 'rejected' });
    expect(Array.isArray(view.plans)).toBe(true);
  });
});
