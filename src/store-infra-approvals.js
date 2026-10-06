/**
 * TaskStore's approvals (docs/specs/IDEA-19-architect.md, "Approvals"; BRK-182): agents propose, the owner approves.
 *
 * Approve and reject are the owner's alone, from the signed-in board: the worker refuses the bearer token agents and
 * the CLI hold (like Merge), and an agent's `by` is refused here as a second line. Approve takes only a plan that
 * waits for the owner and is still up to date: one whose desired state hasn't moved to a new commit since it was
 * planned, and, for a drift plan, one that still matches the drift. An out-of-date plan is refused with words saying
 * to reject it, so a fresh plan is drafted; the board never rejects a plan by itself. Approving keeps the plan's digest
 * (planDigest() in src/infra-runner.js), which the apply runner's reports must carry (BRK-183).
 *
 * A plan that starts waiting for the owner sends one push, linking to it. A plan the repository's policy lets through
 * (BRK-181) is approved by the board when it's made, with the rule that let it through in the audit trail; the
 * default policy lets nothing through. Every move writes its audit entry through moveInfraPlan (store-infra-plans.js).
 */
import { AgentError } from './store-agents.js';
import { planDigest } from './infra-runner.js';
import { planId } from './infra-plans.js';
import { planMessage } from './push.js';
import { redact } from './redact.js';
import { install } from './install.js';

/** The most a rejection's reason keeps, in the audit trail. */
export const REASON_MAX = 300;

/** Whether `by` is the owner's: none, or `owner`. Anything else is an agent's name, and is refused. */
const owners = (by) => by === undefined || by === null || by === '' || by === 'owner';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraApprovalsMethods = {
  initInfraApprovals() {
    // The digest of the diff the owner (or the policy) approved, and when: the executor applies only that diff.
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_plans)')
        .toArray()
        .map((c) => c.name),
    );
    if (!have.has('digest')) this.sql.exec('ALTER TABLE infra_plans ADD COLUMN digest TEXT');
    if (!have.has('approved')) this.sql.exec('ALTER TABLE infra_plans ADD COLUMN approved INTEGER');
  },

  /**
   * Why a plan can't be approved any more, or null while it's up to date: its environment's desired state has moved to
   * another commit since it was planned, or it's a drift plan that no longer matches the drift.
   * @param {Record<string, any>} row the plan's row (planRow)
   */
  outOfDatePlan(row) {
    if (row.desired_sha) {
      const now = this.sql
        .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', row.repo, row.env_name)
        .toArray()[0]?.valid_sha;
      if (now !== row.desired_sha)
        return now
          ? `${row.env_name}’s desired state moved from ${String(row.desired_sha).slice(0, 7)} to ${String(now).slice(0, 7)} since it was planned`
          : `${row.env_name} has no valid desired state now`;
    }
    if (row.source === 'drift') {
      const drift = this.sql
        .exec('SELECT plan_matches FROM infra_drift WHERE environment = ? AND plan = ?', row.environment, row.n)
        .toArray()[0];
      if (drift && !drift.plan_matches) return `${row.env_name}’s drift has changed since it was planned`;
    }
    return null;
  },

  /**
   * Moves a plan to approved with the digest of its diff, refusing one that's out of date. The owner's press, or the
   * board's when the repository's policy lets the plan through.
   * @param {string} ref the plan's ID
   * @param {{ by: 'owner' | 'board', summary?: string }} input
   */
  async approveInfraPlan(ref, { by, summary = '' }) {
    // A plan's diff never changes, so its digest comes first; from here on nothing awaits, so the checks hold.
    const digest = await planDigest(JSON.parse(this.planRow(ref).diff));
    const row = this.planRow(ref);
    const id = planId(Number(row.n));
    if (row.state !== 'waiting')
      throw new AgentError(
        `${id} is ${row.state}: only a plan that waits for you can be approved${row.state === 'draft' ? '; put it in front of you first' : ''}`,
        409,
      );
    const stale = this.outOfDatePlan(row);
    if (stale)
      throw new AgentError(
        `${id} is out of date: ${stale}. Reject it, and the next plan is drafted from what’s there now.`,
        409,
      );
    return this.moveInfraPlan(id, 'approved', {
      by,
      summary: summary || `approved by the owner; digest ${digest.slice(0, 12)}`,
      digest,
    });
  },

  /**
   * Moves a plan to waiting for the owner, then sends one push linking to it. The one path that puts a plan in front of
   * the owner: the owner's own press (PATCH /api/infra/plans/<id>), or the board's (a pull request's plan, an envelope
   * outside its bounds).
   * @param {string} ref the plan's ID
   * @param {{ by: 'owner' | 'board', summary?: string }} input
   */
  async waitForOwner(ref, { by, summary = '' }) {
    const plan = this.moveInfraPlan(ref, 'waiting', { by, summary });
    await this.pushInfraPlan(plan);
    return plan;
  },

  /**
   * After a plan is made: one the repository's policy lets through is approved by the board, the rule that did in the
   * audit trail. Any other stays as it was made.
   * @param {ReturnType<typeof import('./infra-plans.js').planView>} plan
   */
  async settleInfraPlan(plan) {
    if (plan.policy?.outcome !== 'allowed') return plan;
    const rule = `your policy’s rule “${plan.policy.rule}”`;
    this.moveInfraPlan(plan.id, 'waiting', { by: 'board', summary: `${rule} lets it through` });
    return this.approveInfraPlan(plan.id, { by: 'board', summary: `approved by ${rule}` });
  },

  /** Sends a waiting plan's push to every subscribed browser. Never throws: the plan and its audit entry are the record. */
  async pushInfraPlan(plan) {
    try {
      const reason = plan.policy?.reasons?.[0] ?? `${plan.changes} change${plan.changes === 1 ? '' : 's'}`;
      await this.pushToOwner(planMessage({ ...plan, reason }, install(this.env).name));
    } catch {
      /* push is a convenience */
    }
  },

  /** POST /api/infra/plans/<id>/approve: the owner's, from the signed-in board only. */
  planApproveApi(ref, body = {}) {
    return this.run(async () => {
      if (!owners(body.by)) throw new AgentError('only the owner approves a plan, from the board', 403);
      return { status: 200, body: { plan: await this.approveInfraPlan(ref, { by: 'owner' }) } };
    });
  },

  /** POST /api/infra/plans/<id>/reject: the owner's, from the signed-in board only, with an optional reason. */
  planRejectApi(ref, body = {}) {
    return this.run(async () => {
      if (!owners(body.by)) throw new AgentError('only the owner rejects a plan, from the board', 403);
      const reason = redact(String(body.reason ?? ''))
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, REASON_MAX);
      const plan = this.moveInfraPlan(ref, 'rejected', {
        by: 'owner',
        summary: reason ? `rejected by the owner: ${reason}` : 'rejected by the owner; nothing changes',
      });
      return { status: 200, body: { plan } };
    });
  },
};
