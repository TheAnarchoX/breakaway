import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { DAY, foldSignals, healthSignals, signalEntry } from '../src/infra-signals.js';
import { SIGNAL_RAW_DAYS, SIGNAL_SUMMARY_DAYS, signalSubscribers } from '../src/store-infra-signals.js';

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const read = async (query = '') => {
  const res = await api(`infra/signals${query}`);
  expect(res.status).toBe(200);
  return res.json();
};
const iso = (ms) => new Date(ms).toISOString();
const signal = (over = {}) => ({
  source: 'fake',
  environment: 'sig-staging',
  resource: 'svc-api',
  kind: 'health',
  level: 'info',
  value: null,
  at: iso(Date.now() - 60_000),
  text: 'api is up',
  ...over,
});

const unsubscribe = [];
afterEach(() => {
  for (const off of unsubscribe.splice(0)) off();
});

describe('signals', () => {
  it('stores health, alert, and cost signals from the fake provider and reads them back by environment', async () => {
    const provider = fakeProvider();
    const stored = await inStore((store) =>
      store.pullProviderSignals(provider, { environment: 'sig-fake' }, '2026-10-01T00:00:00Z'),
    );
    expect(stored.map((s) => s.kind)).toEqual(['health', 'alert', 'cost']);
    expect(provider.calls).toEqual([{ method: 'events', environment: 'sig-fake' }]);

    const { signals, more } = await read('?environment=sig-fake');
    expect(more).toBe(false);
    expect(signals.map((s) => s.kind)).toEqual(['cost', 'alert', 'health']);
    expect(signals[1]).toMatchObject({
      source: 'fake',
      environment: 'sig-fake',
      resource: 'db-main',
      kind: 'alert',
      level: 'warning',
      value: 81,
      at: provider.state.events[1].at,
      text: 'main is 81% full',
    });
    expect(signals[0].resource).toBeNull();
    expect((await read('?environment=sig-fake&resource=db-main')).signals.map((s) => s.text)).toEqual([
      'main is 81% full',
    ]);
    expect((await read('?environment=sig-fake&kind=cost')).signals.map((s) => s.value)).toEqual([6.5]);
    expect((await read('?environment=sig-fake&level=warning')).signals).toHaveLength(1);
    expect((await read('?environment=sig-nowhere')).signals).toEqual([]);
  });

  it('keeps the environment’s ID beside its name, and reads and summarises by it', async () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const old = iso(Date.parse('2026-09-20T10:00:00Z'));
    const result = await inStore(async (store) => {
      const stored = await store.recordSignals([
        signal({ environment: 'sig-ids', environmentId: 41, text: 'acme/widgets staging' }),
        signal({ environment: 'sig-ids', environmentId: 42, text: 'acme/gadgets staging' }),
        signal({ environment: 'sig-ids', environmentId: 41, at: old }),
        signal({ environment: 'sig-ids', environmentId: 42, at: old }),
      ]);
      store.foldInfraSignals(now);
      return {
        stored,
        days: store.infraSignalDays({ environmentId: 41 }).days,
      };
    });
    expect(result.stored.map((s) => s.environmentId).sort()).toEqual([41, 41, 42, 42]);
    const { signals } = await read('?environmentId=41');
    expect(signals.map((s) => [s.environment, s.environmentId, s.text])).toEqual([
      ['sig-ids', 41, 'acme/widgets staging'],
    ]);
    expect(result.days).toEqual([expect.objectContaining({ environment: 'sig-ids', environmentId: 41, count: 1 })]);
    const days = await (await api('infra/signals/days?environment=sig-ids')).json();
    expect(days.days.map((d) => d.environmentId).sort()).toEqual([41, 42]);
    expect((await api('infra/signals?environmentId=x')).status).toBe(400);
    expect(() => signalEntry(signal({ environmentId: -1 }))).toThrow(/environmentId/u);
    expect(signalEntry(signal()).environmentId).toBeNull();
  });

  it('refuses any other kind, and stores none of a batch with one in it', async () => {
    for (const kind of ['metric', 'log', 'trace']) {
      const error = await inStore((store) =>
        store
          .recordSignals([signal({ environment: 'sig-refused' }), signal({ environment: 'sig-refused', kind })])
          .then(
            () => null,
            (e) => e,
          ),
      );
      expect(error?.message).toMatch(/^kind must be one of health, alert, cost/u);
      expect(error.status).toBe(400);
    }
    expect((await read('?environment=sig-refused')).signals).toEqual([]);
    expect((await api('infra/signals?kind=metric')).status).toBe(400);
    expect((await api('infra/signals?level=loud')).status).toBe(400);
    expect((await api('infra/signals?limit=0')).status).toBe(400);
  });

  it('checks every field before it stores a signal', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const ok = signal({ at: '2026-10-06T11:00:00Z' });
    expect(signalEntry(ok, now)).toMatchObject({ at: Date.parse(ok.at), resource: 'svc-api' });
    expect(signalEntry({ ...ok, resource: null }, now).resource).toBeNull();
    for (const [field, value, message] of [
      ['source', 'Fake Platform', /source/u],
      ['environment', '', /environment/u],
      ['level', 'loud', /level/u],
      ['resource', '', /resource/u],
      ['value', '81', /value/u],
      ['value', Number.NaN, /value/u],
      ['at', 'yesterday', /at must be a time/u],
      ['at', '2026-10-08T12:00:00Z', /ahead/u],
      ['text', '   ', /text/u],
    ])
      expect(() => signalEntry({ ...ok, [field]: value }, now), `${field} ${value}`).toThrow(message);
    expect(signalEntry({ ...ok, text: 'x'.repeat(900) }, now).text).toHaveLength(500);
  });

  it('redacts an email address or a token in a signal before it stores it', async () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const [stored] = await inStore((store) =>
      store.recordSignals([
        signal({
          environment: 'sig-redact',
          kind: 'alert',
          level: 'critical',
          text: `deploy by ops@acme.example failed with ${token}\nand CF_API_TOKEN=abc123 Bearer ${'x9Y8z7W6v5'.repeat(3)}`,
        }),
      ]),
    );
    expect(stored.text).toBe(
      'deploy by [redacted] failed with [redacted] and CF_API_TOKEN=[redacted] Bearer [redacted]',
    );
    const raw = await inStore((store) =>
      store.sql.exec("SELECT text FROM infra_signals WHERE environment = 'sig-redact'").toArray(),
    );
    expect(JSON.stringify(raw)).not.toMatch(/ops@acme|ghp_|abc123|x9Y8/u);
    const shown = JSON.stringify(await read('?environment=sig-redact'));
    expect(shown).not.toMatch(/ops@acme|ghp_|abc123|x9Y8/u);
  });

  it('folds signals older than 7 days into daily summaries, and drops summaries after 90', async () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const old = Date.parse('2026-09-20T00:00:00Z');
    const result = await inStore(async (store) => {
      // Stored with the clock as it was, as if the signals came in on time.
      const rows = [
        signal({
          environment: 'sig-fold',
          kind: 'alert',
          level: 'warning',
          value: 70,
          at: iso(old + 3_600_000),
          text: 'main is 70% full',
        }),
        signal({
          environment: 'sig-fold',
          kind: 'alert',
          level: 'critical',
          value: 95,
          at: iso(old + 7_200_000),
          text: 'main is 95% full',
        }),
        signal({
          environment: 'sig-fold',
          kind: 'alert',
          level: 'warning',
          value: 80,
          at: iso(old + 10_800_000),
          text: 'main is 80% full',
        }),
        signal({ environment: 'sig-fold', kind: 'health', level: 'info', at: iso(old + 3_600_000), text: 'api is up' }),
        signal({ environment: 'sig-fold', kind: 'health', level: 'info', at: iso(now - DAY), text: 'api is still up' }),
        signal({
          environment: 'sig-fold',
          kind: 'cost',
          value: 1,
          at: iso(now - (SIGNAL_SUMMARY_DAYS + 5) * DAY),
          text: 'long ago',
        }),
      ];
      await store.recordSignals(rows);
      store.foldInfraSignals(now);
      return {
        raw: store.infraSignals({ environment: 'sig-fold' }).signals,
        days: store.infraSignalDays({ environment: 'sig-fold' }).days,
      };
    });
    expect(SIGNAL_RAW_DAYS).toBe(7);
    expect(SIGNAL_SUMMARY_DAYS).toBe(90);
    expect(result.raw.map((s) => s.text)).toEqual(['api is still up']);
    expect(result.days).toEqual([
      {
        day: '2026-09-20',
        source: 'fake',
        environment: 'sig-fold',
        environmentId: null,
        resource: 'svc-api',
        kind: 'alert',
        count: 3,
        info: 0,
        warning: 2,
        critical: 1,
        min: 70,
        max: 95,
        last: 80,
        lastAt: iso(old + 10_800_000),
        text: 'main is 80% full',
      },
      expect.objectContaining({ day: '2026-09-20', kind: 'health', count: 1, info: 1, min: null, last: null }),
    ]);

    // Folding again adds a late signal to the same day instead of overwriting it.
    const again = await inStore(async (store) => {
      store.sql.exec(
        "INSERT INTO infra_signals (at, received, source, environment, resource, kind, level, value, text) VALUES (?, ?, 'fake', 'sig-fold', 'svc-api', 'alert', 'info', 60, 'main is 60% full')",
        old + 1_000,
        now,
      );
      store.foldInfraSignals(now);
      return store.infraSignalDays({ environment: 'sig-fold', kind: 'alert' }).days;
    });
    expect(again).toEqual([expect.objectContaining({ count: 4, info: 1, min: 60, last: 80 })]);

    // 90 days on, September's summaries go too; the last raw signal has folded into its own day by then.
    const later = await inStore((store) => {
      store.foldInfraSignals(old + (SIGNAL_SUMMARY_DAYS + 2) * DAY);
      return {
        raw: store.infraSignals({ environment: 'sig-fold' }).signals,
        days: store.infraSignalDays({ environment: 'sig-fold' }).days,
      };
    });
    expect(later.raw).toEqual([]);
    expect(later.days.map((d) => `${d.day} ${d.kind} ${d.count}`)).toEqual(['2026-10-05 health 1']);
    expect((await api('infra/signals/days?environment=sig-fold')).status).toBe(200);
  });

  it('reaches every subscriber after storing, and a subscriber that fails loses nothing', async () => {
    const heard = [];
    unsubscribe.push(
      signalSubscribers.subscribe('broken', () => {
        throw new Error('runbook down');
      }),
      signalSubscribers.subscribe('listener', (_store, signals) => {
        heard.push(...signals.map((s) => `${s.environment} ${s.kind} ${s.level}`));
      }),
    );
    expect(() => signalSubscribers.subscribe('listener', () => {})).toThrow(/already registered/u);
    await inStore((store) =>
      store.recordSignals([signal({ environment: 'sig-subs', kind: 'alert', level: 'critical', text: 'api is down' })]),
    );
    expect(heard).toEqual(['sig-subs alert critical']);
    expect((await read('?environment=sig-subs')).signals).toHaveLength(1);
  });

  it('is read only over the API', async () => {
    expect((await api('infra/signals', { method: 'POST', body: [signal()] })).status).toBe(405);
  });

  it('folds pure signals by day, kind, and resource', () => {
    const at = Date.parse('2026-10-01T10:00:00Z');
    const e = (over) => signalEntry(signal({ at: iso(at), ...over }), at);
    const days = foldSignals([e({}), e({ resource: 'db-main' }), e({ at: iso(at + DAY) })]);
    expect(days.map((d) => `${d.day} ${d.resource} ${d.count}`)).toEqual([
      '2026-10-01 svc-api 1',
      '2026-10-01 db-main 1',
      '2026-10-02 svc-api 1',
    ]);
  });
});

describe('health as signals (BRK-191)', () => {
  const where = { source: 'fake', environment: 'production', environmentId: 7 };
  const at = '2026-10-06T10:00:00.000Z';

  it('signals degraded and down, healthy again once, and nothing for healthy or unknown', () => {
    const health = [
      { resource: 'svc-api', state: 'down', at, text: 'half its requests failed' },
      { resource: 'db-main', state: 'degraded', at },
      { resource: 'route-api', state: 'healthy', at },
      { resource: 'svc-new', state: 'unknown', at },
      { resource: 'svc-back', state: 'healthy', at, text: 'all good' },
    ];
    const before = new Map([
      ['route-api', 'healthy'],
      ['svc-new', 'down'],
      ['svc-back', 'degraded'],
    ]);
    const signals = healthSignals(where, health, before);
    expect(signals.map((s) => [s.resource, s.level, s.text])).toEqual([
      ['svc-api', 'critical', 'svc-api is down: half its requests failed'],
      ['db-main', 'warning', 'db-main is degraded'],
      ['svc-back', 'info', 'svc-back is healthy again: all good'],
    ]);
    for (const s of signals) {
      expect(s).toMatchObject({ source: 'fake', environment: 'production', environmentId: 7, kind: 'health', at });
      expect(() => signalEntry(s)).not.toThrow();
    }
    expect(healthSignals(where, health.slice(2))).toEqual([]);
  });
});
