import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptPlaceholders, slugFrom, startFix, wizardSteps } from '../src/wizard.js';
import { routinePrompt } from '../src/prompt.js';
import TEMPLATE from '../prompts/repository.md?raw';
import BREAKAWAY_PROMPT from '../prompts/breakaway.md?raw';
import SIDEKICK from '../prompts/add-repository.md?raw';

const ALL = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'write',
  deployments: 'read',
  vulnerability_alerts: 'read',
};
const SCRATCH = '/repos/acme/breakaway';
const PATH = 'tools/tasks/routine-prompt.md';
const FILLED = routinePrompt(TEMPLATE, {
  slug: 'breakaway',
  name: 'breakaway',
  github: 'acme/breakaway',
  areas: [{ project: 'product', prefix: 'BRK' }],
});

describe('the wizard, the pure parts', () => {
  it('finds the placeholders a prompt still has, and nothing else', () => {
    expect(promptPlaceholders(TEMPLATE)).toEqual(expect.arrayContaining(['<name>', '<slug>', '<path of the skill>']));
    // After repos init, only the sections are left for the owner.
    const left = promptPlaceholders(FILLED);
    expect(left).toHaveLength(6);
    expect(left[0]).toMatch(/^<How work is done here/);
    expect(promptPlaceholders(BREAKAWAY_PROMPT)).toEqual([]);
    expect(
      promptPlaceholders(
        'Run `npx breakaway show <ID>`, see <https://example.com>, <details>open</details>, <!-- <A note> -->, <br/>.',
      ),
    ).toEqual([]);
    expect(promptPlaceholders('End it with "Closes <ID>." and comment on <the task>.')).toEqual([]);
    expect(promptPlaceholders('## Checks\n\n<The commands that must pass>\n\n<The commands that must pass>')).toEqual([
      '<The commands that must pass>',
    ]);
  });

  it('suggests a slug from the GitHub name', () => {
    expect(slugFrom('acme/Breakaway_App')).toBe('breakaway-app');
    expect(slugFrom('https://github.com/someone/2fast.git')).toBe('fast');
    expect(slugFrom('someone/123')).toBeNull();
  });

  it('starts at creating the repository, and the step to do now is the first not done', () => {
    const empty = wizardSteps({});
    expect(empty.steps.map((s) => s.id)).toEqual([
      'create',
      'install',
      'register',
      'init',
      'deploys',
      'prompt',
      'routine',
      'connect',
      'task',
      'agent',
    ]);
    expect(empty.now).toBe('create');
    expect(empty.steps.find((s) => s.id === 'install').problem.fix).toMatch(/Connect the GitHub App/);
    // Registered first, the GitHub steps still come first.
    expect(wizardSteps({ registered: { slug: 'x' }, app: true }).now).toBe('create');
  });

  it('offers Deploys after init as an optional step that never blocks the ones after it (WEB-14)', () => {
    const facts = {
      registered: { slug: 'x', pipeline: null },
      app: true,
      synced: 1,
      prompt: { status: 'ok', placeholders: [] },
      routine: true,
      connections: ['github.install', 'github.permissions', 'github.automerge'].map((id) => ({ id, state: 'working' })),
      work: { claimed: { wid: 'X-1' } },
    };
    const off = wizardSteps(facts);
    expect(off.steps.find((s) => s.id === 'deploys')).toMatchObject({
      name: 'Deploy with breakaway (optional)',
      optional: true,
      done: false,
    });
    // Init done, the step after Deploys is the one to do now; with the agent's checks done too, every step is.
    expect(wizardSteps({ ...facts, work: {} }).now).toBe('task');
    expect(off.now).toBe('agent');
    const all = { started: { wid: 'X-1' }, output: { wid: 'X-1' }, pull: { wid: 'X-1' }, merged: { wid: 'X-1' } };
    expect(wizardSteps({ ...facts, work: { ...facts.work, ...all } })).toMatchObject({ now: null, done: true });
    // A pipeline ticks it.
    const on = wizardSteps({ ...facts, registered: { slug: 'x', pipeline: { workers: {} } } });
    expect(on.steps.find((s) => s.id === 'deploys').done).toBe(true);
  });

  it('offers Start on the task it found, and keeps a failed start with its fix in the agent step (WEB-40)', () => {
    const facts = {
      registered: { slug: 'x', pipeline: null },
      app: true,
      synced: 1,
      prompt: { status: 'ok', placeholders: [] },
      routine: true,
      connections: ['github.install', 'github.permissions', 'github.automerge'].map((id) => ({ id, state: 'working' })),
      work: { claimed: { wid: 'X-1' } },
      candidate: { uuid: 'u1', wid: 'X-1', description: 'Add a README', blocker: null },
    };
    const agent = (f) => wizardSteps(f).steps.find((s) => s.id === 'agent');
    expect(agent(facts)).toMatchObject({ start: { wid: 'X-1', blocker: null }, failure: null });
    // No routine yet: nothing to start with.
    expect(agent({ ...facts, routine: false }).start).toBeNull();
    // Started: no second Start, unless the last start failed.
    const started = { ...facts, work: { ...facts.work, started: { wid: 'X-1' } } };
    expect(agent(started).start).toBeNull();
    const failed = {
      ...facts,
      failure: { wid: 'X-1', error: 'the routine’s token was refused: connect the routine again', at: 'then' },
    };
    expect(agent(failed)).toMatchObject({
      start: { wid: 'X-1' },
      failure: { wid: 'X-1', error: expect.stringMatching(/token was refused/), step: 'connect' },
    });
    expect(agent(failed).failure.fix).toMatch(/new token.*connect the routine again/);
    // Once the step is done, an old failure is history.
    const all = { started: { wid: 'X-1' }, output: { wid: 'X-1' }, pull: { wid: 'X-1' }, merged: { wid: 'X-1' } };
    expect(agent({ ...failed, work: { ...facts.work, ...all } })).toMatchObject({ start: null, failure: null });
  });

  it('says what to do about each way a start fails (WEB-40)', () => {
    expect(startFix('the routine’s token was refused: connect the routine again')).toMatchObject({ step: 'connect' });
    expect(startFix('the agent routine isn’t connected yet (docs/tasks.md#cloud-agents-from-the-board)')).toMatchObject(
      { step: 'connect' },
    );
    expect(startFix('the x routine is paused on claude.ai')).toMatchObject({ link: 'routines' });
    expect(
      startFix('x’s agent prompt (p on main) still has a placeholder, <A>, which an agent would take'),
    ).toMatchObject({ step: 'prompt' });
    expect(startFix('Claude’s hourly limit for starting sessions is reached (try again after 60 seconds)').fix).toMatch(
      /Wait/,
    );
    expect(startFix('3 agents are already running (the limit is 3)').fix).toMatch(/Settings/);
    expect(startFix('X-1 can’t start an agent: it isn’t tagged +agent').fix).toMatch(/\+agent/);
    expect(startFix('Claude couldn’t start the session (404: Not Found)')).toMatchObject({ step: 'connect' });
    expect(startFix('couldn’t reach Claude to start the session; try again').fix).toMatch(/try again/i);
    // BRK-144's wordings.
    expect(startFix('the x routine’s token has no access to it: make a new token')).toMatchObject({ step: 'connect' });
    expect(startFix('the x routine is gone on claude.ai: make it again')).toMatchObject({ step: 'connect' });
    expect(startFix('x’s agent routine is paused because Claude refused it (…)')).toMatchObject({ step: 'connect' });
    expect(startFix('something new')).toMatchObject({ link: 'routines' });
  });
});

describe('the sidekick prompt', () => {
  it('has the two placeholders the board fills in, and keeps owner-only steps the owner’s', () => {
    expect(SIDEKICK).toContain('<slug>');
    expect(SIDEKICK).toContain('<owner/name>');
    expect(SIDEKICK).toMatch(/never run .*repos add/i);
    expect(SIDEKICK).toMatch(/agents-connect/);
    expect(SIDEKICK).toMatch(/token/);
    expect(SIDEKICK).toMatch(/already with commits/);
    expect(SIDEKICK).toMatch(/`app` field/);
    expect(SIDEKICK).not.toMatch(/widgets tasks/);
  });
});

/** A pretend GitHub: breakaway is created and installed as the test goes. */
const gh = {};
function mockGitHub() {
  Object.assign(gh, { installed: false, autoMerge: false, prompt: null, writes: [], fires: 0 });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    const method = init.method ?? 'GET';
    // breakaway's routine (TASKS_ROUTINES in vitest.config.js), for the starts below.
    if (url.href === 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire') {
      gh.fires = (gh.fires ?? 0) + 1;
      return reply({
        type: 'routine_fire',
        claude_code_session_id: 'session_wiz',
        claude_code_session_url: 'https://claude.ai/code/session_wiz',
      });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (method !== 'GET' && !path.endsWith('/access_tokens')) {
      gh.writes.push([method, path]);
      return reply({ message: 'no writes here' }, 500);
    }
    if (path === '/app')
      return reply({
        id: 424242,
        slug: 'widgets-tasks',
        name: 'widgets tasks',
        html_url: 'https://github.com/apps/widgets-tasks',
      });
    if (path === `${SCRATCH}/installation`)
      return gh.installed
        ? reply({
            id: 91,
            permissions: { ...ALL },
            suspended_at: null,
            html_url: 'https://github.com/settings/installations/91',
          })
        : reply({ message: 'Not Found' }, 404);
    if (path === '/app/installations/91/access_tokens')
      return reply({ token: 'ghs_wizard', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === SCRATCH) return reply({ full_name: 'acme/breakaway', allow_auto_merge: gh.autoMerge });
    if (path === '/rate_limit')
      return reply({ resources: { core: { limit: 5000, remaining: 4999, reset: 1_790_000_000 } } });
    if (path === `${SCRATCH}/contents/${PATH}`) {
      return gh.prompt
        ? reply({
            content: btoa(String.fromCharCode(...new TextEncoder().encode(gh.prompt))),
            html_url: `https://github.com/acme/breakaway/blob/main/${PATH}`,
          })
        : reply({ message: 'Not Found' }, 404);
    }
    if (path === `${SCRATCH}/commits`)
      return reply([
        {
          sha: 'abc1234',
          html_url: 'https://github.com/x',
          commit: { message: 'Add the board', committer: { date: '2026-10-02T10:00:00Z' } },
        },
      ]);
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('the wizard, on the board', () => {
  let spy;
  beforeEach(() => {
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  const setup = async (s, query) => {
    s.promptCache = null;
    const res = await s.repoSetupApi({ check: true, ...query });
    expect(res.status).toBe(200);
    return res.body;
  };
  const step = (body, id) => body.steps.find((x) => x.id === id);

  it('ticks each step from what it can check, from an empty repository to a merged pull request', async () => {
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('wizard')), async (s) => {
      // Before it's registered: only the GitHub steps, by owner/name, with Connections' fix.
      let body = await setup(s, { github: 'https://github.com/acme/breakaway' });
      expect(body).toMatchObject({
        registered: false,
        github: 'acme/breakaway',
        suggestedSlug: 'breakaway',
        now: 'create',
      });
      expect(step(body, 'install').problem.fix).toMatch(/Install the App on acme\/breakaway/);

      gh.installed = true;
      s.setupLive = null;
      body = await setup(s, { github: 'acme/breakaway' });
      expect(step(body, 'create').done).toBe(true);
      expect(step(body, 'install').checks.map((c) => [c.id, c.done])).toEqual([
        ['installed', true],
        ['permissions', true],
        ['automerge', false],
      ]);
      expect(step(body, 'install').problem.fix).toMatch(/Allow auto-merge/);

      gh.autoMerge = true;
      s.setupLive = null;
      expect((await setup(s, { github: 'acme/breakaway' })).now).toBe('register');

      // Checking the form as it's filled in saves nothing.
      const dry = await s.reposAddApi({
        slug: 'breakaway',
        github: 'acme/breakaway',
        areas: ['product:BRK'],
        by: 'owner',
        dryRun: true,
      });
      expect(dry.body).toMatchObject({ dryRun: true, repo: { slug: 'breakaway' } });
      expect(s.repoBySlug('breakaway')).toBeNull();
      expect(
        (await s.reposAddApi({ slug: 'x', github: 'acme/x', areas: ['product:PRD'], dryRun: true })).body.error,
      ).toMatch(/PRD already belongs to widgets/);

      expect(
        (await s.reposAddApi({ slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'], by: 'owner' }))
          .status,
      ).toBe(201);
      s.setGhMeta('gh_empty', 'breakaway', 1);
      s.setGhMeta('gh_last_sync', 'breakaway', Date.now());
      body = await setup(s, { github: 'acme/breakaway' });
      expect(body).toMatchObject({ registered: true, slug: 'breakaway', now: 'init' });
      expect(step(body, 'deploys')).toMatchObject({ optional: true, done: false });
      expect(step(body, 'init').detail).toBe('no commits yet');
      expect(step(body, 'init').problem).toBeNull();

      // After init: the prompt is there, with the sections still to fill in.
      s.setGhMeta('gh_empty', 'breakaway', null);
      gh.prompt = FILLED;
      body = await setup(s, { slug: 'breakaway' });
      expect(body.now).toBe('prompt');
      expect(step(body, 'prompt').detail).toMatch(/^6 placeholders left: <How work is done here/);

      // Filled in; breakaway's routine is in the test's TASKS_ROUTINES, so it's connected.
      gh.prompt = FILLED.replace(/<[A-Z][^<>\n]*>/gu, 'Nothing special.');
      body = await setup(s, { slug: 'breakaway' });
      expect(step(body, 'prompt').done).toBe(true);
      expect(step(body, 'connect').done).toBe(true);
      expect(body.now).toBe('task');

      // A task claimed from its own checkout (the CLI sends the checkout's repository).
      const made = await s.create([{ description: 'Add a README', project: 'product', repo: 'breakaway' }]);
      const task = made.body.tasks[0];
      expect((await s.claim(task.wid, 'owner-laptop', false, 'breakaway')).status).toBe(200);
      await s.release(task.wid, 'owner-laptop');
      body = await setup(s, { slug: 'breakaway' });
      expect(step(body, 'task')).toMatchObject({ done: true, wid: 'BRK-1' });
      expect(body.now).toBe('agent');
      // The agent step offers Start on that task, and keeps a start Claude refused, with its fix (WEB-40).
      expect(step(body, 'agent').start).toMatchObject({ uuid: task.uuid, wid: 'BRK-1' });
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, error, started, repo) VALUES (?, 'claude-brk-1', 'manual', 'failed', 'the breakaway routine’s token was refused: connect the routine again', ?, 'breakaway')",
        task.uuid,
        Date.now(),
      );
      body = await setup(s, { slug: 'breakaway' });
      expect(step(body, 'agent').failure).toMatchObject({ wid: 'BRK-1', step: 'connect' });
      expect(step(body, 'agent').start).toMatchObject({ wid: 'BRK-1' });

      // The agent: started, live output, its pull request, and the merge.
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, started, repo) VALUES (?, 'claude-brk-1', 'manual', 'started', ?, 'breakaway')",
        task.uuid,
        Date.now(),
      );
      s.sql.exec("INSERT INTO agent_logs (task, at, data) VALUES (?, ?, '{}')", task.uuid, Date.now());
      expect((await s.update(task.wid, { pr: '2' })).status).toBe(200);
      body = await setup(s, { slug: 'breakaway' });
      expect(step(body, 'agent').checks.map((c) => [c.id, c.done])).toEqual([
        ['started', true],
        ['output', true],
        ['pull', true],
        ['merged', false],
      ]);
      expect(step(body, 'agent').checks[2].url).toBe('https://github.com/acme/breakaway/pull/2');
      // Started since: the failure and Start are gone.
      expect(step(body, 'agent')).toMatchObject({ start: null, failure: null });
      // The board finishes the task when its pull request merges.
      expect((await s.update(task.wid, { status: 'completed' })).status).toBe(200);
      body = await setup(s, { slug: 'breakaway' });
      // Deploys is optional: every step is done without a pipeline.
      expect(body).toMatchObject({ now: null, done: true });
      expect(step(body, 'deploys').done).toBe(false);

      // It only ever read GitHub.
      expect(gh.writes).toEqual([]);
    });
  });

  it('flags a prompt with placeholders left on Connections and the Agents view, and starts no agent there until it’s filled in (CLD-196)', async () => {
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('wizard-unfilled')), async (s) => {
      gh.installed = true;
      gh.autoMerge = true;
      expect(
        (await s.reposAddApi({ slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'], by: 'owner' }))
          .status,
      ).toBe(201);
      const made = await s.create([
        { description: 'Add a README', project: 'product', repo: 'breakaway', tags: ['agent'], horizon: 'now' },
      ]);
      const task = made.body.tasks[0];
      const routineRow = async () =>
        (await s.claudeConnections()).find((c) => c.id === 'claude.routine' && c.repo === 'breakaway');

      // repos init from before CLD-196: every section still a placeholder.
      gh.prompt = FILLED;
      s.promptCache = null;
      const prompt = (await s.routinePromptApi('breakaway')).body;
      expect(prompt.placeholders).toHaveLength(6);
      expect(prompt.placeholders[0]).toMatch(/^<How work is done here/);
      const row = await routineRow();
      expect(row).toMatchObject({ state: 'attention', link: `https://github.com/acme/breakaway/blob/main/${PATH}` });
      expect(row.detail).toMatch(/its agent prompt still has 6 placeholders, so agents don’t start$/);
      expect(row.fix).toMatch(
        /^Fill in each <…> left in tools\/tasks\/routine-prompt\.md on main \(<How work is done here/,
      );
      await expect(s.startAgent(task.uuid)).rejects.toThrow(
        /breakaway’s agent prompt \(tools\/tasks\/routine-prompt\.md on main\) still has 6 placeholders, <How work is done here.*Fill them in and merge/,
      );
      expect(gh.fires).toBe(0);
      expect(s.tasks.get(task.uuid).claim ?? null).toBeNull();

      // Filled in and merged: the row is back to its routine's own state, and the agent starts.
      gh.prompt = FILLED.replace(/<[A-Z][^<>\n]*>/gu, 'Nothing special.');
      s.promptCache = null;
      expect((await routineRow()).detail).not.toMatch(/placeholder/);
      const started = await s.startAgent(task.uuid);
      expect(started.run).toMatchObject({ agent: 'claude-brk-1', status: 'started' });
      expect(gh.fires).toBe(1);
    });
  });

  it('refuses a repository it can’t name', async () => {
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('wizard-bad')), async (s) => {
      expect((await s.repoSetupApi({ github: 'not a repo' })).status).toBe(400);
      expect((await s.repoSetupApi({ slug: 'nope' })).status).toBe(404);
    });
  });
});
