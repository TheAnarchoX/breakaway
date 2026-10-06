/**
 * TaskStore's preview for `npx breakaway infra check` (docs/specs/IDEA-19-architect.md, "Desired state"; CLI-14): the
 * plan a desired-state file from a checkout would make, before it's in a pull request. The board checks the file the
 * way it checks the default branch's (BRK-180), now with the environment's provider and its kinds, asks the provider
 * for the diff with the same computation a plan uses (store-infra-plans.js's computeInfraPlan), prices it, measures its
 * blast radius, and checks it against the policy the checkout has (BRK-181): its policy.json, or the default when it
 * has none.
 *
 * A preview is kept nowhere: it has no ID, no state, and no audit entry, so it can't wait for the owner, be approved,
 * or be applied. Only a plan the board makes from the default branch can. An observe-only environment is refused, as
 * its desired state is. Each preview asks the provider for a plan, so a repository gets CHECK_PER_MINUTE a minute.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { runsTheBoard } from './infra-environments.js';
import { checkDesiredFile, desiredPath } from './infra-desired.js';
import { checkPolicyFile, DEFAULT_POLICY, evaluatePolicy, POLICY_PATH } from './infra-policy.js';
import { reversibility } from './infra-plans.js';
import { CHECK_PER_MINUTE } from './infra-check.js';

const MINUTE = 60_000;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraCheckMethods = {
  /**
   * Counts one preview for a repository, or refuses it once the repository has had CHECK_PER_MINUTE this minute. Kept
   * in memory: a store that restarts starts counting again.
   * @param {string} repo
   */
  countInfraCheck(repo) {
    this.infraChecks ??= new Map();
    const now = Date.now();
    const recent = (this.infraChecks.get(repo) ?? []).filter((at) => now - at < MINUTE);
    if (recent.length >= CHECK_PER_MINUTE)
      throw new AgentError(
        `${repo} has had ${CHECK_PER_MINUTE} infra checks in the last minute, each a plan from the provider: try again in a minute`,
        429,
      );
    recent.push(now);
    this.infraChecks.set(repo, recent);
  },

  /**
   * POST /api/infra/check: `{ environment, repo?, file, policy }`, where `file` is the environment's desired-state file
   * as text and `policy` is the checkout's policy.json as text, or null when it has none. Answers `{ preview }`, shaped
   * like a plan without an ID or a state, or 422 with `problem` (`{ path, line, field, message }`) when a file doesn't
   * check. Anyone signed in may ask, an agent too: it changes nothing.
   */
  infraCheckApi(body = {}) {
    return this.run(async () => {
      const repo = body.repo ? String(body.repo).trim().toLowerCase() : null;
      const env = this.environmentRow(body.environment, repo);
      if (env.observe_only || runsTheBoard(env, install(this.env).worker))
        throw new AgentError(`${env.name} is observe only: Architect watches it and never plans changes to it`, 409);
      if (typeof body.file !== 'string') throw new AgentError(`file is ${desiredPath(env.name)}’s text`, 400);
      if (body.policy !== null && typeof body.policy !== 'string')
        throw new AgentError(`policy is ${POLICY_PATH}’s text, or null when the checkout has none`, 400);

      const registry = this.infraRegistry();
      const provider = env.provider && registry.has(env.provider) ? registry.get(env.provider) : null;
      const desired = checkDesiredFile(body.file, { provider, expectProvider: env.provider ?? null });
      if ('error' in desired) return unchecked(desiredPath(env.name), desired.error);
      const policyFile = body.policy === null ? null : checkPolicyFile(body.policy);
      if (policyFile && 'error' in policyFile) return unchecked(POLICY_PATH, policyFile.error);

      this.countInfraCheck(env.repo);
      const { stored, cost, blast } = await this.computeInfraPlan(env, desired.desired);
      const view = this.environmentOut(env);
      const policy = stored.changes.length
        ? evaluatePolicy(
            policyFile && 'policy' in policyFile ? policyFile.policy : DEFAULT_POLICY,
            { environment: { name: env.name, frozen: view.frozen, gates: view.gates }, diff: stored, cost, provider },
            { policy: policyFile ? 'repository' : 'default', sha: null, error: null },
          )
        : null;
      const undo = reversibility(stored);
      return {
        status: 200,
        body: {
          preview: {
            repo: env.repo,
            environment: { id: Number(env.id), name: env.name },
            provider: env.provider,
            target: env.target ?? null,
            changes: stored.changes.length,
            diff: stored,
            cost,
            blastRadius: blast,
            reversible: undo.reversible,
            irreversible: undo.irreversible,
            policy,
          },
        },
      };
    });
  },
};

/** A file that doesn't check: where, and what to change. */
function unchecked(path, error) {
  return {
    status: 422,
    body: { error: `${path} doesn’t check: ${error.message}`, problem: { path, ...error } },
  };
}
