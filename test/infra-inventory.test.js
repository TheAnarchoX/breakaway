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
    expect(failed.error).toMatch(/couldn’t discover widgets’s fail-staging: the platform is down\. Nothing changed/);
    expect((await inventory({ provider: 'fake-fail' })).resources).toHaveLength(3);

    provider.discover = discover;
    provider.observe = async () => {
      throw new Error('no health today');
    };
    provider.state.costs['svc-api'] = 7;
    expect((await refresh('fake-fail', registry)).ok).toBe(true);
    const api_ = (await inventory({ provider: 'fake-fail' })).resources.find((r) => r.id === 'svc-api');
    expect(api_.health).toMatchObject({ state: 'healthy' });
    expect(api_.cost.amount).toBe(7);
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

  it('a refresh through the API is the owner’s, and names the provider', async () => {
    const agent = await body(
      await api('infra/inventory/refresh', { method: 'POST', body: { provider: 'fake', by: 'claude-x' } }),
    );
    expect(agent.status).toBe(403);
    const none = await body(await api('infra/inventory/refresh', { method: 'POST', body: {} }));
    expect(none.status).toBe(400);
    const unknown = await body(await api('infra/inventory/refresh', { method: 'POST', body: { provider: 'nowhere' } }));
    expect(unknown.status).toBe(404);
    expect(unknown.error).toMatch(/no provider nowhere/);
  });
});
