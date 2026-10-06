import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { LOCK_TTL_MAX_MINUTES, LOCK_TTL_MINUTES, lockTtl, MINUTE } from '../src/infra-locks.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
/** Runs the store's own call, the way the executor will, and returns what it gave or the error it threw. */
const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return {
        ok: false,
        status: error.status ?? (error.constructor.name === 'InputError' ? 400 : 500),
        error: error.message,
      };
    }
  });
/** The lock-release entries the store appended since the spy went in. */
const audited = () => runInDurableObject(store(), (instance) => [...instance.lockAuditSeen]);

describe('environment locks (BRK-179)', () => {
  let cookie;
  let staging;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const made = await body(
      await api('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: 'fake', name: 'staging', kind: 'staging', target: 'widgets-staging' },
      }),
    );
    staging = made.environment;
    // Watch what goes on the audit trail, passing each entry on to the real one when the board has it (BRK-175).
    await runInDurableObject(store(), (instance) => {
      const real = instance.appendInfraAudit;
      instance.lockAuditSeen = [];
      instance.appendInfraAudit = (entry) => {
        instance.lockAuditSeen.push(entry);
        return typeof real === 'function' ? real.call(instance, entry) : entry;
      };
    });
  });
  const board = (path, { method = 'GET' } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    });
  const take = (ref, input = {}) => inStore((s) => s.takeEnvironmentLock(ref, { holder: 'executor', ...input }));

  it('the lock lasts 15 minutes by default, and never more than an hour', () => {
    expect(lockTtl(undefined)).toBe(LOCK_TTL_MINUTES * MINUTE);
    expect(lockTtl(5)).toBe(5 * MINUTE);
    expect(() => lockTtl(0)).toThrow(/whole number from 1/);
    expect(() => lockTtl(LOCK_TTL_MAX_MINUTES + 1)).toThrow(/whole number from 1/);
    expect(() => lockTtl(2.5)).toThrow(/whole number/);
  });

  it('a free environment has no lock', async () => {
    expect(await body(await api('infra/locks'))).toMatchObject({ status: 200, locks: [] });
    expect(await body(await api(`infra/locks/${staging.id}`))).toMatchObject({ status: 200, lock: null });
  });

  it('two takes at once on one environment give one winner', async () => {
    const results = await Promise.all([
      take('staging', { holder: 'executor:plan-1', plan: 'plan-1' }),
      take('staging', { holder: 'executor:plan-2', plan: 'plan-2' }),
    ]);
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].status).toBe(409);
    expect(lost[0].error).toMatch(/staging is locked by executor:plan-\d until/);
    expect(won[0].value.token).toEqual(expect.any(String));
    expect(won[0].value.lock).toMatchObject({
      environment: { id: staging.id, repo: 'widgets', name: 'staging' },
      holder: expect.stringMatching(/^executor:plan-\d$/),
    });

    // Anyone signed in sees who holds it, but never its token.
    const one = await body(await api('infra/locks/staging?repo=widgets'));
    expect(one.lock.holder).toBe(won[0].value.lock.holder);
    expect(JSON.stringify(one)).not.toContain(won[0].value.token);
    const all = await body(await api('infra/locks?repo=widgets'));
    expect(all.locks).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain(won[0].value.token);

    // Its holder releases it with its token, and that's on the audit trail.
    const wrong = await inStore((s) => s.releaseEnvironmentLock('staging', { token: 'not-it' }));
    expect(wrong).toMatchObject({ ok: false, status: 409 });
    const before = (await audited()).length;
    const released = await inStore((s) => s.releaseEnvironmentLock('staging', { token: won[0].value.token }));
    expect(released.ok).toBe(true);
    expect((await audited()).slice(before)).toEqual([
      expect.objectContaining({
        kind: 'lock-release',
        repo: 'widgets',
        environment: 'staging',
        by: 'executor',
        outcome: 'released',
        plan: won[0].value.lock.plan,
      }),
    ]);
    expect((await body(await api('infra/locks/staging'))).lock).toBeNull();
  });

  it('renewing pushes the expiry out, and only the token renews', async () => {
    const taken = await take('staging', { minutes: 1 });
    const { token } = taken.value;
    const first = Date.parse(taken.value.lock.expires);
    const renewed = await inStore((s) => s.renewEnvironmentLock('staging', { token, minutes: 30 }));
    expect(Date.parse(renewed.value.lock.expires)).toBeGreaterThan(first);
    expect(await inStore((s) => s.renewEnvironmentLock('staging', { token: 'nope' }))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await inStore((s) => s.renewEnvironmentLock('staging', { token, minutes: 61 }))).toMatchObject({
      ok: false,
      status: 400,
    });
    await inStore((s) => s.releaseEnvironmentLock('staging', { token }));
  });

  it('an expired lock can be taken again, and its release is audited as expired', async () => {
    const old = await take('staging', { holder: 'executor:plan-3', plan: 'plan-3' });
    await runInDurableObject(store(), (instance) => {
      instance.sql.exec('UPDATE infra_locks SET expires = ? WHERE environment = ?', Date.now() - 1, staging.id);
    });
    // Expired: nobody sees it held, and its old token neither renews nor releases it.
    expect((await body(await api('infra/locks/staging'))).lock).toBeNull();
    const late = await inStore((s) => s.renewEnvironmentLock('staging', { token: old.value.token }));
    expect(late).toMatchObject({ ok: false, status: 409 });
    expect(late.error).toMatch(/expired/);

    const before = (await audited()).length;
    const next = await take('staging', { holder: 'executor:plan-4', plan: 'plan-4' });
    expect(next.ok).toBe(true);
    expect(next.value.lock.holder).toBe('executor:plan-4');
    expect((await audited()).slice(before)).toEqual([
      expect.objectContaining({ kind: 'lock-release', by: 'board', outcome: 'expired', plan: 'plan-3' }),
    ]);
    expect(await inStore((s) => s.releaseEnvironmentLock('staging', { token: old.value.token }))).toMatchObject({
      ok: false,
      status: 409,
    });
    await inStore((s) => s.releaseEnvironmentLock('staging', { token: next.value.token }));
  });

  it('a forced release is the owner’s, from the signed-in board only, and audited', async () => {
    await take('staging', { holder: 'executor:plan-5', plan: 'plan-5' });
    const agent = await body(await api('infra/locks/staging', { method: 'DELETE' }));
    expect(agent.status).toBe(403);
    expect(agent.error).toMatch(/signed-in web board/);
    expect((await body(await api('infra/locks/staging'))).lock.holder).toBe('executor:plan-5');

    const before = (await audited()).length;
    const forced = await body(await board('infra/locks/staging', { method: 'DELETE' }));
    expect(forced.status).toBe(200);
    expect(forced.released.holder).toBe('executor:plan-5');
    expect((await audited()).slice(before)).toEqual([
      expect.objectContaining({
        kind: 'lock-release',
        repo: 'widgets',
        environment: 'staging',
        by: 'owner',
        outcome: 'forced',
        plan: 'plan-5',
      }),
    ]);
    expect((await body(await api('infra/locks/staging'))).lock).toBeNull();
    expect((await board('infra/locks/staging', { method: 'DELETE' })).status).toBe(404);
  });

  it('a release that can’t be recorded doesn’t happen', async () => {
    const taken = await take('staging');
    const refused = await runInDurableObject(store(), async (instance) => {
      const spy = instance.appendInfraAudit;
      instance.appendInfraAudit = undefined;
      try {
        return await instance.releaseEnvironmentLock('staging', { token: taken.value.token });
      } catch (error) {
        return { status: error.status, error: error.message };
      } finally {
        instance.appendInfraAudit = spy;
      }
    });
    expect(refused.status).toBe(503);
    expect(refused.error).toMatch(/audit trail/);
    expect((await body(await api('infra/locks/staging'))).lock).not.toBeNull();
    await inStore((s) => s.releaseEnvironmentLock('staging', { token: taken.value.token }));
  });

  it('refuses a lock on a frozen, observe-only, or missing environment, and a holder that isn’t one', async () => {
    await SELF.fetch(`${ORIGIN}/api/infra/environments/${staging.id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frozen: true }),
    });
    const cold = await take('staging');
    expect(cold).toMatchObject({ ok: false, status: 409 });
    expect(cold.error).toMatch(/frozen/);
    await SELF.fetch(`${ORIGIN}/api/infra/environments/${staging.id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frozen: false }),
    });

    const own = await body(
      await api('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: 'fake', name: 'board', kind: 'production', target: 'widgets-tasks' },
      }),
    );
    expect(own.environment.observeOnly).toBe(true);
    const watched = await take('board');
    expect(watched).toMatchObject({ ok: false, status: 409 });
    expect(watched.error).toMatch(/observe only/);

    expect(await take('nowhere')).toMatchObject({ ok: false, status: 404 });
    expect(await take('staging', { holder: 'the owner, by name' })).toMatchObject({ ok: false });
    expect(await take('staging', { plan: 'not a plan!' })).toMatchObject({ ok: false });
    expect((await body(await api('infra/locks/staging'))).lock).toBeNull();
  });

  it('only GET and DELETE answer', async () => {
    expect((await api('infra/locks/staging', { method: 'POST', body: {} })).status).toBe(404);
    expect((await api('infra/locks', { method: 'PUT', body: {} })).status).toBe(404);
  });
});
