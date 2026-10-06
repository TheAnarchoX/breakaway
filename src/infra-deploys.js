/**
 * The deploy flow as Architect's first instance, the pure part (docs/specs/IDEA-19-architect.md, "The first instance";
 * BRK-195). A repository's pipeline has a staging and a production Worker; each is an environment, made by the board
 * itself (src/store-infra-deploys.js). Every Deploy, Promote, and Roll back that finishes is one audit entry on its
 * environment, and a Promote or a Roll back is also recorded as a plan that already ran (source `deploy`): the
 * workflows did the work, so the board records it and never applies it again.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */
import { cloudflare, rid } from './infra-cloudflare.js';

/** The provider a pipeline's Workers run on: the deploy flow deploys Cloudflare Workers. */
export const PIPELINE_PROVIDER = cloudflare.id;
/** A pipeline's two environments, by the part each plays (also their kind and their name when the board makes them). */
export const PIPELINE_ROLES = /** @type {const} */ (['staging', 'production']);

/**
 * A Deployment as src/github.js's deployFrom keeps it.
 * @typedef {{ id: number, env: string, sha: string, task: string, state: string, description: string | null,
 *   version: string | null, migrations?: string | null, created: string, updated: string | null,
 *   logUrl?: string | null }} DeployRow
 */

/**
 * The environments a pipeline has: one per role, named and kinded after it, pointing at its Worker.
 * @param {{ staging: string, production: string }} pipeline as src/release.js's pipelineOf gives it
 * @returns {Array<{ role: 'staging' | 'production', name: string, kind: string, provider: string, target: string }>}
 */
export function pipelineEnvironments(pipeline) {
  return PIPELINE_ROLES.map((role) => ({
    role,
    name: role,
    kind: role,
    provider: PIPELINE_PROVIDER,
    target: pipeline[role],
  }));
}

const FAILED = new Set(['failure', 'error']);
/** A Deployment that landed: `inactive` is one a newer Deployment replaced, so it landed too. */
const LANDED = new Set(['success', 'inactive']);

/**
 * What a finished Deployment was, and what it records, or null while it's still running.
 *
 * - A Deploy (the workflow, on a merge to staging) is by the executor, kind `apply`, and no plan: nobody pressed it.
 * - A Promote (a deploy to production, only ever started by the owner's press) and a Roll back are by the owner, and
 *   recorded as plans too.
 * - A deploy whose health check failed and went back by itself is an automatic rollback: kind `rollback`, by the
 *   executor.
 * @param {DeployRow} deploy
 * @param {string | null} role the environment's part in the pipeline, if it has one
 * @returns {{ action: 'deploy' | 'promote' | 'rollback', kind: 'apply' | 'rollback', by: 'owner' | 'executor',
 *   outcome: 'applied' | 'failed' | 'rolled back', plan: boolean } | null}
 */
export function deployRecord(deploy, role) {
  const landed = LANDED.has(deploy.state);
  const failed = FAILED.has(deploy.state);
  if (!landed && !failed) return null;
  if (deploy.task === 'rollback')
    return { action: 'rollback', kind: 'rollback', by: 'owner', outcome: landed ? 'applied' : 'failed', plan: true };
  const promote = role === 'production';
  const action = promote ? 'promote' : 'deploy';
  if (failed && /rolled back/iu.test(deploy.description ?? ''))
    return { action, kind: 'rollback', by: 'executor', outcome: 'rolled back', plan: promote };
  return {
    action,
    kind: 'apply',
    by: promote ? 'owner' : 'executor',
    outcome: landed ? 'applied' : 'failed',
    plan: promote,
  };
}

const WORDS = { deploy: 'Deploy', promote: 'Promote', rollback: 'Roll back' };

/**
 * The audit entry's summary: what ran, the commit, the version, the migrations, why it failed, and the run's log.
 * @param {DeployRow} deploy
 * @param {'deploy' | 'promote' | 'rollback'} action
 */
export function deploySummary(deploy, action) {
  const parts = [`${WORDS[action]} of ${deploy.sha.slice(0, 7)} to ${deploy.env}`];
  if (deploy.version) parts.push(`version ${deploy.version}`);
  if (deploy.migrations) parts.push(`migrations ${deploy.migrations}`);
  if (FAILED.has(deploy.state) && deploy.description) parts.push(deploy.description);
  if (deploy.logUrl) parts.push(`log ${deploy.logUrl}`);
  return parts.join(' · ');
}

/** Whether a Deployment ran migrations: a roll back deploys the old version, and never undoes them. */
const ranMigrations = (deploy) => Boolean(deploy.migrations) && !/^none$/iu.test(String(deploy.migrations).trim());

/**
 * The plan a Promote or a Roll back records: one change, the Worker going from what was live to what this one ran.
 * Reversible (rolling back is a deployment of the version before), unless it ran migrations.
 * @param {DeployRow} deploy
 * @param {DeployRow | null} before what was live on the Worker before it
 * @param {string} environment the environment's name
 * @returns {import('./infra-provider.js').PlanDiff}
 */
export function deployPlanDiff(deploy, before, environment) {
  const state = (/** @type {DeployRow} */ d) => ({ commit: d.sha, version: d.version ?? null });
  const reversible = !ranMigrations(deploy);
  return {
    provider: PIPELINE_PROVIDER,
    environment,
    changes: [
      {
        op: 'update',
        resource: rid('worker', deploy.env),
        kind: 'worker',
        name: deploy.env,
        before: before ? state(before) : null,
        after: state(deploy),
        reversible,
        ...(reversible ? {} : { why: `it ran migrations ${deploy.migrations}, and a roll back doesn’t undo them` }),
      },
    ],
    reversible,
  };
}

/** What a plan from the deploy flow points at: the action and the commit, like `promote:0a1b2c3`. */
export const deployPlanRef = (deploy, action) => `${action}:${deploy.sha.slice(0, 7)}`;

/**
 * A Deployment as the environment's view shows it.
 * @param {DeployRow} d
 */
const shown = (d) => ({
  sha: d.sha,
  version: d.version ?? null,
  task: d.task,
  state: d.state,
  at: d.updated ?? d.created,
  url: d.logUrl ?? null,
});

/**
 * What a Worker runs, from its Deployments newest first: the latest Deploy or Roll back that landed, or null.
 * @param {DeployRow[]} deploys
 */
export const liveDeploy = (deploys) =>
  deploys.find((d) => LANDED.has(d.state) && (d.task === 'deploy' || d.task === 'rollback')) ?? null;

/**
 * What runs on an environment's Worker, from its Deployments newest first: `live`, the latest Deploy or Roll back that
 * landed (what it runs now), and `last`, the latest Deployment whatever its state.
 * @param {DeployRow[]} deploys
 */
export function deployState(deploys) {
  const live = liveDeploy(deploys);
  const last = deploys[0] ?? null;
  return { live: live && shown(live), last: last && shown(last) };
}
