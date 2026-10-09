import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const enc = encodeURIComponent;

const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const detail = async (peloton) => body(await api(`peloton/${enc(peloton)}`));
const mine = async (agent) => body(await api(`peloton?agent=${enc(agent)}`));
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
const hookPost = async (wid, agent, extra = {}) =>
  body(
    await api(`tasks/${wid}/session`, {
      method: 'POST',
      body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }], ...extra },
    }),
  );
const waiting = async (wid, agent) => body(await api(`tasks/${wid}/messages/waiting?agent=${enc(agent)}`));

describe('the peloton (IDEA-32)', () => {
  let repo;
  let spy;
  beforeAll(async () => {
    // Nothing reaches the network: a chase that fires a routine, or the alarm asking GitHub, gets a 404.
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Peloton one', project: 'ops', tags: ['agent', 'pack'], horizon: 'now' },
          { description: 'Peloton two', project: 'ops', tags: ['agent', 'pack'], horizon: 'now' },
          { description: 'Peloton three', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Peloton four', project: 'ops', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(created.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4']);
    repo = created.tasks[0].repo;
    expect(repo).toBeTruthy();
    for (const [wid, agent] of [
      ['OPS-1', 'claude-ops-1'],
      ['OPS-2', 'claude-ops-2'],
      ['OPS-3', 'claude-ops-3'],
    ])
      expect((await claim(wid, agent)).status).toBe(200);
  });
  afterAll(() => spy.mockRestore());

  it('starts empty, and says which pelotons exist', async () => {
    const res = await detail(repo);
    expect(res).toMatchObject({ status: 200, peloton: repo, kind: 'repo', open: true, roster: [], posts: [] });
    expect((await detail('nowhere')).status).toBe(404);
    expect((await detail('chase:nowhere')).status).toBe(404);
    const list = await body(await api('peloton'));
    expect(list.pelotons).toContainEqual(expect.objectContaining({ peloton: repo, riders: 0, posts: 0 }));
  });

  it('only the holder of a claimed task that rides the peloton can post', async () => {
    let res = await post(repo, { agent: 'claude-ops-4', kind: 'checkin', text: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/holds no claimed task that rides/);
    res = await post(repo, { agent: 'claude-ops-1', kind: 'checkin', text: 'Hi', task: 'OPS-2' });
    expect(res.status).toBe(403);
    // The signed-in board posts as the owner, never as an agent (IDEA-36).
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const owner = await SELF.fetch(`${ORIGIN}/api/peloton/${enc(repo)}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude-ops-1', kind: 'checkin', text: 'Hi' }),
    });
    expect(owner.status).toBe(400);
    expect((await detail(repo)).posts).toEqual([]);
  });

  it('checks the kind, the text, and a reply’s post', async () => {
    const as = { agent: 'claude-ops-1' };
    expect((await post(repo, { ...as, kind: 'shout', text: 'Hi' })).status).toBe(400);
    expect((await post(repo, { ...as, kind: 'step', text: '   ' })).status).toBe(400);
    expect((await post(repo, { ...as, kind: 'step', text: 'x'.repeat(2001) })).status).toBe(400);
    const secret = await post(repo, { ...as, kind: 'step', text: 'I used ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(secret.status).toBe(400);
    expect(secret.error).toMatch(/token or key/);
    expect((await post(repo, { ...as, kind: 'reply', text: 'Agreed' })).status).toBe(400);
    expect((await post(repo, { ...as, kind: 'reply', text: 'Agreed', reply_to: 99999 })).status).toBe(404);
    expect((await post(repo, { kind: 'step', text: 'Who am I' })).status).toBe(400);
  });

  it('checks agents in, shows the roster, and hands each agent what it hasn’t seen', async () => {
    let res = await post(repo, { agent: 'claude-ops-1', kind: 'checkin', text: 'On OPS-1: src/runbook.js' });
    expect(res.status).toBe(201);
    expect(res.post).toMatchObject({
      peloton: repo,
      agent: 'claude-ops-1',
      task: 'OPS-1',
      repo,
      kind: 'checkin',
      text: 'On OPS-1: src/runbook.js',
      replyTo: null,
    });
    expect(res.peloton.roster).toEqual([expect.objectContaining({ agent: 'claude-ops-1', task: 'OPS-1' })]);
    res = await post(repo, { agent: 'claude-ops-2', kind: 'checkin', text: 'On OPS-2: src/runbook.js too' });
    expect(res.status).toBe(201);
    // ops-2 reads what ops-1 said in the post's answer, and that marks it seen.
    expect(res.peloton.posts.map((p) => [p.agent, p.unseen])).toEqual([
      ['claude-ops-1', true],
      ['claude-ops-2', false],
    ]);
    expect(res.peloton.roster.map((r) => r.agent)).toEqual(['claude-ops-1', 'claude-ops-2']);

    // ops-1's session hook gets ops-2's check-in once.
    let hook = await hookPost('OPS-1', 'claude-ops-1');
    expect(hook.peloton).toEqual([
      expect.objectContaining({ agent: 'claude-ops-2', task: 'OPS-2', kind: 'checkin', toYou: false }),
    ]);
    hook = await hookPost('OPS-1', 'claude-ops-1');
    expect(hook.peloton).toEqual([]);
    // Nor does the agent's own read show it as unseen again.
    const read = await mine('claude-ops-1');
    expect(read.pelotons).toEqual([expect.objectContaining({ peloton: repo, kind: 'repo', task: 'OPS-1', unseen: 0 })]);
    expect(read.pelotons[0].posts.every((p) => !p.unseen)).toBe(true);
    // An agent that holds nothing rides nothing.
    expect((await mine('claude-ops-4')).pelotons).toEqual([]);
    expect((await body(await api('peloton?agent=%20'))).status).toBe(400);
  });

  it('wakes a waiting agent only for a reply to its own post, replies first', async () => {
    // ops-3 steps without checking in; it isn't on the roster, but it rides.
    const step = await post(repo, { agent: 'claude-ops-3', kind: 'step', text: 'Moved the runbook; anyone affected?' });
    expect(step.status).toBe(201);
    expect((await waiting('OPS-1', 'claude-ops-1')).peloton).toEqual([]);
    const checkin = (await detail(repo)).posts.find((p) => p.agent === 'claude-ops-1' && p.kind === 'checkin');
    const reply = await post(repo, {
      agent: 'claude-ops-2',
      kind: 'reply',
      text: 'You go first',
      reply_to: checkin.id,
    });
    expect(reply.post).toMatchObject({ kind: 'reply', replyTo: checkin.id });
    const woke = await waiting('OPS-1', 'claude-ops-1');
    expect(woke.peloton.map((p) => [p.agent, p.kind, p.toYou])).toEqual([
      ['claude-ops-2', 'reply', true],
      ['claude-ops-3', 'step', false],
    ]);
    expect((await waiting('OPS-1', 'claude-ops-1')).peloton).toEqual([]);
    expect((await hookPost('OPS-1', 'claude-ops-1')).peloton).toEqual([]);
    // A Stop hook's post can't hand them on: they stay for the next one.
    await post(repo, { agent: 'claude-ops-3', kind: 'step', text: 'Done with the move' });
    expect((await hookPost('OPS-1', 'claude-ops-1', { messages: false })).peloton).toEqual([]);
    expect((await hookPost('OPS-1', 'claude-ops-1')).peloton).toHaveLength(1);
    // The roster is who checked in.
    expect((await detail(repo)).roster.map((r) => r.agent)).toEqual(['claude-ops-1', 'claude-ops-2']);
  });

  it('adds a leave post when an agent releases its task or the claim moves', async () => {
    expect((await api('tasks/OPS-2/release', { method: 'POST', body: { agent: 'claude-ops-2' } })).status).toBe(200);
    let res = await detail(repo);
    expect(res.roster.map((r) => r.agent)).toEqual(['claude-ops-1']);
    expect(res.posts.at(-1)).toMatchObject({ agent: 'claude-ops-2', kind: 'leave', text: 'Left: released OPS-2.' });
    // Only once.
    res = await detail(repo);
    expect(res.posts.filter((p) => p.kind === 'leave')).toHaveLength(1);
    // A released agent can't post.
    expect((await post(repo, { agent: 'claude-ops-2', kind: 'step', text: 'One more thing' })).status).toBe(403);

    expect((await claim('OPS-2', 'claude-ops-2b')).status).toBe(200);
    expect((await post(repo, { agent: 'claude-ops-2b', kind: 'checkin', text: 'Taking over OPS-2' })).status).toBe(201);
    expect((await claim('OPS-2', 'claude-ops-2c')).status).toBe(409);
    expect(
      (await api('tasks/OPS-2/claim', { method: 'POST', body: { agent: 'claude-ops-2c', force: true } })).status,
    ).toBe(200);
    res = await detail(repo);
    expect(res.posts.at(-1)).toMatchObject({
      agent: 'claude-ops-2b',
      kind: 'leave',
      text: 'Left: OPS-2’s claim moved to claude-ops-2c.',
    });
  });

  it('adds a leave post when the task is done', async () => {
    await runInDurableObject(store(), (instance) => {
      instance.change(instance.resolve('OPS-1'), { status: 'completed', pr: '17', by: 'board' });
    });
    const res = await detail(repo);
    expect(res.roster).toEqual([]);
    expect(res.posts.at(-1)).toMatchObject({
      agent: 'claude-ops-1',
      kind: 'leave',
      // claude-ops-2's reply to its check-in is still unanswered (BRK-281).
      text: expect.stringMatching(/^Left: OPS-1’s pull request #17 merged, with a post to it unanswered \(#\d+\)\.$/u),
    });
  });

  it('limits an agent to 120 posts an hour and keeps 200 a peloton', async () => {
    await runInDurableObject(store(), (instance) => {
      const now = Date.now();
      // Up to 119 from ops-3 in the last hour (it posted twice already).
      for (let i = 0; i < 117; i += 1)
        instance.sql.exec(
          "INSERT INTO peloton_posts (peloton, at, agent, kind, text) VALUES (?, ?, 'claude-ops-3', 'step', 'x')",
          'elsewhere',
          now - 60_000,
        );
    });
    expect((await post(repo, { agent: 'claude-ops-3', kind: 'step', text: 'The 120th' })).status).toBe(201);
    const over = await post(repo, { agent: 'claude-ops-3', kind: 'step', text: 'The 121st' });
    expect(over.status).toBe(429);
    expect(over.error).toMatch(/120 posts in the last hour/);

    await runInDurableObject(store(), (instance) => {
      instance.sql.exec("DELETE FROM peloton_posts WHERE peloton = 'elsewhere'");
      instance.sql.exec("UPDATE peloton_posts SET at = at - 7200000 WHERE agent = 'claude-ops-3'");
      for (let i = 0; i < 210; i += 1) instance.addPost('flood', { agent: 'claude-x', kind: 'step', text: `n${i}` });
      const kept = instance.sql
        .exec("SELECT COUNT(*) AS n, MIN(text) AS first FROM peloton_posts WHERE peloton = 'flood'")
        .one();
      expect(kept.n).toBe(200);
      const oldest = instance.sql
        .exec("SELECT text FROM peloton_posts WHERE peloton = 'flood' ORDER BY id LIMIT 1")
        .one();
      expect(oldest.text).toBe('n10');
      instance.sql.exec("DELETE FROM peloton_posts WHERE peloton = 'flood'");
    });
  });

  it('opens a chase’s peloton with the chase, and closes it when the chase stops', async () => {
    expect((await api('features', { method: 'POST', body: { slug: 'pack' } })).status).toBe(201);
    // OPS-2's agent is in the chase; OPS-3's isn't.
    expect((await post('chase:pack', { agent: 'claude-ops-2c', kind: 'checkin', text: 'Early' })).status).toBe(409);
    const on = await body(await api('features/pack/chase', { method: 'POST', body: { on: true } }));
    expect(on.status).toBe(200);
    let res = await detail('chase:pack');
    expect(res).toMatchObject({ peloton: 'chase:pack', kind: 'chase', feature: 'pack', open: true, roster: [] });
    expect(res.posts).toEqual([expect.objectContaining({ agent: 'board', kind: 'open' })]);

    expect((await post('chase:pack', { agent: 'claude-ops-3', kind: 'checkin', text: 'Me too' })).status).toBe(403);
    const checkin = await post('chase:pack', {
      agent: 'claude-ops-2c',
      kind: 'checkin',
      text: 'On OPS-2 for the chase',
    });
    expect(checkin.status).toBe(201);
    expect(checkin.post).toMatchObject({ peloton: 'chase:pack', task: 'OPS-2' });
    // An agent in a chase rides both.
    const read = await mine('claude-ops-2c');
    expect(read.pelotons.map((p) => p.peloton).sort()).toEqual(['chase:pack', repo].sort());
    expect(read.pelotons.find((p) => p.peloton === 'chase:pack').roster.map((r) => r.agent)).toEqual(['claude-ops-2c']);
    const list = await body(await api('peloton'));
    expect(list.pelotons).toContainEqual(expect.objectContaining({ peloton: 'chase:pack', open: true, riders: 1 }));

    const off = await body(await api('features/pack/chase', { method: 'POST', body: { on: false } }));
    expect(off.status).toBe(200);
    res = await detail('chase:pack');
    expect(res).toMatchObject({ open: false, roster: [] });
    expect(res.posts.at(-1)).toMatchObject({ agent: 'board', kind: 'close', text: expect.stringMatching(/stopped/) });
    const late = await post('chase:pack', { agent: 'claude-ops-2c', kind: 'step', text: 'Still here' });
    expect(late.status).toBe(409);
    expect(late.error).toMatch(/takes no new posts/);
    expect((await mine('claude-ops-2c')).pelotons.map((p) => p.peloton)).toEqual([repo]);
  });

  it('keeps posts a day, and a closed chase’s for a day after it closed', async () => {
    await runInDurableObject(store(), (instance) => {
      const day = 86_400_000;
      const count = (peloton) =>
        instance.sql.exec('SELECT COUNT(*) AS n FROM peloton_posts WHERE peloton = ?', peloton).one().n;
      const before = count(repo);
      expect(before).toBeGreaterThan(2);
      instance.sql.exec(
        "UPDATE peloton_posts SET at = at - ? WHERE peloton = ? AND kind = 'checkin'",
        day + 1000,
        repo,
      );
      instance.sql.exec("UPDATE peloton_posts SET at = at - ? WHERE peloton = 'chase:pack'", 2 * day);
      instance.prunePeloton();
      // The three check-ins were over a day old.
      expect(count(repo)).toBe(before - 3);
      // Closed less than a day ago: the chase's posts stay, however old.
      expect(count('chase:pack')).toBe(3);
      instance.sql.exec("UPDATE features SET chase_ended = ? WHERE slug = 'pack'", Date.now() - day - 1000);
      instance.prunePeloton();
      expect(count('chase:pack')).toBe(0);
    });
  });
});
