import { describe, expect, it } from 'vitest';
import {
  DAY,
  barDays,
  dragPlan,
  OWNER_RATE,
  STEP_DAYS,
  explain,
  explainPlan,
  fitPx,
  history,
  lanePlanEnd,
  membership,
  neighbour,
  ordered,
  planDays,
  planOf,
  planStatus,
  project,
  scale,
  span,
  statusWords,
  suggest,
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
      task({ who: 'person', assignee: 'owner', tags: ['a'] }),
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
      task({ who: 'decision', tags: ['a'] }),
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

  it('takes in the plans, to the end of their last day', () => {
    const range = span([{ start: NOW, likely: NOW + 3 * DAY }], NOW, [
      { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-12-31T00:00:00Z') },
      null,
    ]);
    expect(new Date(range.from).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(range.to).toBeGreaterThan(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('ticks each Monday when a week has room, and each month when it hasn’t', () => {
    const range = { from: Date.parse('2026-09-28T00:00:00Z'), to: Date.parse('2027-01-11T00:00:00Z') };
    const weeks = scale(range, 28, NOW);
    expect(weeks.ticks[0]).toMatchObject({ x: 0, label: '28 Sept' });
    expect(weeks.ticks[1].x).toBe(7 * 28);
    const months = scale(range, 7, NOW);
    expect(months.ticks.map((t) => t.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan 2027']);
    expect(months.width).toBe(105 * 7);
  });

  it('fits a week before today to a week past the last end in the width', () => {
    expect(fitPx(1400, NOW, NOW + 56 * DAY)).toBe(20);
    // Never less than a week ahead, and never wider than a day can be.
    expect(fitPx(1050, NOW, NOW + DAY)).toBe(50);
    expect(fitPx(100_000, NOW, null)).toBe(60);
    expect(fitPx(100, NOW, NOW + 400 * DAY)).toBe(2);
  });

  it('finds the lane before and after', () => {
    expect(neighbour(['1.0.0', '1.1.0', null], '1.1.0', 1)).toBeNull();
    expect(neighbour(['1.0.0', '1.1.0', null], '1.0.0', -1)).toBeUndefined();
  });
});

describe('the plan', () => {
  const pace = finished(28, 'web'); // web: one a day
  const TODAY = '2026-10-07';
  /** A feature with `open` open web tasks, its projection, and a plan. */
  function planned(open, plan, extra = []) {
    const tasks = [...pace, ...Array.from({ length: open }, () => task({ tags: ['a'] })), ...extra];
    const p = project([{ slug: 'a' }], tasks, NOW).get('a');
    return { f: { slug: 'a', title: 'A', ...plan }, p };
  }

  it('reads the days as midnights UTC, and nothing without them', () => {
    expect(planOf({ plannedStart: null, plannedEnd: null })).toBeNull();
    expect(planOf({ plannedStart: null, plannedEnd: '2026-10-19' })).toEqual({
      start: null,
      end: Date.parse('2026-10-19T00:00:00Z'),
    });
  });

  it('suggests the pace’s start and likely end, and nothing without an estimate', () => {
    const { p } = planned(5, {});
    expect(suggest(p, NOW)).toEqual({ plannedStart: TODAY, plannedEnd: '2026-10-12' });
    expect(suggest(project([{ slug: 'a' }], [task({ tags: ['a'] })], NOW).get('a'), NOW)).toBeNull();
  });

  it('is on plan when the likely end is on or before the planned end', () => {
    const { f, p } = planned(5, { plannedStart: TODAY, plannedEnd: '2026-10-12' });
    expect(planStatus(f, p, NOW)).toEqual({ kind: 'on', days: 0 });
    expect(statusWords(planStatus(f, p, NOW))).toBe('On plan');
  });

  it('is behind by the days the likely end is past the planned end, when even its best is late', () => {
    const { f, p } = planned(5, { plannedStart: TODAY, plannedEnd: '2026-10-08' });
    expect(p.optimistic).toBeGreaterThan(Date.parse('2026-10-09T00:00:00Z'));
    expect(planStatus(f, p, NOW)).toEqual({ kind: 'behind', days: 4 });
    expect(statusWords(planStatus(f, p, NOW))).toBe('Behind by 4 days');
    expect(explainPlan(f, p, NOW)).toBe('Planned 7 to 8 Oct: behind by 4 days, even at the pace’s best.');
  });

  it('could slip when the planned end is between the pace’s best and its likely end', () => {
    // One open task and one of the owner's: the agents' work is done in a day, the owner's step after it.
    const { f, p } = planned(1, { plannedEnd: '2026-10-08' }, [
      task({ who: 'person', assignee: 'owner', tags: ['a'] }),
    ]);
    expect(p.likely).toBeGreaterThan(Date.parse('2026-10-09T00:00:00Z'));
    expect(planStatus(f, p, NOW)).toEqual({ kind: 'slip', days: 0 });
    expect(statusWords(planStatus(f, p, NOW))).toBe('Could slip');
  });

  it('is not started when the planned start has passed and nothing in it is claimed', () => {
    const { f, p } = planned(2, { plannedStart: '2026-10-01', plannedEnd: '2026-10-30' });
    expect(planStatus(f, p, NOW)).toEqual({ kind: 'not-started', days: 0 });
    const claimed = planned(2, { plannedStart: '2026-10-01', plannedEnd: '2026-10-30' }, [
      task({ tags: ['a'], start: 1 }),
    ]);
    expect(planStatus(claimed.f, claimed.p, NOW).kind).toBe('on');
    expect(explainPlan(f, p, NOW)).toMatch(/not started, though the plan started on 1 Oct\./u);
  });

  it('draws only the plan when the pace can’t estimate, and says how a done feature went', () => {
    const unknown = project([{ slug: 'a' }], [task({ tags: ['a'] })], NOW).get('a');
    expect(planStatus({ plannedStart: '2026-10-20', plannedEnd: '2026-10-30' }, unknown, NOW).kind).toBe('planned');
    const done = project([{ slug: 'a' }], [task({ tags: ['a'], done: 2 })], NOW).get('a');
    expect(planStatus({ plannedEnd: '2026-10-02' }, done, NOW)).toEqual({ kind: 'done', days: 3 });
    expect(statusWords({ kind: 'done', days: 0 })).toBe('Done on plan');
    expect(planStatus({ plannedStart: null, plannedEnd: null }, done, NOW)).toBeNull();
  });

  it('says the days in words', () => {
    expect(planDays({ plannedStart: '2026-10-12', plannedEnd: '2026-10-19' }, NOW)).toBe('12 to 19 Oct');
    expect(planDays({ plannedStart: '2026-10-30', plannedEnd: '2026-11-02' }, NOW)).toBe('30 Oct to 2 Nov');
    expect(planDays({ plannedStart: null, plannedEnd: '2026-10-19' }, NOW)).toBe('by 19 Oct');
    expect(planDays({ plannedStart: '2026-10-12', plannedEnd: null }, NOW)).toBe('from 12 Oct');
    expect(planDays({ plannedStart: '2026-10-12', plannedEnd: '2026-10-12' }, NOW)).toBe('12 Oct');
  });

  it('orders a lane by planned start, then the pace’s start', () => {
    const projections = new Map([
      ['a', { start: NOW }],
      ['b', { start: NOW + 5 * DAY }],
      ['c', { start: NOW + 2 * DAY }],
    ]);
    const features = [
      { slug: 'a', title: 'A', plannedStart: null },
      { slug: 'b', title: 'B', plannedStart: '2026-10-01' },
      { slug: 'c', title: 'C', plannedStart: null },
    ];
    expect(ordered(features, projections, NOW).map((f) => f.slug)).toEqual(['b', 'a', 'c']);
  });

  it('gives a lane the latest planned end in it', () => {
    expect(lanePlanEnd([{ plannedEnd: '2026-10-19' }, { plannedEnd: null }, { plannedEnd: '2026-11-02' }])).toBe(
      Date.parse('2026-11-02T00:00:00Z'),
    );
    expect(lanePlanEnd([{ plannedEnd: null }])).toBeNull();
  });
});

describe('the bar is the plan', () => {
  const pace = finished(28, 'web');
  const at = (d) => Date.parse(`${d}T00:00:00Z`);

  it('spans the pace’s start and likely end until there’s a plan, then the plan', () => {
    const p = project([{ slug: 'a' }], [...pace, ...Array.from({ length: 5 }, () => task({ tags: ['a'] }))], NOW).get(
      'a',
    );
    expect(barDays({}, p, NOW)).toEqual({ start: at('2026-10-07'), end: at('2026-10-12'), planned: false });
    expect(barDays({ plannedStart: '2026-10-20', plannedEnd: '2026-10-30' }, p, NOW)).toEqual({
      start: at('2026-10-20'),
      end: at('2026-10-30'),
      planned: true,
    });
    // One planned end alone keeps the pace's length.
    expect(barDays({ plannedEnd: '2026-10-30' }, p, NOW).start).toBe(at('2026-10-25'));
  });

  it('gives a feature with no estimate a week', () => {
    const p = project([{ slug: 'a' }], [task({ tags: ['a'] })], NOW).get('a');
    expect(barDays({}, p, NOW)).toEqual({ start: at('2026-10-07'), end: at('2026-10-13'), planned: false });
  });

  it('moves both ends, or one, never past the other', () => {
    const bar = { start: at('2026-10-12'), end: at('2026-10-14') };
    expect(dragPlan(bar, 'move', 3)).toEqual({ plannedStart: '2026-10-15', plannedEnd: '2026-10-17' });
    expect(dragPlan(bar, 'end', 2)).toEqual({ plannedStart: '2026-10-12', plannedEnd: '2026-10-16' });
    expect(dragPlan(bar, 'start', 5)).toEqual({ plannedStart: '2026-10-14', plannedEnd: '2026-10-14' });
    expect(dragPlan(bar, 'end', -5)).toEqual({ plannedStart: '2026-10-12', plannedEnd: '2026-10-12' });
  });
});
