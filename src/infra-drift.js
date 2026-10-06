/**
 * Architect's drift, the pure part (docs/specs/IDEA-19-architect.md, "Drift"; BRK-184): the difference between what an
 * environment's desired state says and what its provider sees running. The board compares the two on the cron, shows
 * what differs on the environment, and makes one draft plan (source `drift`) the owner can put in front of themselves
 * or turn into a task. It never applies one by itself. The store (store-infra-drift.js) keeps the last comparison.
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
  const lines = diff.changes
    .map((c) =>
      canonical({ op: c.op, resource: c.resource, kind: c.kind, name: c.name, before: c.before, after: c.after }),
    )
    .sort();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n')));
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
