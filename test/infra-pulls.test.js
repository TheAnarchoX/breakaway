import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider, fakeState } from './fake-infra-provider.js';
import { GitHubError } from '../src/github.js';
import { DESIRED_DIR } from '../src/infra-desired.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { RUNNER_WORKFLOW } from '../src/infra-runner.js';
import { RUNNER_NEEDS_INIT, renderRunner } from '../src/infra-runner-render.js';
import RUNNER_TEMPLATE from '../src/infra-runner-template.json';
import {
  costWords,
  INFRA_CHECK_NAME,
  infraConclusion,
  infraFilesIn,
  infraSummary,
  infraTitle,
  MAX_PULLS_PER_SYNC,
} from '../src/infra-pulls.js';

// Plans from pull requests (BRK-185, docs/specs/IDEA-19-architect.md, "Change").
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const PROVIDER = 'fakepulls';
/** A platform with nothing on it yet, for an environment built from nothing (BRK-298). */
const EMPTY = 'fakepullsnew';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

describe('which files a pull request changes in the folder', () => {
  it('names the environments it adds, changes, renames, or removes, and whether it changes the policy', () => {
    const got = infraFilesIn([
      { filename: `${DESIRED_DIR}/staging.json`, status: 'modified' },
      { filename: `${DESIRED_DIR}/preview.json`, previous_filename: `${DESIRED_DIR}/old.json`, status: 'renamed' },
      { filename: `${DESIRED_DIR}/gone.json`, status: 'removed' },
      { filename: `${DESIRED_DIR}/policy.json`, status: 'added' },
      { filename: `${DESIRED_DIR}/scaling.json`, status: 'added' },
      { filename: `${DESIRED_DIR}/templates/queue/staging.json`, status: 'added' },
      { filename: `${DESIRED_DIR}/README.md`, status: 'added' },
      { filename: `${DESIRED_DIR}/Prod.json`, status: 'added' },
      { filename: 'src/index.js', status: 'modified' },
    ]);
    expect(got.touched).toBe(true);
    expect(got.policy).toBe(true);
    expect(got.environments).toEqual([
      { environment: 'gone', path: `${DESIRED_DIR}/gone.json`, removed: true },
      { environment: 'old', path: `${DESIRED_DIR}/old.json`, removed: true },
      { environment: 'preview', path: `${DESIRED_DIR}/preview.json`, removed: false },
      { environment: 'staging', path: `${DESIRED_DIR}/staging.json`, removed: false },
    ]);
    expect(got.problems).toEqual([
      { path: `${DESIRED_DIR}/Prod.json`, message: expect.stringMatching(/isn’t an environment’s name/u) },
    ]);
    expect(infraFilesIn([{ filename: 'README.md', status: 'modified' }])).toMatchObject({ touched: false });
  });

  it('concludes failure for a file that doesn’t check or a refused plan, neutral for what couldn’t be planned', () => {
    const planned = (outcome) => ({
      environment: 'staging',
      environmentId: 1,
      path: `${DESIRED_DIR}/staging.json`,
      state: 'planned',
      problem: null,
      error: null,
      preview: { changes: 1, policy: { outcome } },
    });
    const of = (environments, extra = {}) => ({ environments, policy: null, problems: [], skipped: 0, ...extra });
    expect(infraConclusion(of([planned('needs-owner')]))).toBe('success');
    expect(infraConclusion(of([planned('allowed')]))).toBe('success');
    expect(infraConclusion(of([planned('refused')]))).toBe('failure');
    expect(infraConclusion(of([{ ...planned(null), state: 'invalid', preview: null }]))).toBe('failure');
    expect(infraConclusion(of([{ ...planned(null), state: 'to-add', preview: null }]))).toBe('neutral');
    expect(infraConclusion(of([{ ...planned(null), state: 'removed', preview: null }]))).toBe('success');
    expect(
      infraConclusion(of([planned('needs-owner')], { policy: { path: 'p', ok: false, error: { message: 'x' } } })),
    ).toBe('failure');
    expect(costWords({ delta: 6, currency: 'USD', complete: true })).toBe('adds $6 a month');
    expect(costWords({ delta: -1.5, currency: 'EUR', complete: false })).toBe(
      'saves €1.50 a month, and some of it isn’t known',
    );
    expect(costWords({ delta: null })).toBe('cost change not known');
  });
});

describe('a pull request’s plan as a check', () => {
  let cookie;
  let provider;
  let empty;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });

  /** GitHub, as a pull request's client sees it: its files, each file at its head, and the checks posted. */
  const gh = {
    /** @type {Array<Record<string, any>> | null} */ files: [],
    /** @type {Record<string, string>} */ at: {},
    /** @type {string[]} */ calls: [],
    /** @type {any[]} */ posted: [],
    refuse: false,
  };
  const client = {
    async get(path) {
      gh.calls.push(`GET ${path.split('?')[0]}`);
      if (/^\/pulls\/\d+\/files/u.test(path)) {
        if (gh.files === null) throw new GitHubError('Not Found', 404);
        return gh.files;
      }
      const m = /^\/contents\/(.+)\?ref=(.+)$/u.exec(path);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!(name in gh.at)) throw new GitHubError('Not Found', 404);
        return { type: 'file', size: gh.at[name].length, content: b64(gh.at[name]) };
      }
      throw new GitHubError('Not Found', 404);
    },
    async send(method, path, payload) {
      gh.calls.push(`${method} ${path}`);
      if (gh.refuse) throw new GitHubError('Resource not accessible by integration', 403);
      gh.posted.push(payload);
      return { id: 700 + gh.posted.length, html_url: `https://github.com/acme/widgets/runs/${700 + gh.posted.length}` };
    },
  };
  const repo = { slug: 'widgets', defaultBranch: 'main' };
  const inside = { repo: { full_name: 'acme/widgets' } };
  const pull = (number, sha, head = inside) => ({ number, state: 'open', head: { sha, ...head }, base: inside });
  const check = (pulls, r = repo) => inStore((s) => s.checkInfraPulls(client, r, pulls));
  const shown = (number) => inStore((s) => s.infraPullOut('widgets', number));

  /** A desired-state file: what the fake platform runs now, with `change` applied by resource ID. */
  const fileOf = (change = {}) =>
    JSON.stringify(
      {
        version: 1,
        provider: PROVIDER,
        resources: provider.state.resources
          .filter((r) => change[r.id] !== null)
          .map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) })),
      },
      null,
      2,
    );
  const changes = (...names) =>
    names.map((name) => ({ filename: `${DESIRED_DIR}/${name}`, status: 'modified', additions: 1, deletions: 1 }));
  const kept = () =>
    inStore((s) => ({
      plans: Number(s.sql.exec('SELECT COUNT(*) AS n FROM infra_plans').toArray()[0].n),
      audit: Number(s.sql.exec('SELECT COUNT(*) AS n FROM infra_audit').toArray()[0].n),
    }));

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    for (const [name, kind, extra] of [
      ['pulls-staging', 'staging', {}],
      ['pulls-production', 'production', {}],
      ['pulls-watched', 'staging', { observeOnly: true }],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api', ...extra },
        }),
      );
      envs[name] = made.environment;
    }
    // An environment with nothing running and no target yet.
    envs['pulls-fresh'] = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: EMPTY, name: 'pulls-fresh', kind: 'production' },
        }),
      )
    ).environment;
    provider = fakeProvider({ id: PROVIDER });
    empty = fakeProvider({
      id: EMPTY,
      state: { ...fakeState(), resources: [], relations: [], health: {}, costs: {}, events: [] },
    });
    await inStore(async (s) => {
      s.infraProviders = new ProviderRegistry();
      s.infraProviders.register(provider);
      s.infraProviders.register(empty);
      await s.refreshInventory(PROVIDER);
    });
  });
  beforeEach(() => Object.assign(gh, { files: [], at: {}, calls: [], posted: [], refuse: false }));

  it('posts the plan and the policy’s answer on the head commit, keeping no plan, and looks once per commit', async () => {
    const before = await kept();
    gh.files = changes('pulls-staging.json');
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] = fileOf({ 'route-api': { attrs: { path: '/v2/*' } } });
    await check([pull(11, 'sha-11a')]);

    expect(gh.posted).toHaveLength(1);
    const run = gh.posted[0];
    expect(run).toMatchObject({
      name: INFRA_CHECK_NAME,
      head_sha: 'sha-11a',
      status: 'completed',
      conclusion: 'success',
      output: { title: '1 change to pulls-staging' },
    });
    expect(run.output.summary).toMatch(/### pulls-staging/u);
    expect(run.output.summary).toMatch(/\| update \| api\.acme\.example \| route \|/u);
    expect(run.output.summary).toMatch(/\*\*Policy:\*\* Waits for you, by the default policy\./u);
    expect(run.output.summary).toMatch(/Merging applies nothing\./u);
    // No apply workflow at the head: a waiting note before Approve, never a failure (BRK-307).
    expect(run.output.summary).toContain(`**Before Approve:** ${RUNNER_NEEDS_INIT}`);
    // The policy is read at the head too: without one, the default decides.
    expect(gh.calls).toEqual([
      'GET /pulls/11/files',
      `GET /contents/${DESIRED_DIR}/policy.json`,
      `GET /contents/${DESIRED_DIR}/pulls-staging.json`,
      `GET /contents/${RUNNER_WORKFLOW}`,
      'POST /check-runs',
    ]);

    const page = await shown(11);
    expect(page).toMatchObject({
      sha: 'sha-11a',
      conclusion: 'success',
      title: '1 change to pulls-staging',
      check: { id: 701, url: 'https://github.com/acme/widgets/runs/701' },
      error: null,
      runner: RUNNER_NEEDS_INIT,
      environments: [
        {
          environment: 'pulls-staging',
          environmentId: envs['pulls-staging'].id,
          state: 'planned',
          preview: { changes: 1, policy: { outcome: 'needs-owner', policy: 'default' } },
        },
      ],
    });
    // A preview, not a plan: nothing to approve, and nothing in the audit trail.
    expect(await kept()).toEqual(before);

    // The same head again costs nothing; a new head is looked at again.
    gh.calls = [];
    await check([pull(11, 'sha-11a')]);
    expect(gh.calls).toEqual([]);
    await check([pull(11, 'sha-11b')]);
    expect(gh.posted.map((p) => p.head_sha)).toEqual(['sha-11a', 'sha-11b']);
  });

  it('says what the apply workflow still needs before Approve, from the workflow at the head (BRK-307)', async () => {
    const rendered = (environments) =>
      renderRunner({ environments, branch: 'main', version: '2.0.0' }, RUNNER_TEMPLATE.text).text;
    gh.files = changes('pulls-staging.json');
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] = fileOf({ 'route-api': { attrs: { path: '/v2/*' } } });

    // Rendered for it: nothing to say.
    gh.at[RUNNER_WORKFLOW] = rendered(['pulls-production', 'pulls-staging']);
    await check([pull(12, 'sha-12a')]);
    expect(gh.posted.at(-1).output.summary).not.toMatch(/Before Approve/u);
    expect((await shown(12)).runner).toBeNull();

    // Rendered before the environment was added: infra init --update.
    gh.at[RUNNER_WORKFLOW] = rendered(['pulls-production']);
    await check([pull(12, 'sha-12b')]);
    expect(gh.posted.at(-1).conclusion).toBe('success');
    expect(gh.posted.at(-1).output.summary).toContain(
      `**Before Approve:** ${RUNNER_WORKFLOW} doesn’t offer pulls-staging yet: run npx breakaway infra init --update in the repository and merge it.`,
    );

    // The repository's own, taking any environment: the board doesn't second-guess it.
    gh.at[RUNNER_WORKFLOW] =
      'name: Apply infrastructure\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        type: string\n';
    await check([pull(12, 'sha-12c')]);
    expect(gh.posted.at(-1).output.summary).not.toMatch(/Before Approve/u);

    // A pull request that brings the workflow itself isn't asked about it, and costs no read of it.
    delete gh.at[RUNNER_WORKFLOW];
    gh.files = [...changes('pulls-staging.json'), { filename: RUNNER_WORKFLOW, status: 'added' }];
    gh.calls = [];
    await check([pull(12, 'sha-12d')]);
    expect(gh.posted.at(-1).output.summary).not.toMatch(/Before Approve/u);
    expect(gh.calls).not.toContain(`GET /contents/${RUNNER_WORKFLOW}`);
  });

  it('keeps a fork’s check to what happened, not what the environment holds (BRK-253)', async () => {
    gh.files = changes('pulls-staging.json');
    // Emptying the file would delete every resource in scope: a fork mustn't read them off the public check.
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] = JSON.stringify({ version: 1, provider: PROVIDER, resources: [] });
    const names = provider.state.resources.map((r) => r.name);
    for (const [number, head] of [
      [41, { repo: { full_name: 'someone/widgets' } }],
      [42, { repo: null }],
    ]) {
      await check([pull(number, `sha-${number}`, head)]);
      const run = gh.posted.at(-1);
      expect(run.head_sha).toBe(`sha-${number}`);
      expect(run.output.summary).toMatch(/comes from outside the repository/u);
      expect(run.output.summary).toMatch(/### pulls-staging\n\n\d+ changes\./u);
      expect(run.output.summary).toMatch(/\*\*Policy:\*\*/u);
      for (const name of names) expect(run.output.summary).not.toContain(name);
      expect(run.output.summary).not.toMatch(/\| Change \|/u);
      // The board's own page keeps the detail.
      expect((await shown(number)).environments[0].preview.diff.changes.length).toBe(names.length);
    }
    // The same file from a branch of the repository shows its detail.
    await check([pull(43, 'sha-43')]);
    expect(gh.posted.at(-1).output.summary).toMatch(/\| Change \| Name \| Kind \|/u);
  });

  it('keeps a provider’s words off a fork’s check', () => {
    const result = {
      environments: [
        {
          environment: 'staging',
          environmentId: 1,
          path: `${DESIRED_DIR}/staging.json`,
          state: 'failed',
          problem: 'Cloudflare refused: the token reaches acme.example and acme-internal.example',
          error: null,
          preview: null,
        },
      ],
      policy: null,
      problems: [],
      skipped: 0,
    };
    const text = infraSummary(result, { outside: true });
    expect(text).toMatch(/### staging\n\nStaging couldn’t be planned\./u);
    expect(text).not.toMatch(/acme/u);
    expect(infraSummary(result)).toMatch(/acme-internal\.example/u);
  });

  it('reads only the files of a pull request that doesn’t change the folder, and posts nothing', async () => {
    gh.files = [{ filename: 'src/index.js', status: 'modified' }];
    await check([pull(12, 'sha-12')]);
    expect(gh.calls).toEqual(['GET /pulls/12/files']);
    expect(gh.posted).toEqual([]);
    expect(await shown(12)).toBeNull();
  });

  it('takes a pull request GitHub won’t list the files of as one that changes nothing', async () => {
    gh.files = null;
    await check([pull(20, 'sha-20')]);
    expect(gh.calls).toEqual(['GET /pulls/20/files']);
    expect(gh.posted).toEqual([]);
    expect(await shown(20)).toBeNull();
  });

  it('asks GitHub nothing for a repository with no environment the board can plan for', async () => {
    gh.files = changes('staging.json');
    await check([pull(13, 'sha-13')], { slug: 'gadgets', defaultBranch: 'main' });
    expect(gh.calls).toEqual([]);
  });

  it('fails when a file doesn’t check, naming its line and field', async () => {
    gh.files = changes('pulls-staging.json');
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] =
      '{\n  "version": 1,\n  "resources": [\n    { "id": "svc-api", "kind": "Service", "name": "api" }\n  ]\n}\n';
    await check([pull(14, 'sha-14')]);
    expect(gh.posted[0]).toMatchObject({
      conclusion: 'failure',
      output: { title: `${DESIRED_DIR}/pulls-staging.json doesn’t check` },
    });
    expect(gh.posted[0].output.summary).toMatch(/doesn’t check on line 4\. `resources\[0\]\.kind`: /u);
    expect((await shown(14)).environments[0]).toMatchObject({ state: 'invalid', error: { line: 4 } });
  });

  it('fails when the policy refuses the plan: a frozen environment', async () => {
    await board(`infra/environments/${envs['pulls-staging'].id}`, { method: 'PATCH', body: { frozen: true } });
    try {
      gh.files = changes('pulls-staging.json');
      gh.at[`${DESIRED_DIR}/pulls-staging.json`] = fileOf({ 'route-api': { attrs: { path: '/v3/*' } } });
      await check([pull(15, 'sha-15')]);
      expect(gh.posted[0]).toMatchObject({
        conclusion: 'failure',
        output: { title: 'The policy refuses pulls-staging’s plan' },
      });
      expect(gh.posted[0].output.summary).toMatch(/Refused by the default policy\.\n- Pulls-staging is frozen/u);
    } finally {
      await board(`infra/environments/${envs['pulls-staging'].id}`, { method: 'PATCH', body: { frozen: false } });
    }
  });

  it('checks against the pull request’s own policy, and fails closed when it doesn’t check', async () => {
    gh.files = changes('pulls-staging.json', 'policy.json');
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] = fileOf({ 'route-api': { attrs: { path: '/v4/*' } } });
    gh.at[`${DESIRED_DIR}/policy.json`] = JSON.stringify({
      version: 1,
      allow: [{ name: 'staging routes', environments: ['pulls-staging'], kinds: ['route'] }],
    });
    await check([pull(16, 'sha-16a')]);
    expect(gh.posted[0].conclusion).toBe('success');
    expect(gh.posted[0].output.summary).toMatch(/Let through by the repository’s policy’s rule “staging routes”\./u);

    gh.at[`${DESIRED_DIR}/policy.json`] = '{\n  "version": 1,\n  "allow": [ { "name": 3 } ]\n}';
    await check([pull(16, 'sha-16b')]);
    expect(gh.posted[1]).toMatchObject({
      conclusion: 'failure',
      output: { title: `${DESIRED_DIR}/policy.json doesn’t check` },
    });
    expect(gh.posted[1].output.summary).toMatch(/Until it’s fixed, the default policy decides\./u);
    const page = await shown(16);
    expect(page.policy).toMatchObject({ ok: false, error: { line: 3 } });
    expect(page.environments[0].preview.policy).toMatchObject({ policy: 'default', outcome: 'needs-owner' });
  });

  it('refuses an observe-only environment’s file, and says one the board doesn’t have is to add', async () => {
    gh.files = changes('pulls-watched.json', 'pulls-new.json');
    gh.at[`${DESIRED_DIR}/pulls-watched.json`] = fileOf();
    gh.at[`${DESIRED_DIR}/pulls-new.json`] = fileOf();
    await check([pull(17, 'sha-17')]);
    expect(gh.posted[0]).toMatchObject({ conclusion: 'failure', output: { title: 'Pulls-watched is observe only' } });
    const page = await shown(17);
    expect(page.environments.map((e) => [e.environment, e.state])).toEqual([
      ['pulls-new', 'to-add'],
      ['pulls-watched', 'refused'],
    ]);

    gh.files = changes('pulls-new.json');
    await check([pull(17, 'sha-17b')]);
    expect(gh.posted[1]).toMatchObject({
      conclusion: 'neutral',
      output: { title: 'Pulls-new isn’t on the board yet' },
    });
  });

  it('plans an environment with no target with the one its change gives it, or the one service its file makes (BRK-298)', async () => {
    const PATH = `${DESIRED_DIR}/pulls-fresh.json`;
    const id = envs['pulls-fresh'].id;
    /** The target each plan of the empty platform was asked for. */
    const asked = [];
    const plan = empty.plan;
    empty.plan = async (ctx, desired) => {
      asked.push(ctx.scope?.target ?? null);
      return plan(ctx, desired);
    };
    const resource = (kind, name) => ({ id: `${kind}:${name}`, kind, name, attrs: {} });
    const fileWith = (...resources) => JSON.stringify({ version: 1, provider: EMPTY, resources }, null, 2);
    const app = resource('service', 'acme-app');
    const web = resource('service', 'acme-web');
    const db = resource('database', 'acme-db');
    gh.files = [{ filename: PATH, status: 'added', additions: 1, deletions: 0 }];
    try {
      // The board's own change for the pull request names the target, as the console's preview and Approve plan it.
      await inStore((s) =>
        s.sql.exec(
          `INSERT INTO infra_changes (n, environment, repo, name, edits, lines, branch, pull, target, state, created, updated)
           VALUES (9801, ?, 'widgets', 'pulls-fresh', '[]', '[]', 'breakaway/infra/pulls-fresh-9801', 61, 'acme-web', 'open', ?, ?)`,
          id,
          Date.now(),
          Date.now(),
        ),
      );
      gh.at[PATH] = fileWith(app, web, db);
      await check([pull(61, 'sha-61')]);
      expect(gh.posted[0]).toMatchObject({ conclusion: 'success', output: { title: '3 changes to pulls-fresh' } });
      expect(gh.posted[0].output.summary).toContain(
        'pulls-fresh has no target yet: planned with acme-web, the target its change gives it.',
      );
      const page = (await shown(61)).environments[0];
      expect(page).toMatchObject({ state: 'planned', target: { name: 'acme-web', from: 'change' } });
      expect(page.preview.diff.changes.map((c) => [c.op, c.name])).toEqual([
        ['create', 'acme-app'],
        ['create', 'acme-web'],
        ['create', 'acme-db'],
      ]);
      expect(asked).toEqual(['acme-web']);

      // A hand-written first file, with no change on the board: the one service it makes.
      asked.length = 0;
      gh.at[PATH] = fileWith(app, db);
      await check([pull(62, 'sha-62')]);
      expect(gh.posted[1]).toMatchObject({ conclusion: 'success', output: { title: '2 changes to pulls-fresh' } });
      expect(gh.posted[1].output.summary).toContain(
        'pulls-fresh has no target yet: planned with acme-app, the one Service its file makes.',
      );
      expect((await shown(62)).environments[0]).toMatchObject({
        state: 'planned',
        target: { name: 'acme-app', from: 'desired' },
        preview: { changes: 2 },
      });
      expect(asked).toEqual(['acme-app']);

      // Two services and nothing to say which: it says to pick one, and plans nothing.
      asked.length = 0;
      gh.at[PATH] = fileWith(app, web, db);
      await check([pull(63, 'sha-63')]);
      expect(gh.posted[2]).toMatchObject({
        conclusion: 'neutral',
        output: { title: 'Pulls-fresh couldn’t be planned' },
      });
      expect((await shown(63)).environments[0]).toMatchObject({
        state: 'failed',
        problem:
          'pulls-fresh has no target, and its desired state makes 2 Services (acme-app, acme-web): set which one is its target on the board, then it plans',
      });
      expect(asked).toEqual([]);

      // `infra check` plans it the same way.
      const one = await body(
        await board('infra/check', {
          method: 'POST',
          body: { environment: 'pulls-fresh', repo: 'widgets', file: fileWith(app, db), policy: null },
        }),
      );
      expect(one).toMatchObject({ status: 200, preview: { changes: 2 } });
      const two = await body(
        await board('infra/check', {
          method: 'POST',
          body: { environment: 'pulls-fresh', repo: 'widgets', file: fileWith(app, web), policy: null },
        }),
      );
      expect(two).toMatchObject({ status: 422, problem: { field: 'target' } });
    } finally {
      empty.plan = plan;
      await inStore((s) => s.sql.exec('DELETE FROM infra_changes WHERE n = 9801'));
    }
  });

  it('says a removed file changes nothing', async () => {
    gh.files = [{ filename: `${DESIRED_DIR}/pulls-production.json`, status: 'removed' }];
    await check([pull(18, 'sha-18')]);
    expect(gh.posted[0]).toMatchObject({
      conclusion: 'success',
      output: { title: 'No plan: pulls-production loses its desired state' },
    });
    expect(gh.calls).not.toContain(`GET /contents/${DESIRED_DIR}/pulls-production.json`);
  });

  it('still shows the plan on the board when GitHub refuses the check, and says why', async () => {
    gh.refuse = true;
    gh.files = changes('pulls-staging.json');
    gh.at[`${DESIRED_DIR}/pulls-staging.json`] = fileOf({ 'route-api': { attrs: { path: '/v5/*' } } });
    await check([pull(19, 'sha-19')]);
    const page = await shown(19);
    expect(page).toMatchObject({ conclusion: 'success', check: null, error: /Checks permission \(read and write\)/u });
    expect(page.environments[0].state).toBe('planned');
    // Kept for the commit: the next sync doesn't ask again.
    gh.calls = [];
    await check([pull(19, 'sha-19')]);
    expect(gh.calls).toEqual([]);
  });

  it('looks at a few pull requests a sync, and the rest on the next', async () => {
    gh.files = [{ filename: 'README.md', status: 'modified' }];
    const many = Array.from({ length: MAX_PULLS_PER_SYNC + 2 }, (_, i) => pull(30 + i, `sha-${30 + i}`));
    await check(many);
    expect(gh.calls).toHaveLength(MAX_PULLS_PER_SYNC);
    gh.calls = [];
    await check(many);
    expect(gh.calls).toEqual(['GET /pulls/33/files', 'GET /pulls/34/files']);
  });

  it('summarises in words, and says where to see it on the board', () => {
    const result = {
      environments: [
        {
          environment: 'staging',
          environmentId: 1,
          path: `${DESIRED_DIR}/staging.json`,
          state: 'planned',
          problem: null,
          error: null,
          preview: {
            changes: 1,
            diff: { changes: [{ op: 'delete', name: 'main', kind: 'database' }] },
            cost: { delta: -1.5, currency: 'USD', complete: true },
            reversible: false,
            irreversible: [{ op: 'delete', name: 'main', why: 'its data goes with it' }],
            blastRadius: { affected: 1 },
            policy: { policy: 'default', outcome: 'needs-owner', rule: 'destructive', reasons: ['Can’t be undone.'] },
          },
        },
      ],
      policy: null,
      problems: [],
      skipped: 0,
    };
    expect(infraTitle(result)).toBe('1 change to staging');
    const text = infraSummary(result, { page: 'https://tasks.acme.example/#/github?pr=widgets:4' });
    expect(text).toMatch(/1 change · saves \$1\.50 a month · can’t all be undone · touches 1 other resource/u);
    expect(text).toMatch(/Can’t be undone: delete `main`\. its data goes with it/u);
    expect(text).toMatch(/\[See it on the board\]\(https:\/\/tasks\.acme\.example\/#\/github\?pr=widgets:4\)$/u);
  });
});
