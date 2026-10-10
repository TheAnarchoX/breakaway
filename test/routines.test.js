import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const routine = { fires: [], fail: false, next: 1 };

function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      if (routine.fail) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
      routine.fires.push(JSON.parse(init.body).text);
      const id = `session_${String(routine.next++).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
}

const make = (slug, extra = {}) =>
  api('routines', { method: 'POST', body: { slug, name: `Routine ${slug}`, prompt: `Do ${slug}.`, ...extra } });
const run = (slug, note) => api(`routines/${slug}/run`, { method: 'POST', body: { note } });
const finish = (ref) => api(`tasks/${ref}/done`, { method: 'POST', body: {} });

describe('routines', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
    routine.fail = false;
  });
  afterEach(() => spy.mockRestore());

  it('is written by the owner only, and checks what it’s given', async () => {
    expect((await body(await make('Bad Slug'))).error).toMatch(/slug/);
    expect((await body(await make('empty', { prompt: ' ' }))).error).toMatch(/needs a prompt/);
    expect((await body(await make('nope', { by: 'claude-x-1' }))).status).toBe(403);
    const res = await body(await make('changelog', { done_when: 'A PR is open.', horizon: 'next' }));
    expect(res.status).toBe(201);
    expect(res.routine).toMatchObject({
      slug: 'changelog',
      enabled: true,
      gapMinutes: 60,
      dailyCap: 3,
      horizon: 'next',
      editedBy: 'owner',
      openRun: null,
      lastRun: null,
    });
    expect((await body(await make('changelog'))).status).toBe(409);
    const edited = await body(
      await api('routines/changelog', { method: 'PATCH', body: { prompt: 'Draft the changelog.', dailyCap: 5 } }),
    );
    expect(edited.routine).toMatchObject({ prompt: 'Draft the changelog.', dailyCap: 5, name: 'Routine changelog' });
    expect((await body(await api('routines/changelog', { method: 'PATCH', body: { dailyCap: 0 } }))).status).toBe(400);
    expect(
      (await body(await api('routines/changelog', { method: 'PATCH', body: { prompt: 'x', by: 'claude-x-1' } })))
        .status,
    ).toBe(403);
    expect((await body(await api('routines'))).routines.map((r) => r.slug)).toEqual(['changelog']);
  });

  it('runs as a task in area routines with the prompt as its description, and starts an agent', async () => {
    const res = await body(await run('changelog', 'Only this week.'));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      project: 'routines',
      wid: 'RUN-1',
      brief: 'Draft the changelog.',
      doneWhen: 'A PR is open.',
      claim: 'claude-run-1',
      horizon: 'next',
    });
    expect(res.task.who).toBe('agent');
    expect(res.task.description).toMatch(/^Routine changelog · \d{4}-\d\d-\d\d$/);
    expect(res.run).toMatchObject({ kind: 'routine', trigger: 'manual', status: 'started' });
    expect(routine.fires[0]).toContain('Task: RUN-1');
    expect(routine.fires[0]).toContain('Mode: routine');
    expect(routine.fires[0]).toContain('Routine: changelog');
    expect(routine.fires[0]).toContain('Only this week.');
    expect(routine.fires[0]).not.toContain('Draft the changelog.');
    const listed = (await body(await api('routines'))).routines[0];
    expect(listed.openRun.wid).toBe('RUN-1');
    expect(listed.lastRun).toMatchObject({ wid: 'RUN-1', trigger: 'manual', failed: false });
  });

  it('keeps one run open at a time, and says why', async () => {
    const again = await body(await run('changelog'));
    expect(again.status).toBe(409);
    expect(again.error).toMatch(/already has a run open \(RUN-1\)/);
    expect(routine.fires).toHaveLength(1);
  });

  it('stops at its daily cap and at the cap for all routines, without queueing', async () => {
    await api('routines/changelog', { method: 'PATCH', body: { dailyCap: 2 } });
    await finish('RUN-1');
    expect((await body(await run('changelog'))).status).toBe(200);
    await finish('RUN-2');
    const capped = await body(await run('changelog'));
    expect(capped.status).toBe(429);
    expect(capped.error).toMatch(/daily cap/);
    await api('routines/settings', { method: 'PATCH', body: { dailyCap: 2 } });
    await make('weekly');
    const all = await body(await run('weekly'));
    expect(all.status).toBe(429);
    expect(all.error).toMatch(/most the board allows/);
    expect(routine.fires).toHaveLength(2);
  });

  it('pauses all routines and switches one off', async () => {
    await api('routines/settings', { method: 'PATCH', body: { dailyCap: 10, paused: true } });
    expect((await body(await run('weekly'))).error).toMatch(/paused/);
    await api('routines/settings', { method: 'PATCH', body: { paused: false } });
    await api('routines/weekly', { method: 'PATCH', body: { enabled: false } });
    expect((await body(await run('weekly'))).error).toMatch(/is off/);
    expect((await body(await run('missing'))).status).toBe(404);
  });

  it('leaves no task behind when Claude won’t start it, and switches a routine off after three failures', async () => {
    await api('routines/weekly', { method: 'PATCH', body: { enabled: true } });
    routine.fail = true;
    for (let i = 0; i < 3; i++) expect((await body(await run('weekly'))).status).toBe(502);
    const open = (await body(await api('tasks'))).tasks.filter(
      (t) => t.project === 'routines' && t.description.startsWith('Routine weekly'),
    );
    expect(open).toHaveLength(0);
    const weekly = (await body(await api('routines'))).routines.find((r) => r.slug === 'weekly');
    expect(weekly.enabled).toBe(false);
    expect(weekly.disabledReason).toMatch(/3 times in a row/);
    await api('routines/weekly', { method: 'PATCH', body: { enabled: true } });
    expect((await body(await api('routines'))).routines.find((r) => r.slug === 'weekly')).toMatchObject({
      enabled: true,
      disabledReason: null,
    });
  });
});

describe('routines in a repository (CLD-127)', () => {
  const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
  const fired = [];
  let spy;
  beforeEach(async () => {
    fired.length = 0;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE && url !== FIRE_BREAKAWAY) return new Response('{"message":"Not Found"}', { status: 404 });
      fired.push({ url, text: JSON.parse(init.body).text });
      return Response.json({
        claude_code_session_id: `session_r${fired.length}`,
        claude_code_session_url: 'https://claude.ai/code/s',
      });
    });
    await api('routines/settings', { method: 'PATCH', body: { dailyCap: 100, paused: false } });
    await api('repos', {
      method: 'POST',
      body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
    });
  });
  afterEach(() => spy.mockRestore());

  it('belongs to the default repository unless it names one, and refuses one that isn’t registered', async () => {
    expect((await body(await api('routines'))).routines.every((r) => r.repo === 'widgets')).toBe(true);
    expect((await body(await make('nowhere', { repo: 'nope' }))).error).toMatch(/no repository "nope"/);
    const res = await body(await make('brk-notes', { repo: 'breakaway' }));
    expect(res.status).toBe(201);
    expect(res.routine.repo).toBe('breakaway');
    const moved = await body(await api('routines/weekly', { method: 'PATCH', body: { repo: 'breakaway' } }));
    expect(moved.routine.repo).toBe('breakaway');
    expect((await body(await api('routines/weekly', { method: 'PATCH', body: { repo: null } }))).routine.repo).toBe(
      'widgets',
    );
  });

  it('runs in its repository: the run is that repository’s task and starts through its routine', async () => {
    const res = await body(await run('brk-notes'));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({ project: 'routines', repo: 'breakaway' });
    expect(res.task.wid).toMatch(/^RUN-\d+$/);
    expect(fired).toHaveLength(1);
    expect(fired[0].url).toBe(FIRE_BREAKAWAY);
    expect(fired[0].text).toContain('Repository: breakaway (acme/breakaway)');
    expect(fired[0].text).toContain('Mode: routine');
  });

  it('says so, and leaves no task, in a repository whose routine isn’t connected yet', async () => {
    await api('repos', { method: 'POST', body: { slug: 'scratch', github: 'acme/scratch', areas: ['product:SCR'] } });
    await make('scr-notes', { repo: 'scratch' });
    const res = await body(await run('scr-notes'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.error).toMatch(/isn’t connected|isn't connected/);
    expect(fired).toHaveLength(0);
    const left = (await body(await api('tasks?all=1'))).tasks.filter(
      (t) => t.repo === 'scratch' && t.status === 'pending',
    );
    expect(left).toHaveLength(0);
  });
});
