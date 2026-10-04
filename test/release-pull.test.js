import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const pull = async (release, extra = {}) =>
  body(await api(`releases/${release}/pull`, { method: 'POST', body: { ...extra } }));
const horizonOf = async (ref) => (await body(await api(`tasks/${ref}`))).task.horizon;

describe('pulling a release into now (BRK-126)', () => {
  it('sets up releases with tasks outside now', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Ship the old release', project: 'ops', tags: ['v1_3-0'], horizon: 'now' },
          { description: 'Groundwork with no release', project: 'ops', horizon: 'later' },
          { description: 'The sync engine', project: 'ops', tags: ['sync'], horizon: 'next', depends: ['OPS-2'] },
          { description: 'A loose fix for 1.4', project: 'ops', tags: ['v1_4-0'], horizon: 'next' },
          { description: 'Finished for 1.4', project: 'ops', tags: ['v1_4-0'], horizon: 'next' },
          { description: 'Aimed at 1.6', project: 'ops', tags: ['v1_6-0'], horizon: 'later' },
          { description: 'Aimed at 1.5', project: 'ops', tags: ['v1_5-0'], horizon: 'next', depends: ['OPS-6'] },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4', 'OPS-5', 'OPS-6', 'OPS-7']);
    await api('tasks/OPS-5/done', { method: 'POST', body: {} });
    expect(
      (await body(await api('features', { method: 'POST', body: { slug: 'sync', release: '1.4.0' } }))).status,
    ).toBe(201);
  });

  it('names the first release with open work outside now on the roadmap', async () => {
    const roadmap = await body(await api('features'));
    expect(roadmap.nextPull).toEqual({ release: '1.4.0', tasks: 3 });
  });

  it('shows what it would move on a dry run, a task after what it waits for, and changes nothing', async () => {
    const res = await pull('1.4.0', { dryRun: true });
    expect(res).toMatchObject({ status: 200, release: '1.4.0', dryRun: true });
    expect(res.tasks.map((t) => [t.wid, t.horizon, t.chain])).toEqual([
      ['OPS-4', 'next', false],
      ['OPS-2', 'later', true],
      ['OPS-3', 'next', false],
    ]);
    expect(await horizonOf('OPS-3')).toBe('next');
  });

  it('only pulls the next release: a later one waits for it', async () => {
    const res = await pull('1.5.0');
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/1\.4\.0/u);
    expect(await horizonOf('OPS-7')).toBe('next');
  });

  it('is the owner’s, and checks the release', async () => {
    expect((await pull('1.4.0', { by: 'claude-x-1' })).status).toBe(403);
    expect((await pull('next')).status).toBe(400);
    expect((await pull('1.3.0')).error).toMatch(/already in now/u);
  });

  it('moves the release’s open tasks and what they wait for into now', async () => {
    const res = await pull('1.4.0');
    expect(res).toMatchObject({ status: 200, release: '1.4.0', dryRun: false });
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-4', 'OPS-2', 'OPS-3']);
    for (const ref of ['OPS-2', 'OPS-3', 'OPS-4']) expect(await horizonOf(ref)).toBe('now');
    expect(await horizonOf('OPS-5')).toBe('next');
    expect(await horizonOf('OPS-7')).toBe('next');
  });

  it('pulls a dependency from a later release along with it, then has nothing left', async () => {
    expect((await body(await api('features'))).nextPull).toEqual({ release: '1.5.0', tasks: 2 });
    const res = await pull('1.5.0');
    expect(res.tasks.map((t) => [t.wid, t.chain])).toEqual([
      ['OPS-6', true],
      ['OPS-7', false],
    ]);
    expect(await horizonOf('OPS-6')).toBe('now');
    expect((await body(await api('features'))).nextPull).toBeNull();
  });
});
