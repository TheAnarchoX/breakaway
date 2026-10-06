import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keptPermissions, providerRow, readTokenProblem } from '../src/connections.js';
import { ProviderRegistry, checkProvider, checkTokenCheck } from '../src/infra-provider.js';
import { openJson, sealJson, sealingKey } from '../src/routine-keep.js';
import { ORIGIN, TEST_API_TOKEN, TEST_SYNC_KEY } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)));

describe('a provider’s read-only token, the pure parts (BRK-194)', () => {
  const provider = fakeProvider();

  it('lets a provider declare the token it needs, and checks the declaration', () => {
    expect(() => checkProvider(provider)).not.toThrow();
    expect(() => checkProvider(fakeProvider({ readToken: false }))).not.toThrow();
    const bad = (readToken) => () => checkProvider({ ...provider, readToken });
    expect(bad({ ...provider.readToken, permissions: [] })).toThrow(/names no permissions/u);
    expect(bad({ ...provider.readToken, permissions: [{ name: 'Read' }] })).toThrow(/no name or no for/u);
    expect(bad({ ...provider.readToken, url: 'http://fake.example' })).toThrow(/no https url/u);
    expect(bad({ ...provider.readToken, check: 'yes' })).toThrow(/check is not a function/u);
  });

  it('checks what a provider’s token check returns', () => {
    expect(checkTokenCheck(provider, { ok: true })).toEqual({ ok: true });
    expect(() => checkTokenCheck(provider, { ok: false })).toThrow(/without saying why/u);
    expect(() => checkTokenCheck(provider, { ok: true, permissions: [{ name: 'X', level: 'admin' }] })).toThrow(
      /neither read nor write/u,
    );
  });

  it('refuses a token the platform refused, one that can change things, or one missing a permission', async () => {
    const check = (token) => provider.readToken.check({ token });
    expect(readTokenProblem(provider, await check('fake-read-token'))).toBeNull();
    expect(readTokenProblem(provider, null)).toBeNull();
    expect(readTokenProblem(provider, await check('nope'))).toMatch(
      /^Fake platform refused the token \(the platform doesn’t know this token\): make a read-only token with Fake Services Read and Fake Alerts Read on https:\/\/fake\.example\/tokens/u,
    );
    expect(readTokenProblem(provider, await check('fake-write-token'))).toMatch(
      /can change things on Fake platform \(Fake Services Edit\), and the board keeps read-only tokens only/u,
    );
    expect(readTokenProblem(provider, await check('fake-narrow-token'))).toMatch(/missing Fake Alerts Read/u);
  });

  it('keeps permissions by name only', async () => {
    expect(keptPermissions(provider, await provider.readToken.check({ token: 'fake-read-token' }))).toEqual([
      'Fake Alerts Read',
      'Fake Services Read',
    ]);
    expect(keptPermissions(provider, null)).toEqual(['Fake Alerts Read', 'Fake Services Read']);
  });

  it('gives a row in each state, with its fix', () => {
    const all = ['Fake Alerts Read', 'Fake Services Read'];
    const off = providerRow(provider, null);
    expect(off).toMatchObject({ state: 'off', at: null });
    expect(off.detail).toMatch(/no read-only token for Fake platform/u);
    expect(off.fix).toMatch(/^Make a read-only token on Fake platform with Fake Services Read and Fake Alerts Read/u);
    expect(off.fix).toMatch(/never shows it again/u);
    expect(off.items.map((i) => [i.name, i.ok])).toEqual([
      ['Fake Services Read', false],
      ['Fake Alerts Read', false],
    ]);

    const broken = providerRow(provider, { broken: true });
    expect(broken).toMatchObject({ state: 'attention', detail: /can’t be read any more/u, fix: /paste it here/u });

    const base = {
      permissions: all,
      checked: true,
      connected: '2026-10-06T10:00:00.000Z',
      discovery: null,
      signal: null,
    };
    expect(providerRow(provider, base)).toMatchObject({ state: 'working', detail: 'connected; no discovery yet' });
    expect(providerRow(provider, { ...base, checked: false }).detail).toMatch(
      /can’t see extras: make sure it has only these, all read/u,
    );

    const seen = { at: '2026-10-06T11:00:00.000Z', ok: true, error: null };
    const working = providerRow(provider, { ...base, discovery: seen });
    expect(working).toMatchObject({ state: 'working', detail: 'connected', fix: null, at: seen.at });
    expect(working.items.every((i) => i.ok && i.has === 'read')).toBe(true);

    const failed = providerRow(provider, {
      ...base,
      discovery: seen,
      signal: {
        at: '2026-10-06T12:00:00.000Z',
        ok: false,
        error: 'HTTP 403: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 expired',
      },
    });
    expect(failed).toMatchObject({ state: 'attention', at: '2026-10-06T12:00:00.000Z' });
    expect(failed.detail).toMatch(/^the last signal failed: HTTP 403/u);
    expect(failed.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(failed.fix).toMatch(/If Fake platform refused the token, make a new read-only token/u);
    // A later success clears it.
    const later = { ...seen, at: '2026-10-06T13:00:00.000Z' };
    const lost = { at: '2026-10-06T12:00:00.000Z', ok: false, error: 'x' };
    expect(providerRow(provider, { ...base, discovery: later, signal: lost }).state).toBe('working');

    const short = providerRow(provider, { ...base, permissions: ['Fake Services Read'], discovery: seen });
    expect(short).toMatchObject({ state: 'attention', detail: /doesn’t have Fake Alerts Read/u });
  });

  it('counts a permission by its legacy name, and names both, so a token made before a rename still works (BRK-243)', async () => {
    const renamed = {
      ...provider,
      readToken: {
        ...provider.readToken,
        permissions: [
          {
            name: 'Fake Services Metadata Read-Only',
            legacy: ['Fake Services Read'],
            for: 'what runs, never its code',
          },
          provider.readToken.permissions[1],
        ],
      },
    };
    expect(() => checkProvider(renamed)).not.toThrow();
    const bad = { ...renamed.readToken, permissions: [{ ...renamed.readToken.permissions[0], legacy: 'Old' }] };
    expect(() => checkProvider({ ...renamed, readToken: bad })).toThrow(/legacy is not a list of names/u);

    const legacy = {
      permissions: ['Fake Alerts Read', 'Fake Services Read'],
      checked: true,
      connected: '2026-10-06T10:00:00.000Z',
      discovery: { at: '2026-10-06T11:00:00.000Z', ok: true, error: null },
      signal: null,
    };
    const row = providerRow(renamed, legacy);
    expect(row).toMatchObject({ state: 'working', detail: 'connected' });
    expect(row.items[0]).toMatchObject({
      name: 'Fake Services Metadata Read-Only',
      label: 'Fake Services Metadata Read-Only (or the legacy Fake Services Read)',
      ok: true,
    });
    expect(providerRow(renamed, null).fix).toMatch(
      /with Fake Services Metadata Read-Only \(or the legacy Fake Services Read\) and Fake Alerts Read/u,
    );
    // A platform that lists permissions: the legacy name counts there too.
    expect(readTokenProblem(renamed, await renamed.readToken.check({ token: 'fake-read-token' }))).toBeNull();
    expect(readTokenProblem(renamed, { ok: true, permissions: [{ name: 'Fake Alerts Read', level: 'read' }] })).toMatch(
      /missing Fake Services Metadata Read-Only \(or the legacy Fake Services Read\)/u,
    );
    const short = providerRow(renamed, { ...legacy, permissions: ['Fake Alerts Read'] });
    expect(short.detail).toMatch(/doesn’t have Fake Services Metadata Read-Only \(or the legacy Fake Services Read\)/u);
  });

  it('seals a token bound to its provider, under a key of its own', async () => {
    const info = new TextEncoder().encode('breakaway provider tokens v1');
    const key = await sealingKey(TEST_SYNC_KEY, info);
    const sealed = await sealJson(key, 'provider:fake', { token: 'fake-read-token' });
    expect(sealed).not.toContain('fake-read-token');
    expect(await openJson(key, 'provider:fake', sealed, 'token')).toEqual({ token: 'fake-read-token' });
    await expect(openJson(key, 'provider:other', sealed, 'token')).rejects.toThrow();
    const routines = await sealingKey(TEST_SYNC_KEY, new TextEncoder().encode('breakaway routine tokens v1'));
    await expect(openJson(routines, 'provider:fake', sealed, 'token')).rejects.toThrow();
  });
});

/** The signed-in browser's cookie, from /login. */
let cookie;
async function form(id, method, payload = {}, { origin = ORIGIN } = {}) {
  return body(
    await SELF.fetch(`${ORIGIN}/api/infra/connections/${id}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload),
    }),
  );
}
const paste = (token, id = 'fake') => form(id, 'PUT', { token });

describe('connecting a provider on Connections (BRK-194)', () => {
  const fake = fakeProvider();
  const quiet = fakeProvider({ id: 'quiet', readToken: false });
  const registry = new ProviderRegistry();
  registry.register(fake);
  registry.register(quiet);
  const row = async () => (await inStore((s) => s.providerConnections())).find((c) => c.id === 'provider.fake');
  let spy;

  beforeAll(async () => {
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = login.headers.get('Set-Cookie').split(';')[0];
  });
  beforeEach(async () => {
    await inStore((s) => {
      s.infraProviders = registry;
    });
    // Nothing reaches the network: GitHub, Claude, and the rest answer 404.
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
  });
  afterEach(() => spy.mockRestore());

  it('shows a provider with no token as not connected, and only providers that take one', async () => {
    const rows = await inStore((s) => s.providerConnections());
    expect(rows.map((r) => r.id)).toEqual(['provider.fake']);
    expect(rows[0]).toMatchObject({
      group: 'providers',
      name: 'Fake platform',
      state: 'off',
      link: 'https://fake.example/tokens',
      provider: { id: 'fake', connected: false, discovery: null, signal: null, alerts: false },
    });
    expect(rows[0].fix).toMatch(/Make a read-only token on Fake platform/u);
  });

  it('refuses the bearer token, another origin, an agent, and a provider it doesn’t know, and stores nothing', async () => {
    const bearer = await body(
      await api('infra/connections/fake', { method: 'PUT', body: { token: 'fake-read-token' } }),
    );
    expect(bearer).toMatchObject({ status: 403, error: /only the signed-in web board can connect a provider/u });
    expect(
      await form('fake', 'PUT', { token: 'fake-read-token' }, { origin: 'https://elsewhere.example' }),
    ).toMatchObject({
      status: 403,
    });
    expect(await form('fake', 'PUT', { token: 'fake-read-token', by: 'claude-brk-1' })).toMatchObject({
      status: 403,
      error: /only the owner connects a provider/u,
    });
    expect(await paste('fake-read-token', 'nope')).toMatchObject({ status: 404 });
    expect(await paste('fake-read-token', 'quiet')).toMatchObject({ status: 404 });
    expect(await paste('   ')).toMatchObject({ status: 400, error: /paste Fake platform’s read-only token/u });
    expect(await paste('two words')).toMatchObject({ status: 400, error: /that isn’t a token/u });
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM infra_connections').one().n)).toBe(0);
  });

  it('refuses a token that can change things, one missing a permission, and one the platform refused', async () => {
    expect(await paste('fake-write-token')).toMatchObject({
      status: 400,
      error: /can change things on Fake platform \(Fake Services Edit\).*Nothing was stored\.$/u,
    });
    expect(await paste('fake-narrow-token')).toMatchObject({ status: 400, error: /missing Fake Alerts Read/u });
    expect(await paste('nope')).toMatchObject({ status: 400, error: /Fake platform refused the token/u });
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM infra_connections').one().n)).toBe(0);
    // The token went to its own provider, and nowhere else.
    expect(fake.tokensSeen).toEqual(['fake-write-token', 'fake-narrow-token', 'nope']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a read-only token sealed, with its permissions by name, and never gives it back', async () => {
    const res = await paste(' fake-read-token ');
    expect(res).toEqual({
      status: 201,
      ok: true,
      provider: 'fake',
      connected: true,
      state: 'working',
      permissions: ['Fake Alerts Read', 'Fake Services Read'],
    });
    const stored = await inStore((s) => s.sql.exec('SELECT * FROM infra_connections').toArray());
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('fake-read-token');
    expect(await inStore((s) => s.providerReadToken('fake'))).toBe('fake-read-token');
    expect(await row()).toMatchObject({
      state: 'working',
      detail: 'connected; no discovery yet',
      provider: { connected: true, since: expect.stringMatching(/^\d{4}-/u) },
    });

    // No answer the board gives holds it: Connections, its check, health, and the form's own.
    const answers = await Promise.all([
      api('connections').then((r) => r.text()),
      api('health').then((r) => r.text()),
      api('repos').then((r) => r.text()),
      SELF.fetch(`${ORIGIN}/api/connections/check`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN },
      }).then((r) => r.text()),
    ]);
    const connections = JSON.parse(answers[0]);
    expect(connections.connections.find((c) => c.id === 'provider.fake')).toMatchObject({ state: 'working' });
    for (const text of [...answers, JSON.stringify(res)]) expect(text).not.toContain('fake-read-token');
  });

  it('shows the last discovery and signal, and a failure with its fix', async () => {
    await inStore((s) => s.infraConnectionSeen('fake', 'discovery', { ok: true }));
    let r = await row();
    expect(r).toMatchObject({ state: 'working', detail: 'connected', at: expect.stringMatching(/^\d{4}-/u) });
    expect(r.provider.discovery).toMatchObject({ ok: true });
    await new Promise((done) => setTimeout(done, 5));
    await inStore((s) =>
      s.infraConnectionSeen('fake', 'signal', { ok: false, error: 'HTTP 401 for Bearer fake-read-token' }),
    );
    r = await row();
    expect(r).toMatchObject({ state: 'attention', provider: { signal: { ok: false } } });
    expect(r.detail).toMatch(/^the last signal failed: HTTP 401/u);
    expect(r.detail).not.toContain('fake-read-token');
    expect(r.fix).toMatch(/make a new read-only token/u);
    await expect(inStore((s) => s.infraConnectionSeen('fake', 'apply', { ok: true }))).rejects.toThrow(
      /unknown apply/u,
    );
  });

  it('replaces a token, starting again with nothing seen', async () => {
    const res = await paste('fake-read-token');
    expect(res).toMatchObject({ status: 200, replaced: true, connected: true });
    expect(await row()).toMatchObject({ state: 'working', provider: { discovery: null, signal: null } });
  });

  it('keeps it through a rotation of the sync credentials', async () => {
    const before = await inStore((s) => s.sql.exec('SELECT sealed FROM infra_connections').one().sealed);
    const rekey = await body(
      await api('admin/rekey', { method: 'POST', body: { clientId: crypto.randomUUID(), key: OTHER_KEY } }),
    );
    expect(rekey.status).toBe(200);
    const after = await inStore((s) => s.sql.exec('SELECT sealed FROM infra_connections').one().sealed);
    expect(after).not.toBe(before);
    expect(await inStore((s) => s.providerReadToken('fake'))).toBe('fake-read-token');
    expect(await row()).toMatchObject({ state: 'working' });
  });

  it('shows one that can’t be decrypted as needing attention', async () => {
    await inStore(async (s) => {
      const key = await sealingKey(TEST_SYNC_KEY, new TextEncoder().encode('breakaway provider tokens v1'));
      const sealed = await sealJson(key, 'provider:fake', { token: 'fake-read-token' });
      s.sql.exec('UPDATE infra_connections SET sealed = ? WHERE provider = ?', sealed, 'fake');
    });
    expect(await inStore((s) => s.providerReadToken('fake'))).toBeNull();
    expect(await row()).toMatchObject({ state: 'attention', detail: /can’t be read any more/u });
  });

  it('forgets a token on the owner’s press', async () => {
    expect(await form('fake', 'DELETE', { by: 'claude-brk-1' })).toMatchObject({ status: 403 });
    expect(await form('fake', 'DELETE')).toMatchObject({ status: 200, connected: false, state: 'off' });
    expect(await form('fake', 'DELETE')).toMatchObject({ status: 404 });
    expect(await inStore((s) => s.providerReadToken('fake'))).toBeNull();
    expect(await row()).toMatchObject({ state: 'off' });
  });

  it('keeps a token on the owner’s word when the provider can’t check it', async () => {
    const unchecked = fakeProvider({ id: 'unchecked' });
    delete unchecked.readToken.check;
    const reg = new ProviderRegistry();
    reg.register(unchecked);
    await inStore((s) => {
      s.infraProviders = reg;
    });
    expect(await form('unchecked', 'PUT', { token: 'anything-at-all' })).toMatchObject({
      status: 201,
      permissions: ['Fake Alerts Read', 'Fake Services Read'],
    });
    const r = (await inStore((s) => s.providerConnections()))[0];
    expect(r.detail).toMatch(/can’t list a token’s permissions/u);
    // A 403 on what one permission reads marks it missing, by name, until a new token is pasted.
    await inStore((s) =>
      s.infraConnectionSeen('unchecked', 'discovery', { ok: false, error: 'HTTP 403', missing: ['Fake Alerts Read'] }),
    );
    const short = (await inStore((s) => s.providerConnections()))[0];
    expect(short).toMatchObject({ state: 'attention', detail: /doesn’t have Fake Alerts Read/u });
    expect(short.items.find((i) => i.name === 'Fake Alerts Read')).toMatchObject({ ok: false, has: 'none' });
    expect(await form('unchecked', 'PUT', { token: 'a-new-one' })).toMatchObject({ status: 200 });
    expect((await inStore((s) => s.providerConnections()))[0].state).toBe('working');
  });

  it('marks a renamed permission missing on a token kept under its legacy name (BRK-243)', async () => {
    const renamed = fakeProvider({ id: 'renamed' });
    delete renamed.readToken.check;
    renamed.readToken.permissions[0] = {
      name: 'Fake Services Metadata Read-Only',
      legacy: ['Fake Services Read'],
      for: 'what runs, never its code',
    };
    const reg = new ProviderRegistry();
    reg.register(renamed);
    await inStore((s) => {
      s.infraProviders = reg;
      // A token kept before the rename, under the legacy name.
      s.sql.exec(
        `INSERT INTO infra_connections (provider, sealed, permissions, checked, created, edited) VALUES (?, ?, ?, 0, ?, ?)`,
        'renamed',
        'sealed',
        JSON.stringify(['Fake Alerts Read', 'Fake Services Read']),
        Date.now(),
        Date.now(),
      );
    });
    await inStore((s) =>
      s.infraConnectionSeen('renamed', 'discovery', {
        ok: true,
        missing: ['Fake Services Metadata Read-Only'],
      }),
    );
    const row = await inStore(
      (s) => s.sql.exec('SELECT permissions FROM infra_connections WHERE provider = ?', 'renamed').toArray()[0],
    );
    expect(JSON.parse(row.permissions)).toEqual(['Fake Alerts Read']);
  });
});
