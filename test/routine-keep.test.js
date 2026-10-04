import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRoutine, openRoutine, routineKey, sealRoutine } from '../src/routine-keep.js';
import { ORIGIN, TEST_API_TOKEN, TEST_SYNC_KEY } from './constants.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);

// Made-up routines: gadgets has none in the Secrets Store, breakaway has one there (TASKS_ROUTINES in vitest.config.js).
const GADGETS = {
  url: 'https://api.anthropic.com/v1/claude_code/routines/trig_gadgets/fire',
  token: 'sk-ant-oat01-gadgets-kept-token',
};
const GADGETS_NEW = {
  url: 'https://api.anthropic.com/v1/claude_code/routines/trig_gadgets2/fire',
  token: 'sk-ant-oat01-gadgets-replaced-token',
};
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 11 + 5) % 256)));

describe('sealing a routine, the pure parts', () => {
  it('checks the URL and token the way agents-connect does, and says which failed', () => {
    expect(checkRoutine({ url: ` ${GADGETS.url} `, token: ` ${GADGETS.token}\n` })).toEqual(GADGETS);
    expect(checkRoutine({ url: 'https://example.com/fire', token: GADGETS.token })).toEqual({
      error: expect.stringMatching(/isn't a routine \/fire URL/u),
    });
    expect(checkRoutine({ url: GADGETS.url, token: 'ghp_nope' })).toEqual({
      error: expect.stringMatching(/isn't a routine token/u),
    });
    expect(checkRoutine({})).toHaveProperty('error');
  });

  it('opens with the same key and slug only, and never holds the token in the clear', async () => {
    const key = await routineKey(TEST_SYNC_KEY);
    const sealed = await sealRoutine(key, 'gadgets', GADGETS);
    expect(sealed).toMatch(/^v1\.[\w+/=]+\.[\w+/=]+$/u);
    expect(sealed).not.toContain('gadgets-kept-token');
    expect(atob(sealed.split('.')[2])).not.toContain('gadgets-kept-token');
    expect(await openRoutine(key, 'gadgets', sealed)).toEqual(GADGETS);
    // Each seal is fresh.
    expect(await sealRoutine(key, 'gadgets', GADGETS)).not.toBe(sealed);
    // Another repository's record, another key, or a damaged one: refused.
    await expect(openRoutine(key, 'widgets', sealed)).rejects.toThrow();
    await expect(openRoutine(await routineKey(OTHER_KEY), 'gadgets', sealed)).rejects.toThrow();
    await expect(openRoutine(key, 'gadgets', `${sealed.slice(0, -4)}AAAA`)).rejects.toThrow();
    await expect(openRoutine(key, 'gadgets', 'v2.x.y')).rejects.toThrow(/not a sealed routine/u);
  });
});

/** The signed-in browser's cookie, from /login. */
let cookie;
async function form(slug, method, payload = {}, { origin = ORIGIN } = {}) {
  return body(
    await SELF.fetch(`${ORIGIN}/api/repos/${slug}/routine`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload),
    }),
  );
}
const connect = (slug, payload, opts) => form(slug, 'PUT', payload, opts);

const fires = [];
function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.anthropic.com/')) {
      fires.push({ url, auth: new Headers(init.headers).get('Authorization') });
      const id = `session_${String(fires.length).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return new Response('{"message":"Not Found"}', { status: 404 }); // GitHub
  });
}

const start = (ref) => api('agents/start', { method: 'POST', body: { ref } });
const routineRow = async (slug) =>
  (await inStore((s) => s.claudeConnections())).find((c) => c.id === 'claude.routine' && c.repo === slug);
/** Every byte the board would answer about a repository, to check the token is in none of it. */
async function everythingAbout(slug) {
  const parts = await Promise.all([
    api('repos').then((r) => r.text()),
    api(`repos/${slug}`).then((r) => r.text()),
    api(`repos/setup?slug=${slug}`).then((r) => r.text()),
    api('agents').then((r) => r.text()),
    inStore((s) => s.claudeConnections()).then((rows) => JSON.stringify(rows)),
  ]);
  return parts.join('\n');
}

describe('connecting a routine from the board (BRK-133)', () => {
  let spy;
  beforeAll(async () => {
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = login.headers.get('Set-Cookie').split(';')[0];
    for (const repo of [
      { slug: 'gadgets', github: 'acme/gadgets', areas: ['gizmo:GAD'] },
      { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
    ])
      expect((await api('repos', { method: 'POST', body: repo })).status).toBe(201);
    const made = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Gadget one', project: 'gizmo', repo: 'gadgets', tags: ['agent'], horizon: 'now' },
          { description: 'Gadget two', project: 'gizmo', repo: 'gadgets', tags: ['agent'], horizon: 'now' },
          { description: 'Gadget three', project: 'gizmo', repo: 'gadgets', tags: ['agent'], horizon: 'now' },
          { description: 'Breakaway one', project: 'product', repo: 'breakaway', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(made.tasks.map((t) => t.wid)).toEqual(['GAD-1', 'GAD-2', 'GAD-3', 'BRK-1']);
  });
  beforeEach(() => {
    spy = mockClaude();
    fires.length = 0;
  });
  afterEach(() => spy.mockRestore());

  it('starts with gadgets not connected', async () => {
    expect(await body(await api('repos/gadgets'))).toMatchObject({ routineConnected: false, routineSource: null });
    expect(await routineRow('gadgets')).toMatchObject({ state: 'attention' });
    expect((await body(await start('GAD-1'))).error).toMatch(/gadgets’s agent routine isn’t connected yet/u);
  });

  it('refuses the bearer token, another origin, and an agent, and stores nothing', async () => {
    const bearer = await body(await api('repos/gadgets/routine', { method: 'PUT', body: GADGETS }));
    expect(bearer).toMatchObject({ status: 403, error: /only the signed-in web board can connect a routine/u });
    expect(await connect('gadgets', GADGETS, { origin: 'https://elsewhere.example' })).toMatchObject({ status: 403 });
    expect(await connect('gadgets', GADGETS, { origin: null })).toMatchObject({ status: 403 });
    expect(await connect('gadgets', { ...GADGETS, by: 'claude-gad-1' })).toMatchObject({
      status: 403,
      error: /only the owner connects a routine/u,
    });
    const forget = await body(await api('repos/gadgets/routine', { method: 'DELETE', body: {} }));
    expect(forget.status).toBe(403);
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM kept_routines').one().n)).toBe(0);
  });

  it('says which check failed, stores nothing, and refuses a repository that isn’t registered', async () => {
    const url = await connect('gadgets', { url: 'https://example.com/fire', token: GADGETS.token });
    expect(url).toMatchObject({ status: 400, error: /isn't a routine \/fire URL.*Nothing was stored\./u });
    const token = await connect('gadgets', { url: GADGETS.url, token: 'nope' });
    expect(token).toMatchObject({ status: 400, error: /isn't a routine token.*Nothing was stored\./u });
    expect(await connect('nowhere', GADGETS)).toMatchObject({ status: 404 });
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM kept_routines').one().n)).toBe(0);
  });

  it('connects it: stored sealed, never given back, and agents start with it', async () => {
    const res = await connect('gadgets', GADGETS);
    expect(res).toEqual({
      status: 201,
      ok: true,
      repo: 'gadgets',
      connected: true,
      source: 'board',
      secretsStoreWins: false,
    });
    const stored = await inStore((s) => s.sql.exec('SELECT sealed FROM kept_routines WHERE slug = ?', 'gadgets').one());
    expect(stored.sealed).not.toContain('gadgets-kept-token');
    expect(stored.sealed).not.toContain('trig_gadgets');

    expect(await body(await api('repos/gadgets'))).toMatchObject({ routineConnected: true, routineSource: 'board' });
    const run = await body(await start('GAD-1'));
    expect(run).toMatchObject({ status: 200, run: { repo: 'gadgets', status: 'started' } });
    expect(fires).toEqual([{ url: GADGETS.url, auth: `Bearer ${GADGETS.token}` }]);

    const all = await everythingAbout('gadgets');
    expect(all).not.toContain('gadgets-kept-token');
    expect(all).not.toContain('trig_gadgets');
  });

  it('shows on Connections like a routine in the Secrets Store', async () => {
    const kept = await routineRow('gadgets');
    const fromSecrets = await routineRow('breakaway');
    expect(kept).toMatchObject({ name: 'Agent routine for gadgets', state: 'working', fix: null });
    expect(fromSecrets).toMatchObject({ name: 'Agent routine for breakaway', state: 'working', fix: null });
    expect(kept.detail).toBe('connected; the last start worked');
    const output = (await inStore((s) => s.claudeConnections())).find(
      (c) => c.id === 'claude.output' && c.repo === 'gadgets',
    );
    expect(output).toMatchObject({ name: 'Live output from gadgets’s sessions' });
    expect(await inStore(async (s) => [...(await s.connectedRepos())])).toEqual(
      expect.arrayContaining(['gadgets', 'breakaway']),
    );
  });

  it('replaces it from the form', async () => {
    expect(await connect('gadgets', GADGETS_NEW)).toMatchObject({ status: 200, replaced: true, connected: true });
    expect((await body(await start('GAD-2'))).status).toBe(200);
    expect(fires).toEqual([{ url: GADGETS_NEW.url, auth: `Bearer ${GADGETS_NEW.token}` }]);
    expect(await everythingAbout('gadgets')).not.toContain('gadgets-replaced-token');
  });

  it('lets agents-connect’s routine win when both exist', async () => {
    const res = await connect('breakaway', GADGETS);
    expect(res).toMatchObject({ status: 201, connected: true, source: 'secrets', secretsStoreWins: true });
    expect((await body(await start('BRK-1'))).status).toBe(200);
    expect(fires).toEqual([{ url: FIRE_BREAKAWAY, auth: 'Bearer sk-ant-oat01-breakaway-routine-token' }]);
    expect(await form('breakaway', 'DELETE')).toMatchObject({ status: 200, source: 'secrets' });
    expect(await form('breakaway', 'DELETE')).toMatchObject({ status: 404 });
  });

  it('keeps working through a rotation of the sync credentials', async () => {
    const before = await inStore((s) => s.sql.exec('SELECT sealed FROM kept_routines WHERE slug = ?', 'gadgets').one());
    const rekey = await body(
      await api('admin/rekey', { method: 'POST', body: { clientId: crypto.randomUUID(), key: OTHER_KEY } }),
    );
    expect(rekey.status).toBe(200);
    const after = await inStore((s) => s.sql.exec('SELECT sealed FROM kept_routines WHERE slug = ?', 'gadgets').one());
    expect(after.sealed).not.toBe(before.sealed);
    expect(await inStore((s) => s.keptRoutine('gadgets'))).toEqual(GADGETS_NEW);
    expect(await routineRow('gadgets')).toMatchObject({ state: 'working' });
  });

  it('shows one that can’t be decrypted as Needs attention, and starts nothing with it', async () => {
    // Sealed under a key the board no longer has, as when the sync key is changed by hand without a rotation.
    await inStore(async (s) => {
      const sealed = await sealRoutine(await routineKey(TEST_SYNC_KEY), 'gadgets', GADGETS_NEW);
      s.sql.exec('UPDATE kept_routines SET sealed = ? WHERE slug = ?', sealed, 'gadgets');
    });
    const row = await routineRow('gadgets');
    expect(row).toMatchObject({ state: 'attention', name: 'Agent routine for gadgets' });
    expect(row.detail).toMatch(/can’t be read any more/u);
    expect(row.fix).toMatch(/Connect the routine again from the board/u);
    expect(row.fix).toContain('npx breakaway agents-connect --repo gadgets');
    expect(await body(await api('repos/gadgets'))).toMatchObject({ routineConnected: false, routineSource: 'board' });
    expect(await inStore(async (s) => (await s.connectedRepos()).has('gadgets'))).toBe(false);
    const res = await body(await start('GAD-3'));
    expect(res).toMatchObject({ status: 409, error: /connected from the board, can’t be read any more/u });
    expect(fires).toHaveLength(0);
    // Connecting it again fixes it.
    expect(await connect('gadgets', GADGETS)).toMatchObject({ status: 200, connected: true });
    expect(await routineRow('gadgets')).toMatchObject({ state: 'working' });
  });

  it('drops it when the repository is removed', async () => {
    const removed = await body(await api('repos/gadgets', { method: 'DELETE', body: { force: true } }));
    expect(removed).toMatchObject({ status: 200, routine: false });
    expect(await inStore((s) => s.sql.exec('SELECT COUNT(*) AS n FROM kept_routines').one().n)).toBe(0);
  });
});
