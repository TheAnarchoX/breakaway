import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSpecsDir, inSpecsDir, specMeta, specsDirOf } from '../src/specs.js';
import { api } from './helpers.js';

// `code` is the HTTP status: a spec has a `status` of its own (draft, approved, built).
const body = async (res) => ({ ...(await res.json()), code: res.status });
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

const BRK_7 =
  '# BRK-7 · Sort the inbox\n\nTask: BRK-7 on the board · Status: approved (1 Oct 2026)\n\n## Problem\nIt’s unsorted.\n';
const BRK_12 = '# The inbox, by age\n\nTask: `BRK-12` on the board · Status: draft\n\nSee BRK-7.\n';
const NOTES = 'Some notes, with no heading.\n';
const README = '# Specs\n\nHow we write them.\n';

// A pretend GitHub for acme/widgets: its specs directory as one tree (GraphQL), and each file (REST).
const gh = {
  dir: 'docs/specs',
  files: {}, // name → text, or { size } for one too large to read
  fail: null, // [status, message] for every read
  calls: [],
};

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    gh.calls.push(path);
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === '/repos/acme/widgets/installation') return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (gh.fail) return reply({ message: gh.fail[1] }, gh.fail[0]);
    if (path === '/graphql') {
      const { variables } = JSON.parse(init.body);
      expect(variables).toMatchObject({ owner: 'acme', name: 'widgets' });
      const object =
        variables.expression === `main:${gh.dir}`
          ? {
              entries: [
                ...Object.entries(gh.files).map(([name, f]) => ({
                  name,
                  type: 'blob',
                  object:
                    typeof f === 'string'
                      ? { byteSize: encoder.encode(f).length, isBinary: false, text: f }
                      : { byteSize: f.size, isBinary: false, text: null },
                })),
                { name: 'drafts', type: 'tree', object: {} },
              ],
            }
          : null;
      return reply({ data: { repository: { object } } });
    }
    if (path === '/repos/acme/widgets/commits')
      return reply(
        url.searchParams.get('path') === `${gh.dir}/BRK-7-sort.md`
          ? [
              {
                sha: 'abc1234',
                html_url: 'https://github.com/acme/widgets/commit/abc1234',
                commit: { message: 'BRK-7: Write the spec\n\nMore.', committer: { date: '2026-10-01T10:00:00Z' } },
              },
            ]
          : [],
      );
    const m = /^\/repos\/acme\/widgets\/contents\/(.+)$/u.exec(path);
    if (m && url.searchParams.get('ref') === 'main') {
      const name = decodeURIComponent(m[1]).slice(gh.dir.length + 1);
      const f = gh.files[name];
      if (f === undefined) return reply({ message: 'Not Found' }, 404);
      const html_url = `https://github.com/acme/widgets/blob/main/${gh.dir}/${name}`;
      return typeof f === 'string'
        ? reply({ type: 'file', size: encoder.encode(f).length, encoding: 'base64', content: b64(f), html_url })
        : reply({ type: 'file', size: f.size, encoding: 'none', content: '', html_url });
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('a repository’s specs directory', () => {
  it('is relative, without .., and at most 200 characters; empty means docs/specs', () => {
    expect(checkSpecsDir('specs')).toBe('specs');
    expect(checkSpecsDir('./design/specs/')).toBe('design/specs');
    expect(checkSpecsDir('')).toBeNull();
    expect(checkSpecsDir(null)).toBeNull();
    for (const bad of ['/etc', '../other', 'docs/../..', 'a//b', '.', 'docs/./specs', 'docs specs', 'x'.repeat(201)])
      expect(() => checkSpecsDir(bad), bad).toThrow(/settings.specs is a directory/u);
    expect(specsDirOf({ settings: null })).toBe('docs/specs');
    expect(specsDirOf({ settings: { specs: 'specs' } })).toBe('specs');
  });

  it('holds only Markdown files directly in it', () => {
    expect(inSpecsDir('docs/specs', 'docs/specs/BRK-7-sort.md')).toBe(true);
    expect(inSpecsDir('docs/specs', './docs/specs/README.md')).toBe(true);
    for (const bad of [
      'docs/specs/drafts/BRK-8.md',
      'docs/specs/../../src/worker.js',
      'docs/specs/notes.txt',
      'docs/specs/.hidden.md',
      'docs/BRK-7.md',
      'docs/specsx/BRK-7.md',
      'src/worker.js',
    ])
      expect(inSpecsDir('docs/specs', bad), bad).toBe(false);
  });

  it('reads a spec’s title, status, and work ID from the file', () => {
    expect(specMeta('BRK-7-sort.md', BRK_7)).toEqual({
      wid: 'BRK-7',
      title: 'BRK-7 · Sort the inbox',
      status: 'approved',
    });
    expect(specMeta('BRK-12-age.md', BRK_12)).toEqual({ wid: 'BRK-12', title: 'The inbox, by age', status: 'draft' });
    expect(specMeta('notes.md', NOTES)).toEqual({ wid: null, title: 'notes', status: null });
    expect(specMeta('IDEA-3.md', null)).toEqual({ wid: 'IDEA-3', title: 'IDEA-3', status: null });
  });

  it('is set in the settings, checked, kept beside other settings, and cleared back to the default', async () => {
    const set = await body(await api('repos/widgets', { method: 'PATCH', body: { settings: { specs: './design/' } } }));
    expect(set.code).toBe(200);
    expect(set.repo.settings).toEqual({ specs: 'design' });
    const bad = await body(await api('repos/widgets', { method: 'PATCH', body: { settings: { specs: '../x' } } }));
    expect(bad.code).toBe(400);
    expect(bad.error).toMatch(/settings.specs is a directory in the repository/u);
    const other = await body(
      await api('repos/widgets', { method: 'PATCH', body: { settings: { specs: null, other: true } } }),
    );
    expect(other.repo.settings).toEqual({ other: true });
    const cleared = await body(await api('repos/widgets', { method: 'PATCH', body: { settings: { specs: '' } } }));
    expect(cleared.repo.settings).toBeNull();
  });
});

describe('reading specs from GitHub', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    gh.dir = 'docs/specs';
    gh.files = { 'BRK-7-sort.md': BRK_7, 'BRK-12-age.md': BRK_12, 'notes.md': NOTES, 'README.md': README };
    gh.fail = null;
    gh.calls = [];
    await runInDurableObject(stub(), (store) => {
      store.specsCache = {};
    });
  });
  afterEach(() => spy.mockRestore());

  it('lists the specs, newest first, with the tasks that link each one', async () => {
    const add = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md' },
          { description: 'Show the age', project: 'cloud', spec: './docs/specs/BRK-7-sort.md' },
          { description: 'Unrelated', project: 'cloud' },
        ],
      }),
    );
    const [first, second] = add.tasks;
    await api(`tasks/${second.wid}/done`, { method: 'POST' });
    const list = await body(await api('specs'));
    expect(list).toMatchObject({ code: 200, slug: 'widgets', dir: 'docs/specs', branch: 'main', missing: false });
    expect(list.readme).toEqual({
      path: 'docs/specs/README.md',
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/README.md',
    });
    expect(list.specs.map((s) => s.path)).toEqual([
      'docs/specs/BRK-12-age.md',
      'docs/specs/BRK-7-sort.md',
      'docs/specs/notes.md',
    ]);
    const brk7 = list.specs.find((s) => s.wid === 'BRK-7');
    expect(brk7).toMatchObject({
      name: 'BRK-7-sort.md',
      title: 'BRK-7 · Sort the inbox',
      status: 'approved',
      tooLarge: false,
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/BRK-7-sort.md',
    });
    const ours = (tasks) => tasks.filter((t) => [first.uuid, second.uuid].includes(t.uuid));
    expect(ours(brk7.tasks)).toEqual([
      { uuid: first.uuid, wid: first.wid, description: 'Sort by age', status: 'pending' },
      { uuid: second.uuid, wid: second.wid, description: 'Show the age', status: 'completed' },
    ]);
    expect(ours(list.specs.find((s) => s.wid === 'BRK-12').tasks)).toEqual([]);
    // Kept for a minute: GitHub isn't asked again, but a task that changes shows at once.
    const before = gh.calls.filter((c) => c === '/graphql').length;
    await api(`tasks/${first.wid}`, { method: 'PATCH', body: { spec: 'docs/specs/BRK-12-age.md' } });
    const again = await body(await api('specs?repo=widgets'));
    expect(gh.calls.filter((c) => c === '/graphql').length).toBe(before);
    expect(ours(again.specs.find((s) => s.wid === 'BRK-12').tasks).map((t) => t.uuid)).toEqual([first.uuid]);
    expect(ours(again.specs.find((s) => s.wid === 'BRK-7').tasks).map((t) => t.uuid)).toEqual([second.uuid]);
  });

  it('reads one spec: its Markdown, the commit that last changed it, its link, and its tasks', async () => {
    const add = await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md' }],
      }),
    );
    const spec = await body(await api('specs/docs/specs/BRK-7-sort.md'));
    expect(spec).toMatchObject({
      code: 200,
      slug: 'widgets',
      dir: 'docs/specs',
      path: 'docs/specs/BRK-7-sort.md',
      wid: 'BRK-7',
      title: 'BRK-7 · Sort the inbox',
      status: 'approved',
      text: BRK_7,
      tooLarge: false,
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/BRK-7-sort.md',
      commit: {
        sha: 'abc1234',
        url: 'https://github.com/acme/widgets/commit/abc1234',
        date: '2026-10-01T10:00:00Z',
        message: 'BRK-7: Write the spec',
      },
    });
    expect(spec.tasks.map((t) => t.uuid)).toContain(add.tasks[0].uuid);
    // The directory's introduction reads the same way.
    expect((await body(await api('specs/docs/specs/README.md'))).text).toBe(README);
    const before = gh.calls.length;
    expect((await api('specs/docs/specs/BRK-7-sort.md')).status).toBe(200);
    expect(gh.calls.length).toBe(before);
  });

  it('refuses a path outside the specs directory, and says when a spec isn’t there', async () => {
    for (const path of [
      'src/worker.js',
      'docs/specs/drafts/BRK-8.md',
      'docs/specs/..%2F..%2Fsrc%2Fworker.js',
      'docs/specs/notes.txt',
    ]) {
      const res = await body(await api(`specs/${path}`));
      expect(res.code, path).toBe(400);
      expect(res.error).toMatch(/isn’t a Markdown file in docs\/specs/u);
    }
    const missing = await body(await api('specs/docs/specs/BRK-99-nope.md'));
    expect(missing).toMatchObject({ code: 404, error: 'no spec at docs/specs/BRK-99-nope.md on main' });
    expect(gh.calls.some((c) => c.includes('worker.js'))).toBe(false);
  });

  it('reads the directory the repository’s settings name', async () => {
    await api('repos/widgets', { method: 'PATCH', body: { settings: { specs: 'design' } } });
    gh.dir = 'design';
    try {
      const list = await body(await api('specs'));
      expect(list).toMatchObject({ code: 200, dir: 'design', missing: false });
      expect(list.specs[0].path).toBe('design/BRK-12-age.md');
      expect((await body(await api('specs/design/BRK-7-sort.md'))).text).toBe(BRK_7);
      expect((await api('specs/docs/specs/BRK-7-sort.md')).status).toBe(400);
    } finally {
      await api('repos/widgets', { method: 'PATCH', body: { settings: null } });
    }
  });

  it('answers an empty list with missing when the directory isn’t there, and doesn’t keep that', async () => {
    gh.dir = 'elsewhere';
    const list = await body(await api('specs'));
    expect(list).toMatchObject({ code: 200, dir: 'docs/specs', missing: true, readme: null, specs: [] });
    gh.dir = 'docs/specs';
    expect((await body(await api('specs'))).specs).toHaveLength(3);
  });

  it('lists a file over 1 MB without reading it, and links to GitHub for it', async () => {
    gh.files['BRK-30-huge.md'] = { size: 2_000_000 };
    const list = await body(await api('specs'));
    expect(list.specs.find((s) => s.wid === 'BRK-30')).toMatchObject({
      title: 'BRK-30-huge',
      status: null,
      size: 2_000_000,
      tooLarge: true,
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/BRK-30-huge.md',
    });
    const one = await body(await api('specs/docs/specs/BRK-30-huge.md'));
    expect(one).toMatchObject({
      code: 200,
      tooLarge: true,
      text: null,
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/BRK-30-huge.md',
    });
  });

  it('says what failed when GitHub can’t read the repository', async () => {
    gh.fail = [403, 'Resource not accessible by integration'];
    const list = await body(await api('specs'));
    expect(list).toMatchObject({ code: 502, error: 'Resource not accessible by integration', github: 403 });
    const one = await body(await api('specs/docs/specs/BRK-7-sort.md'));
    expect(one).toMatchObject({ code: 502, error: 'Resource not accessible by integration', github: 403 });
  });

  it('asks to connect GitHub when it isn’t, and 404s an unknown repository', async () => {
    const res = await runInDurableObject(stub(), async (s) => {
      const saved = s.env.TASKS_GITHUB_APP_ID;
      s.env.TASKS_GITHUB_APP_ID = 'unset';
      try {
        return [await s.specsApi(), await s.specApi(null, 'docs/specs/BRK-7-sort.md')];
      } finally {
        s.env.TASKS_GITHUB_APP_ID = saved;
      }
    });
    for (const r of res) expect(r).toMatchObject({ status: 409, body: { error: 'Connect GitHub to read the specs' } });
    expect(gh.calls).toEqual([]);
    expect((await api('specs?repo=nope')).status).toBe(404);
  });

  it('never stores a spec', async () => {
    await body(await api('specs/docs/specs/BRK-7-sort.md'));
    await body(await api('specs'));
    const stored = await runInDurableObject(stub(), (s) =>
      s.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name)
        .filter((name) => {
          const rows = s.sql.exec(`SELECT * FROM "${name}"`).toArray();
          return rows.some((row) => JSON.stringify(row).includes('It’s unsorted'));
        }),
    );
    expect(stored).toEqual([]);
  });
});
