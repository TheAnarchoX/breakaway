import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COST_DATASETS, analyticsQuery, datasetQuery, readDataset } from '../src/infra-cloudflare-analytics.js';
import {
  COST_NOTE,
  NEVER_CALLED,
  PRICES,
  checkToken,
  cloudflare,
  cost,
  discover,
  priceResource,
  rid,
} from '../src/infra-cloudflare.js';
import { checkCosts, checkDiscovery, checkProvider } from '../src/infra-provider.js';
import { providers } from '../src/infra-providers.js';
import { scopeDiscovery } from '../src/infra-inventory.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, boardApi } from './helpers.js';
import { providerContract } from './infra-provider-contract.js';
import {
  ACCOUNT,
  CONTAINER,
  D1_ID,
  DO_COUNTER,
  DO_ROOMS,
  KV_CACHE,
  KV_SESSIONS,
  NEVER_KEPT,
  QUEUE_JOBS,
  cloudflareAnswers,
  cloudflareApi,
  cloudflareUsage,
  cloudflareUsageRows,
} from './cloudflare-fixture.js';

const TOKEN = 'cf-read-token-for-tests-only';

/** A context for `acme-api`'s environment, calling the made-up account. */
function context(answers = cloudflareAnswers(), extra = {}) {
  const fetch = cloudflareApi(answers);
  return { fetch, ctx: { environment: 'production', scope: { target: 'acme-api' }, token: TOKEN, fetch, ...extra } };
}

providerContract(
  'cloudflare',
  () => {
    const { ctx } = context();
    return {
      provider: cloudflare,
      ctx,
      desired: { resources: [{ id: 'worker:acme-new', kind: 'worker', name: 'acme-new' }] },
      since: '2026-10-01T00:00:00Z',
    };
  },
  { notYet: { plan: 'BRK-192', apply: 'BRK-192', observe: 'BRK-191', events: 'BRK-191' } },
);

describe('the Cloudflare provider’s discover (BRK-189)', () => {
  const W = (name) => rid('worker', name);

  it('maps each kind to inventory resources, with their relations, from the target outward', async () => {
    const { ctx } = context();
    const found = checkDiscovery(cloudflare, await discover(ctx));
    expect(found.missing).toEqual([]);
    expect(Object.fromEntries(found.resources.map((r) => [r.id, `${r.kind} ${r.name}`]))).toEqual({
      [W('acme-api')]: 'worker acme-api',
      [W('acme-auth')]: 'worker acme-auth',
      [W('acme-rooms')]: 'worker acme-rooms',
      [`d1:${D1_ID}`]: 'd1 acme-db',
      [`kv:${KV_CACHE}`]: 'kv acme-cache',
      [`kv:${KV_SESSIONS}`]: 'kv acme-sessions',
      'r2:acme-files': 'r2 acme-files',
      [`queue:${QUEUE_JOBS}`]: 'queue acme-jobs',
      [`durable-object:${DO_ROOMS}`]: 'durable-object acme-rooms_Room',
      [`durable-object:${DO_COUNTER}`]: 'durable-object acme-api_Counter',
      [`container:${CONTAINER}`]: 'container acme-rooms-sandbox',
      'route:0000000000000000000000000000d101': 'route api.acme.example/*',
      'custom-domain:0000000000000000000000000000d201': 'custom-domain app.acme.example',
    });
    const rel = found.relations.map((r) => `${r.from} ${r.kind} ${r.to}`).sort();
    expect(rel).toEqual(
      [
        `${W('acme-api')} calls ${W('acme-auth')}`,
        `${W('acme-api')} uses d1:${D1_ID}`,
        `${W('acme-api')} uses kv:${KV_CACHE}`,
        `${W('acme-auth')} uses kv:${KV_SESSIONS}`,
        `${W('acme-api')} uses r2:acme-files`,
        `${W('acme-api')} produces queue:${QUEUE_JOBS}`,
        `${W('acme-api')} consumes queue:${QUEUE_JOBS}`,
        `${W('acme-api')} uses durable-object:${DO_ROOMS}`,
        `${W('acme-rooms')} uses durable-object:${DO_ROOMS}`,
        `durable-object:${DO_ROOMS} runs-in ${W('acme-rooms')}`,
        `${W('acme-api')} uses durable-object:${DO_COUNTER}`,
        `durable-object:${DO_COUNTER} runs-in ${W('acme-api')}`,
        `durable-object:${DO_ROOMS} runs container:${CONTAINER}`,
        `${W('acme-api')} serves route:0000000000000000000000000000d101`,
        `${W('acme-api')} serves custom-domain:0000000000000000000000000000d201`,
      ].sort(),
    );
    // Everything is reachable from the target, so the inventory's own scope keeps all of it.
    expect(scopeDiscovery(found, 'acme-api').resources).toHaveLength(found.resources.length);
  });

  it('keeps a Worker’s settings and secrets by name, and the settings of the rest', async () => {
    const { ctx } = context();
    const byId = new Map((await discover(ctx)).resources.map((r) => [r.id, r]));
    expect(byId.get(W('acme-api')).attrs).toEqual({
      handlers: ['fetch', 'queue', 'scheduled'],
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      usageModel: 'standard',
      observability: true,
      placement: null,
      bindings: [
        { name: 'API_KEY', type: 'secret_text' },
        { name: 'AUTH', type: 'service' },
        { name: 'CACHE', type: 'kv_namespace' },
        { name: 'CONFIG', type: 'json' },
        { name: 'COUNTER', type: 'durable_object_namespace' },
        { name: 'DB', type: 'd1' },
        { name: 'FILES', type: 'r2_bucket' },
        { name: 'GREETING', type: 'plain_text' },
        { name: 'JOBS', type: 'queue' },
        { name: 'ROOMS', type: 'durable_object_namespace' },
      ],
      secrets: ['API_KEY', 'SIGNING_SECRET'],
      crons: ['*/5 * * * *'],
      versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
      deployed: '2026-10-01T09:00:00Z',
    });
    expect(byId.get(`d1:${D1_ID}`).attrs).toEqual({
      tables: 12,
      size: 4096,
      readReplication: 'disabled',
      version: 'production',
    });
    expect(byId.get('r2:acme-files').attrs).toMatchObject({
      location: 'WEUR',
      cors: [],
      lifecycle: [{ id: 'expire-tmp' }],
      domains: ['files.acme.example'],
    });
    expect(byId.get(`queue:${QUEUE_JOBS}`).attrs.consumers).toEqual([
      {
        worker: 'acme-api',
        batchSize: 10,
        maxRetries: 3,
        maxWait: 5000,
        maxConcurrency: 4,
        deadLetter: 'acme-jobs-dlq',
      },
    ]);
    expect(byId.get(`container:${CONTAINER}`).attrs).toEqual({
      schedulingPolicy: 'default',
      instanceType: 'basic',
      instances: 2,
      maxInstances: 5,
      active: 2,
      assigned: 2,
    });
  });

  it('never reads a value, an object, or code, never calls outside the scope, and keeps no person’s details', async () => {
    const { ctx, fetch } = context();
    const out = JSON.stringify(await discover(ctx));
    for (const value of NEVER_KEPT) expect(out).not.toContain(value);
    expect(out).not.toContain('acme-other');
    expect(out).not.toContain('registry.example');
    for (const call of fetch.calls) {
      expect(call.method).toBe('GET');
      expect(call.auth).toBe(`Bearer ${TOKEN}`);
      for (const re of NEVER_CALLED) expect(call.path).not.toMatch(re);
      expect(call.path).not.toMatch(/acme-other|\/values|\/objects|\/content/u);
    }
  });

  it('refuses the paths that read data, whatever asks for them', () => {
    const a = `/accounts/${ACCOUNT}`;
    for (const path of [
      `${a}/storage/kv/namespaces/${KV_CACHE}/values/some-key`,
      `${a}/storage/kv/namespaces/${KV_CACHE}/keys`,
      `${a}/r2/buckets/acme-files/objects/file.txt`,
      `${a}/workers/scripts/acme-api/content`,
      `${a}/workers/scripts/acme-api`,
      `${a}/workers/workers/acme-api/versions/ver-1?include=modules`,
      `${a}/workers/scripts/acme-api/secrets/API_KEY`,
    ])
      expect(NEVER_CALLED.some((re) => re.test(path))).toBe(true);
    for (const path of Object.keys(cloudflareAnswers()))
      expect(NEVER_CALLED.some((re) => re.test(path.split('?')[0]))).toBe(false);
  });

  it('stops at a 429 instead of retrying, and makes no more calls', async () => {
    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/workers/scripts/acme-auth/settings`] = 429;
    const { ctx, fetch } = context(answers);
    await expect(discover(ctx)).rejects.toThrow(/rate limit was reached, so discovery stopped/u);
    expect(fetch.calls.at(-1).path).toBe(`/accounts/${ACCOUNT}/workers/scripts/acme-auth/settings`);
    expect(fetch.calls.filter((c) => c.path.endsWith('/acme-auth/settings'))).toHaveLength(1);
  });

  it('skips queues or containers the token can’t read, naming the permission, and fails on anything else', async () => {
    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/queues?page=1&per_page=100`] = 403;
    answers[`/accounts/${ACCOUNT}/containers/applications`] = 403;
    let found = checkDiscovery(cloudflare, await discover(context(answers).ctx));
    expect(found.missing).toEqual(['Queues Read', 'Containers Read']);
    expect(found.resources.some((r) => r.kind === 'queue' || r.kind === 'container')).toBe(false);
    expect(found.resources.some((r) => r.kind === 'd1')).toBe(true);

    answers[`/accounts/${ACCOUNT}/d1/database/${D1_ID}`] = 403;
    const failed = await discover(context(answers).ctx).catch((e) => e);
    expect(failed.message).toMatch(/the token needs D1 Read/u);
    expect(failed.permission).toBe('D1 Read');

    found = await discover(context(cloudflareAnswers()).ctx);
    expect(found.missing).toEqual([]);
  });

  it('finds the account from the token, or takes it from the scope, and refuses a token that reaches several', async () => {
    const named = context(cloudflareAnswers(), { scope: { target: 'acme-api', account: ACCOUNT } });
    await discover(named.ctx);
    expect(named.fetch.calls.some((c) => c.path.startsWith('/accounts?'))).toBe(false);

    const answers = cloudflareAnswers();
    answers['/accounts?page=1&per_page=50'] = {
      success: true,
      result: [{ id: ACCOUNT }, { id: '0000000000000000000000000000a002' }],
      result_info: { page: 1, total_pages: 1 },
    };
    await expect(discover(context(answers).ctx)).rejects.toThrow(/reaches 2 Cloudflare accounts/u);
  });

  it('finds nothing without a target, or when the target isn’t on the account', async () => {
    const none = context(cloudflareAnswers(), { scope: {} });
    expect(await discover(none.ctx)).toEqual({ resources: [], relations: [], missing: [] });
    expect(none.fetch.calls).toEqual([]);
    const gone = context(cloudflareAnswers(), { scope: { target: 'acme-gone' } });
    expect((await discover(gone.ctx)).resources).toEqual([]);
    expect(gone.fetch.calls.map((c) => c.path)).toEqual([
      '/accounts?page=1&per_page=50',
      `/accounts/${ACCOUNT}/workers/scripts`,
    ]);
  });

  it('asks for a token before it calls anything', async () => {
    const { ctx, fetch } = context();
    await expect(discover({ ...ctx, token: undefined })).rejects.toThrow(/connect Cloudflare on Connections/u);
    expect(fetch.calls).toEqual([]);
  });

  it('refuses to apply in an observe-only environment before anything else', async () => {
    const { ctx, fetch } = context();
    const none = { provider: 'cloudflare', environment: 'production', changes: [], reversible: true };
    await expect(cloudflare.apply({ ...ctx, observeOnly: true }, none)).rejects.toThrow(/observe only/u);
    expect(fetch.calls).toEqual([]);
  });
});

describe('the Cloudflare provider’s cost (BRK-193)', () => {
  /** The fixture's usage, priced by hand: 7 days scaled to 30, storage at its most, before included usage. */
  const scale = 30 / 7;
  const expected = {
    [rid('worker', 'acme-api')]: (0.7 * 0.3 + 3.5 * 0.02) * scale,
    [rid('worker', 'acme-auth')]: (0.07 * 0.3 + 0.07 * 0.02) * scale,
    [rid('worker', 'acme-rooms')]: 0,
    [`durable-object:${DO_ROOMS}`]: (0.14 * 0.15 + 0.175 * 12.5) * scale + 2 * 0.2,
    [`durable-object:${DO_COUNTER}`]: 0.007 * 0.15 * scale,
    [`d1:${D1_ID}`]: (70 * 0.001 + 0.7 * 1) * scale + 4 * 0.75,
    [`kv:${KV_CACHE}`]: (2.1 * 0.5 + 0.07 * 5) * scale + 1 * 0.5,
    [`kv:${KV_SESSIONS}`]: (0.007 * 0.5 + 0.0007 * 5 + 0.0007 * 5) * scale,
    'r2:acme-files': (0.07 * 4.5 + 0.7 * 0.36) * scale + 100 * 0.015,
    [`queue:${QUEUE_JOBS}`]: 0.21 * 0.4 * scale,
    // 2 basic instances (1 GiB, 4 GB) running all month.
    [`container:${CONTAINER}`]: 2 * (1 * 0.0000025 + 4 * 0.00000007) * 30 * 86_400,
    'route:0000000000000000000000000000d101': 0,
    'custom-domain:0000000000000000000000000000d201': 0,
  };

  it('gives each resource a monthly estimate in US dollars from a recorded week of usage', async () => {
    const { ctx } = context();
    const costs = checkCosts(cloudflare, await cost(ctx));
    expect(costs.map((c) => c.resource).sort()).toEqual(Object.keys(expected).sort());
    for (const c of costs) {
      expect(c.amount, c.resource).toBeCloseTo(expected[c.resource], 3);
      expect(c).toMatchObject({ currency: 'USD', estimate: true });
      expect(c.note.startsWith(COST_NOTE)).toBe(true);
    }
    const by = Object.fromEntries(costs.map((c) => [c.resource, c]));
    expect(by[`container:${CONTAINER}`].note).toMatch(/CPU isn’t counted/u);
    expect(by['route:0000000000000000000000000000d101'].note).toMatch(/part of its Worker’s/u);
    expect(COST_NOTE).toMatch(/across the whole account, not by resource/u);
  });

  it('asks one query per dataset for the whole environment, over the last 7 days, and reads nothing else', async () => {
    const { ctx, fetch } = context();
    const resources = (await discover(ctx)).resources;
    fetch.calls.length = 0;
    await cost({ ...ctx, resources });
    const posts = fetch.calls.filter((c) => c.method === 'POST');
    expect(posts.every((c) => c.path === '/graphql')).toBe(true);
    expect(fetch.calls.every((c) => c.method === 'POST' || c.path.startsWith('/accounts?'))).toBe(true);
    expect(posts).toHaveLength(Object.keys(COST_DATASETS).length);
    for (const { body } of posts) {
      expect(body.query).toMatch(/^query /u);
      expect(body.variables.account).toBe(ACCOUNT);
      const days = (Date.parse(body.variables.to) - Date.parse(body.variables.from)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(7);
      expect(days).toBeLessThan(7.01);
    }
    const workers = posts.find((c) => c.body.query.includes('workersInvocationsAdaptive('));
    expect(workers.body.variables.keys.sort()).toEqual(['acme-api', 'acme-auth', 'acme-rooms']);
    const kv = posts.find((c) => c.body.query.includes('kvOperationsAdaptiveGroups('));
    expect(kv.body.variables.keys.sort()).toEqual([KV_CACHE, KV_SESSIONS].sort());
  });

  it('skips a dataset that has no resources in the environment', async () => {
    const { ctx, fetch } = context();
    await cost({ ...ctx, resources: [{ id: rid('worker', 'acme-api'), kind: 'worker', name: 'acme-api' }] });
    const posts = fetch.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.query).toContain('workersInvocationsAdaptive(');
  });

  it('leaves out a dataset Cloudflare won’t answer, and says so on the resources it prices', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage({ ...cloudflareUsageRows(), durableObjectsStorageGroups: 'unknown field' });
    const { ctx } = context(answers);
    const by = Object.fromEntries((await cost(ctx)).map((c) => [c.resource, c]));
    const rooms = by[`durable-object:${DO_ROOMS}`];
    expect(rooms.amount).toBeCloseTo(expected[`durable-object:${DO_ROOMS}`] - 2 * 0.2, 3);
    expect(rooms.note).toMatch(/Not counted, since Cloudflare’s analytics didn’t return it: stored data\./u);
    expect(by[`d1:${D1_ID}`].note).not.toMatch(/Not counted/u);
  });

  it('stops on a 429 or a token without Account Analytics Read, so the store keeps the last estimate', async () => {
    for (const status of [429, 403]) {
      const answers = cloudflareAnswers();
      answers['/graphql'] = status;
      const { ctx } = context(answers);
      const error = await cost(ctx).catch((e) => e);
      expect(error.status).toBe(status);
      if (status === 403) expect(error.permission).toBe('Account Analytics Read');
    }
  });

  it('prices Infrequent Access, a jurisdiction’s bucket name, and a custom container size', async () => {
    const { ctx, fetch } = context();
    const resources = [
      {
        id: 'r2:acme-cold',
        kind: 'r2',
        name: 'acme-cold',
        attrs: { storageClass: 'InfrequentAccess', jurisdiction: 'eu' },
      },
      {
        id: 'container:c2',
        kind: 'container',
        name: 'acme-big',
        attrs: { instanceType: { vcpu: 1, memory_mib: 3072, disk_mb: 10_000 }, active: 1 },
      },
      { id: 'container:c3', kind: 'container', name: 'acme-odd', attrs: { instanceType: 'mystery', active: 1 } },
    ];
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage({
      ...cloudflareUsageRows(),
      r2OperationsAdaptiveGroups: [
        { sum: { requests: 70_000 }, dimensions: { bucketName: 'eu_acme-cold', actionType: 'PutObject' } },
        { sum: { requests: 70_000 }, dimensions: { bucketName: 'eu_acme-cold', actionType: 'HeadObject' } },
      ],
      r2StorageAdaptiveGroups: [
        { max: { payloadSize: 10_000_000_000, metadataSize: 0 }, dimensions: { bucketName: 'eu_acme-cold' } },
      ],
    });
    const run = context(answers);
    const by = Object.fromEntries((await cost({ ...run.ctx, resources })).map((c) => [c.resource, c]));
    expect(by['r2:acme-cold'].amount).toBeCloseTo((0.07 * 9 + 0.07 * 0.9) * scale + 10 * 0.01, 3);
    expect(by['r2:acme-cold'].note).toMatch(/retrieval isn’t counted/u);
    expect(by['container:c2'].amount).toBeCloseTo((3 * 0.0000025 + 10 * 0.00000007) * 30 * 86_400, 3);
    expect(by['container:c3']).toMatchObject({ amount: 0 });
    expect(by['container:c3'].note).toMatch(/isn’t in the price table/u);
    expect(fetch.calls).toHaveLength(0);
  });

  it('prices one resource from its usage alone, for a plan’s estimate', () => {
    const worker = { id: rid('worker', 'acme-new'), kind: 'worker', name: 'acme-new' };
    expect(priceResource(worker)).toEqual({ amount: 0, notes: [] });
    expect(priceResource(worker, { requests: 1_000_000 }, 1).amount).toBeCloseTo(0.3, 6);
    const box = {
      id: 'container:new',
      kind: 'container',
      name: 'acme-box',
      attrs: { instanceType: 'lite', active: 1 },
    };
    expect(priceResource(box).amount).toBeCloseTo((0.25 * 0.0000025 + 2 * 0.00000007) * 30 * 86_400, 6);
  });

  it('keeps its price table as data, with where and when each price was read', () => {
    expect(PRICES.currency).toBe('USD');
    expect(PRICES.read).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    for (const product of ['worker', 'durableObject', 'd1', 'kv', 'r2', 'queue', 'container'])
      expect(PRICES[product].source).toMatch(/^https:\/\/developers\.cloudflare\.com\//u);
  });

  it('estimates nothing for an environment with nothing in it, and asks for a token first', async () => {
    const { ctx, fetch } = context();
    expect(await cost({ ...ctx, resources: [] })).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
    await expect(cost({ ...ctx, token: undefined })).rejects.toThrow(/no read-only token/u);
  });
});

describe('Cloudflare’s GraphQL analytics (BRK-193, for BRK-191)', () => {
  it('reads one dataset for some resources over a window, summed by resource and split by its action', async () => {
    const { ctx, fetch } = context();
    const from = new Date('2026-09-29T00:00:00Z');
    const to = new Date('2026-10-06T00:00:00Z');
    const usage = await readDataset(ctx, {
      account: ACCOUNT,
      dataset: COST_DATASETS.kvOperations,
      keys: [KV_CACHE, KV_SESSIONS],
      from,
      to,
    });
    expect(Object.fromEntries(usage)).toEqual({
      [KV_CACHE]: { 'requests:read': 2_100_000, 'requests:write': 70_000 },
      [KV_SESSIONS]: { 'requests:read': 7_000, 'requests:delete': 700, 'requests:list': 700 },
    });
    expect(fetch.calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/graphql',
        auth: `Bearer ${TOKEN}`,
        body: {
          query: datasetQuery(COST_DATASETS.kvOperations),
          variables: { account: ACCOUNT, from: '2026-09-29', to: '2026-10-06', keys: [KV_CACHE, KV_SESSIONS] },
        },
      }),
    ]);
    expect(datasetQuery(COST_DATASETS.r2Storage)).toContain(
      'r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to, bucketName_in: $keys })',
    );
  });

  it('only sends queries, and says what Cloudflare said about one it won’t answer', async () => {
    const { ctx } = context();
    await expect(analyticsQuery(ctx, 'mutation { x }', {})).rejects.toThrow(/only read/u);
    await expect(analyticsQuery(ctx, 'query { viewer { nothing } }', {})).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('unknown field'),
    });
    await expect(analyticsQuery({ ...ctx, token: undefined }, 'query { x }', {})).rejects.toThrow(
      /no read-only token/u,
    );
  });
});

describe('the Cloudflare provider’s token (BRK-189, for BRK-194)', () => {
  it('declares a read-only token with BRK-188’s permissions, and is in the Worker’s registry', () => {
    expect(() => checkProvider(cloudflare)).not.toThrow();
    const names = cloudflare.readToken.permissions.map((p) => p.name);
    expect(names).toHaveLength(10);
    for (const name of names) expect(name).toMatch(/ Read$/u);
    expect(providers.get('cloudflare')).toBe(cloudflare);
  });

  it('checks a user token, or an account token on its account, and says what Cloudflare said', async () => {
    expect(await checkToken({ token: TOKEN, fetch: cloudflareApi() })).toEqual({ ok: true });

    const answers = cloudflareAnswers();
    delete answers['/user/tokens/verify'];
    answers['/accounts?per_page=50'] = { success: true, result: [{ id: ACCOUNT }] };
    answers[`/accounts/${ACCOUNT}/tokens/verify`] = { success: true, result: { status: 'active' } };
    const account = cloudflareApi(answers);
    expect(await checkToken({ token: TOKEN, fetch: account })).toEqual({ ok: true });
    expect(account.calls.map((c) => c.path)).toEqual([
      '/user/tokens/verify',
      '/accounts?per_page=50',
      `/accounts/${ACCOUNT}/tokens/verify`,
    ]);

    expect(await checkToken({ token: TOKEN, fetch: cloudflareApi({}) })).toEqual({ ok: false, error: 'not found' });
  });
});

describe('discovering into the inventory (BRK-189)', () => {
  const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
  let cookie;
  let spy;

  beforeAll(async () => {
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = login.headers.get('Set-Cookie').split(';')[0];
  });
  afterEach(() => spy?.mockRestore());

  it('fills the environment’s slice from Cloudflare with the connected token, and marks missing permissions', async () => {
    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/containers/applications`] = 403;
    const cf = cloudflareApi(answers);
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.cloudflare.com/')) return cf(url, init);
      return new Response('{}', { status: 404 });
    });
    const put = await SELF.fetch(`${ORIGIN}/api/infra/connections/cloudflare`, {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(put.status).toBe(201);
    const made = await boardApi('infra/environments', {
      method: 'POST',
      body: { repo: 'widgets', name: 'production', kind: 'production', provider: 'cloudflare', target: 'acme-api' },
    });
    expect(made.status).toBe(201);

    const result = await inStore((s) => s.refreshInventory('cloudflare'));
    expect(result).toMatchObject({ provider: 'cloudflare', environments: 1, resources: 12 });

    const inventory = await (await api('infra/inventory?provider=cloudflare')).json();
    expect(inventory.resources.map((r) => r.id)).toContain(`d1:${D1_ID}`);
    expect(inventory.resources.every((r) => r.owner.environment === 'production')).toBe(true);
    expect(inventory.resources.every((r) => r.health === null)).toBe(true);
    const api_ = inventory.resources.find((r) => r.id === 'worker:acme-api');
    expect(api_.cost).toMatchObject({ currency: 'USD', perMonth: true, estimate: true });
    expect(api_.cost.amount).toBeCloseTo((0.7 * 0.3 + 3.5 * 0.02) * (30 / 7), 3);
    expect(api_.cost.note).toMatch(/not by resource/u);
    expect(inventory.relations).toContainEqual(
      expect.objectContaining({ from: 'worker:acme-api', to: `d1:${D1_ID}`, kind: 'uses' }),
    );
    const stored = JSON.stringify(inventory);
    for (const value of [...NEVER_KEPT, TOKEN, 'acme-other']) expect(stored).not.toContain(value);
    for (const call of cf.calls) expect(call.method === 'GET' || call.path === '/graphql').toBe(true);
    // Cost reads what discover just found, so nothing is discovered twice.
    expect(cf.calls.filter((c) => c.path.endsWith('/workers/scripts/acme-api/settings'))).toHaveLength(1);

    const row = (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.cloudflare');
    expect(row.provider.discovery).toMatchObject({ ok: true });
    expect(row.items.find((i) => i.name === 'Containers Read')).toMatchObject({ ok: false });
    expect(row.items.find((i) => i.name === 'D1 Read')).toMatchObject({ ok: true });
  });
});
