import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, boardApi } from './helpers.js';
import {
  INCIDENT_REPEAT_MS,
  INCIDENT_STEPS,
  crossesRule,
  incidentBrief,
  incidentKey,
  incidentSteps,
  incidentTitle,
  pushes,
} from '../src/infra-incidents.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));

const addEnvironment = async (fields) =>
  (await body(await boardApi('infra/environments', { method: 'POST', body: { repo: 'widgets', ...fields } })))
    .environment;
const detail = async (wid) => (await body(await api(`tasks/${wid}`))).task;
const incidents = async (query = '') => (await body(await api(`infra/incidents${query}`))).incidents;
const signal = (over = {}) => ({
  source: 'fake',
  environment: 'in-production',
  resource: 'svc-api',
  kind: 'health',
  level: 'critical',
  value: null,
  at: new Date(Date.now() - 60_000).toISOString(),
  text: 'api is down',
  ...over,
});

/** Records signals the way a provider does, counting the pushes the board tries to send. */
async function record(signals) {
  return inStore(async (store) => {
    const push = vi.spyOn(store, 'pushPing');
    const runs = Number(store.sql.exec('SELECT COUNT(*) AS n FROM agent_runs').one().n);
    try {
      await store.recordSignals(signals);
      return {
        pushes: push.mock.calls.length,
        started: Number(store.sql.exec('SELECT COUNT(*) AS n FROM agent_runs').one().n) - runs,
      };
    } finally {
      push.mockRestore();
    }
  });
}

/** A plan for an incident, as the board would keep one (BRK-178), in `state`. */
const plan = (environmentId, ref, state = 'draft') =>
  inStore((store) => {
    const now = Date.now();
    const n = store.sql
      .exec(
        "INSERT INTO infra_plans (environment, repo, provider, target, desired_sha, source, ref, state, diff, cost, blast, reversible, by, agent, created, updated) VALUES (?, 'widgets', 'fake', NULL, NULL, 'incident', ?, ?, ?, ?, ?, 1, 'agent', 'claude-a', ?, ?) RETURNING n",
        environmentId,
        ref,
        state,
        JSON.stringify({ provider: 'fake', environment: 'in-production', changes: [] }),
        JSON.stringify({ currency: null, before: null, after: null, delta: null, unknown: [], changes: [] }),
        JSON.stringify({ resources: [], changed: 0, reached: 0, deletesInUse: [] }),
        now,
        now,
      )
      .one().n;
    return `plan-${n}`;
  });

describe('incidents, the pure part', () => {
  it('opens on critical only, and keys by environment, resource, and kind, never level or words', () => {
    expect(crossesRule('critical')).toBe(true);
    expect(crossesRule('warning')).toBe(false);
    expect(crossesRule('info')).toBe(false);
    const a = { resource: 'r', kind: 'health', level: 'critical', text: 'one' };
    expect(incidentKey(3, a)).toBe(incidentKey(3, { ...a, level: 'warning', text: 'two' }));
    expect(incidentKey(3, a)).not.toBe(incidentKey(4, a));
    expect(incidentKey(3, a)).not.toBe(incidentKey(3, { ...a, kind: 'alert' }));
    expect(incidentKey(3, { kind: 'health', resource: null })).not.toBe(incidentKey(3, a));
  });

  it('pushes for production and for an environment with production gates, never otherwise', () => {
    expect(pushes({ kind: 'production', gates: null })).toBe(true);
    expect(pushes({ kind: 'staging', gates: null })).toBe(false);
    expect(pushes({ kind: 'staging', gates: 1 })).toBe(true);
    expect(pushes({ kind: 'production', gates: 0 })).toBe(false);
  });

  it('titles and briefs an incident with the signal and the inventory, and lists the steps', () => {
    const s = {
      id: 1,
      source: 'fake',
      environment: 'prod',
      resource: 'svc-api',
      kind: 'health',
      level: 'critical',
      value: 503,
      at: '2026-10-06T00:00:00.000Z',
      text: 'down',
    };
    expect(incidentTitle(s, { name: 'api' })).toBe('Incident: health, critical, in prod (api): down');
    expect(incidentTitle({ ...s, text: 'x'.repeat(300) }, null).length).toBe(200);
    const brief = incidentBrief(s, {
      name: 'prod',
      environmentKind: 'production',
      resource: { id: 'svc-api', kind: 'service', name: 'api', health: 'failing', healthText: '503s' },
      dependents: 2,
    });
    expect(brief).toContain('Value: 503.');
    expect(brief).toContain('Resource: api (service, svc-api), health failing: 503s. 2 resources lean on it.');
    expect(brief).toContain('1. Diagnose, read only');
    expect(brief).toContain('6. Write up');
    expect(incidentBrief({ ...s, resource: null }, { name: 'p', environmentKind: 'staging', resource: null, dependents: 0 })).toContain(
      'The whole environment.',
    );
  });

  it('follows the linked plan through its steps', () => {
    const at = '2026-10-06T00:00:00.000Z';
    const states = (plan, recovered = null, closed = false) =>
      Object.fromEntries(incidentSteps({ plan, recovered, closed }).map((s) => [s.step, s.state]));
    expect(INCIDENT_STEPS).toEqual(['diagnose', 'propose', 'approve', 'apply', 'verify', 'write-up']);
    expect(states(null)).toEqual({
      diagnose: 'now',
      propose: 'next',
      approve: 'next',
      apply: 'next',
      verify: 'next',
      'write-up': 'next',
    });
    expect(states({ state: 'draft', updated: at })).toMatchObject({ diagnose: 'done', propose: 'now' });
    expect(states({ state: 'waiting', updated: at })).toMatchObject({ propose: 'done', approve: 'now' });
    expect(states({ state: 'approved', updated: at })).toMatchObject({ approve: 'done', apply: 'now' });
    expect(states({ state: 'rejected', updated: at })).toMatchObject({ propose: 'now', approve: 'next' });
    expect(states({ state: 'failed', updated: at })).toMatchObject({ apply: 'failed', verify: 'next' });
    expect(states({ state: 'applied', updated: at })).toMatchObject({ apply: 'done', verify: 'now' });
    expect(states({ state: 'applied', updated: at }, '2026-10-06T00:05:00.000Z')).toMatchObject({
      verify: 'done',
      'write-up': 'now',
    });
    // Recovered before the apply verifies nothing.
    expect(states({ state: 'applied', updated: at }, '2026-10-05T23:00:00.000Z')).toMatchObject({ verify: 'now' });
    expect(states(null, null, true)).toEqual({
      diagnose: 'skipped',
      propose: 'skipped',
      approve: 'skipped',
      apply: 'skipped',
      verify: 'skipped',
      'write-up': 'done',
    });
  });
});

describe('incidents from the signals stream (BRK-197)', () => {
  let production;
  let staging;
  beforeEach(async () => {
    production ??= await addEnvironment({ name: 'in-production', kind: 'production', provider: 'fake' });
    staging ??= await addEnvironment({ name: 'in-staging', kind: 'staging', provider: 'fake' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens one +incident task in the owning repository, with the inventory’s context and one push in production', async () => {
    await inStore((store) =>
      store.sql.exec(
        'INSERT OR REPLACE INTO infra_inventory (environment, provider, rid, kind, name, health, seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
        production.id,
        'fake',
        'svc-api',
        'service',
        'api',
        'failing',
        Date.now(),
      ),
    );
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const first = await record([signal({ environmentId: production.id, text: `api is down, token ${token}` })]);
    expect(first).toEqual({ pushes: 1, started: 0 });

    const [incident] = await incidents(`?environment=${production.id}&repo=widgets`);
    expect(incident).toMatchObject({
      repo: 'widgets',
      environment: 'in-production',
      environmentKind: 'production',
      resource: 'svc-api',
      kind: 'health',
      level: 'critical',
      signals: 1,
      pushed: true,
      closed: null,
      plans: [],
    });
    expect(incident.steps.map((s) => s.state)).toEqual(['now', 'next', 'next', 'next', 'next', 'next']);

    const task = await detail(incident.task.wid);
    expect(task.tags).toEqual(['incident']);
    expect(task.autostart).toBeFalsy();
    expect(task.priority).toBe('H');
    expect(task.description).toMatch(/^Incident: health, critical, in in-production \(api\): api is down/);
    expect(task.brief).toContain('Resource: api (service, svc-api), health failing.');
    expect(task.brief).not.toContain(token);
    expect(task.incident).toMatchObject({ id: incident.id });
    expect(task.pings).toMatchObject([{ kind: 'incident', by: 'board', push: true }]);

    const one = await body(await api(`infra/incidents/${incident.task.wid}`));
    expect(one.incident.id).toBe(incident.id);
    expect((await body(await api(`infra/incidents/${incident.id}`))).incident.task.wid).toBe(incident.task.wid);
    expect((await body(await api('infra/incidents/99999'))).status).toBe(404);
  });

  it('comments on the open incident for a repeat instead of opening another, and never pushes again', async () => {
    const [before] = await incidents(`?environment=${production.id}`);
    const comments = (await detail(before.task.wid)).comments.length;
    // A burst inside the repeat window is counted, not commented.
    const again = await record([signal({ at: new Date().toISOString(), text: 'api is still down' })]);
    expect(again).toEqual({ pushes: 0, started: 0 });
    await record([signal({ at: new Date().toISOString(), text: 'down 3' })]);
    const all = await incidents(`?environment=${production.id}`);
    expect(all).toHaveLength(1);
    expect(all[0].signals).toBe(3);
    expect((await detail(before.task.wid)).comments).toHaveLength(comments);

    // The next one after the window comments, and says how many it didn't.
    const later = await inStore(async (store) => {
      const push = vi.spyOn(store, 'pushPing');
      await store.incidentSignals(
        [{ ...signal({ text: 'down 4' }), id: 1, environmentId: null, at: new Date().toISOString() }],
        Date.now() + INCIDENT_REPEAT_MS,
      );
      return push.mock.calls.length;
    });
    expect(later).toBe(0);
    const task = await detail(before.task.wid);
    expect(task.comments).toHaveLength(comments + 1);
    expect(task.comments.at(-1).text).toMatch(/^Signal again: health, critical, in in-production .*down 4/);
    expect(task.comments.at(-1).text).toContain('(and 2 more since the last comment)');
    expect(task.pings).toHaveLength(1);
    expect((await incidents(`?environment=${production.id}`))[0].signals).toBe(4);
  });

  it('opens a quiet one in staging, and nothing for a warning, an unknown environment, or an old signal', async () => {
    const quiet = await record([signal({ environment: 'in-staging', resource: null, kind: 'alert' })]);
    expect(quiet).toEqual({ pushes: 0, started: 0 });
    const [incident] = await incidents(`?environment=in-staging&repo=widgets`);
    expect(incident).toMatchObject({ environmentKind: 'staging', pushed: false, resource: null, kind: 'alert' });
    const task = await detail(incident.task.wid);
    expect(task.priority).toBe('M');
    expect(task.pings).toMatchObject([{ kind: 'incident', push: false }]);
    expect(task.brief).toContain('The whole environment.');

    const count = (await incidents()).length;
    await record([
      signal({ environment: 'in-staging', resource: 'other', level: 'warning' }),
      signal({ environment: 'nowhere', resource: 'x' }),
      signal({ environment: 'in-staging', resource: 'old', at: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    ]);
    expect(await incidents()).toHaveLength(count);
  });

  it('notes recovery once, shows the linked plan and its steps, and opens a new incident once the task is closed', async () => {
    const [incident] = await incidents(`?environment=${production.id}&open=true`);
    const wid = incident.task.wid;
    const id = await plan(production.id, wid, 'waiting');
    let shown = (await body(await api(`infra/incidents/${wid}`))).incident;
    expect(shown.plans.map((p) => p.id)).toEqual([id]);
    expect(Object.fromEntries(shown.steps.map((s) => [s.step, s.state]))).toMatchObject({
      diagnose: 'done',
      propose: 'done',
      approve: 'now',
    });
    for (const [to, by] of [
      ['approved', 'owner'],
      ['applying', 'executor'],
      ['applied', 'executor'],
    ])
      await inStore((store) => store.moveInfraPlan(id, to, { by }));
    shown = (await body(await api(`infra/incidents/${wid}`))).incident;
    expect(shown.steps.find((s) => s.step === 'verify').state).toBe('now');

    const comments = (await detail(wid)).comments.length;
    await record([signal({ level: 'info', at: new Date(Date.now() + 1000).toISOString(), text: 'api is up' })]);
    await record([signal({ level: 'info', at: new Date(Date.now() + 2000).toISOString(), text: 'api is up' })]);
    const task = await detail(wid);
    expect(task.comments).toHaveLength(comments + 1);
    expect(task.comments.at(-1).text).toMatch(/^Signal: health is info again in in-production/);
    expect(task.status).toBe('pending'); // the board never closes it by itself
    shown = (await body(await api(`infra/incidents/${wid}`))).incident;
    expect(shown.recovered).not.toBeNull();
    expect(Object.fromEntries(shown.steps.map((s) => [s.step, s.state]))).toMatchObject({
      verify: 'done',
      'write-up': 'now',
    });

    await api(`tasks/${wid}/done`, { method: 'POST', body: {} });
    expect((await incidents(`?environment=${production.id}&open=true`)).length).toBe(0);
    await record([signal({ at: new Date().toISOString(), text: 'api is down again' })]);
    const open = await incidents(`?environment=${production.id}&open=true`);
    expect(open).toHaveLength(1);
    expect(open[0].task.wid).not.toBe(wid);
    expect((await body(await api(`infra/incidents/${wid}`))).incident.steps.at(-1)).toEqual({
      step: 'write-up',
      state: 'done',
    });
  });

  it('starts no agent, even with a runbook off, and reads only', async () => {
    expect((await record([signal({ resource: 'svc-other' })])).started).toBe(0);
    expect((await body(await api('infra/incidents', { method: 'POST', body: {} }))).status).toBe(404);
    expect((await body(await api('infra/incidents?open=maybe'))).status).toBe(400);
    expect((await body(await api('infra/incidents?limit=1'))).more).toBe(true);
  });
});
