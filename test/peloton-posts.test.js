import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { looksLikeSecret } from '../src/ping.js';

// Planning on the peloton's posts (docs/specs/IDEA-36-peloton-planning.md, sections 2, 3, 7, and 10; BRK-211).

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const enc = encodeURIComponent;

const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const detail = async (peloton) => body(await api(`peloton/${enc(peloton)}`));
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
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
/** A post from the signed-in board: the owner's. */
const ownerPost = async (peloton, input) =>
  body(
    await SELF.fetch(`${ORIGIN}/api/peloton/${enc(peloton)}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
/** Marks everything on `agent`'s pelotons seen, so a test starts from nothing waiting. */
const catchUp = (wid, agent) => hookPost(wid, agent);

describe('peloton posts: kinds, mentions, limits, and the owner (IDEA-36)', () => {
  let repo;
  let spy;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Crew one', project: 'product', tags: ['agent', 'crew'], horizon: 'now' },
          { description: 'Crew two', project: 'product', tags: ['agent', 'crew'], horizon: 'now' },
          { description: 'Solo three', project: 'product', tags: ['agent'], horizon: 'now' },
          {
            description: 'Road captain for Crew',
            project: 'product',
            tags: ['agent', 'general', 'crew'],
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
    cookie = await signIn();
  });
  afterAll(() => spy.mockRestore());

  describe('file paths aren’t tokens', () => {
    it('lets paths and links through', () => {
      for (const text of [
        'Touching docs/specs/IDEA-36-peloton-planning.md and src/store-peloton.js',
        'see web/src/components/PelotonPanel.jsx, .agents/skills/tasks/SKILL.md, and test/peloton-posts.test.js',
        'https://github.com/acme/widgets/pull/260 and https://github.com/acme/widgets/commit/0123456789abcdef0123456789abcdef01234567',
        'docs/releases/v1.5.0.md and plugin/skills/tasks/SKILL.md',
      ])
        expect(looksLikeSecret(text), text).toBe(false);
    });

    it('still refuses tokens and keys, with or without slashes', () => {
      for (const text of [
        'I used ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'the key is Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3Fg5Hj0Ks2Lq8Mw4N',
        'secret: aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v/W1xY3Za5c7e9g1i3k5m7o9q1s3u5',
        'stored at keys/Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3Fg5Hj0Ks2Lq8Mw4N',
        'b64 q8Zr/Kd93Jx+Lp2Wm7Tn4Vb6Yc1Ha5Gf0Es3Qw9Ru8Ti2Ok7Pl==',
        'Bearer abcdefghijklmnopqrstuvwxyz012345',
      ])
        expect(looksLikeSecret(text), text).toBe(true);
    });

    it('takes a post naming a spec', async () => {
      const res = await post(repo, {
        agent: 'claude-prd-1',
        kind: 'checkin',
        text: 'On PRD-1: docs/specs/IDEA-36-peloton-planning.md and src/store-peloton.js',
      });
      expect(res.status).toBe(201);
    });
  });

  describe('kinds', () => {
    it('takes note, ask, propose, and review', async () => {
      for (const kind of ['note', 'ask', 'propose', 'review']) {
        const res = await post(repo, { agent: 'claude-prd-1', kind, text: `A ${kind}` });
        expect(res.status, kind).toBe(201);
        expect(res.post).toMatchObject({ kind, text: `A ${kind}`, agent: 'claude-prd-1', task: 'PRD-1' });
      }
    });

    it('refuses kinds it doesn’t know, and the ones the board writes', async () => {
      for (const kind of ['shout', 'open', 'close', 'plan']) {
        const res = await post(repo, { agent: 'claude-prd-1', kind, text: 'Hi' });
        expect(res.status, kind).toBe(400);
        expect(res.error).toMatch(/kind is one of .*note, ask, propose, review/);
      }
    });
  });

  describe('limits', () => {
    it('takes 2,000 characters a post', async () => {
      expect((await post(repo, { agent: 'claude-prd-1', kind: 'note', text: 'x'.repeat(2000) })).status).toBe(201);
      const over = await post(repo, { agent: 'claude-prd-1', kind: 'note', text: 'x'.repeat(2001) });
      expect(over.status).toBe(400);
      expect(over.error).toMatch(/up to 2,000 characters/);
    });

    it('takes 120 posts an agent an hour', async () => {
      await runInDurableObject(store(), (instance) => {
        const now = Date.now();
        const made = instance.sql
          .exec(
            "SELECT COUNT(*) AS n FROM peloton_posts WHERE agent = 'claude-prd-3' AND kind != 'leave' AND at > ?",
            now - 3_600_000,
          )
          .one().n;
        for (let i = made; i < 119; i += 1)
          instance.sql.exec(
            "INSERT INTO peloton_posts (peloton, at, agent, kind, text) VALUES ('elsewhere', ?, 'claude-prd-3', 'note', 'x')",
            now - 60_000,
          );
      });
      expect((await post(repo, { agent: 'claude-prd-3', kind: 'note', text: 'The 120th' })).status).toBe(201);
      const over = await post(repo, { agent: 'claude-prd-3', kind: 'note', text: 'The 121st' });
      expect(over.status).toBe(429);
      expect(over.error).toMatch(/120 posts in the last hour/);
      await runInDurableObject(store(), (instance) => {
        instance.sql.exec("DELETE FROM peloton_posts WHERE peloton = 'elsewhere'");
        instance.sql.exec("UPDATE peloton_posts SET at = at - 7200000 WHERE agent = 'claude-prd-3'");
      });
    });

    it('keeps 1,000 posts on a chase’s peloton and 200 on a repository’s', async () => {
      await runInDurableObject(store(), (instance) => {
        const count = (peloton) =>
          instance.sql.exec('SELECT COUNT(*) AS n FROM peloton_posts WHERE peloton = ?', peloton).one().n;
        for (let i = 0; i < 1010; i += 1)
          instance.addPost('chase:flood', { agent: 'claude-x', kind: 'note', text: `n${i}` });
        for (let i = 0; i < 210; i += 1) instance.addPost('flood', { agent: 'claude-x', kind: 'note', text: `n${i}` });
        expect(count('chase:flood')).toBe(1000);
        expect(count('flood')).toBe(200);
        const oldest = (peloton) =>
          instance.sql.exec('SELECT text FROM peloton_posts WHERE peloton = ? ORDER BY id LIMIT 1', peloton).one().text;
        expect(oldest('chase:flood')).toBe('n10');
        expect(oldest('flood')).toBe('n10');
        instance.sql.exec("DELETE FROM peloton_posts WHERE peloton IN ('flood', 'chase:flood')");
      });
    });
  });

  describe('the owner’s posts', () => {
    it('come from the signed-in board, stored as owner', async () => {
      const res = await ownerPost(repo, { kind: 'note', text: 'Keep the migration small, please' });
      expect(res.status).toBe(201);
      expect(res.post).toMatchObject({ agent: 'owner', task: null, kind: 'note', peloton: repo });
      expect((await detail(repo)).posts.at(-1)).toMatchObject({
        agent: 'owner',
        text: 'Keep the migration small, please',
      });
      // Any kind an agent talks with, and replies.
      const reply = await ownerPost(repo, { kind: 'reply', text: 'Yes', reply_to: res.post.id });
      expect(reply).toMatchObject({ status: 201, post: { kind: 'reply', replyTo: res.post.id } });
    });

    it('never come with the bearer token', async () => {
      for (const agent of ['owner', 'board', 'Owner']) {
        const res = await post(repo, { agent, kind: 'note', text: 'I’m the owner' });
        expect(res.status, agent).toBe(403);
        expect(res.error).toMatch(/owner and board/);
      }
      // Without an agent, the token's post is nobody's.
      expect((await post(repo, { kind: 'note', text: 'Who am I' })).status).toBe(400);
    });

    it('never post as an agent, check in, or carry a token', async () => {
      const as = await ownerPost(repo, { agent: 'claude-prd-1', kind: 'note', text: 'Hi' });
      expect(as.status).toBe(400);
      expect(as.error).toMatch(/as the owner/);
      for (const kind of ['checkin', 'leave', 'plan'])
        expect((await ownerPost(repo, { kind, text: 'Hi' })).status, kind).toBe(400);
      const secret = await ownerPost(repo, { kind: 'note', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
      expect(secret.status).toBe(400);
      expect(secret.error).toMatch(/token or key/);
      expect((await ownerPost('nowhere', { kind: 'note', text: 'Hi' })).status).toBe(404);
    });
  });

  describe('mentions', () => {
    it('keeps the names of riders a post mentions', async () => {
      const res = await post(repo, {
        agent: 'claude-prd-1',
        kind: 'ask',
        text: '@claude-prd-2, are you on src/runbook.js? (@nobody, @captain, and @CLAUDE-PRD-3.)',
      });
      expect(res.status).toBe(201);
      // @captain means the chase's road captain: a repository's peloton has none.
      expect(res.post.mentions).toEqual(['claude-prd-2', 'claude-prd-3']);
      expect((await detail(repo)).posts.at(-1).mentions).toEqual(['claude-prd-2', 'claude-prd-3']);
      // A post without any has none.
      const plain = await post(repo, { agent: 'claude-prd-1', kind: 'note', text: 'mail me at a@b' });
      expect(plain.post.mentions).toEqual([]);
    });

    it('reads @captain on a chase’s peloton as its road captain', async () => {
      expect((await api('features', { method: 'POST', body: { slug: 'crew' } })).status).toBe(201);
      expect((await api('features/crew/chase', { method: 'POST', body: { on: true } })).status).toBe(200);
      const res = await post('chase:crew', { agent: 'claude-prd-1', kind: 'ask', text: '@captain which goes first?' });
      expect(res.status).toBe(201);
      expect(res.post.mentions).toEqual(['claude-captain-4']);
      // claude-prd-3 isn't in the chase, so it isn't a rider there.
      const other = await post('chase:crew', {
        agent: 'claude-prd-2',
        kind: 'note',
        text: '@claude-prd-3 @claude-prd-1',
      });
      expect(other.post.mentions).toEqual(['claude-prd-1']);
    });
  });

  describe('delivery', () => {
    it('hands over the owner’s posts, then mentions and replies, then the rest, 5 at a time outside a chase', async () => {
      await catchUp('PRD-3', 'claude-prd-3');
      const mine = await post(repo, { agent: 'claude-prd-3', kind: 'note', text: 'Moving src/runbook.js' });
      const ids = [];
      for (let i = 1; i <= 3; i += 1)
        ids.push((await post(repo, { agent: 'claude-prd-1', kind: 'note', text: `Rest ${i}` })).post.id);
      const mention = (await post(repo, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-3 when?' })).post.id;
      const reply = (
        await post(repo, { agent: 'claude-prd-1', kind: 'reply', text: 'After me', reply_to: mine.post.id })
      ).post.id;
      const owner = (await ownerPost(repo, { kind: 'note', text: 'From the owner' })).post.id;
      ids.push((await post(repo, { agent: 'claude-prd-1', kind: 'note', text: 'Rest 4' })).post.id);

      const hook = await hookPost('PRD-3', 'claude-prd-3');
      expect(hook.peloton.map((p) => p.id)).toEqual([owner, mention, reply, ids[0], ids[1]]);
      expect(hook.peloton.map((p) => p.urgent)).toEqual([true, true, true, false, false]);
      expect(hook.peloton[1]).toMatchObject({ mentionsYou: true, toYou: false });
      expect(hook.peloton[2]).toMatchObject({ mentionsYou: false, toYou: true });
      expect(hook.pelotonMore).toBe(2);
      // Each once.
      const again = await hookPost('PRD-3', 'claude-prd-3');
      expect(again).toMatchObject({ peloton: [], pelotonMore: 0 });
    });

    it('hands over 10 at a time in a chase', async () => {
      await catchUp('PRD-1', 'claude-prd-1');
      for (let i = 1; i <= 12; i += 1) await post('chase:crew', { agent: 'claude-prd-2', kind: 'note', text: `C${i}` });
      const hook = await hookPost('PRD-1', 'claude-prd-1');
      expect(hook.peloton).toHaveLength(10);
      expect(hook.pelotonMore).toBe(2);
    });
  });

  describe('the wait route', () => {
    it('stays quiet for other posts', async () => {
      await catchUp('PRD-3', 'claude-prd-3');
      await post(repo, { agent: 'claude-prd-1', kind: 'note', text: 'Just saying' });
      expect((await waiting('PRD-3', 'claude-prd-3')).peloton).toEqual([]);
    });

    it('wakes an agent for the owner’s post', async () => {
      await ownerPost(repo, { kind: 'ask', text: 'Where are we?' });
      const woke = await waiting('PRD-3', 'claude-prd-3');
      expect(woke.peloton.map((p) => [p.agent, p.urgent])).toEqual([
        ['owner', true],
        ['claude-prd-1', false],
      ]);
      expect((await waiting('PRD-3', 'claude-prd-3')).peloton).toEqual([]);
    });

    it('wakes an agent for a mention of it', async () => {
      await post(repo, { agent: 'claude-prd-1', kind: 'ask', text: '@claude-prd-2 has it' });
      expect((await waiting('PRD-3', 'claude-prd-3')).peloton).toEqual([]);
      await post(repo, { agent: 'claude-prd-1', kind: 'ask', text: '@claude-prd-3 are you done?' });
      const woke = await waiting('PRD-3', 'claude-prd-3');
      expect(woke.peloton.map((p) => [p.text, p.mentionsYou])).toEqual([
        ['@claude-prd-3 are you done?', true],
        ['@claude-prd-2 has it', false],
      ]);
    });
  });
});
