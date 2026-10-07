import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { creatableKinds, ProviderRegistry } from '../src/infra-provider.js';
import { cloudflare } from '../src/infra-cloudflare.js';
import { checkTemplate } from '../src/infra-templates.js';
import {
  applyEdits,
  CHANGE_MAX_EDITS,
  changeBody,
  changeBranch,
  changeSummary,
  changeTitle,
  checkChangedFile,
  checkEdits,
  desiredText,
  PREVIEWS_PER_MINUTE,
  PROPOSED_LINE,
} from '../src/infra-changes.js';
import SHIPPED from '../src/infra-shipped-templates.json';

// Changes from the console (BRK-259, docs/specs/BRK-258-plan-from-the-board.md).
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const PROVIDER = 'fakechanges';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

/** The shipped queue template, as the Worker has it. */
const queue = () => {
  const files = /** @type {Record<string, string>} */ (SHIPPED.queue);
  const checked = checkTemplate(files['template.json']);
  if (!checked.ok) throw new Error(checked.error);
  return { template: checked.template, sources: files, from: /** @type {const} */ ('breakaway') };
};
const cloudflareFile = () => ({
  version: 1,
  provider: 'cloudflare',
  resources: [
    { id: 'worker:acme-api', kind: 'worker', name: 'acme-api', attrs: { usage_model: 'standard', bindings: [] } },
    { id: 'd1:acme-db', kind: 'd1', name: 'acme-db', attrs: {} },
  ],
});

describe('a change’s edits', () => {
  it('are set, add, or remove, each checked, at most 50', () => {
    const ok = checkEdits([
      { op: 'set', resource: 'worker:acme-api', path: 'observability.enabled', value: true },
      { op: 'add', template: 'queue', inputs: { name: 'jobs' } },
      { op: 'remove', resource: 'd1:acme-db', extra: 'dropped' },
    ]);
    expect(ok).toEqual({
      ok: true,
      edits: [
        { op: 'set', resource: 'worker:acme-api', path: 'observability.enabled', value: true },
        { op: 'add', template: 'queue', inputs: { name: 'jobs' } },
        { op: 'remove', resource: 'd1:acme-db' },
      ],
    });
    const bad = (edits) => {
      const got = checkEdits(edits);
      return 'problem' in got ? got.problem : null;
    };
    expect(bad('nope')).toMatchObject({ edit: null, field: 'edits' });
    expect(bad([{ op: 'move' }])).toMatchObject({ edit: 0, field: 'op' });
    expect(bad([{ op: 'rename', resource: 'x' }])).toMatchObject({ edit: 0, field: 'name' });
    expect(bad([{ op: 'rename', resource: 'x', name: '  ' }])).toMatchObject({ field: 'name' });
    expect(bad([{ op: 'rename', resource: 'x', name: 'a\nb' }])).toMatchObject({ field: 'name' });
    expect(checkEdits([{ op: 'rename', resource: 'x', name: ' v2.acme.example/* ' }])).toEqual({
      ok: true,
      edits: [{ op: 'rename', resource: 'x', name: 'v2.acme.example/*' }],
    });
    expect(bad([{ op: 'set', resource: 'x', path: '__proto__.polluted', value: 1 }])).toMatchObject({ field: 'path' });
    expect(bad([{ op: 'set', resource: 'x', path: 'a..b', value: 1 }])).toMatchObject({ field: 'path' });
    expect(bad([{ op: 'set', resource: 'x', path: 'a' }])).toMatchObject({ field: 'value' });
    expect(
      bad([
        { op: 'remove', resource: 'x' },
        { op: 'add', template: '../x' },
      ]),
    ).toMatchObject({
      edit: 1,
      field: 'template',
    });
    expect(bad([{ op: 'add', template: 'queue', inputs: { name: 3 } }])).toMatchObject({ field: 'inputs.name' });
    expect(bad(Array.from({ length: CHANGE_MAX_EDITS + 1 }, () => ({ op: 'remove', resource: 'x' })))).toMatchObject({
      message: expect.stringMatching(/at most 50 edits/u),
    });
  });

  it('replay onto the file in order, keeping what they don’t touch, and word each one', () => {
    const file = cloudflareFile();
    const got = applyEdits({
      file,
      environment: 'acme-staging',
      templates: new Map([['queue', queue()]]),
      edits: [
        { op: 'set', resource: 'worker:acme-api', path: 'usage_model', value: 'bundled' },
        { op: 'set', resource: 'worker:acme-api', path: 'observability.enabled', value: true },
        { op: 'add', template: 'queue', inputs: { name: 'jobs', worker: 'acme-api' } },
        { op: 'remove', resource: 'd1:acme-db' },
        { op: 'set', resource: 'd1:acme-db', path: 'size', value: 'large' },
      ],
    });
    expect(got.problems).toEqual([]);
    expect(got.lines).toEqual([
      '~ acme-api: usage_model standard → bundled',
      '~ acme-api: observability.enabled → yes',
      '+ queue jobs, worker acme-api’s bindings (from queue)',
      '− d1 acme-db',
    ]);
    expect(got.dropped).toEqual([{ edit: 4, line: 'd1:acme-db is gone from the file, so setting size was dropped' }]);
    expect(got.file.resources.map((r) => r.id)).toEqual(['worker:acme-api', 'queue:jobs']);
    expect(got.file.resources[0].attrs).toEqual({
      usage_model: 'bundled',
      bindings: [{ name: 'JOBS', type: 'queue', queue_name: 'jobs' }],
      observability: { enabled: true },
    });
    expect(got.files.map((f) => f.path)).toEqual(['src/queues/jobs.js']);
    expect(got.files[0].text).toContain('env.JOBS');
    // The file passed in is never changed.
    expect(file).toEqual(cloudflareFile());
    // Key order stays: version, provider, resources.
    expect(Object.keys(got.file)).toEqual(['version', 'provider', 'resources']);
    expect(desiredText(got.file).endsWith('}\n')).toBe(true);
  });

  it('puts a setting back to the platform’s with null, and says what stops an add', () => {
    const set = applyEdits({
      file: cloudflareFile(),
      environment: 'acme-staging',
      templates: new Map(),
      edits: [{ op: 'set', resource: 'worker:acme-api', path: 'usage_model', value: null }],
    });
    expect(set.file.resources[0].attrs).toEqual({ bindings: [] });
    expect(set.lines).toEqual(['~ acme-api: usage_model standard → the platform’s']);
    const add = applyEdits({
      file: cloudflareFile(),
      environment: 'acme-staging',
      templates: new Map([['queue', queue()]]),
      edits: [
        { op: 'add', template: 'queue', inputs: { name: 'jobs' } },
        { op: 'add', template: 'queue', inputs: { name: 'jobs', worker: 'acme-nope' } },
        { op: 'add', template: 'cron', inputs: {} },
      ],
    });
    expect(add.problems).toEqual([
      { edit: 0, field: 'inputs', message: expect.stringMatching(/^give worker=/u) },
      { edit: 1, field: 'inputs', message: expect.stringMatching(/has no worker acme-nope/u) },
      { edit: 2, field: 'template', message: 'there’s no template called cron' },
    ]);
  });

  it('rename a resource whose provider declares its name, keeping its ID, and refuse what would make another', () => {
    const file = {
      ...cloudflareFile(),
      resources: [
        ...cloudflareFile().resources,
        { id: 'route:r1', kind: 'route', name: 'api.acme.example/*', attrs: { worker: 'acme-api' } },
        { id: 'route:r2', kind: 'route', name: 'www.acme.example/*', attrs: { worker: 'acme-api' } },
      ],
    };
    const pattern = { label: 'Pattern', pattern: '^\\S+$', help: 'The hostname and path, like api.acme.example/*.' };
    const names = (kind) => (kind === 'route' ? pattern : null);
    const seen = file.resources.map((r) => ({ rid: r.id, kind: r.kind, name: r.name }));
    const rename = (edits, more = {}) =>
      applyEdits({ file, environment: 'acme-staging', templates: new Map(), edits, names, seen, ...more });

    const got = rename([
      { op: 'rename', resource: 'route:r1', name: 'v2.acme.example/*' },
      { op: 'set', resource: 'route:r1', path: 'worker', value: 'acme-api' },
      { op: 'rename', resource: 'route:gone', name: 'x.acme.example/*' },
      { op: 'rename', resource: 'route:r2', name: 'www.acme.example/*' },
    ]);
    expect(got.problems).toEqual([]);
    // Setting the worker it already sends to changes nothing, so that edit is dropped.
    expect(got.lines).toEqual(['~ route api.acme.example/*: pattern → v2.acme.example/*']);
    expect(got.dropped).toEqual([
      { edit: 1, line: 'v2.acme.example/*’s worker is already acme-api, so that edit changes nothing' },
      { edit: 2, line: 'route:gone is gone from the file, so renaming it was dropped' },
    ]);
    expect(got.file.resources[2]).toEqual({
      id: 'route:r1',
      kind: 'route',
      name: 'v2.acme.example/*',
      attrs: { worker: 'acme-api' },
    });
    expect(got.touched.get('route:r1')).toBe(0);
    expect(file.resources[2].name).toBe('api.acme.example/*');

    expect(
      rename([
        { op: 'rename', resource: 'worker:acme-api', name: 'acme-web' },
        { op: 'rename', resource: 'route:r1', name: 'has space/*' },
        { op: 'rename', resource: 'route:r1', name: 'www.acme.example/*' },
      ]).problems,
    ).toEqual([
      { edit: 0, field: 'name', message: 'a worker’s name can’t be changed from the board' },
      {
        edit: 1,
        field: 'name',
        message: 'has space/* isn’t a pattern: The hostname and path, like api.acme.example/*.',
      },
      { edit: 2, field: 'name', message: 'another route already has the pattern www.acme.example/*' },
    ]);
    // Without the provider's word, nothing is renamed.
    expect(
      rename([{ op: 'rename', resource: 'route:r1', name: 'v2.acme.example/*' }], { names: undefined }).problems,
    ).toEqual([{ edit: 0, field: 'name', message: 'a route’s name can’t be changed from the board' }]);
    // A route the file names by a made-up ID is matched by its pattern: renaming it would make another.
    const byName = rename([{ op: 'rename', resource: 'route:r1', name: 'v2.acme.example/*' }], {
      seen: [{ rid: 'route:cf-1', kind: 'route', name: 'api.acme.example/*' }],
    });
    expect(byName.problems).toEqual([
      {
        edit: 0,
        field: 'name',
        message:
          'route:r1 isn’t the ID the board sees for api.acme.example/* (route:cf-1), so a new pattern would make another route: give it that ID in the file first',
      },
    ]);
  });

  it('create a resource the provider declares creatable, with its defaults, bound to a Worker in one edit', () => {
    const kinds = creatableKinds(cloudflare);
    const seen = [
      { rid: 'worker:acme-api', kind: 'worker', name: 'acme-api', attrs: '{"bindings":[]}' },
      { rid: 'queue:q-1', kind: 'queue', name: 'acme-running', attrs: '{}' },
    ];
    const create = (edits, more = {}) =>
      applyEdits({
        file: cloudflareFile(),
        environment: 'acme-staging',
        templates: new Map(),
        edits,
        seen,
        creatable: (kind) => kinds[kind] ?? null,
        ...more,
      });

    expect(
      checkEdits([
        {
          op: 'create',
          kind: 'queue',
          name: ' acme-jobs ',
          attrs: { retention: 86_400 },
          bindTo: { worker: 'acme-api', binding: 'JOBS' },
        },
      ]),
    ).toEqual({
      ok: true,
      edits: [
        {
          op: 'create',
          kind: 'queue',
          name: 'acme-jobs',
          attrs: { retention: 86_400 },
          bindTo: { worker: 'acme-api', binding: 'JOBS' },
        },
      ],
    });
    expect(checkEdits([{ op: 'create', kind: 'Queue', name: 'x' }])).toMatchObject({ problem: { field: 'kind' } });
    expect(
      checkEdits([{ op: 'create', kind: 'queue', name: 'x', bindTo: { worker: 'acme-api', binding: 'jobs' } }]),
    ).toMatchObject({ problem: { field: 'bindTo.binding' } });
    expect(checkEdits([{ op: 'create', kind: 'queue', name: 'x', attrs: { __proto__x: 1, 'a..b': 1 } }])).toMatchObject(
      { problem: { field: 'attrs.a..b' } },
    );

    const got = create([
      {
        op: 'create',
        kind: 'queue',
        name: 'acme-jobs',
        attrs: { retention: 86_400 },
        bindTo: { worker: 'acme-api', binding: 'JOBS' },
      },
    ]);
    expect(got.problems).toEqual([]);
    expect(got.lines).toEqual(['+ queue acme-jobs, bound to acme-api as JOBS']);
    expect(got.file.resources.at(-1)).toEqual({
      id: 'queue:acme-jobs',
      kind: 'queue',
      name: 'acme-jobs',
      attrs: { deliveryDelay: 0, deliveryPaused: false, retention: 86_400 },
    });
    expect(got.file.resources[0].attrs.bindings).toEqual([
      { name: 'JOBS', type: 'queue', resource: 'queue:acme-jobs' },
    ]);
    expect(got.touched.get('queue:acme-jobs')).toBe(0);
    expect(got.touched.get('worker:acme-api')).toBe(0);
    expect(cloudflareFile().resources[0].attrs.bindings).toEqual([]);

    // A Worker whose file doesn't list its bindings starts from the ones it runs with.
    const unlisted = cloudflareFile();
    delete unlisted.resources[0].attrs.bindings;
    const kept = create(
      [{ op: 'create', kind: 'd1', name: 'acme-db-2', bindTo: { worker: 'acme-api', binding: 'DB2' } }],
      {
        file: unlisted,
        seen: [
          {
            ...seen[0],
            attrs: '{"bindings":[{"name":"DB","type":"d1","id":"d1-uuid"},{"name":"KEY","type":"secret_text"}]}',
          },
        ],
      },
    );
    expect(kept.file.resources[0].attrs.bindings).toEqual([
      { name: 'DB', type: 'd1', id: 'd1-uuid' },
      { name: 'KEY', type: 'secret_text' },
      { name: 'DB2', type: 'd1', resource: 'd1:acme-db-2' },
    ]);

    const bind = { worker: 'acme-api', binding: 'JOBS' };
    expect(
      create([
        { op: 'create', kind: 'queue', name: 'Acme_Jobs', attrs: {}, bindTo: bind },
        { op: 'create', kind: 'd1', name: 'acme-db', attrs: {}, bindTo: bind },
        { op: 'create', kind: 'queue', name: 'acme-running', attrs: {}, bindTo: bind },
        { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: {} },
        { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: { retention: 5 }, bindTo: bind },
        { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: { size: 'large' }, bindTo: bind },
        { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: {}, bindTo: { ...bind, worker: 'acme-web' } },
        { op: 'create', kind: 'route', name: 'api.acme.example/*', attrs: { worker: 'acme-api' } },
        { op: 'create', kind: 'route', name: 'api.acme.example/*', attrs: { zone: 'acme.example', worker: 'acme-x' } },
        { op: 'create', kind: 'gadget', name: 'acme-g', attrs: {} },
      ]).problems,
    ).toEqual([
      {
        edit: 0,
        field: 'name',
        message:
          'Acme_Jobs isn’t a queue’s name: Lowercase letters, digits, and dashes, up to 63, unique in the account, like acme-jobs.',
      },
      { edit: 1, field: 'name', message: 'acme-staging already has a d1 database called acme-db: pick another name' },
      {
        edit: 2,
        field: 'name',
        message:
          'a queue called acme-running already runs in acme-staging: pick another name, or describe the one that runs as code first',
      },
      {
        edit: 3,
        field: 'bindTo',
        message: 'a new queue is made only when a worker binds it: say which, and what it calls it',
      },
      { edit: 4, field: 'attrs.retention', message: 'Retention is at least 60 seconds' },
      { edit: 5, field: 'attrs.size', message: 'a new queue has no setting size' },
      { edit: 6, field: 'bindTo.worker', message: 'acme-staging has no worker called acme-web in its file' },
      {
        edit: 7,
        field: 'attrs.zone',
        message:
          'a new route needs its zone: The domain on Cloudflare it’s on, like acme.example: one the environment’s token reaches.',
      },
      { edit: 8, field: 'attrs.worker', message: 'acme-staging has no worker called acme-x in its file' },
      { edit: 9, field: 'kind', message: 'a gadget can’t be added from the board' },
    ]);
    // Two in a row: the second sees the first's name and binding.
    expect(
      create([
        { op: 'create', kind: 'queue', name: 'acme-jobs', attrs: {}, bindTo: bind },
        { op: 'create', kind: 'kv', name: 'acme-flags', attrs: {}, bindTo: bind },
      ]).problems,
    ).toEqual([
      { edit: 1, field: 'bindTo.binding', message: 'acme-api already has a binding called JOBS: pick another name' },
    ]);
    // Without the provider's word, nothing is created.
    expect(
      create([{ op: 'create', kind: 'queue', name: 'acme-jobs', attrs: {}, bindTo: bind }], { creatable: undefined })
        .problems,
    ).toEqual([{ edit: 0, field: 'kind', message: 'a queue can’t be added from the board' }]);
  });

  it('put a problem in the file on the edit that touched its resource', () => {
    const made = applyEdits({
      file: cloudflareFile(),
      environment: 'acme-staging',
      templates: new Map(),
      edits: [
        { op: 'set', resource: 'd1:acme-db', path: 'size', value: 'large' },
        { op: 'set', resource: 'worker:acme-api', path: 'token', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      ],
    });
    const checked = checkChangedFile(desiredText(made.file), { touched: made.touched, file: made.file });
    expect(checked).toMatchObject({ ok: false, problem: { edit: 1, field: 'resources[0].attrs.token' } });
  });

  it('become a pull request titled for the environment, closing no task', () => {
    expect(changeBranch('acme-staging', 4)).toBe('breakaway/infra/acme-staging-4');
    expect(changeSummary(['~ acme-api: usage_model standard → bundled'])).toBe(
      'acme-api: usage_model standard → bundled',
    );
    expect(changeTitle('acme-staging', ['+ queue jobs (from queue)', '− d1 acme-db'])).toBe(
      'Change acme-staging: queue jobs (from queue), and 1 more',
    );
    const text = changeBody({
      environment: 'acme-staging',
      lines: ['− d1 acme-db'],
      dropped: [{ line: 'x is gone from the file, so setting y was dropped' }],
      files: ['src/queues/jobs.js'],
      preview: {
        changes: 1,
        cost: { delta: -2, currency: 'USD', complete: true },
        reversible: false,
        policy: { outcome: 'needs-owner', policy: 'default' },
      },
      page: 'https://board.acme.example/#/infrastructure/3',
    });
    expect(text).toContain('- − d1 acme-db');
    expect(text).toContain('- `src/queues/jobs.js`');
    expect(text).toContain('Dropped: x is gone from the file, so setting y was dropped.');
    expect(text).toContain('**The plan:** 1 change · saves $2 a month · can’t all be undone.');
    expect(text).toContain('**Policy:** Waits for you, by the default policy.');
    expect(text).toContain(PROPOSED_LINE);
    expect(text).not.toMatch(/Closes|Fixes/u);
  });
});

// A pretend GitHub for acme/widgets: the default branch, files at its head, and what the board writes.
const gh = {
  /** @type {Record<string, string>} */ files: {},
  head: 'head-1',
  /** @type {Record<string, any>} */ pulls: {},
  /** @type {Array<{ method: string, path: string, body: any }>} */ writes: [],
  /** @type {string[]} */ reads: [],
  refuse: false,
  branches: new Set(),
};

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const method = init.method ?? 'GET';
    const local = path.replace('/repos/acme/widgets', '');
    if (method === 'GET') {
      gh.reads.push(local);
      if (local === '/git/ref/heads/main') return reply({ object: { sha: gh.head } });
      if (local === `/git/commits/${gh.head}`) return reply({ sha: gh.head, tree: { sha: `tree-${gh.head}` } });
      const pull = /^\/pulls\/(\d+)$/u.exec(local);
      if (pull) return gh.pulls[pull[1]] ? reply(gh.pulls[pull[1]]) : reply({ message: 'Not Found' }, 404);
      const file = /^\/contents\/(.+)$/u.exec(local);
      if (file) {
        const name = decodeURIComponent(file[1]);
        if (name in gh.files) {
          const text = gh.files[name];
          return reply({ type: 'file', size: encoder.encode(text).length, encoding: 'base64', content: b64(text) });
        }
        const inside = Object.keys(gh.files).filter((f) => f.startsWith(`${name}/`));
        if (inside.length)
          return reply(
            [...new Set(inside.map((f) => f.slice(name.length + 1).split('/')[0]))].map((n) => ({
              name: n,
              type: inside.includes(`${name}/${n}`) ? 'file' : 'dir',
            })),
          );
      }
      return reply({ message: 'Not Found' }, 404);
    }
    const sent = init.body ? JSON.parse(init.body) : null;
    gh.writes.push({ method, path: local, body: sent });
    if (gh.refuse) return reply({ message: 'Resource not accessible by integration' }, 403);
    if (method === 'POST' && local === '/git/trees') return reply({ sha: `tree-new-${gh.writes.length}` }, 201);
    if (method === 'POST' && local === '/git/commits') return reply({ sha: `commit-${gh.writes.length}` }, 201);
    if (method === 'POST' && local === '/git/refs') {
      const branch = sent.ref.replace(/^refs\/heads\//u, '');
      if (gh.branches.has(branch)) return reply({ message: 'Reference already exists' }, 422);
      gh.branches.add(branch);
      return reply({ ref: sent.ref }, 201);
    }
    if (method === 'PATCH' && local.startsWith('/git/refs/heads/')) return reply({ object: { sha: sent.sha } });
    if (method === 'DELETE' && local.startsWith('/git/refs/heads/')) return new Response(null, { status: 204 });
    if (method === 'POST' && local === '/pulls') {
      const number = 300 + Object.keys(gh.pulls).length;
      const commit = [...gh.writes].reverse().find((w) => w.path === '/git/commits');
      gh.pulls[number] = {
        number,
        state: 'open',
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        head: { ref: sent.head, sha: `commit-${gh.writes.indexOf(commit) + 1}` },
      };
      return reply(gh.pulls[number], 201);
    }
    const patch = /^\/pulls\/(\d+)$/u.exec(local);
    if (method === 'PATCH' && patch) {
      Object.assign(gh.pulls[patch[1]], sent);
      return reply(gh.pulls[patch[1]]);
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('changes from the console', () => {
  let cookie;
  let provider;
  let spy;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const change = (environment, b) => board(`infra/environments/${environment}/changes`, { method: 'POST', body: b });
  /** The file on the default branch, as the sync keeps it and as GitHub has it. */
  const fileOf = (patch = {}) => ({
    version: 1,
    provider: PROVIDER,
    resources: provider.state.resources
      .filter((r) => patch[r.id] !== null)
      .map((r) => ({ ...structuredClone(r), ...(patch[r.id] ?? {}) })),
  });
  const want = (name, file, sha) =>
    inStore((s) => {
      s.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        `${name}.json`,
        name,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify({ resources: file.resources }),
        sha,
        Date.now(),
      );
    });
  const kept = () =>
    inStore((s) => ({
      plans: Number(s.sql.exec('SELECT COUNT(*) AS n FROM infra_plans').toArray()[0].n),
      audit: s.sql.exec("SELECT outcome, summary, by FROM infra_audit WHERE kind = 'change' ORDER BY id").toArray(),
    }));

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    for (const [name, extra] of [
      ['chg-staging', {}],
      ['chg-fresh', {}],
      ['chg-watched', { observeOnly: true }],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind: 'staging', target: 'svc-api', ...extra },
        }),
      );
      envs[name] = made.environment;
    }
    provider = fakeProvider({ id: PROVIDER });
    await inStore(async (s) => {
      s.infraProviders = new ProviderRegistry();
      s.infraProviders.register(provider);
      await s.refreshInventory(PROVIDER);
    });
    await want('chg-staging', fileOf(), 'head-1');
  });
  beforeEach(async () => {
    spy = mockGitHub();
    Object.assign(gh, { files: {}, head: 'head-1', writes: [], reads: [], refuse: false });
    gh.files['.github/breakaway-infra/chg-staging.json'] = JSON.stringify(fileOf(), null, 4);
    await inStore((s) => {
      s.infraChangePreviews = new Map();
      s.infraChangeCache = new Map();
      s.infraTemplateCache = new Map();
    });
  });
  afterEach(async () => {
    spy.mockRestore();
    // Proposing asks for a sync: none runs here, so nothing reaches GitHub.
    await inStore((s) => s.ctx.storage.deleteAlarm());
  });

  it('previews the plan the edits make, with its digest and policy, writing nothing', async () => {
    const before = await kept();
    const res = await body(
      await change(envs['chg-staging'].id, {
        edits: [
          { op: 'set', resource: 'svc-api', path: 'instances', value: 4 },
          { op: 'remove', resource: 'db-gone' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(res).toMatchObject({
      head: 'head-1',
      from: 'file',
      lines: ['~ api: instances 2 → 4'],
      dropped: [{ edit: 1, line: 'db-gone is already gone from the file, so removing it was dropped' }],
      files: [],
      preview: {
        environment: { id: envs['chg-staging'].id, name: 'chg-staging' },
        changes: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        policy: { outcome: 'needs-owner' },
      },
    });
    expect(await kept()).toEqual(before);
    expect(gh.writes).toEqual([]);
  });

  it('changes a route’s name where the provider declares it, planning an update of the same route', async () => {
    const edits = [{ op: 'rename', resource: 'route-api', name: 'v2.acme.example' }];
    const res = await body(await change(envs['chg-staging'].id, { edits }));
    expect(res).toMatchObject({ status: 200, lines: ['~ route api.acme.example: hostname → v2.acme.example'] });
    expect(res.preview.changes).toBe(1);
    expect(res.preview.diff.changes).toEqual([
      expect.objectContaining({ op: 'update', resource: 'route-api', name: 'v2.acme.example' }),
    ]);
    const service = await body(
      await change(envs['chg-staging'].id, { edits: [{ op: 'rename', resource: 'svc-api', name: 'api-2' }] }),
    );
    expect(service).toMatchObject({
      status: 422,
      problems: [{ edit: 0, field: 'name', message: 'a service’s name can’t be changed from the board' }],
    });

    const proposed = await body(await change(envs['chg-staging'].id, { edits, propose: true }));
    expect(proposed.status).toBe(201);
    const tree = gh.writes.find((w) => w.path === '/git/trees');
    expect(JSON.parse(tree.body.tree[0].content).resources.find((r) => r.id === 'route-api').name).toBe(
      'v2.acme.example',
    );
    expect(
      (await body(await board(`infra/changes/${proposed.change.n}/reject`, { method: 'POST', body: {} }))).status,
    ).toBe(200);
  });

  it('creates a resource the provider declares, bound in the same change, and previews it as an add', async () => {
    const edits = [
      {
        op: 'create',
        kind: 'database',
        name: 'acme-jobs',
        attrs: { engine: 'sqlite' },
        bindTo: { worker: 'api', binding: 'JOBS_DB' },
      },
    ];
    const res = await body(await change(envs['chg-staging'].id, { edits }));
    expect(res).toMatchObject({ status: 200, lines: ['+ database acme-jobs, bound to api as JOBS_DB'] });
    expect(res.preview.diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'create', resource: 'database:acme-jobs', name: 'acme-jobs', reversible: true }),
        expect.objectContaining({ op: 'update', resource: 'svc-api' }),
      ]),
    );
    expect(res.preview.diff.changes.find((c) => c.op === 'create').after).toEqual({ engine: 'sqlite', size: 'small' });
    expect(res.preview.reversible).toBe(true);
    expect(gh.writes).toEqual([]);

    const wrong = await body(
      await change(envs['chg-staging'].id, {
        edits: [
          { op: 'create', kind: 'route', name: 'v3.acme.example', attrs: {} },
          { op: 'create', kind: 'database', name: 'main', attrs: {}, bindTo: { worker: 'api', binding: 'MAIN' } },
        ],
      }),
    );
    expect(wrong).toMatchObject({
      status: 422,
      problems: [
        { edit: 0, field: 'kind', message: 'a route can’t be added from the board' },
        { edit: 1, field: 'name', message: 'chg-staging already has a database called main: pick another name' },
      ],
    });
  });

  it('is the owner’s alone: the bearer token and an agent’s by are refused, and observe only says so', async () => {
    const edits = [{ op: 'set', resource: 'svc-api', path: 'instances', value: 3 }];
    const agent = await body(
      await api(`infra/environments/${envs['chg-staging'].id}/changes`, { method: 'POST', body: { edits } }),
    );
    expect(agent.status).toBe(403);
    const named = await body(await change(envs['chg-staging'].id, { edits, by: 'claude-x' }));
    expect(named.status).toBe(403);
    const reject = await body(await api('infra/changes/1/reject', { method: 'POST', body: {} }));
    expect(reject.status).toBe(403);
    const watched = await body(await change(envs['chg-watched'].id, { edits }));
    expect(watched).toMatchObject({ status: 409, error: 'Observe only: the board watches it and never changes it.' });
    // Reading is anyone's.
    expect((await api(`infra/environments/${envs['chg-staging'].id}/changes`)).status).toBe(200);
  });

  it('puts a problem on its edit, and plans an environment at most 6 times a minute', async () => {
    const bad = await body(
      await change(envs['chg-staging'].id, { edits: [{ op: 'add', template: 'nothing-here', inputs: {} }] }),
    );
    expect(bad).toMatchObject({
      status: 422,
      problems: [{ edit: 0, field: 'template', message: 'there’s no template called nothing-here' }],
    });
    for (let n = 0; n < PREVIEWS_PER_MINUTE; n += 1) {
      const edits = [{ op: 'set', resource: 'svc-api', path: 'instances', value: 10 + n }];
      expect((await change(envs['chg-staging'].id, { edits })).status).toBe(200);
      // The same edits on the same head come from the cache.
      expect((await change(envs['chg-staging'].id, { edits })).status).toBe(200);
    }
    const over = await body(
      await change(envs['chg-staging'].id, {
        edits: [{ op: 'set', resource: 'svc-api', path: 'instances', value: 99 }],
      }),
    );
    expect(over).toMatchObject({ status: 429, retryAfter: expect.any(Number) });
  });

  it('proposes as a pull request on the board’s branch, replaces it, and rejects it', async () => {
    const edits = [{ op: 'set', resource: 'svc-api', path: 'instances', value: 5 }];
    const proposed = await body(await change(envs['chg-staging'].id, { edits, propose: true }));
    expect(proposed.status).toBe(201);
    const { change: made } = proposed;
    expect(made).toMatchObject({
      repo: 'widgets',
      environment: { id: envs['chg-staging'].id, name: 'chg-staging' },
      lines: ['~ api: instances 2 → 5'],
      head: 'head-1',
      branch: `breakaway/infra/chg-staging-${made.n}`,
      state: 'open',
      digest: proposed.preview.digest,
      policy: { outcome: 'needs-owner' },
    });
    // One commit on the default branch's head: the file reformatted with two spaces, and the edit.
    const tree = gh.writes.find((w) => w.path === '/git/trees');
    expect(tree.body.base_tree).toBe('tree-head-1');
    expect(tree.body.tree).toHaveLength(1);
    expect(tree.body.tree[0].path).toBe('.github/breakaway-infra/chg-staging.json');
    expect(tree.body.tree[0].content).toBe(
      `${JSON.stringify(fileOf({ 'svc-api': { attrs: { instances: 5, version: '1.0.0' } } }), null, 2)}\n`,
    );
    const commit = gh.writes.find((w) => w.path === '/git/commits');
    expect(commit.body).toMatchObject({ message: 'chg-staging: api: instances 2 → 5', parents: ['head-1'] });
    expect(gh.writes.find((w) => w.path === '/git/refs').body.ref).toBe(`refs/heads/${made.branch}`);
    const pull = gh.writes.find((w) => w.path === '/pulls');
    expect(pull.body).toMatchObject({
      title: 'Change chg-staging: api: instances 2 → 5',
      head: made.branch,
      base: 'main',
    });
    expect(pull.body.body).toContain(PROPOSED_LINE);
    expect(pull.body.body).not.toMatch(/Closes/u);
    expect(made.pull.number).toBe(Number(Object.keys(gh.pulls).at(-1)));
    // Nothing is written to the default branch, and the board asks for a sync so the plan check posts.
    expect(gh.writes.some((w) => w.path.includes('/contents/'))).toBe(false);
    expect(await inStore((s) => JSON.parse(s.meta('gh_dirty') ?? '[]'))).toContain('widgets');

    const listed = await body(await board(`infra/environments/${envs['chg-staging'].id}/changes`));
    expect(listed.open.n).toBe(made.n);
    // The pull request page finds the change by its pull request (WEB-105), with its environment's freeze.
    const byPull = await body(await board(`infra/changes?repo=widgets&pull=${made.pull.number}`));
    expect(byPull).toMatchObject({
      status: 200,
      change: { n: made.n, state: 'open' },
      environment: { id: envs['chg-staging'].id, name: 'chg-staging', frozen: false },
    });
    expect(await body(await board(`infra/changes?repo=widgets&pull=999999`))).toMatchObject({
      status: 200,
      change: null,
      environment: null,
    });
    expect(await body(await board(`infra/changes?repo=other&pull=${made.pull.number}`))).toMatchObject({
      change: null,
    });
    expect((await body(await board('infra/changes?repo=widgets&pull=nope'))).status).toBe(400);

    // Proposing again while it's open replaces its commit on the same branch, and its pull request.
    gh.writes = [];
    const again = await body(
      await change(envs['chg-staging'].id, {
        edits: [...edits, { op: 'remove', resource: 'route-api' }],
        propose: true,
      }),
    );
    expect(again.status).toBe(200);
    expect(again.change).toMatchObject({
      n: made.n,
      branch: made.branch,
      lines: ['~ api: instances 2 → 5', '− route api.acme.example'],
    });
    const moved = gh.writes.find((w) => w.method === 'PATCH' && w.path.startsWith('/git/refs/heads/'));
    expect(moved.path).toBe(`/git/refs/heads/${made.branch.split('/').map(encodeURIComponent).join('/')}`);
    expect(moved.body.force).toBe(true);
    expect(gh.writes.find((w) => w.path === `/pulls/${made.pull.number}`).body.title).toBe(
      'Change chg-staging: api: instances 2 → 5, and 1 more',
    );
    gh.pulls[made.pull.number].head.sha = again.change.commit;

    const rejected = await body(await board(`infra/changes/${made.n}/reject`, { method: 'POST', body: {} }));
    expect(rejected).toMatchObject({ status: 200, change: { state: 'rejected', why: 'rejected by the owner' } });
    expect(gh.pulls[made.pull.number].state).toBe('closed');
    expect(gh.writes.some((w) => w.method === 'DELETE')).toBe(true);
    expect((await body(await board(`infra/changes/${made.n}/reject`, { method: 'POST', body: {} }))).status).toBe(409);

    const audit = (await kept()).audit.slice(-3);
    expect(audit.map((a) => a.outcome)).toEqual(['proposed', 'replaced', 'rejected']);
    expect(audit.every((a) => a.by === 'owner')).toBe(true);
  });

  it('stops being the board’s when someone else pushes, or it closes or merges on GitHub', async () => {
    const proposed = await body(
      await change(envs['chg-staging'].id, {
        edits: [{ op: 'set', resource: 'db-main', path: 'size', value: 'large' }],
        propose: true,
      }),
    );
    const { n, pull } = proposed.change;
    await inStore((s) =>
      s.followInfraChanges('widgets', [{ number: pull.number, state: 'open', head: { sha: proposed.change.commit } }]),
    );
    expect((await body(await board(`infra/changes/${n}`))).change.state).toBe('open');
    await inStore((s) =>
      s.followInfraChanges('widgets', [{ number: pull.number, state: 'open', head: { sha: 'someone-else' } }]),
    );
    const taken = (await body(await board(`infra/changes/${n}`))).change;
    expect(taken).toMatchObject({ state: 'taken over', why: 'someone else pushed to its branch' });
    expect((await kept()).audit.at(-1)).toMatchObject({ outcome: 'taken over', by: 'board' });
    // A new change can open now: the taken-over one isn't the board's.
    const next = await body(
      await change(envs['chg-staging'].id, {
        edits: [{ op: 'set', resource: 'db-main', path: 'size', value: 'medium' }],
        propose: true,
      }),
    );
    expect(next.status).toBe(201);
    expect(next.change.n).not.toBe(n);
    await inStore((s) =>
      s.followInfraChanges('widgets', [
        { number: next.change.pull.number, state: 'closed', merged_at: new Date().toISOString(), head: { sha: 'x' } },
      ]),
    );
    expect((await body(await board(`infra/changes/${next.change.n}`))).change.state).toBe('merged');
  });

  it('describes an environment with no file from the board’s draft, and adds from the repository’s template', async () => {
    gh.files['.github/breakaway-infra/templates/cache/template.json'] = JSON.stringify({
      version: 1,
      title: 'A cache database',
      provider: PROVIDER,
      inputs: { name: { help: 'its name, like cache' } },
      resources: [{ id: 'db-{{name}}', kind: 'database', name: '{{name}}', attrs: { size: 'small' } }],
      files: [{ from: 'client.js.tmpl', to: 'src/db/{{name}}.js' }],
    });
    gh.files['.github/breakaway-infra/templates/cache/client.js.tmpl'] = '// the {{name}} database\n';
    const listed = await body(await board(`infra/environments/${envs['chg-fresh'].id}/templates`));
    expect(listed.templates.map((t) => [t.name, t.from])).toEqual([
      ['cache', 'repository'],
      ['queue', 'breakaway'],
    ]);

    const res = await body(
      await change(envs['chg-fresh'].id, {
        edits: [{ op: 'add', template: 'cache', inputs: { name: 'acme-cache' } }],
        propose: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.change.lines).toEqual(['+ database acme-cache (from cache)']);
    const tree = gh.writes.find((w) => w.path === '/git/trees').body.tree;
    expect(tree.map((t) => t.path)).toEqual(['.github/breakaway-infra/chg-fresh.json', 'src/db/acme-cache.js']);
    expect(JSON.parse(tree[0].content).resources.map((r) => r.id)).toContain('db-acme-cache');
    expect(tree[1].content).toBe('// the acme-cache database\n');
    const pull = gh.writes.find((w) => w.path === '/pulls').body;
    expect(pull.body).toMatch(/^Describes chg-fresh as code/u);
    // Rejecting it leaves nothing open.
    await board(`infra/changes/${res.change.n}/reject`, { method: 'POST', body: {} });
  });

  it('never moves a branch it didn’t make for the change: it takes the next number', async () => {
    const next = await inStore((s) => Number(s.meta('infra_change_seq') ?? 0) + 1);
    gh.branches.add(changeBranch('chg-staging', next));
    gh.branches.add(changeBranch('chg-staging', next + 1));
    const edits = [{ op: 'set', resource: 'svc-api', path: 'instances', value: 7 }];
    const res = await body(await change(envs['chg-staging'].id, { edits, propose: true }));
    expect(res.status).toBe(201);
    expect(res.change).toMatchObject({ n: next + 2, branch: changeBranch('chg-staging', next + 2) });
    expect(gh.writes.some((w) => w.method === 'PATCH' && w.path.startsWith('/git/refs/'))).toBe(false);
    await board(`infra/changes/${res.change.n}/reject`, { method: 'POST', body: {} });

    // Every name it tries is taken: it says so, and moves none of them.
    gh.writes = [];
    const at = await inStore((s) => Number(s.meta('infra_change_seq')) + 1);
    for (let k = 0; k < 3; k += 1) gh.branches.add(changeBranch('chg-staging', at + k));
    const taken = await body(await change(envs['chg-staging'].id, { edits, propose: true }));
    expect(taken).toMatchObject({
      status: 409,
      error: expect.stringMatching(/the board didn’t make for this change/u),
    });
    expect(gh.writes.some((w) => w.method === 'PATCH' || w.path === '/pulls')).toBe(false);
  });

  it('says what GitHub refused, keeping nothing', async () => {
    gh.refuse = true;
    const before = await kept();
    const res = await body(
      await change(envs['chg-staging'].id, {
        edits: [{ op: 'set', resource: 'svc-api', path: 'version', value: '2.0.0' }],
        propose: true,
      }),
    );
    expect(res).toMatchObject({
      status: 502,
      github: 403,
      error: expect.stringMatching(/^GitHub refused chg-staging’s change/u),
    });
    expect((await kept()).audit).toEqual(before.audit);
  });
});
