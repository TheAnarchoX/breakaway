import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generalAgentRequest } from '../scripts/tasks/cli.js';
import { refinePrompt } from '../src/decision.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const FIRE_BREAKAWAY = 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire';
const fires = [];

const general = (extra = {}) =>
  api('agents/general', { method: 'POST', body: { prompt: 'Tidy the docs\nThe intro is stale.', ...extra } });
const settings = (patch) => api('agents/settings', { method: 'PATCH', body: patch });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const overview = async () => body(await api('agents'));

describe('general agents', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE && url !== FIRE_BREAKAWAY) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  it('makes a task with no area and no work ID, and starts an agent on it', async () => {
    const res = await body(await general());
    expect(res.status).toBe(201);
    expect(res.waiting).toBeNull();
    const t = res.task;
    expect(t).toMatchObject({
      wid: null,
      project: null,
      description: 'Tidy the docs',
      brief: 'Tidy the docs\nThe intro is stale.',
      horizon: 'now',
      autostart: true,
      claim: `claude-${t.short}`,
    });
    expect(t.tags).toEqual(['general']);
    expect(t.who).toBe('agent');
    expect(res.run).toMatchObject({ agent: `claude-${t.short}`, trigger: 'general', forced: false });
    const payload = fires.at(-1);
    expect(payload).toContain(`Task: ${t.uuid}`);
    expect(payload).toContain(`Agent name: claude-${t.short}`);
    expect(payload).toContain('Started: by a prompt from the owner, from the board');
    expect(payload).toContain('Mode: general');
    const recent = (await overview()).recent[0];
    expect(recent).toMatchObject({ trigger: 'general', kind: 'general', wid: null });
  });

  it('gives the work ID once, when the agent sets the area, and never renumbers', async () => {
    const t = (await body(await api('agents'))).recent[0];
    const uuid = (await body(await api('tasks?status=pending'))).tasks.find((x) => x.tags.includes('general')).uuid;
    expect(t.wid).toBeNull();
    const set = await body(await api(`tasks/${uuid}`, { method: 'PATCH', body: { project: 'ops' } }));
    expect(set.status).toBe(200);
    expect(set.task.wid).toMatch(/^OPS-\d+$/);
    const first = set.task.wid;
    const again = await body(await api(`tasks/${uuid}`, { method: 'PATCH', body: { project: 'product' } }));
    expect(again.task.wid).toBe(first);
    // The agent's name stays what it was.
    expect(again.task.claim).toBe(`claude-${uuid.slice(0, 8)}`);
  });

  it('keeps a general agent out of the shared areas', async () => {
    const made = await body(await general({ force: true }));
    const res = await body(await api(`tasks/${made.task.uuid}`, { method: 'PATCH', body: { project: 'ideas' } }));
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/own areas/);
  });

  it('gives any open task without a work ID the next one when it gets an area', async () => {
    const plain = await body(await api('tasks', { method: 'POST', body: [{ description: 'Loose end' }] }));
    expect(plain.tasks[0].wid).toBeNull();
    const set = await body(await api(`tasks/${plain.tasks[0].uuid}`, { method: 'PATCH', body: { project: 'debt' } }));
    expect(set.task.wid).toMatch(/^DEBT-\d+$/);
  });

  it('requires the repository when the board runs more than one, and names the choices', async () => {
    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
    });
    expect(registered.status).toBe(201);
    const refused = await body(await general());
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/which repository/);
    expect(refused.error).toMatch(/breakaway/);
    const ok = await body(await general({ repo: 'breakaway' }));
    expect(ok.status).toBe(201);
    expect(ok.task.repo).toBe('breakaway');
    expect(fires.at(-1)).toContain('Repository: breakaway (acme/breakaway)');
  });

  it('refuses before making a task when the repository’s routine isn’t connected', async () => {
    await api('repos', { method: 'POST', body: { slug: 'quiet', github: 'acme/quiet', areas: ['product:QT'] } });
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const res = await body(await general({ repo: 'quiet' }));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/quiet’s agent routine isn’t connected/);
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before);
    expect((await body(await general({ repo: 'quiet', prompt: '  ' }))).status).toBe(400);
  });

  it('queues ahead of other auto-start tasks, whatever the switch says, and starts on the next tick', async () => {
    await api('tasks', {
      method: 'POST',
      body: [{ description: 'Ordinary auto-start', project: 'ops', who: 'agent', horizon: 'now', autostart: 'yes' }],
    });
    await settings({ autostart: false, max: 1 });
    const running = (await overview()).running.length;
    await settings({ max: Math.max(1, running) });
    const waiting = await body(await general({ repo: 'breakaway', prompt: 'Queued behind a full board' }));
    expect(waiting.status).toBe(202);
    expect(waiting.run).toBeNull();
    expect(waiting.waiting).toMatch(/already running/);
    expect(waiting.forceable).toBe(true);
    const queue = (await overview()).queue;
    expect(queue[0]).toMatchObject({ uuid: waiting.task.uuid, general: true });
    expect(queue[0].reason).toMatch(/no free slot/);
    const ordinary = queue.find((q) => q.description === 'Ordinary auto-start');
    expect(ordinary.reason).toBe('auto-start is off');

    // Room appears, and the switch is still off: the general agent starts, the ordinary task doesn't.
    await settings({ max: 6 });
    const before = fires.length;
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName('widgets')));
    expect(fires.length).toBe(before + 1);
    expect(fires.at(-1)).toContain('Mode: general');
    expect((await task(waiting.task.uuid)).claim).toBe(`claude-${waiting.task.short}`);
    expect((await task(ordinary.wid)).claim).toBeNull();
    await settings({ autostart: true });
  });

  it('skips the board’s limits when forced, and records it', async () => {
    const { running } = await overview();
    await settings({ max: Math.max(1, running.length) });
    const held = await body(await general({ repo: 'breakaway', prompt: 'Held' }));
    expect(held.status).toBe(202);
    const forced = await body(await general({ repo: 'breakaway', prompt: 'Forced', force: true }));
    expect(forced.status).toBe(201);
    expect(forced.run.forced).toBe(true);
    // A waiting general task starts through Start, forced or not, as a general agent.
    const start = await body(await api('agents/start', { method: 'POST', body: { ref: held.task.uuid, force: true } }));
    expect(start.status).toBe(200);
    expect(start.run).toMatchObject({ kind: 'general', trigger: 'general', forced: true });
    await settings({ max: 6 });
  });

  it('only the owner starts one', async () => {
    const res = await body(await general({ by: 'claude-brk-1' }));
    expect(res.status).toBe(403);
  });

  it('closes the task when its agent releases it with no pull request, but not when it has one', async () => {
    await settings({ max: 6 });
    const made = await body(await general({ repo: 'breakaway', prompt: 'Change tasks on the board only' }));
    const agent = made.task.claim;
    const released = await body(await api(`tasks/${made.task.uuid}/release`, { method: 'POST', body: { agent } }));
    expect(released.task).toMatchObject({ status: 'completed', claim: null });
    expect(released.task.comments.at(-1).text).toMatch(/no pull request/);

    const withPr = await body(await general({ repo: 'breakaway', prompt: 'Build something' }));
    await api(`tasks/${withPr.task.uuid}`, { method: 'PATCH', body: { pr: '12' } });
    const kept = await body(
      await api(`tasks/${withPr.task.uuid}/release`, { method: 'POST', body: { agent: withPr.task.claim } }),
    );
    expect(kept.task.status).toBe('pending');
    expect(kept.task.claim).toBeNull();
  });
});

const QUESTIONS = [
  {
    id: 'edits',
    type: 'choice',
    prompt: 'How do cross-task edits land?',
    options: [
      { id: 'direct', label: 'Directly, each change noted' },
      { id: 'proposal', label: 'As a proposal' },
    ],
  },
  { id: 'why', type: 'open', prompt: 'Anything else?', required: false },
];

describe('refine from the answers (BRK-110)', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE && url !== FIRE_BREAKAWAY) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  /** A decision in ops with a task waiting for it; answered unless `answer` is false. */
  const decided = async ({ answer = true } = {}) => {
    const [d] = (
      await body(
        await api('tasks', {
          method: 'POST',
          body: [
            {
              description: 'Choose how edits land',
              project: 'ops',
              decision: QUESTIONS,
              spec: 'docs/specs/IDEA-9-edits.md',
              force: true,
            },
          ],
        }),
      )
    ).tasks;
    const [w] = (
      await body(
        await api('tasks', {
          method: 'POST',
          body: [
            {
              description: 'Build the edits',
              project: 'ops',
              who: 'agent',
              tags: ['cross-edits', 'v1_3-0'],
              depends: [d.wid],
              force: true,
            },
          ],
        }),
      )
    ).tasks;
    if (answer) {
      const res = await api(`tasks/${d.wid}/decision/answers`, {
        method: 'POST',
        body: { answers: { edits: { value: 'direct', comment: 'keep each change in Activity' } } },
      });
      expect(res.status).toBe(200);
    }
    return { d, w };
  };
  const fromDecision = (extra) => api('agents/general', { method: 'POST', body: { force: true, ...extra } });

  it('writes the prompt from the answered decision, relates the task to it, and starts a general agent', async () => {
    const { d, w } = await decided();
    const res = await body(await fromDecision({ decision: d.wid }));
    expect(res.status).toBe(201);
    const t = res.task;
    expect(t).toMatchObject({ wid: null, project: null, horizon: 'now', autostart: true, repo: d.repo });
    expect(t.tags).toEqual(['general']);
    expect(t.who).toBe('agent');
    expect(t.description).toBe(`Refine from the answers to ${d.wid}: Choose how edits land`);
    expect(t.related).toEqual([d.uuid]);
    expect(t.brief).toContain('1. How do cross-task edits land?\n   Answer: Directly, each change noted');
    expect(t.brief).toContain("The owner's note: keep each change in Activity");
    expect(t.brief).toContain('Answer: no answer');
    expect(t.brief).toContain(`- ${w.wid}: Build the edits (feature: cross-edits)`);
    expect(t.brief).toContain('- docs/specs/IDEA-9-edits.md');
    expect(t.brief).toMatch(/What to do\n- Change the tasks waiting for/);
    expect(t.brief).not.toContain('Note from the owner');
    expect(res.run).toMatchObject({ trigger: 'general', kind: 'general', agent: `claude-${t.short}` });
    expect(fires.at(-1)).toContain('Mode: general');
    // The decision shows it too.
    const shown = (await body(await api(`tasks/${d.wid}`))).task;
    expect(shown.relatedTasks.map((r) => r.uuid)).toContain(t.uuid);
  });

  it('puts the owner’s note under the board’s prompt', async () => {
    const { d } = await decided();
    const res = await body(await fromDecision({ decision: d.wid, note: 'Leave the web tasks alone.' }));
    expect(res.status).toBe(201);
    expect(res.task.brief).toMatch(/What to do[\s\S]*\n\nNote from the owner:\nLeave the web tasks alone\.$/);
  });

  it('refuses an unanswered decision, a task with none, a prompt of its own, and another repository', async () => {
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const { d } = await decided({ answer: false });
    const open = await body(await fromDecision({ decision: d.wid }));
    expect(open.status).toBe(409);
    expect(open.error).toMatch(/isn’t answered yet/);
    const plain = (
      await body(await api('tasks', { method: 'POST', body: [{ description: 'No questions', project: 'ops' }] }))
    ).tasks[0];
    expect((await body(await fromDecision({ decision: plain.wid }))).error).toMatch(/has no decision/);
    expect((await fromDecision({ decision: 'OPS-99999' })).status).toBe(404);
    // Only the decision's pending task and the plain one were made: no general task.
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before + 3);
    const answered = await decided();
    expect((await body(await fromDecision({ decision: answered.d.wid, prompt: 'Mine' }))).status).toBe(400);
    const elsewhere = await body(await fromDecision({ decision: answered.d.wid, repo: 'breakaway' }));
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.error).toMatch(/runs in widgets/);
    expect((await fromDecision({ decision: answered.d.wid, by: 'claude-x' })).status).toBe(403);
  });

  it('links to the open one instead of starting a second, and starts again once it’s closed', async () => {
    const { d } = await decided();
    const first = await body(await fromDecision({ decision: d.wid }));
    const fired = fires.length;
    const again = await body(await fromDecision({ decision: d.wid, note: 'And again' }));
    expect(again.status).toBe(200);
    expect(again.run).toBeNull();
    expect(again.task.uuid).toBe(first.task.uuid);
    expect(again.already).toBe(`${first.task.claim} is on it`);
    expect(fires.length).toBe(fired);
    // Its agent finishes on the board: the next start makes a new one.
    await api(`tasks/${first.task.uuid}/release`, { method: 'POST', body: { agent: first.task.claim } });
    const next = await body(await fromDecision({ decision: d.wid }));
    expect(next.status).toBe(201);
    expect(next.task.uuid).not.toBe(first.task.uuid);
  });

  it('shows the prompt it would write with dryRun, and makes nothing', async () => {
    const { d, w } = await decided();
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const fired = fires.length;
    const preview = await body(await fromDecision({ decision: d.wid, dryRun: true }));
    expect(preview.status).toBe(200);
    expect(preview).toMatchObject({ dryRun: true, task: null, already: null, refusal: null });
    expect(preview.title).toBe(`Refine from the answers to ${d.wid}: Choose how edits land`);
    expect(preview.prompt).toContain(`- ${w.wid}: Build the edits (feature: cross-edits)`);
    expect(preview.prompt).not.toContain('Note from the owner');
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before);
    expect(fires.length).toBe(fired);
    // The start writes the same prompt.
    const started = await body(await fromDecision({ decision: d.wid }));
    expect(started.task.brief).toBe(preview.prompt);
    // While it's open, the preview names it.
    const again = await body(await fromDecision({ decision: d.wid, dryRun: true }));
    expect(again.task.uuid).toBe(started.task.uuid);
    expect(again.already).toBe(`${started.task.claim} is on it`);
    // Without a decision there's nothing to show, and nothing is made.
    expect((await general({ dryRun: true })).status).toBe(400);
  });

  it('says in the dry run why it can’t start, and still refuses an unanswered decision', async () => {
    const { d } = await decided({ answer: false });
    expect((await fromDecision({ decision: d.wid, dryRun: true })).status).toBe(409);
    await api('repos', { method: 'POST', body: { slug: 'hushed', github: 'acme/hushed', areas: ['product:HU'] } });
    const [q] = (
      await body(
        await api('tasks', {
          method: 'POST',
          body: [{ description: 'Pick a name', project: 'product', repo: 'hushed', decision: QUESTIONS }],
        }),
      )
    ).tasks;
    await api(`tasks/${q.wid}/decision/answers`, { method: 'POST', body: { answers: { edits: { value: 'direct' } } } });
    const preview = await body(await fromDecision({ decision: q.wid, dryRun: true }));
    expect(preview.status).toBe(200);
    expect(preview.prompt).toContain('Questions and answers');
    expect(preview.refusal).toMatch(/hushed’s agent routine isn’t connected/);
  });

  it('takes the CLI’s request: agents new --decision <ID> "<note>"', async () => {
    const { d } = await decided();
    const built = generalAgentRequest('Keep it small', { decision: d.wid, force: true, by: 'owner' });
    const [method, path, payload] = built.request;
    const res = await body(await api(path, { method, body: payload }));
    expect(res.status).toBe(201);
    expect(res.task.related).toEqual([d.uuid]);
    expect(res.task.brief).toMatch(/Note from the owner:\nKeep it small$/);
    expect(method).toBe('POST');
  });

  it('keeps a long prompt within a description, and points at the decision for the rest', () => {
    const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, type: 'open', prompt: 'x'.repeat(1900) }));
    const answers = Object.fromEntries(questions.map((q) => [q.id, { value: 'y'.repeat(5000) }]));
    const { title, brief } = refinePrompt(
      { ref: 'OPS-1', description: 'A long one', questions, answers },
      [],
      'n'.repeat(5000),
    );
    expect(title).toBe('Refine from the answers to OPS-1: A long one');
    expect(brief.length).toBeLessThanOrEqual(10000);
    expect(brief).toContain('the rest is on OPS-1');
    expect(brief).toContain('What to do');
    expect(brief).toContain('Nothing open waits for it');
  });
});
