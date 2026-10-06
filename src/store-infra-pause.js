/**
 * TaskStore's side of freeze and the deploy pause as one switch (BRK-236; the pure parts are in src/infra-pause.js).
 * Freezing or unfreezing a pipeline's production writes the board first, then sets `DEPLOYS_PAUSED` through the
 * GitHub App, outside any transaction: when GitHub refuses (the App has no Variables permission yet), the freeze still
 * holds on the board and the next sync tries again. Each sync reads the variable and settles any difference with
 * pauseSync(), audited by the board. Only production touches the variable; staging's freeze never does.
 */
import { GitHubError, appCredentials } from './github.js';
import { pipelineOf } from './release.js';
import { PAUSE_PERMISSION, PAUSE_VARIABLE, followSummary, pauseSync, pausedValue } from './infra-pause.js';

/** What a failed read or write of the variable says, in words. */
const pauseError = (error) =>
  error instanceof GitHubError && error.status === 403
    ? PAUSE_PERMISSION
    : String(error?.reason ?? error?.message ?? error).slice(0, 200);

/** The value both sides last agreed on, or null before the first. */
const agreed = (value) => (value === null || value === undefined ? null : value === 'true');

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraPauseMethods = {
  /** A repository's pipeline production environment, or null when it has no pipeline or none was made. */
  pipelineProduction(slug) {
    if (!pipelineOf(this.repoBySlug(slug))) return null;
    return (
      this.sql
        .exec("SELECT * FROM infra_environments WHERE repo = ? AND pipeline = 'production' ORDER BY id LIMIT 1", slug)
        .toArray()[0] ?? null
    );
  },

  /** Whether the pipeline's production is frozen, so Promote waits. */
  productionFrozen(slug) {
    return Boolean(this.pipelineProduction(slug)?.frozen);
  },

  /**
   * Whether `DEPLOYS_PAUSED` on GitHub matches a pipeline production's freeze, for its view: `synced` is null before
   * the first sync read it, and `error` says why it couldn't be read or written. Null for any other environment.
   */
  deployPause(row) {
    if (row.pipeline !== 'production' || !pipelineOf(this.repoBySlug(row.repo))) return null;
    const last = agreed(this.ghMeta('gh_paused', row.repo));
    const error = this.ghMeta('gh_pause_error', row.repo) ?? null;
    return {
      variable: PAUSE_VARIABLE,
      synced: error ? false : last === null ? null : last === Boolean(row.frozen),
      error,
    };
  },

  /**
   * Sets `DEPLOYS_PAUSED` on the repository to the freeze. Never throws: GitHub's refusal comes back as `error`, and
   * the freeze already holds on the board either way.
   * @returns {Promise<{ variable: string, value: boolean, synced: boolean, error: string | null }>}
   */
  async writeDeployPause(slug, paused) {
    const out = (synced, error = null) => ({ variable: PAUSE_VARIABLE, value: paused, synced, error });
    const repo = this.repoBySlug(slug);
    const credentials = await appCredentials(this.env);
    if (!credentials || !repo) {
      const error = 'GitHub isn’t connected yet';
      this.setGhMeta('gh_pause_error', slug, error);
      return out(false, error);
    }
    const client = this.githubClient(credentials, repo);
    const value = String(paused);
    try {
      try {
        await client.send('PATCH', `/actions/variables/${PAUSE_VARIABLE}`, { name: PAUSE_VARIABLE, value });
      } catch (error) {
        // Not there yet: make it. There's nothing to clear when it was never set.
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
        if (paused) await client.send('POST', '/actions/variables', { name: PAUSE_VARIABLE, value });
      }
    } catch (error) {
      const reason = pauseError(error);
      this.setGhMeta('gh_pause_error', slug, reason);
      return out(false, reason);
    }
    this.setGhMeta('gh_paused', slug, value);
    this.setGhMeta('gh_pause_error', slug, null);
    return out(true);
  },

  /**
   * On each sync of a repository with a pipeline: reads `DEPLOYS_PAUSED` and settles a difference with its
   * production's freeze (pauseSync). A change made on GitHub moves the freeze, audited as the board's; a freeze whose
   * write never reached GitHub is written again. Never throws for GitHub: a refusal is kept for Connections.
   */
  async syncDeployPause(client, slug) {
    const row = this.pipelineProduction(slug);
    if (!row) return;
    let github;
    try {
      github = pausedValue((await client.get(`/actions/variables/${PAUSE_VARIABLE}`)).value);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 404) github = false;
      else {
        this.setGhMeta('gh_pause_error', slug, pauseError(error));
        return;
      }
    }
    const board = Boolean(row.frozen);
    const move = pauseSync({ github, board, last: agreed(this.ghMeta('gh_paused', slug)) });
    if (move === 'push') {
      await this.writeDeployPause(slug, board);
      return;
    }
    if (move === 'follow') {
      this.sql.exec(
        'UPDATE infra_environments SET frozen = ?, frozen_at = ?, edited = ? WHERE id = ?',
        github ? 1 : 0,
        github ? Date.now() : null,
        Date.now(),
        row.id,
      );
      this.appendInfraAudit({
        kind: 'freeze',
        repo: slug,
        environment: row.name,
        environmentId: Number(row.id),
        by: 'board',
        outcome: github ? 'on' : 'off',
        summary: followSummary(github),
      });
    }
    this.setGhMeta('gh_paused', slug, String(github));
    this.setGhMeta('gh_pause_error', slug, null);
  },
};
