import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, boardApi } from './helpers.js';
import { RUNBOOK_FIELDS, runbookData, signalKey, signalMatches, signalTrigger } from '../src/infra-runbooks.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));

const make = (slug, extra = {}) =>
  api('routines', {
    method: 'POST',
    body: { slug, name: `Routine ${slug}`, prompt: `Look into ${slug}.`, gapMinutes: 0, ...extra },
  });
const setRunbook = async (slug, fields) =>
  body(await boardApi(`infra/runbooks/${slug}`, { method: 'PUT', body: fields }));
const addEnvironment = async (fields) =>
  (await body(await boardApi('infra/environments', { method: 'POST', body: { repo: 'widgets', ...fields } })))
    .environment;
const routine = async (slug) => (await body(await api('routines'))).routines.find((r) => r.slug === slug);
const detail = async (wid) => (await body(await api(`tasks/${wid}`))).task;
const finish = (wid) => api(`tasks/${wid}/done`, { method: 'POST', body: {} });
const record = (signals) => inStore((store) => store.recordSignals(signals));
const signal = (over = {}) => ({
  source: 'fake',
  environment: 'rb-production',
  resource: 'svc-api',
  kind: 'health',
  level: 'critical',
  value: null,
  at: new Date(Date.now() - 60_000).toISOString(),
  text: 'api is down',
  ...over,
});

describe('signal triggers, the pure part', () => {
  it('starts off and waiting, checks every field, and keeps what it isn’t given', () => {
    const t = signalTrigger({});
    expect(t).toEqual({ environments: [], resourceKinds: [], kinds: [], level: 'critical', on: false, start: 'wait' });
    const changed = signalTrigger({ environments: 'Production, staging,production', kinds: ['alert'] }, t);
    expect(changed.environments).toEqual(['production', 'staging']);
    expect(signalTrigger({ on: true }, changed)).toMatchObject({ kinds: ['alert'], on: true, start: 'wait' });
    expect(() => signalTrigger({ kinds: ['logs'] })).toThrow(/health, alert, cost/);
    expect(() => signalTrigger({ level: 'loud' })).toThrow(/info, warning, critical/);
    expect(() => signalTrigger({ start: 'now' })).toThrow(/wait|auto/);
    expect(() => signalTrigger({ on: 'yes' })).toThrow(/true or false/);
    expect(() => signalTrigger({ environments: ['Bad Name!'] })).toThrow(/environments’ names/);
  });

  it('matches on, at or above its level, and in its lists; an unknown resource kind never matches a kind list', () => {
    const on = signalTrigger({ on: true, level: 'warning', environments: ['production'], kinds: ['health'] });
    const s = { environment: 'production', kind: 'health', level: 'warning' };
    expect(signalMatches(on, s, null)).toBe(true);
    expect(signalMatches(on, { ...s, level: 'critical' }, null)).toBe(true);
    expect(signalMatches(on, { ...s, level: 'info' }, null)).toBe(false);
    expect(signalMatches(on, { ...s, environment: 'staging' }, null)).toBe(false);
    expect(signalMatches(on, { ...s, kind: 'cost' }, null)).toBe(false);
    expect(signalMatches({ ...on, on: false }, s, null)).toBe(false);
    const byKind = { ...on, resourceKinds: ['database'] };
    expect(signalMatches(byKind, s, 'database')).toBe(true);
    expect(signalMatches(byKind, s, 'service')).toBe(false);
    expect(signalMatches(byKind, s, null)).toBe(false);
  });

  it('keys a signal by where, what, and how loud, and hands a run the allowlisted fields only', () => {
    const a = { environmentId: 3, environment: 'p', resource: 'r', kind: 'health', level: 'critical' };
    expect(signalKey({ ...a, at: 'x', text: 'one' })).toBe(signalKey({ ...a, at: 'y', text: 'two' }));
    expect(signalKey(a)).not.toBe(signalKey({ ...a, level: 'warning' }));
    const data = runbookData(
      /** @type {any} */ ({
        id: 7,
        source: 'fake',
        environment: 'p',
        environmentId: 3,
        resource: null,
        kind: 'health',
        level: 'critical',
        value: null,
        at: '2026-10-06T00:00:00.000Z',
        text: 'down',
        secret: 'nope',
      }),
      null,
    );
    expect(Object.keys(data)).toEqual(['signal', 'source', 'environment', 'kind', 'level', 'at', 'text']);
    expect(Object.keys(data).every((k) => RUNBOOK_FIELDS.includes(k))).toBe(true);
  });
});

describe('runbooks: routines started by signals (BRK-196)', () => {
  let spy;
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

  it('is the owner’s, from the signed-in board only, and a new one is off and waits', async () => {
    await make('rb-owner');
    const viaToken = await body(await api('infra/runbooks/rb-owner', { method: 'PUT', body: { on: true } }));
    expect(viaToken.status).toBe(403);
    expect(viaToken.error).toMatch(/signed-in web board/);
    expect((await setRunbook('rb-owner', { on: true, by: 'claude-x' })).status).toBe(403);
    expect((await setRunbook('rb-nothere', {})).status).toBe(404);

    const made = await setRunbook('rb-owner', { environments: ['rb-production'] });
    expect(made).toMatchObject({ status: 200, signal: { on: false, start: 'wait', level: 'critical' } });
    expect((await routine('rb-owner')).signal).toMatchObject({ environments: ['rb-production'], on: false });
    const listed = (await body(await api('infra/runbooks'))).runbooks.find((r) => r.slug === 'rb-owner');
    expect(listed).toMatchObject({ name: 'Routine rb-owner', repo: 'widgets', signal: { on: false } });

    expect((await body(await api('infra/runbooks/rb-owner', { method: 'DELETE' }))).status).toBe(403);
    expect((await body(await boardApi('infra/runbooks/rb-owner', { method: 'DELETE' }))).signal).toBeNull();
    expect((await routine('rb-owner')).signal).toBeNull();
    const activity = (await body(await api('activity?limit=100'))).events.filter((e) => e.source === 'routines');
    expect(activity.some((e) => e.changes[0].kind === 'runbook_changed')).toBe(true);
  });

  it('starts nothing while its trigger is off', async () => {
    await addEnvironment({ name: 'rb-production', kind: 'production', provider: 'fake' });
    await make('rb-off');
    await setRunbook('rb-off', { environments: ['rb-production'] });
    await record([signal()]);
    expect((await routine('rb-off')).recentRuns).toEqual([]);
  });

  it('turned on, starts once for a matching signal, not for a duplicate, and its comment holds only the allowlist', async () => {
    await make('rb-on');
    await setRunbook('rb-on', { environments: ['rb-production'], on: true });
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    await record([signal({ text: `api is down, token ${token}` })]);
    const r = await routine('rb-on');
    expect(r.recentRuns).toHaveLength(1);
    expect(r.recentRuns[0].trigger).toBe('signal');
    expect(fires).toHaveLength(0); // it waits for the owner's Start
    const task = await detail(r.recentRuns[0].wid);
    expect(task.brief).toBe('Look into rb-on.');
    const comment = task.comments.at(-1).text;
    expect(comment).toMatch(
      /^Trigger data \(untrusted\), from the trigger “Signal: health, critical, in rb-production”/,
    );
    const block = comment.split('```')[1].trim().split('\n');
    expect(block.map((line) => line.split(':')[0])).toEqual([
      'signal',
      'source',
      'environment',
      'resource',
      'kind',
      'level',
      'at',
      'text',
    ]);
    expect(comment).not.toContain(token);
    expect(comment).toContain('Read only');

    // The same signal again, a minute later and in other words, is a duplicate: no run, no note.
    await record([signal({ at: new Date().toISOString(), text: 'api is still down' })]);
    const again = await routine('rb-on');
    expect(again.recentRuns).toHaveLength(1);
    expect((await detail(r.recentRuns[0].wid)).comments).toHaveLength(task.comments.length);

    // A different one while the run is open is noted on it, not a second run.
    await record([signal({ resource: 'db-main', text: 'db is down' })]);
    expect((await routine('rb-on')).recentRuns).toHaveLength(1);
    expect((await detail(r.recentRuns[0].wid)).comments.at(-1).text).toContain('db is down');
  });

  it('matches only its level, environments, kinds, and resource kinds, and only its own repository’s environments', async () => {
    const env2 = await addEnvironment({ name: 'rb-staging', kind: 'staging', provider: 'fake' });
    await make('rb-picky');
    await setRunbook('rb-picky', {
      environments: ['rb-staging'],
      kinds: ['alert'],
      resourceKinds: ['database'],
      level: 'warning',
      on: true,
    });
    await inStore((store) =>
      store.sql.exec(
        'INSERT INTO infra_inventory (environment, provider, rid, kind, name, seen) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        env2.id,
        'fake',
        'db-main',
        'database',
        'main',
        Date.now(),
        env2.id,
        'fake',
        'svc-api',
        'service',
        'api',
        Date.now(),
      ),
    );
    const base = { environment: 'rb-staging', environmentId: env2.id, kind: 'alert', resource: 'db-main' };
    await record([
      signal({ ...base, level: 'info' }), // below its level
      signal({ ...base, kind: 'health' }), // another kind
      signal({ ...base, resource: 'svc-api' }), // a service, not a database
      signal({ ...base, environment: 'rb-production', environmentId: null }), // another environment
      signal({ ...base, environment: 'rb-elsewhere', environmentId: null }), // an environment no repository has
      signal({ ...base, at: new Date(Date.now() - 2 * 86_400_000).toISOString() }), // too old to act on
    ]);
    expect((await routine('rb-picky')).recentRuns).toEqual([]);
    await record([signal({ ...base, level: 'warning' })]);
    expect((await routine('rb-picky')).recentRuns).toHaveLength(1);
  });

  it('starts the agent itself when the owner sets it to, and stays under the routine’s daily cap', async () => {
    await make('rb-auto', { dailyCap: 1 });
    await setRunbook('rb-auto', { environments: ['rb-production'], kinds: ['cost'], on: true, start: 'auto' });
    await record([signal({ kind: 'cost', resource: null, text: 'over budget' })]);
    expect(fires).toHaveLength(1);
    const first = (await routine('rb-auto')).recentRuns[0];
    expect(fires[0]).toContain(`Task: ${first.wid}`);
    expect(fires[0]).not.toContain('over budget');
    await finish(first.wid);

    await record([signal({ kind: 'cost', resource: 'svc-api', text: 'api over budget' })]);
    expect(fires).toHaveLength(1);
    expect((await routine('rb-auto')).recentRuns).toHaveLength(1);
    const refused = (await body(await api('activity?limit=100'))).events.filter(
      (e) => e.source === 'routines' && e.changes[0].kind === 'trigger_refused' && e.changes[0].routine === 'rb-auto',
    );
    expect(refused[0].changes[0].detail).toMatch(/daily cap/);
  });

  it('a routine that’s off starts nothing, whatever its trigger says', async () => {
    await make('rb-routine-off');
    await setRunbook('rb-routine-off', { environments: ['rb-production'], on: true });
    await api('routines/rb-routine-off', { method: 'PATCH', body: { enabled: false } });
    await record([signal({ resource: 'svc-off' })]);
    expect((await routine('rb-routine-off')).recentRuns).toEqual([]);
  });
});
