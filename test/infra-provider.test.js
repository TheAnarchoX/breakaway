import { describe, expect, it } from 'vitest';
import {
  checkApplyResult,
  checkCosts,
  checkDiscovery,
  checkPlan,
  checkProvider,
  checkSignals,
  declares,
  desiredFrom,
  ProviderRegistry,
  providers,
} from '../src/infra-provider.js';
import { fakeProvider } from './fake-infra-provider.js';
import { providerContract } from './infra-provider-contract.js';

const CTX = { environment: 'staging' };

/** The fake's platform with the api scaled to 4, a cache added, and the route removed. */
function changed(provider) {
  const resources = provider.state.resources
    .filter((r) => r.id !== 'route-api')
    .map((r) => (r.id === 'svc-api' ? { ...r, attrs: { ...r.attrs, instances: 4 } } : structuredClone(r)));
  resources.push({ id: 'db-cache', kind: 'database', name: 'cache', attrs: { size: 'small' } });
  return { resources };
}

providerContract('fake', () => {
  const provider = fakeProvider();
  return { provider, ctx: CTX, desired: changed(provider), since: '2026-10-01T00:00:00Z' };
});

describe('the fake provider', () => {
  it('plans a scale for a change to instances only, and an update for anything else', async () => {
    const provider = fakeProvider();
    const plan = await provider.plan(CTX, changed(provider));
    expect(plan.changes.map((c) => [c.op, c.resource])).toEqual([
      ['scale', 'svc-api'],
      ['create', 'db-cache'],
      ['delete', 'route-api'],
    ]);
    const desired = desiredFrom(await provider.discover(CTX));
    desired.resources[0].attrs.version = '1.1.0';
    expect((await provider.plan(CTX, desired)).changes.map((c) => c.op)).toEqual(['update']);
  });

  it("says deleting a database can't be undone, and why", async () => {
    const provider = fakeProvider();
    const desired = { resources: provider.state.resources.filter((r) => r.id !== 'db-main') };
    const plan = await provider.plan(CTX, desired);
    expect(plan.reversible).toBe(false);
    expect(plan.changes[0]).toMatchObject({ op: 'delete', reversible: false, why: expect.stringMatching(/data/u) });
  });

  it('stops at a step the platform refuses, and records each call with its environment', async () => {
    const provider = fakeProvider({ failOn: ['db-cache'] });
    const plan = await provider.plan(CTX, changed(provider));
    const result = checkApplyResult(provider, plan, await provider.apply(CTX, plan));
    expect(result).toMatchObject({ ok: false, steps: [{ ok: true }, { ok: false, resource: 'db-cache' }] });
    expect(provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances).toBe(4);
    expect(provider.state.resources.some((r) => r.id === 'route-api')).toBe(true);
    expect(provider.calls).toEqual([
      { method: 'plan', environment: 'staging' },
      { method: 'apply', environment: 'staging' },
    ]);
  });

  it('restarts a service, which only kinds that declare it can do', async () => {
    const provider = fakeProvider();
    expect(declares(provider, 'service', 'restart')).toBe(true);
    expect(declares(provider, 'database', 'restart')).toBe(false);
    expect(declares(provider, 'queue', 'create')).toBe(false);
    const attrs = provider.state.resources[0].attrs;
    const restart = { op: 'restart', resource: 'svc-api', kind: 'service', name: 'api', before: attrs, after: attrs };
    const plan = {
      provider: 'fake',
      environment: 'staging',
      changes: [{ ...restart, reversible: true }],
      reversible: true,
    };
    expect((await provider.apply(CTX, plan)).ok).toBe(true);
    expect(provider.state.restarts['svc-api']).toBe(1);
    const db = { ...restart, resource: 'db-main', kind: 'database', name: 'main', reversible: true };
    await expect(provider.apply(CTX, { ...plan, changes: [db] })).rejects.toThrow(/database db-main can't restart/u);
  });

  it('shows drift: a change by hand on the platform plans back to the desired state', async () => {
    const provider = fakeProvider();
    const desired = desiredFrom(await provider.discover(CTX));
    provider.state.resources[1].attrs.size = 'large';
    const plan = await provider.plan(CTX, desired);
    expect(plan.changes).toMatchObject([{ op: 'update', resource: 'db-main', after: { size: 'small' } }]);
  });
});

describe('provider checks', () => {
  const provider = fakeProvider();

  it('refuses a provider without an id, a method, or the base changes', () => {
    expect(() => checkProvider({ ...provider, id: 'Fake Cloud' })).toThrow(/id must be lowercase/u);
    expect(() => checkProvider({ ...provider, events: undefined })).toThrow(/no events\(\)/u);
    expect(() => checkProvider({ ...provider, kinds: {} })).toThrow(/no resource kinds/u);
    expect(() => checkProvider({ ...provider, kinds: { service: { changes: ['create', 'update'] } } })).toThrow(
      /service can't delete/u,
    );
    expect(() =>
      checkProvider({ ...provider, kinds: { service: { changes: ['create', 'update', 'delete', 'resize'] } } }),
    ).toThrow(/unknown change "resize"/u);
  });

  it('refuses a discovery with a duplicate, an undeclared kind, or a relation to nothing', () => {
    const r = { id: 'a', kind: 'service', name: 'a' };
    expect(() => checkDiscovery(provider, { resources: [r, r], relations: [] })).toThrow(/listed twice/u);
    expect(() => checkDiscovery(provider, { resources: [{ ...r, kind: 'queue' }], relations: [] })).toThrow(
      /doesn't declare/u,
    );
    expect(() =>
      checkDiscovery(provider, { resources: [r], relations: [{ from: 'a', to: 'b', kind: 'uses' }] }),
    ).toThrow(/names b/u);
  });

  it("refuses a plan whose changes don't add up", () => {
    const create = {
      op: 'create',
      resource: 'a',
      kind: 'service',
      name: 'a',
      before: null,
      after: {},
      reversible: true,
    };
    const plan = { provider: 'fake', environment: 'staging', changes: [create], reversible: true };
    expect(() => checkPlan(provider, plan, CTX)).not.toThrow();
    expect(() => checkPlan(provider, plan, { environment: 'production' })).toThrow(/is for staging/u);
    expect(() => checkPlan(provider, { ...plan, reversible: false })).toThrow(/reversible/u);
    expect(() => checkPlan(provider, { ...plan, changes: [{ ...create, before: {} }] })).toThrow(/wrong before/u);
    expect(() => checkPlan(provider, { ...plan, changes: [{ ...create, op: 'scale', kind: 'route' }] })).toThrow(
      /route a can't scale/u,
    );
    const gone = { ...create, op: 'delete', before: {}, after: null, reversible: false };
    expect(() => checkPlan(provider, { ...plan, changes: [gone], reversible: false })).toThrow(/doesn't say why/u);
  });

  it('refuses an apply result that skips, reorders, or hides a failure', () => {
    const c = (resource) => ({ op: 'update', resource, kind: 'service', name: resource, before: {}, after: {} });
    const plan = { provider: 'fake', environment: 'staging', changes: [c('a'), c('b')], reversible: true };
    const ok = (resource) => ({ resource, op: 'update', ok: true });
    expect(() => checkApplyResult(provider, plan, { ok: true, steps: [ok('a'), ok('b')] })).not.toThrow();
    expect(() => checkApplyResult(provider, plan, { ok: true, steps: [ok('a')] })).toThrow(/ok doesn't match/u);
    expect(() => checkApplyResult(provider, plan, { ok: false, steps: [ok('b')] })).toThrow(/isn't the plan's/u);
    const bad = { resource: 'a', op: 'update', ok: false };
    expect(() => checkApplyResult(provider, plan, { ok: false, steps: [bad] })).toThrow(/without saying why/u);
    const failed = { ...bad, error: 'no' };
    expect(() => checkApplyResult(provider, plan, { ok: false, steps: [failed, ok('b')] })).toThrow(/later steps/u);
  });

  it('refuses a cost that is not an estimate, or a signal out of order or from elsewhere', () => {
    expect(() => checkCosts(provider, [{ resource: 'a', amount: 1, currency: 'USD', estimate: false }])).toThrow(
      /estimate/u,
    );
    expect(() => checkCosts(provider, [{ resource: 'a', amount: -1, currency: 'USD', estimate: true }])).toThrow(
      /no amount/u,
    );
    const s = {
      source: 'fake',
      environment: 'staging',
      resource: null,
      kind: 'alert',
      level: 'warning',
      value: null,
      at: '2026-10-02T00:00:00Z',
      text: 'x',
    };
    const since = '2026-10-01T00:00:00Z';
    expect(() => checkSignals(provider, CTX, since, [s])).not.toThrow();
    expect(() => checkSignals(provider, CTX, since, [s, { ...s, at: since }])).toThrow(/out of order/u);
    expect(() => checkSignals(provider, CTX, since, [{ ...s, source: 'other' }])).toThrow(/from other/u);
    expect(() => checkSignals(provider, CTX, since, [{ ...s, level: 'page' }])).toThrow(/unknown level/u);
    expect(() => checkSignals(provider, CTX, since, [{ ...s, text: 'x'.repeat(501) }])).toThrow(/longer than 500/u);
  });
});

describe('the provider registry', () => {
  it('registers checked providers by id, refuses a second with the same id, and lists them', () => {
    const registry = new ProviderRegistry();
    const b = registry.register(fakeProvider({ id: 'fake-b' }));
    const a = registry.register(fakeProvider({ id: 'fake-a' }));
    expect(registry.get('fake-b')).toBe(b);
    expect(registry.has('fake-a')).toBe(true);
    expect(registry.list()).toEqual([a, b]);
    expect(() => registry.register(fakeProvider({ id: 'fake-a' }))).toThrow(/already registered/u);
    expect(() => registry.register({ id: 'x' })).toThrow(/no name/u);
    expect(() => registry.get('nope')).toThrow(/no provider nope \(registered: fake-a, fake-b\)/u);
  });

  it('starts empty in the Worker: the core names no vendor', () => {
    expect(providers.list()).toEqual([]);
    expect(() => providers.get('fake')).toThrow(/registered: none/u);
  });
});
