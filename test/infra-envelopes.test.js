import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { FAKE_KINDS, fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry, checkProvider } from '../src/infra-provider.js';
import { toB64u } from '../src/push.js';
import { checkAct, checkEnvelope, envelopeWords, judgeChange } from '../src/infra-envelopes.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeenvelopes';

/** A browser's push subscription, with keys of the right size: the test only counts and reads what's sent. */
async function browser(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh: toB64u(p256dh), auth: toB64u(crypto.getRandomValues(new Uint8Array(16))) } };
}

/** Stands in for the push service: records each call. */
function pushService() {
  const sent = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith('https://push.example.com/')) return real(input, init);
    sent.push(url);
    return new Response(null, { status: 201 });
  });
  return sent;
}

const scale = (to, over = {}) => ({
  op: 'scale',
  resource: 'svc-api',
  kind: 'service',
  name: 'api',
  before: { instances: 2 },
  after: { instances: to },
  reversible: true,
  ...over,
});

describe('envelopes, the pure part', () => {
  it('checks the bounds against the provider’s kinds, and starts the restart cap at 3 a day', () => {
    expect(checkEnvelope({}, FAKE_KINDS)).toEqual({ scale: [], monthly: null, restarts: { cap: 3, hours: 24 } });
    const e = checkEnvelope(
      { scale: [{ kind: 'service', min: 2, max: 10 }], monthly: 40.123, restarts: { cap: 5 } },
      FAKE_KINDS,
    );
    expect(e).toEqual({
      scale: [{ kind: 'service', resource: null, min: 2, max: 10 }],
      monthly: 40.12,
      restarts: { cap: 5, hours: 24 },
    });
    expect(envelopeWords(e)).toBe('2 to 10 for every service; up to 40.12 a month; 5 restarts in a day');
    const bad = (input, message) => expect(() => checkEnvelope(input, FAKE_KINDS)).toThrow(message);
    bad({ scale: [{ kind: 'database', min: 1, max: 2 }] }, /doesn’t scale/);
    bad({ scale: [{ kind: 'queue', min: 1, max: 2 }] }, /has no queue/);
    bad({ scale: [{ kind: 'service', min: 5, max: 2 }] }, /more than max/);
    bad({ scale: [{ kind: 'service', min: 1.5, max: 2 }] }, /whole number/);
    bad(
      {
        scale: [
          { kind: 'service', min: 1, max: 2 },
          { kind: 'service', min: 1, max: 3 },
        ],
      },
      /twice/,
    );
    bad({ restarts: { cap: -1 } }, /restarts.cap/);
    bad({ restarts: { hours: 0 } }, /restarts.hours/);
    bad({ widen: true }, /isn’t part of an envelope/);
    bad({ monthly: 'lots' }, /monthly/);
  });

  it('a kind that scales names its setting: the provider check refuses one that doesn’t', () => {
    const p = fakeProvider();
    expect(() =>
      checkProvider({ ...p, kinds: { ...p.kinds, service: { changes: FAKE_KINDS.service.changes } } }),
    ).toThrow(/scales names the setting/);
    expect(() =>
      checkProvider({ ...p, kinds: { ...p.kinds, route: { changes: ['create', 'update', 'delete'], scales: 'n' } } }),
    ).toThrow(/scales names the setting/);
  });

  it('judges a scale by its bound and the cost, and a restart by the cap', () => {
    const e = checkEnvelope(
      {
        scale: [
          { kind: 'service', min: 2, max: 10 },
          { kind: 'service', resource: 'api', min: 2, max: 4 },
        ],
      },
      FAKE_KINDS,
    );
    const ctx = { scales: 'instances', costAfter: 20, currency: 'USD', restartsUsed: 0 };
    expect(judgeChange(e, scale(4), ctx)).toMatchObject({ inside: true });
    // The resource's own bound comes before its kind's.
    expect(judgeChange(e, scale(6), ctx)).toMatchObject({ inside: false, why: '6 is outside its envelope’s 2 to 4' });
    expect(judgeChange(e, scale(6, { name: 'worker' }), ctx)).toMatchObject({ inside: true });
    expect(judgeChange(null, scale(3), ctx)).toMatchObject({ inside: false, why: 'the environment has no envelope' });
    expect(judgeChange(e, { ...scale(3), op: 'update' }, ctx).inside).toBe(false);
    const priced = { ...e, monthly: 15 };
    expect(judgeChange(priced, scale(3), ctx)).toMatchObject({ inside: false, why: expect.stringMatching(/over/) });
    expect(judgeChange(priced, scale(3), { ...ctx, costAfter: null }).why).toMatch(/isn’t known/);
    const restart = { ...scale(2), op: 'restart', after: { instances: 2 } };
    expect(judgeChange(e, restart, { ...ctx, restartsUsed: 2 })).toMatchObject({ inside: true, capUsed: false });
    expect(judgeChange(e, restart, { ...ctx, restartsUsed: 3 })).toMatchObject({ inside: false, capUsed: true });
    expect(judgeChange({ ...e, restarts: { cap: 0, hours: 24 } }, restart, ctx).inside).toBe(false);
  });

  it('takes only a resource, a change, and a value from an act', () => {
    expect(checkAct({ resource: 'api', change: 'scale', value: 3 })).toEqual({
      resource: 'api',
      change: 'scale',
      value: 3,
    });
    expect(checkAct({ resource: 'api', change: 'restart' })).toEqual({
      resource: 'api',
      change: 'restart',
      value: null,
    });
    expect(() => checkAct({ resource: 'api', change: 'delete' })).toThrow(/scale or restart/);
    expect(() => checkAct({ resource: 'api', change: 'scale', value: -1 })).toThrow(/whole number/);
    expect(() => checkAct({ resource: 'api', change: 'restart', value: 2 })).toThrow(/no value/);
    expect(() => checkAct({ change: 'scale', value: 2 })).toThrow(/resource/);
  });
});

describe('envelopes on the board (BRK-186)', () => {
  let cookie;
  let production;
  let staging;
  let provider;
  let run;
  const AGENT = 'claude-envelope-run';

  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const set = (environment, envelope) =>
    board(`infra/envelopes/${environment.id}`, { method: 'PUT', body: { envelope } }).then(body);
  const act = (environment, fields, by = AGENT, task = run.wid) =>
    api(`infra/envelopes/${environment.id}/act`, { method: 'POST', body: { by, task, ...fields } }).then(body);
  const audit = async (environment) =>
    (await body(await api(`infra/audit?environmentId=${environment.id}`))).entries.reverse();
  const queued = (plan) =>
    runInDurableObject(store(), (s) =>
      s.sql.exec('SELECT phase FROM infra_runs WHERE n = ?', Number(plan.slice(5))).toArray(),
    );
  const pings = () =>
    runInDurableObject(store(), (s) =>
      s.sql
        .exec("SELECT message, quiet FROM pings WHERE task = ? AND kind = 'envelope' ORDER BY id", run.uuid)
        .toArray(),
    );

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const add = async (name, kind) =>
      (
        await body(
          await board('infra/environments', {
            method: 'POST',
            body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api' },
          }),
        )
      ).environment;
    production = await add('env-production', 'production');
    staging = await add('env-staging', 'staging');
    provider = fakeProvider({ id: PROVIDER });
    // A runbook's run, held by its agent: a task a routine with a signal trigger made.
    expect(
      (
        await api('routines', {
          method: 'POST',
          body: { slug: 'env-runbook', name: 'Scale on alerts', prompt: 'Scale api when it is busy.', gapMinutes: 0 },
        })
      ).status,
    ).toBe(201);
    expect((await board('infra/runbooks/env-runbook', { method: 'PUT', body: { on: true } })).status).toBe(200);
    run = await runInDurableObject(store(), async (s) => {
      s.infraProviders = new ProviderRegistry();
      s.infraProviders.register(provider);
      const made = await s.create([
        { description: 'Scale on alerts', project: 'routines', repo: 'widgets', horizon: 'now', by: 'board' },
      ]);
      const uuid = made.body.tasks[0].uuid;
      s.sql.exec(
        "INSERT INTO routine_runs (slug, task, trigger, started) VALUES ('env-runbook', ?, 'signal', ?)",
        uuid,
        Date.now(),
      );
      return { uuid, wid: s.tasks.get(uuid).wid };
    });
    expect((await api(`tasks/${run.wid}/claim`, { method: 'POST', body: { agent: AGENT } })).status).toBe(200);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runInDurableObject(store(), (s) => {
      s.sql.exec('DELETE FROM push_subscriptions');
      s.sql.exec('DELETE FROM infra_envelopes');
      s.sql.exec('DELETE FROM infra_envelope_acts');
      s.sql.exec('UPDATE infra_environments SET frozen = 0');
    });
  });

  it('is the owner’s to set, change, and revoke, from the signed-in board only, and each is audited', async () => {
    const envelope = { scale: [{ kind: 'service', min: 2, max: 10 }] };
    const token = await body(await api(`infra/envelopes/${staging.id}`, { method: 'PUT', body: { envelope } }));
    expect(token).toMatchObject({ status: 403, error: 'only the signed-in web board can set or revoke an envelope' });
    expect(
      (await body(await board(`infra/envelopes/${staging.id}`, { method: 'PUT', body: { envelope, by: AGENT } })))
        .status,
    ).toBe(403);
    expect((await body(await api(`infra/envelopes/${staging.id}`, { method: 'DELETE' }))).status).toBe(403);
    expect(await body(await api(`infra/envelopes/${staging.id}`))).toMatchObject({
      envelope: null,
      scalable: [{ kind: 'service', setting: 'instances' }],
      blocked: null,
    });

    expect((await set(staging, { scale: [{ kind: 'database', min: 1, max: 2 }] })).status).toBe(400);
    const made = await set(staging, envelope);
    expect(made).toMatchObject({
      status: 200,
      envelope: { scale: [{ kind: 'service', resource: null, min: 2, max: 10 }], restarts: { cap: 3, hours: 24 } },
      words: '2 to 10 for every service; 3 restarts in a day',
    });
    await set(staging, { ...envelope, restarts: { cap: 1, hours: 12 } });
    const listed = (await body(await api('infra/envelopes?repo=widgets'))).envelopes;
    expect(listed.find((e) => e.environment.id === staging.id).envelope.restarts).toEqual({ cap: 1, hours: 12 });
    expect((await body(await board(`infra/envelopes/${staging.id}`, { method: 'DELETE' }))).envelope).toBeNull();
    expect((await body(await board(`infra/envelopes/${staging.id}`, { method: 'DELETE' }))).status).toBe(404);

    const entries = (await audit(staging)).filter((e) => e.kind === 'envelope');
    expect(entries.map((e) => [e.by, e.outcome])).toEqual([
      ['owner', 'set'],
      ['owner', 'changed'],
      ['owner', 'revoked'],
    ]);
    expect(entries[0]).toMatchObject({ envelope: `envelope-${staging.id}`, environment: 'env-staging' });
  });

  it('scales inside its envelope in production: approved by the envelope, queued for the executor, no push', async () => {
    const sub = await browser('https://push.example.com/send/envelopes');
    expect((await board('push/subscriptions', { method: 'POST', body: sub })).status).toBe(200);
    const sent = pushService();
    await set(production, { scale: [{ kind: 'service', min: 2, max: 10 }], monthly: 100 });

    const res = await act(production, { resource: 'api', change: 'scale', value: 6 });
    expect(res).toMatchObject({ status: 200, act: { inside: true, why: '6 is inside 2 to 10' } });
    const { plan } = res.act;
    expect(plan).toMatchObject({ state: 'approved', source: { kind: 'envelope', ref: run.wid }, agent: AGENT });
    expect(plan.diff.changes).toEqual([
      expect.objectContaining({ op: 'scale', resource: 'svc-api', after: { instances: 6, version: '1.0.0' } }),
    ]);
    expect(await queued(plan.id)).toEqual([{ phase: 'queued' }]);
    expect(sent).toHaveLength(0);

    const trail = (await audit(production)).filter((e) => e.plan === plan.id);
    expect(trail.map((e) => [e.kind, e.by, e.outcome])).toEqual([
      ['plan', 'agent', 'draft'],
      ['envelope', 'agent', 'inside'],
      ['plan', 'envelope', 'waiting'],
      ['approve', 'envelope', 'approved'],
    ]);
    expect(trail[1].agent).toBe(AGENT);
    const notes = await pings();
    expect(notes.at(-1)).toEqual({
      message: `Scale api to 6 instances in env-production, inside its envelope: ${plan.id} applies without a press.`,
      quiet: 1,
    });
    const shown = await body(await api(`infra/envelopes/${production.id}`));
    expect(shown.acts[0]).toMatchObject({ change: 'scale', resource: 'svc-api', inside: true, plan: plan.id });
  });

  it('makes a plan that waits, with one push, for a scale outside its bounds or with no envelope', async () => {
    const sub = await browser('https://push.example.com/send/envelopes-out');
    await board('push/subscriptions', { method: 'POST', body: sub });
    const sent = pushService();
    const none = await act(staging, { resource: 'svc-api', change: 'scale', value: 3 });
    expect(none.act).toMatchObject({
      inside: false,
      why: 'the environment has no envelope',
      plan: { state: 'waiting' },
    });
    expect(sent).toHaveLength(1);

    await set(staging, { scale: [{ kind: 'service', min: 2, max: 4 }] });
    const out = await act(staging, { resource: 'api', change: 'scale', value: 12 });
    expect(out.act).toMatchObject({
      inside: false,
      why: '12 is outside its envelope’s 2 to 4',
      plan: { state: 'waiting' },
    });
    expect(sent).toHaveLength(2);
    expect(await queued(out.act.plan.id)).toEqual([]);
    const trail = (await audit(staging)).filter((e) => e.plan === out.act.plan.id);
    expect(trail.map((e) => [e.kind, e.by, e.outcome])).toEqual([
      ['plan', 'agent', 'draft'],
      ['envelope', 'agent', 'outside'],
      ['plan', 'board', 'waiting'],
    ]);
  });

  it('restarts until the cap, then the next one waits with one push', async () => {
    const sub = await browser('https://push.example.com/send/envelopes-cap');
    await board('push/subscriptions', { method: 'POST', body: sub });
    const sent = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (!url.startsWith('https://push.example.com/')) return real(input, init);
      sent.push(url);
      return new Response(null, { status: 201 });
    });
    await set(production, { restarts: { cap: 2, hours: 24 } });
    const first = await act(production, { resource: 'api', change: 'restart' });
    const second = await act(production, { resource: 'api', change: 'restart' });
    expect([first.act.inside, second.act.inside]).toEqual([true, true]);
    expect(first.act.plan.state).toBe('approved');
    expect(second.act.why).toBe('restart 2 of 2 in a day');
    expect(sent).toHaveLength(0);
    expect((await body(await api(`infra/envelopes/${production.id}`))).restartsUsed).toBe(2);

    const third = await act(production, { resource: 'api', change: 'restart' });
    expect(third.act).toMatchObject({
      inside: false,
      why: 'api used its 2 restarts in a day',
      plan: { state: 'waiting' },
    });
    expect(sent).toHaveLength(1);
    const entry = (await audit(production)).find((e) => e.plan === third.act.plan.id && e.kind === 'envelope');
    expect(entry.outcome).toBe('cap used');
  });

  it('refuses what an envelope can’t do, and anyone but a runbook’s agent', async () => {
    await set(staging, { scale: [{ kind: 'service', min: 1, max: 5 }] });
    const cant = await act(staging, { resource: 'main', change: 'restart' });
    expect(cant).toMatchObject({
      status: 409,
      error: `a database can’t restart on Fake platform, so nothing was planned`,
    });
    expect((await act(staging, { resource: 'nothing-here', change: 'restart' })).status).toBe(404);
    // A provider may refuse one resource its kind allows (BRK-227), and its words are the act's.
    provider.refuses = (r, op) => (r.name === 'api' && op === 'restart' ? 'api restarts by itself' : null);
    try {
      expect(await act(staging, { resource: 'api', change: 'restart' })).toMatchObject({
        status: 409,
        error: 'api restarts by itself, so nothing was planned',
      });
      expect((await act(staging, { resource: 'main', change: 'restart' })).error).toMatch(/a database can’t restart/);
    } finally {
      delete provider.refuses;
    }
    // A resource outside the environment (the install's Worker, another environment's) is refused too (BRK-251), and
    // the provider is asked with the environment's whole scope.
    let scope = null;
    provider.outside = (ctx, _found, r) => {
      scope = ctx.scope;
      return r.name === 'api' ? 'api is the Worker this board runs on' : null;
    };
    try {
      expect(await act(staging, { resource: 'api', change: 'restart' })).toMatchObject({
        status: 409,
        error: 'api is the Worker this board runs on, so nothing was planned',
      });
      expect(scope).toMatchObject({ target: 'svc-api', board: expect.any(String), others: [] });
    } finally {
      delete provider.outside;
    }
    expect((await act(staging, { resource: 'api', change: 'scale', value: 2 })).error).toMatch(/nothing to change/);
    expect((await act(staging, { resource: 'api', change: 'delete' })).status).toBe(400);

    // The owner approves plans; an act names the agent, and the run it holds, made by a runbook.
    expect((await act(staging, { resource: 'api', change: 'restart' }, '')).status).toBe(403);
    expect((await act(staging, { resource: 'api', change: 'restart' }, 'claude-someone-else')).status).toBe(403);
    expect((await act(staging, { resource: 'api', change: 'restart' }, AGENT, null)).status).toBe(403);
    const made = await body(
      await api('tasks', { method: 'POST', body: [{ description: 'Not a runbook', project: 'ops', horizon: 'now' }] }),
    );
    const other = made.tasks[0].wid;
    await api(`tasks/${other}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    const notRunbook = await act(staging, { resource: 'api', change: 'restart' }, 'claude-other', other);
    expect(notRunbook).toMatchObject({ status: 403, error: expect.stringMatching(/isn’t a runbook’s run/) });

    // A frozen environment refuses every act, envelopes included.
    await runInDurableObject(store(), (s) =>
      s.sql.exec('UPDATE infra_environments SET frozen = 1 WHERE id = ?', staging.id),
    );
    expect((await act(staging, { resource: 'api', change: 'scale', value: 3 })).status).toBe(409);
  });

  it('refuses an envelope on an observe-only environment', async () => {
    const watched = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name: 'env-watched', kind: 'staging', observeOnly: true },
        }),
      )
    ).environment;
    const res = await set(watched, { restarts: { cap: 1 } });
    expect(res).toMatchObject({ status: 409, error: expect.stringMatching(/observe only/) });
    expect(await body(await api(`infra/envelopes/${watched.id}`))).toMatchObject({
      scalable: [],
      blocked: expect.stringMatching(/observe only/),
    });
    expect((await act(watched, { resource: 'api', change: 'restart' })).status).toBe(409);
  });
});
