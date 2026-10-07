import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOT_SET,
  checkInputs,
  dispatchOf,
  fieldOf,
  inputsToSend,
  validRef,
  workflowsChanged,
} from '../src/workflows.js';
import { YamlError, parseYaml } from '../src/yaml.js';
import { ORIGIN, TEST_API_TOKEN, TEST_GITHUB_WEBHOOK_SECRET } from './constants.js';
import { api } from './helpers.js';

// Run a repository's workflows that run by hand (BRK-224, docs/specs/BRK-223-run-workflows.md), against a pretend GitHub.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const REPO = '/repos/acme/widgets';
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));

describe('the YAML reader reads what real workflows use', () => {
  it('comments, flow mappings, folded and chomped blocks, plain scalars over lines, and anchors', () => {
    const doc = parseYaml(`---
# a comment
name: Plugin # after a value
"on":
  workflow_dispatch:
    inputs:
      ref: { type: string, required: true, description: "A tag, like v1.6.0" }
      level:
        type: choice
        options: [patch, minor,
          major]   # a list over two lines
        default: &level patch
      note:
        description: >-
          Folded onto
          one line.
      script:
        description: |+
          kept

      long:
        description: a plain value
          that goes on
      again: *level
      quoted:
        description: 'it''s
          folded'
`);
    expect(doc.on.workflow_dispatch.inputs).toEqual({
      ref: { type: 'string', required: true, description: 'A tag, like v1.6.0' },
      level: { type: 'choice', options: ['patch', 'minor', 'major'], default: 'patch' },
      note: { description: 'Folded onto one line.' },
      script: { description: 'kept\n\n' },
      long: { description: 'a plain value that goes on' },
      again: 'patch',
      quoted: { description: "it's folded" },
    });
    expect(doc.name).toBe('Plugin');
  });

  it('keeps on as a key, and says what it can’t read with its line', () => {
    expect(parseYaml('on: push\n')).toEqual({ on: 'push' });
    expect(parseYaml('a: >\n  one\n  two\n\n  three\n')).toEqual({ a: 'one two\nthree\n' });
    expect(parseYaml('a: |-\n  x\n')).toEqual({ a: 'x' });
    expect(parseYaml('a: [x, {b: 1}, "c, d"]\n')).toEqual({ a: ['x', { b: 1 }, 'c, d'] });
    expect(() => parseYaml('a: *nothing\n')).toThrow(YamlError);
    expect(() => parseYaml('a: [x, y\n')).toThrow(/line 1: a \[list\] that never ends/u);
    expect(() => parseYaml('a: !!str x\n')).toThrow(/doesn't take/u);
    expect(() => parseYaml('a: 1\n---\nb: 2\n')).toThrow(/second document/u);
  });
});

describe('which workflows run by hand', () => {
  it('counts workflow_dispatch in every form', () => {
    expect(dispatchOf('on: workflow_dispatch\njobs: {}\n')).toEqual({ readable: true, inputs: [] });
    expect(dispatchOf('on: [push, workflow_dispatch]\n')).toEqual({ readable: true, inputs: [] });
    expect(dispatchOf('on:\n  push:\n  workflow_dispatch:\n')).toEqual({ readable: true, inputs: [] });
    expect(dispatchOf('on:\n  workflow_dispatch: {}\n')).toEqual({ readable: true, inputs: [] });
    expect(dispatchOf('on: push\n')).toBeNull();
    expect(dispatchOf('on:\n  workflow_call:\n  schedule:\n    - cron: "0 9 * * 1"\n')).toBeNull();
  });

  it('reads each input’s type, required, default, and options, in the file’s order', () => {
    const found = dispatchOf(`on:
  workflow_dispatch:
    inputs:
      tag:
        description: A release tag
        required: true
      dry-run: { type: boolean, default: true }
      level: { type: choice, options: [patch, minor], default: patch }
      count: { type: number, default: 3 }
      where: { type: environment }
`);
    expect(found).toEqual({
      readable: true,
      inputs: [
        { name: 'tag', description: 'A release tag', type: 'string', required: true, default: null, options: null },
        { name: 'dry-run', description: null, type: 'boolean', required: false, default: true, options: null },
        {
          name: 'level',
          description: null,
          type: 'choice',
          required: false,
          default: 'patch',
          options: ['patch', 'minor'],
        },
        { name: 'count', description: null, type: 'number', required: false, default: '3', options: null },
        { name: 'where', description: null, type: 'environment', required: false, default: null, options: null },
      ],
    });
  });

  it('reads the on: block alone when the jobs use YAML it can’t, and never guesses inputs it can’t read', () => {
    const jobs = 'jobs:\n  a:\n    steps:\n      - run: !!binary x\n';
    expect(dispatchOf(`on:\n  workflow_dispatch:\n    inputs:\n      x: {}\n${jobs}`)).toMatchObject({
      readable: true,
      inputs: [{ name: 'x', type: 'string' }],
    });
    expect(dispatchOf(`on: push\n${jobs}`)).toBeNull();
    expect(dispatchOf('on:\n  workflow_dispatch:\n    inputs: !!map {}\n')).toMatchObject({ readable: false });
    expect(dispatchOf('on:\n  workflow_dispatch:\n    inputs:\n      x: { type: secret }\n')).toMatchObject({
      readable: false,
    });
    expect(dispatchOf('on:\n  workflow_dispatch:\n    inputs:\n      x: { type: choice }\n')).toMatchObject({
      readable: false,
    });
  });

  it('checks a run’s ref and inputs', () => {
    const wanted = dispatchOf(`on:
  workflow_dispatch:
    inputs:
      tag: { required: true }
      env: { required: true, default: staging }
      dry: { type: boolean }
      level: { type: choice, options: [patch, minor] }
      n: { type: number }
`).inputs;
    expect(checkInputs(wanted, { tag: 'v1.6.0', dry: true, level: 'minor', n: 2 })).toEqual({
      inputs: { tag: 'v1.6.0', dry: 'true', level: 'minor', n: '2' },
    });
    expect(checkInputs(wanted, {})).toEqual({ error: 'tag is required' });
    expect(checkInputs(wanted, { tag: 'x', other: 'y' })).toMatchObject({
      error: expect.stringMatching(/no input named "other"/u),
    });
    expect(checkInputs(wanted, { tag: 'x', level: 'major' })).toEqual({ error: 'level is one of patch, minor' });
    expect(checkInputs(wanted, { tag: 'x', dry: 'yes' })).toEqual({ error: 'dry is true or false' });
    expect(checkInputs(wanted, { tag: 'x', n: 'two' })).toEqual({ error: 'n is a number' });
    expect(checkInputs(wanted, { tag: 'x'.repeat(1001) })).toMatchObject({
      error: expect.stringMatching(/longer than 1000/u),
    });
    expect(checkInputs(wanted, { tag: ['x'] })).toEqual({ error: 'tag takes one value' });
    expect(checkInputs(wanted, 'tag=x')).toMatchObject({ error: expect.any(String) });
    expect(['main', 'v1.6.0', 'feature/x', 'a_b-c.d'].every(validRef)).toBe(true);
    expect(['', 'a b', 'a..b', '-x', '/x', 'x/', 'a;b', 'x'.repeat(256), 7].some(validRef)).toBe(false);
  });

  it('shows a choice with a default without an empty entry, and sends nothing for an optional input left alone', () => {
    const wanted = dispatchOf(`on:
  workflow_dispatch:
    inputs:
      next:
        description: For a stable, what main works toward next
        required: false
        default: patch
        type: choice
        options: [patch, minor, major]
      level: { type: choice, options: [patch, minor] }
      env: { type: choice, required: true, options: [staging, production] }
      odd: { type: choice, options: [a, b], default: c }
      tag: { required: true, default: main }
      dry: { type: boolean }
`).inputs;
    const [next, level, env, odd, tag, dry] = wanted;
    expect(next.description).toBe('For a stable, what main works toward next');
    expect(fieldOf(next)).toEqual({ start: 'patch', empty: null });
    expect(fieldOf(level)).toEqual({ start: '', empty: NOT_SET });
    expect(NOT_SET).toBe('Not set (the workflow decides)');
    expect(fieldOf(env)).toEqual({ start: 'staging', empty: null });
    expect(fieldOf(odd)).toEqual({ start: '', empty: NOT_SET });
    expect(fieldOf(tag)).toEqual({ start: 'main', empty: null });
    expect(fieldOf(dry)).toEqual({ start: false, empty: null });

    const start = Object.fromEntries(wanted.map((w) => [w.name, fieldOf(w).start]));
    expect(inputsToSend(wanted, start)).toEqual({ env: 'staging', tag: 'main' });
    expect(inputsToSend(wanted, { ...start, next: 'minor', level: 'minor', dry: true, tag: ' v2 ' })).toEqual({
      next: 'minor',
      level: 'minor',
      env: 'staging',
      tag: 'v2',
      dry: 'true',
    });
    expect(checkInputs(wanted, inputsToSend(wanted, start))).toEqual({ inputs: { env: 'staging', tag: 'main' } });
  });

  it('drops the list when a push to the default branch changes a workflow', () => {
    const push = (files, ref = 'refs/heads/main') => ({
      ref,
      repository: { default_branch: 'main' },
      size: 1,
      commits: [{ added: [], removed: [], modified: files }],
    });
    expect(workflowsChanged('push', push(['.github/workflows/plugin.yml']))).toBe(true);
    expect(workflowsChanged('push', push(['src/worker.js']))).toBe(false);
    expect(workflowsChanged('push', push(['.github/workflows/plugin.yml'], 'refs/heads/dev'))).toBe(false);
    expect(workflowsChanged('push', { ...push([]), size: 30 })).toBe(true);
    expect(workflowsChanged('pull_request', push(['.github/workflows/plugin.yml']))).toBe(false);
  });
});

const FILES = {
  '.github/workflows/plugin.yml': `name: Plugin
on:
  workflow_dispatch:
    inputs:
      ref:
        description: A release tag of breakaway, like v1.6.0
        required: true
      dry-run: { type: boolean, default: false }
      level: { type: choice, options: [patch, minor] }
jobs: {}
`,
  '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\njobs: {}\n',
  '.github/workflows/odd.yml': 'name: Odd\non:\n  workflow_dispatch:\n    inputs: !!map {}\n',
};
const WORKFLOWS = [
  { id: 11, name: 'Plugin', path: '.github/workflows/plugin.yml', state: 'active' },
  { id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: 13, name: 'Odd', path: '.github/workflows/odd.yml', state: 'active' },
  { id: 14, name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
  { id: 15, name: 'CodeQL', path: 'dynamic/github-code-scanning/codeql', state: 'active' },
];
const gh = { writes: [], reads: [], writeError: null, workflows: WORKFLOWS };

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = decodeURIComponent(url.pathname);
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (init.method && init.method !== 'GET') {
      gh.writes.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      if (gh.writeError) {
        const [status, message] = gh.writeError;
        gh.writeError = null;
        return reply({ message }, status);
      }
      return new Response(null, { status: 204 });
    }
    gh.reads.push(`${path}${url.search}`);
    if (path === `${REPO}/actions/workflows`)
      return reply({ total_count: gh.workflows.length, workflows: gh.workflows });
    const m = /\/contents\/(.+)$/u.exec(path);
    if (m) {
      const text = FILES[m[1]];
      if (text === undefined) return reply({ message: 'Not Found' }, 404);
      return reply({ content: btoa(text), encoding: 'base64' });
    }
    if (path.endsWith('/actions/runs')) return reply({ workflow_runs: [] });
    if (path.endsWith('/check-runs')) return reply({ check_runs: [] });
    return reply([]);
  });
}

async function browser() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return (payload) =>
    SELF.fetch(`${ORIGIN}/api/github/workflows/run`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(payload),
    });
}

async function webhook(event, payload) {
  const bytes = encoder.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return SELF.fetch(`${ORIGIN}/github/webhook`, {
    method: 'POST',
    headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature, 'Content-Type': 'application/json' },
    body: bytes,
  });
}

describe('GET /api/github/workflows and POST /api/github/workflows/run', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    gh.writes = [];
    gh.reads = [];
    gh.writeError = null;
    gh.workflows = WORKFLOWS;
    await runInDurableObject(stub(), (s) => {
      s.workflowCache = {};
      s.setMeta('conn_live', null);
    });
  });
  afterEach(() => spy.mockRestore());

  it('lists the active workflows that run by hand, with their inputs, and one it can’t read', async () => {
    const res = await body(await api('github/workflows?repo=widgets'));
    expect(res.status).toBe(200);
    expect(res.branch).toBe('main');
    expect(res.branches[0]).toBe('main');
    expect(res.actions).toEqual({ ok: true, reason: null });
    expect(res.workflows.map((w) => [w.name, w.readable])).toEqual([
      ['Odd', false],
      ['Plugin', true],
    ]);
    const plugin = res.workflows.find((w) => w.name === 'Plugin');
    expect(plugin).toMatchObject({
      id: 11,
      path: '.github/workflows/plugin.yml',
      url: 'https://github.com/acme/widgets/actions/workflows/plugin.yml',
    });
    expect(plugin.inputs.map((i) => [i.name, i.type, i.required])).toEqual([
      ['ref', 'string', true],
      ['dry-run', 'boolean', false],
      ['level', 'choice', false],
    ]);
    expect(gh.reads.filter((r) => r.includes('/contents/')).every((r) => r.endsWith('?ref=main'))).toBe(true);
    // Kept: a second read asks GitHub nothing.
    const before = gh.reads.length;
    expect((await api('github/workflows?repo=widgets')).status).toBe(200);
    expect(gh.reads.length).toBe(before);
  });

  it('lists nothing as an empty list, and an unknown repository as 404', async () => {
    gh.workflows = [];
    expect(await body(await api('github/workflows'))).toMatchObject({ status: 200, workflows: [] });
    expect((await api('github/workflows?repo=nope')).status).toBe(404);
  });

  it('says when the App can’t start workflows, on any repository', async () => {
    await runInDurableObject(stub(), (s) =>
      s.setMeta(
        'conn_live',
        JSON.stringify({
          at: Date.now(),
          repos: {
            widgets: {
              installed: true,
              permissions: { metadata: 'read', pull_requests: 'write', contents: 'write', actions: 'read' },
              autoMerge: true,
            },
          },
        }),
      ),
    );
    const res = await body(await api('github/workflows?repo=widgets'));
    expect(res.actions.ok).toBe(false);
    expect(res.actions.reason).toMatch(/can’t start workflows on acme\/widgets/u);
  });

  it('runs one on the signed-in owner’s press, and records it in Activity without the values', async () => {
    const run = await browser();
    const ok = await body(
      await run({ repo: 'widgets', workflow: 11, ref: 'main', inputs: { ref: 'v1.6.0-secret', 'dry-run': true } }),
    );
    expect(ok).toMatchObject({ status: 200, ok: true, action: 'workflow_started', name: 'Plugin', ref: 'main' });
    expect(gh.writes).toEqual([
      [
        'POST',
        `${REPO}/actions/workflows/11/dispatches`,
        { ref: 'main', inputs: { ref: 'v1.6.0-secret', 'dry-run': 'true' } },
      ],
    ]);
    const activity = JSON.stringify(await body(await api('activity')));
    expect(activity).toContain('"kind":"workflow_started","workflow":"Plugin"');
    expect(activity).toContain('"inputs":["ref","dry-run"]');
    expect(activity).not.toContain('v1.6.0-secret');
    // By its path, on the default branch when no ref is sent.
    expect((await run({ workflow: '.github/workflows/plugin.yml', inputs: { ref: 'v1.6.0' } })).status).toBe(200);
    expect(gh.writes[1][2].ref).toBe('main');
  });

  it('refuses the bearer token, and anything it can’t show or check', async () => {
    const token = await api('github/workflows/run', { method: 'POST', body: { workflow: 11, inputs: { ref: 'v1' } } });
    expect(token.status).toBe(403);
    expect((await token.json()).error).toMatch(/only the signed-in web board can run a workflow/u);
    const run = await browser();
    const refused = async (payload) => body(await run(payload));
    expect(await refused({ workflow: 12 })).toMatchObject({ status: 404 }); // CI doesn't run by hand
    expect(await refused({ workflow: 14 })).toMatchObject({ status: 404 }); // disabled
    expect(await refused({ workflow: 13 })).toMatchObject({
      status: 409,
      url: 'https://github.com/acme/widgets/actions/workflows/odd.yml',
    });
    expect(await refused({ workflow: 11, inputs: { ref: 'v1', other: 'x' } })).toMatchObject({ status: 400 });
    expect(await refused({ workflow: 11, inputs: {} })).toMatchObject({ status: 400, error: 'ref is required' });
    expect(await refused({ workflow: 11, inputs: { ref: 'v1', level: 'major' } })).toMatchObject({ status: 400 });
    expect(await refused({ workflow: 11, ref: 'main;rm', inputs: { ref: 'v1' } })).toMatchObject({ status: 400 });
    expect(await refused({ workflow: 11, ref: '../main', inputs: { ref: 'v1' } })).toMatchObject({ status: 400 });
    expect(await refused({ inputs: { ref: 'v1' } })).toMatchObject({ status: 400 });
    expect(gh.writes).toEqual([]);
  });

  it('gives Promote’s message without Actions write, and GitHub’s reason when it refuses', async () => {
    const run = await browser();
    gh.writeError = [403, 'Resource not accessible by integration'];
    const denied = await body(await run({ workflow: 11, inputs: { ref: 'v1' } }));
    expect(denied).toMatchObject({ status: 403, permission: true });
    expect(denied.error).toMatch(/read and write on Actions/u);
    gh.writeError = [422, "Workflow does not have 'workflow_dispatch' trigger"];
    expect(await body(await run({ workflow: 11, ref: 'old', inputs: { ref: 'v1' } }))).toMatchObject({
      status: 409,
      github: 422,
      error: "Workflow does not have 'workflow_dispatch' trigger",
    });
    expect(JSON.stringify(await body(await api('activity')))).not.toContain('"ref":"old"');
  });

  it('reads the workflows again after a push to the default branch changes one', async () => {
    expect((await api('github/workflows?repo=widgets')).status).toBe(200);
    const listed = gh.reads.filter((r) => r.endsWith('/actions/workflows?per_page=100')).length;
    const push = (files) => ({
      ref: 'refs/heads/main',
      size: 1,
      repository: { full_name: 'acme/widgets', default_branch: 'main' },
      commits: [{ added: [], removed: [], modified: files }],
    });
    expect((await webhook('push', push(['README.md']))).status).toBe(202);
    await api('github/workflows?repo=widgets');
    expect(gh.reads.filter((r) => r.endsWith('/actions/workflows?per_page=100')).length).toBe(listed);
    expect((await webhook('push', push(['.github/workflows/plugin.yml']))).status).toBe(202);
    await api('github/workflows?repo=widgets');
    expect(gh.reads.filter((r) => r.endsWith('/actions/workflows?per_page=100')).length).toBe(listed + 1);
  });
});
