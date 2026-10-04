import { describe, expect, it } from 'vitest';
import {
  checksOnMain,
  checksSummary,
  githubTabs,
  isPrerelease,
  latestPackages,
  pickTab,
  repoFacts,
  runState,
  scopeGitHub,
} from '../web/src/lib/github-scope.js';

// The GitHub view for the repository the switcher shows (CLD-125), from one answer for all of them.
const pr = (repo, number, verdict = 'running') => ({ repo, number, verdict, state: 'open' });
const flow = { staging: {}, production: {} };
const all = {
  connected: true,
  all: true,
  repo: null,
  slug: null,
  open: [pr('widgets', 1, 'ready'), pr('scratch', 1, 'ready'), pr('scratch', 2)],
  closed: Array.from({ length: 30 }, (_, i) => ({
    repo: i % 2 ? 'scratch' : 'widgets',
    number: 100 + i,
    state: 'merged',
  })),
  runs: [{ repo: 'scratch', id: 1 }],
  deploys: [{ repo: 'widgets', id: 9 }],
  commits: [],
  alerts: [{ repo: 'scratch', number: 3 }],
  repos: [
    {
      slug: 'widgets',
      name: 'widgets',
      repo: 'acme/widgets',
      isDefault: true,
      branch: 'main',
      pipeline: { staging: 'widgets-staging', production: 'widgets' },
      flow,
      access: { write: { ok: true } },
    },
    {
      slug: 'scratch',
      name: 'scratch',
      repo: 'acme/scratch',
      isDefault: false,
      branch: 'trunk',
      pipeline: null,
      flow: null,
      access: { write: { ok: false, reason: 'no' } },
    },
  ],
};

describe('the GitHub view per repository', () => {
  it('passes one repository’s answer through, with its flow', () => {
    const one = { connected: true, repo: 'acme/widgets', flow, open: [] };
    expect(scopeGitHub(one, null)).toEqual({ ...one, flows: [one], empties: [], nextVersions: [] });
    // Pre-releases counted from package.json (BRK-100): it offers the next version.
    const counted = { ...one, nextVersion: { base: '1.1.2' } };
    expect(scopeGitHub(counted, null).nextVersions).toEqual([counted]);
    expect(scopeGitHub({ ...one, flow: null }, null).flows).toEqual([]);
    // No commits yet (CLD-191): the view says to run repos init.
    expect(scopeGitHub({ ...one, empty: true }, null).empties).toEqual([{ ...one, empty: true }]);
    expect(scopeGitHub(null, null)).toBeNull();
  });

  it('shows every repository under All, and one when the switcher picks it', () => {
    const every = scopeGitHub(all, null);
    expect(every).toMatchObject({ all: true, readyToMerge: 2, branch: null, pipeline: {} });
    expect(every.closed).toHaveLength(20);
    expect(every.flows.map((r) => r.slug)).toEqual(['widgets']);
    expect(every.empties).toEqual([]);
    expect(
      scopeGitHub(
        { ...all, repos: all.repos.map((r) => (r.slug === 'scratch' ? { ...r, empty: true } : r)) },
        null,
      ).empties.map((r) => r.slug),
    ).toEqual(['scratch']);

    const scratch = scopeGitHub(all, 'scratch');
    expect(scratch).toMatchObject({
      all: false,
      slug: 'scratch',
      repo: 'acme/scratch',
      pipeline: null,
      branch: 'trunk',
      readyToMerge: 1,
      flows: [],
    });
    expect(scratch.open.map((p) => p.number)).toEqual([1, 2]);
    expect(scratch.closed.every((p) => p.repo === 'scratch')).toBe(true);
    expect(scratch.deploys).toEqual([]);
    expect(scratch.alerts).toHaveLength(1);
  });

  it('finds a repository’s own facts', () => {
    expect(repoFacts(all, null).slug).toBe('widgets');
    expect(repoFacts(all, 'scratch').access.write.ok).toBe(false);
    expect(repoFacts(all, 'nowhere')).toBeNull();
    const one = { repo: 'x' };
    expect(repoFacts(one, 'anything')).toBe(one);
  });
});

// The dashboard at the top of the GitHub view, and the tabs under it (WEB-17).
const run = (repo, name, branch, created, status = 'completed', conclusion = 'success') => ({
  repo,
  name,
  branch,
  created,
  status,
  conclusion,
});

describe('the GitHub dashboard', () => {
  it('reads a run’s state', () => {
    expect(runState({ status: 'in_progress', conclusion: null })).toBe('pending');
    expect(runState({ status: 'completed', conclusion: 'failure' })).toBe('failure');
    expect(runState({ status: 'completed', conclusion: null })).toBe('neutral');
  });

  it('keeps each workflow’s latest run on the default branch, failures first', () => {
    const view = {
      branch: 'main',
      runs: [
        run(undefined, 'CI', 'main', '2026-10-01T10:00:00Z', 'completed', 'failure'),
        run(undefined, 'CI', 'main', '2026-10-02T10:00:00Z'),
        run(undefined, 'CI', 'feature', '2026-10-03T10:00:00Z', 'completed', 'failure'),
        run(undefined, 'Deploy', 'main', '2026-10-02T09:00:00Z', 'in_progress', null),
        run(undefined, 'CodeQL', 'main', '2026-10-01T09:00:00Z', 'completed', 'timed_out'),
      ],
    };
    const checks = checksOnMain(view);
    expect(checks.map((r) => r.name)).toEqual(['CodeQL', 'Deploy', 'CI']);
    expect(checks.find((r) => r.name === 'CI').created).toBe('2026-10-02T10:00:00Z');
    expect(checksSummary(checks)).toEqual({ failing: 1, running: 1, passing: 1 });
    expect(checksOnMain(null)).toEqual([]);
    expect(checksOnMain({ runs: [run(undefined, 'CI', 'main', 'x')] })).toHaveLength(1);
  });

  it('uses each repository’s own default branch under All', () => {
    const every = scopeGitHub(
      {
        ...all,
        runs: [
          run('widgets', 'CI', 'main', '2026-10-01T10:00:00Z'),
          run('scratch', 'CI', 'trunk', '2026-10-01T10:00:00Z', 'completed', 'failure'),
          run('scratch', 'CI', 'main', '2026-10-02T10:00:00Z'),
        ],
      },
      null,
    );
    expect(checksOnMain(every).map((r) => `${r.repo}:${r.branch}`)).toEqual(['scratch:trunk', 'widgets:main']);
  });

  it('shows Releases and Deploys only with a pipeline, and falls back to the first tab', () => {
    const every = scopeGitHub(all, null);
    expect(githubTabs(every).map((t) => t.id)).toEqual(['releases', 'deploys', 'completed', 'runs', 'commits']);
    expect(githubTabs(every).find((t) => t.id === 'completed').count).toBe(20);
    expect(githubTabs(every).at(-1).label).toBe('Commits');
    const scratch = githubTabs(scopeGitHub(all, 'scratch'));
    expect(scratch.map((t) => t.id)).toEqual(['completed', 'runs', 'commits']);
    expect(scratch.at(-1).label).toBe('Commits on trunk');
    expect(pickTab(scratch, 'releases')).toBe('completed');
    expect(pickTab(scratch, 'runs')).toBe('runs');
    expect(pickTab([], 'runs')).toBeNull();
    expect(githubTabs(null)).toEqual([]);
  });

  it('shows Releases for a repository whose next version can be prepared, even with no release flow', () => {
    const tabs = githubTabs({ flows: [], nextVersions: [{ slug: 'scratch' }], closed: [], runs: [], commits: [] });
    expect(tabs[0].id).toBe('releases');
  });
});

// Packages on the GitHub view (WEB-18): the latest pre-release and release per package, and the Packages tab.
const ver = (repo, name, version, staged, state = 'published', tag = version.includes('-') ? 'next' : 'latest') => ({
  repo,
  name,
  version,
  tag,
  state,
  staged,
  run: { id: 1, url: null, workflow: 'Release', number: 1 },
  url: `https://www.npmjs.com/package/${name}${state === 'published' ? `/v/${version}` : ''}`,
});

describe('packages on the GitHub view', () => {
  it('tells a pre-release from a release', () => {
    expect(isPrerelease('1.3.0-main.4')).toBe(true);
    expect(isPrerelease('1.3.0')).toBe(false);
    expect(isPrerelease('1.3.0+build.7')).toBe(false);
    expect(isPrerelease('1.3.0-rc.1+build.7')).toBe(true);
  });

  it('keeps each package’s latest pre-release and release, staged or published', () => {
    const view = {
      packages: [
        ver('widgets', 'widgets', '1.3.0-main.5', '2026-10-04T10:00:00Z', 'staged'),
        ver('widgets', '@acme/kit', '0.2.0', '2026-10-04T09:00:00Z'),
        ver('widgets', 'widgets', '1.3.0-main.4', '2026-10-03T10:00:00Z'),
        ver('widgets', 'widgets', '1.2.0', '2026-10-02T10:00:00Z'),
        ver('widgets', 'widgets', '1.1.0', '2026-10-01T10:00:00Z'),
      ],
    };
    const latest = latestPackages(view);
    expect(latest.map((p) => p.name)).toEqual(['@acme/kit', 'widgets']);
    const widgets = latest.find((p) => p.name === 'widgets');
    expect(widgets.prerelease.version).toBe('1.3.0-main.5');
    expect(widgets.prerelease.state).toBe('staged');
    expect(widgets.release.version).toBe('1.2.0');
    expect(widgets.waiting).toBe(1);
    expect(widgets.url).toBe('https://www.npmjs.com/package/widgets');
    const kit = latest.find((p) => p.name === '@acme/kit');
    expect(kit.prerelease).toBeNull();
    expect(kit.release.version).toBe('0.2.0');
    expect(kit.waiting).toBe(0);
    expect(kit.url).toBe('https://www.npmjs.com/package/@acme/kit');
    expect(latestPackages({ packages: [] })).toEqual([]);
    expect(latestPackages({})).toEqual([]);
    expect(latestPackages(null)).toEqual([]);
  });

  it('keeps the same name in two repositories apart', () => {
    const latest = latestPackages({
      packages: [
        ver('widgets', 'kit', '1.0.0', '2026-10-02T10:00:00Z'),
        ver('scratch', 'kit', '2.0.0', '2026-10-03T10:00:00Z'),
      ],
    });
    expect(latest.map((p) => `${p.repo}:${p.release.version}`)).toEqual(['scratch:2.0.0', 'widgets:1.0.0']);
  });

  it('scopes packages to the repository in view, and shows the Packages tab only with some', () => {
    const packages = [
      ver('widgets', 'widgets', '1.0.0', '2026-10-02T10:00:00Z'),
      ver('widgets', 'widgets', '1.1.0-main.1', '2026-10-03T10:00:00Z', 'staged'),
    ];
    const every = scopeGitHub({ ...all, packages }, null);
    expect(every.packages).toHaveLength(2);
    expect(githubTabs(every).map((t) => t.id)).toEqual([
      'releases',
      'deploys',
      'packages',
      'completed',
      'runs',
      'commits',
    ]);
    expect(githubTabs(every).find((t) => t.id === 'packages').count).toBe(2);
    const scratch = scopeGitHub({ ...all, packages }, 'scratch');
    expect(scratch.packages).toEqual([]);
    expect(githubTabs(scratch).map((t) => t.id)).not.toContain('packages');
    // An answer from before the feed, or for one repository without packages.
    expect(scopeGitHub(all, null).packages).toEqual([]);
    expect(githubTabs({ closed: [], runs: [], commits: [], packages: [] }).map((t) => t.id)).not.toContain('packages');
    expect(githubTabs({ closed: [], runs: [], commits: [], packages }).map((t) => t.id)).toEqual([
      'packages',
      'completed',
      'runs',
      'commits',
    ]);
  });
});
