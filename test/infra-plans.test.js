import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import {
  PLAN_MOVES,
  PLAN_STATES,
  blastRadius,
  checkMove,
  checkSource,
  costChange,
  keptDiff,
  planNumber,
} from '../src/infra-plans.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeplans';
const usd = (amount) => ({ amount, currency: 'USD' });

/** Runs the store's own call, the way the board's control plane does, and returns what it gave or the error. */
const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

/** The fake platform's desired state: what it runs now, with `change` applied by resource ID (null drops one). */
const desired = (provider, change = {}) => ({
  version: 1,
  provider: PROVIDER,
  resources: provider.state.resources
    .filter((r) => change[r.id] !== null)
    .map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) })),
});

describe('plans, the pure part (BRK-178)', () => {
  const diff = {
    provider: 'fake',
    environment: 'staging',
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
      {
        op: 'delete',
        resource: 'db-main',
        kind: 'database',
        name: 'main',
        before: { size: 'small' },
        after: null,
        reversible: false,
        why: 'deleting database main deletes its data',
      },
      { op: 'create', resource: 'q', kind: 'queue', name: 'jobs', before: null, after: {}, reversible: true },
    ],
    reversible: false,
  };

  it('prices a plan from what each resource costs now and the provider’s estimates, and says what it can’t price', () => {
    const costs = new Map([
      ['svc-api', usd(5)],
      ['db-main', usd(1.5)],
      ['route-api', usd(0)],
    ]);
    const cost = costChange(diff, costs, new Map([['svc-api', usd(10)]]));
    expect(cost).toMatchObject({
      currency: 'USD',
      now: 6.5,
      delta: 3.5,
      after: 10,
      complete: false,
      unknown: ['q'],
      perMonth: true,
      estimate: true,
    });
    expect(cost.changes).toEqual([
      { resource: 'svc-api', before: 5, after: 10 },
      { resource: 'db-main', before: 1.5, after: 0 },
      { resource: 'q', before: 0, after: null },
    ]);
    // A restart costs what it did; with no costs at all, nothing is known.
    const restart = { ...diff, changes: [{ ...diff.changes[0], op: 'restart' }] };
    expect(costChange(restart, costs)).toMatchObject({ delta: 0, complete: true, unknown: [] });
    expect(costChange(diff, new Map())).toMatchObject({ currency: null, now: null, delta: null, complete: false });
  });

  it('measures the blast radius backwards along what leans on what, and names a deletion still in use', () => {
    const inventory = {
      resources: [
        { id: 'svc-api', kind: 'service', name: 'api' },
        { id: 'db-main', kind: 'database', name: 'main' },
        { id: 'route-api', kind: 'route', name: 'api.acme.example' },
        { id: 'svc-jobs', kind: 'service', name: 'jobs' },
        { id: 'svc-cron', kind: 'service', name: 'cron' },
      ],
      relations: [
        { from: 'svc-api', to: 'db-main', kind: 'uses' },
        { from: 'svc-api', to: 'route-api', kind: 'serves' },
        { from: 'svc-jobs', to: 'db-main', kind: 'uses' },
        { from: 'svc-cron', to: 'svc-jobs', kind: 'calls' },
      ],
      seen: '2026-10-06T12:00:00.000Z',
    };
    const onlyDb = { ...diff, changes: [diff.changes[1]] };
    const blast = blastRadius(onlyDb, inventory);
    expect(blast.resources.map(({ id, changed, depth, leansOn }) => ({ id, changed, depth, leansOn }))).toEqual([
      { id: 'db-main', changed: true, depth: 0, leansOn: null },
      { id: 'svc-api', changed: false, depth: 1, leansOn: { id: 'db-main', relation: 'uses' } },
      { id: 'svc-jobs', changed: false, depth: 1, leansOn: { id: 'db-main', relation: 'uses' } },
      { id: 'svc-cron', changed: false, depth: 2, leansOn: { id: 'svc-jobs', relation: 'calls' } },
    ]);
    expect(blast).toMatchObject({ changed: 1, affected: 3, seen: '2026-10-06T12:00:00.000Z' });
    expect(blast.deletesInUse).toEqual([{ resource: 'db-main', name: 'main', by: ['svc-api', 'svc-jobs'] }]);
    // With no inventory, the plan reaches what it changes and says the relations weren't seen.
    expect(blastRadius(onlyDb, { resources: [], relations: [] })).toMatchObject({
      changed: 1,
      affected: 0,
      seen: null,
    });
  });

  it('moves only along the states’ paths, and takes only known sources', () => {
    expect(PLAN_STATES).toEqual(Object.keys(PLAN_MOVES));
    expect(() => checkMove('draft', 'waiting')).not.toThrow();
    expect(() => checkMove('draft', 'approved')).toThrow(
      /a plan that is draft can’t become approved: it can become waiting or rejected/u,
    );
    expect(() => checkMove('rejected', 'waiting')).toThrow(/can’t become waiting$/u);
    expect(() => checkMove('draft', 'done')).toThrow(/state must be one of/u);
    expect(checkSource('pull-request', '#42')).toEqual({ source: 'pull-request', ref: '#42' });
    expect(checkSource('drift')).toEqual({ source: 'drift', ref: null });
    expect(() => checkSource('cron')).toThrow(/source must be one of/u);
    expect(() => checkSource('incident', 'a b')).toThrow(/ref/u);
    expect([planNumber('plan-12'), planNumber('12'), planNumber('plan-0'), planNumber('x')]).toEqual([
      12,
      12,
      null,
      null,
    ]);
  });

  it('keeps settings as they are, and redacts a token a platform echoes back', () => {
    const leaky = {
      ...diff,
      changes: [{ ...diff.changes[0], after: { instances: 4, note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }],
      reversible: true,
    };
    const kept = keptDiff(leaky);
    expect(kept.changes[0].after.instances).toBe(4);
    expect(kept.changes[0].after.note).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(keptDiff(diff)).toEqual(diff);
  });
});

describe('plans in the store (BRK-178)', () => {
  let cookie;
  let staging;
  let provider;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const made = await body(
      await board('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'plans-staging', kind: 'staging', target: 'svc-api' },
      }),
    );
    staging = made.environment;
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
    });
  });
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** Puts a desired state on the environment, as a read of its file from the default branch would. */
  const want = (state, sha = 'abc123') =>
    runInDurableObject(store(), (instance) => {
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'plans-staging.json', 'plans-staging', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify(state),
        sha,
        Date.now(),
      );
    });
  const audit = async (plan) =>
    (await body(await api(`infra/audit?environmentId=${staging.id}`))).entries.filter((e) => e.plan === plan);

  it('refuses an environment with no desired state, saying where the file goes', async () => {
    const res = await body(
      await api('infra/plans', { method: 'POST', body: { environment: staging.id, source: 'drift' } }),
    );
    expect(res).toMatchObject({ status: 409, error: /add \.github\/breakaway-infra\/plans-staging\.json/u });
  });

  it('makes a draft from the provider’s diff, with its cost change, blast radius, and why it can’t be undone', async () => {
    await want(desired(provider, { 'svc-api': { attrs: { instances: 4, version: '1.0.0' } }, 'db-main': null }));
    const res = await body(
      await api('infra/plans', {
        method: 'POST',
        // A diff in the body is never read: the board asks the provider.
        body: { environment: 'plans-staging', source: 'pull-request', ref: '#42', diff: { changes: [] } },
      }),
    );
    expect(res.status).toBe(201);
    const plan = res.plan;
    expect(plan).toMatchObject({
      id: expect.stringMatching(/^plan-\d+$/u),
      repo: 'widgets',
      environment: { id: staging.id, name: 'plans-staging' },
      provider: PROVIDER,
      target: 'svc-api',
      desiredSha: 'abc123',
      source: { kind: 'pull-request', ref: '#42' },
      state: 'draft',
      changes: 2,
      reversible: false,
      irreversible: [
        { resource: 'db-main', name: 'main', op: 'delete', why: 'deleting database main deletes its data' },
      ],
      by: 'owner',
      agent: null,
    });
    expect(plan.diff.changes.map((c) => `${c.op} ${c.resource}`)).toEqual(['scale svc-api', 'delete db-main']);
    expect(plan.cost).toMatchObject({
      currency: 'USD',
      now: 6.5,
      delta: 3.5,
      after: 10,
      complete: true,
      estimate: true,
    });
    expect(plan.blastRadius).toMatchObject({ changed: 2, affected: 0 });
    expect(plan.blastRadius.deletesInUse).toEqual([{ resource: 'db-main', name: 'main', by: ['svc-api'] }]);
    expect(await audit(plan.id)).toMatchObject([
      { kind: 'plan', by: 'owner', outcome: 'draft', environment: 'plans-staging', environmentId: staging.id },
    ]);
    // It reads back the same.
    const read = await body(await api(`infra/plans/${plan.id}`));
    expect(read.plan).toEqual(plan);
  });

  it('reaches what leans on the change, from the inventory', async () => {
    await want(desired(provider, { 'db-main': { attrs: { size: 'large' } } }));
    const { value: plan } = await inStore((s) => s.makeInfraPlan(staging.id, { source: 'drift', by: 'board' }));
    expect(plan.blastRadius.resources.map((r) => [r.id, r.changed, r.leansOn?.relation ?? null])).toEqual([
      ['db-main', true, null],
      ['svc-api', false, 'uses'],
    ]);
    expect(plan.cost).toMatchObject({ delta: 4.5, complete: true });
    expect(plan.reversible).toBe(true);
    expect(await audit(plan.id)).toMatchObject([{ kind: 'plan', by: 'board' }]);
  });

  it('writes an audit entry on every state change, and refuses a move off the states’ paths', async () => {
    await want(desired(provider, { 'svc-api': { attrs: { instances: 3, version: '1.0.0' } } }));
    const { value: plan } = await inStore((s) => s.makeInfraPlan(staging.id, { source: 'drift', by: 'board' }));
    const skip = await inStore((s) => s.moveInfraPlan(plan.id, 'applying', { by: 'executor' }));
    expect(skip).toMatchObject({ ok: false, status: 409, error: /draft can’t become applying/u });
    const path = [
      ['waiting', 'board'],
      ['approved', 'owner'],
      ['applying', 'executor'],
      ['applied', 'executor'],
      ['rolled back', 'executor'],
    ];
    for (const [to, by] of path) {
      // Approving keeps the plan's digest (BRK-182).
      const digest = to === 'approved' ? 'a'.repeat(64) : undefined;
      const moved = await inStore((s) => s.moveInfraPlan(plan.id, to, { by, digest }));
      expect(moved).toMatchObject({ ok: true, value: { state: to } });
    }
    const entries = (await audit(plan.id)).reverse();
    expect(entries.map((e) => [e.kind, e.by, e.outcome])).toEqual([
      ['plan', 'board', 'draft'],
      ['plan', 'board', 'waiting'],
      ['approve', 'owner', 'approved'],
      ['apply', 'executor', 'applying'],
      ['apply', 'executor', 'applied'],
      ['rollback', 'executor', 'rolled back'],
    ]);
    const end = await inStore((s) => s.moveInfraPlan(plan.id, 'waiting', { by: 'board' }));
    expect(end).toMatchObject({ ok: false, status: 409 });
    expect(await audit(plan.id)).toHaveLength(6);
  });

  it('lets an agent propose a draft, and only the owner put one in front of the owner', async () => {
    await want(desired(provider, { 'route-api': { attrs: { path: '/v2/*' } } }));
    const proposed = await body(
      await api('infra/plans', {
        method: 'POST',
        body: { environment: staging.id, source: 'incident', ref: 'BRK-1', by: 'claude-a' },
      }),
    );
    expect(proposed.plan).toMatchObject({ state: 'draft', by: 'agent', agent: 'claude-a' });
    expect(await audit(proposed.plan.id)).toMatchObject([{ kind: 'plan', by: 'agent', agent: 'claude-a' }]);
    const refused = await body(
      await api(`infra/plans/${proposed.plan.id}`, { method: 'PATCH', body: { state: 'waiting', by: 'claude-a' } }),
    );
    expect(refused.status).toBe(403);
    // The bearer token never does, whoever it says it is.
    const token = await body(
      await api(`infra/plans/${proposed.plan.id}`, { method: 'PATCH', body: { state: 'waiting' } }),
    );
    expect(token).toMatchObject({ status: 403, error: /only the signed-in web board/u });
    const byAgent = await body(
      await board(`infra/plans/${proposed.plan.id}`, { method: 'PATCH', body: { state: 'waiting', by: 'claude-a' } }),
    );
    expect(byAgent.status).toBe(403);
    const approve = await body(
      await board(`infra/plans/${proposed.plan.id}`, { method: 'PATCH', body: { state: 'approved' } }),
    );
    expect(approve.status).toBe(400);
    const waits = await body(
      await board(`infra/plans/${proposed.plan.id}`, { method: 'PATCH', body: { state: 'waiting' } }),
    );
    expect(waits.plan.state).toBe('waiting');
    // The environment's card shows the waiting plan without a second call.
    const shown = await body(await api(`infra/environments/${staging.id}`));
    expect(shown.environment.waitingPlan).toBe(proposed.plan.id);
    const list = await body(await api(`infra/plans?environment=${staging.id}&state=waiting`));
    expect(list.plans.map((p) => p.id)).toEqual([proposed.plan.id]);
    expect(list.plans[0].diff).toBeUndefined();
  });

  it('lists plans newest first, paged', async () => {
    const page = await body(await api(`infra/plans?repo=widgets&limit=2`));
    expect(page.plans).toHaveLength(2);
    expect(page.more).toBe(true);
    const next = await body(await api(`infra/plans?repo=widgets&limit=50&before=${page.plans[1].id}`));
    expect(next.plans.every((p) => Number(p.id.slice(5)) < Number(page.plans[1].id.slice(5)))).toBe(true);
    expect((await body(await api('infra/plans?state=done'))).status).toBe(400);
    expect((await body(await api('infra/plans/plan-99999'))).status).toBe(404);
  });

  it('refuses when nothing would change, and keeps nothing when the provider fails', async () => {
    await want(desired(provider));
    const same = await body(
      await api('infra/plans', { method: 'POST', body: { environment: staging.id, source: 'drift' } }),
    );
    expect(same).toMatchObject({ status: 409, error: /already matches its desired state/u });
    await want(desired(provider, { 'svc-api': { attrs: { instances: 5, version: '1.0.0' } } }));
    const before = (await body(await api('infra/plans?limit=200'))).plans.length;
    const plan = provider.plan;
    provider.plan = async () => {
      throw new Error('the platform is down');
    };
    const failed = await inStore((s) => s.makeInfraPlan(staging.id, { source: 'drift', by: 'board' }));
    provider.plan = plan;
    expect(failed).toMatchObject({
      ok: false,
      status: 502,
      error: /couldn’t plan widgets’s plans-staging: the platform is down/u,
    });
    expect((await body(await api('infra/plans?limit=200'))).plans.length).toBe(before);
  });

  it('never plans for an observe-only environment', async () => {
    const watched = await body(
      await board('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'plans-watched', kind: 'production', target: 'svc-api' },
      }),
    );
    await board(`infra/environments/${watched.environment.id}`, { method: 'PATCH', body: { observeOnly: true } });
    const res = await inStore((s) => s.makeInfraPlan(watched.environment.id, { source: 'drift', by: 'board' }));
    expect(res).toMatchObject({ ok: false, status: 409, error: /observe only/u });
  });
});
