import { describe, expect, it } from 'vitest';
import { diffOps, nextWid, rank, resolveRef, toEpoch, view, withChanges } from '../src/model.js';

const A = '1dd497fc-7d89-4c7b-adfb-b74856043b81';
const B = 'f5e733e5-10da-453a-99df-17181953eb1c';
const NOW = new Date('2026-09-28T12:00:00Z');

// Exactly what Taskwarrior 3.5 wrote for `task add … +agent depends:1` and an annotation.
const twA = {
  project: 'ops',
  tag_agent: 'x',
  annotation_1790630931: 'a note',
  wid: 'OPS-5',
  priority: 'H',
  status: 'pending',
  modified: '1790630931',
  tags: 'agent',
  description: 'First thing',
  entry: '1790630931',
};
const twB = {
  start: '1790630931',
  entry: '1790630931',
  description: 'Second',
  status: 'pending',
  [`dep_${A}`]: 'x',
  due: '1791583200',
  depends: A,
  modified: '1790630931',
};

describe('view', () => {
  const all = new Map([
    [A, twA],
    [B, twB],
  ]);

  it('reads Taskwarrior 3 properties', () => {
    const a = view(A, twA, all, NOW);
    expect(a).toMatchObject({
      uuid: A,
      short: '1dd497fc',
      wid: 'OPS-5',
      project: 'ops',
      priority: 'H',
      tags: ['agent'],
      ready: true,
      blocked: false,
      active: false,
    });
    expect(a.annotations).toEqual([{ entry: '2026-09-28T21:28:51.000Z', text: 'a note' }]);
    expect(a.entry).toBe('2026-09-28T21:28:51.000Z');
  });

  it('marks a task blocked while a dependency is pending', () => {
    const b = view(B, twB, all, NOW);
    expect(b).toMatchObject({ depends: [A], blocked: true, ready: false, active: true });
    const done = new Map([
      [A, { ...twA, status: 'completed' }],
      [B, twB],
    ]);
    expect(view(B, twB, done, NOW).blocked).toBe(false);
  });

  it('treats a future wait as not ready', () => {
    const t = { ...twA, wait: String(toEpoch('2026-10-01', NOW)) };
    expect(view(A, t, new Map([[A, t]]), NOW)).toMatchObject({ waiting: true, ready: false });
  });

  it('reads legacy tags and depends strings too', () => {
    const t = { status: 'pending', description: 'x', tags: 'owner,decide', depends: B };
    expect(view(A, t, new Map([[A, t]]), NOW)).toMatchObject({ tags: ['decide', 'owner'], depends: [B] });
  });
});

describe('changes and operations', () => {
  it('writes tags and dependencies both ways, like Taskwarrior', () => {
    const after = withChanges(
      null,
      { description: 'New', project: 'cloud', addTags: ['agent', 'owner'], addDepends: [A] },
      NOW,
    );
    expect(after).toMatchObject({
      description: 'New',
      status: 'pending',
      project: 'cloud',
      tag_agent: 'x',
      tag_owner: 'x',
      tags: 'agent,owner',
      [`dep_${A}`]: 'x',
      depends: A,
      entry: '1790596800',
      modified: '1790596800',
    });
    const removed = withChanges(after, { removeTags: ['owner'], removeDepends: [A] }, NOW);
    expect(removed.tag_owner).toBeUndefined();
    expect(removed.tags).toBe('agent');
    expect(removed.depends).toBeUndefined();
  });

  it('finishing sets end and clears start; reopening clears end', () => {
    const done = withChanges({ ...twB }, { status: 'completed' }, NOW);
    expect(done).toMatchObject({ status: 'completed', end: '1790596800' });
    expect(done.start).toBeUndefined();
    expect(withChanges(done, { status: 'pending' }, NOW).end).toBeUndefined();
  });

  it('adds annotations without overwriting one from the same second', () => {
    const once = withChanges({ status: 'pending', description: 'x' }, { annotate: 'one' }, NOW);
    const twice = withChanges(once, { annotate: 'two' }, NOW);
    expect(
      Object.entries(twice)
        .filter(([k]) => k.startsWith('annotation_'))
        .map(([, v]) => v),
    ).toEqual(['one', 'two']);
  });

  it('turns a change into create and update operations', () => {
    const ts = NOW.toISOString();
    expect(diffOps(A, null, { description: 'x' }, ts)).toEqual([
      { type: 'create', uuid: A },
      { type: 'update', uuid: A, property: 'description', value: 'x', timestamp: ts },
    ]);
    expect(diffOps(A, { a: '1', b: '2' }, { a: '1', c: '3' }, ts)).toEqual([
      { type: 'update', uuid: A, property: 'b', value: null, timestamp: ts },
      { type: 'update', uuid: A, property: 'c', value: '3', timestamp: ts },
    ]);
  });
});

describe('IDs, refs, and order', () => {
  const all = new Map([
    [A, twA],
    [B, { ...twB, wid: 'OPS-12' }],
  ]);

  it('gives the next free number for an area, never reusing one', () => {
    expect(nextWid('OPS', all)).toBe('OPS-13');
    expect(nextWid('PRD', all)).toBe('PRD-1');
  });

  it('finds a task by work ID, UUID, or UUID prefix', () => {
    expect(resolveRef('ops-5', all)).toBe(A);
    expect(resolveRef(B, all)).toBe(B);
    expect(resolveRef('f5e733e5', all)).toBe(B);
    expect(resolveRef('nope', all)).toBeNull();
    const clash = new Map([
      ['aaaa1111-0000-4000-8000-000000000000', {}],
      ['aaaa2222-0000-4000-8000-000000000000', {}],
    ]);
    expect(() => resolveRef('aaaa', clash)).toThrow(/more than one/);
  });

  it('orders by horizon, then priority, then work ID number', () => {
    const t = (horizon, priority, wid) => ({ horizon, priority, wid, entry: '2026-01-01T00:00:00.000Z' });
    const list = [
      t('later', 'H', 'PRD-20'),
      t('now', '', 'OPS-8'),
      t('now', 'H', 'PRD-5'),
      t('next', 'H', 'PRD-10'),
      t('now', '', 'OPS-2'),
    ];
    expect(list.sort(rank).map((x) => x.wid)).toEqual(['PRD-5', 'OPS-2', 'OPS-8', 'PRD-10', 'PRD-20']);
  });

  it('reads dates people type', () => {
    expect(toEpoch('2026-10-10', NOW)).toBe(1791590400);
    expect(toEpoch('2026-10-10T08:00:00Z', NOW)).toBe(1791619200);
    expect(toEpoch('now', NOW)).toBe(1790596800);
    expect(toEpoch('3d', NOW)).toBe(1790596800 + 3 * 86400);
    expect(() => toEpoch('someday', NOW)).toThrow(/date/);
  });
});
