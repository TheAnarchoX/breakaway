import { describe, expect, it } from 'vitest';
import { ownerSaidOf, withChanges } from '../src/model.js';
import { firePayload } from '../src/store-agents.js';
import { taskDetail } from '../src/mcp.js';
import { ownerSaidLines } from '../scripts/tasks/structure.js';
import { api, boardApi } from './helpers.js';

// BRK-284: the owner's words stay on a task, quoted, and every agent that picks it up reads them first.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const make = async (fields = {}) =>
  (await body(await api('tasks', { method: 'POST', body: [{ description: 'A task', project: 'ops', ...fields }] })))
    .tasks[0];
const claim = (ref, agent) => api(`tasks/${ref}/claim`, { method: 'POST', body: { agent } });
const quote = (ref, payload) => api(`tasks/${ref}/said`, { method: 'POST', body: payload });

describe('the model', () => {
  const NOW = new Date('2026-10-09T12:00:00Z');
  const base = { description: 'A task', status: 'pending' };

  it('keeps each quote with where it came from and who put it there, oldest first', () => {
    let map = withChanges(base, { said: { text: 'drop em', from: 'peloton #12', by: 'claude-ops-1' } }, NOW);
    map = withChanges(map, { said: { text: "don't make me open a code editor", by: 'owner' } }, NOW);
    expect(ownerSaidOf(map)).toEqual([
      { id: 1791547200, text: 'drop em', from: 'peloton #12', by: 'claude-ops-1', at: '2026-10-09T12:00:00.000Z' },
      {
        id: 1791547201,
        text: "don't make me open a code editor",
        from: 'board',
        by: 'owner',
        at: '2026-10-09T12:00:01.000Z',
      },
    ]);
    expect(map.said_1791547200).toBe('drop em');
    expect(map.said_from_1791547200).toBe('peloton #12');
    expect(map.said_by_1791547200).toBe('claude-ops-1');
  });

  it('refuses an empty quote, a long one, an unknown source, and the same words twice', () => {
    expect(() => withChanges(base, { said: { text: '  ' } })).toThrow(/can't be empty/u);
    expect(() => withChanges(base, { said: { text: 'x'.repeat(2001) } })).toThrow(/up to 2000/u);
    expect(() => withChanges(base, { said: { text: 'hi', from: 'slack' } })).toThrow(/where the owner said it/u);
    const once = withChanges(base, { said: { text: 'hi' } });
    expect(() => withChanges(once, { said: { text: 'hi' } })).toThrow(/already quotes/u);
  });

  it('keeps up to 20 quotes', () => {
    let map = base;
    for (let i = 0; i < 20; i += 1) map = withChanges(map, { said: { text: `quote ${i}` } }, NOW);
    expect(() => withChanges(map, { said: { text: 'one more' } }, NOW)).toThrow(/up to 20 quotes/u);
  });

  it('removes a quote by its id, and only one it has', () => {
    const map = withChanges(base, { said: { text: 'hi' } }, NOW);
    const [{ id }] = ownerSaidOf(map);
    const after = withChanges(map, { unsay: id }, NOW);
    expect(ownerSaidOf(after)).toEqual([]);
    expect(Object.keys(after).filter((k) => k.startsWith('said'))).toEqual([]);
    expect(() => withChanges(map, { unsay: 123 }, NOW)).toThrow(/no quote 123/u);
  });
});

describe('quoting the owner', () => {
  it('the signed-in board adds the owner’s own words, and only it removes them', async () => {
    const task = await make();
    const added = await body(
      await boardApi(`tasks/${task.uuid}/said`, { method: 'POST', body: { text: 'Oldest first, always.' } }),
    );
    expect(added.status).toBe(200);
    expect(added.task.ownerSaid).toMatchObject([{ text: 'Oldest first, always.', from: 'board', by: 'owner' }]);
    const { id } = added.task.ownerSaid[0];
    // The bearer token every agent holds can't remove it.
    expect((await api(`tasks/${task.uuid}/said/${id}`, { method: 'DELETE' })).status).toBe(403);
    const removed = await body(await boardApi(`tasks/${task.uuid}/said/${id}`, { method: 'DELETE', body: {} }));
    expect(removed.status).toBe(200);
    expect(removed.task.ownerSaid).toEqual([]);
  });

  it('the bearer token can’t put words in the owner’s mouth', async () => {
    const task = await make();
    expect((await quote(task.uuid, { text: 'Ship it.' })).status).toBe(403);
    expect((await quote(task.uuid, { text: 'Ship it.', by: 'owner', from: 'message' })).status).toBe(403);
    expect((await quote(task.uuid, { text: 'Ship it.', by: 'board', from: 'message' })).status).toBe(403);
  });

  it('an agent quotes the owner on a task it holds, marked as its quote with the source', async () => {
    const task = await make();
    expect((await claim(task.uuid, 'claude-ops-9')).status).toBe(200);
    const res = await body(await quote(task.wid, { text: 'drop em', from: 'peloton #12', by: 'claude-ops-9' }));
    expect(res.status).toBe(200);
    expect(res.task.ownerSaid).toMatchObject([{ text: 'drop em', from: 'peloton #12', by: 'claude-ops-9' }]);
    // It says where the owner said it: never "on the board", which is the owner's own.
    expect((await quote(task.wid, { text: 'more', by: 'claude-ops-9' })).status).toBe(400);
    expect((await quote(task.wid, { text: 'more', from: 'board', by: 'claude-ops-9' })).status).toBe(400);
    expect((await quote(task.wid, { text: 'more', from: 'gossip', by: 'claude-ops-9' })).status).toBe(400);
  });

  it('refuses an agent that doesn’t hold the task, and a finished task', async () => {
    const task = await make();
    expect((await claim(task.uuid, 'claude-ops-1')).status).toBe(200);
    const other = await body(await quote(task.uuid, { text: 'hi', from: 'message', by: 'claude-ops-2' }));
    expect(other.status).toBe(403);
    expect(other.error).toMatch(/doesn't hold/u);
    await api(`tasks/${task.uuid}/done`, { method: 'POST', body: {} });
    expect((await quote(task.uuid, { text: 'hi', from: 'message', by: 'claude-ops-1' })).status).toBe(409);
  });
});

describe('what an agent reads', () => {
  const said = [
    { id: 1, text: 'drop em', from: 'peloton #12', by: 'claude-ops-9', at: '2026-10-08T10:00:00.000Z' },
    { id: 2, text: "don't make me\nopen a code editor", from: 'board', by: 'owner', at: '2026-10-09T10:00:00.000Z' },
  ];
  const task = { uuid: 'd676d69d-a69f-454a-80be-ff9e7d4c3a73', wid: 'OPS-7', description: 'A task', ownerSaid: said };

  it('the start payload carries the quotes, before the owner’s note', () => {
    const text = firePayload(task, 'claude-ops-7', 'manual', { note: 'Be quick.' });
    expect(text).toContain(
      [
        'The owner said (quoted on the task):',
        '> drop em',
        '  (peloton #12, quoted by claude-ops-9, 2026-10-08)',
        "> don't make me",
        '> open a code editor',
        '  (board, from the owner, 2026-10-09)',
      ].join('\n'),
    );
    expect(text.indexOf('The owner said')).toBeLessThan(text.indexOf('Note from the owner:'));
    expect(firePayload({ ...task, ownerSaid: [] }, 'claude-ops-7', 'manual')).not.toContain('The owner said');
  });

  it('show and claim print them first, on the CLI and the MCP server', () => {
    expect(ownerSaidLines(task)).toEqual([
      '  The owner said (read this first)',
      '    > drop em',
      '      (peloton #12, quoted by claude-ops-9, 2026-10-08)',
      "    > don't make me",
      '    > open a code editor',
      '      (board, from the owner, 2026-10-09)',
    ]);
    expect(ownerSaidLines({ ownerSaid: [] })).toEqual([]);
    const md = taskDetail({ ...task, status: 'pending', tags: [], brief: 'The brief.' });
    expect(md.indexOf('## The owner said')).toBeGreaterThan(-1);
    expect(md.indexOf('## The owner said')).toBeLessThan(md.indexOf('## Description'));
    expect(md).toContain('> drop em\n\n(peloton #12, quoted by claude-ops-9, 2026-10-08)');
  });

  it('claim hands the quotes to the agent with the task', async () => {
    const t = await make();
    await boardApi(`tasks/${t.uuid}/said`, { method: 'POST', body: { text: 'Keep it small.' } });
    const res = await body(await claim(t.uuid, 'claude-ops-3'));
    expect(res.task.ownerSaid).toMatchObject([{ text: 'Keep it small.', by: 'owner' }]);
  });
});
