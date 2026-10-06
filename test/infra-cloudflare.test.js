import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NEVER_CALLED, checkToken, cloudflare, discover, rid } from '../src/infra-cloudflare.js';
import { checkDiscovery, checkProvider } from '../src/infra-provider.js';
import { providers } from '../src/infra-providers.js';
import { scopeDiscovery } from '../src/infra-inventory.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, boardApi } from './helpers.js';
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
} from './cloudflare-fixture.js';

const TOKEN = 'cf-read-token-for-tests-only';

/** A context for `acme-api`'s environment, calling the made-up account. */
function context(answers = cloudflareAnswers(), extra = {}) {
  const fetch = cloudflareApi(answers);
  return { fetch, ctx: { environment: 'production', scope: { target: 'acme-api' }, token: TOKEN, fetch, ...extra } };
}

// The provider contract runs in infra-cloudflare-plan.test.js, against an account that answers writes.

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
    expect(inventory.resources.every((r) => r.health === null && r.cost === null)).toBe(true);
    expect(inventory.relations).toContainEqual(
      expect.objectContaining({ from: 'worker:acme-api', to: `d1:${D1_ID}`, kind: 'uses' }),
    );
    const stored = JSON.stringify(inventory);
    for (const value of [...NEVER_KEPT, TOKEN, 'acme-other']) expect(stored).not.toContain(value);
    for (const call of cf.calls) expect(call.method).toBe('GET');

    const row = (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.cloudflare');
    expect(row.provider.discovery).toMatchObject({ ok: true });
    expect(row.items.find((i) => i.name === 'Containers Read')).toMatchObject({ ok: false });
    expect(row.items.find((i) => i.name === 'D1 Read')).toMatchObject({ ok: true });
  });
});
