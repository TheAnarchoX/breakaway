import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import {
  DEFAULT_CURRENCY,
  checkCurrency,
  convert,
  costChangeInCurrency,
  costInCurrency,
  RATE_SOURCE,
  rateOf,
  rateSourceUrl,
  rateWords,
  readFetchedRate,
} from '../src/infra-currency.js';
import { DEFAULT_POLICY, evaluatePolicy } from '../src/infra-policy.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakecurrency';
const EUR = { currency: 'EUR', rate: 1.2, setAt: '2026-10-03T09:00:00.000Z' };
const NOW = new Date('2026-10-06T12:00:00.000Z');

const costOf = (over = {}) => ({
  currency: 'USD',
  now: 6.5,
  delta: 5,
  after: 11.5,
  complete: true,
  unknown: [],
  changes: [{ resource: 'svc-api', before: 5, after: 10 }],
  perMonth: true,
  estimate: true,
  ...over,
});

describe('costs in your currency, the pure part (BRK-226)', () => {
  it('takes any currency code with a rate, and US dollars without one', () => {
    expect(checkCurrency({ currency: ' eur ', rate: '0,92' })).toEqual({
      ok: true,
      setting: { currency: 'EUR', rate: 0.92 },
    });
    expect(checkCurrency({ currency: 'JPY', rate: 149.5 })).toMatchObject({ ok: true });
    expect(checkCurrency({ currency: 'USD' })).toEqual({ ok: true, setting: { currency: 'USD', rate: 1 } });
    expect(checkCurrency({ currency: 'USD', rate: 0.9 })).toMatchObject({ ok: false, error: /need no rate/u });
    expect(checkCurrency({ currency: 'EUR' })).toMatchObject({ ok: false, error: /how much EUR one US dollar buys/u });
    for (const rate of [0, -1, 'abc', Number.POSITIVE_INFINITY, 2_000_000])
      expect(checkCurrency({ currency: 'EUR', rate })).toMatchObject({ ok: false });
    for (const currency of ['euro', 'E1', '', null, 'ZZZ'])
      expect(checkCurrency({ currency, rate: 1 })).toMatchObject({ ok: false, error: /three-letter code/u });
  });

  it('converts US dollars at the rate, leaves the same currency alone, and won’t guess across others', () => {
    expect(convert(4.6, 'USD', EUR)).toBe(5.52);
    expect(convert(4.6, 'EUR', EUR)).toBe(4.6);
    expect(convert(4.6, 'GBP', EUR)).toBeNull();
    expect(convert(null, 'USD', EUR)).toBeNull();
    expect(convert(4.6, 'USD', DEFAULT_CURRENCY)).toBe(4.6);
    expect(rateOf(DEFAULT_CURRENCY)).toBeNull();
  });

  it('shows a resource’s cost in your currency, with the provider’s amount and the rate beside it', () => {
    const cost = { amount: 4.6, currency: 'USD', perMonth: true, estimate: true, note: 'before included usage' };
    expect(costInCurrency(cost, EUR)).toEqual({
      ...cost,
      amount: 5.52,
      currency: 'EUR',
      rate: { from: 'USD', to: 'EUR', rate: 1.2, setAt: EUR.setAt, amount: 4.6 },
    });
    // In US dollars nothing changes, and nothing has no cost.
    expect(costInCurrency(cost, DEFAULT_CURRENCY)).toBe(cost);
    expect(costInCurrency(null, EUR)).toBeNull();
  });

  it('converts a plan’s cost change, and leaves what it can’t convert unknown', () => {
    const converted = costChangeInCurrency(costOf(), EUR);
    expect(converted).toMatchObject({
      currency: 'EUR',
      now: 7.8,
      delta: 6,
      after: 13.8,
      complete: true,
      changes: [{ resource: 'svc-api', before: 6, after: 12 }],
      rate: { from: 'USD', to: 'EUR', rate: 1.2, setAt: EUR.setAt },
    });
    expect(costChangeInCurrency(costOf(), DEFAULT_CURRENCY)).toEqual({ ...costOf(), rate: null });
    expect(costChangeInCurrency(costOf({ currency: 'GBP' }), EUR)).toMatchObject({
      currency: 'EUR',
      delta: null,
      complete: false,
      unknown: ['svc-api'],
      rate: null,
    });
    expect(costChangeInCurrency(null, EUR)).toBeNull();
  });

  it('writes the rate the way the brand does', () => {
    expect(rateWords(rateOf(EUR), NOW)).toBe('at 1 USD = 1.2 EUR, set 3 Oct');
    expect(rateWords({ ...rateOf(EUR), setAt: '2025-12-31T00:00:00.000Z' }, NOW)).toBe(
      'at 1 USD = 1.2 EUR, set 31 Dec 2025',
    );
    expect(rateWords(null)).toBe('');
  });

  it('reads the cost limit and the budget in your currency, with the rate on the plan', () => {
    const staging = { name: 'staging', frozen: false, gates: false };
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
      ],
      reversible: true,
    };
    // $5 is inside the $5 limit; at 1.2 it's €6, over the €5 limit.
    const dollars = evaluatePolicy(DEFAULT_POLICY, { environment: staging, diff, cost: costOf() });
    expect(dollars.rules.find((r) => r.rule === 'cost')).toMatchObject({ applies: false });
    const euros = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff,
      cost: costChangeInCurrency(costOf(), EUR),
    });
    expect(euros.reasons[0]).toMatch(/^Adds €6 a month, over your €5 limit\. At 1 USD = 1\.2 EUR, set 3 Oct/u);
    expect(euros.limits).toMatchObject({ costLimit: 5, budget: 20, currency: 'EUR', rate: { to: 'EUR' } });
    expect(euros.rules.find((r) => r.rule === 'budget').reason).toBe(
      'Keeps staging at €13.80 a month, inside its €20 budget.',
    );
    // A plan with no cost change still names the board's currency for its limits.
    const nothing = evaluatePolicy(DEFAULT_POLICY, {
      environment: staging,
      diff: { ...diff, changes: [] },
      cost: null,
      currency: 'EUR',
    });
    expect(nothing.limits).toMatchObject({ currency: 'EUR', rate: null });
  });
});

describe('costs in your currency on the board (BRK-226)', () => {
  let staging;
  let provider;
  beforeAll(async () => {
    const made = await body(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'money-staging', kind: 'staging', target: 'svc-api' },
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
  afterAll(() => boardApi('infra/currency', { method: 'PUT', body: { currency: 'USD' } }));

  const inventoryCost = async (rid) =>
    (await body(await api(`infra/inventory?environment=${staging.id}`))).resources.find((r) => r.id === rid).cost;
  const stored = () =>
    runInDurableObject(store(), (instance) =>
      instance.sql
        .exec('SELECT rid, cost, currency FROM infra_inventory WHERE environment = ? ORDER BY rid', staging.id)
        .toArray(),
    );
  /** A plan that scales the service from 2 to 4 instances: $5 a month more, at the fake platform's prices. */
  const plan = async () => {
    await runInDurableObject(store(), (instance) => {
      const desired = {
        version: 1,
        provider: PROVIDER,
        resources: provider.state.resources.map((r) =>
          r.id === 'svc-api'
            ? { ...structuredClone(r), attrs: { instances: 4, version: '1.0.0' } }
            : structuredClone(r),
        ),
      };
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'money-staging.json', 'money-staging', ?, 'abc123', ?, ?, 'abc123', ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired`,
        PROVIDER,
        Date.now(),
        JSON.stringify(desired),
        Date.now(),
      );
    });
    const res = await body(
      await api('infra/plans', { method: 'POST', body: { environment: staging.id, source: 'drift' } }),
    );
    expect(res.status).toBe(201);
    return res.plan;
  };

  it('starts in US dollars, with no rate', async () => {
    expect(await body(await api('infra/currency'))).toMatchObject({
      status: 200,
      currency: { currency: 'USD', rate: 1, from: 'USD', setAt: null },
    });
    expect(await inventoryCost('svc-api')).toMatchObject({ amount: 5, currency: 'USD' });
    expect((await inventoryCost('svc-api')).rate).toBeUndefined();
  });

  it('lets only the owner set it, from the signed-in board', async () => {
    const token = await body(await api('infra/currency', { method: 'PUT', body: { currency: 'EUR', rate: 1.2 } }));
    expect(token).toMatchObject({ status: 403, error: /only the signed-in web board/u });
    const agent = await body(
      await boardApi('infra/currency', { method: 'PUT', body: { currency: 'EUR', rate: 1.2, by: 'claude-x' } }),
    );
    expect(agent).toMatchObject({ status: 403, error: /only the owner sets/u });
    const wrong = await body(await boardApi('infra/currency', { method: 'PUT', body: { currency: 'EUR' } }));
    expect(wrong).toMatchObject({ status: 400, error: /the rate is how much EUR one US dollar buys/u });
    expect((await body(await api('infra/currency'))).currency.currency).toBe('USD');
  });

  it('shows costs, a plan’s cost change, and its limits in euros with the rate, and keeps estimates in dollars', async () => {
    const before = await stored();
    const set = await body(await boardApi('infra/currency', { method: 'PUT', body: { currency: 'eur', rate: '1.2' } }));
    expect(set).toMatchObject({ status: 200, currency: { currency: 'EUR', rate: 1.2, from: 'USD' } });
    expect(Date.parse(set.currency.setAt)).toBeGreaterThan(Date.now() - 60_000);

    expect(await inventoryCost('svc-api')).toMatchObject({
      amount: 6,
      currency: 'EUR',
      estimate: true,
      rate: { from: 'USD', to: 'EUR', rate: 1.2, setAt: set.currency.setAt, amount: 5 },
    });

    const made = await plan();
    expect(made.cost).toMatchObject({
      currency: 'EUR',
      now: 7.8,
      delta: 6,
      after: 13.8,
      rate: { from: 'USD', to: 'EUR', rate: 1.2, setAt: set.currency.setAt },
    });
    expect(made.policy.limits).toMatchObject({ costLimit: 5, budget: 20, currency: 'EUR' });
    expect(made.policy.reasons).toContainEqual(
      expect.stringMatching(/^Adds €6 a month, over your €5 limit\. At 1 USD = 1\.2 EUR, set /u),
    );
    expect(made.policy.reasons).not.toContainEqual(expect.stringMatching(/budget/u));
    expect((await body(await api('infra/policy?repo=widgets'))).policies[0].currency).toMatchObject({
      currency: 'EUR',
      rate: 1.2,
    });

    // Back to US dollars: nothing stored changed, and costs read as the provider gave them.
    const back = await body(await boardApi('infra/currency', { method: 'PUT', body: { currency: 'USD' } }));
    expect(back.currency).toMatchObject({ currency: 'USD', rate: 1, setAt: null });
    expect(await stored()).toEqual(before);
    expect(await inventoryCost('svc-api')).toMatchObject({ amount: 5, currency: 'USD' });
    // The plan keeps the cost it was checked with.
    expect((await body(await api(`infra/plans/${made.id}`))).plan.cost).toMatchObject({ currency: 'EUR', delta: 6 });
  });
});

describe('Fetch today’s rate, on the owner’s press only (BRK-239)', () => {
  /** @type {string[]} */
  let calls = [];
  /** What the mocked source answers, by currency. */
  let answer = (/** @type {string} */ currency) =>
    Response.json({ amount: 1, base: 'USD', date: '2026-10-05', rates: { [currency]: 0.8571 } });
  beforeAll(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.startsWith('https://api.frankfurter.dev/')) return answer(new URL(url).searchParams.get('symbols') ?? '');
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterEach(() => {
    calls = [];
  });
  afterAll(() => vi.restoreAllMocks());
  const rateCalls = () => calls.filter((u) => u.includes('frankfurter'));

  it('names its source, asks for only the pair, and reads only a usable rate', () => {
    expect(RATE_SOURCE).toMatchObject({ name: 'Frankfurter', site: 'https://frankfurter.dev' });
    expect(rateSourceUrl('EUR')).toBe('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
    expect(readFetchedRate({ base: 'USD', date: '2026-10-05', rates: { EUR: 0.8571 } }, 'EUR')).toEqual({
      ok: true,
      rate: {
        currency: 'EUR',
        rate: 0.8571,
        date: '2026-10-05',
        source: 'Frankfurter',
        site: 'https://frankfurter.dev',
      },
    });
    for (const bad of [null, {}, { base: 'EUR', rates: { EUR: 1 } }, { base: 'USD', rates: { GBP: 0.7 } }])
      expect(readFetchedRate(bad, 'EUR')).toMatchObject({ ok: false, error: /Frankfurter has no rate for EUR/u });
    expect(readFetchedRate({ base: 'USD', rates: { EUR: -1 } }, 'EUR')).toMatchObject({ ok: false });
    expect(readFetchedRate({ base: 'USD', date: 'today', rates: { EUR: 0.9 } }, 'EUR')).toMatchObject({
      rate: { date: null },
    });
  });

  it('fills, never saves: the owner’s press returns the rate and the board’s currency stays as it was', async () => {
    const before = (await body(await api('infra/currency'))).currency;
    const res = await body(await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'eur' } }));
    expect(res).toMatchObject({
      status: 200,
      rate: { currency: 'EUR', rate: 0.8571, date: '2026-10-05', source: 'Frankfurter' },
    });
    expect(rateCalls()).toEqual(['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR']);
    expect((await body(await api('infra/currency'))).currency).toEqual(before);
  });

  it('is the owner’s, from the signed-in board, and refuses what needs no rate', async () => {
    const token = await body(await api('infra/currency/rate', { method: 'POST', body: { currency: 'EUR' } }));
    expect(token).toMatchObject({ status: 403, error: /only the signed-in web board can fetch a rate/u });
    const agent = await body(
      await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'EUR', by: 'claude-x' } }),
    );
    expect(agent).toMatchObject({ status: 403, error: /only the owner fetches a rate/u });
    const dollars = await body(await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'USD' } }));
    expect(dollars).toMatchObject({ status: 400, error: /US dollars need no rate/u });
    const nonsense = await body(await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'zz1' } }));
    expect(nonsense).toMatchObject({ status: 400, error: /three-letter code/u });
    expect(rateCalls()).toEqual([]);
  });

  it('says what failed when the source has no rate or can’t be reached', async () => {
    answer = () => Response.json({ message: 'not found' }, { status: 404 });
    expect(
      await body(await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'XOF' } })),
    ).toMatchObject({ status: 422, error: 'Frankfurter has no rate for XOF: type yours in the field' });
    answer = () => new Response('down', { status: 503 });
    expect(
      await body(await boardApi('infra/currency/rate', { method: 'POST', body: { currency: 'EUR' } })),
    ).toMatchObject({ status: 502, error: /couldn’t reach Frankfurter: try again, or type the rate yourself/u });
  });

  it('fetches nothing any other way: reading, saving, and the cron leave the source alone', async () => {
    await api('infra/currency');
    await boardApi('infra/currency', { method: 'PUT', body: { currency: 'EUR', rate: 0.9 } });
    await boardApi('infra/currency', { method: 'PUT', body: { currency: 'USD' } });
    await runInDurableObject(store(), (instance) => instance.tick('cron').catch(() => {}));
    expect(rateCalls()).toEqual([]);
  });
});
