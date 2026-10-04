/**
 * TaskStore's Turn on deploys (WEB-13, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 5). For a
 * repository without a pipeline, the sync reads `.github/breakaway-pipeline.json` and the rendered workflows from its
 * default branch, once per new commit there, and keeps what it found (pipeline-found.js). The GitHub page shows it,
 * and the owner's one press sets the repository's pipeline, read again from GitHub at that moment and checked as
 * `repos modify --pipeline` checks it. Nothing about the pipeline changes before that press.
 */
import { GitHubError, appCredentials } from './github.js';
import { CONFIG_PATH, WORKFLOWS_DIR, pipelineFound, samePipeline } from './pipeline-found.js';
import { pipelineOf } from './release.js';

const FOUND = 'gh_pipeline_found';
const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** A read GitHub answers 404 (not there) or 403 (not readable) to is nothing found, not a failure. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && [403, 404].includes(error.status)) return null;
    throw error;
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const pipelineMethods = {
  /**
   * What the default branch holds for the move: the config's text (null when it isn't there; then nothing else is
   * read) and the file names in `.github/` and `.github/workflows/`.
   */
  async readPipelineFiles(client, repo) {
    const ref = `?ref=${encodeURIComponent(repo.defaultBranch || 'main')}`;
    const file = await orNull(client.get(`/contents/${CONFIG_PATH}${ref}`));
    if (!file || Array.isArray(file) || file.type !== 'file') return { config: null };
    const names = (list) => (Array.isArray(list) ? list.filter((e) => e.type === 'file').map((e) => e.name) : []);
    const [github, workflows] = await Promise.all([
      orNull(client.get(`/contents/.github${ref}`)),
      orNull(client.get(`/contents/${WORKFLOWS_DIR}${ref}`)),
    ]);
    return { config: decode(file.content), github: names(github), workflows: names(workflows) };
  },

  /**
   * During a sync: for a repository without a pipeline, what its default branch says, read again only when the
   * branch has a new commit (`sha`). One with a pipeline keeps nothing: there is nothing to turn on.
   */
  async findPipeline(client, repo, sha) {
    if (pipelineOf(repo) || repo.pipeline) {
      if (this.ghMeta(FOUND, repo.slug) !== null) this.setGhMeta(FOUND, repo.slug, null);
      return;
    }
    const branch = repo.defaultBranch || 'main';
    const kept = JSON.parse(this.ghMeta(FOUND, repo.slug) ?? 'null');
    if (sha && kept && kept.sha === sha && kept.branch === branch) return;
    const found = pipelineFound(await this.readPipelineFiles(client, repo));
    this.setGhMeta(FOUND, repo.slug, JSON.stringify({ sha: sha ?? null, branch, found }));
  },

  /** What the last sync found for the GitHub page: null for a repository with a pipeline, or one that hasn't moved. */
  pipelineFoundOf(repo) {
    if (repo.pipeline) return null;
    return JSON.parse(this.ghMeta(FOUND, repo.slug) ?? 'null')?.found ?? null;
  },

  /**
   * `POST /api/repos/<slug>/pipeline`: Turn on deploys, the owner's press (the Worker lets only the signed-in board
   * through). It reads the default branch again, so what's set is what is there now; `pipeline`, when sent, is the one
   * the page showed, and a different one on GitHub is a 409 with what's there instead. The pipeline is saved the way
   * `repos modify --pipeline` saves it, with the same checks.
   */
  async turnOnDeploysApi(slug, body = {}) {
    await this.ready();
    if (body?.by !== undefined && body.by !== null && body.by !== '' && body.by !== 'owner')
      return { status: 403, body: { error: 'only the owner turns on deploys' } };
    const repo = this.repoBySlug(String(slug).toLowerCase());
    if (!repo) return { status: 404, body: { error: `no repository "${String(slug).slice(0, 40)}"` } };
    if (repo.pipeline)
      return {
        status: 409,
        body: { error: `${repo.name} has a pipeline already. Change it in its settings or with repos modify.`, repo },
      };
    const credentials = await appCredentials(this.env);
    if (!credentials)
      return { status: 409, body: { error: 'GitHub isn’t connected, so the board can’t read the workflows.' } };
    let found;
    try {
      found = pipelineFound(await this.readPipelineFiles(this.githubClient(credentials, repo), repo));
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return {
        status: 502,
        body: { error: `Couldn’t read ${repo.github} from GitHub: ${error.reason ?? error.message}. Try again.` },
      };
    }
    const branch = repo.defaultBranch || 'main';
    this.setGhMeta(FOUND, repo.slug, JSON.stringify({ sha: null, branch, found }));
    if (!found)
      return {
        status: 409,
        body: { error: `${CONFIG_PATH} isn’t on ${branch}. Merge the move’s pull request first.`, found },
      };
    if (!found.pipeline) return { status: 409, body: { error: found.problem, found } };
    if (body?.pipeline && !samePipeline(body.pipeline, found.pipeline))
      return {
        status: 409,
        body: {
          error: `The ${branch} branch changed since you loaded the page. Check what it says now, then press again.`,
          found,
        },
      };
    const saved = await this.reposModifyApi(repo.slug, { pipeline: found.pipeline });
    if (saved.status !== 200) return saved;
    this.setGhMeta(FOUND, repo.slug, null);
    return { status: 200, body: { repo: saved.body.repo, pipeline: found.pipeline } };
  },
};
