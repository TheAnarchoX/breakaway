/**
 * TaskStore's deploy flow as Architect's first instance (docs/specs/IDEA-19-architect.md, "The first instance";
 * BRK-195). A repository with a pipeline gets its staging and production environments by itself, as the board's own
 * write (never the owner's environments API): when deploys are turned on or the pipeline changes, and on every sync for
 * a repository that already had one. Each Deploy, Promote, and Roll back that finishes appends one audit entry on its
 * environment, and a Promote or Roll back is also kept as a plan that already ran. The workflows and their buttons
 * don't change, and nothing here applies anything: the board's own install is recorded like any other.
 *
 * `environmentForDeploy` is the one mapping from a Deployment's Worker to its environment, for the deploy flow's
 * signals (BRK-198) and the web.
 */
import { install } from './install.js';
import { runsTheBoard, MAX_ENVIRONMENTS } from './infra-environments.js';
import { blastRadius, costChange, keptDiff, planId } from './infra-plans.js';
import {
  PIPELINE_PROVIDER,
  deployPlanDiff,
  deployPlanRef,
  deployRecord,
  deployState,
  deploySummary,
  liveDeploy,
  pipelineEnvironments,
} from './infra-deploys.js';
import { pipelineOf } from './release.js';

/** How many of a Worker's latest Deployments the environment's view reads. */
const SHOWN = 30;

/**
 * The environment a Deployment's Worker runs in: the repository's environment on the pipeline's provider whose target
 * is that Worker.
 * @typedef {{ id: number, name: string, kind: string, production: boolean, pipeline: string | null }} DeployEnvironment
 */

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDeploysMethods = {
  initInfraDeploys() {
    // Which Deployments are recorded, so each is recorded once however many syncs see it.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_deploys (
        deploy INTEGER PRIMARY KEY, repo TEXT NOT NULL, environment INTEGER NOT NULL, audit INTEGER NOT NULL,
        plan TEXT, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_deploys_by_environment ON infra_deploys (environment, deploy);
    `);
  },

  /**
   * The environment a Deployment's Worker runs in a repository, or null when none targets it.
   * @param {string} slug
   * @param {string} worker
   * @returns {DeployEnvironment | null}
   */
  environmentForDeploy(slug, worker) {
    const row = this.sql
      .exec(
        'SELECT id, name, kind, pipeline FROM infra_environments WHERE repo = ? AND provider = ? AND target = ? ORDER BY pipeline IS NULL, id LIMIT 1',
        slug,
        PIPELINE_PROVIDER,
        worker,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      name: row.name,
      kind: row.kind,
      production: row.kind === 'production',
      pipeline: row.pipeline ?? null,
    };
  },

  /**
   * Gives a repository with a pipeline its staging and production environments, or points them at the pipeline's
   * Workers when it changed. An environment already on a Worker, or one with the role's name and no target, becomes
   * the pipeline's; one with the name that points elsewhere is the owner's and is left alone. The board's own Worker's
   * environment is observe only.
   * @param {string} slug
   */
  ensurePipelineEnvironments(slug) {
    const pipeline = pipelineOf(this.repoBySlug(slug));
    if (!pipeline) return;
    const worker = install(this.env).worker;
    for (const want of pipelineEnvironments(pipeline)) {
      const rows = this.sql.exec('SELECT * FROM infra_environments WHERE repo = ? ORDER BY id', slug).toArray();
      const own = (row) => (runsTheBoard({ target: want.target }, worker) || row.observe_only ? 1 : 0);
      const mine =
        rows.find((r) => r.pipeline === want.role) ??
        rows.find((r) => !r.pipeline && r.provider === want.provider && r.target === want.target) ??
        rows.find((r) => !r.pipeline && r.name === want.name && !r.target);
      if (mine) {
        if (mine.pipeline !== want.role || mine.target !== want.target || mine.provider !== want.provider)
          // Only what the pipeline decides: its name, kind, freeze, and production gates stay as they are.
          this.sql.exec(
            'UPDATE infra_environments SET pipeline = ?, provider = ?, target = ?, observe_only = ?, edited = ? WHERE id = ?',
            want.role,
            want.provider,
            want.target,
            own(mine),
            Date.now(),
            mine.id,
          );
        // Pointing an environment somewhere else leaves a trace.
        if (mine.target !== want.target || mine.provider !== want.provider)
          this.appendInfraAudit({
            kind: 'environment',
            repo: slug,
            environment: mine.name,
            environmentId: Number(mine.id),
            by: 'board',
            outcome: `follows the pipeline’s ${want.role}`,
            summary: `now follows the pipeline’s ${want.role}: ${mine.provider ?? 'no provider'} ${mine.target ?? 'no target'} → ${want.provider} ${want.target}`,
          });
        continue;
      }
      if (rows.some((r) => r.name === want.name) || rows.length >= MAX_ENVIRONMENTS) continue;
      const now = Date.now();
      this.sql.exec(
        'INSERT INTO infra_environments (repo, name, kind, provider, target, pipeline, frozen, gates, observe_only, created, edited) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        slug,
        want.name,
        want.kind,
        want.provider,
        want.target,
        want.role,
        want.kind === 'production' ? 1 : 0,
        own({ observe_only: 0 }),
        now,
        now,
      );
      this.infraEvent(
        'environment.created',
        { repo: slug, name: want.name, kind: want.kind },
        {
          fields: { state: 'added', source: 'deploy' },
          dedupe: `added:${now}`,
        },
      );
    }
  },

  /** What ran on the Worker before Deployment `id`: its latest earlier Deploy or Roll back that landed, or null. */
  deployBefore(slug, worker, id) {
    return liveDeploy(
      this.sql
        .exec(
          'SELECT data FROM gh_deploys WHERE repo = ? AND env = ? AND id < ? ORDER BY id DESC LIMIT ?',
          slug,
          worker,
          id,
          SHOWN,
        )
        .toArray()
        .map((r) => JSON.parse(r.data)),
    );
  },

  /**
   * Records each finished Deployment of a sync once: one audit entry on its environment and, for a Promote or a Roll
   * back, a plan that already ran, in one transaction. A Deployment whose Worker no environment targets, or that's
   * still running, records nothing yet. Returns what it couldn't record.
   * @param {Array<{ deploy: import('./infra-deploys.js').DeployRow }>} changes
   * @param {string} slug
   */
  recordDeploys(changes, slug) {
    const errors = [];
    for (const { deploy } of changes) {
      if (this.sql.exec('SELECT 1 FROM infra_deploys WHERE deploy = ?', deploy.id).toArray().length) continue;
      const env = this.environmentForDeploy(slug, deploy.env);
      const record = env && deployRecord(deploy, env.pipeline);
      if (!record) continue;
      try {
        this.ctx.storage.transactionSync(() => {
          const plan = record.plan ? this.recordDeployPlan(slug, env, deploy, record) : null;
          const entry = this.appendInfraAudit({
            kind: record.kind,
            repo: slug,
            environment: env.name,
            environmentId: env.id,
            plan,
            by: record.by,
            outcome: record.outcome,
            summary: deploySummary(deploy, record.action),
          });
          // A Deploy or Promote that landed reaches the routines that listen for it (BRK-293).
          if (record.outcome === 'applied' && record.action !== 'rollback')
            this.infraEvent(
              record.action === 'promote' ? 'promote.done' : 'deploy.done',
              { repo: slug, name: env.name, kind: env.kind },
              {
                fields: { state: 'applied', resource: deploy.env, ...(plan ? { plan } : {}) },
                dedupe: String(deploy.id),
                cause: { pull: this.mergedPullAt(slug, deploy.sha) },
              },
            );
          this.sql.exec(
            'INSERT INTO infra_deploys (deploy, repo, environment, audit, plan, at) VALUES (?, ?, ?, ?, ?, ?)',
            deploy.id,
            slug,
            env.id,
            entry.id,
            plan,
            Date.now(),
          );
        });
      } catch (error) {
        errors.push(`${deploy.env} ${deploy.sha.slice(0, 7)}: ${error.message}`);
      }
    }
    return errors;
  },

  /**
   * Keeps a Promote or a Roll back as a plan in its final state (applied, failed, or rolled back), from the deploy
   * flow, never to be applied: the workflow already ran it. Its audit entry is the caller's, in the same transaction.
   * @returns {string} the plan's ID
   */
  recordDeployPlan(slug, env, deploy, record) {
    const row = this.sql.exec('SELECT provider, target FROM infra_environments WHERE id = ?', env.id).toArray()[0];
    const diff = keptDiff(deployPlanDiff(deploy, this.deployBefore(slug, deploy.env, deploy.id), env.name));
    const inventory = this.planInventory(env.id);
    const now = Date.now();
    const n = Number(
      this.sql
        .exec(
          `INSERT INTO infra_plans (environment, repo, provider, target, desired_sha, source, ref, state, diff, cost, blast, reversible, by, agent, created, updated)
           VALUES (?, ?, ?, ?, NULL, 'deploy', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) RETURNING n`,
          env.id,
          slug,
          row.provider,
          row.target ?? null,
          deployPlanRef(deploy, record.action),
          record.outcome,
          JSON.stringify(diff),
          JSON.stringify(costChange(diff, new Map())),
          JSON.stringify(blastRadius(diff, inventory)),
          diff.reversible ? 1 : 0,
          record.by,
          now,
          now,
        )
        .toArray()[0].n,
    );
    return planId(n);
  },

  /**
   * What an environment's Worker runs, for its view: the live commit and version and the last Deployment with its
   * state. null for an environment with no target, or one the deploy flow never deployed and isn't the pipeline's.
   * @param {{ repo: string, target: string | null, provider: string | null, pipeline?: string | null }} row
   */
  environmentDeploys(row) {
    if (!row.target || row.provider !== PIPELINE_PROVIDER) return null;
    const rows = this.sql
      .exec(
        'SELECT data FROM gh_deploys WHERE repo = ? AND env = ? ORDER BY id DESC LIMIT ?',
        row.repo,
        row.target,
        SHOWN,
      )
      .toArray()
      .map((r) => JSON.parse(r.data));
    const state = deployState(rows);
    return row.pipeline || state.last ? state : null;
  },
};
