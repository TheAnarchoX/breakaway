import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const add = async (slug, extra = {}) => body(await api('features', { method: 'POST', body: { slug, ...extra } }));
const tagsOf = async (ref) => (await body(await api(`tasks/${ref}`))).task.tags;

// A feature made from a group of the Dependencies view, or part of one (WEB-15).
describe('features made from a group', () => {
  it('sets up a board with two groups and a lone task', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Lay the schema', project: 'ops', who: 'agent', horizon: 'now' },
          { description: 'Migrate the rows', project: 'ops', who: 'agent', horizon: 'now', depends: ['OPS-1'] },
          {
            description: 'Read from the new table',
            project: 'ops',
            who: 'agent',
            tags: ['v1_3-0'],
            horizon: 'now',
            depends: ['OPS-2'],
          },
          {
            description: 'Index it',
            project: 'ops',
            who: 'agent',
            tags: ['search'],
            horizon: 'now',
            depends: ['OPS-1'],
          },
          { description: 'A lone fix', project: 'ops', who: 'agent', horizon: 'now' },
          { description: 'Drop the old store', project: 'debt', who: 'agent', horizon: 'now' },
          { description: 'Clean up after it', project: 'debt', who: 'agent', horizon: 'now', depends: ['DEBT-1'] },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-5', 'DEBT-1', 'DEBT-2']);
    expect((await body(await api('tasks/OPS-2', { method: 'PATCH', body: { status: 'completed' } }))).status).toBe(200);
    expect((await add('search')).status).toBe(201);
  });

  it('is made from a task’s whole group: its open tasks join by the tag, done ones and another feature’s stay', async () => {
    const res = await add('schema', { from: 'OPS-3', title: 'New schema' });
    expect(res.status).toBe(201);
    expect(res.feature).toMatchObject({ slug: 'schema', title: 'New schema', release: '1.3.0' });
    expect(res.joined.sort()).toEqual(['OPS-1', 'OPS-3']);
    expect(res.kept).toEqual([{ wid: 'OPS-4', feature: 'search' }]);
    expect(res.feature.progress.total).toBe(2);
    expect(await tagsOf('OPS-1')).toContain('schema');
    expect(await tagsOf('OPS-2')).not.toContain('schema');
    expect(await tagsOf('OPS-4')).not.toContain('schema');
  });

  it('is made from part of a group: only the tasks picked join', async () => {
    const res = await add('cleanup', { tasks: ['DEBT-2'], release: '1.4.0' });
    expect(res.status).toBe(201);
    expect(res.joined).toEqual(['DEBT-2']);
    expect(res.kept).toEqual([]);
    expect(res.feature.release).toBe('1.4.0');
    expect(await tagsOf('DEBT-1')).not.toContain('cleanup');
  });

  it('refuses what can’t join, and makes nothing then', async () => {
    expect((await add('lone', { from: 'OPS-5' })).error).toMatch(/waits for nothing/);
    expect((await add('taken', { tasks: ['OPS-4', 'OPS-2'] })).error).toMatch(/none of these tasks can join/);
    expect((await body(await api('features/taken'))).status).toBe(404);
    expect((await add('empty', { tasks: [] })).error).toMatch(/pick at least one task/);
    expect((await add('nowhere', { tasks: ['OPS-99'] })).status).toBe(404);
    expect((await add('mine', { tasks: ['OPS-5'], by: 'claude-idea-9' })).status).toBe(403);
    expect((await body(await api('features/mine'))).status).toBe(404);
  });
});
