/**
 * TaskStore's drift (docs/specs/IDEA-19-architect.md, "Drift"; BRK-184). On the cron, for each environment with a
 * provider and a desired state (BRK-180), the board asks the provider what it would change to bring what runs back to
 * the desired state. Anything it would change is drift: the board keeps what differs, shows it on the environment
 * (`driftCount`, `drift`), and makes one draft plan from it (source `drift`, by the board) through `makeInfraPlan`, so
 * the plan and its audit entry are BRK-178's. It never applies, and never moves a plan: the owner puts the draft in
 * front of themselves, rejects it, or turns it into a task.
 *
 * One drift, one plan: a comparison that finds an open plan covering the same changes (from drift, a pull request, or
 * anything else) makes none, and while an earlier drift plan is still open it makes no other, saying instead that the
 * open one no longer matches. A frozen environment's drift is kept but not planned until it's unfrozen. Observe-only
 * environments (BRK-169) are never compared: they take no desired state.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { redact } from './redact.js';
import { runsTheBoard } from './infra-environments.js';
import { checkDesired, checkPlan } from './infra-provider.js';
import { keptDiff, planNumber } from './infra-plans.js';
import {
  DRIFT_PER_TICK,
  OPEN_PLAN_STATES,
  driftDue,
  driftFingerprint,
  driftResources,
  driftView,
} from './infra-drift.js';

const OPEN = OPEN_PLAN_STATES.map(() => '?').join(', ');

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDriftMethods = {
  initInfraDrift() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_drift (
        environment INTEGER PRIMARY KEY, repo TEXT NOT NULL, checked INTEGER NOT NULL, desired_sha TEXT,
        count INTEGER, resources TEXT, fingerprint TEXT, plan INTEGER, plan_matches INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `);
  },

  /** An environment's drift for its view: `driftCount` (null until compared) and the last comparison, or null. */
  driftFor(environmentId) {
    const row = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', environmentId).toArray()[0];
    const drift = row ? driftView(row) : null;
    return { driftCount: drift?.count ?? null, drift };
  },

  /**
   * Why an environment row can't be compared, or null when it can: it's observe only, or has no provider that's
   * connected, or no desired state.
   */
  driftRefusal(env) {
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      return `${env.name} is observe only: Architect watches it and never compares it with a desired state`;
    if (!env.provider) return `${env.name} has no provider: the owner picks one on the board first`;
    if (!this.infraRegistry().has(env.provider))
      return `${env.provider} isn’t connected, so ${env.name} can’t be compared`;
    if (!this.desiredStateFor(env))
      return `${env.name} has no desired state yet: add .github/breakaway-infra/${env.name}.json to ${env.repo}’s default branch`;
    return null;
  },

  /**
   * Compares one environment's desired state with what runs, keeps the result, and makes a draft plan when there's
   * drift no open plan covers. A provider that fails is kept as the comparison's error, not thrown, so the cron
   * carries on and the environment shows it. Refused (409) on an environment that can't be compared.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null }} [options]
   */
  async checkInfraDrift(ref, { repo = null } = {}) {
    const env = this.environmentRow(ref, repo);
    const refused = this.driftRefusal(env);
    if (refused) throw new AgentError(refused, 409);
    this.driftChecking ??= new Set();
    if (this.driftChecking.has(env.id))
      throw new AgentError(`${env.name} is being compared already: wait for that to finish`, 409);
    this.driftChecking.add(env.id);
    try {
      return await this.compareDrift(env);
    } finally {
      this.driftChecking.delete(env.id);
    }
  },

  async compareDrift(env) {
    const provider = this.infraRegistry().get(env.provider);
    const desiredSha =
      this.sql
        .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
        .toArray()[0]?.valid_sha ?? null;
    const ctx = {
      environment: env.name,
      scope: { target: env.target },
      observeOnly: false,
      token: (await this.providerReadToken(env.provider)) ?? undefined,
    };
    const last = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
    let diff;
    try {
      diff = keptDiff(
        checkPlan(provider, await provider.plan(ctx, checkDesired(provider, this.desiredStateFor(env))), ctx),
      );
    } catch (error) {
      // What differed last time stays on the environment, with why this comparison couldn't finish.
      return this.keepDrift(env, {
        desiredSha,
        count: last?.count ?? null,
        resources: last?.resources ?? null,
        fingerprint: last?.fingerprint ?? null,
        plan: last?.plan ?? null,
        planMatches: Boolean(last?.plan_matches),
        error: `${provider.name} couldn’t compare ${env.repo}’s ${env.name}: ${redact(error?.message ?? error)}. The board tries again on the next check.`,
      });
    }
    const fingerprint = await driftFingerprint(diff);
    const resources = JSON.stringify(driftResources(diff));
    if (diff.changes.length === 0)
      return this.keepDrift(env, { desiredSha, count: 0, resources, fingerprint, plan: null, planMatches: false });

    const open = this.sql
      .exec(
        `SELECT n, source, diff FROM infra_plans WHERE environment = ? AND state IN (${OPEN}) ORDER BY n DESC`,
        env.id,
        ...OPEN_PLAN_STATES,
      )
      .toArray();
    for (const p of open)
      if ((await driftFingerprint(JSON.parse(p.diff))) === fingerprint)
        return this.keepDrift(env, {
          desiredSha,
          count: diff.changes.length,
          resources,
          fingerprint,
          plan: p.n,
          planMatches: true,
        });
    const stale = open.find((p) => p.source === 'drift');
    if (stale)
      return this.keepDrift(env, {
        desiredSha,
        count: diff.changes.length,
        resources,
        fingerprint,
        plan: stale.n,
        planMatches: false,
      });

    // A frozen environment's drift is kept and shown, but planned only once it's unfrozen.
    if (env.frozen)
      return this.keepDrift(env, {
        desiredSha,
        count: diff.changes.length,
        resources,
        fingerprint,
        plan: null,
        planMatches: false,
      });
    let plan = null;
    let planMatches = false;
    let error = null;
    try {
      const made = await this.makeInfraPlan(env.id, { source: 'drift', by: 'board' });
      plan = planNumber(made.id);
      planMatches = (await driftFingerprint(made.diff)) === fingerprint;
    } catch (e) {
      error = `the drift couldn’t become a plan: ${redact(e?.message ?? e)}`;
    }
    return this.keepDrift(env, {
      desiredSha,
      count: diff.changes.length,
      resources,
      fingerprint,
      plan,
      planMatches,
      error,
    });
  },

  /** Keeps one environment's comparison, replacing the last, and returns it as the API shows it. */
  keepDrift(env, { desiredSha, count, resources, fingerprint, plan, planMatches, error = null }) {
    this.sql.exec(
      `INSERT INTO infra_drift (environment, repo, checked, desired_sha, count, resources, fingerprint, plan, plan_matches, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment) DO UPDATE SET repo = excluded.repo, checked = excluded.checked,
         desired_sha = excluded.desired_sha, count = excluded.count, resources = excluded.resources,
         fingerprint = excluded.fingerprint, plan = excluded.plan, plan_matches = excluded.plan_matches,
         error = excluded.error`,
      env.id,
      env.repo,
      Date.now(),
      desiredSha,
      count,
      resources,
      fingerprint,
      plan,
      planMatches ? 1 : 0,
      error,
    );
    return this.driftOut(env);
  },

  driftOut(env) {
    const row = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
    return { repo: env.repo, environment: { id: Number(env.id), name: env.name }, ...driftView(row) };
  },

  /**
   * On the cron: forgets comparisons for environments that can no longer be compared, then compares the ones that are
   * due (infra-drift.js's driftDue), oldest comparison first, at most DRIFT_PER_TICK. One environment's failure never
   * stops the rest.
   * @param {number} [now]
   */
  async driftTick(now = Date.now()) {
    const environments = this.sql.exec('SELECT * FROM infra_environments ORDER BY id').toArray();
    const due = [];
    for (const env of environments) {
      const last = this.sql
        .exec('SELECT checked, desired_sha FROM infra_drift WHERE environment = ?', env.id)
        .toArray()[0];
      if (this.driftRefusal(env)) {
        if (last) this.sql.exec('DELETE FROM infra_drift WHERE environment = ?', env.id);
        continue;
      }
      const sha =
        this.sql
          .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
          .toArray()[0]?.valid_sha ?? null;
      if (driftDue(last, sha, now)) due.push({ env, checked: last ? Number(last.checked) : 0 });
    }
    this.sql.exec('DELETE FROM infra_drift WHERE environment NOT IN (SELECT id FROM infra_environments)');
    const compared = [];
    for (const { env } of due.sort((a, b) => a.checked - b.checked).slice(0, DRIFT_PER_TICK)) {
      try {
        compared.push(await this.checkInfraDrift(env.id));
      } catch {
        /* being compared already, or no longer comparable: the next tick looks again */
      }
    }
    return compared;
  },

  /** GET /api/infra/drift[?repo=]: every environment's last comparison, by repository then environment. */
  driftApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec(
          `SELECT e.* FROM infra_drift d JOIN infra_environments e ON e.id = d.environment
           WHERE (? IS NULL OR e.repo = ?) ORDER BY e.repo, e.name`,
          slug,
          slug,
        )
        .toArray();
      return { status: 200, body: { drift: rows.map((env) => this.driftOut(env)) } };
    });
  },

  /** GET /api/infra/drift/<environment>[?repo=]: one environment's last comparison, by its ID or name. */
  driftOneApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const has = this.sql.exec('SELECT 1 FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
      if (!has) {
        const refused = this.driftRefusal(env);
        throw new AgentError(
          refused ?? `${env.name} hasn’t been compared yet: the board compares it on its next check`,
          404,
        );
      }
      return { status: 200, body: { drift: this.driftOut(env) } };
    });
  },

  /**
   * POST /api/infra/drift/<environment>: compare it now. The owner's, from the signed-in browser only (the worker
   * refuses the bearer token); an agent's `by` is refused too. A plan it makes is a draft, like the cron's.
   */
  driftCheckApi(ref, body = {}) {
    return this.run(async () => {
      if (body.by !== undefined && body.by !== null && body.by !== '' && body.by !== 'owner')
        throw new AgentError('only the owner or the board compares an environment; agents read drift', 403);
      const repo = body.repo ? String(body.repo).trim().toLowerCase() : null;
      return { status: 200, body: { drift: await this.checkInfraDrift(ref, { repo }) } };
    });
  },
};
