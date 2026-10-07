import { describe, expect, it } from 'vitest';
import {
  DAY,
  OWNER_RATE,
  STEP_DAYS,
  explain,
  history,
  membership,
  neighbour,
  project,
  scale,
  span,
} from '../web/src/lib/roadmap-timeline.js';

// The roadmap's timeline (WEB-102), on made-up tasks.

const NOW = Date.parse('2026-10-07T12:00:00Z');
const iso = (days) => new Date(NOW + days * DAY).toISOString();
let n = 0;
/** A task; `done` is how many days ago it finished. */
function task({ tags = [], project = 'web', done, start, depends = [], ...rest } = {}) {
  n += 1;
  return {
    uuid: `u${n}`,
    wid: `T-${n}`,
    status: done === undefined ? 'pending' : 'completed',
    end: done === undefined ? null : iso(-done),
    start: start === undefined ? null : iso(-start),
    project,
    tags,
    depends,
    github: [],
    decision: null,
    decisionAnswers: null,
    ...rest,
  };
}
/** `count` agent tasks in `area`, finished over the window. */
const finished = (count, area = 'web', tags = []) =>
  Array.from({ length: count }, (_, i) => task({ project: area, done: 1 + (i % 27), tags }));

describe('membership', () => {
  it('puts a task in the first of its feature tags alphabetically', () => {
    const a = task({ tags: ['zeta', 'alpha'] });
    const b = task({ tags: ['zeta'] });
    const c = task({ tags: ['other'] });
    const m = membership([a, b, c], ['alpha', 'zeta']);
    expect(m.get('alpha')).toEqual([a]);
    expect(m.get('zeta')).toEqual([b]);
  });
});

describe('history', () => {
  it('counts each area’s agent tasks a day over the window, and the owner’s steps apart', () => {
    const past = history([...finished(28, 'web'), ...finished(14, 'board'), ...finished(7, 'web', ['owner'])], NOW);
    expect(past.areas.get('web').avg).toBeCloseTo(1);
    expect(past.areas.get('board').avg).toBeCloseTo(0.5);
    expect(past.overall.avg).toBeCloseTo(1.5);
    expect(past.owner).toBeCloseTo(0.25);
  });

  it('takes the best week as the optimistic pace', () => {
    const past = history(
      Array.from({ length: 14 }, () => task({ done: 2 })),
      NOW,
    );
    expect(past.areas.get('web').avg).toBeCloseTo(0.5);
    expect(past.areas.get('web').best).toBeCloseTo(2);
  });

  it('ignores tasks finished before the window and open ones', () => {
    const past = history([task({ done: 40 }), task()], NOW);
    expect(past.overall).toBeNull();
    expect(past.areas.size).toBe(0);
  });

  it('measures a chain step from tasks that finished one after the other', () => {
    const a = task({ done: 10 });
    const b = task({ done: 8, depends: [a.uuid] });
    const c = task({ done: 4, depends: [b.uuid] });
    const past = history([a, b, c], NOW);
    expect(past.measuredSteps).toBe(2);
    expect(past.step).toBeCloseTo(4);
    expect(past.stepFast).toBeCloseTo(2);
  });

  it('falls back to a day a step with no finished pair', () => {
    expect(history([], NOW).step).toBe(STEP_DAYS);
  });
});

describe('project', () => {
  const pace = finished(28, 'web'); // web: one a day, every week the same

  it('ends a feature after its open tasks at its area’s pace, starting today when nothing has', () => {
    const tasks = [...pace, task({ tags: ['a'] }), task({ tags: ['a'] }), task({ tags: ['a'] })];
    const p = project([{ slug: 'a' }], tasks, NOW).get('a');
    expect(p.state).toBe('open');
    expect(p.projectedStart).toBe(true);
    expect(p.start).toBe(NOW);
    expect(p.likely).toBe(NOW + 3 * DAY);
    expect(p.optimistic).toBeLessThanOrEqual(p.likely);
    expect(p.ownerSteps).toBe(0);
    expect(p.ownerFrom).toBe(p.likely);
  });

  it('queues features in the same area in roadmap order', () => {
    const tasks = [...pace, task({ tags: ['first'] }), task({ tags: ['first'] }), task({ tags: ['second'] })];
    const out = project([{ slug: 'first' }, { slug: 'second' }], tasks, NOW);
    expect(out.get('first').likely).toBe(NOW + 2 * DAY);
    expect(out.get('second').start).toBe(NOW + 2 * DAY);
    expect(out.get('second').likely).toBe(NOW + 3 * DAY);
  });

  it('keeps features in different areas side by side', () => {
    const tasks = [
      ...pace,
      ...finished(28, 'board'),
      task({ tags: ['web-one'] }),
      task({ tags: ['board-one'], project: 'board' }),
    ];
    const out = project([{ slug: 'web-one' }, { slug: 'board-one' }], tasks, NOW);
    expect(out.get('board-one').start).toBe(NOW);
    expect(out.get('board-one').likely).toBe(NOW + DAY);
  });

  it('borrows the board’s pace for an area with no history', () => {
    const tasks = [...pace, task({ tags: ['a'], project: 'docs' })];
    const p = project([{ slug: 'a' }], tasks, NOW).get('a');
    expect(p.areas).toEqual([expect.objectContaining({ area: 'docs', borrowed: true })]);
    expect(p.likely).toBe(NOW + DAY);
  });

  it('never ends sooner than its longest chain allows', () => {
    const a = task({ tags: ['chain'] });
    const b = task({ tags: ['chain'], depends: [a.uuid] });
    const c = task({ tags: ['chain'], depends: [b.uuid] });
    const fast = finished(280, 'web'); // ten a day
    const p = project([{ slug: 'chain' }], [...fast, a, b, c], NOW).get('chain');
    expect(p.chain).toBe(3);
    expect(p.likely).toBe(NOW + 3 * STEP_DAYS * DAY);
  });

  it('puts the owner’s steps after the agents’ work, at the owner’s pace', () => {
    const tasks = [
      ...pace,
      task({ tags: ['a'] }),
      task({ tags: ['a', 'owner'] }),
      task({ tags: ['a'], github: [{ closes: true, state: 'open' }] }),
    ];
    const p = project([{ slug: 'a' }], tasks, NOW).get('a');
    expect(p.agentOpen).toBe(1);
    expect(p.ownerSteps).toBe(2);
    expect(p.ownerFrom).toBe(NOW + DAY);
    expect(p.likely).toBe(NOW + DAY + (2 / OWNER_RATE) * DAY);
    expect(p.optimistic).toBeLessThan(p.ownerFrom + 1);
  });

  it('starts a feature at its first claim or finished task', () => {
    const tasks = [...pace, task({ tags: ['a'], done: 5 }), task({ tags: ['a'], start: 2 })];
    const p = project([{ slug: 'a' }], tasks, NOW).get('a');
    expect(p.projectedStart).toBe(false);
    expect(p.start).toBe(NOW - 5 * DAY);
  });

  it('ends a done feature when its last task did, and has nothing for an empty one', () => {
    const tasks = [task({ tags: ['a'], done: 9 }), task({ tags: ['a'], done: 3 })];
    const out = project([{ slug: 'a' }, { slug: 'b' }], tasks, NOW);
    expect(out.get('a')).toMatchObject({ state: 'done', start: NOW - 9 * DAY, end: NOW - 3 * DAY });
    expect(out.get('b')).toMatchObject({ state: 'empty', start: null, end: null });
  });

  it('says it can’t estimate with no pace at all', () => {
    const p = project([{ slug: 'a' }], [task({ tags: ['a'] })], NOW).get('a');
    expect(p.state).toBe('unknown');
    expect(p.likely).toBeNull();
    expect(explain(p, history([], NOW), NOW)).toMatch(/Can’t estimate yet/u);
  });
});

describe('explain', () => {
  it('gives the range, the pace, the chain, and the owner’s steps in words', () => {
    const a = task({ tags: ['a'] });
    const tasks = [
      ...finished(14, 'web'),
      a,
      task({ tags: ['a'], depends: [a.uuid] }),
      task({ tags: ['a', 'decide'] }),
    ];
    const past = history(tasks, NOW);
    const text = explain(project([{ slug: 'a' }], tasks, NOW, past).get('a'), past, NOW);
    expect(text).toMatch(/^Likely done by \d+ \w+/u);
    expect(text).toMatch(/2 open in web at web’s pace, one every 2 days over 28 days\./u);
    expect(text).toMatch(/longest chain is 2 tasks/u);
    expect(text).toMatch(/1 step is yours/u);
    expect(text).toMatch(/Nothing in it has started yet\./u);
  });
});

describe('the scale', () => {
  it('spans from the Monday a week before now to two weeks past the last end', () => {
    const range = span([{ start: NOW, likely: NOW + 40 * DAY }], NOW);
    expect(new Date(range.from).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(range.to).toBeGreaterThanOrEqual(NOW + 40 * DAY + 7 * DAY);
  });

  it('ticks each Monday in weeks and each month in months', () => {
    const range = { from: Date.parse('2026-09-28T00:00:00Z'), to: Date.parse('2027-01-11T00:00:00Z') };
    const weeks = scale(range, 'weeks', NOW);
    expect(weeks.ticks[0]).toMatchObject({ x: 0, label: '28 Sept' });
    expect(weeks.ticks[1].x).toBe(7 * 28);
    const months = scale(range, 'months', NOW);
    expect(months.ticks.map((t) => t.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan 2027']);
    expect(months.width).toBe(105 * 7);
  });

  it('finds the lane before and after', () => {
    expect(neighbour(['1.0.0', '1.1.0', null], '1.1.0', 1)).toBeNull();
    expect(neighbour(['1.0.0', '1.1.0', null], '1.0.0', -1)).toBeUndefined();
  });
});
