import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDigest,
  digestHeadline,
  digestMessage,
  digestQuiet,
  ownerOrder,
  screenshotsIn,
} from '../src/chase-digest.js';
import { api } from './helpers.js';

// A chase's digest (docs/specs/BRK-277-chase-digest.md): once an hour while it runs and once when it ends, what merged
// (with its screenshots), what waits for the owner in order, what's stuck, what starts next, and the captain's lines.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
let next = 1;

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const chase = async (slug, input = {}) => body(await api(`features/${slug}/chase`, { method: 'POST', body: input }));
const feature = async (slug) => (await body(await api(`features/${slug}`))).feature;
const digest = async (slug, id) => body(await api(`features/${slug}/digests/${id}`));
const tick = () => runInDurableObject(stub(), (instance) => instance.chaseTick());
const sql = (query, ...args) => runInDurableObject(stub(), (instance) => instance.sql.exec(query, ...args).toArray());
/** Moves the chase's clock back an hour and a bit: its start, its captain's lines, and every digest it wrote. */
const hourPasses = async (slug) => {
  await sql(
    'UPDATE features SET chase_started = chase_started - 3700000, chase_digest_note_at = chase_digest_note_at - 3700000 WHERE slug = ?',
    slug,
  );
  await sql('UPDATE chase_digests SET at = at - 3700000 WHERE slug = ?', slug);
};

describe('what a digest says', () => {
  it('finds the screenshots in a pull request’s description, on GitHub only, each once, at most four', () => {
    const text = [
      '## What changed',
      '![The inbox, in carbon](https://github.com/user-attachments/assets/1a2b3c)',
      '<img width="600" alt="The inbox, in chalk" src="https://private-user-images.githubusercontent.com/1/2.png?x=1">',
      '![again](https://github.com/user-attachments/assets/1a2b3c)',
      '![elsewhere](https://example.com/shot.png)',
      '![a page, not an image](https://github.com/acme/widgets/blob/main/shot.png)',
      '![plain](http://github.com/user-attachments/assets/9)',
      '![odd](javascript:alert(1))',
      '![three](https://user-images.githubusercontent.com/3.png)',
      '![four](https://github.com/user-attachments/assets/4)',
      '![five](https://github.com/user-attachments/assets/5)',
    ].join('\n');
    expect(screenshotsIn(text)).toEqual([
      { url: 'https://github.com/user-attachments/assets/1a2b3c', alt: 'The inbox, in carbon' },
      { url: 'https://private-user-images.githubusercontent.com/1/2.png?x=1', alt: 'The inbox, in chalk' },
      { url: 'https://user-images.githubusercontent.com/3.png', alt: 'three' },
      { url: 'https://github.com/user-attachments/assets/4', alt: 'four' },
    ]);
    expect(screenshotsIn(null)).toEqual([]);
    expect(screenshotsIn('No screenshots here.')).toEqual([]);
  });

  it('puts what waits for the owner in order: priority, then what it frees, then merges first', () => {
    const order = ownerOrder([
      { wid: 'A', kind: 'person', priority: null, unblocks: 5 },
      { wid: 'B', kind: 'decision', priority: 'M', unblocks: 0 },
      { wid: 'C', kind: 'merge', priority: 'M', unblocks: 0 },
      { wid: 'D', kind: 'person', priority: 'H', unblocks: 0 },
      { wid: 'E', kind: 'decision', priority: 'M', unblocks: 2 },
    ]);
    expect(order.map((x) => x.wid)).toEqual(['D', 'E', 'C', 'B', 'A']);
  });

  it('says it in a line, and pushes a link to its page', () => {
    const base = {
      feature: { slug: 'crew', title: 'Crew' },
      kind: /** @type {const} */ ('hourly'),
      from: Date.parse('2026-10-09T10:00:00Z'),
      to: Date.parse('2026-10-09T11:00:00Z'),
      summary: '1 running, 0 ready',
      merged: [],
      needsYou: [],
      stuck: [],
      queue: [],
    };
    const quiet = buildDigest(base);
    expect(digestQuiet(quiet)).toBe(true);
    expect(digestHeadline(quiet)).toBe('Nothing new: 1 running, 0 ready');
    const busy = buildDigest({
      ...base,
      merged: [
        {
          wid: 'OPS-2',
          description: 'Two',
          repo: 'widgets',
          pr: 9,
          title: 'OPS-2: Two',
          url: null,
          mergedAt: '2026-10-09T10:40:00Z',
        },
        {
          wid: 'OPS-1',
          description: 'One',
          repo: 'widgets',
          pr: 8,
          title: 'OPS-1: One',
          url: null,
          mergedAt: '2026-10-09T10:20:00Z',
        },
      ],
      needsYou: [{ uuid: 'u', wid: 'OPS-3', description: 'Three', kind: 'decision', why: 'it waits on your decision' }],
    });
    expect(busy.merged.map((m) => m.wid)).toEqual(['OPS-1', 'OPS-2']);
    expect(busy.merged[0].screenshots).toEqual([]);
    expect(digestQuiet(busy)).toBe(false);
    expect(digestHeadline(busy)).toBe('2 merged, 1 waits for you');
    expect(digestMessage({ ...busy, id: 7 }, 'breakaway')).toEqual({
      title: 'breakaway',
      body: 'Digest of the chase on Crew\n2 merged, 1 waits for you',
      tag: 'digest-crew',
      url: '/#/roadmap?feature=crew&digest=7',
    });
    const last = buildDigest({ ...base, kind: 'final', ended: 'The chase stopped.' });
    expect(digestQuiet(last)).toBe(false);
    expect(digestHeadline(last)).toBe('The chase stopped.');
    expect(digestMessage({ ...last, id: 8 }, 'breakaway').body).toBe(
      'Last digest of the chase on Crew\nThe chase stopped.',
    );
  });
});

describe('a chase’s digest (BRK-277)', () => {
  let spy;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === FIRE) {
        const id = `session_d${String(next++).padStart(3, '0')}`;
        return Response.json({
          type: 'routine_fire',
          claude_code_session_id: id,
          claude_code_session_url: `https://claude.ai/code/${id}`,
        });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    });
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Build the thing', project: 'ops', who: 'agent', tags: ['dig'], horizon: 'now' },
          {
            description: 'Turn on the key',
            project: 'ops',
            who: 'person',
            assignee: 'owner',
            tags: ['dig'],
            horizon: 'now',
            priority: 'M',
          },
          { description: 'Pick a name', project: 'ops', who: 'decision', tags: ['dig'], horizon: 'now', priority: 'H' },
          {
            description: 'Build on it',
            project: 'ops',
            who: 'agent',
            tags: ['dig'],
            horizon: 'now',
            depends: ['OPS-1'],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect((await api('features', { method: 'POST', body: { slug: 'dig', title: 'Dig' } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } });
  });
  afterAll(() => spy.mockRestore());

  it('is the owner’s to push, and off until they turn it on', async () => {
    expect((await chase('dig', { digestPush: 'yes' })).status).toBe(400);
    expect((await chase('dig', { digestPush: true, by: 'claude-x-1' })).status).toBe(403);
    expect((await feature('dig')).chase.digest).toEqual({ push: false, list: [] });
  });

  it('writes nothing in the chase’s first hour', async () => {
    const res = await chase('dig', { on: true, captain: true });
    expect(res.status).toBe(200);
    expect(res.started).toEqual(['OPS-1']);
    await tick();
    expect((await feature('dig')).chase.digest.list).toEqual([]);
  });

  it('takes the road captain’s lines for the next digest, from the captain only', async () => {
    const captain = (await feature('dig')).chase.captain.agent;
    expect(captain).toBe('claude-captain-dig-1');
    const post = (input) => api('features/dig/captain', { method: 'POST', body: input }).then(body);
    expect((await post({ digest: 'Lines', by: 'claude-x-1' })).status).toBe(403);
    expect((await post({ digest: ' ', by: captain })).status).toBe(400);
    expect((await post({ digest: 'x'.repeat(601), by: captain })).status).toBe(400);
    expect((await post({ digest: 'Lines', log: 'Log', by: captain })).status).toBe(400);
    const res = await post({
      digest: 'OPS-1 is close. Pick a name first: it holds the copy.',
      by: captain,
    });
    expect(res.status).toBe(200);
    expect(res.digest.text).toBe('OPS-1 is close. Pick a name first: it holds the copy.');
  });

  it('after an hour, says what merged with its screenshots, what waits for the owner in order, and what’s next', async () => {
    const mergedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await sql(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', 41, ?, 'merged', ?)",
      mergedAt,
      JSON.stringify({
        number: 41,
        title: 'OPS-1: Build the thing',
        state: 'merged',
        url: 'https://github.com/acme/widgets/pull/41',
        mergedAt,
        closes: ['OPS-1'],
        mentions: [],
        checks: { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
        images: [{ url: 'https://github.com/user-attachments/assets/41', alt: 'The thing' }],
      }),
    );
    // One merged before the chase's stretch, which an earlier digest would have had.
    await sql(
      "INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', 40, '2026-01-01T00:00:00Z', 'merged', ?)",
      JSON.stringify({
        number: 40,
        title: 'Old',
        state: 'merged',
        mergedAt: '2026-01-01T00:00:00Z',
        closes: ['OPS-2'],
        mentions: [],
        checks: { state: 'success', total: 1, passed: 1, runs: [] },
        review: { decision: null, comments: 0 },
      }),
    );
    await hourPasses('dig');
    await tick();
    const { list } = (await feature('dig')).chase.digest;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'hourly', counts: { merged: 1, waiting: 2, stuck: 0 } });

    const { status, digest: d } = await digest('dig', list[0].id);
    expect(status).toBe(200);
    expect(d).toMatchObject({ feature: 'dig', title: 'Dig', kind: 'hourly', ended: null });
    expect(d.merged).toEqual([
      {
        wid: 'OPS-1',
        description: 'Build the thing',
        repo: 'widgets',
        pr: 41,
        title: 'OPS-1: Build the thing',
        url: 'https://github.com/acme/widgets/pull/41',
        mergedAt,
        screenshots: [{ url: 'https://github.com/user-attachments/assets/41', alt: 'The thing' }],
      },
    ]);
    // The decision is H, the step M: the decision first.
    expect(d.waiting.map((x) => [x.wid, x.kind])).toEqual([
      ['OPS-3', 'decision'],
      ['OPS-2', 'person'],
    ]);
    expect(d.stuck).toEqual([]);
    expect(d.summary).toMatch(/running/u);
    expect(d.captain).toMatchObject({
      agent: 'claude-captain-dig-1',
      text: 'OPS-1 is close. Pick a name first: it holds the copy.',
    });
    expect((await digest('dig', 999)).status).toBe(404);
    expect((await digest('dig', 'x')).status).toBe(404);
  });

  it('writes one an hour, not one a tick, and carries the captain’s lines once', async () => {
    await tick();
    expect((await feature('dig')).chase.digest.list).toHaveLength(1);
    await hourPasses('dig');
    await tick();
    const { list } = (await feature('dig')).chase.digest;
    expect(list).toHaveLength(2);
    const d = (await digest('dig', list[0].id)).digest;
    expect(d.captain).toBeNull();
  });

  it('shows the newest in the inbox, one per chase, until the owner clears it', async () => {
    const { digests } = await body(await api('pings'));
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ feature: 'dig', title: 'Dig', kind: 'hourly', counts: { waiting: 2 } });
    expect(digests[0].waiting[0]).toMatchObject({ wid: 'OPS-3' });
    expect((await chase('dig', { dismissDigests: true })).status).toBe(200);
    expect((await body(await api('pings'))).digests).toEqual([]);
  });

  it('pushes only when the owner asked, only with something in it, and at most once an hour', async () => {
    expect((await chase('dig', { digestPush: true })).chase.digest.push).toBe(true);
    const pushed = await runInDurableObject(stub(), async (instance) => {
      const sent = [];
      instance.pushToOwner = async (message) => {
        sent.push(message);
      };
      const row = instance.featureRow('dig');
      const plan = instance.chaseQueue(row, instance.views(), null);
      const first = await instance.chaseDigestWrite(row, plan);
      await instance.chaseDigestWrite(row, plan);
      // Nothing for the owner: never pushed, whenever it comes.
      instance.sql.exec('UPDATE chase_digests SET at = at - 3700000');
      instance.sql.exec("DELETE FROM gh_pulls WHERE state = 'merged'");
      await instance.chaseDigestWrite(row, { ...plan, needsYou: [], stuck: [] });
      return { sent, first };
    });
    expect(pushed.sent).toEqual([
      {
        title: expect.any(String),
        body: 'Digest of the chase on Dig\n2 wait for you',
        tag: 'digest-dig',
        url: `/#/roadmap?feature=dig&digest=${pushed.first}`,
      },
    ]);
    await chase('dig', { digestPush: false });
  });

  it('writes its last when the chase stops', async () => {
    const res = await chase('dig', { on: false });
    expect(res.status).toBe(200);
    const { list } = res.chase.digest;
    expect(list[0]).toMatchObject({ kind: 'final' });
    expect(list[0].headline).toMatch(/^The chase stopped\./u);
    expect((await body(await api('pings'))).digests[0]).toMatchObject({ kind: 'final' });
  });
});
