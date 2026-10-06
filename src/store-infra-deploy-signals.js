/**
 * TaskStore's deploy-flow signals (docs/specs/IDEA-19-architect.md, "Signals"; BRK-198): the GitHub sync hands over
 * the Deployments whose state changed, and each failed deploy or roll back becomes a signal
 * (src/infra-deploy-signals.js) on its environment, stored with recordSignals so runbooks and incidents hear it.
 */
import { deploySignal } from './infra-deploy-signals.js';
import { pipelineOf } from './release.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDeploySignalsMethods = {
  /**
   * The environment a Deployment's Worker runs in a repository: the environment whose target is that Worker, with its
   * ID. With none yet (BRK-195 makes the pipeline's), the pipeline's `staging` or `production` by name only, never
   * with an ID guessed from a name. A Worker neither names sends no signal.
   * @param {string} slug
   * @param {string} worker
   * @returns {import('./infra-deploy-signals.js').DeployEnvironment | null}
   */
  deployEnvironment(slug, worker) {
    const row = this.sql
      .exec(
        'SELECT id, name, kind FROM infra_environments WHERE repo = ? AND target = ? ORDER BY id LIMIT 1',
        slug,
        worker,
      )
      .toArray()[0];
    if (row) return { name: row.name, id: Number(row.id), production: row.kind === 'production' };
    const pipeline = pipelineOf(this.githubRepo(slug));
    if (pipeline?.production === worker) return { name: 'production', id: null, production: true };
    if (pipeline?.staging === worker) return { name: 'staging', id: null, production: false };
    return null;
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
