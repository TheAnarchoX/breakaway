import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_WATCHED, readClaudeStatus } from '../src/claude-status.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const PAGE = 'https://status.claude.example';

/** A Statuspage summary with every watched component working, and the Console as one the board doesn't watch. */
function summary({ components = {}, incidents = [] } = {}) {
  return {
    page: { name: 'Claude' },
    components: [...CLAUDE_WATCHED, 'Claude Console (platform.claude.com)'].map((name) => ({
      name,
      status: components[name] ?? 'operational',
    })),
    incidents,
  };
}
const incident = (name, extra = {}) => ({
  name,
  status: 'investigating',
  impact: 'major',
  shortlink: 'https://stspg.io/def456',
  created_at: '2026-10-09T10:00:00Z',
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
      const id = `session_c${String(fires.length).padStart(3, '0')}`;
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
    const saved = s.env.TASKS_CLAUDE_STATUS;
    s.env.TASKS_CLAUDE_STATUS = PAGE;
    try {
      return await fn(s);
    } finally {
      s.env.TASKS_CLAUDE_STATUS = saved;
    }
  });
/** Reads the page now, as Check now does. */
const check = () => withPage((s) => s.claudeStatusCheck({ force: true }));

describe('reading Claude’s status page', () => {
  it('watches the parts agents run on, not the Console', () => {
    const read = readClaudeStatus(
      summary({
        components: { 'Claude Console (platform.claude.com)': 'major_outage' },
        incidents: [
          incident('Elevated errors on platform.claude.com', {
            components: [{ name: 'Claude Console (platform.claude.com)' }],
          }),
        ],
      }),
    );
    expect(read.disrupted).toBe(false);
    expect(read.components.map((c) => c.name)).toEqual(CLAUDE_WATCHED);
  });

  it('names Claude Code when it’s down, and an incident that touches it', () => {
    const read = readClaudeStatus(
      summary({
        components: { 'Claude Code': 'partial_outage' },
        incidents: [incident('Sessions fail to start', { components: [{ name: 'Claude Code' }] })],
      }),
    );
    expect(read.disrupted).toBe(true);
    expect(read.affected.map((c) => [c.name, c.words])).toEqual([['Claude Code', 'partial outage']]);
    expect(read.incidents.map((i) => i.name)).toEqual(['Sessions fail to start']);
  });
});

describe('the board watching Claude’s status page', () => {
  let spy;
  beforeEach(() => {
    spy = mockFetch();
    Object.assign(status, { answer: summary(), code: 200 });
  });
  afterEach(() => spy.mockRestore());

  it('reads nothing while the install has it off, or no routine is connected', async () => {
    status.reads = 0;
    expect(await inStore((s) => s.claudeStatusCheck({ force: true }))).toBeNull();
    expect(await inStore((s) => s.claudeStatusView())).toBeNull();
    expect(
      await withPage(async (s) => {
        const saved = s.connectedRepos;
        s.connectedRepos = async () => new Set();
        try {
          return [await s.claudeStatusCheck({ force: true }), await s.claudeStatusConnection()];
        } finally {
          s.connectedRepos = saved;
        }
      }),
    ).toEqual([null, []]);
    expect(status.reads).toBe(0);
  });

  it('reads the page at most every five minutes, unless Check now asks, and shows it on Connections', async () => {
    status.reads = 0;
    expect(await check()).toMatchObject({ disrupted: false, error: null });
    await withPage((s) => s.claudeStatusCheck());
    expect(status.reads).toBe(1);
    expect(await withPage((s) => s.claudeStatusConnection())).toEqual([
      expect.objectContaining({
        id: 'claude.status',
        group: 'claude',
        state: 'working',
        detail: `${CLAUDE_WATCHED.join(', ')} working, as status.claude.example says`,
      }),
    ]);
  });

  it('holds while a watched part of Claude is down, and says so on Connections', async () => {
    status.answer = summary({
      components: { 'Claude Code': 'major_outage' },
      incidents: [incident('Sessions fail to start', { components: [{ name: 'Claude Code' }] })],
    });
    await check();
    const [row] = await withPage((s) => s.claudeStatusConnection());
    expect(row).toMatchObject({ id: 'claude.status', state: 'attention', link: 'https://stspg.io/def456' });
    expect(row.detail).toMatch(
      /^Claude Code: major outage; incident “Sessions fail to start”, since .+\. Chases start no new agents$/u,
    );
    expect(row.fix).toMatch(/start agents again by themselves/u);
    expect(await withPage((s) => s.claudeHold())).toBe(
      'Claude reports trouble (Claude Code: major outage; incident “Sessions fail to start”)',
    );
    const report = await withPage((s) => s.connectionsReport());
    const all = report.connections ?? report;
    expect(all.find((c) => c.id === 'claude.status')).toMatchObject({ state: 'attention' });
  });

  it('keeps the last reading when the page can’t be read, and stops holding once it’s old', async () => {
    status.code = 503;
    await check();
    expect(await withPage((s) => s.claudeStatusView())).toMatchObject({ held: true, error: 'it answered 503' });
    await withPage((s) => {
      const kept = JSON.parse(s.meta('claude_status'));
      s.setMeta('claude_status', JSON.stringify({ ...kept, at: Date.now() - 31 * 60_000 }));
    });
    expect(await withPage((s) => s.claudeOutage())).toBeNull();
    const [row] = await withPage((s) => s.claudeStatusConnection());
    expect(row.detail).toMatch(/^couldn’t read status\.claude\.example: it answered 503; nothing waits on it/u);
    Object.assign(status, { answer: summary(), code: 200 });
    await check();
  });

  it('starts nothing in a chase while Claude is down, and carries on once it works again', async () => {
    status.answer = summary({ components: { 'Claude API (api.anthropic.com)': 'major_outage' } });
    await check();
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: 'Ops one', project: 'ops', tags: ['agent', 'calm'], horizon: 'now' }],
      }),
    );
    const [wid] = res.tasks.map((t) => t.wid);
    expect((await api('features', { method: 'POST', body: { slug: 'calm' } })).status).toBe(201);
    const pressed = await withPage(async (s) => s.chaseFeature('calm', { on: true }));
    expect(pressed.started).toEqual([]);
    expect(pressed.chase).toMatchObject({
      on: true,
      held: 'Claude reports trouble (Claude API (api.anthropic.com): major outage)',
    });
    expect(fires).toEqual([]);
    status.answer = summary();
    await check();
    expect(await withPage((s) => s.chaseTick())).toEqual([wid]);
    expect(fires).toHaveLength(1);
    expect((await withPage((s) => s.featureWithChase('calm'))).chase.held).toBeUndefined();
  });

  it('tells a running chase’s agents what to do once per outage, and when it’s over, which work wasn’t pushed', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Ride one', project: 'ops', tags: ['agent', 'storm'], horizon: 'now' },
          { description: 'Ride two', project: 'ops', tags: ['agent', 'storm'], horizon: 'now' },
        ],
      }),
    );
    const [one, two] = res.tasks.map((t) => t.wid);
    expect((await api('features', { method: 'POST', body: { slug: 'storm' } })).status).toBe(201);
    await withPage((s) => s.chaseFeature('storm', { on: true }));
    const lines = () =>
      inStore((s) => s.pelotonPosts('chase:storm').filter((p) => p.agent === 'board' && p.kind !== 'open'));
    expect(await lines()).toEqual([]);

    status.answer = summary({ components: { 'Claude Code': 'major_outage' } });
    await check();
    await check();
    let posts = await lines();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'outage' });
    expect(posts[0].text).toMatch(/^Claude is down \(Claude Code: major outage\)\. Your session may end/u);
    expect(posts[0].text).toMatch(/Not pushed: <branch>/u);

    // An agent riding the chase gets it as urgently as the owner's post.
    const rider = await inStore((s) => s.tasks.get(s.resolve(one)).claim);
    expect(rider).toBeTruthy();
    const heard = await inStore((s) => s.takePeloton(rider, { urgent: true }));
    expect(heard.posts.find((p) => p.kind === 'outage')).toMatchObject({ agent: 'board', urgent: true });

    // The page going quiet says nothing either way.
    status.code = 503;
    await check();
    expect(await lines()).toHaveLength(1);

    await api(`tasks/${one}/annotate`, {
      method: 'POST',
      body: { text: 'Not pushed: claude/storm-1, the last commit' },
    });
    await api(`tasks/${two}/annotate`, { method: 'POST', body: { text: 'Pushed everything' } });
    Object.assign(status, { answer: summary(), code: 200 });
    await check();
    await check();
    posts = await lines();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ kind: 'clear' });
    expect(posts[1].text).toBe(
      `Claude works again: sessions can start, and the chase carries on. Work that wasn’t pushed: ${one}. Whoever picks one up, read its Not pushed comment first.`,
    );
  });
});
