import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, boardApi, latestVersion, readChild } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });

/** Another board, with work on it, whose export the test reads back into this file's empty one. */
const source = () => env.STORE.get(env.STORE.idFromName('import-source'));

/** What the source board's `npx breakaway export` writes. */
async function exportSource() {
  return runInDurableObject(source(), async (store) => {
    const add = async (items) => (await store.create(items)).body.tasks;
    const [first, second] = await add([
      { description: 'Restore the queue', project: 'ops', horizon: 'now', brief: 'The queue loses jobs', by: 'owner' },
      { description: 'Write the runbook', project: 'ops', horizon: 'next', tags: ['agent'], priority: 'H' },
    ]);
    await add([{ description: 'Check the restore', project: 'ops', depends: [first.wid], related: [second.wid] }]);
    await store.comment(first.wid, 'Found it: the retry drops them.', 'claude-ops-1');
    await store.comment(first.wid, 'Thanks, carry on.');
    await store.quoteOwner(second.wid, { text: 'Keep it to one page.', from: 'message' }, 'claude-ops-2');
    await store.claim(second.wid, 'claude-ops-2');
    await store.update(second.wid, { autostart: 'yes' });
    await store.done(first.wid, 'Fixed in #12.', 'claude-ops-1');
    const { tasks } = (await store.list('all')).body;
    return { exported: '2026-10-09T12:00:00.000Z', count: tasks.length, tasks };
  });
}

/** The parts of a task an import keeps, for comparing two boards. */
const kept = (t) => ({
  uuid: t.uuid,
  wid: t.wid,
  description: t.description,
  brief: t.brief,
  briefBy: t.briefBy,
  doneWhen: t.doneWhen,
  status: t.status,
  project: t.project,
  priority: t.priority,
  horizon: t.horizon,
  tags: t.tags,
  depends: t.depends,
  related: t.related,
  repo: t.repo,
  entry: t.entry,
  end: t.end,
  comments: t.comments,
  annotations: t.annotations,
  ownerSaid: t.ownerSaid,
});

describe('restoring a board from an export', () => {
  let exported;

  it('refuses an agent', async () => {
    exported = await exportSource();
    const res = await body(await api('import', { method: 'POST', body: { ...exported, by: 'claude-brk-1' } }));
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/only the owner/u);
    expect((await body(await api('tasks?status=all'))).tasks).toHaveLength(0);
  });

  it('refuses an export that is missing tasks', async () => {
    const res = await body(await api('import', { method: 'POST', body: { ...exported, count: 9 } }));
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/incomplete/u);
  });

  it('refuses tasks of a repository the board has not registered, and imports none', async () => {
    const tasks = exported.tasks.map((t, i) => (i === 0 ? { ...t, repo: 'gadgets' } : t));
    const res = await body(await api('import', { method: 'POST', body: { tasks } }));
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/register gadgets first/u);
    expect((await body(await api('tasks?status=all'))).tasks).toHaveLength(0);
  });

  it('imports into an empty board with the same tasks, work IDs, and comments, and claims cleared', async () => {
    const res = await body(await api('import', { method: 'POST', body: exported }));
    expect(res).toMatchObject({ status: 201, imported: 3, comments: 3, cleared: 1, total: 3 });
    const { tasks } = await body(await api('tasks?status=all'));
    const byUuid = new Map(tasks.map((t) => [t.uuid, t]));
    for (const before of exported.tasks) expect(kept(byUuid.get(before.uuid))).toEqual(kept(before));
    const runbook = tasks.find((t) => t.description === 'Write the runbook');
    expect(runbook).toMatchObject({ claim: null, autostart: false, active: false });
    expect(exported.tasks.find((t) => t.uuid === runbook.uuid).claim).toBe('claude-ops-2');
    // Dependencies still point at the same task, and it's done, so the check is ready.
    expect(tasks.find((t) => t.description === 'Check the restore')).toMatchObject({ blocked: false, ready: true });
  });

  it('keeps counting work IDs from the highest imported', async () => {
    const { tasks } = await body(
      await api('tasks', { method: 'POST', body: { description: 'Next one', project: 'ops' } }),
    );
    const highest = Math.max(...exported.tasks.map((t) => Number(t.wid.split('-')[1])));
    expect(tasks[0].wid).toBe(`OPS-${highest + 1}`);
  });

  it('refuses to import into a board that has tasks', async () => {
    const res = await body(await api('import', { method: 'POST', body: exported }));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/already has 4 tasks: an export only restores into an empty board/u);
  });

  it('shows the import in Activity as one event', async () => {
    const { events } = await body(await api('activity?limit=5'));
    expect(events.filter((e) => e.changes.some((c) => c.kind === 'board-imported'))).toEqual([
      expect.objectContaining({ source: 'import', task: null, changes: [{ kind: 'board-imported', tasks: 3 }] }),
    ]);
  });

  it('syncs to a Taskwarrior replica like any other change', async () => {
    const { ops } = await readChild('00000000-0000-0000-0000-000000000000');
    const created = ops.filter((o) => o.type === 'create').map((o) => o.uuid);
    expect(created.sort()).toEqual(exported.tasks.map((t) => t.uuid).sort());
    expect(await latestVersion()).not.toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('restoring from the signed-in web board', () => {
  it('is the owner, and still refused on a board with tasks', async () => {
    const res = await body(await boardApi('import', { method: 'POST', body: { tasks: [{ uuid: 'x' }] } }));
    expect(res.status).toBe(409);
  });
});

describe('restoring a large export', () => {
  const board = (name) => env.STORE.get(env.STORE.idFromName(name));
  const big = (n) =>
    Array.from({ length: n }, (_, i) => ({
      uuid: crypto.randomUUID(),
      wid: `OPS-${i + 1}`,
      description: `Task ${i + 1}`,
      brief: 'x'.repeat(9000),
      status: 'pending',
      project: 'ops',
      repo: 'widgets',
      entry: '2026-10-01T00:00:00.000Z',
    }));

  it('splits it over versions that each fit in a row, and keeps every task', async () => {
    const tasks = big(150);
    const res = await runInDurableObject(board('import-big'), (store) => store.importApi({ tasks }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 150, total: 150 });
    expect(res.body.versions).toBeGreaterThan(1);
  });

  it('imports nothing when one task is wrong', async () => {
    const tasks = [...big(150), { uuid: crypto.randomUUID(), description: 'Bad', status: 'pending', priority: 'Z' }];
    const res = await runInDurableObject(board('import-bad'), (store) => store.importApi({ tasks }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priority/u);
    const after = await runInDurableObject(board('import-bad'), (store) => store.list('all'));
    expect(after.body.tasks).toHaveLength(0);
  });
});
