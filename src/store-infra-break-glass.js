/**
 * TaskStore's break-glass (docs/specs/IDEA-19-architect.md, "Break-glass"; BRK-187). The owner changed something by
 * hand, outside a plan, and the board found it as drift (BRK-184). **Mark as break-glass**, with a note, records it
 * once in the audit trail and makes one task in the environment's repository to write what runs into its
 * desired-state file by pull request (BRK-171). The board never proposes undoing it: marking rejects the open drift
 * plan that would, and drift that still holds a marked change makes no other (store-infra-drift.js asks
 * `settleBreakGlass`). A mark is settled once none of its changes differ any more: the file caught up, or the change
 * is gone.
 *
 * The owner's, from the signed-in board only: the worker refuses the bearer token, and an agent's `by` is refused too.
 */
import { AgentError } from './store-agents.js';
import { OPEN_PLAN_STATES } from './infra-drift.js';
import { breakGlassCovers, breakGlassKeys, breakGlassNote, breakGlassTask } from './infra-break-glass.js';
import { planId } from './infra-plans.js';
import { redact } from './redact.js';

/** A mark as the API shows it. */
function shown(row, wid) {
  return {
    id: Number(row.id),
    at: new Date(Number(row.at)).toISOString(),
    note: row.note,
    changes: JSON.parse(row.keys).length,
    task: wid,
    settled: row.settled === null || row.settled === undefined ? null : new Date(Number(row.settled)).toISOString(),
  };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraBreakGlassMethods = {
  initInfraBreakGlass() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_break_glass (
        id INTEGER PRIMARY KEY AUTOINCREMENT, environment INTEGER NOT NULL, repo TEXT NOT NULL, at INTEGER NOT NULL,
        note TEXT NOT NULL, keys TEXT NOT NULL, task TEXT NOT NULL, settled INTEGER
      );
      CREATE INDEX IF NOT EXISTS infra_break_glass_by_environment ON infra_break_glass (environment, id);
    `);
  },

  /** A mark's view, with its follow-up task's work ID (its UUID's start when it has none). */
  breakGlassOut(row) {
    const map = this.tasks.get(row.task);
    return shown(row, map?.wid ?? String(row.task).slice(0, 8));
  },

  /** An environment's newest mark that still stands, as its drift shows it, or null. */
  breakGlassFor(environmentId) {
    const row = this.sql
      .exec(
        'SELECT * FROM infra_break_glass WHERE environment = ? AND settled IS NULL ORDER BY id DESC LIMIT 1',
        environmentId,
      )
      .toArray()[0];
    return row ? this.breakGlassOut(row) : null;
  },

  /**
   * For each comparison: settles the environment's marks none of whose changes differ any more, and says whether a
   * mark still covers a change in `diff`, so the comparison makes no plan that would undo it.
   * @param {Record<string, any>} env
   * @param {import('./infra-provider.js').PlanDiff} diff
   */
  async settleBreakGlass(env, diff) {
    const marks = this.sql
      .exec('SELECT id, keys FROM infra_break_glass WHERE environment = ? AND settled IS NULL', env.id)
      .toArray();
    if (!marks.length) return false;
    const now = await breakGlassKeys(diff);
    let covers = false;
    for (const m of marks) {
      if (breakGlassCovers(JSON.parse(m.keys), now)) covers = true;
      else this.sql.exec('UPDATE infra_break_glass SET settled = ? WHERE id = ?', Date.now(), m.id);
    }
    return covers;
  },

  /**
   * Marks an environment's drift as break-glass: compares it now, so the mark is for what differs, then records it in
   * the audit trail, makes the follow-up task in the environment's repository, and rejects the open drift plans that
   * would undo it. Marking the same changes again returns the first mark (`already`), with no second entry or task.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null, note?: unknown }} input
   */
  async markBreakGlass(ref, { repo = null, note } = {}) {
    const text = breakGlassNote(note);
    const env = this.environmentRow(ref, repo);
    const refused = this.driftRefusal(env);
    if (refused) throw new AgentError(refused, 409);
    this.breakGlassMarking ??= new Set();
    if (this.breakGlassMarking.has(env.id))
      throw new AgentError(`${env.name}’s drift is being marked already: wait for that to finish`, 409);
    this.breakGlassMarking.add(env.id);
    try {
      return await this.markBreakGlassOnce(env, text);
    } finally {
      this.breakGlassMarking.delete(env.id);
    }
  },

  async markBreakGlassOnce(env, text) {
    let diff;
    try {
      diff = await this.driftDiff(env);
    } catch (error) {
      throw new AgentError(
        `couldn’t compare ${env.repo}’s ${env.name} to mark its drift: ${redact(error?.message ?? error)}. Try again in a moment.`,
        502,
      );
    }
    if (!diff.changes.length)
      throw new AgentError(`${env.name} has no drift: what runs matches ${env.repo}’s desired state`, 409);
    const keys = await breakGlassKeys(diff);
    const same = this.sql
      .exec(
        'SELECT * FROM infra_break_glass WHERE environment = ? AND settled IS NULL AND keys = ? ORDER BY id DESC LIMIT 1',
        env.id,
        JSON.stringify(keys),
      )
      .toArray()[0];
    if (same) return { already: true, breakGlass: this.breakGlassOut(same), drift: await this.compareDrift(env) };

    // A drift plan the executor already holds would undo the change, and can't be rejected any more: say so first.
    const undoing = this.sql
      .exec(
        "SELECT n, state FROM infra_plans WHERE environment = ? AND source = 'drift' AND state IN ('approved', 'applying') ORDER BY n DESC LIMIT 1",
        env.id,
      )
      .toArray()[0];
    if (undoing)
      throw new AgentError(
        `${planId(Number(undoing.n))} is ${undoing.state} and puts ${env.name} back as the file says: wait for it to finish, then mark what differs`,
        409,
      );

    const task = breakGlassTask({ environment: env.name, note: text, changes: diff.changes });
    const made = await this.create([
      {
        ...task,
        project: this.boardArea(env.repo),
        repo: env.repo,
        horizon: 'now',
        tags: ['agent', 'break-glass'],
        by: 'board',
      },
    ]);
    if (made.status !== 201) throw new AgentError(made.body.error ?? 'couldn’t make the break-glass task', made.status);
    const uuid = made.body.tasks[0].uuid;
    const wid = made.body.tasks[0].wid ?? uuid.slice(0, 8);

    let row;
    this.ctx.storage.transactionSync(() => {
      row = this.sql
        .exec(
          'INSERT INTO infra_break_glass (environment, repo, at, note, keys, task) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
          env.id,
          env.repo,
          Date.now(),
          text,
          JSON.stringify(keys),
          uuid,
        )
        .toArray()[0];
      this.appendInfraAudit({
        kind: 'break-glass',
        repo: env.repo,
        environment: env.name,
        environmentId: Number(env.id),
        by: 'owner',
        outcome: 'recorded',
        summary: `${diff.changes.length} ${diff.changes.length === 1 ? 'change' : 'changes'} made by hand, brought into code by ${wid}: ${text}`,
      });
    });
    // The open drift plans would put back what the owner changed: the board never proposes that.
    const open = this.sql
      .exec(
        `SELECT n FROM infra_plans WHERE environment = ? AND source = 'drift' AND state IN (${OPEN_PLAN_STATES.map(() => '?').join(', ')}) ORDER BY n`,
        env.id,
        ...OPEN_PLAN_STATES,
      )
      .toArray();
    for (const p of open)
      this.moveInfraPlan(planId(Number(p.n)), 'rejected', {
        by: 'owner',
        outcome: 'rejected',
        summary: `marked as break-glass: the board doesn’t undo a change made by hand; ${wid} brings it into code`,
      });
    return { already: false, breakGlass: this.breakGlassOut(row), drift: await this.compareDrift(env) };
  },

  /** GET /api/infra/break-glass[?repo=&environment=]: marks newest first, settled ones too. */
  breakGlassApi({ repo, environment } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const envId = environment ? Number(this.environmentRow(environment, slug).id) : null;
      const rows = this.sql
        .exec(
          `SELECT * FROM infra_break_glass WHERE (? IS NULL OR repo = ?) AND (? IS NULL OR environment = ?)
           ORDER BY id DESC LIMIT 200`,
          slug,
          slug,
          envId,
          envId,
        )
        .toArray();
      return { status: 200, body: { breakGlass: rows.map((r) => this.breakGlassOut(r)) } };
    });
  },

  /**
   * POST /api/infra/break-glass/<environment>: **Mark as break-glass**, with a note. The owner's, from the signed-in
   * browser only (the worker refuses the bearer token); an agent's `by` is refused too. 201 for a new mark, 200 when
   * the same changes were marked already.
   */
  breakGlassMarkApi(ref, body = {}) {
    return this.run(async () => {
      const repo = body.repo ? String(body.repo).trim().toLowerCase() : null;
      this.allowOn(
        body,
        'drift.break-glass',
        () => this.environmentRow(ref, repo).repo,
        'only the owner marks drift as break-glass; agents read it',
      );
      const marked = await this.markBreakGlass(ref, { repo, note: body.note });
      return { status: marked.already ? 200 : 201, body: marked };
    });
  },
};
