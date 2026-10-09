import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';
import {
  checkReport,
  checkRiskyPaths,
  globMatches,
  MAX_REVIEWS_PER_PULL,
  RISK_CHECK_NAME,
  riskConclusion,
  riskHold,
  RISKY_PATHS_FILE,
  riskyAreasIn,
} from '../src/risky-paths.js';
import { environmentOfFile } from '../src/infra-desired.js';
import { riskAnswerRequest, riskReviewRequest } from '../scripts/tasks/cli.js';

// Risky-path review (BRK-280, docs/specs/BRK-280-risky-path-review.md).
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

const LIST = {
  version: 1,
  areas: [
    { name: 'Credentials', why: 'Holds tokens.', paths: ['src/auth.js', 'src/**/*-tokens.js'] },
    { name: 'Merging', why: 'Merges on green.', paths: ['src/merge.js'] },
    { name: 'Workflows', why: '', paths: ['.github/workflows/'] },
  ],
};

describe('the list and what it covers', () => {
  it('matches globs: ** across folders, * within a name, a folder by its trailing slash', () => {
    expect(globMatches('src/auth.js', 'src/auth.js')).toBe(true);
    expect(globMatches('src/auth.js', 'src/auth.jsx')).toBe(false);
    expect(globMatches('src/**/*-tokens.js', 'src/infra-tokens.js')).toBe(true);
    expect(globMatches('src/**/*-tokens.js', 'src/a/b/cf-tokens.js')).toBe(true);
    expect(globMatches('src/*.js', 'src/a/b.js')).toBe(false);
    expect(globMatches('.github/workflows/', '.github/workflows/ci.yml')).toBe(true);
    expect(globMatches('.github/workflows/', '.github/dependabot.yml')).toBe(false);
    expect(globMatches('src/a?.js', 'src/ab.js')).toBe(true);
  });

  it('reads a list, and says what’s wrong with one that doesn’t check', () => {
    expect(checkRiskyPaths(JSON.stringify(LIST))).toEqual({
      list: [
        { name: 'Credentials', why: 'Holds tokens.', paths: ['src/auth.js', 'src/**/*-tokens.js'] },
        { name: 'Merging', why: 'Merges on green.', paths: ['src/merge.js'] },
        { name: 'Workflows', why: '', paths: ['.github/workflows/'] },
      ],
    });
    expect(checkRiskyPaths('{')).toMatchObject({ error: expect.stringMatching(/isn’t JSON/u) });
    expect(checkRiskyPaths('{"version":2,"areas":[]}')).toMatchObject({ error: expect.stringMatching(/version/u) });
    expect(checkRiskyPaths('{"version":1,"areas":[{"name":"x","paths":["/abs"]}]}')).toMatchObject({
      error: expect.stringMatching(/from the repository’s root/u),
    });
    // The list is beside the policy, and no environment can take its name.
    expect(RISKY_PATHS_FILE).toBe('.github/breakaway-infra/risky-paths.json');
    expect(environmentOfFile('risky-paths.json')).toBeNull();
  });

  it('names the areas a pull request touches, with a renamed file’s old name', () => {
    const { list } = /** @type {any} */ (checkRiskyPaths(JSON.stringify(LIST)));
    expect(
      riskyAreasIn(list, [
        { filename: 'src/login.js', previous_filename: 'src/auth.js' },
        { filename: 'src/infra-tokens.js' },
        { filename: 'README.md' },
      ]),
    ).toEqual([{ name: 'Credentials', why: 'Holds tokens.', files: ['src/auth.js', 'src/infra-tokens.js'] }]);
    expect(riskyAreasIn(list, [{ filename: 'README.md' }])).toEqual([]);
  });

  it('checks a report, holds while a blocking finding has no answer, and concludes the check', () => {
    expect(checkReport({ summary: '' })).toMatchObject({ error: expect.stringMatching(/summary/u) });
    expect(checkReport({ summary: 'ok', findings: [{ severity: 'bad', text: 'x' }] })).toMatchObject({
      error: expect.stringMatching(/blocking or note/u),
    });
    const report = /** @type {any} */ (
      checkReport({
        summary: 'Read it.',
        findings: [
          { severity: 'blocking', text: 'Force-pushes any branch.', path: 'src/merge.js', line: 12 },
          { severity: 'note', text: 'Name it better.' },
        ],
      })
    );
    expect(report.findings.map((f) => [f.n, f.severity])).toEqual([
      [1, 'blocking'],
      [2, 'note'],
    ]);
    const reviewed = { state: 'reviewed', findings: report.findings, answers: [] };
    expect(riskHold(reviewed)).toMatch(/a blocking finding waits for the author’s answer \(#1\)/u);
    expect(riskConclusion(reviewed)).toEqual({ status: 'completed', conclusion: 'action_required' });
    const answered = { ...reviewed, answers: [{ finding: 1, text: 'Fixed.', by: 'claude-x' }] };
    expect(riskHold(answered)).toBeNull();
    expect(riskConclusion(answered)).toEqual({ status: 'completed', conclusion: 'success' });
    expect(riskHold({ state: 'reviewing' })).toMatch(/a reviewer is reading/u);
    expect(riskConclusion({ state: 'waiting' })).toEqual({ status: 'in_progress', conclusion: null });
    expect(riskHold({ state: 'no-task' })).toBeNull();
    expect(riskConclusion({ state: 'capped' })).toEqual({ status: 'completed', conclusion: 'neutral' });
  });

  it('builds the CLI’s requests', () => {
    expect(riskReviewRequest('BRK-1', null)).toEqual({ request: ['GET', 'tasks/BRK-1/risk-review'] });
    expect(riskReviewRequest('BRK-1', '{"summary":"s","findings":[]}', { by: 'a', pr: '#7' })).toEqual({
      request: ['POST', 'tasks/BRK-1/risk-review', { summary: 's', findings: [], by: 'a', pr: 7 }],
    });
    expect(riskReviewRequest('BRK-1', 'nope')).toMatchObject({ error: expect.stringMatching(/isn’t JSON/u) });
    expect(riskAnswerRequest('BRK-1', '#2', 'Fixed in abc.', { by: 'a' })).toEqual({
      request: ['POST', 'tasks/BRK-1/risk-answer', { finding: 2, text: 'Fixed in abc.', by: 'a' }],
    });
    expect(riskAnswerRequest('BRK-1', 'two', 'x')).toMatchObject({ error: expect.stringMatching(/number/u) });
    expect(riskAnswerRequest('BRK-1', '2', ' ')).toMatchObject({ error: expect.stringMatching(/say how/u) });
  });
});

/** GitHub and Claude, as the board sees them in this file. */
const gh = {
  /** @type {any[]} */ pulls: [],
  /** @type {Record<string, any[]>} */ files: {},
  list: /** @type {string | null} */ (JSON.stringify(LIST)),
  head: 'main1',
  /** @type {any[]} */ fires: [],
  /** @type {any[]} */ checks: [],
  /** @type {any[]} */ graphql: [],
  /** @type {any[]} */ merges: [],
};

function pr(number, { body: text = '', draft = false, sha, autoMerge = false, fork = false } = {}) {
  return {
    number,
    node_id: `PR_${number}`,
    title: `PR ${number}`,
    body: text,
    draft,
    state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: {
      ref: `branch-${number}`,
      sha: sha ?? S(number),
      repo: { full_name: fork ? 'someone/widgets' : 'acme/widgets' },
    },
    base: { ref: 'main', sha: 'main1', repo: { full_name: 'acme/widgets' } },
    user: { login: 'claude[bot]' },
    auto_merge: autoMerge ? { merge_method: 'squash' } : null,
    created_at: '2026-10-09T09:00:00Z',
    updated_at: '2026-10-09T10:00:00Z',
    merged_at: null,
    closed_at: null,
  };
}

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const method = init.method ?? 'GET';
    if (url.href === FIRE) {
      gh.fires.push(JSON.parse(init.body).text);
      const id = `session_r${gh.fires.length}`;
      return json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    const path = url.pathname;
    if (path === '/graphql') {
      const q = JSON.parse(init.body);
      if (/disablePullRequestAutoMerge|enablePullRequestAutoMerge/u.test(q.query)) {
        gh.graphql.push(q);
        return json({ data: {} });
      }
      return json({ message: 'Not Found' }, 404);
    }
    if (path === `${REPO}/installation`) return json({ id: 7 });
    if (path.startsWith('/app/installations/'))
      return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === `${REPO}/pulls`) return json(gh.pulls);
    if (path === `${REPO}/commits`)
      return json([
        {
          sha: gh.head,
          html_url: `https://github.com/acme/widgets/commit/${gh.head}`,
          commit: { message: 'Start', committer: { date: '2026-10-09T08:00:00Z' } },
        },
      ]);
    if (path === `${REPO}/dependabot/alerts`) return json([]);
    if (path === `${REPO}/actions/runs`) return json({ workflow_runs: [] });
    if (path === `${REPO}/contents/.github/breakaway-infra`)
      return gh.list === null
        ? json({ message: 'Not Found' }, 404)
        : json([{ type: 'file', name: 'risky-paths.json', size: gh.list.length }]);
    if (path === `${REPO}/contents/${RISKY_PATHS_FILE}`)
      return gh.list === null
        ? json({ message: 'Not Found' }, 404)
        : json({ type: 'file', size: gh.list.length, content: b64(gh.list) });
    if (path === `${REPO}/check-runs` && method === 'POST') {
      const sent = JSON.parse(init.body);
      gh.checks.push({ method, ...sent });
      return json({
        id: 900 + gh.checks.length,
        html_url: `https://github.com/acme/widgets/runs/${900 + gh.checks.length}`,
      });
    }
    let m = /\/check-runs\/(\d+)$/u.exec(path);
    if (m && method === 'PATCH') {
      gh.checks.push({ method, id: Number(m[1]), ...JSON.parse(init.body) });
      return json({ id: Number(m[1]), html_url: `https://github.com/acme/widgets/runs/${m[1]}` });
    }
    m = /\/pulls\/(\d+)\/files$/u.exec(path);
    if (m) return json(gh.files[m[1]] ?? []);
    m = /\/pulls\/(\d+)\/merge$/u.exec(path);
    if (m && method === 'PUT') {
      gh.merges.push(Number(m[1]));
      return json({ merged: true });
    }
    m = /\/pulls\/(\d+)$/u.exec(path);
    if (m)
      return json({
        ...gh.pulls.find((p) => String(p.number) === m[1]),
        mergeable: true,
        mergeable_state: 'clean',
        commits: 1,
        changed_files: 1,
      });
    if (/\/commits\/[^/]+\/check-runs$/u.test(path)) return json({ check_runs: [] });
    if (/\/commits\/[^/]+\/status$/u.test(path)) return json({ state: 'success', statuses: [] });
    if (/\/pulls\/\d+\/(comments|reviews)$/u.test(path)) return json([]);
    return json({ message: 'Not Found' }, 404);
  });
}

/** The signed-in browser: the cookie from /login. */
async function browser() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return (path, payload) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(payload),
    });
}

const sync = () => api('github/sync', { method: 'POST' });
const report = (wid, payload) => api(`tasks/${wid}/risk-review`, { method: 'POST', body: payload });
const answer = (wid, payload) => api(`tasks/${wid}/risk-answer`, { method: 'POST', body: payload });
/** A head commit: pull request `n`'s, and its `v`th push. */
const S = (n, v = 'a') => `${v.repeat(3)}${String(n).padStart(4, '0')}`;
const checksOf = (sha) => gh.checks.filter((c) => c.head_sha === sha);

describe('a pull request that touches a risky path gets a separate reviewer', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('sets up tasks, an author holding one, and pull requests', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: ['Rotate tokens', 'Docs', 'Draft work', 'Fork work'].map((description) => ({
          description,
          project: 'product',
          tags: ['agent'],
          horizon: 'now',
        })),
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['PRD-1', 'PRD-2', 'PRD-3', 'PRD-4']);
    expect((await api('tasks/PRD-1/claim', { method: 'POST', body: { agent: 'claude-prd-1' } })).status).toBe(200);
    gh.pulls = [
      pr(1, { body: 'Closes PRD-1.', autoMerge: true }),
      pr(2, { body: 'Closes PRD-2.' }),
      pr(3, { body: 'Closes PRD-3.', draft: true }),
    ];
    gh.files = {
      1: [{ filename: 'src/auth.js', status: 'modified' }, { filename: 'README.md' }],
      2: [{ filename: 'README.md', status: 'modified' }],
      3: [{ filename: 'src/merge.js', status: 'modified' }],
      5: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
      6: [{ filename: 'src/auth.js', status: 'modified' }],
    };
    await api('agents/settings', { method: 'PATCH', body: { max: 2 } });
  });

  it('starts a reviewer on the task’s pull request without taking the author’s claim, and posts a running check', async () => {
    await sync();
    expect(gh.fires).toHaveLength(1);
    const text = gh.fires[0];
    expect(text).toMatch(/^Task: PRD-1\nTitle: Rotate tokens\nAgent name: claude-prd-1-risk\nStarted: by the board/u);
    expect(text).toContain('Mode: risk-review\nPull request: #1\nRisky paths: Credentials (src/auth.js)');
    const task = await body(await api('tasks/PRD-1'));
    expect(task.task?.claim ?? task.claim).toBe('claude-prd-1');

    const posted = checksOf(S(1));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: 'POST', name: RISK_CHECK_NAME, status: 'in_progress' });
    expect(posted[0].output.summary).toContain('**Credentials**: Holds tokens. (`src/auth.js`)');
    // A pull request that touches nothing listed gets no check, and a draft waits.
    expect(checksOf(S(2))).toEqual([]);
    expect(checksOf(S(3))).toEqual([]);
    // GitHub's auto-merge was on: it's turned off, so it can't merge before the review is in.
    expect(gh.graphql.map((q) => [/disable/u.test(q.query), q.variables.id])).toEqual([[true, 'PR_1']]);
    // Its start spends the board's starts this hour like any other.
    expect(await inStore((s) => s.startsThisHour())).toBe(1);
  });

  it('holds Merge when green while it reviews, and the settings skip it, but the owner’s Merge goes through', async () => {
    const list = await body(await api('github'));
    const one = list.open.find((p) => p.number === 1);
    expect(one.riskHold).toMatch(/a reviewer is reading its risky paths/u);
    expect(list.open.find((p) => p.number === 2).riskHold).toBeNull();
    const post = await browser();
    const held = await body(await post('github/pulls/1/auto-merge', { sha: S(1), method: 'squash' }));
    expect(held).toMatchObject({ status: 409, riskHold: true, error: expect.stringMatching(/^#1: a reviewer/u) });
    const settings = await body(await post('github/pulls/1/merge', { sha: S(1), method: 'squash', setting: true }));
    expect(settings).toMatchObject({ status: 409, riskHold: true });
    expect(gh.merges).toEqual([]);
    // Turning it off is never held.
    expect((await post('github/pulls/1/auto-merge', { sha: S(1), enable: false })).status).toBe(200);
  });

  it('takes the review only from the reviewer the board started, never the author', async () => {
    const findings = {
      summary: 'Read auth.js and its callers.',
      findings: [
        { severity: 'blocking', text: 'The token lives forever: give it an expiry.', path: 'src/auth.js', line: 40 },
        { severity: 'note', text: 'The error could name the header.' },
      ],
    };
    expect(await body(await report('PRD-1', { ...findings, by: 'claude-prd-1' }))).toMatchObject({
      status: 409,
      error: expect.stringMatching(/claude-prd-1 has no open risky-path review/u),
    });
    expect((await report('PRD-1', { ...findings })).status).toBe(400);
    gh.graphql = [];
    const res = await body(await report('PRD-1', { ...findings, by: 'claude-prd-1-risk' }));
    expect(res.status).toBe(201);
    expect(res.review).toMatchObject({
      state: 'reviewed',
      agent: 'claude-prd-1-risk',
      task: 'PRD-1',
      hold: expect.stringMatching(/a blocking finding waits for the author’s answer \(#1\)/u),
    });
    expect(res.task.comments.at(-1)).toMatchObject({
      by: 'claude-prd-1-risk',
      text: expect.stringMatching(/^Risky-path review of #1 at aaa0001: 1 blocking/u),
    });
    // The check on the same head is updated, and GitHub's auto-merge is turned off while it holds.
    const last = gh.checks.at(-1);
    expect(last).toMatchObject({ method: 'PATCH', id: 901, status: 'completed', conclusion: 'action_required' });
    expect(last.output.summary).toContain('1. **Blocking** `src/auth.js:40`: The token lives forever');
    expect(gh.graphql.map((q) => /disable/u.test(q.query))).toEqual([true]);
    // Once is all: a second report finds no open review.
    expect((await report('PRD-1', { ...findings, by: 'claude-prd-1-risk' })).status).toBe(409);

    const page = await body(await api('github/pulls/1'));
    expect(page.riskReview).toMatchObject({ state: 'reviewed', findings: [{ n: 1 }, { n: 2 }] });
  });

  it('lets the author answer, not the reviewer, and lifts the hold once every blocking finding is answered', async () => {
    expect(
      await body(await answer('PRD-1', { finding: 1, text: 'Looks fine.', by: 'claude-prd-1-risk' })),
    ).toMatchObject({ status: 409, error: expect.stringMatching(/the reviewer can’t answer/u) });
    expect(await body(await answer('PRD-1', { finding: 1, text: 'Mine.', by: 'claude-someone' }))).toMatchObject({
      status: 409,
      error: expect.stringMatching(/claude-prd-1’s/u),
    });
    // Every agent holds the bearer token, so without a name it isn't the owner's answer.
    expect((await answer('PRD-1', { finding: 1, text: 'Owner here.' })).status).toBe(400);
    expect((await answer('PRD-1', { finding: 9, text: 'x', by: 'claude-prd-1' })).status).toBe(400);
    const res = await body(
      await answer('PRD-1', { finding: 1, text: 'Tokens expire after an hour now (abc1234).', by: 'claude-prd-1' }),
    );
    expect(res.status).toBe(201);
    expect(res.review.hold).toBeNull();
    expect(gh.checks.at(-1)).toMatchObject({ method: 'PATCH', conclusion: 'success' });
    expect(gh.checks.at(-1).output.summary).toContain('*Answer* from claude-prd-1: Tokens expire after an hour now');
    const post = await browser();
    expect((await post('github/pulls/1/auto-merge', { sha: S(1), method: 'squash' })).status).toBe(200);
    // The owner answers from the signed-in board.
    expect((await post('tasks/PRD-1/risk-answer', { finding: 2, text: 'Agreed, later.' })).status).toBe(201);
    const shown = await body(await api('tasks/PRD-1/risk-review'));
    expect(shown.reviews[0].answers.map((a) => [a.finding, a.by])).toEqual([
      [1, 'claude-prd-1'],
      [2, 'owner'],
    ]);
  });

  it('reviews a new head again, and refuses a review of the head that moved on', async () => {
    gh.pulls[0] = pr(1, { body: 'Closes PRD-1.', sha: S(1, 'b') });
    await sync();
    expect(gh.fires).toHaveLength(2);
    expect(checksOf(S(1, 'b'))[0]).toMatchObject({ method: 'POST', status: 'in_progress' });
    gh.pulls[0] = pr(1, { body: 'Closes PRD-1.', sha: S(1, 'c') });
    await sync();
    expect(gh.fires).toHaveLength(3);
    // claude-prd-1-risk's review of sha1b is gone: the one of sha1c is open, and the report goes there.
    const res = await body(await report('PRD-1', { summary: 'Fine.', findings: [], by: 'claude-prd-1-risk' }));
    expect(res.review).toMatchObject({ state: 'reviewed', hold: null });
    expect(gh.checks.at(-1)).toMatchObject({ head_sha: S(1, 'c'), conclusion: 'success' });
    // After MAX_REVIEWS_PER_PULL heads, the board starts no more, and nothing holds it.
    expect(MAX_REVIEWS_PER_PULL).toBe(3);
    gh.pulls[0] = pr(1, { body: 'Closes PRD-1.', sha: S(1, 'd') });
    await sync();
    expect(gh.fires).toHaveLength(3);
    expect(checksOf(S(1, 'd'))[0]).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect((await body(await api('github'))).open.find((p) => p.number === 1).riskHold).toBeNull();
  });

  it('waits for room, holding meanwhile, and starts once there is', async () => {
    await api('agents/settings', { method: 'PATCH', body: { max: 1 } });
    gh.pulls.push(pr(6, { body: 'Closes PRD-2.' }), pr(7, { body: 'Closes PRD-4.' }));
    gh.files[7] = [{ filename: 'src/merge.js' }];
    await sync();
    // #6 starts a reviewer, which fills the board's one slot, so #7 waits.
    expect(gh.fires).toHaveLength(4);
    expect(gh.fires.at(-1)).toContain('Pull request: #6');
    expect(checksOf(S(7))[0]).toMatchObject({ status: 'in_progress' });
    expect(checksOf(S(7))[0].output.title).toMatch(/^Waiting for room/u);
    expect(await inStore((s) => s.riskHoldOf('widgets', 7))).toMatch(/a reviewer is reading/u);
    await report('PRD-2', { summary: 'Nothing.', findings: [], by: 'claude-prd-2-risk' });
    await sync();
    expect(gh.fires).toHaveLength(5);
    expect(gh.fires.at(-1)).toContain('Pull request: #7');
    expect(checksOf(S(7)).at(-1)).toMatchObject({ method: 'PATCH', status: 'in_progress' });
  });

  it('starts nobody for a fork, a pull request that closes no task, or a draft until it’s published', async () => {
    await api('agents/settings', { method: 'PATCH', body: { max: 6 } });
    gh.pulls.push(pr(5, { body: 'No task here.' }), pr(8, { body: 'Closes PRD-3.', fork: true }));
    gh.files[8] = [{ filename: 'src/auth.js' }];
    const before = gh.fires.length;
    await sync();
    await sync();
    expect(gh.fires).toHaveLength(before);
    expect(checksOf(S(5))[0]).toMatchObject({ conclusion: 'neutral' });
    expect(checksOf(S(5))[0].output.title).toMatch(/closes no open task/u);
    expect(checksOf(S(8))[0].output.title).toMatch(/from a fork/u);
    gh.pulls[2] = pr(3, { body: 'Closes PRD-3.' });
    await sync();
    expect(gh.fires.at(-1)).toContain('Pull request: #3\nRisky paths: Merging (src/merge.js)');
  });

  it('reviews nothing in a repository without a list, and says so when the list doesn’t check', async () => {
    gh.head = 'main2';
    gh.list = '{"version":1}';
    const res = await body(await api('github/sync', { method: 'POST' }));
    expect(JSON.stringify(res)).toContain('risky paths:');
    gh.list = null;
    gh.head = 'main3';
    gh.pulls.push(pr(9, { body: 'Closes PRD-4.' }));
    gh.files[9] = [{ filename: 'src/auth.js' }];
    const before = gh.fires.length;
    await sync();
    expect(gh.fires).toHaveLength(before);
    expect(checksOf(S(9))).toEqual([]);
  });
});
