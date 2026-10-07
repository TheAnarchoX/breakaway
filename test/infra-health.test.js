import { describe, expect, it } from 'vitest';
import {
  HEALTH_URL_MAX,
  checkHealthField,
  debounceHealthUrl,
  keepLastHealth,
  readHealthUrl,
  rollUpHealth,
  withHealthUrl,
} from '../src/infra-health.js';
import { checkDesiredFile } from '../src/infra-desired.js';
import { healthSignals } from '../src/infra-signals.js';
import { healthVerdict } from '../src/infra-runs.js';

const AT = new Date(Date.now() - 60_000).toISOString();

describe('an environment’s health from its resources’ (BRK-266)', () => {
  const h = (state, note) => ({ state, ...(note ? { note } : {}) });

  it('lets down and degraded win, with how many', () => {
    expect(rollUpHealth([h('healthy'), h('down'), h('degraded'), h('down')])).toEqual({
      state: 'down',
      count: 2,
      total: 4,
      notRead: 0,
    });
    expect(rollUpHealth([h('idle'), h('degraded'), h('unknown')])).toMatchObject({ state: 'degraded', count: 1 });
  });

  it('reads healthy with healthy and idle resources plus one unreadable one, noting it', () => {
    expect(rollUpHealth([h('healthy'), h('idle'), h('idle'), h('unknown')])).toEqual({
      state: 'healthy',
      count: 3,
      total: 4,
      notRead: 1,
    });
    // A health kept from an earlier read counts as not read now, and a resource never seen too.
    expect(rollUpHealth([h('healthy'), h('healthy', 'Couldn’t read its health'), null])).toMatchObject({
      state: 'healthy',
      notRead: 2,
    });
  });

  it('reads idle when every readable resource is quiet, and unknown only when none could be read', () => {
    expect(rollUpHealth([h('idle'), h('idle')])).toEqual({ state: 'idle', count: 2, total: 2, notRead: 0 });
    expect(rollUpHealth([h('unknown'), null])).toEqual({ state: 'unknown', count: 2, total: 2, notRead: 2 });
    expect(rollUpHealth([])).toBeNull();
  });
});

describe('keeping the last health when a read fails (BRK-266)', () => {
  const last = { health: 'healthy', health_at: 1_000, health_text: '10 requests, 0 failed, in the last 15 minutes' };

  it('keeps the last known health and its time, and notes what failed', () => {
    expect(
      keepLastHealth({ resource: 'r', state: 'unknown', at: AT, text: 'Couldn’t read its backlog: GET …' }, last),
    ).toEqual({
      state: 'healthy',
      at: 1_000,
      text: '10 requests, 0 failed, in the last 15 minutes',
      note: 'Couldn’t read its backlog: GET …',
    });
    expect(keepLastHealth(null, last, 'Cloudflare refused')).toMatchObject({
      state: 'healthy',
      at: 1_000,
      note: 'Couldn’t read its health: Cloudflare refused',
    });
  });

  it('takes what was read, idle included, and unknown when there was nothing to keep', () => {
    expect(keepLastHealth({ resource: 'r', state: 'idle', at: AT, text: 'Idle: no requests' }, last)).toEqual({
      state: 'idle',
      at: Date.parse(AT),
      text: 'Idle: no requests',
      note: null,
    });
    expect(keepLastHealth({ resource: 'r', state: 'unknown', at: AT, text: 'x' }, undefined)).toMatchObject({
      state: 'unknown',
      note: null,
    });
  });
});

describe('an environment’s health URL (BRK-266)', () => {
  it('is an https address with no credentials, in the desired state', () => {
    expect(checkHealthField({ url: 'https://staging.acme.example/health' })).toBeNull();
    expect(checkHealthField({ url: 'http://staging.acme.example/health' })?.field).toBe('health.url');
    expect(checkHealthField({ url: 'https://me:pw@staging.acme.example/' })?.message).toMatch(/credentials/u);
    expect(checkHealthField({ url: `https://acme.example/${'a'.repeat(HEALTH_URL_MAX)}` })?.field).toBe('health.url');
    expect(checkHealthField({ url: 'https://acme.example', every: 5 })?.field).toBe('health.every');
    expect(checkHealthField('https://acme.example')?.field).toBe('health');

    const file = (health) => JSON.stringify({ version: 1, health, resources: [] }, null, 2);
    expect(checkDesiredFile(file({ url: 'https://staging.acme.example/health' }))).toEqual({
      ok: true,
      desired: { resources: [], health: { url: 'https://staging.acme.example/health' } },
      provider: null,
    });
    expect(checkDesiredFile(file({ url: 'ftp://acme.example' }))).toMatchObject({
      ok: false,
      error: { field: 'health.url', line: 4 },
    });
  });

  it('GETs it with no credentials, and reads 2xx healthy, 4xx degraded, 5xx, a timeout, or no answer down', async () => {
    const calls = [];
    const answering = (status) => async (url, init) => {
      calls.push({ url, init });
      return new Response('ok', { status });
    };
    const url = 'https://staging.acme.example/health';
    expect(await readHealthUrl(url, answering(200))).toMatchObject({
      state: 'healthy',
      text: expect.stringMatching(/^The health URL on staging\.acme\.example answered 200 in \d+ ms$/u),
    });
    expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(calls[0].init.headers).has('authorization')).toBe(false);
    expect((await readHealthUrl(url, answering(404))).state).toBe('degraded');
    expect((await readHealthUrl(url, answering(502))).state).toBe('down');
    const hangs = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await readHealthUrl(url, hangs, { timeoutMs: 20 })).toEqual({
      state: 'down',
      text: 'The health URL on staging.acme.example didn’t answer within 0 s',
    });
    const refuses = async () => {
      throw new Error('connection refused');
    };
    expect(await readHealthUrl(url, refuses)).toMatchObject({ state: 'down', text: /couldn’t be reached/u });
  });

  it('reads one failure degraded and only two in a row down; a pass clears the count', () => {
    const down = { state: 'down', text: 'The health URL on acme.example answered 502 in 9 ms' };
    expect(debounceHealthUrl(down, 0)).toEqual({
      check: {
        state: 'degraded',
        text: 'The health URL on acme.example answered 502 in 9 ms; down if the next check fails too',
      },
      fails: 1,
    });
    expect(debounceHealthUrl(down, 1)).toEqual({
      check: { state: 'down', text: 'The health URL on acme.example answered 502 in 9 ms, 2 checks in a row' },
      fails: 2,
    });
    expect(debounceHealthUrl(down, null).check.state).toBe('degraded');
    const ok = { state: 'healthy', text: 'answered 200' };
    expect(debounceHealthUrl(ok, 3)).toEqual({ check: ok, fails: 0 });
  });

  it('puts its answer on the front door whose host it names, or every front door when none does', () => {
    const resources = [
      { id: 'route:1', kind: 'route', name: 'staging.acme.example/*', attrs: { worker: 'acme-api' } },
      { id: 'domain:1', kind: 'custom-domain', name: 'other.acme.example', attrs: { hostname: 'other.acme.example' } },
      { id: 'worker:acme-api', kind: 'worker', name: 'acme-api' },
    ];
    const health = [
      { resource: 'route:1', state: 'idle', at: AT, text: 'Its Worker, acme-api: Idle' },
      { resource: 'domain:1', state: 'degraded', at: AT, text: 'Its Worker: 10% failed' },
      { resource: 'worker:acme-api', state: 'idle', at: AT, text: 'Idle' },
    ];
    const ok = { state: 'healthy', text: 'The health URL on staging.acme.example answered 200 in 4 ms' };
    const by = (list) => Object.fromEntries(list.map((x) => [x.resource, x.state]));
    expect(by(withHealthUrl(resources, health, 'https://staging.acme.example/health', ok, AT))).toEqual({
      'route:1': 'healthy',
      'domain:1': 'degraded',
      'worker:acme-api': 'idle',
    });
    // No front door on that host: every front door takes it, and a passing check never hides failing requests.
    const down = { state: 'down', text: 'The health URL on elsewhere.example didn’t answer within 5 s' };
    expect(by(withHealthUrl(resources, health, 'https://elsewhere.example/up', down, AT))).toEqual({
      'route:1': 'down',
      'domain:1': 'down',
      'worker:acme-api': 'idle',
    });
    expect(by(withHealthUrl(resources, health, 'https://elsewhere.example/up', ok, AT))['domain:1']).toBe('degraded');
    expect(withHealthUrl([resources[2]], [health[2]], 'https://acme.example/', down, AT)).toEqual([health[2]]);
  });
});

describe('idle in signals and apply checks (BRK-266)', () => {
  const where = { source: 'cloudflare', environment: 'staging' };

  it('makes no signal when traffic stops, and counts idle after down as healthy again', () => {
    const idle = [{ resource: 'worker:acme-api', state: 'idle', at: AT, text: 'Idle: no requests in the last day' }];
    expect(healthSignals(where, idle, new Map([['worker:acme-api', 'healthy']]))).toEqual([]);
    expect(healthSignals(where, idle, new Map())).toEqual([]);
    expect(healthSignals(where, idle, new Map([['worker:acme-api', 'down']]))).toEqual([
      expect.objectContaining({
        level: 'info',
        text: 'worker:acme-api is healthy again: Idle: no requests in the last day',
      }),
    ]);
  });

  it('leaves an apply unverified when what it touched is only idle', () => {
    const diff = {
      provider: 'cloudflare',
      environment: 'staging',
      reversible: true,
      changes: [{ op: 'update', resource: 'worker:acme-api', kind: 'worker', name: 'acme-api', reversible: true }],
    };
    const verdict = healthVerdict(/** @type {any} */ (diff), [{ resource: 'worker:acme-api', state: 'idle', at: AT }]);
    expect(verdict).toEqual({ ok: true, problems: [], unknown: ['acme-api'], touched: 1 });
  });
});
