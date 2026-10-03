import { describe, expect, it } from 'vitest';
import { api, latestVersion, pushOps, twCreate } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });

describe('activity', () => {
  it('summarises recent changes per task, newest first, with where they came from', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Publish security.txt', project: 'ops', tags: ['agent'], note: 'With an expiry date.' },
        { description: 'Check it after the deploy', project: 'ops', tags: ['owner'], depends: ['OPS-1'] },
      ],
    });
    await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-a' } });
    await api('tasks/OPS-1/annotate', { method: 'POST', body: { text: 'Served at /.well-known/security.txt' } });
    await api('tasks/OPS-2', { method: 'PATCH', body: { horizon: 'now', priority: 'H', addTags: ['decide'] } });
    await api('tasks/OPS-1/release', { method: 'POST', body: { agent: 'claude-a' } });
    await api('tasks/OPS-1/done', { method: 'POST', body: {} });
    await api('tasks/OPS-2', { method: 'PATCH', body: { status: 'completed' } });
    await api('tasks/OPS-2', { method: 'PATCH', body: { status: 'pending' } });
    const uuid = crypto.randomUUID();
    await pushOps(await latestVersion(), twCreate(uuid, { description: 'From Taskwarrior', project: 'debt' }));

    const res = await body(await api('activity'));
    expect(res.status).toBe(200);
    const flat = res.events.map(
      (e) =>
        `${e.task.wid ?? e.task.uuid.slice(0, 8)} ${e.source} ${e.changes.map((c) => c.kind + (c.by ? `:${c.by}` : '') + (c.fields ? `:${c.fields.join('+')}` : '') + (c.wid ? `:${c.wid}` : '')).join(',')}`,
    );
    expect(flat).toEqual([
      'DEBT-1 api numbered:DEBT-1',
      'DEBT-1 taskwarrior created',
      'OPS-2 api reopened',
      'OPS-2 api done',
      'OPS-1 api done',
      'OPS-1 api released',
      'OPS-2 api changed:horizon+priority+tags', // gitleaks:allow (an activity line, not a key)
      'OPS-1 api note:owner',
      'OPS-1 api claimed:claude-a',
      'OPS-2 api created',
      'OPS-1 api created,brief',
    ]);
    const note = res.events.find((e) => e.changes.some((c) => c.kind === 'note'));
    expect(note.changes[0].text).toBe('Served at /.well-known/security.txt');
    expect(res.events[0].task.description).toBe('From Taskwarrior');
    expect(res.events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('pages back through older changes', async () => {
    const first = await body(await api('activity?limit=3'));
    expect(first.events.length).toBeGreaterThanOrEqual(3);
    expect(first.next).toBeTypeOf('number');
    const older = await body(await api(`activity?limit=3&before=${first.next}`));
    expect(older.events[0].seq).toBeLessThan(first.events.at(-1).seq);
  });
});
