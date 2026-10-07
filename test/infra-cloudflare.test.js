import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COST_DATASETS,
  HEALTH_DATASETS,
  analyticsQuery,
  datasetQuery,
  readDataset,
} from '../src/infra-cloudflare-analytics.js';
import {
  CLOUDFLARE_KINDS,
  COST_NOTE,
  NEVER_CALLED,
  PRICES,
  alertSetup,
  checkToken,
  cloudflare,
  cost,
  discover,
  events,
  observe,
  priceResource,
  rid,
} from '../src/infra-cloudflare.js';
import { checkCosts, checkDiscovery, checkHealth, checkProvider, checkSignals } from '../src/infra-provider.js';
import { providers } from '../src/infra-providers.js';
import { scopeDiscovery } from '../src/infra-inventory.js';
import { DEFAULT_POLICY, evaluatePolicy } from '../src/infra-policy.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, boardApi } from './helpers.js';
import {
  ACCOUNT,
  ALERT_NEVER_KEPT,
  ALERT_ROUTINE,
  ALERT_TIMES,
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

// The provider contract runs in infra-cloudflare-plan.test.js, against an account that answers writes.

describe('the Cloudflare provider’s access kinds (BRK-229)', () => {
  it('marks routes and custom domains as access, so a change to one always asks the owner', () => {
    expect(CLOUDFLARE_KINDS.route.access).toBe(true);
    expect(CLOUDFLARE_KINDS['custom-domain'].access).toBe(true);
    expect(CLOUDFLARE_KINDS.worker.access).toBeUndefined();
    const route = {
      op: 'update',
      resource: 'route:acme-zone/1',
      kind: 'route',
      name: 'acme.example/*',
      before: { worker: 'acme-api' },
      after: { worker: 'acme-other' },
      reversible: true,
    };
    const result = evaluatePolicy(DEFAULT_POLICY, {
      environment: { name: 'staging', frozen: false, gates: false },
      diff: { provider: 'cloudflare', environment: 'staging', changes: [route], reversible: true },
      cost: null,
      provider: cloudflare,
      currency: 'USD',
    });
    expect(result.rules.find((r) => r.rule === 'access')).toMatchObject({ applies: true, effect: 'ask' });
  });
});

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
    expect(byId.get(`queue:${QUEUE_JOBS}`).attrs.maxConcurrency).toBe(4);
    expect(byId.get(`queue:${QUEUE_JOBS}`).attrs.consumers).toEqual([
      {
        type: 'worker',
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
      `${a}/workers/observability/telemetry/query`,
      `${a}/workers/observability/telemetry/keys`,
      `${a}/workers/observability/telemetry/values`,
      `${a}/workers/observability/destinations`,
      `${a}/workers/scripts/acme-api/tails`,
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

    // A refused Workers read names the role, and the legacy permission an older token has instead.
    const workers = cloudflareAnswers();
    workers[`/accounts/${ACCOUNT}/workers/scripts`] = 403;
    const refused = await discover(context(workers).ctx).catch((e) => e);
    expect(refused.message).toMatch(
      /the token needs Workers Metadata Read-Only \(or the legacy Workers Scripts Read\)$/u,
    );
    expect(refused.permission).toBe('Workers Metadata Read-Only');

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
    for (const name of names) expect(name).toMatch(/ Read(-Only)?$/u);
    // Cloudflare's Workers role that never reads code, with the legacy permission a token made before still has.
    expect(cloudflare.readToken.permissions[0]).toMatchObject({
      name: 'Workers Metadata Read-Only',
      legacy: ['Workers Scripts Read'],
    });
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
    expect(inventory.resources.every((r) => r.health !== null)).toBe(true);
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

/** Fifteen made-up minutes of analytics: acme-api failing, acme-auth degraded, a slow database, R2 with some 503s. */
function healthRows() {
  return {
    workersInvocationsAdaptive: [
      { sum: { requests: 1_000, errors: 600 }, dimensions: { scriptName: 'acme-api' } },
      { sum: { requests: 1_000, errors: 100 }, dimensions: { scriptName: 'acme-auth' } },
      { sum: { requests: 5_000, errors: 5_000 }, dimensions: { scriptName: 'acme-other' } },
    ],
    durableObjectsInvocationsAdaptiveGroups: [
      { sum: { requests: 100, errors: 0 }, dimensions: { namespaceId: DO_ROOMS } },
    ],
    d1AnalyticsAdaptiveGroups: [
      {
        sum: { readQueries: 40, writeQueries: 10 },
        avg: { queryBatchTimeMs: 2_500 },
        dimensions: { databaseId: D1_ID },
      },
    ],
    kvOperationsAdaptiveGroups: [{ sum: { requests: 10 }, dimensions: { namespaceId: KV_CACHE } }],
    r2OperationsAdaptiveGroups: [
      { sum: { requests: 90 }, dimensions: { bucketName: 'acme-files', responseStatusCode: 200 } },
      { sum: { requests: 10 }, dimensions: { bucketName: 'acme-files', responseStatusCode: 503 } },
    ],
    queuesBacklogAdaptiveGroups: [{ avg: { messages: 10 }, dimensions: { queueId: QUEUE_JOBS } }],
  };
}

describe('the Cloudflare provider’s observe (BRK-191)', () => {
  const W = (name) => rid('worker', name);
  const healthOf = async (answers) => {
    const { ctx, fetch } = context(answers);
    const health = checkHealth(cloudflare, await observe(ctx));
    return { fetch, by: Object.fromEntries(health.map((h) => [h.resource, h])) };
  };

  it('reads each resource’s health from the last 15 minutes, and routes and domains take their Worker’s', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage(healthRows());
    const { by } = await healthOf(answers);
    const state = Object.fromEntries(Object.entries(by).map(([id, h]) => [id, h.state]));
    expect(state).toEqual({
      [W('acme-api')]: 'down',
      [W('acme-auth')]: 'degraded',
      [W('acme-rooms')]: 'unknown',
      [`d1:${D1_ID}`]: 'degraded',
      [`kv:${KV_CACHE}`]: 'healthy',
      [`kv:${KV_SESSIONS}`]: 'unknown',
      'r2:acme-files': 'degraded',
      [`queue:${QUEUE_JOBS}`]: 'healthy',
      [`durable-object:${DO_ROOMS}`]: 'healthy',
      [`durable-object:${DO_COUNTER}`]: 'unknown',
      [`container:${CONTAINER}`]: 'healthy',
      'route:0000000000000000000000000000d101': 'down',
      'custom-domain:0000000000000000000000000000d201': 'down',
    });
    expect(by[W('acme-api')].text).toBe('60% of 1000 requests failed in the last 15 minutes');
    expect(by[`d1:${D1_ID}`].text).toBe('Queries took 2500 ms on average in the last 15 minutes');
    expect(by['r2:acme-files'].text).toBe('10% of 100 operations failed in the last 15 minutes');
    expect(by[`queue:${QUEUE_JOBS}`].text).toBe('12 in the backlog');
    expect(by[`container:${CONTAINER}`].text).toBe('2 of 2 instances are running');
    expect(by['route:0000000000000000000000000000d101'].text).toMatch(/^Its Worker, acme-api: 60% of 1000/u);
    expect(by[W('acme-rooms')].text).toBe('No requests in the last 15 minutes');
  });

  it('asks one query per dataset for the whole environment, over the last 15 minutes, and reads nothing else', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage(healthRows());
    const { ctx, fetch } = context(answers);
    const found = await discover(ctx);
    fetch.calls.length = 0;
    await observe({ ...ctx, resources: found.resources });
    const queries = fetch.calls.filter((c) => c.path === '/graphql');
    expect(queries.map((c) => c.body.query)).toEqual(Object.values(HEALTH_DATASETS).map((d) => datasetQuery(d)));
    for (const q of queries) {
      const { from, to } = q.body.variables;
      expect(Date.parse(to) - Date.parse(from)).toBe(15 * 60_000);
      expect(q.body.variables.account).toBe(ACCOUNT);
    }
    const workers = queries.find((q) => q.body.query.includes('workersInvocationsAdaptive('));
    expect(workers.body.variables.keys).toEqual(['acme-api', 'acme-auth', 'acme-rooms']);
    // The rest is the account and the queue's backlog now: given what discover found, it discovers nothing again.
    expect(fetch.calls.filter((c) => c.path !== '/graphql').map((c) => c.path)).toEqual([
      '/accounts?page=1&per_page=50',
      `/accounts/${ACCOUNT}/queues/${QUEUE_JOBS}/metrics`,
    ]);
    for (const c of fetch.calls) expect(NEVER_CALLED.some((re) => re.test(c.path.split('?')[0]))).toBe(false);
  });

  it('calls a Worker with no deployment down, a stopped container down, and a waiting or paused queue degraded', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage({ ...healthRows(), queuesBacklogAdaptiveGroups: [] });
    answers[`/accounts/${ACCOUNT}/queues/${QUEUE_JOBS}/metrics`] = () => ({
      success: true,
      result: { backlog_count: 40, oldest_message_timestamp_ms: Date.now() - 45.5 * 60_000 },
    });
    const { ctx } = context(answers);
    const found = await discover(ctx);
    const resources = found.resources.map((r) => {
      if (r.id === W('acme-auth')) return { ...r, attrs: { ...r.attrs, versions: [] } };
      if (r.kind === 'container') return { ...r, attrs: { ...r.attrs, active: 0, assigned: 2 } };
      return r;
    });
    const by = Object.fromEntries((await observe({ ...ctx, resources })).map((h) => [h.resource, h]));
    expect(by[W('acme-auth')]).toMatchObject({ state: 'down', text: 'No deployment: it serves nothing' });
    expect(by[`container:${CONTAINER}`]).toMatchObject({ state: 'down', text: 'None of 2 instances is running' });
    expect(by[`queue:${QUEUE_JOBS}`]).toMatchObject({
      state: 'degraded',
      text: 'The oldest message has waited 45 minutes; 40 in the backlog',
    });

    const paused = resources.map((r) =>
      r.kind === 'queue' ? { ...r, attrs: { ...r.attrs, deliveryPaused: true } } : r,
    );
    const again = await observe({ ...ctx, resources: paused });
    expect(again.find((h) => h.resource === `queue:${QUEUE_JOBS}`)).toMatchObject({
      state: 'degraded',
      text: 'Delivery is paused',
    });
  });

  it('leaves a dataset Cloudflare won’t answer unknown, and stops on a 429 or a token without the analytics', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage({ ...healthRows(), d1AnalyticsAdaptiveGroups: 'unknown field "avg"' });
    const { by } = await healthOf(answers);
    expect(by[`d1:${D1_ID}`]).toMatchObject({
      state: 'unknown',
      text: 'Cloudflare’s analytics didn’t answer for its queries and their time',
    });
    expect(by[W('acme-api')].state).toBe('down');

    for (const [status, permission] of [
      [429, undefined],
      [403, 'Account Analytics Read'],
    ]) {
      const refused = cloudflareAnswers();
      refused['/graphql'] = status;
      const { ctx } = context(refused);
      await expect(observe(ctx)).rejects.toMatchObject({ status, ...(permission ? { permission } : {}) });
    }
  });

  it('observes nothing in an environment with nothing in it, and asks for a token first', async () => {
    const { ctx, fetch } = context();
    expect(await observe({ ...ctx, resources: [] })).toEqual([]);
    expect(fetch.calls).toEqual([]);
    await expect(observe({ ...ctx, token: undefined })).rejects.toThrow(/no read-only token/u);
  });
});

describe('the Cloudflare provider’s events and alerts (BRK-191)', () => {
  it('reports the alert history as alert signals on the Worker each names, or the whole environment', async () => {
    const { ctx, fetch } = context();
    const since = '2026-10-01T00:00:00Z';
    const signals = checkSignals(cloudflare, ctx, since, await events(ctx, since));
    expect(signals).toEqual([
      {
        source: 'cloudflare',
        environment: 'production',
        resource: 'worker:acme-api',
        kind: 'alert',
        level: 'warning',
        value: null,
        at: ALERT_TIMES[0],
        text: 'Cloudflare alert: Worker error rate on acme-api',
      },
      {
        source: 'cloudflare',
        environment: 'production',
        resource: null,
        kind: 'alert',
        level: 'warning',
        value: null,
        at: ALERT_TIMES[2],
        text: 'Cloudflare alert: Usage based billing',
      },
    ]);
    const stored = JSON.stringify(signals);
    for (const value of [...ALERT_NEVER_KEPT, 'acme-other', ACCOUNT]) expect(stored).not.toContain(value);
    const history = fetch.calls.find((c) => c.path.includes('/alerting/v3/history'));
    const url = new URL(`https://x${history.path}`);
    expect(url.searchParams.get('since')).toBe('2026-10-01T00:00:00.000Z');
    expect(Date.parse(url.searchParams.get('before') ?? '')).toBeGreaterThan(Date.parse(since));
    for (const c of fetch.calls) expect(c.method).toBe('GET');
  });

  it('asks only for what’s new, asks nothing for a time ahead, and names Notifications Read when it’s refused', async () => {
    const { ctx, fetch } = context();
    expect(await events(ctx, new Date(Date.parse(ALERT_TIMES[1]) + 1).toISOString())).toHaveLength(1);
    fetch.calls.length = 0;
    expect(await events(ctx, new Date(Date.now() + 86_400_000).toISOString())).toEqual([]);
    expect(fetch.calls).toEqual([]);

    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/alerting/v3/history?*`] = 403;
    await expect(events(context(answers).ctx, '2026-10-01T00:00:00Z')).rejects.toMatchObject({
      status: 403,
      permission: 'Notifications Read',
    });
  });

  it('reads which alerts are set up and which reach the board, keeping names and never an address', async () => {
    const { ctx, fetch } = context();
    const setup = await alertSetup(ctx, { board: [ORIGIN] });
    expect(setup.alerts).toEqual([
      { type: 'workers_alert', name: 'Worker error rate', product: 'Workers', policies: 1, reachesBoard: true },
      {
        type: 'billing_usage_alert',
        name: 'Usage based billing',
        product: 'Billing',
        policies: 1,
        reachesBoard: false,
      },
      {
        type: 'real_origin_monitoring',
        name: 'Origin error rate',
        product: 'Origin Monitoring',
        policies: 1,
        reachesBoard: false,
      },
    ]);
    expect(setup.policies).toEqual([
      {
        name: 'Errors to the board',
        alertType: 'workers_alert',
        enabled: true,
        reachesBoard: true,
        routines: [ALERT_ROUTINE],
      },
      { name: 'Billing by email', alertType: 'billing_usage_alert', enabled: true, reachesBoard: false, routines: [] },
      {
        name: 'Origin errors (off)',
        alertType: 'real_origin_monitoring',
        enabled: false,
        reachesBoard: false,
        routines: [ALERT_ROUTINE],
      },
    ]);
    expect(setup.webhooks).toEqual({ toBoard: 1, other: 1 });
    const kept = JSON.stringify(setup);
    for (const value of [...ALERT_NEVER_KEPT, 'tasks.acme.example', 'wh-board']) expect(kept).not.toContain(value);
    for (const c of fetch.calls) expect(c.method).toBe('GET');

    // Another board's webhook doesn't reach this one.
    const elsewhere = await alertSetup(ctx, { board: ['https://tasks.other.example'] });
    expect(elsewhere.webhooks).toEqual({ toBoard: 0, other: 2 });
    expect(elsewhere.alerts.some((a) => a.reachesBoard)).toBe(false);
  });
});

describe('Cloudflare’s health and alerts in the signal stream (BRK-191)', () => {
  const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
  let spy;
  afterEach(() => spy?.mockRestore());

  /** Points Cloudflare's API at `answers`, connects the token, and makes sure production runs `acme-api`. */
  async function onCloudflare(answers) {
    const cf = cloudflareApi(answers);
    spy?.mockRestore();
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.cloudflare.com/')) return cf(url, init);
      return new Response('{}', { status: 404 });
    });
    const put = await boardApi('infra/connections/cloudflare', { method: 'PUT', body: { token: TOKEN } });
    expect(put.status).toBeLessThan(300);
    const listed = await (await api('infra/environments?repo=widgets')).json();
    let production = listed.environments.find((e) => e.name === 'production');
    if (!production) {
      const made = await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', name: 'production', kind: 'production', provider: 'cloudflare', target: 'acme-api' },
      });
      expect(made.status).toBe(201);
      production = (await made.json()).environment;
    }
    return { cf, production };
  }
  const signals = async (query) =>
    (await (await api(`infra/signals?environment=production&source=cloudflare&${query}`)).json()).signals;

  it('turns failing health into signals on the right resource, and again once it’s healthy', async () => {
    const answers = cloudflareAnswers();
    answers['/graphql'] = cloudflareUsage(healthRows());
    const { production } = await onCloudflare(answers);
    // Connecting looked once already (BRK-248); make sure it did, since production may be new here.
    if (!(await inStore((s) => s.inventoryRefreshRow('cloudflare'))))
      await inStore((s) => s.refreshInventory('cloudflare'));

    const health = await signals('kind=health');
    const on = (id) => health.filter((s) => s.resource === id);
    expect(on('worker:acme-api')).toEqual([
      expect.objectContaining({
        source: 'cloudflare',
        environment: 'production',
        environmentId: production.id,
        kind: 'health',
        level: 'critical',
        text: 'worker:acme-api is down: 60% of 1000 requests failed in the last 15 minutes',
      }),
    ]);
    expect(on('worker:acme-auth')).toEqual([expect.objectContaining({ level: 'warning' })]);
    expect(on('route:0000000000000000000000000000d101')).toEqual([expect.objectContaining({ level: 'critical' })]);
    // Healthy and unknown resources add nothing: the inventory keeps their health.
    expect(on(`kv:${KV_CACHE}`)).toEqual([]);
    expect(on(`kv:${KV_SESSIONS}`)).toEqual([]);
    const inventory = await (await api('infra/inventory?provider=cloudflare')).json();
    expect(inventory.resources.find((r) => r.id === 'worker:acme-api').health).toMatchObject({ state: 'down' });

    const row = (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.cloudflare');
    expect(row.provider.signal).toMatchObject({ ok: true });

    // Fixed: acme-api is healthy again, and says so once.
    const fixed = healthRows();
    fixed.workersInvocationsAdaptive[0].sum.errors = 0;
    answers['/graphql'] = cloudflareUsage(fixed);
    await inStore((s) => s.refreshInventory('cloudflare'));
    const after = (await signals('kind=health&resource=worker:acme-api')).map((s) => `${s.level} ${s.text}`);
    expect(after).toEqual([
      'info worker:acme-api is healthy again: 1000 requests, 0 failed, in the last 15 minutes',
      'critical worker:acme-api is down: 60% of 1000 requests failed in the last 15 minutes',
    ]);
    await inStore((s) => s.refreshInventory('cloudflare'));
    expect(await signals('kind=health&resource=worker:acme-api')).toHaveLength(2);
  });

  it('adds the alert history once, on the Worker it names or the whole environment, and nothing it leaves out', async () => {
    const { production } = await onCloudflare(cloudflareAnswers());
    await inStore((s) => s.refreshInventory('cloudflare'));
    const alerts = await signals('kind=alert');
    expect(alerts.filter((a) => a.at === ALERT_TIMES[0] || a.at === ALERT_TIMES[2])).toEqual([
      expect.objectContaining({
        resource: null,
        environmentId: production.id,
        text: 'Cloudflare alert: Usage based billing',
      }),
      expect.objectContaining({
        resource: 'worker:acme-api',
        level: 'warning',
        text: 'Cloudflare alert: Worker error rate on acme-api',
      }),
    ]);
    const stored = JSON.stringify(alerts);
    for (const value of [...ALERT_NEVER_KEPT, 'acme-other']) expect(stored).not.toContain(value);

    // The same history again (as after a refresh that failed half way) adds nothing.
    const { ctx } = context();
    const history = await events(ctx, new Date(Date.parse(ALERT_TIMES[0]) - 1).toISOString());
    expect(history).toHaveLength(2);
    const again = await inStore((s) =>
      s.recordAlertSignals(history.map((a) => ({ ...a, environmentId: production.id }))),
    );
    expect(again).toEqual([]);
    expect(await signals('kind=alert')).toHaveLength(alerts.length);
  });

  it('records a Cloudflare webhook’s alert as a signal on its Worker, once, and the routine still starts', async () => {
    const { production } = await onCloudflare(cloudflareAnswers());
    await inStore((s) => s.refreshInventory('cloudflare'));
    const made = await api('routines', {
      method: 'POST',
      body: { slug: ALERT_ROUTINE, name: 'Cloudflare alerts', prompt: 'Look into the alert.', gapMinutes: 0 },
    });
    expect(made.status).toBe(201);
    const secret = (
      await (await api(`routines/${ALERT_ROUTINE}/triggers`, { method: 'POST', body: { label: 'cloudflare' } })).json()
    ).secret;
    const fire = (alert) =>
      SELF.fetch(`${ORIGIN}/api/routines/${ALERT_ROUTINE}/fire`, {
        method: 'POST',
        headers: { 'cf-webhook-auth': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
    const count = async () => (await signals('kind=alert')).length;
    const before = await count();

    // The alert the history already brought in: the webhook's copy is the same signal.
    const heard = await fire({
      alert_name: 'Worker error rate',
      ts: Date.parse(ALERT_TIMES[0]) / 1000,
      text: 'acme-alert-details: write to oncall@example.com',
      data: { script_name: 'acme-api' },
    });
    expect(heard.status).toBe(202);
    expect((await heard.json()).task.wid).toBeTruthy();
    expect(await count()).toBe(before);

    // A new one becomes one signal on acme-api in production, however often it's delivered.
    const cpu = { alert_name: 'Worker CPU time', ts: Math.floor(Date.now() / 1000), data: { script_name: 'acme-api' } };
    expect((await fire(cpu)).status).toBe(202);
    expect((await fire(cpu)).status).toBe(202);
    const onApi = (await signals('kind=alert&resource=worker:acme-api')).filter((s) => /CPU/u.test(s.text));
    expect(onApi).toEqual([
      expect.objectContaining({
        environmentId: production.id,
        level: 'warning',
        text: 'Cloudflare alert: Worker CPU time on acme-api',
      }),
    ]);

    // An alert naming no Worker is about the whole environment.
    expect((await fire({ alert_name: 'Zone traffic anomaly', ts: Math.floor(Date.now() / 1000) })).status).toBe(202);
    const whole = (await signals('kind=alert')).find((s) => s.text === 'Cloudflare alert: Zone traffic anomaly');
    expect(whole).toMatchObject({ resource: null, environmentId: production.id });
    expect(JSON.stringify(await signals('kind=alert'))).not.toContain('oncall@example.com');
  });

  it('marks the signal connection when the alert history is refused, and still refreshes the inventory', async () => {
    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/alerting/v3/history?*`] = 403;
    await onCloudflare(answers);
    const result = await inStore((s) => s.refreshInventory('cloudflare'));
    expect(result.resources).toBeGreaterThan(0);
    const row = (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.cloudflare');
    expect(row.provider.signal).toMatchObject({ ok: false });
    expect(row.items.find((i) => i.name === 'Notifications Read')).toMatchObject({ ok: false });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it('says which alerts reach the board on GET /api/infra/alerts, read only', async () => {
    await onCloudflare(cloudflareAnswers());
    const res = await api('infra/alerts?provider=cloudflare');
    expect(res.status).toBe(200);
    const setup = await res.json();
    expect(setup.provider).toBe('cloudflare');
    expect(setup.alerts.find((a) => a.type === 'workers_alert')).toMatchObject({ reachesBoard: true });
    expect(setup.policies.find((p) => p.name === 'Errors to the board')).toMatchObject({ routines: [ALERT_ROUTINE] });
    expect(setup.webhooks).toEqual({ toBoard: 1, other: 1 });
    const kept = JSON.stringify(setup);
    for (const value of [...ALERT_NEVER_KEPT, TOKEN]) expect(kept).not.toContain(value);

    expect((await api('infra/alerts')).status).toBe(400);
    expect((await api('infra/alerts?provider=nowhere')).status).toBe(404);
    expect((await api('infra/alerts?provider=cloudflare', { method: 'POST', body: {} })).status).toBe(405);
  });

  it('marks Cloudflare’s row as one that sends alerts, and names the permission an alerts read is missing (WEB-91)', async () => {
    const answers = cloudflareAnswers();
    answers[`/accounts/${ACCOUNT}/alerting/v3/policies`] = 403;
    await onCloudflare(answers);
    const row = (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.cloudflare');
    expect(row.provider.alerts).toBe(true);
    const res = await api('infra/alerts?provider=cloudflare');
    expect(res.status).toBe(502);
    const said = await res.json();
    expect(said).toMatchObject({ error: /couldn’t say which alerts are set up/u, missing: ['Notifications Read'] });
    expect(JSON.stringify(said)).not.toContain(TOKEN);
  });
});
