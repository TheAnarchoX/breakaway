import { describe, expect, it } from 'vitest';
import {
  CHANGE_MAX_EDITS,
  agentPrompt,
  cardState,
  declaredFor,
  editLines,
  editMarks,
  fieldProblem,
  formValue,
  getPath,
  joinEdits,
  readEdits,
  recentChange,
  sameValue,
  setPath,
  settingEdits,
  writeEdits,
} from '../web/src/lib/infra-change.js';

// A change from the environment console (WEB-99), from made-up resources.

/** A storage like the browser's, in memory. */
function memory() {
  const kept = new Map();
  return {
    getItem: (/** @type {string} */ k) => kept.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => kept.set(k, v),
    removeItem: (/** @type {string} */ k) => kept.delete(k),
    kept,
  };
}

const worker = {
  id: 'worker:acme-api',
  kind: 'worker',
  name: 'acme-api',
  attrs: {
    usageModel: 'standard',
    compatibilityFlags: ['nodejs_compat'],
    observability: false,
    bindings: [
      { name: 'DB', type: 'd1', resource: 'd1:acme-db' },
      { name: 'API_KEY', type: 'secret_text' },
    ],
  },
};
const queue = { id: 'queue:acme-jobs', kind: 'queue', name: 'acme-jobs', attrs: { deliveryDelay: 0 } };

const FIELDS = [
  {
    path: 'usageModel',
    label: 'Usage model',
    type: 'choice',
    optional: true,
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'bundled', label: 'Bundled' },
    ],
    help: 'How it bills.',
  },
  {
    path: 'compatibilityFlags',
    label: 'Compatibility flags',
    type: 'names',
    pattern: '^[a-z0-9_]+$',
    help: 'Flags.',
  },
  { path: 'observability', label: 'Workers Logs', type: 'yesno', help: 'Logs.' },
  { path: 'crons', label: 'Cron triggers', type: 'names', help: 'When.' },
  {
    path: 'bindings',
    label: 'Bindings',
    type: 'bindings',
    help: 'What it reaches.',
    targets: [{ type: 'd1', label: 'D1 database', kind: 'd1', field: 'resource', by: 'id' }],
  },
];

describe('keeping a change', () => {
  it('keeps edits per environment, and forgets them when there are none', () => {
    const storage = memory();
    writeEdits(7, [{ op: 'remove', resource: 'queue:acme-jobs' }], storage);
    expect(readEdits(7, storage)).toEqual([{ op: 'remove', resource: 'queue:acme-jobs' }]);
    expect(readEdits(8, storage)).toEqual([]);
    writeEdits(7, [], storage);
    expect(storage.kept.size).toBe(0);
  });

  it('reads nothing from a broken or blocked storage', () => {
    const storage = memory();
    storage.setItem('breakaway.change.7', '{not json');
    expect(readEdits(7, storage)).toEqual([]);
    expect(readEdits(7, null)).toEqual([]);
    storage.setItem('breakaway.change.7', JSON.stringify([{ op: 'drop' }, { op: 'remove', resource: 'x' }]));
    expect(readEdits(7, storage)).toEqual([{ op: 'remove', resource: 'x' }]);
  });

  it('replaces a setting set again, and a removal drops the settings set on it', () => {
    const set = (/** @type {string} */ value) => ({ op: 'set', resource: worker.id, path: 'usageModel', value });
    let r = joinEdits([set('bundled')], [set('standard')]);
    expect(r).toEqual({ edits: [set('standard')] });
    r = joinEdits(
      [set('bundled'), { op: 'set', resource: queue.id, path: 'deliveryDelay', value: 5 }],
      [{ op: 'remove', resource: worker.id }],
    );
    expect(r).toEqual({
      edits: [
        { op: 'set', resource: queue.id, path: 'deliveryDelay', value: 5 },
        { op: 'remove', resource: worker.id },
      ],
    });
    // Removing twice is one removal.
    expect(joinEdits(/** @type {any} */ (r).edits, [{ op: 'remove', resource: worker.id }])).toEqual(r);
  });

  it(`holds at most ${CHANGE_MAX_EDITS} edits`, () => {
    const many = Array.from({ length: CHANGE_MAX_EDITS }, (_, n) => ({ op: 'remove', resource: `queue:q${n}` }));
    const r = joinEdits(/** @type {any} */ (many), [{ op: 'remove', resource: 'queue:one-more' }]);
    expect(r).toEqual({ error: expect.stringContaining('at most 50 edits') });
  });
});

describe('paths and values', () => {
  it('reads and writes a dotted path without changing what it was given', () => {
    const rule = { id: 'old', allowed: { origins: ['https://acme.example'] } };
    expect(getPath(rule, 'allowed.origins')).toEqual(['https://acme.example']);
    expect(getPath(rule, 'allowed.methods')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
    const out = setPath(rule, 'allowed.methods', ['GET']);
    expect(out.allowed).toEqual({ origins: ['https://acme.example'], methods: ['GET'] });
    expect(rule.allowed).toEqual({ origins: ['https://acme.example'] });
    expect(setPath(rule, 'id', null)).toEqual({ allowed: rule.allowed });
  });

  it('compares settings whatever the order of their keys', () => {
    expect(sameValue({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});

describe('the settings form', () => {
  it('starts each field from the resource’s setting', () => {
    expect(formValue(FIELDS[1], ['nodejs_compat', 'streams'])).toBe('nodejs_compat\nstreams');
    expect(formValue({ path: 'd', label: 'D', type: 'number', help: '' }, 30)).toBe('30');
    expect(formValue({ path: 'd', label: 'D', type: 'number', help: '' }, undefined)).toBe('');
    expect(formValue(FIELDS[2], undefined)).toBe(false);
    expect(formValue(FIELDS[0], undefined)).toBe('');
  });

  it('says what’s wrong with a value the way the provider declares the field', () => {
    const delay = {
      path: 'deliveryDelay',
      label: 'Delivery delay',
      type: 'number',
      integer: true,
      min: 0,
      max: 86_400,
      optional: true,
      help: 'How long.',
    };
    expect(fieldProblem(delay, '')).toBeNull();
    expect(fieldProblem({ ...delay, optional: false }, '')).toBe('Delivery delay needs a number.');
    expect(fieldProblem(delay, '1.5')).toBe('Delivery delay is a whole number.');
    expect(fieldProblem(delay, '90000')).toBe('Delivery delay is at most 86400.');
    expect(fieldProblem(delay, 'soon')).toBe('Delivery delay is a number.');
    expect(fieldProblem(FIELDS[1], 'nodejs_compat\nNot A Flag')).toContain('Not A Flag doesn’t fit');
    expect(fieldProblem(FIELDS[0], 'unbound')).toBe('Usage model is one of Standard, Bundled.');
    expect(fieldProblem(FIELDS[4], [{ name: 'DB', type: 'd1', resource: '' }])).toBe('Pick the d1 database DB binds.');
    expect(
      fieldProblem(FIELDS[4], [
        { name: 'DB', type: 'd1', resource: 'd1:a' },
        { name: 'DB', type: 'd1', resource: 'd1:b' },
      ]),
    ).toBe('Two bindings are called DB: give each its own name.');
    const rules = {
      path: 'cors',
      label: 'CORS rules',
      type: 'rules',
      help: '',
      fields: [{ path: 'maxAgeSeconds', label: 'Cache for', type: 'number', min: 0, optional: true, help: '' }],
    };
    expect(fieldProblem(rules, [{ maxAgeSeconds: '-1' }])).toBe('Cache for is at least 0.');
  });

  it('makes one set edit per changed field, and none for what stayed', () => {
    const form = {
      usageModel: 'bundled',
      compatibilityFlags: 'nodejs_compat\n\n',
      observability: true,
      crons: '',
      bindings: [
        { name: 'DB', type: 'd1', resource: 'd1:acme-db' },
        { name: 'API_KEY', type: 'secret_text' },
        { name: ' JOBS ', type: 'd1', resource: 'd1:acme-jobs' },
      ],
    };
    expect(settingEdits(worker, FIELDS, form)).toEqual([
      { op: 'set', resource: worker.id, path: 'usageModel', value: 'bundled' },
      { op: 'set', resource: worker.id, path: 'observability', value: true },
      {
        op: 'set',
        resource: worker.id,
        path: 'bindings',
        value: [
          { name: 'DB', type: 'd1', resource: 'd1:acme-db' },
          { name: 'API_KEY', type: 'secret_text' },
          { name: 'JOBS', type: 'd1', resource: 'd1:acme-jobs' },
        ],
      },
    ]);
    // An optional choice left empty is unset: the platform decides.
    expect(settingEdits(worker, FIELDS, { usageModel: '' })).toEqual([
      { op: 'set', resource: worker.id, path: 'usageModel', value: null },
    ]);
    expect(
      settingEdits(queue, [{ path: 'deliveryDelay', label: 'D', type: 'number', help: '' }], { deliveryDelay: '0' }),
    ).toEqual([]);
  });
});

describe('the change in words', () => {
  const labels = new Map([['worker', FIELDS]]);

  it('says each edit in a line, at once', () => {
    const lines = editLines(
      [
        { op: 'set', resource: worker.id, path: 'usageModel', value: 'bundled' },
        { op: 'set', resource: worker.id, path: 'crons', value: ['0 3 * * *'] },
        { op: 'add', template: 'queue', inputs: { name: 'acme-mail' } },
        { op: 'remove', resource: queue.id },
        { op: 'remove', resource: 'queue:gone' },
      ],
      [worker, queue],
      labels,
    );
    expect(lines).toEqual([
      '~ acme-api: usage model standard → bundled',
      '~ acme-api: cron triggers unset → ["0 3 * * *"]',
      '+ queue acme-mail (from a template)',
      '− queue acme-jobs',
      '− resource queue:gone',
    ]);
  });

  it('marks what it changes and removes on the map', () => {
    const marks = editMarks([
      { op: 'set', resource: worker.id, path: 'usageModel', value: 'bundled' },
      { op: 'remove', resource: queue.id },
    ]);
    expect(marks.get(worker.id)?.effect).toBe('changes');
    expect(marks.get(queue.id)?.effect).toBe('removes');
  });

  it('finds the declared resource behind one the board saw, by ID or by kind and name', () => {
    expect(declaredFor([worker, queue], { id: 'queue:acme-jobs', kind: 'queue', name: 'x' })).toBe(queue);
    expect(declaredFor([worker], { id: 'worker:other-id', kind: 'worker', name: 'acme-api' })).toBe(worker);
    expect(declaredFor([worker], { id: 'kv:acme', kind: 'kv', name: 'acme' })).toBeNull();
  });

  it('fills in the prompt for an agent with what the owner was changing', () => {
    const prompt = agentPrompt({ name: 'staging', repo: 'acme/widgets' }, [
      '~ acme-api: usage model standard → bundled',
    ]);
    expect(prompt).toContain('.github/breakaway-infra/staging.json in acme/widgets');
    expect(prompt).toContain('- ~ acme-api: usage model standard → bundled');
  });
});

describe('the change’s card', () => {
  const change = { state: 'open', why: null, approval: null, digest: 'd'.repeat(64), commit: 'abc1234' };

  it('checks while the plan check runs, then waits for you with Approve and Reject', () => {
    expect(cardState(change, { checks: 'pending' })).toMatchObject({ state: 'checking', approve: true, reject: true });
    expect(cardState(change, { checks: 'success' })).toMatchObject({ state: 'waiting', approve: true, again: false });
    expect(cardState(change)).toMatchObject({ state: 'waiting' });
    expect(cardState(change, { checks: 'failure' })).toMatchObject({ state: 'waiting', again: true });
  });

  it('offers Merge instead of Approve for a draft with no edits, once its checks are done', () => {
    const described = { ...change, edits: [], lines: [] };
    expect(cardState(described, { checks: 'success' })).toMatchObject({
      state: 'waiting',
      approve: false,
      merge: true,
      reject: true,
    });
    expect(cardState(described, { checks: 'pending' })).toMatchObject({ state: 'checking', merge: false });
    expect(cardState({ ...change, edits: [{ op: 'remove', resource: 'acme-db' }] })).toMatchObject({
      approve: true,
      merge: false,
    });
  });

  it('merges once approved, or says it can’t with Propose again', () => {
    expect(cardState({ ...change, state: 'approved' })).toMatchObject({
      state: 'merging',
      approve: false,
      again: false,
    });
    expect(cardState({ ...change, state: 'approved', why: 'Can’t merge #12: checks failing.' })).toMatchObject({
      state: 'cant',
      approve: false,
      reject: true,
      again: true,
    });
  });

  it('follows the merged change’s plan', () => {
    expect(cardState({ ...change, state: 'merged' })).toMatchObject({ state: 'merged' });
    expect(cardState({ ...change, state: 'merged' }, { plan: { state: 'applying' } })).toMatchObject({
      state: 'applying',
      plan: true,
    });
    expect(cardState({ ...change, state: 'taken over' })).toMatchObject({ state: 'taken over', approve: false });
  });

  it('shows a finished change for a day', () => {
    const now = Date.now();
    expect(recentChange({ updated: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(recentChange({ updated: new Date(now - 25 * 3_600_000).toISOString() }, now)).toBe(false);
  });
});
