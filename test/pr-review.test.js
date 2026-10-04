import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const gh = { pulls: [], mergeable: {}, checks: {}, fires: [] };

function pr(number, { title, body: text = '', draft = false, author = 'claude[bot]', sha } = {}) {
  return {
    number,
    title: title ?? `PR ${number}`,
    body: text,
    draft,
    state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { ref: `branch-${number}`, sha: sha ?? `sha${number}` },
    user: { login: author },
    created_at: '2026-09-29T09:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
    merged_at: null,
    closed_at: null,
  };
}

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.href === FIRE) {
      gh.fires.push(JSON.parse(init.body).text);
      const id = `session_v${gh.fires.length}`;
      return json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    const path = url.pathname;
    if (path === `${REPO}/installation`) return json({ id: 7 });
    if (path.startsWith('/app/installations/'))
      return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === `${REPO}/pulls`) return json(gh.pulls);
    if (path === `${REPO}/commits` || path === `${REPO}/dependabot/alerts`) return json([]);
    if (path === `${REPO}/actions/runs`) return json({ workflow_runs: [] });
    let m = /\/pulls\/(\d+)$/u.exec(path);
    if (m) {
      const [mergeable, state] = gh.mergeable[m[1]] ?? [true, 'clean'];
      return json({
        ...gh.pulls.find((p) => String(p.number) === m[1]),
        mergeable,
        mergeable_state: state,
        commits: 1,
        changed_files: 0,
        base: { ref: 'main' },
      });
    }
    m = /\/commits\/([^/]+)\/check-runs$/u.exec(path);
    if (m) return json({ check_runs: gh.checks[m[1]] ?? [passed] });
    if (/\/commits\/[^/]+\/status$/u.test(path)) return json({ state: 'success', statuses: [] });
    if (/\/pulls\/\d+\/(comments|files|reviews)$/u.test(path)) return json([]);
    return json({ message: 'Not Found' }, 404);
  });
}

const passed = { name: 'Test and build', status: 'completed', conclusion: 'success' };
const running = { name: 'Test and build', status: 'in_progress', conclusion: null };
const failed = { name: 'Test and build', status: 'completed', conclusion: 'failure' };
const review = (number, payload = {}) => api(`github/pulls/${number}/review`, { method: 'POST', body: payload });
const verdict = (wid, payload) => api(`tasks/${wid}/review`, { method: 'POST', body: payload });

describe('review with an agent on a mergeable pull request (BRK-111)', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('sets up a board and pull requests', async () => {
    const titles = ['Ready', 'Running', 'Draft', 'Behind', 'Conflicts', 'Failing', 'Changes', 'Blocked'];
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: titles.map((description) => ({ description, project: 'product', tags: ['agent'], horizon: 'now' })),
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(titles.map((_, i) => `PRD-${i + 1}`));
    gh.pulls = [
      pr(1, { body: 'Closes PRD-1.' }),
      pr(2, { body: 'Closes PRD-2.' }),
      pr(3, { body: 'Closes PRD-3.', draft: true }),
      pr(4, { body: 'Closes PRD-4.' }),
      pr(5, { body: 'Closes PRD-5.' }),
      pr(6, { body: 'Closes PRD-6.' }),
      pr(7, { body: 'Closes PRD-7.' }),
      pr(8, { title: 'Closes nothing' }),
      pr(9, { title: 'Bump vite from 7.0.0 to 7.1.0', author: 'dependabot[bot]' }),
    ];
    gh.mergeable = { 4: [true, 'behind'], 5: [false, 'dirty'] };
    gh.checks = { sha2: [running], sha6: [failed] };
    await api('github/sync', { method: 'POST' });
    await api('github/sync', { method: 'POST' });
    await api('agents/settings', { method: 'PATCH', body: { max: 6 } });
  });

  it('starts a review on a ready pull request, on the task it closes', async () => {
    const res = await body(await review(1, { note: 'Look hard at the migration.' }));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({
      agent: 'claude-prd-1-review',
      kind: 'pr-review',
      trigger: 'pr-review',
      status: 'started',
    });
    expect(res.task).toMatchObject({ wid: 'PRD-1', claim: 'claude-prd-1-review' });
    const text = gh.fires.at(-1);
    expect(text).toMatch(
      /^Task: PRD-1\nTitle: Ready\nAgent name: claude-prd-1-review\nStarted: by “Review with an agent”/,
    );
    expect(text).toContain('Mode: pr-review\nPull request: #1');
    expect(text).toContain('Note from the owner:\nLook hard at the migration.');

    // It counts as running although its task is in review, and a second press names it.
    const { running: list } = await body(await api('agents'));
    expect(list.map((r) => r.wid)).toContain('PRD-1');
    const before = gh.fires.length;
    expect(await body(await review(1))).toMatchObject({ run: null, already: 'claude-prd-1-review is starting' });
    expect(gh.fires).toHaveLength(before);
  });

  it('starts one on a pull request whose checks are still running', async () => {
    const res = await body(await review(2));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ agent: 'claude-prd-2-review', kind: 'pr-review' });
  });

  it('refuses a draft, a behind, a conflicting, or a failing pull request, with the path that fits it', async () => {
    const before = gh.fires.length;
    expect(await body(await review(3))).toMatchObject({ status: 409, error: expect.stringMatching(/draft/) });
    expect(await body(await review(4))).toMatchObject({
      status: 409,
      path: 'update',
      error: expect.stringMatching(/behind main.*Update branch/),
    });
    expect(await body(await review(5))).toMatchObject({
      status: 409,
      path: 'fix',
      error: expect.stringMatching(/conflicts.*Fix with an agent/),
    });
    expect(await body(await review(6))).toMatchObject({
      status: 409,
      path: 'fix',
      error: expect.stringMatching(/checks are failing.*Fix with an agent/),
    });
    expect(gh.fires).toHaveLength(before);
  });

  it('checks GitHub again rather than trusting the last sync', async () => {
    gh.mergeable[7] = [false, 'dirty'];
    expect(await body(await review(7))).toMatchObject({ status: 409, path: 'fix' });
    delete gh.mergeable[7];
  });

  it('refuses a pull request that closes no open task, and one that isn’t on the board', async () => {
    expect(await body(await review(8))).toMatchObject({
      status: 409,
      error: expect.stringMatching(/closes no open task/),
    });
    expect((await review(99)).status).toBe(404);
  });

  it('is the owner’s: an agent can’t start a review', async () => {
    const res = await body(await review(7, { by: 'claude-prd-9' }));
    expect(res.status).toBe(403);
  });

  it('keeps the review note with the commit it reviewed, and as a task comment', async () => {
    const res = await body(
      await verdict('PRD-1', {
        verdict: 'ready',
        note: 'Matches the done when.\n\n- tests cover the migration',
        by: 'claude-prd-1-review',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.review).toMatchObject({
      pr: 1,
      verdict: 'ready',
      agent: 'claude-prd-1-review',
      sha: 'sha1',
      note: 'Matches the done when.\n\n- tests cover the migration',
    });
    expect(res.task.comments.at(-1)).toMatchObject({
      by: 'claude-prd-1-review',
      text: expect.stringMatching(/^Agent review of #1 at sha1: Looks ready\n\nMatches the done when\./),
    });

    const page = await body(await api('github/pulls/1'));
    expect(page.agentReview).toMatchObject({
      verdict: 'ready',
      agent: 'claude-prd-1-review',
      sha: 'sha1',
      moved: false,
    });

    // The branch moves on: the page marks the review as older than its head.
    gh.pulls[0] = pr(1, { body: 'Closes PRD-1.', sha: 'sha1b' });
    expect((await body(await api('github/pulls/1'))).agentReview).toMatchObject({ sha: 'sha1', moved: true });
    gh.pulls[0] = pr(1, { body: 'Closes PRD-1.' });
  });

  it('refuses a review from anyone but the task’s agent, a bad verdict, or an empty note', async () => {
    const ok = { verdict: 'ready', note: 'Fine.', by: 'claude-prd-1-review' };
    expect((await verdict('PRD-1', { ...ok, by: 'claude-other' })).status).toBe(409);
    expect((await verdict('PRD-1', { ...ok, by: undefined })).status).toBe(400);
    expect((await verdict('PRD-1', { ...ok, verdict: 'great' })).status).toBe(400);
    expect((await verdict('PRD-1', { ...ok, note: '  ' })).status).toBe(400);
    // A task with no open pull request has nothing to review.
    await api('tasks/PRD-8/claim', { method: 'POST', body: { agent: 'claude-prd-8' } });
    expect(await body(await verdict('PRD-8', { ...ok, by: 'claude-prd-8' }))).toMatchObject({
      status: 409,
      error: expect.stringMatching(/no open pull request/),
    });
  });

  it('turns a changes verdict into the fix path, carrying the note', async () => {
    await api('tasks/PRD-7/claim', { method: 'POST', body: { agent: 'claude-prd-7-review' } });
    const res = await body(
      await verdict('PRD-7', {
        verdict: 'changes',
        note: 'The empty state is missing in `web/src/List.jsx`.',
        by: 'claude-prd-7-review',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.task.comments.at(-1).text).toMatch(/^Agent review of #7 at sha7: Needs changes/);

    const fix = await body(await api('github/pulls/7/fix', { method: 'POST', body: {} }));
    expect(fix.status).toBe(200);
    expect(fix.run).toMatchObject({ agent: 'claude-prd-7-fix', kind: 'fix-pr' });
    const text = gh.fires.at(-1);
    expect(text).toContain('What is wrong:\nAn agent’s review of sha7 (claude-prd-7-review) needs changes:');
    expect(text).toContain('The empty state is missing in `web/src/List.jsx`.');
  });

  it('keeps Safe to merge? for Dependabot pull requests, and its agent answers the same way', async () => {
    const res = await body(await review(9));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ kind: 'review', trigger: 'review' });
    expect(res.task.claim).toMatch(/-check$/u);
    expect(gh.fires.at(-1)).toContain('Mode: review\nPull request: #9');

    const answer = await body(
      await verdict(res.task.wid, {
        verdict: 'follow-up',
        note: 'Safe; DEBT-9 tracks the deprecation.',
        by: res.task.claim,
      }),
    );
    expect(answer.review).toMatchObject({ pr: 9, verdict: 'follow-up', sha: 'sha9' });
    expect((await body(await api('github/pulls/9'))).agentReview).toMatchObject({ verdict: 'follow-up' });
  });

  it('is not a mode the generic start accepts', async () => {
    const res = await body(await api('agents/start', { method: 'POST', body: { ref: 'PRD-8', mode: 'pr-review' } }));
    expect(res.status).toBe(400);
  });
});
