import { describe, expect, it } from 'vitest';
import { commentsOf, view, withChanges } from '../src/model.js';
import { api, latestVersion, pushOps, twCreate } from './helpers.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const A = '1dd497fc-7d89-4c7b-adfb-b74856043b81';
const json = async (res) => ({ status: res.status, ...(await res.json()) });

describe('task structure in the model', () => {
  it('stores description, done when, and related the Taskwarrior way', () => {
    const map = withChanges(
      null,
      { description: 'A', brief: 'Why.', done_when: 'It ships.', by: 'owner', addRelated: [A] },
      NOW,
    );
    expect(map).toMatchObject({
      brief: 'Why.',
      brief_by: 'owner',
      done_when: 'It ships.',
      related: A,
      [`rel_${A}`]: 'x',
    });
    const v = view('u', map, new Map([['u', map]]), NOW);
    expect(v).toMatchObject({ brief: 'Why.', briefBy: 'owner', doneWhen: 'It ships.', related: [A] });
    expect(withChanges(map, { removeRelated: [A], brief: null }, NOW)).not.toHaveProperty('brief_by');
  });

  it('keeps who wrote a comment beside it, and shows an unsigned annotation as the owner', () => {
    let map = withChanges(null, { description: 'A' }, NOW);
    map = withChanges(map, { annotate: 'one', by: 'claude-x' }, NOW);
    map = withChanges(map, { annotate: 'two', by: 'board' }, NOW);
    expect(Object.keys(map).filter((k) => k.startsWith('by_')).length).toBe(2);
    map.annotation_1 = 'from task annotate';
    expect(commentsOf(map).map((c) => [c.by, c.text])).toEqual([
      ['owner', 'from task annotate'],
      ['claude-x', 'one'],
      ['board', 'two'],
    ]);
  });

  it('caps text at 10,000 characters', () => {
    expect(() => withChanges(null, { description: 'A', brief: 'x'.repeat(10001) }, NOW)).toThrow(/10000/u);
    expect(() => withChanges(null, { description: 'A', annotate: 'x'.repeat(10001) }, NOW)).toThrow(/10000/u);
  });

  it('hides a comment that repeats the description', () => {
    const map = withChanges(withChanges(null, { description: 'A', brief: 'Same' }, NOW), { annotate: 'Same' }, NOW);
    const v = view('u', map, new Map([['u', map]]), NOW);
    expect(v.comments).toEqual([]);
    expect(v.annotations).toHaveLength(1);
  });
});

describe('task structure through the API', () => {
  it('sets fields on create and update, shows related both ways, and summarises them in activity', async () => {
    const created = await json(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Structured one', project: 'ops', brief: 'The brief.', done_when: 'Done.', by: 'owner' },
          { description: 'Structured two', project: 'ops', related: ['OPS-1'] },
        ],
      }),
    );
    expect(created.tasks[0]).toMatchObject({ brief: 'The brief.', briefBy: 'owner', doneWhen: 'Done.' });
    const first = (await json(await api('tasks/OPS-1'))).task;
    expect(first.relatedTasks.map((t) => t.wid)).toEqual(['OPS-2']);
    await api('tasks/OPS-1', {
      method: 'PATCH',
      body: { brief: 'Better.', by: 'claude-a', done_when: 'Really done.' },
    });
    await api('tasks/OPS-1/annotate', { method: 'POST', body: { text: 'A finding', by: 'claude-a' } });
    const task = (await json(await api('tasks/OPS-1'))).task;
    expect(task.comments.at(-1)).toMatchObject({ by: 'claude-a', text: 'A finding' });
    const { events } = await json(await api('activity'));
    const kinds = events.filter((e) => e.task.wid === 'OPS-1').flatMap((e) => e.changes.map((c) => c.kind));
    expect(kinds).toEqual(expect.arrayContaining(['brief', 'done-when', 'note']));
    expect(events.find((e) => e.changes.some((c) => c.kind === 'note')).changes.find((c) => c.kind === 'note').by).toBe(
      'claude-a',
    );
  });
});

describe('the comments endpoint and the edit rule', () => {
  // The store is shared across tests in a file, so each test uses the work IDs it was given.
  const make = async (extra = {}) =>
    (await json(await api('tasks', { method: 'POST', body: [{ description: 'T', project: 'brand', ...extra }] })))
      .tasks[0].wid;

  it('adds comments with an author, keeps annotate as an alias, and signs the owner when nobody says', async () => {
    const id = await make();
    await api(`tasks/${id}/comments`, { method: 'POST', body: { text: 'first', by: 'claude-a' } });
    await api(`tasks/${id}/annotate`, { method: 'POST', body: { text: 'old client', by: 'claude-b' } });
    await api(`tasks/${id}/comments`, { method: 'POST', body: { text: 'from the web' } });
    const res = await json(
      await api(`tasks/${id}/comments`, { method: 'POST', body: { text: 'trigger', by: 'routine:nightly' } }),
    );
    expect(res.task.comments.map((c) => [c.by, c.text])).toEqual([
      ['claude-a', 'first'],
      ['claude-b', 'old client'],
      ['owner', 'from the web'],
      ['routine:nightly', 'trigger'],
    ]);
    expect(res.task.annotations).toHaveLength(4);
    expect((await api(`tasks/${id}/comments`, { method: 'POST', body: { text: '  ' } })).status).toBe(400);
    expect((await api(`tasks/${id}/comments`, { method: 'POST', body: { text: 'x', by: 'not a name!' } })).status).toBe(
      400,
    );
  });

  it('turns a note on create into the description, signed by whoever made it', async () => {
    const a = await make({ note: 'The idea.', by: 'owner' });
    expect((await json(await api(`tasks/${a}`))).task).toMatchObject({
      brief: 'The idea.',
      briefBy: 'owner',
      comments: [],
    });
    const b = await make({ brief: 'Brief.', note: 'Extra.', by: 'claude-a' });
    expect((await json(await api(`tasks/${b}`))).task).toMatchObject({
      brief: 'Brief.',
      comments: [{ by: 'claude-a', text: 'Extra.' }],
    });
  });

  it('sets related on update, replacing the list, and shows it both ways', async () => {
    const [a, b, c] = [await make(), await make(), await make()];
    await api(`tasks/${a}`, { method: 'PATCH', body: { related: [b] } });
    await api(`tasks/${a}`, { method: 'PATCH', body: { related: [c] } });
    expect((await json(await api(`tasks/${a}`))).task.relatedTasks.map((t) => t.wid)).toEqual([c]);
    expect((await json(await api(`tasks/${b}`))).task.relatedTasks).toEqual([]);
    expect((await json(await api(`tasks/${c}`))).task.relatedTasks.map((t) => t.wid)).toEqual([a]);
    expect((await api(`tasks/${a}`, { method: 'PATCH', body: { related: [a] } })).status).toBe(400);
  });

  it('lets an agent change the description only on a task it made or is refining', async () => {
    const owned = await make({ brief: 'Owner wrote this.', by: 'owner' });
    const mine = await make({ brief: 'Agent wrote this.', by: 'claude-a' });
    const edit = (ref, by) => api(`tasks/${ref}`, { method: 'PATCH', body: { brief: 'New.', done_when: 'Done.', by } });
    expect((await edit(owned, 'claude-a')).status).toBe(403);
    expect((await edit(mine, 'claude-b')).status).toBe(403);
    expect((await edit(mine, 'claude-a')).status).toBe(200);
    expect((await edit(owned, 'owner')).status).toBe(200);
    expect((await api(`tasks/${owned}`, { method: 'PATCH', body: { brief: 'Web edit.' } })).status).toBe(200);
    // Refining: the claim is the permission.
    expect((await edit(owned, 'claude-refine-x')).status).toBe(403);
    await api(`tasks/${owned}/claim`, { method: 'POST', body: { agent: 'claude-refine-x' } });
    expect((await edit(owned, 'claude-refine-x')).status).toBe(200);
    // Other fields aren't affected by the rule.
    expect((await api(`tasks/${mine}`, { method: 'PATCH', body: { horizon: 'next', by: 'claude-b' } })).status).toBe(
      200,
    );
  });
});

describe('the backfill', () => {
  it('copies a first note into the description, marks old notes, and does the same when run twice', async () => {
    const withNote = crypto.randomUUID();
    const late = crypto.randomUUID();
    const bare = crypto.randomUUID();
    await pushOps(await latestVersion(), [
      ...twCreate(withNote, {
        description: 'Old with note',
        project: 'debt',
        entry: '1790630931',
        annotation_1790630950: 'What it was made for',
        annotation_1790640000: 'Later finding',
      }),
      ...twCreate(late, {
        description: 'Old late note',
        project: 'debt',
        entry: '1790630931',
        annotation_1790700000: 'Only a late note',
      }),
      ...twCreate(bare, { description: 'Old bare', project: 'debt' }),
    ]);
    const first = await json(await api('backfill/structure', { method: 'POST', body: {} }));
    expect(first).toMatchObject({ status: 200, marked: 3 });
    expect(first.briefs).toBeGreaterThanOrEqual(1); // other tests' tasks with an early comment count too
    const a = (await json(await api(`tasks/${withNote}`))).task;
    expect(a.brief).toBe('What it was made for');
    expect(a.briefBy).toBeNull();
    expect(a.annotations).toHaveLength(2);
    expect(a.comments).toEqual([{ by: null, at: expect.any(String), text: 'Later finding' }]);
    expect((await json(await api(`tasks/${late}`))).task.brief).toBeNull();
    expect((await json(await api(`tasks/${bare}`))).task.brief).toBeNull();

    const second = await json(await api('backfill/structure', { method: 'POST', body: {} }));
    expect(second).toMatchObject({ briefs: 0, marked: 0 });
    expect((await json(await api(`tasks/${withNote}`))).task.brief).toBe('What it was made for');
  });

  it('shows an annotation added with task annotate as an owner comment', async () => {
    const uuid = crypto.randomUUID();
    await pushOps(
      await latestVersion(),
      twCreate(uuid, {
        description: 'Annotated in Taskwarrior',
        project: 'debt',
        annotation_1790631000: 'from the terminal',
      }),
    );
    const task = (await json(await api(`tasks/${uuid}`))).task;
    expect(task.comments).toEqual([{ by: 'owner', at: expect.any(String), text: 'from the terminal' }]);
  });
});
