import { describe, expect, it } from 'vitest';
import { filesNamed, similarLine, similarTasks, titleWords } from '../src/similar.js';
import { api } from './helpers.js';

// BRK-283: adding a task first hears of the open tasks it resembles.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const add = async (fields) => body(await api('tasks', { method: 'POST', body: { project: 'ops', ...fields } }));
const titles = (list) => list.map((m) => m.task.description);

describe('similar tasks, the pure part', () => {
  it('compares the words that say what a title is about', () => {
    expect([...titleWords('Adding a task shows similar open tasks first')].sort()).toEqual([
      'first',
      'open',
      'show',
      'similar',
    ]);
    expect(titleWords('A task')).toEqual(new Set());
  });

  it('reads the files and folders a text names, by name', () => {
    expect([...filesNamed('Touch src/store.js, store.js again, web/src/components/ and the README.md')].sort()).toEqual([
      'readme.md',
      'store.js',
      'web/src/components',
    ]);
    expect(filesNamed('and/or, a web/ folder, version 1.2')).toEqual(new Set());
  });

  it('finds a title that says the same thing, most alike first, and not one that shares a word', () => {
    const open = [
      { description: 'Sort the inbox by age' },
      { description: 'Sort the activity feed' },
      { description: 'Inbox sorting by age, oldest first' },
      { description: 'Publish security.txt' },
    ];
    expect(titles(similarTasks({ description: 'Sort inbox by age' }, open))).toEqual([
      'Sort the inbox by age',
      'Inbox sorting by age, oldest first',
    ]);
    expect(similarTasks({ description: 'Sort the roadmap' }, open)).toEqual([]);
    expect(similarTasks({ description: 'A task' }, open)).toEqual([]);
  });

  it('finds the same files named, in the title or the description', () => {
    const open = [
      { description: 'Cache the replica', brief: 'In src/replica.js and src/ops.js.' },
      { description: 'Quiet the replica logs', brief: 'src/replica.js logs every op.' },
      { description: 'Rename the sync key', brief: 'src/replica.js reads it.' },
    ];
    // Two files named by both, whatever the titles.
    expect(titles(similarTasks({ description: 'Faster startup', brief: 'replica.js and ops.js' }, open))).toEqual([
      'Cache the replica',
    ]);
    // One file and a title that's partly alike.
    expect(titles(similarTasks({ description: 'Log less from the replica', brief: 'src/replica.js' }, open))).toEqual(
      ['Quiet the replica logs', 'Cache the replica'],
    );
    // One file and nothing else in common isn't enough.
    expect(similarTasks({ description: 'Count versions', brief: 'src/replica.js' }, open)).toEqual([]);
  });

  it('says each one in a line, with who has it', () => {
    expect(similarLine({ wid: 'OPS-3', description: 'Fix it', claim: 'claude-a' })).toBe(
      'OPS-3 Fix it (claimed by claude-a)',
    );
    expect(similarLine({ wid: null, short: 'abcd1234', description: 'Fix it', claim: null })).toBe('abcd1234 Fix it');
  });
});

describe('adding a task that resembles an open one', () => {
  it('refuses it with the open tasks it resembles, and who has them', async () => {
    const first = (await add({ description: 'Rotate the pager every week' })).tasks[0];
    await api(`tasks/${first.wid}/claim`, { method: 'POST', body: { agent: 'claude-a' } });
    const res = await add({ description: 'Rotate the pager weekly' });
    expect(res.status).toBe(409);
    expect(res.error).toMatch(
      new RegExp(`resembles open tasks: ${first.wid} Rotate the pager every week \\(claimed by claude-a\\)`, 'u'),
    );
    expect(res.similar).toEqual([
      expect.objectContaining({ uuid: first.uuid, wid: first.wid, claim: 'claude-a', description: first.description }),
    ]);
    const all = (await body(await api('tasks'))).tasks.map((t) => t.description);
    expect(all).not.toContain('Rotate the pager weekly');
  });

  it('adds it with force, or linked to them as related or as what it waits for', async () => {
    const forced = await add({ description: 'Rotate the pager weekly', force: true });
    expect(forced.status).toBe(201);
    expect(forced.tasks[0]).not.toHaveProperty('force');
    const open = (await body(await api('tasks'))).tasks.filter((t) => /Rotate the pager/u.test(t.description));
    const ids = open.map((t) => t.wid);
    const related = await add({ description: 'Rotate the pager on Mondays', related: ids });
    expect(related.status).toBe(201);
    expect(related.tasks[0].related.sort()).toEqual(open.map((t) => t.uuid).sort());
    // Linking only some of them still names the rest.
    const partly = await add({ description: 'Rotate the pager on Fridays', depends: [ids[0]] });
    expect(partly.status).toBe(409);
    expect(partly.similar.map((t) => t.wid)).not.toContain(ids[0]);
  });

  it('compares only open tasks of the same repository, and leaves ideas and runs alone', async () => {
    const done = (await add({ description: 'Archive the old dashboards' })).tasks[0];
    await api(`tasks/${done.wid}/done`, { method: 'POST', body: {} });
    expect((await add({ description: 'Archive old dashboards' })).status).toBe(201);

    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GDG'] },
    });
    expect(registered.status).toBe(201);
    const there = await add({ description: 'Archive the old dashboards', repo: 'gadgets', project: 'product' });
    expect(there.status).toBe(201);

    const idea = { project: 'ideas', tags: ['idea', 'horizon-auto'] };
    expect((await add({ description: 'A dashboard for the pager', ...idea })).status).toBe(201);
    expect((await add({ description: 'A dashboard for the pager', ...idea })).status).toBe(201);
    expect((await add({ description: 'Dashboard for the pager' })).status).toBe(201);
  });

  it('checks each task of a batch, and adds none when one is refused', async () => {
    const before = (await body(await api('tasks'))).tasks.length;
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Write the restore drill', project: 'ops' },
          { description: 'Rotate the pager each week', project: 'ops' },
        ],
      }),
    );
    expect(res.status).toBe(409);
    expect((await body(await api('tasks'))).tasks).toHaveLength(before);
  });
});
