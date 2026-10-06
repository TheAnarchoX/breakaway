import { describe, expect, it } from 'vitest';
import {
  PLAN_ID,
  RunnerError,
  checkRunInputs,
  checkRunPlan,
  planDigest,
  runPath,
  runReport,
} from '../src/infra-runner.js';

// CLI-12: the apply runner's contract with the board, shared by the CLI's runner and the executor (BRK-183).
const INPUTS = { plan: 'p-1', environment: 'staging', board: 'https://board.example.com/x', run: '42' };
const DIFF = {
  provider: 'fake',
  environment: 'staging',
  changes: [
    {
      op: 'update',
      resource: 'svc-1',
      kind: 'service',
      name: 'api',
      before: { instances: 1 },
      after: { instances: 2 },
      reversible: true,
    },
  ],
  reversible: true,
};
const plan = (over = {}) => ({ plan: { id: 'p-1', environment: 'staging', state: 'approved', diff: DIFF, ...over } });

describe('the runner’s inputs (CLI-12)', () => {
  it('takes a plan, an environment, the run, and the board’s https origin', () => {
    expect(checkRunInputs(INPUTS)).toEqual({
      plan: 'p-1',
      environment: 'staging',
      origin: 'https://board.example.com',
      run: '42',
    });
  });

  it('refuses to start without a plan ID', () => {
    for (const plan of [undefined, '']) expect(() => checkRunInputs({ ...INPUTS, plan })).toThrow(/no plan/u);
    expect(() => checkRunInputs({ ...INPUTS, plan: '../x' })).toThrow(RunnerError);
    expect(PLAN_ID.test('a'.repeat(65))).toBe(false);
  });

  it('refuses a bad environment, a missing run, and a board that isn’t https', () => {
    expect(() => checkRunInputs({ ...INPUTS, environment: 'Prod!' })).toThrow(/environment/u);
    expect(() => checkRunInputs({ ...INPUTS, run: undefined })).toThrow(/run ID/u);
    expect(() => checkRunInputs({ ...INPUTS, board: 'http://board.example.com' })).toThrow(/https/u);
    expect(() => checkRunInputs({ ...INPUTS, board: undefined })).toThrow(/BREAKAWAY_URL/u);
  });

  it('asks the board at /api/infra/runs/<plan>', () => {
    expect(runPath('p-1')).toBe('/api/infra/runs/p-1');
  });
});

describe('the plan the board hands its run (CLI-12)', () => {
  const expected = { plan: 'p-1', environment: 'staging' };

  it('takes one approved plan for this environment', () => {
    expect(checkRunPlan(plan(), expected).id).toBe('p-1');
    expect(checkRunPlan(plan({ state: 'applying' }), expected).id).toBe('p-1');
  });

  it('refuses a plan that isn’t approved, or isn’t the one the run was started for', () => {
    for (const state of ['draft', 'waiting', 'rejected', 'applied', 'failed', 'rolled back', undefined])
      expect(() => checkRunPlan(plan({ state }), expected)).toThrow(/not approved/u);
    expect(() => checkRunPlan(plan({ id: 'p-2' }), expected)).toThrow(/not p-1/u);
    expect(() => checkRunPlan(plan({ environment: 'production' }), expected)).toThrow(/not staging/u);
    expect(() => checkRunPlan(plan({ diff: { ...DIFF, environment: 'production' } }), expected)).toThrow(
      /another environment/u,
    );
    expect(() => checkRunPlan(plan({ diff: null }), expected)).toThrow(/no changes/u);
    expect(() => checkRunPlan({}, expected)).toThrow(/no plan/u);
    expect(() => checkRunPlan(null, expected)).toThrow(/no plan/u);
  });
});

describe('what a run reports (CLI-12)', () => {
  it('digests the same diff the same way, whatever order its keys are in', async () => {
    const a = await planDigest(DIFF);
    const reordered = { reversible: true, changes: DIFF.changes, environment: 'staging', provider: 'fake' };
    expect(await planDigest(reordered)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(await planDigest({ ...DIFF, reversible: false })).not.toBe(a);
  });

  it('carries the run, the step, and the digest, and redacts what failed', async () => {
    const digest = await planDigest(DIFF);
    expect(runReport({ run: '42', step: 'applying', digest })).toEqual({ run: '42', step: 'applying', digest });
    const failed = runReport({
      run: '42',
      step: 'failed',
      digest,
      error: 'refused: token=ghp_0123456789abcdef0123456789abcdef0123',
      steps: [{ resource: 'svc-1', op: 'update', ok: false, error: 'x'.repeat(900) }],
    });
    expect(failed.error).not.toContain('ghp_0123456789abcdef');
    expect(failed.steps[0].error.length).toBeLessThanOrEqual(500);
    expect(() => runReport({ run: '42', step: 'done', digest })).toThrow(/reports/u);
    expect(() => runReport({ run: '42', step: 'applied', digest: 'abc' })).toThrow(/digest/u);
  });
});
