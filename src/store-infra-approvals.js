/**
 * TaskStore's approvals (docs/specs/IDEA-19-architect.md, "Approvals"; BRK-182): agents propose, the owner approves.
 *
 * Approve and reject are the owner's alone, from the signed-in board: the worker refuses the bearer token agents and
 * the CLI hold (like Merge), and an agent's `by` is refused here as a second line. Approve takes only a plan that
 * waits for the owner and is still up to date: one whose desired state hasn't moved to a new commit since it was
 * planned, and, for a drift plan, one that still matches the drift. An out-of-date plan is refused with words saying
 * to reject it, so a fresh plan is drafted; the board never rejects a plan by itself. Approving keeps the plan's digest
 * (planDigest() in src/infra-runner.js), which the apply runner's reports must carry, and queues the plan for the
 * executor (BRK-183, store-infra-runs.js); rejecting takes an approved plan that hasn't started applying off it.
 *
 * A plan that starts waiting for the owner sends one push, linking to it. A plan the repository's policy lets through
 * (BRK-181) is approved by the board when it's made, with the rule that let it through in the audit trail; the
 * default policy lets nothing through. Every move writes its audit entry through moveInfraPlan (store-infra-plans.js).
 */
import { AgentError } from './store-agents.js';
import { planDigest } from './infra-runner.js';
import { planId, planView } from './infra-plans.js';
import { planMessage } from './push.js';
import { redact } from './redact.js';
import { install } from './install.js';
import { personWords } from './store-permissions.js';
import { OWNER } from './permissions.js';

/** The most a rejection's reason keeps, in the audit trail. */
export const REASON_MAX = 300;

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
   * another commit since it was planned, it's a drift plan that no longer matches the drift, or the environment's kind,
   * provider, or target changed since (BRK-253): the policy and the gates were read for what it was.
   * @param {Record<string, any>} row the plan's row (planRow)
   */
  outOfDatePlan(row) {
    const env = this.sql
      .exec('SELECT kind, provider, target, observe_only FROM infra_environments WHERE id = ?', row.environment)
      .toArray()[0];
    if (env) {
      const moved = (what, then, now) =>
        `${row.env_name}’s ${what} changed from ${then ?? 'none'} to ${now ?? 'none'} since it was planned`;
      if (row.env_kind && env.kind !== row.env_kind) return moved('kind', row.env_kind, env.kind);
      if ((env.provider ?? null) !== (row.provider ?? null)) return moved('provider', row.provider, env.provider);
      // A plan made with the target the desired state gives an environment with none (BRK-309) is up to date while
      // the file still gives that one.
      const gives =
        !env.target && row.target
          ? this.desiredTargetOf({ ...env, id: row.environment, repo: row.repo, name: row.env_name }).target
          : null;
      if ((env.target ?? null) !== (row.target ?? null) && gives !== row.target)
        return moved('target', row.target, env.target);
    }
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
   * Whether approving a plan gives its environment a target (BRK-309): the environment has none, and the plan was made
   * with the one its desired state makes.
   * @param {Record<string, any>} row the plan's row (planRow)
   */
  planGivesTarget(row) {
    if (!row.target) return false;
    const env = this.sql.exec('SELECT target FROM infra_environments WHERE id = ?', row.environment).toArray()[0];
    return Boolean(env && !env.target);
  },

  /**
   * Moves a plan to approved with the digest of its diff, refusing one that's out of date. A press (the owner's, or a
   * person's once its environment's approval rule is met: BRK-303), or the board's when the repository's policy lets
   * the plan through.
   * @param {string} ref the plan's ID
   * @param {{ by: 'owner' | 'person' | 'board' | 'envelope', person?: string | null, summary?: string }} input
   */
  async approveInfraPlan(ref, { by, person = null, summary = '' }) {
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
    const gives = this.planGivesTarget(row);
    if (gives && by !== 'owner')
      throw new AgentError(
        `${id} gives ${row.env_name} its target, ${row.target}: only the owner approves that, on the board`,
        409,
      );
    this.moveInfraPlan(id, 'approved', {
      by,
      person,
      summary: summary || `approved by ${personWords(person)}; digest ${digest.slice(0, 12)}`,
      digest,
    });
    // An environment with no target takes the one this plan was made for from its desired state, now (BRK-309).
    if (gives) this.giveDesiredTarget(row);
    // The executor (BRK-183, store-infra-runs.js) applies it: queued now, started by the alarm in a moment.
    this.queueInfraRun(id);
    await this.soonInfraRuns();
    return planView(this.planRow(id));
  },

  /**
   * Moves a plan to waiting for the owner, then sends one push linking to it. The one path that puts a plan in front of
   * the owner: the owner's own press (PATCH /api/infra/plans/<id>), or the board's (a pull request's plan, an envelope
   * outside its bounds). `reason` is the push's second line, when the plan's policy isn't why it waits.
   * @param {string} ref the plan's ID
   * @param {{ by: 'owner' | 'person' | 'board', person?: string | null, summary?: string, reason?: string,
   *   quiet?: boolean }} input `quiet` sends no push: the owner is already reading the plan
   */
  async waitForOwner(ref, { by, person = null, summary = '', reason, quiet = false }) {
    const plan = this.moveInfraPlan(ref, 'waiting', { by, person, summary });
    if (!quiet) await this.pushInfraPlan(plan, reason);
    return plan;
  },

  /**
   * After a plan is made: one the repository's policy lets through is approved by the board, the rule that did in the
   * audit trail. Any other stays as it was made.
   * @param {ReturnType<typeof import('./infra-plans.js').planView>} plan
   */
  async settleInfraPlan(plan) {
    if (plan.policy?.outcome !== 'allowed') return plan;
    // A plan that gives its environment a target waits for the owner whatever the policy says (BRK-309).
    if (this.planGivesTarget(this.planRow(plan.id))) return plan;
    const rule = `your policy’s rule “${plan.policy.rule}”`;
    this.moveInfraPlan(plan.id, 'waiting', { by: 'board', summary: `${rule} lets it through` });
    return this.approveInfraPlan(plan.id, { by: 'board', summary: `approved by ${rule}` });
  },

  /**
   * Who a waiting plan's push goes to (BRK-340): the owner, as always, and everyone else its environment's approval
   * rule lets approve it now (BRK-303), never its proposer under the two-person rule.
   * @param {{ id: string }} plan
   * @returns {string[]}
   */
  planPushPeople(plan) {
    const view = this.planApprovalView(this.planRow(plan.id));
    return [...new Set([OWNER, ...(view?.mayApprove ?? [])])];
  },

  /**
   * Sends a waiting plan's push to the browsers of everyone who may approve it. Never throws: the plan and its audit
   * entry are the record.
   */
  async pushInfraPlan(plan, why) {
    try {
      const reason = why ?? plan.policy?.reasons?.[0] ?? `${plan.changes} change${plan.changes === 1 ? '' : 's'}`;
      await this.pushTo(this.planPushPeople(plan), planMessage({ ...plan, reason }, install(this.env).name));
    } catch {
      /* push is a convenience */
    }
  },

  /**
   * Whether the request's person may `action` plan `ref`: a maintainer of its repository (BRK-301), never an agent.
   * An agent hears so before the plan is looked up, as it always has.
   */
  allowPlan(body, ref, action, words) {
    this.allowOn(body, action, () => this.planRow(ref).repo, words);
  },

  /**
   * Where approving an open plan stands under its environment's approval rule (BRK-303), for its page: who has
   * approved, how many more it needs, who else may, and whether the owner may approve alone.
   * @param {Record<string, any>} row the plan's row
   */
  planApprovalView(row) {
    const id = planId(Number(row.n));
    return this.approvalView('plan', Number(row.n), {
      environment: Number(row.environment),
      repo: row.repo,
      proposer: this.planProposer(id),
    });
  },

  /**
   * POST /api/infra/plans/<id>/approve: a press, from the signed-in board only, by someone its environment's approval
   * rule lets approve (BRK-303). Under the two-person rule the first approval is kept and the plan still waits; the
   * second approves it. `{ alone: true }` is the owner's Approve alone, when nobody else could approve.
   */
  planApproveApi(ref, body = {}) {
    return this.run(async () => {
      this.allowPlan(body, ref, 'plan.approve', 'only the owner approves a plan, from the board');
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
      const pressed = this.pressedBy(body);
      if (this.planGivesTarget(row) && pressed.by !== 'owner')
        throw new AgentError(
          `${id} gives ${row.env_name} its target, ${row.target}: only the owner approves that, on the board`,
          409,
        );
      const counted = this.countApproval(
        'plan',
        Number(row.n),
        { environment: Number(row.environment), repo: row.repo, proposer: this.planProposer(id), what: id },
        body,
      );
      if (!counted.done) {
        this.appendInfraAudit({
          kind: 'approve',
          repo: row.repo,
          environment: row.env_name,
          environmentId: Number(row.environment),
          plan: id,
          ...pressed,
          outcome: 'needs another approval',
          summary: counted.words,
        });
        return { status: 200, body: { plan: planView(this.planRow(id)), approval: this.planApprovalView(row) } };
      }
      const plan = await this.approveInfraPlan(ref, {
        ...pressed,
        // One approval is today's words; a second, or approving alone, says who and how.
        summary: counted.view.approvals.length > 1 || counted.alone ? counted.words : '',
      });
      return { status: 200, body: { plan, approval: this.planApprovalView(this.planRow(id)) } };
    });
  },

  /** POST /api/infra/plans/<id>/reject: the owner's, from the signed-in board only, with an optional reason. */
  planRejectApi(ref, body = {}) {
    return this.run(async () => {
      this.allowPlan(body, ref, 'plan.approve', 'only the owner rejects a plan, from the board');
      const reason = redact(String(body.reason ?? ''))
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, REASON_MAX);
      const pressed = this.pressedBy(body);
      const who = personWords(pressed.person);
      const plan = this.moveInfraPlan(ref, 'rejected', {
        ...pressed,
        summary: reason ? `rejected by ${who}: ${reason}` : `rejected by ${who}; nothing changes`,
      });
      // An approved plan that hasn't started applying leaves the executor's queue.
      this.sql.exec("DELETE FROM infra_runs WHERE n = ? AND phase = 'queued'", Number(this.planRow(ref).n));
      return { status: 200, body: { plan } };
    });
  },
};
