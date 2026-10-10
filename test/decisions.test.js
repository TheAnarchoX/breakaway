import { describe, expect, it } from 'vitest';
import { validateAnswers, validateQuestions, summarize } from '../src/decision.js';
import { view, withChanges } from '../src/model.js';
import { api } from './helpers.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const json = async (res) => ({ status: res.status, ...(await res.json()) });

const opts = [
  { id: 'a', label: 'Alice' },
  { id: 'b', label: 'Bea', note: 'Means later.' },
  { id: 'c', label: 'Cy' },
];
const QUESTIONS = [
  { id: 'why', type: 'open', prompt: 'Why?' },
  { id: 'go', type: 'yesno', prompt: 'Go ahead?' },
  { id: 'keeper', type: 'choice', prompt: 'Who keeps it?', options: opts, other: true },
  { id: 'many', type: 'multi', prompt: 'Which areas?', options: opts, min: 1, max: 2, required: false },
  { id: 'order', type: 'rank', prompt: 'Which first?', options: opts },
  { id: 'size', type: 'scale', prompt: 'How big?', min: 1, max: 5, minLabel: 'small', maxLabel: 'large' },
  { id: 'when', type: 'date', prompt: 'By when?' },
];
const ANSWERS = {
  why: { value: 'Because.' },
  go: { value: 'yes', comment: 'after OPS-8' },
  keeper: { value: 'a' },
  order: { value: ['c', 'a', 'b'] },
  size: { value: 3 },
  when: { value: '2026-10-10' },
};

describe('validating a decision', () => {
  it('accepts every question type', () => {
    expect(validateQuestions(QUESTIONS)).toHaveLength(7);
  });

  it('rejects what makes no sense', () => {
    const bad = (q, re) => expect(() => validateQuestions(q)).toThrow(re);
    bad([], /at least one question/u);
    bad('nope', /list of questions/u);
    bad(
      Array.from({ length: 21 }, (_, i) => ({ id: `q${i}`, type: 'open', prompt: 'x' })),
      /20 questions/u,
    );
    bad(
      [
        { id: 'q1', type: 'open', prompt: 'x' },
        { id: 'q1', type: 'open', prompt: 'y' },
      ],
      /twice/u,
    );
    bad([{ id: 'has space', type: 'open', prompt: 'x' }], /id/u);
    bad([{ id: 'q1', type: 'poll', prompt: 'x' }], /type/u);
    bad([{ id: 'q1', type: 'open', prompt: '  ' }], /prompt/u);
    bad([{ id: 'q1', type: 'choice', prompt: 'x', options: [{ id: 'a', label: 'A' }] }], /at least 2 options/u);
    bad(
      [
        {
          id: 'q1',
          type: 'choice',
          prompt: 'x',
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        },
      ],
      /option/u,
    );
    bad([{ id: 'q1', type: 'scale', prompt: 'x', min: 5, max: 1 }], /min/u);
    bad([{ id: 'q1', type: 'multi', prompt: 'x', options: opts, min: 3, max: 1 }], /min/u);
    bad([{ id: 'q1', type: 'open', prompt: 'x'.repeat(21000) }], /20 KB|too long/u);
  });
});

describe('validating answers', () => {
  const ok = (answers) => validateAnswers(QUESTIONS, answers);
  const bad = (answers, re) => expect(() => ok(answers)).toThrow(re);

  it('accepts a complete set and keeps only what belongs to each type', () => {
    expect(ok({ ...ANSWERS, many: { value: ['a', 'c'] } })).toMatchObject({
      why: { value: 'Because.' },
      many: { value: ['a', 'c'] },
      go: { value: 'yes', comment: 'after OPS-8' },
    });
  });

  it('lets optional questions stay blank and names a required one that is', () => {
    expect(ok(ANSWERS)).not.toHaveProperty('many');
    const { why, ...rest } = ANSWERS;
    bad(rest, /"Why\?"/u);
    bad({ ...ANSWERS, why: { value: '   ' } }, /"Why\?"/u);
  });

  it('checks each type', () => {
    bad({ ...ANSWERS, ghost: { value: 'x' } }, /no question "ghost"/u);
    bad({ ...ANSWERS, go: { value: 'maybe' } }, /yes or no/u);
    bad({ ...ANSWERS, keeper: { value: 'z' } }, /option/u);
    expect(ok({ ...ANSWERS, keeper: { value: 'other', other: 'Dee' } }).keeper).toEqual({
      value: 'other',
      other: 'Dee',
    });
    bad({ ...ANSWERS, keeper: { value: 'other' } }, /something else/u);
    bad({ ...ANSWERS, many: { value: ['a', 'a'] } }, /once/u);
    expect(ok({ ...ANSWERS, many: { value: [] } })).not.toHaveProperty('many');
    expect(() => validateAnswers([{ ...QUESTIONS[3], required: true }], { many: { value: [] } })).toThrow(
      /at least 1/u,
    );
    bad({ ...ANSWERS, many: { value: ['a', 'b', 'c'] } }, /at most 2/u);
    bad({ ...ANSWERS, many: { value: 'a' } }, /list/u);
    bad({ ...ANSWERS, order: { value: ['a', 'b'] } }, /every option/u);
    bad({ ...ANSWERS, order: { value: ['a', 'b', 'x'] } }, /option/u);
    bad({ ...ANSWERS, size: { value: 6 } }, /between 1 and 5/u);
    bad({ ...ANSWERS, size: { value: 2.5 } }, /whole number/u);
    bad({ ...ANSWERS, size: { value: '3' } }, /whole number/u);
    bad({ ...ANSWERS, when: { value: '2026-02-31' } }, /date/u);
    bad({ ...ANSWERS, when: { value: 'tomorrow' } }, /date/u);
    bad({ ...ANSWERS, go: { value: 'yes', comment: 'x'.repeat(1001) } }, /comment/u);
    bad({ ...ANSWERS, why: { value: 'x'.repeat(10001) } }, /10000/u);
    bad('answers', /answers/u);
  });

  it('summarises for people', () => {
    const text = summarize(QUESTIONS, ok({ ...ANSWERS, keeper: { value: 'other', other: 'Dee' } }));
    expect(text).toMatch(/^Decided by the owner: /u);
    expect(text).toContain('Who keeps it? = Dee');
    expect(text).toContain('Go ahead? = yes (after OPS-8)');
    expect(text).toContain('Which first? = Cy, Alice, Bea');
    expect(text).toContain('Which areas? = no answer');
    expect(text).toContain('How big? = 3');
  });
});

describe('a decision in the model', () => {
  it('stores questions as JSON, tags the task, and shows them parsed', () => {
    const map = withChanges(null, { description: 'Pick', decision: QUESTIONS }, NOW);
    expect(JSON.parse(map.decision_questions)).toHaveLength(7);
    expect(map.who).toBe('decision');
    const v = view('u', map, new Map([['u', map]]), NOW);
    expect(v.decision).toHaveLength(7);
    expect(v.decisionAnswers).toBeNull();
  });

  it('shows a decision Taskwarrior mangled as no decision', () => {
    const v = view(
      'u',
      { description: 'x', status: 'pending', decision_questions: '{oops', decision_answers: '[[' },
      new Map(),
      NOW,
    );
    expect(v).toMatchObject({ decision: null, decisionAnswers: null });
  });

  it('keeps answers for questions that survive an edit and drops the rest', () => {
    let map = withChanges(null, { description: 'Pick', decision: QUESTIONS }, NOW);
    map.decision_answers = JSON.stringify({
      by: 'owner',
      at: NOW.toISOString(),
      answers: { why: { value: 'x' }, go: { value: 'no' } },
    });
    map = withChanges(map, { decision: QUESTIONS.filter((q) => q.id !== 'go') }, NOW);
    expect(JSON.parse(map.decision_answers).answers).toEqual({ why: { value: 'x' } });
    map = withChanges(map, { decision: null }, NOW);
    expect(map).not.toHaveProperty('decision');
    expect(map).not.toHaveProperty('decision_questions');
    expect(map).not.toHaveProperty('decision_answers');
  });
});

describe('a decision through the API', () => {
  const make = async (extra = {}) =>
    (
      await json(
        await api('tasks', {
          method: 'POST',
          body: { description: 'Decide something', project: 'ops', decision: QUESTIONS, force: true, ...extra },
        }),
      )
    ).tasks[0];
  const submit = (task, body) => api(`tasks/${task.wid}/decision/answers`, { method: 'POST', body });

  it('creates a decision task, who: decision, and rejects a bad one', async () => {
    const task = await make();
    expect(task.who).toBe('decision');
    expect(task.decision.map((q) => q.id)).toEqual(QUESTIONS.map((q) => q.id));
    const res = await api('tasks', { method: 'POST', body: { description: 'Bad', project: 'ops', decision: [] } });
    expect(res.status).toBe(400);
  });

  it('adds a decision to an existing task by PATCH', async () => {
    const [task] = (
      await json(await api('tasks', { method: 'POST', body: [{ description: 'Plain', project: 'ops' }] }))
    ).tasks;
    const res = await json(await api(`tasks/${task.wid}`, { method: 'PATCH', body: { decision: QUESTIONS } }));
    expect(res.task.who).toBe('decision');
  });

  it('submits atomically: stores answers, finishes, comments, and unblocks', async () => {
    const task = await make();
    const [waiting] = (
      await json(
        await api('tasks', { method: 'POST', body: [{ description: 'Waits', project: 'ops', depends: [task.wid] }] }),
      )
    ).tasks;
    expect(waiting.blocked).toBe(true);
    const res = await json(await submit(task, { answers: ANSWERS }));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      status: 'completed',
      decisionAnswers: { by: 'owner', answers: { keeper: { value: 'a' } } },
    });
    // Finished, it stays the decision it was.
    expect(res.task.who).toBe('decision');
    const last = res.task.comments.at(-1);
    expect(last.by).toBe('board');
    expect(last.text).toMatch(/^Decided by the owner: /u);
    const after = (await json(await api(`tasks/${waiting.wid}`))).task;
    expect(after).toMatchObject({ blocked: false, ready: true });
  });

  it('refuses an invalid answer and stores nothing', async () => {
    const task = await make();
    const res = await json(await submit(task, { answers: { ...ANSWERS, keeper: { value: 'zzz' } } }));
    expect(res.status).toBe(400);
    const now = (await json(await api(`tasks/${task.wid}`))).task;
    expect(now).toMatchObject({ status: 'pending', decisionAnswers: null });
    expect(now.who).toBe('decision');
  });

  it("is the owner's: an agent name is refused", async () => {
    const task = await make();
    expect((await submit(task, { answers: ANSWERS, by: 'claude-x' })).status).toBe(403);
    expect((await submit(task, { answers: ANSWERS, by: 'owner' })).status).toBe(200);
  });

  it('refuses a second submit, a task with no decision, and a missing task', async () => {
    const task = await make();
    expect((await submit(task, { answers: ANSWERS })).status).toBe(200);
    const again = await json(await submit(task, { answers: ANSWERS }));
    expect(again.status).toBe(409);
    expect(again.error).toMatch(/already decided/u);
    const [plain] = (
      await json(await api('tasks', { method: 'POST', body: [{ description: 'Plain', project: 'ops' }] }))
    ).tasks;
    expect((await submit(plain, { answers: {} })).status).toBe(400);
    expect((await api('tasks/OPS-99999/decision/answers', { method: 'POST', body: { answers: ANSWERS } })).status).toBe(
      404,
    );
  });

  it('reopens: pending as a decision, answers kept, dependents blocked again, then answers again', async () => {
    const task = await make();
    const [waiting] = (
      await json(
        await api('tasks', { method: 'POST', body: [{ description: 'Waits', project: 'ops', depends: [task.wid] }] }),
      )
    ).tasks;
    await submit(task, { answers: ANSWERS });
    expect(
      (await api(`tasks/${task.wid}/decision/answers`, { method: 'DELETE', body: { by: 'claude-x' } })).status,
    ).toBe(403);
    const res = await json(await api(`tasks/${task.wid}/decision/answers`, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({ status: 'pending', decisionAnswers: { answers: { go: { value: 'yes' } } } });
    expect(res.task.who).toBe('decision');
    expect((await json(await api(`tasks/${waiting.wid}`))).task.blocked).toBe(true);
    expect((await api(`tasks/${task.wid}/decision/answers`, { method: 'DELETE' })).status).toBe(409);
    const second = await json(await submit(task, { answers: { ...ANSWERS, go: { value: 'no' } } }));
    expect(second.task).toMatchObject({ status: 'completed', decisionAnswers: { answers: { go: { value: 'no' } } } });
  });

  it('logs answering and reopening in activity', async () => {
    const task = await make();
    await submit(task, { answers: ANSWERS });
    await api(`tasks/${task.wid}/decision/answers`, { method: 'DELETE' });
    const { events } = await json(await api('activity?limit=5'));
    const kinds = events.filter((e) => e.task?.wid === task.wid).flatMap((e) => e.changes.map((c) => c.kind));
    expect(kinds).toContain('decision-reopened');
    expect(kinds).toContain('decision-answered');
    expect(kinds).not.toContain('done');
  });
});
