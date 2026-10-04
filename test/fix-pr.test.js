import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const gh = { pulls: [], mergeable: {}, checks: {}, reviews: {}, fires: [] };

function pr(number, { title, body: text = '', draft = false } = {}) {
  return {
    number,
    title: title ?? `PR ${number}`,
    body: text,
    draft,
    state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { ref: `branch-${number}`, sha: `sha${number}` },
    user: { login: 'claude[bot]' },
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
      const id = `session_p${gh.fires.length}`;
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
    m = /\/pulls\/(\d+)\/reviews$/u.exec(path);
    if (m) return json(gh.reviews[m[1]] ?? []);
    m = /\/commits\/([^/]+)\/check-runs$/u.exec(path);
    if (m) return json({ check_runs: gh.checks[m[1]] ?? [] });
    if (/\/commits\/[^/]+\/status$/u.test(path)) return json({ state: 'success', statuses: [] });
    if (/\/pulls\/\d+\/(comments|files)$/u.test(path)) return json([]);
    return json({ message: 'Not Found' }, 404);
  });
}

const fix = (number, payload = {}) => api(`github/pulls/${number}/fix`, { method: 'POST', body: payload });
const failed = {
  name: 'Test and build',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/x/actions/runs/1',
};

describe('fix with an agent on a pull request', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('sets up a board and pull requests', async () => {
    await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Add a widget', project: 'product', tags: ['agent'], horizon: 'now' },
          { description: 'Other work', project: 'ops', tags: ['agent'], horizon: 'now' },
          { description: 'Held by a person', project: 'brand', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    gh.pulls = [
      pr(1, { title: 'PRD-1: Add a widget', body: 'Closes PRD-1.' }),
      pr(2, { title: 'Bump sharp' }),
      pr(3, { title: 'Clean one' }),
      pr(4, { title: 'A draft', draft: true }),
      pr(5, { title: 'Reviewed', body: 'Closes OPS-1.' }),
      pr(6, { title: 'Held', body: 'Closes BRD-1.' }),
    ];
    gh.mergeable = { 1: [false, 'dirty'], 2: [true, 'blocked'], 4: [false, 'dirty'], 6: [false, 'dirty'] };
    gh.checks = { sha2: [failed] };
    gh.reviews = { 5: [{ state: 'CHANGES_REQUESTED', user: { login: 'owner' } }] };
    await api('github/sync', { method: 'POST' });
    await api('github/sync', { method: 'POST' });
    await api('agents/settings', { method: 'PATCH', body: { max: 6 } });
  });

  it('starts an agent on the PR’s own task, even though the task is in review', async () => {
    const res = await body(await fix(1, { note: 'Keep main’s copy.' }));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ agent: 'claude-prd-1-fix', kind: 'fix-pr', trigger: 'pr', status: 'started' });
    expect(res.task).toMatchObject({
      wid: 'PRD-1',
      claim: 'claude-prd-1-fix',
      session: 'https://claude.ai/code/session_p1',
    });
    const text = gh.fires.at(-1);
    expect(text).toMatch(
      /^Task: PRD-1\nTitle: Add a widget\nAgent name: claude-prd-1-fix\nStarted: to fix a pull request/,
    );
    expect(text).toContain('Mode: fix-pr\nPull request: #1');
    expect(text).toContain('What is wrong:\nIt conflicts with main');
    expect(text).toContain("Owner's note: Keep main’s copy.");
  });

  it('won’t start a second while the first is still starting, and the page names it (WEB-6)', async () => {
    const before = gh.fires.length;
    const again = await body(await fix(1));
    expect(again).toMatchObject({ run: null, already: 'claude-prd-1-fix is starting' });
    expect(gh.fires).toHaveLength(before);
    const page = await body(await api('github/pulls/1'));
    expect(page.agent).toEqual({
      wid: 'PRD-1',
      agent: 'claude-prd-1-fix',
      session: 'https://claude.ai/code/session_p1',
      busy: 'claude-prd-1-fix is starting',
    });
    expect((await body(await api('github/pulls/3'))).agent).toBeNull();
  });

  it('counts as a running agent and won’t start a second while the first is producing output', async () => {
    const { running } = await body(await api('agents'));
    expect(running.map((r) => r.wid)).toContain('PRD-1');
    await api('tasks/PRD-1/session', {
      method: 'POST',
      body: { agent: 'claude-prd-1-fix', entries: [{ kind: 'message', text: 'merging main' }] },
    });
    const before = gh.fires.length;
    const again = await body(await fix(1));
    expect(again).toMatchObject({ run: null, already: 'claude-prd-1-fix is working on it right now' });
    expect(gh.fires).toHaveLength(before);
  });

  it('never takes a claim from a person', async () => {
    await api('tasks/BRD-1/claim', { method: 'POST', body: { agent: 'owner' } });
    expect(await body(await fix(6))).toMatchObject({ run: null, already: 'owner has it' });
  });

  it('makes a task from a PR with none (Tech debt), naming the failing checks', async () => {
    const res = await body(await fix(2));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      project: 'debt',
      tags: ['agent'],
      pr: '2',
      description: 'Fix pull request #2: Bump sharp',
      claim: `claude-${res.task.wid.toLowerCase()}-fix`,
    });
    expect(gh.fires.at(-1)).toContain('Checks are failing: Test and build');
    // The task now closes #2, so asking again finds it rather than making another.
    await api(`tasks/${res.task.wid}/session`, {
      method: 'POST',
      body: { agent: res.task.claim, entries: [{ kind: 'message', text: 'on it' }] },
    });
    expect((await body(await fix(2))).already).toMatch(/is working on it/);
  });

  it('addresses review comments when changes were requested, taking over the claim of an agent that has gone quiet', async () => {
    await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-ops-1' } }); // the build agent that opened the PR
    const res = await body(await fix(5));
    expect(res.status).toBe(200);
    expect(res.task.claim).toBe('claude-ops-1-fix');
    expect(res.task.comments.at(-1)).toMatchObject({
      by: 'board',
      text: 'claude-ops-1-fix took over the claim from claude-ops-1.',
    });
    expect(gh.fires.at(-1)).toContain('review comments to address (changes were requested)');
  });

  it('refuses what an agent can’t fix, and says why', async () => {
    expect((await body(await fix(3))).error).toMatch(/nothing for an agent to fix/);
    expect((await body(await fix(4))).error).toMatch(/draft/);
    expect((await body(await fix(3, { problem: 'failing' }))).error).toMatch(/doesn’t have that problem/);
    expect((await body(await fix(3, { problem: 'lint' }))).status).toBe(400);
    expect((await body(await fix(99))).status).toBe(404);
  });

  it('is not a mode the generic start accepts', async () => {
    const res = await body(await api('agents/start', { method: 'POST', body: { ref: 'OPS-1', mode: 'fix-pr' } }));
    expect(res.status).toBe(400);
  });
});
