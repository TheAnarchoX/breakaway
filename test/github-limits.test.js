import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ETAG_ENTRIES,
  GitHubClient,
  GitHubError,
  detailsFromGraphql,
  isRateLimited,
  pullDetailsQuery,
} from '../src/github.js';
import { budgetAfterSync, budgetWords, countsOf, restBudget } from '../src/github-budget.js';

// The client's rate limits (BRK-269): conditional reads, each budget's state, and backing off. Nothing here
// reaches GitHub: fetch is stubbed, and the cache holds a token so no JWT is made.

const repo = { owner: 'acme', repo: 'widgets', full: 'acme/widgets' };
const client = () =>
  new GitHubClient({ appId: '1', key: 'unused' }, repo, { token: 'ghs_fake', expires: Date.now() + 3_600_000 });
const reset = () => String(Math.floor(Date.now() / 1000) + 600);
const json = (data, status = 200, headers = {}) =>
  new Response(status === 304 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** Stubs fetch with `answer(path, headers)` and records each call's path and If-None-Match. */
function stub(answer) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers);
    calls.push({ path: url.pathname, ifNoneMatch: headers.get('If-None-Match') });
    return answer(url.pathname, headers, init);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('conditional reads', () => {
  it('asks again with the ETag and serves an unchanged answer from the cache', async () => {
    const calls = stub((_path, headers) =>
      headers.get('If-None-Match') === '"v1"' ? json(null, 304) : json([{ number: 1 }], 200, { ETag: '"v1"' }),
    );
    const c = client();
    expect(await c.get('/pulls')).toEqual([{ number: 1 }]);
    const again = await c.get('/pulls');
    expect(again).toEqual([{ number: 1 }]);
    expect(calls.map((x) => x.ifNoneMatch)).toEqual([null, '"v1"']);
    // Each answer is its own copy: changing one never changes what the cache serves next.
    again.push({ number: 2 });
    expect(await c.get('/pulls')).toEqual([{ number: 1 }]);
  });

  it('never makes a write or GraphQL conditional', async () => {
    const calls = stub(() => json({ data: {} }, 200, { ETag: '"w"' }));
    const c = client();
    await c.send('PUT', '/pulls/1/merge', {});
    await c.send('PUT', '/pulls/1/merge', {});
    await c.graphql('query { viewer { login } }', {});
    expect(calls.every((x) => x.ifNoneMatch === null)).toBe(true);
    expect(c.cache.etags?.size ?? 0).toBe(0);
  });

  it('remembers at most ETAG_ENTRIES answers, forgetting the least recently used', async () => {
    stub((path) => json({ path }, 200, { ETag: `"${path}"` }));
    const c = client();
    for (let i = 0; i <= ETAG_ENTRIES; i += 1) await c.get(`/issues/${i}`);
    expect(c.cache.etags.size).toBe(ETAG_ENTRIES);
    expect(c.cache.etags.has('/repos/acme/widgets/issues/0')).toBe(false);
    expect(c.cache.etags.has(`/repos/acme/widgets/issues/${ETAG_ENTRIES}`)).toBe(true);
  });
});

describe('rate limits', () => {
  it('keeps each budget from the headers, and stops calling one GitHub says is used up until it resets', async () => {
    let refuse = true;
    const calls = stub(() =>
      refuse
        ? json({ message: 'API rate limit exceeded for installation ID 1.' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': reset(),
            'x-ratelimit-resource': 'core',
          })
        : json([], 200, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': reset() }),
    );
    const c = client();
    const error = await c.get('/pulls').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    // 429 whatever GitHub sent, so a read that skips a 403 as "not permitted" doesn't skip this.
    expect(error.status).toBe(429);
    expect(isRateLimited(error)).toBe(true);
    expect(error.message).toMatch(/^GitHub's API rate limit is used up until \d\d:\d\d UTC/u);
    expect(c.limitedUntil('core')).toBe(error.resetAt);
    expect(c.limitedUntil('graphql')).toBeNull();

    refuse = false;
    await expect(c.get('/pulls')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1); // refused without a call

    c.cache.limits.core.reset = Date.now() - 1; // the hour turned
    expect(await c.get('/pulls')).toEqual([]);
    expect(c.cache.limits.core).toMatchObject({ remaining: 4999 });
  });

  it('pauses every call for Retry-After on a secondary limit', async () => {
    const calls = stub(() =>
      json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '30' }),
    );
    const c = client();
    const error = await c.get('/pulls').catch((e) => e);
    expect(isRateLimited(error)).toBe(true);
    expect(error.resetAt - Date.now()).toBeGreaterThan(25_000);
    await expect(c.graphql('query { viewer { login } }', {})).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  it('reads a used-up GraphQL budget from its 200 answer, leaving REST to carry on', async () => {
    stub((path) =>
      path === '/graphql'
        ? json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': reset(),
            'x-ratelimit-resource': 'graphql',
          })
        : json([]),
    );
    const c = client();
    const error = await c.graphql('query { viewer { login } }', {}).catch((e) => e);
    expect(error.message).toMatch(/^GitHub's GraphQL rate limit is used up/u);
    expect(c.limitedUntil('graphql')).toBeGreaterThan(Date.now());
    expect(c.limitedUntil('core')).toBeNull();
    expect(await c.get('/pulls')).toEqual([]);
  });

  it('leaves other refusals as they were', async () => {
    stub(() => json({ message: 'Resource not accessible by integration' }, 403));
    const c = client();
    await expect(c.get('/dependabot/alerts')).rejects.toMatchObject({
      status: 403,
      reason: 'Resource not accessible by integration',
    });
    expect(c.limitedUntil('core')).toBeNull();
  });
});

describe('pull request details over GraphQL', () => {
  it('asks for each pull request by number, under its own alias', () => {
    const query = pullDetailsQuery([12, 7]);
    expect(query).toContain('pr12: pullRequest(number: 12) { ...details }');
    expect(query).toContain('pr7: pullRequest(number: 7) { ...details }');
    expect(query).toMatch(/^query\(\$owner: String!, \$name: String!\)/u);
  });

  it('gives the same details the REST calls do', () => {
    const data = {
      repository: {
        pr12: {
          number: 12,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          reviews: {
            nodes: [
              { state: 'COMMENTED', author: { login: 'a' } },
              { state: 'APPROVED', author: { login: 'b' } },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          databaseId: 5,
                          name: 'CI',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          permalink: 'https://github.com/acme/widgets/runs/5',
                          startedAt: '2026-10-01T10:00:00Z',
                        },
                        {
                          __typename: 'StatusContext',
                          context: 'deploy/preview',
                          state: 'EXPECTED',
                          targetUrl: null,
                          createdAt: '2026-10-01T10:00:00Z',
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
        pr7: {
          number: 7,
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          reviews: { nodes: [] },
          commits: { nodes: [] },
        },
        pr3: { number: 3, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviews: null, commits: null },
        pr9: null, // GitHub had no such pull request: read over REST
      },
    };
    const details = detailsFromGraphql(data, new Set([12, 7]));
    expect([...details.keys()].sort()).toEqual([12, 3, 7].sort());
    expect(details.get(12)).toEqual({
      checks: {
        state: 'failure',
        total: 2,
        passed: 0,
        runs: [
          { name: 'CI', state: 'failure', url: 'https://github.com/acme/widgets/runs/5' },
          { name: 'deploy/preview', state: 'in_progress', url: null },
        ],
      },
      review: { decision: 'approved', reviewers: ['b'], comments: 1 },
      mergeable: false,
      mergeableState: 'dirty',
    });
    // Still working it out: null, as REST says it.
    expect(details.get(7)).toMatchObject({ mergeable: null, mergeableState: null, checks: { state: 'none' } });
    // Closed: no merge state, as REST (which doesn't read a closed one's) has none.
    expect(details.get(3)).toMatchObject({ mergeable: null, mergeableState: null });
  });
});

describe('what a sync spends (BRK-271)', () => {
  it('counts calls per budget, free 304s apart, and keeps each budget’s limit', async () => {
    const left = { core: 4900, graphql: 4990 };
    stub((path, headers) => {
      const resource = path === '/graphql' ? 'graphql' : 'core';
      const free = headers.get('If-None-Match') === '"v1"';
      if (!free) left[resource] -= 1;
      const rate = {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': String(left[resource]),
        'x-ratelimit-reset': reset(),
        'x-ratelimit-resource': resource,
      };
      return free ? json(null, 304, rate) : json({ data: {} }, 200, { ETag: '"v1"', ...rate });
    });
    const c = client();
    await c.get('/pulls');
    await c.get('/pulls');
    await c.get('/pulls');
    await c.graphql('query { viewer { login } }', {});
    expect(c.cache.calls).toEqual({ core: 1, graphql: 1 });
    expect(c.cache.free).toBe(2);
    expect(c.cache.limits.core).toMatchObject({ remaining: 4899, limit: 5000 });
    expect(c.cache.limits.graphql).toMatchObject({ remaining: 4989, limit: 5000 });
  });

  it('keeps a used-up budget’s limit', async () => {
    stub(() =>
      json({ message: 'API rate limit exceeded for installation ID 1.' }, 403, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': reset(),
        'x-ratelimit-resource': 'core',
      }),
    );
    const c = client();
    await c.get('/pulls').catch(() => null);
    expect(c.cache.limits.core).toMatchObject({ remaining: 0, limit: 5000 });
    expect(c.cache.calls).toEqual({ core: 1 });
  });

  it('keeps what the sync spent, and a budget it didn’t touch as it was', () => {
    const before = countsOf({ calls: { core: 10, graphql: 2 }, free: 5 });
    const previous = {
      at: '2026-10-07T18:00:00.000Z',
      limits: { graphql: { remaining: 4000, limit: 5000, reset: '2026-10-07T19:00:00.000Z' } },
      calls: { core: 3, graphql: 1 },
      free: 0,
    };
    const cache = {
      calls: { core: 16 },
      free: 14,
      limits: { core: { remaining: 4812, reset: Date.UTC(2026, 9, 7, 20) } },
    };
    expect(budgetAfterSync(previous, cache, before, Date.UTC(2026, 9, 7, 19, 30))).toEqual({
      at: '2026-10-07T19:30:00.000Z',
      limits: {
        core: { remaining: 4812, reset: '2026-10-07T20:00:00.000Z' },
        graphql: { remaining: 4000, limit: 5000, reset: '2026-10-07T19:00:00.000Z' },
      },
      calls: { core: 6, graphql: 0 },
      free: 9,
    });
    // A fresh client (the Durable Object restarted) counts from nothing.
    expect(budgetAfterSync(null, { calls: { core: 2 } }, countsOf(undefined)).calls).toEqual({ core: 2, graphql: 0 });
  });

  it('says it in one line', () => {
    const now = Date.UTC(2026, 9, 7, 19, 30);
    const budget = {
      at: '2026-10-07T19:30:00.000Z',
      limits: {
        core: { remaining: 4812, limit: 5000, reset: '2026-10-07T20:00:00.000Z' },
        graphql: { remaining: 4990, limit: 5000, reset: '2026-10-07T20:10:00.000Z' },
      },
      calls: { core: 4, graphql: 2 },
      free: 9,
    };
    expect(budgetWords(budget, now)).toBe(
      'REST 4,812 of 5,000 left · GraphQL 4,990 of 5,000 left · resets 20:00 UTC · last sync 6 calls (4 REST, 2 GraphQL), 9 free',
    );
    // A reset that has passed isn't named; one budget's calls, or none, read plainly.
    expect(budgetWords({ ...budget, calls: { core: 1, graphql: 0 } }, Date.UTC(2026, 9, 7, 20, 5))).toBe(
      'REST 4,812 of 5,000 left · GraphQL 4,990 of 5,000 left · resets 20:10 UTC · last sync 1 REST call, 9 free',
    );
    expect(budgetWords({ at: budget.at, limits: {}, calls: { core: 0, graphql: 0 }, free: 0 }, now)).toBe(
      'last sync made no calls',
    );
    expect(budgetWords(null)).toBeNull();
    expect(restBudget(budget)).toEqual({ remaining: 4812, limit: 5000, reset: '2026-10-07T20:00:00.000Z' });
  });
});
