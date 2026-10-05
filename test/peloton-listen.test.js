import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// The listen route: what's waiting for an agent now (docs/specs/IDEA-36-peloton-planning.md, sections 3 and 10; BRK-213).

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const enc = encodeURIComponent;
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const CHASE = 'chase:relay';

const listen = async (agent, task) =>
  body(await api(`peloton/listen?agent=${enc(agent)}${task ? `&task=${enc(task)}` : ''}`));
const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const plan = async (peloton, input) => body(await api(`peloton/${enc(peloton)}/plan`, { method: 'PUT', body: input }));
const claim = (wid, agent, force = false) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent, force } });
const release = (wid, agent) => api(`tasks/${wid}/release`, { method: 'POST', body: { agent } });
const hookPost = async (wid, agent) =>
  body(
    await api(`tasks/${wid}/session`, {
      method: 'POST',
      body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }] },
    }),
  );
const waiting = async (wid, agent) => body(await api(`tasks/${wid}/messages/waiting?agent=${enc(agent)}`));

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
const message = (wid, text) => asOwner(`tasks/${wid}/messages`, 'POST', { text });

/** The pull request that closes `wid`, as the board keeps it from GitHub. */
const pull = (number, wid, { state = 'open', head = 'aaa', checks = 'pending', review = 'none', dirty = false } = {}) =>
  runInDurableObject(store(), (instance) => {
    instance.sql.exec(
      'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES (?, ?, ?, ?, ?)',
      instance.defaultRepoSlug(),
      number,
      new Date().toISOString(),
      state,
      JSON.stringify({
        number,
        title: `Pull ${number}`,
        state,
        draft: false,
        url: `https://github.com/acme/widgets/pull/${number}`,
        headSha: head,
        mergeable: !dirty,
        mergeableState: dirty ? 'dirty' : 'clean',
        checks: { state: checks, total: 1, passed: checks === 'success' ? 1 : 0, runs: [] },
        review: {
          decision: review,
          reviewers: review === 'none' || review === 'commented' ? [] : ['octocat'],
          comments: review === 'commented' ? 1 : 0,
        },
        closes: [wid],
        mentions: [],
      }),
    );
  });

describe('listening on the peloton (IDEA-36)', () => {
  let repo;
  let spy;
  beforeAll(async () => {
    let next = 1;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === FIRE) {
        const id = `session_l${String(next++).padStart(3, '0')}`;
        return Response.json({
          type: 'routine_fire',
          claude_code_session_id: id,
          claude_code_session_url: `https://claude.ai/code/${id}`,
        });
      }
      return new Response('{}', { status: 404 });
    });
    const task = (description, tags) => ({ description, project: 'product', tags, horizon: 'now' });
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          task('Relay one', ['agent', 'relay']),
          task('Relay two', ['agent', 'relay']),
          task('Solo three', ['agent']),
          task('Relay four', ['agent', 'relay']),
          task('Relay five', ['agent', 'relay']),
        ],
      }),
    );
    expect(created.tasks.map((t) => t.wid)).toEqual(['PRD-1', 'PRD-2', 'PRD-3', 'PRD-4', 'PRD-5']);
    repo = created.tasks[0].repo;
    for (const n of [1, 2, 3, 4, 5]) expect((await claim(`PRD-${n}`, `claude-prd-${n}`)).status).toBe(200);
    expect((await api('features', { method: 'POST', body: { slug: 'relay' } })).status).toBe(201);
    expect((await api('features/relay/chase', { method: 'POST', body: { on: true } })).status).toBe(200);
    cookie = await signIn();
    // Start every agent with nothing waiting: the chase's opening line is read.
    for (const n of [1, 2, 3, 4, 5]) await hookPost(`PRD-${n}`, `claude-prd-${n}`);
  });
  afterAll(() => spy.mockRestore());

  it('says which agent is listening', async () => {
    const res = await listen('');
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/say which agent is listening/);
    expect((await listen('no such agent')).status).toBe(400);
    // Without ?agent= it's the peloton named `listen`, which the board doesn't have.
    expect((await body(await api('peloton/listen'))).status).toBe(404);
  });

  it('answers at once with nothing waiting', async () => {
    const res = await listen('claude-prd-1');
    expect(res).toMatchObject({
      status: 200,
      agent: 'claude-prd-1',
      task: 'PRD-1',
      urgent: false,
      posts: [],
      more: 0,
      messages: [],
      pr: null,
      stop: null,
    });
  });

  it('hands over any other post on the chase’s peloton, not urgent, and only once', async () => {
    await post(CHASE, { agent: 'claude-prd-2', kind: 'note', text: 'Starting on src/store.js' });
    const res = await listen('claude-prd-1');
    expect(res.urgent).toBe(false);
    expect(res.posts.map((p) => [p.agent, p.kind, p.text, p.urgent])).toEqual([
      ['claude-prd-2', 'note', 'Starting on src/store.js', false],
    ]);
    expect((await listen('claude-prd-1')).posts).toEqual([]);
    // Delivered once, whichever asks first: the session answer doesn't hand it over again.
    expect((await hookPost('PRD-1', 'claude-prd-1')).peloton).toEqual([]);
  });

  it('leaves the repository’s peloton to the session answer, unless something there is urgent', async () => {
    await post(repo, { agent: 'claude-prd-2', kind: 'note', text: 'Lunch' });
    expect((await listen('claude-prd-1')).posts).toEqual([]);
    expect((await hookPost('PRD-1', 'claude-prd-1')).peloton.map((p) => p.text)).toEqual(['Lunch']);

    await post(repo, { agent: 'claude-prd-2', kind: 'note', text: 'Back' });
    await post(repo, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 is src/a.js yours?' });
    const res = await listen('claude-prd-1');
    expect(res.urgent).toBe(true);
    expect(res.posts.map((p) => [p.text, p.urgent])).toEqual([
      ['@claude-prd-1 is src/a.js yours?', true],
      ['Back', false],
    ]);
    expect((await hookPost('PRD-1', 'claude-prd-1')).peloton).toEqual([]);
  });

  it('marks each urgent post as urgent, in the delivery order', async () => {
    const mine = await post(CHASE, { agent: 'claude-prd-1', kind: 'ask', text: 'Who has the docs?' });
    await post(CHASE, { agent: 'claude-prd-2', kind: 'note', text: 'Tests are slow today' });
    await post(CHASE, { agent: 'claude-prd-2', kind: 'plan', text: 'nope' }).then((r) => expect(r.status).toBe(400));
    await plan(CHASE, { agent: 'claude-prd-2', text: 'PRD-1 first, then PRD-2.', why: 'First plan' });
    await post(CHASE, { agent: 'claude-prd-2', kind: 'reply', reply_to: mine.post.id, text: 'claude-prd-4 does' });
    await post(CHASE, { agent: 'claude-prd-4', kind: 'note', text: 'Ask @claude-prd-1 about it' });
    await post(CHASE, { agent: 'claude-prd-4', kind: 'huddle', text: 'Which goes first?' });
    expect((await ownerPost(CHASE, { kind: 'note', text: 'Keep it small' })).status).toBe(201);
    const res = await listen('claude-prd-1');
    expect(res.urgent).toBe(true);
    expect(res.posts.map((p) => [p.agent, p.kind, p.urgent])).toEqual([
      ['owner', 'note', true],
      ['claude-prd-4', 'huddle', true],
      ['claude-prd-2', 'reply', true],
      ['claude-prd-4', 'note', true],
      ['claude-prd-2', 'plan', true],
      ['claude-prd-2', 'note', false],
    ]);
    expect(res.posts.find((p) => p.kind === 'reply').toYou).toBe(true);
    expect(res.posts.find((p) => p.agent === 'claude-prd-4' && p.kind === 'note').mentionsYou).toBe(true);
    // The huddle's close is urgent too.
    await post(CHASE, { agent: 'claude-prd-4', kind: 'outcome', text: 'PRD-1 first' });
    expect((await listen('claude-prd-1')).posts.map((p) => [p.kind, p.urgent])).toEqual([['outcome', true]]);
  });

  it('hands a post over once across listen, the session answer, and the wait route', async () => {
    await post(CHASE, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 one' });
    expect((await waiting('PRD-1', 'claude-prd-1')).peloton.map((p) => p.text)).toEqual(['@claude-prd-1 one']);
    expect((await listen('claude-prd-1')).posts).toEqual([]);

    await post(CHASE, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 two' });
    expect((await listen('claude-prd-1')).posts.map((p) => p.text)).toEqual(['@claude-prd-1 two']);
    expect((await waiting('PRD-1', 'claude-prd-1')).peloton).toEqual([]);
    expect((await hookPost('PRD-1', 'claude-prd-1')).peloton).toEqual([]);

    await post(CHASE, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 three' });
    expect((await hookPost('PRD-1', 'claude-prd-1')).peloton.map((p) => p.text)).toEqual(['@claude-prd-1 three']);
    expect((await listen('claude-prd-1')).posts).toEqual([]);
  });

  it('hands over the owner’s messages for its task once, as urgent, whichever way asks first', async () => {
    expect((await message('PRD-1', 'Also update the docs.')).status).toBe(201);
    const res = await listen('claude-prd-1');
    expect(res.urgent).toBe(true);
    expect(res.messages.map((m) => m.text)).toEqual(['Also update the docs.']);
    expect((await listen('claude-prd-1')).messages).toEqual([]);
    expect((await waiting('PRD-1', 'claude-prd-1')).messages).toEqual([]);
    expect((await hookPost('PRD-1', 'claude-prd-1')).messages).toEqual([]);

    await message('PRD-1', 'And the changelog.');
    expect((await hookPost('PRD-1', 'claude-prd-1')).messages.map((m) => m.text)).toEqual(['And the changelog.']);
    expect((await listen('claude-prd-1')).messages).toEqual([]);
  });

  it('hands over messages only to the agent that holds the task', async () => {
    await message('PRD-2', 'For PRD-2 only.');
    expect((await listen('claude-prd-1')).messages).toEqual([]);
    expect((await listen('claude-prd-2')).messages.map((m) => m.text)).toEqual(['For PRD-2 only.']);
  });

  describe('its pull request', () => {
    it('says nothing while there is none, or while its checks run', async () => {
      expect((await listen('claude-prd-1')).pr).toBeNull();
      await pull(11, 'PRD-1', { checks: 'pending' });
      expect((await listen('claude-prd-1')).pr).toBeNull();
    });

    it('says when its checks finish, once', async () => {
      await pull(11, 'PRD-1', { checks: 'failure' });
      const res = await listen('claude-prd-1');
      expect(res.urgent).toBe(true);
      expect(res.pr).toEqual({
        number: 11,
        url: 'https://github.com/acme/widgets/pull/11',
        checks: 'failure',
        review: 'none',
        conflict: false,
        changed: ['checks'],
      });
      expect((await listen('claude-prd-1')).pr).toBeNull();
      // A new head runs them again: quiet while they run, and they say when they finish.
      await pull(11, 'PRD-1', { head: 'bbb', checks: 'pending' });
      expect((await listen('claude-prd-1')).pr).toBeNull();
      await pull(11, 'PRD-1', { head: 'bbb', checks: 'success' });
      expect((await listen('claude-prd-1')).pr).toMatchObject({ checks: 'success', changed: ['checks'] });
      // Finished again on another head with the same result: that's news too.
      await pull(11, 'PRD-1', { head: 'ccc', checks: 'success' });
      expect((await listen('claude-prd-1')).pr).toMatchObject({ checks: 'success', changed: ['checks'] });
      expect((await listen('claude-prd-1')).urgent).toBe(false);
    });

    it('says when a review comes in', async () => {
      await pull(11, 'PRD-1', { head: 'ccc', checks: 'success', review: 'changes_requested' });
      expect((await listen('claude-prd-1')).pr).toMatchObject({ review: 'changes_requested', changed: ['review'] });
      expect((await listen('claude-prd-1')).pr).toBeNull();
      await pull(11, 'PRD-1', { head: 'ccc', checks: 'success', review: 'approved' });
      expect((await listen('claude-prd-1')).pr).toMatchObject({ review: 'approved', changed: ['review'] });
    });

    it('says when it starts to conflict', async () => {
      await pull(11, 'PRD-1', { head: 'ccc', checks: 'success', review: 'approved', dirty: true });
      expect((await listen('claude-prd-1')).pr).toMatchObject({ conflict: true, changed: ['conflict'] });
      expect((await listen('claude-prd-1')).pr).toBeNull();
    });

    it('reports what’s already there on an agent’s first ask', async () => {
      await pull(12, 'PRD-2', { checks: 'failure', dirty: true });
      expect((await listen('claude-prd-2')).pr).toMatchObject({ number: 12, changed: ['checks', 'conflict'] });
    });

    it('follows the pull request its task names', async () => {
      await pull(13, 'PRD-9', { checks: 'success' });
      expect((await api('tasks/PRD-2', { method: 'PATCH', body: { pr: '13' } })).status).toBe(200);
      expect((await listen('claude-prd-2')).pr).toMatchObject({ number: 13, changed: ['checks'] });
    });
  });

  describe('when to stop', () => {
    it('when the task isn’t in an open chase, after handing over what’s urgent', async () => {
      await hookPost('PRD-3', 'claude-prd-3');
      await post(repo, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-3 got a minute?' });
      const res = await listen('claude-prd-3');
      expect(res.stop).toMatch(/PRD-3 isn’t in an open chase/);
      expect(res.posts.map((p) => p.text)).toEqual(['@claude-prd-3 got a minute?']);
    });

    it('when the claim is released, moves, or never was', async () => {
      expect((await release('PRD-4', 'claude-prd-4')).status).toBe(200);
      // A released task keeps no claim, so only naming it says which.
      const released = await listen('claude-prd-4');
      expect(released).toMatchObject({ task: null, urgent: false, posts: [], messages: [], pr: null });
      expect(released.stop).toMatch(/claude-prd-4 holds no claimed task: the claim is gone/);
      const named = await listen('claude-prd-4', 'PRD-4');
      expect(named).toMatchObject({ task: 'PRD-4', urgent: false, posts: [], messages: [], pr: null });
      expect(named.stop).toMatch(/the claim on PRD-4 is gone: it was released/);

      expect((await claim('PRD-4', 'claude-prd-4')).status).toBe(200);
      expect((await claim('PRD-4', 'claude-other', true)).status).toBe(200);
      expect((await listen('claude-prd-4')).stop).toMatch(/claude-prd-4 holds no claimed task/);
      expect((await listen('claude-prd-4', 'PRD-4')).stop).toMatch(/the claim on PRD-4 moved to claude-other/);

      expect((await listen('claude-nobody')).stop).toMatch(/claude-nobody holds no claimed task/);
    });

    it('when its pull request merged', async () => {
      await pull(15, 'PRD-5', { state: 'merged', checks: 'success' });
      expect((await listen('claude-prd-5')).stop).toMatch(/PRD-5’s pull request #15 merged/);
      // And once the board has finished the task.
      await runInDurableObject(store(), (instance) =>
        instance.change(
          instance.resolve('PRD-5'),
          { status: 'completed', pr: '15', by: 'board' },
          new Date(),
          'github',
        ),
      );
      expect((await listen('claude-prd-5')).stop).toMatch(/PRD-5’s pull request #15 merged/);
    });

    it('when the chase stopped', async () => {
      expect((await listen('claude-prd-1')).stop).toBeNull();
      expect((await api('features/relay/chase', { method: 'POST', body: { on: false } })).status).toBe(200);
      expect((await listen('claude-prd-1')).stop).toMatch(/PRD-1 isn’t in an open chase/);
    });
  });
});
