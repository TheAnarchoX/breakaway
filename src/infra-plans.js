/**
 * Architect's plans, the pure part (docs/specs/IDEA-19-architect.md, "Plans"; BRK-178): the exact difference an apply
 * would make, reviewed like a pull request. A plan holds the provider's diff, what it changes the environment's monthly
 * cost by, its blast radius (what leans on what it changes, from the inventory's relations), whether it can be undone
 * or why not, and a state. The store (store-infra-plans.js) makes and keeps them and writes the audit trail on every
 * state change. Policy (BRK-181, infra-policy.js) is checked when a plan is made and kept on it; approval (BRK-182)
 * and the executor (BRK-183) build on them.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */
import { InputError } from './model.js';
import { redact } from './redact.js';
import { redactAttrs } from './infra-inventory.js';

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */
/** @typedef {import('./infra-provider.js').Change} Change */
/** @typedef {import('./infra-provider.js').Relation} Relation */

/** A plan's states, in the order a plan that goes all the way passes them. */
export const PLAN_STATES = ['draft', 'waiting', 'approved', 'rejected', 'applying', 'applied', 'failed', 'rolled back'];

/**
 * Where a plan comes from: a pull request that changed a desired-state file (BRK-185), drift (BRK-184), an envelope
 * acting (BRK-186), an incident's runbook (BRK-197), the deploy flow's Promote and Roll back (BRK-195), removing what
 * nobody owns once its grace period is over (BRK-201), or a task's short-lived environment being made or removed (BRK-200).
 */
export const PLAN_SOURCES = ['pull-request', 'drift', 'envelope', 'incident', 'deploy', 'cleanup', 'short-lived'];

/**
 * Which states a plan may move to from each. A draft waits for the owner or is dropped; only an approved plan is
 * applied, and one that hasn't started applying can still be rejected; an apply ends applied or failed, and either can
 * be rolled back. A failed plan goes back to approved only through the owner's Start the run again, for a run that
 * applied nothing (BRK-308, store-infra-runs.js). Rejected and rolled back are the end.
 * @type {Record<string, string[]>}
 */
export const PLAN_MOVES = {
  draft: ['waiting', 'rejected'],
  waiting: ['approved', 'rejected'],
  approved: ['applying', 'rejected'],
  rejected: [],
  applying: ['applied', 'failed'],
  applied: ['rolled back'],
  failed: ['rolled back', 'approved'],
  'rolled back': [],
};

/** The audit trail's kind (infra-audit.js) for the entry each state writes. */
export const PLAN_AUDIT_KINDS = {
  draft: 'plan',
  waiting: 'plan',
  approved: 'approve',
  rejected: 'reject',
  applying: 'apply',
  applied: 'apply',
  failed: 'apply',
  'rolled back': 'rollback',
};

/** A plan's ID, as the apply runner takes it (src/infra-runner.js): `plan-<n>`. */
export const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** @param {number} n */
export const planId = (n) => `plan-${n}`;

/** The most changes one plan carries: an environment holds at most this many resources (infra-inventory.js). */
export const MAX_PLAN_CHANGES = 1000;
/** The most a stored diff takes, well inside a Durable Object's row. */
export const MAX_PLAN_BYTES = 512 * 1024;

const SOURCE_REF = /^[\w.:#/-]{1,100}$/u;

/**
 * The plan's number from its ID (`plan-12`, or `12`), or null when it isn't one.
 * @param {unknown} ref
 */
export function planNumber(ref) {
  const m = /^(?:plan-)?(\d{1,15})$/u.exec(String(ref ?? '').trim());
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Where a plan comes from, checked: one of PLAN_SOURCES and, optionally, what it points at there (a pull request's
 * number, an incident's work ID, a deploy's version).
 * @param {unknown} source
 * @param {unknown} ref
 * @returns {{ source: string, ref: string | null }}
 */
export function checkSource(source, ref) {
  const kind = String(source ?? '').trim();
  if (!PLAN_SOURCES.includes(kind)) throw new InputError(`source must be one of ${PLAN_SOURCES.join(', ')}`);
  if (ref === undefined || ref === null || ref === '') return { source: kind, ref: null };
  const at = String(ref).trim();
  if (!SOURCE_REF.test(at))
    throw new InputError('the source’s ref is up to 100 letters, digits, and . : # / - _, like #42 or BRK-12');
  return { source: kind, ref: redact(at) };
}

/**
 * Whether a plan in state `from` may move to `to`, or an InputError saying why not.
 * @param {string} from
 * @param {string} to
 */
export function checkMove(from, to) {
  if (!PLAN_STATES.includes(to)) throw new InputError(`state must be one of ${PLAN_STATES.join(', ')}`);
  if (!PLAN_MOVES[from]?.includes(to)) {
    const next = PLAN_MOVES[from] ?? [];
    throw new InputError(
      `a plan that is ${from} can’t become ${to}${next.length ? `: it can become ${next.join(' or ')}` : ''}`,
    );
  }
}

/**
 * The diff as it is kept: settings redacted the way the inventory keeps them (a provider never sends a secret's value;
 * this is the second line), so ordinary settings are kept exactly and the runner applies what was approved.
 * @param {PlanDiff} diff
 * @returns {PlanDiff}
 */
export function keptDiff(diff) {
  return {
    provider: diff.provider,
    environment: diff.environment,
    changes: diff.changes.map((c) => ({
      op: c.op,
      resource: c.resource,
      kind: c.kind,
      name: redact(c.name),
      before: /** @type {Record<string, unknown> | null} */ (c.before === null ? null : redactAttrs(c.before)),
      after: /** @type {Record<string, unknown> | null} */ (c.after === null ? null : redactAttrs(c.after)),
      reversible: c.reversible,
      ...(c.reversible ? {} : { why: redact(String(c.why ?? '')) }),
    })),
    reversible: diff.reversible,
  };
}

/**
 * Whether the plan can be undone, and for each change that can't, why.
 * @param {PlanDiff} diff
 * @returns {{ reversible: boolean, irreversible: Array<{ resource: string, name: string, op: string, why: string }> }}
 */
export function reversibility(diff) {
  const irreversible = diff.changes
    .filter((c) => !c.reversible)
    .map((c) => ({ resource: c.resource, name: c.name, op: c.op, why: String(c.why ?? '') }));
  return { reversible: irreversible.length === 0, irreversible };
}

/**
 * @typedef {{ amount: number, currency: string }} Amount
 * @typedef {object} CostChange
 * @property {string | null} currency the provider's; the board converts it to its own (infra-currency.js, BRK-226)
 * @property {number | null} now the environment's estimated monthly cost before the plan
 * @property {number | null} delta what the plan changes it by, over the changes whose cost is known
 * @property {number | null} after `now` plus `delta`
 * @property {boolean} complete every change's cost is known; when not, `unknown` names the ones that aren't
 * @property {string[]} unknown the resources whose cost after the change isn't known
 * @property {Array<{ resource: string, before: number | null, after: number | null }>} changes
 * @property {true} perMonth
 * @property {true} estimate
 */

const round = (n) => Math.round(n * 100) / 100;

/**
 * What the plan changes the environment's monthly cost by, always an estimate. `costs` is each resource's cost now
 * (from the provider, or the inventory's last); `estimates` is the provider's estimate of a resource's cost once its
 * change is applied, where it gave one. A deleted resource costs nothing after, and a restart costs what it did; a
 * created, updated, or scaled resource without an estimate is unknown, and the plan says so rather than guessing.
 * @param {PlanDiff} diff
 * @param {Map<string, Amount>} costs
 * @param {Map<string, Amount>} [estimates]
 * @returns {CostChange}
 */
export function costChange(diff, costs, estimates = new Map()) {
  const currency = [...costs.values(), ...estimates.values()][0]?.currency ?? null;
  const inCurrency = (/** @type {Amount | undefined} */ a) => (a && a.currency === currency ? a.amount : null);
  let total = 0;
  let priced = false;
  for (const c of costs.values())
    if (c.currency === currency) {
      total += c.amount;
      priced = true;
    }
  let delta = 0;
  /** @type {string[]} */
  const unknown = [];
  const changes = diff.changes.map((c) => {
    const before = c.op === 'create' ? 0 : inCurrency(costs.get(c.resource));
    let after;
    if (c.op === 'delete') after = 0;
    else if (c.op === 'restart') after = before;
    else after = inCurrency(estimates.get(c.resource));
    if (before === null || after === null) unknown.push(c.resource);
    else delta += after - before;
    return { resource: c.resource, before, after };
  });
  const known = diff.changes.length > unknown.length;
  return {
    currency,
    now: priced ? round(total) : null,
    delta: currency && (known || diff.changes.length === 0) ? round(delta) : null,
    after: priced && currency && known ? round(total + delta) : null,
    complete: unknown.length === 0 && currency !== null,
    unknown,
    changes,
    perMonth: true,
    estimate: true,
  };
}

/**
 * @typedef {object} BlastRadius
 * @property {Array<{ id: string, kind: string | null, name: string | null, changed: boolean, depth: number, leansOn: { id: string, relation: string } | null }>} resources
 *   what the plan changes (depth 0), then what leans on those, nearest first
 * @property {number} changed
 * @property {number} affected what leans on a change, directly or through others
 * @property {Array<{ resource: string, name: string, by: string[] }>} deletesInUse deleted resources something still
 *   leans on
 * @property {string | null} seen when the inventory the relations came from was read, or null when it has none
 */

/**
 * What a plan reaches: the resources it changes and everything that leans on them, following the inventory's relations
 * backwards (a relation's `from` leans on its `to`: this service uses that database, so changing the database reaches
 * the service). A deleted resource something still leans on is named on its own.
 * @param {PlanDiff} diff
 * @param {{ resources: Array<{ id: string, kind: string, name: string }>, relations: Relation[], seen?: string | null }} inventory
 * @returns {BlastRadius}
 */
export function blastRadius(diff, inventory) {
  const known = new Map(inventory.resources.map((r) => [r.id, r]));
  /** @type {Map<string, Relation[]>} */
  const leaning = new Map();
  for (const rel of inventory.relations) leaning.set(rel.to, [...(leaning.get(rel.to) ?? []), rel]);
  /** @type {BlastRadius['resources']} */
  const resources = [];
  const seen = new Set();
  for (const c of diff.changes) {
    if (seen.has(c.resource)) continue;
    seen.add(c.resource);
    resources.push({ id: c.resource, kind: c.kind, name: c.name, changed: true, depth: 0, leansOn: null });
  }
  const changed = resources.length;
  for (let i = 0; i < resources.length; i++) {
    const at = resources[i];
    for (const rel of leaning.get(at.id) ?? []) {
      if (seen.has(rel.from)) continue;
      seen.add(rel.from);
      const r = known.get(rel.from);
      resources.push({
        id: rel.from,
        kind: r?.kind ?? null,
        name: r?.name ?? null,
        changed: false,
        depth: at.depth + 1,
        leansOn: { id: at.id, relation: rel.kind },
      });
    }
  }
  const deleted = new Set(diff.changes.filter((c) => c.op === 'delete').map((c) => c.resource));
  const deletesInUse = diff.changes
    .filter((c) => c.op === 'delete')
    .map((c) => ({
      resource: c.resource,
      name: c.name,
      by: [...new Set((leaning.get(c.resource) ?? []).map((rel) => rel.from))].filter((id) => !deleted.has(id)),
    }))
    .filter((d) => d.by.length > 0);
  return {
    resources,
    changed,
    affected: resources.length - changed,
    deletesInUse,
    seen: inventory.seen ?? null,
  };
}

/**
 * A plan's row as the API shows it. The summary (`full` false) leaves out the diff's settings and the blast radius's
 * list, for the list of plans. `environment.removed` is true when the plan's environment was removed (BRK-265).
 * @param {Record<string, any>} row
 * @param {{ full?: boolean }} [options]
 */
export function planView(row, { full = true } = {}) {
  const diff = JSON.parse(row.diff);
  const blast = JSON.parse(row.blast);
  const undo = reversibility(diff);
  const at = (/** @type {number | null} */ ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  return {
    id: planId(Number(row.n)),
    repo: row.repo,
    environment: { id: Number(row.environment), name: row.env_name, ...(row.env_gone ? { removed: true } : {}) },
    provider: row.provider,
    target: row.target ?? null,
    desiredSha: row.desired_sha ?? null,
    source: { kind: row.source, ref: row.ref ?? null },
    state: row.state,
    changes: diff.changes.length,
    ...(full ? { diff } : {}),
    cost: JSON.parse(row.cost),
    blastRadius: full ? blast : { changed: blast.changed, affected: blast.affected, deletesInUse: blast.deletesInUse },
    reversible: undo.reversible,
    irreversible: undo.irreversible,
    policy: row.policy ? JSON.parse(row.policy) : null,
    digest: row.digest ?? null,
    approved: at(row.approved),
    by: row.by,
    agent: row.agent ?? null,
    created: at(row.created),
    updated: at(row.updated),
  };
}
