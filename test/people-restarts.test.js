// A person's later starts check their role again (BRK-348): a chase's ticks and its road captain, and a start that
// waited for room, run after the press, so a person removed, demoted, or without their grant since starts nothing more,
// on their own routine or a lent one. Fixtures are made-up people and repositories (acme/widgets); nothing reaches the
// network.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const COOKIE = '__Host-sw_tasks';
const fireOf = (name) => `https://api.anthropic.com/v1/claude_code/routines/trig_${name}/fire`;
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

function call(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const owner = (path, opts = {}) => call(path, { token: TEST_API_TOKEN, ...opts });
const json = async (res) => ({ status: res.status, ...(await res.json()) });

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

let session;

/** Invites a made-up maintainer of widgets and signs them in; with `own`, they connect their own routine there. */
async function person(base, { own = false } = {}) {
  const handle = unique(base);
  const made = await call('/api/people/invites', {
    method: 'POST',
    cookie: session,
    body: { grants: [{ repository: 'widgets', role: 'maintainer' }] },
  });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const joined = await call(`/api/join/${code}`, { method: 'POST', body: { challengeId, credential } });
  expect(joined.status).toBe(201);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  expect(cookie.startsWith(`${COOKIE}=p`)).toBe(true);
  if (own) {
    const connected = await call('/api/me/routines/widgets', {
      method: 'PUT',
      cookie,
      body: { url: fireOf(handle), token: `sk-ant-oat01-${handle}-made-up-token`, plan: 'max20' },
    });
    expect(connected.status).toBe(201);
  }
  return { handle, cookie };
}

/** The owner makes `who` a viewer of widgets. */
const demote = async (who) =>
  expect(
    (
      await call(`/api/people/${who.handle}`, {
        method: 'PATCH',
        cookie: session,
        body: { grants: [{ repository: 'widgets', role: 'viewer' }] },
      })
    ).status,
  ).toBe(200);

const fires = [];
let next = 1;
let fetchSpy;
let settingsBefore;
const made = [];

const runsOf = (uuid) =>
  inStore((store) =>
    store.sql
      .exec('SELECT trigger, kind, for_person, routine_of FROM agent_runs WHERE task = ? ORDER BY id DESC', uuid)
      .toArray(),
  );

async function task(description, extra = {}) {
  const res = await owner('/api/tasks', {
    method: 'POST',
    body: { description, project: 'product', who: 'agent', horizon: 'now', force: true, ...extra },
  });
  expect(res.status).toBe(201);
  const t = (await res.json()).tasks[0];
  made.push(t.uuid);
  return t;
}

const free = (uuid) => owner(`/api/tasks/${uuid}/release`, { method: 'POST', body: { force: true } });

/** A feature with one task, chased by `cookie` (the owner's token without one): the task, which the chase started. */
async function chased(cookie, slug, { captain = false } = {}) {
  expect((await owner('/api/features', { method: 'POST', body: { slug } })).status).toBe(201);
  const first = await task(unique('Chased widget '), { tags: [slug] });
  const body = { on: true, captain };
  const res = await json(
    cookie
      ? await call(`/api/features/${slug}/chase`, { method: 'POST', cookie, body })
      : await owner(`/api/features/${slug}/chase`, { method: 'POST', body }),
  );
  expect(res.status).toBe(200);
  expect((await runsOf(first.uuid)).length).toBe(1);
  return first;
}

/** Queues a start for person `who` on a new task, as a press that waited for room does. */
async function queued(who) {
  const t = await task(unique('Queued widget '), { autostart: 'yes' });
  await inStore((store) => store.queueFor(t.uuid, who.handle));
  return t;
}

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\/v1\/claude_code\/routines\/trig_\w+\/fire$/u.test(url)) {
      fires.push({ url, text: JSON.parse(init.body).text });
      const id = `session_r${String(next++).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  session = await ownerCookie();
  settingsBefore = (await (await owner('/api/agents/settings', { method: 'PATCH', body: {} })).json()).settings;
  await owner('/api/agents/settings', { method: 'PATCH', body: { hourly: 30 } });
});

afterAll(async () => {
  await owner('/api/agents/settings', { method: 'PATCH', body: { hourly: settingsBefore.hourly } });
  await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
  for (const uuid of made) await free(uuid);
  fetchSpy.mockRestore();
});

describe('a person’s later starts check their role again (BRK-348)', () => {
  it('starts nothing more in a chase of someone demoted mid-chase, nor its road captain, on their own routine', async () => {
    const cleo = await person('cleo', { own: true });
    const slug = unique('demoted-chase');
    const first = await chased(cleo.cookie, slug);
    await free(first.uuid);
    await demote(cleo);
    const second = await task(unique('Later widget '), { tags: [slug] });
    fires.length = 0;
    expect(await inStore((store) => store.chaseTick({ only: slug }))).toEqual([]);
    expect(await runsOf(second.uuid)).toEqual([]);
    expect(fires).toEqual([]);
    // The chase says why it waits, and its captain can't start on their routine either.
    const why = await inStore((store) => {
      const plan = store.chaseQueue(store.featureRow(slug), store.views(), new Set(['widgets']));
      return plan.tasks.find((x) => x.uuid === second.uuid)?.why;
    });
    expect(why).toMatch(new RegExp(`${cleo.handle} is a viewer in widgets, so nothing starts there for them`, 'u'));
    await expect(inStore((store) => store.routineForStart('widgets', cleo.handle))).rejects.toThrow(
      /only a member in widgets can start an agent/u,
    );
    await expect(inStore((store) => store.startCaptain(slug))).rejects.toThrow(/viewer in widgets/u);
    expect(await inStore(async (store) => [...(await store.personStartable(cleo.handle))])).toEqual([]);
    await owner(`/api/features/${slug}/chase`, { method: 'POST', body: { on: false } });
  });

  it('starts nothing more in a chase on a lent routine once the person loses their grant there', async () => {
    expect((await call('/api/repos/widgets/routine/lend', { method: 'PUT', cookie: session, body: {} })).status).toBe(
      200,
    );
    try {
      const dev = await person('dev');
      const slug = unique('lent-chase');
      const first = await chased(dev.cookie, slug);
      expect((await runsOf(first.uuid))[0]).toMatchObject({ for_person: dev.handle, routine_of: 'owner' });
      await free(first.uuid);
      // Their grant in widgets is taken away.
      await inStore((store) => store.sql.exec("DELETE FROM grants WHERE handle = ? AND repo = 'widgets'", dev.handle));
      const second = await task(unique('Later widget '), { tags: [slug] });
      fires.length = 0;
      expect(await inStore((store) => store.chaseTick({ only: slug }))).toEqual([]);
      expect(await runsOf(second.uuid)).toEqual([]);
      expect(fires).toEqual([]);
      await owner(`/api/features/${slug}/chase`, { method: 'POST', body: { on: false } });
    } finally {
      await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
    }
  });

  it('drops a demoted person’s queued start rather than trying it every tick, and never starts it for the owner', async () => {
    const ana = await person('ana', { own: true });
    const t = await queued(ana);
    await demote(ana);
    fires.length = 0;
    const started = await inStore((store) => store.autostartTick());
    expect(started).not.toContain(t.wid ?? t.uuid);
    expect(await runsOf(t.uuid)).toEqual([]);
    const left = await inStore((store) => ({
      key: store.meta(`start_for:${t.uuid}`),
      autostart: store.tasks.get(t.uuid).autostart ?? null,
      notes: store.detail(t.uuid).annotations.map((a) => a.text),
    }));
    expect(left.key).toBeNull();
    expect(left.autostart).toBeNull();
    expect(left.notes.join('\n')).toMatch(/The start waiting for room was dropped: only a member in widgets/u);
  });

  it('stops a removed person’s chase and drops their queued starts, leaving no marker behind', async () => {
    const eve = await person('eve', { own: true });
    const slug = unique('removed-chase');
    const first = await chased(eve.cookie, slug, { captain: true });
    const captain = await inStore((store) => store.captainTask(slug));
    made.push(captain.uuid);
    const waiting = await queued(eve);
    // A start in flight holds the claim: the sweep leaves its key, so a refused fire stays the person's.
    await inStore((store) => {
      store.change(waiting.uuid, { claim: 'claude-in-flight', start: true }, new Date(), 'agents');
      store.sweepQueuedStarts();
      expect(store.meta(`start_for:${waiting.uuid}`)).toBe(eve.handle);
      store.change(waiting.uuid, { claim: null }, new Date(), 'agents');
    });
    // The object may have gone cold since: removal loads the tasks before it writes them.
    await inStore((store) => {
      store.tasks = null;
      store.key = undefined;
    });
    expect((await call(`/api/people/${eve.handle}`, { method: 'DELETE', cookie: session, body: {} })).status).toBe(200);
    const after = await inStore((store) => ({
      chase: store.featureRow(slug).chase,
      by: store.featureRow(slug).chase_by,
      captain: store.tasks.get(captain.uuid).status,
      key: store.meta(`start_for:${waiting.uuid}`),
      autostart: store.tasks.get(waiting.uuid).autostart ?? null,
      ended: store.sql
        .exec("SELECT detail FROM chase_events WHERE slug = ? AND kind = 'chase_ended'", slug)
        .toArray()
        .map((r) => r.detail),
    }));
    expect(after).toEqual({
      chase: 'stopped',
      by: null,
      captain: 'completed',
      key: null,
      autostart: null,
      ended: [`${eve.handle} left the board, so it stopped.`],
    });
    await free(first.uuid);
    fires.length = 0;
    expect(await inStore((store) => store.chaseTick({ only: slug }))).toEqual([]);
    expect(fires).toEqual([]);
  });

  it('forgets a queued start once its task finishes, goes, or stops waiting', async () => {
    const ben = await person('ben', { own: true });
    const done = await queued(ben);
    const gone = await queued(ben);
    const off = await queued(ben);
    await inStore((store) => {
      const now = new Date();
      store.change(done.uuid, { status: 'completed' }, now, 'agents');
      store.change(gone.uuid, { status: 'deleted' }, now, 'agents');
      store.change(off.uuid, { autostart: null }, now, 'agents');
      store.sweepQueuedStarts();
    });
    const keys = await inStore((store) => [done, gone, off].map((t) => store.meta(`start_for:${t.uuid}`)));
    expect(keys).toEqual([null, null, null]);
  });

  it('starts a person’s queued start on their routine when the owner has no routine anywhere', async () => {
    const cleo = await person('cleo', { own: true });
    const t = await queued(cleo);
    // The owner's routine for widgets is gone; the person's own still starts.
    const started = await inStore(async (store) => {
      const before = store.connectedRepos;
      store.connectedRepos = async () => new Set();
      try {
        return await store.autostartTick();
      } finally {
        store.connectedRepos = before;
      }
    });
    expect(started).toContain(t.wid ?? t.uuid);
    expect((await runsOf(t.uuid))[0]).toMatchObject({ for_person: cleo.handle, routine_of: cleo.handle });
    await free(t.uuid);
  });

  it('keeps the owner’s chase as before', async () => {
    const slug = unique('owners-chase');
    const first = await chased(null, slug);
    expect((await runsOf(first.uuid))[0]).toMatchObject({ trigger: 'chase', for_person: 'owner', routine_of: 'owner' });
    expect(await inStore((store) => store.featureRow(slug).chase_by)).toBeNull();
    await owner(`/api/features/${slug}/chase`, { method: 'POST', body: { on: false } });
    await free(first.uuid);
  });
});
