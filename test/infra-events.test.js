import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import {
  INFRA_EVENTS,
  INFRA_EVENT_FIELDS,
  infraEventData,
  infraEventMatches,
  infraEventOf,
  infraEventText,
  infraEventsOf,
  planCause,
} from '../src/infra-events.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const PROVIDER = 'fakeevents';
const fires = [];
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));

const make = (slug, extra = {}) =>
  api('routines', {
    method: 'POST',
    body: { slug, name: `Routine ${slug}`, prompt: `Look into ${slug}.`, gapMinutes: 0, ...extra },
  });
const routine = async (slug) => (await body(await api('routines'))).routines.find((r) => r.slug === slug);
const detail = async (wid) => (await body(await api(`tasks/${wid}`))).task;
const finish = (wid) => api(`tasks/${wid}/done`, { method: 'POST', body: {} });
const refusals = async (slug) =>
  (await body(await api('activity?limit=200'))).events
    .filter((e) => e.source === 'routines' && e.changes[0].kind === 'trigger_refused' && e.changes[0].routine === slug)
    .map((e) => e.changes[0].detail);
/** Says an event the way a store does, then waits for its delivery. */
const say = (key, where, what = {}) =>
  inStore(async (store) => {
    store.infraEvent(key, where, what);
    return store.flushInfraEvents();
  });
const STAGING = { repo: 'widgets', name: 'ev-staging', kind: 'staging' };

describe('infrastructure triggers, the pure part (BRK-293)', () => {
  it('reads keys, filters, and objects, and refuses what it doesn’t know', () => {
    expect(infraEventsOf('')).toEqual([]);
    const list = infraEventsOf(
      'plan.failed, drift.found:environment=staging+Production:resource=database,budget.crossed:percent=80:kind=production',
    );
    expect(list).toEqual([
      { event: 'plan.failed', environments: [], kinds: [], resourceKinds: [] },
      { event: 'drift.found', environments: ['staging', 'production'], kinds: [], resourceKinds: ['database'] },
      { event: 'budget.crossed', environments: [], kinds: ['production'], resourceKinds: [], percent: 80 },
    ]);
    expect(list.map(infraEventText)).toEqual([
      'plan.failed',
      'drift.found:environment=staging+production:resource=database',
      'budget.crossed:kind=production:percent=80',
    ]);
    expect(infraEventsOf(list.map(infraEventText).join(','))).toEqual(list);
    expect(infraEventsOf([{ event: 'budget.crossed' }])[0].percent).toBe(100);
    expect(infraEventsOf([{ event: 'plan.waiting', kinds: ['staging'] }])[0].kinds).toEqual(['staging']);
    expect(() => infraEventsOf('plan.exploded')).toThrow(/infrastructure events are plan\.waiting/);
    expect(() => infraEventsOf('plan.failed:colour=red')).toThrow(/no filter "colour"/);
    expect(() => infraEventsOf('plan.failed:kind=sandbox')).toThrow(/production, staging, short-lived/);
    expect(() => infraEventsOf('plan.failed:percent=50')).toThrow(/budget\.crossed only/);
    expect(() => infraEventsOf('budget.crossed:percent=0')).toThrow(/1 to 1000/);
    expect(() => infraEventsOf('plan.failed,plan.failed:kind=staging')).toThrow(/listed twice/);
    expect(() => infraEventsOf('plan.failed:environment=Bad Name!')).toThrow(/environments’ names/);
    expect(() => infraEventsOf('plan.failed:nothing')).toThrow(/name=value/);
  });

  it('matches its key, environments, kinds, resource kinds, and a budget’s share since the last look', () => {
    const event = infraEventOf('plan.failed', STAGING, { resourceKinds: ['service'] });
    const [any, here, prod, db, svc] = [
      'plan.failed',
      'plan.failed:environment=ev-staging',
      'plan.failed:kind=production',
      'plan.failed:resource=database',
      'plan.failed:resource=service',
    ].map((text) => infraEventsOf(text)[0]);
    expect(infraEventMatches(any, event)).toBe(true);
    expect(infraEventMatches(here, event)).toBe(true);
    expect(infraEventMatches(prod, event)).toBe(false);
    expect(infraEventMatches(db, event)).toBe(false);
    expect(infraEventMatches(svc, event)).toBe(true);
    expect(infraEventMatches(any, infraEventOf('plan.applied', STAGING))).toBe(false);
    // An event that names no resource kind never matches a resource kind filter.
    expect(infraEventMatches(svc, infraEventOf('plan.failed', STAGING))).toBe(false);

    const [eighty] = infraEventsOf('budget.crossed:percent=80');
    const budget = (before, used) => infraEventOf('budget.crossed', STAGING, { fields: { before, used } });
    expect(infraEventMatches(eighty, budget(50, 85))).toBe(true);
    expect(infraEventMatches(eighty, budget(0, 80))).toBe(true);
    expect(infraEventMatches(eighty, budget(81, 95))).toBe(false); // past it already
    expect(infraEventMatches(eighty, budget(10, 60))).toBe(false); // not there yet
  });

  it('hands a run the allowlisted fields only: names, IDs, states, and counts, never text or a token', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const event = infraEventOf('plan.failed', STAGING, {
      fields: {
        plan: 'plan-12',
        state: 'failed',
        source: 'pull-request',
        count: 2,
        text: 'the provider said: out of memory',
        secret: token,
        resource: token,
        task: 'it said <script> and more, which is not a name',
        used: Number.NaN,
      },
      dedupe: 'plan-12',
      cause: { pull: 12, wid: 'nope nope' },
    });
    const data = infraEventData(event);
    expect(Object.keys(data)).toEqual(['event', 'environment', 'kind', 'plan', 'state', 'source', 'count']);
    expect(Object.keys(data).every((k) => INFRA_EVENT_FIELDS.includes(k))).toBe(true);
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.cause).toEqual({ pull: 12, wid: null });
    expect(event.dedupe).toBe(infraEventOf('plan.failed', STAGING, { dedupe: 'plan-12' }).dedupe);
    expect(event.dedupe).not.toBe(infraEventOf('plan.failed', STAGING, { dedupe: 'plan-13' }).dedupe);
  });

  it('reads what caused a plan from its source reference', () => {
    expect(planCause('#42')).toEqual({ pull: 42 });
    expect(planCause('RUN-7')).toEqual({ wid: 'RUN-7' });
    expect(planCause('scaling.json')).toEqual({});
    expect(planCause(null)).toEqual({});
  });
});

describe('routines started by infrastructure events (BRK-293)', () => {
  let spy;
  let provider;
  beforeAll(async () => {
    provider = fakeProvider({ id: PROVIDER });
    await inStore(async (store) => {
      store.infraProviders = new ProviderRegistry();
      store.infraProviders.register(provider);
      store.pushInfraPlan = async () => {};
    });
    // Every event key starts a run here: room for them all under the cap for all routines a day.
    await api('routines/settings', { method: 'PATCH', body: { dailyCap: 100 } });
  });
  beforeEach(() => {
    fires.length = 0;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      const id = `session_${fires.length}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    });
  });
  afterEach(() => spy.mockRestore());

  it('queues nothing while no routine listens', async () => {
    await say('plan.failed', STAGING);
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM infra_events').one().n)).toBe(0);
  });

  it('is set by the owner, shown on the routine, and cleared with an empty list; a routine maker can’t set it', async () => {
    const made = await body(await make('ev-owner', { infraEvents: 'plan.failed:kind=production' }));
    expect(made.status).toBe(201);
    expect((await routine('ev-owner')).infraEvents).toEqual([
      { event: 'plan.failed', environments: [], kinds: ['production'], resourceKinds: [] },
    ]);
    const bad = await body(
      await api('routines/ev-owner', { method: 'PATCH', body: { infraEvents: ['plan.exploded'] } }),
    );
    expect(bad.status).toBe(400);
    await api('routines/ev-owner', { method: 'PATCH', body: { name: 'Renamed' } });
    expect((await routine('ev-owner')).infraEvents).toHaveLength(1); // kept when not given
    await api('routines/ev-owner', { method: 'PATCH', body: { infraEvents: '' } });
    expect((await routine('ev-owner')).infraEvents).toEqual([]);

    const maker = await body(
      await api('routines/agent', { method: 'POST', body: { prompt: 'Make a routine for failed plans' } }),
    );
    const agent = `claude-${maker.task.short}`;
    const refused = await body(await make('ev-maker', { by: agent, infraEvents: 'plan.failed' }));
    expect(refused).toMatchObject({ status: 403, error: /only the owner turns on infrastructure events/ });
    expect((await body(await make('ev-maker', { by: agent }))).status).toBe(201);
    const change = await body(
      await api('routines/ev-maker', { method: 'PATCH', body: { by: agent, infraEvents: 'plan.failed' } }),
    );
    expect(change.status).toBe(403);
  });

  it('starts a run for every event key, with the event’s fields and nothing else', async () => {
    for (const [i, key] of Object.keys(INFRA_EVENTS).entries()) {
      const slug = `ev-key-${i}`;
      await make(slug, { infraEvents: key === 'budget.crossed' ? `${key}:percent=50` : key });
      await say(key, STAGING, {
        fields: { state: 'x', count: 1, used: 60, before: 10, text: 'never shown' },
        dedupe: key,
      });
      const r = await routine(slug);
      expect(r.recentRuns, key).toHaveLength(1);
      expect(r.recentRuns[0].trigger).toBe('infra');
      const comment = (await detail(r.recentRuns[0].wid)).comments.at(-1).text;
      expect(comment).toContain(`from the trigger “Infrastructure: ${INFRA_EVENTS[key]}, in ev-staging”`);
      expect(comment).toContain(`event: ${key}`);
      expect(comment).toContain('kind: staging');
      expect(comment).not.toContain('never shown');
      expect(comment).not.toContain('before:');
      expect(comment).toContain('Read only');
      await api(`routines/${slug}`, { method: 'PATCH', body: { infraEvents: '' } });
    }
    expect(fires).toHaveLength(0); // each waits for the owner's Start
  });

  it('matches only its filters and its own repository, and a routine that’s off starts nothing', async () => {
    await make('ev-picky', { infraEvents: 'plan.applied:environment=ev-prod:resource=database' });
    await say('plan.applied', { repo: 'widgets', name: 'ev-prod', kind: 'production' }, { resourceKinds: ['service'] });
    await say('plan.applied', STAGING, { resourceKinds: ['database'] });
    await say('plan.applied', { repo: 'other', name: 'ev-prod', kind: 'production' }, { resourceKinds: ['database'] });
    expect((await routine('ev-picky')).recentRuns).toEqual([]);
    await say(
      'plan.applied',
      { repo: 'widgets', name: 'ev-prod', kind: 'production' },
      { resourceKinds: ['database'] },
    );
    expect((await routine('ev-picky')).recentRuns).toHaveLength(1);

    await make('ev-off', { infraEvents: 'plan.applied', enabled: false });
    await say('plan.applied', STAGING, { dedupe: 'off' });
    expect((await routine('ev-off')).recentRuns).toEqual([]);
  });

  it('starts once per thing: a duplicate does nothing, another is noted on the open run', async () => {
    await make('ev-dedupe', { infraEvents: 'drift.found' });
    await say('drift.found', STAGING, { dedupe: 'fp-1' });
    const r = await routine('ev-dedupe');
    expect(r.recentRuns).toHaveLength(1);
    const before = (await detail(r.recentRuns[0].wid)).comments.length;
    await say('drift.found', STAGING, { dedupe: 'fp-1' });
    expect((await detail(r.recentRuns[0].wid)).comments).toHaveLength(before);
    await say('drift.found', STAGING, { dedupe: 'fp-2' });
    expect((await routine('ev-dedupe')).recentRuns).toHaveLength(1);
    expect((await detail(r.recentRuns[0].wid)).comments).toHaveLength(before + 1);
  });

  it('starts the agent when the routine says auto, and stays under its daily cap', async () => {
    await make('ev-auto', { infraEvents: 'incident.opened', triggerStart: 'auto', dailyCap: 1 });
    await say('incident.opened', STAGING, { dedupe: 'i-1' });
    expect(fires).toHaveLength(1);
    const first = (await routine('ev-auto')).recentRuns[0];
    expect(fires[0]).toContain(`Task: ${first.wid}`);
    await finish(first.wid);
    await say('incident.opened', STAGING, { dedupe: 'i-2' });
    expect(fires).toHaveLength(1);
    expect((await refusals('ev-auto')).some((d) => /daily cap/.test(d))).toBe(true);
  });

  it('never starts again on what its own run caused: its pull request or its work ID', async () => {
    await make('ev-loop', { infraEvents: 'plan.applied' });
    const run = await body(await api('routines/ev-loop/run', { method: 'POST', body: {} }));
    const wid = run.task.wid;
    await api(`tasks/${wid}`, { method: 'PATCH', body: { pr: '77' } });
    await finish(wid);
    await say('plan.applied', STAGING, { dedupe: 'plan-77', cause: { pull: 77 } });
    await say('plan.applied', STAGING, { dedupe: 'plan-78', cause: { wid } });
    expect((await routine('ev-loop')).recentRuns).toHaveLength(1);
    expect((await refusals('ev-loop')).filter((d) => /its own run caused it/.test(d))).toHaveLength(2);
    // Someone else's pull request still starts it.
    await say('plan.applied', STAGING, { dedupe: 'plan-79', cause: { pull: 79 } });
    expect((await routine('ev-loop')).recentRuns).toHaveLength(2);
  });

  it('hears plans as they move: waiting, applied, failed, and rolled back', async () => {
    await make('ev-plans', { infraEvents: 'plan.waiting,plan.applied,plan.failed,plan.rolled_back' });
    const made = await body(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'ev-plans', kind: 'staging', target: 'svc-api' },
      }),
    );
    const id = made.environment.id;
    const diff = {
      provider: PROVIDER,
      environment: 'ev-plans',
      changes: [
        {
          op: 'restart',
          resource: 'svc-api',
          kind: 'service',
          name: 'api',
          before: {},
          after: {},
          reversible: true,
        },
      ],
      reversible: true,
    };
    const run = async (path) =>
      inStore(async (store) => {
        const plan = await store.makeInfraPlan(id, { source: 'drift', by: 'board', diff });
        for (const [to, by] of path)
          store.moveInfraPlan(plan.id, to, { by, digest: to === 'approved' ? 'a'.repeat(64) : undefined });
        await store.flushInfraEvents();
        return plan.id;
      });
    const applied = await run([
      ['waiting', 'board'],
      ['approved', 'owner'],
      ['applying', 'executor'],
      ['applied', 'executor'],
      ['rolled back', 'executor'],
    ]);
    const r = await routine('ev-plans');
    expect(r.recentRuns).toHaveLength(1);
    const comments = (await detail(r.recentRuns[0].wid)).comments.map((c) => c.text);
    const seen = (key) => comments.filter((c) => c.includes(`event: ${key}`) && c.includes(`plan: ${applied}`));
    expect(seen('plan.waiting')).toHaveLength(1);
    expect(seen('plan.applied')).toHaveLength(1);
    expect(seen('plan.rolled_back')).toHaveLength(1);
    expect(comments.some((c) => c.includes('event: plan.waiting') && c.includes('source: drift'))).toBe(true);
    const failed = await run([
      ['waiting', 'board'],
      ['approved', 'owner'],
      ['applying', 'executor'],
      ['failed', 'executor'],
    ]);
    const after = (await detail(r.recentRuns[0].wid)).comments.map((c) => c.text);
    expect(after.some((c) => c.includes('event: plan.failed') && c.includes(`plan: ${failed}`))).toBe(true);
  });

  it('hears environments added and removed, drift found, an inventory gone stale, and a budget passing its share', async () => {
    await make('ev-envs', {
      infraEvents: 'environment.created,environment.removed,drift.found,inventory.stale,budget.crossed:percent=80',
    });
    const made = await body(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'ev-envs', kind: 'staging', target: 'svc-api' },
      }),
    );
    const envRow = made.environment;
    await inStore((s) => s.flushInfraEvents());
    const r = await routine('ev-envs');
    expect(r.recentRuns).toHaveLength(1);
    const comments = async () => (await detail(r.recentRuns[0].wid)).comments.map((c) => c.text);
    expect((await comments()).some((c) => c.includes('event: environment.created'))).toBe(true);

    // Drift: what runs differs from the desired state.
    await inStore(async (store) => {
      store.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'ev-envs.json', 'ev-envs', ?, 'abc123', ?, ?, 'abc123', ?, NULL)`,
        PROVIDER,
        Date.now(),
        JSON.stringify({
          version: 1,
          provider: PROVIDER,
          resources: provider.state.resources.map((x) =>
            x.id === 'db-main' ? { ...structuredClone(x), attrs: { ...x.attrs, size: 'huge' } } : structuredClone(x),
          ),
        }),
        Date.now(),
      );
      await store.checkInfraDrift(envRow.id);
      await store.flushInfraEvents();
    });
    expect((await comments()).some((c) => c.includes('event: drift.found') && c.includes('count: 1'))).toBe(true);

    // An inventory gone stale, once until it's fresh again.
    await inStore(async (store) => {
      const row = store.sql.exec('SELECT * FROM infra_environments WHERE id = ?', envRow.id).one();
      store.inventoryStaleSeen(row, PROVIDER, 'token ghp_secret refused', Date.now());
      store.inventoryStaleSeen(row, PROVIDER, 'token ghp_secret refused', Date.now() + 1);
      await store.flushInfraEvents();
    });
    const stale = (await comments()).filter((c) => c.includes('event: inventory.stale'));
    expect(stale).toHaveLength(1);
    expect(stale[0]).not.toContain('ghp_secret');

    // A budget: 50% starts nothing, 85% passes the routine's 80%, and 90% after it is past it already.
    const used = (share) =>
      inStore(async (store) => {
        const row = store.sql.exec('SELECT * FROM infra_environments WHERE id = ?', envRow.id).one();
        store.infraBudgetUsed(row, '2026-10', share);
        await store.flushInfraEvents();
      });
    await used(50);
    await used(85);
    await used(90);
    const budget = (await comments()).filter((c) => c.includes('event: budget.crossed'));
    expect(budget).toHaveLength(1);
    expect(budget[0]).toContain('used: 85');

    await boardApi(`infra/environments/${envRow.id}`, { method: 'DELETE', body: {} });
    await inStore((s) => s.flushInfraEvents());
    expect((await comments()).some((c) => c.includes('event: environment.removed'))).toBe(true);
  });

  it('delivers on the cron what a delivery left behind, and drops what’s too old', async () => {
    await make('ev-cron', { infraEvents: 'promote.done' });
    await inStore((store) => {
      const now = Date.now();
      const event = (dedupe) => JSON.stringify(infraEventOf('promote.done', STAGING, { dedupe }));
      store.sql.exec(
        'INSERT INTO infra_events (at, event, taken) VALUES (?, ?, ?), (?, ?, NULL)',
        now - 60_000,
        event('left'),
        now - 30 * 60_000,
        now - 2 * 86_400_000,
        event('old'),
      );
    });
    await inStore((s) => s.flushInfraEvents());
    const r = await routine('ev-cron');
    expect(r.recentRuns).toHaveLength(1);
    expect((await detail(r.recentRuns[0].wid)).comments).toHaveLength(1); // the one left behind, never the old one
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM infra_events').one().n)).toBe(0);
  });
});
