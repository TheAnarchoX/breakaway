/**
 * Architect's audit trail, the pure part (docs/specs/IDEA-19-architect.md, "Audit trail"; BRK-175): what an entry
 * holds, checked and scrubbed before src/store-infra-audit.js appends it. Nothing secret or personal is kept: every
 * text is redacted the way Connections redacts (src/redact.js), email addresses are dropped, and the owner is only
 * ever `owner`.
 */
import { AgentError } from './store-agents.js';
import { redact } from './redact.js';

export const DAY = 86_400_000;
/** At least a year, always (the spec): the table's own trigger refuses a younger delete whatever this says. */
export const AUDIT_KEPT_DAYS = 2 * 365;
export const YEAR_DAYS = 365;

/** What an entry records, in the spec's words: a plan, its approval or rejection, an apply, and the rest; a freeze or thaw is `freeze`. */
export const AUDIT_KINDS = ['plan', 'approve', 'reject', 'apply', 'envelope', 'lock-release', 'break-glass', 'freeze'];
/** Who acted: the owner (never by name), the executor, an envelope acting with no press, or an agent proposing. */
export const AUDIT_ACTORS = ['owner', 'executor', 'envelope', 'agent', 'board'];

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENVIRONMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const AGENT = /^[\w.@:/-]{1,64}$/u;
const REF = /^[\w.:#/-]{1,100}$/u;
const EMAIL = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/gu;
const OUTCOME_MAX = 120;
const SUMMARY_MAX = 500;

/**
 * What the control plane appends: `at` is always the board's clock, never the caller's.
 * @typedef {{ kind: string, repo: string, environment: string, by: string, plan?: string | null,
 *   agent?: string | null, envelope?: string | null, outcome?: string, summary?: string }} AuditInput
 */

/** Text from outside the board, safe to keep for a year: secrets and email addresses redacted, short. */
function scrub(text, max) {
  const s = redact(String(text ?? ''))
    .replace(EMAIL, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** An optional reference (a plan, an envelope): checked, then redacted like any text in case it holds a token. */
function ref(value, what) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!REF.test(s)) throw new AgentError(`${what} must be up to 100 letters, digits, and . : # / - _`, 400);
  return scrub(s, 100);
}

/**
 * The entry to store, or an AgentError that says what's wrong.
 * @param {AuditInput} input
 */
export function auditEntry(input) {
  const kind = String(input?.kind ?? '');
  if (!AUDIT_KINDS.includes(kind)) throw new AgentError(`kind must be one of ${AUDIT_KINDS.join(', ')}`, 400);
  const by = String(input?.by ?? '');
  if (!AUDIT_ACTORS.includes(by)) throw new AgentError(`by must be one of ${AUDIT_ACTORS.join(', ')}`, 400);
  const repo = String(input?.repo ?? '').toLowerCase();
  if (!SLUG.test(repo)) throw new AgentError('repo must be a repository’s slug', 400);
  const environment = String(input?.environment ?? '').toLowerCase();
  if (!ENVIRONMENT.test(environment)) throw new AgentError('environment must be an environment’s name', 400);
  const agent = input?.agent ? String(input.agent) : null;
  if (agent !== null && !AGENT.test(agent)) throw new AgentError('agent must be an agent’s name on the board', 400);
  if (by === 'agent' && !agent) throw new AgentError('an entry by an agent names the agent', 400);
  return {
    kind,
    repo,
    environment,
    plan: ref(input?.plan, 'plan'),
    by,
    agent: agent === null ? null : scrub(agent, 64),
    envelope: ref(input?.envelope, 'envelope'),
    outcome: scrub(input?.outcome, OUTCOME_MAX),
    summary: scrub(input?.summary, SUMMARY_MAX),
  };
}
