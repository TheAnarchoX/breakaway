/**
 * TaskStore's Turn on deploys (WEB-13, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 5). For a
 * repository without a pipeline, the sync reads `.github/breakaway-pipeline.json` and the rendered workflows from its
 * default branch, once per new commit there, and keeps what it found (pipeline-found.js). The GitHub page shows it,
 * and the owner's one press sets the repository's pipeline, read again from GitHub at that moment and checked as
 * `repos modify --pipeline` checks it. Nothing about the pipeline changes before that press.
 */
import { GitHubError, appCredentials, prVerdict } from './github.js';
import { commentsOf } from './model.js';
import { moveStage, moveTask, repoShape } from './move.js';
import { CONFIG_PATH, WORKFLOWS_DIR, pipelineFound, samePipeline } from './pipeline-found.js';
import { pipelineOf } from './release.js';
import { AgentError } from './store-agents.js';

const FOUND = 'gh_pipeline_found';
/** The repository's move task (WEB-12): the uuid the owner's press made, kept until the repository has a pipeline. */
const MOVE = 'gh_move';
/** How much of the task's last comment the card shows when the agent stopped. */
const REASON_MAX = 600;
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
   * read) and the file names in `.github/` and `.github/workflows/`. With `shape`, a branch without the config also
   * says what it suggests the repository ships (WEB-12): its root's file names and its `package.json`.
   */
  async readPipelineFiles(client, repo, { shape = false } = {}) {
    const ref = `?ref=${encodeURIComponent(repo.defaultBranch || 'main')}`;
    const file = await orNull(client.get(`/contents/${CONFIG_PATH}${ref}`));
    if (!file || Array.isArray(file) || file.type !== 'file')
      return shape ? { config: null, shape: await this.readRepoShape(client, ref) } : { config: null };
    const names = (list) => (Array.isArray(list) ? list.filter((e) => e.type === 'file').map((e) => e.name) : []);
    const [github, workflows] = await Promise.all([
      orNull(client.get(`/contents/.github${ref}`)),
      orNull(client.get(`/contents/${WORKFLOWS_DIR}${ref}`)),
    ]);
    return { config: decode(file.content), github: names(github), workflows: names(workflows) };
  },

  /** The default branch's root file names and its `package.json`, for the card's words (move.js, repoShape). */
  async readRepoShape(client, ref) {
    const list = await orNull(client.get(`/contents/${ref}`));
    const root = Array.isArray(list) ? list.filter((e) => e.type === 'file').map((e) => e.name) : [];
    if (!root.includes('package.json')) return repoShape({ root });
    const pkg = await orNull(client.get(`/contents/package.json${ref}`));
    return repoShape({ root, packageJson: pkg && !Array.isArray(pkg) && pkg.content ? decode(pkg.content) : null });
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
    const files = await this.readPipelineFiles(client, repo, { shape: true });
    const found = pipelineFound(files);
    this.setGhMeta(FOUND, repo.slug, JSON.stringify({ sha: sha ?? null, branch, found, shape: files.shape ?? null }));
  },

  /** What the last sync found for the GitHub page: null for a repository with a pipeline, or one that hasn't moved. */
  pipelineFoundOf(repo) {
    if (repo.pipeline) return null;
    return JSON.parse(this.ghMeta(FOUND, repo.slug) ?? 'null')?.found ?? null;
  },

  /** What the default branch suggested the repository ships at the last sync (move.js, repoShape), or null. */
  repoShapeOf(repo) {
    return JSON.parse(this.ghMeta(FOUND, repo.slug) ?? 'null')?.shape ?? null;
  },

  /** The repository's move task's uuid and its fields, or nulls when there is none (or it was deleted). */
  moveTaskOf(repo) {
    const uuid = this.ghMeta(MOVE, repo.slug);
    const map = uuid ? this.tasks.get(uuid) : null;
    return map && map.status !== 'deleted' ? { uuid, map } : { uuid: null, map: null };
  },

  /** The pull requests that close the move task, newest first, as the card shows them. */
  movePulls(repo, map) {
    if (!map?.wid) return [];
    return this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? ORDER BY updated DESC', repo.slug)
      .toArray()
      .map((r) => JSON.parse(r.data))
      .filter((p) => p.closes?.includes(map.wid) || map.pr === String(p.number))
      .map((p) => ({ ...p, repo: repo.slug, verdict: p.state === 'open' ? prVerdict(p) : null }));
  },

  /**
   * The GitHub page's Deploy with breakaway card (WEB-12) for a repository without a pipeline: the stage (move.js,
   * moveStage), what the default branch suggests it ships, the move task, the pull request the stage is about, and,
   * when the agent stopped, the task's last comment as the reason. null for a repository with a pipeline.
   */
  moveOf(repo) {
    if (repo.pipeline) return null;
    const { uuid, map } = this.moveTaskOf(repo);
    const pulls = this.movePulls(repo, map);
    const stage = moveStage(map, pulls);
    const shape = this.repoShapeOf(repo);
    if (stage === 'start') return { stage, shape, task: null, pr: null, reason: null };
    const pr =
      stage === 'pr'
        ? pulls.find((p) => p.state === 'open')
        : stage === 'merged'
          ? pulls.find((p) => p.state === 'merged')
          : (pulls[0] ?? null);
    const last = stage === 'stopped' ? commentsOf(map).at(-1) : null;
    return {
      stage,
      shape,
      task: {
        uuid,
        wid: map.wid ?? null,
        description: map.description ?? '',
        claim: map.claim ?? null,
        session: map.session ?? null,
      },
      pr: pr ?? null,
      reason: last ? { by: last.by, at: last.at, text: last.text.slice(0, REASON_MAX) } : null,
    };
  },

  /**
   * `POST /api/repos/<slug>/move`: Move to breakaway's deploy flow, the owner's press (the Worker lets only the
   * signed-in board through). It adds the move task (move.js, moveTask) and starts its agent through the repository's
   * routine; never `autostart`, since the press is the start. With the task open it adds nothing: a 409 shows it while
   * an agent holds it or its pull request is open, and Try again starts a new agent on it once the last one stopped.
   */
  async moveApi(slug, body = {}) {
    return this.run(async () => {
      if (body?.by !== undefined && body.by !== null && body.by !== '' && body.by !== 'owner')
        return { status: 403, body: { error: 'only the owner moves a repository to the deploy flow' } };
      const repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) return { status: 404, body: { error: `no repository "${String(slug).slice(0, 40)}"` } };
      if (repo.pipeline)
        return {
          status: 409,
          body: { error: `${repo.name} has a pipeline already. Change it in its settings or with repos modify.` },
        };
      if (this.ghMeta('gh_empty', repo.slug))
        return {
          status: 409,
          body: { error: `${repo.github} has no commits yet. Add the board’s files first, then move it.` },
        };
      const move = this.moveOf(repo);
      if (move.stage === 'running' || move.stage === 'pr' || move.stage === 'merged') {
        const what =
          move.stage === 'running'
            ? `${move.task.claim} is on it`
            : move.stage === 'pr'
              ? `its pull request #${move.pr.number} is open`
              : `its pull request #${move.pr.number} merged`;
        return {
          status: 409,
          body: { error: `${repo.name} is already moving (${move.task.wid}): ${what}.`, move },
        };
      }
      // Nothing is made for a routine that can't start: the refusal says what to connect.
      await this.checkRoutineReady(repo.slug);
      let uuid = move.stage === 'stopped' ? move.task.uuid : null;
      const retried = Boolean(uuid);
      if (!uuid) {
        const task = moveTask(repo, move.shape);
        const res = await this.create([
          {
            ...task,
            project: this.boardArea(repo.slug),
            repo: repo.slug,
            horizon: 'now',
            tags: ['agent'],
            by: 'board',
          },
        ]);
        if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make the move’s task', res.status);
        uuid = res.body.tasks[0].uuid;
        this.setGhMeta(MOVE, repo.slug, uuid);
      }
      try {
        const started = await this.startAgent(uuid, { trigger: 'move' });
        return { status: retried ? 200 : 201, body: { ...started, move: this.moveOf(repo) } };
      } catch (error) {
        // The task stays, and the card shows why with Try again.
        if (this.tasks.get(uuid)?.status === 'pending')
          this.change(
            uuid,
            { annotate: `Couldn’t start an agent: ${error.message}`, by: 'board' },
            new Date(),
            'agents',
          );
        throw error;
      }
    });
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
    this.setGhMeta(MOVE, repo.slug, null);
    return { status: 200, body: { repo: saved.body.repo, pipeline: found.pipeline } };
  },
};
