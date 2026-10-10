import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { diffOps, legacyQuestions, view, withChanges } from '../src/model.js';
import { api, latestVersion, pushOps, readChild, twCreate } from './helpers.js';

// A decision's questions live in `decision_questions` (BRK-346): while Taskwarrior's UDA was called `decision`, it read
// the word as that attribute's value, so `task add … who:decision` stored no who. The API keeps the name `decision`.

const NOW = new Date('2026-10-10T12:00:00Z');
const QUESTIONS = [{ id: 'go', type: 'yesno', prompt: 'Should we do this?' }];
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);

describe('a decision’s questions, in the model', () => {
  it('stores them as decision_questions and shows them as decision', () => {
    const map = withChanges(null, { description: 'Pick', decision: QUESTIONS }, NOW);
    expect(JSON.parse(map.decision_questions)).toEqual(QUESTIONS);
    expect(map.decision).toBeUndefined();
    expect(view('u', map, new Map([['u', map]]), NOW).decision).toEqual(QUESTIONS);
    expect(withChanges(map, { decision: null }, NOW).decision_questions).toBeUndefined();
  });

  it('moves an older map’s decision forward, and leaves one without it as it is', () => {
    const old = { description: 'x', who: 'decision', decision: JSON.stringify(QUESTIONS) };
    expect(legacyQuestions(old)).toEqual({ description: 'x', who: 'decision', decision_questions: old.decision });
    // Both at once (an older replica wrote decision after the move): the newer key wins, and the old one goes.
    const both = { description: 'x', decision: '[]', decision_questions: old.decision };
    expect(legacyQuestions(both)).toEqual({ description: 'x', decision_questions: old.decision });
    const plain = { description: 'y', decision_questions: old.decision };
    expect(legacyQuestions(plain)).toBe(plain);
    // A change to an older map lands on the new key.
    expect(withChanges(old, { brief: 'why' }, NOW)).toMatchObject({ decision_questions: old.decision });
    expect(withChanges(old, { brief: 'why' }, NOW).decision).toBeUndefined();
  });

  it('clears an older map’s questions for good: the old key doesn’t bring them back', () => {
    const old = { description: 'x', who: 'decision', decision: JSON.stringify(QUESTIONS) };
    const cleared = withChanges(old, { decision: null }, NOW);
    expect(cleared.decision).toBeUndefined();
    expect(cleared.decision_questions).toBeUndefined();
    expect(view('u', cleared, new Map([['u', cleared]]), NOW).decision).toBeNull();
  });
});

describe('a decision’s questions, on the board', () => {
  it('migrates every stored task once, in one version Taskwarrior reads', async () => {
    const uuid = crypto.randomUUID();
    const before = await inStore(async (store) => {
      await store.ready();
      store.loadTasks();
      // Written before BRK-346, straight into history, as an older board did.
      const old = {
        description: 'Asked before BRK-346',
        status: 'pending',
        entry: '1790596800',
        who: 'decision',
        decision: JSON.stringify(QUESTIONS),
      };
      store.commit(diffOps(uuid, null, old, NOW.toISOString()));
      store.setMeta('questions_migrated', null);
      return store.latest();
    });
    const { task } = await body(await api(`tasks/${uuid}`));
    expect(task).toMatchObject({ who: 'decision', decision: QUESTIONS });
    const { ops } = await readChild(before);
    const of = Object.fromEntries(ops.filter((o) => o.uuid === uuid).map((o) => [o.property, o.value]));
    expect(of).toEqual({ decision: null, decision_questions: JSON.stringify(QUESTIONS) });
    expect(await inStore(async (store) => store.meta('questions_migrated'))).toBeTruthy();
  });

  it('moves the questions a replica with an older taskrc sends, and tells it so', async () => {
    const uuid = crypto.randomUUID();
    const pushed = await pushOps(
      await latestVersion(),
      twCreate(uuid, { description: 'From an older taskrc', who: 'decision', decision: JSON.stringify(QUESTIONS) }),
    );
    expect(pushed.status).toBe(200);
    const { task } = await body(await api(`tasks/${uuid}`));
    expect(task).toMatchObject({ who: 'decision', decision: QUESTIONS });
    // The board's follow-up version, which the replica syncs next.
    const { ops } = await readChild(pushed.headers.get('X-Version-Id'));
    expect(ops.filter((o) => o.uuid === uuid).map((o) => [o.property, o.value])).toEqual(
      expect.arrayContaining([
        ['decision', null],
        ['decision_questions', JSON.stringify(QUESTIONS)],
      ]),
    );
  });

  it('keeps the API’s field decision, and stores decision_questions', async () => {
    const made = (
      await body(await api('tasks', { method: 'POST', body: { description: 'Asked over HTTP', decision: QUESTIONS } }))
    ).tasks[0];
    expect(made).toMatchObject({ who: 'decision', decision: QUESTIONS });
    const raw = await inStore(async (store) => store.tasks.get(made.uuid));
    expect(raw.decision).toBeUndefined();
    expect(JSON.parse(raw.decision_questions)).toEqual(QUESTIONS);
  });
});
