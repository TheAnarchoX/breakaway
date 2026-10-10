// Bring your own Claude (BRK-302, docs/specs/BRK-299-people-and-roles.md, point 5): a person connects their own routine
// and picks its plan, their agents run on it within their caps (or on a routine the owner lends, 1 at once and 5 an
// hour), the owner can lower a person's caps, and the board's caps count everyone. Fixtures are made-up people (ana,
// ben) and repositories (acme/widgets); nothing reaches the network.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LENT_CAPS, checkLimit, lentCaps, personCaps, personCeilings } from '../src/person-claude.js';
import { PLANS } from '../src/plans.js';
import { OTHER_STARTS } from '../src/permissions.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

describe('a person’s caps (src/person-claude.js)', () => {
  it('come from the plan they picked, as the owner’s come from theirs', () => {
    for (const [id, plan] of Object.entries(PLANS)) {
      const caps = personCaps({ plan: id, routines: 4 });
      expect(caps, id).toEqual({ max: plan.agents.default, hourly: plan.hourly.default });
    }
    // Claude allows 30 starts an hour for each routine: one routine holds Max 20x's 60 to 30.
    expect(personCaps({ plan: 'max20', routines: 1 })).toEqual({ max: 10, hourly: 30 });
    expect(personCeilings('max5', 1)).toEqual({ max: PLANS.max5.agents.most, hourly: 30 });
  });

  it('take what the person set within the plan’s ceilings, and never more than the owner allows', () => {
    expect(personCaps({ plan: 'pro', routines: 1, own: { max: 5, hourly: 25 } })).toEqual({ max: 5, hourly: 25 });
    expect(personCaps({ plan: 'pro', routines: 1, own: { max: 50, hourly: 500 } })).toEqual({
      max: PLANS.pro.agents.most,
      hourly: 30,
    });
    expect(
      personCaps({ plan: 'max20', routines: 4, own: { max: null, hourly: null }, owner: { max: 2, hourly: 7 } }),
    ).toEqual({ max: 2, hourly: 7 });
    expect(personCaps({ plan: null, routines: 0 })).toBeNull();
  });

  it('give a lent routine 1 at once and 5 an hour, or less when the owner lowers them', () => {
    expect(LENT_CAPS).toEqual({ max: 1, hourly: 5 });
    expect(lentCaps()).toEqual({ max: 1, hourly: 5 });
    expect(lentCaps({ max: 0, hourly: 2 })).toEqual({ max: 0, hourly: 2 });
    expect(lentCaps({ max: 4, hourly: 9 })).toEqual({ max: 1, hourly: 5 });
  });

  it('checks a limit someone sets', () => {
    expect(checkLimit(3, { least: 1, most: 6, what: 'agents at once' })).toEqual({ value: 3 });
    expect(checkLimit(null, { least: 1, most: 6, what: 'agents at once' })).toEqual({ value: null });
    expect(checkLimit(7, { least: 1, most: 6, what: 'agents at once' })).toEqual({
      error: 'agents at once is a number from 1 to 6',
    });
    expect(checkLimit(1.5, { least: 1, most: 6, what: 'x' })).toHaveProperty('error');
  });
});

// ---- On the board ----------------------------------------------------------------------------------------------------

const COOKIE = '__Host-sw_tasks';
const OWNER_FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
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

/** Invites a made-up person with `grants` and signs them in: their cookie and a personal token. */
async function person(ownerSession, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: ownerSession, body: { grants } });
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
  const tokens = await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } });
  return { handle, cookie, token: (await tokens.json()).token };
}

/** Claude's /fire, for every routine: what each start sent, and what it answers. */
const claude = { fires: [], fail: {}, next: 1 };
let fetchSpy;
let session;
let ana;
let ben;
const tasks = [];

async function task(description) {
  const res = await owner('/api/tasks', {
    method: 'POST',
    body: { description, project: 'product', who: 'agent', horizon: 'now', force: true },
  });
  expect(res.status).toBe(201);
  const made = (await res.json()).tasks[0];
  tasks.push(made.uuid);
  return made;
}

const start = (who, ref) =>
  call('/api/agents/start', { method: 'POST', cookie: who.cookie, body: { ref, anyway: true } });

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\/v1\/claude_code\/routines\/trig_\w+\/fire$/u.test(url)) {
      const headers = new Headers(init.headers);
      claude.fires.push({ url, auth: headers.get('Authorization'), text: JSON.parse(init.body).text });
      const fail = claude.fail[url];
      if (fail)
        return Response.json(
          { type: 'error', error: { type: 'x', message: 'no' } },
          { status: fail.status, headers: fail.headers ?? {} },
        );
      const id = `session_p${String(claude.next++).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  session = await ownerCookie();
  ana = await person(session, unique('ana'), [{ repository: 'widgets', role: 'member' }]);
  ben = await person(session, unique('ben'), [{ repository: 'widgets', role: 'maintainer' }]);
});

afterAll(async () => {
  // Leave the board as the other files expect it: nothing lent, no agents running for these people.
  await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
  for (const uuid of tasks) await owner(`/api/tasks/${uuid}/release`, { method: 'POST', body: { force: true } });
  fetchSpy.mockRestore();
});

describe('bringing your own Claude', () => {
  it('starts nothing for a person with no routine of their own and none lent, and says what to do', async () => {
    const t = await task('Tidy the widget list');
    const res = await json(await start(ana, t.uuid));
    expect(res.status).toBe(403);
    expect(res.error).toBe(
      `you have no Claude routine for widgets: connect yours in your settings, or ask the owner to lend you the repository’s routine`,
    );
    const mine = await json(await call('/api/me/claude', { cookie: ana.cookie }));
    expect(mine.claude.plan).toBeNull();
    expect(mine.claude.caps).toBeNull();
    expect(mine.claude.routines).toEqual([expect.objectContaining({ repo: 'widgets', connected: false, lent: false })]);
  });

  it('lends the repository’s routine only on the owner’s press, at 1 at once and 5 an hour', async () => {
    for (const who of [ana, ben]) {
      const res = await call('/api/repos/widgets/routine/lend', { method: 'PUT', cookie: who.cookie, body: {} });
      expect(res.status).toBe(403);
    }
    expect((await owner('/api/repos/widgets/routine/lend', { method: 'PUT', body: {} })).status).toBe(403);
    const lent = await json(
      await call('/api/repos/widgets/routine/lend', { method: 'PUT', cookie: session, body: {} }),
    );
    expect(lent).toMatchObject({ status: 200, repo: 'widgets', lent: true });

    const first = await task('Sort the widgets');
    claude.fires.length = 0;
    const res = await json(await start(ana, first.uuid));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ forPerson: ana.handle, routineOf: 'owner' });
    expect(claude.fires).toHaveLength(1);
    // The owner's routine, with its own token: the start says it's for ana, on the lent routine.
    expect(claude.fires[0].url).toBe(OWNER_FIRE);
    expect(claude.fires[0].text).toContain(
      `For: ${ana.handle} · on the repository’s routine, which the owner lends them`,
    );

    const second = await task('Count the widgets');
    const refused = await json(await start(ana, second.uuid));
    expect(refused.status).toBe(409);
    expect(refused.error).toBe(
      '1 of your agents is already running on the routine the owner lends you (your limit is 1)',
    );
  });

  it('connects a person’s own routine with its plan, seals it, and never gives it back', async () => {
    const url = fireOf(ana.handle);
    const token = 'sk-ant-oat01-ana-made-up-token';
    const noPlan = await json(
      await call('/api/me/routines/widgets', { method: 'PUT', cookie: ana.cookie, body: { url, token } }),
    );
    expect(noPlan.status).toBe(400);
    expect(noPlan.error).toMatch(/^say which Claude plan the routine runs on: pro \(Pro\), max5/u);
    // A personal token only reads.
    const byToken = await call('/api/me/routines/widgets', {
      method: 'PUT',
      token: ana.token,
      body: { url, token, plan: 'max5' },
    });
    expect(byToken.status).toBe(403);
    const made = await call('/api/me/routines/widgets', {
      method: 'PUT',
      cookie: ana.cookie,
      body: { url, token, plan: 'max5' },
    });
    expect(made.status).toBe(201);
    const text = await made.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(url);
    const { claude: mine } = JSON.parse(text);
    expect(mine.plan).toBe('max5');
    expect(mine.caps).toEqual({ max: PLANS.max5.agents.default, hourly: PLANS.max5.hourly.default });
    expect(mine.routines).toEqual([expect.objectContaining({ repo: 'widgets', connected: true, lent: true })]);
    const stored = await inStore((store) =>
      store.sql.exec('SELECT sealed FROM person_routines WHERE handle = ?', ana.handle).one(),
    );
    expect(stored.sealed).toMatch(/^v1\./u);
    expect(stored.sealed).not.toContain(token);
    // A viewer can't start agents, so can't connect a routine either.
    const viewer = await person(session, unique('vic'), [{ repository: 'widgets', role: 'viewer' }]);
    const refused = await json(
      await call('/api/me/routines/widgets', {
        method: 'PUT',
        cookie: viewer.cookie,
        body: { url, token, plan: 'pro' },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.error).toMatch(/^only a member in widgets can start an agent/u);
  });

  it('starts a person’s agents on their own routine, within their plan’s caps', async () => {
    const t = await task('Polish the widget page');
    claude.fires.length = 0;
    const res = await json(await start(ana, t.uuid));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ forPerson: ana.handle, routineOf: ana.handle });
    expect(claude.fires).toHaveLength(1);
    expect(claude.fires[0].url).toBe(fireOf(ana.handle));
    expect(claude.fires[0].auth).toBe('Bearer sk-ant-oat01-ana-made-up-token');
    expect(claude.fires[0].text).toContain(`For: ${ana.handle} · on their own Claude routine`);
    // The agent's run is for ana, so it acts with at most ana's rights.
    const runFor = await inStore((store) => store.runForPerson(res.run.agent));
    expect(runFor).toBe(ana.handle);
  });

  it('changes a person’s caps when they change their plan, and lets them set their own within it', async () => {
    const changed = await json(
      await call('/api/me/claude', { method: 'PATCH', cookie: ana.cookie, body: { plan: 'max20' } }),
    );
    expect(changed.claude.caps).toEqual({ max: PLANS.max20.agents.default, hourly: 30 });
    const set = await json(
      await call('/api/me/claude', { method: 'PATCH', cookie: ana.cookie, body: { max: 4, hourly: 12 } }),
    );
    expect(set.claude.caps).toEqual({ max: 4, hourly: 12 });
    const over = await json(await call('/api/me/claude', { method: 'PATCH', cookie: ana.cookie, body: { max: 99 } }));
    expect(over.status).toBe(400);
    expect(over.error).toBe(`agents at once on Max 20x is a number from 1 to ${PLANS.max20.agents.most}`);
    // A new plan sets them back to its defaults.
    const back = await json(
      await call('/api/me/claude', { method: 'PATCH', cookie: ana.cookie, body: { plan: 'pro' } }),
    );
    expect(back.claude.caps).toEqual({ max: PLANS.pro.agents.default, hourly: PLANS.pro.hourly.default });
  });

  it('lets only the owner lower a person’s caps, and holds the person to them', async () => {
    for (const who of [ana, ben]) {
      const res = await call(`/api/people/${ana.handle}/claude`, {
        method: 'PATCH',
        cookie: who.cookie,
        body: { max: 9 },
      });
      expect(res.status).toBe(403);
    }
    const agent = await owner(`/api/people/${ana.handle}/claude`, {
      method: 'PATCH',
      body: { max: 1, by: 'claude-brk-9' },
    });
    expect(agent.status).toBe(403);
    const lowered = await json(await owner(`/api/people/${ana.handle}/claude`, { method: 'PATCH', body: { max: 1 } }));
    expect(lowered.status).toBe(200);
    expect(lowered.claude.caps.max).toBe(1);
    expect(lowered.claude.ownerLimits).toEqual({ max: 1, hourly: null });
    const t = await task('Rename the widget field');
    const refused = await json(await start(ana, t.uuid));
    expect(refused.status).toBe(409);
    expect(refused.error).toBe('1 of your agents is already running (your limit is 1)');
    // Lifting it gives the plan's caps back.
    const lifted = await json(
      await owner(`/api/people/${ana.handle}/claude`, { method: 'PATCH', body: { max: null } }),
    );
    expect(lifted.claude.caps.max).toBe(PLANS.pro.agents.default);
  });

  it('counts every person’s agents in the board’s own caps, and shows each person’s runs', async () => {
    const overview = await json(await owner('/api/agents'));
    const row = overview.people.find((p) => p.handle === ana.handle);
    expect(row).toMatchObject({
      plan: 'pro',
      routines: ['widgets'],
      runs: { own: { running: 1, started: 1 }, lent: { running: 1, started: 1 } },
    });
    expect(overview.running.filter((r) => r.forPerson === ana.handle)).toHaveLength(2);
    // With the board's agents at once at what runs now, a person's start waits like the owner's.
    const running = overview.running.length;
    const before = overview.settings.max;
    await owner('/api/agents/settings', { method: 'PATCH', body: { max: running } });
    try {
      const t = await task('Widget docs');
      const res = await json(await start(ana, t.uuid));
      expect(res.status).toBe(409);
      expect(res.error).toBe(`${running} agents are already running (the limit is ${running})`);
    } finally {
      await owner('/api/agents/settings', { method: 'PATCH', body: { max: before } });
    }
  });

  it('shows a person only their own Claude in the Agents view, and lets only a member pick a plan', async () => {
    const theirs = await json(await call('/api/agents', { cookie: ana.cookie }));
    expect(theirs.status).toBe(200);
    expect(theirs.people.map((p) => p.handle)).toEqual([ana.handle]);
    const others = await json(await call('/api/agents', { cookie: ben.cookie }));
    expect(others.people.map((p) => p.handle)).toEqual([ben.handle]);
    const viewer = await person(session, unique('val'), [{ repository: 'widgets', role: 'viewer' }]);
    const seen = await json(await call('/api/agents', { token: viewer.token }));
    expect(seen.people.map((p) => p.handle)).toEqual([viewer.handle]);
    const plan = await json(
      await call('/api/me/claude', { method: 'PATCH', cookie: viewer.cookie, body: { plan: 'max20' } }),
    );
    expect(plan.status).toBe(403);
    expect(plan.error).toBe('only a member of a repository can start agents, so only a member picks a Claude plan');
  });

  it('holds a person’s routine apart when Claude refuses it, and never the owner’s', async () => {
    const t = await task('Widget icons');
    claude.fail[fireOf(ana.handle)] = { status: 429, headers: { 'Retry-After': '600' } };
    try {
      await owner(`/api/people/${ana.handle}/claude`, { method: 'PATCH', body: { max: 5 } });
      const res = await json(await start(ana, t.uuid));
      expect(res.status).toBe(429);
      const holds = await inStore((store) => ({
        theirs: store.routineHold('widgets', ana.handle)?.kind ?? null,
        owners: store.routineHold('widgets')?.kind ?? null,
      }));
      expect(holds).toEqual({ theirs: 'limit', owners: null });
    } finally {
      delete claude.fail[fireOf(ana.handle)];
      await inStore((store) => store.setMeta(`routine_hold:widgets:person:${ana.handle}`, null));
    }
  });

  it('keeps the owner’s starts on the repository’s routine, as before', async () => {
    const t = await task('Owner’s widget');
    claude.fires.length = 0;
    const res = await json(await owner('/api/agents/start', { method: 'POST', body: { ref: t.uuid, anyway: true } }));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ forPerson: 'owner', routineOf: 'owner' });
    expect(claude.fires[0].url).toBe(OWNER_FIRE);
    expect(claude.fires[0].text).not.toMatch(/Claude routine|lends them/u);
  });

  it('refuses a person’s other starts with the task they wait for', async () => {
    const res = await json(
      await call('/api/agents/next', { method: 'POST', cookie: ben.cookie, body: { repo: 'widgets', count: 1 } }),
    );
    expect(res.status).toBe(403);
    expect(res.error).toBe(OTHER_STARTS);
  });

  it('forgets a person’s routines when they’re removed, and seals them again on a rotation', async () => {
    const resealed = await inStore((store) =>
      store.resealedPersonRoutines('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    );
    expect(resealed.map((r) => r.handle)).toContain(ana.handle);
    const forgot = await json(
      await call('/api/me/routines/widgets', { method: 'DELETE', cookie: ben.cookie, body: {} }),
    );
    expect(forgot.status).toBe(404);
    const removed = await call(`/api/people/${ana.handle}`, { method: 'DELETE', cookie: session, body: {} });
    expect(removed.status).toBe(200);
    const left = await inStore((store) => ({
      routines: store.sql.exec('SELECT COUNT(*) AS n FROM person_routines WHERE handle = ?', ana.handle).one().n,
      plan: store.sql.exec('SELECT COUNT(*) AS n FROM person_claude WHERE handle = ?', ana.handle).one().n,
    }));
    expect(left).toEqual({ routines: 0, plan: 0 });
  });
});
