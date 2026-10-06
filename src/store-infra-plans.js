/**
 * TaskStore's plans (docs/specs/IDEA-19-architect.md, "Plans"; BRK-178): the exact change an apply would make, with
 * its cost change, blast radius, and whether it can be undone, kept for the owner to review like a pull request.
 *
 * The board makes every plan itself: from the environment's desired state (BRK-180) and its provider's `plan`, never
 * from a diff a caller sends, so what the owner approves is what the provider said. A plan keeps the environment as it
 * was planned for (its provider, target, and the desired state's commit), so the executor (BRK-183) applies against
 * what was approved, not the live row. Every state change appends to the audit trail (BRK-175) in the same
 * transaction: a change that can't be recorded doesn't happen.
 *
 * Anyone signed in reads plans, and an agent may propose one (a draft); a draft waits for the owner only by the owner's
 * hand, from the signed-in board, or the board's own. Approve and reject are store-infra-approvals.js's (BRK-182), and
 * applying is the executor's: `moveInfraPlan` is the one path that changes a plan's state, for them to call. The plan's
 * hash is `planDigest(diff)` (src/infra-runner.js), stored on approval.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { redact } from './redact.js';
import { runsTheBoard } from './infra-environments.js';
import { checkCosts, checkDesired, checkPlan } from './infra-provider.js';
import { costChangeInCurrency } from './infra-currency.js';
import {
  MAX_PLAN_BYTES,
  MAX_PLAN_CHANGES,
  PLAN_AUDIT_KINDS,
  PLAN_STATES,
  blastRadius,
  checkMove,
  checkSource,
  costChange,
  keptDiff,
  planId,
  planNumber,
  planView,
} from './infra-plans.js';

/** @typedef {import('./infra-provider.js').DesiredState} DesiredState */

const SHOWN = 50;
const SHOWN_MAX = 200;
const SELECT = 'SELECT p.*, e.name AS env_name FROM infra_plans p JOIN infra_environments e ON e.id = p.environment';

/** The moves a frozen environment refuses: rejecting a plan, finishing an apply, and rolling back still go. */
const FORWARD = ['waiting', 'approved', 'applying'];

/** Why a frozen environment refuses a plan, in words. */
const frozen = (env) => `${env.name} is frozen: nothing changes there until the owner unfreezes it, on the board`;

/** The policy's result for the audit trail: what it decided, and the rule that did. */
const policySummary = (p) =>
  p.outcome === 'allowed' ? `policy allows it by “${p.rule}”` : `policy: needs the owner (${p.rule})`;

/** Who acts on a plan, from the API's `by`: none, or `owner`, is the owner; anything else is an agent's name. */
function actor(by) {
  return by === undefined || by === null || by === '' || by === 'owner'
    ? { by: 'owner', agent: null }
    : { by: 'agent', agent: String(by) };
}

/** A call to the provider that may fail without failing the plan: the plan says what it couldn't learn. */
async function tryCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** A whole number from a query string, or an AgentError naming it. */
function whole(value, what, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AgentError(`${what} must be a whole number from ${min} to ${max}`, 400);
  return n;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraPlansMethods = {
  initInfraPlans() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_plans (
        n INTEGER PRIMARY KEY AUTOINCREMENT, environment INTEGER NOT NULL, repo TEXT NOT NULL,
        provider TEXT NOT NULL, target TEXT, desired_sha TEXT,
        source TEXT NOT NULL, ref TEXT, state TEXT NOT NULL,
        diff TEXT NOT NULL, cost TEXT NOT NULL, blast TEXT NOT NULL, reversible INTEGER NOT NULL,
        by TEXT NOT NULL, agent TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_plans_by_environment ON infra_plans (environment, state, n);
      CREATE INDEX IF NOT EXISTS infra_plans_by_repo ON infra_plans (repo, n);
    `);
    // The policy's result (BRK-181), on a store from before it was kept.
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_plans)')
        .toArray()
        .map((c) => c.name),
    );
    if (!have.has('policy')) this.sql.exec('ALTER TABLE infra_plans ADD COLUMN policy TEXT');
  },

  /** A plan's row with its environment's name, by its ID (`plan-12`), or a 404. */
  planRow(ref) {
    const n = planNumber(ref);
    const row = n ? this.sql.exec(`${SELECT} WHERE p.n = ?`, n).toArray()[0] : null;
    if (!row) throw new AgentError(`no plan ${String(ref ?? '').slice(0, 40)}`, 404);
    return row;
  },

  /** The newest plan waiting for the owner on an environment, by its ID, or null: the environment's view shows it. */
  waitingInfraPlan(environmentId) {
    const row = this.sql
      .exec(
        "SELECT n FROM infra_plans WHERE environment = ? AND state = 'waiting' ORDER BY n DESC LIMIT 1",
        environmentId,
      )
      .toArray()[0];
    return row ? planId(Number(row.n)) : null;
  },

  /** The inventory's slice for an environment: its resources, their last cost, and their relations. */
  planInventory(environmentId) {
    const resources = this.sql
      .exec('SELECT rid, kind, name, cost, currency, seen FROM infra_inventory WHERE environment = ?', environmentId)
      .toArray();
    const relations = this.sql
      .exec('SELECT from_rid, to_rid, kind FROM infra_inventory_relations WHERE environment = ?', environmentId)
      .toArray()
      .map((r) => ({ from: r.from_rid, to: r.to_rid, kind: r.kind }));
    const seen = resources.reduce((m, r) => Math.max(m, Number(r.seen)), 0);
    return {
      resources: resources.map((r) => ({ id: r.rid, kind: r.kind, name: r.name })),
      relations,
      costs: new Map(
        resources
          .filter((r) => r.cost !== null && r.cost !== undefined && r.currency)
          .map((r) => [r.rid, { amount: Number(r.cost), currency: r.currency }]),
      ),
      seen: seen ? new Date(seen).toISOString() : null,
    };
  },

  /**
   * What a plan for an environment would hold, kept nowhere: its provider's diff from `wanted`, its cost change, and
   * its blast radius from the inventory. makeInfraPlan keeps it; `infra check`'s preview (store-infra-check.js) only
   * shows it. Refused on an environment with no provider, or one whose provider isn't connected. With nothing to
   * change, the diff is empty and there's no cost or blast radius.
   * @param {Record<string, any>} env the environment's row
   * @param {DesiredState} wanted
   */
  async computeInfraPlan(env, wanted) {
    if (!env.provider) throw new AgentError(`${env.name} has no provider: the owner picks one on the board first`, 409);
    const registry = this.infraRegistry();
    if (!registry.has(env.provider))
      throw new AgentError(`${env.provider} isn’t connected, so ${env.name} can’t be planned`, 409);
    const provider = registry.get(env.provider);
    const ctx = {
      environment: env.name,
      scope: { target: env.target },
      observeOnly: false,
      token: (await this.providerReadToken(env.provider)) ?? undefined,
    };
    let diff;
    try {
      diff = checkPlan(provider, await provider.plan(ctx, checkDesired(provider, wanted)), ctx);
    } catch (error) {
      throw new AgentError(
        `${provider.name} couldn’t plan ${env.repo}’s ${env.name}: ${redact(error?.message ?? error)}. Nothing was kept; try again once the provider answers.`,
        502,
      );
    }
    if (diff.changes.length === 0) return { provider, stored: keptDiff(diff), cost: null, blast: null };
    if (diff.changes.length > MAX_PLAN_CHANGES)
      throw new AgentError(
        `the plan for ${env.name} has ${diff.changes.length} changes, more than ${MAX_PLAN_CHANGES}: split the desired state`,
        409,
      );
    const stored = keptDiff(diff);
    const text = JSON.stringify(stored);
    if (text.length > MAX_PLAN_BYTES)
      throw new AgentError(
        `the plan for ${env.name} is over ${MAX_PLAN_BYTES / 1024} KB: split the desired state`,
        409,
      );

    const inventory = this.planInventory(env.id);
    const live = await tryCall(async () => checkCosts(provider, await provider.cost(ctx)));
    const costs = live
      ? new Map(live.map((c) => [c.resource, { amount: c.amount, currency: c.currency }]))
      : inventory.costs;
    /** @type {Map<string, { amount: number, currency: string }>} */
    const estimates = new Map();
    if (typeof provider.estimate === 'function')
      for (const c of diff.changes) {
        if (!['create', 'update', 'scale'].includes(c.op)) continue;
        const e = await tryCall(async () => {
          const got = await provider.estimate(ctx, c);
          return got ? checkCosts(provider, [got])[0] : null;
        });
        if (e) estimates.set(c.resource, { amount: e.amount, currency: e.currency });
      }
    // In the board's currency, with its rate (BRK-226): the policy's limits are in it, and the plan keeps what it was checked with.
    const cost = costChangeInCurrency(costChange(stored, costs, estimates), this.infraCurrency());
    const blast = blastRadius(stored, inventory);
    return { provider, stored, cost, blast };
  },

  /**
   * Makes a draft plan for an environment: asks its provider for the diff from the environment's desired state (or
   * `desired`, for the board's own callers, like an envelope's scale), prices it, measures its blast radius from the
   * inventory, and keeps it with an audit entry. Refused on an observe-only environment, one with no provider or no
   * desired state, and when nothing would change.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null, source: string, sourceRef?: string | null, by: 'owner' | 'board' | 'agent',
   *   agent?: string | null, desired?: DesiredState }} input
   */
  async makeInfraPlan(
    ref,
    { repo = null, source, sourceRef = null, by, agent = null, desired } = /** @type {any} */ ({}),
  ) {
    const from = checkSource(source, sourceRef);
    const env = this.environmentRow(ref, repo);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      throw new AgentError(`${env.name} is observe only: Architect watches it and never plans changes to it`, 409);
    if (env.frozen) throw new AgentError(frozen(env), 409);
    const kept = this.sql
      .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
      .toArray()[0];
    const wanted = desired ?? this.desiredStateFor(env);
    if (!wanted)
      throw new AgentError(
        `${env.name} has no desired state yet: add .github/breakaway-infra/${env.name}.json to ${env.repo}’s default branch`,
        409,
      );
    const { provider, stored, cost, blast } = await this.computeInfraPlan(env, wanted);
    if (stored.changes.length === 0)
      throw new AgentError(`${env.name} already matches its desired state: there’s nothing to plan`, 409);
    const text = JSON.stringify(stored);
    const policy = this.checkInfraPolicy(env, { diff: stored, cost, provider });
    const now = Date.now();
    let n;
    this.ctx.storage.transactionSync(() => {
      n = Number(
        this.sql
          .exec(
            `INSERT INTO infra_plans (environment, repo, provider, target, desired_sha, source, ref, state, diff, cost, blast, reversible, policy, by, agent, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n`,
            env.id,
            env.repo,
            env.provider,
            env.target ?? null,
            desired ? null : (kept?.valid_sha ?? null),
            from.source,
            from.ref,
            text,
            JSON.stringify(cost),
            JSON.stringify(blast),
            stored.reversible ? 1 : 0,
            JSON.stringify(policy),
            by,
            agent,
            now,
            now,
          )
          .toArray()[0].n,
      );
      this.appendInfraAudit({
        kind: PLAN_AUDIT_KINDS.draft,
        repo: env.repo,
        environment: env.name,
        environmentId: env.id,
        plan: planId(n),
        by,
        agent,
        outcome: 'draft',
        summary: `${stored.changes.length} change${stored.changes.length === 1 ? '' : 's'} from ${from.source}${from.ref ? ` ${from.ref}` : ''}${stored.reversible ? '' : ', not all reversible'}; ${policySummary(policy)}`,
      });
    });
    // A plan the repository's policy lets through is approved by the board (BRK-182, store-infra-approvals.js).
    return this.settleInfraPlan(planView(this.planRow(n)));
  },

  /**
   * Moves a plan to another state (infra-plans.js's PLAN_MOVES), with its audit entry in the same transaction: the
   * one path every later piece (approve, reject, the executor) changes a plan through.
   * @param {string} ref the plan's ID
   * @param {string} to
   * `digest`, on a move to approved, is planDigest() of the plan's diff (store-infra-approvals.js), kept with the time.
   * @param {{ by: 'owner' | 'board' | 'executor' | 'envelope' | 'agent', agent?: string | null, outcome?: string, summary?: string, digest?: string }} input
   */
  moveInfraPlan(ref, to, { by, agent = null, outcome, summary = '', digest } = /** @type {any} */ ({})) {
    let row;
    this.ctx.storage.transactionSync(() => {
      row = this.planRow(ref);
      try {
        checkMove(row.state, to);
      } catch (error) {
        throw new AgentError(`${planId(Number(row.n))}: ${error.message}`, 409);
      }
      // A frozen environment refuses every plan: none waits, is approved, or starts applying until it's unfrozen.
      if (FORWARD.includes(to)) {
        const env = this.sql
          .exec('SELECT name, frozen FROM infra_environments WHERE id = ?', row.environment)
          .toArray()[0];
        if (env?.frozen) throw new AgentError(`${planId(Number(row.n))} can’t become ${to}: ${frozen(env)}`, 409);
      }
      if (to === 'approved' && !digest)
        throw new AgentError(`${planId(Number(row.n))} is approved with its digest`, 500);
      const now = Date.now();
      if (to === 'approved')
        this.sql.exec(
          'UPDATE infra_plans SET state = ?, updated = ?, digest = ?, approved = ? WHERE n = ?',
          to,
          now,
          digest,
          now,
          row.n,
        );
      else this.sql.exec('UPDATE infra_plans SET state = ?, updated = ? WHERE n = ?', to, now, row.n);
      this.appendInfraAudit({
        kind: PLAN_AUDIT_KINDS[to],
        repo: row.repo,
        environment: row.env_name,
        environmentId: Number(row.environment),
        plan: planId(Number(row.n)),
        by,
        agent,
        outcome: outcome ?? to,
        summary: summary || `${row.state} → ${to}`,
      });
    });
    return planView(this.planRow(ref));
  },

  /**
   * GET /api/infra/plans: plans newest first, as summaries, filtered by repository, environment (its ID or name), and
   * state, paged with `before` (a plan's ID).
   */
  plansApi(query = {}) {
    return this.run(async () => {
      const where = [];
      const args = [];
      const repo = query.repo ? String(query.repo).trim().toLowerCase() : null;
      if (repo) {
        where.push('p.repo = ?');
        args.push(repo);
      }
      if (query.environment) {
        where.push('p.environment = ?');
        args.push(this.environmentRow(query.environment, repo).id);
      }
      if (query.state) {
        if (!PLAN_STATES.includes(String(query.state)))
          throw new AgentError(`state must be one of ${PLAN_STATES.join(', ')}`, 400);
        where.push('p.state = ?');
        args.push(String(query.state));
      }
      if (query.before) {
        const before = planNumber(query.before);
        if (!before) throw new AgentError('before must be a plan’s ID', 400);
        where.push('p.n < ?');
        args.push(before);
      }
      const limit = whole(query.limit, 'limit', 1, SHOWN_MAX) ?? SHOWN;
      const rows = this.sql
        .exec(
          `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.n DESC LIMIT ?`,
          ...args,
          limit + 1,
        )
        .toArray();
      return {
        status: 200,
        body: { plans: rows.slice(0, limit).map((row) => planView(row, { full: false })), more: rows.length > limit },
      };
    });
  },

  /** GET /api/infra/plans/<id>: one plan, with its diff and blast radius, and `outOfDate`: why an open plan can no longer be approved, or null. */
  planApi(ref) {
    return this.run(async () => {
      const row = this.planRow(ref);
      // Why an open plan can't be approved any more (store-infra-approvals.js), so the plan page says so up front.
      const outOfDate = ['draft', 'waiting'].includes(row.state) ? this.outOfDatePlan(row) : null;
      return { status: 200, body: { plan: planView(row), outOfDate } };
    });
  },

  /**
   * POST /api/infra/plans: make a draft plan for an environment from its desired state. The body names the
   * environment, the source, and what it points at; the board computes the rest, and never reads a diff from it.
   * The owner and agents may; an agent's draft names it.
   */
  plansCreateApi(body = {}) {
    return this.run(async () => {
      const who = actor(body.by);
      const plan = await this.makeInfraPlan(body.environment, {
        repo: body.repo ? String(body.repo).trim().toLowerCase() : null,
        source: body.source,
        sourceRef: body.ref,
        ...who,
      });
      return { status: 201, body: { plan } };
    });
  },

  /**
   * PATCH /api/infra/plans/<id>: `{ state: 'waiting' }` puts a draft in front of the owner. The owner's, from the
   * signed-in browser only (the worker refuses the bearer token); an agent's `by` is refused too. It sends one push,
   * unless `quiet`: the plan page approving a draft the owner is reading needs none. Approve and reject are their own
   * routes (store-infra-approvals.js).
   */
  planModifyApi(ref, body = {}) {
    return this.run(async () => {
      const who = actor(body.by);
      if (who.by !== 'owner')
        throw new AgentError('only the owner puts a plan in front of the owner; agents make drafts', 403);
      if (body.state !== 'waiting')
        throw new AgentError(
          'a plan’s state changes here only to waiting; approve and reject it at /approve and /reject',
          400,
        );
      return { status: 200, body: { plan: await this.waitForOwner(ref, { by: 'owner', quiet: body.quiet === true }) } };
    });
  },
};
