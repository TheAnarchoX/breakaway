import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { computeStats, familyOf, median, shiftDay, zoneOf } from '../src/stats.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const NOW = Date.parse('2026-10-02T10:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const empty = {
  tasks: [],
  prs: [],
  runs: [],
  deploys: [],
  ships: [],
  agentRuns: [],
  routineRuns: [],
  open: { prs: 0, drafts: 0, alerts: 0 },
};
const task = (over) => ({
  wid: null,
  project: 'cloud',
  status: 'pending',
  horizon: 'now',
  tags: ['agent'],
  claim: null,
  entry: NOW - 10 * D,
  end: null,
  ready: true,
  blocked: false,
  ...over,
});

describe('dashboard numbers', () => {
  it("counts days in calendar steps, in the viewer's time zone", () => {
    expect(shiftDay('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftDay('2026-10-02', -6)).toBe('2026-09-26');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(zoneOf('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(zoneOf('Mars/Olympus')).toBe('UTC');
    expect(zoneOf(undefined)).toBe('UTC');
    // 23:30 UTC on 1 Oct is already 2 Oct in Amsterdam.
    const late = computeStats({
      ...empty,
      now: NOW,
      days: 7,
      tz: 'Europe/Amsterdam',
      tasks: [task({ status: 'completed', end: Date.parse('2026-10-01T23:30:00Z') })],
    });
    expect(late.daily.at(-1)).toMatchObject({ day: '2026-10-02', finished: 1 });
    const utc = computeStats({
      ...empty,
      now: NOW,
      days: 7,
      tz: 'UTC',
      tasks: [task({ status: 'completed', end: Date.parse('2026-10-01T23:30:00Z') })],
    });
    expect(utc.daily.at(-2)).toMatchObject({ day: '2026-10-01', finished: 1 });
    expect(utc.period).toMatchObject({ days: 7, from: '2026-09-26', to: '2026-10-02', tz: 'UTC' });
  });

  it('starts a period at the first activity on a board younger than it', () => {
    const tasks = [
      task({ wid: 'CLD-1', status: 'completed', entry: NOW - 2 * D, end: NOW - D }),
      task({ wid: 'CLD-2', status: 'completed', entry: NOW - 2 * D, end: NOW - 2 * H }),
    ];
    const s = computeStats({ ...empty, now: NOW, days: 7, tz: 'UTC', tasks });
    expect(s.period).toMatchObject({ days: 7, covered: 3, comparable: false, from: '2026-09-30', to: '2026-10-02' });
    expect(s.daily.map((d) => d.day)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(s.pace.perDay).toBeCloseTo(2 / 3);
    expect(s.pace.perDayBefore).toBeNull();
    expect(s.totals.finished).toEqual({ now: 2, before: null });
    expect(s.totals.added.before).toBeNull();
  });

  it('keeps quiet days inside an active period, and an older board as it was', () => {
    const young = computeStats({
      ...empty,
      now: NOW,
      days: 7,
      tz: 'UTC',
      tasks: [task({ status: 'completed', entry: NOW - 4 * D, end: NOW - H })],
    });
    expect(young.period.covered).toBe(5);
    expect(young.daily.map((d) => d.finished)).toEqual([0, 0, 0, 0, 1]);
    const old = computeStats({
      ...empty,
      now: NOW,
      days: 7,
      tz: 'UTC',
      tasks: [
        task({ status: 'completed', entry: NOW - 30 * D, end: NOW - 9 * D }),
        task({ status: 'completed', entry: NOW - 30 * D, end: NOW - H }),
      ],
    });
    expect(old.period).toMatchObject({ days: 7, covered: 7, comparable: true, from: '2026-09-26' });
    expect(old.daily).toHaveLength(7);
    expect(old.pace.perDay).toBeCloseTo(1 / 7);
    expect(old.pace.perDayBefore).toBeCloseTo(1 / 7);
    expect(old.totals.finished).toEqual({ now: 1, before: 1 });
  });

  it('counts activity other than tasks as the first day, and an empty board as today', () => {
    const s = computeStats({
      ...empty,
      now: NOW,
      days: 30,
      tz: 'UTC',
      routineRuns: [{ slug: 'x', failed: false, at: NOW - 5 * D }],
    });
    expect(s.period.covered).toBe(6);
    const none = computeStats({ ...empty, now: NOW, days: 30, tz: 'UTC' });
    expect(none.period).toMatchObject({ covered: 1, comparable: false, from: '2026-10-02' });
  });

  it('compares the period with the one before it, and keeps the pace', () => {
    const tasks = [
      // This week: finished today, yesterday, and three days ago; added in the window.
      task({ wid: 'CLD-1', status: 'completed', entry: NOW - 2 * H, end: NOW - H, claim: 'claude-cld-a' }),
      task({ wid: 'CLD-2', status: 'completed', entry: NOW - 2 * D, end: NOW - D, claim: 'codex-x' }),
      task({ wid: 'OPS-3', project: 'ops', status: 'completed', entry: NOW - 20 * D, end: NOW - 3 * D, claim: null }),
      // The week before.
      task({ wid: 'CLD-4', status: 'completed', entry: NOW - 12 * D, end: NOW - 9 * D, claim: 'owner' }),
      // Open now.
      task({ wid: 'CLD-5', claim: 'claude-b', ready: true }),
      task({ wid: 'CLD-6', blocked: true, ready: false, horizon: 'next' }),
      task({ wid: 'IDEA-7', project: 'ideas', tags: ['decide'], horizon: 'later' }),
      task({ wid: 'CLD-8', status: 'deleted', end: NOW - H }),
    ];
    const s = computeStats({ ...empty, now: NOW, days: 7, tz: 'UTC', tasks });
    expect(s.totals.finished).toEqual({ now: 3, before: 1 });
    expect(s.totals.added).toEqual({ now: 2, before: 4 });
    expect(s.pace).toMatchObject({ streak: 2, bestStreak: 2, activeDays: 3, busiest: { finished: 1 } });
    expect(s.pace.perDay).toBeCloseTo(3 / 7);
    expect(s.who).toEqual({ claude: 1, owner: 0, other: 1, none: 1 });
    expect(s.areas.map((a) => [a.project, a.finished])).toEqual([
      ['cloud', 2],
      ['ops', 1],
      ['ideas', 0],
    ]);
    expect(s.open).toMatchObject({ open: 3, ready: 0, blocked: 1, claimed: 1, decide: 1, ideas: 1 });
    expect(s.open.horizons.now).toEqual({ open: 1, done: 4 });
    expect(s.leadTime.count).toBe(3);
    expect(s.leadTime.median).toBe(D);
    expect(s.leadTime.buckets.map((b) => b.count)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(s.leadTime.medianBefore).toBe(3 * D);
    // Finishes land on the weekday-by-hour grid (2 Oct 2026 is a Friday).
    expect(s.punch[4][9]).toBe(1);
  });

  it('keeps a streak going on a day nothing has finished yet, and breaks it after a gap', () => {
    const finishedOn = (...daysAgo) => daysAgo.map((n) => task({ status: 'completed', end: NOW - n * D }));
    expect(computeStats({ ...empty, now: NOW, days: 30, tz: 'UTC', tasks: finishedOn(1, 2, 3) }).pace.streak).toBe(3);
    expect(
      computeStats({ ...empty, now: NOW, days: 30, tz: 'UTC', tasks: finishedOn(0, 1, 3, 4, 5) }).pace,
    ).toMatchObject({ streak: 2, bestStreak: 3 });
    expect(computeStats({ ...empty, now: NOW, days: 30, tz: 'UTC', tasks: finishedOn(2, 3) }).pace.streak).toBe(0);
  });

  it('measures pull requests, checks, deploys, agents, and routines', () => {
    const s = computeStats({
      ...empty,
      now: NOW,
      days: 7,
      tz: 'UTC',
      tasks: [
        task({ wid: 'CLD-1', status: 'completed', end: NOW - 5 * H }),
        task({ wid: 'CLD-2', status: 'completed', end: NOW - 20 * D }),
      ],
      prs: [
        { number: 1, created: NOW - 3 * H, merged: NOW - H, author: 'octocat' },
        { number: 2, created: NOW - 2 * D, merged: NOW - D, author: 'dependabot[bot]' },
        { number: 3, created: NOW - 10 * D, merged: NOW - 8 * D, author: 'octocat' },
      ],
      runs: [
        {
          name: 'Test and build',
          event: 'pull_request',
          branch: 'x',
          conclusion: 'success',
          created: NOW - H,
          duration: 120_000,
        },
        {
          name: 'Test and build',
          event: 'push',
          branch: 'main',
          conclusion: 'failure',
          created: NOW - 2 * H,
          duration: 60_000,
        },
        {
          name: 'Deploy',
          event: 'workflow_run',
          branch: 'main',
          conclusion: 'success',
          created: NOW - 3 * H,
          duration: 200_000,
        },
        {
          name: 'Test and build',
          event: 'pull_request',
          branch: 'y',
          conclusion: 'cancelled',
          created: NOW - 4 * H,
          duration: 5_000,
        },
        {
          name: 'Dependabot',
          event: 'dynamic',
          branch: 'main',
          conclusion: 'failure',
          created: NOW - 4 * H,
          duration: 5_000,
        },
        {
          name: 'Test and build',
          event: 'pull_request',
          branch: 'z',
          conclusion: 'success',
          created: NOW - 9 * D,
          duration: 5_000,
        },
      ],
      deploys: [
        { env: 'staging', task: 'deploy', state: 'success', landed: true, at: NOW - 3 * H },
        { env: 'staging', task: 'deploy', state: 'failure', landed: false, at: NOW - 4 * H },
        { env: 'production', task: 'deploy', state: 'inactive', landed: true, at: NOW - 2 * H },
        { env: 'production', task: 'rollback', state: 'success', landed: true, at: NOW - H },
        { env: 'production', task: 'deploy', state: 'success', landed: true, at: NOW - 9 * D },
      ],
      ships: [
        { wid: 'CLD-1', env: 'production', at: NOW - 2 * H },
        { wid: 'CLD-1', env: 'staging', at: NOW - 4 * H },
        { wid: 'CLD-2', env: 'production', at: NOW - 19 * D },
      ],
      agentRuns: [
        { kind: 'build', trigger: 'board', status: 'started', at: NOW - 6 * H, taskDone: true },
        { kind: 'build', trigger: 'autostart', status: 'started', at: NOW - 5 * H, taskDone: false },
        { kind: 'build', trigger: 'autostart', status: 'failed', at: NOW - 4 * H, taskDone: false },
        { kind: 'refine', trigger: 'board', status: 'started', at: NOW - 3 * H, taskDone: false },
      ],
      routineRuns: [
        { slug: 'changelog', failed: false, at: NOW - H },
        { slug: 'changelog', failed: true, at: NOW - 2 * H },
        { slug: 'triage', failed: false, at: NOW - 2 * D },
      ],
      open: { prs: 2, drafts: 1, alerts: 3 },
    });
    expect(s.totals.merged).toEqual({ now: 2, before: 1 });
    expect(s.mergeTime).toMatchObject({ count: 2, authors: { people: 1, dependabot: 1 } });
    expect(s.mergeTime.median).toBe(median([2 * H, D]));
    expect(s.checks).toMatchObject({ passed: 2, failed: 1, main: { passed: 1, failed: 1, rate: 0.5 }, rateBefore: 1 });
    expect(s.checks.rate).toBeCloseTo(2 / 3);
    expect(s.checks.workflows[0]).toMatchObject({
      name: 'Test and build',
      runs: 2,
      passed: 1,
      rate: 0.5,
      duration: 90_000,
    });
    expect(s.deploys.staging).toEqual({ landed: 1, failed: 1, rollbacks: 0 });
    expect(s.deploys.production).toEqual({ landed: 1, failed: 0, rollbacks: 1 });
    expect(s.deploys.rate).toBeCloseTo(3 / 4);
    expect(s.deploys.recent.map((d) => d.result)).toEqual(['failed', 'landed', 'landed', 'rollback']);
    expect(s.totals.deploys).toEqual({ now: 1, before: 1 });
    expect(s.deploys.lastProduction).toBe(new Date(NOW - H).toISOString());
    expect(s.shipTime).toEqual({ count: 1, median: 3 * H });
    expect(s.agents).toMatchObject({
      runs: 4,
      failed: 1,
      builds: 2,
      finished: 1,
      kinds: { build: 3, refine: 1 },
      startRate: 0.75,
      finishRate: 0.5,
    });
    expect(s.routines).toMatchObject({
      runs: 3,
      failed: 1,
      list: [
        { slug: 'changelog', runs: 2, failed: 1 },
        { slug: 'triage', runs: 1, failed: 0 },
      ],
    });
    expect(s.open).toMatchObject({ prs: 2, drafts: 1, alerts: 3 });
  });

  it('tells Claude agents, the owner, others, and nobody apart', () => {
    expect(['claude-cld-scrollbars', 'Codex-1', 'owner', null, '?', 'jim'].map(familyOf)).toEqual([
      'claude',
      'other',
      'owner',
      'none',
      'none',
      'other',
    ]);
  });

  it('serves the numbers, and keeps GitHub and agent history after the tables let it go', async () => {
    await api('tasks', {
      method: 'POST',
      body: [{ description: 'Count the finished work', project: 'cloud', tags: ['agent'] }],
    });
    const [{ wid }] = (await body(await api('tasks'))).tasks.filter((t) => t.description === 'Count the finished work');
    await api(`tasks/${wid}/done`, { method: 'POST', body: {} });

    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    const merged = new Date(Date.now() - 2 * H).toISOString();
    await runInDurableObject(stub, (instance) => {
      instance.sql.exec(
        'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, applied, data) VALUES (?, ?, ?, ?, ?, ?)',
        'widgets',
        9001,
        merged,
        'merged',
        'merged',
        JSON.stringify({
          number: 9001,
          title: 'Count',
          state: 'merged',
          checks: { state: 'success', total: 1, passed: 1, runs: [] },
          review: { decision: 'none' },
          closes: [],
          mentions: [],
          created: new Date(Date.now() - 5 * H).toISOString(),
          mergedAt: merged,
          author: 'octocat',
        }),
      );
      instance.sql.exec(
        'INSERT OR REPLACE INTO gh_runs (id, created, data) VALUES (?, ?, ?)',
        9001,
        merged,
        JSON.stringify({
          id: 9001,
          name: 'Test and build',
          status: 'completed',
          conclusion: 'success',
          branch: 'main',
          event: 'push',
          created: merged,
          started: merged,
          updated: new Date(Date.parse(merged) + 60_000).toISOString(),
        }),
      );
    });

    const first = await body(await api('stats?days=7&tz=Europe/Amsterdam'));
    expect(first.status).toBe(200);
    expect(first.period).toMatchObject({ days: 7, tz: 'Europe/Amsterdam' });
    // A board made today covers only the days since its first activity.
    expect(first.daily).toHaveLength(first.period.covered);
    expect(first.period.covered).toBeLessThanOrEqual(7);
    expect(first.totals.finished.now).toBeGreaterThanOrEqual(1);
    expect(first.totals.merged.now).toBeGreaterThanOrEqual(1);
    expect(first.checks.workflows.find((w) => w.name === 'Test and build')).toMatchObject({ duration: 60_000 });

    // GitHub's table drops the rows; the dashboard still has them.
    await runInDurableObject(stub, (instance) => {
      instance.sql.exec("DELETE FROM gh_pulls WHERE repo = 'widgets' AND number = 9001");
      instance.sql.exec('DELETE FROM gh_runs WHERE id = 9001');
    });
    const later = await body(await api('stats?days=7'));
    expect(later.totals.merged.now).toBe(first.totals.merged.now);
    expect(later.checks.passed).toBe(first.checks.passed);
    expect(later.period.tz).toBe('UTC');

    expect((await body(await api('stats?days=nonsense'))).period.days).toBe(30);
    expect((await body(await api('stats?days=9999'))).period.days).toBe(30);
    expect((await api('stats', { token: null })).status).toBe(401);
  });

  it('counts one repository when asked (?repo=), and the whole board otherwise', async () => {
    const made = await api('repos', {
      method: 'POST',
      body: { slug: 'scratch', github: 'acme/scratch', name: 'scratch', areas: ['product:SCR:Product'], by: 'owner' },
    });
    expect(made.status).toBe(201);
    const create = (description, extra) =>
      api('tasks', { method: 'POST', body: [{ description, tags: ['agent'], ...extra }] });
    await create('Scratch one', { project: 'product', repo: 'scratch' });
    await create('Scratch two', { project: 'product', repo: 'scratch' });
    await create('Home one', { project: 'cloud' });
    await api('tasks/SCR-1/done', { method: 'POST', body: {} });

    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    const merged = new Date(Date.now() - 2 * H).toISOString();
    await runInDurableObject(stub, (instance) => {
      const pull = (repo, number, state) =>
        instance.sql.exec(
          'INSERT OR REPLACE INTO gh_pulls (repo, number, updated, state, applied, data) VALUES (?, ?, ?, ?, ?, ?)',
          repo,
          number,
          merged,
          state,
          state,
          JSON.stringify({
            number,
            state,
            draft: false,
            created: merged,
            mergedAt: state === 'merged' ? merged : null,
            author: 'someone',
          }),
        );
      pull('scratch', 5, 'merged');
      pull('scratch', 6, 'open');
      pull('widgets', 5, 'merged');
      pull('widgets', 7, 'merged');
      instance.sql.exec(
        'INSERT OR REPLACE INTO gh_runs (id, created, data, repo) VALUES (?, ?, ?, ?)',
        9101,
        merged,
        JSON.stringify({
          id: 9101,
          name: 'Test and build',
          status: 'completed',
          conclusion: 'success',
          created: merged,
          started: merged,
          updated: merged,
        }),
        'scratch',
      );
      instance.sql.exec(
        "INSERT INTO routine_runs (slug, task, trigger, started) VALUES ('scratch', 'x', 'manual', ?)",
        Date.now() - H,
      );
    });

    const all = await body(await api('stats?days=7'));
    const scratch = await body(await api('stats?days=7&repo=scratch'));
    const home = await body(await api('stats?days=7&repo=widgets'));
    expect(scratch.status).toBe(200);
    expect(scratch.totals.merged.now).toBe(1);
    expect(home.totals.merged.now).toBeGreaterThanOrEqual(2);
    expect(all.totals.merged.now).toBe(scratch.totals.merged.now + home.totals.merged.now);
    expect(scratch.totals.finished.now).toBe(1);
    expect(home.totals.finished.now).toBe(all.totals.finished.now - 1);
    expect(scratch.open.prs).toBe(1);
    expect(home.open.prs).toBe(all.open.prs - 1);
    expect(scratch.checks.passed).toBe(1);
    expect(scratch.routines.runs).toBe(1);
    expect(home.routines.runs).toBe(all.routines.runs - 1);
    // All, an empty value, and no parameter are the same.
    expect((await body(await api('stats?days=7&repo=all'))).totals).toEqual(all.totals);
    expect((await body(await api('stats?days=7&repo='))).totals).toEqual(all.totals);
    expect((await api('stats?repo=nowhere')).status).toBe(404);
  });
});
