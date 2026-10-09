import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// The road captain is the board's (docs/specs/BRK-275-road-captain.md): one per chase, started with it, shown on the
// feature, limited to its chase, and handed over on a clock or when it says so, with a log the next one reads.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];
let next = 1;

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const chase = async (slug, input = {}) => body(await api(`features/${slug}/chase`, { method: 'POST', body: input }));
const feature = async (slug) => (await body(await api(`features/${slug}`))).feature;
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const modify = async (ref, input) => body(await api(`tasks/${ref}`, { method: 'PATCH', body: input }));
const captainLog = async (slug, input) => body(await api(`features/${slug}/captain`, { method: 'POST', body: input }));
const tick = () => runInDurableObject(stub(), (instance) => instance.chaseTick());
const captainFires = () => fires.filter((text) => text.includes('Mode: captain'));
const sql = (query, ...args) => runInDurableObject(stub(), (instance) => instance.sql.exec(query, ...args).toArray());

describe('the road captain (BRK-275)', () => {
  let spy;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === FIRE) {
        fires.push(JSON.parse(init.body).text);
        const id = `session_c${String(next++).padStart(3, '0')}`;
        return Response.json({
          type: 'routine_fire',
          claude_code_session_id: id,
          claude_code_session_url: `https://claude.ai/code/${id}`,
        });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    });
    // Eleven tasks in Crew, each waiting on the one before, so the chase starts one at a time; two in Duo; one alone.
    const items = Array.from({ length: 11 }, (_, i) => ({
      description: `Crew ${i + 1}`,
      project: 'ops',
      tags: ['agent', 'crew'],
      horizon: 'now',
      ...(i ? { depends: [`OPS-${i}`] } : {}),
    }));
    items.push(
      { description: 'Duo one', project: 'product', tags: ['agent', 'duo'], horizon: 'now' },
      { description: 'Duo two', project: 'product', tags: ['agent', 'duo'], horizon: 'now', depends: ['PRD-1'] },
      { description: 'Alone', project: 'ops', tags: ['agent'], horizon: 'later' },
    );
    const res = await body(await api('tasks', { method: 'POST', body: items }));
    expect(res).toMatchObject({ status: 201 });
    for (const slug of ['crew', 'duo'])
      expect((await api('features', { method: 'POST', body: { slug } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } });
  });
  afterAll(() => spy.mockRestore());

  it('is on by default for a chase of more than 10 tasks, and the dry run says so', async () => {
    expect((await chase('crew', { on: true, dryRun: true })).captain).toBe(true);
    expect((await chase('duo', { on: true, dryRun: true })).captain).toBe(false);
    expect((await chase('duo', { on: true, dryRun: true, captain: true })).captain).toBe(true);
    expect((await chase('crew', { on: true, captain: 'yes' })).status).toBe(400);
    expect((await chase('crew', { on: true, captainHours: 0 })).status).toBe(400);
    expect((await chase('crew', { on: true, captainHours: 73 })).status).toBe(400);
    expect((await chase('crew', { on: true, captain: true, by: 'claude-x-1' })).status).toBe(403);
  });

  it('starts with the chase, on a task of its own, in Mode: captain, force started', async () => {
    const res = await chase('crew', { on: true, captainHours: 6 });
    expect(res.status).toBe(200);
    expect(res.started).toEqual(['OPS-1']);
    expect(captainFires()).toHaveLength(1);
    const text = captainFires()[0];
    expect(text).toContain('Agent name: claude-captain-crew-1');
    expect(text).toContain('Mode: captain\nChase: crew');
    expect(text).toContain('Started: by the board, as the road captain of a chase');
    expect(text).toContain('Title: Road captain for Crew');
    expect(text).not.toContain('Note from the owner');

    const { captain } = res.chase;
    expect(captain).toMatchObject({ on: true, hours: 6, agent: 'claude-captain-crew-1', log: [] });
    expect(Date.parse(captain.watchEndsAt) - Date.parse(captain.since)).toBe(6 * 3_600_000);
    const t = await task(captain.task.uuid);
    expect(t.tags).toEqual(expect.arrayContaining(['agent', 'captain', 'crew']));
    expect(t.tags).not.toContain('general');
    expect(t.brief).toMatch(/^You're the road captain of the chase on Crew \(\+crew\)/);
    expect(t.brief).toContain('1 running');
    const { events } = await body(await api('activity'));
    expect(events.flatMap((e) => e.changes).find((c) => c.trigger === 'road-captain')).toMatchObject({
      forced: true,
    });
  });

  it('isn’t the chase’s work: not in its tasks, its progress, or Start next, but on its riders', async () => {
    const f = await feature('crew');
    expect(f.progress.total).toBe(11);
    expect(f.chase.tasks).toHaveLength(11);
    expect(f.chase.tasks.some((x) => x.description.startsWith('Road captain'))).toBe(false);
    expect(f.riders.map((r) => r.agent)).toContain('claude-captain-crew-1');
    // Nothing more starts on a tick: the captain holds its task, and the rest wait on OPS-1.
    await tick();
    expect(captainFires()).toHaveLength(1);
    const dry = await body(await api('agents/next', { method: 'POST', body: { count: 5, dryRun: true } }));
    expect([...dry.started, ...dry.skipped].some((x) => x.description?.startsWith('Road captain'))).toBe(false);
  });

  it('answers @captain on the chase’s peloton', async () => {
    await runInDurableObject(stub(), (instance) => {
      expect(instance.ridersOf('chase:crew').captain).toBe('claude-captain-crew-1');
      expect(instance.mentionsIn('chase:crew', 'what next, @captain?')).toEqual(['claude-captain-crew-1']);
    });
  });

  it('changes its chase’s tasks as a chase agent does, and nothing outside it', async () => {
    const by = 'claude-captain-crew-1';
    const inside = await modify('OPS-5', { brief: 'Split from the plan', by });
    expect(inside.status).toBe(200);
    expect((await task('OPS-5')).brief).toBe('Split from the plan');
    const outside = await modify('OPS-12', { brief: 'Not the captain’s', by });
    expect(outside.status).toBe(403);
    // Another chase's task is outside it too.
    expect((await modify('PRD-1', { done_when: 'It works', by })).status).toBe(403);
  });

  it('writes its log, which only it may, and the log shows on the feature', async () => {
    expect((await captainLog('crew', { log: 'Mine now', by: 'claude-ops-1' })).status).toBe(403);
    expect((await captainLog('crew', { log: '   ', by: 'claude-captain-crew-1' })).status).toBe(400);
    expect((await captainLog('crew', { log: 'x'.repeat(8001), by: 'claude-captain-crew-1' })).status).toBe(400);
    expect((await captainLog('crew', { log: `Token ghp_${'a'.repeat(36)}`, by: 'claude-captain-crew-1' })).status).toBe(
      400,
    );
    const res = await captainLog('crew', { log: 'OPS-1 is nearly done. OPS-5 split.', by: 'claude-captain-crew-1' });
    expect(res).toMatchObject({
      status: 200,
      log: { agent: 'claude-captain-crew-1', handover: false },
      successor: null,
    });
    expect((await feature('crew')).chase.captain.log).toEqual([
      expect.objectContaining({ text: 'OPS-1 is nearly done. OPS-5 split.', handover: false }),
    ]);
  });

  it('hands over when it says so: the board starts the next captain, which reads the log and the plan', async () => {
    await runInDurableObject(stub(), (instance) =>
      instance.revisePlan('chase:crew', { text: 'OPS in order.', why: 'First plan' }, { owner: true }),
    );
    const res = await captainLog('crew', {
      log: 'Handing over: OPS-1 in review next.',
      handover: true,
      by: 'claude-captain-crew-1',
    });
    expect(res).toMatchObject({ status: 200, successor: { agent: 'claude-captain-crew-2' } });
    expect(captainFires()).toHaveLength(2);
    const text = captainFires()[1];
    expect(text).toContain('Agent name: claude-captain-crew-2');
    expect(text).toContain('The chase’s plan (chase:crew, version 1):\nOPS in order.');
    expect(text).toMatch(
      /The last road captain’s log \(claude-captain-crew-1, [^)]+\):\nHanding over: OPS-1 in review next\.$/,
    );
    const t = await task(res.successor.task);
    expect(t.claim).toBe('claude-captain-crew-2');
    expect(t.comments.map((c) => c.text)).toContain('claude-captain-crew-1 handed over.');
    // The one before has no rights left.
    expect((await modify('OPS-6', { brief: 'Late', by: 'claude-captain-crew-1' })).status).toBe(403);
  });

  it('is asked once on the peloton when its watch is over, and the board hands over 30 minutes later', async () => {
    await sql(
      "UPDATE agent_runs SET started = started - ? WHERE agent = 'claude-captain-crew-2'",
      6 * 3_600_000 + 1000,
    );
    await tick();
    const asks = () =>
      sql(
        "SELECT * FROM peloton_posts WHERE peloton = 'chase:crew' AND agent = 'board' AND text LIKE '@claude-captain%'",
      );
    expect(await asks()).toHaveLength(1);
    expect((await asks())[0]).toMatchObject({ mentions: '["claude-captain-crew-2"]' });
    expect((await asks())[0].text).toMatch(/6-hour watch as road captain is over/);
    await tick();
    expect(await asks()).toHaveLength(1);
    expect(captainFires()).toHaveLength(2);
    expect((await feature('crew')).chase.captain.askedAt).not.toBeNull();

    await sql("UPDATE features SET chase_captain_asked = chase_captain_asked - ? WHERE slug = 'crew'", 31 * 60_000);
    await tick();
    expect(captainFires()).toHaveLength(3);
    expect(captainFires()[2]).toContain('Agent name: claude-captain-crew-3');
    expect(captainFires()[2]).toMatch(
      /The last road captain’s log \(board, [^)]+\):\nclaude-captain-crew-2 didn’t hand over/,
    );
    const { captain } = (await feature('crew')).chase;
    expect(captain).toMatchObject({ agent: 'claude-captain-crew-3', askedAt: null });
    expect(captain.log[0]).toMatchObject({ agent: 'board', handover: true });
  });

  it('comes back when one lets go, at most once every 15 minutes', async () => {
    const { captain } = (await feature('crew')).chase;
    await body(
      await api(`tasks/${captain.task.uuid}/release`, { method: 'POST', body: { agent: 'claude-captain-crew-3' } }),
    );
    expect((await task(captain.task.uuid)).status).toBe('pending');
    await tick();
    expect(captainFires()).toHaveLength(3);
    await sql("UPDATE agent_runs SET started = started - ? WHERE agent = 'claude-captain-crew-3'", 16 * 60_000);
    await tick();
    expect(captainFires()).toHaveLength(4);
    expect(captainFires()[3]).toContain('Agent name: claude-captain-crew-4');
  });

  it('isn’t started twice: the owner’s Start a road captain messages the one there instead', async () => {
    const res = await body(await api('agents/general', { method: 'POST', body: { chase: 'crew', prompt: 'Look' } }));
    expect(res).toMatchObject({
      status: 409,
      error: expect.stringMatching(/claude-captain-crew-4 is the road captain/),
    });
  });

  it('stands down when the owner turns it off, and when the chase stops', async () => {
    const before = (await feature('crew')).chase.captain.task.uuid;
    const off = await chase('crew', { captain: false });
    expect(off.chase.captain).toMatchObject({ on: false, agent: null, task: null });
    const t = await task(before);
    expect(t.status).toBe('completed');
    expect(t.comments.at(-1).text).toBe('The owner turned the road captain off: it stands down.');
    await tick();
    expect(captainFires()).toHaveLength(4);

    // On again: a fresh task, the chase's fifth captain.
    const on = await chase('crew', { captain: true });
    expect(on.chase.captain.agent).toBe('claude-captain-crew-5');
    expect(on.chase.captain.task.uuid).not.toBe(before);
    const again = on.chase.captain.task.uuid;
    await chase('crew', { on: false });
    expect((await task(again)).status).toBe('completed');
    expect((await feature('crew')).chase.captain).toMatchObject({ on: true, task: null, agent: null });
  });

  it('starts from the owner’s Start a road captain on a chase without one, with their prompt as its note', async () => {
    const started = await chase('duo', { on: true });
    expect(started.chase.captain.on).toBe(false);
    expect(captainFires()).toHaveLength(5);
    const res = await body(
      await api('agents/general', { method: 'POST', body: { chase: 'duo', prompt: 'Watch PRD-1’s review.' } }),
    );
    expect(res.status).toBe(201);
    expect(res.run.agent).toBe('claude-captain-duo-1');
    expect(captainFires().at(-1)).toContain('Note from the owner:\nWatch PRD-1’s review.');
    expect((await feature('duo')).chase.captain).toMatchObject({ on: true, agent: 'claude-captain-duo-1' });
    // A note is optional now: the board writes the prompt.
    expect((await body(await api('agents/general', { method: 'POST', body: { chase: 'duo' } }))).status).toBe(409);
  });
});
