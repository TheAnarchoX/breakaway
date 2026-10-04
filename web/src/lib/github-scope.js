// The GitHub view for the repository the switcher shows (CLD-125). With several repositories the board
// loads them all at once (GET /api/github?repo=all) and picks one here, so the pull request settings
// see every repository's pull requests whichever one is on screen. Pure, so it's tested in the Workers pool.

/** How many of each list the view keeps for one repository, as the server does. */
const KEEP = { closed: 20, runs: 40, deploys: 20, commits: 30 };

/**
 * `data`: the answer from /api/github (one repository's, or `all: true`). `scope`: a repository's slug, or
 * null for every one. Returns the view's data: one repository's facts (sync, pipeline, flow, access), its
 * lists, and `flows`, the release flows to show (each with its repository's slug, name, and access).
 */
export function scopeGitHub(data, scope = null) {
  if (!data) return data;
  if (!data.all)
    return {
      ...data,
      flows: data.flow ? [data] : [],
      empties: data.empty ? [data] : [],
      nextVersions: data.nextVersion ? [data] : [],
    };
  const one = scope ? (data.repos.find((r) => r.slug === scope) ?? null) : null;
  const mine = (list, keep) => {
    const kept = one ? list.filter((x) => x.repo === one.slug) : list;
    return keep ? kept.slice(0, keep) : kept;
  };
  const open = mine(data.open);
  const shown = one ? [one] : data.repos;
  const branches = [...new Set(shown.map((r) => r.branch))];
  return {
    ...data,
    ...(one ?? {}),
    all: !one,
    open,
    readyToMerge: open.filter((p) => p.verdict === 'ready').length,
    closed: mine(data.closed, KEEP.closed),
    runs: mine(data.runs, KEEP.runs),
    deploys: mine(data.deploys, KEEP.deploys),
    commits: mine(data.commits, KEEP.commits),
    alerts: mine(data.alerts),
    flows: shown.filter((r) => r.flow),
    // Repositories with no commits yet (CLD-191): each says to run repos init.
    empties: shown.filter((r) => r.empty),
    // Repositories whose pre-releases count from package.json (BRK-100): each offers its next minor and major.
    nextVersions: shown.filter((r) => r.nextVersion),
    pipeline: one ? one.pipeline : shown.some((r) => r.pipeline) ? {} : null,
    branch: branches.length === 1 ? branches[0] : null,
  };
}

/** One repository's own facts (access, pipeline, default or not) from the answer, by slug (null: the default). */
export function repoFacts(data, slug = null) {
  if (!data) return null;
  if (!data.all) return data;
  return data.repos.find((r) => (slug ? r.slug === slug : r.isDefault)) ?? null;
}
