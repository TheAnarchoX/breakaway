import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { budgetCrossed, budgetSignal, budgetState, monthOf, sumCosts } from '../src/infra-costs.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const USD = { currency: 'USD', rate: 1, setAt: null };
const EUR = { currency: 'EUR', rate: 0.5, setAt: '2026-10-01T00:00:00.000Z' };

/** A fake platform under its own provider ID: svc-api costs 5, db-main 1.5, and route-api nothing. */
function platform(id) {
  const provider = fakeProvider({ id });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { provider, registry };
}

const addEnvironment = async (fields) =>
  (await body(await boardApi('infra/environments', { method: 'POST', body: { repo: 'widgets', ...fields } })))
    .environment;

const refresh = (id, registry) =>
  runInDurableObject(store(), (instance) => instance.refreshInventory(id, { registry }));

const costs = async (query = {}) => body(await api(`infra/costs?${new URLSearchParams(query)}`));
/** The budget's signals: the fake provider's own cost events are info, and a budget's never are. */
const costSignals = async (environment) =>
  (await body(await api(`infra/signals?${new URLSearchParams({ kind: 'cost', environment })}`))).signals.filter(
    (s) => s.level !== 'info',
  );

describe('adding up costs (BRK-199)', () => {
  const rows = [
    { environmentId: 1, environment: 'production', repo: 'acme/widgets', task: null, amount: 10, currency: 'USD' },
    { environmentId: 1, environment: 'production', repo: 'acme/widgets', task: null, amount: 2.5, currency: 'USD' },
    { environmentId: 2, environment: 'preview-1', repo: 'acme/widgets', task: 'u-1', amount: 4, currency: 'USD' },
    { environmentId: 2, environment: 'preview-1', repo: 'acme/widgets', task: 'u-1', amount: null, currency: null },
    { environmentId: 3, environment: 'staging', repo: 'acme/gadgets', task: null, amount: 1, currency: 'GBP' },
  ];

  it('sums by environment, repository, and owning task, counting what has no estimate as unknown', () => {
    const { environments, repositories, tasks } = sumCosts(rows, USD);
    expect(environments.get(1)).toEqual({ amount: 12.5, currency: 'USD', resources: 2, unknown: 0, estimate: true });
    expect(environments.get(2)).toMatchObject({ amount: 4, resources: 2, unknown: 1 });
    // A currency no rate covers can't be added in: it's unknown, never mixed in.
    expect(environments.get(3)).toMatchObject({ amount: 0, resources: 1, unknown: 1 });
    expect(repositories.get('acme/widgets')).toMatchObject({ amount: 16.5, resources: 4, unknown: 1 });
    expect(repositories.get('acme/gadgets')).toMatchObject({ amount: 0, unknown: 1 });
    expect([...tasks.keys()]).toEqual(['u-1']);
    expect(tasks.get('u-1')).toMatchObject({ amount: 4, resources: 2, unknown: 1 });
  });

  it('converts into the board’s currency at its rate', () => {
    const { environments, repositories } = sumCosts(rows, EUR);
    expect(environments.get(1)).toMatchObject({ amount: 6.25, currency: 'EUR' });
    expect(repositories.get('acme/widgets')).toMatchObject({ amount: 8.25, currency: 'EUR' });
  });

  it('says where a total stands against its budget, and an unknown total is never inside', () => {
    expect(budgetState({ amount: 10, unknown: 0 }, 20)).toBe('inside');
    expect(budgetState({ amount: 16, unknown: 0 }, 20)).toBe('near');
    expect(budgetState({ amount: 20, unknown: 0 }, 20)).toBe('near');
    expect(budgetState({ amount: 20.01, unknown: 0 }, 20)).toBe('over');
    expect(budgetState({ amount: 10, unknown: 1 }, 20)).toBe('unknown');
    expect(budgetState({ amount: 25, unknown: 1 }, 20)).toBe('over');
  });

  it('signals only going further than the month has been', () => {
    expect(budgetCrossed(null, 'inside')).toBe(false);
    expect(budgetCrossed(null, 'unknown')).toBe(false);
    expect(budgetCrossed(null, 'near')).toBe(true);
    expect(budgetCrossed(null, 'over')).toBe(true);
    expect(budgetCrossed('near', 'near')).toBe(false);
    expect(budgetCrossed('near', 'over')).toBe(true);
    expect(budgetCrossed('over', 'over')).toBe(false);
    expect(budgetCrossed('over', 'near')).toBe(false);
  });

  it('writes the signal as a budget, never as an outage', () => {
    const where = { source: 'fake', environment: 'production', environmentId: 1 };
    const total = { amount: 31.5, currency: 'EUR', resources: 3, unknown: 0, estimate: /** @type {true} */ (true) };
    const at = Date.parse('2026-10-06T12:00:00Z');
    expect(budgetSignal(where, 'over', total, 20, at)).toEqual({
      ...where,
      resource: null,
      kind: 'cost',
      level: 'critical',
      value: 31.5,
      at: '2026-10-06T12:00:00.000Z',
      text: 'production is over its €20 budget: an estimated €31.50 a month.',
    });
    const near = budgetSignal(where, 'near', { ...total, amount: 17, unknown: 1 }, 20, at);
    expect(near).toMatchObject({ level: 'warning', value: 17 });
    expect(near.text).toBe(
      'production is near its €20 budget: an estimated €17 a month, or more: some resources have no estimate.',
    );
    expect(monthOf(at)).toBe('2026-10');
  });
});

describe('cost on the board (BRK-199)', () => {
  afterAll(() => boardApi('infra/currency', { method: 'PUT', body: { currency: 'USD' } }));

  it('adds up by environment, repository, and the task that owns a short-lived environment', async () => {
    const { registry } = platform('fake-cost');
    const staging = await addEnvironment({
      name: 'cost-staging',
      kind: 'staging',
      provider: 'fake-cost',
      target: 'api',
    });
    const task = await body(
      await api('tasks', { method: 'POST', body: [{ description: 'Try a preview', project: 'ops', horizon: 'now' }] }),
    );
    const { wid, uuid } = task.tasks[0];
    const preview = await addEnvironment({
      name: 'cost-preview',
      kind: 'short-lived',
      provider: 'fake-cost',
      target: 'api',
      task: wid,
    });
    await addEnvironment({ name: 'cost-untargeted', kind: 'staging', provider: 'fake-cost' });
    await refresh('fake-cost', registry);

    const out = await costs({ repo: 'widgets' });
    expect(out.status).toBe(200);
    expect(out.currency).toMatchObject({ currency: 'USD' });
    const of = (id) => out.environments.find((e) => e.environmentId === id);
    expect(of(staging.id)).toMatchObject({
      environment: 'cost-staging',
      repo: 'widgets',
      kind: 'staging',
      task: null,
      cost: { amount: 6.5, currency: 'USD', resources: 3, unknown: 0, estimate: true },
      budget: { amount: 20, currency: 'USD', policy: 'default', used: 0.33, state: 'inside' },
    });
    expect(of(preview.id)).toMatchObject({ task: { wid, uuid }, cost: { amount: 6.5 } });
    expect(out.environments.find((e) => e.environment === 'cost-untargeted')).toMatchObject({
      cost: { amount: 0, resources: 0 },
    });
    expect(out.repositories).toEqual([
      { repo: 'widgets', cost: { amount: 13, currency: 'USD', resources: 6, unknown: 0, estimate: true } },
    ]);
    expect(out.tasks).toEqual([
      {
        task: { uuid, wid, description: 'Try a preview' },
        repo: 'widgets',
        cost: { amount: 6.5, currency: 'USD', resources: 3, unknown: 0, estimate: true },
      },
    ]);

    // The month is in the series, and the board's currency converts it on read.
    expect(of(staging.id).months).toEqual([
      {
        month: monthOf(Date.now()),
        cost: { amount: 6.5, currency: 'USD', resources: 3, unknown: 0, estimate: true },
        budget: { amount: 20, currency: 'USD', state: 'inside' },
      },
    ]);
    await boardApi('infra/currency', { method: 'PUT', body: { currency: 'EUR', rate: 0.5 } });
    const euros = (await costs({ environment: 'cost-staging', repo: 'widgets' })).environments;
    expect(euros).toHaveLength(1);
    expect(euros[0]).toMatchObject({ cost: { amount: 3.25, currency: 'EUR' }, budget: { currency: 'EUR' } });
    expect(euros[0].months[0].cost).toMatchObject({ amount: 3.25, currency: 'EUR' });
    await boardApi('infra/currency', { method: 'PUT', body: { currency: 'USD' } });
  });

  it('sends one signal as a month goes near its budget, and one more as it goes over', async () => {
    const { provider, registry } = platform('fake-budget');
    const budgeted = await addEnvironment({
      name: 'budget-staging',
      kind: 'staging',
      provider: 'fake-budget',
      target: 'api',
    });
    await refresh('fake-budget', registry);
    expect(await costSignals('budget-staging')).toEqual([]);

    provider.state.costs['svc-api'] = 15; // 16.5 of 20: near
    await refresh('fake-budget', registry);
    await refresh('fake-budget', registry);
    const near = await costSignals('budget-staging');
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({
      source: 'fake-budget',
      environmentId: budgeted.id,
      resource: null,
      kind: 'cost',
      level: 'warning',
      value: 16.5,
      text: 'budget-staging is near its $20 budget: an estimated $16.50 a month.',
    });

    provider.state.costs['svc-api'] = 30; // 31.5 of 20: over
    await refresh('fake-budget', registry);
    await refresh('fake-budget', registry);
    const over = await costSignals('budget-staging');
    expect(over).toHaveLength(2);
    expect(over[0]).toMatchObject({
      level: 'critical',
      value: 31.5,
      text: expect.stringMatching(/over its \$20 budget/),
    });

    // Back inside and over again in the same month: the month already said so.
    provider.state.costs['svc-api'] = 1;
    await refresh('fake-budget', registry);
    provider.state.costs['svc-api'] = 40;
    await refresh('fake-budget', registry);
    expect(await costSignals('budget-staging')).toHaveLength(2);
    const view = (await costs({ environment: 'budget-staging', repo: 'widgets' })).environments[0];
    expect(view.budget).toMatchObject({ state: 'over', amount: 20 });
    expect(view.months[0].budget).toMatchObject({ state: 'over' });
  });

  it('reads each environment’s budget from its repository’s policy, and a new month starts again', async () => {
    const { provider, registry } = platform('fake-policy-budget');
    provider.state.costs['svc-api'] = 30;
    const prod = await addEnvironment({
      name: 'budget-production',
      kind: 'production',
      provider: 'fake-policy-budget',
      target: 'api',
    });
    const policy = JSON.stringify({
      version: 1,
      costLimit: 5,
      budget: 20,
      environments: { 'budget-production': { budget: 200 } },
    });
    await runInDurableObject(store(), (instance) => {
      instance.sql.exec(
        `INSERT INTO infra_policy (repo, sha, read_at, policy, valid_sha, valid_at) VALUES ('widgets', 'p1', ?, ?, 'p1', ?)
         ON CONFLICT (repo) DO UPDATE SET policy = excluded.policy`,
        Date.now(),
        policy,
        Date.now(),
      );
    });
    await refresh('fake-policy-budget', registry);
    const view = (await costs({ environment: 'budget-production', repo: 'widgets' })).environments[0];
    expect(view.budget).toMatchObject({ amount: 200, policy: 'repository', state: 'inside' });
    expect(await costSignals('budget-production')).toEqual([]);

    // With the default budget back, a month in the past and one now each say so once.
    await runInDurableObject(store(), (instance) =>
      instance.sql.exec("DELETE FROM infra_policy WHERE repo = 'widgets'"),
    );
    const d = new Date();
    const lastMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 10);
    const sent = await runInDurableObject(store(), async (instance) => {
      const last = await instance.recordInfraCosts([prod.id], lastMonth);
      const again = await instance.recordInfraCosts([prod.id], lastMonth + 86_400_000);
      const now = await instance.recordInfraCosts([prod.id]);
      return [last.length, again.length, now.length];
    });
    expect(sent).toEqual([1, 0, 1]);
    const months = (await costs({ environment: 'budget-production', repo: 'widgets' })).environments[0].months;
    expect(months.map((m) => m.month)).toEqual([monthOf(Date.now()), monthOf(lastMonth)]);
  });

  it('keeps no month for a removed environment', async () => {
    const { registry } = platform('fake-cost-removed');
    const gone = await addEnvironment({
      name: 'cost-gone',
      kind: 'staging',
      provider: 'fake-cost-removed',
      target: 'api',
    });
    await refresh('fake-cost-removed', registry);
    expect((await boardApi(`infra/environments/${gone.id}`, { method: 'DELETE' })).status).toBe(200);
    const left = await runInDurableObject(store(), async (instance) => {
      await instance.recordInfraCosts([]);
      return instance.sql.exec('SELECT COUNT(*) AS n FROM infra_costs WHERE environment = ?', gone.id).one().n;
    });
    expect(left).toBe(0);
    expect((await costs({ repo: 'widgets' })).environments.some((e) => e.environment === 'cost-gone')).toBe(false);
  });
});
