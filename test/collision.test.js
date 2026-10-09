import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];
let next = 1;

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      fires.push(JSON.parse(init.body).text);
      const id = `session_${String(next++).padStart(4, '0')}`;
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
const inStore = (fn) => runInDurableObject(stub(), fn);
const add = async (items) => (await body(await api('tasks', { method: 'POST', body: items }))).tasks.map((t) => t.wid);
const task = (description, project, brief, extra = {}) => ({
  description,
  project,
  tags: ['agent'],
  horizon: 'now',
  force: true,
  ...(brief ? { brief } : {}),
  ...extra,
});
const settings = (input) => api('agents/settings', { method: 'PATCH', body: input });
const nextPlan = async (input = {}) =>
  body(await api('agents/next', { method: 'POST', body: { count: 6, dryRun: true, ...input } }));
const reasons = (plan) => Object.fromEntries(plan.skipped.map((s) => [s.wid, s.reason]));
const release = (wid) =>
  api(`tasks/${wid}/release`, { method: 'POST', body: { agent: `claude-${wid.toLowerCase()}` } });

describe('every starter schedules by footprints (IDEA-55, section 3)', () => {
  let spy;
  beforeAll(async () => {
    expect((await settings({ plan: 'max5', max: 12, hourly: 30 })).status).toBe(200);
  });
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('has Agents per area, 3 by default, from 1 to the agents at once', async () => {
    const res = await body(await api('agents'));
    expect(res.settings.perArea).toBe(3);
    expect((await settings({ perArea: 0 })).status).toBe(400);
    expect((await settings({ perArea: 13 })).status).toBe(400);
    expect((await body(await settings({ perArea: 2 }))).settings.perArea).toBe(2);
    expect((await body(await settings({ perArea: 3 }))).settings.perArea).toBe(3);
  });

  it('agents next: disjoint footprints in one area start together, a shared file waits, an unknown one keeps one per area', async () => {
    const [a, b, c, d] = await add([
      task('Mend the alpha', 'ops', 'Change src/alpha.js.'),
      task('Mend the beta', 'ops', 'Change src/beta.js.'),
      task('Mend the alpha again', 'ops', 'Also in src/alpha.js.'),
      task('Something vague', 'ops'),
    ]);
    const plan = await nextPlan();
    expect(plan.started.map((t) => t.wid)).toEqual([a, b]);
    expect(reasons(plan)[c]).toBe(`it would touch src/alpha.js, which ${a} starts on now`);
    expect(plan.skipped.find((s) => s.wid === c).footprint).toEqual({ task: a, agent: null, path: 'src/alpha.js' });
    // Its footprint is unknown, so the old rule holds: one task per area.
    expect(reasons(plan)[d]).toMatch(/one Operations task at a time/);

    const run = await body(await api('agents/next', { method: 'POST', body: { count: 2 } }));
    expect(run.started.map((t) => t.wid)).toEqual([a, b]);
    const after = await nextPlan();
    expect(reasons(after)[c]).toBe(`it would touch src/alpha.js, which ${a} is changing (claude-${a.toLowerCase()})`);
    expect(reasons(after)[d]).toMatch(new RegExp(`already working in Operations \\((${a}|${b})\\)`));
  });

  it('agents next: Agents per area caps an area even when footprints are apart, and 1 is the old rule', async () => {
    const [e] = await add([task('Mend the gamma', 'ops', 'Change src/gamma.js.')]);
    expect((await nextPlan()).started.map((t) => t.wid)).toEqual([e]);
    await settings({ perArea: 2 });
    expect(reasons(await nextPlan())[e]).toBe('2 agents already work in Operations, the most Agents per area allows');
    await settings({ perArea: 1 });
    expect(reasons(await nextPlan())[e]).toMatch(/agents already work in Operations, the most Agents per area allows/);
    await settings({ perArea: 3 });
  });

  it('the owner’s Start warns about an overlap and starts on a second press', async () => {
    const plan = await nextPlan();
    const c = plan.skipped.find((s) => s.footprint)?.wid;
    expect(c).toBeTruthy();
    const warned = await body(await api('agents/start', { method: 'POST', body: { ref: c } }));
    expect(warned.status).toBe(409);
    expect(warned).toMatchObject({ anyway: true, overlap: { path: 'src/alpha.js' } });
    expect(warned.error).toMatch(/is changing src\/alpha\.js, which .* would touch too/);
    const before = fires.length;
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: c, anyway: true } }));
    expect(started.status).toBe(200);
    expect(fires).toHaveLength(before + 1);
    // Clear Operations for what follows.
    for (const s of (await body(await api('agents'))).running) await release(s.task?.wid ?? s.wid);
  });

  it('auto-start: the same rule, with the reasons in its queue', async () => {
    const [a, b, c, d] = await add([
      task('Draw the left panel', 'debt', 'Change web/left.jsx.', { autostart: 'yes' }),
      task('Draw the right panel', 'debt', 'Change web/right.jsx.', { autostart: 'yes' }),
      task('Restyle the left panel', 'debt', 'Touches web/left.jsx.', { autostart: 'yes' }),
      task('Tidy up somewhere', 'debt', null, { autostart: 'yes' }),
    ]);
    const queue = (await body(await api('agents'))).queue;
    const of = (wid) => queue.find((q) => q.wid === wid);
    expect(of(a)).toMatchObject({ ready: true });
    expect(of(b)).toMatchObject({ ready: true });
    expect(of(c)).toMatchObject({
      ready: false,
      forceable: true,
      reason: `it would touch web/left.jsx, which ${a} starts on now`,
      footprint: { task: a, path: 'web/left.jsx' },
    });
    expect(of(d)).toMatchObject({ ready: false, reason: expect.stringMatching(/already working in Tech debt/) });
    await runDurableObjectAlarm(stub());
    const after = (await body(await api('agents'))).queue;
    expect(after.find((q) => q.wid === c).reason).toBe(
      `it would touch web/left.jsx, which ${a} is changing (claude-${a.toLowerCase()})`,
    );
    for (const wid of [a, b]) {
      await api(`tasks/${wid}`, { method: 'PATCH', body: { autostart: 'no' } });
      await release(wid);
    }
    for (const wid of [c, d]) await api(`tasks/${wid}`, { method: 'PATCH', body: { autostart: 'no' } });
  });

  it('the chase: related tasks with disjoint footprints start together; a shared file waits; unknown keeps the old rule', async () => {
    // Related tasks name each other's paths only in the same folder (section 2), so these two are apart.
    const [m1] = await add([task('Count the votes', 'moderation', 'Change src/votes.js.', { tags: ['agent', 'fp'] })]);
    const [m2, m3, m4] = await add([
      task('Show the votes', 'moderation', 'Change web/tally.jsx.', { tags: ['agent', 'fp'], related: [m1] }),
      task('Count the votes faster', 'moderation', 'Also src/votes.js.', { tags: ['agent', 'fp'] }),
      task('Moderate somewhere', 'moderation', null, { tags: ['agent', 'fp'] }),
    ]);
    const [m5] = await add([task('Moderate elsewhere', 'moderation', null, { tags: ['agent', 'fp'], related: [m4] })]);
    expect((await api('features', { method: 'POST', body: { slug: 'fp' } })).status).toBe(201);
    const dry = await body(await api('features/fp/chase', { method: 'POST', body: { on: true, dryRun: true } }));
    expect(dry.wouldStart).toEqual([m1, m2, m4]);
    const f = (await body(await api('features/fp'))).feature;
    const queued = (wid) => f.chase.queue.find((q) => q.wid === wid);
    expect(queued(m2)).toMatchObject({ ready: true });
    expect(queued(m3)).toMatchObject({
      ready: false,
      reason: `it would touch src/votes.js, which ${m1} starts on now`,
      footprint: { task: m1, path: 'src/votes.js' },
    });
    expect(queued(m5).reason).toMatch(new RegExp(`related to ${m4}, which an agent is working on in`));
  });

  it('an open pull request nobody runs holds a start with its files, and only those', async () => {
    const [p1, p2, p3] = await add([
      task('Write the pull', 'product', 'Change lib/pull.js.', { horizon: 'next' }),
      task('Change the pull too', 'product', 'Also lib/pull.js.', { horizon: 'next' }),
      task('Something else in product', 'product', null, { horizon: 'next' }),
    ]);
    await inStore((s) =>
      s.sql.exec(
        "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', 77, ?, 'open', ?)",
        new Date().toISOString(),
        JSON.stringify({
          number: 77,
          title: 'Pull 77',
          state: 'open',
          draft: false,
          url: 'https://github.com/acme/widgets/pull/77',
          author: 'claude[bot]',
          headSha: 'abc123',
          files: ['lib/pull.js'],
          checks: { state: 'success', total: 1, passed: 1, runs: [] },
          review: { decision: null, comments: 0 },
          closes: [p1],
          mentions: [],
        }),
      ),
    );
    const plan = await nextPlan({ horizon: 'next' });
    expect(reasons(plan)[p2]).toBe(`it would touch lib/pull.js, which ${p1}’s open pull request changes`);
    // Its footprint is unknown, but a pull request nobody runs holds only with its files.
    expect(plan.started.map((t) => t.wid)).toContain(p3);
  });

  it('exempts security fixes, general agents, and kickoffs from waiting, and refine and review agents from holding', async () => {
    await inStore((s) => {
      const views = s.views();
      const votes = views.find((t) => t.description === 'Count the votes');
      const again = views.find((t) => t.description === 'Count the votes faster');
      const beside = [{ task: votes, agent: 'claude-x', kind: 'build' }];
      expect(s.collision(again, beside, { chase: true })?.why).toBe('files');
      expect(s.collision({ ...again, alert: 'https://github.com/acme/widgets/security/1' }, beside)).toBeNull();
      expect(s.collision({ ...again, tags: [...again.tags, 'general'] }, beside)).toBeNull();
      for (const kind of ['refine', 'review', 'pr-review'])
        expect(s.collision(again, [{ task: votes, agent: 'claude-x', kind }])).toBeNull();
      // A general agent holds others only once it claims paths: its words alone hold nothing.
      expect(
        s.collision(again, [{ task: { ...votes, tags: [...votes.tags, 'general'] }, agent: 'g', kind: 'general' }]),
      ).toBeNull();
    });
  });
});
