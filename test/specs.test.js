import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { specLines, specListLines, specRequest, specsRequest } from '../scripts/tasks/cli.js';
import {
  NEXT_STATUS,
  builtDetail,
  checkSpecsDir,
  inSpecsDir,
  nextStatus,
  readStatus,
  specDate,
  specMeta,
  specsDirOf,
  withStatus,
} from '../src/specs.js';
import { linkedWids } from '../src/github.js';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

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
  failWrites: null, // [status, message] for every write
  calls: [],
  head: 'head1', // main's commit
  branches: new Set(), // branches there besides main
  pulls: [], // open pull requests: { number, head, html_url }
  writes: [], // { method, path, body } for each write, in order
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
    const method = init.method ?? 'GET';
    if (method !== 'GET' && path !== '/graphql') {
      const sent = init.body ? JSON.parse(init.body) : null;
      gh.writes.push({ method, path, body: sent });
      if (gh.failWrites) return reply({ message: gh.failWrites[1] }, gh.failWrites[0]);
      if (method === 'POST' && path === '/repos/acme/widgets/git/refs') {
        const branch = sent.ref.replace(/^refs\/heads\//u, '');
        if (gh.branches.has(branch)) return reply({ message: 'Reference already exists' }, 422);
        gh.branches.add(branch);
        return reply({ ref: sent.ref, object: { sha: sent.sha } }, 201);
      }
      if (method === 'PATCH' && path.startsWith('/repos/acme/widgets/git/refs/heads/'))
        return reply({ object: { sha: sent.sha } });
      if (method === 'PUT' && path.startsWith('/repos/acme/widgets/contents/'))
        return reply({ commit: { sha: 'commit1' } }, 201);
      if (method === 'POST' && path === '/repos/acme/widgets/pulls') {
        const pull = { number: 99, head: sent.head, html_url: 'https://github.com/acme/widgets/pull/99' };
        gh.pulls.push(pull);
        return reply(pull, 201);
      }
      return reply({ message: 'Not Found' }, 404);
    }
    if (path === '/repos/acme/widgets/git/ref/heads/main') return reply({ object: { sha: gh.head } });
    if (path === '/repos/acme/widgets/pulls') {
      const head = url.searchParams.get('head');
      return reply(gh.pulls.filter((p) => `acme:${p.head}` === head));
    }
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
    if (m && ['main', gh.head].includes(url.searchParams.get('ref'))) {
      const name = decodeURIComponent(m[1]).slice(gh.dir.length + 1);
      const f = gh.files[name];
      if (f === undefined) return reply({ message: 'Not Found' }, 404);
      const html_url = `https://github.com/acme/widgets/blob/main/${gh.dir}/${name}`;
      const sha = `sha-${name}`;
      return typeof f === 'string'
        ? reply({ type: 'file', sha, size: encoder.encode(f).length, encoding: 'base64', content: b64(f), html_url })
        : reply({ type: 'file', sha, size: f.size, encoding: 'none', content: '', html_url });
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

  it('moves a status one step: draft to approved, approved to built, and no further', () => {
    expect(NEXT_STATUS).toEqual({ draft: 'approved', approved: 'built' });
    expect(NEXT_STATUS.built).toBeUndefined();
    expect(nextStatus('draft')).toBe('approved');
    expect(nextStatus('built')).toBeNull();
    expect(nextStatus('constructor')).toBeNull();
  });

  it('reads the status line under the title, with what its brackets say', () => {
    expect(readStatus(BRK_7)).toEqual({ status: 'approved', detail: '1 Oct 2026' });
    expect(readStatus(BRK_12)).toEqual({ status: 'draft', detail: null });
    expect(readStatus('# X\n\n**Status:** Draft (started)\n')).toEqual({ status: 'draft', detail: 'started' });
    expect(readStatus(NOTES)).toBeNull();
    expect(readStatus('# X\n\nNo status here.\n\nStatus: draft\n')).toBeNull();
  });

  it('changes only the status on the line under the title, keeping the rest of the file', () => {
    expect(withStatus(BRK_12, 'approved', '5 Oct 2026, by the owner')).toBe(
      BRK_12.replace('Status: draft', 'Status: approved (5 Oct 2026, by the owner)'),
    );
    expect(withStatus(BRK_7, 'built', '#41; approved 1 Oct 2026')).toBe(
      BRK_7.replace('Status: approved (1 Oct 2026)', 'Status: built (#41; approved 1 Oct 2026)'),
    );
    expect(withStatus('# X\n\n**Status:** draft. More after it.\n', 'approved', 'today')).toBe(
      '# X\n\n**Status:** approved (today). More after it.\n',
    );
    // Windows line endings stay, and a later Status: in the body is never touched.
    expect(withStatus('# X\r\n\r\nStatus: draft\r\n\r\nStatus: draft\r\n', 'approved', 'd')).toBe(
      '# X\r\n\r\nStatus: approved (d)\r\n\r\nStatus: draft\r\n',
    );
    expect(withStatus(NOTES, 'approved', 'd')).toBeNull();
  });

  it('says when a spec was approved, and which pull requests built it', () => {
    expect(specDate(Date.UTC(2026, 8, 29, 23, 30))).toBe('29 Sep 2026');
    expect(specDate(Date.UTC(2026, 9, 5))).toBe('5 Oct 2026');
    expect(builtDetail([42, 41, 42], '1 Oct 2026, by the owner', Date.UTC(2026, 9, 5))).toBe(
      '#41, #42; approved 1 Oct 2026, by the owner',
    );
    expect(builtDetail([7], null, Date.UTC(2026, 9, 5))).toBe('#7');
    expect(builtDetail([], null, Date.UTC(2026, 9, 5))).toBe('as of 5 Oct 2026');
    expect(builtDetail([], '1 Oct 2026', Date.UTC(2026, 9, 5))).toBe('as of 5 Oct 2026; approved 1 Oct 2026');
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
          { description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md', force: true },
          { description: 'Show the age', project: 'cloud', spec: './docs/specs/BRK-7-sort.md', force: true },
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
        body: [{ description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md', force: true }],
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

  it('takes the CLI’s requests: specs and specs show <path>, and prints what the board answers', async () => {
    await api('tasks', {
      method: 'POST',
      body: [{ description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md', force: true }],
    });
    const [method, path] = specsRequest('widgets');
    const list = await api(path, { method });
    expect(list.status).toBe(200);
    const lines = specListLines(await list.json());
    expect(lines[0]).toBe('widgets: 3 specs in docs/specs (its introduction is docs/specs/README.md)');
    expect(lines.find((l) => l.includes('BRK-7 · Sort the inbox'))).toMatch(
      /^ {2}BRK-7 +approved +.*\(\d+ tasks?, \d+ open\)$/u,
    );

    const built = specRequest('./docs/specs/BRK-7-sort.md', 'widgets');
    const one = await api(built.request[1], { method: built.request[0] });
    expect(one.status).toBe(200);
    const out = specLines(await one.json()).join('\n');
    expect(out).toContain('BRK-7 · Sort the inbox (docs/specs/BRK-7-sort.md)');
    expect(out).toContain('  Changed     2026-10-01 10:00 in abc1234: BRK-7: Write the spec');
    expect(out).toContain('It’s unsorted.');
    expect(out).toMatch(/Sort by age/u);

    // What the board refuses comes back as its error, which the CLI prints.
    const outside = specRequest('src/worker.js', 'widgets');
    const refused = await body(await api(outside.request[1], { method: 'GET' }));
    expect(refused).toMatchObject({ code: 400, error: 'src/worker.js isn’t a Markdown file in docs/specs' });
    gh.files = {};
    await runInDurableObject(stub(), (store) => {
      store.specsCache = {};
    });
    expect(specListLines(await (await api(specsRequest('widgets')[1])).json())[0]).toMatch(
      /^No specs in docs\/specs yet/u,
    );
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

describe('marking a spec approved or built (BRK-215)', () => {
  let spy;
  let cookie;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
  });
  beforeEach(async () => {
    spy = mockGitHub();
    gh.dir = 'docs/specs';
    gh.files = { 'BRK-7-sort.md': BRK_7, 'BRK-12-age.md': BRK_12, 'notes.md': NOTES };
    Object.assign(gh, { fail: null, failWrites: null, calls: [], head: 'head1', pulls: [], writes: [] });
    gh.branches = new Set();
    await runInDurableObject(stub(), (store) => {
      store.specsCache = {};
    });
  });
  afterEach(() => spy.mockRestore());

  const mark = async (path, status, { token = false } = {}) =>
    body(
      token
        ? await api(`specs/${path}`, { method: 'POST', body: { status } })
        : await SELF.fetch(`${ORIGIN}/api/specs/${path}`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          }),
    );
  const committed = () => {
    const put = gh.writes.find((w) => w.method === 'PUT');
    return new TextDecoder().decode(Uint8Array.from(atob(put.body.content), (c) => c.charCodeAt(0)));
  };

  it('opens a pull request that marks a draft spec approved, changing only its status line', async () => {
    const res = await mark('docs/specs/BRK-12-age.md', 'approved');
    expect(res).toMatchObject({
      code: 201,
      slug: 'widgets',
      path: 'docs/specs/BRK-12-age.md',
      from: 'draft',
      status: 'approved',
      branch: 'spec-status/BRK-12-age-approved',
      pull: { number: 99, url: 'https://github.com/acme/widgets/pull/99' },
    });
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /repos/acme/widgets/git/refs',
      'PUT /repos/acme/widgets/contents/docs/specs/BRK-12-age.md',
      'POST /repos/acme/widgets/pulls',
    ]);
    const [ref, put, pull] = gh.writes;
    expect(ref.body).toEqual({ ref: 'refs/heads/spec-status/BRK-12-age-approved', sha: 'head1' });
    expect(put.body).toMatchObject({ branch: 'spec-status/BRK-12-age-approved', sha: 'sha-BRK-12-age.md' });
    expect(committed()).toMatch(
      /^Task: `BRK-12` on the board · Status: approved \(\d{1,2} [A-Z][a-z]{2} \d{4}, by the owner\)$/mu,
    );
    expect(committed().replace(/Status: approved \([^)]*\)/u, 'Status: draft')).toBe(BRK_12);
    expect(pull.body).toMatchObject({ head: 'spec-status/BRK-12-age-approved', base: 'main' });
    expect(pull.body.title).toBe('BRK-12: Mark its spec approved');
    // It closes no task, the spec's own included.
    expect(linkedWids({ title: pull.body.title, body: pull.body.body }).closes).toEqual([]);
    expect(pull.body.body).toMatch(/Mark approved/u);
  });

  it('marks an approved spec built, naming the merged pull requests of the tasks that link it', async () => {
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Sort by age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md', force: true },
          { description: 'Show the age', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md', force: true },
          { description: 'Still open', project: 'cloud', spec: 'docs/specs/BRK-7-sort.md' },
        ],
      }),
    );
    const [a, b] = created.tasks;
    for (const [t, pr] of [
      [a, '42'],
      [b, '41'],
    ])
      expect((await api(`tasks/${t.uuid}`, { method: 'PATCH', body: { status: 'completed', pr } })).status).toBe(200);
    const res = await mark('docs/specs/BRK-7-sort.md', 'built');
    expect(res).toMatchObject({ code: 201, from: 'approved', status: 'built', branch: 'spec-status/BRK-7-sort-built' });
    expect(committed()).toContain('Status: built (#41, #42; approved 1 Oct 2026)\n');
  });

  it('answers with the open pull request when pressed again, and starts a branch a closed one left again', async () => {
    gh.pulls = [
      { number: 98, head: 'spec-status/BRK-12-age-approved', html_url: 'https://github.com/acme/widgets/pull/98' },
    ];
    const again = await mark('docs/specs/BRK-12-age.md', 'approved');
    expect(again).toMatchObject({ code: 200, existing: true, pull: { number: 98 } });
    expect(gh.writes).toEqual([]);

    gh.pulls = [];
    gh.branches.add('spec-status/BRK-12-age-approved');
    const fresh = await mark('docs/specs/BRK-12-age.md', 'approved');
    expect(fresh).toMatchObject({ code: 201, pull: { number: 99 } });
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /repos/acme/widgets/git/refs',
      'PATCH /repos/acme/widgets/git/refs/heads/spec-status/BRK-12-age-approved',
      'PUT /repos/acme/widgets/contents/docs/specs/BRK-12-age.md',
      'POST /repos/acme/widgets/pulls',
    ]);
    expect(gh.writes[1].body).toEqual({ sha: 'head1', force: true });
  });

  it('refuses a step the spec isn’t at, a status it can’t take, a spec with no status line, and a path outside the directory', async () => {
    const early = await mark('docs/specs/BRK-12-age.md', 'built');
    expect(early.code).toBe(409);
    expect(early.error).toMatch(/BRK-12-age.md is draft on main, so it’s marked approved first/u);
    const twice = await mark('docs/specs/BRK-7-sort.md', 'approved');
    expect(twice.code).toBe(409);
    expect(twice.error).toMatch(/already approved/u);
    const odd = await mark('docs/specs/BRK-12-age.md', 'shipped');
    expect(odd.code).toBe(400);
    expect(odd.error).toMatch(/approved or built/u);
    const bare = await mark('docs/specs/notes.md', 'approved');
    expect(bare.code).toBe(409);
    expect(bare.error).toMatch(/no Status: line under its title/u);
    const outside = await mark('src/worker.js', 'approved');
    expect(outside.code).toBe(400);
    const gone = await mark('docs/specs/BRK-99-gone.md', 'approved');
    expect(gone.code).toBe(404);
    expect(gh.writes).toEqual([]);
  });

  it('is the owner’s press: the bearer token gets 403 and writes nothing', async () => {
    const res = await mark('docs/specs/BRK-12-age.md', 'approved', { token: true });
    expect(res.code).toBe(403);
    expect(res.error).toMatch(/only the signed-in web board/u);
    expect(gh.writes).toEqual([]);
  });

  it('says what failed when GitHub refuses the write', async () => {
    gh.failWrites = [403, 'Resource not accessible by integration'];
    const res = await mark('docs/specs/BRK-12-age.md', 'approved');
    expect(res.code).toBe(502);
    expect(res.error).toMatch(
      /GitHub refused the pull request for docs\/specs\/BRK-12-age.md: Resource not accessible by integration/u,
    );
    expect(res.error).toMatch(/Connections/u);
  });
});
