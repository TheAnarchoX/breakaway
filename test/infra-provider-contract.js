/**
 * The contract every Architect provider passes (BRK-173): the fake one in infra-provider.test.js, and each real one in
 * its own test file, with the platform's API mocked. Call `providerContract(name, setup)` inside a test file; `setup`
 * makes a fresh provider for each test, the context to call it with, a desired state that differs from what it
 * discovers, and a time to ask for events since.
 *
 * A real provider is built a step at a time. `notYet` names the steps it doesn't have yet, each with the task that
 * builds it (`{ plan: 'BRK-192' }`): those steps must refuse, saying they aren't built yet, and the tests that need them
 * show as todo, naming the task. The task that builds a step takes it out of `notYet`.
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

/** The steps each test needs, besides `discover`. */
const NEEDS = {
  plan: ['plan'],
  apply: ['plan', 'apply'],
  observe: ['observe'],
  cost: ['cost'],
  events: ['events'],
};

/**
 * @param {string} name
 * @param {() => ContractSetup | Promise<ContractSetup>} setup
 * @param {{ notYet?: Partial<Record<'plan' | 'apply' | 'observe' | 'cost' | 'events', string>> }} [options]
 */
export function providerContract(name, setup, { notYet = {} } = {}) {
  /** `it`, or a todo naming the task that builds a step the test needs. */
  const step = (need) => {
    const missing = NEEDS[need].filter((s) => notYet[s]);
    if (!missing.length) return it;
    const tasks = [...new Set(missing.map((s) => notYet[s]))].join(', ');
    return (/** @type {string} */ title) => it.todo(`${title} (once ${tasks} builds ${missing.join(' and ')})`);
  };

  describe(`provider contract: ${name}`, () => {
    for (const [method, task] of Object.entries(notYet))
      it(`says ${method} isn't built yet, naming ${task}`, async () => {
        const { provider, ctx, desired, since } = await setup();
        const none = { provider: provider.id, environment: ctx.environment, changes: [], reversible: true };
        const args = { plan: [desired], apply: [none], observe: [], cost: [], events: [since] }[method];
        await expect(provider[method](ctx, ...args)).rejects.toThrow(new RegExp(`isn't built yet \\(${task}\\)`, 'u'));
      });

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

    step('plan')('plans no changes when the desired state is what exists', async () => {
      const { provider, ctx } = await setup();
      const found = await provider.discover(ctx);
      const plan = checkPlan(provider, await provider.plan(ctx, desiredFrom(found)), ctx);
      expect(plan.changes).toEqual([]);
      expect(plan.reversible).toBe(true);
    });

    step('plan')('plans changes it declares, each saying whether it can be undone', async () => {
      const { provider, ctx, desired } = await setup();
      checkDesired(provider, desired);
      const plan = checkPlan(provider, await provider.plan(ctx, desired), ctx);
      expect(plan.changes.length).toBeGreaterThan(0);
      for (const c of plan.changes) {
        if (ENVELOPE_CHANGES.includes(c.op)) expect(declares(provider, c.kind, c.op)).toBe(true);
        if (!c.reversible) expect(c.why).toBeTruthy();
      }
    });

    step('apply')('applies a plan and then plans nothing more', async () => {
      const { provider, ctx, desired } = await setup();
      const plan = await provider.plan(ctx, desired);
      const result = checkApplyResult(provider, plan, await provider.apply(ctx, plan));
      expect(result.ok).toBe(true);
      expect(result.steps).toHaveLength(plan.changes.length);
      checkDiscovery(provider, await provider.discover(ctx));
      expect((await provider.plan(ctx, desired)).changes).toEqual([]);
    });

    step('plan')(
      'refuses to apply in an observe-only environment, or a plan for another environment or provider',
      async () => {
        const { provider, ctx, desired } = await setup();
        const before = await provider.discover(ctx);
        const plan = await provider.plan(ctx, desired);
        await expect(provider.apply({ ...ctx, observeOnly: true }, plan)).rejects.toThrow(/observe only/u);
        await expect(provider.apply({ ...ctx, environment: `${ctx.environment}-other` }, plan)).rejects.toThrow(
          /is for/u,
        );
        await expect(provider.apply(ctx, { ...plan, provider: `${provider.id}-other` })).rejects.toThrow(/made by/u);
        expect(await provider.discover(ctx)).toEqual(before);
      },
    );

    step('observe')('observes a health for each resource it discovers', async () => {
      const { provider, ctx } = await setup();
      const found = await provider.discover(ctx);
      const health = checkHealth(provider, await provider.observe(ctx));
      expect(health.map((h) => h.resource).sort()).toEqual(found.resources.map((r) => r.id).sort());
    });

    step('cost')('estimates a cost for resources it discovers', async () => {
      const { provider, ctx } = await setup();
      const ids = new Set((await provider.discover(ctx)).resources.map((r) => r.id));
      for (const c of checkCosts(provider, await provider.cost(ctx))) expect(ids.has(c.resource)).toBe(true);
    });

    step('events')('reports events since a time, oldest first, as signals for its environment', async () => {
      const { provider, ctx, since } = await setup();
      checkSignals(provider, ctx, since, await provider.events(ctx, since));
      const later = new Date(Date.parse(since) + 365 * 86_400_000).toISOString();
      checkSignals(provider, ctx, later, await provider.events(ctx, later));
    });
  });
}
