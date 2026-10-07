import { describe, expect, it } from 'vitest';
import { RECENT_PLANS, plansPanel, runProgress } from '../web/src/lib/env-plans.js';

// The environment console's Plans panel (WEB-115): the console change, the open plans, and the recent ones.
const now = Date.now();
const iso = (/** @type {number} */ msAgo) => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const environment = { id: 7, name: 'acme-production' };

const plan = (/** @type {number} */ n, /** @type {string} */ state, more = {}) => ({
  id: `plan-${n}`,
  environment,
  state,
  changes: 1,
  reversible: true,
  created: iso(n * MIN),
  updated: iso(n * MIN),
  ...more,
});

const change = (/** @type {number} */ n, /** @type {string} */ state, more = {}) => ({
  n,
  environment,
  state,
  edits: [{ op: 'set', resource: 'acme-api', path: 'memory', value: 256 }],
  lines: ['Change acme-api: memory to 256'],
  pull: { number: 100 + n, url: null },
  digest: 'd',
  commit: 'c',
  approval: null,
  outcome: null,
  why: null,
  created: iso(30 * MIN),
  updated: iso(5 * MIN),
  ...more,
});

describe('plansPanel', () => {
  it('is empty when there is nothing', () => {
    expect(plansPanel({})).toEqual({ changes: [], open: [], recent: [] });
    expect(plansPanel({ plans: [], runs: [], changes: { open: null, changes: [] } })).toEqual({
      changes: [],
      open: [],
      recent: [],
    });
  });

  it('lists the console change waiting for you, with its card state, even with no plan yet', () => {
    const open = change(50, 'open');
    const { changes, open: plans } = plansPanel({ changes: { open, changes: [open] }, now });
    expect(changes).toHaveLength(1);
    expect(changes[0].change.n).toBe(50);
    expect(changes[0].card.state).toBe('waiting');
    expect(plans).toEqual([]);
  });

  it('says a change is checking while its pull request checks run, and merging once approved', () => {
    const open = change(50, 'open');
    expect(plansPanel({ changes: { open, changes: [] }, checks: () => 'pending' }).changes[0].card.state).toBe(
      'checking',
    );
    const approved = change(51, 'approved');
    expect(plansPanel({ changes: { open: approved, changes: [approved] } }).changes[0].card.state).toBe('merging');
  });

  it('keeps an open change however old, but drops one that ended', () => {
    const old = change(50, 'open', { updated: iso(3 * 24 * 60 * MIN) });
    expect(plansPanel({ changes: { open: old, changes: [old] }, now }).changes).toHaveLength(1);
    const rejected = change(49, 'rejected');
    const closed = change(48, 'closed');
    const nothing = change(47, 'merged', { outcome: { kind: 'nothing', at: iso(MIN) } });
    expect(plansPanel({ changes: { open: null, changes: [rejected, closed, nothing] }, now }).changes).toEqual([]);
  });

  it('lists a merged change the board has not compared yet, for a day', () => {
    const merged = change(50, 'merged');
    expect(plansPanel({ changes: { open: null, changes: [merged] }, now }).changes[0].card.state).toBe('merged');
    const stale = change(50, 'merged', { updated: iso(25 * 60 * MIN) });
    expect(plansPanel({ changes: { open: null, changes: [stale] }, now }).changes).toEqual([]);
  });

  it('shows a merged change as its plan once the panel lists the plan, and says which change it came from', () => {
    const merged = change(50, 'merged', { outcome: { kind: 'plan', plan: 'plan-3', at: iso(MIN) } });
    const result = plansPanel({ plans: [plan(3, 'waiting')], changes: { open: null, changes: [merged] }, now });
    expect(result.changes).toEqual([]);
    expect(result.open.map((r) => r.plan.id)).toEqual(['plan-3']);
    expect(result.open[0].change.n).toBe(50);
  });

  it('lists the open plans, applying first, with the run’s progress', () => {
    const plans = [plan(5, 'waiting'), plan(4, 'approved'), plan(3, 'applying'), plan(2, 'draft')];
    const runs = [
      {
        plan: 'plan-3',
        environment,
        phase: 'applying',
        steps: [
          { resource: 'acme-api', op: 'update', ok: true },
          { resource: 'acme-db', op: 'update', ok: true },
        ],
      },
      { plan: 'plan-4', environment, phase: 'queued', steps: null },
      { plan: 'plan-1', environment, phase: 'done', outcome: 'applied', steps: null },
    ];
    const { open } = plansPanel({ plans, runs });
    expect(open.map((r) => [r.plan.id, r.plan.state])).toEqual([
      ['plan-3', 'applying'],
      ['plan-4', 'approved'],
      ['plan-5', 'waiting'],
      ['plan-2', 'draft'],
    ]);
    expect(open[0].progress).toBe('2 of 2 changes applied');
    expect(open[1].progress).toBe('Waiting to apply');
    expect(open[2].progress).toBeNull();
  });

  it('shows a run still going whose plan is older than the ones read', () => {
    const runs = [
      { plan: 'plan-1', environment, phase: 'dispatched', steps: null, created: iso(MIN), updated: iso(MIN) },
    ];
    const { open } = plansPanel({ plans: [plan(9, 'applied')], runs });
    expect(open.map((r) => [r.plan.id, r.plan.state, r.progress])).toEqual([
      ['plan-1', 'applying', 'Starting the apply'],
    ]);
  });

  it('lists the last few plans that ended, newest first', () => {
    const plans = [
      plan(10, 'waiting'),
      ...[9, 8, 7, 6, 5, 4, 3].map((n) => plan(n, ['applied', 'failed', 'rolled back', 'rejected'][n % 4])),
    ];
    const { open, recent } = plansPanel({ plans });
    expect(open.map((r) => r.plan.id)).toEqual(['plan-10']);
    expect(recent).toHaveLength(RECENT_PLANS);
    expect(recent.map((r) => r.plan.id)).toEqual(['plan-9', 'plan-8', 'plan-7', 'plan-6', 'plan-5']);
  });

  it('lists the change waiting, the plan applying, and the recent ones together (the owner’s case)', () => {
    const open = change(150, 'open');
    const result = plansPanel({
      plans: [plan(2, 'applying'), plan(1, 'applied')],
      runs: [{ plan: 'plan-2', environment, phase: 'checked', steps: [] }],
      changes: { open, changes: [open] },
      now,
    });
    expect(result.changes.map((r) => [r.change.pull.number, r.card.state])).toEqual([[250, 'waiting']]);
    expect(result.open.map((r) => [r.plan.id, r.progress])).toEqual([['plan-2', '']]);
    expect(result.recent.map((r) => r.plan.id)).toEqual(['plan-1']);
  });
});

describe('runProgress', () => {
  const step = (/** @type {string} */ resource, ok = true) => ({ resource, op: 'update', ok });
  it('counts what applied against the plan’s changes, without repeating Applying', () => {
    expect(runProgress({ phase: 'applying', steps: [step('acme-api')] }, { state: 'applying', changes: 3 })).toBe(
      '1 of 3 changes applied',
    );
    expect(runProgress({ phase: 'applying', steps: [] }, { state: 'applying', changes: 3 })).toBe('');
  });
  it('says where the run is when the plan’s state doesn’t', () => {
    expect(runProgress({ phase: 'queued' }, { state: 'approved', changes: 1 })).toBe('Waiting to apply');
    expect(
      runProgress({ phase: 'rollback-applying', steps: [step('acme-api')] }, { state: 'applying', changes: 1 }),
    ).toBe('Rolling back · 1 of 1 change applied');
  });
  it('names the change that failed', () => {
    expect(
      runProgress(
        { phase: 'applying', steps: [step('acme-api'), step('acme-db', false)] },
        { state: 'applying', changes: 2 },
      ),
    ).toBe('1 of 2 changes applied; update of acme-db failed');
  });
});
