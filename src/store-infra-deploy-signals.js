/**
 * TaskStore's deploy-flow signals (docs/specs/IDEA-19-architect.md, "Signals"; BRK-198): the GitHub sync hands over
 * the Deployments whose state changed, and each failed deploy or roll back becomes a `health` signal
 * (src/infra-deploy-signals.js) on its environment, stored with recordSignals so runbooks and incidents hear it.
 */
import { deploySignal } from './infra-deploy-signals.js';
import { pipelineOf } from './release.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDeploySignalsMethods = {
  /**
   * The environment a Deployment's Worker belongs to in a repository: the environment whose target is that Worker,
   * else the pipeline's `staging` or `production` (with its ID when the repository has an environment by that name),
   * else none, and the Deployment sends no signal.
   * @param {string} slug
   * @param {string} worker
   * @returns {{ name: string, id: number | null } | null}
   */
  deployEnvironment(slug, worker) {
    const target = this.sql
      .exec('SELECT id, name FROM infra_environments WHERE repo = ? AND target = ? ORDER BY id LIMIT 1', slug, worker)
      .toArray()[0];
    if (target) return { name: target.name, id: Number(target.id) };
    const pipeline = pipelineOf(this.githubRepo(slug));
    const name = pipeline?.staging === worker ? 'staging' : pipeline?.production === worker ? 'production' : null;
    if (!name) return null;
    const row = this.sql.exec('SELECT id FROM infra_environments WHERE repo = ? AND name = ?', slug, name).toArray()[0];
    return { name, id: row ? Number(row.id) : null };
  },

  /**
   * The signals a sync's changed Deployments send, each with the state the board saw before.
   * @param {Array<{ deploy: import('./infra-deploy-signals.js').DeployRow, prev: string | null }>} changes
   * @param {string} slug
   */
  deploySignals(changes, slug) {
    const signals = [];
    for (const { deploy, prev } of changes) {
      const environment = this.deployEnvironment(slug, deploy.env);
      const signal = environment && deploySignal(deploy, prev, environment);
      if (signal) signals.push(signal);
    }
    return signals;
  },
};
