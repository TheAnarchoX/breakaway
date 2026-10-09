/**
 * Approving a change from the console (docs/specs/BRK-258-plan-from-the-board.md, "One press to approve"; BRK-260),
 * the pure part. The owner approves the plan of a change whose pull request the board opened; the board merges that
 * pull request as the owner's action and, once the merged desired state plans to exactly what was approved, approves
 * that plan on the recorded press and queues the apply. The digest binds the press to one diff: a plan that differs
 * after the merge waits for the owner as any other.
 *
 * This file keeps the approval's record, says which part of the approved plan drift's plan after the merge keeps,
 * picks how the pull request merges from what GitHub says about it, and words what the change's card shows. The store
 * (src/store-infra-change-approval.js) reads GitHub, merges, and settles the plan. Pure and Node-safe.
 */
import { isDrift } from './infra-drift.js';

/** An approval waits this long for its merge, then lapses and the change asks again. */
export const APPROVAL_LAPSE_MS = 24 * 60 * 60 * 1000;

/**
 * How the board merges an approved change's pull request: `now` (it was ready), `auto` (GitHub's auto-merge, on for
 * the head the owner approved), or `sync` (the repository doesn't allow auto-merge, so the board merges at the first
 * sync after its checks pass).
 * @typedef {'now' | 'auto' | 'sync'} MergeMode
 */

/**
 * What the owner approved, kept on the change: the head and the plan's digest they saw, the digest of the part of it
 * drift's plan keeps after the merge (`kept`), the policy's rules that applied, when, how it merges, and, once the
 * merged plan is made, that plan and what became of it.
 * `person` is who approved it (BRK-303): the owner, or a person's handle; an approval from before has none, the owner's.
 * @typedef {{ by: 'owner' | 'person', person?: string, at: string, sha: string, digest: string, kept: string,
 *   rules: string[],
 *   merge: MergeMode | null, plan: string | null, settled: 'approved' | 'waits' | 'refused' | null }} ChangeApproval
 */

/**
 * The resources a change removes, by ID: drift leaves deletes to clean up, so after a change of the board's merges, its
 * plan keeps these deletes and no other.
 * @param {Array<{ op: string, resource?: string }>} edits
 */
export function removedBy(edits) {
  return new Set(edits.filter((e) => e.op === 'remove' && typeof e.resource === 'string').map((e) => e.resource));
}

/**
 * Which changes of the provider's plan drift keeps for a merged change: every change but a delete, and the deletes the
 * change asked for.
 * @param {Array<{ op: string, resource?: string }>} edits
 * @returns {(change: { op: string, resource: string }) => boolean}
 */
export function keepsChange(edits) {
  const removed = removedBy(edits);
  return (c) => isDrift(/** @type {any} */ (c)) || (c.op === 'delete' && removed.has(c.resource));
}

/**
 * The part of a previewed plan that drift's plan after the merge keeps (keepsChange), as a plan keeps it: its digest
 * is what the merged plan's must be.
 * @template {{ changes: Array<{ op: string, resource: string, reversible: boolean }>, reversible: boolean }} D
 * @param {D} diff
 * @param {Array<{ op: string, resource?: string }>} edits
 * @returns {D}
 */
export function keptForMerge(diff, edits) {
  const keep = keepsChange(edits);
  const changes = diff.changes.filter(keep);
  return { ...diff, changes, reversible: changes.every((c) => c.reversible) };
}

/**
 * The policy's rules that apply to a plan, by name.
 * @param {{ rules?: Array<{ rule: string, applies: boolean }> } | null | undefined} policy
 * @returns {string[]}
 */
export function appliedRules(policy) {
  return (policy?.rules ?? []).filter((r) => r.applies).map((r) => r.rule);
}

/**
 * The rules that apply to the merged plan and didn't apply to the plan the owner approved: any one means the plan
 * waits for the owner.
 * @param {string[]} approved
 * @param {{ rules?: Array<{ rule: string, applies: boolean }> } | null | undefined} policy
 */
export function newRules(approved, policy) {
  const had = new Set(approved);
  return appliedRules(policy).filter((r) => !had.has(r));
}

/**
 * Whether an approval waited too long for its merge.
 * @param {ChangeApproval | null} approval
 * @param {number} now
 */
export function approvalLapsed(approval, now) {
  if (!approval) return false;
  const at = Date.parse(approval.at);
  return Number.isFinite(at) && now - at >= APPROVAL_LAPSE_MS;
}

/**
 * What the board does next with an approved change's pull request, from what GitHub says about it:
 * - `conflicts`: it has conflicts with the default branch, so it can't merge;
 * - `failing`: its checks failed;
 * - `behind`: protection wants it current, so the board updates its own branch first;
 * - `now`: it's ready to merge;
 * - `wait`: its checks are still running, or GitHub hasn't worked it out yet: auto-merge, or the next green sync.
 * @param {{ mergeable?: boolean | null, mergeableState?: string | null, checks?: string | null }} pull
 * @returns {'conflicts' | 'failing' | 'behind' | 'now' | 'wait'}
 */
export function mergeRoute({ mergeable = null, mergeableState = null, checks = null }) {
  if (mergeableState === 'dirty' || mergeable === false) return 'conflicts';
  if (checks === 'failure') return 'failing';
  if (mergeableState === 'behind') return 'behind';
  if (['clean', 'has_hooks'].includes(mergeableState ?? '')) return 'now';
  // Unstable is a check that failed or is still running: merged only once the checks say which.
  if (mergeableState === 'unstable' && ['success', 'none'].includes(checks ?? '')) return 'now';
  return 'wait';
}

/** An environment's name with its first letter up, to start a line. */
const upper = (name) => `${String(name).charAt(0).toUpperCase()}${String(name).slice(1)}`;

/** The card's lines (brand/README.md's Infrastructure words; the spec's "The words"). */
export const approvalWords = {
  frozen: (env) => `${upper(env)} is frozen: unfreeze it to approve.`,
  moved: (n) => `#${n} changed since you looked. Read it again.`,
  changed: 'What runs changed since you looked. Here’s the plan now.',
  between: 'The plan changed between your approval and the merge.',
  nothing: (env, n) => `Nothing changes in ${env}: merging #${n} records it as code.`,
  conflicts: (n) => `Can’t merge #${n}: it has conflicts.`,
  failing: (n) => `Can’t merge #${n}: checks failing.`,
  refused: (n, reason) => `Can’t merge #${n}: GitHub says “${reason}”. Look at it on GitHub.`,
  permission: (n) =>
    `Can’t merge #${n}: the board’s GitHub App can’t write yet. Give it read and write on Pull requests and Contents, then accept the change on the installation (Connections).`,
  updated: (n) => `Can’t merge #${n}: updating it from the default branch changed its plan. Propose again.`,
  lapsed: 'Your approval waited 24 hours for the merge and lapsed. Approve again.',
};
