import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHED, describeOutage, readGitHubStatus } from '../src/github-status.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const PAGE = 'https://status.acme.example';

/** A Statuspage summary with every watched component working, and Copilot as one the board doesn't watch. */
function summary({ components = {}, incidents = [] } = {}) {
  return {
    page: { name: 'GitHub' },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [...WATCHED, 'Copilot'].map((name) => ({ name, status: components[name] ?? 'operational' })),
    incidents,
  };
}
const incident = (name, extra = {}) => ({
  name,
  status: 'investigating',
  impact: 'minor',
  shortlink: 'https://stspg.io/abc123',
  created_at: '2026-10-05T19:50:00Z',
  components: [],
  ...extra,
});

/** The pretend status page and routine; each test changes what the page answers. */
const status = { answer: summary(), code: 200, reads: 0 };
const fires = [];
function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === `${PAGE}/api/v2/summary.json`) {
      status.reads += 1;
      return new Response(JSON.stringify(status.answer), { status: status.code });
    }
    if (url === FIRE) {
      fires.push(JSON.parse(init.body).text);
      const id = `session_s${String(fires.length).padStart(3, '0')}`;
      return Response.json({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    return new Response('{"message":"Not Found"}', { status: 404 }); // GitHub, during alarms
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (s) => fn(s));
/** Points the store at the pretend page (the test config turns the status page off) for `fn`. */
const withPage = (fn) =>
  inStore(async (s) => {
    const saved = s.env.TASKS_GITHUB_STATUS;
    s.env.TASKS_GITHUB_STATUS = PAGE;
    try {
      return await fn(s);
    } finally {
      s.env.TASKS_GITHUB_STATUS = saved;
    }
  });
/** Reads the page now, as Check now does. */
const check = () => withPage((s) => s.githubStatusCheck({ force: true }));

describe('reading GitHub’s status page', () => {
  it('finds nothing wrong when every watched component works and no incident touches one', () => {
    const read = readGitHubStatus(
      summary({
        components: { Copilot: 'major_outage' },
        incidents: [
          incident('Copilot is slow', { components: [{ name: 'Copilot' }] }),
          incident('Fixed already', { status: 'resolved' }),
        ],
      }),
    );
    expect(read.disrupted).toBe(false);
    expect(read.components.map((c) => c.name)).toEqual(WATCHED);
    expect(read.incidents).toEqual([]);
  });

  it('names each watched component that isn’t working and each incident that touches one', () => {
    const read = readGitHubStatus(
      summary({
        components: { Actions: 'partial_outage', 'Pull Requests': 'degraded_performance' },
        incidents: [incident('Disruption with some GitHub services', { components: [{ name: 'Actions' }] })],
      }),
    );
    expect(read.disrupted).toBe(true);
    expect(read.affected.map((c) => [c.name, c.words])).toEqual([
      ['Pull Requests', 'degraded performance'],
      ['Actions', 'partial outage'],
    ]);
    expect(read.incidents).toEqual([
      {
        name: 'Disruption with some GitHub services',
        status: 'investigating',
        impact: 'minor',
        url: 'https://stspg.io/abc123',
        started: '2026-10-05T19:50:00Z',
        components: ['Actions'],
      },
    ]);
    expect(describeOutage(read)).toBe(
      'Pull Requests: degraded performance, Actions: partial outage; incident “Disruption with some GitHub services”',
    );
  });

  it('counts an incident that names no component yet, unless it has no impact', () => {
    expect(readGitHubStatus(summary({ incidents: [incident('Investigating reports')] })).disrupted).toBe(true);
    expect(readGitHubStatus(summary({ incidents: [incident('A notice', { impact: 'none' })] })).disrupted).toBe(false);
  });

  it('refuses an answer that isn’t a status summary', () => {
    expect(() => readGitHubStatus({ message: 'rate limited' })).toThrow(/no components/u);
    expect(() => readGitHubStatus(null)).toThrow(/no components/u);
  });
});

describe('the board watching GitHub’s status page', () => {
  let spy;
  beforeEach(() => {
    spy = mockFetch();
    Object.assign(status, { answer: summary(), code: 200 });
  });
  afterEach(() => spy.mockRestore());

  it('reads nothing while the install has it off, or GitHub isn’t connected', async () => {
    status.reads = 0;
    expect(await inStore((s) => s.githubStatusCheck({ force: true }))).toBeNull();
    expect(await inStore((s) => s.githubStatusView())).toBeNull();
    expect(
      await withPage(async (s) => {
        const saved = s.env.TASKS_GITHUB_APP_ID;
        s.env.TASKS_GITHUB_APP_ID = 'unset';
        try {
          return await s.githubStatusCheck({ force: true });
        } finally {
          s.env.TASKS_GITHUB_APP_ID = saved;
        }
      }),
    ).toBeNull();
    expect(status.reads).toBe(0);
  });

  it('reads the page at most every five minutes, unless Check now asks', async () => {
    status.reads = 0;
    expect(await check()).toMatchObject({ disrupted: false, error: null });
    await withPage((s) => s.githubStatusCheck());
    expect(status.reads).toBe(1);
    await check();
    expect(status.reads).toBe(2);
    expect(await withPage((s) => s.githubStatusConnection())).toEqual([
      expect.objectContaining({
        id: 'github.status',
        group: 'github',
        state: 'working',
        detail: `${WATCHED.join(', ')} working, as status.acme.example says`,
      }),
    ]);
  });

  it('holds while a watched part of GitHub is down, and says so on Connections and the GitHub view', async () => {
    status.answer = summary({
      components: { Actions: 'major_outage' },
      incidents: [incident('Actions runs are delayed', { components: [{ name: 'Actions' }] })],
    });
    await check();
    const [row] = await withPage((s) => s.githubStatusConnection());
    expect(row).toMatchObject({ id: 'github.status', state: 'attention', link: 'https://stspg.io/abc123' });
    expect(row.detail).toMatch(/^Actions: major outage; incident “Actions runs are delayed”, since /u);
    expect(row.fix).toMatch(/carry on by themselves/u);
    const view = await withPage((s) => s.githubStatusView());
    expect(view).toMatchObject({ held: true, summary: 'Actions: major outage; incident “Actions runs are delayed”' });
    const overview = await withPage(async (s) => (await s.githubOverview()).body);
    expect(overview.githubStatus).toMatchObject({ held: true, page: PAGE });
  });

  it('keeps the last reading when the page can’t be read, and stops holding once it’s old', async () => {
    const since = (await withPage((s) => s.githubStatusView())).since;
    status.code = 503;
    await check();
    const view = await withPage((s) => s.githubStatusView());
    expect(view).toMatchObject({ held: true, since, error: 'it answered 503' });
    // Half an hour without a reading: the board stops waiting on a page that's gone quiet.
    await withPage((s) => {
      const kept = JSON.parse(s.meta('gh_status'));
      s.setMeta('gh_status', JSON.stringify({ ...kept, at: Date.now() - 31 * 60_000 }));
    });
    expect(await withPage((s) => s.githubOutage())).toBeNull();
    const [row] = await withPage((s) => s.githubStatusConnection());
    expect(row).toMatchObject({ state: 'attention' });
    expect(row.detail).toMatch(/^couldn’t read status\.acme\.example: it answered 503; nothing waits on it/u);
  });

  it('refuses the pull request settings’ writes while GitHub is down, but not the owner’s own', async () => {
    status.answer = summary({ components: { 'Pull Requests': 'partial_outage' } });
    await check();
    const held = await withPage((s) => s.githubWrite(7, 'update-branch', { sha: 'abc1234', setting: true }));
    expect(held.status).toBe(503);
    expect(held.body).toMatchObject({ held: true });
    expect(held.body.error).toMatch(/^GitHub reports trouble \(Pull Requests: partial outage\): Keep branches/u);
    // The owner's press goes on to GitHub (here a pretend one that knows no pull request 7).
    const own = await withPage((s) => s.githubWrite(7, 'update-branch', { sha: 'abc1234' }));
    expect(own.body.held).toBeUndefined();
  });

  it('lets the owner treat GitHub as working while an incident stays open, until the page reports something new', async () => {
    const stuck = incident('Actions runs are delayed', { status: 'monitoring', components: [{ name: 'Actions' }] });
    status.answer = summary({ components: { Actions: 'degraded_performance' }, incidents: [stuck] });
    await check();
    expect(await withPage((s) => s.githubHold())).toMatch(/^GitHub reports trouble/u);
    const [held] = await withPage((s) => s.githubStatusConnection());
    expect(held).toMatchObject({ state: 'attention', override: { on: false } });

    await withPage((s) => s.githubStatusOverride({ on: true }));
    expect(await withPage((s) => s.githubHold())).toBeNull();
    const view = await withPage((s) => s.githubStatusView());
    expect(view).toMatchObject({ held: false, overridden: { at: expect.any(String) } });
    expect(view.summary).toMatch(/^Actions: degraded performance/u);
    const [row] = await withPage((s) => s.githubStatusConnection());
    expect(row).toMatchObject({ id: 'github.status', state: 'working', override: { on: true } });
    expect(row.detail).toMatch(
      /^Actions: degraded performance; incident “Actions runs are delayed”, but you marked it working/u,
    );

    // The same outage read again stays overridden.
    await check();
    expect(await withPage((s) => s.githubHold())).toBeNull();

    // Something new on the page holds again: a component's status changes, or a new incident opens.
    status.answer = summary({ components: { Actions: 'major_outage' }, incidents: [stuck] });
    await check();
    expect(await withPage((s) => s.githubHold())).toMatch(/Actions: major outage/u);
    expect((await withPage((s) => s.githubStatusView())).overridden).toBeNull();

    // The owner can undo it, and it's cleared once the page says it's working.
    await withPage((s) => s.githubStatusOverride({ on: true }));
    expect(await withPage((s) => s.githubHold())).toBeNull();
    await withPage((s) => s.githubStatusOverride({ on: false }));
    expect(await withPage((s) => s.githubHold())).toMatch(/Actions: major outage/u);
    await withPage((s) => s.githubStatusOverride({ on: true }));
    status.answer = summary();
    await check();
    expect(await withPage((s) => s.meta('gh_status_override'))).toBeNull();
    status.answer = summary({ components: { Actions: 'major_outage' }, incidents: [stuck] });
    await check();
    expect(await withPage((s) => s.githubHold())).toMatch(/Actions: major outage/u);
  });

  it('refuses an override while nothing is held', async () => {
    status.answer = summary();
    await check();
    await expect(withPage((s) => s.githubStatusOverride({ on: true }))).rejects.toThrow(/isn’t holding anything/u);
  });

  it('only takes an override from the signed-in web board', async () => {
    const res = await api('connections/github-status/override', { method: 'POST', body: { on: true } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/signed-in web board/u);
  });

  it('starts nothing in a chase while GitHub is down, and carries on once it works again', async () => {
    status.answer = summary({ components: { 'Git Operations': 'major_outage' } });
    await check();
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: 'Ops one', project: 'ops', tags: ['agent', 'calm'], horizon: 'now' }],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1']);
    expect((await api('features', { method: 'POST', body: { slug: 'calm' } })).status).toBe(201);
    const pressed = await withPage(async (s) => s.chaseFeature('calm', { on: true }));
    expect(pressed.started).toEqual([]);
    expect(pressed.chase).toMatchObject({ on: true, held: 'GitHub reports trouble (Git Operations: major outage)' });
    expect(fires).toEqual([]);
    status.answer = summary();
    await check();
    expect(await withPage((s) => s.chaseTick())).toEqual(['OPS-1']);
    expect(fires).toHaveLength(1);
    expect((await withPage((s) => s.featureWithChase('calm'))).chase.held).toBeUndefined();
  });
});
