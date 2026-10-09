import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// Agents close their open questions before they leave (BRK-281): the posts to an agent it hasn't answered or handed
// over, listed by `peloton open`, by release, and by a listen that says to stop, and noted on the task when it leaves.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const enc = encodeURIComponent;

const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
const release = async (wid, agent) => body(await api(`tasks/${wid}/release`, { method: 'POST', body: { agent } }));
const comment = (wid, text, by) => api(`tasks/${wid}/annotate`, { method: 'POST', body: { text, by } });
const open = async (agent, task) =>
  body(await api(`peloton/open?agent=${enc(agent)}${task ? `&task=${enc(task)}` : ''}`));
const listen = async (agent) => body(await api(`peloton/listen?agent=${enc(agent)}`));
const show = async (wid) => body(await api(`tasks/${wid}`));
const ids = (posts) => posts.map((p) => p.id);

describe('open posts when an agent leaves (BRK-281)', () => {
  let repo;
  let spy;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: ['Leaver one', 'Asker two', 'Merger three'].map((description) => ({
          description,
          project: 'product',
          tags: ['agent'],
          horizon: 'now',
        })),
      }),
    );
    expect(created.tasks.map((t) => t.wid)).toEqual(['PRD-1', 'PRD-2', 'PRD-3']);
    repo = created.tasks[0].repo;
    for (const n of [1, 2, 3]) expect((await claim(`PRD-${n}`, `claude-prd-${n}`)).status).toBe(200);
  });
  afterAll(() => spy.mockRestore());

  it('lists the posts to an agent until it answers or hands each over, and release lists what’s left', async () => {
    const checkin = await post(repo, { agent: 'claude-prd-1', kind: 'checkin', text: 'PRD-1: the leaver.' });
    expect(checkin.status).toBe(201);
    await post(repo, { agent: 'claude-prd-2', kind: 'checkin', text: 'PRD-2: the asker.' });
    expect((await open('claude-prd-1')).posts).toEqual([]);

    // A mention, a reply to its post, a post that only mentions someone else, and the board's own line.
    const asked = await post(repo, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 does the list sort?' });
    const replied = await post(repo, {
      agent: 'claude-prd-2',
      kind: 'reply',
      reply_to: checkin.post.id,
      text: 'Which file first?',
    });
    const handed = await post(repo, { agent: 'claude-prd-2', kind: 'ask', text: '@claude-prd-1 and the empty state?' });
    await post(repo, { agent: 'claude-prd-1', kind: 'note', text: '@claude-prd-2 heads-up: I touch the store.' });
    const first = await open('claude-prd-1');
    expect(first.task).toBe('PRD-1');
    expect(ids(first.posts)).toEqual([asked.post.id, replied.post.id, handed.post.id]);
    expect(first.posts[0]).toMatchObject({ agent: 'claude-prd-2', text: '@claude-prd-1 does the list sort?' });

    // Answering one on the peloton closes it; a thank-you to that answer opens nothing.
    const answer = await post(repo, {
      agent: 'claude-prd-1',
      kind: 'reply',
      reply_to: asked.post.id,
      text: 'It does.',
    });
    await post(repo, { agent: 'claude-prd-2', kind: 'reply', reply_to: answer.post.id, text: 'Thanks @claude-prd-1.' });
    // Handing one over is a comment of its own on its task naming the post; someone else's comment doesn't.
    await comment('PRD-1', `Handed over peloton #${handed.post.id}: PRD-9 follows it up.`, 'claude-prd-1');
    await comment('PRD-1', `peloton #${replied.post.id} looks open`, 'claude-prd-2');
    expect(ids((await open('claude-prd-1')).posts)).toEqual([replied.post.id]);

    // Release gives the task back and lists what's still open.
    const released = await release('PRD-1', 'claude-prd-1');
    expect(released.status).toBe(200);
    expect(released.task.claim).toBeFalsy();
    expect(ids(released.open)).toEqual([replied.post.id]);

    // The next read sweeps it off the roster: its leave post says so, and the task keeps the list once.
    const room = await body(await api(`peloton/${enc(repo)}`));
    const left = room.posts.filter((p) => p.kind === 'leave' && p.agent === 'claude-prd-1');
    expect(left.map((p) => p.text)).toEqual([
      `Left: released PRD-1, with a post to it unanswered (#${replied.post.id}).`,
    ]);
    await body(await api(`peloton/${enc(repo)}`));
    const notes = (await show('PRD-1')).task.comments.filter((a) => a.by === 'board');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe(
      `claude-prd-1 left with a post to it unanswered on the peloton:\n- peloton #${replied.post.id} on ${repo}, from claude-prd-2: Which file first?`,
    );

    // A handover after leaving still closes it: the comment route doesn't need the claim.
    await comment('PRD-1', `Handed over peloton #${replied.post.id}: claude-prd-2 picks the file.`, 'claude-prd-1');
    expect((await open('claude-prd-1', 'PRD-1')).posts).toEqual([]);
  });

  it('lists what’s open when a listen says to stop because the pull request merged', async () => {
    const checkin = await post(repo, { agent: 'claude-prd-3', kind: 'checkin', text: 'PRD-3: the merger.' });
    const asked = await post(repo, {
      agent: 'claude-prd-2',
      kind: 'reply',
      reply_to: checkin.post.id,
      text: 'Will you add the test?',
    });
    expect((await api('tasks/PRD-3', { method: 'PATCH', body: { pr: 7 } })).status).toBe(200);
    expect((await api('tasks/PRD-3/done', { method: 'POST', body: {} })).status).toBe(200);
    const heard = await listen('claude-prd-3');
    expect(heard.stop).toBeTruthy();
    expect(ids(heard.open)).toEqual([asked.post.id]);
    const room = await body(await api(`peloton/${enc(repo)}`));
    expect(room.posts.find((p) => p.kind === 'leave' && p.agent === 'claude-prd-3').text).toBe(
      `Left: PRD-3’s pull request #7 merged, with a post to it unanswered (#${asked.post.id}).`,
    );
  });

  it('asks for an agent’s name', async () => {
    expect((await api('peloton/open?agent=')).status).toBe(400);
  });
});
