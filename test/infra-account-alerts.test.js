import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertFields, alertPlace, events } from '../src/infra-cloudflare.js';
import { checkSignals } from '../src/infra-provider.js';
import { cloudflare } from '../src/infra-cloudflare.js';
import { ORIGIN } from './constants.js';
import { api, boardApi } from './helpers.js';
import {
  ACCOUNT,
  ALERT_NEVER_KEPT,
  QUEUE_OTHER,
  ZONE,
  cloudflareAnswers,
  cloudflareApi,
} from './cloudflare-fixture.js';

// BRK-255: an alert reaches the environment whose Worker or zone it names, and one about the whole account is kept
// once for the provider, not copied into every environment on the account.

const TOKEN = 'cf-read-token-for-tests-only';
const ZONE_TWO = '0000000000000000000000000000f002';
const HOUR = 3_600_000;
/** When each alert in the made-up history was sent, oldest first, relative to now. */
const T = [8, 7, 6, 5, 4, 3, 2].map((h) => new Date(Math.floor((Date.now() - h * HOUR) / 1000) * 1000).toISOString());

/** The made-up account's alert history: two Worker alerts, three on acme-two.example, one account-wide, one unused. */
function history() {
  const entry = (id, name, sent, data) => ({
    id,
    name,
    alert_type: 'workers_alert',
    sent,
    mechanism: 'oncall@example.com',
    mechanism_type: 'email',
    alert_body: JSON.stringify({
      alert_name: name,
      ts: Date.parse(sent) / 1000,
      text: 'acme-alert-details: write to oncall@example.com',
      data: { account_id: ACCOUNT, ...data },
    }),
  });
  return [
    entry('h1', 'Worker error rate', T[0], { script_name: 'acme-api' }),
    entry('h2', 'Worker error rate', T[1], { script_name: 'acme-other' }),
    entry('h3', 'Advanced certificate', T[2], { zone_name: 'acme-two.example', zone_tag: ZONE_TWO }),
    entry('h4', 'Universal SSL', T[3], { hostnames: ['www.acme-two.example'] }),
    entry('h5', 'Security insight', T[4], { zone_tag: ZONE_TWO }),
    entry('h6', 'Cloudflare incident', T[5], {}),
    entry('h7', 'Advanced certificate', T[6], { zone_name: 'unused.example' }),
  ];
}

/** The made-up account with a second zone, acme-two.example, whose one route sends to acme-other, and the history. */
function answers() {
  const a = cloudflareAnswers();
  const ok = (result) => ({ success: true, errors: [], messages: [], result });
  a[`/accounts/${ACCOUNT}/queues/${QUEUE_OTHER}/consumers`] = ok([{ script: 'acme-other', type: 'worker' }]);
  a[`/accounts/${ACCOUNT}/queues/${QUEUE_OTHER}/metrics`] = ok({ backlog_count: 0 });
  a[`/zones?account.id=${ACCOUNT}&page=1&per_page=50`] = {
    success: true,
    result: [
      { id: ZONE, name: 'acme.example' },
      { id: ZONE_TWO, name: 'acme-two.example' },
      { id: '0000000000000000000000000000f003', name: 'unused.example' },
    ],
    result_info: { page: 1, total_pages: 1 },
  };
  a[`/zones/${ZONE_TWO}/workers/routes`] = {
    success: true,
    result: [{ id: '0000000000000000000000000000d103', pattern: 'www.acme-two.example/*', script: 'acme-other' }],
  };
  a['/zones/0000000000000000000000000000f003/workers/routes'] = { success: true, result: [] };
  a[`/accounts/${ACCOUNT}/alerting/v3/history?*`] = (_body, url) => {
    const since = Date.parse(url.searchParams.get('since') ?? '');
    const before = Date.parse(url.searchParams.get('before') ?? '');
    const sent = history().filter((h) => Date.parse(h.sent) >= since && Date.parse(h.sent) <= before);
    return { success: true, result: sent, result_info: { page: 1, total_pages: 1 } };
  };
  return a;
}

describe('where a Cloudflare alert goes (BRK-255)', () => {
  const resources = [
    { kind: 'worker', name: 'acme-api' },
    { kind: 'route', name: 'api.acme.example/*', attrs: { zone: 'acme.example', worker: 'acme-api' } },
  ];
  const place = (data) => alertPlace(alertFields({ alert_name: 'x', data }), resources);

  it('reads the Worker, the zone, and the hostname an alert names, and nothing else', () => {
    const fields = alertFields({
      alert_name: 'Universal SSL',
      ts: 1_790_000_000,
      text: 'acme-alert-details',
      data: { zone_name: 'Acme.Example', zone_tag: ZONE, hostnames: ['*.API.acme.example'], account_id: ACCOUNT },
    });
    expect(fields).toEqual({
      alert: 'Universal SSL',
      at: new Date(1_790_000_000_000).toISOString(),
      worker: null,
      zone: 'acme.example',
      zoneId: ZONE,
      hostname: 'api.acme.example',
    });
  });

  it('places an alert on its Worker, on a zone the environment uses, for the account, or nowhere', () => {
    expect(place({ script_name: 'acme-api' })).toEqual({ resource: 'worker:acme-api', account: false, on: 'acme-api' });
    expect(place({ script_name: 'acme-other' })).toBeNull();
    expect(place({ zone_name: 'acme.example' })).toEqual({ resource: null, account: false, on: 'acme.example' });
    expect(place({ hostname: 'app.acme.example' })).toEqual({ resource: null, account: false, on: 'app.acme.example' });
    expect(place({ hostname: 'acme.example.evil' })).toBeNull();
    expect(place({ zone_name: 'acme-two.example' })).toBeNull();
    expect(place({ zone_tag: ZONE })).toBeNull();
    expect(place({})).toEqual({ resource: null, account: true, on: null });
  });

  it('reads each environment’s share of the history, finding a zone named by its ID alone', async () => {
    const fetch = cloudflareApi(answers());
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const read = async (target) => {
      const ctx = {
        environment: target === 'acme-api' ? 'production' : 'staging',
        scope: { target },
        token: TOKEN,
        fetch,
      };
      return checkSignals(cloudflare, ctx, since, await events(ctx, since));
    };
    const production = await read('acme-api');
    expect(production.map((s) => [s.resource, s.text, s.account ?? false])).toEqual([
      ['worker:acme-api', 'Cloudflare alert: Worker error rate on acme-api', false],
      [null, 'Cloudflare alert: Cloudflare incident', true],
    ]);
    const staging = await read('acme-other');
    expect(staging.map((s) => [s.resource, s.text, s.account ?? false])).toEqual([
      ['worker:acme-other', 'Cloudflare alert: Worker error rate on acme-other', false],
      [null, 'Cloudflare alert: Advanced certificate on acme-two.example', false],
      [null, 'Cloudflare alert: Universal SSL on www.acme-two.example', false],
      [null, 'Cloudflare alert: Security insight on acme-two.example', false],
      [null, 'Cloudflare alert: Cloudflare incident', true],
    ]);
    const kept = JSON.stringify([production, staging]);
    for (const value of [...ALERT_NEVER_KEPT, ZONE_TWO, ACCOUNT, 'unused.example']) expect(kept).not.toContain(value);
    for (const c of fetch.calls) expect(c.method).toBe('GET');
  });
});

describe('account-wide alerts on the board (BRK-255)', () => {
  const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
  let spy;
  afterEach(() => spy?.mockRestore());

  /** Points Cloudflare's API at the made-up account, connects the token, and makes production and staging. */
  async function twoEnvironments() {
    const cf = cloudflareApi(answers());
    spy?.mockRestore();
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.cloudflare.com/')) return cf(url, init);
      return new Response('{}', { status: 404 });
    });
    const put = await boardApi('infra/connections/cloudflare', { method: 'PUT', body: { token: TOKEN } });
    expect(put.status).toBeLessThan(300);
    const listed = (await (await api('infra/environments?repo=widgets')).json()).environments;
    const made = {};
    for (const [name, kind, target] of [
      ['production', 'production', 'acme-api'],
      ['staging', 'staging', 'acme-other'],
    ]) {
      made[name] = listed.find((e) => e.name === name);
      if (made[name]) continue;
      const res = await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', name, kind, provider: 'cloudflare', target },
      });
      expect(res.status).toBe(201);
      made[name] = (await res.json()).environment;
    }
    await inStore((s) => s.refreshInventory('cloudflare'));
    return made;
  }
  const alertsOf = async (environment) =>
    (await (await api(`infra/signals?environment=${environment}&kind=alert&limit=200`)).json()).signals;
  const texts = async (environment) => (await alertsOf(environment)).map((s) => s.text).sort();
  const account = async () => (await (await api('infra/account-alerts?source=cloudflare')).json()).alerts;

  it('puts each alert in its own environment and keeps an account-wide one once', async () => {
    const { production, staging } = await twoEnvironments();
    expect(await texts('production')).toEqual(['Cloudflare alert: Worker error rate on acme-api']);
    expect(await texts('staging')).toEqual([
      'Cloudflare alert: Advanced certificate on acme-two.example',
      'Cloudflare alert: Security insight on acme-two.example',
      'Cloudflare alert: Universal SSL on www.acme-two.example',
      'Cloudflare alert: Worker error rate on acme-other',
    ]);
    expect((await alertsOf('production'))[0]).toMatchObject({
      environmentId: production.id,
      resource: 'worker:acme-api',
    });
    expect((await alertsOf('staging')).every((s) => s.environmentId === staging.id)).toBe(true);
    expect(await account()).toEqual([
      {
        id: expect.any(Number),
        source: 'cloudflare',
        level: 'warning',
        at: T[5],
        text: 'Cloudflare alert: Cloudflare incident',
      },
    ]);

    // Another refresh reads the same history again and adds nothing anywhere.
    await inStore((s) => s.refreshInventory('cloudflare'));
    expect(await alertsOf('production')).toHaveLength(1);
    expect(await alertsOf('staging')).toHaveLength(4);
    expect(await account()).toHaveLength(1);

    // Read only, and kept as long as raw signals.
    expect((await api('infra/account-alerts', { method: 'POST', body: {} })).status).toBe(405);
    await inStore((s) => s.pruneInfraAccountAlerts(Date.now() + 30 * 24 * HOUR));
    expect(await account()).toEqual([]);
  });

  it('places a webhook’s alert the way the history does', async () => {
    await twoEnvironments();
    const made = await api('routines', {
      method: 'POST',
      body: { slug: 'cf-alerts', name: 'Cloudflare alerts', prompt: 'Look into the alert.', gapMinutes: 0 },
    });
    expect(made.status).toBe(201);
    const secret = (
      await (await api('routines/cf-alerts/triggers', { method: 'POST', body: { label: 'cloudflare' } })).json()
    ).secret;
    const fire = async (alert_name, data) => {
      const res = await SELF.fetch(`${ORIGIN}/api/routines/cf-alerts/fire`, {
        method: 'POST',
        headers: { 'cf-webhook-auth': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_name, ts: Math.floor(Date.now() / 1000), data }),
      });
      expect(res.status).toBe(202);
    };
    const before = { production: await texts('production'), staging: await texts('staging'), account: await account() };

    await fire('Worker CPU time', { script_name: 'acme-api' });
    await fire('Origin errors', { zone_name: 'acme-two.example' });
    await fire('Certificate expiring', { hostname: 'www.acme-two.example' });
    await fire('Cloudflare maintenance', {});
    await fire('Cloudflare maintenance', {});
    await fire('Advanced certificate', { zone_name: 'unused.example' });

    const added = (now, was) => now.filter((t) => !was.includes(t));
    expect(added(await texts('production'), before.production)).toEqual([
      'Cloudflare alert: Worker CPU time on acme-api',
    ]);
    expect(added(await texts('staging'), before.staging)).toEqual([
      'Cloudflare alert: Certificate expiring on www.acme-two.example',
      'Cloudflare alert: Origin errors on acme-two.example',
    ]);
    expect((await account()).length - before.account.length).toBe(1);
    expect((await account())[0]).toMatchObject({ text: 'Cloudflare alert: Cloudflare maintenance' });
  });

  it('moves the copies an older board kept in every environment into one account-wide alert, once', async () => {
    const { production, staging } = await twoEnvironments();
    const at = Date.now() - 3 * HOUR;
    const moved = await inStore((s) => {
      const row = (environment, environmentId, text, when = at) =>
        s.sql.exec(
          "INSERT INTO infra_signals (at, received, source, environment, environment_id, resource, kind, level, value, text) VALUES (?, ?, 'cloudflare', ?, ?, NULL, 'alert', 'warning', NULL, ?)",
          when,
          when,
          environment,
          environmentId,
          text,
        );
      row('production', production.id, 'Cloudflare alert: Acme status page');
      row('staging', staging.id, 'Cloudflare alert: Acme status page');
      row('production', production.id, 'Cloudflare alert: Only production’s', at + 1000);
      s.setMeta('infra_account_alerts_moved', null);
      s.initInfraAccountAlerts();
      s.initInfraAccountAlerts();
      return s.sql.exec('SELECT COUNT(*) AS n FROM infra_account_alerts').one().n;
    });
    expect(moved).toBe(2);
    expect(await texts('production')).toContain('Cloudflare alert: Only production’s');
    expect(await texts('production')).not.toContain('Cloudflare alert: Acme status page');
    expect(await texts('staging')).not.toContain('Cloudflare alert: Acme status page');
    expect((await account()).map((a) => a.text)).toContain('Cloudflare alert: Acme status page');
  });
});
