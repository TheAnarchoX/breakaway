import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generalAgentRequest, generalAgentSummary } from '../scripts/tasks/cli.js';
import { specPrompt } from '../src/spec-prompt.js';
import { api } from './helpers.js';

// Refine a spec with an agent on the server (docs/specs/IDEA-31-specs-view.md, section 4).
const body = async (res) => ({ ...(await res.json()), code: res.status });
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';

const spec = (wid, title) =>
  `# ${wid} · ${title}\n\nTask: ${wid} on the board · Status: draft\n\n## Problem\nIt’s slow.\n`;
// acme/widgets' specs on main, by file name.
const files = {
  'OPS-70-sort.md': spec('OPS-70', 'Sort the inbox'),
  'OPS-71-age.md': spec('OPS-71', 'The inbox, by age'),
  'OPS-72-badges.md': spec('OPS-72', 'Badges'),
  'OPS-73-force.md': spec('OPS-73', 'Forced'),
  'OPS-74-dry.md': spec('OPS-74', 'A dry run'),
  'OPS-75-cli.md': spec('OPS-75', 'From a terminal'),
};
const fires = [];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.href === FIRE) {
      fires.push(JSON.parse(init.body).text);
      return reply({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    const path = url.pathname;
    if (path === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/repos/acme/widgets/commits') return reply([]);
    const m = /^\/repos\/acme\/widgets\/contents\/docs\/specs\/(.+)$/u.exec(path);
    const text = m && files[decodeURIComponent(m[1])];
    if (!text) return reply({ message: 'Not Found' }, 404);
    return reply({ type: 'file', size: encoder.encode(text).length, encoding: 'base64', content: b64(text) });
  });
}

const refine = (extra) => api('agents/general', { method: 'POST', body: { force: true, ...extra } });
const add = async (tasks) => (await body(await api('tasks', { method: 'POST', body: tasks }))).tasks;
const count = async () => (await body(await api('tasks?status=all'))).tasks.length;

describe('refine a spec with an agent (BRK-120)', () => {
  let spy;
  beforeEach(async () => {
    spy = mockFetch();
    await runInDurableObject(stub(), (store) => {
      store.specsCache = {};
    });
  });
  afterEach(() => spy.mockRestore());

  it('writes the prompt from the spec and its tasks, sets the task’s spec, and starts a general agent', async () => {
    const [open, done, claimed] = await add([
      { description: 'Sort by age', project: 'ops', who: 'agent', tags: ['inbox'], spec: 'docs/specs/OPS-70-sort.md' },
      { description: 'Show the age', project: 'ops', spec: './docs/specs/OPS-70-sort.md' },
      { description: 'Sort on the phone', project: 'ops', who: 'agent', spec: 'docs/specs/OPS-70-sort.md' },
      { description: 'Unrelated', project: 'ops', spec: 'docs/specs/OPS-71-age.md' },
    ]);
    await api(`tasks/${done.wid}/done`, { method: 'POST' });
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    const res = await body(await refine({ spec: 'docs/specs/OPS-70-sort.md', note: 'Sort oldest first, too.' }));
    expect(res.code).toBe(201);
    const t = res.task;
    expect(t).toMatchObject({
      wid: null,
      project: null,
      horizon: 'now',
      autostart: true,
      spec: 'docs/specs/OPS-70-sort.md',
      description: 'Refine the spec: OPS-70 · Sort the inbox',
    });
    expect(t.tags).toEqual(['general']);
    expect(t.who).toBe('agent');
    expect(t.brief).toMatch(
      /^The owner wants the spec docs\/specs\/OPS-70-sort\.md \(OPS-70 · Sort the inbox\) changed\./u,
    );
    expect(t.brief).toContain('The owner’s request\nSort oldest first, too.\n\nTasks that link it\n');
    expect(t.brief).toContain(`- ${open.wid}: Sort by age (open; feature: inbox)`);
    expect(t.brief).toContain(`- ${done.wid}: Show the age (done)`);
    expect(t.brief).toContain(`- ${claimed.wid}: Sort on the phone (open, claimed)`);
    expect(t.brief).not.toContain('Unrelated');
    expect(t.brief).toContain('What to do\n- Change docs/specs/OPS-70-sort.md as the request asks');
    expect(t.brief).toContain('with --spec docs/specs/OPS-70-sort.md');
    expect(t.brief).toContain('Never set --autostart');
    expect(t.brief).toContain('closes your own task');
    expect(res.run).toMatchObject({ trigger: 'general', kind: 'general', agent: `claude-${t.short}`, forced: true });
    expect(fires.at(-1)).toContain('Mode: general');
    // The spec lists it with its tasks while it runs.
    const listed = (await body(await api('specs/docs/specs/OPS-70-sort.md'))).tasks.map((x) => x.uuid);
    expect(listed).toContain(t.uuid);
  });

  it('links to the open one instead of starting a second, and starts again once it’s closed', async () => {
    const first = await body(await refine({ spec: 'docs/specs/OPS-71-age.md', note: 'Say what age means.' }));
    expect(first.code).toBe(201);
    const fired = fires.length;
    const before = await count();
    const again = await body(await refine({ spec: './docs/specs/OPS-71-age.md', note: 'And again' }));
    expect(again).toMatchObject({ code: 200, run: null, already: `${first.task.claim} is on it` });
    expect(again.task.uuid).toBe(first.task.uuid);
    expect(fires.length).toBe(fired);
    expect(await count()).toBe(before);
    // Its agent finishes on the board: the next start makes a new one, which doesn't list the old one as work.
    await api(`tasks/${first.task.uuid}/release`, { method: 'POST', body: { agent: first.task.claim } });
    const next = await body(await refine({ spec: 'docs/specs/OPS-71-age.md', note: 'Once more.' }));
    expect(next.code).toBe(201);
    expect(next.task.uuid).not.toBe(first.task.uuid);
    expect(next.task.brief).not.toContain('Refine the spec');
  });

  it('refuses a path outside the directory, a missing file, no request, a prompt of its own, and anyone else', async () => {
    const before = await count();
    for (const path of ['src/worker.js', 'docs/specs/drafts/OPS-8.md', 'docs/specs/../../src/worker.js']) {
      const res = await body(await refine({ spec: path, note: 'Change it' }));
      expect(res.code, path).toBe(400);
      expect(res.error).toMatch(/isn’t a Markdown file in docs\/specs/u);
    }
    const missing = await body(await refine({ spec: 'docs/specs/OPS-99-nope.md', note: 'Change it' }));
    expect(missing).toMatchObject({ code: 400, error: 'no spec at docs/specs/OPS-99-nope.md on main' });
    const empty = await body(await refine({ spec: 'docs/specs/OPS-72-badges.md', note: '  ' }));
    expect(empty.code).toBe(400);
    expect(empty.error).toMatch(/say what should change/u);
    const own = await body(await refine({ spec: 'docs/specs/OPS-72-badges.md', prompt: 'Mine', note: 'x' }));
    expect(own.code).toBe(400);
    const both = await body(await refine({ spec: 'docs/specs/OPS-72-badges.md', decision: 'OPS-1', note: 'x' }));
    expect(both).toMatchObject({ code: 400, error: expect.stringMatching(/only one of them/u) });
    const agent = await refine({ spec: 'docs/specs/OPS-72-badges.md', note: 'x', by: 'claude-ops-1' });
    expect(agent.status).toBe(403);
    expect(await count()).toBe(before);
  });

  it('asks to connect GitHub when it can’t read the spec, and makes nothing', async () => {
    const before = await count();
    const res = await runInDurableObject(stub(), async (s) => {
      const saved = s.env.TASKS_GITHUB_APP_ID;
      s.env.TASKS_GITHUB_APP_ID = 'unset';
      try {
        return await s.agentsGeneralApi({ spec: 'docs/specs/OPS-72-badges.md', note: 'Change it', force: true });
      } finally {
        s.env.TASKS_GITHUB_APP_ID = saved;
      }
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Connect GitHub to read the specs' });
    expect(await count()).toBe(before);
  });

  it('passes Force start through, and waits for room without it', async () => {
    const running = (await body(await api('agents'))).running.length;
    await api('agents/settings', { method: 'PATCH', body: { max: Math.max(1, running) } });
    try {
      const held = await body(
        await api('agents/general', {
          method: 'POST',
          body: { spec: 'docs/specs/OPS-73-force.md', note: 'Wait for room.' },
        }),
      );
      expect(held).toMatchObject({ code: 202, run: null, forceable: true });
      expect(held.task.spec).toBe('docs/specs/OPS-73-force.md');
      // While it waits it's the open one for that spec.
      expect((await body(await refine({ spec: 'docs/specs/OPS-73-force.md', note: 'x' }))).already).toBe(
        'it’s waiting to start',
      );
      await api(`tasks/${held.task.uuid}`, { method: 'PATCH', body: { status: 'deleted' } });
      const forced = await body(await refine({ spec: 'docs/specs/OPS-73-force.md', note: 'Go now.' }));
      expect(forced.code).toBe(201);
      expect(forced.run.forced).toBe(true);
    } finally {
      await api('agents/settings', { method: 'PATCH', body: { max: 6 } });
    }
  });

  it('shows the prompt it would write with dryRun, without a request, and makes nothing', async () => {
    const before = await count();
    const fired = fires.length;
    const preview = await body(await refine({ spec: 'docs/specs/OPS-74-dry.md', dryRun: true }));
    expect(preview).toMatchObject({ code: 200, dryRun: true, task: null, already: null, refusal: null });
    expect(preview.title).toBe('Refine the spec: OPS-74 · A dry run');
    expect(preview.prompt).not.toContain('The owner’s request');
    expect(preview.prompt).toContain('- None yet: add the tasks the change needs.');
    expect(await count()).toBe(before);
    expect(fires.length).toBe(fired);
  });
});

describe('the prompt for refining a spec', () => {
  it('stays within a description, and the task list gives way first', () => {
    const tasks = Array.from({ length: 400 }, (_, i) => ({
      ref: `OPS-${i + 1}`,
      description: 'd'.repeat(60),
      status: 'pending',
    }));
    const { title, brief } = specPrompt(
      { path: 'docs/specs/OPS-1-x.md', title: 't'.repeat(300) },
      tasks,
      'r'.repeat(9000),
    );
    expect(title.length).toBeLessThanOrEqual(200);
    expect(brief.length).toBeLessThanOrEqual(10000);
    expect(brief).toContain('r'.repeat(4000));
    expect(brief).not.toContain('r'.repeat(4001));
    expect(brief).toContain('- … (more link it');
    expect(brief).toMatch(
      /closes your own task\. Never touch a claimed or closed task, an idea’s description, or a horizon-\* tag\.$/u,
    );
  });
});

describe('agents new --spec from a terminal (BRK-121)', () => {
  let spy;
  beforeEach(async () => {
    spy = mockFetch();
    await runInDurableObject(stub(), (store) => {
      store.specsCache = {};
    });
  });
  afterEach(() => spy.mockRestore());

  it('takes the CLI’s request: agents new --spec <path> "<what should change>"', async () => {
    const built = generalAgentRequest('Badges in colour', {
      spec: './docs/specs/OPS-75-cli.md',
      repo: 'widgets',
      force: true,
      by: 'owner',
    });
    const [method, path, payload] = built.request;
    const res = await body(await api(path, { method, body: payload }));
    expect(res.code).toBe(201);
    expect(res.task.spec).toBe('docs/specs/OPS-75-cli.md');
    expect(res.task.brief).toContain('Badges in colour');
    // Again while that one is open: the board answers with it, and the CLI says so.
    const again = await body(await api(path, { method, body: payload }));
    expect(again.task.uuid).toBe(res.task.uuid);
    expect(generalAgentSummary(again, { spec: payload.spec })).toMatch(/already refines this spec: /u);
  });
});
