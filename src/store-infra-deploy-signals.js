/**
 * TaskStore's deploy-flow signals (docs/specs/IDEA-19-architect.md, "Signals"; BRK-198): the GitHub sync hands over
 * the Deployments whose state changed, and each failed deploy or roll back becomes a signal
 * (src/infra-deploy-signals.js) on its environment, stored with recordSignals so runbooks and incidents hear it. The
 * environment is environmentForDeploy's (src/store-infra-deploys.js, BRK-195): the one mapping from a Worker to it.
 */
import { deploySignal } from './infra-deploy-signals.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDeploySignalsMethods = {
  /**
   * The signals a sync's changed Deployments send, each with the state the board saw before. A Worker no environment
   * targets sends none.
   * @param {Array<{ deploy: import('./infra-deploy-signals.js').DeployRow, prev: string | null }>} changes
   * @param {string} slug
   */
  deploySignals(changes, slug) {
    const signals = [];
    for (const { deploy, prev } of changes) {
      const environment = this.environmentForDeploy(slug, deploy.env);
      const signal = environment && deploySignal(deploy, prev, environment);
      if (signal) signals.push(signal);
    }
    return signals;
  },
};
