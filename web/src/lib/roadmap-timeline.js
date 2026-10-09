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
/** Pixels a day in weeks; Fit works its own out from the screen's width (WEB-106). */
export const WEEKS_PX = 28;
/** The narrowest and widest a day draws at Fit. */
export const FIT_PX = { min: 2, max: 60 };

const time = (iso) => (iso ? Date.parse(iso) : Number.NaN);

/** A step for a person, not an agent: a decision to make or a person's task. */
export const ownerStep = (t) =>
  t.who === 'person' || t.who === 'decision' || Boolean(t.decision && !t.decisionAnswers);
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
 * longest chain of open tasks allows; its steps for the owner (decisions, people's tasks, pull requests to merge)
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
      `${p.ownerSteps === 1 ? '1 step is' : `${p.ownerSteps} steps are`} yours (a decision, a person’s task, or a merge), at ${
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
 * The span the timeline draws: from the Monday before the earliest bar or plan (and at least a week before now)
 * to a week past the last likely or planned end (and at least four weeks after now).
 * @param {Iterable<any>} projections
 * @param {number} now
 * @param {Iterable<{ start: number | null, end: number | null } | null>} [plans]
 */
export function span(projections, now, plans = []) {
  let from = now - 7 * DAY;
  let to = now + 28 * DAY;
  const ends = [...plans].filter(Boolean).map((p) => ({ start: p.start, end: p.end === null ? null : p.end + DAY }));
  for (const p of [...projections, ...ends]) {
    for (const ms of [p.start, p.end, p.likely]) {
      if (!Number.isFinite(ms) || ms === null) continue;
      from = Math.min(from, ms);
      to = Math.max(to, ms);
    }
  }
  return { from: monday(from), to: monday(to) + 14 * DAY };
}

/**
 * The timeline's scale at `px` pixels a day: where a time sits, in pixels from the left, the whole width, and the
 * ticks with their labels: each Monday when a week has room for its date, else each month's first day.
 * @param {{ from: number, to: number }} range
 * @param {number} px
 * @param {number} now
 */
export function scale({ from, to }, px, now) {
  const x = (ms) => Math.round(((ms - from) / DAY) * px);
  const ticks = [];
  if (px * 7 < 56) {
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

/**
 * Fit's pixels a day: a week before today to a week past `last` (the last likely or planned end in view) fills
 * `width`, within FIT_PX.
 * @param {number} width
 * @param {number} now
 * @param {number | null} last
 */
export function fitPx(width, now, last) {
  const days = Math.max(7, ((last ?? now) - now) / DAY) + 14;
  return Math.min(FIT_PX.max, Math.max(FIT_PX.min, Math.floor((width / days) * 100) / 100));
}

// ---- the plan (WEB-106): the owner's dates against the pace ----

/** A whole UTC day, `YYYY-MM-DD`, from a time. */
export const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Midnight UTC of a `YYYY-MM-DD` day, or null. */
export const fromDay = (d) => (d ? Date.parse(`${d}T00:00:00Z`) : null);
const index = (ms) => Math.floor(ms / DAY);

/**
 * A feature's plan, as midnights UTC (the end is the last planned day, so the plan runs to the end of it), or null
 * when it has none.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 */
export function planOf(f) {
  if (!f.plannedStart && !f.plannedEnd) return null;
  return { start: fromDay(f.plannedStart), end: fromDay(f.plannedEnd) };
}

/**
 * What Plan it offers: the pace's start and likely end, as days; null when the pace has no estimate.
 * @param {any} p one of `project`'s
 * @param {number} now
 */
export function suggest(p, now) {
  if (p?.state !== 'open' || p.likely === null) return null;
  const start = toDay(p.start ?? now);
  const end = toDay(p.likely);
  return { plannedStart: start, plannedEnd: end < start ? start : end };
}

/** How many days a bar spans when nothing says how long it runs: no plan and no estimate. */
export const UNSIZED_DAYS = 7;

/**
 * The days a feature's bar spans (WEB-111): its plan, else the pace's start and likely end, as midnights UTC of the
 * first and last day. The bar is the plan; the pace only suggests one until the owner sets it.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 * @param {any} p one of `project`'s, or undefined
 * @param {number} now
 * @returns {{ start: number, end: number, planned: boolean }}
 */
export function barDays(f, p, now) {
  const midnight = (ms) => index(ms) * DAY;
  const plan = planOf(f);
  const paceStart = midnight(p?.start ?? now);
  const paceEnd =
    p?.state === 'open' && p.likely !== null
      ? midnight(p.likely)
      : p?.state === 'done' && p.end
        ? midnight(p.end)
        : paceStart + (UNSIZED_DAYS - 1) * DAY;
  if (!plan) return { start: paceStart, end: Math.max(paceStart, paceEnd), planned: false };
  const length = Math.max(0, paceEnd - paceStart);
  const start = plan.start ?? Math.min(plan.end, plan.end - length);
  const end = plan.end ?? start + length;
  return { start, end: Math.max(start, end), planned: true };
}

/**
 * The plan after dragging a bar `days` days: `move` shifts both ends, `start` and `end` one of them, never past
 * the other.
 * @param {{ start: number, end: number }} bar from `barDays`
 * @param {'move' | 'start' | 'end'} how
 * @param {number} days
 */
export function dragPlan(bar, how, days) {
  const by = days * DAY;
  let { start, end } = bar;
  if (how === 'move') {
    start += by;
    end += by;
  } else if (how === 'start') start = Math.min(start + by, end);
  else end = Math.max(end + by, start);
  return { plannedStart: toDay(start), plannedEnd: toDay(end) };
}

/**
 * How the pace compares to the plan, by whole UTC days:
 * - `behind`: even at best the pace ends after the planned end; `days` is how far the likely end is past it;
 * - `slip`: the planned end is inside the range the pace could run to (on or after its best end, before its
 *   likely end);
 * - `not-started`: the planned start has passed and no task in it has been claimed (said before On plan or
 *   Could slip, since it's the one to act on);
 * - `on`: the likely end is on or before the planned end;
 * - `planned`: a plan the pace can't check yet (no estimate, or no planned end);
 * - `done`: every task is done; `days` is how late the last one finished, 0 when on plan.
 * Null without a plan.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 * @param {any} p one of `project`'s
 * @param {number} now
 * @returns {{ kind: 'on' | 'slip' | 'behind' | 'not-started' | 'planned' | 'done', days: number } | null}
 */
export function planStatus(f, p, now) {
  const plan = planOf(f);
  if (!plan || !p) return null;
  const end = plan.end === null ? null : index(plan.end);
  if (p.state === 'done') return { kind: 'done', days: end === null || !p.end ? 0 : Math.max(0, index(p.end) - end) };
  if (end !== null && p.state === 'open' && index(p.optimistic) > end)
    return { kind: 'behind', days: index(p.likely) - end };
  const unclaimed = p.state === 'empty' || p.projectedStart;
  if (plan.start !== null && index(plan.start) < index(now) && unclaimed) return { kind: 'not-started', days: 0 };
  if (end === null || p.state !== 'open') return { kind: 'planned', days: 0 };
  return { kind: index(p.likely) <= end ? 'on' : 'slip', days: 0 };
}

/** A plan's status in a few words: `On plan`, `Could slip`, `Behind by 4 days`, `Not started`. */
export function statusWords(s) {
  if (!s) return '';
  if (s.kind === 'behind') return `Behind by ${s.days === 1 ? '1 day' : `${s.days} days`}`;
  if (s.kind === 'done') return s.days ? `Done ${s.days === 1 ? '1 day' : `${s.days} days`} late` : 'Done on plan';
  return { on: 'On plan', slip: 'Could slip', 'not-started': 'Not started', planned: 'Planned' }[s.kind];
}

/**
 * The plan's days in words: `12 to 19 Oct`, `30 Oct to 2 Nov`, `by 19 Oct`, `from 12 Oct`.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 * @param {number} now
 */
export function planDays(f, now) {
  const start = fromDay(f.plannedStart ?? null);
  const end = fromDay(f.plannedEnd ?? null);
  if (start === null && end === null) return '';
  if (start === null) return `by ${day(end, now)}`;
  if (end === null) return `from ${day(start, now)}`;
  if (start === end) return day(start, now);
  const [a, b] = [new Date(start), new Date(end)];
  const sameMonth = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  return `${sameMonth ? a.getUTCDate() : day(start, now)} to ${day(end, now)}`;
}

/**
 * The plan and how the pace compares, as a sentence for the bar's explanation; empty without a plan.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 * @param {any} p one of `project`'s
 * @param {number} now
 */
export function explainPlan(f, p, now) {
  const s = planStatus(f, p, now);
  if (!s) return '';
  const planned = `Planned ${planDays(f, now)}`;
  switch (s.kind) {
    case 'behind':
      return `${planned}: behind by ${s.days === 1 ? '1 day' : `${s.days} days`}, even at the pace’s best.`;
    case 'slip':
      return `${planned}: it could slip, since only the pace’s best makes the end.`;
    case 'not-started':
      return `${planned}: not started, though the plan started on ${day(fromDay(f.plannedStart), now)}.`;
    case 'on':
      return `${planned}: on plan.`;
    case 'done':
      return `${planned}: ${statusWords(s).toLowerCase()}.`;
    default:
      return `${planned}.`;
  }
}

/** The latest planned end of a lane's features, as a midnight UTC, or null when none has one. */
export function lanePlanEnd(features) {
  const ends = features.map((f) => fromDay(f.plannedEnd ?? null)).filter((ms) => ms !== null);
  return ends.length ? Math.max(...ends) : null;
}

/**
 * A lane's features in the timeline's order: by planned start, else the pace's start, so planning a feature also
 * places it; then the pace's start, then the title.
 * @param {any[]} features
 * @param {Map<string, any>} projections
 * @param {number} now
 */
export function ordered(features, projections, now) {
  const pace = (f) => projections.get(f.slug)?.start ?? now;
  const key = (f) => fromDay(f.plannedStart ?? null) ?? pace(f);
  return [...features].sort((a, b) => key(a) - key(b) || pace(a) - pace(b) || a.title.localeCompare(b.title));
}

/** The release lane `release` moves to with Alt+arrow: the one before or after it, Unplanned last. */
export function neighbour(lanes, release, step) {
  const i = lanes.indexOf(release);
  if (i < 0) return undefined;
  return lanes[i + step];
}
