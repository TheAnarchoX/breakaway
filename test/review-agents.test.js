import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const fires = [];

function pull(number, login) {
  return {
    number,
    title: `Bump vite from 7.0.0 to 7.1.0`,
    body: '',
    draft: false,
    state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    node_id: `PR_${number}`,
    head: { ref: `dependabot/npm_and_yarn/vite-7.1.0`, sha: `sha${number}` },
    user: { login },
    created_at: '2026-09-29T09:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
    merge_commit_sha: null,
    merged_at: null,
    closed_at: null,
  };
}

describe('Safe to merge? on Dependabot pull requests', () => {
  let spy;
  beforeEach(() => {
    fires.length = 0;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const json = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.href === FIRE) {
        fires.push(JSON.parse(init.body).text);
        return json({
          claude_code_session_id: `session_r${fires.length}`,
          claude_code_session_url: `https://claude.ai/code/session_r${fires.length}`,
        });
      }
      const path = url.pathname;
      if (path === `${REPO}/installation`) return json({ id: 7 });
      if (path.startsWith('/app/installations/'))
        return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (path === `${REPO}/pulls`) return json([pull(41, 'dependabot[bot]'), pull(42, 'someone')]);
      if (path === `${REPO}/actions/runs`) return json({ workflow_runs: [] });
      if (path === `${REPO}/commits` || path === `${REPO}/dependabot/alerts`) return json([]);
      if (/\/pulls\/\d+$/u.test(path))
        return json({
          ...pull(Number(path.split('/').pop()), 'dependabot[bot]'),
          mergeable: true,
          mergeable_state: 'clean',
          commits: 1,
          changed_files: 2,
          base: { ref: 'main' },
        });
      if (/\/pulls\/\d+\/(comments|reviews)$/u.test(path)) return json([]);
      if (/\/check-runs$/u.test(path)) return json({ check_runs: [] });
      if (/\/status$/u.test(path)) return json({ state: 'success', statuses: [] });
      return json({ message: 'Not Found' }, 404);
    });
  });
  afterEach(() => spy.mockRestore());

  it('makes a task for the pull request and starts an agent in review mode', async () => {
    await api('github/sync', { method: 'POST' });
    const res = await body(await api('github/pulls/41/review', { method: 'POST', body: {} }));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      project: 'debt',
      tags: ['agent'],
      pr: '41',
      claim: `claude-${res.task.wid.toLowerCase()}-check`,
    });
    expect(res.run).toMatchObject({ trigger: 'review', kind: 'review', status: 'started' });
    expect(fires.at(-1)).toMatch(new RegExp(`Task: ${res.task.wid}\\n[\\s\\S]*Mode: review\\nPull request: #41`, 'u'));

    // The pull request is open and linked to the task, yet the agent still counts as running.
    const { running } = await body(await api('agents'));
    expect(running.map((r) => r.wid)).toContain(res.task.wid);

    // Asking again doesn't make a second task or a second agent while the first is working.
    await api(`tasks/${res.task.wid}/session`, {
      method: 'POST',
      body: { agent: res.task.claim, entries: [{ kind: 'message', text: 'testing' }] },
    });
    const again = await body(await api('github/pulls/41/review', { method: 'POST', body: {} }));
    expect(again).toMatchObject({ run: null, already: expect.stringMatching(/is working on it right now/) });
    expect(again.task.uuid).toBe(res.task.uuid);
    expect(fires).toHaveLength(1);
  });

  it('refuses a pull request that isn’t Dependabot’s or isn’t there', async () => {
    await api('github/sync', { method: 'POST' });
    expect((await api('github/pulls/42/review', { method: 'POST', body: {} })).status).toBe(400);
    expect((await api('github/pulls/99/review', { method: 'POST', body: {} })).status).toBe(404);
    expect(fires).toHaveLength(0);
  });
});
