// People see only their repositories (BRK-323, docs/specs/BRK-299-people-and-roles.md, point 3, "What a person
// sees"): every read a person makes is filtered by their grants, and their write answers too. Fixtures are made-up
// people (vic, …) and repositories (acme/widgets, acme/gadgets).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import workerSource from '../src/worker.js?raw';
import { isHidden, lostTarget, readOf, scrub } from '../src/reads.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// ---- The pure half --------------------------------------------------------------------------------------------------

describe('the scrub (src/reads.js)', () => {
  const hidden = { repos: new Set(['gadgets', 'acme/gadgets']), tasks: new Set(['u-gad', 'GAD-1']) };

  it('takes out list items, map keys, and task links that belong to a repository the person can’t read', () => {
    const before = {
      tasks: [
        { uuid: 'u-wid', repo: 'widgets', depends: ['u-gad', 'u-other'], dependsOn: [{ uuid: 'u-gad', wid: 'GAD-1' }] },
        { uuid: 'u-gad', repo: 'gadgets' },
      ],
      byRepo: { widgets: 2, gadgets: 1 },
      repos: ['widgets', 'gadgets'],
      incident: { task: 'u-gad', level: 'critical' },
      link: 'https://github.com/acme/gadgets/pull/3',
      note: 'a gadgets word in prose stays',
    };
    expect(scrub(before, hidden)).toEqual({
      tasks: [{ uuid: 'u-wid', repo: 'widgets', depends: ['u-other'], dependsOn: [] }],
      byRepo: { widgets: 2 },
      repos: ['widgets'],
      incident: null,
      link: null,
      note: 'a gadgets word in prose stays',
    });
    // Untouched: a new value comes back.
    expect(before.repos).toEqual(['widgets', 'gadgets']);
  });

  it('leaves everything for someone who can see everything', () => {
    const value = { repo: 'gadgets', tasks: ['u-gad'] };
    expect(scrub(value, { repos: new Set(), tasks: new Set() })).toBe(value);
  });

  it('knows a hidden thing by its repository or its task, and says when the thing asked for is gone', () => {
    expect(isHidden({ github: 'acme/gadgets' }, hidden)).toBe(true);
    expect(isHidden({ wid: 'GAD-1' }, hidden)).toBe(true);
    expect(isHidden({ repo: 'widgets' }, hidden)).toBe(false);
    expect(lostTarget({ plan: { repo: 'gadgets' } }, { plan: null })).toBe(true);
    expect(lostTarget({ plans: [{ repo: 'gadgets' }] }, { plans: [] })).toBe(false);
  });

  it('refuses a route it doesn’t know, and knows the install’s own reads', () => {
    const q = (s = '') => new URLSearchParams(s);
    expect(readOf(['no-such-route'], q())).toBeNull();
    expect(readOf(['connections'], q())).toEqual({ install: true });
    expect(readOf(['tasks', 'BRK-1', 'messages'], q())).toEqual({ target: { task: 'BRK-1' } });
    expect(readOf(['infra', 'costs'], q('repo=widgets'))).toEqual({ repo: 'widgets', absent: 'install' });
  });
});

// ---- Every GET route, as a viewer of acme/widgets only ----------------------------------------------------------------

const COOKIE = '__Host-sw_tasks';
const SECRET = 'GADGET-SECRET';
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

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** Invites a made-up person with `grants`, and signs them in: their cookie and a personal token. */
async function person(session, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: session, body: { grants } });
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

let w;
let fetchSpy;

beforeAll(async () => {
  // Nothing reaches the network: GitHub and Claude answer 404 to everything.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  const added = await owner('/api/repos', {
    method: 'POST',
    body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GAD'], defaultBranch: 'main' },
  });
  expect([201, 400]).toContain(added.status);
  const task = async (body) => {
    const res = await owner('/api/tasks', { method: 'POST', body: { force: true, project: 'product', ...body } });
    expect(res.status).toBe(201);
    return (await res.json()).tasks[0];
  };
  const mixed = unique('reads-mixed');
  const gadOnly = unique('reads-gad');
  await owner('/api/features', { method: 'POST', body: { slug: mixed } });
  await owner('/api/features', { method: 'POST', body: { slug: gadOnly } });
  const gadget = await task({ description: `${SECRET} task`, repo: 'gadgets', tags: [mixed] });
  await task({ description: `${SECRET} other task`, repo: 'gadgets', tags: [gadOnly] });
  const widget = await task({
    description: 'A widget task',
    depends: [gadget.uuid],
    related: [gadget.uuid],
    tags: [mixed],
  });
  await owner(`/api/tasks/${gadget.uuid}/comments`, { method: 'POST', body: { text: `${SECRET} comment` } });
  const routine = await owner('/api/routines', {
    method: 'POST',
    body: { slug: unique('gad-routine'), name: `${SECRET} routine`, prompt: 'x', repo: 'gadgets', enabled: false },
  });
  expect(routine.status).toBe(201);
  // An agent holds the gadget task and posts on its peloton.
  expect(
    (await owner(`/api/tasks/${gadget.uuid}/claim`, { method: 'POST', body: { agent: 'claude-gad-1' } })).status,
  ).toBe(200);
  await owner('/api/peloton/gadgets', {
    method: 'POST',
    body: { agent: 'claude-gad-1', kind: 'note', text: `${SECRET} post` },
  });
  await owner(`/api/tasks/${gadget.uuid}/pings`, {
    method: 'POST',
    body: { agent: 'claude-gad-1', kind: 'fyi', message: `${SECRET} ping` },
  });
  // Infrastructure in each repository, made straight in the store.
  const ids = await inStore((store) => {
    const now = Date.now();
    const out = {};
    for (const repo of ['widgets', 'gadgets']) {
      const name = unique(`${repo === 'gadgets' ? 'gad' : 'wid'}-env`);
      const envId = store.sql
        .exec(
          "INSERT INTO infra_environments (repo, name, kind, created, edited) VALUES (?, ?, 'staging', ?, ?) RETURNING id",
          repo,
          name,
          now,
          now,
        )
        .one().id;
      const plan = store.sql
        .exec(
          "INSERT INTO infra_plans (environment, repo, provider, source, state, diff, cost, blast, reversible, by, created, updated) VALUES (?, ?, 'fake', 'manual', 'waiting', ?, '{}', '{}', 1, 'owner', ?, ?) RETURNING n",
          envId,
          repo,
          JSON.stringify({ changes: [] }),
          now,
          now,
        )
        .one().n;
      const change = store.sql
        .exec(
          "INSERT INTO infra_changes (n, environment, repo, name, edits, lines, branch, state, created, updated) VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM infra_changes), ?, ?, 'x', '[]', '[]', 'b', 'open', ?, ?) RETURNING n",
          envId,
          repo,
          now,
          now,
        )
        .one().n;
      out[repo] = { env: envId, name, plan, change };
    }
    // The road captain's log and a digest on the feature that spans both: free text that names gadgets.
    store.sql.exec(
      "INSERT INTO captain_logs (slug, at, agent, text, handover) VALUES (?, ?, 'claude-captain-x', ?, 0)",
      mixed,
      now,
      `gadgets: ${SECRET} is blocked on the queue rewrite`,
    );
    out.digest = store.sql
      .exec(
        "INSERT INTO chase_digests (slug, at, kind, data) VALUES (?, ?, 'hourly', ?) RETURNING id",
        mixed,
        now,
        JSON.stringify({
          merged: [],
          waiting: [],
          stuck: [],
          summary: `${SECRET} in gadgets`,
          note: `${SECRET} in gadgets`,
        }),
      )
      .one().id;
    store.sql.exec(
      "INSERT INTO peloton_plans (peloton, version, text, agent, task, at, why) VALUES (?, 1, ?, 'owner', NULL, ?, 'start')",
      `chase:${mixed}`,
      `gadgets: ${SECRET} plan names src/billing/`,
      now,
    );
    out.image = store.sql
      .exec(
        "INSERT INTO attachments (task, name, type, size, alt, added_at, data) VALUES (?, 'a.png', 'image/png', 1, '', ?, ?) RETURNING id",
        gadget.uuid,
        now,
        new Uint8Array([1]),
      )
      .one().id;
    return out;
  });
  const viewer = await person(session, unique('vic'), [{ repository: 'widgets', role: 'viewer' }]);
  w = { session, gadget, widget, mixed, gadOnly, viewer, ...ids };
}, 120_000);

afterAll(() => fetchSpy?.mockRestore());

/** Whatever names acme/gadgets or what's in it. */
const leaks = (text) =>
  [SECRET, 'gadgets', w.gadget.uuid, w.gadget.wid, w.gadgets.name].filter((needle) => text.includes(needle));

/**
 * Every GET route the API has, as the viewer asks it: `ok` for a read they get (filtered), `install` for the install's
 * own (the owner's and the `*` grant's: 403), and `hidden` for one about acme/gadgets (404, as if it weren't there).
 */
function reads() {
  const t = w.widget.uuid;
  const g = w.gadget.uuid;
  const we = encodeURIComponent(w.widgets.name);
  const ge = encodeURIComponent(w.gadgets.name);
  const ok = (path) => ({ path, want: 'ok' });
  const install = (path) => ({ path, want: 'install' });
  const hidden = (path) => ({ path, want: 'hidden' });
  return [
    install('/api/health'),
    ok('/api/activity'),
    ok('/api/footprints'),
    ok('/api/footprints?repo=widgets'),
    install('/api/stats'),
    ok('/api/stats?repo=widgets'),
    hidden('/api/stats?repo=gadgets'),
    ok('/api/github'),
    hidden('/api/github?repo=gadgets'),
    install('/api/connections'),
    install('/api/self-update'),
    ok('/api/repos'),
    install('/api/repos/setup'),
    ok('/api/repos/widgets'),
    hidden('/api/repos/gadgets'),
    install('/api/kickoffs'),
    install('/api/kickoffs/IDEA-1'),
    ok('/api/infra/environments'),
    ok('/api/infra/environments?repo=widgets'),
    hidden('/api/infra/environments?repo=gadgets'),
    ok(`/api/infra/environments/${we}`),
    hidden(`/api/infra/environments/${ge}`),
    hidden(`/api/infra/environments/${w.gadgets.env}`),
    ok(`/api/infra/environments/${we}/draft`),
    hidden(`/api/infra/environments/${ge}/draft`),
    ok(`/api/infra/environments/${we}/editable`),
    ok(`/api/infra/environments/${we}/describe`),
    ok(`/api/infra/environments/${we}/changes`),
    hidden(`/api/infra/environments/${ge}/changes`),
    ok(`/api/infra/environments/${we}/templates`),
    ok('/api/infra/changes?repo=widgets&pull=1'),
    ok(`/api/infra/changes/${w.widgets.change}`),
    hidden(`/api/infra/changes/${w.gadgets.change}`),
    ok('/api/infra/desired'),
    ok(`/api/infra/desired/${we}`),
    hidden(`/api/infra/desired/${ge}`),
    ok('/api/infra/policy'),
    ok('/api/infra/policy/view'),
    hidden('/api/infra/policy?repo=gadgets'),
    ok('/api/infra/scaling'),
    ok('/api/infra/currency'),
    install('/api/infra/inventory/refresh'),
    ok('/api/infra/inventory'),
    ok('/api/infra/inventory/some-resource'),
    install('/api/infra/costs'),
    ok('/api/infra/costs?repo=widgets'),
    hidden(`/api/infra/costs?environment=${ge}`),
    ok('/api/infra/locks'),
    ok(`/api/infra/locks/${we}`),
    hidden(`/api/infra/locks/${ge}`),
    ok('/api/infra/runs'),
    ok(`/api/infra/runs/plan-${w.widgets.plan}`),
    hidden(`/api/infra/runs/plan-${w.gadgets.plan}`),
    ok('/api/infra/envelopes'),
    ok(`/api/infra/envelopes/${we}`),
    hidden(`/api/infra/envelopes/${ge}`),
    ok('/api/infra/plans'),
    hidden(`/api/infra/plans?environment=${ge}`),
    ok(`/api/infra/plans/plan-${w.widgets.plan}`),
    hidden(`/api/infra/plans/plan-${w.gadgets.plan}`),
    ok('/api/infra/drift'),
    ok(`/api/infra/drift/${we}`),
    hidden(`/api/infra/drift/${ge}`),
    ok('/api/infra/cleanup'),
    ok('/api/infra/break-glass'),
    ok('/api/infra/tokens'),
    ok('/api/infra/short-lived'),
    ok('/api/infra/runbooks'),
    ok('/api/infra/incidents'),
    ok('/api/infra/incidents/1'),
    ok('/api/infra/signals'),
    hidden(`/api/infra/signals?environmentId=${w.gadgets.env}`),
    ok('/api/infra/signals/days'),
    install('/api/infra/account-alerts'),
    install('/api/infra/alerts'),
    install('/api/infra/audit'),
    ok('/api/infra/audit?repo=widgets'),
    hidden(`/api/infra/audit?environmentId=${w.gadgets.env}`),
    ok('/api/features'),
    ok(`/api/features/${w.mixed}`),
    hidden(`/api/features/${w.gadOnly}`),
    hidden(`/api/features/${w.mixed}/digests/${w.digest}`),
    ok('/api/routines'),
    ok('/api/specs'),
    hidden('/api/specs?repo=gadgets'),
    ok('/api/specs/docs/specs/X-1-x.md'),
    install('/api/oauth/connections'),
    ok('/api/pings'),
    ok('/api/peloton'),
    ok('/api/peloton/widgets'),
    hidden('/api/peloton/gadgets'),
    // A chase's room is free text about every repository it spans: only for someone who sees them all.
    hidden(`/api/peloton/chase:${w.mixed}`),
    hidden(`/api/peloton/chase:${w.mixed}/plan`),
    hidden(`/api/peloton/chase:${w.gadOnly}`),
    ok('/api/peloton/listen?agent=claude-gad-1'),
    ok('/api/peloton/open?agent=claude-gad-1'),
    install('/api/push'),
    ok('/api/agents'),
    ok('/api/agents/prompt'),
    hidden('/api/agents/prompt?repo=gadgets'),
    ok('/api/github/pulls/1'),
    hidden('/api/github/pulls/1?repo=gadgets'),
    ok('/api/github/pulls/1/file?path=README.md'),
    ok('/api/github/workflows'),
    ok('/api/github/packages'),
    ok('/api/tasks'),
    ok('/api/tasks?status=all'),
    ok(`/api/tasks/${t}`),
    hidden(`/api/tasks/${g}`),
    hidden(`/api/tasks/${w.gadget.wid}`),
    ok(`/api/tasks/${t}/messages`),
    ok(`/api/tasks/${t}/messages/waiting?agent=claude-x-1`),
    ok(`/api/tasks/${t}/footprint`),
    ok(`/api/tasks/${t}/risk-review`),
    ok(`/api/tasks/${t}/session`),
    ok(`/api/tasks/${t}/attachments`),
    hidden(`/api/tasks/${g}/attachments`),
    hidden(`/api/tasks/${g}/session`),
    hidden(`/api/attachments/${w.image}`),
    ok('/api/people'),
  ];
}

describe('a viewer of acme/widgets reads every GET route (BRK-323)', () => {
  it('covers every first segment the API routes on', () => {
    const segments = [...new Set([...workerSource.matchAll(/parts\[0\] === '([\w-]+)'/gu)].map((m) => m[1]))];
    const read = new Set(reads().map((r) => r.path.split(/[/?]/u)[2]));
    // Writes only, or the person's own (src/people.js).
    const writes = ['next', 'backfill', 'releases', 'planning', 'horizons', 'admin', 'import', 'session'];
    expect(segments.filter((s) => !read.has(s) && !writes.includes(s))).toEqual([]);
  });

  for (const via of ['cookie', 'token'])
    it(`gets nothing from acme/gadgets with their ${via}, and the install’s own reads are refused`, async () => {
      const credential = via === 'cookie' ? { cookie: w.viewer.cookie } : { token: w.viewer.token };
      const wrong = [];
      for (const { path, want } of reads()) {
        const res = await call(path, credential);
        const text = await res.text();
        // A refusal may say back what was asked (`no task "GAD-1"`), and nothing more.
        const found = leaks(text).filter((needle) => !decodeURIComponent(path).includes(needle));
        if (found.length)
          wrong.push(
            `${path}: leaks ${found.join(', ')} ${text.slice(Math.max(0, text.indexOf(found[0]) - 300), text.indexOf(found[0]) + 100)}`,
          );
        // GitHub answers 404 to everything here, which some routes pass on as a 502, for the owner too.
        if (res.status >= 500 && res.status !== 502) wrong.push(`${path}: ${res.status} ${text.slice(0, 200)}`);
        if (want === 'install' && res.status !== 403) wrong.push(`${path}: ${res.status}, not 403`);
        if (want === 'hidden' && res.status !== 404) wrong.push(`${path}: ${res.status}, not 404`);
        if (want === 'ok' && (res.status === 403 || res.status === 401)) wrong.push(`${path}: ${res.status} ${text}`);
      }
      expect(wrong).toEqual([]);
    }, 120_000);

  it('answers a task in acme/gadgets exactly as one that doesn’t exist', async () => {
    const hiddenOne = await call(`/api/tasks/${w.gadget.wid}`, { cookie: w.viewer.cookie });
    expect(hiddenOne.status).toBe(404);
    expect(await hiddenOne.json()).toEqual({ error: `no task "${w.gadget.wid}"` });
    const plan = await call(`/api/infra/plans/plan-${w.gadgets.plan}`, { cookie: w.viewer.cookie });
    expect(await plan.json()).toEqual({ error: `no plan plan-${w.gadgets.plan}` });
  });

  it('shows the widget task whole, without its link to the gadget', async () => {
    const res = await call(`/api/tasks/${w.widget.uuid}`, { cookie: w.viewer.cookie });
    expect(res.status).toBe(200);
    const { task } = await res.json();
    expect(task.description).toBe('A widget task');
    expect(task.depends).toEqual([]);
    expect(task.dependsOn).toEqual([]);
    expect(task.relatedTasks).toEqual([]);
    const list = await (await call('/api/tasks?status=all', { cookie: w.viewer.cookie })).json();
    expect(list.tasks.some((t) => t.uuid === w.widget.uuid)).toBe(true);
    expect(list.tasks.every((t) => t.repo === 'widgets')).toBe(true);
  });

  it('counts a feature spanning repositories by the parts in theirs', async () => {
    const mine = (await (await call(`/api/features/${w.mixed}`, { cookie: w.viewer.cookie })).json()).feature;
    const all = (await (await owner(`/api/features/${w.mixed}`)).json()).feature;
    expect(all.progress.total).toBe(2);
    expect(mine.progress.total).toBe(1);
    expect(mine.tasks.map((t) => t.uuid)).toEqual([w.widget.uuid]);
    // The board's words about why it waits don't name the gadget.
    expect(leaks(JSON.stringify(mine))).toEqual([]);
    const listed = (await (await call('/api/features', { cookie: w.viewer.cookie })).json()).features;
    expect(listed.find((f) => f.slug === w.mixed).progress.total).toBe(1);
  });

  it('lets someone with the * grant read the install’s own, and everything', async () => {
    const everyone = await person(w.session, unique('eve'), [{ repository: '*', role: 'viewer' }]);
    for (const path of ['/api/health', '/api/connections', '/api/infra/costs', `/api/tasks/${w.gadget.uuid}`])
      expect((await call(path, { cookie: everyone.cookie })).status, path).toBe(200);
    const text = await (await call('/api/tasks', { cookie: everyone.cookie })).text();
    expect(text).toContain(SECRET);
  });

  it('answers a person’s write whole, with what they can’t see taken out', async () => {
    const member = await person(w.session, unique('mia'), [{ repository: 'widgets', role: 'member' }]);
    const res = await call('/api/tasks', {
      method: 'POST',
      cookie: member.cookie,
      // Its words never say gadgets, whatever the random suffix: leaks() checks the answer for that word.
      body: {
        description: unique('Waits on another repository’s task '),
        project: 'product',
        depends: [w.gadget.uuid],
        force: true,
      },
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(leaks(text)).toEqual([]);
    const made = JSON.parse(text).tasks[0];
    expect(made).toMatchObject({ repo: 'widgets', depends: [] });
    expect(made.wid).toMatch(/^PRD-\d+$/u);
  });

  it('shows a person the people they share a repository with, and not the rest', async () => {
    const stranger = await person(w.session, unique('oli'), [{ repository: 'gadgets', role: 'viewer' }]);
    const { people, invites } = await (await call('/api/people', { cookie: w.viewer.cookie })).json();
    const handles = people.map((p) => p.handle);
    expect(handles).toContain(w.viewer.handle);
    expect(handles).not.toContain(stranger.handle);
    expect(invites).toEqual([]);
    // Someone they can't Reset shows without their sign-in counts.
    const other = people.find((p) => p.handle !== w.viewer.handle);
    if (other) expect(other).not.toHaveProperty('sessions');
  });
});

describe('MCP (BRK-323, BRK-327)', () => {
  it('opens to a personal token, and lists tasks only in the person’s repositories (test/mcp-person.test.js has the rest)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${w.viewer.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Breakaway-Agent': 'claude-vic-1',
        'X-Breakaway-Repo': 'widgets',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks' } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(w.widget.uuid);
    expect(leaks(text)).toEqual([]);
  });
});

describe('the owner’s reads, unchanged', () => {
  it('see every repository, as before', async () => {
    const text = await (await owner('/api/tasks?status=all')).text();
    expect(text).toContain(SECRET);
    const task = (await (await owner(`/api/tasks/${w.widget.uuid}`)).json()).task;
    expect(task.depends).toEqual([w.gadget.uuid]);
    expect((await owner('/api/connections')).status).toBe(200);
  });
});
