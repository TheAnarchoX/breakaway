import { describe, expect, it } from 'vitest';
import {
  bindChoice,
  boundRows,
  bindingChoices,
  boundChoice,
  CHANGE_MAX_EDITS,
  agentPrompt,
  bindingFor,
  cardState,
  changePlanId,
  changeShows,
  codePrompt,
  createAt,
  createEdit,
  createForm,
  createOverlay,
  createProblems,
  createStart,
  declaredFor,
  editLines,
  editMarks,
  endedWords,
  FOLD_MS,
  fieldProblem,
  formValue,
  getPath,
  idleEdits,
  plansNothing,
  joinEdits,
  nameAfter,
  nameEdits,
  nameProblem,
  orderCreates,
  pendingCreates,
  readDismissed,
  readEdits,
  rebind,
  recentChange,
  replaceCreate,
  sameValue,
  setPath,
  settingEdits,
  writeDismissed,
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
const route = { id: 'route:r1', kind: 'route', name: 'api.acme.example/*', attrs: { worker: 'acme-api' } };
const PATTERN = { label: 'Pattern', pattern: '^\\S+$', help: 'The hostname and path.' };

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

  it('keeps one rename per resource, and a removal drops it', () => {
    const rename = (/** @type {string} */ name) => ({ op: 'rename', resource: route.id, name });
    const storage = memory();
    writeEdits(7, [rename('v2.acme.example/*')], storage);
    expect(readEdits(7, storage)).toEqual([rename('v2.acme.example/*')]);
    expect(joinEdits([rename('v2.acme.example/*')], [rename('v3.acme.example/*')])).toEqual({
      edits: [rename('v3.acme.example/*')],
    });
    expect(joinEdits([rename('v2.acme.example/*')], [{ op: 'remove', resource: route.id }])).toEqual({
      edits: [{ op: 'remove', resource: route.id }],
    });
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

describe('the name field', () => {
  it('renames only when the name changes, says what’s wrong, and starts from the change’s rename', () => {
    expect(nameEdits(route, ' api.acme.example/* ')).toEqual([]);
    expect(nameEdits(route, 'v2.acme.example/*')).toEqual([
      { op: 'rename', resource: route.id, name: 'v2.acme.example/*' },
    ]);
    expect(nameProblem(PATTERN, 'v2.acme.example/*')).toBeNull();
    expect(nameProblem(PATTERN, '')).toBe('Pattern needs a value.');
    expect(nameProblem(PATTERN, 'has space/*')).toBe('Pattern doesn’t look right: The hostname and path.');
    expect(nameAfter([], route)).toBe('api.acme.example/*');
    expect(nameAfter([{ op: 'rename', resource: route.id, name: 'v2.acme.example/*' }], route)).toBe(
      'v2.acme.example/*',
    );
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
        { op: 'rename', resource: route.id, name: 'v2.acme.example/*' },
      ],
      [worker, queue, route],
      labels,
      new Map([['route', PATTERN]]),
    );
    expect(lines).toEqual([
      '~ acme-api: usage model standard → bundled',
      '~ acme-api: cron triggers unset → 0 3 * * *',
      '+ queue acme-mail (from a template)',
      '− queue acme-jobs',
      '− resource queue:gone',
      '~ route api.acme.example/*: pattern → v2.acme.example/*',
    ]);
  });

  it('words bindings one at a time, never as JSON, and finds the edits that change nothing (WEB-110)', () => {
    const labels = new Map([['worker', FIELDS]]);
    const [db, key] = worker.attrs.bindings;
    const chat = { name: 'CHAT', type: 'durable_object_namespace', class_name: 'Chat' };
    const edits = [
      { op: 'set', resource: worker.id, path: 'bindings', value: [key, db, chat] },
      { op: 'set', resource: worker.id, path: 'bindings', value: [key, db] },
      { op: 'set', resource: worker.id, path: 'usageModel', value: 'standard' },
      { op: 'set', resource: worker.id, path: 'observability', value: true },
    ];
    const lines = editLines(edits, [worker], labels);
    expect(lines[0]).toBe('~ acme-api: bindings + CHAT (durable object namespace); API_KEY, DB unchanged');
    expect(lines[3]).toBe('~ acme-api: workers logs no → yes');
    expect(lines.join('\n')).not.toMatch(/[[{"]/u);
    expect([...idleEdits(edits, [worker], labels)]).toEqual([
      [1, 'acme-api’s bindings are the same in another order, so it changes nothing'],
      [2, 'acme-api’s usage model is already standard, so it changes nothing'],
    ]);
    // The settings form makes no edit for the same bindings in another order.
    expect(settingEdits(worker, FIELDS, { bindings: [key, db] })).toEqual([]);
  });

  it('marks what it changes and removes on the map', () => {
    const marks = editMarks([
      { op: 'set', resource: worker.id, path: 'usageModel', value: 'bundled' },
      { op: 'remove', resource: queue.id },
      { op: 'rename', resource: route.id, name: 'v2.acme.example/*' },
    ]);
    expect(marks.get(route.id)?.effect).toBe('changes');
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

describe('what a binding binds (BRK-285)', () => {
  const D1 = { type: 'd1', label: 'D1 database', kind: 'd1', field: 'id', by: /** @type {const} */ ('id') };
  const R2 = {
    type: 'r2_bucket',
    label: 'R2 bucket',
    kind: 'r2',
    field: 'bucket_name',
    by: /** @type {const} */ ('name'),
  };
  const declared = [
    { id: 'd1:acme-db', kind: 'd1', name: 'acme-db' },
    { id: 'd1:acme-db-2', kind: 'd1', name: 'acme-db-2' },
    { id: 'r2:acme-media', kind: 'r2', name: 'acme-media' },
  ];
  const running = [{ id: 'd1:0000-acme-uuid', kind: 'd1', name: 'acme-db' }];

  it('binds one that runs by its platform ID, one still to be made by its ID in the file, and a bucket by name', () => {
    expect(bindingChoices(D1, declared, running)).toEqual([
      { key: 'd1:acme-db', label: 'acme-db', binds: { id: '0000-acme-uuid' } },
      { key: 'd1:acme-db-2', label: 'acme-db-2', binds: { resource: 'd1:acme-db-2' } },
    ]);
    expect(bindingChoices(R2, declared, running)).toEqual([
      { key: 'r2:acme-media', label: 'acme-media', binds: { bucket_name: 'acme-media' } },
    ]);
  });

  it('reads either shape back, keeps what no choice is, and reads a binding with no target from what runs', () => {
    const choices = bindingChoices(D1, declared, running);
    expect(boundChoice(D1, { name: 'DB', type: 'd1', id: '0000-acme-uuid' }, choices)).toEqual({
      key: 'd1:acme-db',
      other: null,
      kept: false,
    });
    expect(boundChoice(D1, { name: 'DB', type: 'd1', resource: 'd1:acme-db-2' }, choices).key).toBe('d1:acme-db-2');
    expect(boundChoice(D1, { name: 'DB', type: 'd1', id: 'elsewhere' }, choices)).toEqual({
      key: null,
      other: 'elsewhere',
      kept: false,
    });
    const live = [{ name: 'DB', type: 'd1', id: '0000-acme-uuid' }];
    expect(boundChoice(D1, { name: 'DB', type: 'd1' }, choices, live)).toEqual({
      key: 'd1:acme-db',
      other: null,
      kept: true,
    });
    expect(boundChoice(D1, { name: 'DB', type: 'd1' }, choices)).toEqual({ key: null, other: null, kept: true });
  });

  it('a pick replaces what it bound, and a new row needs one', () => {
    const [, later] = bindingChoices(D1, declared, running);
    expect(bindChoice(D1, { name: 'DB', type: 'd1', id: '0000-acme-uuid' }, later)).toEqual({
      name: 'DB',
      type: 'd1',
      resource: 'd1:acme-db-2',
    });
    const field = { path: 'bindings', label: 'Bindings', type: 'bindings', help: '', targets: [D1] };
    expect(fieldProblem(field, [bindChoice(D1, { name: 'DB', type: 'd1' }, null)])).toBe(
      'Pick the d1 database DB binds.',
    );
    expect(fieldProblem(field, [{ name: 'DB', type: 'd1' }])).toBeNull();
    expect(fieldProblem(field, [{ name: 'DB', type: 'd1', resource: 'd1:acme-db-2' }])).toBeNull();
  });
});

describe('adding a resource', () => {
  const D1_TARGET = {
    type: 'd1',
    label: 'D1 database',
    kind: 'd1',
    field: 'resource',
    by: /** @type {const} */ ('id'),
  };
  const QUEUE_TARGET = {
    type: 'queue',
    label: 'Queue',
    kind: 'queue',
    field: 'queue',
    by: /** @type {const} */ ('name'),
  };
  /** @type {Record<string, import('../web/src/lib/infra-change.js').CreatableKind>} */
  const CREATABLE = {
    queue: {
      label: 'Queue',
      help: 'Holds messages.',
      name: { label: 'Name', pattern: '^[a-z0-9-]+$', max: 20, help: 'Lowercase, like acme-jobs.' },
      fields: [
        {
          path: 'deliveryDelay',
          label: 'Delivery delay',
          type: 'number',
          integer: true,
          min: 0,
          help: 'Wait.',
          default: 0,
        },
        { path: 'deliveryPaused', label: 'Paused', type: 'yesno', help: 'Hold it.', default: false },
      ],
      bind: { kind: 'worker', list: 'bindings', target: QUEUE_TARGET, required: true },
    },
    d1: {
      label: 'D1 database',
      help: 'SQL.',
      name: { label: 'Name', pattern: '^[a-z0-9-]+$', help: 'Lowercase.' },
      fields: [],
      bind: { kind: 'worker', list: 'bindings', target: D1_TARGET },
    },
    route: {
      label: 'Route',
      help: 'Sends requests.',
      name: { label: 'Pattern', pattern: '^\\S+$', help: 'The hostname and path.' },
      fields: [
        { path: 'zone', label: 'Zone', type: 'text', help: 'The domain.', required: true },
        { path: 'worker', label: 'Worker', type: 'resource', kinds: ['worker'], help: 'Which.', required: true },
      ],
    },
    'durable-object': {
      label: 'Durable Object',
      help: 'State.',
      name: { label: 'Name', help: 'Worker_Class.' },
      fields: [{ path: 'class', label: 'Class', type: 'text', help: 'The class.', required: true }],
      needsCode: 'The Worker exports the class.',
    },
  };
  const where = { taken: [worker, queue, route], declared: [worker, queue, route] };

  it('suggests a binding name from the resource’s name', () => {
    expect(bindingFor('acme-jobs')).toBe('ACME_JOBS');
    expect(bindingFor('acme.jobs v2')).toBe('ACME_JOBS_V2');
    expect(bindingFor('2-fast')).toBe('R_2_FAST');
    expect(bindingFor('--')).toBe('');
    expect(bindingFor('a'.repeat(80))).toHaveLength(63);
  });

  it('starts the form from the kind’s defaults', () => {
    expect(createForm(CREATABLE.queue)).toEqual({ deliveryDelay: '0', deliveryPaused: false });
    expect(createForm(CREATABLE.route)).toEqual({ zone: '', worker: '' });
  });

  it('checks the name, the fields, and the binding as you type', () => {
    const queueForm = createForm(CREATABLE.queue);
    const none = { worker: '', binding: '' };
    expect(
      createProblems('queue', CREATABLE.queue, { name: 'Acme Jobs', form: queueForm, bindTo: none }, where).name,
    ).toMatch(/doesn’t look right/);
    expect(
      createProblems('queue', CREATABLE.queue, { name: 'a'.repeat(21), form: queueForm, bindTo: none }, where).name,
    ).toBe('Name is at most 20 characters.');
    expect(
      createProblems('queue', CREATABLE.queue, { name: 'acme-jobs', form: queueForm, bindTo: none }, where).name,
    ).toMatch(/acme-jobs is taken by another Queue here/);
    const fresh = createProblems('queue', CREATABLE.queue, { name: 'acme-mail', form: queueForm, bindTo: none }, where);
    expect(fresh.name).toBeNull();
    expect(fresh.worker).toMatch(/Pick what binds it/);
    expect(
      createProblems(
        'queue',
        CREATABLE.queue,
        { name: 'acme-mail', form: queueForm, bindTo: { worker: 'acme-api', binding: 'mail' } },
        where,
      ).binding,
    ).toMatch(/Capital letters/);
    expect(
      createProblems(
        'd1',
        CREATABLE.d1,
        { name: 'acme-db2', form: {}, bindTo: { worker: 'acme-api', binding: 'DB' } },
        where,
      ).binding,
    ).toBe('acme-api already has a binding called DB: pick another name.');
    // A database nothing has to bind can be added unbound.
    expect(createProblems('d1', CREATABLE.d1, { name: 'acme-db2', form: {}, bindTo: none }, where).worker).toBeNull();
    const routed = createProblems(
      'route',
      CREATABLE.route,
      { name: 'v2.acme.example/*', form: createForm(CREATABLE.route), bindTo: none },
      where,
    );
    expect(routed.fields).toEqual({ zone: 'Zone needs a value.', worker: 'Worker needs a value.' });
    expect(
      createProblems(
        'queue',
        CREATABLE.queue,
        { name: 'acme-mail', form: { ...queueForm, deliveryDelay: '-1' }, bindTo: none },
        where,
      ).fields.deliveryDelay,
    ).toBe('Delivery delay is at least 0.');
  });

  it('makes the create edit the board takes, and words it like the board', () => {
    const edit = createEdit('queue', CREATABLE.queue, {
      name: ' acme-mail ',
      form: { deliveryDelay: '30', deliveryPaused: false },
      bindTo: { worker: 'acme-api', binding: 'MAIL' },
    });
    expect(edit).toEqual({
      op: 'create',
      kind: 'queue',
      name: 'acme-mail',
      attrs: { deliveryDelay: 30, deliveryPaused: false },
      bindTo: { worker: 'acme-api', binding: 'MAIL' },
    });
    expect(createEdit('d1', CREATABLE.d1, { name: 'acme-db2', form: {}, bindTo: { worker: '', binding: '' } })).toEqual(
      {
        op: 'create',
        kind: 'd1',
        name: 'acme-db2',
        attrs: {},
      },
    );
    expect(editLines([edit], [worker])).toEqual(['+ queue acme-mail, bound to acme-api as MAIL']);
  });

  it('keeps an add, and a second add of the same name replaces the first', () => {
    const storage = memory();
    const one = createEdit('d1', CREATABLE.d1, { name: 'acme-db2', form: {}, bindTo: { worker: '', binding: '' } });
    const joined = joinEdits([one], [{ ...one, bindTo: { worker: 'acme-api', binding: 'DB2' } }]);
    expect('edits' in joined && joined.edits).toEqual([{ ...one, bindTo: { worker: 'acme-api', binding: 'DB2' } }]);
    writeEdits(1, [one], storage);
    expect(readEdits(1, storage)).toEqual([one]);
  });

  it('draws each add dashed on the map, with a line to what binds or serves it', () => {
    const { adds, relations } = createOverlay(
      [
        { op: 'create', kind: 'queue', name: 'acme-mail', attrs: {}, bindTo: { worker: 'acme-api', binding: 'MAIL' } },
        { op: 'create', kind: 'route', name: 'v2.acme.example/*', attrs: { zone: 'acme.example', worker: 'acme-api' } },
        { op: 'set', resource: worker.id, path: 'observability', value: true },
      ],
      [worker, queue],
      CREATABLE,
    );
    expect(adds.map((a) => [a.id, a.planned])).toEqual([
      ['queue:acme-mail', true],
      ['route:v2.acme.example/*', true],
    ]);
    expect(relations).toEqual([
      { from: 'worker:acme-api', to: 'queue:acme-mail', kind: 'uses' },
      { from: 'worker:acme-api', to: 'route:v2.acme.example/*', kind: 'serves' },
    ]);
  });

  describe('changing an add before it’s proposed (WEB-119)', () => {
    const db = { op: /** @type {const} */ ('create'), kind: 'd1', name: 'acme-db2', attrs: {} };
    const jobs = {
      op: /** @type {const} */ ('create'),
      kind: 'queue',
      name: 'acme-jobs',
      attrs: { deliveryDelay: 5 },
      bindTo: { worker: 'acme-api', binding: 'JOBS' },
    };
    const api2 = { op: /** @type {const} */ ('create'), kind: 'worker', name: 'acme-api2', attrs: {} };
    const creatable = {
      ...CREATABLE,
      worker: { label: 'Worker', help: 'Code.', name: { label: 'Name', help: '' }, fields: [] },
    };

    it('finds the add behind a dashed node, by the ID the board gives it', () => {
      const edits = [{ op: /** @type {const} */ ('set'), resource: worker.id, path: 'observability', value: true }, db];
      expect(createAt(edits, { kind: 'd1', name: 'acme-db2' })).toBe(1);
      expect(createAt(edits, { kind: 'queue', name: 'acme-db2' })).toBe(-1);
      expect(pendingCreates(edits)).toEqual([
        { id: 'd1:acme-db2', kind: 'd1', name: 'acme-db2', attrs: {}, planned: true },
      ]);
    });

    it('opens its form from the edit: its settings, the defaults it doesn’t give, and what binds it', () => {
      expect(createStart(CREATABLE.queue, jobs)).toEqual({
        name: 'acme-jobs',
        form: { deliveryDelay: '5', deliveryPaused: false },
        worker: 'acme-api',
        binding: 'JOBS',
      });
      expect(createStart(CREATABLE.d1, db)).toEqual({ name: 'acme-db2', form: {}, worker: '', binding: null });
    });

    it('replaces the add where it is, and what names it follows a rename', () => {
      const route = {
        op: /** @type {const} */ ('create'),
        kind: 'route',
        name: 'v2.acme.example/*',
        attrs: { zone: 'acme.example', worker: 'acme-api2' },
      };
      const bound = { ...db, bindTo: { worker: 'acme-api2', binding: 'DB2' } };
      const out = replaceCreate([api2, bound, route], 0, { ...api2, name: 'acme-edge' }, creatable);
      expect('edits' in out && out.edits).toEqual([
        { ...api2, name: 'acme-edge' },
        { ...db, bindTo: { worker: 'acme-edge', binding: 'DB2' } },
        { ...route, attrs: { zone: 'acme.example', worker: 'acme-edge' } },
      ]);
      expect(replaceCreate([db, jobs], 1, { ...jobs, kind: 'd1', name: 'acme-db2' }, creatable)).toEqual({
        error: 'Your change already adds a d1 called acme-db2: pick another name.',
      });
      expect('error' in replaceCreate([db], 3, db, creatable)).toBe(true);
    });

    it('shows the bindings its adds make as rows on the Worker’s form, as the board writes them', () => {
      expect(boundRows([db, jobs, api2], creatable, { kind: 'worker', name: 'acme-api' }, 'bindings')).toEqual([
        { name: 'JOBS', type: 'queue', queue: 'acme-jobs' },
      ]);
      const onDb = { ...db, bindTo: { worker: 'acme-api', binding: 'DB2' } };
      expect(boundRows([onDb], creatable, { kind: 'worker', name: 'acme-api' }, 'bindings')).toEqual([
        { name: 'DB2', type: 'd1', resource: 'd1:acme-db2' },
      ]);
      expect(boundRows([onDb], creatable, { kind: 'worker', name: 'acme-api' }, 'routes')).toEqual([]);
    });

    it('turns a row that binds an add into its bindTo, renamed, removed, or new, and keeps the others', () => {
      const kept = { name: 'CACHE', type: 'kv', namespace_id: 'abc' };
      const binder = { kind: 'worker', name: 'acme-api' };
      // Renamed in the form, and the D1 bound from the Worker's Bindings field like one that runs.
      const out = rebind([db, jobs], creatable, binder, 'bindings', [
        kept,
        { name: 'MAIL', type: 'queue', queue: 'acme-jobs' },
        { name: 'DB2', type: 'd1', resource: 'd1:acme-db2' },
      ]);
      expect(out).toEqual({
        rows: [kept],
        edits: [
          { ...db, bindTo: { worker: 'acme-api', binding: 'DB2' } },
          { ...jobs, bindTo: { worker: 'acme-api', binding: 'MAIL' } },
        ],
      });
      // Its row removed: the add isn't bound any more.
      expect(rebind([db, jobs], creatable, binder, 'bindings', [kept])).toEqual({
        rows: [kept],
        edits: [db, { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: { deliveryDelay: 5 } }],
      });
      // An add another Worker binds stays its, and the row stays a binding of the field.
      const other = { name: 'JOBS2', type: 'queue', queue: 'acme-jobs' };
      expect(rebind([jobs], creatable, { kind: 'worker', name: 'acme-web' }, 'bindings', [other])).toEqual({
        rows: [other],
        edits: [jobs],
      });
    });

    it('moves an add after the new Worker that binds it, so the board makes the Worker first', () => {
      const bound = { ...db, bindTo: { worker: 'acme-api2', binding: 'DB2' } };
      expect(orderCreates([bound, jobs, api2], creatable)).toEqual([jobs, api2, bound]);
      expect(orderCreates([api2, bound], creatable)).toEqual([api2, bound]);
    });
  });

  it('fills in the prompt for an agent to write the code a new resource needs', () => {
    const edit = /** @type {any} */ (
      createEdit('durable-object', CREATABLE['durable-object'], {
        name: 'acme-api_Counter',
        form: { class: 'Counter' },
        bindTo: { worker: '', binding: '' },
      })
    );
    const prompt = codePrompt({ name: 'staging', repo: 'acme/widgets' }, CREATABLE['durable-object'], edit);
    expect(prompt).toContain('acme-api_Counter, a new Durable Object in staging (acme/widgets)');
    expect(prompt).toContain('What must exist: The Worker exports the class.');
    expect(prompt).toContain('- Class: Counter');
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

  it('offers Merge for edits whose plan has no changes, and Approve once it has one (BRK-286)', () => {
    const edits = [{ op: 'set', resource: 'acme-api', path: 'bindings', value: [] }];
    expect(plansNothing({ ...change, edits, changes: 0 })).toBe(true);
    expect(cardState({ ...change, edits, changes: 0 }, { checks: 'success' })).toMatchObject({
      state: 'waiting',
      approve: false,
      merge: true,
      reject: true,
    });
    expect(cardState({ ...change, edits, changes: 2 }, { checks: 'success' })).toMatchObject({
      approve: true,
      merge: false,
    });
    // A change proposed before the board kept its plan's size asks for an approval, as it did.
    expect(cardState({ ...change, edits, changes: null }, { checks: 'success' })).toMatchObject({ approve: true });
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

  it('ends a merged change in what the compare after its merge found (WEB-110)', () => {
    const merged = { ...change, state: 'merged', updated: new Date().toISOString() };
    const outcome = (kind, plan = null, why = null) => ({ kind, plan, why, at: new Date().toISOString() });
    expect(cardState({ ...merged, outcome: outcome('nothing') })).toMatchObject({ state: 'nothing', plan: false });
    expect(cardState({ ...merged, outcome: outcome('refused', 'plan-3') })).toMatchObject({ state: 'refused' });
    expect(cardState({ ...merged, outcome: outcome('waits', null, 'staging is frozen') })).toMatchObject({
      state: 'waiting',
    });
    const waits = { ...merged, outcome: outcome('waits', 'plan-3') };
    expect(changePlanId(waits)).toBe('plan-3');
    expect(changePlanId({ ...merged, approval: { plan: 'plan-2' } })).toBe('plan-2');
    expect(changePlanId({ ...change, outcome: outcome('waits', 'plan-3') })).toBeNull();
    for (const state of ['waiting', 'applying', 'applied', 'failed', 'rolled back'])
      expect(cardState(waits, { plan: { state } })).toMatchObject({ state, plan: true });
    expect(endedWords({ n: 4, pull: { number: 253 } }, { state: 'applied' })).toBe('#253 applied');
    expect(endedWords({ n: 4, pull: null }, { state: 'nothing' })).toBe('Change 4 nothing to apply');
  });

  it('shows the card while it follows something, then folds it to a line you can dismiss (WEB-110)', () => {
    const now = Date.now();
    const iso = (/** @type {number} */ ms) => new Date(now - ms).toISOString();
    const merged = { ...change, state: 'merged', updated: iso(60_000) };
    const nothing = (/** @type {number} */ ms) => ({
      ...merged,
      outcome: { kind: 'nothing', plan: null, why: null, at: iso(ms) },
    });
    expect(changeShows({ ...change, updated: iso(3 * 3_600_000) }, { now })).toBe('card');
    expect(changeShows(nothing(60_000), { now })).toBe('card');
    expect(changeShows(nothing(FOLD_MS + 1), { now })).toBe('line');
    expect(changeShows(nothing(FOLD_MS + 1), { now, dismissed: true })).toBeNull();
    expect(changeShows(nothing(25 * 3_600_000), { now })).toBeNull();
    // A plan being applied keeps the card; once it's applied, it folds a while later.
    const planned = { ...merged, outcome: { kind: 'planned', plan: 'plan-3', why: null, at: iso(3_600_000) } };
    expect(changeShows(planned, { now, plan: { state: 'applying', updated: iso(3_600_000) } })).toBe('card');
    expect(changeShows(planned, { now, plan: { state: 'applied', updated: iso(60_000) } })).toBe('card');
    expect(changeShows(planned, { now, plan: { state: 'applied', updated: iso(FOLD_MS + 1) } })).toBe('line');
    // A merge the board hasn't compared yet never says so for long: after an hour it folds.
    expect(changeShows(merged, { now })).toBe('card');
    expect(changeShows({ ...merged, updated: iso(3_600_000 + 1) }, { now })).toBe('line');

    const storage = memory();
    expect(readDismissed(7, storage)).toBeNull();
    writeDismissed(7, 12, storage);
    expect(readDismissed(7, storage)).toBe(12);
    expect(readDismissed(8, storage)).toBeNull();
  });

  it('shows a finished change for a day', () => {
    const now = Date.now();
    expect(recentChange({ updated: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(recentChange({ updated: new Date(now - 25 * 3_600_000).toISOString() }, now)).toBe(false);
  });
});
