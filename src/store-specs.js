/**
 * TaskStore's specs (docs/specs/IDEA-31-specs-view.md, section 2): a repository's specs read from its default
 * branch through the GitHub App, with the tasks that link each one. Kept for a minute per repository, as the
 * agent prompt is (`routinePromptApi`), in memory only: the board never stores a spec. The linked tasks are the
 * board's own and are worked out on every read, so a task that changes shows at once.
 */
import { GitHubError, appCredentials, isEmptyRepo, repoRef } from './github.js';
import { repoSlugOf } from './repos.js';
import { SPEC_MAX_BYTES, bySpecOrder, inSpecsDir, isSpecFile, normalPath, specMeta, specsDirOf } from './specs.js';

const SPECS_CACHE_MS = 60_000;
const NOT_CONNECTED = 'Connect GitHub to read the specs';

/** One GraphQL call for the whole directory, so a repository with many specs costs one request, not one each. */
const TREE_QUERY = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree { entries { name type object { ... on Blob { byteSize isBinary text } } } }
    }
  }
}`;

/** @typedef {{ uuid: string, wid: string | null, description: string, status: string }} SpecTask */

const byWid = (a, b) =>
  (a.wid ? Number(a.wid.split('-')[1]) : Number.MAX_SAFE_INTEGER) -
    (b.wid ? Number(b.wid.split('-')[1]) : Number.MAX_SAFE_INTEGER) || a.uuid.localeCompare(b.uuid);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const specsMethods = {
  /**
   * The tasks of `repo` whose `spec` field names a file, by path: their work ID, title, and status. Deleted
   * tasks are left out; done ones stay, so the list can say "4 tasks, 2 open".
   * @returns {Map<string, SpecTask[]>}
   */
  specTasks(repo) {
    const fallback = this.defaultRepoSlug();
    /** @type {Map<string, SpecTask[]>} */
    const out = new Map();
    for (const [uuid, map] of this.tasks) {
      if (!map.spec || map.status === 'deleted' || repoSlugOf(map, fallback) !== repo.slug) continue;
      const path = normalPath(map.spec);
      if (!out.has(path)) out.set(path, []);
      out.get(path).push({ uuid, wid: map.wid ?? null, description: map.description ?? '', status: map.status });
    }
    for (const list of out.values()) list.sort(byWid);
    return out;
  },

  /** The repository a specs request is for, and GitHub's credentials, or the response that says why not. */
  async specsSetup(slug) {
    await this.ready();
    const { repo, error } = this.githubRepoOr404(slug);
    if (error) return { error };
    const dir = specsDirOf(repo);
    const credentials = await appCredentials(this.env);
    if (!credentials) return { error: { status: 409, body: { slug: repo.slug, dir, error: NOT_CONNECTED } } };
    this.specsCache ??= {};
    return { repo, dir, credentials };
  },

  /**
   * `GET /api/specs?repo=<slug>`: repository `slug`'s specs (the default's when empty) on its default branch,
   * each with its title, status, work ID, and linked tasks, newest first. A directory that isn't there is an
   * empty list with `missing`; a file over 1 MB is listed with `tooLarge` and its file name for a title.
   */
  async specsApi(slug = null) {
    const setup = await this.specsSetup(slug);
    if (setup.error) return setup.error;
    const { repo, dir, credentials } = setup;
    const key = repo.slug;
    let kept = this.specsCache[key];
    if (!kept || kept.dir !== dir || kept.branch !== repo.defaultBranch || Date.now() - kept.at >= SPECS_CACHE_MS) {
      const ref = repoRef(repo.github);
      let data;
      try {
        data = await this.githubClient(credentials, repo).graphql(TREE_QUERY, {
          owner: ref.owner,
          name: ref.repo,
          expression: `${repo.defaultBranch}:${dir}`,
        });
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        if (!isEmptyRepo(error))
          return {
            status: 502,
            body: { slug: repo.slug, dir, error: error.reason ?? error.message, github: error.status },
          };
        data = null;
      }
      const entries = data?.repository?.object?.entries;
      const blob = (path) => `https://github.com/${repo.github}/blob/${encodeURIComponent(repo.defaultBranch)}/${path}`;
      const files = (entries ?? []).filter((e) => e.type === 'blob');
      const readme = files.find((e) => e.name.toLowerCase() === 'readme.md');
      kept = {
        at: Date.now(),
        dir,
        branch: repo.defaultBranch,
        missing: !Array.isArray(entries),
        readme: readme ? { path: `${dir}/${readme.name}`, url: blob(`${dir}/${readme.name}`) } : null,
        specs: files
          .filter((e) => isSpecFile(e.name))
          .map((e) => {
            const size = e.object?.byteSize ?? null;
            const tooLarge = size !== null && size > SPEC_MAX_BYTES;
            const readable = !tooLarge && !e.object?.isBinary && typeof e.object?.text === 'string';
            const path = `${dir}/${e.name}`;
            return {
              path,
              name: e.name,
              ...specMeta(e.name, readable ? e.object.text : null),
              size,
              tooLarge,
              url: blob(path),
            };
          })
          .sort(bySpecOrder),
      };
      // A directory that isn't there isn't kept, so adding it shows at once.
      if (!kept.missing) this.specsCache[key] = kept;
    }
    const tasks = this.specTasks(repo);
    return {
      status: 200,
      body: {
        slug: repo.slug,
        dir,
        branch: kept.branch,
        missing: kept.missing,
        readme: kept.readme,
        specs: kept.specs.map((s) => ({ ...s, tasks: tasks.get(s.path) ?? [] })),
      },
    };
  },

  /**
   * `GET /api/specs/<path>?repo=<slug>`: one spec, its Markdown, the commit that last changed it, its GitHub
   * link, and the tasks that link it. The path must be a Markdown file directly in the specs directory (a 400
   * otherwise); one that isn't on the default branch is a 404. A file over 1 MB has no text, only its link.
   */
  async specApi(slug, rawPath) {
    const setup = await this.specsSetup(slug);
    if (setup.error) return setup.error;
    const { repo, dir, credentials } = setup;
    const path = normalPath(rawPath);
    if (!inSpecsDir(dir, path))
      return {
        status: 400,
        body: { slug: repo.slug, dir, error: `${path.slice(0, 200) || 'that'} isn’t a Markdown file in ${dir}` },
      };
    const key = `${repo.slug}\n${path}`;
    let kept = this.specsCache[key];
    if (!kept || kept.branch !== repo.defaultBranch || Date.now() - kept.at >= SPECS_CACHE_MS) {
      const client = this.githubClient(credentials, repo);
      const branch = encodeURIComponent(repo.defaultBranch);
      const [file, commits] = await Promise.allSettled([
        client.get(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`),
        client.get(`/commits?sha=${branch}&path=${encodeURIComponent(path)}&per_page=1`),
      ]);
      for (const r of [file, commits])
        if (r.status === 'rejected' && !(r.reason instanceof GitHubError)) throw r.reason;
      const head = { slug: repo.slug, dir, path };
      const notThere = { status: 404, body: { ...head, error: `no spec at ${path} on ${repo.defaultBranch}` } };
      if ([file, commits].some((r) => r.status === 'rejected' && isEmptyRepo(r.reason))) return notThere;
      if (file.status === 'rejected') {
        // A 404 on the file while the history reads is a missing file; GitHub answers 404 for a repository it hides too.
        if (file.reason.status === 404 && commits.status === 'fulfilled') return notThere;
        return {
          status: 502,
          body: { ...head, error: file.reason.reason ?? file.reason.message, github: file.reason.status },
        };
      }
      if (Array.isArray(file.value) || file.value?.type === 'dir') return notThere;
      const size = Number(file.value.size ?? 0);
      const tooLarge = size > SPEC_MAX_BYTES || file.value.encoding === 'none';
      const text = tooLarge
        ? null
        : new TextDecoder().decode(
            Uint8Array.from(atob(String(file.value.content ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)),
          );
      const last = commits.status === 'fulfilled' ? commits.value[0] : null;
      const name = path.slice(dir.length + 1);
      kept = {
        at: Date.now(),
        branch: repo.defaultBranch,
        body: {
          ...head,
          name,
          ...specMeta(name, text),
          text,
          size,
          tooLarge,
          url: file.value.html_url ?? `https://github.com/${repo.github}/blob/${branch}/${path}`,
          commit: last
            ? {
                sha: last.sha,
                url: last.html_url ?? null,
                date: last.commit?.committer?.date ?? null,
                message: String(last.commit?.message ?? '').split('\n')[0],
              }
            : null,
        },
      };
      this.specsCache[key] = kept;
    }
    return { status: 200, body: { ...kept.body, tasks: this.specTasks(repo).get(path) ?? [] } };
  },
};
