import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

// A chase's road captain answers a risky pull request of its chase with `review <its task> --verdict …` (BRK-326,
// prompts/core.md "Captaining a chase" step 3), though another agent holds the task. Only the captain of an open chase
// that holds the task gains it; the holder's review is unchanged.

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const pulls = [];
let fired = 0;

function pr(number, text) {
  return {
    number,
    title: `PR ${number}`,
    body: text,
    draft: false,
    state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { ref: `branch-${number}`, sha: `sha${number}` },
    user: { login: 'claude[bot]' },
    created_at: '2026-10-09T09:00:00Z',
    updated_at: '2026-10-09T10:00:00Z',
    merged_at: null,
    closed_at: null,
  };
}

const verdict = (ref, payload) => api(`tasks/${ref}/review`, { method: 'POST', body: payload });
const chase = async (slug, input) => body(await api(`features/${slug}/chase`, { method: 'POST', body: input }));
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;

describe('a road captain reviews its chase’s pull requests (BRK-326)', () => {
  let spy;
  let crew;
  let duo;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const json = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.href === FIRE) {
        JSON.parse(init.body);
        const id = `session_k${++fired}`;
        return json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
      }
      const path = url.pathname;
      if (path === `${REPO}/installation`) return json({ id: 7 });
      if (path.startsWith('/app/installations/'))
        return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (path === `${REPO}/pulls`) return json(pulls);
      if (path === `${REPO}/commits` || path === `${REPO}/dependabot/alerts`) return json([]);
      if (path === `${REPO}/actions/runs`) return json({ workflow_runs: [] });
      const m = /\/pulls\/(\d+)$/u.exec(path);
      if (m)
        return json({
          ...pulls.find((p) => String(p.number) === m[1]),
          mergeable: true,
          mergeable_state: 'clean',
          commits: 1,
          changed_files: 0,
          base: { ref: 'main' },
        });
      if (/\/check-runs$/u.test(path)) return json({ check_runs: [] });
      if (/\/status$/u.test(path)) return json({ state: 'success', statuses: [] });
      if (/\/pulls\/\d+\/(comments|files|reviews)$/u.test(path)) return json([]);
      return json({ message: 'Not Found' }, 404);
    });
    // Crew: two tasks, the second waiting on the first. Duo: one task. And one task in no chase.
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Crew one', project: 'ops', who: 'agent', tags: ['crew'], horizon: 'now' },
          { description: 'Crew two', project: 'ops', who: 'agent', tags: ['crew'], horizon: 'now', depends: ['OPS-1'] },
          { description: 'Duo one', project: 'product', who: 'agent', tags: ['duo'], horizon: 'now' },
          { description: 'Alone', project: 'ops', who: 'agent', horizon: 'later' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'PRD-1', 'OPS-3']);
    for (const slug of ['crew', 'duo'])
      expect((await api('features', { method: 'POST', body: { slug } })).status).toBe(201);
    await api('agents/settings', { method: 'PATCH', body: { plan: 'max5', max: 12, hourly: 30 } });
    crew = (await chase('crew', { on: true, captain: true })).chase.captain.agent;
    duo = (await chase('duo', { on: true, captain: true })).chase.captain.agent;
    expect([crew, duo]).toEqual(['claude-captain-crew-1', 'claude-captain-duo-1']);
    pulls.push(pr(1, 'Closes OPS-1.'), pr(2, 'Closes OPS-2.'), pr(3, 'Closes PRD-1.'), pr(4, 'Closes OPS-3.'));
    expect((await api('github/sync', { method: 'POST' })).status).toBe(200);
  });
  afterAll(() => spy.mockRestore());

  it('records the captain’s review of a chase task it doesn’t hold, with its name', async () => {
    const holder = (await task('OPS-1')).claim;
    expect(holder).toBeTruthy();
    expect(holder).not.toBe(crew);
    const res = await body(await verdict('OPS-1', { verdict: 'follow-up', note: 'Migration needs a test.', by: crew }));
    expect(res.status).toBe(201);
    expect(res.review).toMatchObject({ pr: 1, verdict: 'follow-up', agent: crew, sha: 'sha1' });
    expect(res.task.claim).toBe(holder);
    expect(res.task.comments.at(-1)).toMatchObject({
      by: crew,
      text: expect.stringMatching(/^Agent review of #1 at sha1: Ready with a follow-up\n\nMigration needs a test\./),
    });
    expect((await body(await api('github/pulls/1'))).agentReview).toMatchObject({ agent: crew, verdict: 'follow-up' });
    // An unclaimed task of the chase, waiting on the first, is the captain's to review too.
    expect((await task('OPS-2')).claim).toBeFalsy();
    expect((await verdict('OPS-2', { verdict: 'ready', note: 'Fine.', by: crew })).status).toBe(201);
  });

  it('refuses the captain of another chase, a task in no chase, and an agent with no captain task', async () => {
    const ok = { verdict: 'ready', note: 'Fine.' };
    expect(await body(await verdict('OPS-1', { ...ok, by: duo }))).toMatchObject({
      status: 409,
      error: expect.stringMatching(/claim it first/),
    });
    expect((await verdict('PRD-1', { ...ok, by: crew })).status).toBe(409);
    expect((await verdict('OPS-3', { ...ok, by: crew })).status).toBe(409);
    expect((await verdict('OPS-1', { ...ok, by: 'claude-nobody' })).status).toBe(409);
    // The duo captain reviews its own chase's task.
    expect((await verdict('PRD-1', { ...ok, by: duo })).status).toBe(201);
  });

  it('leaves the holder’s review as it was', async () => {
    const holder = (await task('OPS-1')).claim;
    const res = await body(await verdict('OPS-1', { verdict: 'ready', note: 'Done.', by: holder }));
    expect(res.status).toBe(201);
    expect(res.review).toMatchObject({ pr: 1, verdict: 'ready', agent: holder });
  });

  it('loses it once the chase stops', async () => {
    expect((await chase('crew', { on: false })).status).toBe(200);
    expect((await verdict('OPS-2', { verdict: 'ready', note: 'Fine.', by: crew })).status).toBe(409);
  });
});
