/**
 * The contract every Architect provider passes (BRK-173): the fake one in infra-provider.test.js, and each real one in
 * its own test file, with the platform's API mocked. Call `providerContract(name, setup)` inside a test file; `setup`
 * makes a fresh provider for each test, the context to call it with, a desired state that differs from what it
 * discovers, and a time to ask for events since.
 */
import { describe, expect, it } from 'vitest';
import {
  checkApplyResult,
  checkCosts,
  checkDesired,
  checkDiscovery,
  checkHealth,
  checkPlan,
  checkProvider,
  checkSignals,
  declares,
  desiredFrom,
  ENVELOPE_CHANGES,
} from '../src/infra-provider.js';

/**
 * @typedef {object} ContractSetup
 * @property {import('../src/infra-provider.js').Provider} provider
 * @property {import('../src/infra-provider.js').ProviderContext} ctx
 * @property {import('../src/infra-provider.js').DesiredState} desired differs from what `discover` finds
 * @property {string} since events at or after this time, ISO 8601
 */

/**
 * @param {string} name
 * @param {() => ContractSetup | Promise<ContractSetup>} setup
 */
export function providerContract(name, setup) {
  describe(`provider contract: ${name}`, () => {
    it('has an id, a name, every method, and kinds that can create, update, and delete', async () => {
      const { provider } = await setup();
      expect(() => checkProvider(provider)).not.toThrow();
      for (const kind of Object.keys(provider.kinds))
        for (const op of ['create', 'update', 'delete']) expect(declares(provider, kind, op)).toBe(true);
    });

    it('discovers resources with relations between them', async () => {
      const { provider, ctx } = await setup();
      const found = checkDiscovery(provider, await provider.discover(ctx));
      expect(found.resources.length).toBeGreaterThan(0);
    });

    it('plans no changes when the desired state is what exists', async () => {
      const { provider, ctx } = await setup();
      const found = await provider.discover(ctx);
      const plan = checkPlan(provider, await provider.plan(ctx, desiredFrom(found)), ctx);
      expect(plan.changes).toEqual([]);
      expect(plan.reversible).toBe(true);
    });

    it('plans changes it declares, each saying whether it can be undone', async () => {
      const { provider, ctx, desired } = await setup();
      checkDesired(provider, desired);
      const plan = checkPlan(provider, await provider.plan(ctx, desired), ctx);
      expect(plan.changes.length).toBeGreaterThan(0);
      for (const c of plan.changes) {
        if (ENVELOPE_CHANGES.includes(c.op)) expect(declares(provider, c.kind, c.op)).toBe(true);
        if (!c.reversible) expect(c.why).toBeTruthy();
      }
    });

    it('applies a plan and then plans nothing more', async () => {
      const { provider, ctx, desired } = await setup();
      const plan = await provider.plan(ctx, desired);
      const result = checkApplyResult(provider, plan, await provider.apply(ctx, plan));
      expect(result.ok).toBe(true);
      expect(result.steps).toHaveLength(plan.changes.length);
      checkDiscovery(provider, await provider.discover(ctx));
      expect((await provider.plan(ctx, desired)).changes).toEqual([]);
    });

    it('refuses to apply in an observe-only environment, or a plan for another environment or provider', async () => {
      const { provider, ctx, desired } = await setup();
      const before = await provider.discover(ctx);
      const plan = await provider.plan(ctx, desired);
      await expect(provider.apply({ ...ctx, observeOnly: true }, plan)).rejects.toThrow(/observe only/u);
      await expect(provider.apply({ ...ctx, environment: `${ctx.environment}-other` }, plan)).rejects.toThrow(
        /is for/u,
      );
      await expect(provider.apply(ctx, { ...plan, provider: `${provider.id}-other` })).rejects.toThrow(/made by/u);
      expect(await provider.discover(ctx)).toEqual(before);
    });

    it('observes a health for each resource it discovers', async () => {
      const { provider, ctx } = await setup();
      const found = await provider.discover(ctx);
      const health = checkHealth(provider, await provider.observe(ctx));
      expect(health.map((h) => h.resource).sort()).toEqual(found.resources.map((r) => r.id).sort());
    });

    it('estimates a cost for resources it discovers', async () => {
      const { provider, ctx } = await setup();
      const ids = new Set((await provider.discover(ctx)).resources.map((r) => r.id));
      for (const c of checkCosts(provider, await provider.cost(ctx))) expect(ids.has(c.resource)).toBe(true);
    });

    it('reports events since a time, oldest first, as signals for its environment', async () => {
      const { provider, ctx, since } = await setup();
      checkSignals(provider, ctx, since, await provider.events(ctx, since));
      const later = new Date(Date.parse(since) + 365 * 86_400_000).toISOString();
      checkSignals(provider, ctx, later, await provider.events(ctx, later));
    });
  });
}
