import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDesiredFile,
  DESIRED_DIR,
  DESIRED_MAX_BYTES,
  environmentOfFile,
  parseWithLines,
} from '../src/infra-desired.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';

// Desired state (BRK-180, docs/specs/IDEA-19-architect.md, "Desired state").
const body = async (res) => ({ code: res.status, ...(await res.json()) });
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

const STAGING = {
  version: 1,
  provider: 'fake',
  resources: [
    { id: 'svc-api', kind: 'service', name: 'api', attrs: { instances: 2 } },
    { id: 'db-main', kind: 'database', name: 'main' },
  ],
};
const pretty = (value) => JSON.stringify(value, null, 2);

describe('checking a desired-state file', () => {
  it('takes a valid file as BRK-173’s desired state', () => {
    const checked = checkDesiredFile(pretty(STAGING));
    expect(checked).toEqual({
      ok: true,
      provider: 'fake',
      desired: {
        resources: [
          { id: 'svc-api', kind: 'service', name: 'api', attrs: { instances: 2 } },
          { id: 'db-main', kind: 'database', name: 'main' },
        ],
      },
    });
    expect(checkDesiredFile('{"version":1,"resources":[]}')).toMatchObject({ ok: true, provider: null });
  });

  it('names the line and field that’s wrong', () => {
    const bad = (value) => checkDesiredFile(pretty(value)).error;
    const kind = bad({ ...STAGING, resources: [STAGING.resources[0], { id: 'db', kind: 'Big DB', name: 'x' }] });
    expect(kind).toMatchObject({ field: 'resources[1].kind', line: 15 });
    expect(kind.message).toMatch(/kind is the kind of resource/u);
    expect(bad({ ...STAGING, version: 2 })).toMatchObject({ field: 'version', line: 2 });
    expect(bad({ ...STAGING, policy: {} })).toMatchObject({
      field: 'policy',
      message: /isn’t part of a desired state/u,
    });
    expect(bad({ version: 1 })).toMatchObject({ field: null, line: 1, message: /resources is a list/u });
    expect(bad({ ...STAGING, resources: [{ ...STAGING.resources[0] }, { ...STAGING.resources[0] }] })).toMatchObject({
      field: 'resources[1].id',
      message: /svc-api is listed twice/u,
    });
    expect(bad({ ...STAGING, resources: [{ kind: 'service', name: 'x' }] })).toMatchObject({
      field: 'resources[0]',
      message: /id is the provider’s own ID/u,
    });
    expect(bad({ ...STAGING, resources: [{ id: 'a', kind: 'service', name: 'a', size: 1 }] })).toMatchObject({
      field: 'resources[0].size',
    });
    expect(bad({ ...STAGING, provider: 'Fake!' })).toMatchObject({ field: 'provider' });
  });

  it('says where JSON that doesn’t parse goes wrong, and refuses a key given twice', () => {
    const broken = checkDesiredFile('{\n  "version": 1,\n  "resources": [\n    { "id": "a", }\n  ]\n}');
    expect(broken).toMatchObject({ ok: false, error: { line: 4, field: null, message: /isn’t JSON/u } });
    const twice = checkDesiredFile('{\n  "version": 1,\n  "version": 1,\n  "resources": []\n}');
    expect(twice.error).toMatchObject({ line: 3, message: /“version” is given twice/u });
    expect(checkDesiredFile('[]').error.message).toMatch(/one JSON object/u);
    expect(checkDesiredFile('').error.message).toMatch(/isn’t JSON/u);
    expect(parseWithLines('{"a": [1, {"b": "c\\n"}]}').value).toEqual({ a: [1, { b: 'c\n' }] });
  });

  it('refuses a secret’s value in a resource’s settings', () => {
    const leaked = checkDesiredFile(
      pretty({
        version: 1,
        resources: [
          { id: 'a', kind: 'service', name: 'a', attrs: { env: { TOKEN: 'ghp_0123456789abcdefghijABCDEFGHIJ' } } },
        ],
      }),
    );
    expect(leaked.error).toMatchObject({ field: 'resources[0].attrs.env.TOKEN', message: /never its value/u });
  });

  it('refuses a file over the size limit', () => {
    const big = checkDesiredFile(`{"version":1,"resources":[],"pad":"${'x'.repeat(DESIRED_MAX_BYTES)}"}`);
    expect(big.error.message).toMatch(/over 256 KB/u);
  });

  it('checks the provider in the file against the environment’s, and kinds against the provider’s', () => {
    expect(checkDesiredFile(pretty(STAGING), { expectProvider: 'cloudflare' }).error).toMatchObject({
      field: 'provider',
      line: 3,
      message: /the environment runs on cloudflare/u,
    });
    const provider = fakeProvider();
    expect(checkDesiredFile(pretty(STAGING), { provider }).ok).toBe(true);
    const queue = { ...STAGING, resources: [{ id: 'q', kind: 'queue', name: 'jobs' }] };
    expect(checkDesiredFile(pretty(queue), { provider }).error).toMatchObject({
      field: 'resources[0].kind',
      message: /fake has no kind queue: it has database, route, service/u,
    });
  });

  it('knows which files are an environment’s', () => {
    expect(environmentOfFile('staging.json')).toEqual({ environment: 'staging' });
    expect(environmentOfFile('README.md')).toBeNull();
    // Policy (BRK-181) and scaling rules (BRK-186) live beside the environments' files.
    expect(environmentOfFile('policy.json')).toBeNull();
    expect(environmentOfFile('scaling.json')).toBeNull();
    expect(environmentOfFile('Prod.json')).toMatchObject({ problem: /isn’t an environment’s name/u });
  });
});

// GitHub, mocked for acme/widgets: the default branch's .github/breakaway-infra folder, and every other read empty.
const REPO = '/repos/acme/widgets';
const gh = { files: {}, head: 'sha1', calls: [], fail: false };

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) throw new Error(`unexpected write ${path}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const rest = path.slice(REPO.length);
    if (rest.startsWith(`/contents/${DESIRED_DIR}`)) {
      gh.calls.push(rest);
      if (gh.fail) return reply({ message: 'Server Error' }, 500);
      if (url.searchParams.get('ref') !== 'main') return reply({ message: 'Not Found' }, 404);
      const names = Object.keys(gh.files);
      if (rest === `/contents/${DESIRED_DIR}`)
        return names.length
          ? reply(names.map((name) => ({ name, type: 'file', size: encoder.encode(gh.files[name]).length })))
          : reply({ message: 'Not Found' }, 404);
      const name = decodeURIComponent(rest.slice(`/contents/${DESIRED_DIR}/`.length));
      return name in gh.files
        ? reply({ type: 'file', encoding: 'base64', content: b64(gh.files[name]) })
        : reply({ message: 'Not Found' }, 404);
    }
    if (rest.startsWith('/contents/')) return reply({ message: 'Not Found' }, 404);
    if (rest === '/actions/runs') return reply({ workflow_runs: [] });
    if (rest === '/commits')
      return reply([
        {
          sha: gh.head,
          html_url: `https://github.com/acme/widgets/commit/${gh.head}`,
          commit: { message: 'Declare staging', author: { name: 'x', date: '2026-10-06T10:00:00Z' } },
        },
      ]);
    if (['/pulls', '/dependabot/alerts', '/deployments', '/releases', '/tags'].includes(rest)) return reply([]);
    return reply({ message: 'Not Found' }, 404);
  });
}

const sync = async () => body(await api('github/sync', { method: 'POST' }));
const desired = async (query = '') => body(await api(`infra/desired${query}`));
const one = async (name) => body(await api(`infra/desired/${name}?repo=widgets`));
const addEnvironment = async (fields) =>
  body(
    await boardApi('infra/environments', { method: 'POST', body: { repo: 'widgets', provider: 'fake', ...fields } }),
  );

describe('reading the desired state from the default branch', () => {
  let spy;
  let heads = 0;
  beforeEach(() => {
    spy = mockGitHub();
    // The store lasts the whole file: each test starts on a new commit.
    heads += 1;
    Object.assign(gh, { files: {}, head: `head${heads}`, calls: [], fail: false });
  });
  afterEach(() => spy.mockRestore());

  it('has nothing for a repository without the folder', async () => {
    await sync();
    expect((await desired()).desired).toEqual([]);
    expect(gh.calls).toEqual([`/contents/${DESIRED_DIR}`]);
  });

  it('shows a valid file as its environment’s desired state, read once per commit', async () => {
    const staging = await addEnvironment({ name: 'staging', kind: 'staging', target: 'widgets-staging' });
    gh.files = { 'staging.json': pretty(STAGING), 'README.md': '# not read', 'policy.json': '{}' };
    await sync();
    const got = await one('staging');
    expect(got.code).toBe(200);
    expect(got.desired).toMatchObject({
      repo: 'widgets',
      environment: 'staging',
      environmentId: staging.environment.id,
      path: `${DESIRED_DIR}/staging.json`,
      state: 'valid',
      problem: null,
      error: null,
      provider: 'fake',
      sha: gh.head,
      validSha: gh.head,
    });
    expect(got.desired.desired.resources.map((r) => r.id)).toEqual(['svc-api', 'db-main']);
    expect((await one(String(staging.environment.id))).desired.environment).toBe('staging');
    // policy.json is the policy's (BRK-181), read from the same listing, and never an environment's.
    expect(gh.calls).toEqual([
      `/contents/${DESIRED_DIR}`,
      `/contents/${DESIRED_DIR}/policy.json`,
      `/contents/${DESIRED_DIR}/staging.json`,
    ]);
    // The same commit reads nothing again.
    gh.calls = [];
    await sync();
    expect(gh.calls).toEqual([]);
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (s) => {
      const row = s.environmentRow('staging', 'widgets');
      expect(s.desiredStateFor(row).resources).toHaveLength(2);
    });
  });

  it('shows an invalid file’s error and keeps the last valid copy', async () => {
    gh.files = { 'staging.json': pretty(STAGING) };
    await sync();
    const valid = gh.head;
    gh.head = `${gh.head}-broken`;
    gh.files = { 'staging.json': pretty({ ...STAGING, resources: [{ id: 'svc-api', kind: 'service' }] }) };
    await sync();
    const got = (await one('staging')).desired;
    expect(got).toMatchObject({
      state: 'invalid',
      error: { field: 'resources[0]', line: 5, message: /name is what the platform calls it/u },
      sha: gh.head,
      validSha: valid,
    });
    expect(got.desired.resources).toHaveLength(2);
    // Fixed on the next commit: the error goes.
    gh.head = `${gh.head}-fixed`;
    gh.files = { 'staging.json': pretty({ ...STAGING, resources: [STAGING.resources[0]] }) };
    await sync();
    expect((await one('staging')).desired).toMatchObject({ state: 'valid', error: null, validSha: gh.head });
  });

  it('shows a file for an environment that doesn’t exist as one to add', async () => {
    gh.files = { 'preview-7.json': pretty(STAGING), 'Bad Name.json': '{}' };
    await sync();
    const all = (await desired('?repo=widgets')).desired;
    const preview = all.find((d) => d.environment === 'preview-7');
    expect(preview).toMatchObject({
      state: 'to-add',
      environmentId: null,
      problem: /no environment called preview-7/u,
    });
    expect(preview.desired.resources).toHaveLength(2);
    expect(all.find((d) => d.path.endsWith('Bad Name.json'))).toMatchObject({
      environment: null,
      state: 'invalid',
      error: { message: /isn’t an environment’s name/u },
    });
    // Adding the environment makes it its desired state, without another read.
    await addEnvironment({ name: 'preview-7', kind: 'staging' });
    expect((await one('preview-7')).desired.state).toBe('valid');
    // A file that's gone from the branch goes from the board.
    gh.head = `${gh.head}-gone`;
    gh.files = {};
    await sync();
    expect((await desired()).desired).toEqual([]);
    expect((await one('preview-7')).code).toBe(404);
  });

  it('refuses one for an observe-only environment, the board’s own install above all', async () => {
    await addEnvironment({ name: 'board', kind: 'production', target: 'widgets-tasks' });
    gh.files = { 'board.json': pretty(STAGING) };
    await sync();
    const got = (await one('board')).desired;
    expect(got).toMatchObject({ state: 'refused', desired: null, problem: /runs this board, so it’s observe only/u });
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (s) => {
      expect(s.desiredStateFor(s.environmentRow('board', 'widgets'))).toBeNull();
    });
  });

  it('checks the file’s provider against its environment’s, and kinds against a connected provider', async () => {
    await addEnvironment({ name: 'qa', kind: 'staging', provider: 'cloudflare' });
    gh.files = { 'qa.json': pretty(STAGING) };
    await sync();
    expect((await one('qa')).desired).toMatchObject({
      state: 'invalid',
      error: { field: 'provider', message: /the environment runs on cloudflare/u },
    });
    await addEnvironment({ name: 'kinds', kind: 'staging' });
    gh.head = `${gh.head}-kinds`;
    gh.files = { 'kinds.json': pretty({ ...STAGING, resources: [{ id: 'q', kind: 'queue', name: 'jobs' }] }) };
    await runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (s) => {
      s.infraProviders = new ProviderRegistry();
      s.infraProviders.register(fakeProvider());
    });
    await sync();
    expect((await one('kinds')).desired).toMatchObject({
      state: 'invalid',
      error: { field: 'resources[0].kind', message: /fake has no kind queue/u },
    });
  });

  it('keeps what it had when GitHub fails, and reads again on the next sync', async () => {
    gh.files = { 'staging.json': pretty(STAGING) };
    await sync();
    gh.head = `${gh.head}-later`;
    gh.fail = true;
    await sync();
    expect((await one('staging')).desired.state).not.toBe('to-add');
    gh.fail = false;
    gh.calls = [];
    await sync();
    expect(gh.calls).toContain(`/contents/${DESIRED_DIR}`);
    expect((await one('staging')).desired.sha).toBe(gh.head);
  });

  it('answers 404 for an environment without a file, saying where it goes', async () => {
    const missing = await one('nowhere');
    expect(missing).toMatchObject({ code: 404, error: /add \.github\/breakaway-infra\/nowhere\.json/u });
  });

  it('is read only', async () => {
    const res = await api('infra/desired', { method: 'POST', body: {} });
    expect(res.status).toBe(404);
  });

  it('refuses an environment named after a reserved file', async () => {
    const policy = await addEnvironment({ name: 'policy', kind: 'staging' });
    expect(policy).toMatchObject({ code: 400, error: /Architect’s policy file/u });
  });
});
