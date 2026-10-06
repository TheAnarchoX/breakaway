/**
 * Architect's clean up, the pure part (docs/specs/IDEA-19-architect.md, "Clean up"; BRK-201): what nobody owns. A
 * resource is unowned when it runs in an environment's scope (it's in the environment's inventory slice, BRK-177) but
 * the environment's desired state doesn't declare it, so its provider's plan would delete it, and nothing else owns
 * it: it isn't the environment's target (a pipeline's Worker), its environment isn't a short-lived one a task owns
 * (BRK-200 removes those itself), and no break-glass mark (BRK-187) covers it, since that mark's task puts it into
 * code. The board flags it on the environment, and once it has been flagged for CLEANUP_GRACE_MS it makes one removal
 * plan (source `cleanup`), which waits for the owner: a delete always trips the destructive guard, so it's never
 * approved by the board. The store (store-infra-cleanup.js) keeps the flags.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */
/** @typedef {import('./infra-provider.js').Change} Change */

const DAY = 24 * 60 * 60 * 1000;

/** How long a resource is flagged before the board proposes removing it: time to claim it, or say it's wanted. */
export const CLEANUP_GRACE_MS = 7 * DAY;

/**
 * Why a resource the provider would delete isn't unowned: it's the environment's target, it's outside the
 * environment's scope, or a break-glass mark covers it. Null when it's unowned.
 * @param {Change} c a delete from the provider's plan
 * @param {{ target: string | null, inScope: Set<string>, brokenGlass: Set<string> }} context
 */
export function ownedBecause(c, { target, inScope, brokenGlass }) {
  if (target && (c.resource === target || c.name === target)) return 'target';
  if (!inScope.has(c.resource)) return 'scope';
  if (brokenGlass.has(c.resource)) return 'break-glass';
  return null;
}

/**
 * What nobody owns in an environment, from its provider's plan against its desired state: the deletes, less what
 * `ownedBecause` says something owns, a line per resource.
 * @param {PlanDiff} diff
 * @param {{ target: string | null, inScope: Set<string>, brokenGlass: Set<string> }} context
 * @returns {Array<{ id: string, kind: string, name: string }>}
 */
export function unownedResources(diff, context) {
  const seen = new Set();
  return diff.changes
    .filter((c) => c.op === 'delete' && !ownedBecause(c, context))
    .filter((c) => !seen.has(c.resource) && seen.add(c.resource))
    .map((c) => ({ id: c.resource, kind: c.kind, name: c.name }));
}

/**
 * Whether a flag's grace period is over, so the board proposes removing it.
 * @param {number} flagged when it was flagged, in ms
 * @param {number} now
 */
export function cleanupDue(flagged, now) {
  return now - Number(flagged) >= CLEANUP_GRACE_MS;
}

/**
 * A flag as the API shows it. `plan` is the removal plan that covers it, once the grace period is over, with its
 * state; a removal the owner rejected keeps the resource, and the board proposes it no more.
 * @param {Record<string, any>} row
 * @param {string | null} planState
 */
export function unownedView(row, planState) {
  const flagged = Number(row.flagged);
  return {
    id: row.rid,
    kind: row.kind,
    name: row.name,
    flagged: new Date(flagged).toISOString(),
    removeAfter: new Date(flagged + CLEANUP_GRACE_MS).toISOString(),
    plan: row.plan ? { id: `plan-${Number(row.plan)}`, state: planState } : null,
    kept: planState === 'rejected',
    error: row.error ?? null,
  };
}
