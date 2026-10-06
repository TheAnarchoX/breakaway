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
      pipelinesFound: data.pipelineFound ? [data] : [],
      moves: isMoving(data) ? [data] : [],
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
    // What the runs staged on npm (BRK-101, WEB-18); an answer from before the feed has none.
    packages: mine(data.packages ?? []),
    flows: shown.filter((r) => r.flow),
    // Repositories with no commits yet (CLD-191): each says to run repos init.
    empties: shown.filter((r) => r.empty),
    // Repositories whose pre-releases count from package.json (BRK-100): each offers its next minor and major.
    nextVersions: shown.filter((r) => r.nextVersion),
    // Repositories whose move to the deploy flow merged, not on yet (WEB-13): each offers Turn on deploys.
    pipelinesFound: shown.filter((r) => r.pipelineFound),
    // Repositories without a pipeline (WEB-12): each shows Deploy with breakaway, or Turn on deploys once it merged.
    moves: shown.filter(isMoving),
    pipeline: one ? one.pipeline : shown.some((r) => r.pipeline) ? {} : null,
    branch: branches.length === 1 ? branches[0] : null,
  };
}

/** Whether a repository's facts show the Deploy with breakaway card: no pipeline, some commits, and a move or its files. */
const isMoving = (r) => !r.pipeline && !r.empty && Boolean(r.move || r.pipelineFound);

/** One repository's own facts (access, pipeline, default or not) from the answer, by slug (null: the default). */
export function repoFacts(data, slug = null) {
  if (!data) return null;
  if (!data.all) return data;
  return data.repos.find((r) => (slug ? r.slug === slug : r.isDefault)) ?? null;
}

/** A workflow run's state: 'pending' while it runs, else its conclusion ('success', 'failure', …). */
export function runState(run) {
  if (run.status !== 'completed') return 'pending';
  return run.conclusion ?? 'neutral';
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Checks on main for the dashboard (WEB-17): each workflow's latest run on its repository's default
 * branch, failures first, then the ones still running, then the rest, by name. `view` is scopeGitHub's.
 */
export function checksOnMain(view) {
  if (!view) return [];
  const branchOf = (run) => (run.repo && view.repos?.find((r) => r.slug === run.repo)?.branch) || view.branch || 'main';
  const latest = new Map();
  for (const run of view.runs ?? []) {
    if (run.branch !== branchOf(run)) continue;
    const key = `${run.repo ?? ''}\n${run.name}`;
    const seen = latest.get(key);
    if (!seen || String(run.created).localeCompare(String(seen.created)) > 0) latest.set(key, run);
  }
  const rank = (run) => {
    const state = runState(run);
    return FAILED.has(state) ? 0 : state === 'pending' ? 1 : 2;
  };
  return [...latest.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || String(a.repo ?? '').localeCompare(String(b.repo ?? '')) || a.name.localeCompare(b.name),
  );
}

/** How checks on main add up: failing, running, and passing (skipped and cancelled count as neither). */
export function checksSummary(checks) {
  const out = { failing: 0, running: 0, passing: 0 };
  for (const run of checks) {
    const state = runState(run);
    if (FAILED.has(state)) out.failing += 1;
    else if (state === 'pending') out.running += 1;
    else if (state === 'success') out.passing += 1;
  }
  return out;
}

/**
 * The GitHub view's tabs under the dashboard (WEB-17), in order, each with the count its label shows.
 * Releases and Deploys only where a repository in view has a pipeline, Packages only where one has staged a package.
 */
export function githubTabs(view) {
  if (!view) return [];
  const tabs = [];
  if (view.flows?.length || view.nextVersions?.length) tabs.push({ id: 'releases', label: 'Releases', count: null });
  if (view.pipeline) tabs.push({ id: 'deploys', label: 'Deploys', count: view.deploys?.length ?? 0 });
  if (view.packages?.length) tabs.push({ id: 'packages', label: 'Packages', count: view.packages.length });
  tabs.push(
    { id: 'completed', label: 'Recently completed', count: view.closed?.length ?? 0 },
    { id: 'runs', label: 'Runs', count: view.runs?.length ?? 0 },
    { id: 'commits', label: view.branch ? `Commits on ${view.branch}` : 'Commits', count: view.commits?.length ?? 0 },
  );
  return tabs;
}

/** The tab to show: the one asked for when it's there, else the first. */
export function pickTab(tabs, wanted) {
  return tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? null;
}

/** Whether a version is a pre-release (`1.3.0-main.4`): a hyphen before any build metadata. */
export function isPrerelease(version) {
  return String(version).split('+')[0].includes('-');
}

/**
 * The Packages tile (WEB-18): for each package in view, its latest pre-release and latest release (null when it has
 * none), staged or published, its page on npm, and how many of its versions wait for approval there. By repository, then name.
 * `view` is scopeGitHub's; its packages come newest first, but they're sorted here so the order never matters.
 */
export function latestPackages(view) {
  const byPackage = new Map();
  const versions = [...(view?.packages ?? [])].sort((a, b) => String(b.staged).localeCompare(String(a.staged)));
  for (const v of versions) {
    const key = `${v.repo ?? ''}\n${v.name}`;
    // A staged version's link is its package's page on npm, where Staged Packages is; a published one's is its own.
    const url = v.url ? String(v.url).replace(/\/v\/[^/]+$/u, '') : null;
    if (!byPackage.has(key))
      byPackage.set(key, { repo: v.repo, name: v.name, url, prerelease: null, release: null, waiting: 0 });
    const p = byPackage.get(key);
    const kind = isPrerelease(v.version) ? 'prerelease' : 'release';
    if (!p[kind]) p[kind] = v;
    if (v.state === 'staged') p.waiting += 1;
  }
  return [...byPackage.values()].sort(
    (a, b) => String(a.repo ?? '').localeCompare(String(b.repo ?? '')) || a.name.localeCompare(b.name),
  );
}

/** A pre-release the release flow stages and Release offers, `X.Y.Z-main.N` (src/release.js stableOf). */
const RELEASABLE = /^\d+\.\d+\.\d+-main\.\d+$/u;

/**
 * Where Release is missing because the release flow is off (WEB-81): each repository in view whose pipeline names no
 * npm package (`releasePackage` null) but whose feed has pre-releases Release would offer, with those packages' names.
 * An answer from before `releasePackage` says nothing, so it's left out. `view` is scopeGitHub's.
 * @returns {{ slug: string, name: string, packages: string[] }[]}
 */
export function releaseSetups(view) {
  if (!view) return [];
  const shown = view.all ? (view.repos ?? []) : [view];
  return shown
    .filter((r) => r.releasePackage === null)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      packages: [
        ...new Set(
          (view.packages ?? [])
            .filter((v) => (v.repo ?? r.slug) === r.slug && RELEASABLE.test(String(v.version)))
            .map((v) => v.name),
        ),
      ].sort(),
    }))
    .filter((r) => r.packages.length > 0);
}
