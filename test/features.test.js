import { describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const add = (slug, extra = {}) => api('features', { method: 'POST', body: { slug, ...extra } });
const feature = async (slug) => body(await api(`features/${slug}`));
const list = async () => body(await api('features'));

describe('features', () => {
  it('sets up a board with tagged tasks', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Read the release', project: 'ops', tags: ['agent', 'self-update', 'v1_2-0'], horizon: 'now' },
          {
            description: 'Apply the update',
            project: 'ops',
            tags: ['agent', 'self-update', 'v1_2-0'],
            horizon: 'now',
            depends: ['OPS-1'],
          },
          { description: 'Pick the channel', project: 'ops', tags: ['owner', 'decide', 'self-update'], horizon: 'now' },
          { description: 'Roll it back', project: 'ops', tags: ['agent', 'self-update', 'v1_3-0'], horizon: 'next' },
          { description: 'Drop the old store', project: 'debt', tags: ['agent', 'legacy-free'], horizon: 'now' },
          {
            description: 'Also legacy',
            project: 'debt',
            tags: ['agent', 'legacy-free', 'self-update'],
            horizon: 'now',
          },
          { description: 'A lone fix', project: 'debt', tags: ['agent', 'v1_2-0'], horizon: 'now' },
          { description: 'Owner chores', project: 'ops', tags: ['owner', 'horizon-now', 'security'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual([
      'OPS-1',
      'OPS-2',
      'OPS-3',
      'OPS-4',
      'DEBT-1',
      'DEBT-2',
      'DEBT-3',
      'OPS-5',
    ]);
  });

  it('suggests tags that are on open tasks and aren’t features yet, never the board’s own tags', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.features).toEqual([]);
    expect(res.suggestions).toEqual([
      { slug: 'legacy-free', tasks: 2, open: 2, release: null, repos: ['widgets'] },
      { slug: 'self-update', tasks: 5, open: 5, release: '1.2.0', repos: ['widgets'] },
    ]);
  });

  it('checks what it’s given, and only the owner ships a feature or plans its dates', async () => {
    expect((await body(await add('Bad Slug'))).error).toMatch(/slug/);
    expect((await body(await add('agent'))).error).toMatch(/board’s own/);
    expect((await body(await add('v1_2-0'))).error).toMatch(/release tag/);
    expect((await body(await add('horizon-now'))).error).toMatch(/board’s own/);
    expect((await body(await add('ok', { release: 'soon' }))).error).toMatch(/release/);
    expect((await body(await add('ok', { state: 'gone' }))).error).toMatch(/state/);
    expect((await body(await add('ok', { title: 'x'.repeat(201) }))).error).toMatch(/too long/);
    expect((await body(await add('ok', { state: 'shipped', by: 'claude-idea-9' }))).status).toBe(403);
    expect((await body(await add('ok', { plannedEnd: '2026-12-01', by: 'claude-idea-9' }))).status).toBe(403);
  });

  it('is made from a suggestion with one press: a title from its slug and the release its tasks share', async () => {
    const res = await body(await add('self-update'));
    expect(res.status).toBe(201);
    expect(res.feature).toMatchObject({
      slug: 'self-update',
      title: 'Self update',
      brief: null,
      release: '1.2.0',
      state: 'open',
      createdBy: 'owner',
    });
    expect((await body(await add('self-update'))).status).toBe(409);
    expect((await list()).suggestions.map((s) => s.slug)).toEqual(['legacy-free']);
  });

  it('may be added by an agent shaping an idea, without a release', async () => {
    const res = await body(
      await add('legacy-free', { title: 'Legacy free', brief: 'No more **old** store.', by: 'claude-idea-9' }),
    );
    expect(res.status).toBe(201);
    expect(res.feature).toMatchObject({ release: null, createdBy: 'claude-idea-9', brief: 'No more **old** store.' });
    expect((await list()).suggestions).toEqual([]);
  });

  it('counts each task in one feature: a second feature tag is a warning and counts toward the first alphabetically', async () => {
    const legacy = await feature('legacy-free');
    expect(legacy.feature.tasks.map((t) => t.wid)).toEqual(['DEBT-1', 'DEBT-2']);
    expect(legacy.feature.tasks.find((t) => t.wid === 'DEBT-2').alsoIn).toEqual(['self-update']);
    expect(legacy.feature.conflicts).toEqual([{ wid: 'DEBT-2', features: ['legacy-free', 'self-update'] }]);
    const self = await feature('self-update');
    expect(self.feature.tasks.map((t) => t.wid)).not.toContain('DEBT-2');
    expect(self.feature.conflicts).toEqual([{ wid: 'DEBT-2', features: ['legacy-free', 'self-update'] }]);
  });

  it('computes progress and lists its tasks in dependency order with their state', async () => {
    const { feature: f } = await feature('self-update');
    expect(f.progress).toEqual({
      total: 4,
      done: 0,
      running: 0,
      ready: 2,
      waiting: 1,
      needsYou: 1,
      inReview: 0,
      shipped: 0,
    });
    expect(f.done).toBe(false);
    expect(f.shipped).toBe(false);
    expect(f.tasks.map((t) => [t.wid, t.state])).toEqual([
      ['OPS-1', 'ready'],
      ['OPS-2', 'waiting'],
      ['OPS-3', 'needs-you'],
      ['OPS-4', 'ready'],
    ]);
    expect(f.tasks.find((t) => t.wid === 'OPS-2').why).toMatch(/waits for OPS-1/);
    expect(f.needsYou).toEqual([expect.objectContaining({ wid: 'OPS-3', why: expect.stringMatching(/decision/) })]);

    await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-ops-1' } });
    expect((await feature('self-update')).feature.progress).toMatchObject({ running: 1, ready: 1 });
    await api('tasks/OPS-1/done', { method: 'POST', body: {} });
    const after = (await feature('self-update')).feature;
    expect(after.progress).toMatchObject({ done: 1, running: 0, ready: 2, waiting: 0 });
    expect(after.tasks[0]).toMatchObject({ wid: 'OPS-1', state: 'done' });
  });

  it('is done when every task is, and the owner can mark it shipped', async () => {
    for (const wid of ['DEBT-1', 'DEBT-2']) await api(`tasks/${wid}/done`, { method: 'POST', body: {} });
    const legacy = (await feature('legacy-free')).feature;
    expect(legacy.progress).toMatchObject({ total: 2, done: 2 });
    expect(legacy.done).toBe(true);
    expect(legacy.shipped).toBe(false);
    const marked = await body(
      await api('features/legacy-free', { method: 'PATCH', body: { state: 'shipped', release: '1.1.0' } }),
    );
    expect(marked.feature).toMatchObject({ state: 'shipped', shipped: true, release: '1.1.0' });
  });

  it('lists features in release order, then unplanned, with progress and the release tags left over', async () => {
    await add('docs-pass', { title: 'Docs pass' });
    const res = await list();
    expect(res.features.map((f) => [f.slug, f.release])).toEqual([
      ['legacy-free', '1.1.0'],
      ['self-update', '1.2.0'],
      ['docs-pass', null],
    ]);
    expect(res.features[1].progress).toMatchObject({ total: 4, done: 1 });
    expect(res.features[1].tasks).toBeUndefined();
    expect(res.features[2].progress.total).toBe(0);
    // A release tag on a task with no feature still groups under its release.
    expect(res.releaseTasks).toEqual([{ release: '1.2.0', tasks: [expect.objectContaining({ wid: 'DEBT-3' })] }]);
  });

  it('is planned by the owner on the board: a start and an end, either cleared, never the start after the end', async () => {
    const plan = (input) => boardApi('features/legacy-free', { method: 'PATCH', body: input });
    expect((await feature('legacy-free')).feature).toMatchObject({ plannedStart: null, plannedEnd: null });
    const planned = await body(await plan({ plannedStart: '2026-10-12', plannedEnd: '2026-10-19' }));
    expect(planned.status).toBe(200);
    expect(planned.feature).toMatchObject({ plannedStart: '2026-10-12', plannedEnd: '2026-10-19', editedBy: 'owner' });
    expect((await list()).features.find((f) => f.slug === 'legacy-free')).toMatchObject({
      plannedStart: '2026-10-12',
      plannedEnd: '2026-10-19',
    });
    // An end alone is a "done by"; the start the change leaves out stays.
    expect((await body(await plan({ plannedStart: '' }))).feature).toMatchObject({
      plannedStart: null,
      plannedEnd: '2026-10-19',
    });
    const after = await body(await plan({ plannedStart: '2026-10-20' }));
    expect(after.status).toBe(400);
    expect(after.error).toMatch(/starts on 2026-10-20, after it ends on 2026-10-19/);
    for (const bad of ['12 Oct', '2026-02-30', '2026-1-5'])
      expect((await body(await plan({ plannedEnd: bad }))).error).toMatch(/a day like 2026-10-12/);
    expect((await body(await plan({ plannedStart: '2026-10-19' }))).feature.plannedStart).toBe('2026-10-19');
    // The CLI's token reads the plan and can't set it, as the owner or as an agent; nor can it make a feature with one.
    for (const by of [undefined, 'claude-x-1']) {
      const refused = await body(
        await api('features/legacy-free', { method: 'PATCH', body: { plannedEnd: '', ...(by ? { by } : {}) } }),
      );
      expect(refused.status).toBe(403);
      expect(refused.error).toMatch(/only the owner plans a feature’s dates, signed in to the web board/);
    }
    expect((await body(await add('dated', { plannedEnd: '2026-11-01' }))).status).toBe(403);
    expect((await feature('legacy-free')).feature.plannedEnd).toBe('2026-10-19');
    // The rest of a feature still changes from the CLI, and leaves the plan as it was.
    expect(
      (await body(await api('features/legacy-free', { method: 'PATCH', body: { title: 'Legacy free' } }))).feature,
    ).toMatchObject({ title: 'Legacy free', plannedStart: '2026-10-19', plannedEnd: '2026-10-19' });
    const cleared = await body(await plan({ plannedStart: null, plannedEnd: '' }));
    expect(cleared.feature).toMatchObject({ plannedStart: null, plannedEnd: null });
    // Activity says each change of plan, newest first, and nothing for a change that leaves it as it was.
    const { events } = await body(await api('activity'));
    expect(
      events
        .flatMap((e) => e.changes.map((c) => ({ ...c, source: e.source })))
        .filter((c) => c.kind === 'feature_planned'),
    ).toEqual([
      { kind: 'feature_planned', feature: 'legacy-free', title: 'Legacy free', start: null, end: null, source: 'api' },
      {
        kind: 'feature_planned',
        feature: 'legacy-free',
        title: 'Legacy free',
        start: '2026-10-19',
        end: '2026-10-19',
        source: 'api',
      },
      {
        kind: 'feature_planned',
        feature: 'legacy-free',
        title: 'Legacy free',
        start: null,
        end: '2026-10-19',
        source: 'api',
      },
      {
        kind: 'feature_planned',
        feature: 'legacy-free',
        title: 'Legacy free',
        start: '2026-10-12',
        end: '2026-10-19',
        source: 'api',
      },
    ]);
  });

  it('is shipped and deleted only by the owner; deleting leaves the tasks and their tag', async () => {
    expect(
      (await body(await api('features/self-update', { method: 'PATCH', body: { state: 'shipped', by: 'claude-x-1' } })))
        .status,
    ).toBe(403);
    const edited = await body(
      await api('features/self-update', { method: 'PATCH', body: { title: 'Update itself', release: null } }),
    );
    expect(edited.feature).toMatchObject({ title: 'Update itself', release: null, editedBy: 'owner' });
    expect((await body(await api('features/nope', { method: 'PATCH', body: { title: 'x' } }))).status).toBe(404);
    expect((await body(await api('features/docs-pass', { method: 'DELETE', body: { by: 'claude-x-1' } }))).status).toBe(
      403,
    );
    expect((await body(await api('features/self-update', { method: 'DELETE', body: {} }))).status).toBe(200);
    expect((await feature('self-update')).status).toBe(404);
    const res = await list();
    expect(res.features.map((f) => f.slug)).toEqual(['legacy-free', 'docs-pass']);
    expect(res.suggestions.map((s) => s.slug)).toEqual(['self-update']);
    expect((await body(await api('tasks/OPS-2'))).task.tags).toContain('self-update');
  });
});
