import { describe, expect, it } from 'vitest';
import {
  FOLD_FROM,
  criticalPath,
  crossings,
  foldDone,
  foldId,
  isPass,
  layered,
  orderSteps,
} from '../web/src/lib/graph-layout.js';

// The Dependencies view's layout (WEB-98), on made-up chains.

/** Each id one step right of everything it waits for, each step in the order the ids came in (rank). */
function stepsOf(ids, edges) {
  const before = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) before.get(b).push(a);
  const level = new Map();
  const depth = (id) => {
    if (!level.has(id)) level.set(id, before.get(id).length ? Math.max(...before.get(id).map(depth)) + 1 : 0);
    return level.get(id);
  };
  const steps = [];
  for (const id of ids) {
    const step = depth(id);
    if (!steps[step]) steps[step] = [];
    steps[step].push(id);
  }
  return steps;
}

/** The crossings in rank order, and after ordering, the same way the view lays a chain out. */
function compare(steps, edges) {
  const { steps: withGaps, links } = layered(steps, edges);
  return { rank: crossings(withGaps, links), ordered: crossings(orderSteps(withGaps, links), links) };
}

// Fifteen tasks that fan out and back in, where the board's rank puts each step in an order that crosses.
const chainIds = Array.from({ length: 15 }, (_, i) => `ACME-${i + 1}`);
const chainEdges = /** @type {[string, string][]} */ (
  [
    [1, 5],
    [2, 6],
    [3, 4],
    [4, 8],
    [5, 9],
    [6, 7],
    [1, 9],
    [7, 11],
    [8, 12],
    [9, 10],
    [2, 12],
    [10, 13],
    [12, 13],
    [11, 14],
    [13, 15],
    [14, 15],
  ].map(([a, b]) => [`ACME-${a}`, `ACME-${b}`])
);

/** A seeded generator, so a failing case can be found again. */
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A big feature: `done` finished tasks over a few steps, then `open` tasks, each waiting on a few before it. */
function bigFeature({ done = 90, open = 10, seed = 7 } = {}) {
  const next = random(seed);
  const ids = Array.from({ length: done + open }, (_, i) => `ACME-${i + 1}`);
  const edges = [];
  ids.forEach((id, i) => {
    if (i === 0) return;
    const count = 1 + Math.floor(next() * 3);
    const from = new Set();
    for (let k = 0; k < count; k += 1) from.add(ids[Math.floor(next() * i)]);
    // The open tasks run one after another, so the feature has a path to its last task.
    if (i > done) from.add(ids[i - 1]);
    for (const f of from) edges.push([f, id]);
  });
  return { ids, edges: /** @type {[string, string][]} */ (edges), isDone: (id) => Number(id.slice(5)) <= done };
}

describe('the order within a step', () => {
  it('crosses fewer arrows than rank order on a fifteen-task chain', () => {
    const { rank, ordered } = compare(stepsOf(chainIds, chainEdges), chainEdges);
    expect(rank).toBeGreaterThan(0);
    expect(ordered).toBeLessThan(rank);
  });

  it('crosses fewer arrows than rank order on a big feature, folded the way the view shows it', () => {
    const { ids, edges, isDone } = bigFeature();
    const folded = foldDone(stepsOf(ids, edges), edges, { done: isDone });
    const { rank, ordered } = compare(folded.steps, folded.edges);
    expect(ordered).toBeLessThan(rank);
  });

  it('never crosses more than rank order', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const next = random(seed);
      const ids = Array.from({ length: 12 + Math.floor(next() * 20) }, (_, i) => `ACME-${i + 1}`);
      const edges = [];
      ids.forEach((id, i) => {
        for (let k = 0; k < i && k < 3; k += 1) if (next() < 0.5) edges.push([ids[Math.floor(next() * i)], id]);
      });
      const unique = /** @type {[string, string][]} */ ([...new Map(edges.map((e) => [e.join('>'), e])).values()]);
      const { rank, ordered } = compare(stepsOf(ids, unique), unique);
      expect(ordered).toBeLessThanOrEqual(rank);
    }
  });

  it('keeps rank order where nothing crosses', () => {
    const steps = [
      ['ACME-1', 'ACME-2'],
      ['ACME-3', 'ACME-4'],
    ];
    const links = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-3'],
      ['ACME-2', 'ACME-4'],
    ]);
    expect(orderSteps(steps, links)).toEqual(steps);
  });

  it('puts a card beside the one it waits for', () => {
    const steps = [
      ['ACME-1', 'ACME-2'],
      ['ACME-3', 'ACME-4'],
    ];
    const links = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-4'],
      ['ACME-2', 'ACME-3'],
    ]);
    const ordered = orderSteps(steps, links);
    expect(crossings(ordered, links)).toBe(0);
  });
});

describe('arrows that skip a step', () => {
  it('pass through a gap on each step they skip, never through a card', () => {
    const steps = [['ACME-1'], ['ACME-2'], ['ACME-3'], ['ACME-4']];
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-2'],
      ['ACME-2', 'ACME-3'],
      ['ACME-3', 'ACME-4'],
      ['ACME-1', 'ACME-4'],
    ]);
    const { steps: out, links, routes } = layered(steps, edges);
    const gaps = routes.get('ACME-1>ACME-4');
    expect(gaps).toHaveLength(2);
    expect(out[1]).toContain(gaps[0]);
    expect(out[2]).toContain(gaps[1]);
    expect(gaps.every(isPass)).toBe(true);
    expect(routes.get('ACME-1>ACME-2')).toEqual([]);
    // Every link joins neighbouring steps.
    const stepOf = new Map(out.flatMap((ids, s) => ids.map((id) => [id, s])));
    for (const [a, b] of links) expect(stepOf.get(b)).toBe(stepOf.get(a) + 1);
  });

  it('leaves a cycle’s way back out of the layers', () => {
    const { links } = layered([['ACME-1'], ['ACME-2']], [['ACME-2', 'ACME-1']]);
    expect(links).toEqual([]);
  });
});

describe('finished work folds away', () => {
  it('folds a big feature to its open tasks and one card a step', () => {
    const { ids, edges, isDone } = bigFeature();
    const steps = stepsOf(ids, edges);
    const folded = foldDone(steps, edges, { done: isDone });
    const cards = folded.steps.flat();
    const open = ids.filter((id) => !isDone(id));
    expect(cards.filter((id) => !id.startsWith('fold:'))).toEqual(expect.arrayContaining(open));
    expect(cards.length).toBeLessThanOrEqual(open.length + steps.length + (FOLD_FROM - 1) * steps.length);
    expect(cards.length).toBeLessThan(ids.length / 3);
    // Every finished task is somewhere: on a card of its own or in its step's folded card.
    const inside = [...folded.folded.values()].flat();
    expect(inside.length + cards.filter((id) => !id.startsWith('fold:') && isDone(id)).length).toBe(90);
  });

  it('keeps a step’s few finished tasks as cards', () => {
    const steps = [['ACME-1', 'ACME-2'], ['ACME-3']];
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-3'],
      ['ACME-2', 'ACME-3'],
    ]);
    const folded = foldDone(steps, edges, { done: (id) => id !== 'ACME-3' });
    expect(folded.steps).toEqual(steps);
    expect(folded.edges).toEqual(edges);
  });

  it('draws one arrow from a folded card to each task that waits on it', () => {
    const steps = [
      ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4'],
      ['ACME-5', 'ACME-6'],
    ];
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-5'],
      ['ACME-2', 'ACME-5'],
      ['ACME-3', 'ACME-5'],
      ['ACME-4', 'ACME-6'],
      ['ACME-4', 'ACME-5'],
    ]);
    const done = (id) => ['ACME-2', 'ACME-3', 'ACME-4'].includes(id);
    const folded = foldDone(steps, edges, { done });
    expect(folded.steps[0]).toEqual(['ACME-1', foldId(0)]);
    expect(folded.folded.get(foldId(0))).toEqual(['ACME-2', 'ACME-3', 'ACME-4']);
    expect(folded.edges).toEqual([
      ['ACME-1', 'ACME-5'],
      [foldId(0), 'ACME-5'],
      [foldId(0), 'ACME-6'],
    ]);
  });

  it('opens a step the person unfolded', () => {
    const steps = [['ACME-1', 'ACME-2', 'ACME-3'], ['ACME-4']];
    const edges = /** @type {[string, string][]} */ ([['ACME-1', 'ACME-4']]);
    const folded = foldDone(steps, edges, { done: (id) => id !== 'ACME-4', unfold: new Set([0]) });
    expect(folded.steps).toEqual(steps);
    expect(folded.folded.size).toBe(0);
  });
});

describe('the path to the last task', () => {
  it('is the longest run of open tasks to the group’s last one', () => {
    // 1 → 2 → 3 → 6, and 4 → 6, 5 → 3: the path is 1, 2, 3, 6 (5 ties with 2 but comes later by rank).
    const order = ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4', 'ACME-5', 'ACME-6'];
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-2'],
      ['ACME-2', 'ACME-3'],
      ['ACME-3', 'ACME-6'],
      ['ACME-4', 'ACME-6'],
      ['ACME-5', 'ACME-3'],
    ]);
    expect(criticalPath(order, edges, () => true)).toEqual(['ACME-1', 'ACME-2', 'ACME-3', 'ACME-6']);
  });

  it('runs through open tasks only', () => {
    const order = ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4'];
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-2'],
      ['ACME-2', 'ACME-3'],
      ['ACME-3', 'ACME-4'],
    ]);
    expect(criticalPath(order, edges, (id) => id !== 'ACME-1')).toEqual(['ACME-2', 'ACME-3', 'ACME-4']);
  });

  it('ends on a big feature’s last task', () => {
    const { ids, edges, isDone } = bigFeature();
    const path = criticalPath(ids, edges, (id) => !isDone(id));
    expect(path).toEqual(ids.slice(90));
  });

  it('is empty when no open task waits for another', () => {
    expect(criticalPath(['ACME-1', 'ACME-2'], [['ACME-1', 'ACME-2']], (id) => id === 'ACME-2')).toEqual([]);
  });

  it('stops at a cycle instead of looping', () => {
    const edges = /** @type {[string, string][]} */ ([
      ['ACME-1', 'ACME-2'],
      ['ACME-2', 'ACME-1'],
    ]);
    const path = criticalPath(['ACME-1', 'ACME-2'], edges, () => true);
    expect(path.length).toBeLessThanOrEqual(2);
  });
});
