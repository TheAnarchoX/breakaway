/**
 * The release flow on the GitHub view (docs/specs/IDEA-10-promote-releases.md, CLD-105): what
 * staging and production run, what a promote would carry, and whether Promote and Roll back may
 * be pressed. Pure functions over the stored Deployments, so they're tested without GitHub. The
 * workflows decide for real (promote.yml re-checks everything); this only explains and
 * disables buttons early, with the reason.
 */
import { candidate, checkCandidate, productionSha } from './promote.js';
import { shippedPrs } from './github.js';
import { isPackageName } from './packages.js';
import { compareVersions } from './versions.js';

const NAME = /^[\w.-]{1,100}$/u;
const name = (value) => (typeof value === 'string' && NAME.test(value) ? value : null);

/**
 * A repository's deploy pipeline from its registry row (docs/specs/IDEA-14-multi-repo.md, section 1), or
 * null when it has none: then the GitHub view shows no Releases, Promote, or Roll back, and merging
 * deploys nothing. `staging` and `production` are the Workers (the Deployments' environments), and the
 * workflows are the files Promote and Roll back start on the default branch.
 */
export function pipelineOf(repo) {
  const p = repo?.pipeline;
  if (!p || typeof p !== 'object') return null;
  const staging = name(p.workers?.staging);
  const production = name(p.workers?.production);
  if (!staging || !production) return null;
  return {
    staging,
    production,
    promote: name(p.workflows?.promote) ?? 'promote.yml',
    rollback: name(p.workflows?.rollback) ?? 'rollback.yml',
    deployPaths: typeof p.deployPaths === 'string' && p.deployPaths ? p.deployPaths : null,
    branch: repo.defaultBranch || 'main',
  };
}

/**
 * The npm package a repository releases, from its pipeline (BRK-103, IDEA-27 section 2b), or null when it releases
 * none: then the GitHub page offers no Release. `workflow` is the file whose stable job Release starts on the default
 * branch, and `prefix` is how its tags start, as the rendered release.yml has it: `<package>@` beside a Worker's
 * deploys (which tag `v…` themselves), `v` for a repository that only releases.
 */
export function packageOf(repo) {
  const p = repo?.pipeline;
  if (!p || typeof p !== 'object' || !isPackageName(p.package)) return null;
  return {
    name: p.package,
    workflow: name(p.workflows?.release) ?? 'release.yml',
    prefix: pipelineOf(repo) ? `${p.package}@` : 'v',
    branch: repo.defaultBranch || 'main',
  };
}

/** A pre-release the release flow stages, `X.Y.Z-main.N`, and the stable `X.Y.Z` it becomes. */
const PRERELEASE = /^(\d+\.\d+\.\d+)-main\.\d+$/u;
export const stableOf = (version) => PRERELEASE.exec(String(version ?? ''))?.[1] ?? null;

/** What the stable job's `next` input takes: patch counts by itself, minor or major opens the pull request that sets it. */
export const NEXT_STEPS = ['patch', 'minor', 'major'];

/** The version each next step makes main work toward after stable `X.Y.Z`. */
export function nextAfter(stable) {
  const [maj, min, pat] = stable.split('.').map(Number);
  return [
    { next: 'patch', version: `${maj}.${min}.${pat + 1}` },
    { next: 'minor', version: `${maj}.${min + 1}.0` },
    { next: 'major', version: `${maj + 1}.0.0` },
  ];
}

const preNumber = (version) => Number(String(version).split('-main.')[1]);

/**
 * Release on one pre-release of a package (WEB-39, IDEA-27 section 2b), worked out from the Packages feed: `versions`
 * are the feed's `{ version, state }` for that package. Null for anything but a pre-release.
 *
 * - `superseded`: once `X.Y.Z` is staged or published, npm can't take it again, so every `X.Y.Z-main.N` is blocked.
 *   `from` is the pre-release it was released from, when `from` (stable to pre-release) knows it. A stable that failed
 *   or was never staged isn't in the feed, and blocks nothing.
 * - `leavesOut`: the later pre-releases of the same `X.Y.Z`, which aren't in this stable and ship in the next
 *   version's pre-releases instead.
 * - `next`: what main works toward afterwards. `ask` with the three choices, or already set, with `why`: a pre-release
 *   of a later version is out (`prerelease`, the newest), or an open +version task (`preparing`) is setting it. Then it
 *   releases with patch.
 * @param {{ version: string, state: string }[]} versions
 * @param {string} version
 * @param {{ from?: Record<string, string>, preparing?: { uuid: string, wid?: string | null, short?: string, version?: string | null } | null }} [context]
 */
export function releaseOffer(versions, version, { from = {}, preparing = null } = {}) {
  const stable = stableOf(version);
  if (!stable) return null;
  const out = versions.find((v) => v.version === stable && ['staged', 'published'].includes(v.state));
  if (out) {
    return {
      stable,
      allowed: false,
      superseded: { version: stable, state: out.state, from: from[stable] ?? null },
      leavesOut: [],
      next: null,
    };
  }
  const n = preNumber(version);
  const leavesOut = versions
    .filter((v) => stableOf(v.version) === stable && preNumber(v.version) > n)
    .map((v) => v.version)
    .sort((a, b) => preNumber(a) - preNumber(b));
  const later = versions
    .filter((v) => stableOf(v.version) && compareVersions(/** @type {string} */ (stableOf(v.version)), stable) > 0)
    .map((v) => v.version)
    .sort(compareVersions);
  let next;
  if (later.length) {
    const newest = later[later.length - 1];
    next = { ask: false, version: stableOf(newest), why: 'prerelease', prerelease: newest };
  } else if (preparing) {
    next = { ask: false, version: preparing.version ?? null, why: 'preparing', task: preparing };
  } else {
    next = { ask: true, choices: nextAfter(stable) };
  }
  return { stable, allowed: true, superseded: null, leavesOut, next };
}

/**
 * Which pre-release each stable was released from, by the commit its tags point at (a stable is the same commit as
 * its pre-release), then by the board's own Release events. `tags` are `{ name, sha }`, `events` the release_started
 * events' data, and `prefix` how the package's tags start.
 * @param {{ name: string, sha?: string | null }[]} tags
 * @param {{ prerelease?: string, version?: string }[]} events
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
export function releasedFrom(tags, events, prefix) {
  /** @type {Record<string, string>} */
  const from = {};
  for (const e of events)
    if (e.version && e.prerelease && stableOf(e.prerelease) === e.version) from[e.version] = e.prerelease;
  const named = (t) => (t.name?.startsWith(prefix) ? t.name.slice(prefix.length) : null);
  const bySha = new Map();
  for (const t of tags) {
    const v = named(t);
    if (v && stableOf(v) && t.sha) bySha.set(`${t.sha}\n${stableOf(v)}`, v);
  }
  for (const t of tags) {
    const v = named(t);
    if (v && /^\d+\.\d+\.\d+$/u.test(v) && t.sha && bySha.has(`${t.sha}\n${v}`)) from[v] = bySha.get(`${t.sha}\n${v}`);
  }
  return from;
}

const PENDING = new Set(['', 'queued', 'pending', 'in_progress', 'waiting']);
const FAILED = new Set(['failure', 'error']);
const short = (sha) => String(sha ?? '').slice(0, 7);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a card says about its environment: the latest attempt, and the build that is live. */
export function cardFor(deploys, env, { runs = [], compareUrl = null } = {}) {
  const mine = deploys
    .filter((d) => d.env === env && ['deploy', 'rollback'].includes(d.task) && d.state !== 'inactive')
    .sort((a, b) => b.id - a.id);
  const latest = mine[0] ?? null;
  const live = mine.find((d) => d.landed) ?? null;
  let state = 'none';
  if (latest) {
    if (PENDING.has(latest.state)) state = 'deploying';
    else if (latest.landed) state = latest.task === 'rollback' ? 'rolledback' : 'live';
    else if (FAILED.has(latest.state)) state = /rolled back/iu.test(latest.description ?? '') ? 'rolledback' : 'failed';
    else state = 'live';
  }
  const ci = live
    ? runs
        .filter((r) => r.name === 'CI' && r.sha === live.sha)
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0]
    : null;
  return {
    env,
    state,
    step:
      state === 'deploying'
        ? String(latest.description ?? 'starting')
            .replace(/^promoting:\s*/iu, '')
            .replace(/^Deploying .*/u, 'starting')
        : null,
    attempt:
      latest && state !== 'live'
        ? {
            sha: latest.sha,
            sha7: short(latest.sha),
            description: latest.description,
            url: latest.logUrl,
            at: latest.updated,
          }
        : null,
    build: live && {
      id: live.id,
      sha: live.sha,
      sha7: short(live.sha),
      version: live.version,
      at: live.updated,
      url: live.logUrl,
      preRelease: /pre-release/iu.test(live.description ?? ''),
      migrations: live.migrations && live.migrations !== 'none' ? live.migrations : null,
      deploy: { passed: true, at: live.updated },
      ci: ci
        ? {
            state: ci.status !== 'completed' ? 'pending' : ci.conclusion === 'success' ? 'success' : 'failure',
            url: ci.url,
          }
        : null,
    },
    commitUrl: live && compareUrl ? `${compareUrl}/commit/${live.sha}` : null,
  };
}

/** The commits a promote would carry, as the stored compare of production's commit and the candidate's. */
function aheadFrom(compare, prs) {
  if (!compare) return null;
  const commits = (compare.commits ?? []).filter((c) => !/^Merge (remote-tracking )?branch /u.test(c.message ?? ''));
  const merged = shippedPrs(prs, compare.commits ?? []);
  const tasks = new Map();
  for (const pr of merged) {
    const known = new Map((pr.tasks ?? []).map((t) => [t.wid, t]));
    for (const wid of new Set([...(pr.closes ?? []), ...(pr.tasks ?? []).filter((t) => t.closes).map((t) => t.wid)]))
      tasks.set(wid, { wid, title: known.get(wid)?.description ?? null });
  }
  return {
    from: compare.from,
    to: compare.to,
    merges: merged.length || commits.length,
    commits: commits.length,
    tasks: [...tasks.values()],
    prs: merged.map((pr) => ({ number: pr.number, title: pr.title })),
    migrations: compare.migrations ?? [],
    destructive: compare.destructive ?? [],
    config: Boolean(compare.config),
  };
}

/** The line between the cards: what pressing Promote would do, in words. */
export function lineFor(candidateSha, productionLive, ahead) {
  if (!candidateSha) return 'Nothing on staging to promote yet.';
  if (productionLive && productionLive === candidateSha) return 'Production is up to date with staging.';
  if (!ahead)
    return productionLive
      ? `Promoting would put ${short(candidateSha)} in production.`
      : `Production has no recorded deploy yet. Promoting would put ${short(candidateSha)} in production.`;
  const bits = [plural(ahead.merges, 'merge')];
  if (ahead.tasks.length) bits.push(plural(ahead.tasks.length, 'task'));
  bits.push(ahead.migrations.length ? plural(ahead.migrations.length, 'migration') : 'no migrations');
  return `Staging is ${bits[0]} ahead: ${bits.slice(1).join(', ')}.`;
}

/**
 * The whole flow. `deploys`: stored Deployments (any order). `compare`: { from, to, commits, migrations,
 * destructive, config } for production's commit and the candidate, or null. `prs`: stored pull requests
 * with their `tasks`. `workers`: the repository's staging and production Workers (pipelineOf). `paused`
 * isn't known here: the workflow says so in its first step.
 */
export function buildFlow({ deploys, compare = null, prs = [], runs = [], repoUrl = null, workers }) {
  const newestFirst = [...deploys].sort((a, b) => b.id - a.id);
  const staging = cardFor(newestFirst, workers.staging, { runs, compareUrl: repoUrl });
  const production = cardFor(newestFirst, workers.production, { runs, compareUrl: repoUrl });
  // A stale `pending` Deployment (a run that ended without a final status) must not block a newer success.
  const stagingLatest = newestFirst.find(
    (d) => d.env === workers.staging && ['deploy', 'rollback'].includes(d.task),
  )?.id;
  const stagingDeploys = newestFirst.filter(
    (d) => d.env === workers.staging && (!PENDING.has(d.state ?? '') || d.id === stagingLatest),
  );
  const productionDeploys = newestFirst.filter((d) => d.env === workers.production);
  const cand = candidate(stagingDeploys);
  const live = productionSha(productionDeploys);
  const ahead = cand && compare && compare.to === cand.sha && compare.from === live ? aheadFrom(compare, prs) : null;

  // Promote: the same refusals as promote.yml's first step, minus what only GitHub knows.
  let promote;
  const tried = cand
    ? productionDeploys.find((d) => d.sha === cand.sha && d.task === 'deploy' && FAILED.has(d.state))
    : null;
  if (!cand)
    promote = { allowed: false, reason: 'Nothing on staging yet. Merge a pull request and let staging deploy.' };
  else if (staging.state === 'deploying')
    promote = { allowed: false, reason: 'Staging is still deploying. Try again when it’s done.' };
  else if (production.state === 'deploying')
    promote = { allowed: false, reason: 'A promote or rollback is already running.' };
  else if (live === cand.sha) promote = { allowed: false, reason: 'Production already runs this build.' };
  else {
    const check = checkCandidate({
      sha: cand.sha,
      staging: stagingDeploys,
      production: productionDeploys,
      artifactDigest: null,
    });
    // No release artifact recorded (the first staging build after the cutover) can't be promoted.
    promote = check.ok ? { allowed: true, reason: null } : { allowed: false, reason: check.reason };
  }
  promote.sha = cand?.sha ?? null;
  promote.tried = tried
    ? { at: tried.updated, rolledBack: /rolled back/iu.test(tried.description ?? ''), url: tried.logUrl }
    : null;

  // Roll back: the versions production has run before, newest first, without the live one.
  const liveDeploy = productionDeploys.find((d) => (d.task === 'deploy' || d.task === 'rollback') && d.landed);
  const seen = new Set([liveDeploy?.version]);
  const versions = [];
  for (const d of productionDeploys) {
    if (
      !d.landed ||
      !d.version ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(d.version) ||
      seen.has(d.version)
    )
      continue;
    seen.add(d.version);
    versions.push({
      version: d.version,
      sha: d.sha,
      sha7: short(d.sha),
      at: d.updated,
      rollback: d.task === 'rollback',
    });
  }
  let rollback;
  if (!liveDeploy) rollback = { allowed: false, reason: 'Production has no recorded deploy to go back from.' };
  else if (production.state === 'deploying')
    rollback = { allowed: false, reason: 'A promote or rollback is running. Roll back when it’s finished.' };
  else if (!versions.length) rollback = { allowed: false, reason: 'No earlier version is on record.' };
  else rollback = { allowed: true, reason: null };
  rollback.versions = versions.slice(0, 5);

  return {
    staging,
    production,
    candidate: cand ? { sha: cand.sha, sha7: short(cand.sha) } : null,
    line: lineFor(cand?.sha, live, ahead),
    ahead,
    promote,
    rollback,
  };
}

/** Migration files in a compare, and which carry an owner approval line (destructive); the Promote dialog names them. */
export function compareFacts(compare) {
  const files = compare.files ?? [];
  const migrations = files.filter((f) => /^migrations\/.+\.sql$/u.test(f.filename) && f.status !== 'removed');
  return {
    commits: (compare.commits ?? []).map((c) => ({ sha: c.sha, message: (c.commit?.message ?? '').split('\n')[0] })),
    migrations: migrations.map((f) => f.filename.replace(/^migrations\//u, '')),
    destructive: migrations
      .filter((f) => /^\+[ \t]*--[ \t]*owner-approved:[ \t]*\S/mu.test(f.patch ?? ''))
      .map((f) => f.filename.replace(/^migrations\//u, '')),
    config: files.some((f) => /^wrangler(\.[a-z]+)?\.jsonc$/u.test(f.filename)),
  };
}
