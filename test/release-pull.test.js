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

  it('checks the release, and an agent’s name', async () => {
    expect((await pull('1.4.0', { by: 'claude x' })).status).toBe(400);
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

describe('staging a release in next (BRK-209)', () => {
  it('sets up releases with tasks in later', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Started for 2.0', project: 'cloud', tags: ['v2_0-0'], horizon: 'now' },
          { description: 'Still an idea for 2.0', project: 'cloud', tags: ['v2_0-0'], horizon: 'later' },
          { description: 'Groundwork for 2.1', project: 'cloud', horizon: 'later' },
          { description: 'Aimed at 2.1', project: 'cloud', tags: ['v2_1-0'], horizon: 'later', depends: ['CLD-3'] },
          { description: 'Staged for 2.2', project: 'cloud', tags: ['v2_2-0'], horizon: 'next' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['CLD-1', 'CLD-2', 'CLD-3', 'CLD-4', 'CLD-5']);
  });

  it('names the first release with open work outside now and next on the roadmap', async () => {
    const roadmap = await body(await api('features'));
    expect(roadmap.stagePull).toEqual({ release: '2.0.0', tasks: 1 });
    expect(roadmap.nextPull).toEqual({ release: '2.0.0', tasks: 1 });
  });

  it('only stages the next release: a later one waits for it', async () => {
    const res = await pull('2.1.0', { into: 'next' });
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/pull 2\.0\.0 into next first/u);
    expect(await horizonOf('CLD-4')).toBe('later');
  });

  it('checks where it goes', async () => {
    expect((await pull('2.0.0', { into: 'next', by: 'claude x' })).status).toBe(400);
    expect((await pull('2.0.0', { into: 'later' })).status).toBe(400);
    expect((await pull('2.2.0', { into: 'next' })).error).toMatch(/already in now or next/u);
  });

  it('moves the release’s tasks in later into next, and leaves the ones in now', async () => {
    const res = await pull('2.0.0', { into: 'next' });
    expect(res).toMatchObject({ status: 200, release: '2.0.0', into: 'next', dryRun: false });
    expect(res.tasks.map((t) => t.wid)).toEqual(['CLD-2']);
    expect(await horizonOf('CLD-1')).toBe('now');
    expect(await horizonOf('CLD-2')).toBe('next');
    const roadmap = await body(await api('features'));
    expect(roadmap.stagePull).toEqual({ release: '2.1.0', tasks: 2 });
    expect(roadmap.nextPull).toEqual({ release: '2.0.0', tasks: 1 });
  });

  it('stages what a release waits for along with it, then has nothing left to stage', async () => {
    const plan = await pull('2.1.0', { into: 'next', dryRun: true });
    expect(plan.tasks.map((t) => [t.wid, t.horizon, t.chain])).toEqual([
      ['CLD-3', 'later', true],
      ['CLD-4', 'later', false],
    ]);
    expect(await horizonOf('CLD-3')).toBe('later');
    await pull('2.1.0', { into: 'next' });
    for (const ref of ['CLD-3', 'CLD-4']) expect(await horizonOf(ref)).toBe('next');
    expect((await body(await api('features'))).stagePull).toBeNull();
  });

  it('still pulls a staged release into now', async () => {
    const res = await pull('2.0.0');
    expect(res).toMatchObject({ into: 'now', tasks: [{ wid: 'CLD-2', horizon: 'next' }] });
    expect(await horizonOf('CLD-2')).toBe('now');
  });
});
