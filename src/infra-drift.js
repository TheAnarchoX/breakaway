/**
 * Architect's drift, the pure part (docs/specs/IDEA-19-architect.md, "Drift"; BRK-184): the difference between what an
 * environment's desired state says and what its provider sees running. The board compares the two on the cron, shows
 * what differs on the environment, and makes one plan from it: a draft (source `drift`) the owner can put in front of
 * themselves or turn into a task, or, when the desired state itself moved since the drift was last settled (a merged
 * change, BRK-246), one from the pull request that waits for the owner. It never applies one by itself. The store (store-infra-drift.js) keeps the last comparison.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */

/** How often the cron compares an environment, unless its desired state's commit changed since the last time. */
export const DRIFT_EVERY_MS = 60 * 60 * 1000;
/** The most environments one cron tick compares, oldest comparison first: each one is a call to its provider. */
export const DRIFT_PER_TICK = 5;
/** A plan in one of these states still stands for what it would change, so drift it covers needs no other plan. */
export const OPEN_PLAN_STATES = ['draft', 'waiting', 'approved', 'applying'];
/** The sources of the plans a comparison makes: while one of them is open, a comparison makes no other. */
export const DRIFT_PLAN_SOURCES = ['drift', 'pull-request'];

/** JSON with every object's keys sorted, so two equal diffs read the same whatever order a provider sent. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * One change as one line, the same whatever order its keys came in: what a fingerprint is made of, and what
 * break-glass (infra-break-glass.js) marks.
 * @param {import('./infra-provider.js').Change} c
 */
export function driftLine(c) {
  return canonical({ op: c.op, resource: c.resource, kind: c.kind, name: c.name, before: c.before, after: c.after });
}

/** Whether a change of the provider's plan is drift, not clean up's: every change but a delete. */
export const isDrift = (/** @type {import('./infra-provider.js').Change} */ c) => c.op !== 'delete';

/**
 * The drift in a provider's plan: every change but its deletes. A delete is a resource that runs but isn't in the
 * desired state, which nobody owns; clean up (BRK-201, infra-cleanup.js) flags it and proposes removing it after a
 * grace period, so drift never plans it away at once.
 * @param {PlanDiff} diff
 * @returns {PlanDiff}
 */
export function driftChanges(diff) {
  const changes = diff.changes.filter(isDrift);
  return { ...diff, changes, reversible: changes.every((c) => c.reversible) };
}

/**
 * What differs, a line per resource: what the plan would do to it to bring it back to the desired state.
 * @param {PlanDiff} diff
 * @returns {Array<{ id: string, kind: string, name: string, op: string }>}
 */
export function driftResources(diff) {
  return diff.changes.map((c) => ({ id: c.resource, kind: c.kind, name: c.name, op: c.op }));
}

/**
 * A fingerprint of what differs: the same drift has the same one, in any order, so a second comparison finds the
 * plan the first one made instead of making another. Hex SHA-256 of the changes, sorted.
 * @param {PlanDiff} diff
 * @returns {Promise<string>}
 */
export async function driftFingerprint(diff) {
  return sha256(diff.changes.map(driftLine).sort().join('\n'));
}

/**
 * A fingerprint of a desired state: the same file has the same one, whatever order its keys are in, so a comparison
 * can tell the desired state moved (a merged change) from a commit that left this environment's file alone. Hex
 * SHA-256, or null when there's no desired state.
 * @param {unknown} desired
 * @returns {Promise<string | null>}
 */
export async function desiredFingerprint(desired) {
  return desired ? sha256(canonical(desired)) : null;
}

/**
 * Whether drift comes from the desired state moving rather than a change by hand: the desired state differs from the
 * one the drift was last settled against. On an environment's first comparison, it did when its file was added since
 * the board started reading the repository (`added`); a file there from the start counts as by hand, as does a
 * comparison kept before the board remembered the desired state (`desired_hash` null).
 * @param {{ desired_hash?: string | null } | null | undefined} last
 * @param {string | null} desiredHash
 * @param {boolean} [added] whether the environment's file was added since the board started reading the repository
 */
export function desiredMoved(last, desiredHash, added = false) {
  if (!desiredHash) return false;
  if (!last) return added;
  if (!last.desired_hash) return false;
  return last.desired_hash !== desiredHash;
}

/** @param {string} text */
async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether the cron compares an environment now: it never has, its desired state moved to another commit, or the last
 * comparison is DRIFT_EVERY_MS old.
 * @param {{ checked: number, desired_sha: string | null } | null | undefined} last
 * @param {string | null} desiredSha
 * @param {number} now
 */
export function driftDue(last, desiredSha, now) {
  if (!last) return true;
  if ((last.desired_sha ?? null) !== (desiredSha ?? null)) return true;
  return now - Number(last.checked) >= DRIFT_EVERY_MS;
}

/**
 * The last comparison as the API shows it. `count` is null when the comparison failed before the provider answered;
 * `plan` is the open plan that covers the drift, and `planMatches` false when that plan no longer matches what
 * differs (the owner rejects it, and the next comparison makes a new one).
 * @param {Record<string, any>} row
 */
export function driftView(row) {
  return {
    checked: new Date(Number(row.checked)).toISOString(),
    desiredSha: row.desired_sha ?? null,
    count: row.count === null || row.count === undefined ? null : Number(row.count),
    resources: row.resources ? JSON.parse(row.resources) : [],
    plan: row.plan ? `plan-${Number(row.plan)}` : null,
    planMatches: Boolean(row.plan) && Boolean(row.plan_matches),
    error: row.error ?? null,
  };
}
