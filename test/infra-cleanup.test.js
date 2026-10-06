import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { DRIFT_EVERY_MS, driftChanges } from '../src/infra-drift.js';
import { breakGlassKeys } from '../src/infra-break-glass.js';
import { CLEANUP_GRACE_MS, cleanupDue, ownedBecause, unownedResources, unownedView } from '../src/infra-cleanup.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakecleanup';
const ENV = 'cleanup-staging';

const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

describe('clean up, the pure part (BRK-201)', () => {
  const del = (resource, over = {}) => ({
    op: 'delete',
    resource,
    kind: 'service',
    name: resource,
    before: {},
    after: null,
    reversible: true,
    ...over,
  });
  const diff = (changes) => ({ provider: 'fake', environment: 'staging', changes, reversible: true });
  const context = (over = {}) => ({
    target: 'svc-api',
    inScope: new Set(['svc-api', 'svc-old', 'db-old', 'svc-glass']),
    brokenGlass: new Set(['svc-glass']),
    ...over,
  });

  it('flags only deletes in scope that aren’t the target or covered by break-glass', () => {
    const d = diff([
      del('svc-old', { name: 'acme-old' }),
      del('db-old', { kind: 'database', name: 'acme-db-old' }),
      del('svc-api'),
      del('svc-elsewhere'),
      del('svc-glass'),
      { ...del('svc-api'), op: 'update', after: { instances: 3 } },
    ]);
    expect(unownedResources(d, context())).toEqual([
      { id: 'svc-old', kind: 'service', name: 'acme-old' },
      { id: 'db-old', kind: 'database', name: 'acme-db-old' },
    ]);
    expect(ownedBecause(del('svc-api'), context())).toBe('target');
    expect(ownedBecause(del('x', { name: 'svc-api' }), context())).toBe('target');
    expect(ownedBecause(del('svc-elsewhere'), context())).toBe('scope');
    expect(ownedBecause(del('svc-glass'), context())).toBe('break-glass');
    expect(ownedBecause(del('svc-old'), context())).toBeNull();
  });

  it('leaves deletes out of drift', () => {
    const update = { ...del('svc-api'), op: 'update', after: { instances: 3 } };
    const lost = del('db-old', { reversible: false, why: 'its data goes' });
    expect(driftChanges({ ...diff([update, lost]), reversible: false })).toEqual({
      ...diff([update]),
      reversible: true,
    });
  });

  it('proposes removal once the grace period is over', () => {
    const now = Date.now();
    expect(cleanupDue(now - 1000, now)).toBe(false);
    expect(cleanupDue(now - CLEANUP_GRACE_MS, now)).toBe(true);
  });

  it('shows a flag with when it can be removed, and a rejected removal as kept', () => {
    const flagged = Date.parse('2026-10-01T00:00:00Z');
    const row = { rid: 'db-old', kind: 'database', name: 'acme-db-old', flagged, plan: 4, error: null };
    expect(unownedView(row, 'rejected')).toEqual({
      id: 'db-old',
      kind: 'database',
      name: 'acme-db-old',
      flagged: '2026-10-01T00:00:00.000Z',
      removeAfter: new Date(flagged + CLEANUP_GRACE_MS).toISOString(),
      plan: { id: 'plan-4', state: 'rejected' },
      kept: true,
      error: null,
    });
    expect(unownedView({ ...row, plan: null }, null)).toMatchObject({ plan: null, kept: false });
  });
});

describe('clean up in the store (BRK-201)', () => {
  let cookie;
  let staging;
  let provider;
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** The desired state: what runs, less `leave`, as a read of the file from the default branch would put it. */
  const want = (leave = []) =>
    runInDurableObject(store(), (instance) => {
      const resources = structuredClone(provider.state.resources).filter((r) => !leave.includes(r.id));
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'cleanup-staging.json', ?, ?, 'abc123', ?, ?, 'abc123', ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired`,
        ENV,
        PROVIDER,
        Date.now(),
        JSON.stringify({ version: 1, provider: PROVIDER, resources }),
        Date.now(),
      );
    });
  const refresh = () => inStore((s) => s.refreshInventory(PROVIDER));
  const cron = (ahead = DRIFT_EVERY_MS) => inStore((s) => s.driftTick(Date.now() + ahead));
  /** The grace period passes for every flag on the environment. */
  const graceOver = () =>
    inStore((s) =>
      s.sql.exec('UPDATE infra_cleanup SET flagged = flagged - ? WHERE environment = ?', CLEANUP_GRACE_MS, staging.id),
    );
  const view = async () => (await body(await api(`infra/environments/${staging.id}`))).environment;
  const plans = async (kind) =>
    (await body(await api(`infra/plans?environment=${staging.id}&limit=200`))).plans.filter(
      (p) => p.source.kind === kind,
    );
  const audit = async () =>
    (await body(await api(`infra/audit?environmentId=${staging.id}&kind=cleanup&limit=200`))).entries;

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    staging = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name: ENV, kind: 'staging', target: 'svc-api' },
        }),
      )
    ).environment;
    provider = fakeProvider({ id: PROVIDER });
    // A database the service still uses that nobody declares, and a service outside the environment's scope.
    provider.state.resources.push(
      { id: 'db-old', kind: 'database', name: 'acme-old', attrs: { size: 'small' } },
      { id: 'svc-other', kind: 'service', name: 'acme-someone-elses', attrs: {} },
    );
    provider.state.relations.push({ from: 'svc-api', to: 'db-old', kind: 'uses' });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
    });
    await refresh();
    await want(['db-old', 'svc-other']);
  });

  it('flags what runs in scope but isn’t declared, and leaves it out of drift', async () => {
    await cron();
    const env = await view();
    expect(env).toMatchObject({
      unownedCount: 1,
      unowned: [{ id: 'db-old', kind: 'database', name: 'acme-old', plan: null, kept: false, error: null }],
      driftCount: 0,
    });
    expect(Date.parse(env.unowned[0].removeAfter) - Date.parse(env.unowned[0].flagged)).toBe(CLEANUP_GRACE_MS);
    expect(await plans('drift')).toEqual([]);
    expect(await plans('cleanup')).toEqual([]);
    expect(await audit()).toMatchObject([
      { kind: 'cleanup', by: 'board', outcome: 'flagged', summary: /database `acme-old` runs in cleanup-staging/u },
    ]);
  });

  it('waits out the grace period: no plan and no second flag before it', async () => {
    await cron(2 * DRIFT_EVERY_MS);
    expect(await plans('cleanup')).toEqual([]);
    expect(await audit()).toHaveLength(1);
  });

  it('after the grace period, makes one removal plan that waits for the owner, and never applies it', async () => {
    // Drift on a declared resource meanwhile stays drift's own plan, without the delete.
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 3;
    await graceOver();
    await cron(3 * DRIFT_EVERY_MS);
    const removal = await plans('cleanup');
    expect(removal).toHaveLength(1);
    expect(removal[0]).toMatchObject({ state: 'waiting', by: 'board', changes: 1 });
    const full = (await body(await api(`infra/plans/${removal[0].id}`))).plan;
    expect(full.diff.changes).toMatchObject([{ op: 'delete', resource: 'db-old' }]);
    expect(full.policy).toMatchObject({ outcome: 'needs-owner' });
    expect(full.blastRadius.deletesInUse).toMatchObject([{ resource: 'db-old', by: ['svc-api'] }]);
    const drift = await plans('drift');
    expect(drift).toHaveLength(1);
    const driftPlan = (await body(await api(`infra/plans/${drift[0].id}`))).plan;
    expect(driftPlan.diff.changes.map((c) => c.op)).toEqual(['scale']);
    expect(await view()).toMatchObject({
      waitingPlan: removal[0].id,
      unowned: [{ id: 'db-old', plan: { id: removal[0].id, state: 'waiting' } }],
      driftCount: 1,
    });
    await cron(4 * DRIFT_EVERY_MS);
    expect(await plans('cleanup')).toHaveLength(1);
    expect(provider.calls.filter((c) => c.method === 'apply')).toEqual([]);
    expect(provider.state.resources.some((r) => r.id === 'db-old')).toBe(true);
    await inStore((s) => s.moveInfraPlan(drift[0].id, 'rejected', { by: 'owner' }));
    provider.state.resources.find((r) => r.id === 'svc-api').attrs.instances = 2;
  });

  it('keeps a resource whose removal the owner rejected, and proposes it no more', async () => {
    const [removal] = await plans('cleanup');
    const rejected = await body(await board(`infra/plans/${removal.id}/reject`, { method: 'POST', body: {} }));
    expect(rejected.status).toBe(200);
    await cron(5 * DRIFT_EVERY_MS);
    expect(await plans('cleanup')).toHaveLength(1);
    expect((await view()).unowned).toMatchObject([{ id: 'db-old', kept: true, plan: { state: 'rejected' } }]);
  });

  it('drops the flag once the desired state declares the resource', async () => {
    await want(['svc-other']);
    await cron(6 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 0, unowned: [] });
    expect((await audit())[0]).toMatchObject({
      outcome: 'unflagged',
      summary: /database `acme-old`: it’s in widgets’s desired state now/u,
    });
  });

  it('drops the flag of a resource a break-glass mark covers', async () => {
    provider.state.resources.push({ id: 'svc-hotfix', kind: 'service', name: 'acme-hotfix', attrs: {} });
    provider.state.relations.push({ from: 'svc-api', to: 'svc-hotfix', kind: 'calls' });
    await refresh();
    await cron(7 * DRIFT_EVERY_MS);
    expect((await view()).unowned.map((r) => r.id)).toEqual(['svc-hotfix']);
    await inStore(async (s) => {
      const keys = await breakGlassKeys(await s.driftDiff(s.environmentRow(staging.id)));
      s.sql.exec(
        "INSERT INTO infra_break_glass (environment, repo, at, note, keys, task) VALUES (?, 'widgets', ?, 'a hotfix', ?, 'none')",
        staging.id,
        Date.now(),
        JSON.stringify(keys),
      );
    });
    await cron(8 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 0 });
    expect((await audit())[0]).toMatchObject({ outcome: 'unflagged', summary: /break-glass/u });
    await inStore((s) => s.sql.exec('DELETE FROM infra_break_glass WHERE environment = ?', staging.id));
  });

  it('plans nothing in a frozen environment until it’s unfrozen', async () => {
    await cron(9 * DRIFT_EVERY_MS);
    expect((await view()).unowned.map((r) => r.id)).toEqual(['svc-hotfix']);
    await graceOver();
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { frozen: true } });
    await cron(10 * DRIFT_EVERY_MS);
    expect(await plans('cleanup')).toHaveLength(1);
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { frozen: false } });
    await cron(11 * DRIFT_EVERY_MS);
    const removal = await plans('cleanup');
    expect(removal).toHaveLength(2);
    expect(removal[0]).toMatchObject({ state: 'waiting', changes: 1 });
    await inStore((s) => s.moveInfraPlan(removal[0].id, 'rejected', { by: 'owner' }));
  });

  it('says it’s removed once it’s gone', async () => {
    provider.state.resources = provider.state.resources.filter((r) => r.id !== 'svc-hotfix');
    provider.state.relations = provider.state.relations.filter((r) => r.to !== 'svc-hotfix');
    await cron(12 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 0 });
    expect((await audit())[0]).toMatchObject({ outcome: 'removed', summary: /service `acme-hotfix`: it’s gone/u });
  });

  it('lists what nobody owns for anyone signed in', async () => {
    provider.state.resources.push({ id: 'svc-spare', kind: 'service', name: 'acme-spare', attrs: {} });
    provider.state.relations.push({ from: 'svc-api', to: 'svc-spare', kind: 'calls' });
    await refresh();
    await cron(13 * DRIFT_EVERY_MS);
    const listed = await body(await api(`infra/cleanup?repo=widgets&environment=${ENV}`));
    expect(listed).toMatchObject({
      status: 200,
      unowned: [{ repo: 'widgets', environment: { id: staging.id, name: ENV }, id: 'svc-spare', plan: null }],
    });
    expect((await body(await api('infra/cleanup', { method: 'POST', body: {} }))).status).toBe(404);
  });

  it('never flags what a short-lived environment’s task owns', async () => {
    await inStore((s) => s.sql.exec("UPDATE infra_environments SET task = 'acme-task-uuid' WHERE id = ?", staging.id));
    await cron(14 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 0 });
    expect((await audit())[0]).toMatchObject({ outcome: 'unflagged', summary: /short-lived/u });
    await inStore((s) => s.sql.exec('UPDATE infra_environments SET task = NULL WHERE id = ?', staging.id));
  });

  it('forgets an environment that becomes observe only', async () => {
    await cron(15 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 1 });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: true } });
    await cron(16 * DRIFT_EVERY_MS);
    expect(await view()).toMatchObject({ unownedCount: 0 });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: false } });
  });
});
