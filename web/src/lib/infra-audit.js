// How an environment's audit trail reads (WEB-61, WEB-62, WEB-87): the environment page and the plan page word each
// entry the same way, in the brand's Infrastructure words. Pure, so the tests can check them.

/** What each kind of audit entry says happened. */
const AUDIT_LABEL = {
  plan: 'Plan',
  approve: 'Approved',
  reject: 'Rejected',
  apply: 'Applied',
  rollback: 'Rolled back',
  envelope: 'Envelope',
  'lock-release': 'Lock released',
  'break-glass': 'Break-glass',
  freeze: 'Frozen',
  environment: 'Target changed',
  cleanup: 'Clean up',
};

/** An apply's or a rollback's steps, by outcome: what's under way reads as under way. */
const RUN_WORDS = {
  apply: {
    started: { label: 'Applying', outcome: 'started' },
    applying: { label: 'Applying', outcome: '' },
    failed: { label: 'Apply failed', outcome: '' },
    unhealthy: { label: 'Applied', outcome: 'health check failed' },
  },
  rollback: {
    started: { label: 'Rolling back', outcome: 'started' },
    applying: { label: 'Rolling back', outcome: '' },
  },
};

/** An envelope's entries, by outcome: the owner setting one, or a scale or restart asked for against it. */
const ENVELOPE_WORDS = {
  inside: { label: 'Inside an envelope', outcome: '' },
  outside: { label: 'Outside its envelope', outcome: 'waits for you' },
  'cap used': { label: 'Restart cap used', outcome: 'waits for you' },
  set: { label: 'Envelope set', outcome: '' },
  changed: { label: 'Envelope changed', outcome: '' },
  revoked: { label: 'Envelope revoked', outcome: '' },
};

/** A plan's state as an outcome, where its word differs from the stored one. */
const PLAN_OUTCOME = { waiting: 'waiting for you' };

/**
 * What the deploy flow recorded (BRK-195), from its summary's first words: it deploys, never applies, so its entries
 * read in the release flow's words.
 */
const DEPLOY_LABEL = { Deploy: 'Deployed', Promote: 'Promoted', 'Roll back': 'Rolled back' };

/** Who acted, as the trail records it: the owner is never named. */
const ACTOR = {
  owner: 'you',
  executor: 'the executor',
  envelope: 'an envelope',
  board: 'the board',
};

/**
 * An entry's label and outcome in words, with no outcome that only repeats the label.
 * @param {{ kind: string, outcome?: string | null, summary?: string | null }} e
 * @returns {{ label: string, outcome: string }}
 */
export function auditWords(e) {
  const outcome = e.outcome ?? '';
  if (e.kind === 'freeze') return { label: outcome === 'off' ? 'Unfrozen' : AUDIT_LABEL.freeze, outcome: '' };
  if (e.kind === 'envelope') return ENVELOPE_WORDS[outcome] ?? { label: AUDIT_LABEL.envelope, outcome };
  const flow = /^(Deploy|Promote|Roll back) of /u.exec(e.summary ?? '')?.[1];
  if (flow && (e.kind === 'apply' || e.kind === 'rollback')) {
    if (outcome === 'failed') return { label: `${flow} failed`, outcome: '' };
    // A deploy whose health check failed, and the version before came back by itself.
    if (outcome === 'rolled back') return { label: 'Rolled back', outcome: `${flow.toLowerCase()} failed its check` };
    return { label: DEPLOY_LABEL[flow], outcome: '' };
  }
  const run = RUN_WORDS[e.kind]?.[outcome];
  if (run) return run;
  const label = AUDIT_LABEL[e.kind] ?? e.kind;
  if (e.kind === 'plan') return { label, outcome: PLAN_OUTCOME[outcome] ?? outcome };
  return { label, outcome: outcome.toLowerCase() === label.toLowerCase() ? '' : outcome };
}

/**
 * Who made an entry: an agent by its name, anyone else in words.
 * @param {{ by: string, agent?: string | null }} e
 */
export const auditActor = (e) => (e.by === 'agent' ? (e.agent ?? 'an agent') : (ACTOR[e.by] ?? e.by));
