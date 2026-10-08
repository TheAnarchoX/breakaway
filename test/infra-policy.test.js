import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { GitHubError } from '../src/github.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { DESIRED_DIR } from '../src/infra-desired.js';
import {
  DEFAULT_POLICY,
  GUARDS,
  POLICY_PATH,
  allows,
  checkPolicyFile,
  evaluatePolicy,
  limitsFor,
  money,
} from '../src/infra-policy.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakepolicy';

const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

/** A policy file's text, from an object. */
const file = (o) => JSON.stringify(o, null, 2);
const policyOf = (o) => {
  const checked = checkPolicyFile(file(o));
  if (!checked.ok) throw new Error(checked.error.message);
  return checked.policy;
};

const change = (over = {}) => ({
  op: 'update',
  resource: 'svc-api',
  kind: 'service',
  name: 'api',
  before: { version: '1.0.0' },
  after: { version: '1.1.0' },
  reversible: true,
  ...over,
});
const diffOf = (...changes) => ({
  provider: 'fake',
  environment: 'staging',
  changes,
  reversible: changes.every((c) => c.reversible),
});
const costOf = (over = {}) => ({
  currency: 'USD',
  now: 6.5,
  delta: 0,
  after: 6.5,
  complete: true,
  unknown: [],
  changes: [],
  perMonth: true,
  estimate: true,
  ...over,
});
const staging = { name: 'staging', frozen: false, gates: false };
const production = { name: 'production', frozen: false, gates: true };
const kinds = {
  kinds: {
    service: { changes: ['create', 'update', 'delete', 'scale', 'restart'], accessSettings: ['public'] },
    route: { changes: ['create', 'update', 'delete'], access: true },
  },
};
const applied = (result) => result.rules.filter((r) => r.applies).map((r) => r.rule);

describe('policy, the pure part (BRK-181)', () => {
  it('asks the owner for every plan under the default policy, and says why', () => {
    const small = evaluatePolicy(DEFAULT_POLICY, { environment: staging, diff: diffOf(change()), cost: costOf() });
    expect(small).toMatchObject({ policy: 'default', outcome: 'needs-owner', rule: 'every' });
    expect(small.reasons).toEqual(['Every plan needs you: the default policy lets nothing through.']);
    expect(small.rules.map((r) => r.rule)).toEqual([...GUARDS, 'every']);
    expect(small.limits).toEqual({ costLimit: 5, budget: 20, currency: 'USD', rate: null });
  });

  it('names production, a destructive change, access, a cost over the limit, and the budget', () => {
    const prod = evaluatePolicy(DEFAULT_POLICY, { environment: production, diff: diffOf(change()), cost: costOf() });
    expect(prod).toMatchObject({ outcome: 'needs-owner', rule: 'production' });
    expect(prod.reasons).toEqual(['Production needs you.']);

    const drop = change({
      op: 'delete',
      resource: 'db-main',
      kind: 'database',
      name: 'widgets',
      after: null,
      reversible: false,
      why: 'deleting database widgets deletes its data',
    });
    const destructive = evaluatePolicy(DEFAULT_POLICY, { environment: staging, diff: diffOf(drop), cost: costOf() });
    expect(destructive).toMatchObject({ outcome: 'needs-owner', rule: 'destructive' });
    expect(destructive.reasons).toEqual(['Can’t be undone: it deletes the `widgets` database.']);

    const pricey = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: diffOf(change({ op: 'scale', before: { instances: 2 }, after: { instances: 5 } })),
      cost: costOf({ delta: 6, after: 12.5 }),
    });
    expect(pricey).toMatchObject({ outcome: 'needs-owner', rule: 'cost' });
    expect(pricey.reasons).toEqual(['Adds $6 a month, over your $5 limit.']);

    const budget = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: diffOf(change()),
      cost: costOf({ now: 18, delta: 4, after: 22 }),
    });
    expect(applied(budget)).toEqual(['budget']);
    expect(budget.reasons[0]).toBe('Takes staging to $22 a month, over its $20 budget.');

    const route = change({ resource: 'route-api', kind: 'route', name: 'api.acme.example' });
    const exposed = change({ before: { public: false }, after: { public: true } });
    const access = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: diffOf(route, exposed),
      cost: costOf(),
      provider: kinds,
    });
    expect(access).toMatchObject({ rule: 'access' });
    expect(access.reasons[0]).toBe(
      'Changes who or what can reach it: it changes the `api.acme.example` route and changes the `api` service’s public.',
    );

    // Everything at once: each rule that applies is named, one a line, in the guards' order; `every` only when none did.
    const all = evaluatePolicy(DEFAULT_POLICY, {
      environment: production,
      diff: diffOf(drop, route),
      cost: costOf({ delta: 9, after: 30 }),
      provider: kinds,
    });
    expect(applied(all)).toEqual(['production', 'destructive', 'access', 'cost', 'budget']);
  });

  it('asks when it can’t tell what a change costs, and never for a plan that saves', () => {
    const unknown = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: diffOf(change({ op: 'create', kind: 'queue', name: 'jobs', before: null })),
      cost: costOf({ delta: null, after: null, complete: false, unknown: ['q'] }),
    });
    expect(unknown.rule).toBe('cost');
    expect(unknown.reasons[0]).toMatch(
      /isn’t known for 1 of its changes, so it can’t be checked against your \$5 limit/u,
    );
    const saves = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: diffOf(change({ op: 'scale' })),
      cost: costOf({ now: 30, delta: -2.5, after: 27.5 }),
    });
    // Over budget already, but the plan lowers the cost: it isn't what takes it over.
    expect(applied(saves)).toEqual(['every']);
    expect(saves.rules.find((r) => r.rule === 'cost').reason).toBe('Saves $2.50 a month.');
  });

  it('refuses every plan in a frozen environment', () => {
    const result = evaluatePolicy(policyOf({ version: 1, allow: [{ name: 'anything' }] }), {
      environment: { ...staging, frozen: true },
      diff: diffOf(change()),
      cost: costOf(),
    });
    expect(result).toMatchObject({ outcome: 'refused', rule: 'frozen' });
    expect(result.reasons[0]).toBe('Staging is frozen: nothing changes there until the owner unfreezes it.');
  });

  it('lets a plan a repository’s rule covers through, naming the rule, and never past a guard', () => {
    const policy = policyOf({
      version: 1,
      allow: [
        { name: 'staging restarts', environments: ['staging'], changes: ['restart'] },
        { name: 'small staging changes', environments: ['staging'], changes: ['update', 'scale'], maxChanges: 2 },
      ],
    });
    const ok = evaluatePolicy(
      policy,
      { environment: staging, diff: diffOf(change()), cost: costOf() },
      { policy: 'repository', sha: 'abc' },
    );
    expect(ok).toMatchObject({ policy: 'repository', sha: 'abc', outcome: 'allowed', rule: 'small staging changes' });
    expect(ok.reasons).toEqual(['Allowed by your policy’s rule “small staging changes”.']);
    // Three changes is more than the rule covers.
    const many = evaluatePolicy(policy, {
      environment: staging,
      diff: diffOf(change(), change(), change()),
      cost: costOf(),
    });
    expect(many).toMatchObject({ outcome: 'needs-owner', rule: 'every' });
    expect(many.reasons).toEqual(['No rule in your policy lets it through, so it needs you.']);
    // A guard still asks: production, and a cost over the limit.
    expect(evaluatePolicy(policy, { environment: production, diff: diffOf(change()), cost: costOf() }).rule).toBe(
      'production',
    );
    const over = evaluatePolicy(policy, {
      environment: staging,
      diff: diffOf(change()),
      cost: costOf({ delta: 7, after: 13.5 }),
    });
    expect(over).toMatchObject({ outcome: 'needs-owner', rule: 'cost' });
    expect(allows({ name: 'x', kinds: ['service'] }, 'staging', diffOf(change(), change({ kind: 'route' })))).toBe(
      false,
    );
  });

  it('takes the limits from the file, per environment, and the default otherwise', () => {
    const policy = policyOf({ version: 1, costLimit: 10, environments: { production: { budget: 200 } } });
    expect(limitsFor(policy, 'staging')).toEqual({ costLimit: 10, budget: 20 });
    expect(limitsFor(policy, 'production')).toEqual({ costLimit: 10, budget: 200 });
    const raised = evaluatePolicy(policy, {
      environment: staging,
      diff: diffOf(change()),
      cost: costOf({ delta: 6, after: 12.5 }),
    });
    expect(applied(raised)).toEqual(['every']);
    expect(raised.rules.find((r) => r.rule === 'cost').reason).toBe('Adds $6 a month, inside your $10 limit.');
    expect(money(4.6, 'EUR')).toBe('€4.60');
    expect(money(3, null)).toBe('3');
  });

  it('says which line and field of a policy file is wrong', () => {
    const wrong = (text) => {
      const checked = checkPolicyFile(text);
      return checked.ok ? null : checked.error;
    };
    expect(checkPolicyFile('{ "version": 1 }')).toEqual({ ok: true, policy: { ...DEFAULT_POLICY } });
    expect(wrong('{ "version": 1, ')).toMatchObject({ line: 1, message: /isn’t JSON/u });
    expect(wrong('{ "version": 2 }')).toMatchObject({ field: 'version', message: /version is 1/u });
    expect(wrong(file({ version: 1, ask: [] }))).toMatchObject({
      field: 'ask',
      line: 3,
      message: /“ask” isn’t part of a policy/u,
    });
    expect(wrong(file({ version: 1, costLimit: -1 }))).toMatchObject({
      field: 'costLimit',
      message: /costLimit is an amount a month/u,
    });
    expect(wrong(file({ version: 1, environments: { Prod: {} } }))).toMatchObject({ field: 'environments.Prod' });
    expect(wrong(file({ version: 1, environments: { production: { cap: 1 } } }))).toMatchObject({
      field: 'environments.production.cap',
    });
    expect(wrong(file({ version: 1, allow: [{ changes: ['update'] }] }))).toMatchObject({
      field: 'allow[0]',
      message: /name says/u,
    });
    expect(wrong(file({ version: 1, allow: [{ name: 'a', changes: ['apply'] }] }))).toMatchObject({
      field: 'allow[0].changes[0]',
      message: /apply isn’t a change kind/u,
    });
    expect(wrong(file({ version: 1, allow: [{ name: 'a' }, { name: 'a' }] }))).toMatchObject({
      field: 'allow[1].name',
    });
    expect(wrong(file({ version: 1, allow: [{ name: 'production' }] }))).toMatchObject({
      message: /the board’s own rules/u,
    });
    // An empty list names nothing: the message says to leave it out (WEB-128).
    expect(wrong(file({ version: 1, access: { kinds: [] } }))).toMatchObject({
      field: 'access.kinds',
      message: 'kinds is empty: leave it out, or list a resource kind, lowercase, like route',
    });
    expect(wrong(file({ version: 1, environments: { staging: { access: { settings: [] } } } }))).toMatchObject({
      field: 'environments.staging.access.settings',
      message: /settings is empty: leave it out/u,
    });
    expect(wrong(file({ version: 1, allow: [{ name: 'a', maxChanges: 0 }] }))).toMatchObject({
      field: 'allow[0].maxChanges',
    });
  });
});

describe('policy in the store (BRK-181)', () => {
  let cookie;
  let provider;
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** Puts a desired state on an environment, as a read of its file from the default branch would. */
  const want = (name, resources) =>
    runInDurableObject(store(), (instance) => {
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', ?, ?, ?, 'abc123', ?, ?, 'abc123', ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired`,
        `${name}.json`,
        name,
        PROVIDER,
        Date.now(),
        JSON.stringify({ resources }),
        Date.now(),
      );
    });
  /** The fake platform's state with `change` applied by resource ID (null drops one). */
  const desired = (change = {}) =>
    provider.state.resources
      .filter((r) => change[r.id] !== null)
      .map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) }));
  const plan = (name) => inStore((s) => s.makeInfraPlan(envs[name].id, { source: 'drift', by: 'board' }));
  /** A repository's policy file, as the sync reads it from the folder's listing. */
  const readPolicy = (text, sha = 'def456') =>
    inStore((s) =>
      s.readInfraPolicy(
        {
          async get(path) {
            if (path.startsWith(`/contents/${DESIRED_DIR}/policy.json`)) return { type: 'file', content: btoa(text) };
            throw new GitHubError('Not Found', 404);
          },
        },
        { slug: 'widgets', defaultBranch: 'main' },
        sha,
        text === null ? [] : [{ type: 'file', name: 'policy.json', size: text.length }],
      ),
    );

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    for (const [name, kind] of [
      ['policy-staging', 'staging'],
      ['policy-production', 'production'],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api' },
        }),
      );
      envs[name] = made.environment;
    }
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
    });
  });
  afterAll(() => readPolicy(null));

  it('has the default policy for a repository without a file', async () => {
    const res = await body(await api('infra/policy?repo=widgets'));
    expect(res.policies).toEqual([
      expect.objectContaining({ repo: 'widgets', path: POLICY_PATH, policy: 'default', state: 'none', error: null }),
    ]);
    expect(res.policies[0].rules).toMatchObject({ costLimit: 5, budget: 20, allow: [] });
  });

  it('keeps each rule’s result on the plan: a small staging plan waits for the owner', async () => {
    await want('policy-staging', desired({ 'route-api': { attrs: { path: '/v2/*' } } }));
    const { value } = await plan('policy-staging');
    expect(value.policy).toMatchObject({ policy: 'default', outcome: 'needs-owner', rule: 'every' });
    const read = await body(await api(`infra/plans/${value.id}`));
    expect(read.plan.policy).toEqual(value.policy);
    const audit = (await body(await api(`infra/audit?environmentId=${envs['policy-staging'].id}`))).entries;
    expect(audit.find((e) => e.plan === value.id).summary).toMatch(/policy: needs the owner \(every\)/u);
  });

  it('says production, destructive, and over the cost limit need you, with the rule that said so', async () => {
    await want('policy-production', desired({ 'route-api': { attrs: { path: '/v3/*' } } }));
    const prod = (await plan('policy-production')).value.policy;
    expect(prod).toMatchObject({ outcome: 'needs-owner', rule: 'production' });
    expect(prod.reasons).toContain('Production needs you.');

    await want('policy-staging', desired({ 'db-main': null }));
    const drop = (await plan('policy-staging')).value.policy;
    expect(drop).toMatchObject({ outcome: 'needs-owner', rule: 'destructive' });
    expect(drop.reasons[0]).toBe('Can’t be undone: it deletes the `main` database.');

    // From 2 instances at 2.5 each to 6: 10 more a month.
    await want('policy-staging', desired({ 'svc-api': { attrs: { instances: 6, version: '1.0.0' } } }));
    const pricey = (await plan('policy-staging')).value.policy;
    expect(pricey).toMatchObject({ outcome: 'needs-owner', rule: 'cost' });
    expect(pricey.reasons[0]).toBe('Adds $10 a month, over your $5 limit.');
  });

  it('lets through what a repository’s policy file allows, with the rule named', async () => {
    await readPolicy(
      file({ version: 1, allow: [{ name: 'staging routes', environments: ['policy-staging'], kinds: ['route'] }] }),
    );
    const shown = (await body(await api('infra/policy?repo=widgets'))).policies[0];
    expect(shown).toMatchObject({ policy: 'repository', state: 'valid', sha: 'def456' });
    await want('policy-staging', desired({ 'route-api': { attrs: { path: '/v4/*' } } }));
    const { value } = await plan('policy-staging');
    expect(value.policy).toMatchObject({
      policy: 'repository',
      sha: 'def456',
      outcome: 'allowed',
      rule: 'staging routes',
    });
    const audit = (await body(await api(`infra/audit?environmentId=${envs['policy-staging'].id}`))).entries;
    expect(audit.find((e) => e.plan === value.id && e.outcome === 'draft').summary).toMatch(
      /policy allows it by “staging routes”/u,
    );
    // The board approves it by itself, naming the rule (BRK-182).
    expect(value.state).toBe('approved');
    expect(audit.find((e) => e.plan === value.id).summary).toBe('approved by your policy’s rule “staging routes”');
    // The same rule doesn't reach production.
    await want('policy-production', desired({ 'route-api': { attrs: { path: '/v4/*' } } }));
    expect((await plan('policy-production')).value.policy.rule).toBe('production');
  });

  it('falls back to the default when the file has an error, and says so on the policy and the plan', async () => {
    await readPolicy('{ "version": 1, "allow": [ { "name": 3 } ] }', 'bad789');
    const shown = (await body(await api('infra/policy?repo=widgets'))).policies[0];
    expect(shown).toMatchObject({ policy: 'default', state: 'invalid', sha: 'bad789' });
    expect(shown.error).toMatchObject({ line: 1, field: 'allow[0].name' });
    expect(shown.rules.allow).toEqual([]);
    // The rule that let staging routes through no longer does.
    await want('policy-staging', desired({ 'route-api': { attrs: { path: '/v6/*' } } }));
    const { value } = await plan('policy-staging');
    expect(value.policy).toMatchObject({
      policy: 'default',
      outcome: 'needs-owner',
      rule: 'every',
      error: { line: 1 },
    });
    expect(value.policy.reasons.at(-1)).toMatch(
      /^\.github\/breakaway-infra\/policy\.json has an error on line 1, so the default policy decides until it’s fixed: name says/u,
    );
    // A file that goes away leaves the default, with nothing wrong.
    await readPolicy(null);
    expect((await body(await api('infra/policy?repo=widgets'))).policies[0]).toMatchObject({
      policy: 'default',
      state: 'none',
      error: null,
    });
  });

  it('refuses every plan in a frozen environment, and every move that would bring one closer to applying', async () => {
    await want('policy-staging', desired({ 'route-api': { attrs: { path: '/v5/*' } } }));
    const { value: before } = await plan('policy-staging');
    await inStore((s) => s.moveInfraPlan(before.id, 'waiting', { by: 'owner' }));
    await board(`infra/environments/${envs['policy-staging'].id}`, { method: 'PATCH', body: { frozen: true } });
    expect(await plan('policy-staging')).toMatchObject({ ok: false, status: 409, error: /policy-staging is frozen/u });
    const approve = await inStore((s) => s.moveInfraPlan(before.id, 'approved', { by: 'owner' }));
    expect(approve).toMatchObject({
      ok: false,
      status: 409,
      error: /can’t become approved: policy-staging is frozen/u,
    });
    // Rejecting still goes.
    const reject = await inStore((s) => s.moveInfraPlan(before.id, 'rejected', { by: 'owner' }));
    expect(reject).toMatchObject({ ok: true, value: { state: 'rejected' } });
    await board(`infra/environments/${envs['policy-staging'].id}`, { method: 'PATCH', body: { frozen: false } });
    expect((await plan('policy-staging')).ok).toBe(true);
  });

  it('reads the policy from the desired-state folder’s listing, with no call when there’s no file', async () => {
    const calls = [];
    const client = {
      async get(path) {
        calls.push(path.split('?')[0]);
        if (path.startsWith(`/contents/${DESIRED_DIR}?`)) return [{ type: 'file', name: 'policy.json', size: 40 }];
        if (path.startsWith(`/contents/${DESIRED_DIR}/policy.json`))
          return { type: 'file', content: btoa(file({ version: 1, costLimit: 8 })) };
        throw new GitHubError('Not Found', 404);
      },
    };
    await inStore((s) => s.readDesiredStates(client, { slug: 'widgets', defaultBranch: 'main' }, 'sha-1'));
    expect(calls).toEqual([`/contents/${DESIRED_DIR}`, `/contents/${DESIRED_DIR}/policy.json`]);
    expect((await body(await api('infra/policy?repo=widgets'))).policies[0].rules.costLimit).toBe(8);
    calls.length = 0;
    client.get = async (path) => {
      calls.push(path.split('?')[0]);
      if (path.startsWith(`/contents/${DESIRED_DIR}?`)) return [];
      throw new GitHubError('Not Found', 404);
    };
    await inStore((s) => s.readDesiredStates(client, { slug: 'widgets', defaultBranch: 'main' }, 'sha-2'));
    expect(calls).toEqual([`/contents/${DESIRED_DIR}`]);
    expect((await body(await api('infra/policy?repo=widgets'))).policies[0].policy).toBe('default');
  });
});
