import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const horizonOf = async (ref) => (await body(await api(`tasks/${ref}`))).task.horizon;

describe('closing a horizon', () => {
  it('reports what it would do on a dry run and changes nothing', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Finished in now', project: 'ops', horizon: 'now' },
        { description: 'Open in now', project: 'ops', horizon: 'now' },
        { description: 'Waiting in next', project: 'ops', horizon: 'next' },
        { description: 'Idea in later', project: 'ops', horizon: 'later' },
        { description: 'Finished in next', project: 'ops', horizon: 'next' },
      ],
    });
    await api('tasks/OPS-1/done', { method: 'POST', body: {} });
    const dry = await body(await api('horizons/close', { method: 'POST', body: { dryRun: true } }));
    expect(dry).toMatchObject({ status: 200, archived: 1, carriedOver: 1, movedUp: 3, dryRun: true });
    expect(await horizonOf('OPS-1')).toBe('now');
    expect(await horizonOf('OPS-3')).toBe('next');
  });

  it('archives finished now tasks, then next becomes now, then later becomes next', async () => {
    const res = await body(await api('horizons/close', { method: 'POST', body: {} }));
    expect(res).toMatchObject({ status: 200, archived: 1, carriedOver: 1, movedUp: 3, dryRun: false });
    expect(await horizonOf('OPS-1')).toBe('archive');
    expect(await horizonOf('OPS-2')).toBe('now');
    expect(await horizonOf('OPS-3')).toBe('now');
    expect(await horizonOf('OPS-5')).toBe('now');
    expect(await horizonOf('OPS-4')).toBe('next');
    const archived = (await body(await api('tasks?status=all'))).tasks.find((t) => t.wid === 'OPS-1');
    expect(archived.status).toBe('completed');
  });

  it('logs one event for the close', async () => {
    const { events } = await body(await api('activity?limit=1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'horizon',
      task: null,
      changes: [{ kind: 'horizon-closed', archived: 1, movedUp: 3 }],
    });
  });

  it('closes again safely: nothing left to archive, next moves up', async () => {
    const res = await body(await api('horizons/close', { method: 'POST', body: {} }));
    expect(res).toMatchObject({ archived: 0, carriedOver: 3, movedUp: 1 });
    expect(await horizonOf('OPS-4')).toBe('now');
    expect(await horizonOf('OPS-1')).toBe('archive');
  });

  it('does nothing, and writes no version, when every horizon is empty', async () => {
    await api('horizons/close', { method: 'POST', body: {} });
    const before = (await body(await api('activity?limit=1'))).events[0].seq;
    const res = await body(await api('horizons/close', { method: 'POST', body: {} }));
    expect(res).toMatchObject({ archived: 0, movedUp: 0 });
    expect((await body(await api('activity?limit=1'))).events[0].seq).toBe(before);
  });

  it('accepts archive as a horizon on a task', async () => {
    const res = await body(await api('tasks/OPS-4', { method: 'PATCH', body: { horizon: 'archive' } }));
    expect(res.task.horizon).toBe('archive');
  });
});
