import { describe, expect, it } from 'vitest';
import { CRON_MS, FAST_MS, SHARE, hourlyAllowance, plannedPerHour, syncPace } from '../src/github-pace.js';

// How fast a busy repository syncs (BRK-272), from the budgets the last syncs left. Pure: no GitHub here.

const NOW = Date.UTC(2026, 9, 8, 13, 0);
const MIN = 60_000;
const at = (ms) => new Date(NOW + ms).toISOString();

/** A repository's budgets after a sync like breakaway's measured one (5 REST calls, 1 GraphQL query). */
function repo({ busy = false, core = 4600, graphql = 4900, resetIn = 30 * MIN, calls = { core: 5, graphql: 1 } } = {}) {
  return {
    busy,
    budget: {
      at: at(0),
      limits: {
        core: { remaining: core, limit: 5000, reset: at(resetIn) },
        graphql: { remaining: graphql, limit: 5000, reset: at(resetIn) },
      },
      calls,
      free: 4,
    },
  };
}

describe('the budget an hour the board plans on', () => {
  it('is half the hourly limit while plenty is left', () => {
    expect(hourlyAllowance({ remaining: 4600, limit: 5000, reset: at(30 * MIN) }, NOW)).toBe(5000 * SHARE);
  });

  it('shrinks with what is left before the reset', () => {
    // 400 left for the next half hour: half of it, 200, over 30 minutes is 400 an hour.
    expect(hourlyAllowance({ remaining: 400, limit: 5000, reset: at(30 * MIN) }, NOW)).toBe(400);
    expect(hourlyAllowance({ remaining: 0, limit: 5000, reset: at(30 * MIN) }, NOW)).toBe(0);
  });

  it('is whole again past the reset, and unknown when nothing is known', () => {
    expect(hourlyAllowance({ remaining: 0, limit: 5000, reset: at(-MIN) }, NOW)).toBe(2500);
    expect(hourlyAllowance(null, NOW)).toBeNull();
    // A used-up budget the client marked has no limit: nothing to spend until it resets.
    expect(hourlyAllowance({ remaining: 0, reset: at(10 * MIN) }, NOW)).toBe(0);
    expect(hourlyAllowance({ remaining: 0, reset: at(-MIN) }, NOW)).toBeNull();
  });
});

describe('the pace of a busy repository', () => {
  it('is every minute with the budgets the board measured', () => {
    expect(syncPace([repo({ busy: true }), repo(), repo()], NOW)).toBe(FAST_MS);
  });

  it('is no faster than the cron while nothing is busy', () => {
    expect(syncPace([repo(), repo()], NOW)).toBeNull();
    expect(syncPace([], NOW)).toBeNull();
  });

  it('slows as the budget left shrinks, then stops and leaves it to the cron', () => {
    const pace = (core) => syncPace([repo({ busy: true, core }), repo({ core }), repo({ core })], NOW);
    const paces = [4600, 1000, 600, 400, 300, 200, 100, 0].map(pace);
    expect(paces[0]).toBe(FAST_MS);
    for (let i = 1; i < paces.length; i += 1) {
      if (paces[i - 1] === null) expect(paces[i]).toBeNull();
      else if (paces[i] !== null) expect(paces[i]).toBeGreaterThanOrEqual(paces[i - 1]);
    }
    expect(paces.some((p) => p !== null && p > FAST_MS && p < CRON_MS)).toBe(true);
    expect(paces.at(-1)).toBeNull();
    expect(paces.every((p) => p === null || p < CRON_MS)).toBe(true);
  });

  it('plans on the least any repository has left, since they may share one installation', () => {
    expect(syncPace([repo({ busy: true }), repo({ core: 150 })], NOW)).toBeNull();
  });

  it('waits for a busy repository’s first sync to know what GitHub has left', () => {
    expect(syncPace([{ busy: true, budget: null }], NOW)).toBeNull();
  });

  it('slows for GraphQL too, when that budget is the one running out', () => {
    expect(syncPace([repo({ busy: true, graphql: 60 })], NOW)).toBeGreaterThan(FAST_MS);
  });

  it('stays under half of an hour’s budget across several repositories', () => {
    for (const core of [5000, 3000, 1500, 800, 400]) {
      for (const busy of [1, 4, 10]) {
        const repos = Array.from({ length: 12 }, (_, i) => repo({ busy: i < busy, core, resetIn: 59 * MIN }));
        const pace = syncPace(repos, NOW);
        // With room to sync faster, everything planned fits in what the budget left allows, never over half.
        if (pace)
          expect(plannedPerHour(repos, pace, 'core')).toBeLessThanOrEqual(
            hourlyAllowance(repos[0].budget.limits.core, NOW),
          );
        expect(plannedPerHour(repos, pace, 'core')).toBeLessThanOrEqual(5000 * SHARE);
      }
    }
  });
});
