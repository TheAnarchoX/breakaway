/**
 * TaskStore's answer to what the console may change on an environment (BRK-262; docs/specs/BRK-258-plan-from-the-board.md):
 * GET /api/infra/environments/<id>/editable gives, per resource kind, the settings its provider declares editable, so
 * the console draws fields from them and never names a vendor. Read only: it keeps nothing and changes nothing, so it
 * audits nothing. Anyone signed in reads it, agents with the token as well as the owner, like the draft.
 */
import { AgentError } from './store-agents.js';
import { editableKinds } from './infra-provider.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraEditableMethods = {
  /** GET /api/infra/environments/<id>/editable[?repo=]: `{ editable }`, or a 409 saying what to do first. */
  infraEditableApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      if (!env.provider)
        throw new AgentError(`${env.name} has no provider: pick one on the board, then ask again`, 409);
      const registry = this.infraRegistry();
      if (!registry.has(env.provider))
        throw new AgentError(
          `${env.name}’s provider ${env.provider} isn’t one this board has: pick another on the board, then ask again`,
          409,
        );
      return {
        status: 200,
        body: {
          editable: {
            repo: env.repo,
            environment: env.name,
            environmentId: env.id,
            kinds: editableKinds(registry.get(env.provider)),
          },
        },
      };
    });
  },
};
