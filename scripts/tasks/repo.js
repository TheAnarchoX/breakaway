/**
 * Which repository the CLI works in (docs/specs/IDEA-14-multi-repo.md, section 5; CLD-123): the
 * checkout's, from `git remote get-url origin`, matched against the board's registry. `--repo` or
 * BREAKAWAY_REPO (or SAMEWAVE_TASKS_REPO) overrides it. Pure, so it's tested without git or the board.
 */

/**
 * The `owner/name` a remote URL ends with, or null. Covers https (`https://github.com/o/n.git`),
 * ssh (`git@github.com:o/n.git`, `ssh://git@github.com/o/n`), and a cloud session's proxied remote
 * (`http://local_proxy@127.0.0.1:port/git/o/n`), which all end the same way.
 */
export function githubFromRemote(remote) {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/u.exec(String(remote ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The repository's slug, or null to behave as before repositories (an old board without
 * `/api/repos`, or a checkout the board doesn't know).
 *
 * named: `--repo` or BREAKAWAY_REPO; remote: the origin URL; registry: GET /api/repos's body, or
 * null when the board doesn't have it. Naming a repository the board doesn't have throws, with the list.
 */
export function pickRepo({ named, remote, registry }) {
  if (!registry?.repos?.length) return null;
  if (named) {
    const slug = String(named).trim().toLowerCase();
    if (!registry.repos.some((r) => r.slug === slug))
      throw new Error(
        `no repository "${slug.slice(0, 40)}" on the board; it has ${registry.repos.map((r) => r.slug).join(', ')}. The owner registers one with npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>`,
      );
    return slug;
  }
  const github = githubFromRemote(remote)?.toLowerCase();
  return (github && registry.repos.find((r) => r.github.toLowerCase() === github)?.slug) || null;
}

/** Whether a task (as the API lists it) is in `slug`; a task without `repo` is the default repository's. */
export const inRepo = (task, slug, registry) => (task.repo || registry?.default) === slug;
