import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BOARD_FILES from '../src/board-files.json';
import { initPlan, promptSections } from '../src/init.js';
import { promptPlaceholders } from '../src/wizard.js';
import { BREAKAWAY_REPO } from '../src/updates.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';

// Add the board's files (BRK-132): the owner's press writes an empty repository's first commit through the App.
const ALL = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'write',
  deployments: 'read',
  vulnerability_alerts: 'read',
};
const REPO = '/repos/acme/gadgets';
const PROMPT = 'tools/tasks/routine-prompt.md';
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const encode = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** A pretend GitHub for acme/gadgets: empty until something is written, then the files of its branch's commit. */
const gh = {};
function mockGitHub() {
  Object.assign(gh, { head: null, files: new Map(), commits: [], writes: [], trees: [], raceOnPut: false });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const sent = init.body ? JSON.parse(init.body) : null;
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === '/app') return reply({ id: 424242, slug: 'widgets-tasks', name: 'widgets tasks' });
    if (path === `${REPO}/installation`)
      return reply({ id: 92, permissions: { ...ALL }, suspended_at: null, html_url: 'https://github.com/x' });
    if (path === '/app/installations/92/access_tokens')
      return reply({ token: 'ghs_init', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === REPO) return reply({ full_name: 'acme/gadgets', allow_auto_merge: true });
    if (path === '/rate_limit')
      return reply({ resources: { core: { limit: 5000, remaining: 4999, reset: 1_790_000_000 } } });
    const rest = path.slice(REPO.length);
    if (method !== 'GET') gh.writes.push([method, rest]);
    const empty = () => reply({ message: 'Git Repository is empty.' }, 409);

    if (rest === '/commits' && method === 'GET') {
      if (!gh.head) return empty();
      return reply(
        gh.commits.map((c) => ({
          sha: c.sha,
          html_url: `https://github.com/acme/gadgets/commit/${c.sha}`,
          commit: { message: c.message, committer: { date: '2026-10-04T10:00:00Z' } },
        })),
      );
    }
    if (rest.startsWith('/contents/') && method === 'PUT') {
      const file = decodeURIComponent(rest.slice('/contents/'.length));
      if (gh.files.has(file)) return reply({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, 422);
      if (gh.raceOnPut) gh.head = 'someone-else';
      const parents = gh.head ? [{ sha: gh.head }] : [];
      gh.head = `boot-${gh.commits.length}`;
      gh.files.set(file, { content: decode(sent.content), mode: '100644' });
      gh.commits.unshift({ sha: gh.head, message: sent.message, parents });
      return reply({ content: { path: file }, commit: { sha: gh.head, parents } }, 201);
    }
    if (rest.startsWith('/contents/') && method === 'GET') {
      if (!gh.head) return empty();
      const file = gh.files.get(decodeURIComponent(rest.slice('/contents/'.length)));
      return file
        ? reply({ content: encode(file.content), html_url: `https://github.com/acme/gadgets/blob/main/${PROMPT}` })
        : reply({ message: 'Not Found' }, 404);
    }
    if (rest === '/git/trees' && method === 'POST') {
      gh.trees.push(sent);
      return reply({ sha: `tree-${gh.trees.length}` }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      gh.made = { ...sent, sha: 'first-commit' };
      return reply({ sha: 'first-commit', html_url: 'https://github.com/acme/gadgets/commit/first-commit' }, 201);
    }
    if (rest === '/git/ref/heads/main' && method === 'GET') return reply({ object: { sha: gh.head } });
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      expect(sent.force).toBe(true);
      const tree = gh.trees.at(-1);
      gh.head = sent.sha;
      gh.files = new Map(tree.tree.map((e) => [e.path, { content: e.content, mode: e.mode }]));
      gh.commits = [{ sha: sent.sha, message: gh.made.message, parents: gh.made.parents }];
      return reply({ object: { sha: sent.sha } });
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

/** The signed-in browser's press, with the cookie from /login. */
async function press(slug, payload = {}) {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const res = await SELF.fetch(`${ORIGIN}/api/repos/${slug}/init`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { code: res.status, ...(await res.json()) };
}

/** A store with acme/gadgets registered, found empty by its last sync. */
async function withGadgets(name, fn) {
  await runInDurableObject(env.STORE.get(env.STORE.idFromName(name)), async (s) => {
    const added = await s.reposAddApi({ slug: 'gadgets', github: 'acme/gadgets', areas: ['app:GDG'], by: 'owner' });
    expect(added.status).toBe(201);
    s.setGhMeta('gh_empty', 'gadgets', 1);
    s.setGhMeta('gh_last_sync', 'gadgets', Date.now());
    try {
      await fn(s);
    } finally {
      // The sync the press schedules would reach past the pretend GitHub.
      await s.ctx.storage.deleteAlarm();
    }
  });
}

describe('Add the board’s files', () => {
  let spy;
  beforeEach(() => {
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  it('makes one commit on an empty repository with the files repos init adds, and the wizard ticks', async () => {
    await withGadgets('init-empty', async (s) => {
      const step = async (id) => {
        const res = await s.repoSetupApi({ slug: 'gadgets', check: true });
        return res.body.steps.find((x) => x.id === id);
      };
      expect((await step('init')).done).toBe(false);

      const res = await s.boardFilesApi('gadgets', { by: 'owner', origin: ORIGIN });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ slug: 'gadgets', branch: 'main', commit: { sha: 'first-commit' } });

      // One commit on main, with no parent: the contents API's first file is replaced, not built on.
      expect(gh.commits).toHaveLength(1);
      expect(gh.made.parents).toEqual([]);
      expect(gh.made.message).toMatch(
        /^Set up the task board's agent files\n\n.+Added by the board, through its GitHub App\.$/su,
      );
      expect(gh.writes.map(([method, path]) => `${method} ${path}`)).toEqual([
        'PUT /contents/.gitignore',
        'POST /git/trees',
        'POST /git/commits',
        'PATCH /git/refs/heads/main',
      ]);

      // The same files as repos init's for the same slug, from the board's own copy of them.
      const repo = s.repoBySlug('gadgets');
      const plan = initPlan({
        repo,
        board: BREAKAWAY_REPO,
        url: ORIGIN,
        read: (path) => BOARD_FILES[path],
        readTarget: () => null,
        ...promptSections({}),
      });
      expect([...gh.files.keys()].sort()).toEqual(plan.files.map((f) => f.path).sort());
      expect(res.body.files).toEqual(plan.files.map((f) => f.path));
      for (const f of plan.files) expect(gh.files.get(f.path).content, f.path).toBe(f.link ?? f.content);
      expect(gh.files.get('scripts/task').mode).toBe('100755');
      expect(gh.files.get('.claude/skills')).toEqual({ content: '../.agents/skills', mode: '120000' });
      expect(gh.files.get('tools/tasks/prompts/core.md').content).toBe(BOARD_FILES['prompts/core.md']);
      expect(gh.files.get('.taskrc').content).toContain(`sync.server.url=${ORIGIN}\n`);
      expect(gh.files.get('AGENTS.md').content).toContain("This repository's tasks are in the areas app (`GDG`)");
      // The prompt's sections took their defaults, so nothing is left for an agent to mistake for an instruction.
      expect(promptPlaceholders(gh.files.get(PROMPT).content)).toEqual([]);

      // The wizard's init and prompt steps tick from it.
      expect((await step('init')).done).toBe(true);
      expect((await step('prompt')).done).toBe(true);

      // A second press finds commits there.
      gh.writes = [];
      const again = await s.boardFilesApi('gadgets', { origin: ORIGIN });
      expect(again).toMatchObject({ status: 409, body: { command: 'npx breakaway repos init gadgets' } });
      expect(gh.writes).toEqual([]);
    });
  });

  it('refuses a repository with any commit, with the command to run, and writes nothing', async () => {
    await withGadgets('init-not-empty', async (s) => {
      gh.head = 'theirs';
      gh.commits = [{ sha: 'theirs', message: 'Initial commit', parents: [] }];
      gh.files.set('README.md', { content: '# gadgets\n', mode: '100644' });
      const res = await s.boardFilesApi('gadgets', { origin: ORIGIN });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        'acme/gadgets already has commits, so the board doesn’t write to it. Run npx breakaway repos init gadgets: it adds the files in a pull request.',
      );
      expect(res.body.command).toBe('npx breakaway repos init gadgets');
      expect(gh.writes).toEqual([]);
    });
  });

  it('stops after the first file when a commit lands on the branch meanwhile', async () => {
    await withGadgets('init-race', async (s) => {
      gh.raceOnPut = true;
      const res = await s.boardFilesApi('gadgets', { origin: ORIGIN });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(
        /got a commit while the board was adding its files, so it stopped after \.gitignore/u,
      );
      expect(gh.writes.map(([method]) => method)).toEqual(['PUT']);
    });
  });

  it('refuses the bearer token and an agent, and a repository it doesn’t know', async () => {
    const bearer = await api('repos/widgets/init', { method: 'POST', body: {} });
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).error).toMatch(/only the signed-in web board can add the board’s files/u);
    expect(await press('widgets', { by: 'claude-x' })).toMatchObject({ code: 403, error: /only the owner/u });
    expect(await press('nope')).toMatchObject({ code: 404 });
    expect(gh.writes).toEqual([]);
  });
});
