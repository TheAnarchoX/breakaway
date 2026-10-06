/**
 * TaskStore's draft of an environment's desired state (BRK-240): GET /api/infra/environments/<id>/draft writes the
 * environment's `.github/breakaway-infra/<environment>.json` from its slice of the inventory (BRK-177), with
 * infra-adopt.js, so nobody hand-writes it. Read only: it keeps nothing and changes nothing, so it audits nothing.
 * Anyone signed in reads it, agents with the token as well as the owner: `infra adopt` (CLI-23) writes it into a
 * checkout, and the environment page (WEB-92) shows it. An observe-only environment gets one too; it says it's never
 * applied.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { draftDesired } from './infra-adopt.js';
import { runsTheBoard } from './infra-environments.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraAdoptMethods = {
  /** GET /api/infra/environments/<id>/draft[?repo=]: `{ draft }`, or a 409 saying what to do first. */
  infraDraftApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      if (!env.provider)
        throw new AgentError(
          `${env.name} has no provider: pick one on the board, connect it on Connections, then refresh the inventory`,
          409,
        );
      if (!env.target)
        throw new AgentError(
          `${env.name} has no target, so the inventory has nothing for it yet: give it a target on the board, then refresh the inventory from Connections`,
          409,
        );
      const rows = this.inventoryRows('WHERE i.environment = ?', env.id);
      if (!rows.length)
        throw new AgentError(
          `${env.name} has no inventory yet: connect ${env.provider} on Connections and refresh the inventory, then ask again`,
          409,
        );
      const registry = this.infraRegistry();
      const draft = draftDesired({
        environment: {
          name: env.name,
          provider: env.provider,
          observeOnly: Boolean(env.observe_only) || runsTheBoard(env, install(this.env).worker),
        },
        resources: rows.map((row) => ({
          id: row.rid,
          kind: row.kind,
          name: row.name,
          attrs: row.attrs ? JSON.parse(row.attrs) : {},
        })),
        provider: registry.has(env.provider) ? registry.get(env.provider) : null,
      });
      return {
        status: 200,
        body: { draft: { repo: env.repo, environment: env.name, environmentId: env.id, ...draft } },
      };
    });
  },
};
