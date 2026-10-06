import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileDeployPaths, workersFor } from '../src/deploy-paths.js';
import {
  byInbox,
  linkedWids,
  ownLinks,
  prNumberOf,
  prVerdict,
  reviewDecision,
  rollupChecks,
  verifyWebhook,
} from '../src/github.js';
import { ORIGIN, TEST_API_TOKEN, TEST_GITHUB_APP_ID, TEST_GITHUB_WEBHOOK_SECRET } from './constants.js';
/** A description that mentions a task another pull request only planned, and closes the one it finishes. */
const PLAN_BODY = `## What and why

Tracks the work on a task board with a Taskwarrior sync server (\`CLD-24\`).

- **GitHub on the board**: a PR that says \`Closes <ID>.\` puts the task **In review** and finishes it on merge; branch names only mention.
- An old pull request only *planned* the status page, but its branch carried the ID: \`OPS-8\` stays open.

## After merging

Merging this PR finishes \`CLD-24\` on the board by itself.

Closes CLD-24.
`;
import { DEPLOY_PATHS, api, setPipeline } from './helpers.js';

const RULES = compileDeployPaths({ widgets: DEPLOY_PATHS.widgets });
import { shipState } from '../web/src/lib/model.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const encoder = new TextEncoder();

describe('linking pull requests to tasks', () => {
  it('closes only from a sentence or line that starts with Closes, Fixes, or Resolves', () => {
    expect(
      linkedWids({
        title: 'x',
        branch: 'status',
        body: 'Some work.\n\nCloses CLD-24. Follow-ups are CLD-25 and OPS-21.',
      }),
    ).toEqual({ closes: ['CLD-24'], mentions: ['CLD-25', 'OPS-21'] });
    expect(linkedWids({ title: 'Fixes prd-5, PRD-12', branch: 'x', body: 'See DEBT-1' })).toEqual({
      closes: ['PRD-5', 'PRD-12'],
      mentions: ['DEBT-1'],
    });
    expect(
      linkedWids({ title: 'x', branch: 'x', body: 'Done.\n- Resolves: MOD-6 and `MOD-8`\n- Closes `CLD-26`' }),
    ).toEqual({ closes: ['MOD-6', 'MOD-8', 'CLD-26'], mentions: [] });
    expect(linkedWids({ title: 'x', branch: 'claude/brd-5-content-plan', body: 'Closes BRD-5.' })).toEqual({
      closes: ['BRD-5'],
      mentions: [],
    });
  });

  it('never closes from prose, code, quotes, or a branch name', () => {
    const none = (body, branch = 'x') => linkedWids({ title: 'x', branch, body }).closes;
    expect(none('and its first sync finished `OPS-8`: old PR #8 only planned it.')).toEqual([]);
    expect(none('This PR fixes the layout of OPS-8 and closes a gap in OPS-9.')).toEqual([]);
    expect(none('We fixed `OPS-8` yesterday.')).toEqual([]);
    expect(none('> Closes OPS-8')).toEqual([]);
    expect(none('```\nCloses OPS-8\n```')).toEqual([]);
    expect(none('`Closes OPS-8` is how you write it.')).toEqual([]);
    expect(none('Part of OPS-8.')).toEqual([]);
    expect(none('', 'ops-8-status-page')).toEqual([]);
  });

  it('reads a description the way it should have: it closes CLD-24 and only mentions OPS-8', () => {
    const { closes, mentions } = linkedWids({
      title: 'Track work on a task board with a Taskwarrior sync server',
      branch: 'task-server',
      body: PLAN_BODY,
    });
    expect(closes).toEqual(['CLD-24']);
    expect(mentions).toContain('OPS-8');
  });

  it('reads every registered repository’s prefixes, and closes only its own repository’s IDs', () => {
    const prefixes = ['CLD', 'OPS', 'BRK'];
    const linked = linkedWids(
      { title: 'x', branch: 'brk-3-landing', body: 'Closes BRK-3 and CLD-9. See OPS-1 and SHA-256.' },
      prefixes,
    );
    expect(linked).toEqual({ closes: ['BRK-3', 'CLD-9'], mentions: ['OPS-1'] });
    expect(linkedWids({ title: 'x', branch: 'x', body: 'Closes BRK-3.' }).closes).toEqual([]); // widgets's prefixes only
    const owners = new Map([
      ['CLD', 'widgets'],
      ['OPS', 'widgets'],
      ['BRK', 'breakaway'],
    ]);
    expect(ownLinks(linked, 'breakaway', owners)).toEqual({
      closes: ['BRK-3'],
      mentions: ['OPS-1', 'CLD-9'],
      elsewhere: { 'CLD-9': 'widgets', 'OPS-1': 'widgets' },
    });
    expect(ownLinks(linked, 'widgets', owners)).toEqual({
      closes: ['CLD-9'],
      mentions: ['OPS-1', 'BRK-3'],
      elsewhere: { 'BRK-3': 'breakaway' },
    });
  });

  it('finds the PR of a squash or merge commit', () => {
    expect(prNumberOf('Stop menus from being cut off (#28)\n\nbody')).toBe(28);
    expect(prNumberOf('Merge pull request #27 from x/y')).toBe(27);
    expect(prNumberOf('Merge branch main into x')).toBeNull();
  });
});

describe('what needs a deploy', () => {
  it('reads the same file the Deploy workflow does', () => {
    expect(
      workersFor(
        [
          'docs/decisions.md',
          'WORK.md',
          '.agents/skills/tasks/SKILL.md',
          '.github/workflows/ci.yml',
          'scripts/tasks.mjs',
        ],
        RULES,
      ),
    ).toEqual([]);
    expect(workersFor(['docs/runbook.md', 'src/rooms.js'], RULES)).toEqual(['widgets']);
    // The board no longer deploys from widgets (CLD-141, BRK-68): its files need no deploy there.
    expect(workersFor(['tools/tasks/src/store.js'], RULES)).toEqual([]);
    // The board has its own copies of widgets's styles and web push (CLD-135).
    expect(workersFor(['src/app/styles/tokens.css'], RULES)).toEqual(['widgets']);
    expect(workersFor(['src/shared/web-push.js'], RULES)).toEqual(['widgets']);
    expect(workersFor(['tools/tasks/package.json'], RULES)).toEqual([]);
    expect(workersFor(['.github/deploy-paths.json'], RULES)).toEqual(['widgets']);
  });

  it('tells shipped, waiting for a deploy, and no deploy needed apart', () => {
    const done = (github, extra = {}) => ({ status: 'completed', github, ...extra });
    const pr = (workers, extra = {}) => ({ closes: true, state: 'merged', workers, ...extra });
    expect(shipState(done([pr(['widgets'])], { shipped: { version: 'x' } }))).toBe('shipped');
    expect(shipState(done([pr(['widgets'])]))).toBe('unshipped');
    expect(shipState(done([pr(null)]))).toBe('unshipped'); // files not read yet
    expect(shipState(done([pr([])]))).toBe('nodeploy');
    expect(shipState(done([pr([]), pr(['widgets'])]))).toBe('unshipped');
    expect(shipState(done([pr([], { closes: false })]))).toBeNull();
    expect(shipState(done([pr([], { state: 'open' })]))).toBeNull();
    expect(shipState({ status: 'pending', github: [pr([])] })).toBeNull();
    expect(shipState(done([]))).toBeNull();
  });
});

describe('the pull request verdict', () => {
  const ok = { state: 'success' };
  const v = (o) =>
    prVerdict({ checks: ok, review: { decision: 'none' }, mergeable: true, mergeableState: 'clean', ...o });
  it("reads GitHub's mergeable state, then checks and reviews", () => {
    expect(v({})).toBe('ready');
    expect(v({ mergeableState: 'unstable' })).toBe('ready');
    expect(v({ mergeable: false, mergeableState: 'dirty' })).toBe('conflicts');
    expect(v({ checks: { state: 'failure' }, mergeableState: 'blocked' })).toBe('failing');
    expect(v({ mergeableState: 'behind' })).toBe('behind');
    expect(v({ checks: { state: 'pending' }, mergeableState: 'blocked' })).toBe('running');
    expect(v({ mergeableState: 'blocked' })).toBe('review');
    expect(v({ mergeable: null, mergeableState: null })).toBe('unknown');
    expect(v({ draft: true, mergeable: false })).toBe('draft');
  });
  it('sorts what needs the owner first', () => {
    const list = ['running', 'ready', 'behind', 'draft', 'conflicts', 'failing'].map((verdict) => ({ verdict }));
    expect(list.sort(byInbox).map((p) => p.verdict)).toEqual([
      'ready',
      'conflicts',
      'failing',
      'behind',
      'running',
      'draft',
    ]);
  });
});

describe('checks and reviews', () => {
  it('rolls checks up, with the latest run of each name winning', () => {
    const runs = [
      { name: 'Test and build', status: 'completed', conclusion: 'failure' },
      { name: 'Test and build', status: 'completed', conclusion: 'success' },
      { name: 'claude-review', status: 'in_progress', conclusion: null },
    ];
    expect(rollupChecks(runs)).toMatchObject({ state: 'pending', total: 2, passed: 1 });
    expect(
      rollupChecks([{ name: 'a', status: 'completed', conclusion: 'timed_out' }], [{ context: 'b', state: 'success' }]),
    ).toMatchObject({ state: 'failure', total: 2 });
    expect(rollupChecks()).toMatchObject({ state: 'none', total: 0 });
  });

  it("rolls up each check's newest run, so a superseded cancelled run isn't a failure (BRK-170)", () => {
    const cancelled = {
      id: 10,
      name: 'Test and build',
      status: 'completed',
      conclusion: 'cancelled',
      started_at: '2026-10-05T10:00:00Z',
    };
    const running = { id: 11, name: 'Test and build', status: 'in_progress', started_at: '2026-10-05T10:01:00Z' };
    const passed = { ...running, status: 'completed', conclusion: 'success' };
    // GitHub lists check runs newest first, but the order mustn't matter.
    for (const order of [
      [running, cancelled],
      [cancelled, running],
    ]) {
      const r = rollupChecks(order);
      expect(r).toMatchObject({ state: 'pending', total: 1 });
      expect(r.runs[0].state).toBe('in_progress');
    }
    expect(rollupChecks([passed, cancelled])).toMatchObject({ state: 'success', total: 1, passed: 1 });
    expect(rollupChecks([cancelled, passed])).toMatchObject({ state: 'success', total: 1, passed: 1 });
    // Same start time: the higher id is the newer run.
    expect(rollupChecks([{ ...passed, started_at: cancelled.started_at }, cancelled])).toMatchObject({
      state: 'success',
    });
    // A lone cancelled run still fails.
    expect(rollupChecks([cancelled])).toMatchObject({ state: 'failure', total: 1 });
  });

  it("takes each reviewer's latest decision", () => {
    const r = (login, state) => ({ user: { login }, state });
    expect(reviewDecision([r('a', 'CHANGES_REQUESTED'), r('a', 'APPROVED')]).decision).toBe('approved');
    expect(reviewDecision([r('a', 'APPROVED'), r('b', 'CHANGES_REQUESTED')]).decision).toBe('changes_requested');
    expect(reviewDecision([r('a', 'COMMENTED')]).decision).toBe('commented');
  });
});

describe('webhook signatures', () => {
  it('accepts only an HMAC of the exact body', async () => {
    const payload = encoder.encode('{"a":1}');
    const sign = async (secretValue, bytes) => {
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secretValue),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    };
    expect(await verifyWebhook('s3cret', payload, await sign('s3cret', payload))).toBe(true);
    expect(await verifyWebhook('s3cret', payload, await sign('other', payload))).toBe(false);
    expect(await verifyWebhook('s3cret', encoder.encode('{"a":2}'), await sign('s3cret', payload))).toBe(false);
    expect(await verifyWebhook('s3cret', payload, null)).toBe(false);
  });
});

// ---- the whole flow, against a pretend GitHub ------------------------------------------

const REPO = '/repos/acme/widgets';
const gh = {
  pulls: [],
  checks: {},
  reviews: {},
  runs: [],
  commits: [],
  alerts: [],
  alertsStatus: 200,
  deployments: null, // null: the App can't read them
  statuses: {},
  compares: {},
  files: {},
  releases: [],
  tags: [],
  mergeable: {}, // number → [mergeable, mergeable_state]
  fileDetails: {}, // number → GitHub's file objects (with patches)
  contents: {}, // `${sha}:${path}` → a file's text, or { size, encoding: 'none' } for one too large to send
  comments: {},
  calls: [],
  writes: [], // [method, path, body] the board sent
  writeError: null, // [status, message] for the next write
  autoMerge: null,
  prompt: null, // tools/tasks/routine-prompt.md on main
};

function pr(
  number,
  {
    title = `PR ${number}`,
    branch = `branch-${number}`,
    body = '',
    state = 'open',
    merged = false,
    draft = false,
    sha = `sha${number}`,
    updated = '2026-09-29T10:00:00Z',
    mergeSha = null,
  } = {},
) {
  return {
    number,
    title,
    body,
    draft,
    state,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    node_id: `PR_${number}`,
    head: { ref: branch, sha },
    user: { login: 'claude[bot]' },
    created_at: '2026-09-29T09:00:00Z',
    updated_at: updated,
    merge_commit_sha: mergeSha,
    merged_at: merged ? '2026-09-29T11:00:00Z' : null,
    closed_at: state === 'closed' ? '2026-09-29T11:00:00Z' : null,
  };
}

async function verifyJwt(authorization) {
  const [h, p, sig] = authorization.replace('Bearer ', '').split('.');
  const der = Uint8Array.from(
    atob(env.TEST_GITHUB_PUBLIC_KEY.replace(/-----[^-]+-----/gu, '').replace(/\s+/gu, '')),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const bytes = Uint8Array.from(atob(sig.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, encoder.encode(`${h}.${p}`));
  const claims = JSON.parse(atob(p.replaceAll('-', '+').replaceAll('_', '/')));
  return valid && claims.iss === TEST_GITHUB_APP_ID;
}

// A second registered repository, with its own pull requests (numbered on their own) and a switch to make it fail.
const OTHER = '/repos/acme/scratch';
const other = { pulls: [], fail: null, deployPaths: null, prompt: null, empty: false };

async function otherRepo(rest, auth, reply) {
  if (rest === '/installation')
    return (await verifyJwt(auth)) ? reply({ id: 88 }) : reply({ message: 'Bad credentials' }, 401);
  if (auth !== 'Bearer ghs_test') return reply({ message: 'Bad credentials' }, 401);
  if (other.fail) return reply({ message: other.fail[1] }, other.fail[0]);
  // GitHub's answer for a repository with no commits yet (CLD-191).
  if (other.empty && (rest === '/commits' || rest.startsWith('/contents/')))
    return reply({ message: 'Git Repository is empty.' }, 409);
  if (rest === '/pulls') return reply(other.pulls);
  if (rest === '/contents/agents/prompt.md')
    return other.prompt === null
      ? reply({ message: 'Not Found' }, 404)
      : reply({
          content: btoa(other.prompt),
          encoding: 'base64',
          html_url: 'https://github.com/acme/scratch/blob/main/agents/prompt.md',
        });
  if (rest.startsWith('/contents/'))
    return other.deployPaths
      ? reply({ content: btoa(JSON.stringify(other.deployPaths)), encoding: 'base64' })
      : reply({ message: 'Not Found' }, 404);
  if (rest === '/actions/runs') return reply({ workflow_runs: [] });
  if (['/commits', '/dependabot/alerts', '/deployments', '/releases', '/tags'].includes(rest)) return reply([]);
  if (/^\/commits\/[^/]+\/check-runs$/u.test(rest))
    return reply({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });
  if (/^\/commits\/[^/]+\/status$/u.test(rest)) return reply({ state: 'success', statuses: [] });
  let m = /^\/pulls\/(\d+)$/u.exec(rest);
  if (m) {
    const found = other.pulls.find((p) => String(p.number) === m[1]);
    return found
      ? reply({
          ...found,
          mergeable: true,
          mergeable_state: 'clean',
          commits: 1,
          changed_files: 1,
          base: { ref: 'main' },
        })
      : reply({ message: 'Not Found' }, 404);
  }
  m = /^\/pulls\/(\d+)\/(reviews|comments)$/u.exec(rest);
  if (m) return reply([]);
  m = /^\/pulls\/(\d+)\/files$/u.exec(rest);
  if (m)
    return reply([
      { filename: 'src/index.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' },
    ]);
  return reply({ message: 'Not Found' }, 404);
}

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    gh.calls.push(path);
    if (init.method && init.method !== 'GET' && !path.startsWith('/app/')) {
      if (auth !== 'Bearer ghs_test') return reply({ message: 'Bad credentials' }, 401);
      gh.writes.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      if (gh.writeError) {
        const [status, message] = gh.writeError;
        gh.writeError = null;
        return reply({ message }, status);
      }
      return path === '/graphql' ? reply({ data: {} }) : reply({ merged: true, message: 'ok' });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path.startsWith(`${OTHER}/`)) return otherRepo(path.slice(OTHER.length), auth, reply);
    if (path === `${REPO}/installation` || path.startsWith('/app/installations/')) {
      if (!(await verifyJwt(auth))) return reply({ message: 'Bad credentials' }, 401);
      return path.endsWith('/installation')
        ? reply({ id: 77 })
        : reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (auth !== 'Bearer ghs_test') return reply({ message: 'Bad credentials' }, 401);
    if (path === `${REPO}/pulls`) return reply(gh.pulls);
    if (path === `${REPO}/actions/runs`) return reply({ workflow_runs: gh.runs });
    if (path === `${REPO}/commits`) return reply(gh.commits);
    if (path === `${REPO}/dependabot/alerts`)
      return gh.alertsStatus === 200
        ? reply(gh.alerts)
        : reply({ message: 'Resource not accessible by integration' }, gh.alertsStatus);
    if (path === `${REPO}/deployments`)
      return gh.deployments ? reply(gh.deployments) : reply({ message: 'Resource not accessible by integration' }, 403);
    if (path === `${REPO}/releases`) return reply(gh.releases);
    if (path === `${REPO}/tags`) return reply(gh.tags);
    if (path === `${REPO}/contents/.github/deploy-paths.json`)
      return reply({ content: btoa(JSON.stringify({ widgets: DEPLOY_PATHS.widgets })), encoding: 'base64' });
    if (path === `${REPO}/contents/tools/tasks/routine-prompt.md`) {
      if (gh.prompt === null || url.searchParams.get('ref') !== 'main') return reply({ message: 'Not Found' }, 404);
      const bytes = encoder.encode(gh.prompt);
      return reply({
        content: btoa(String.fromCharCode(...bytes)).replace(/(.{60})/gu, '$1\n'),
        encoding: 'base64',
        html_url: 'https://github.com/acme/widgets/blob/main/tools/tasks/routine-prompt.md',
      });
    }
    if (path.startsWith(`${REPO}/contents/`)) {
      const file = gh.contents[`${url.searchParams.get('ref')}:${decodeURIComponent(path.slice(REPO.length + 10))}`];
      if (file === undefined) return reply({ message: 'Not Found' }, 404);
      if (typeof file !== 'string') return reply({ type: 'file', content: '', ...file });
      const bytes = encoder.encode(file);
      return reply({
        type: 'file',
        size: bytes.length,
        encoding: 'base64',
        content: btoa(String.fromCharCode(...bytes)),
      });
    }
    let m = /\/deployments\/(\d+)\/statuses$/u.exec(path);
    if (m) return reply(gh.statuses[m[1]] ?? []);
    m = /\/compare\/([^/]+)\.\.\.([^/]+)$/u.exec(path);
    if (m) return reply({ commits: gh.compares[`${m[1]}...${m[2]}`] ?? [] });
    m = /\/commits\/([^/]+)\/check-runs$/u.exec(path);
    if (m) return reply({ check_runs: gh.checks[m[1]] ?? [] });
    m = /\/commits\/([^/]+)\/status$/u.exec(path);
    if (m) return reply({ state: 'success', statuses: [] });
    m = /\/pulls\/(\d+)$/u.exec(path);
    if (m) {
      const [mergeable, state] = gh.mergeable[m[1]] ?? [true, 'clean'];
      const found = gh.pulls.find((p) => String(p.number) === m[1]);
      return found
        ? reply({
            ...found,
            mergeable,
            mergeable_state: state,
            commits: 2,
            changed_files: (gh.fileDetails[m[1]] ?? []).length,
            base: { ref: 'main', sha: `base${m[1]}` },
          })
        : reply({ message: 'Not Found' }, 404);
    }
    m = /\/pulls\/(\d+)\/comments$/u.exec(path);
    if (m) return reply(gh.comments[m[1]] ?? []);
    m = /\/pulls\/(\d+)\/files$/u.exec(path);
    if (m && gh.fileDetails[m[1]]) return reply(gh.fileDetails[m[1]]);
    if (m)
      return gh.files[m[1]]
        ? reply(gh.files[m[1]].map((filename) => ({ filename })))
        : reply({ message: 'Not Found' }, 404);
    m = /\/pulls\/(\d+)\/reviews$/u.exec(path);
    if (m) return reply(gh.reviews[m[1]] ?? []);
    return reply({ message: 'Not Found' }, 404);
  });
}

async function webhook(event, payload, secretValue = TEST_GITHUB_WEBHOOK_SECRET) {
  const bytes = encoder.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretValue),
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

describe('GitHub on the board', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    await setPipeline();
  });
  afterEach(() => spy.mockRestore());

  it('reads PRs, checks, reviews, runs, commits, and alerts, and links PRs to tasks', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Build the GitHub view', project: 'cloud', tags: ['agent'] },
        { description: 'Tidy alerts', project: 'ops', tags: ['owner'] },
      ],
    });
    gh.pulls = [
      pr(10, { branch: 'cld-1-github-view', body: 'Closes CLD-1. Mentions OPS-1.' }),
      // Merged before the board was connected: recorded, but it must not finish OPS-1.
      pr(9, {
        title: 'Plan the alert tidy-up',
        body: 'Closes OPS-1.',
        state: 'closed',
        merged: true,
        updated: '2026-09-01T00:00:00Z',
      }),
    ];
    gh.checks.sha10 = [
      { name: 'Test and build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/x/runs/1' },
      { name: 'claude-review', status: 'completed', conclusion: 'success' },
    ];
    gh.reviews[10] = [{ user: { login: 'octocat' }, state: 'CHANGES_REQUESTED' }];
    gh.runs = [
      {
        id: 501,
        name: 'CI',
        workflow_id: 61,
        path: '.github/workflows/ci.yml',
        display_title: 'Build the GitHub view',
        head_branch: 'cld-1-github-view',
        event: 'pull_request',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/x/actions/runs/501',
        created_at: '2026-09-29T10:00:00Z',
        updated_at: '2026-09-29T10:02:00Z',
        run_number: 7,
        pull_requests: [{ number: 10 }],
        actor: { login: 'claude[bot]' },
      },
    ];
    gh.commits = [
      {
        sha: 'abc123',
        html_url: 'https://github.com/x/commit/abc123',
        author: { login: 'octocat' },
        commit: { message: 'Add the board (#9)\n\nCloses CLD-22.', committer: { date: '2026-09-29T08:00:00Z' } },
      },
    ];
    gh.alerts = [
      {
        number: 1,
        html_url: 'https://github.com/x/security/dependabot/1',
        created_at: '2026-09-28T00:00:00Z',
        dependency: { package: { name: 'vite', ecosystem: 'npm' }, manifest_path: 'package.json' },
        security_advisory: { severity: 'high', summary: 'A bad thing', ghsa_id: 'GHSA-x' },
        security_vulnerability: { first_patched_version: { identifier: '8.3.2' } },
      },
    ];

    const overview = await body(await api('github/sync', { method: 'POST' }));
    expect(overview.status).toBe(200);
    expect(overview.connected).toBe(true);
    expect(overview.error).toBeNull();
    const open = overview.open[0];
    expect(open).toMatchObject({
      number: 10,
      state: 'open',
      closes: ['CLD-1'],
      mentions: ['OPS-1'],
      checks: { state: 'failure', total: 2, passed: 1 },
      review: { decision: 'changes_requested' },
    });
    expect(open.tasks.map((t) => [t.wid, t.closes])).toEqual([
      ['CLD-1', true],
      ['OPS-1', false],
    ]);
    expect(overview.runs[0]).toMatchObject({
      id: 501,
      conclusion: 'failure',
      prs: [10],
      workflow: 61,
      path: '.github/workflows/ci.yml',
    });
    expect(overview.commits[0]).toMatchObject({
      sha: 'abc123',
      pr: 9,
      wids: ['CLD-22'],
      message: 'Add the board (#9)',
    });
    expect(overview.alerts[0]).toMatchObject({ severity: 'high', package: 'vite', fixedIn: '8.3.2' });

    const task = (await body(await api('tasks/CLD-1'))).task;
    expect(task.pr).toBe('10');
    expect(task.github).toEqual([
      expect.objectContaining({
        number: 10,
        closes: true,
        state: 'open',
        checks: { state: 'failure', total: 2, passed: 1 },
        review: 'changes_requested',
        // What the task menu needs to offer Review with an agent (WEB-23).
        verdict: 'failing',
        mergeable: true,
      }),
    ]);
    const ops1 = (await body(await api('tasks/OPS-1'))).task;
    expect(ops1.status).toBe('pending');
    expect(ops1.github).toEqual([
      expect.objectContaining({ number: 10, closes: false }),
      expect.objectContaining({ number: 9, closes: true, state: 'merged', verdict: null }),
    ]);
  });

  it('shows the verdict in the inbox order and reads one pull request live, with its diff', async () => {
    gh.pulls = [
      pr(20, { title: 'Docs', updated: '2026-09-29T10:00:00Z' }),
      pr(21, { title: 'Worker', updated: '2026-09-29T09:00:00Z' }),
    ];
    gh.mergeable = { 20: [true, 'behind'], 21: [true, 'clean'] };
    gh.checks = {
      sha20: [{ name: 'Test and build', status: 'completed', conclusion: 'success' }],
      sha21: [{ name: 'Test and build', status: 'completed', conclusion: 'success' }],
    };
    gh.fileDetails = {
      21: [
        { filename: 'docs/a.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' },
        { filename: 'src/rooms.js', status: 'modified', additions: 2, deletions: 1 },
      ],
    };
    gh.comments = {
      21: [
        { id: 1, user: { login: 'octocat' }, body: 'Why?', path: 'docs/a.md', created_at: '2026-09-29T09:30:00Z' },
        {
          id: 2,
          in_reply_to_id: 1,
          user: { login: 'claude[bot]' },
          body: 'Because.',
          created_at: '2026-09-29T09:31:00Z',
        },
      ],
    };
    const overview = await body(await api('github/sync', { method: 'POST' }));
    expect(overview.open.filter((p) => p.number >= 20).map((p) => [p.number, p.verdict])).toEqual([
      [21, 'ready'],
      [20, 'behind'],
    ]);
    expect(overview.open[0].number).toBe(21);
    expect(overview.readyToMerge).toBe(1);

    const page = await body(await api('github/pulls/21'));
    expect(page).toMatchObject({
      status: 200,
      number: 21,
      verdict: 'ready',
      deploys: true,
      workers: ['widgets'],
      base: 'main',
    });
    expect(page.files.map((f) => [f.name, f.worker, f.patch === null])).toEqual([
      ['docs/a.md', false, false],
      ['src/rooms.js', true, true],
    ]);
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0].comments.map((c) => c.body)).toEqual(['Why?', 'Because.']);
    expect((await body(await api('github/pulls/999'))).status).toBe(404);
    expect((await body(await api('github/pulls/x'))).status).toBe(404);
    gh.mergeable = {};
    gh.fileDetails = {};
    gh.comments = {};
  });

  it('reads a changed file whole, on either side, for Preview (WEB-86)', async () => {
    gh.pulls = [pr(22, { title: 'Docs and a logo', sha: 'head22' })];
    gh.fileDetails = {
      22: [
        { filename: 'docs/guide.md', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-Old\n+New' },
        { filename: 'docs/new.md', previous_filename: 'docs/old.md', status: 'renamed', additions: 0, deletions: 0 },
        { filename: 'docs/added.txt', status: 'added', additions: 1, deletions: 0 },
        { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 },
        { filename: 'data.bin', status: 'modified', additions: 0, deletions: 0 },
        { filename: 'big.md', status: 'modified', additions: 1, deletions: 0 },
      ],
    };
    gh.contents = {
      'head22:docs/guide.md': '# Guide\n\nNew ✓\n',
      'base22:docs/guide.md': '# Guide\n\nOld\n',
      'base22:docs/old.md': 'Before the move\n',
      'head22:docs/added.txt': 'Hello\n',
      'head22:logo.png': '\u0089PNG\u0000\u0001',
      'head22:data.bin': 'a\u0000b',
      'head22:big.md': { size: 3_000_000, encoding: 'none' },
    };
    const file = (query) => api(`github/pulls/22/file?${new URLSearchParams(query)}`).then(body);

    expect(await file({ path: 'docs/guide.md', side: 'head' })).toMatchObject({
      status: 200,
      path: 'docs/guide.md',
      side: 'head',
      sha: 'head22',
      text: '# Guide\n\nNew ✓\n',
      binary: false,
      tooLarge: false,
    });
    expect((await file({ path: 'docs/guide.md', side: 'base' })).text).toBe('# Guide\n\nOld\n');
    // A renamed file's base is read at its old name.
    expect(await file({ path: 'docs/new.md', side: 'base' })).toMatchObject({
      path: 'docs/old.md',
      text: 'Before the move\n',
    });
    // A new file has no base, and a path the pull request doesn't change isn't read at all.
    const added = await file({ path: 'docs/added.txt', side: 'base' });
    expect(added.status).toBe(404);
    expect(added.error).toMatch(/new in this pull request/u);
    const before = gh.calls.filter((c) => c.includes('/contents/')).length;
    expect((await file({ path: 'src/secret.js', side: 'head' })).status).toBe(404);
    expect(gh.calls.filter((c) => c.includes('/contents/')).length).toBe(before);
    // An image comes back to show; other binary files and very large ones only say so.
    const logo = await file({ path: 'logo.png', side: 'head' });
    expect(logo).toMatchObject({ status: 200, text: null, binary: true });
    expect(logo.image).toMatch(/^data:image\/png;base64,/u);
    expect(await file({ path: 'data.bin', side: 'head' })).toMatchObject({ text: null, binary: true, image: null });
    expect(await file({ path: 'big.md', side: 'head' })).toMatchObject({ text: null, tooLarge: true });
    expect((await file({ path: 'docs/guide.md', side: 'middle' })).status).toBe(400);
    expect((await file({ side: 'head' })).status).toBe(400);
    gh.fileDetails = {};
    gh.contents = {};
  });

  it('refuses webhooks with a bad signature, and schedules one reconcile for good ones', async () => {
    expect(
      (await webhook('pull_request', { action: 'closed', repository: { full_name: 'acme/widgets' } }, 'wrong')).status,
    ).toBe(401);
    expect((await webhook('ping', { zen: 'hi' })).status).toBe(200);
    expect(
      (await webhook('pull_request', { action: 'closed', repository: { full_name: 'someone/else' } })).status,
    ).toBe(202);

    gh.pulls = [
      pr(10, {
        branch: 'cld-1-github-view',
        body: 'Closes CLD-1. Mentions OPS-1.',
        state: 'closed',
        merged: true,
        updated: '2026-09-29T11:00:00Z',
      }),
    ];
    gh.checks.sha10 = [{ name: 'Test and build', status: 'completed', conclusion: 'success' }];
    gh.alerts = [];
    for (let i = 0; i < 3; i += 1)
      expect(
        (await webhook('check_run', { action: 'completed', repository: { full_name: 'acme/widgets' } })).status,
      ).toBe(202);
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(false); // three webhooks, one reconcile

    const task = (await body(await api('tasks/CLD-1'))).task;
    expect(task).toMatchObject({ status: 'completed', pr: '10' });
    expect(task.comments.at(-1)).toMatchObject({ by: 'board', text: 'Merged in #10: PR 10' });
    expect((await body(await api('tasks/OPS-1'))).task.status).toBe('pending'); // only mentioned

    const overview = await body(await api('github'));
    expect(overview.alerts).toEqual([]);
    const { events } = await body(await api('activity'));
    const kinds = events.flatMap((e) => e.changes.map((c) => `${e.source}:${c.kind}`));
    expect(kinds).toEqual(
      expect.arrayContaining(['github:pr_merged', 'github:ci_fixed', 'github:alert_closed', 'github:done']),
    );
    const merged = events.find((e) => e.changes.some((c) => c.kind === 'pr_merged'));
    expect(merged.task.wid).toBe('CLD-1');
  });

  it('notes a PR closed without merging once, and keeps the task open', async () => {
    gh.pulls = [pr(11, { title: 'Fixes OPS-1', state: 'closed', updated: '2026-09-29T12:00:00Z' })];
    await api('github/sync', { method: 'POST' });
    await api('github/sync', { method: 'POST' });
    const task = (await body(await api('tasks/OPS-1'))).task;
    expect(task.status).toBe('pending');
    expect(task.annotations.filter((a) => a.text === '#11 was closed without merging.')).toHaveLength(1);
  });

  it('carries on without Dependabot alerts when the App may not read them', async () => {
    gh.alertsStatus = 403;
    const overview = await body(await api('github/sync', { method: 'POST' }));
    expect(overview.status).toBe(200);
    expect(overview.error).toBeNull();
    gh.alertsStatus = 200;
  });

  it('records deploys, marks the tasks they shipped, and lists releases and tags', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Ship the board view', wid: 'PRD-70' },
        { description: 'Ship the second thing', wid: 'PRD-71' },
      ],
    });
    gh.pulls = [
      pr(20, {
        body: 'Closes PRD-70.',
        state: 'closed',
        merged: true,
        updated: '2026-09-29T13:00:00Z',
        mergeSha: 'merge20',
      }),
      pr(21, {
        body: 'Closes PRD-71.',
        state: 'closed',
        merged: true,
        updated: '2026-09-29T13:30:00Z',
        mergeSha: 'squash21',
      }),
    ];
    const version = '4f2c8a10-1111-4222-8333-444455556666';
    const deployment = (id, sha, extra = {}) => ({
      id,
      sha,
      environment: 'widgets',
      task: 'deploy',
      created_at: '2026-09-29T14:00:00Z',
      creator: { login: 'github-actions[bot]' },
      ...extra,
    });
    gh.deployments = [deployment(3, 'd3'), deployment(2, 'd2'), deployment(1, 'd1')];
    gh.statuses = {
      1: [
        {
          state: 'success',
          description: 'version aaaaaaaa-1111-4222-8333-444455556666 · migrations none',
          created_at: '2026-09-29T12:00:00Z',
        },
      ],
      2: [
        {
          state: 'success',
          description: `version ${version} · migrations 0009_x.sql`,
          log_url: 'https://github.com/x/actions/runs/9',
          created_at: '2026-09-29T14:05:00Z',
        },
      ],
      3: [
        {
          state: 'failure',
          description: 'health check failed; rolled back to 4f2c8a10 (tried bbbb)',
          created_at: '2026-09-29T15:00:00Z',
        },
      ],
    };
    gh.compares['d1...d2'] = [
      { sha: 'x1', commit: { message: 'Merge pull request #20 from x/y' } },
      { sha: 'squash21', commit: { message: 'Something else' } },
    ];
    gh.releases = [
      {
        name: 'Launch',
        tag_name: 'v0.1.0',
        html_url: 'https://github.com/x/releases/v0.1.0',
        published_at: '2026-09-29T14:10:00Z',
      },
    ];
    gh.tags = [{ name: 'v0.1.0', commit: { sha: 'd2' } }];

    const overview = await body(await api('github/sync', { method: 'POST' }));
    expect(overview.error).toBeNull();
    expect(overview.deploys.map((d) => [d.id, d.state, d.version?.slice(0, 8) ?? null])).toEqual([
      [3, 'failure', null],
      [2, 'success', '4f2c8a10'],
      [1, 'success', 'aaaaaaaa'],
    ]);
    expect(overview.deploys[1]).toMatchObject({
      env: 'widgets',
      migrations: '0009_x.sql',
      sha: 'd2',
      logUrl: 'https://github.com/x/actions/runs/9',
    });
    expect(overview.deploys[1].shipped.map((t) => t.wid)).toEqual(['PRD-70', 'PRD-71']);
    expect(overview.deploys[2].shipped).toEqual([]);
    expect(overview.releases[0]).toMatchObject({ tag: 'v0.1.0', name: 'Launch' });
    expect(overview.tags).toEqual([{ name: 'v0.1.0', sha: 'd2' }]);

    const task = (await body(await api('tasks/PRD-70'))).task;
    expect(task.shipped).toMatchObject({ env: 'widgets', sha: 'd2', version });
    expect(task.annotations.map((n) => n.text)).toContain(`Live in ${version} (d2).`);
    expect((await body(await api('tasks/OPS-1'))).task.shipped).toBeNull();

    // A second sync doesn't ship or note them again.
    await api('github/sync', { method: 'POST' });
    expect(
      (await body(await api('tasks/PRD-70'))).task.annotations.filter((n) => n.text.startsWith('Live in')),
    ).toHaveLength(1);

    const { events } = await body(await api('activity'));
    const kinds = events.filter((e) => e.source === 'github').flatMap((e) => e.changes.map((c) => c.kind));
    expect(kinds).toEqual(expect.arrayContaining(['deployed', 'deploy_failed']));
    gh.deployments = null;
  });

  it('counts a pipeline’s deploys on the Activity view under staging and production, not its Workers’ names', async () => {
    const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const dep = (id, environment, hours, extra = {}) => ({
      id,
      sha: `s${id}`,
      environment,
      task: 'deploy',
      created_at: ago(hours),
      creator: { login: 'github-actions[bot]' },
      ...extra,
    });
    gh.deployments = [
      dep(24, 'widgets', 1),
      dep(23, 'widgets', 3, { task: 'rollback' }),
      dep(22, 'widgets', 5),
      dep(21, 'widgets-staging', 6),
      dep(20, 'widgets-staging', 7),
    ];
    const status = (state, hours) => [
      { state, description: 'version a0000000 · migrations none', created_at: ago(hours) },
    ];
    gh.statuses = {
      24: status('success', 1),
      23: status('success', 3),
      22: status('inactive', 5),
      21: status('success', 6),
      20: status('failure', 7),
    };
    await api('github/sync', { method: 'POST' });

    const stats = await body(await api('stats?days=7&tz=UTC'));
    expect(stats.deploys.production).toEqual({ landed: 2, failed: 0, rollbacks: 1 });
    expect(stats.deploys.staging).toEqual({ landed: 1, failed: 1, rollbacks: 0 });
    expect(stats.totals.deploys.now).toBe(2);
    expect(stats.deploys.lastProduction).not.toBeNull();
    expect(stats.deploys.recent.map((d) => d.env)).toEqual([
      'staging',
      'staging',
      'production',
      'production',
      'production',
    ]);
    gh.deployments = null;
  });

  it('marks tasks per environment: on staging first, live after a promote, never by try or rollback', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Staged first', wid: 'PRD-90' },
        { description: 'Staged later', wid: 'PRD-91' },
      ],
    });
    gh.pulls = [
      pr(30, {
        body: 'Closes PRD-90.',
        state: 'closed',
        merged: true,
        updated: '2026-09-30T10:00:00Z',
        mergeSha: 'm30',
      }),
      pr(31, {
        body: 'Closes PRD-91.',
        state: 'closed',
        merged: true,
        updated: '2026-09-30T11:00:00Z',
        mergeSha: 'm31',
      }),
    ];
    const dep = (id, sha, environment, extra = {}) => ({
      id,
      sha,
      environment,
      task: 'deploy',
      created_at: '2026-09-30T12:00:00Z',
      creator: { login: 'github-actions[bot]' },
      ...extra,
    });
    gh.deployments = [
      dep(14, 's31', 'widgets-staging'),
      dep(13, 'p30', 'widgets', { task: 'rollback' }),
      dep(12, 's31try', 'widgets-staging', { task: 'try' }),
      dep(11, 'p30', 'widgets'),
      dep(10, 's30', 'widgets-staging'),
      dep(9, 'p0', 'widgets'),
      dep(8, 's0', 'widgets-staging'),
    ];
    const ok = (description, at, url) => [{ state: 'success', description, log_url: url, created_at: at }];
    gh.statuses = {
      8: ok('version a0000000 · migrations none', '2026-09-30T08:00:00Z'),
      9: ok('version b0000000 · migrations none', '2026-09-30T08:10:00Z'),
      10: ok('version a1111111 · migrations none', '2026-09-30T10:05:00Z', 'https://github.com/x/actions/runs/30'),
      11: ok('version b1111111 · migrations none', '2026-09-30T10:30:00Z', 'https://github.com/x/actions/runs/31'),
      12: ok('version a2222222 · migrations none', '2026-09-30T11:05:00Z'),
      13: ok('version b0000000 · migrations none', '2026-09-30T11:10:00Z'),
      14: ok('version a3333333 · migrations none', '2026-09-30T11:30:00Z', 'https://github.com/x/actions/runs/32'),
    };
    gh.compares['s0...s30'] = [{ sha: 's30', commit: { message: 'Merge pull request #30 from x/y' } }];
    gh.compares['s30...s31'] = [{ sha: 's31', commit: { message: 'Merge pull request #31 from x/y' } }];
    gh.compares['p0...p30'] = [{ sha: 's30', commit: { message: 'Merge pull request #30 from x/y' } }];
    gh.tags = [{ name: 'v2026-09-30-p30', commit: { sha: 'p30' } }];

    await api('github/sync', { method: 'POST' });
    const first = (await body(await api('tasks/PRD-90'))).task;
    expect(first.staged).toMatchObject({
      env: 'widgets-staging',
      sha: 's30',
      mergeSha: 'm30',
      run: 'https://github.com/x/actions/runs/30',
    });
    expect(first.shipped).toMatchObject({ env: 'widgets', sha: 'p30', tag: 'v2026-09-30-p30' });
    expect(first.ships.map((x) => x.stage).sort()).toEqual(['live', 'staging']);
    expect(first.annotations.map((n) => n.text)).toEqual(
      expect.arrayContaining(['On staging in a1111111 (s30).', 'Live in b1111111 (p30).']),
    );
    const second = (await body(await api('tasks/PRD-91'))).task;
    expect(second.staged).toMatchObject({ sha: 's31', mergeSha: 'm31' }); // the try deploy didn't count: the compare ran from s30
    expect(second.shipped).toBeNull(); // the rollback didn't mark it live
    gh.deployments = null;
  });

  it('reads what merged pull requests changed, and marks the ones from before recorded deploys as shipped', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Write the runbook', wid: 'PRD-80' },
        { description: 'Change the room', wid: 'PRD-81' },
        { description: 'Change the room, old', wid: 'PRD-82' },
        { description: 'Unreadable files', wid: 'PRD-83' },
      ],
    });
    gh.pulls = [
      pr(80, { body: 'Closes PRD-80.', state: 'closed', merged: true, updated: '2026-09-29T14:00:00Z' }),
      pr(81, { body: 'Closes PRD-81.', state: 'closed', merged: true, updated: '2026-09-29T14:01:00Z' }),
      pr(42, { body: 'Closes PRD-82.', state: 'closed', merged: true, updated: '2026-09-29T14:02:00Z' }), // in backfill-shipped.js
      pr(83, { body: 'Closes PRD-83.', state: 'closed', merged: true, updated: '2026-09-29T14:03:00Z' }),
    ];
    gh.files = {
      80: ['docs/runbook.md', 'WORK.md'],
      81: ['docs/runbook.md', 'src/rooms.js'],
      42: ['src/server/spotify.js'],
    };
    await api('github/sync', { method: 'POST' });

    const shipStateOf = async (wid) => shipState((await body(await api(`tasks/${wid}`))).task);
    expect(await shipStateOf('PRD-80')).toBe('nodeploy');
    expect(await shipStateOf('PRD-81')).toBe('unshipped');
    expect(await shipStateOf('PRD-83')).toBe('unshipped'); // GitHub wouldn't list its files, so it isn't called done
    expect((await body(await api('tasks/PRD-80'))).task.github[0].workers).toEqual([]);
    expect((await body(await api('tasks/PRD-81'))).task.github[0].workers).toEqual(['widgets']);
    expect((await body(await api('tasks/PRD-83'))).task.github[0].workers).toBeNull();

    // The old pull request's task is shipped in the deploy the log names, without a note.
    const old = (await body(await api('tasks/PRD-82'))).task;
    expect(old.shipped).toMatchObject({ env: 'samewave', version: '4756548c' });
    expect(old.annotations.some((n) => n.text.startsWith('Live in'))).toBe(false);

    // Files are read once; a pull request GitHub couldn't list is tried again next time.
    gh.calls.length = 0;
    gh.files[83] = ['src/rooms.js'];
    await api('github/sync', { method: 'POST' });
    const read = gh.calls.filter((c) => c.endsWith('/files'));
    expect(read).toContain(`${REPO}/pulls/83/files`);
    expect(read).not.toContain(`${REPO}/pulls/80/files`);
    expect(read).not.toContain(`${REPO}/pulls/81/files`);
    expect((await body(await api('tasks/PRD-83'))).task.github[0].workers).toEqual(['widgets']);
  });

  it('reads the files of a merged pull request that has aged out of the latest 50', async () => {
    await api('tasks', { method: 'POST', body: [{ description: 'Old docs change', wid: 'PRD-84' }] });
    const old = pr(84, { body: 'Closes PRD-84.', state: 'closed', merged: true, updated: '2026-09-29T14:00:00Z' });
    gh.pulls = [old];
    gh.files[84] = null; // stored while GitHub wouldn't list its files
    await api('github/sync', { method: 'POST' });
    expect((await body(await api('tasks/PRD-84'))).task.github[0].workers).toBeNull();

    gh.pulls = []; // a later sync no longer lists it
    gh.files[84] = ['docs/runbook.md'];
    await api('github/sync', { method: 'POST' });
    const task = (await body(await api('tasks/PRD-84'))).task;
    expect(task.github[0].workers).toEqual([]);
    expect(shipState(task)).toBe('nodeploy');
  });

  it('shows the routine prompt as it is on main, with the commit that last changed it', async () => {
    gh.prompt =
      'You are a widgets agent.\n\n## Messages from the owner\n\nIt’s the owner’s guidance for the task you hold.\n';
    gh.commits = [
      {
        sha: 'feed123',
        html_url: 'https://github.com/x/commit/feed123',
        commit: {
          message: 'CLD-150: Teach agents about board messages\n\nMore.',
          committer: { date: '2026-10-01T19:30:00Z' },
        },
      },
    ];
    const prompt = await body(await api('agents/prompt'));
    expect(prompt).toMatchObject({
      status: 200,
      slug: 'widgets',
      path: 'tools/tasks/routine-prompt.md',
      missing: false,
      text: gh.prompt,
      commit: { sha: 'feed123', date: '2026-10-01T19:30:00Z', message: 'CLD-150: Teach agents about board messages' },
    });
    expect(prompt.url).toContain('/blob/main/tools/tasks/routine-prompt.md');
    // Kept for a minute: opening the Agents view again doesn't ask GitHub again.
    const before = gh.calls.filter((c) => c.endsWith('/contents/tools/tasks/routine-prompt.md')).length;
    expect((await api('agents/prompt')).status).toBe(200);
    expect(gh.calls.filter((c) => c.endsWith('/contents/tools/tasks/routine-prompt.md')).length).toBe(before);
  });

  it('checks the setup state GitHub sends back', async () => {
    const setup = await body(await api('github/setup', { method: 'POST' }));
    expect(setup.manifest).toMatchObject({
      name: 'widgets tasks',
      public: false,
      hook_attributes: { url: `${ORIGIN}/github/webhook` },
      redirect_url: `${ORIGIN}/github/connected`,
    });
    expect(setup.manifest.default_permissions).toMatchObject({
      pull_requests: 'write',
      contents: 'write',
      checks: 'write',
      vulnerability_alerts: 'read',
    });
    // Write only where a button or a check needs it: update branch and merge, workflows, and a plan's check (BRK-185).
    expect(
      Object.entries(setup.manifest.default_permissions)
        .filter(([, v]) => v !== 'read')
        .map(([k]) => k)
        .sort(),
    ).toEqual(['actions', 'checks', 'contents', 'pull_requests']);
    const bad = await SELF.fetch(`${ORIGIN}/github/connected?code=abcdef123456&state=nope`, { redirect: 'manual' });
    expect(bad.headers.get('Location')).toBe('/#/github?connect=failed');
    const good = await SELF.fetch(`${ORIGIN}/github/connected?code=abcdef123456&state=${setup.state}`, {
      redirect: 'manual',
    });
    expect(good.headers.get('Location')).toBe('/#/github?connect=abcdef123456');
    const reused = await SELF.fetch(`${ORIGIN}/github/connected?code=abcdef123456&state=${setup.state}`, {
      redirect: 'manual',
    });
    expect(reused.headers.get('Location')).toBe('/#/github?connect=failed');
  });
});

describe('Update branch, Merge, and Merge when green', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    await setPipeline();
    gh.writes = [];
    gh.writeError = null;
  });
  afterEach(() => {
    spy.mockRestore();
    gh.mergeable = {};
  });

  /** The signed-in browser: the cookie from /login, from this origin. */
  async function browser() {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
      redirect: 'manual',
    });
    const cookie = res.headers.get('Set-Cookie').split(';')[0];
    return (path, payload, origin = ORIGIN) =>
      SELF.fetch(`${ORIGIN}/api/${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(payload),
      });
  }

  it('refuses a bearer token and a cross-origin request, and writes nothing', async () => {
    gh.pulls = [pr(30, { sha: 'abc1234' })];
    for (const action of ['merge', 'update-branch', 'auto-merge', 'publish']) {
      const res = await body(
        await api(`github/pulls/30/${action}`, { method: 'POST', body: { sha: 'abc1234', method: 'squash' } }),
      );
      expect(res.status).toBe(403);
    }
    const post = await browser();
    expect(
      (await post('github/pulls/30/merge', { sha: 'abc1234', method: 'squash' }, 'https://evil.example')).status,
    ).toBe(403);
    expect((await post('github/pulls/30/merge', { sha: 'abc1234', method: 'squash' }, null)).status).toBe(403);
    expect(gh.writes).toEqual([]);
  });

  it('merges with the head commit the owner saw, and records it in Activity', async () => {
    gh.pulls = [pr(31, { title: 'CLD-9: Something', body: 'Closes CLD-9.', sha: 'abc1234' })];
    const post = await browser();
    expect((await post('github/pulls/31/merge', { sha: 'abc1234', method: 'rebase' })).status).toBe(400);
    expect((await post('github/pulls/31/merge', { method: 'squash' })).status).toBe(400);
    const stale = await body(await post('github/pulls/31/merge', { sha: 'deadbeef', method: 'squash' }));
    expect(stale.status).toBe(409);
    expect(stale.error).toMatch(/changed since/u);
    expect(gh.writes).toEqual([]);

    const ok = await body(await post('github/pulls/31/merge', { sha: 'abc1234', method: 'squash' }));
    expect(ok).toMatchObject({ status: 200, ok: true, action: 'pr_merged_by_owner' });
    expect(gh.writes).toEqual([['PUT', `${REPO}/pulls/31/merge`, { sha: 'abc1234', merge_method: 'squash' }]]);
    const feed = await body(await api('activity'));
    expect(JSON.stringify(feed)).toContain('pr_merged_by_owner');
  });

  it('refuses like GitHub does: not ready, draft, closed, missing permission, or GitHub says no', async () => {
    gh.pulls = [
      pr(32, { sha: 'a1b2c3d' }),
      pr(33, { draft: true, sha: 'a1b2c3d' }),
      pr(34, { state: 'closed', sha: 'a1b2c3d' }),
    ];
    gh.mergeable = { 32: [true, 'behind'] };
    const post = await browser();
    const behind = await body(await post('github/pulls/32/merge', { sha: 'a1b2c3d', method: 'merge' }));
    expect(behind.status).toBe(409);
    expect(behind.error).toMatch(/isn’t ready/u);
    expect((await body(await post('github/pulls/33/merge', { sha: 'a1b2c3d', method: 'merge' }))).error).toMatch(
      /draft/u,
    );
    expect((await body(await post('github/pulls/34/merge', { sha: 'a1b2c3d', method: 'merge' }))).error).toMatch(
      /already closed/u,
    );
    expect((await body(await post('github/pulls/999/merge', { sha: 'a1b2c3d', method: 'merge' }))).status).toBe(404);
    expect(gh.writes).toEqual([]);

    gh.mergeable = { 32: [true, 'clean'] };
    gh.writeError = [403, 'Resource not accessible by integration'];
    const denied = await body(await post('github/pulls/32/merge', { sha: 'a1b2c3d', method: 'merge' }));
    expect(denied).toMatchObject({ status: 403, permission: true });
    gh.writeError = [405, 'Required status check "Test and build" is expected.'];
    const refused = await body(await post('github/pulls/32/merge', { sha: 'a1b2c3d', method: 'merge' }));
    expect(refused).toMatchObject({ status: 409, error: 'Required status check "Test and build" is expected.' });
    const feed = await body(await api('activity'));
    expect(JSON.stringify(feed)).not.toContain('"pr_merged_by_owner","number":32');
  });

  it('updates a behind branch with a merge commit, and leaves conflicts to an agent', async () => {
    gh.pulls = [pr(35, { sha: 'f00dbabe' }), pr(36, { sha: 'f00dbabe' })];
    gh.mergeable = { 35: [true, 'behind'], 36: [false, 'dirty'] };
    const post = await browser();
    expect((await body(await post('github/pulls/36/update-branch', { sha: 'f00dbabe' }))).error).toMatch(/conflicts/u);
    expect(gh.writes).toEqual([]);
    expect((await post('github/pulls/35/update-branch', { sha: 'f00dbabe' })).status).toBe(200);
    expect(gh.writes).toEqual([['PUT', `${REPO}/pulls/35/update-branch`, { expected_head_sha: 'f00dbabe' }]]);
  });

  it('turns auto-merge on and off through GraphQL, with the head commit', async () => {
    gh.pulls = [pr(37, { sha: 'c0ffee1' })];
    gh.mergeable = { 37: [true, 'blocked'] };
    const post = await browser();
    expect((await post('github/pulls/37/auto-merge', { sha: 'c0ffee1', method: 'squash' })).status).toBe(200);
    expect((await post('github/pulls/37/auto-merge', { sha: 'c0ffee1', enable: false })).status).toBe(200);
    const [on, off] = gh.writes;
    expect(on[1]).toBe('/graphql');
    expect(on[2].variables).toEqual({ id: 'PR_37', method: 'SQUASH', sha: 'c0ffee1' });
    expect(off[2].variables).toEqual({ id: 'PR_37' });
    const feed = JSON.stringify(await body(await api('activity')));
    expect(feed).toContain('pr_auto_merge_on');
    expect(feed).toContain('pr_auto_merge_off');
  });

  it('publishes a draft through GraphQL, and refuses a pull request that isn’t one', async () => {
    gh.pulls = [pr(40, { draft: true, sha: 'd00d001' }), pr(41, { sha: 'd00d002' })];
    const post = await browser();
    expect((await body(await post('github/pulls/41/publish', { sha: 'd00d002' }))).error).toMatch(/isn’t a draft/u);
    expect((await body(await post('github/pulls/40/publish', { sha: 'beef0001' }))).error).toMatch(/changed since/u);
    expect(gh.writes).toEqual([]);
    expect((await post('github/pulls/40/publish', { sha: 'd00d001' })).status).toBe(200);
    expect(gh.writes).toHaveLength(1);
    expect(gh.writes[0][1]).toBe('/graphql');
    expect(gh.writes[0][2].query).toContain('markPullRequestReadyForReview');
    expect(gh.writes[0][2].variables).toEqual({ id: 'PR_40' });
    expect(JSON.stringify(await body(await api('activity')))).toContain('pr_published');
  });

  it('keeps each open pull request’s auto-merge from the sync, and marks what the owner’s settings did', async () => {
    gh.pulls = [{ ...pr(38, { sha: 'beef001' }), auto_merge: { merge_method: 'squash' } }, pr(39, { sha: 'beef002' })];
    gh.mergeable = { 38: [true, 'blocked'], 39: [true, 'behind'] };
    const overview = await body(await api('github/sync', { method: 'POST' }));
    expect(overview.open.filter((p) => p.number >= 38).map((p) => [p.number, p.autoMerge])).toEqual([
      [39, null],
      [38, { method: 'squash' }],
    ]);
    const post = await browser();
    expect((await post('github/pulls/39/update-branch', { sha: 'beef002', setting: true })).status).toBe(200);
    expect((await post('github/pulls/39/auto-merge', { sha: 'beef002', method: 'merge', setting: 'yes' })).status).toBe(
      200,
    );
    const events = (await body(await api('activity'))).events
      .flatMap((e) => e.changes ?? [])
      .filter((c) => c.number === 39);
    expect(events.find((c) => c.kind === 'pr_branch_updated')).toMatchObject({ setting: true });
    expect(events.find((c) => c.kind === 'pr_auto_merge_on').setting).toBeUndefined(); // only `true` counts
  });
});

describe('GitHub per repository (CLD-124)', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    await setPipeline();
  });
  afterEach(() => spy.mockRestore());

  const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
  const task = async (wid) => (await body(await api(`tasks/${wid}`))).task;
  const create = async (input) => (await body(await api('tasks', { method: 'POST', body: input }))).tasks;
  const scratchPr = (number, options) => {
    const p = pr(number, options);
    return { ...p, html_url: p.html_url.replace('/widgets/', '/scratch/') };
  };

  it('syncs two repositories side by side, and a pull request closes only its own repository’s tasks', async () => {
    await runDurableObjectAlarm(stub()); // nothing left over from the tests above
    expect(
      (await api('repos', { method: 'POST', body: { slug: 'scratch', github: 'acme/scratch', areas: ['core:SCR'] } }))
        .status,
    ).toBe(201);
    const [scr1, scr2] = await create([
      { description: 'Scratch one', project: 'core', repo: 'scratch' },
      { description: 'Scratch two', project: 'core', repo: 'scratch' },
    ]);
    const [cld] = await create([{ description: 'Widgets side', project: 'cloud' }]);
    expect([scr1.wid, scr2.wid]).toEqual(['SCR-1', 'SCR-2']);

    // The same number in both repositories: scratch's #10 closes SCR-1 and names widgets's task, which it can't close.
    other.pulls = [scratchPr(10, { title: 'Scratch work', body: `Closes SCR-1. Closes ${cld.wid}.`, sha: 'scr10' })];
    gh.pulls = [pr(60, { title: 'Widgets work', body: 'Closes SCR-2.', sha: 'sw60' })];
    gh.calls = [];
    expect(
      (await webhook('pull_request', { action: 'opened', repository: { full_name: 'acme/scratch' } })).status,
    ).toBe(202);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(gh.calls).toContain(`${OTHER}/pulls`);
    expect(gh.calls).not.toContain(`${REPO}/pulls`); // only the repository the delivery named

    expect((await task('SCR-1')).pr).toBe('10');
    expect((await task(cld.wid)).pr).toBeNull();
    expect((await task(cld.wid)).github).toEqual([
      expect.objectContaining({ repo: 'scratch', number: 10, closes: false }),
    ]);

    const scratch = await body(await api('github?repo=scratch'));
    expect(scratch).toMatchObject({ status: 200, slug: 'scratch', repo: 'acme/scratch', error: null });
    expect(scratch.open.map((p) => [p.number, p.closes, p.mentions])).toEqual([[10, ['SCR-1'], [cld.wid]]]);
    expect((await body(await api('github'))).open.some((p) => p.title === 'Scratch work')).toBe(false);
    expect((await body(await api('github?repo=nowhere'))).status).toBe(404);

    const page = await body(await api('github/pulls/10?repo=scratch'));
    expect(page).toMatchObject({ status: 200, repo: 'scratch', number: 10, workers: [], deploys: false });
    expect(page.tasks.map((t) => [t.wid, t.closes, t.elsewhere ?? null])).toEqual([
      ['SCR-1', true, null],
      [cld.wid, false, 'widgets'],
    ]);

    // widgets's #60 says "Closes SCR-2.", which is scratch's: only a mention.
    const widgets = await body(await api('github/sync', { method: 'POST' }));
    expect(widgets.open.find((p) => p.number === 60)).toMatchObject({
      closes: [],
      mentions: ['SCR-2'],
      elsewhere: { 'SCR-2': 'scratch' },
    });
    expect((await task('SCR-2')).pr).toBeNull();

    // Both merge: each finishes only its own repository's task.
    other.pulls = [
      scratchPr(10, {
        title: 'Scratch work',
        body: `Closes SCR-1. Closes ${cld.wid}.`,
        sha: 'scr10',
        state: 'closed',
        merged: true,
        updated: '2026-09-30T10:00:00Z',
      }),
    ];
    gh.pulls = [
      pr(60, {
        title: 'Widgets work',
        body: 'Closes SCR-2.',
        sha: 'sw60',
        state: 'closed',
        merged: true,
        updated: '2026-09-30T10:00:00Z',
      }),
    ];
    expect(
      (await webhook('pull_request', { action: 'closed', repository: { full_name: 'acme/scratch' } })).status,
    ).toBe(202);
    expect(
      (await webhook('pull_request', { action: 'closed', repository: { full_name: 'acme/widgets' } })).status,
    ).toBe(202);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await task('SCR-1')).toMatchObject({ status: 'completed', pr: '10' });
    expect((await task('SCR-1')).comments.at(-1).text).toBe('Merged in #10: Scratch work');
    expect((await task('SCR-2')).status).toBe('pending');
    expect((await task(cld.wid)).status).toBe('pending');
    const feed = (await body(await api('activity'))).events
      .flatMap((e) => e.changes ?? [])
      .filter((c) => c.kind === 'pr_merged');
    expect(feed.find((c) => c.title === 'Scratch work')).toMatchObject({ repo: 'scratch', number: 10 });
  });

  it('keeps syncing one repository while another fails or runs out of requests', async () => {
    const [cld] = await create([{ description: 'Ship while scratch is down', project: 'cloud' }]);
    other.fail = [403, 'API rate limit exceeded for installation ID 88.'];
    gh.pulls = [
      pr(61, {
        title: 'Ship it',
        body: `Closes ${cld.wid}.`,
        sha: 'sw61',
        state: 'closed',
        merged: true,
        updated: '2026-09-30T12:00:00Z',
      }),
    ];
    // A delivery without a repository (the App's own events) reconciles every one, like the cron.
    expect((await webhook('installation', { action: 'new_permissions_accepted' })).status).toBe(202);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await task(cld.wid)).toMatchObject({ status: 'completed', pr: '61' });

    const scratch = await body(await api('github?repo=scratch'));
    expect(scratch.error).toMatch(/rate limit/u);
    expect((await body(await api('github'))).error).toBeNull();
    expect((await body(await api('github/sync?repo=scratch', { method: 'POST' }))).status).toBe(502);
    expect((await body(await api('github/sync', { method: 'POST' }))).status).toBe(200);
    const sync = (await body(await api('connections'))).connections.filter((c) => c.id === 'github.sync');
    expect(sync.map((c) => [c.repo, c.state])).toEqual([
      ['widgets', 'working'],
      ['scratch', 'attention'],
    ]);
    other.fail = null;
    expect((await body(await api('github/sync?repo=scratch', { method: 'POST' }))).error).toBeNull();
  });

  it('treats a repository with no commits yet as empty, not failing, until repos init pushes (CLD-191)', async () => {
    other.empty = true;
    other.pulls = [];
    const view = await body(await api('github/sync?repo=scratch', { method: 'POST' }));
    expect(view).toMatchObject({ status: 200, slug: 'scratch', error: null, empty: true });
    expect(view.lastSync).not.toBeNull();
    // The cron syncs every repository: an empty one never puts it on Needs attention.
    await runInDurableObject(stub(), (store) => store.tick('cron'));
    const report = await body(await api('connections'));
    expect(report.connections.find((c) => c.id === 'cloudflare.cron')).toMatchObject({
      state: 'working',
      detail: 'last run finished',
    });
    const sync = report.connections.find((c) => c.id === 'github.sync' && c.repo === 'scratch');
    expect(sync).toMatchObject({ state: 'off' });
    expect(sync.detail).toMatch(/no commits yet/u);
    expect(sync.fix).toMatch(/npx breakaway repos init scratch/u);
    // Its routine isn't connected yet either, which is the next step of setting up, not a failure (CLD-193).
    const routine = report.connections.find((c) => c.id === 'claude.routine' && c.repo === 'scratch');
    expect(routine).toMatchObject({ state: 'off' });
    expect(routine.fix).toMatch(/npx breakaway repos init scratch/u);
    expect((await body(await api('github?repo=all'))).repos.find((r) => r.slug === 'scratch')).toMatchObject({
      empty: true,
      error: null,
    });
    // Its prompt is missing, and says why.
    await runInDurableObject(stub(), (store) => {
      store.promptCache = {};
    });
    expect(await body(await api('agents/prompt?repo=scratch'))).toMatchObject({
      status: 200,
      slug: 'scratch',
      missing: true,
      empty: true,
      text: null,
    });
    // The first push: it syncs as usual again.
    other.empty = false;
    const after = await body(await api('github/sync?repo=scratch', { method: 'POST' }));
    expect(after).toMatchObject({ status: 200, error: null, empty: false });
    const working = (await body(await api('connections'))).connections.find(
      (c) => c.id === 'github.sync' && c.repo === 'scratch',
    );
    expect(working.state).toBe('working');
    // Once it has commits, a routine that's still missing needs attention again.
    const routineAfter = (await body(await api('connections'))).connections.find(
      (c) => c.id === 'claude.routine' && c.repo === 'scratch',
    );
    expect(routineAfter.state).toBe('attention');
  });
});

describe('the GitHub view, Merge, and the pipeline per repository (CLD-125)', () => {
  let spy;
  beforeEach(async () => {
    spy = mockGitHub();
    await setPipeline();
    gh.writes = [];
  });
  afterEach(() => spy.mockRestore());

  const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
  const scratchPr = (number, options) => {
    const p = pr(number, options);
    return { ...p, html_url: p.html_url.replace('/widgets/', '/scratch/') };
  };
  async function browser() {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
      redirect: 'manual',
    });
    const cookie = res.headers.get('Set-Cookie').split(';')[0];
    return (path, payload) =>
      SELF.fetch(`${ORIGIN}/api/${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify(payload),
      });
  }

  it('shows Releases and deploys only for a repository with a pipeline; widgets keeps its own', async () => {
    other.pulls = [scratchPr(12, { title: 'Scratch open', sha: 'scr12' })];
    gh.pulls = [pr(70, { title: 'Widgets open', sha: 'sw70' })];
    expect((await body(await api('github/sync?repo=all', { method: 'POST' }))).status).toBe(200);

    const widgets = await body(await api('github'));
    expect(widgets.pipeline).toEqual({ staging: 'widgets-staging', production: 'widgets' });
    expect(widgets.flow).toMatchObject({ staging: { env: 'widgets-staging' }, production: { env: 'widgets' } });
    expect(widgets.open.every((p) => p.repo === 'widgets')).toBe(true);

    const scratch = await body(await api('github?repo=scratch'));
    expect(scratch).toMatchObject({ pipeline: null, flow: null, deploys: [] });
    expect(scratch.open.map((p) => [p.repo, p.number])).toEqual([['scratch', 12]]);

    // The pull request page: no deploy facts without a pipeline; widgets's are as before.
    expect(await body(await api('github/pulls/12?repo=scratch'))).toMatchObject({
      pipeline: null,
      workers: [],
      deploys: false,
      isDefault: false,
    });
    gh.fileDetails[70] = [
      { filename: 'src/server/pages.js', status: 'modified', additions: 1, deletions: 0, patch: '' },
    ];
    expect(await body(await api('github/pulls/70'))).toMatchObject({
      pipeline: { staging: 'widgets-staging', production: 'widgets', known: true },
      workers: ['widgets'],
      deploys: true,
      isDefault: true,
    });
    delete gh.fileDetails[70];

    // Promote and Roll back: refused where there's no pipeline, before anything reaches GitHub.
    const post = await browser();
    const promote = await body(await post('github/promote', { sha: 'a'.repeat(40), repo: 'scratch' }));
    expect(promote.status).toBe(409);
    expect(promote.error).toMatch(/no deploy pipeline/u);
    expect((await body(await post('github/rollback', { reason: 'broke', repo: 'scratch' }))).status).toBe(409);
    expect(gh.writes).toEqual([]);
  });

  it('answers for every repository at once, each item carrying its repository', async () => {
    other.pulls = [scratchPr(12, { title: 'Scratch open', sha: 'scr12' })];
    gh.pulls = [pr(70, { title: 'Widgets open', sha: 'sw70' })];
    await body(await api('github/sync?repo=all', { method: 'POST' }));
    const all = await body(await api('github?repo=all'));
    expect(all).toMatchObject({ status: 200, all: true, slug: null, flow: null });
    expect(all.open.map((p) => `${p.repo}#${p.number}`)).toEqual(expect.arrayContaining(['widgets#70', 'scratch#12']));
    expect(all.open.every((p) => ['widgets', 'scratch'].includes(p.repo))).toBe(true);
    expect(all.readyToMerge).toBe(all.repos.reduce((n, r) => n + r.readyToMerge, 0));
    expect(all.repos.map((r) => [r.slug, Boolean(r.flow), Boolean(r.pipeline)])).toEqual([
      ['widgets', true, true],
      ['scratch', false, false],
    ]);
    expect(all.repos[0].open).toBeUndefined(); // the lists are merged, not repeated
  });

  it('says why a button can’t work, from the last Connections check', async () => {
    await runInDurableObject(stub(), (store) =>
      store.setMeta(
        'conn_live',
        JSON.stringify({
          at: Date.now(),
          repos: {
            widgets: {
              installed: true,
              permissions: {
                metadata: 'read',
                pull_requests: 'write',
                contents: 'write',
                actions: 'write',
                deployments: 'read',
              },
              autoMerge: true,
            },
            scratch: {
              installed: true,
              permissions: { metadata: 'read', pull_requests: 'read', contents: 'read' },
              autoMerge: false,
            },
          },
        }),
      ),
    );
    const widgets = await body(await api('github'));
    expect(widgets.access).toMatchObject({ write: { ok: true }, autoMerge: { ok: true }, actions: { ok: true } });
    const scratch = await body(await api('github?repo=scratch'));
    expect(scratch.access.write).toMatchObject({ ok: false });
    expect(scratch.access.write.reason).toMatch(/Pull requests and Contents/u);
    expect(scratch.access.autoMerge.ok).toBe(false);
    await runInDurableObject(stub(), (store) => store.setMeta('conn_live', null));
  });

  it('reads another repository’s pipeline and deploy paths from the registry and its own branch', async () => {
    const patch = (input) => api('repos/scratch', { method: 'PATCH', body: input });
    expect(
      (
        await patch({
          pipeline: {
            workers: { staging: 'scratch-staging', production: 'scratch' },
            workflows: { promote: 'ship.yml' },
            deployPaths: 'deploy-paths.json',
          },
        })
      ).status,
    ).toBe(200);
    other.deployPaths = { scratch: '^src/' };
    other.pulls = [scratchPr(12, { title: 'Scratch open', sha: 'scr12' })];
    const page = await body(await api('github/pulls/12?repo=scratch'));
    expect(page).toMatchObject({
      pipeline: { staging: 'scratch-staging', production: 'scratch', known: true },
      workers: ['scratch'],
      deploys: true,
    });
    const view = await body(await api('github/sync?repo=scratch', { method: 'POST' }));
    expect(view.pipeline).toEqual({ staging: 'scratch-staging', production: 'scratch' });
    expect(view.flow.promote).toMatchObject({ allowed: false, reason: expect.stringMatching(/Nothing on staging/u) });
    const post = await browser();
    expect((await body(await post('github/promote', { sha: 'a'.repeat(40), repo: 'scratch' }))).error).toMatch(
      /Nothing on staging/u,
    );
    expect(gh.writes).toEqual([]);
    expect((await patch({ pipeline: null })).status).toBe(200);
    other.deployPaths = null;
  });

  it('reads another repository’s agent prompt from its own path and branch, and says when it’s missing or unreadable (CLD-132)', async () => {
    expect(
      (await api('repos/scratch', { method: 'PATCH', body: { routine: { prompt: 'agents/prompt.md' } } })).status,
    ).toBe(200);
    // Missing: the App reads the repository, but the file isn't there. Not kept, so adding it shows at once.
    const missing = await body(await api('agents/prompt?repo=scratch'));
    expect(missing).toMatchObject({
      status: 200,
      slug: 'scratch',
      path: 'agents/prompt.md',
      missing: true,
      text: null,
    });
    other.prompt = 'You are a scratch agent.\n';
    const found = await body(await api('agents/prompt?repo=scratch'));
    expect(found).toMatchObject({
      status: 200,
      slug: 'scratch',
      path: 'agents/prompt.md',
      missing: false,
      text: other.prompt,
    });
    expect(found.url).toContain('/scratch/blob/main/agents/prompt.md');
    // Unreadable: GitHub refuses the repository, and says why.
    await runInDurableObject(stub(), (store) => {
      store.promptCache = {};
    });
    other.fail = [403, 'Resource not accessible by integration'];
    const refused = await body(await api('agents/prompt?repo=scratch'));
    expect(refused).toMatchObject({
      status: 502,
      slug: 'scratch',
      path: 'agents/prompt.md',
      error: 'Resource not accessible by integration',
      github: 403,
    });
    other.fail = null;
    expect((await body(await api('agents/prompt?repo=nowhere'))).status).toBe(404);
    expect((await api('repos/scratch', { method: 'PATCH', body: { routine: null } })).status).toBe(200);
    other.prompt = null;
  });
});
