/**
 * TaskStore's clean up (docs/specs/IDEA-19-architect.md, "Clean up"; BRK-201). Each drift comparison (BRK-184,
 * store-infra-drift.js) hands its provider's plan here: its deletes are what runs in the environment but isn't in its
 * desired state. What nobody owns (infra-cleanup.js) is flagged on the environment, with an audit entry; a flag whose
 * resource gains an owner (the desired state declares it, a break-glass mark covers it, or it's gone) is dropped, with
 * another. Once a flag is CLEANUP_GRACE_MS old the board makes one removal plan (source `cleanup`) for every flag
 * that's due and puts it in front of the owner: a delete always trips the destructive guard, so it waits for the
 * owner's Approve and is never approved by the board. A removal the owner rejects keeps the resource, and the board
 * proposes it no more; a frozen environment's flags wait to be planned until it's unfrozen.
 *
 * Never anything outside an environment's scope: a flag needs the resource in the environment's inventory slice
 * (BRK-177). Never in an observe-only environment or the board's own install (the comparison refuses them), and never
 * in a short-lived environment, whose task owns everything in it (BRK-200 removes it when the task closes). Anyone
 * signed in reads the flags; only the board writes them.
 */
import { redact } from './redact.js';
import { breakGlassKeys } from './infra-break-glass.js';
import { OPEN_PLAN_STATES } from './infra-drift.js';
import { planNumber } from './infra-plans.js';
import { cleanupDue, ownedBecause, unownedResources, unownedView } from './infra-cleanup.js';

/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */

const OPEN = OPEN_PLAN_STATES.map(() => '?').join(', ');

/** What a flagged resource is, in a few words: "service `old-api`". */
const what = (r) => `${r.kind} \`${r.name}\``;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraCleanupMethods = {
  initInfraCleanup() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_cleanup (
        environment INTEGER NOT NULL, rid TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        flagged INTEGER NOT NULL, plan INTEGER, error TEXT, PRIMARY KEY (environment, rid)
      );
    `);
  },

  /** The flags as the API shows them, with their removal plan's state. */
  unownedRows(environmentId) {
    return this.sql
      .exec(
        `SELECT c.*, p.state AS plan_state FROM infra_cleanup c LEFT JOIN infra_plans p ON p.n = c.plan
         WHERE c.environment = ? ORDER BY c.flagged, c.kind, c.name, c.rid`,
        environmentId,
      )
      .toArray()
      .map((row) => unownedView(row, row.plan_state ?? null));
  },

  /** An environment's flags for its view: `unownedCount` and each flagged resource. */
  unownedFor(environmentId) {
    const unowned = this.unownedRows(environmentId);
    return { unownedCount: unowned.length, unowned };
  },

  /** Writes one audit entry about a flag (kind `cleanup`, by the board). */
  auditUnowned(env, outcome, summary) {
    this.appendInfraAudit({
      kind: 'cleanup',
      repo: env.repo,
      environment: env.name,
      environmentId: env.id,
      by: 'board',
      outcome,
      summary,
    });
  },

  /**
   * Drops every flag on an environment that can no longer be compared (observe only, no provider or desired state),
   * each with an audit entry.
   * @param {Record<string, any>} env
   * @param {string} [why]
   */
  forgetUnowned(env, why = `${env.name} isn’t compared any more, so the board doesn’t clean it up`) {
    const rows = this.sql.exec('SELECT * FROM infra_cleanup WHERE environment = ?', env.id).toArray();
    if (!rows.length) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM infra_cleanup WHERE environment = ?', env.id);
      for (const r of rows) this.auditUnowned(env, 'unflagged', `${what(r)}: ${why}`);
    });
  },

  /**
   * After a comparison: flags what nobody owns in `diff` (the provider's plan against the desired state), drops the
   * flags whose resource has an owner now or is gone, and proposes removing the flags that are due. Never throws: a
   * removal plan that can't be made is kept as the flags' error, and the next comparison tries again.
   * @param {Record<string, any>} env
   * @param {PlanDiff} diff
   * @param {number} [now]
   */
  async settleUnowned(env, diff, now = Date.now()) {
    // A short-lived environment's task owns everything in it, until BRK-200's removal plan takes it away.
    if (env.task) return this.forgetUnowned(env, `${env.name} is short-lived, and its task owns what runs there`);
    const inScope = new Set(
      this.sql
        .exec('SELECT rid FROM infra_inventory WHERE environment = ?', env.id)
        .toArray()
        .map((r) => r.rid),
    );
    const marked = new Set(
      this.sql
        .exec('SELECT keys FROM infra_break_glass WHERE environment = ? AND settled IS NULL', env.id)
        .toArray()
        .flatMap((m) => JSON.parse(m.keys)),
    );
    const brokenGlass = new Set();
    for (const c of diff.changes)
      if (
        c.op === 'delete' &&
        marked.size &&
        (await breakGlassKeys({ ...diff, changes: [c] })).some((k) => marked.has(k))
      )
        brokenGlass.add(c.resource);
    const context = { target: env.target ?? null, inScope, brokenGlass };
    const unowned = unownedResources(diff, context);
    const ids = new Set(unowned.map((r) => r.id));
    const deletes = new Map(diff.changes.filter((c) => c.op === 'delete').map((c) => [c.resource, c]));
    const rows = this.sql.exec('SELECT * FROM infra_cleanup WHERE environment = ?', env.id).toArray();
    const flagged = new Set(rows.map((r) => r.rid));
    const desired = this.desiredStateFor(env)?.resources ?? [];
    const declared = (r) => desired.some((d) => d.id === r.rid || (d.kind === r.kind && d.name === r.name));

    this.ctx.storage.transactionSync(() => {
      for (const r of rows) {
        if (ids.has(r.rid)) continue;
        const c = deletes.get(r.rid);
        const because = c ? ownedBecause(c, context) : null;
        const gone = !c && !declared(r);
        const why =
          because === 'break-glass'
            ? 'a break-glass mark covers it, and its task puts it into code'
            : because === 'target'
              ? `it’s ${env.name}’s target`
              : because === 'scope'
                ? `it’s no longer in ${env.name}’s scope`
                : gone
                  ? r.plan
                    ? `it’s gone (plan-${Number(r.plan)} removed it, or it was removed by hand)`
                    : 'it’s gone: it was removed by hand'
                  : `it’s in ${env.repo}’s desired state now`;
        this.sql.exec('DELETE FROM infra_cleanup WHERE environment = ? AND rid = ?', env.id, r.rid);
        this.auditUnowned(env, gone ? 'removed' : 'unflagged', `${what(r)}: ${why}`);
      }
      for (const r of unowned) {
        if (flagged.has(r.id)) continue;
        this.sql.exec(
          'INSERT INTO infra_cleanup (environment, rid, repo, kind, name, flagged) VALUES (?, ?, ?, ?, ?, ?)',
          env.id,
          r.id,
          env.repo,
          r.kind,
          redact(r.name),
          now,
        );
        this.auditUnowned(
          env,
          'flagged',
          `${what(r)} runs in ${env.name} but isn’t in ${env.repo}’s desired state, and nothing owns it`,
        );
      }
    });
    if (!env.frozen) await this.proposeRemoval(env, now);
  },

  /**
   * Makes one removal plan for an environment's flags that are due and have none yet, and puts it in front of the
   * owner. A flag an open plan already deletes (a pull request's, say) waits for that one instead.
   * @param {Record<string, any>} env
   * @param {number} now
   */
  async proposeRemoval(env, now) {
    const due = this.sql
      .exec('SELECT rid, flagged FROM infra_cleanup WHERE environment = ? AND plan IS NULL', env.id)
      .toArray()
      .filter((r) => cleanupDue(r.flagged, now))
      .map((r) => r.rid);
    if (!due.length) return;
    const deleting = new Set(
      this.sql
        .exec(`SELECT diff FROM infra_plans WHERE environment = ? AND state IN (${OPEN})`, env.id, ...OPEN_PLAN_STATES)
        .toArray()
        .flatMap((p) =>
          JSON.parse(p.diff)
            .changes.filter((c) => c.op === 'delete')
            .map((c) => c.resource),
        ),
    );
    const remove = new Set(due.filter((rid) => !deleting.has(rid)));
    if (!remove.size) return;
    try {
      const made = await this.makeInfraPlan(env.id, {
        source: 'cleanup',
        by: 'board',
        only: (c) => c.op === 'delete' && remove.has(c.resource),
      });
      const planned = new Set(made.diff.changes.map((c) => c.resource));
      for (const rid of remove)
        this.sql.exec(
          'UPDATE infra_cleanup SET plan = ?, error = NULL WHERE environment = ? AND rid = ?',
          planned.has(rid) ? planNumber(made.id) : null,
          env.id,
          rid,
        );
      // A delete always needs the owner (the destructive guard), so the plan is a draft: put it in front of them.
      if (made.state === 'draft')
        await this.waitForOwner(made.id, {
          by: 'board',
          summary: `${made.changes} resource${made.changes === 1 ? '' : 's'} nobody owns, flagged for the grace period`,
        });
    } catch (error) {
      const why = `the removal couldn’t be planned: ${redact(error?.message ?? error)}. The board tries again on the next check.`;
      for (const rid of remove)
        this.sql.exec('UPDATE infra_cleanup SET error = ? WHERE environment = ? AND rid = ?', why, env.id, rid);
    }
  },

  /** GET /api/infra/cleanup[?repo=&environment=]: what nobody owns, by repository then environment. */
  cleanupApi({ repo, environment } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const env = environment ? this.environmentRow(environment, slug) : null;
      const environments = this.sql
        .exec(
          `SELECT DISTINCT e.* FROM infra_cleanup c JOIN infra_environments e ON e.id = c.environment
           WHERE (? IS NULL OR e.repo = ?) AND (? IS NULL OR e.id = ?) ORDER BY e.repo, e.name`,
          slug,
          slug,
          env?.id ?? null,
          env?.id ?? null,
        )
        .toArray();
      return {
        status: 200,
        body: {
          unowned: environments.flatMap((e) =>
            this.unownedRows(e.id).map((r) => ({
              repo: e.repo,
              environment: { id: Number(e.id), name: e.name },
              ...r,
            })),
          ),
        },
      };
    });
  },
};
