import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { CLAUDE_LIMITS, PLANS, hourlyCeiling, planLimits } from '../src/plans.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
let next = 1;

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE || url === FIRE_BREAKAWAY) {
      const id = `session_${String(next++).padStart(4, '0')}`;
      return Response.json({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
}

const overview = async () => body(await api('agents'));
const settings = (patch) => api('agents/settings', { method: 'PATCH', body: patch });
const routines = async () => body(await api('routines'));

describe('Claude plan limits', () => {
  it('starts an hour: Claude’s 30 for each routine, never more than 100 for the account', () => {
    expect(hourlyCeiling(0)).toBe(30);
    expect(hourlyCeiling(1)).toBe(30);
    expect(hourlyCeiling(2)).toBe(60);
    expect(hourlyCeiling(5)).toBe(CLAUDE_LIMITS.accountHourly);
    expect(planLimits('max20', 1)).toMatchObject({ agents: PLANS.max20.agents.most, hourly: 30 });
    // An unknown plan is read as Pro, the board's limits from before plans.
    expect(planLimits('nope', 1).agents).toBe(PLANS.pro.agents.most);
  });

  it('every plan’s defaults sit inside its own ceilings, and each plan allows at least what the one before it does', () => {
    const order = Object.values(PLANS);
    for (const p of order) {
      expect(p.agents.default).toBeLessThanOrEqual(p.agents.most);
      expect(p.routinesDaily.default).toBeLessThanOrEqual(p.routinesDaily.most);
      expect(p.routineDaily.default).toBeLessThanOrEqual(p.routineDaily.most);
    }
    for (let i = 1; i < order.length; i++) {
      expect(order[i].agents.most).toBeGreaterThanOrEqual(order[i - 1].agents.most);
      expect(order[i].routinesDaily.most).toBeGreaterThanOrEqual(order[i - 1].routinesDaily.most);
    }
  });
});

describe('the Claude plan on the board', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('is Pro until the owner picks one, with the limits the board always had', async () => {
    const d = await overview();
    expect(d.settings).toMatchObject({ plan: 'pro', max: 3, hourly: 20 });
    expect(d.plans.map((p) => p.id)).toEqual(['pro', 'max5', 'max20']);
    expect(d.limits).toMatchObject({ agents: 6, hourly: 30, routineHourly: 30, accountHourly: 100 });
    expect((await routines()).settings).toMatchObject({
      dailyCap: 10,
      limits: { dailyCap: 100, routineDailyCap: 50, routineDailyDefault: 3 },
    });
    expect((await settings({ max: 7 })).status).toBe(400);
  });

  it('is the owner’s to pick, from the plans there are', async () => {
    expect((await settings({ plan: 'max5', by: 'claude-cld-1' })).status).toBe(403);
    expect((await settings({ plan: 'ultra' })).status).toBe(400);
    expect((await overview()).settings.plan).toBe('pro');
  });

  it('sets the limits to the plan’s defaults and lets them go up to its ceilings', async () => {
    const res = await body(await settings({ plan: 'max5' }));
    expect(res.settings).toMatchObject({ plan: 'max5', max: 6, hourly: 30 });
    const d = await overview();
    expect(d.limits).toMatchObject({ agents: 12, hourly: 30 });
    expect((await routines()).settings).toMatchObject({
      dailyCap: 25,
      limits: { dailyCap: 250, routineDailyCap: 100, routineDailyDefault: 6 },
    });
    expect((await body(await settings({ max: 12 }))).settings.max).toBe(12);
    expect((await settings({ max: 13 })).status).toBe(400);
    // Claude's limit for one routine is the same on every plan.
    expect((await settings({ hourly: 31 })).status).toBe(400);
    expect((await api('routines/settings', { method: 'PATCH', body: { dailyCap: 250 } })).status).toBe(200);
    expect((await api('routines/settings', { method: 'PATCH', body: { dailyCap: 251 } })).status).toBe(400);
    // A new routine starts with the plan's default daily cap, and can go up to its ceiling.
    const made = await body(
      await api('routines', { method: 'POST', body: { slug: 'sweep', name: 'Sweep', prompt: 'Sweep.' } }),
    );
    expect(made.routine.dailyCap).toBe(6);
    expect((await api('routines/sweep', { method: 'PATCH', body: { dailyCap: 80 } })).status).toBe(200);
    expect((await api('routines/sweep', { method: 'PATCH', body: { dailyCap: 101 } })).status).toBe(400);
  });

  it('sets the cap for all routines by itself, leaving pause alone (CLD-199)', async () => {
    await api('routines/settings', { method: 'PATCH', body: { paused: true } });
    const res = await body(await api('routines/settings', { method: 'PATCH', body: { dailyCap: 40 } }));
    expect(res.settings).toMatchObject({ paused: true, dailyCap: 40 });
    expect((await api('routines/settings', { method: 'PATCH', body: { dailyCap: 0 } })).status).toBe(400);
    await api('routines/settings', { method: 'PATCH', body: { paused: false } });
  });

  it('a change of plan resets what the owner set and brings caps above the new ceilings down', async () => {
    await settings({ max: 9, hourly: 12 });
    const res = await body(await settings({ plan: 'pro' }));
    expect(res.settings).toMatchObject({ plan: 'pro', max: 3, hourly: 20 });
    const r = await routines();
    expect(r.settings.dailyCap).toBe(10);
    expect(r.routines.find((x) => x.slug === 'sweep').dailyCap).toBe(50);
    // A plan and a limit in one request: the limit is checked against the new plan.
    expect((await body(await settings({ plan: 'max20', max: 20 }))).settings).toMatchObject({ plan: 'max20', max: 20 });
  });

  it('lets a repository’s cap on agents go up to the plan’s, and clamps it when the plan goes down', async () => {
    expect(
      (
        await api('repos', {
          method: 'POST',
          body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
        })
      ).status,
    ).toBe(201);
    expect((await api('repos/breakaway', { method: 'PATCH', body: { routine: { max: 20 } } })).status).toBe(200);
    expect((await api('repos/breakaway', { method: 'PATCH', body: { routine: { max: 25 } } })).status).toBe(400);
    // Two connected routines (the default repository's and breakaway's): starts an hour can go to 60.
    expect((await overview()).limits.hourly).toBe(60);
    expect((await body(await settings({ hourly: 60 }))).settings.hourly).toBe(60);
    expect((await settings({ hourly: 61 })).status).toBe(400);
    await settings({ plan: 'pro' });
    const { repos } = await overview();
    expect(repos.find((r) => r.slug === 'breakaway').caps.max).toBe(6);
    expect((await api('repos/breakaway', { method: 'PATCH', body: { routine: { max: 7 } } })).status).toBe(400);
  });

  it('never starts more than Claude allows one routine in an hour, whatever the board’s budget', async () => {
    await settings({ max: 6, hourly: 60 });
    expect(
      (
        await api('tasks', {
          method: 'POST',
          body: [{ description: 'Footer links', project: 'product', tags: ['agent'], horizon: 'now' }],
        })
      ).status,
    ).toBe(201);
    // 30 starts in the default repository this hour, from runs that are already over.
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('samewave')), (instance) => {
      for (let i = 0; i < 30; i++)
        instance.sql.exec(
          "INSERT INTO agent_runs (task, agent, trigger, status, started, repo) VALUES ('gone', 'claude-x', 'manual', 'started', ?, 'samewave')",
          Date.now() - 60_000,
        );
    });
    const res = await body(await api('agents/start', { method: 'POST', body: { ref: 'PRD-1' } }));
    expect(res.status).toBe(429);
    expect(res.error).toMatch(/Claude’s limit for its routine/);
    const plan = await body(await api('agents/next', { method: 'POST', body: { count: 1, dryRun: true } }));
    expect(plan.started).toEqual([]);
  });
});
