import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isKickoffIdea } from '../src/kickoff.js';
import { firePayload } from '../src/store-agents.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];

const QUESTIONS = [
  {
    id: 'who',
    type: 'choice',
    prompt: 'Who is it for?',
    options: [
      { id: 'me', label: 'Just me' },
      { id: 'friends', label: 'People I invite' },
    ],
  },
  { id: 'look', type: 'open', prompt: 'How should it look and feel?' },
];
const ANSWERS = { who: { value: 'me' }, look: { value: 'Calm, green, big photos' } };

const settings = (patch) => api('agents/settings', { method: 'PATCH', body: patch });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const make = async (item) => (await body(await api('tasks', { method: 'POST', body: [item] }))).tasks[0];
const kickoffIdea = (description = 'A diary for my plants') =>
  make({ description, project: 'ideas', horizon: 'next', who: 'agent', tags: ['idea', 'kickoff-project'] });

describe('the kickoff mode, the pure parts (BRK-134)', () => {
  it('knows a kickoff’s idea by its tag and its area', () => {
    expect(isKickoffIdea({ project: 'ideas', who: 'agent', tags: ['idea', 'kickoff-project'] })).toBe(true);
    expect(isKickoffIdea({ project: 'ideas', 'tag_kickoff-project': 'x' })).toBe(true);
    expect(isKickoffIdea({ project: 'ideas', who: 'agent', tags: ['idea'] })).toBe(false);
    expect(isKickoffIdea({ project: 'app', tags: ['kickoff-project'] })).toBe(false);
    expect(isKickoffIdea(null)).toBe(false);
  });

  it('sends Mode: kickoff, and says the carry-on started it', () => {
    const text = firePayload({ wid: 'IDEA-7', description: 'A diary for my plants' }, 'claude-idea-7', 'kickoff', {
      kind: 'kickoff',
      attachments: 2,
      repo: { slug: 'plant-diary', github: 'acme/plant-diary' },
    });
    expect(text.split('\n')).toEqual([
      'Task: IDEA-7',
      'Title: A diary for my plants',
      'Agent name: claude-idea-7',
      'Started: by “Send answers and carry on” on a kickoff’s decision, from the board',
      'Repository: plant-diary (acme/plant-diary)',
      'Mode: kickoff',
      'Run it: not answered yet',
      'Attachments: 2',
    ]);
  });

  it('carries Run it’s answer after Mode: kickoff, so the plan can include the first infrastructure (BRK-305)', () => {
    const lines = (runIt, kind = 'kickoff') =>
      firePayload({ wid: 'IDEA-7', description: 'A diary for my plants' }, 'claude-idea-7', 'kickoff', {
        kind,
        repo: { slug: 'plant-diary', github: 'acme/plant-diary' },
        runIt,
      }).split('\n');
    expect(lines('agent').slice(-2)).toEqual(['Mode: kickoff', 'Run it: agent']);
    expect(lines('now')).toContain('Run it: now');
    expect(lines('not-needed')).toContain('Run it: not-needed');
    // Not answered yet: said so, and the agent leaves how it runs to Run it.
    expect(lines(null)).toContain('Run it: not answered yet');
    // Only a kickoff's run carries it.
    expect(lines('now', 'build').some((l) => l.startsWith('Run it:'))).toBe(false);
  });
});

describe('the kickoff mode on the board (BRK-134)', () => {
  let spy;
  let cookie;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{"message":"Not Found"}', { status: 404 });
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
  const answer = (ref, extra = {}) =>
    owner(`tasks/${ref}/decision/answers`, { method: 'POST', body: { answers: ANSWERS, ...extra } });

  /** What the first run does: ask its questions on the IDEA, then release it. */
  const ask = async (idea, agent) => {
    const asked = await body(await api(`tasks/${idea.wid}`, { method: 'PATCH', body: { decision: QUESTIONS } }));
    expect(asked.status).toBe(200);
    expect(asked.task.who).toBe('decision');
    await api(`tasks/${idea.wid}/release`, { method: 'POST', body: { agent } });
  };

  let idea;

  it('starts an agent on a kickoff’s idea in the kickoff mode, and a plain idea as before', async () => {
    idea = await kickoffIdea();
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: idea.wid } }));
    expect(started.status).toBe(200);
    expect(started.run).toMatchObject({
      kind: 'kickoff',
      trigger: 'manual',
      agent: `claude-${idea.wid.toLowerCase()}`,
    });
    expect(fires.at(-1)).toContain('Mode: kickoff');
    expect(fires.at(-1)).toContain(`Task: ${idea.wid}`);

    expect(fires.at(-1).split('\n')).toContain('Run it: not answered yet');

    const plain = await make({ description: 'An ordinary idea', project: 'ideas', who: 'agent', tags: ['idea'] });
    const build = await body(await api('agents/start', { method: 'POST', body: { ref: plain.wid } }));
    expect(build.run.kind).toBe('build');
    expect(fires.at(-1)).not.toContain('Mode:');
    expect(fires.at(-1)).not.toContain('Run it:');
  });

  it('keeps a kickoff’s idea open when its questions are answered', async () => {
    await ask(idea, `claude-${idea.wid.toLowerCase()}`);
    const res = await body(await answer(idea.wid));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({ status: 'pending', claim: null, decisionAnswers: { answers: ANSWERS } });
    expect(res.task.who).toBe('agent');
    expect(res.task.comments.at(-1).text).toMatch(/Who is it for\?/);
    // Answered already: a second press is refused until it's reopened.
    expect((await answer(idea.wid)).status).toBe(409);
    const { events } = await body(await api('activity?limit=10'));
    const kinds = events.filter((e) => e.task?.wid === idea.wid).flatMap((e) => e.changes.map((c) => c.kind));
    expect(kinds).toContain('decision-answered');
    expect(kinds).not.toContain('done');
  });

  it('reopens a kickoff’s answers by making it a decision again, and keeps the idea open', async () => {
    const res = await body(await owner(`tasks/${idea.wid}/decision/answers`, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(res.task.status).toBe('pending');
    expect(res.task.who).toBe('decision');
    expect((await owner(`tasks/${idea.wid}/decision/answers`, { method: 'DELETE' })).status).toBe(409);
  });

  it('refuses Send answers and carry on from the bearer token, from an agent, and on another decision', async () => {
    const viaToken = await body(
      await api(`tasks/${idea.wid}/decision/answers`, { method: 'POST', body: { answers: ANSWERS, carryOn: true } }),
    );
    expect(viaToken.status).toBe(403);
    expect(viaToken.error).toMatch(/only the signed-in web board/);
    const agent = await body(await answer(idea.wid, { carryOn: true, by: 'claude-idea-1' }));
    expect(agent.status).toBe(403);
    expect(agent.error).toMatch(/only the owner/);

    const other = await make({ description: 'Pick a colour', project: 'ops', decision: QUESTIONS });
    const refused = await body(await answer(other.wid, { carryOn: true }));
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/isn't a kickoff's idea/);
    // Nothing was answered.
    expect((await task(other.wid)).status).toBe('pending');
    expect((await task(idea.wid)).who).toBe('decision');
  });

  it('answers and starts the next kickoff run in one press', async () => {
    const before = fires.length;
    const res = await body(await answer(idea.wid, { carryOn: true }));
    expect(res.status).toBe(200);
    expect(res.waiting).toBeNull();
    expect(res.run).toMatchObject({ kind: 'kickoff', trigger: 'kickoff' });
    expect(res.task).toMatchObject({ status: 'pending', claim: `claude-${idea.wid.toLowerCase()}` });
    expect(res.task.decisionAnswers.answers).toEqual(ANSWERS);
    expect(fires.length).toBe(before + 1);
    expect(fires.at(-1)).toContain('Mode: kickoff');
    expect(fires.at(-1)).toContain('Started: by “Send answers and carry on” on a kickoff’s decision, from the board');
  });

  it('tells the kickoff’s agent Run it’s answer, read from the kickoff that made the idea (BRK-305)', async () => {
    const herbs = await kickoffIdea('A garden planner');
    const agent = `claude-${herbs.wid.toLowerCase()}`;
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => {
      instance.sql.exec(
        "INSERT INTO kickoffs (id, pitch, name, slug, areas, github, idea, step, created, edited, run_it, run_it_at) VALUES (?, 'A garden planner', 'garden-planner', 'garden-planner', '[]', 'acme/garden-planner', ?, 'done', 1, 1, 'agent', 1)",
        crypto.randomUUID(),
        herbs.uuid,
      );
    });
    const started = await body(await api('agents/start', { method: 'POST', body: { ref: herbs.wid } }));
    expect(started.run).toMatchObject({ kind: 'kickoff', agent });
    expect(fires.at(-1).split('\n')).toContain('Run it: agent');
    await api(`tasks/${herbs.wid}/release`, { method: 'POST', body: { agent } });
  });

  it('queues the next run for room when the board is full, whatever the switch says, and starts it once', async () => {
    const second = await kickoffIdea('A log for my herbs');
    const agent = `claude-${second.wid.toLowerCase()}`;
    await api('agents/start', { method: 'POST', body: { ref: second.wid } });
    await ask(second, agent);

    const { running } = await body(await api('agents'));
    await settings({ autostart: false, max: Math.max(1, running.length) });
    const before = fires.length;
    const res = await body(await answer(second.wid, { carryOn: true }));
    expect(res.status).toBe(202);
    expect(res.run).toBeNull();
    expect(res.waiting).toMatch(/already running/);
    expect(res.task).toMatchObject({ status: 'pending', claim: null, autostart: true });
    expect(res.task.who).toBe('agent');
    expect(fires.length).toBe(before);
    const queue = (await body(await api('agents'))).queue;
    expect(queue.find((q) => q.uuid === second.uuid)).toMatchObject({ kickoff: true, general: false });

    await settings({ max: 6 });
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName('widgets')));
    expect(fires.length).toBe(before + 1);
    expect(fires.at(-1)).toContain('Mode: kickoff');
    const started = await task(second.wid);
    expect(started).toMatchObject({ claim: agent, autostart: false });
    await settings({ autostart: true });
  });
});
