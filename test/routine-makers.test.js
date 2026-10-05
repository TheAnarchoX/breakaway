import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routineMakerRequest, routineWrite } from '../scripts/tasks/cli.js';
import { firePayload } from '../src/store-agents.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';

// Routines with an agent (docs/specs/BRK-220-routines-with-an-agent.md, sections 2, 3, and 5, BRK-221).

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
const fires = [];

const QUESTIONS = [
  {
    id: 'when',
    type: 'choice',
    prompt: 'When should it run?',
    options: [
      { id: 'monday', label: 'Every Monday at 9:00 UTC' },
      { id: 'button', label: 'Only when I press Run now' },
    ],
  },
];
const ANSWERS = { when: { value: 'monday' } };

const maker = (extra = {}) =>
  api('routines/agent', {
    method: 'POST',
    body: { prompt: 'Every Monday morning, update the changelog from what merged last week', ...extra },
  });
const routine = (slug, extra = {}) =>
  api('routines', { method: 'POST', body: { slug, name: `Routine ${slug}`, prompt: `Do ${slug}.`, ...extra } });
const change = (slug, patch) => api(`routines/${slug}`, { method: 'PATCH', body: patch });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;

describe('the routines mode, the pure parts', () => {
  it('sends Mode: routines, and says Make with an agent started it', () => {
    const text = firePayload(
      { uuid: '1a2b3c4d-0000-4000-8000-000000000000', wid: null, description: 'Update the changelog' },
      'claude-1a2b3c4d',
      'routines',
      null,
      'routines',
      null,
      null,
      0,
      { slug: 'widgets', github: 'acme/widgets' },
    );
    expect(text.split('\n')).toEqual([
      'Task: 1a2b3c4d-0000-4000-8000-000000000000',
      'Title: Update the changelog',
      'Agent name: claude-1a2b3c4d',
      'Started: by “Make with an agent” on the Routines view, from the board',
      'Repository: widgets (acme/widgets)',
      'Mode: routines',
    ]);
  });
});

describe('routine makers on the board', () => {
  let spy;
  let cookie;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE && url !== FIRE_BREAKAWAY) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
  });
  afterAll(() => spy.mockRestore());

  /** The owner on the signed-in web board. */
  const owner = (path, { method = 'GET', body: sent } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: sent === undefined ? undefined : JSON.stringify(sent),
    });

  let made;
  let agent;

  it('is the owner’s to start, and makes a +routine-maker task with an agent on it in Mode: routines', async () => {
    const refused = await body(await maker({ by: 'claude-someone' }));
    expect(refused.status).toBe(403);
    expect(refused.error).toMatch(/only the owner/);
    expect((await body(await maker({ prompt: '  ' }))).status).toBe(400);

    const res = await body(await maker());
    expect(res.status).toBe(201);
    made = res.task;
    agent = `claude-${made.short}`;
    expect(made).toMatchObject({
      wid: null,
      project: null,
      brief: 'Every Monday morning, update the changelog from what merged last week',
      claim: agent,
    });
    expect(made.tags).toEqual(['agent', 'general', 'routine-maker']);
    expect(res.run).toMatchObject({ agent, trigger: 'routines', kind: 'routines' });
    expect(fires.at(-1)).toContain('Mode: routines');
    expect(fires.at(-1)).not.toContain('Mode: general');
    expect(fires.at(-1)).toContain('Started: by “Make with an agent” on the Routines view, from the board');
  });

  it('lets its agent make a routine, on and recorded as its task’s, and change its own', async () => {
    const res = await body(await routine('changelog', { by: agent, schedule: '0 9 * * 1', triggerStart: 'auto' }));
    expect(res.status).toBe(201);
    expect(res.routine).toMatchObject({
      slug: 'changelog',
      enabled: true,
      editedBy: agent,
      madeBy: { uuid: made.uuid, agent },
    });
    const edited = await body(await change('changelog', { by: agent, prompt: 'Draft the changelog.' }));
    expect(edited.status).toBe(200);
    expect(edited.routine).toMatchObject({ prompt: 'Draft the changelog.', editedBy: agent });
    expect(edited.routine.madeBy.uuid).toBe(made.uuid);
    const off = await body(await change('changelog', { by: agent, enabled: false }));
    expect(off.routine.enabled).toBe(false);
    await change('changelog', { by: agent, enabled: true });

    const { events } = await body(await api('activity?limit=50'));
    const kinds = events.filter((e) => e.source === 'routines').flatMap((e) => e.changes);
    expect(kinds).toContainEqual(expect.objectContaining({ kind: 'routine_made', routine: 'changelog', by: agent }));
    expect(kinds).toContainEqual(expect.objectContaining({ kind: 'routine_changed', routine: 'changelog', by: agent }));
    const madeEvent = events.find((e) => e.changes.some((c) => c.kind === 'routine_made'));
    expect(madeEvent.task.uuid).toBe(made.uuid);
  });

  it('refuses the owner’s routines, triggers, settings, and runs to a routine maker', async () => {
    expect((await routine('owners')).status).toBe(201);
    const theirs = await body(await change('owners', { by: agent, prompt: 'Mine now.' }));
    expect(theirs.status).toBe(403);
    expect(theirs.error).toMatch(/only routines its task made/);

    const trigger = await body(
      await api('routines/changelog/triggers', { method: 'POST', body: { label: 'ci', by: agent } }),
    );
    expect(trigger.status).toBe(403);
    expect(trigger.error).toMatch(/webhook/);
    const own = await body(await api('routines/owners/triggers', { method: 'POST', body: { label: 'ci' } }));
    expect(own.status).toBe(201);
    const revoke = await body(
      await api(`routines/owners/triggers/${own.trigger.id}`, { method: 'DELETE', body: { by: agent } }),
    );
    expect(revoke.status).toBe(403);

    const settings = await body(await api('routines/settings', { method: 'PATCH', body: { paused: true, by: agent } }));
    expect(settings.status).toBe(403);
    expect(settings.error).toMatch(/only the owner/);
    expect((await body(await api('routines'))).settings.paused).toBe(false);

    const run = await body(await api('routines/changelog/run', { method: 'POST', body: { by: agent } }));
    expect(run.status).toBe(403);
    expect(run.error).toMatch(/only the owner/);
  });

  it('refuses another agent, and a routine maker of another repository', async () => {
    const other = await body(await routine('stranger', { by: 'claude-someone' }));
    expect(other.status).toBe(403);
    expect(other.error).toMatch(/routine maker/);
    expect((await body(await change('changelog', { by: 'claude-someone', prompt: 'x' }))).status).toBe(403);

    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
    });
    expect(registered.status).toBe(201);
    const elsewhere = await body(await maker({ repo: 'breakaway', prompt: 'Weekly docs check' }));
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.task.repo).toBe('breakaway');
    const theirAgent = `claude-${elsewhere.task.short}`;
    const crossed = await body(await routine('crossed', { by: theirAgent, repo: 'widgets' }));
    expect(crossed.status).toBe(403);
    expect(crossed.error).toMatch(/breakaway/);
    // Nor may it move a routine of its own into another repository.
    const own = await body(await routine('docs-check', { by: theirAgent, repo: 'breakaway' }));
    expect(own.status).toBe(201);
    expect(own.routine.repo).toBe('breakaway');
    expect((await body(await change('docs-check', { by: theirAgent, repo: 'widgets' }))).status).toBe(403);
    expect((await body(await change('changelog', { by: theirAgent, prompt: 'x' }))).status).toBe(403);
  });

  it('makes at most 5 routines per task', async () => {
    for (const n of [2, 3, 4, 5]) expect((await routine(`job-${n}`, { by: agent })).status).toBe(201);
    const sixth = await body(await routine('job-6', { by: agent }));
    expect(sixth.status).toBe(403);
    expect(sixth.error).toMatch(/5 routines/);
  });

  it('keeps the task open when its agent asks and releases, and carry on starts it again in Mode: routines', async () => {
    const asked = await body(await api(`tasks/${made.uuid}`, { method: 'PATCH', body: { decision: QUESTIONS } }));
    expect(asked.status).toBe(200);
    const released = await body(await api(`tasks/${made.uuid}/release`, { method: 'POST', body: { agent } }));
    expect(released.task).toMatchObject({ status: 'pending', claim: null });
    expect(released.task.tags).toContain('decide');
    // Released, its agent may no longer write routines.
    expect((await routine('late', { by: agent })).status).toBe(403);

    const viaToken = await body(
      await api(`tasks/${made.uuid}/decision/answers`, { method: 'POST', body: { answers: ANSWERS, carryOn: true } }),
    );
    expect(viaToken.status).toBe(403);
    const before = fires.length;
    const res = await body(
      await owner(`tasks/${made.uuid}/decision/answers`, { method: 'POST', body: { answers: ANSWERS, carryOn: true } }),
    );
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ kind: 'routines', trigger: 'routines-carry-on', agent });
    expect(res.task).toMatchObject({ status: 'pending', claim: agent });
    expect(res.task.decisionAnswers.answers).toEqual(ANSWERS);
    expect(fires.length).toBe(before + 1);
    expect(fires.at(-1)).toContain('Mode: routines');
    expect(fires.at(-1)).toContain('Started: by “Send answers and carry on” on a routine maker’s decision');
  });

  it('closes the task when its agent hands over, and the permission ends with it', async () => {
    const released = await body(await api(`tasks/${made.uuid}/release`, { method: 'POST', body: { agent } }));
    expect(released.task.status).toBe('completed');
    expect((await routine('after', { by: agent })).status).toBe(403);
    expect((await change('changelog', { by: agent, prompt: 'x' })).status).toBe(403);
    // The owner still changes it like any routine.
    expect((await change('changelog', { prompt: 'Owner’s now.' })).status).toBe(200);
  });

  it('keeps an answered routine maker open without starting it, for a plain Send answers', async () => {
    const res = await body(await maker({ prompt: 'Keep an eye on failing builds', repo: 'widgets' }));
    const name = `claude-${res.task.short}`;
    await api(`tasks/${res.task.uuid}`, { method: 'PATCH', body: { decision: QUESTIONS } });
    await api(`tasks/${res.task.uuid}/release`, { method: 'POST', body: { agent: name } });
    const answered = await body(
      await owner(`tasks/${res.task.uuid}/decision/answers`, { method: 'POST', body: { answers: ANSWERS } }),
    );
    expect(answered.status).toBe(200);
    expect(answered.task).toMatchObject({ status: 'pending', claim: null, autostart: false });
    const queue = (await body(await api('agents'))).queue;
    expect(queue.find((q) => q.uuid === res.task.uuid)).toBeUndefined();
    // Start on it later starts the routines mode, whatever button asked.
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: res.task.uuid } }));
    expect(started.run).toMatchObject({ kind: 'routines', agent: name });
    expect((await task(res.task.uuid)).claim).toBe(name);
  });

  it('takes the CLI’s requests: routines new, and routines add signed with BREAKAWAY_AGENT (CLI-19)', async () => {
    const send = ([method, path, payload]) => api(path, { method, body: payload });
    // routines add as an agent with no routine maker's task: the name goes along, and the board refuses it.
    const refused = await body(
      await send([
        'POST',
        'routines',
        routineWrite({ slug: 'cli-job', name: 'CLI job', prompt: 'Do it.' }, 'claude-nobody'),
      ]),
    );
    expect(refused.status).toBe(403);
    expect(refused.error).toMatch(/routine maker/);
    // A pause signed with that name is refused too, where it once went through.
    expect((await send(['PATCH', 'routines/settings', routineWrite({ paused: true }, 'claude-nobody')])).status).toBe(
      403,
    );

    expect(
      (await body(await send(routineMakerRequest('Tidy the docs weekly', { by: 'claude-nobody' }).request))).status,
    ).toBe(403);
    const started = await body(
      await send(routineMakerRequest('Tidy the docs weekly', { repo: 'widgets', force: true }).request),
    );
    expect(started.status).toBe(201);
    expect(started.task.tags).toContain('routine-maker');
    const name = `claude-${started.task.short}`;
    expect(started.run).toMatchObject({ kind: 'routines', agent: name });

    // Its agent's routines add, signed the same way, goes through.
    const made = await body(
      await send([
        'POST',
        'routines',
        routineWrite({ slug: 'cli-job', name: 'CLI job', prompt: 'Do it.', repo: 'widgets' }, name),
      ]),
    );
    expect(made.status).toBe(201);
    expect(made.routine.madeBy).toMatchObject({ uuid: started.task.uuid, agent: name });
  });
});
