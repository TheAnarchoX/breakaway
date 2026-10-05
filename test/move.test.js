import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveStage, moveTask, releases, repoShape } from '../src/move.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, setPipeline } from './helpers.js';

// Move to breakaway's deploy flow (WEB-12, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, sections 3 and 6).
const body = async (res) => ({ code: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

describe('what the default branch suggests', () => {
  it('finds a Worker from a wrangler config at the root', () => {
    expect(repoShape({ root: ['wrangler.jsonc', 'README.md'] })).toEqual({ worker: true, package: null });
    expect(repoShape({ root: ['wrangler.toml'] }).worker).toBe(true);
    expect(repoShape({ root: ['wrangler.example.toml', 'README.md'] }).worker).toBe(false);
  });

  it('finds a package from package.json, and whether it is private', () => {
    expect(repoShape({ root: ['package.json'], packageJson: '{"name":"@acme/widgets","version":"1.0.0"}' })).toEqual({
      worker: false,
      package: { name: '@acme/widgets', private: false },
    });
    expect(repoShape({ packageJson: '{"name":"widgets","private":true}' }).package).toEqual({
      name: 'widgets',
      private: true,
    });
    // A project's package.json (no name, no version) and one that doesn't parse name no package.
    expect(repoShape({ packageJson: '{"scripts":{}}' }).package).toBeNull();
    expect(repoShape({ packageJson: '{ nope' }).package).toBeNull();
    expect(releases(repoShape({ packageJson: '{"name":"widgets","private":true}' }))).toBe(false);
    expect(releases(repoShape({ packageJson: '{"name":"widgets"}' }))).toBe(true);
  });

  it('words the task for the flow the repository needs', () => {
    const repo = { name: 'Widgets', github: 'acme/widgets' };
    expect(moveTask(repo, null).description).toBe('Move Widgets to breakaway’s deploy flow');
    expect(moveTask(repo, { worker: false, package: { name: 'widgets', private: false } }).description).toBe(
      'Move Widgets to breakaway’s release flow',
    );
    expect(moveTask(repo, { worker: true, package: { name: 'widgets', private: false } }).description).toBe(
      'Move Widgets to breakaway’s deploy flow',
    );
    const task = moveTask(repo, null);
    expect(task.brief).toMatch(/\.agents\/skills\/pipeline\/SKILL\.md/u);
    expect(task.brief).toMatch(/acme\/widgets/u);
    expect(task.done_when).toMatch(/\+owner task that depends on this one/u);
  });

  it('works out the card’s stage from the task and its pull requests', () => {
    expect(moveStage(null)).toBe('start');
    expect(moveStage({ status: 'deleted' })).toBe('start');
    expect(moveStage({ status: 'pending', claim: 'claude-x' })).toBe('running');
    expect(moveStage({ status: 'pending', claim: 'claude-x' }, [{ state: 'open' }])).toBe('pr');
    expect(moveStage({ status: 'pending', claim: null }, [{ state: 'open' }])).toBe('pr');
    expect(moveStage({ status: 'pending', claim: null })).toBe('stopped');
    expect(moveStage({ status: 'pending', claim: null }, [{ state: 'closed' }])).toBe('stopped');
    expect(moveStage({ status: 'completed' }, [{ state: 'merged' }])).toBe('merged');
    expect(moveStage({ status: 'completed' }, [])).toBe('start');
  });
});

// GitHub and the routine, mocked for acme/widgets.
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/widgets';
const gh = {
  root: ['wrangler.jsonc', 'package.json'],
  pkg: '{"name":"widgets","private":true}',
  pulls: [],
  head: 'h1',
};
const fires = [];
let failFire = false;

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.href === FIRE) {
      if (failFire) return reply({ error: { message: 'routine is paused' } }, 400);
      fires.push(JSON.parse(init.body).text);
      const id = `session_m${fires.length}`;
      return reply({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    const path = url.pathname;
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) throw new Error(`unexpected write ${path}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const rest = path.slice(REPO.length);
    if (rest === '/contents/') return reply(gh.root.map((name) => ({ name, type: 'file' })));
    if (rest === '/contents/package.json') return reply({ type: 'file', encoding: 'base64', content: b64(gh.pkg) });
    if (rest === '/pulls') return reply(gh.pulls);
    if (/^\/commits\/[^/]+\/(check-runs|status)$/u.test(rest)) return reply({ check_runs: [], statuses: [] });
    if (/^\/pulls\/\d+\/reviews$/u.test(rest)) return reply([]);
    const one = /^\/pulls\/(\d+)$/u.exec(rest);
    if (one) return reply({ ...gh.pulls.find((p) => p.number === Number(one[1])), mergeable: true });
    if (rest === '/actions/runs') return reply({ workflow_runs: [] });
    if (rest === '/commits')
      return reply([
        {
          sha: gh.head,
          html_url: `https://github.com/acme/widgets/commit/${gh.head}`,
          commit: { message: 'A change', author: { name: 'x', date: '2026-10-04T10:00:00Z' } },
        },
      ]);
    if (['/dependabot/alerts', '/deployments', '/releases', '/tags'].includes(rest)) return reply([]);
    return reply({ message: 'Not Found' }, 404);
  });
}

const sync = async () => body(await api('github/sync', { method: 'POST' }));
const overview = async () => body(await api('github'));

/** The signed-in browser: the cookie from /login, from this origin. */
async function press(payload = {}, { origin = ORIGIN, slug = 'widgets' } = {}) {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  return body(
    await SELF.fetch(`${ORIGIN}/api/repos/${slug}/move`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload),
    }),
  );
}

function pull(number, wid, state = 'open') {
  return {
    number,
    title: `${wid}: Move Widgets to breakaway’s deploy flow`,
    state: state === 'open' ? 'open' : 'closed',
    merged_at: state === 'merged' ? '2026-10-05T10:00:00Z' : null,
    closed_at: state === 'open' ? null : '2026-10-05T10:00:00Z',
    body: `The move.\n\nCloses ${wid}.`,
    draft: false,
    head: { ref: 'claude/move', sha: `sha${number}` },
    user: { login: 'claude' },
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    created_at: '2026-10-05T09:00:00Z',
    updated_at: '2026-10-05T09:30:00Z',
  };
}

describe('Move to breakaway’s deploy flow', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
    failFire = false;
  });
  afterEach(() => spy.mockRestore());

  it('refuses the bearer token, another origin, and an agent, and makes nothing', async () => {
    const bearer = await body(await api('repos/widgets/move', { method: 'POST', body: {} }));
    expect(bearer).toMatchObject({ code: 403, error: /only the signed-in web board can move/u });
    expect(await press({}, { origin: 'https://elsewhere.example' })).toMatchObject({ code: 403 });
    expect(await press({ by: 'claude-x' })).toMatchObject({ code: 403, error: /only the owner/u });
    expect(await press({}, { slug: 'nope' })).toMatchObject({ code: 404 });
    expect(fires).toHaveLength(0);
    const view = await sync();
    expect(view.move).toMatchObject({ stage: 'start', task: null });
  });

  it('reads what the default branch suggests for the card’s words', async () => {
    const view = await overview();
    expect(view.move.shape).toEqual({ worker: true, package: { name: 'widgets', private: true } });
  });

  it('adds the move task and starts its agent on the owner’s press, and only once', async () => {
    const moved = await press({});
    expect(moved.code).toBe(201);
    expect(moved.task).toMatchObject({
      description: 'Move widgets to breakaway’s deploy flow',
      repo: 'widgets',
      horizon: 'now',
      tags: ['agent'],
      autostart: false,
      briefBy: 'board',
      claim: `claude-${moved.task.wid.toLowerCase()}`,
    });
    expect(moved.run).toMatchObject({ trigger: 'move', kind: 'build', status: 'started' });
    expect(fires.at(-1)).toMatch(new RegExp(`Task: ${moved.task.wid}`, 'u'));
    expect(fires.at(-1)).toMatch(/Move to breakaway’s deploy flow” on the GitHub page/u);
    expect(moved.move).toMatchObject({ stage: 'running', task: { wid: moved.task.wid, claim: moved.task.claim } });

    // A second press adds nothing and starts nobody: it shows the open one.
    const again = await press({});
    expect(again).toMatchObject({ code: 409, error: /already moving .+ is on it/u, move: { stage: 'running' } });
    expect(fires).toHaveLength(1);
    const view = await overview();
    expect(view.move).toMatchObject({ stage: 'running', task: { uuid: moved.task.uuid } });
    expect(view.move.task.session).toMatch(/^https:\/\/claude\.ai\/code\//u);

    // The agent stopped: the card shows its last comment, and Try again starts a new agent on the same task.
    const wid = moved.task.wid;
    await api(`tasks/${wid}/annotate`, {
      method: 'POST',
      body: { text: 'It deploys to Pages, which the flow doesn’t run.', by: moved.task.claim },
    });
    await api(`tasks/${wid}/release`, { method: 'POST', body: { agent: moved.task.claim } });
    const stopped = (await overview()).move;
    expect(stopped).toMatchObject({ stage: 'stopped', reason: { text: /deploys to Pages/u } });
    const retried = await press({});
    expect(retried).toMatchObject({ code: 200, task: { uuid: moved.task.uuid }, move: { stage: 'running' } });
    expect(fires).toHaveLength(2);

    // Its pull request opens: the card follows it, and the press still adds nothing.
    gh.pulls = [pull(41, wid)];
    gh.head = 'h2';
    const view2 = await sync();
    expect(view2.move).toMatchObject({ stage: 'pr', pr: { number: 41, state: 'open' } });
    expect(await press({})).toMatchObject({ code: 409, error: /pull request #41 is open/u });
  });

  it('refuses a repository with a pipeline, and shows no card for it', async () => {
    await setPipeline();
    expect(await press({})).toMatchObject({ code: 409, error: /has a pipeline already/u });
    expect((await overview()).move).toBeNull();
    await api('repos/widgets', { method: 'PATCH', body: { pipeline: null } });
  });
});

describe('a press whose agent can’t start', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('keeps the task with why, so the card offers Try again', async () => {
    // A store of its own: the earlier describe's task is gone from this one only if it finished, so finish it.
    const view = await overview();
    if (view.move?.task) await api(`tasks/${view.move.task.wid}/done`, { method: 'POST', body: {} });
    gh.pulls = [];
    failFire = true;
    const failed = await press({});
    expect(failed.code).toBeGreaterThanOrEqual(400);
    const after = (await overview()).move;
    expect(after).toMatchObject({ stage: 'stopped', reason: { by: 'board', text: /^Couldn’t start an agent/u } });
    failFire = false;
    expect(await press({})).toMatchObject({ code: 200, move: { stage: 'running' } });
  });
});
