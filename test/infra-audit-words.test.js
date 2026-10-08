import { describe, expect, it } from 'vitest';
import { auditActor, auditSummary, auditWords, summaryText } from '../web/src/lib/infra-audit.js';
import { streamItems } from '../web/src/lib/env-stream.js';

// How the environment page and the plan page word an audit entry (WEB-87): one label for what happened, and the
// outcome only when it adds something.
describe('auditWords', () => {
  it('drops an outcome that only repeats the label', () => {
    expect(auditWords({ kind: 'approve', outcome: 'approved' })).toEqual({ label: 'Approved', outcome: '' });
    expect(auditWords({ kind: 'reject', outcome: 'rejected' })).toEqual({ label: 'Rejected', outcome: '' });
    expect(auditWords({ kind: 'plan', outcome: 'waiting' })).toEqual({ label: 'Plan', outcome: 'waiting for you' });
    expect(auditWords({ kind: 'plan', outcome: 'draft' })).toEqual({ label: 'Plan', outcome: 'draft' });
  });

  it('never says waiting for you for a plan its envelope moved, and still does for one that waits (WEB-125)', () => {
    expect(auditWords({ kind: 'plan', outcome: 'waiting', by: 'envelope' })).toEqual({
      label: 'Plan',
      outcome: 'inside its envelope',
    });
    expect(auditWords({ kind: 'plan', outcome: 'waiting', by: 'board' })).toEqual({
      label: 'Plan',
      outcome: 'waiting for you',
    });
    expect(auditWords({ kind: 'plan', outcome: 'waiting', by: 'agent' })).toEqual({
      label: 'Plan',
      outcome: 'waiting for you',
    });
  });

  it('says an apply that started or is running is applying, and one that failed failed', () => {
    expect(auditWords({ kind: 'apply', outcome: 'started' })).toEqual({ label: 'Applying', outcome: 'started' });
    expect(auditWords({ kind: 'apply', outcome: 'applying' })).toEqual({ label: 'Applying', outcome: '' });
    expect(auditWords({ kind: 'apply', outcome: 'applied' })).toEqual({ label: 'Applied', outcome: '' });
    expect(auditWords({ kind: 'apply', outcome: 'failed' })).toEqual({ label: 'Apply failed', outcome: '' });
    expect(auditWords({ kind: 'apply', outcome: 'unhealthy' })).toEqual({
      label: 'Applied',
      outcome: 'health check failed',
    });
    expect(auditWords({ kind: 'rollback', outcome: 'started' })).toEqual({ label: 'Rolling back', outcome: 'started' });
    expect(auditWords({ kind: 'rollback', outcome: 'rolled back' })).toEqual({ label: 'Rolled back', outcome: '' });
  });

  it('says an environment was added, changed, or removed, and a pipeline move changed its target (BRK-229)', () => {
    expect(auditWords({ kind: 'environment', outcome: 'added' })).toEqual({ label: 'Environment added', outcome: '' });
    expect(auditWords({ kind: 'environment', outcome: 'changed' })).toEqual({
      label: 'Environment changed',
      outcome: '',
    });
    expect(auditWords({ kind: 'environment', outcome: 'removed' })).toEqual({
      label: 'Environment removed',
      outcome: '',
    });
    expect(auditWords({ kind: 'environment', outcome: 'follows the pipeline’s staging' }).label).toBe('Target changed');
  });

  it('never says inside an envelope for a change outside it, or for setting one', () => {
    expect(auditWords({ kind: 'envelope', outcome: 'inside' })).toEqual({ label: 'Inside an envelope', outcome: '' });
    expect(auditWords({ kind: 'envelope', outcome: 'outside' })).toEqual({
      label: 'Outside its envelope',
      outcome: 'waits for you',
    });
    expect(auditWords({ kind: 'envelope', outcome: 'cap used' })).toEqual({
      label: 'Restart cap used',
      outcome: 'waits for you',
    });
    expect(auditWords({ kind: 'envelope', outcome: 'set' })).toEqual({ label: 'Envelope set', outcome: '' });
    expect(auditWords({ kind: 'envelope', outcome: 'changed' })).toEqual({ label: 'Envelope changed', outcome: '' });
    expect(auditWords({ kind: 'envelope', outcome: 'revoked' })).toEqual({ label: 'Envelope revoked', outcome: '' });
  });

  it('names every kind the trail records, never its raw key', () => {
    expect(auditWords({ kind: 'lock-release', outcome: 'failed' })).toEqual({
      label: 'Lock released',
      outcome: 'failed',
    });
    expect(auditWords({ kind: 'freeze', outcome: 'on' })).toEqual({ label: 'Frozen', outcome: '' });
    expect(auditWords({ kind: 'freeze', outcome: 'off' })).toEqual({ label: 'Unfrozen', outcome: '' });
    expect(auditWords({ kind: 'break-glass', outcome: 'recorded' }).label).toBe('Break-glass');
  });

  it('words the deploy flow’s entries in its own words', () => {
    expect(auditWords({ kind: 'apply', outcome: 'applied', summary: 'Deploy of abc1234 to staging' })).toEqual({
      label: 'Deployed',
      outcome: '',
    });
    expect(auditWords({ kind: 'apply', outcome: 'failed', summary: 'Promote of abc1234' })).toEqual({
      label: 'Promote failed',
      outcome: '',
    });
    expect(auditWords({ kind: 'rollback', outcome: 'rolled back', summary: 'Deploy of abc1234' })).toEqual({
      label: 'Rolled back',
      outcome: 'deploy failed its check',
    });
  });
});

describe('auditActor', () => {
  it('never names the owner, and names an agent', () => {
    expect(auditActor({ by: 'owner' })).toBe('you');
    expect(auditActor({ by: 'executor' })).toBe('the executor');
    expect(auditActor({ by: 'agent', agent: 'claude-acme-1' })).toBe('claude-acme-1');
    expect(auditActor({ by: 'agent' })).toBe('an agent');
  });
});

// A lock release reads in words, never as its raw holder (WEB-96): the plan the lock was for links to its page.
describe('auditSummary', () => {
  const release = (by, outcome, summary, plan = 'plan-1') => ({ kind: 'lock-release', by, outcome, summary, plan });

  it('says the executor released the lock after its plan', () => {
    const e = release('executor', 'released', 'executor:plan-1 released the lock');
    expect(auditSummary(e)).toEqual(['The executor released the lock after ', { plan: 'plan-1' }]);
    expect(auditWords(e)).toEqual({ label: 'Lock released', outcome: '' });
    expect(auditSummary({ ...e, plan: null })).toEqual(['The executor released the lock']);
  });

  it('says you released it when the owner forced it', () => {
    const e = release('owner', 'forced', 'the owner released executor:plan-1’s lock');
    expect(auditSummary(e)).toEqual(['You released the lock held for ', { plan: 'plan-1' }]);
    expect(auditSummary({ ...e, plan: null })).toEqual(['You released the lock']);
  });

  it('says the lock expired when the next take found it unreleased', () => {
    const e = release('board', 'expired', 'executor:plan-1’s lock expired unreleased; executor:plan-2 took it');
    expect(auditSummary(e)).toEqual(['The lock held for ', { plan: 'plan-1' }, ' expired']);
    expect(summaryText(auditSummary({ ...e, plan: null }))).toBe('The lock expired');
  });

  it('keeps any other entry’s summary as it was recorded', () => {
    expect(auditSummary({ kind: 'approve', by: 'owner', summary: 'Approved plan-1' })).toEqual(['Approved plan-1']);
    expect(auditSummary({ kind: 'approve', by: 'owner', summary: null })).toEqual([]);
  });

  it('never shows the raw holder in the stream', () => {
    const now = Date.now();
    const [item] = streamItems({
      audit: [{ id: 1, at: now, ...release('executor', 'released', 'executor:plan-1 released the lock') }],
    });
    expect(item.text).toBe('The executor released the lock after plan-1');
    expect(item.parts).toEqual(['The executor released the lock after ', { plan: 'plan-1' }]);
    expect(item.text).not.toContain('executor:plan-1');
  });

  it('never shows a scale inside an envelope as waiting for you in the stream (WEB-125)', () => {
    const now = Date.now();
    const items = streamItems({
      audit: [
        {
          id: 1,
          at: now - 2000,
          kind: 'plan',
          by: 'envelope',
          outcome: 'waiting',
          plan: 'plan-2',
          summary: 'inside its envelope: 3 replicas, within 2–6',
        },
        {
          id: 2,
          at: now - 1000,
          kind: 'approve',
          by: 'envelope',
          outcome: 'approved',
          plan: 'plan-2',
          summary: 'approved by its envelope',
        },
      ],
    });
    expect(items.map((i) => i.outcome)).not.toContain('waiting for you');
    expect(items.find((i) => i.key === 'audit:1')?.outcome).toBe('inside its envelope');
  });
});
