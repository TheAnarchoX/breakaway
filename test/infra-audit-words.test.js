import { describe, expect, it } from 'vitest';
import { auditActor, auditWords } from '../web/src/lib/infra-audit.js';

// How the environment page and the plan page word an audit entry (WEB-87): one label for what happened, and the
// outcome only when it adds something.
describe('auditWords', () => {
  it('drops an outcome that only repeats the label', () => {
    expect(auditWords({ kind: 'approve', outcome: 'approved' })).toEqual({ label: 'Approved', outcome: '' });
    expect(auditWords({ kind: 'reject', outcome: 'rejected' })).toEqual({ label: 'Rejected', outcome: '' });
    expect(auditWords({ kind: 'plan', outcome: 'waiting' })).toEqual({ label: 'Plan', outcome: 'waiting for you' });
    expect(auditWords({ kind: 'plan', outcome: 'draft' })).toEqual({ label: 'Plan', outcome: 'draft' });
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
