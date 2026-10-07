import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider, fakeState } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { planDigest } from '../src/infra-runner.js';
import {
  APPROVAL_LAPSE_MS,
  appliedRules,
  approvalLapsed,
  approvalWords,
  keptForMerge,
  mergeRoute,
  newRules,
} from '../src/infra-change-approval.js';
import { REFUSED_DOCS } from '../src/store-infra-change-approval.js';

// Approving a change from the console (BRK-260, docs/specs/BRK-258-plan-from-the-board.md, "One press to approve").
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const PROVIDER = 'fakeapproval';
/** A platform with nothing on it yet, for an environment built from nothing (BRK-291). */
const EMPTY = 'fakeapprovalnew';
const encoder = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));

describe('an approval, the pure part', () => {
  const diff = {
    provider: 'x',
    environment: 'acme-staging',
    reversible: false,
    changes: [
      { op: 'scale', resource: 'svc-api', reversible: true },
      { op: 'delete', resource: 'route-api', reversible: true },
      { op: 'delete', resource: 'db-old', reversible: false },
    ],
  };

  it('keeps the drift and the deletes the change asked for, and nothing else', () => {
    const kept = keptForMerge(diff, [{ op: 'remove', resource: 'route-api' }]);
    expect(kept.changes.map((c) => c.resource)).toEqual(['svc-api', 'route-api']);
    expect(kept.reversible).toBe(true);
    expect(keptForMerge(diff, []).changes.map((c) => c.resource)).toEqual(['svc-api']);
  });

  it('names the rules that apply, and the ones that didn’t before', () => {
    const policy = {
      rules: [
        { rule: 'frozen', applies: false },
        { rule: 'destructive', applies: true },
        { rule: 'cost', applies: true },
      ],
    };
    expect(appliedRules(policy)).toEqual(['destructive', 'cost']);
    expect(newRules(['destructive'], policy)).toEqual(['cost']);
    expect(newRules(['destructive', 'cost'], policy)).toEqual([]);
    expect(appliedRules(null)).toEqual([]);
  });

  it('merges from what GitHub says, and lapses after 24 hours', () => {
    expect(mergeRoute({ mergeableState: 'clean', checks: 'success' })).toBe('now');
    expect(mergeRoute({ mergeableState: 'has_hooks' })).toBe('now');
    expect(mergeRoute({ mergeableState: 'unstable', checks: 'pending' })).toBe('wait');
    expect(mergeRoute({ mergeableState: 'unstable', checks: 'success' })).toBe('now');
    expect(mergeRoute({ mergeableState: 'blocked', checks: 'pending' })).toBe('wait');
    expect(mergeRoute({ mergeableState: null })).toBe('wait');
    expect(mergeRoute({ mergeableState: 'behind', checks: 'success' })).toBe('behind');
    expect(mergeRoute({ mergeableState: 'blocked', checks: 'failure' })).toBe('failing');
    expect(mergeRoute({ mergeableState: 'dirty', checks: 'success' })).toBe('conflicts');
    expect(mergeRoute({ mergeable: false, mergeableState: 'unknown' })).toBe('conflicts');
    const now = Date.now();
    const at = (ms) => ({ at: new Date(now - ms).toISOString() });
    expect(approvalLapsed(/** @type {any} */ (at(APPROVAL_LAPSE_MS - 60_000)), now)).toBe(false);
    expect(approvalLapsed(/** @type {any} */ (at(APPROVAL_LAPSE_MS)), now)).toBe(true);
    expect(approvalLapsed(null, now)).toBe(false);
    expect(approvalWords.frozen('staging')).toBe('Staging is frozen: unfreeze it to approve.');
  });
});

// A pretend GitHub for acme/widgets: the default branch, its files, each commit's files, pull requests, and writes.
const gh = {
  /** @type {Record<string, string>} */ files: {},
  /** @type {Record<string, Record<string, string>>} */ commits: {},
  /** @type {Record<string, Record<string, string>>} */ trees: {},
  head: 'head-1',
  /** @type {Record<string, any>} */ pulls: {},
  /** @type {Array<{ method: string, path: string, body: any }>} */ writes: [],
  /** @type {Record<string, any>} */ repo: {},
  state: 'clean',
  refuseMerge: /** @type {string | null} */ (null),
  conflict: false,
  seq: 0,
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
    const sent = init.body ? JSON.parse(init.body) : null;
    if (path === '/graphql') {
      gh.writes.push({ method, path, body: sent });
      const pull = Object.values(gh.pulls).find((p) => p.node_id === sent.variables.id);
      if (/disablePullRequestAutoMerge/u.test(sent.query)) {
        pull.auto_merge = null;
        return reply({ data: {} });
      }
      if (gh.repo.allow_auto_merge === false)
        return reply({ errors: [{ message: 'Pull request Auto merge is not allowed for this repository' }] });
      pull.auto_merge = { merge_method: sent.variables.method.toLowerCase(), sha: sent.variables.sha };
      return reply({ data: {} });
    }
    const local = path.replace('/repos/acme/widgets', '');
    if (method === 'GET') {
      if (local === '') return reply({ default_branch: 'main', ...gh.repo });
      if (local === '/git/ref/heads/main') return reply({ object: { sha: gh.head } });
      if (local === `/git/commits/${gh.head}`) return reply({ sha: gh.head, tree: { sha: `tree-${gh.head}` } });
      const pull = /^\/pulls\/(\d+)$/u.exec(local);
      if (pull) return gh.pulls[pull[1]] ? reply(gh.pulls[pull[1]]) : reply({ message: 'Not Found' }, 404);
      const file = /^\/contents\/(.+)$/u.exec(local);
      if (file) {
        const name = decodeURIComponent(file[1]);
        const ref = url.searchParams.get('ref');
        const files = (ref && gh.commits[ref]) || gh.files;
        if (name in files) {
          const text = files[name];
          return reply({ type: 'file', size: encoder.encode(text).length, encoding: 'base64', content: b64(text) });
        }
      }
      return reply({ message: 'Not Found' }, 404);
    }
    gh.writes.push({ method, path: local, body: sent });
    gh.seq += 1;
    if (method === 'POST' && local === '/git/trees') {
      const sha = `tree-new-${gh.seq}`;
      gh.trees[sha] = { ...gh.files, ...Object.fromEntries(sent.tree.map((t) => [t.path, t.content])) };
      return reply({ sha }, 201);
    }
    if (method === 'POST' && local === '/git/commits') {
      const sha = `c0ffee${String(gh.seq).padStart(4, '0')}`;
      gh.commits[sha] = gh.trees[sent.tree];
      return reply({ sha }, 201);
    }
    if (method === 'POST' && local === '/git/refs') return reply({ ref: sent.ref }, 201);
    if (method === 'PATCH' && local.startsWith('/git/refs/heads/')) {
      // Proposing again moves the board's branch, and its pull request's head with it.
      const branch = decodeURIComponent(local.slice('/git/refs/heads/'.length));
      for (const p of Object.values(gh.pulls)) if (p.head.ref === branch) p.head.sha = sent.sha;
      return reply({ object: { sha: sent.sha } });
    }
    if (method === 'DELETE' && local.startsWith('/git/refs/heads/')) return new Response(null, { status: 204 });
    if (method === 'POST' && local === '/pulls') {
      const number = 500 + Object.keys(gh.pulls).length;
      const commit = [...gh.writes].reverse().find((w) => w.path === '/git/commits');
      const sha = Object.keys(gh.commits).find((s) => gh.commits[s] === gh.trees[commit.body.tree]);
      gh.pulls[number] = {
        number,
        node_id: `PR_${number}`,
        state: 'open',
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        head: { ref: sent.head, sha },
        get mergeable_state() {
          return gh.state;
        },
        mergeable: true,
        auto_merge: null,
      };
      return reply(gh.pulls[number], 201);
    }
    const merge = /^\/pulls\/(\d+)\/merge$/u.exec(local);
    if (method === 'PUT' && merge) {
      const pull = gh.pulls[merge[1]];
      if (gh.refuseMerge) return reply({ message: gh.refuseMerge }, 405);
      if (sent.sha !== pull.head.sha)
        return reply({ message: 'Head branch was modified. Review and try the merge again.' }, 409);
      Object.assign(pull, { state: 'closed', merged: true, merged_at: new Date().toISOString() });
      return reply({ merged: true, sha: `merge-${merge[1]}` });
    }
    if (method === 'POST' && local === '/merges') {
      if (gh.conflict) return reply({ message: 'Merge conflict' }, 409);
      const pull = Object.values(gh.pulls).find((p) => p.head.ref === sent.base);
      const sha = `abcdef${String(gh.seq).padStart(4, '0')}`;
      gh.commits[sha] = { ...gh.commits[pull.head.sha] };
      pull.head.sha = sha;
      return reply({ sha }, 201);
    }
    const patch = /^\/pulls\/(\d+)$/u.exec(local);
    if (method === 'PATCH' && patch) {
      Object.assign(gh.pulls[patch[1]], sent);
      return reply(gh.pulls[patch[1]]);
    }
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('approving a change from the console', () => {
  let cookie;
  let provider;
  /** @type {ReturnType<typeof fakeProvider>} */
  let empty;
  let spy;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const FILE = '.github/breakaway-infra/apv-staging.json';
  const fileOf = () => ({ version: 1, provider: PROVIDER, resources: structuredClone(provider.state.resources) });
  /** The default branch's file, as the sync keeps it: the board compares the environment against it. */
  const want = (text, sha) =>
    inStore((s) => {
      const file = JSON.parse(text);
      s.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'apv-staging.json', 'apv-staging', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify({ resources: file.resources }),
        sha,
        Date.now(),
      );
    });
  /** Proposes a change, and answers it with the plan it previewed. */
  const propose = async (edits) => {
    const res = await body(
      await board(`infra/environments/${envs['apv-staging'].id}/changes`, {
        method: 'POST',
        body: { edits, propose: true },
      }),
    );
    expect(res.status).toBe(201);
    return res.change;
  };
  const approve = (change, extra = {}) =>
    board(`infra/changes/${change.n}/approve`, {
      method: 'POST',
      body: { sha: change.commit, digest: change.digest, ...extra },
    });
  const audit = () =>
    inStore((s) =>
      s.sql.exec("SELECT outcome, summary, by FROM infra_audit WHERE kind = 'change' ORDER BY id").toArray(),
    );
  const merges = () => gh.writes.filter((w) => w.method === 'PUT' && w.path.endsWith('/merge'));
  /** The merge reaches the default branch: the sync reads the file at the merge, and the board settles it. */
  const landMerge = async (change) => {
    gh.files[FILE] = gh.commits[change.commit][FILE];
    await want(gh.files[FILE], `merge-${change.pull.number}`);
    await inStore(async (s) => {
      const github = await s.changeGitHub(s.environmentRow(String(envs['apv-staging'].id), null));
      await s.advanceInfraChanges(github.client, github.repo);
    });
  };
  const settleDrift = () => inStore((s) => s.checkInfraDrift(envs['apv-staging'].id));
  const reject = async (change) => {
    if (gh.pulls[change.pull.number].state === 'open')
      await board(`infra/changes/${change.n}/reject`, { method: 'POST', body: {} });
  };

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    for (const [name, extra] of [
      ['apv-staging', {}],
      ['apv-watched', { observeOnly: true }],
      ['apv-first', {}],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind: 'staging', target: 'svc-api', ...extra },
        }),
      );
      envs[name] = made.environment;
    }
    // A new environment with nothing running and no target yet.
    envs['apv-new'] = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: EMPTY, name: 'apv-new', kind: 'production' },
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
  beforeEach(async () => {
    spy = mockGitHub();
    Object.assign(gh, {
      files: {},
      commits: {},
      trees: {},
      head: 'head-1',
      writes: [],
      repo: {},
      state: 'clean',
      refuseMerge: null,
      conflict: false,
    });
    gh.files[FILE] = `${JSON.stringify(fileOf(), null, 2)}\n`;
    await want(gh.files[FILE], `head-${Date.now()}`);
    await settleDrift();
    await inStore((s) => {
      s.infraChangePreviews = new Map();
      s.infraChangeCache = new Map();
      s.sql.exec('UPDATE infra_environments SET frozen = 0 WHERE id = ?', envs['apv-staging'].id);
      // A plan left open by an earlier test would cover this one's drift.
      s.sql.exec("UPDATE infra_plans SET state = 'rejected' WHERE state IN ('draft', 'waiting', 'approved')");
      s.sql.exec("DELETE FROM infra_runs WHERE phase = 'queued'");
    });
  });
  afterEach(async () => {
    spy.mockRestore();
    await inStore((s) => s.ctx.storage.deleteAlarm());
  });

  it('merges the board’s pull request at the head you saw, then approves the merged plan on that press', async () => {
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 4 }]);
    const res = await body(await approve(change));
    expect(res.status).toBe(200);
    expect(res.change).toMatchObject({ state: 'merged', approval: { by: 'owner', sha: change.commit, merge: 'now' } });
    expect(res.change.approval.digest).toBe(change.digest);
    // Squash, with the head commit: a push in between refuses.
    expect(merges()).toEqual([
      {
        method: 'PUT',
        path: `/pulls/${change.pull.number}/merge`,
        body: { sha: change.commit, merge_method: 'squash' },
      },
    ]);
    expect((await audit()).slice(-2).map((a) => [a.outcome, a.by])).toEqual([
      ['approved', 'owner'],
      ['merged', 'owner'],
    ]);

    // Merging applied nothing: the plan comes from the merge, and it's exactly the one approved.
    expect(
      await inStore((s) => s.sql.exec("SELECT COUNT(*) AS n FROM infra_runs WHERE phase = 'queued'").one().n),
    ).toBe(0);
    await landMerge(change);
    const after = await body(await board(`infra/changes/${change.n}`));
    expect(after.change.approval).toMatchObject({ settled: 'approved', plan: expect.stringMatching(/^plan-\d+$/u) });
    // The change records what it became (WEB-110): its plan, which the card follows.
    expect(after.change.outcome).toMatchObject({ kind: 'planned', plan: after.change.approval.plan });
    expect(after.change.merged).toEqual(expect.any(String));
    const plan = (await body(await board(`infra/plans/${after.change.approval.plan}`))).plan;
    expect(plan).toMatchObject({ state: 'approved', source: { kind: 'pull-request' }, changes: 1 });
    const planAudit = await inStore((s) =>
      s.sql.exec("SELECT by, summary FROM infra_audit WHERE plan = ? AND outcome = 'approved'", plan.id).toArray(),
    );
    expect(planAudit).toEqual([
      {
        by: 'owner',
        summary: expect.stringMatching(
          new RegExp(`^approved on the console before #${change.pull.number} merged; digest`, 'u'),
        ),
      },
    ]);
    // The executor has it, with its usual checks.
    expect(
      await inStore((s) => s.sql.exec("SELECT COUNT(*) AS n FROM infra_runs WHERE phase = 'queued'").one().n),
    ).toBe(1);
  });

  it('builds an environment with no target from nothing, and the Worker it adds becomes its target on approve', async () => {
    const id = envs['apv-new'].id;
    const NEW = '.github/breakaway-infra/apv-new.json';
    /** The target each plan of the empty platform was asked for. */
    const asked = [];
    const plan = empty.plan;
    empty.plan = async (ctx, desired) => {
      asked.push(ctx.scope?.target ?? null);
      return plan(ctx, desired);
    };
    const changes = (b) => board(`infra/environments/${id}/changes`, { method: 'POST', body: b });
    const app = { op: 'create', kind: 'service', name: 'acme-app', attrs: {} };
    const db = {
      op: 'create',
      kind: 'database',
      name: 'acme-db',
      attrs: {},
      bindTo: { worker: 'acme-app', binding: 'DB' },
    };
    try {
      // The preview plans against nothing: everything in the change is an add, for the target the change gives it.
      const preview = await body(await changes({ edits: [app, db] }));
      expect(preview).toMatchObject({
        status: 200,
        head: null,
        from: 'empty',
        lines: [
          '+ service acme-app',
          '+ database acme-db, bound to acme-app as DB',
          '→ apv-new’s target becomes acme-app',
        ],
        target: { name: 'acme-app', choices: ['acme-app'] },
        preview: { changes: 2 },
      });
      expect(preview.preview.diff.changes.map((c) => [c.op, c.name])).toEqual([
        ['create', 'acme-app'],
        ['create', 'acme-db'],
      ]);
      expect(asked).toEqual(['acme-app']);

      // Two services: the owner picks which one is the target.
      const web = { op: 'create', kind: 'service', name: 'acme-web', attrs: {} };
      const two = await body(await changes({ edits: [app, web] }));
      expect(two).toMatchObject({
        status: 422,
        target: { name: null, choices: ['acme-app', 'acme-web'] },
        problems: [
          { edit: null, field: 'target', message: 'The change adds 2 Services: pick which one is apv-new’s target' },
        ],
      });
      const picked = await body(await changes({ edits: [app, web], target: 'acme-web' }));
      expect(picked).toMatchObject({ status: 200, target: { name: 'acme-web' } });
      expect(picked.lines.at(-1)).toBe('→ apv-new’s target becomes acme-web');
      // A change with nothing to be the target says what to do.
      const alone = await body(await changes({ edits: [{ ...db, bindTo: undefined }] }));
      expect(alone.status).toBe(422);

      // Proposing writes the environment's first file from the change alone.
      const proposed = await body(await changes({ edits: [app, db], propose: true }));
      expect(proposed.status).toBe(201);
      const change = proposed.change;
      expect(change).toMatchObject({ target: 'acme-app', lines: preview.lines });
      expect(change.digest).toBe(preview.preview.digest);
      const file = JSON.parse(gh.commits[change.commit][NEW]);
      expect(file).toMatchObject({ version: 1, provider: EMPTY });
      expect(file.resources.map((r) => r.id)).toEqual(['service:acme-app', 'database:acme-db']);
      const pull = gh.writes.find((w) => w.path === '/pulls').body;
      expect(pull.title).toBe('Change apv-new: service acme-app, and 2 more');
      expect(pull.body).toMatch(/^Starts apv-new from nothing: its first desired state/u);
      expect(pull.body).toContain('- → apv-new’s target becomes acme-app');
      // Nothing is the target until the owner approves.
      expect((await body(await board(`infra/environments/${id}`))).environment.target).toBeNull();

      // Approving merges it and gives the environment its target, with an audit entry.
      const approved = await body(await approve(change));
      expect(approved).toMatchObject({ status: 200, change: { state: 'merged' } });
      expect((await body(await board(`infra/environments/${id}`))).environment.target).toBe('acme-app');
      const given = await inStore((s) =>
        s.sql
          .exec(
            "SELECT by, summary, environment_id FROM infra_audit WHERE kind = 'environment' AND environment = 'apv-new' AND summary LIKE '%target is%'",
          )
          .toArray(),
      );
      expect(given).toEqual([
        {
          by: 'owner',
          summary: `apv-new’s target is acme-app, from #${change.pull.number}, approved by the owner`,
          environment_id: id,
        },
      ]);

      // The plan from the merge is made for that target, and is the one approved. The sync reads the new file as added.
      gh.files[NEW] = gh.commits[change.commit][NEW];
      await inStore((s) => {
        s.sql.exec(
          `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error, added)
           VALUES ('widgets', 'apv-new.json', 'apv-new', ?, ?, ?, ?, ?, ?, NULL, 1)`,
          EMPTY,
          `merge-${change.pull.number}`,
          Date.now(),
          JSON.stringify({ resources: file.resources }),
          `merge-${change.pull.number}`,
          Date.now(),
        );
      });
      await inStore(async (s) => {
        const github = await s.changeGitHub(s.environmentRow(String(id), null));
        await s.advanceInfraChanges(github.client, github.repo);
      });
      const after = (await body(await board(`infra/changes/${change.n}`))).change;
      expect(after.approval).toMatchObject({ settled: 'approved' });
      const made = (await body(await board(`infra/plans/${after.approval.plan}`))).plan;
      expect(made).toMatchObject({ state: 'approved', changes: 2 });
      expect(asked.at(-1)).toBe('acme-app');

      // Once it's applied, the next refresh finds both from the target.
      empty.state.resources.push(
        { id: 'service:acme-app', kind: 'service', name: 'acme-app', attrs: { instances: 1 } },
        { id: 'database:acme-db', kind: 'database', name: 'acme-db', attrs: { size: 'small' } },
      );
      empty.state.relations.push({ from: 'service:acme-app', to: 'database:acme-db', kind: 'uses' });
      const seen = await inStore(async (s) => {
        await s.refreshInventory(EMPTY);
        return s.inventoryRows('WHERE i.environment = ?', id).map((r) => r.rid);
      });
      expect(seen.sort()).toEqual(['database:acme-db', 'service:acme-app']);
    } finally {
      empty.plan = plan;
    }
  });

  it('is the owner’s alone: the bearer token and an agent’s by are refused, and observe only says so', async () => {
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 5 }]);
    const agent = await api(`infra/changes/${change.n}/approve`, {
      method: 'POST',
      body: { sha: change.commit, digest: change.digest },
    });
    expect(agent.status).toBe(403);
    expect((await body(await approve(change, { by: 'claude-x' }))).status).toBe(403);
    expect(merges()).toEqual([]);
    expect((await body(await board('infra/changes/999999/approve', { method: 'POST', body: {} }))).status).toBe(404);
    await inStore((s) =>
      s.sql.exec('UPDATE infra_changes SET environment = ? WHERE n = ?', envs['apv-watched'].id, change.n),
    );
    const watched = await body(await approve(change));
    expect(watched).toMatchObject({ status: 409, error: 'Observe only: the board watches it and never changes it.' });
    await inStore((s) =>
      s.sql.exec('UPDATE infra_changes SET environment = ? WHERE n = ?', envs['apv-staging'].id, change.n),
    );
    await reject(change);
  });

  it('refuses a frozen environment, a push in between, and a plan that changed, merging nothing', async () => {
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 6 }]);
    const before = (await audit()).length;
    await inStore((s) => s.sql.exec('UPDATE infra_environments SET frozen = 1 WHERE id = ?', envs['apv-staging'].id));
    expect(await body(await approve(change))).toMatchObject({
      status: 409,
      error: 'Apv-staging is frozen: unfreeze it to approve.',
    });
    await inStore((s) => s.sql.exec('UPDATE infra_environments SET frozen = 0 WHERE id = ?', envs['apv-staging'].id));

    // The owner saw another head.
    const stale = await body(await approve(change, { sha: 'deadbeef' }));
    expect(stale).toMatchObject({ status: 409, error: approvalWords.moved(change.pull.number) });

    // What runs changed by hand since the preview: the plan at the head isn't the one seen.
    provider.state.resources[0].attrs.version = '1.0.1';
    const moved = await body(await approve(change));
    expect(moved).toMatchObject({ status: 409, error: approvalWords.changed, preview: { changes: 1 } });
    expect(moved.preview.digest).not.toBe(change.digest);
    provider.state.resources[0].attrs.version = '1.0.0';
    // A digest the board never showed.
    expect((await body(await approve(change, { digest: 'a'.repeat(64) }))).status).toBe(409);

    // Someone pushed to the board's branch: it's an ordinary pull request now.
    gh.pulls[change.pull.number].head.sha = 'f00d0000';
    const pushed = await body(await approve(change, { sha: 'f00d0000' }));
    expect(pushed).toMatchObject({ status: 409, change: { state: 'taken over' } });
    expect(merges()).toEqual([]);
    expect((await audit()).slice(before).map((a) => a.outcome)).toEqual(['taken over']);
  });

  it('approves what it proposed when nothing moved in between, even when what runs moved just before (BRK-286)', async () => {
    const edits = [{ op: 'set', resource: 'svc-api', path: 'instances', value: 7 }];
    const first = await propose(edits);
    // What runs moves by hand, and the owner proposes the same edits again on the same head: the board plans what it
    // commits as it is now, never from an earlier look, so Approve finds the plan it proposed.
    provider.state.resources[0].attrs.version = '1.0.2';
    try {
      const again = await body(
        await board(`infra/environments/${envs['apv-staging'].id}/changes`, {
          method: 'POST',
          body: { edits, propose: true },
        }),
      );
      expect(again.status).toBe(200);
      expect(again.change.digest).not.toBe(first.digest);
      expect(again.change.changes).toBe(1);
      const res = await body(await approve(again.change));
      expect(res.status).toBe(200);
      expect(res.change).toMatchObject({ state: 'merged', approval: { digest: again.change.digest } });
    } finally {
      provider.state.resources[0].attrs.version = '1.0.0';
    }
  });

  it('offers Merge for a first file whose binding edits leave it as it runs, and merging applies nothing (BRK-286)', async () => {
    const FIRST = '.github/breakaway-infra/apv-first.json';
    const svc = provider.state.resources[0];
    const was = structuredClone(svc.attrs);
    svc.attrs.uses = [{ name: 'DB', resource: 'db-main' }];
    await inStore((s) => s.refreshInventory(PROVIDER));
    // Changed by hand since the inventory last looked: the console's edits say what already runs.
    svc.attrs.instances = 3;
    svc.attrs.uses = [
      { name: 'DB', resource: 'db-main' },
      { name: 'CACHE', resource: 'db-main' },
    ];
    try {
      const res = await body(
        await board(`infra/environments/${envs['apv-first'].id}/changes`, {
          method: 'POST',
          body: {
            edits: [
              { op: 'set', resource: 'svc-api', path: 'instances', value: 3 },
              { op: 'set', resource: 'svc-api', path: 'uses', value: structuredClone(svc.attrs.uses) },
            ],
            propose: true,
          },
        }),
      );
      expect(res.status).toBe(201);
      expect(res.change).toMatchObject({ state: 'open', changes: 0 });
      expect(res.change.lines).toHaveLength(2);
      expect(res.preview).toMatchObject({ changes: 0 });
      const committed = JSON.parse(gh.commits[res.change.commit][FIRST]);
      expect(committed.resources.find((r) => r.id === 'svc-api').attrs).toMatchObject({
        instances: 3,
        uses: svc.attrs.uses,
      });

      // Approve finds nothing to apply at the head: it says merge instead, and merges nothing.
      const number = res.change.pull.number;
      const approved = await body(await approve(res.change));
      expect(approved).toMatchObject({
        status: 409,
        nothing: true,
        error: approvalWords.nothing('apv-first', number),
        preview: { changes: 0 },
        change: { state: 'open', changes: 0 },
      });
      expect(approved.changed).toBeUndefined();
      expect(merges()).toEqual([]);

      // Merge is the owner's, at the head they saw, and applies nothing.
      const merged = await body(
        await board(`github/pulls/${number}/merge`, {
          method: 'POST',
          body: { sha: res.change.commit, method: 'squash', repo: 'widgets' },
        }),
      );
      expect(merged.status).toBe(200);
      expect(merges()).toEqual([
        { method: 'PUT', path: `/pulls/${number}/merge`, body: expect.objectContaining({ sha: res.change.commit }) },
      ]);
      expect(
        await inStore((s) => s.sql.exec("SELECT COUNT(*) AS n FROM infra_runs WHERE phase = 'queued'").one().n),
      ).toBe(0);
    } finally {
      svc.attrs = was;
      await inStore((s) => s.refreshInventory(PROVIDER));
    }
  });

  it('turns on auto-merge while checks run, or merges at the first green sync without it', async () => {
    gh.state = 'blocked';
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 7 }]);
    const res = await body(await approve(change));
    expect(res.change).toMatchObject({ state: 'approved', why: null, approval: { merge: 'auto' } });
    const auto = gh.writes.find((w) => w.path === '/graphql');
    expect(auto.body.variables).toEqual({ id: `PR_${change.pull.number}`, method: 'SQUASH', sha: change.commit });
    expect(merges()).toEqual([]);
    // Proposing again resets the approval and turns auto-merge off, so the new commit doesn't merge on the old press.
    const again = await body(
      await board(`infra/environments/${envs['apv-staging'].id}/changes`, {
        method: 'POST',
        body: { edits: [{ op: 'set', resource: 'svc-api', path: 'instances', value: 8 }], propose: true },
      }),
    );
    expect(again.change).toMatchObject({ state: 'open', approval: null });
    expect(gh.pulls[change.pull.number].auto_merge).toBe(null);
    gh.pulls[change.pull.number].head.sha = again.change.commit;

    // A repository without auto-merge: the board merges at the first sync whose checks pass, with a merge commit
    // where squash isn't allowed.
    gh.repo = { allow_auto_merge: false, allow_squash_merge: false };
    const waiting = await body(await approve(again.change));
    expect(waiting.change).toMatchObject({ state: 'approved', approval: { merge: 'sync' } });
    const synced = async (data) => {
      await inStore(async (s) => {
        s.sql.exec(
          `INSERT INTO gh_pulls (repo, number, updated, state, data) VALUES ('widgets', ?, ?, 'open', ?)
           ON CONFLICT (repo, number) DO UPDATE SET data = excluded.data`,
          change.pull.number,
          new Date().toISOString(),
          JSON.stringify({ state: 'open', headSha: again.change.commit, mergeable: true, ...data }),
        );
        const github = await s.changeGitHub(s.environmentRow(String(envs['apv-staging'].id), null));
        await s.advanceInfraChanges(github.client, github.repo);
      });
      return (await body(await board(`infra/changes/${change.n}`))).change;
    };
    expect(await synced({ checks: { state: 'pending' }, mergeableState: 'blocked' })).toMatchObject({
      state: 'approved',
      why: null,
    });
    expect(await synced({ checks: { state: 'failure' }, mergeableState: 'blocked' })).toMatchObject({
      state: 'approved',
      why: approvalWords.failing(change.pull.number),
    });
    expect(merges()).toEqual([]);
    expect(await synced({ checks: { state: 'success' }, mergeableState: 'clean' })).toMatchObject({ state: 'merged' });
    expect(merges().at(-1).body).toEqual({ sha: again.change.commit, merge_method: 'merge' });
    expect((await audit()).slice(-3).map((a) => a.outcome)).toEqual(['approved', 'couldn’t merge', 'merged']);
    await landMerge(again.change);
  });

  it('updates the board’s own branch when it’s behind, and says why when it can’t merge', async () => {
    gh.state = 'behind';
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 9 }]);
    const res = await body(await approve(change));
    expect(gh.writes.find((w) => w.path === '/merges').body).toMatchObject({ base: change.branch, head: 'main' });
    const head = gh.pulls[change.pull.number].head.sha;
    expect(res.change).toMatchObject({ state: 'approved', commit: head, approval: { merge: 'auto' } });
    expect(gh.writes.find((w) => w.path === '/graphql').body.variables.sha).toBe(head);
    // The board's own update isn't someone else's push.
    await inStore((s) =>
      s.followInfraChanges('widgets', [{ number: change.pull.number, state: 'open', head: { sha: head } }]),
    );
    expect((await body(await board(`infra/changes/${change.n}`))).change.state).toBe('approved');
    await reject(change);

    // Conflicts, and a refusal of GitHub's own (a required review): the change stays approved, and says why.
    gh.state = 'dirty';
    const conflicted = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 10 }]);
    expect((await body(await approve(conflicted))).change).toMatchObject({
      state: 'approved',
      why: approvalWords.conflicts(conflicted.pull.number),
    });
    await reject(conflicted);
    gh.state = 'clean';
    gh.refuseMerge = 'At least 1 approving review is required by reviewers with write access.';
    const refused = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 11 }]);
    const out = await body(await approve(refused));
    expect(out.change.state).toBe('approved');
    expect(out.change.why).toContain('At least 1 approving review is required');
    expect(out.change.why).toContain(REFUSED_DOCS);
    expect((await audit()).at(-1)).toMatchObject({ outcome: 'couldn’t merge', by: 'board' });
    await reject(refused);
  });

  it('lapses an approval that waited 24 hours for its merge, turning auto-merge off', async () => {
    gh.state = 'blocked';
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 12 }]);
    await approve(change);
    expect(gh.pulls[change.pull.number].auto_merge).not.toBe(null);
    await inStore(async (s) => {
      const row = s.changeRow(change.n);
      const approval = JSON.parse(row.approval);
      approval.at = new Date(Date.now() - APPROVAL_LAPSE_MS - 1000).toISOString();
      s.setChangeApproval(change.n, approval);
      const github = await s.changeGitHub(s.environmentRow(String(envs['apv-staging'].id), null));
      await s.advanceInfraChanges(github.client, github.repo);
    });
    const after = (await body(await board(`infra/changes/${change.n}`))).change;
    expect(after).toMatchObject({ state: 'open', approval: null, why: approvalWords.lapsed });
    expect(gh.pulls[change.pull.number].auto_merge).toBe(null);
    expect((await audit()).at(-1)).toMatchObject({ outcome: 'lapsed', by: 'board' });
    await reject(change);
  });

  it('puts the merged plan in front of you when it isn’t the one approved', async () => {
    const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 3 }]);
    expect((await body(await approve(change))).change.state).toBe('merged');
    // Between the press and the plan, something changed by hand.
    provider.state.resources[1].attrs.size = 'medium';
    await landMerge(change);
    provider.state.resources[1].attrs.size = 'small';
    const after = (await body(await board(`infra/changes/${change.n}`))).change;
    expect(after.approval).toMatchObject({ settled: 'waits' });
    const plan = (await body(await board(`infra/plans/${after.approval.plan}`))).plan;
    expect(plan.state).toBe('waiting');
    expect(
      await inStore((s) => s.sql.exec("SELECT COUNT(*) AS n FROM infra_runs WHERE phase = 'queued'").one().n),
    ).toBe(0);
  });

  it('keeps the removals the change asked for in the merged plan', async () => {
    const change = await propose([{ op: 'remove', resource: 'route-api' }]);
    const res = await body(await approve(change));
    expect(res.change.state).toBe('merged');
    expect(res.preview.diff.changes.map((c) => [c.op, c.resource])).toEqual([['delete', 'route-api']]);
    await landMerge(change);
    const after = (await body(await board(`infra/changes/${change.n}`))).change;
    expect(after.approval.settled).toBe('approved');
    const plan = (await body(await board(`infra/plans/${after.approval.plan}`))).plan;
    expect(plan.diff.changes.map((c) => [c.op, c.resource])).toEqual([['delete', 'route-api']]);
    expect(plan.digest).toBe(
      await planDigest(keptForMerge(res.preview.diff, [{ op: 'remove', resource: 'route-api' }])),
    );
  });
  describe('what a merge became (WEB-110)', () => {
    /** The pull request merges on GitHub, not through Approve: the sync follows it, then reads the merge. */
    const mergeOnGitHub = async (change, { read = true } = {}) => {
      const pull = gh.pulls[change.pull.number];
      Object.assign(pull, {
        state: 'closed',
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: `gh-merge-${change.pull.number}`,
      });
      await inStore((s) => s.followInfraChanges('widgets', [pull]));
      if (!read) return;
      gh.files[FILE] = gh.commits[change.commit][FILE];
      await want(gh.files[FILE], `gh-merge-${change.pull.number}`);
    };
    const changeNow = async (change) => (await body(await board(`infra/changes/${change.n}`))).change;
    const outcomes = () =>
      inStore((s) =>
        s.sql
          .exec(
            "SELECT outcome, summary FROM infra_audit WHERE kind = 'change' AND outcome IN ('nothing to apply', 'planned', 'waits', 'refused') ORDER BY id",
          )
          .toArray(),
      );

    it('links the plan a change merged on GitHub makes, which waits for you', async () => {
      const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 6 }]);
      await mergeOnGitHub(change);
      expect(await changeNow(change)).toMatchObject({ state: 'merged', outcome: null, approval: null });
      await settleDrift();
      const after = await changeNow(change);
      expect(after.outcome).toMatchObject({ kind: 'waits', plan: expect.stringMatching(/^plan-\d+$/u), why: null });
      const plan = (await body(await board(`infra/plans/${after.outcome.plan}`))).plan;
      expect(plan.state).toBe('waiting');
      expect((await outcomes()).at(-1)).toEqual({
        outcome: 'waits',
        summary: `#${change.pull.number}: ${after.outcome.plan} waits for you`,
      });
      // A later compare leaves it as it was.
      await settleDrift();
      expect((await changeNow(change)).outcome).toEqual(after.outcome);
    });

    it('says nothing applies when what runs already matches the merge', async () => {
      const change = await propose([{ op: 'set', resource: 'svc-api', path: 'version', value: 'v9' }]);
      // Someone set it by hand before the merge: the merged file plans nothing.
      const svc = provider.state.resources.find((r) => r.id === 'svc-api');
      const was = svc.attrs.version;
      svc.attrs.version = 'v9';
      try {
        await mergeOnGitHub(change);
        await settleDrift();
        const after = await changeNow(change);
        expect(after.outcome).toMatchObject({ kind: 'nothing', plan: null, why: null });
        expect((await outcomes()).at(-1)).toEqual({
          outcome: 'nothing to apply',
          summary: `#${change.pull.number}: what runs already matches it`,
        });
      } finally {
        if (was === undefined) delete svc.attrs.version;
        else svc.attrs.version = was;
      }
    });

    it('waits until the board has read the merge, and says why a frozen environment holds it', async () => {
      const change = await propose([{ op: 'set', resource: 'svc-api', path: 'instances', value: 7 }]);
      await mergeOnGitHub(change, { read: false });
      // The compare before the sync reads the merged file settles nothing.
      await settleDrift();
      expect((await changeNow(change)).outcome).toBeNull();
      await inStore((s) => s.sql.exec('UPDATE infra_environments SET frozen = 1 WHERE id = ?', envs['apv-staging'].id));
      gh.files[FILE] = gh.commits[change.commit][FILE];
      await want(gh.files[FILE], `gh-merge-${change.pull.number}`);
      await settleDrift();
      expect((await changeNow(change)).outcome).toMatchObject({
        kind: 'waits',
        plan: null,
        why: 'apv-staging is frozen: it’s planned once you unfreeze it',
      });
    });
  });
});
