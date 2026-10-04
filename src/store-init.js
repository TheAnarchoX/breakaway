/**
 * TaskStore's Add the board's files (BRK-132, docs/specs/IDEA-26-kickoff.md, section 2, step 4): the owner's one press
 * writes the first commit to an empty registered repository through the board's GitHub App, with the files
 * `repos init` adds. src/init.js renders them for both from the board's copy of its own files (src/board-files.json),
 * so the two never drift. A repository with any commit is refused with the `repos init` command, which opens a pull
 * request there; the board never does.
 */
import BOARD_FILES from './board-files.json' with { type: 'json' };
import { GitHubError, appCredentials, isEmptyRepo } from './github.js';
import { initCommitMessage, initPlan, promptSections } from './init.js';
import { BREAKAWAY_REPO } from './updates.js';

/** @param {string} path */
const readBoardFile = (path) => {
  const text = /** @type {Record<string, string>} */ (BOARD_FILES)[path];
  if (text === undefined) throw new Error(`the board's copy of ${path} is missing (src/board-files.json)`);
  return text;
};

/** UTF-8 text as base64, for the contents API. */
const base64 = (text) => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** A git tree entry for one planned file: a symlink, an executable, or a plain file. */
const treeEntry = (f) =>
  f.link
    ? { path: f.path, mode: '120000', type: 'blob', content: f.link }
    : { path: f.path, mode: f.mode === 0o755 ? '100755' : '100644', type: 'blob', content: f.content };

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const initMethods = {
  /**
   * `POST /api/repos/<slug>/init`: the owner's press (the Worker lets only the signed-in board through, and an agent's
   * `by` is refused). `origin` is the board's address, which the new `.taskrc` names. Answers 201 with the commit and
   * its files, or 409 with `command` when the repository already has commits.
   *
   * GitHub won't make a tree in a repository with no commits, so the first file goes in through the contents API,
   * and the full tree's commit, with no parent, then replaces it: the branch ends with one commit.
   */
  async boardFilesApi(slug, { by = null, origin = null } = {}) {
    await this.ready();
    if (by !== undefined && by !== null && by !== '' && by !== 'owner')
      return { status: 403, body: { error: 'only the owner adds the board’s files to a repository' } };
    const repo = this.repoBySlug(String(slug).toLowerCase());
    if (!repo) return { status: 404, body: { error: `no repository "${String(slug).slice(0, 40)}"` } };
    const command = `npx breakaway repos init ${repo.slug}`;
    const credentials = await appCredentials(this.env);
    if (!credentials)
      return {
        status: 409,
        body: { error: 'GitHub isn’t connected, so the board can’t write to the repository. Connect it first.' },
      };
    this.initRunning ??= new Set();
    if (this.initRunning.has(repo.slug))
      return { status: 409, body: { error: `The board is already adding its files to ${repo.github}.` } };
    this.initRunning.add(repo.slug);
    try {
      return await this.writeBoardFiles(credentials, repo, { command, origin });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return {
        status: 502,
        body: {
          error: `GitHub refused the first commit to ${repo.github}: ${error.reason ?? error.message}. Check the App can write there (Connections), then try again, or run ${command}.`,
          command,
        },
      };
    } finally {
      this.initRunning.delete(repo.slug);
    }
  },

  async writeBoardFiles(credentials, repo, { command, origin }) {
    const client = this.githubClient(credentials, repo);
    const branch = repo.defaultBranch || 'main';
    const hasCommits = {
      status: 409,
      body: {
        error: `${repo.github} already has commits, so the board doesn’t write to it. Run ${command}: it adds the files in a pull request.`,
        command,
      },
    };
    try {
      await client.get('/commits?per_page=1');
      return hasCommits;
    } catch (error) {
      if (!isEmptyRepo(error)) throw error;
    }

    const plan = initPlan({
      repo,
      board: BREAKAWAY_REPO,
      url: origin,
      read: readBoardFile,
      readTarget: () => null,
      ...promptSections({}),
    });
    const { title, body } = initCommitMessage(repo.slug, { by: 'the board, through its GitHub App' });
    const first = plan.files.find((f) => f.path === '.gitignore') ?? plan.files.find((f) => !f.link);

    // The contents API is the only write GitHub takes on an empty repository. A file that's there already means it
    // isn't empty any more.
    let started;
    try {
      started = await client.send('PUT', `/contents/${first.path.split('/').map(encodeURIComponent).join('/')}`, {
        message: title,
        content: base64(first.content),
        branch,
      });
    } catch (error) {
      if (error instanceof GitHubError && [409, 422].includes(error.status)) return hasCommits;
      throw error;
    }
    const startSha = started?.commit?.sha;
    const raced = {
      status: 409,
      body: {
        error: `${repo.github} got a commit while the board was adding its files, so it stopped after ${first.path}. Run ${command} for the rest.`,
        command,
      },
    };
    if (started?.commit?.parents?.length) return raced;

    const tree = await client.send('POST', '/git/trees', { tree: plan.files.map(treeEntry) });
    const commit = await client.send('POST', '/git/commits', {
      message: `${title}\n\n${body}`,
      tree: tree.sha,
      parents: [],
    });
    // Replace the first file's commit only if nothing else landed on the branch since.
    const ref = await client.get(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref?.object?.sha !== startSha) return raced;
    await client.send('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: true });

    // The wizard's init and prompt steps tick from the next look, and the sync catches up with the new commit.
    this.setGhMeta('gh_empty', repo.slug, null);
    if (this.promptCache) delete this.promptCache[repo.slug];
    if (this.setupLive) delete this.setupLive[repo.github.toLowerCase()];
    await this.githubWebhook('push', null, { slug: repo.slug });
    return {
      status: 201,
      body: {
        slug: repo.slug,
        github: repo.github,
        branch,
        commit: { sha: commit.sha, url: commit.html_url ?? `https://github.com/${repo.github}/commit/${commit.sha}` },
        files: plan.files.map((f) => f.path),
        todo: plan.todo,
      },
    };
  },
};
