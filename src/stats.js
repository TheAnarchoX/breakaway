/**
 * The numbers behind the Activity view's dashboard (CLD-185): how fast tasks, pull requests,
 * deploys, agents, and routines move, over the last `days` calendar days in the viewer's time
 * zone, next to the same stretch before it. Pure: the store gathers the rows, this counts them.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A run that failed, as opposed to one that was cancelled or skipped (which count for nothing). */
const RUN_FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
/** Lead-time buckets, in hours: the last one is open-ended. */
const LEAD_BUCKETS = [
  { label: 'Under 1 h', max: 1 },
  { label: '1–4 h', max: 4 },
  { label: '4–24 h', max: 24 },
  { label: '1–3 days', max: 72 },
  { label: '3–7 days', max: 168 },
  { label: 'Over a week', max: Infinity },
];
const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export const STATS_DAYS = { min: 1, max: 365, fallback: 30 };

/** The time zone to count days in: the viewer's, when the runtime knows it. */
export function zoneOf(tz) {
  try {
    if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    /* an unknown zone: count in UTC */
  }
  return 'UTC';
}

/** Turns times into local day keys (2026-10-02), weekdays (0 is Monday), and hours. */
function clock(tz) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (ms) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return {
      day: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: WEEKDAYS[parts.weekday] ?? 0,
      hour: Number(parts.hour) % 24,
    };
  };
}

/** The calendar day `n` days after `key` (negative goes back), as a key. Calendar arithmetic, so no DST surprises. */
export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const rate = (good, all) => (all ? good / all : null);

/** Who a claim belongs to, by family: per-session agent names would make a leaderboard of one-offs. */
export function familyOf(claim) {
  if (!claim || claim === '?') return 'none';
  const name = claim.toLowerCase();
  if (name === 'owner' || name === 'board') return 'owner';
  if (name.startsWith('claude')) return 'claude';
  return 'other';
}

/**
 * @param {object} input
 * @param {number} input.now  ms
 * @param {number} input.days  how many calendar days, today included
 * @param {string} input.tz  an IANA time zone
 * @param {Array<{wid: string|null, project: string|null, status: string, horizon: string|null, tags: string[], who?: string|null, claim: string|null, entry: number|null, end: number|null, ready: boolean, blocked: boolean}>} input.tasks
 * @param {Array<{number: number, created: number, merged: number, author: string|null}>} input.prs  merged pull requests
 * @param {Array<{name: string, event: string|null, branch: string|null, conclusion: string|null, created: number, duration: number|null}>} input.runs  finished workflow runs
 * @param {Array<{env: string, task: string, state: string, landed: boolean, at: number}>} input.deploys  finished deployments
 * @param {Array<{wid: string, env: string, at: number}>} input.ships  when each task reached an environment
 * @param {Array<{kind: string, trigger: string, status: string, at: number, taskDone: boolean}>} input.agentRuns
 * @param {Array<{slug: string, failed: boolean, at: number}>} input.routineRuns
 * @param {{prs: number, drafts: number, alerts: number}} input.open  what's open on GitHub now
 */
export function computeStats({ now, days, tz, tasks, prs, runs, deploys, ships, agentRuns, routineRuns, open }) {
  const at = clock(tz);
  const today = at(now).day;
  const periodFrom = shiftDay(today, -(days - 1));
  // The board's (or the repository's) first activity: days before it aren't quiet days, they're days before it existed.
  const stamps = [
    ...tasks.flatMap((t) => [t.entry, t.end]),
    ...prs.flatMap((p) => [p.merged, p.created]),
    ...runs.map((r) => r.created),
    ...deploys.map((d) => d.at),
    ...ships.map((s) => s.at),
    ...agentRuns.map((r) => r.at),
    ...routineRuns.map((r) => r.at),
  ].filter((ms) => Number.isFinite(ms) && ms > 0 && ms <= now + HOUR_MS);
  const firstDay = stamps.length ? at(Math.min(...stamps)).day : today;
  const from = firstDay > periodFrom ? firstDay : periodFrom;
  const covered = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  // A full period always has the stretch before it to compare with; a young board has nothing before its first day.
  const comparable = firstDay < periodFrom;
  const beforeFrom = shiftDay(from, -covered);
  const keys = Array.from({ length: covered }, (_, i) => shiftDay(from, i));
  const index = new Map(keys.map((k, i) => [k, i]));
  // Everything that happened from beforeFrom on gets its day once; the window and the one before split on `from`.
  const earliest = Date.parse(`${beforeFrom}T00:00:00Z`) - 2 * DAY_MS; // a day early either side of UTC is enough
  const inRange = (ms) => Number.isFinite(ms) && ms >= earliest && ms <= now + HOUR_MS;
  const where = (ms) => {
    if (!inRange(ms)) return null;
    const c = at(ms);
    if (c.day > today || c.day < beforeFrom) return null;
    return { ...c, current: c.day >= from };
  };

  const daily = keys.map((day) => ({ day, finished: 0, added: 0, merged: 0, deploys: 0, agentRuns: 0 }));
  const totals = { finished: [0, 0], added: [0, 0], merged: [0, 0], deploys: [0, 0], agentRuns: [0, 0] };
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  const count = (series, ms, also) => {
    const w = where(ms);
    if (!w) return null;
    totals[series][w.current ? 0 : 1] += 1;
    if (w.current) {
      daily[index.get(w.day)][series] += 1;
      if (also) punch[w.weekday][w.hour] += 1;
    }
    return w;
  };

  // ---- tasks ----
  const areas = new Map();
  const area = (p) => {
    const key = p ?? 'none';
    if (!areas.has(key)) areas.set(key, { project: key, finished: 0, added: 0, open: 0 });
    return areas.get(key);
  };
  const who = { claude: 0, owner: 0, other: 0, none: 0 };
  const lead = [];
  const leadBefore = [];
  const finishedWids = new Set();
  const horizons = { now: { open: 0, done: 0 }, next: { open: 0, done: 0 }, later: { open: 0, done: 0 } };
  const flow = { open: 0, ready: 0, blocked: 0, claimed: 0, decide: 0, ideas: 0 };
  for (const t of tasks) {
    if (t.status === 'deleted') continue;
    const added = count('added', t.entry);
    if (added?.current) area(t.project).added += 1;
    if (t.status === 'completed') {
      const done = count('finished', t.end, true);
      if (done?.current) {
        area(t.project).finished += 1;
        who[familyOf(t.claim)] += 1;
        if (t.wid) finishedWids.add(t.wid);
      }
      if (done && t.entry && t.end >= t.entry) (done.current ? lead : leadBefore).push(t.end - t.entry);
      if (t.horizon in horizons) horizons[t.horizon].done += 1;
    }
    if (t.status === 'pending') {
      flow.open += 1;
      area(t.project).open += 1;
      if (t.ready && !t.claim && t.who !== 'decision') flow.ready += 1;
      if (t.blocked) flow.blocked += 1;
      if (t.claim) flow.claimed += 1;
      if (t.who === 'decision') flow.decide += 1;
      if (t.project === 'ideas') flow.ideas += 1;
      if (t.horizon in horizons) horizons[t.horizon].open += 1;
    }
  }

  // ---- pull requests ----
  const mergeTimes = [];
  const mergeBefore = [];
  const authors = { people: 0, dependabot: 0 };
  for (const pr of prs) {
    const w = count('merged', pr.merged, true);
    if (!w) continue;
    if (pr.created && pr.merged >= pr.created) (w.current ? mergeTimes : mergeBefore).push(pr.merged - pr.created);
    if (w.current) authors[/dependabot/iu.test(pr.author ?? '') ? 'dependabot' : 'people'] += 1;
  }

  // ---- checks ----
  const workflows = new Map();
  const ci = { passed: 0, failed: 0, before: { passed: 0, failed: 0 }, main: { passed: 0, failed: 0 } };
  for (const r of runs) {
    const w = where(r.created);
    if (!w || r.event === 'dynamic') continue; // Dependabot's own update jobs aren't the repository's checks
    const passed = r.conclusion === 'success';
    const failed = RUN_FAILED.has(r.conclusion ?? '');
    if (!passed && !failed) continue;
    const bucket = w.current ? ci : ci.before;
    bucket[passed ? 'passed' : 'failed'] += 1;
    if (!w.current) continue;
    if (r.branch === 'main') ci.main[passed ? 'passed' : 'failed'] += 1;
    if (!workflows.has(r.name)) workflows.set(r.name, { name: r.name, passed: 0, failed: 0, durations: [] });
    const wf = workflows.get(r.name);
    wf[passed ? 'passed' : 'failed'] += 1;
    if (r.duration > 0) wf.durations.push(r.duration);
  }

  // ---- deploys ----
  const envs = {};
  const recent = [];
  for (const d of [...deploys].sort((a, b) => a.at - b.at)) {
    const w = where(d.at);
    if (!w) continue;
    const failed = ['failure', 'error'].includes(d.state);
    if (!d.landed && !failed) continue;
    if (d.env === 'production' && d.landed && d.task !== 'rollback') count('deploys', d.at);
    if (!w.current) continue;
    envs[d.env] ??= { landed: 0, failed: 0, rollbacks: 0 };
    if (d.task === 'rollback' && d.landed) envs[d.env].rollbacks += 1;
    else envs[d.env][d.landed ? 'landed' : 'failed'] += 1;
    recent.push({
      env: d.env,
      at: new Date(d.at).toISOString(),
      result: failed ? 'failed' : d.task === 'rollback' ? 'rollback' : 'landed',
    });
  }
  const lastProduction = deploys
    .filter((d) => d.env === 'production' && d.landed)
    .reduce((max, d) => Math.max(max, d.at), 0);

  // From finishing a task to its pull request reaching production.
  const shipTimes = [];
  const ended = new Map(tasks.filter((t) => t.wid && t.end).map((t) => [t.wid, t.end]));
  for (const s of ships) {
    if (s.env !== 'production' || !finishedWids.has(s.wid)) continue;
    const end = ended.get(s.wid);
    if (end && s.at >= end) shipTimes.push(s.at - end);
  }

  // ---- agents ----
  const agents = { runs: 0, failed: 0, finished: 0, builds: 0, kinds: {}, triggers: {} };
  for (const r of agentRuns) {
    const w = count('agentRuns', r.at);
    if (!w?.current) continue;
    agents.runs += 1;
    if (r.status === 'failed') agents.failed += 1;
    agents.kinds[r.kind] = (agents.kinds[r.kind] ?? 0) + 1;
    agents.triggers[r.trigger] = (agents.triggers[r.trigger] ?? 0) + 1;
    if (r.kind === 'build' && r.status !== 'failed') {
      agents.builds += 1;
      if (r.taskDone) agents.finished += 1;
    }
  }

  // ---- routines ----
  const routines = new Map();
  for (const r of routineRuns) {
    const w = where(r.at);
    if (!w?.current) continue;
    if (!routines.has(r.slug)) routines.set(r.slug, { slug: r.slug, runs: 0, failed: 0 });
    const row = routines.get(r.slug);
    row.runs += 1;
    if (r.failed) row.failed += 1;
  }
  const routineList = [...routines.values()].sort((a, b) => b.runs - a.runs);
  const routineRunsTotal = routineList.reduce((n, r) => n + r.runs, 0);
  const routineFailed = routineList.reduce((n, r) => n + r.failed, 0);

  // ---- pace ----
  let streak = 0;
  // Today still counts as "on a streak" before its first finish: the streak runs to yesterday then.
  for (let i = daily.length - 1; i >= 0; i -= 1) {
    if (daily[i].finished > 0) streak += 1;
    else if (i === daily.length - 1) continue;
    else break;
  }
  let best = 0;
  let run = 0;
  for (const d of daily) {
    run = d.finished > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const busiest = daily.reduce((top, d) => (d.finished > (top?.finished ?? 0) ? d : top), null);

  const pair = (series) => ({ now: totals[series][0], before: comparable ? totals[series][1] : null });
  return {
    period: { days, covered, comparable, from, to: today, tz },
    generated: new Date(now).toISOString(),
    totals: {
      finished: pair('finished'),
      added: pair('added'),
      merged: pair('merged'),
      deploys: pair('deploys'),
      agentRuns: pair('agentRuns'),
    },
    daily,
    pace: {
      perDay: totals.finished[0] / covered,
      perDayBefore: comparable ? totals.finished[1] / covered : null,
      streak,
      bestStreak: best,
      busiest: busiest ? { day: busiest.day, finished: busiest.finished } : null,
      activeDays: daily.filter((d) => d.finished > 0).length,
    },
    leadTime: {
      count: lead.length,
      median: median(lead),
      p90: percentile(lead, 90),
      medianBefore: median(leadBefore),
      buckets: LEAD_BUCKETS.map((b, i) => ({
        label: b.label,
        count: lead.filter((ms) => ms >= (i ? LEAD_BUCKETS[i - 1].max : 0) * HOUR_MS && ms < b.max * HOUR_MS).length,
      })),
    },
    mergeTime: { count: mergeTimes.length, median: median(mergeTimes), medianBefore: median(mergeBefore), authors },
    shipTime: { count: shipTimes.length, median: median(shipTimes) },
    checks: {
      passed: ci.passed,
      failed: ci.failed,
      rate: rate(ci.passed, ci.passed + ci.failed),
      rateBefore: rate(ci.before.passed, ci.before.passed + ci.before.failed),
      main: { ...ci.main, rate: rate(ci.main.passed, ci.main.passed + ci.main.failed) },
      workflows: [...workflows.values()]
        .map(({ durations, ...wf }) => ({
          ...wf,
          runs: wf.passed + wf.failed,
          rate: rate(wf.passed, wf.passed + wf.failed),
          duration: median(durations),
        }))
        .sort((a, b) => b.runs - a.runs),
    },
    deploys: {
      staging: envs.staging ?? { landed: 0, failed: 0, rollbacks: 0 },
      production: envs.production ?? { landed: 0, failed: 0, rollbacks: 0 },
      rate: (() => {
        const all = Object.values(envs);
        const landed = all.reduce((n, e) => n + e.landed + e.rollbacks, 0);
        return rate(landed, landed + all.reduce((n, e) => n + e.failed, 0));
      })(),
      recent: recent.slice(-40),
      lastProduction: lastProduction ? new Date(lastProduction).toISOString() : null,
    },
    agents: {
      ...agents,
      startRate: rate(agents.runs - agents.failed, agents.runs),
      finishRate: rate(agents.finished, agents.builds),
    },
    routines: {
      runs: routineRunsTotal,
      failed: routineFailed,
      rate: rate(routineRunsTotal - routineFailed, routineRunsTotal),
      list: routineList,
    },
    areas: [...areas.values()]
      .filter((a) => a.finished || a.added || a.open)
      .sort((a, b) => b.finished - a.finished || b.open - a.open),
    who,
    punch,
    open: { ...flow, horizons, prs: open.prs, drafts: open.drafts, alerts: open.alerts },
  };
}
