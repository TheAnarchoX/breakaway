import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { DRIFT_EVERY_MS, driftDue, driftFingerprint, driftResources, driftView } from '../src/infra-drift.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakedrift';

/** Runs the store's own call, the way the cron does, and returns what it gave or the error. */
const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

describe('drift, the pure part (BRK-184)', () => {
  const change = (over = {}) => ({
    op: 'update',
    resource: 'db-main',
    kind: 'database',
    name: 'main',
    before: { size: 'large', tier: 1 },
    after: { size: 'small', tier: 1 },
    reversible: true,
    ...over,
  });
  const diff = (changes) => ({ provider: 'fake', environment: 'staging', changes, reversible: true });

  it('fingerprints what differs the same in any order, and differently when it changes', async () => {
    const a = change();
    const b = change({ op: 'scale', resource: 'svc-api', kind: 'service', name: 'api', before: { instances: 1 } });
    const one = await driftFingerprint(diff([a, b]));
    expect(one).toMatch(/^[0-9a-f]{64}$/u);
    // Keys in another order, and the changes the other way round: the same drift.
    const reordered = { ...a, after: { tier: 1, size: 'small' } };
    expect(await driftFingerprint(diff([b, reordered]))).toBe(one);
    expect(await driftFingerprint(diff([a]))).not.toBe(one);
    expect(await driftFingerprint(diff([a, { ...b, before: { instances: 3 } }]))).not.toBe(one);
  });

  it('lists what differs, a line per resource, with what the plan would do to it', () => {
    expect(driftResources(diff([change()]))).toEqual([{ id: 'db-main', kind: 'database', name: 'main', op: 'update' }]);
  });

  it('compares again when it never has, the desired state moved, or the last comparison is old', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(driftDue(null, 'abc', now)).toBe(true);
    expect(driftDue({ checked: now - 1000, desired_sha: 'abc' }, 'abc', now)).toBe(false);
    expect(driftDue({ checked: now - 1000, desired_sha: 'abc' }, 'def', now)).toBe(true);
    expect(driftDue({ checked: now - DRIFT_EVERY_MS, desired_sha: 'abc' }, 'abc', now)).toBe(true);
  });

  it('shows a comparison that failed before the provider answered as not counted', () => {
    expect(driftView({ checked: 0, count: null, resources: null, plan: null, plan_matches: 0, error: 'down' })).toEqual(
      {
        checked: '1970-01-01T00:00:00.000Z',
        desiredSha: null,
        count: null,
        resources: [],
        plan: null,
        planMatches: false,
        error: 'down',
      },
    );
  });
});

describe('drift in the store (BRK-184)', () => {
  let cookie;
  let staging;
  let provider;
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** Puts what runs now as the environment's desired state, as a read of its file from the default branch would. */
  const want = (sha = 'abc123') =>
    runInDurableObject(store(), (instance) => {
      const state = { version: 1, provider: PROVIDER, resources: structuredClone(provider.state.resources) };
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'drift-staging.json', 'drift-staging', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify(state),
        sha,
        Date.now(),
      );
    });
  const driftPlans = async () =>
    (await body(await api(`infra/plans?environment=${staging.id}&limit=200`))).plans.filter(
      (p) => p.source.kind === 'drift',
    );
  const view = async () => (await body(await api(`infra/environments/${staging.id}`))).environment;
  /** The cron's tick, `ahead` past now, so every environment is due. */
  const cron = (ahead = DRIFT_EVERY_MS) => inStore((s) => s.driftTick(Date.now() + ahead));

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
        body: { repo: 'widgets', provider: PROVIDER, name: 'drift-staging', kind: 'staging', target: 'svc-api' },
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

  it('isn’t compared until it has a desired state, and says where the file goes', async () => {
    expect(await view()).toMatchObject({ driftCount: null, drift: null });
    expect(await cron()).toMatchObject({ ok: true, value: [] });
    const res = await body(await api(`infra/drift/${staging.id}`));
    expect(res).toMatchObject({ status: 404, error: /add \.github\/breakaway-infra\/drift-staging\.json/u });
  });

  it('finds no drift while what runs matches the repository, and makes no plan', async () => {
    await want();
    const { value } = await cron();
    expect(value).toMatchObject([{ environment: { id: staging.id }, count: 0, resources: [], plan: null }]);
    expect(await view()).toMatchObject({ driftCount: 0, drift: { count: 0, desiredSha: 'abc123', error: null } });
    expect(await driftPlans()).toEqual([]);
  });

  it('shows a change by hand as drift, and makes exactly one draft plan back to the desired state', async () => {
    provider.state.resources.find((r) => r.id === 'db-main').attrs.size = 'large';
    const { value } = await cron();
    expect(value).toHaveLength(1);
    const plans = await driftPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ state: 'draft', by: 'board', source: { kind: 'drift' }, changes: 1 });
    expect(await view()).toMatchObject({
      driftCount: 1,
      drift: {
        count: 1,
        resources: [{ id: 'db-main', kind: 'database', name: 'main', op: 'update' }],
        plan: plans[0].id,
        planMatches: true,
        error: null,
      },
    });
    const audit = (await body(await api(`infra/audit?environmentId=${staging.id}`))).entries;
    expect(audit.filter((e) => e.plan === plans[0].id)).toMatchObject([
      { kind: 'plan', by: 'board', outcome: 'draft' },
    ]);
    // Never applied: the platform still runs what was changed by hand.
    expect(provider.calls.filter((c) => c.method === 'apply')).toEqual([]);
    expect(provider.state.resources.find((r) => r.id === 'db-main').attrs.size).toBe('large');
  });

  it('doesn’t duplicate the plan on a second run', async () => {
    const first = await driftPlans();
    await cron();
    await cron(2 * DRIFT_EVERY_MS);
    expect(await driftPlans()).toEqual(first);
    expect((await view()).drift).toMatchObject({ count: 1, plan: first[0].id, planMatches: true });
  });

  it('waits until the next comparison is due', async () => {
    const before = (await view()).drift.checked;
    expect(await inStore((s) => s.driftTick(Date.now()))).toMatchObject({ ok: true, value: [] });
    expect((await view()).drift.checked).toBe(before);
  });

  it('makes no second plan while the first is open and the drift moved, and says the first no longer matches', async () => {
    const first = await driftPlans();
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 7;
    await cron();
    expect(await driftPlans()).toEqual(first);
    expect((await view()).drift).toMatchObject({ count: 2, plan: first[0].id, planMatches: false });
    // Once the owner rejects it, the next comparison makes a new one.
    await inStore((s) => s.moveInfraPlan(first[0].id, 'rejected', { by: 'owner' }));
    await cron();
    const plans = await driftPlans();
    expect(plans.map((p) => p.state)).toEqual(['draft', 'rejected']);
    expect((await view()).drift).toMatchObject({ count: 2, plan: plans[0].id, planMatches: true });
  });

  it('counts a plan from elsewhere that covers the drift, instead of making another', async () => {
    const [open] = await driftPlans();
    await inStore((s) => s.moveInfraPlan(open.id, 'rejected', { by: 'owner' }));
    const { value: pr } = await inStore((s) =>
      s.makeInfraPlan(staging.id, { source: 'pull-request', sourceRef: '#7', by: 'owner' }),
    );
    await cron();
    expect((await driftPlans()).filter((p) => p.state === 'draft')).toEqual([]);
    expect((await view()).drift).toMatchObject({ count: 2, plan: pr.id, planMatches: true });
    await inStore((s) => s.moveInfraPlan(pr.id, 'rejected', { by: 'owner' }));
  });

  it('keeps what differed and says why when the provider fails, and carries on', async () => {
    const before = (await view()).drift;
    const plan = provider.plan;
    provider.plan = async () => {
      throw new Error('the platform is down');
    };
    const { value } = await cron();
    provider.plan = plan;
    expect(value[0]).toMatchObject({
      count: before.count,
      resources: before.resources,
      error: /couldn’t compare widgets’s drift-staging: the platform is down/u,
    });
  });

  it('compares now for the owner from the board, never for the bearer token or an agent', async () => {
    const refused = await body(await api(`infra/drift/${staging.id}`, { method: 'POST', body: {} }));
    expect(refused.status).toBe(403);
    const agent = await body(await board(`infra/drift/${staging.id}`, { method: 'POST', body: { by: 'claude-x' } }));
    expect(agent.status).toBe(403);
    const now = await body(await board('infra/drift/drift-staging', { method: 'POST', body: {} }));
    expect(now).toMatchObject({
      status: 200,
      drift: { environment: { name: 'drift-staging' }, count: 2, error: null },
    });
    const list = await body(await api('infra/drift?repo=widgets'));
    expect(list.drift.map((d) => d.environment.name)).toContain('drift-staging');
  });

  it('shows no drift once what runs matches again', async () => {
    provider.state.resources.find((r) => r.id === 'db-main').attrs.size = 'small';
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 2;
    await cron();
    expect(await view()).toMatchObject({ driftCount: 0, drift: { resources: [], plan: null } });
  });

  it('never compares an observe-only environment, and forgets one that becomes it', async () => {
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: true } });
    const res = await inStore((s) => s.checkInfraDrift(staging.id));
    expect(res).toMatchObject({ ok: false, status: 409, error: /observe only/u });
    await cron();
    expect(await view()).toMatchObject({ driftCount: null, drift: null });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: false } });
  });
});
