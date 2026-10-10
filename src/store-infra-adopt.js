/**
 * TaskStore's draft of an environment's desired state (BRK-240): GET /api/infra/environments/<id>/draft writes the
 * environment's `.github/breakaway-infra/<environment>.json` from its slice of the inventory (BRK-177), with
 * infra-adopt.js, so nobody hand-writes it. Read only: it keeps nothing and changes nothing, so it audits nothing.
 * Anyone signed in reads it, agents with the token as well as the owner: `infra adopt` (CLI-23) writes it into a
 * checkout, and the environment page (WEB-92) shows it. An observe-only environment gets one too; it says it's never
 * applied.
 *
 * Describe it as code (WEB-92): the owner's one press on the environment page adds a task in the environment's
 * repository, whose agent runs `infra adopt`, then `infra check`, and opens the pull request, and starts that agent the
 * way Start on a task does. The board opens no pull request itself, and nothing is applied: the owner merges as always.
 * It's a change to the board's tasks, not to the environment, so it audits nothing either; the task is the record.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { describeBrief, describeTitle, draftDesired } from './infra-adopt.js';
import { desiredPath } from './infra-desired.js';
import { runsTheBoard } from './infra-environments.js';
import { repoSlugOf } from './repos.js';

/** What the environment page shows of the task describing an environment: enough to link it and its pull request. */
function describeTask(t) {
  return {
    uuid: t.uuid,
    wid: t.wid ?? null,
    short: t.short,
    description: t.description,
    status: t.status,
    claim: t.claim ?? null,
    pr: t.pr ?? null,
  };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraAdoptMethods = {
  /** GET /api/infra/environments/<id>/draft[?repo=]: `{ draft }`, or a 409 saying what to do first. */
  infraDraftApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      return {
        status: 200,
        body: { draft: { repo: env.repo, environment: env.name, environmentId: env.id, ...this.infraDraftOf(env) } },
      };
    });
  },

  /** Environment row `env`'s draft, or a 409 AgentError saying what to do first. */
  infraDraftOf(env) {
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
    return draftDesired({
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
  },

  /** The open task describing environment row `env` as code, or null: one at a time per environment. */
  describeTaskOf(env) {
    const fallback = this.defaultRepoSlug();
    const title = describeTitle(env.name);
    const open = [...this.tasks].find(
      ([, map]) =>
        map.status === 'pending' &&
        map.tag_general &&
        map.description === title &&
        repoSlugOf(map, fallback) === env.repo,
    );
    return open ? describeTask(this.detail(open[0])) : null;
  },

  /** Why environment row `env` can't be described as code from the board, or null: it has a file, or is observe only. */
  describeBlocker(env) {
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      return `${env.name} is observe only: the board watches it and never changes it, so it takes no desired state`;
    const file = this.sql
      .exec('SELECT 1 FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
      .toArray()[0];
    if (file) return `${env.name} already has ${desiredPath(env.name)} on ${env.repo}’s default branch`;
    return null;
  },

  /**
   * GET /api/infra/environments/<id>/describe[?repo=]: the open task describing the environment as code, if any, and
   * why a press wouldn't start one now (`refusal`: observe only, a file already there, or the repository's agent
   * routine not connected, with `routine` true for the last). Anyone signed in reads it.
   */
  infraDescribeApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const task = this.describeTaskOf(env);
      let refusal = task ? null : this.describeBlocker(env);
      let routine = false;
      if (!task && !refusal)
        try {
          await this.checkRoutineReady(env.repo);
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          refusal = error.message;
          routine = true;
        }
      return { status: 200, body: { task, refusal, routine } };
    });
  },

  /**
   * POST /api/infra/environments/<id>/describe: the owner's Have an agent open the pull request. Adds `Describe <env> as
   * code` in the environment's repository (an agent's, +general, never autostart: the press starts it) and starts its
   * agent through the same start as Start on a task. With one already open it returns that one (`already`). Refuses,
   * adding nothing, while the environment has a file or is observe only, has no draft yet, or its repository's agent
   * routine isn't connected. A start the board's limits refuse leaves the task waiting for the owner's Start
   * (`waiting`); any other refusal takes the task away again.
   */
  infraDescribeStartApi(ref, { repo, by, force, actor } = {}) {
    return this.run(async () => {
      this.allowOn(
        { actor, by },
        'environment.describe',
        () => this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null).repo,
        'only the owner has an agent describe an environment as code; agents run infra adopt',
      );
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const open = this.describeTaskOf(env);
      if (open) return { status: 200, body: { task: open, run: null, waiting: null, already: true } };
      const blocker = this.describeBlocker(env);
      if (blocker) throw new AgentError(blocker, 409);
      this.infraDraftOf(env);
      await this.checkRoutineReady(env.repo);
      const res = await this.create([
        {
          description: describeTitle(env.name),
          horizon: 'now',
          who: 'agent',
          tags: ['general'],
          brief: describeBrief({ name: env.name, repo: env.repo }),
          ...(env.repo === this.defaultRepoSlug() ? {} : { repo: env.repo }),
          by: 'owner',
        },
      ]);
      if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t add the task', res.status);
      const uuid = res.body.tasks[0].uuid;
      try {
        const started = await this.startAgent(uuid, { trigger: 'describe', kind: 'general', force: Boolean(force) });
        return {
          status: 201,
          body: { task: describeTask(this.detail(uuid)), run: started.run, waiting: null, already: false },
        };
      } catch (error) {
        // Over the board's limits, or Claude's hourly one: the task stays, and the owner starts it when there's room.
        const queued = error instanceof AgentError && (error.forceable || error.status === 429);
        if (!queued) {
          this.change(uuid, { status: 'deleted' }, new Date(), 'agents');
          throw error;
        }
        return {
          status: 202,
          body: {
            task: describeTask(this.detail(uuid)),
            run: null,
            waiting: error.message,
            forceable: error.forceable,
            already: false,
          },
        };
      }
    });
  },
};
