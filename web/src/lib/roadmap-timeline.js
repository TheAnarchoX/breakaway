// The roadmap's timeline (WEB-102): when each feature is likely done, worked out from the board's own history, and
// where its bar sits. Pure, so the projection and the layout are tested on made-up tasks (test/roadmap-timeline.test.js).
import { criticalPath } from './graph-layout.js';

export const DAY = 86_400_000;
/** How far back the board looks for what agents and the owner get done. */
export const WINDOW_DAYS = 28;
/** A chain step's time when the history has no finished pair of tasks, one waiting for the other. */
export const STEP_DAYS = 1;
/** Owner steps a day when the history has none finished. */
export const OWNER_RATE = 1;
/** Pixels a day at each zoom. */
export const ZOOMS = { weeks: 28, months: 7 };

const time = (iso) => (iso ? Date.parse(iso) : Number.NaN);

/** A step for the owner, not an agent: a decision to make or a +owner task. */
export const ownerStep = (t) =>
  t.tags.includes('owner') || t.tags.includes('decide') || Boolean(t.decision && !t.decisionAnswers);
/** Its pull request is open: merging it is the owner's. */
export const inReview = (t) => Boolean(t.github?.some((p) => p.closes && p.state === 'open'));

/**
 * Each feature's tasks, the way the board counts them: a task is in the feature whose slug it carries, the first
 * alphabetically when it carries more than one.
 * @param {any[]} tasks every task that isn't deleted
 * @param {string[]} slugs
 * @returns {Map<string, any[]>}
 */
export function membership(tasks, slugs) {
  const known = new Set(slugs);
  const out = new Map(slugs.map((s) => [s, []]));
  for (const t of tasks) {
    const mine = t.tags.filter((tag) => known.has(tag)).sort()[0];
    if (mine) out.get(mine).push(t);
  }
  return out;
}

/** The value at fraction `q` of a sorted list. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * What the board gets done, from the tasks finished in the last `windowDays` days: each area's agent tasks a day
 * (on average, and in its best week), the owner's steps a day, and how long a chain step takes (the time from a
 * task finishing to the next one waiting for it finishing).
 * @param {any[]} tasks
 * @param {number} now
 * @param {number} [windowDays]
 */
export function history(tasks, now, windowDays = WINDOW_DAYS) {
  const since = now - windowDays * DAY;
  const weeks = Math.max(1, Math.floor(windowDays / 7));
  const recent = tasks.filter((t) => t.status === 'completed' && time(t.end) > since && time(t.end) <= now);
  const areas = new Map();
  const all = new Array(weeks).fill(0);
  let owner = 0;
  for (const t of recent) {
    if (ownerStep(t)) {
      owner += 1;
      continue;
    }
    const week = Math.min(weeks - 1, Math.floor((now - time(t.end)) / (7 * DAY)));
    const area = t.project ?? 'none';
    if (!areas.has(area)) areas.set(area, new Array(weeks).fill(0));
    areas.get(area)[week] += 1;
    all[week] += 1;
  }
  const rate = (counts) => {
    const total = counts.reduce((a, b) => a + b, 0);
    return total ? { avg: total / windowDays, best: Math.max(total / windowDays, Math.max(...counts) / 7) } : null;
  };
  const byUuid = new Map(tasks.map((t) => [t.uuid, t]));
  const gaps = [];
  for (const t of recent)
    for (const d of t.depends ?? []) {
      const dep = byUuid.get(d);
      const gap = (time(t.end) - time(dep?.end)) / DAY;
      if (dep?.status === 'completed' && gap > 0) gaps.push(gap);
    }
  gaps.sort((a, b) => a - b);
  const clamp = (days) => Math.min(7, Math.max(0.1, days));
  return {
    windowDays,
    areas: new Map([...areas].map(([area, counts]) => [area, rate(counts)])),
    overall: rate(all),
    owner: owner ? owner / windowDays : null,
    step: gaps.length ? clamp(quantile(gaps, 0.5)) : STEP_DAYS,
    stepFast: gaps.length ? clamp(quantile(gaps, 0.25)) : STEP_DAYS / 2,
    measuredSteps: gaps.length,
  };
}

/**
 * When each feature is likely done, and when at best (WEB-102). Features queue in each area in the order given
 * (the roadmap's: release, then title), since agents in an area work through them about one release at a time.
 * A feature's agent work ends when the last of its areas gets through its open tasks, and never sooner than its
 * longest chain of open tasks allows; its steps for the owner (decisions, +owner tasks, pull requests to merge)
 * come after, at the owner's pace. The optimistic end takes each area's best week and the owner's steps as done
 * at once. Done features end when their last task did.
 * @param {any[]} features the roadmap's features, in its order
 * @param {any[]} tasks every task that isn't deleted
 * @param {number} now
 * @param {ReturnType<typeof history>} [past]
 */
export function project(features, tasks, now, past = history(tasks, now)) {
  const members = membership(
    tasks,
    features.map((f) => f.slug),
  );
  const cursor = new Map();
  const cursorFast = new Map();
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const f of features) {
    const mine = members.get(f.slug) ?? [];
    const open = mine.filter((t) => t.status === 'pending');
    const finished = mine.filter((t) => t.status === 'completed');
    const begun = [...open.map((t) => time(t.start)), ...finished.map((t) => time(t.end))].filter(Number.isFinite);
    const started = begun.length ? Math.min(...begun) : null;
    if (!open.length) {
      const ends = finished.map((t) => time(t.end)).filter(Number.isFinite);
      const end = ends.length ? Math.max(...ends) : null;
      out.set(f.slug, {
        slug: f.slug,
        state: mine.length ? 'done' : 'empty',
        start: started ?? end,
        end,
        tasks: mine.length,
      });
      continue;
    }
    const agent = open.filter((t) => !ownerStep(t) && !inReview(t));
    const owner = open.length - agent.length;
    const byArea = new Map();
    for (const t of agent) byArea.set(t.project ?? 'none', (byArea.get(t.project ?? 'none') ?? 0) + 1);
    const areas = [];
    let likelyAgent = 0;
    let fastAgent = 0;
    let queued = Number.POSITIVE_INFINITY;
    let unknown = false;
    for (const [area, n] of [...byArea].sort((a, b) => a[0].localeCompare(b[0]))) {
      const own = past.areas.get(area) ?? null;
      const rate = own ?? past.overall;
      if (!rate) {
        unknown = true;
        areas.push({ area, open: n, rate: null, borrowed: false });
        continue;
      }
      const before = cursor.get(area) ?? 0;
      queued = Math.min(queued, before);
      const done = before + n / rate.avg;
      const fast = (cursorFast.get(area) ?? 0) + n / rate.best;
      cursor.set(area, done);
      cursorFast.set(area, fast);
      likelyAgent = Math.max(likelyAgent, done);
      fastAgent = Math.max(fastAgent, fast);
      areas.push({ area, open: n, rate: rate.avg, borrowed: !own, queued: before });
    }
    const inside = new Set(agent.map((t) => t.uuid));
    const edges = [];
    for (const t of agent) for (const d of t.depends ?? []) if (inside.has(d)) edges.push([d, t.uuid]);
    const ids = agent.map((t) => t.uuid);
    const chain = agent.length ? Math.max(1, criticalPath(ids, edges, () => true).length) : 0;
    likelyAgent = Math.max(likelyAgent, chain * past.step);
    fastAgent = Math.max(fastAgent, chain * past.stepFast);
    const ownerDays = owner / (past.owner ?? OWNER_RATE);
    const at = (days) => now + days * DAY;
    const start = started ?? at(Number.isFinite(queued) ? queued : 0);
    out.set(f.slug, {
      slug: f.slug,
      state: unknown ? 'unknown' : 'open',
      start,
      projectedStart: started === null,
      optimistic: unknown ? null : Math.max(start, at(fastAgent)),
      ownerFrom: unknown ? null : Math.max(start, at(likelyAgent)),
      likely: unknown ? null : Math.max(start, at(likelyAgent + ownerDays)),
      open: open.length,
      agentOpen: agent.length,
      ownerSteps: owner,
      chain,
      areas,
      tasks: mine.length,
    });
  }
  return out;
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DATE_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });

/** `14 Oct`, with the year when it isn't `now`'s. */
export function day(ms, now) {
  return new Date(ms).getUTCFullYear() === new Date(now).getUTCFullYear() ? DATE.format(ms) : DATE_YEAR.format(ms);
}

const perDay = (rate) => {
  if (rate >= 1) return `${Math.round(rate * 10) / 10} a day`;
  const every = Math.round(1 / rate);
  return every <= 1 ? 'one a day' : `one every ${every} days`;
};

/**
 * How a projection was worked out, in words, for the bar's hover and focus.
 * @param {any} p one of `project`'s
 * @param {ReturnType<typeof history>} past
 * @param {number} now
 */
export function explain(p, past, now) {
  if (p.state === 'empty') return 'No tasks yet, so nothing to estimate.';
  if (p.state === 'done') return p.end ? `Every task is done; the last on ${day(p.end, now)}.` : 'Every task is done.';
  const lines = [];
  if (p.state === 'unknown')
    lines.push(
      `Can’t estimate yet: no agent task finished in the last ${past.windowDays} days, so there’s no pace to go by.`,
    );
  else
    lines.push(
      p.optimistic === p.likely || day(p.optimistic, now) === day(p.likely, now)
        ? `Likely done by ${day(p.likely, now)}.`
        : `Likely done by ${day(p.likely, now)}, ${day(p.optimistic, now)} at best. An estimate, not a promise.`,
    );
  for (const a of p.areas) {
    if (a.rate === null) continue;
    const pace = `${a.borrowed ? 'the board’s pace' : `${a.area}’s pace`}, ${perDay(a.rate)} over ${past.windowDays} days`;
    lines.push(
      `${a.open} open in ${a.area} at ${pace}${a.queued > 0.05 ? ', after the features ahead of it there' : ''}.`,
    );
  }
  if (p.chain > 1) lines.push(`Its longest chain is ${p.chain} tasks, each waiting for the one before.`);
  if (p.ownerSteps)
    lines.push(
      `${p.ownerSteps === 1 ? '1 step is' : `${p.ownerSteps} steps are`} yours (a decision, a +owner task, or a merge), at ${
        past.owner ? `your pace, ${perDay(past.owner)}` : 'one a day, until you’ve finished some'
      }.`,
    );
  if (p.projectedStart) lines.push('Nothing in it has started yet.');
  return lines.join(' ');
}

/** Midnight UTC on the Monday of `ms`'s week. */
function monday(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
}

/**
 * The span the timeline draws: from the Monday before the earliest bar (and at least a week before now) to a
 * week past the last likely end (and at least four weeks after now).
 * @param {Iterable<any>} projections
 * @param {number} now
 */
export function span(projections, now) {
  let from = now - 7 * DAY;
  let to = now + 28 * DAY;
  for (const p of projections) {
    for (const ms of [p.start, p.end, p.likely]) {
      if (!Number.isFinite(ms) || ms === null) continue;
      from = Math.min(from, ms);
      to = Math.max(to, ms);
    }
  }
  return { from: monday(from), to: monday(to) + 14 * DAY };
}

/**
 * The timeline's scale at `zoom`: where a time sits, in pixels from the left, the whole width, and the ticks
 * (each Monday in weeks, each month's first day in months) with their labels.
 * @param {{ from: number, to: number }} range
 * @param {string} zoom `weeks` or `months`
 * @param {number} now
 */
export function scale({ from, to }, zoom, now) {
  const px = ZOOMS[zoom] ?? ZOOMS.weeks;
  const x = (ms) => Math.round(((ms - from) / DAY) * px);
  const ticks = [];
  if (zoom === 'months') {
    const d = new Date(from);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
    for (let m = d.getTime(); m < to; ) {
      const date = new Date(m);
      if (m >= from)
        ticks.push({
          at: m,
          x: x(m),
          label: date.getUTCFullYear() === new Date(now).getUTCFullYear() ? MONTH.format(m) : MONTH_YEAR.format(m),
        });
      date.setUTCMonth(date.getUTCMonth() + 1);
      m = date.getTime();
    }
  } else for (let m = from; m < to; m += 7 * DAY) ticks.push({ at: m, x: x(m), label: day(m, now) });
  return { x, width: x(to), ticks, px };
}

/** The release lane `release` moves to with Alt+arrow: the one before or after it, Unplanned last. */
export function neighbour(lanes, release, step) {
  const i = lanes.indexOf(release);
  if (i < 0) return undefined;
  return lanes[i + step];
}
