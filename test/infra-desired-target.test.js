import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';

// An environment with no target takes it from its merged desired state (BRK-309): after Clear the target, Compare,
// the inventory, and the next plan use the one service its file makes, and the environment gets it on Approve.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakedesiredtarget';

/** Runs the store's own call and returns what it gave or the error. */
const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

describe('an environment with no target and a merged desired state (BRK-309)', () => {
  let cookie;
  let provider;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const service = (name) => ({ id: `svc-${name}`, kind: 'service', name, attrs: { instances: 1 } });
  /** Keeps `resources` as the environment's desired state, as a read of its file from main would. */
  const want = (name, resources, sha = `sha-${name}`) =>
    runInDurableObject(store(), (instance) => {
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        `${name}.json`,
        name,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify({ version: 1, provider: PROVIDER, resources }),
        sha,
        Date.now(),
      );
      instance.setGhMeta('infra_desired_read', 'widgets', JSON.stringify({ sha, branch: 'main' }));
    });
  const add = async (name) => {
    const made = await body(
      await board('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name, kind: 'production' },
      }),
    );
    envs[name] = made.environment;
    return made.environment;
  };
  const view = async (name) => (await body(await api(`infra/environments/${envs[name].id}`))).environment;
  const plans = async (name) => (await body(await api(`infra/plans?environment=${envs[name].id}&limit=50`))).plans;
  const audit = async (name) => (await body(await api(`infra/audit?environmentId=${envs[name].id}`))).entries;

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    // Nothing runs yet: the first apply failed before applying anything.
    provider = fakeProvider({
      id: PROVIDER,
      state: { resources: [], relations: [], health: {}, costs: {}, restarts: {}, events: [] },
    });
    await runInDurableObject(store(), (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      instance.pushInfraPlan = async () => {};
      // The executor isn't this test's: an approved plan is only queued.
      instance.queueInfraRun = () => {};
      instance.soonInfraRuns = async () => {};
    });
    await add('acme-prod');
    await add('acme-two');
    await add('acme-own');
  });

  it('says which target its file gives it, and that Compare plans with it', async () => {
    expect((await view('acme-prod')).desiredTarget).toBeNull();
    await want('acme-prod', [service('acme-api')]);
    expect(await view('acme-prod')).toMatchObject({
      target: null,
      desiredTarget: { name: 'acme-api', file: 'acme-prod.json', problem: null },
    });
  });

  it('drafts the plan that builds it on Compare, with that target, and gives it nothing yet', async () => {
    const res = await body(await board(`infra/drift/${envs['acme-prod'].id}`, { method: 'POST', body: {} }));
    expect(res).toMatchObject({ status: 200, drift: { count: 1, error: null } });
    const [plan] = await plans('acme-prod');
    expect(plan).toMatchObject({ id: res.drift.plan, target: 'acme-api', changes: 1 });
    expect(provider.calls.filter((c) => c.method === 'plan' && c.environment === 'acme-prod')).not.toEqual([]);
    expect((await view('acme-prod')).target).toBeNull();
    const drafted = (await audit('acme-prod')).find((e) => e.plan === plan.id && e.outcome === 'draft');
    expect(drafted.summary).toMatch(/builds acme-api, acme-prod’s target once you approve it/u);
  });

  it('looks for it in the inventory before it’s given, and finds nothing until it’s built', async () => {
    const got = await inStore((s) => s.refreshInventory(PROVIDER));
    expect(got.ok).toBe(true);
    expect(provider.calls.filter((c) => c.method === 'discover' && c.environment === 'acme-prod')).not.toEqual([]);
  });

  it('waits for the owner whatever the policy says, and only the owner’s Approve gives the target', async () => {
    const [plan] = await plans('acme-prod');
    await inStore((s) => s.moveInfraPlan(plan.id, 'waiting', { by: 'owner' }));
    expect(await inStore((s) => s.approveInfraPlan(plan.id, { by: 'board' }))).toMatchObject({
      ok: false,
      status: 409,
      error: `${plan.id} gives acme-prod its target, acme-api: only the owner approves that, on the board`,
    });
    expect((await view('acme-prod')).target).toBeNull();
    expect(
      await inStore((s) => s.settleInfraPlan({ id: plan.id, policy: { outcome: 'allowed', rule: 'x' } })),
    ).toMatchObject({ ok: true });
    expect((await plans('acme-prod'))[0].state).toBe('waiting');

    const approved = await inStore((s) => s.approveInfraPlan(plan.id, { by: 'owner' }));
    expect(approved).toMatchObject({ ok: true, value: { state: 'approved', target: 'acme-api' } });
    expect(await view('acme-prod')).toMatchObject({ target: 'acme-api', desiredTarget: null });
    const given = (await audit('acme-prod')).find((e) => e.kind === 'environment' && e.plan === plan.id);
    expect(given).toMatchObject({
      by: 'owner',
      outcome: 'changed',
      environment: 'acme-prod',
      environmentId: envs['acme-prod'].id,
      summary: `acme-prod’s target is acme-api, from the desired state on main, approved by the owner with ${plan.id}`,
    });
  });

  it('refuses in words when the file makes two, and plans nothing', async () => {
    await want('acme-two', [service('acme-web'), service('acme-jobs')]);
    const problem =
      'acme-two has no target, and its desired state makes 2 Services (acme-web, acme-jobs): set which one is its target on the board, then it plans';
    expect((await view('acme-two')).desiredTarget).toEqual({ name: null, file: 'acme-two.json', problem });
    const res = await body(await board(`infra/drift/${envs['acme-two'].id}`, { method: 'POST', body: {} }));
    expect(res).toMatchObject({ status: 409, error: problem });
    expect(await inStore((s) => s.makeInfraPlan(envs['acme-two'].id, { source: 'drift', by: 'board' }))).toMatchObject({
      ok: false,
      status: 409,
      error: problem,
    });
    expect(await plans('acme-two')).toEqual([]);
  });

  it('never takes the board’s own Worker as a target', async () => {
    await want('acme-own', [{ ...service('widgets-tasks'), id: 'svc-own' }]);
    const { desiredTarget } = await view('acme-own');
    expect(desiredTarget).toMatchObject({ name: null });
    expect(desiredTarget.problem).toMatch(/widgets-tasks, is the one this board runs on/u);
    const res = await body(await board(`infra/drift/${envs['acme-own'].id}`, { method: 'POST', body: {} }));
    expect(res).toMatchObject({ status: 409, error: desiredTarget.problem });
  });
});
