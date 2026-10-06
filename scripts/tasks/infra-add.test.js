import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInfraFolder } from '../../src/infra-check.js';
import { checkDesiredFile } from '../../src/infra-desired.js';
import { addFromTemplate, checkTemplate, fillIn, inputValues } from '../../src/infra-templates.js';
import { infraAdd } from './infra-add.js';
import { readInfraFolder } from './infra-check.js';

const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
const DIR = '.github/breakaway-infra';

const STAGING = `{
  "version": 1,
  "provider": "cloudflare",
  "resources": [
    {
      "id": "worker:api",
      "kind": "worker",
      "name": "api",
      "attrs": { "bindings": [{ "name": "DB", "type": "d1" }] }
    }
  ]
}
`;

/** A template, as an owner would write one, with its overrides. */
const template = (fields = {}) =>
  JSON.stringify({
    version: 1,
    title: 'A cache',
    provider: 'cloudflare',
    inputs: { name: { help: 'the namespace’s title', pattern: '^[a-z][a-z0-9-]*$' } },
    resources: [{ id: 'kv:{{name}}', kind: 'kv', name: '{{name}}' }],
    ...fields,
  });

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'infra-add-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (path) => readFileSync(join(root, path), 'utf8');

describe('checkTemplate (CLI-15)', () => {
  it('takes the shipped example', () => {
    const shipped = readFileSync(
      new URL('../../template/infra/templates/queue/template.json', import.meta.url),
      'utf8',
    );
    const checked = checkTemplate(shipped);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(Object.keys(checked.template.inputs)).toEqual(['name', 'worker', 'binding']);
  });

  it('says what is wrong, in words', () => {
    expect(checkTemplate('{').ok).toBe(false);
    expect(checkTemplate(template({ version: 2 }))).toEqual({ ok: false, error: 'version is 1: add "version": 1' });
    expect(checkTemplate(template({ extra: 1 }))).toMatchObject({ error: expect.stringContaining('“extra”') });
    expect(checkTemplate(template({ title: '' }))).toMatchObject({ error: expect.stringContaining('title') });
    expect(checkTemplate(template({ inputs: {} }))).toMatchObject({
      error: '{{name}} isn’t one of its inputs: add it to inputs',
    });
    expect(checkTemplate(template({ resources: [] }))).toMatchObject({
      error: expect.stringContaining('adds something'),
    });
    expect(
      checkTemplate(template({ resources: [{ id: 'kv:{{name|lower}}', kind: 'kv', name: '{{name}}' }] })),
    ).toMatchObject({ error: expect.stringContaining('|upper') });
    expect(checkTemplate(template({ files: [{ from: '../secret', to: 'x.js' }] }))).toMatchObject({
      error: expect.stringContaining('files[0].from'),
    });
  });
});

describe('inputValues and fillIn', () => {
  const t = /** @type {any} */ (
    checkTemplate(
      template({
        inputs: {
          name: { help: 'a name', pattern: '^[a-z-]+$' },
          binding: { help: 'a binding', default: '{{name|upper}}' },
        },
      }),
    )
  ).template;

  it('fills in defaults from what was given, and checks each value', () => {
    expect(inputValues(t, { name: 'hot-cache' })).toEqual({
      ok: true,
      values: { name: 'hot-cache', binding: 'HOT_CACHE' },
    });
    expect(inputValues(t, { name: 'x', binding: 'KV' })).toEqual({ ok: true, values: { name: 'x', binding: 'KV' } });
    expect(inputValues(t, {})).toMatchObject({ ok: false, error: 'give name=<a name>' });
    expect(inputValues(t, { name: 'x', nmae: 'y' })).toMatchObject({ error: expect.stringContaining('nmae') });
    expect(inputValues(t, { name: 'Bad' })).toMatchObject({ ok: false, error: expect.stringContaining('^[a-z-]+$') });
  });

  it('never takes a value that could be a path or break out of a string, whatever the pattern', () => {
    const loose = /** @type {any} */ (checkTemplate(template({ inputs: { name: { help: 'any', pattern: '.*' } } })))
      .template;
    for (const name of ['../up', 'a/b', 'a"b', '{{x}}', '']) expect(inputValues(loose, { name }).ok, name).toBe(false);
  });

  it('puts values in strings and keys, never changing the shape', () => {
    expect(fillIn({ '{{a}}': ['x-{{a|upper}}', 1, null] }, { a: 'q-1' })).toEqual({ 'q-1': ['x-Q_1', 1, null] });
  });
});

describe('addFromTemplate', () => {
  const queue = /** @type {any} */ (
    checkTemplate(readFileSync(new URL('../../template/infra/templates/queue/template.json', import.meta.url), 'utf8'))
  ).template;
  const values = { name: 'jobs', worker: 'api', binding: 'JOBS' };
  const sources = { 'send.js.tmpl': 'env.{{binding}} -> {{name}}' };

  it('adds the resources and the binding, keeps the rest, and the result checks', () => {
    const made = addFromTemplate({ template: queue, values, environment: 'staging', desired: STAGING, sources });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.added).toEqual(['queue jobs']);
    expect(made.extended).toEqual(['worker api’s bindings']);
    expect(made.files).toEqual([{ path: 'src/queues/jobs.js', text: 'env.JOBS -> jobs' }]);
    const file = JSON.parse(made.desired);
    expect(file.resources[0].attrs.bindings).toEqual([
      { name: 'DB', type: 'd1' },
      { name: 'JOBS', type: 'queue', queue_name: 'jobs' },
    ]);
    expect(file.resources[1]).toMatchObject({ id: 'queue:jobs', kind: 'queue', name: 'jobs' });
    expect(checkDesiredFile(made.desired).ok).toBe(true);
  });

  it('refuses a name the file already has, a Worker it hasn’t, and bindings it doesn’t list', () => {
    const once = /** @type {any} */ (
      addFromTemplate({ template: queue, values, environment: 'staging', desired: STAGING, sources })
    );
    expect(
      addFromTemplate({ template: queue, values, environment: 'staging', desired: once.desired, sources }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('already has queue jobs') });
    expect(
      addFromTemplate({
        template: queue,
        values: { ...values, worker: 'web' },
        environment: 'staging',
        desired: STAGING,
        sources,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('has no worker web: give the name of one it has (api)'),
    });
    const bare = JSON.stringify({ version: 1, resources: [{ id: 'worker:api', kind: 'worker', name: 'api' }] });
    expect(addFromTemplate({ template: queue, values, environment: 'staging', desired: bare, sources })).toMatchObject({
      ok: false,
      error: expect.stringContaining('doesn’t list its bindings, so adding one would drop the rest'),
    });
  });

  it('refuses a file for another provider, and one that doesn’t check yet', () => {
    const other = STAGING.replace('"cloudflare"', '"fake"');
    expect(addFromTemplate({ template: queue, values, environment: 'staging', desired: other, sources })).toMatchObject(
      {
        error: expect.stringContaining('is for fake'),
      },
    );
    expect(
      addFromTemplate({ template: queue, values, environment: 'staging', desired: '{ "version": 1 }', sources }),
    ).toMatchObject({ error: expect.stringContaining('.github/breakaway-infra/staging.json:1: resources is a list') });
  });

  it('makes the file when there is none, and never writes outside the checkout', () => {
    const t = /** @type {any} */ (checkTemplate(template())).template;
    const made = addFromTemplate({
      template: t,
      values: { name: 'cache' },
      environment: 'dev',
      desired: null,
      sources: {},
    });
    expect(made).toMatchObject({ ok: true, created: true, desiredPath: `${DIR}/dev.json` });
    expect(JSON.parse(/** @type {any} */ (made).desired)).toEqual({
      version: 1,
      provider: 'cloudflare',
      resources: [{ id: 'kv:cache', kind: 'kv', name: 'cache' }],
    });
    for (const to of ['/etc/x', '.git/hooks/{{name}}', `${DIR}/{{name}}.json`]) {
      const bad = /** @type {any} */ (checkTemplate(template({ files: [{ from: 'a.js', to }] }))).template;
      expect(
        addFromTemplate({
          template: bad,
          values: { name: 'cache' },
          environment: 'dev',
          desired: null,
          sources: { 'a.js': '' },
        }),
      ).toMatchObject({ ok: false, error: expect.stringContaining('isn’t a path in the checkout') });
    }
  });

  it('refuses a template whose result wouldn’t check', () => {
    const t = /** @type {any} */ (
      checkTemplate(template({ resources: [{ id: 'kv:{{name}}', kind: 'KV', name: '{{name}}' }] }))
    ).template;
    expect(
      addFromTemplate({ template: t, values: { name: 'c' }, environment: 'dev', desired: null, sources: {} }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('fix the template'),
    });
  });
});

describe('infra add (CLI-15)', () => {
  it('writes the example’s change into the checkout, and infra check accepts it', () => {
    write(`${DIR}/staging.json`, STAGING);
    const result = infraAdd(['queue', 'name=jobs', 'worker=api'], { root });
    expect(result.code).toBe(0);
    expect(result.data).toMatchObject({ ok: true, template: 'queue', from: 'example', environment: 'staging' });
    expect(result.text).toContain('adds queue jobs');
    expect(result.text).toContain('Wrote src/queues/jobs.js');
    expect(result.text).toContain('npx breakaway infra check staging');
    expect(read('src/queues/jobs.js')).toContain('await env.JOBS.send(body);');
    expect(JSON.parse(read(`${DIR}/staging.json`)).resources.map((r) => r.id)).toEqual(['worker:api', 'queue:jobs']);
    expect(checkInfraFolder(/** @type {any} */ (readInfraFolder(root)))).toMatchObject({ ok: true });
  });

  it('lists the templates for an unknown one, and with none named', () => {
    write(`.github/breakaway-infra/templates/cache/template.json`, template());
    const unknown = infraAdd(['database'], { root });
    expect(unknown.code).toBe(1);
    expect(unknown.text).toMatch(
      /^No template database\. There are:\n {2}cache +A cache\n {2}queue +A queue a Worker sends to \(breakaway’s example\)$/u,
    );
    expect(unknown.data.templates.map((t) => t.name)).toEqual(['cache', 'queue']);
    const all = infraAdd([], { root });
    expect(all.code).toBe(0);
    expect(all.text).toContain('.github/breakaway-infra/templates/<name>/template.json');
  });

  it('takes the repository’s template over the example of the same name', () => {
    write(`${DIR}/templates/queue/template.json`, template({ title: 'Our queue' }));
    const result = infraAdd(['queue', 'dev', 'name=cache'], { root });
    expect(result.data).toMatchObject({ ok: true, from: 'repository' });
    expect(JSON.parse(read(`${DIR}/dev.json`)).resources).toEqual([{ id: 'kv:cache', kind: 'kv', name: 'cache' }]);
  });

  it('asks for the environment when there are several, and writes nothing on --dry-run', () => {
    write(`${DIR}/staging.json`, STAGING);
    write(`${DIR}/production.json`, STAGING);
    expect(infraAdd(['queue', 'name=jobs', 'worker=api'], { root }).text).toBe(
      'name the environment: production, staging (npx breakaway infra add queue <environment> …)',
    );
    const dry = infraAdd(['queue', 'staging', 'name=jobs', 'worker=api'], { root, dryRun: true });
    expect(dry.code).toBe(0);
    expect(dry.text).toContain('Would write src/queues/jobs.js');
    expect(read(`${DIR}/staging.json`)).toBe(STAGING);
    expect(existsSync(join(root, 'src/queues/jobs.js'))).toBe(false);
  });

  it('never overwrites a code file, and changes nothing when it refuses', () => {
    write(`${DIR}/staging.json`, STAGING);
    write('src/queues/jobs.js', 'mine');
    const result = infraAdd(['queue', 'name=jobs', 'worker=api'], { root });
    expect(result).toMatchObject({ code: 1, text: expect.stringContaining('src/queues/jobs.js is already there') });
    expect(read(`${DIR}/staging.json`)).toBe(STAGING);
    expect(read('src/queues/jobs.js')).toBe('mine');
  });

  it('runs from the CLI with no board', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(`${DIR}/staging.json`, STAGING);
    const env = { ...process.env, BREAKAWAY_URL: '', BREAKAWAY_TOKEN: '', HOME: root };
    const out = execFileSync(process.execPath, [CLI, 'infra', 'add', 'queue', 'name=jobs', 'worker=api', '--json'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: ['src/queues/jobs.js'] });
    let failed;
    try {
      execFileSync(process.execPath, [CLI, 'infra', 'add', 'nope'], {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failed = error;
    }
    expect(failed?.status).toBe(1);
    expect(String(failed?.stderr)).toContain('No template nope. There are:');
  });
});
