import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// Huddles and the chase's plan (docs/specs/IDEA-36-peloton-planning.md, sections 4, 5, and 10; BRK-212).

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const enc = encodeURIComponent;
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const CHASE = 'chase:squad';

const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const detail = async (peloton) => body(await api(`peloton/${enc(peloton)}`));
const plan = async (peloton, input) => body(await api(`peloton/${enc(peloton)}/plan`, { method: 'PUT', body: input }));
const revisions = async (peloton) => body(await api(`peloton/${enc(peloton)}/plan`));
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
const hookPost = async (wid, agent) =>
  body(
    await api(`tasks/${wid}/session`, {
      method: 'POST',
      body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }] },
    }),
  );
const waiting = async (wid, agent) => body(await api(`tasks/${wid}/messages/waiting?agent=${enc(agent)}`));
/** Moves the open huddles, and every call made so far, `minutes` into the past. */
const later = (minutes) =>
  runInDurableObject(store(), (instance) => {
    const ms = minutes * 60_000;
    instance.sql.exec('UPDATE peloton_huddles SET opened = opened - ?, closes = closes - ?', ms, ms);
  });

let cookie;
const signIn = async () => {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return login.headers.get('Set-Cookie').split(';')[0];
};
const asOwner = async (path, method, input) =>
  body(
    await SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
const ownerPost = (peloton, input) => asOwner(`peloton/${enc(peloton)}`, 'POST', input);
const ownerPlan = (peloton, input) => asOwner(`peloton/${enc(peloton)}/plan`, 'PUT', input);

describe('huddles and the chase’s plan (IDEA-36)', () => {
  let repo;
  let spy;
  const fires = [];
  beforeAll(async () => {
    let next = 1;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === FIRE) {
        fires.push(JSON.parse(init.body).text);
        const id = `session_h${String(next++).padStart(3, '0')}`;
        return Response.json({
          type: 'routine_fire',
          claude_code_session_id: id,
          claude_code_session_url: `https://claude.ai/code/${id}`,
        });
      }
      return new Response('{}', { status: 404 });
    });
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Squad one', project: 'product', tags: ['agent', 'squad'], horizon: 'now' },
          { description: 'Squad two', project: 'product', tags: ['agent', 'squad'], horizon: 'now' },
          { description: 'Solo three', project: 'product', tags: ['agent'], horizon: 'now' },
          {
            description: 'Road captain for Squad',
            project: 'product',
            tags: ['agent', 'general', 'squad'],
            horizon: 'now',
          },
        ],
      }),
    );
    expect(created.tasks.map((t) => t.wid)).toEqual(['PRD-1', 'PRD-2', 'PRD-3', 'PRD-4']);
    repo = created.tasks[0].repo;
    for (const [wid, agent] of [
      ['PRD-1', 'claude-prd-1'],
      ['PRD-2', 'claude-prd-2'],
      ['PRD-3', 'claude-prd-3'],
      ['PRD-4', 'claude-captain-4'],
    ])
      expect((await claim(wid, agent)).status).toBe(200);
    // PRD-4's agent is the chase's road captain: the owner started it as one.
    await runInDurableObject(store(), (instance) => {
      instance.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, started) VALUES (?, 'claude-captain-4', 'road-captain', 'running', ?)",
        instance.resolve('PRD-4'),
        Date.now(),
      );
    });
    expect((await api('features', { method: 'POST', body: { slug: 'squad' } })).status).toBe(201);
    expect((await api('features/squad/chase', { method: 'POST', body: { on: true } })).status).toBe(200);
    cookie = await signIn();
  });
  afterAll(() => spy.mockRestore());

  describe('huddles', () => {
    it('are a chase’s only: a repository’s peloton refuses huddle, in, and outcome', async () => {
      for (const kind of ['huddle', 'in', 'outcome']) {
        const res = await post(repo, { agent: 'claude-prd-1', kind, text: 'Which goes first?' });
        expect(res.status, kind).toBe(400);
        expect(res.error).toMatch(/only on a chase’s peloton/);
      }
      expect((await ownerPost(repo, { kind: 'huddle', text: 'Which goes first?' })).status).toBe(400);
      expect((await detail(repo)).huddle).toBeNull();
    });

    it('take in and outcome only while one is open', async () => {
      for (const kind of ['in', 'outcome']) {
        const res = await post(CHASE, { agent: 'claude-prd-1', kind, text: 'In' });
        expect(res.status, kind).toBe(409);
        expect(res.error).toMatch(/no huddle is open/);
      }
    });

    it('opens with a huddle post by an agent riding the chase, one at a time', async () => {
      // claude-prd-3 isn't in the chase, so it can't call one there.
      expect((await post(CHASE, { agent: 'claude-prd-3', kind: 'huddle', text: 'Hi' })).status).toBe(403);
      await hookPost('PRD-2', 'claude-prd-2');
      const res = await post(CHASE, { agent: 'claude-prd-1', kind: 'huddle', text: 'Who takes the migration?' });
      expect(res.status).toBe(201);
      expect(res.post).toMatchObject({ kind: 'huddle', agent: 'claude-prd-1', task: 'PRD-1' });
      const { huddle } = await detail(CHASE);
      expect(huddle).toMatchObject({
        id: res.post.id,
        question: 'Who takes the migration?',
        caller: 'claude-prd-1',
        task: 'PRD-1',
        in: [],
      });
      expect(Date.parse(huddle.closes) - Date.parse(huddle.opened)).toBe(20 * 60_000);
      // The agent's own view shows it too.
      expect(res.peloton.huddle).toMatchObject({ id: res.post.id });

      const second = await post(CHASE, { agent: 'claude-prd-2', kind: 'huddle', text: 'And the docs?' });
      expect(second.status).toBe(409);
      expect(second.error).toMatch(/one huddle at a time/);
      const owners = await ownerPost(CHASE, { kind: 'huddle', text: 'And the docs?' });
      expect(owners.status).toBe(409);
    });

    it('reaches the riders as urgent, after the owner’s posts and before mentions', async () => {
      await post(CHASE, { agent: 'claude-captain-4', kind: 'ask', text: '@claude-prd-2 still on src/a.js?' });
      const hook = await hookPost('PRD-2', 'claude-prd-2');
      expect(hook.peloton.map((p) => [p.kind, p.urgent])).toEqual([
        ['huddle', true],
        ['ask', true],
      ]);
    });

    it('takes in from the riders, and shows who’s in', async () => {
      const a = await post(CHASE, { agent: 'claude-prd-2', kind: 'in', text: 'In' });
      expect(a.status).toBe(201);
      expect(a.post.replyTo).toBe((await detail(CHASE)).huddle.id);
      await post(CHASE, { agent: 'claude-captain-4', kind: 'in', text: 'In, after this edit' });
      await post(CHASE, { agent: 'claude-prd-2', kind: 'in', text: 'Still in' });
      expect((await detail(CHASE)).huddle.in).toEqual(['claude-prd-2', 'claude-captain-4']);
      // The owner talks; they don't ride, so they're never in.
      expect((await ownerPost(CHASE, { kind: 'in', text: 'In' })).status).toBe(400);
    });

    it('closes with an outcome by its caller, the road captain, or the owner, and nobody else', async () => {
      const other = await post(CHASE, { agent: 'claude-prd-2', kind: 'outcome', text: 'I take it' });
      expect(other.status).toBe(403);
      expect(other.error).toMatch(/caller, the road captain, or the owner/);
      await hookPost('PRD-2', 'claude-prd-2');
      const res = await post(CHASE, {
        agent: 'claude-prd-1',
        kind: 'outcome',
        text: 'claude-prd-2 takes the migration; I wait for it.',
      });
      expect(res.status).toBe(201);
      expect((await detail(CHASE)).huddle).toBeNull();
      expect((await post(CHASE, { agent: 'claude-prd-2', kind: 'in', text: 'Late' })).status).toBe(409);
      // The close is urgent, and wakes a waiting agent.
      const woke = await waiting('PRD-2', 'claude-prd-2');
      expect(woke.peloton.map((p) => [p.kind, p.urgent])).toEqual([['outcome', true]]);
    });

    it('lets an agent call one every 30 minutes', async () => {
      const again = await post(CHASE, { agent: 'claude-prd-1', kind: 'huddle', text: 'One more thing' });
      expect(again.status).toBe(429);
      expect(again.error).toMatch(/one huddle every 30 minutes/);
      // Another agent can, and it wakes a waiting agent.
      await hookPost('PRD-2', 'claude-prd-2');
      const captain = await post(CHASE, { agent: 'claude-captain-4', kind: 'huddle', text: 'Order of the PRs?' });
      expect(captain.status).toBe(201);
      expect((await waiting('PRD-2', 'claude-prd-2')).peloton.map((p) => [p.kind, p.urgent])).toEqual([
        ['huddle', true],
      ]);
      // The road captain closes its own, and the owner theirs.
      expect((await post(CHASE, { agent: 'claude-captain-4', kind: 'outcome', text: 'PRD-1 first' })).status).toBe(201);
      await later(31);
      expect((await post(CHASE, { agent: 'claude-prd-1', kind: 'huddle', text: 'One more thing' })).status).toBe(201);
    });

    it('lets the road captain close another agent’s', async () => {
      const res = await post(CHASE, { agent: 'claude-captain-4', kind: 'outcome', text: 'Settled: no change' });
      expect(res.status).toBe(201);
      expect((await detail(CHASE)).huddle).toBeNull();
    });

    it('lets the owner call one and close it, without the 30-minute rule', async () => {
      const open = await ownerPost(CHASE, { kind: 'huddle', text: 'Where are we?' });
      expect(open.status).toBe(201);
      expect((await detail(CHASE)).huddle).toMatchObject({ caller: 'owner', task: null });
      expect((await ownerPost(CHASE, { kind: 'outcome', text: 'Carry on' })).status).toBe(201);
      expect((await ownerPost(CHASE, { kind: 'huddle', text: 'And now?' })).status).toBe(201);
      // An agent closes the owner's only as the road captain.
      expect((await post(CHASE, { agent: 'claude-prd-2', kind: 'outcome', text: 'Done' })).status).toBe(403);
      expect((await ownerPost(CHASE, { kind: 'outcome', text: 'Done' })).status).toBe(201);
    });

    it('times out after 20 minutes with a line from the board', async () => {
      await later(60);
      expect((await post(CHASE, { agent: 'claude-prd-2', kind: 'huddle', text: 'Tests flaky?' })).status).toBe(201);
      await hookPost('PRD-1', 'claude-prd-1');
      await later(19);
      expect((await detail(CHASE)).huddle).not.toBeNull();
      await later(2);
      const res = await detail(CHASE);
      expect(res.huddle).toBeNull();
      expect(res.posts.at(-1)).toMatchObject({
        agent: 'board',
        kind: 'outcome',
        text: expect.stringMatching(/ended without an outcome/),
      });
      // Once, and it reaches the riders as a close.
      expect((await detail(CHASE)).posts.filter((p) => p.agent === 'board' && p.kind === 'outcome')).toHaveLength(1);
      const hook = await hookPost('PRD-1', 'claude-prd-1');
      expect(hook.peloton.map((p) => [p.agent, p.kind, p.urgent])).toEqual([['board', 'outcome', true]]);
    });
  });

  describe('the plan', () => {
    it('is a chase’s only', async () => {
      const res = await plan(repo, { agent: 'claude-prd-1', text: 'Do it', why: 'First' });
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/only a chase’s peloton has a plan/);
      expect((await detail(repo)).plan).toBeNull();
      expect((await detail(CHASE)).plan).toBeNull();
      expect((await revisions(CHASE)).revisions).toEqual([]);
    });

    it('while a road captain runs, is its to revise and the owner’s; the others propose', async () => {
      const refused = await plan(CHASE, { agent: 'claude-prd-1', text: 'Me first', why: 'Mine' });
      expect(refused.status).toBe(403);
      expect(refused.error).toMatch(/claude-captain-4 keeps the plan.*propose/);
      expect((await plan(CHASE, { agent: 'claude-prd-3', text: 'X', why: 'Y' })).status).toBe(403);

      await hookPost('PRD-1', 'claude-prd-1');
      const first = await plan(CHASE, {
        agent: 'claude-captain-4',
        text: 'PRD-1, then PRD-2. claude-prd-2 owns the migration.',
        why: 'First cut',
      });
      expect(first.status).toBe(200);
      expect(first.plan).toMatchObject({
        version: 1,
        text: 'PRD-1, then PRD-2. claude-prd-2 owns the migration.',
        agent: 'claude-captain-4',
        task: 'PRD-4',
        why: 'First cut',
      });
      expect(first.post).toMatchObject({ kind: 'plan', agent: 'claude-captain-4', text: 'Plan v1: First cut' });

      const owner = await ownerPlan(CHASE, { text: 'PRD-2 first.', why: 'The migration goes first' });
      expect(owner.status).toBe(200);
      expect(owner.plan).toMatchObject({ version: 2, agent: 'owner', task: null });
      // The bearer token never revises it as the owner.
      expect((await plan(CHASE, { agent: 'owner', text: 'X', why: 'Y' })).status).toBe(403);
      expect((await plan(CHASE, { text: 'X', why: 'Y' })).status).toBe(400);

      const { revisions: list, plan: current } = await revisions(CHASE);
      expect(list.map((r) => [r.version, r.agent, r.why])).toEqual([
        [2, 'owner', 'The migration goes first'],
        [1, 'claude-captain-4', 'First cut'],
      ]);
      expect(current).toMatchObject({ version: 2, text: 'PRD-2 first.' });
      expect((await detail(CHASE)).plan).toMatchObject({ version: 2, text: 'PRD-2 first.' });

      // Each revision reaches the riders as urgent, after mentions and before the rest.
      await post(CHASE, { agent: 'claude-prd-2', kind: 'note', text: 'Noted' });
      await post(CHASE, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 ok?' });
      const hook = await hookPost('PRD-1', 'claude-prd-1');
      expect(hook.peloton.map((p) => [p.kind, p.agent, p.urgent])).toEqual([
        ['plan', 'owner', true],
        ['ask', 'claude-prd-2', true],
        ['plan', 'claude-captain-4', true],
        ['note', 'claude-prd-2', false],
      ]);
    });

    it('with no road captain running, is any rider’s to revise', async () => {
      expect((await api('tasks/PRD-4/release', { method: 'POST', body: { agent: 'claude-captain-4' } })).status).toBe(
        200,
      );
      const res = await plan(CHASE, { agent: 'claude-prd-1', text: 'PRD-2, then PRD-1.', why: 'Swap' });
      expect(res.status).toBe(200);
      expect(res.plan).toMatchObject({ version: 3, agent: 'claude-prd-1' });
      // Still only riders.
      expect((await plan(CHASE, { agent: 'claude-prd-3', text: 'X', why: 'Y' })).status).toBe(403);
    });

    it('takes up to 4,000 characters, says what changed, and no token', async () => {
      const long = await plan(CHASE, { agent: 'claude-prd-1', text: 'x'.repeat(4001), why: 'Long' });
      expect(long.status).toBe(400);
      expect(long.error).toMatch(/up to 4,000 characters/);
      expect((await plan(CHASE, { agent: 'claude-prd-1', text: 'x'.repeat(4000), why: 'Full' })).status).toBe(200);
      expect((await plan(CHASE, { agent: 'claude-prd-1', text: 'X', why: ' ' })).status).toBe(400);
      expect((await plan(CHASE, { agent: 'claude-prd-1', text: '  ', why: 'Empty' })).status).toBe(400);
      const secret = await plan(CHASE, {
        agent: 'claude-prd-1',
        text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        why: 'Key',
      });
      expect(secret.status).toBe(400);
      expect(secret.error).toMatch(/token or key/);
      expect((await plan(CHASE, { agent: 'claude-prd-1', text: 'PRD-2, then PRD-1.', why: 'Back' })).status).toBe(200);
    });

    it('shows in the agent’s view of the chase', async () => {
      const read = await body(await api('peloton?agent=claude-prd-1'));
      const chase = read.pelotons.find((p) => p.peloton === CHASE);
      expect(chase.plan).toMatchObject({ version: 5, text: 'PRD-2, then PRD-1.' });
      expect(read.pelotons.find((p) => p.peloton === repo).plan).toBeNull();
    });

    it('goes in the payload of every agent the chase starts', async () => {
      const created = await body(
        await api('tasks', {
          method: 'POST',
          body: [{ description: 'Squad five', project: 'product', tags: ['agent', 'squad'], horizon: 'now' }],
        }),
      );
      expect(created.tasks[0].wid).toBe('PRD-5');
      await runInDurableObject(store(), (instance) => instance.chaseTick());
      const text = fires.find((f) => f.includes('Task: PRD-5\n'));
      expect(text).toContain('Started: by the owner’s chase of a feature');
      expect(text).toMatch(/\n\nThe chase’s plan \(chase:squad, version 5\):\nPRD-2, then PRD-1\.$/);
      // An agent started any other way gets none.
      await runInDurableObject(store(), async (instance) => {
        const uuid = instance.resolve('PRD-3');
        instance.change(uuid, { claim: null });
        await instance.startAgent(uuid, { trigger: 'manual' });
      });
      expect(fires.at(-1)).toContain('Task: PRD-3\n');
      expect(fires.at(-1)).not.toContain('plan');
    });

    it('goes in the road captain’s brief', async () => {
      await runInDurableObject(store(), (instance) => {
        const { brief } = instance.roadCaptain('squad', 'Keep it moving.', instance.views(), []);
        expect(brief).toContain('## The chase’s plan (version 5)');
        expect(brief).toContain('PRD-2, then PRD-1.');
        expect(brief).toMatch(/you keep the plan/);
      });
    });

    it('is kept as long as the chase’s posts', async () => {
      await runInDurableObject(store(), (instance) => {
        const count = (table) =>
          instance.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE peloton = ?`, CHASE).one().n;
        instance.sql.exec("UPDATE features SET chase = 'stopped', chase_ended = ? WHERE slug = 'squad'", Date.now());
        instance.prunePeloton();
        expect(count('peloton_plans')).toBe(5);
        expect(count('peloton_huddles')).toBeGreaterThan(0);
        instance.sql.exec("UPDATE features SET chase_ended = ? WHERE slug = 'squad'", Date.now() - 86_400_000 - 1000);
        instance.prunePeloton();
        expect(count('peloton_plans')).toBe(0);
        expect(count('peloton_huddles')).toBe(0);
      });
    });
  });
});
