import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { redactAttrs, scopeDiscovery } from '../src/infra-inventory.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));

/** A fake platform under its own provider ID, so each test's refresh touches only its own slice. */
function platform(id) {
  const provider = fakeProvider({ id });
  // Something on the same platform that no environment runs on: it must never be stored.
  provider.state.resources.push({ id: 'svc-other', kind: 'service', name: 'someone-elses', attrs: {} });
  provider.state.relations.push({ from: 'svc-other', to: 'db-main', kind: 'uses' });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { provider, registry };
}

const addEnvironment = async (fields) =>
  (await body(await boardApi('infra/environments', { method: 'POST', body: { repo: 'widgets', ...fields } })))
    .environment;

/** Refreshes inside the Durable Object with a test registry; the Worker's registry has no fake. */
const refresh = (id, registry) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, result: await instance.refreshInventory(id, { registry }) };
    } catch (error) {
      return { ok: false, status: error.status, error: error.message };
    }
  });

const inventory = async (query) => body(await api(`infra/inventory?${new URLSearchParams(query)}`));

describe('inventory scope (BRK-177)', () => {
  const discovery = {
    resources: [
      { id: 'a', kind: 'service', name: 'api' },
      { id: 'b', kind: 'database', name: 'main' },
      { id: 'c', kind: 'secret', name: 'TOKEN' },
      { id: 'd', kind: 'service', name: 'other' },
    ],
    relations: [
      { from: 'a', to: 'b', kind: 'uses' },
      { from: 'b', to: 'c', kind: 'binds' },
      { from: 'd', to: 'b', kind: 'uses' },
    ],
  };

  it('keeps the target and what it reaches, by name or ID, and nothing that only leans on it', () => {
    const byName = scopeDiscovery(discovery, 'api');
    expect(byName.resources.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(byName.relations).toEqual([
      { from: 'a', to: 'b', kind: 'uses' },
      { from: 'b', to: 'c', kind: 'binds' },
    ]);
    expect(scopeDiscovery(discovery, 'a').resources).toHaveLength(3);
    expect(scopeDiscovery(discovery, 'main').resources.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('keeps nothing without a target, or when the target isn’t there', () => {
    expect(scopeDiscovery(discovery, null)).toEqual({ resources: [], relations: [] });
    expect(scopeDiscovery(discovery, 'missing')).toEqual({ resources: [], relations: [] });
  });

  it('redacts every string in a resource’s settings', () => {
    const out = redactAttrs({
      env: ['API_TOKEN=abc123'],
      nested: { header: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      n: 2,
    });
    expect(out).toEqual({ env: ['API_TOKEN=[redacted]'], nested: { header: 'Bearer [redacted]' }, n: 2 });
  });
});

describe('inventory (BRK-177)', () => {
  it('a refresh fills it with what’s in scope, with relations, ownership, health, and cost', async () => {
    const { provider, registry } = platform('fake-fill');
    const staging = await addEnvironment({
      name: 'fill-staging',
      kind: 'staging',
      provider: 'fake-fill',
      target: 'api',
    });
    await addEnvironment({ name: 'fill-untargeted', kind: 'staging', provider: 'fake-fill' });

    const res = await refresh('fake-fill', registry);
    expect(res).toMatchObject({ ok: true, result: { provider: 'fake-fill', environments: 1, resources: 3 } });
    expect(provider.calls.filter((c) => c.method === 'discover')).toEqual([
      { method: 'discover', environment: 'fill-staging' },
    ]);

    const all = await inventory({ provider: 'fake-fill' });
    expect(all.status).toBe(200);
    expect(all.resources.map((r) => r.id).sort()).toEqual(['db-main', 'route-api', 'svc-api']);
    expect(all.resources.some((r) => r.id === 'svc-other')).toBe(false);
    const api_ = all.resources.find((r) => r.id === 'svc-api');
    expect(api_).toMatchObject({
      provider: 'fake-fill',
      kind: 'service',
      name: 'api',
      attrs: { instances: 2, version: '1.0.0' },
      owner: { repo: 'widgets', environment: 'fill-staging', environmentId: staging.id, task: null },
      health: { state: 'healthy', at: '2026-10-06T12:00:00.000Z' },
      cost: { amount: 5, currency: 'USD', perMonth: true, estimate: true },
    });
    expect(all.relations.map(({ from, to, kind }) => ({ from, to, kind }))).toEqual([
      { from: 'svc-api', to: 'route-api', kind: 'serves' },
      { from: 'svc-api', to: 'db-main', kind: 'uses' },
    ]);

    const byEnvironment = await inventory({ environment: 'fill-staging', repo: 'widgets', kind: 'database' });
    expect(byEnvironment.resources.map((r) => r.id)).toEqual(['db-main']);
  });

  it('reads one resource back with its neighbours', async () => {
    const { registry } = platform('fake-read');
    await addEnvironment({ name: 'read-staging', kind: 'staging', provider: 'fake-read', target: 'svc-api' });
    await refresh('fake-read', registry);

    const one = await body(await api('infra/inventory/svc-api?environment=read-staging'));
    expect(one.status).toBe(200);
    expect(one.resource).toMatchObject({ id: 'svc-api', owner: { environment: 'read-staging' } });
    expect(one.uses.map((n) => [n.kind, n.resource.id])).toEqual([
      ['serves', 'route-api'],
      ['uses', 'db-main'],
    ]);
    expect(one.usedBy).toEqual([]);
    const db = await body(await api('infra/inventory/db-main?environment=read-staging'));
    expect(db.usedBy.map((n) => [n.kind, n.resource.id])).toEqual([['uses', 'svc-api']]);

    const missing = await body(await api('infra/inventory/svc-other?environment=read-staging'));
    expect(missing.status).toBe(404);
    expect(missing.error).toMatch(/no resource svc-other/);
  });

  it('a second refresh drops what the provider no longer reports', async () => {
    const { provider, registry } = platform('fake-drop');
    await addEnvironment({ name: 'drop-staging', kind: 'staging', provider: 'fake-drop', target: 'api' });
    await refresh('fake-drop', registry);
    expect((await inventory({ provider: 'fake-drop' })).resources).toHaveLength(3);

    provider.state.resources = provider.state.resources.filter((r) => r.id !== 'route-api');
    provider.state.relations = provider.state.relations.filter((r) => r.to !== 'route-api');
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 3;
    await refresh('fake-drop', registry);

    const after = await inventory({ provider: 'fake-drop' });
    expect(after.resources.map((r) => r.id).sort()).toEqual(['db-main', 'svc-api']);
    expect(after.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(3);
    expect(after.relations.map((r) => r.to)).toEqual(['db-main']);
    expect((await body(await api('infra/inventory/route-api?environment=drop-staging'))).status).toBe(404);
  });

  it('a failed discovery changes nothing, and a failed observe keeps the last health', async () => {
    const { provider, registry } = platform('fake-fail');
    await addEnvironment({ name: 'fail-staging', kind: 'staging', provider: 'fake-fail', target: 'api' });
    await refresh('fake-fail', registry);

    const discover = provider.discover;
    provider.discover = async () => {
      throw new Error('the platform is down');
    };
    const failed = await refresh('fake-fail', registry);
    expect(failed).toMatchObject({ ok: false, status: 502 });
    expect(failed.error).toMatch(
      /couldn’t discover widgets’s fail-staging: the platform is down\. The last inventory is kept/,
    );
    const kept = await inventory({ provider: 'fake-fail' });
    expect(kept.resources).toHaveLength(3);
    expect(kept.stale).toMatchObject([{ environment: 'fail-staging', error: /the platform is down/ }]);

    provider.discover = discover;
    provider.observe = async () => {
      throw new Error('no health today');
    };
    provider.state.costs['svc-api'] = 7;
    expect((await refresh('fake-fail', registry)).ok).toBe(true);
    const api_ = (await inventory({ provider: 'fake-fail' })).resources.find((r) => r.id === 'svc-api');
    expect(api_.health).toMatchObject({ state: 'healthy' });
    expect(api_.cost.amount).toBe(7);
    expect((await inventory({ provider: 'fake-fail' })).stale).toEqual([]);
  });

  it('keeps the last known health with its age when a read fails, and notes what failed (BRK-266)', async () => {
    const { provider, registry } = platform('fake-keep');
    await addEnvironment({ name: 'keep-staging', kind: 'staging', provider: 'fake-keep', target: 'api' });
    await refresh('fake-keep', registry);
    const first = (await inventory({ provider: 'fake-keep' })).resources.find((r) => r.id === 'svc-api').health;
    expect(first).toEqual({ state: 'healthy', at: '2026-10-06T12:00:00.000Z' });

    // The provider couldn't read it this time: unknown, saying which call.
    const observe = provider.observe;
    provider.observe = async (ctx) =>
      (await observe(ctx)).map((h) =>
        h.resource === 'svc-api'
          ? {
              ...h,
              at: '2026-10-06T13:00:00Z',
              state: 'unknown',
              text: 'Couldn’t read its health: GET /metrics failed',
            }
          : { ...h, at: '2026-10-06T13:00:00Z' },
      );
    expect((await refresh('fake-keep', registry)).ok).toBe(true);
    const kept = (await inventory({ provider: 'fake-keep' })).resources;
    expect(kept.find((r) => r.id === 'svc-api').health).toEqual({
      state: 'healthy',
      at: '2026-10-06T12:00:00.000Z',
      note: 'Couldn’t read its health: GET /metrics failed',
    });
    expect(kept.find((r) => r.id === 'db-main').health).toEqual({ state: 'healthy', at: '2026-10-06T13:00:00.000Z' });

    // observe failing altogether keeps every resource's last health, noting why.
    provider.observe = async () => {
      throw new Error('the analytics are out of reach');
    };
    expect((await refresh('fake-keep', registry)).ok).toBe(true);
    const db = (await inventory({ provider: 'fake-keep' })).resources.find((r) => r.id === 'db-main').health;
    expect(db).toEqual({
      state: 'healthy',
      at: '2026-10-06T13:00:00.000Z',
      note: 'Couldn’t read its health: the analytics are out of reach',
    });

    // Read again: the note goes.
    provider.observe = observe;
    await refresh('fake-keep', registry);
    expect((await inventory({ provider: 'fake-keep' })).resources.find((r) => r.id === 'db-main').health).toEqual({
      state: 'healthy',
      at: '2026-10-06T12:00:00.000Z',
    });
  });

  it('checks the health URL the desired state names on each refresh, on the front door (BRK-266)', async () => {
    const { provider, registry } = platform('fake-url');
    const staging = await addEnvironment({ name: 'url-staging', kind: 'staging', provider: 'fake-url', target: 'api' });
    provider.state.health['route-api'] = 'unknown';
    await runInDurableObject(store(), (s) =>
      s.sql.exec(
        'INSERT OR REPLACE INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'widgets',
        'url-staging.json',
        'url-staging',
        'fake-url',
        'abc',
        Date.now(),
        JSON.stringify({ resources: [], health: { url: 'https://api.acme.example/health' } }),
        'abc',
        Date.now(),
      ),
    );
    /** @type {Array<{ url: string, init: any }>} */
    const calls = [];
    let status = 503;
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('', { status });
    };
    const refreshWith = () => runInDurableObject(store(), (s) => s.refreshInventory('fake-url', { registry, fetch }));

    await refreshWith();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.acme.example/health');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).has('authorization')).toBe(false);
    const route = async () => (await inventory({ provider: 'fake-url' })).resources.find((r) => r.id === 'route-api');
    expect((await route()).health).toMatchObject({
      state: 'down',
      text: expect.stringMatching(/^The health URL on api\.acme\.example answered 503 in \d+ ms$/u),
    });
    const signals = await body(await api(`infra/signals?environment=url-staging&source=fake-url&kind=health`));
    expect(signals.signals.filter((x) => x.resource === 'route-api' && x.level === 'critical')).toHaveLength(1);
    expect(signals.signals[0].environmentId).toBe(staging.id);

    // Answering again: the front door is healthy, and says so once.
    status = 200;
    await refreshWith();
    expect(calls).toHaveLength(2);
    expect((await route()).health).toMatchObject({ state: 'healthy' });
    const again = await body(await api(`infra/signals?environment=url-staging&source=fake-url&kind=health`));
    expect(again.signals.filter((x) => x.resource === 'route-api' && x.level === 'info')).toHaveLength(1);
  });

  it('redacts a token a platform echoes back before it’s stored', async () => {
    const { provider, registry } = platform('fake-redact');
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.vars = {
      DEPLOY_TOKEN: 'DEPLOY_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
    };
    await addEnvironment({ name: 'redact-staging', kind: 'staging', provider: 'fake-redact', target: 'api' });
    await refresh('fake-redact', registry);
    const raw = await runInDurableObject(store(), (instance) =>
      instance.sql.exec("SELECT attrs FROM infra_inventory WHERE provider = 'fake-redact'").toArray(),
    );
    expect(JSON.stringify(raw)).not.toMatch(/ghp_/);
    const api_ = (await inventory({ provider: 'fake-redact' })).resources.find((r) => r.id === 'svc-api');
    expect(api_.attrs.vars.DEPLOY_TOKEN).toBe('DEPLOY_TOKEN=[redacted]');
  });

  it('shows the task that owns a short-lived environment, and drops a removed environment’s resources', async () => {
    const { registry } = platform('fake-owner');
    const task = await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: 'Preview the inventory', project: 'ops', horizon: 'now' }],
      }),
    );
    const { wid, uuid } = task.tasks[0];
    const preview = await addEnvironment({
      name: 'owner-preview',
      kind: 'short-lived',
      provider: 'fake-owner',
      target: 'api',
      task: wid,
    });
    await refresh('fake-owner', registry);
    const [first] = (await inventory({ environment: 'owner-preview' })).resources;
    expect(first.owner.task).toMatchObject({ uuid, wid });

    await boardApi(`infra/environments/${preview.id}`, { method: 'DELETE' });
    expect((await inventory({ provider: 'fake-owner' })).resources).toEqual([]);
  });

  it('a resource in two environments asks which', async () => {
    const { registry } = platform('fake-two');
    await addEnvironment({ name: 'two-staging', kind: 'staging', provider: 'fake-two', target: 'api' });
    await addEnvironment({ name: 'two-production', kind: 'production', provider: 'fake-two', target: 'api' });
    await refresh('fake-two', registry);
    const both = await body(await api('infra/inventory/db-main'));
    expect(both.status).toBe(409);
    expect(both.error).toMatch(/say which with \?environment=/);
  });

  it('a refresh through the API is the signed-in owner’s, and names the provider', async () => {
    const token = await body(await api('infra/inventory/refresh', { method: 'POST', body: { provider: 'fake' } }));
    expect(token).toMatchObject({ status: 403, error: /only the signed-in web board can refresh the inventory/ });
    const agent = await body(
      await boardApi('infra/inventory/refresh', { method: 'POST', body: { provider: 'fake', by: 'claude-x' } }),
    );
    expect(agent.status).toBe(403);
    const unknown = await body(
      await boardApi('infra/inventory/refresh', { method: 'POST', body: { provider: 'nowhere' } }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error).toMatch(/no provider nowhere/);
  });
});

/** Pastes `token` for `id` on Connections, as the owner would. */
const connect = (id, token = 'fake-read-token') =>
  boardApi(`infra/connections/${id}`, { method: 'PUT', body: { token } });

describe('each environment refreshes on its own (BRK-257)', () => {
  /** Two environments on one platform, both filled once; then `broken`'s discovery throws `error`. */
  async function twoEnvironments(id, error) {
    const { provider, registry } = platform(id);
    const good = await addEnvironment({ name: `${id}-good`, kind: 'staging', provider: id, target: 'api' });
    const broken = await addEnvironment({ name: `${id}-broken`, kind: 'production', provider: id, target: 'api' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = registry;
    });
    expect((await connect(id)).status).toBe(201);
    const discover = provider.discover;
    provider.discover = async (ctx) => {
      if (ctx.environment === broken.name) throw error;
      return discover(ctx);
    };
    return { provider, registry, good, broken, discover };
  }

  const done = () =>
    runInDurableObject(store(), (s) => {
      s.infraProviders = undefined;
    });

  it('a 500 on one keeps its last inventory, stale, and writes the other’s inventory, health, and alerts', async () => {
    const id = 'fake-split';
    const { provider, registry, good, broken, discover } = await twoEnvironments(
      id,
      Object.assign(new Error('Fake platform answered 500'), { status: 500 }),
    );
    const before = (await inventory({ environment: broken.name })).resources;
    expect(before).toHaveLength(3);

    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 4;
    provider.state.health['db-main'] = 'down';
    provider.state.events.push({
      resource: 'svc-api',
      kind: 'alert',
      level: 'critical',
      value: null,
      // After the last refresh, so this one reads it.
      at: new Date().toISOString(),
      text: 'api errors are up',
    });
    const res = await refresh(id, registry);
    expect(res).toMatchObject({ ok: true, result: { environments: 1, resources: 3 } });
    expect(res.result.stale).toMatchObject([{ environmentId: broken.id, environment: broken.name }]);

    // The broken one keeps what it had, and says why it's stale.
    const kept = await inventory({ environment: broken.name });
    expect(kept.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(2);
    expect(kept.resources.map((r) => r.seen)).toEqual(before.map((r) => r.seen));
    expect(kept.stale).toEqual([
      expect.objectContaining({
        environmentId: broken.id,
        repo: 'widgets',
        environment: broken.name,
        provider: id,
        error: `Fake platform couldn’t discover widgets’s ${broken.name}: Fake platform answered 500`,
        seen: before[0].seen,
      }),
    ]);

    // The other is written as normal: its inventory, its health, and its alerts.
    const fresh = await inventory({ environment: good.name });
    expect(fresh.stale).toEqual([]);
    expect(fresh.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(4);
    expect(fresh.resources.find((r) => r.id === 'db-main').health.state).toBe('down');
    const signals = await body(await api(`infra/signals?environment=${good.name}`));
    expect(signals.signals.some((s) => s.kind === 'health' && s.resource === 'db-main' && s.level !== 'info')).toBe(
      true,
    );
    expect(signals.signals.some((s) => s.kind === 'alert' && /api errors are up/.test(s.text))).toBe(true);
    const quiet = await body(await api(`infra/signals?environment=${broken.name}`));
    expect(quiet.signals.some((s) => /api errors are up/.test(s.text))).toBe(false);

    // The overview sees it too.
    expect((await inventory({ provider: id })).stale.map((s) => s.environment)).toEqual([broken.name]);

    // Connections counts and names it, and a 5xx strikes no permission.
    const row = await runInDurableObject(store(), (s) => s.providerRecord(id));
    expect(row.discovery).toMatchObject({ ok: false });
    expect(row.discovery.error).toMatch(new RegExp(`^1 of 2 environments discovered; .*${broken.name}.*answered 500`));
    expect(row.permissions).toEqual(['Fake Alerts Read', 'Fake Services Read']);

    // Once it answers again, it's fresh.
    provider.discover = discover;
    expect((await refresh(id, registry)).ok).toBe(true);
    expect((await inventory({ provider: id })).stale).toEqual([]);
    expect(
      (await inventory({ environment: broken.name })).resources.find((r) => r.id === 'svc-api').attrs.instances,
    ).toBe(4);
    expect((await runInDurableObject(store(), (s) => s.providerRecord(id))).discovery).toMatchObject({ ok: true });
    await done();
  });

  it('a 403 naming a permission strikes it; the refresh still writes the other', async () => {
    const id = 'fake-split-403';
    const { provider, registry, good, broken } = await twoEnvironments(
      id,
      Object.assign(new Error('Fake platform refused: the token needs Fake Alerts Read'), {
        status: 403,
        permission: 'Fake Alerts Read',
      }),
    );
    const res = await refresh(id, registry);
    expect(res).toMatchObject({ ok: true, result: { environments: 1, resources: 3 } });
    expect((await inventory({ environment: good.name })).stale).toEqual([]);
    expect((await inventory({ environment: broken.name })).stale).toMatchObject([{ error: /needs Fake Alerts Read/ }]);
    const row = await runInDurableObject(store(), (s) => s.providerRecord(id));
    expect(row.permissions).toEqual(['Fake Services Read']);
    expect(row.discovery.error).toMatch(/^1 of 2 environments discovered/);

    // When the other environment reached the same permission in this run, the token is scoped, not missing it: it
    // comes back, and the refused environment is still stale. What the working one skipped stays on the row.
    const discover = provider.discover;
    provider.discover = async (ctx) => {
      const found = await discover(ctx);
      ctx.reached?.add('Fake Alerts Read');
      return { ...found, skipped: ['a zone it can’t read routes on'] };
    };
    expect((await refresh(id, registry)).ok).toBe(true);
    const scoped = await runInDurableObject(store(), (s) => s.providerRecord(id));
    expect(scoped.permissions).toEqual(['Fake Alerts Read', 'Fake Services Read']);
    expect(scoped.discovery).toMatchObject({ ok: false, skipped: ['a zone it can’t read routes on'] });
    expect((await inventory({ environment: broken.name })).stale).toMatchObject([{ error: /needs Fake Alerts Read/ }]);
    // One environment's 403 doesn't stop the cron: the refresh as a whole worked.
    const state = await body(await api('infra/inventory/refresh'));
    expect(state.providers.find((p) => p.provider === id).last).toMatchObject({ ok: true });
    await done();
  });

  it('a failed environment’s last zones still count for the others’ alerts', async () => {
    const id = 'fake-split-elsewhere';
    const { provider, registry, broken } = await twoEnvironments(id, new Error('gone'));
    /** @type {any[]} */
    const elsewhere = [];
    const events = provider.events;
    provider.events = async (ctx, since) => {
      elsewhere.push({ environment: ctx.environment, ids: (ctx.elsewhere ?? []).map((r) => r.id).sort() });
      return events(ctx, since);
    };
    await refresh(id, registry);
    expect(elsewhere).toEqual([{ environment: `${id}-good`, ids: ['db-main', 'route-api', 'svc-api'] }]);
    expect((await inventory({ environment: broken.name })).resources).toHaveLength(3);
    await done();
  });

  it('when every environment fails, the refresh fails and each keeps its last inventory', async () => {
    const id = 'fake-split-all';
    const { provider, registry, good, broken } = await twoEnvironments(id, new Error('down'));
    const discover = provider.discover;
    provider.discover = async (ctx) => {
      if (ctx.environment === good.name) throw Object.assign(new Error('also down'), { status: 503 });
      return discover(ctx);
    };
    const res = await refresh(id, registry);
    expect(res).toMatchObject({ ok: false, status: 502 });
    expect(res.error).toMatch(/\(and 1 more\)\. The last inventory is kept/);
    expect((await inventory({ provider: id })).resources).toHaveLength(6);
    expect((await inventory({ provider: id })).stale.map((s) => s.environment).sort()).toEqual(
      [broken.name, good.name].sort(),
    );
    const row = await runInDurableObject(store(), (s) => s.providerRecord(id));
    expect(row.discovery.error).toMatch(/^0 of 2 environments discovered/);
    await done();
  });
});

describe('the inventory refreshes by itself (BRK-248)', () => {
  const MINUTE = 60 * 1000;

  it('the cron refreshes a connected provider, skips one that isn’t, and waits 15 minutes between', async () => {
    const a = platform('fake-cron-a');
    const b = platform('fake-cron-b');
    const registry = new ProviderRegistry();
    registry.register(a.provider);
    registry.register(b.provider);
    await addEnvironment({ name: 'cron-a', kind: 'staging', provider: 'fake-cron-a', target: 'api' });
    await addEnvironment({ name: 'cron-b', kind: 'staging', provider: 'fake-cron-b', target: 'api' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = registry;
    });
    expect((await connect('fake-cron-a')).status).toBe(201);
    a.provider.calls.length = 0;

    const now = Date.now();
    await runInDurableObject(store(), async (s) => {
      s.inventoryRefreshSeen('fake-cron-a', { ok: true, source: 'connect' });
      s.sql.exec("UPDATE infra_inventory_refresh SET at = ? WHERE provider = 'fake-cron-a'", now - 16 * MINUTE);
    });
    const ran = await runInDurableObject(store(), (s) => s.inventoryTick(now));
    expect(ran.map((r) => r.provider)).toEqual(['fake-cron-a']);
    expect(a.provider.calls.filter((c) => c.method === 'discover')).toHaveLength(1);
    expect(b.provider.calls).toEqual([]);
    expect((await inventory({ provider: 'fake-cron-a' })).resources).toHaveLength(3);
    expect((await inventory({ provider: 'fake-cron-b' })).resources).toEqual([]);

    // Too soon for another look; 15 minutes on, it looks again.
    expect(await runInDurableObject(store(), (s) => s.inventoryTick(Date.now() + 5 * MINUTE))).toEqual([]);
    const later = await runInDurableObject(store(), (s) => s.inventoryTick(Date.now() + 16 * MINUTE));
    expect(later.map((r) => r.provider)).toEqual(['fake-cron-a']);
    await runInDurableObject(store(), (s) => {
      s.infraProviders = undefined;
    });
  });

  it('pasting a token fills the inventory at once', async () => {
    const { provider, registry } = platform('fake-connect');
    await addEnvironment({ name: 'connect-staging', kind: 'staging', provider: 'fake-connect', target: 'api' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = registry;
    });
    const res = await body(await connect('fake-connect'));
    expect(res).toMatchObject({ status: 201, connected: true, inventory: { ok: true, resources: 3 } });
    expect(provider.calls.filter((c) => c.method === 'discover')).toHaveLength(1);
    expect((await inventory({ provider: 'fake-connect' })).resources).toHaveLength(3);
    const state = await body(await api('infra/inventory/refresh'));
    expect(state.providers.find((p) => p.provider === 'fake-connect')).toMatchObject({
      connected: true,
      targets: 1,
      running: false,
      last: { ok: true, error: null, source: 'connect' },
    });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = undefined;
    });
  });

  it('keeps an error and shows it; a refused token waits for a new one', async () => {
    const { provider, registry } = platform('fake-refused');
    await addEnvironment({ name: 'refused-staging', kind: 'staging', provider: 'fake-refused', target: 'api' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = registry;
    });
    const discover = provider.discover;
    provider.discover = async () => {
      throw Object.assign(new Error('Fake platform answered 403: not allowed'), { status: 403 });
    };
    const connected = await body(await connect('fake-refused'));
    expect(connected).toMatchObject({ status: 201, inventory: { ok: false } });
    expect(connected.inventory.error).toMatch(
      /couldn’t discover widgets’s refused-staging: Fake platform answered 403/,
    );

    const state = await body(await api('infra/inventory/refresh'));
    const row = state.providers.find((p) => p.provider === 'fake-refused');
    expect(row).toMatchObject({ last: { ok: false, source: 'connect' }, next: null });
    expect(row.last.error).toMatch(/answered 403/);

    // The cron doesn't try the refused token again, however long it waits.
    provider.discover = discover;
    provider.calls.length = 0;
    expect(await runInDurableObject(store(), (s) => s.inventoryTick(Date.now() + 60 * MINUTE))).toEqual([]);
    expect(provider.calls).toEqual([]);

    // A new token, and the board looks again at once.
    const again = await body(await connect('fake-refused'));
    expect(again).toMatchObject({ status: 200, inventory: { ok: true, resources: 3 } });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = undefined;
    });
  });

  it('one refresh per provider at a time', async () => {
    // A platform that needs no token, so it's connected as it stands.
    const provider = fakeProvider({ id: 'fake-busy', readToken: false });
    const registry = new ProviderRegistry();
    registry.register(provider);
    await addEnvironment({ name: 'busy-staging', kind: 'staging', provider: 'fake-busy', target: 'api' });
    const discover = provider.discover;
    /** @type {(() => void) | null} */
    let go = null;
    provider.discover = async (ctx) => {
      await new Promise((resolve) => {
        go = () => resolve(undefined);
      });
      return discover(ctx);
    };
    const out = await runInDurableObject(store(), async (s) => {
      const first = s.refreshInventoryNow('fake-busy', { registry });
      await Promise.resolve();
      const second = await s.refreshInventoryNow('fake-busy', { registry }).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, status: error.status, error: error.message }),
      );
      const skipped = await s.inventoryTick(Date.now(), { registry });
      // The first refresh is at the platform now.
      while (!go) await new Promise((resolve) => setTimeout(resolve, 1));
      go();
      return { second, skipped, first: await first };
    });
    expect(out.second).toMatchObject({ ok: false, status: 409, error: /looking at fake-busy already/ });
    expect(out.skipped).toEqual([]);
    expect(out.first).toMatchObject({ provider: 'fake-busy', resources: 3 });
  });

  it('refuses to look at a provider with no token yet, and keeps nothing', async () => {
    const { provider, registry } = platform('fake-unconnected');
    await addEnvironment({ name: 'unconnected-staging', kind: 'staging', provider: 'fake-unconnected', target: 'api' });
    const out = await runInDurableObject(store(), (s) =>
      s.refreshInventoryNow('fake-unconnected', { registry }).then(
        () => ({ ok: true }),
        (error) => ({
          ok: false,
          status: error.status,
          error: error.message,
          row: s.inventoryRefreshRow('fake-unconnected'),
        }),
      ),
    );
    expect(out).toMatchObject({
      ok: false,
      status: 409,
      error: /connect Fake platform on Connections first/,
      row: null,
    });
    expect(provider.calls).toEqual([]);
  });

  it('the owner’s Refresh with no provider looks at every connected one', async () => {
    const { registry } = platform('fake-all');
    await addEnvironment({ name: 'all-staging', kind: 'staging', provider: 'fake-all', target: 'api' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = registry;
    });
    await connect('fake-all');
    const res = await body(await boardApi('infra/inventory/refresh', { method: 'POST', body: {} }));
    expect(res.status).toBe(200);
    expect(res.refreshed).toEqual([expect.objectContaining({ ok: true, provider: 'fake-all', resources: 3 })]);
    expect(res.providers.find((p) => p.provider === 'fake-all').last).toMatchObject({ ok: true, source: 'owner' });
    await runInDurableObject(store(), (s) => {
      s.infraProviders = undefined;
    });
  });
});
