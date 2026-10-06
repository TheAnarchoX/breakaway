import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { DRIFT_EVERY_MS } from '../src/infra-drift.js';
import {
  BREAK_GLASS_NOTE_MAX,
  breakGlassCovers,
  breakGlassKeys,
  breakGlassLine,
  breakGlassNote,
  breakGlassTask,
} from '../src/infra-break-glass.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeglass';
const ENV = 'glass-staging';

const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

describe('break-glass, the pure part (BRK-187)', () => {
  const change = (over = {}) => ({
    op: 'update',
    resource: 'db-main',
    kind: 'database',
    name: 'main',
    before: { size: 'large', tier: 1 },
    after: { size: 'small', tier: 1 },
    reversible: true,
    ...over,
  });
  const diff = (changes) => ({ provider: 'fake', environment: 'staging', changes, reversible: true });

  it('needs a note, redacts it, and keeps it short', () => {
    expect(() => breakGlassNote('  ')).toThrow(/needs a note/u);
    expect(() => breakGlassNote(undefined)).toThrow(/needs a note/u);
    expect(() => breakGlassNote('x'.repeat(BREAK_GLASS_NOTE_MAX + 1))).toThrow(/at most/u);
    expect(breakGlassNote('  Scaled the\n database   up ')).toBe('Scaled the database up');
    expect(breakGlassNote('used API_TOKEN=abc123 to do it')).not.toContain('abc123');
  });

  it('keys each change the same in any order, and covers drift that still holds one of them', async () => {
    const a = change();
    const b = change({ op: 'scale', resource: 'svc-api', kind: 'service', name: 'api', before: { instances: 5 } });
    const keys = await breakGlassKeys(diff([a, b]));
    expect(keys).toHaveLength(2);
    expect(await breakGlassKeys(diff([b, { ...a, after: { tier: 1, size: 'small' } }]))).toEqual(keys);
    const onlyB = await breakGlassKeys(diff([b]));
    expect(breakGlassCovers(keys, onlyB)).toBe(true);
    expect(breakGlassCovers(onlyB, await breakGlassKeys(diff([a])))).toBe(false);
    expect(breakGlassCovers(keys, [])).toBe(false);
  });

  it('says what to write into the file for each change, so it says what runs', () => {
    expect(breakGlassLine(change())).toBe(
      '- In database `main` (`db-main`), set size: "large" (the file says "small").',
    );
    expect(breakGlassLine(change({ op: 'create', before: null, after: { size: 'small' } }))).toBe(
      '- Remove database `main` (`db-main`): the file has it, and nothing like it runs.',
    );
    expect(breakGlassLine(change({ op: 'delete', before: { size: 'large' }, after: null }))).toBe(
      '- Add database `main` (`db-main`), which runs but isn’t in the file, with size: "large".',
    );
  });

  it('makes a task that names the desired-state file and each change, and never asks to undo it', () => {
    const task = breakGlassTask({ environment: 'staging', note: 'Scaled up for the launch', changes: [change()] });
    expect(task.description).toBe('Put staging’s break-glass change into .github/breakaway-infra/staging.json');
    expect(task.brief).toContain('“Scaled up for the launch”');
    expect(task.brief).toContain('`.github/breakaway-infra/staging.json`');
    expect(task.brief).toContain('set size: "large"');
    expect(task.brief).toContain('Don’t undo the change');
    expect(task.done_when).toContain('.github/breakaway-infra/staging.json says what runs');
  });

  it('lists at most 40 changes and counts the rest', () => {
    const many = Array.from({ length: 45 }, (_, i) => change({ resource: `db-${i}`, name: `db${i}` }));
    const { brief } = breakGlassTask({ environment: 'staging', note: 'n', changes: many });
    expect(brief.split('\n').filter((l) => l.startsWith('- In '))).toHaveLength(40);
    expect(brief).toContain('- And 5 more');
  });
});

describe('break-glass in the store (BRK-187)', () => {
  let cookie;
  let staging;
  let provider;
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** Puts what runs now as the environment's desired state, as a read of its file from the default branch would. */
  const want = (sha) =>
    runInDurableObject(store(), (instance) => {
      const state = { version: 1, provider: PROVIDER, resources: structuredClone(provider.state.resources) };
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        `${ENV}.json`,
        ENV,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify(state),
        sha,
        Date.now(),
      );
    });
  const driftPlans = async () =>
    (await body(await api(`infra/plans?environment=${staging.id}&limit=200`))).plans.filter(
      (p) => p.source.kind === 'drift',
    );
  const glassAudit = async () =>
    (await body(await api(`infra/audit?environmentId=${staging.id}&kind=break-glass`))).entries;
  const glassTasks = async () =>
    (await body(await api('tasks?repo=widgets&status=pending&limit=500'))).tasks?.filter((t) =>
      (t.tags ?? []).includes('break-glass'),
    ) ?? [];
  const view = async () => (await body(await api(`infra/environments/${staging.id}`))).environment;
  const cron = (ahead = DRIFT_EVERY_MS) => inStore((s) => s.driftTick(Date.now() + ahead));
  const mark = (note = 'Scaled the database up by hand during the launch') =>
    board(`infra/break-glass/${staging.id}`, { method: 'POST', body: { note } });
  const runs = (id) => provider.state.resources.find((r) => r.id === id).attrs;

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const made = await body(
      await board('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: ENV, kind: 'staging', target: 'svc-api' },
      }),
    );
    staging = made.environment;
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
    });
    await want('sha-1');
  });

  it('is the owner’s from the board: never the bearer token or an agent, and always with a note', async () => {
    const token = await body(
      await api(`infra/break-glass/${staging.id}`, { method: 'POST', body: { note: 'by hand' } }),
    );
    expect(token.status).toBe(403);
    const agent = await body(
      await board(`infra/break-glass/${staging.id}`, { method: 'POST', body: { note: 'x', by: 'claude-x' } }),
    );
    expect(agent.status).toBe(403);
    const bare = await body(await board(`infra/break-glass/${staging.id}`, { method: 'POST', body: {} }));
    expect(bare).toMatchObject({ status: 400, error: /needs a note/u });
  });

  it('refuses when there’s no drift to mark', async () => {
    expect(await body(await mark())).toMatchObject({ status: 409, error: /has no drift/u });
    expect(await glassAudit()).toEqual([]);
  });

  it('records a change by hand once, makes one task to put it into code, and rejects the plan that would undo it', async () => {
    runs('db-main').size = 'large';
    await cron();
    const [draft] = await driftPlans();
    expect(draft).toMatchObject({ state: 'draft' });

    const res = await body(await mark());
    expect(res).toMatchObject({
      status: 201,
      already: false,
      breakGlass: { note: 'Scaled the database up by hand during the launch', changes: 1, settled: null },
      drift: { count: 1, plan: null },
    });

    const audit = await glassAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'break-glass',
      repo: 'widgets',
      environment: ENV,
      environmentId: staging.id,
      by: 'owner',
      outcome: 'recorded',
    });
    expect(audit[0].summary).toContain(res.breakGlass.task);

    const task = (await body(await api(`tasks/${res.breakGlass.task}`))).task;
    expect(task).toMatchObject({ status: 'pending', horizon: 'now' });
    expect(task.tags).toEqual(expect.arrayContaining(['agent', 'break-glass']));
    expect(task.brief).toContain(`.github/breakaway-infra/${ENV}.json`);
    expect(task.brief).toContain('In database `main` (`db-main`), set size: "large" (the file says "small")');
    expect(task.doneWhen).toContain(`.github/breakaway-infra/${ENV}.json says what runs`);

    // No undo: the drift plan is rejected, and nothing was applied.
    expect(await driftPlans()).toMatchObject([{ id: draft.id, state: 'rejected' }]);
    expect(provider.calls.filter((c) => c.method === 'apply')).toEqual([]);
    expect(runs('db-main').size).toBe('large');
    expect((await view()).drift).toMatchObject({ count: 1, plan: null, breakGlass: { task: res.breakGlass.task } });
  });

  it('returns the first mark when the same changes are marked again, with no second entry or task', async () => {
    const tasks = await glassTasks();
    expect(tasks).toHaveLength(1);
    const res = await body(await mark('again'));
    expect(res).toMatchObject({ status: 200, already: true, breakGlass: { changes: 1 } });
    expect(await glassAudit()).toHaveLength(1);
    expect(await glassTasks()).toHaveLength(tasks.length);
  });

  it('makes no plan for marked drift on the next comparisons, even when more drifts on top', async () => {
    await cron();
    await cron(2 * DRIFT_EVERY_MS);
    expect((await driftPlans()).filter((p) => p.state !== 'rejected')).toEqual([]);
    runs('svc-api').instances = 7;
    await cron();
    expect((await driftPlans()).filter((p) => p.state !== 'rejected')).toEqual([]);
    expect((await view()).drift).toMatchObject({ count: 2, plan: null, breakGlass: { settled: null } });
  });

  it('settles the mark once the file says what runs, and plans drift as usual after that', async () => {
    runs('svc-api').instances = 2;
    await want('sha-2');
    await cron();
    expect((await view()).drift).toMatchObject({ count: 0, breakGlass: null });
    const marks = (await body(await api(`infra/break-glass?environment=${staging.id}`))).breakGlass;
    expect(marks).toHaveLength(1);
    expect(marks[0].settled).not.toBeNull();
    runs('db-main').size = 'small';
    await cron();
    expect((await driftPlans()).filter((p) => p.state === 'draft')).toHaveLength(1);
  });

  it('refuses while an approved drift plan is about to put things back', async () => {
    const [draft] = (await driftPlans()).filter((p) => p.state === 'draft');
    await inStore((s) => s.moveInfraPlan(draft.id, 'waiting', { by: 'owner' }));
    await inStore((s) => s.moveInfraPlan(draft.id, 'approved', { by: 'owner', digest: 'a'.repeat(64) }));
    expect(await body(await mark())).toMatchObject({ status: 409, error: /approved/u });
    expect(await glassAudit()).toHaveLength(1);
  });

  it('never marks an observe-only environment', async () => {
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: true } });
    expect(await body(await mark())).toMatchObject({ status: 409, error: /observe only/u });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { observeOnly: false } });
  });
});
