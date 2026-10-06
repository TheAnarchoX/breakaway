/**
 * The deploy flow's signals, the pure part (docs/specs/IDEA-19-architect.md, "Signals" and "The first instance";
 * BRK-198). The Deploy, Promote, and Roll back workflows already record each run as a GitHub Deployment, and the board
 * already reads them (src/store-github.js). A deploy whose health check failed and rolled back, any other failed
 * deploy, and every roll back becomes a `health` signal on the environment, so runbooks (BRK-196) and incidents
 * (BRK-197) hear the deploy flow with no new workflow.
 *
 * Only a change counts: a Deployment the board already saw in the same state sends nothing again.
 */

/** Every deploy-flow signal's source. */
export const DEPLOY_SOURCE = 'deploy';

const FAILED = new Set(['failure', 'error']);

/**
 * A Deployment as src/github.js's deployFrom keeps it.
 * @typedef {{ env: string, sha: string, task: string, state: string, description: string | null,
 *   version: string | null, created: string, updated: string | null }} DeployRow
 */

/**
 * The signal a Deployment's new state sends, or null when it sends none: the deploy flow's environment name comes
 * from the caller (the pipeline's staging or production, or the environment whose target is the Worker).
 * @param {DeployRow} deploy
 * @param {string | null | undefined} prevState the state the board last saw, if any
 * @param {{ name: string, id: number | null }} environment
 * @returns {import('./infra-signals.js').SignalInput | null}
 */
export function deploySignal(deploy, prevState, environment) {
  if (prevState === deploy.state) return null;
  const failed = FAILED.has(deploy.state);
  const rollback = deploy.task === 'rollback';
  if (failed ? FAILED.has(prevState ?? '') : !(rollback && deploy.state === 'success')) return null;
  const label = deploy.version ? `version ${deploy.version.slice(0, 8)}` : deploy.sha.slice(0, 7);
  const why = deploy.description ? `: ${deploy.description}` : '';
  /** @type {[string, string]} */
  const [level, text] = rollback
    ? failed
      ? ['critical', `${deploy.env} roll back to ${label} failed${why}`]
      : ['info', `${deploy.env} rolled back to ${label}${why}`]
    : /rolled back/iu.test(deploy.description ?? '')
      ? ['warning', `${deploy.env} deploy of ${deploy.sha.slice(0, 7)} failed its check and went back${why}`]
      : ['warning', `${deploy.env} deploy of ${deploy.sha.slice(0, 7)} failed${why}`];
  return {
    source: DEPLOY_SOURCE,
    environment: environment.name,
    environmentId: environment.id,
    resource: deploy.env,
    kind: 'health',
    level,
    value: null,
    at: deploy.updated ?? deploy.created,
    text,
  };
}
