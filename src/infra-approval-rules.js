/**
 * Who must approve a plan (BRK-303, docs/specs/BRK-299-people-and-roles.md, point 7), the pure part: an environment's
 * approval rule, whether a change to it tightens or loosens, and where a plan's approvals stand against it.
 *
 * A rule is `{ role, people }`: the role an approver needs in the environment's repository (`maintainer`, or `owner`
 * for the owner alone), and how many different people approve (1, or 2 for the two-person rule). It's kept on the
 * board, never in the repository's policy.json, so a pull request can't lower the bar for its own plans. The default
 * is one maintainer, and the owner always counts as one: today's behaviour in an install with nobody invited.
 *
 * Under the two-person rule, nobody approves twice, and the person who proposed what's being approved doesn't count.
 * When nobody else could approve, the owner may approve alone, with a second confirm, recorded in the audit trail.
 */
import { AgentError } from './store-agents.js';

/** @typedef {{ role: 'maintainer' | 'owner', people: 1 | 2 }} ApprovalRule */

/** @type {ApprovalRule} */
export const DEFAULT_RULE = Object.freeze({ role: 'maintainer', people: 1 });

const ROLE_RANK = { maintainer: 1, owner: 2 };

/**
 * A rule from what was sent, or an AgentError that says what's wrong.
 * @param {any} input
 * @returns {ApprovalRule}
 */
export function checkRule(input) {
  const role = input?.role ?? DEFAULT_RULE.role;
  if (role !== 'maintainer' && role !== 'owner') throw new AgentError('role must be maintainer or owner', 400);
  const people = Number(input?.people ?? DEFAULT_RULE.people);
  if (people !== 1 && people !== 2) throw new AgentError('people must be 1 or 2', 400);
  return { role, people: /** @type {1 | 2} */ (people) };
}

/**
 * Whether going from `from` to `to` loosens the rule: a lower role, or fewer people. Anything that loosens is the
 * owner's; a change that only tightens (or changes nothing) is a maintainer's.
 * @param {ApprovalRule} from
 * @param {ApprovalRule} to
 */
export function loosens(from, to) {
  return ROLE_RANK[to.role] < ROLE_RANK[from.role] || to.people < from.people;
}

/**
 * A rule in words: "one maintainer", "two people, each a maintainer", "the owner".
 * @param {ApprovalRule} rule
 */
export function ruleWords(rule) {
  if (rule.role === 'owner') return rule.people === 2 ? 'the owner and one other person' : 'the owner';
  return rule.people === 2 ? 'two different maintainers' : 'one maintainer';
}

/**
 * Where a plan's approvals stand: who has approved, how many more it needs, who else may approve, and whether the
 * owner may approve alone. `eligible` is everyone who holds the rule's role in the repository (the owner included);
 * `proposer` is the person who proposed it, who never counts under the two-person rule.
 * @param {ApprovalRule} rule
 * @param {{ approvals: { person: string, at: number }[], eligible: string[], proposer?: string | null }} state
 */
export function approvalState(rule, { approvals, eligible, proposer = null }) {
  const have = approvals.map((a) => a.person);
  const needs = Math.max(rule.people - have.length, 0);
  const counts = (p) => rule.people === 1 || p !== proposer;
  // Under "the owner and one other", the owner must be one of them; anyone with the repository's maintainer role is
  // the other.
  const ownerMissing = rule.role === 'owner' && !have.includes('owner');
  const others = eligible.filter((p) => !have.includes(p) && counts(p));
  const mayApprove = ownerMissing && needs === 1 ? others.filter((p) => p === 'owner') : others;
  return {
    rule,
    words: ruleWords(rule),
    approvals,
    needs,
    mayApprove,
    // Nobody else could give the second approval: the owner may approve alone, with a second confirm.
    alone: rule.people === 2 && needs > 0 && mayApprove.filter((p) => p !== 'owner').length === 0,
  };
}

/**
 * Why `person` can't approve under `rule` now, or null when they can: the rule's role, approving twice, and the
 * proposer under the two-person rule.
 * @param {ApprovalRule} rule
 * @param {string} person `owner` or a handle
 * @param {{ approvals: { person: string }[], eligible: string[], proposer?: string | null, what: string }} state
 */
export function approveRefusal(rule, person, { approvals, eligible, proposer = null, what }) {
  if (!eligible.includes(person))
    return rule.role === 'owner'
      ? `only the owner approves ${what}: its environment’s rule is ${ruleWords(rule)}`
      : `only a maintainer of its repository approves ${what}`;
  if (approvals.some((a) => a.person === person))
    return `you’ve approved ${what} already: its environment’s rule is ${ruleWords(rule)}, so someone else approves it too`;
  if (rule.people === 2 && person === proposer)
    return `you proposed ${what}: its environment’s rule is ${ruleWords(rule)}, so two other people approve it`;
  // Under "the owner and one other", the second approval is the owner's when the owner hasn't approved yet.
  if (
    rule.role === 'owner' &&
    person !== 'owner' &&
    !approvals.some((a) => a.person === 'owner') &&
    approvals.length + 1 >= rule.people
  )
    return `the owner approves ${what} too: its environment’s rule is ${ruleWords(rule)}`;
  return null;
}
