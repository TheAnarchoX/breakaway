/**
 * TaskStore's guided token setup (BRK-304; infra-tokens.js): GET /api/infra/tokens?repo= gives the checklist for a
 * repository's environments, the board's read token for each provider they run on and each GitHub environment's
 * write token, and POST /api/infra/tokens/environments/<name>?repo= is the owner's Make it on GitHub: the GitHub App
 * makes the GitHub environment with only the default branch allowed to deploy, when it has Administration write.
 *
 * The board never asks for, reads, or keeps a write token. It reads a GitHub environment, its branch rule, and its
 * secrets' names (GitHub never gives their values), at most three reads an environment, kept for a few minutes so
 * opening Connections again doesn't ask GitHub again; Check again reads afresh.
 */
import { AgentError } from './store-agents.js';
import { appCredentials, appGet, GitHubError } from './github.js';
import { install } from './install.js';
import { providerRow } from './connections.js';
import { runsTheBoard } from './infra-environments.js';
import { SHORT_LIVED_GITHUB_ENVIRONMENT, runnerEnvironment } from './infra-runner.js';
import {
  branchRuleFix,
  canMakeEnvironments,
  environmentByHand,
  environmentSteps,
  environmentsUrl,
  refusedRead,
  stepsDone,
} from './infra-tokens.js';

/** How long a checklist's GitHub reads are kept before the next look reads again. */
const KEEP_MS = 5 * 60_000;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraTokensMethods = {
  /**
   * The GitHub environments that need a write token in `slug`, each with its provider and desired state: one per
   * environment that can be applied to, and one `short-lived` shared by every short-lived environment and the template.
   * Observe-only environments, and the one the board runs on, take none.
   */
  tokenEnvironments(slug) {
    const worker = install(this.env).worker;
    const rows = this.sql
      .exec('SELECT * FROM infra_environments WHERE repo = ? ORDER BY name', slug)
      .toArray()
      .filter((row) => !row.observe_only && !runsTheBoard(row, worker));
    /** @type {Map<string, { github: string, environments: any[], provider: string | null, desired: any }>} */
    const out = new Map();
    for (const row of rows) {
      const github = runnerEnvironment(row);
      if (github === SHORT_LIVED_GITHUB_ENVIRONMENT) continue;
      out.set(github, {
        github,
        environments: [row],
        provider: row.provider ?? null,
        desired: this.desiredStateFor(row),
      });
    }
    const template = this.shortLivedTemplateOut(slug);
    const shortLived = rows.filter((row) => runnerEnvironment(row) === SHORT_LIVED_GITHUB_ENVIRONMENT);
    if (template.state === 'valid' || shortLived.length)
      out.set(SHORT_LIVED_GITHUB_ENVIRONMENT, {
        github: SHORT_LIVED_GITHUB_ENVIRONMENT,
        environments: shortLived,
        provider: template.template?.provider ?? shortLived[0]?.provider ?? null,
        desired: template.template ? { resources: template.template.resources } : null,
      });
    return [...out.values()];
  },

  /** The targets already running in an environment (a Worker, for Cloudflare), by name, from the inventory. */
  runningTargets(provider, environments) {
    const kinds = Object.entries(provider.kinds ?? {})
      .filter(([, spec]) => spec.target)
      .map(([kind]) => kind);
    if (!kinds.length || !environments.length) return [];
    const names = new Set();
    for (const env of environments)
      for (const r of this.sql
        .exec(
          `SELECT name FROM infra_inventory WHERE environment = ? AND kind IN (${kinds.map(() => '?').join(', ')})`,
          env.id,
          ...kinds,
        )
        .toArray())
        names.add(r.name);
    return [...names];
  },

  /** What GitHub says about one GitHub environment: at most three reads, a refused one said in words. */
  async readTokenEnvironment(client, name) {
    const path = `/environments/${encodeURIComponent(name)}`;
    /** @type {{ environment?: string, policies?: string, secrets?: string }} */
    const problems = {};
    const read = async (key, what, permission, get) => {
      try {
        return await get();
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        if (key === 'environment' && error.status === 404) return null;
        if (error.status === 429) throw new AgentError(`GitHub’s rate limit is used up: check again later`, 429);
        problems[key] = refusedRead(error, what, permission);
        return null;
      }
    };
    const environment = await read('environment', `the GitHub environment ${name}`, 'Actions: read', () =>
      client.get(path),
    );
    if (!environment) return { environment: null, policies: null, secrets: null, problems };
    const rule = environment.deployment_branch_policy;
    const policies =
      rule?.custom_branch_policies && !rule.protected_branches
        ? ((
            await read('policies', `${name}’s deployment branches`, 'Actions: read', () =>
              client.get(`${path}/deployment-branch-policies?per_page=100`),
            )
          )?.branch_policies ?? null)
        : null;
    const listed = await read('secrets', `${name}’s secrets`, 'Environments: read', () =>
      client.get(`${path}/secrets?per_page=100`),
    );
    const secrets = listed ? (listed.secrets ?? []).map((s) => String(s.name)) : null;
    return { environment, policies, secrets, problems };
  },

  /**
   * The checklist for repository `slug` (Kickoff's Run it step reads `done`): the read token for each provider its
   * environments run on, and each GitHub environment's write token. `fresh` reads GitHub again.
   */
  async infraTokens(slug, { fresh = false } = {}) {
    const repo = this.repoBySlug(String(slug ?? '').toLowerCase());
    if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
    this.tokenSetupKept ??= new Map();
    const kept = this.tokenSetupKept.get(repo.slug);
    if (!fresh && kept && Date.now() - kept.at < KEEP_MS) return kept.view;
    const registry = this.infraRegistry();
    const branch = repo.defaultBranch || 'main';
    const groups = this.tokenEnvironments(repo.slug);
    const used = [...new Set(groups.map((g) => g.provider).filter(Boolean))];
    const read = [];
    for (const id of used) {
      const provider = registry.has(id) ? registry.get(id) : null;
      if (!provider?.readToken) continue;
      const row = providerRow(provider, await this.providerRecord(provider.id));
      const permissions = provider.writeToken?.permissions(null, { running: [] }) ?? provider.readToken.permissions;
      const readOnly = permissions.filter((p) => provider.readToken.permissions.some((r) => r.name === p.name));
      read.push({
        provider: provider.id,
        name: provider.name,
        ok: row.state === 'working',
        connected: row.state !== 'off',
        detail: row.detail,
        fix: row.state === 'working' ? null : row.fix,
        permissions: readOnly,
        template: provider.readToken.template?.(readOnly, `${install(this.env).name} read`) ?? null,
        url: provider.readToken.url,
      });
    }
    const credentials = groups.length ? await appCredentials(this.env) : null;
    const client = credentials ? this.githubClient(credentials, repo) : null;
    let canMake = null;
    if (credentials)
      try {
        canMake = canMakeEnvironments(
          (await appGet(credentials, `/repos/${repo.github}/installation`, this.env.TASKS_GITHUB_API || undefined))
            ?.permissions,
        );
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
      }
    const environments = [];
    for (const g of groups) {
      const provider = g.provider && registry.has(g.provider) ? registry.get(g.provider) : null;
      if (!provider?.writeToken) continue;
      const secret = provider.writeToken.secret;
      const permissions = provider.writeToken.permissions(g.desired, {
        running: this.runningTargets(provider, g.environments),
      });
      const seen = client
        ? await this.readTokenEnvironment(client, g.github)
        : {
            environment: null,
            policies: null,
            secrets: null,
            problems: {
              environment: 'connect the board’s GitHub App first: Connections → GitHub',
            },
          };
      const steps = environmentSteps({ github: repo.github, name: g.github, branch, secret, ...seen });
      environments.push({
        name: g.github,
        environments: g.environments.map((e) => e.name),
        provider: provider.id,
        providerName: provider.name,
        desired: Boolean(g.desired),
        secret,
        ok: stepsDone(steps),
        steps,
        permissions,
        template: provider.writeToken.template?.(permissions, `${repo.slug} ${g.github} write`) ?? null,
        // Whether Make it on GitHub can do the first two steps: the App can, and the environment is missing.
        canMake: Boolean(canMake && !seen.environment && !seen.problems.environment),
      });
    }
    const view = {
      repo: repo.slug,
      github: repo.github,
      branch,
      settings: environmentsUrl(repo.github),
      canMake,
      read,
      environments,
      done: read.every((r) => r.ok) && environments.every((e) => e.ok) && (read.length > 0 || environments.length > 0),
      checked: new Date().toISOString(),
    };
    this.tokenSetupKept.set(repo.slug, { at: Date.now(), view });
    return view;
  },

  /** GET /api/infra/tokens?repo=[&fresh=1]: the checklist. */
  infraTokensApi({ repo, fresh } = {}) {
    return this.run(async () => ({
      status: 200,
      body: await this.infraTokens(repo || this.defaultRepoSlug(), { fresh: Boolean(fresh) }),
    }));
  },

  /**
   * POST /api/infra/tokens/environments/<name>?repo=: the owner's Make it on GitHub (the Worker refuses the bearer
   * token). The App makes GitHub environment `name` with only the default branch allowed to deploy, or adds the
   * default branch to an existing one's chosen branches when it has none. It never changes an existing environment's
   * rule otherwise, its reviewers, or its secrets, and never touches a secret's value: the write token is the owner's
   * to add, by hand. Without Administration write, it says so and gives the steps.
   */
  infraTokensMakeApi(name, { repo: slug } = {}, body = {}) {
    return this.run(async () => {
      this.ownerOnlyRoutineKeep(body?.by, 'makes a GitHub environment');
      const repo = this.repoBySlug(String(slug || this.defaultRepoSlug()).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      const github = String(name ?? '').toLowerCase();
      const group = this.tokenEnvironments(repo.slug).find((g) => g.github === github);
      if (!group)
        throw new AgentError(
          `${repo.slug} has no environment that applies through a GitHub environment called ${github.slice(0, 40)}`,
          404,
        );
      const branch = repo.defaultBranch || 'main';
      const byHand = environmentByHand(repo.github, github, branch);
      const credentials = await appCredentials(this.env);
      if (!credentials) throw new AgentError(`the board’s GitHub App isn’t connected. ${byHand}.`, 409);
      const base = this.env.TASKS_GITHUB_API || undefined;
      let permissions = null;
      try {
        permissions = (await appGet(credentials, `/repos/${repo.github}/installation`, base))?.permissions;
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        throw new AgentError(`GitHub answered ${error.status} for the App’s installation. ${byHand}.`, 502);
      }
      if (!canMakeEnvironments(permissions))
        throw new AgentError(
          `the board’s GitHub App can’t make environments: give it Administration: write (Settings → Developer settings → GitHub Apps → Permissions & events), accept it on the installation, and press Make it on GitHub again. Or ${byHand[0].toLowerCase()}${byHand.slice(1)}.`,
          403,
        );
      const client = this.githubClient(credentials, repo);
      const path = `/environments/${encodeURIComponent(github)}`;
      const seen = await this.readTokenEnvironment(client, github);
      if (seen.problems.environment) throw new AgentError(seen.problems.environment, 502);
      const env = group.environments[0] ?? null;
      const audit = (outcome, summary) =>
        this.appendInfraAudit({
          kind: 'environment',
          repo: repo.slug,
          environment: env?.name ?? github,
          environmentId: env?.id ?? null,
          by: 'owner',
          outcome,
          summary,
        });
      const refused = (error, what) => {
        if (!(error instanceof GitHubError)) return error;
        return new AgentError(
          `GitHub answered ${error.status} ${what}: ${error.reason ?? error.message}`,
          error.status === 403 ? 403 : 502,
        );
      };
      const addBranch = async (made) => {
        try {
          await client.send('POST', `${path}/deployment-branch-policies`, { name: branch, type: 'branch' });
        } catch (error) {
          const e = refused(error, `adding ${branch} to ${github}’s deployment branches`);
          // The environment exists now with no branch allowed, so nothing deploys to it: pressing again finishes it.
          if (e instanceof AgentError)
            e.message = `${made ? `${github} was made, but ` : ''}${e.message}. Press Make it on GitHub again to add ${branch}, or add it by hand under Deployment branches and tags.`;
          throw e;
        }
      };
      /** @type {'made' | 'branch' | null} */
      let outcome = null;
      if (!seen.environment) {
        try {
          await client.send('PUT', path, {
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          });
        } catch (error) {
          const e = refused(error, `making ${github}`);
          if (e instanceof AgentError) e.message = `${e.message}. ${byHand}.`;
          throw e;
        }
        // Recorded as soon as GitHub has it, so a failed next step never leaves a change unaudited.
        audit('github-environment', `made the GitHub environment ${github}, only chosen branches deploy`);
        await addBranch(true);
        audit('github-branch', `let ${branch} deploy to the GitHub environment ${github}`);
        outcome = 'made';
      } else {
        if (seen.problems.policies) throw new AgentError(seen.problems.policies, 502);
        const fix = branchRuleFix(seen.environment, seen.policies, branch);
        if (fix === 'by-hand')
          throw new AgentError(
            `${github} already exists with another branch rule, and the board doesn’t change one it didn’t make: on GitHub, ${repo.github} → Settings → Environments → ${github}, under Deployment branches and tags choose Selected branches and tags and allow only ${branch}`,
            409,
          );
        if (fix === 'add-branch') {
          await addBranch(false);
          audit('github-branch', `let ${branch} deploy to the GitHub environment ${github}`);
          outcome = 'branch';
        }
      }
      const view = await this.infraTokens(repo.slug, { fresh: true });
      return { status: outcome === 'made' ? 201 : 200, body: { ...view, made: outcome } };
    });
  },
};
