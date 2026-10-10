// A person's other starts (BRK-334, docs/specs/BRK-299-people-and-roles.md, point 5): a chase, Start next, general,
// review, and routine-making agents, carry on, describe, and move each run on the person who pressed, on their own
// Claude routine (or the one the owner lends) within their caps, and the payload says who started them. Fixtures are
// made-up people (cleo, dev) and repositories (acme/widgets); nothing reaches the network.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startedWords } from '../src/store-agents.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { fakeProvider } from './fake-infra-provider.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

describe('the Started line (startedWords)', () => {
  it('reads as it always has for the owner and the board', () => {
    expect(startedWords('general')).toBe('by a prompt from the owner, from the board');
    expect(startedWords('chase', null)).toBe('by the owner’s chase of a feature, because the task became ready');
    expect(startedWords('next')).toBe('as one of the next few ready tasks, from the board');
  });

  it('names the person who started it', () => {
    expect(startedWords('general', 'Cleo')).toBe('by a prompt from Cleo, from the board');
    expect(startedWords('chase', 'Cleo')).toBe('by Cleo’s chase of a feature, because the task became ready');
    expect(startedWords('chase-fix', 'Cleo')).toBe(
      'by Cleo’s chase of a feature, to fix a pull request its agent left',
    );
    expect(startedWords('next', 'Cleo')).toBe('as one of the next few ready tasks, from the board, started by Cleo');
    expect(startedWords('move', 'Cleo')).toBe(
      'by “Move to breakaway’s deploy flow” on the GitHub page, from the board, started by Cleo',
    );
  });
});

// ---- On the board ----------------------------------------------------------------------------------------------------

const COOKIE = '__Host-sw_tasks';
const OWNER_FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fireOf = (name) => `https://api.anthropic.com/v1/claude_code/routines/trig_${name}/fire`;
const PROVIDER = 'fake-people-starts';
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

/** Invites a made-up person with `grants` and signs them in: their cookie. */
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
  return { handle, cookie };
}

/** Claude's /fire, for every routine: what each start sent. */
const fires = [];
let next = 1;
let fetchSpy;
let session;
let cleo;
let dev;
let settingsBefore;
const made = [];

/** The runs started for the tasks given, newest first. */
const runsOf = (uuid) =>
  inStore((store) =>
    store.sql
      .exec('SELECT trigger, kind, for_person, routine_of FROM agent_runs WHERE task = ? ORDER BY id DESC', uuid)
      .toArray(),
  );

/** The fire that started the run on `uuid`'s task: its routine and its payload. */
const fireFor = (agent) => fires.find((f) => f.text.includes(`Agent name: ${agent}\n`));

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

/** Fills the board's agents at once with made-up running agents, so the next start waits for room: their tasks. */
async function fillBoard() {
  const { max } = (await (await owner('/api/agents/settings', { method: 'PATCH', body: {} })).json()).settings;
  const fillers = [];
  for (let i = 0; i < max; i += 1) {
    const t = await task(unique('Filler widget '));
    fillers.push(t.uuid);
    const agent = `claude-filler-${i}-${t.short}`;
    await inStore((store) => {
      store.change(t.uuid, { claim: agent, start: true }, new Date(), 'agents');
      store.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, kind, status, started, repo) VALUES (?, ?, 'manual', 'build', 'started', ?, 'widgets')",
        t.uuid,
        agent,
        Date.now(),
      );
    });
  }
  return fillers;
}

/** Sets person `who`'s grants, as the owner's press on People does. */
const grant = (who, grants) =>
  call(`/api/people/${who.handle}`, { method: 'PATCH', cookie: session, body: { grants } });

/** Who added task `uuid`, from Activity (BRK-303): the person behind the version that made it. */
const addedBy = async (uuid) => {
  const { events } = await (await owner('/api/activity?limit=200')).json();
  return events.filter((e) => e.task?.uuid === uuid && e.source === 'api').at(-1)?.who?.person ?? null;
};

/** Frees the board's room after a start: the run's claim goes, as an agent's release would. */
const free = (uuid) => owner(`/api/tasks/${uuid}/release`, { method: 'POST', body: { force: true } });

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/\/v1\/claude_code\/routines\/trig_\w+\/fire$/u.test(url)) {
      fires.push({ url, text: JSON.parse(init.body).text });
      const id = `session_s${String(next++).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });
  session = await ownerCookie();
  // Room for every start below in one hour.
  settingsBefore = (await (await owner('/api/agents/settings', { method: 'PATCH', body: {} })).json()).settings;
  await owner('/api/agents/settings', { method: 'PATCH', body: { hourly: 30 } });
  cleo = await person(session, unique('cleo'), [{ repository: 'widgets', role: 'maintainer' }]);
  dev = await person(session, unique('dev'), [{ repository: 'widgets', role: 'maintainer' }]);
  // cleo brings her own Claude; dev has none, and nothing is lent until a test lends it.
  const connected = await call('/api/me/routines/widgets', {
    method: 'PUT',
    cookie: cleo.cookie,
    body: { url: fireOf(cleo.handle), token: 'sk-ant-oat01-cleo-made-up-token', plan: 'max20' },
  });
  expect(connected.status).toBe(201);
});

afterAll(async () => {
  await owner('/api/agents/settings', { method: 'PATCH', body: { hourly: settingsBefore.hourly } });
  await call('/api/repos/widgets/routine/lend', { method: 'DELETE', cookie: session, body: {} });
  for (const uuid of made) await free(uuid);
  fetchSpy.mockRestore();
});

describe('a person’s other starts run on their own Claude (BRK-334)', () => {
  it('starts a general agent on the person’s routine, names them on the task, and says who started it', async () => {
    fires.length = 0;
    const res = await json(
      await call('/api/agents/general', {
        method: 'POST',
        cookie: cleo.cookie,
        body: { prompt: 'Tidy the widget docs', repo: 'widgets' },
      }),
    );
    expect(res.status).toBe(201);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ kind: 'general', forPerson: cleo.handle, routineOf: cleo.handle });
    const fire = fireFor(res.run.agent);
    expect(fire.url).toBe(fireOf(cleo.handle));
    expect(fire.text).toContain(`Started: by a prompt from ${cleo.handle}, from the board`);
    expect(await addedBy(res.task.uuid)).toBe(cleo.handle);
    await free(res.task.uuid);
  });

  it('refuses a general agent for a person with no routine and none lent, adding nothing', async () => {
    const before = await inStore((store) => store.tasks.size);
    const res = await json(
      await call('/api/agents/general', {
        method: 'POST',
        cookie: dev.cookie,
        body: { prompt: 'Count the widgets', repo: 'widgets' },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/^you have no Claude routine for widgets/u);
    expect(await inStore((store) => store.tasks.size)).toBe(before);
  });

  it('starts a routine maker on the person’s routine', async () => {
    fires.length = 0;
    const res = await json(
      await call('/api/routines/agent', {
        method: 'POST',
        cookie: cleo.cookie,
        body: { prompt: 'Every Monday, update the changelog', repo: 'widgets' },
      }),
    );
    expect(res.status).toBe(201);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ kind: 'routines', forPerson: cleo.handle, routineOf: cleo.handle });
    expect(fireFor(res.run.agent).text).toContain(
      `Started: by “Make with an agent” on the Routines view, from the board, started by ${cleo.handle}`,
    );
    await free(res.task.uuid);
  });

  it('carries on a routine maker’s decision on the presser’s routine', async () => {
    const res = await json(
      await call('/api/routines/agent', {
        method: 'POST',
        cookie: cleo.cookie,
        body: { prompt: 'Every Friday, tidy the issues', repo: 'widgets' },
      }),
    );
    made.push(res.task.uuid);
    const decision = [
      {
        id: 'when',
        type: 'choice',
        prompt: 'When should it run?',
        options: [
          { id: 'friday', label: 'Every Friday' },
          { id: 'button', label: 'Only when I press Run now' },
        ],
      },
    ];
    expect((await owner(`/api/tasks/${res.task.uuid}`, { method: 'PATCH', body: { decision } })).status).toBe(200);
    await free(res.task.uuid);
    fires.length = 0;
    const carried = await json(
      await call(`/api/tasks/${res.task.uuid}/decision/answers`, {
        method: 'POST',
        cookie: dev.cookie,
        body: { answers: { when: { value: 'friday' } }, carryOn: true },
      }),
    );
    // dev pressed, and dev has no routine: the press is refused before anything is answered.
    expect(carried.status).toBe(403);
    expect(carried.error).toMatch(/^you have no Claude routine for widgets/u);
    const again = await json(
      await call(`/api/tasks/${res.task.uuid}/decision/answers`, {
        method: 'POST',
        cookie: cleo.cookie,
        body: { answers: { when: { value: 'friday' } }, carryOn: true },
      }),
    );
    expect(again.status).toBe(200);
    expect(again.run).toMatchObject({ kind: 'routines', forPerson: cleo.handle, routineOf: cleo.handle });
    expect(fireFor(again.run.agent).text).toContain(`started by ${cleo.handle}`);
    await free(res.task.uuid);
  });

  it('starts Start next on the person’s routine, in the repository they named', async () => {
    const t = await task(unique('Next widget '));
    fires.length = 0;
    const res = await json(
      await call('/api/agents/next', { method: 'POST', cookie: cleo.cookie, body: { repo: 'widgets', count: 5 } }),
    );
    expect(res.status).toBe(200);
    expect(res.started.length).toBeGreaterThan(0);
    for (const s of res.started) {
      const [run] = await runsOf(s.uuid);
      expect(run).toMatchObject({ trigger: 'next', for_person: cleo.handle, routine_of: cleo.handle });
      made.push(s.uuid);
      await free(s.uuid);
    }
    expect(fires.every((f) => f.url === fireOf(cleo.handle))).toBe(true);
    expect(fires[0].text).toContain(`from the board, started by ${cleo.handle}`);
    await free(t.uuid);
  });

  it('skips every task for a person with no routine anywhere, and starts nothing', async () => {
    await task(unique('Unstarted widget '));
    fires.length = 0;
    const res = await json(
      await call('/api/agents/next', { method: 'POST', cookie: dev.cookie, body: { repo: 'widgets', count: 5 } }),
    );
    expect(res.status).toBe(200);
    expect(res.started).toEqual([]);
    expect(res.skipped.some((s) => /^you have no Claude routine for widgets/u.test(s.reason))).toBe(true);
    expect(fires).toHaveLength(0);
  });

  it('starts a review agent on a Dependabot pull request for the person', async () => {
    const number = 9000 + Math.floor(Math.random() * 900);
    await inStore((store) =>
      store.sql.exec(
        "INSERT INTO gh_pulls (repo, number, updated, state, data) VALUES (?, ?, ?, 'open', ?)",
        'widgets',
        number,
        new Date().toISOString(),
        JSON.stringify({
          number,
          title: 'Bump widget-lib from 1.0.0 to 1.0.1',
          state: 'open',
          draft: false,
          url: `https://github.com/acme/widgets/pull/${number}`,
          author: 'dependabot[bot]',
          mergeable: true,
          mergeableState: 'clean',
          checks: { state: 'success', total: 1, passed: 1, runs: [] },
          review: { decision: null, comments: 0 },
          closes: [],
          mentions: [],
        }),
      ),
    );
    fires.length = 0;
    const res = await json(
      await call(`/api/github/pulls/${number}/review`, {
        method: 'POST',
        cookie: cleo.cookie,
        body: { repo: 'widgets' },
      }),
    );
    expect(res.status).toBe(200);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ kind: 'review', forPerson: cleo.handle, routineOf: cleo.handle });
    expect(fireFor(res.run.agent).text).toContain(`started by ${cleo.handle}`);
    await free(res.task.uuid);
  });

  it('moves a repository to the deploy flow on the person’s routine', async () => {
    fires.length = 0;
    const res = await json(await call('/api/repos/widgets/move', { method: 'POST', cookie: cleo.cookie, body: {} }));
    expect([200, 201]).toContain(res.status);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ forPerson: cleo.handle, routineOf: cleo.handle });
    expect(fireFor(res.run.agent).text).toContain(
      `Started: by “Move to breakaway’s deploy flow” on the GitHub page, from the board, started by ${cleo.handle}`,
    );
    await free(res.task.uuid);
  });

  it('has an agent describe an environment as code on the person’s routine, and names them on the task', async () => {
    const name = unique('people-describe');
    const env = await json(
      await call('/api/infra/environments', {
        method: 'POST',
        cookie: session,
        body: { repo: 'widgets', provider: PROVIDER, name, kind: 'staging', target: 'api' },
      }),
    );
    expect(env.status).toBe(201);
    await inStore(async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(fakeProvider({ id: PROVIDER }));
      await instance.refreshInventory(PROVIDER);
    });
    fires.length = 0;
    const res = await json(
      await call(`/api/infra/environments/${env.environment.id}/describe`, {
        method: 'POST',
        cookie: cleo.cookie,
        body: {},
      }),
    );
    expect(res.status).toBe(201);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ forPerson: cleo.handle, routineOf: cleo.handle });
    expect(fireFor(res.run.agent).text).toContain(`started by ${cleo.handle}`);
    expect(await addedBy(res.task.uuid)).toBe(cleo.handle);
    await free(res.task.uuid);
  });

  it('runs a person’s chase, its ticks, and its road captain on their routine, and says whose chase it is', async () => {
    const slug = unique('people-chase');
    expect((await owner('/api/features', { method: 'POST', body: { slug } })).status).toBe(201);
    const t = await task(unique('Chased widget '), { tags: [slug] });
    // dev has no routine anywhere: Chase refuses, rather than turning on a chase that can start nothing.
    const refused = await json(
      await call(`/api/features/${slug}/chase`, { method: 'POST', cookie: dev.cookie, body: { on: true } }),
    );
    expect(refused.status).toBe(403);
    expect(refused.error).toMatch(/^you have no Claude routine for widgets/u);
    fires.length = 0;
    const res = await json(
      await call(`/api/features/${slug}/chase`, {
        method: 'POST',
        cookie: cleo.cookie,
        body: { on: true, captain: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(await inStore((store) => store.featureRow(slug).chase_by)).toBe(cleo.handle);
    const [run] = await runsOf(t.uuid);
    expect(run).toMatchObject({ trigger: 'chase', for_person: cleo.handle, routine_of: cleo.handle });
    const chased = fires.find((f) => f.text.includes(`Task: ${t.wid}\n`));
    expect(chased.url).toBe(fireOf(cleo.handle));
    expect(chased.text).toContain(`Started: by ${cleo.handle}’s chase of a feature, because the task became ready`);
    const captain = await inStore((store) => store.captainTask(slug));
    made.push(captain.uuid);
    const [captainRun] = await runsOf(captain.uuid);
    expect(captainRun).toMatchObject({ kind: 'captain', for_person: cleo.handle, routine_of: cleo.handle });
    // Stopping it starts nothing more; the owner's chase on it again is the owner's.
    expect(
      (await call(`/api/features/${slug}/chase`, { method: 'POST', cookie: cleo.cookie, body: { on: false } })).status,
    ).toBe(200);
    await free(t.uuid);
    await free(captain.uuid);
    const again = await json(await owner(`/api/features/${slug}/chase`, { method: 'POST', body: { on: true } }));
    expect(again.status).toBe(200);
    expect(await inStore((store) => store.featureRow(slug).chase_by)).toBeNull();
    const [ownerRun] = await runsOf(t.uuid);
    expect(ownerRun).toMatchObject({ trigger: 'chase', for_person: 'owner', routine_of: 'owner' });
    await owner(`/api/features/${slug}/chase`, { method: 'POST', body: { on: false } });
    await free(t.uuid);
  });

  it('starts a person’s general agent that waited for room on their routine, not the owner’s', async () => {
    const fillers = await fillBoard();
    try {
      const res = await json(
        await call('/api/agents/general', {
          method: 'POST',
          cookie: cleo.cookie,
          body: { prompt: 'Rename the widget sizes', repo: 'widgets' },
        }),
      );
      expect(res.status).toBe(202);
      made.push(res.task.uuid);
      expect(res.waiting).toBeTruthy();
      expect(await inStore((store) => store.queuedFor(res.task.uuid))).toBe(cleo.handle);
      for (const uuid of fillers) await free(uuid);
      fires.length = 0;
      const started = await inStore((store) => store.autostartTick());
      expect(started).toContain(res.task.uuid);
      const [run] = await runsOf(res.task.uuid);
      expect(run).toMatchObject({ trigger: 'general', for_person: cleo.handle, routine_of: cleo.handle });
      expect(fires.find((f) => f.text.includes(`Task: ${res.task.uuid}\n`)).url).toBe(fireOf(cleo.handle));
      // Started, nobody waits on it any more.
      expect(await inStore((store) => store.meta(`start_for:${res.task.uuid}`))).toBeNull();
      await free(res.task.uuid);
    } finally {
      for (const uuid of fillers) await free(uuid);
    }
  });

  it('names the person on an idea they ask an agent to shape, and starts its agent on their routine', async () => {
    const slug = unique('people-shape');
    const res = await json(
      await call('/api/features', {
        method: 'POST',
        cookie: cleo.cookie,
        body: { slug, brief: 'Widgets sorted by size.', shape: { repo: 'widgets', horizon: 'next' } },
      }),
    );
    expect(res.status).toBe(201);
    made.push(res.idea.uuid);
    expect(await addedBy(res.idea.uuid)).toBe(cleo.handle);
    expect(await inStore((store) => store.queuedFor(res.idea.uuid))).toBe(cleo.handle);
    fires.length = 0;
    await inStore((store) => store.autostartTick());
    const [run] = await runsOf(res.idea.uuid);
    expect(run).toMatchObject({ for_person: cleo.handle, routine_of: cleo.handle });
    expect(fires[0].url).toBe(fireOf(cleo.handle));
    await free(res.idea.uuid);
  });

  it('stops a chase whose starter can’t chase any more, and starts nothing more for them', async () => {
    const eve = await person(session, unique('eve'), [{ repository: 'widgets', role: 'maintainer' }]);
    const connected = await call('/api/me/routines/widgets', {
      method: 'PUT',
      cookie: eve.cookie,
      body: { url: fireOf(eve.handle), token: 'sk-ant-oat01-eve-made-up-token', plan: 'max20' },
    });
    expect(connected.status).toBe(201);
    const slug = unique('people-lowered');
    expect((await owner('/api/features', { method: 'POST', body: { slug } })).status).toBe(201);
    const first = await task(unique('Lowered widget '), { tags: [slug] });
    const res = await json(
      await call(`/api/features/${slug}/chase`, { method: 'POST', cookie: eve.cookie, body: { on: true } }),
    );
    expect(res.status).toBe(200);
    expect((await runsOf(first.uuid))[0]).toMatchObject({ trigger: 'chase', for_person: eve.handle });
    await free(first.uuid);
    // The owner lowers eve to a viewer: her chase's next tick starts nothing, and the board stops it.
    expect((await grant(eve, [{ repository: 'widgets', role: 'viewer' }])).status).toBe(200);
    const second = await task(unique('Lowered widget '), { tags: [slug] });
    fires.length = 0;
    await inStore((store) => store.chaseTick({ only: slug }));
    expect(await runsOf(second.uuid)).toEqual([]);
    expect(fires).toHaveLength(0);
    expect(await inStore((store) => store.featureRow(slug).chase)).toBe('stopped');
    const event = await inStore(
      (store) =>
        store.sql
          .exec("SELECT detail FROM chase_events WHERE slug = ? AND kind = 'chase_stopped' ORDER BY id DESC", slug)
          .toArray()[0],
    );
    expect(JSON.stringify(event)).toContain(`${eve.handle} started it and can’t chase it now`);
    // Nor does a start that waited for room run for her, and her waiting starts go when she's removed.
    expect((await grant(eve, [{ repository: 'widgets', role: 'maintainer' }])).status).toBe(200);
    const fillers = await fillBoard();
    try {
      const queued = await json(
        await call('/api/agents/general', {
          method: 'POST',
          cookie: eve.cookie,
          body: { prompt: 'Polish the widget icons', repo: 'widgets' },
        }),
      );
      expect(queued.status).toBe(202);
      made.push(queued.task.uuid);
      expect((await grant(eve, [{ repository: 'widgets', role: 'viewer' }])).status).toBe(200);
      for (const uuid of fillers) await free(uuid);
      fires.length = 0;
      const started = await inStore((store) => store.autostartTick());
      expect(started).not.toContain(queued.task.uuid);
      expect(await runsOf(queued.task.uuid)).toEqual([]);
      const waiting = await inStore((store) =>
        store.autostartQueue(store.views()).find((q) => q.uuid === queued.task.uuid),
      );
      expect(waiting.ready).toBe(false);
      expect(waiting.reason).toMatch(new RegExp(`^it was started for ${eve.handle}, who can’t start it now`, 'u'));
      expect((await call(`/api/people/${eve.handle}`, { method: 'DELETE', cookie: session, body: {} })).status).toBe(
        200,
      );
      expect(await inStore((store) => store.meta(`start_for:${queued.task.uuid}`))).toBeNull();
    } finally {
      for (const uuid of fillers) await free(uuid);
    }
    await free(second.uuid);
  });

  it('keeps the owner’s starts on the repository’s routine, saying nothing about who started them', async () => {
    fires.length = 0;
    const res = await json(
      await owner('/api/agents/general', {
        method: 'POST',
        body: { prompt: 'Sweep the widget shelf', repo: 'widgets' },
      }),
    );
    expect(res.status).toBe(201);
    made.push(res.task.uuid);
    expect(res.run).toMatchObject({ forPerson: 'owner', routineOf: 'owner' });
    const fire = fireFor(res.run.agent);
    expect(fire.url).toBe(OWNER_FIRE);
    expect(fire.text).toContain('Started: by a prompt from the owner, from the board');
    expect(fire.text).not.toMatch(/started by/u);
    await free(res.task.uuid);
  });
});
