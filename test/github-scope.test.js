import { describe, expect, it } from 'vitest';
import { repoFacts, scopeGitHub } from '../web/src/lib/github-scope.js';

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
    expect(scopeGitHub(one, null)).toEqual({ ...one, flows: [one], empties: [] });
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
