import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { GitHubError } from '../src/github.js';
import { DESIRED_DIR, RESERVED_FILES } from '../src/infra-desired.js';
import { allows, checkPolicyFile, evaluatePolicy, DEFAULT_POLICY } from '../src/infra-policy.js';
import {
  checkShortLivedTemplate,
  GRACE_MS,
  MAX_SHORT_LIVED,
  REFUSED_RETRY_MS,
  renderShortLived,
  SHORT_LIVED_PATH,
  shortLivedName,
  shortLivedNext,
} from '../src/infra-short-lived.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeshort';

/** Runs the store's own call, the way the alarm does, and returns what it gave or the error. */
const inStore = (fn) =>
  runInDurableObject(store(), async (instance) => {
    try {
      return { ok: true, value: await fn(instance) };
    } catch (error) {
      return { ok: false, status: error.status ?? 400, error: error.message };
    }
  });

const TEMPLATE = {
  version: 1,
  provider: PROVIDER,
  target: 'app-{environment}',
  resources: [
    { id: 'app-{environment}', kind: 'service', name: 'app-{environment}', attrs: { instances: 1 } },
    { id: 'app-{environment}-route', kind: 'route', name: '{environment}.acme.example', attrs: { path: '/*' } },
  ],
};
const text = (value) => JSON.stringify(value, null, 2);

describe('short-lived environments, the pure part (BRK-200)', () => {
  it('names the environment after its task’s work ID', () => {
    expect(shortLivedName({ uuid: '0e6c1f7a-0000-4000-8000-000000000000', wid: 'OPS-12' })).toBe('ops-12');
    expect(shortLivedName({ uuid: '0e6c1f7a-0000-4000-8000-000000000000', wid: null })).toBe('task-0e6c1f7a');
  });

  it('reserves short-lived.json, so no environment takes its name', () => {
    expect(RESERVED_FILES).toContain('short-lived');
    expect(SHORT_LIVED_PATH).toBe(`${DESIRED_DIR}/short-lived.json`);
  });

  it('checks a template: a provider, a target and ids with the environment’s name in them', () => {
    expect(checkShortLivedTemplate(text(TEMPLATE))).toMatchObject({
      ok: true,
      template: { provider: PROVIDER, target: 'app-{environment}' },
    });
    const { provider, ...noProvider } = TEMPLATE;
    expect(checkShortLivedTemplate(text(noProvider))).toMatchObject({
      ok: false,
      error: { field: 'provider', message: /provider short-lived environments run on/u },
    });
    expect(checkShortLivedTemplate(text({ ...TEMPLATE, target: 'app' }))).toMatchObject({
      ok: false,
      error: { field: 'target', message: /with \{environment\} in it/u },
    });
    const shared = { ...TEMPLATE, resources: [{ id: 'db-main', kind: 'database', name: 'main' }] };
    expect(checkShortLivedTemplate(text(shared))).toMatchObject({
      ok: false,
      error: { field: 'resources', message: /db-main has no \{environment\} in its id/u },
    });
    expect(checkShortLivedTemplate(text({ ...TEMPLATE, extra: 1 }))).toMatchObject({
      ok: false,
      error: { field: 'extra', message: /has version, provider, resources, and target/u },
    });
    // A provider that's connected checks each kind.
    const fake = fakeProvider({ id: PROVIDER });
    const queue = { ...TEMPLATE, resources: [{ id: 'q-{environment}', kind: 'queue', name: 'q' }] };
    expect(checkShortLivedTemplate(text(queue), { provider: fake })).toMatchObject({
      ok: false,
      error: { message: /has no kind queue/u },
    });
  });

  it('makes each environment’s resources its own', () => {
    const template = checkShortLivedTemplate(text(TEMPLATE)).template;
    expect(renderShortLived(template, 'ops-12')).toEqual({
      provider: PROVIDER,
      target: 'app-ops-12',
      desired: {
        resources: [
          { id: 'app-ops-12', kind: 'service', name: 'app-ops-12', attrs: { instances: 1 } },
          { id: 'app-ops-12-route', kind: 'route', name: 'ops-12.acme.example', attrs: { path: '/*' } },
        ],
      },
    });
  });

  it('decides what happens next from the request, its task, and its plans', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const row = { state: 'creating', created: now, next_try: null, create_plan: null, remove_plan: null };
    const at = { closed: false, environment: true, createPlan: null, removePlan: null, now };
    expect(shortLivedNext(row, at)).toBe('create');
    expect(shortLivedNext({ ...row, next_try: now + 1 }, at)).toBe('wait');
    expect(shortLivedNext({ ...row, create_plan: 1 }, { ...at, createPlan: 'waiting' })).toBe('wait');
    expect(shortLivedNext({ ...row, create_plan: 1 }, { ...at, createPlan: 'applied' })).toBe('ready');
    expect(shortLivedNext({ ...row, create_plan: 1 }, { ...at, closed: true, createPlan: 'waiting' })).toBe(
      'reject-create',
    );
    expect(shortLivedNext({ ...row, create_plan: 1 }, { ...at, closed: true, createPlan: 'applying' })).toBe('wait');
    const ready = { ...row, state: 'ready', create_plan: 1 };
    expect(shortLivedNext(ready, { ...at, createPlan: 'applied' })).toBe('wait');
    expect(shortLivedNext(ready, { ...at, closed: true, createPlan: 'applied' })).toBe('remove');
    expect(shortLivedNext(ready, { ...at, createPlan: 'applied', now: now + GRACE_MS })).toBe('remove');
    const removing = { ...ready, state: 'removing', remove_plan: 2 };
    const closed = { ...at, closed: true, createPlan: 'applied' };
    expect(shortLivedNext(removing, { ...closed, removePlan: 'waiting' })).toBe('wait');
    expect(shortLivedNext(removing, { ...closed, removePlan: 'applied' })).toBe('removed');
    expect(shortLivedNext(removing, { ...closed, removePlan: 'rejected' })).toBe('keep');
    expect(shortLivedNext(removing, { ...closed, environment: false })).toBe('removed');
    expect(shortLivedNext({ ...row, state: 'removed' }, closed)).toBe('wait');
  });

  it('lets a repository’s policy name kinds of environment in an allow rule', () => {
    const file = (allow) => JSON.stringify({ version: 1, allow });
    const checked = checkPolicyFile(file([{ name: 'task environments', environmentKinds: ['short-lived'] }]));
    expect(checked).toMatchObject({ ok: true, policy: { allow: [{ environmentKinds: ['short-lived'] }] } });
    expect(checkPolicyFile(file([{ name: 'x', environmentKinds: ['preview'] }]))).toMatchObject({
      ok: false,
      error: { field: 'allow[0].environmentKinds[0]', message: /preview isn’t a kind of environment/u },
    });
    const rule = checked.policy.allow[0];
    const diff = {
      provider: 'fake',
      environment: 'ops-1',
      changes: [{ op: 'create', resource: 'a', kind: 'route', name: 'a', before: null, after: {}, reversible: true }],
      reversible: true,
    };
    expect(allows(rule, 'ops-1', diff, 'short-lived')).toBe(true);
    expect(allows(rule, 'staging', diff, 'staging')).toBe(false);
    const cost = { currency: 'USD', now: 0, delta: 0, after: 0, complete: true, unknown: [], changes: [] };
    const environment = { name: 'ops-1', kind: 'short-lived', frozen: false, gates: false };
    expect(evaluatePolicy(checked.policy, { environment, diff, cost })).toMatchObject({
      outcome: 'allowed',
      rule: 'task environments',
    });
    expect(evaluatePolicy(DEFAULT_POLICY, { environment, diff, cost })).toMatchObject({
      outcome: 'needs-owner',
      rule: 'every',
    });
    // Removing one is a delete: the destructive guard asks, whatever the rule says.
    const removal = {
      ...diff,
      changes: [{ ...diff.changes[0], op: 'delete', before: {}, after: null }],
    };
    expect(evaluatePolicy(checked.policy, { environment, diff: removal, cost })).toMatchObject({
      outcome: 'needs-owner',
      rule: 'destructive',
    });
  });
});

describe('short-lived environments in the store (BRK-200)', () => {
  let cookie;
  let provider;
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  const tick = (ahead = 0) => inStore((s) => s.shortLivedTick(Date.now() + ahead));
  const addTask = async (description, tags = ['environment']) =>
    (await body(await api('tasks', { method: 'POST', body: [{ description, project: 'ops', horizon: 'now', tags }] })))
      .tasks[0];
  const requests = async () => (await body(await api('infra/short-lived?repo=widgets'))).shortLived;
  const requestFor = async (task) => (await requests()).find((r) => r.task?.uuid === task.uuid);
  const envNamed = async (name) =>
    (await body(await api('infra/environments?repo=widgets'))).environments.find((e) => e.name === name);
  const plan = async (id) => (await body(await api(`infra/plans/${id}`))).plan;
  const audit = async (environmentId) => (await body(await api(`infra/audit?environmentId=${environmentId}`))).entries;
  /** The repository's template, as the sync reads it from the desired-state folder. */
  const readTemplate = (value, sha = 'sl-1') =>
    inStore((s) =>
      s.readDesiredStates(
        {
          async get(path) {
            if (path.startsWith(`/contents/${DESIRED_DIR}?`))
              return value === null ? [] : [{ type: 'file', name: 'short-lived.json', size: 400 }];
            if (path.startsWith(`/contents/${SHORT_LIVED_PATH}`)) return { type: 'file', content: btoa(text(value)) };
            throw new GitHubError('Not Found', 404);
          },
        },
        { slug: 'widgets', defaultBranch: 'main' },
        sha,
      ),
    );
  const readPolicy = (value, sha) =>
    inStore((s) =>
      s.readInfraPolicy(
        {
          async get() {
            return { type: 'file', content: btoa(text(value)) };
          },
        },
        { slug: 'widgets', defaultBranch: 'main' },
        sha,
        [{ type: 'file', name: 'policy.json', size: 100 }],
      ),
    );
  /** What the executor does once a plan is approved, without the runner: apply it on the fake platform. */
  const applyPlan = (id) =>
    inStore(async (s) => {
      const row = s.planRow(id);
      s.sql.exec('DELETE FROM infra_runs WHERE n = ?', Number(row.n));
      s.moveInfraPlan(id, 'applying', { by: 'executor' });
      const diff = JSON.parse(row.diff);
      await provider.apply({ environment: row.env_name, scope: { target: row.target }, observeOnly: false }, diff);
      return s.moveInfraPlan(id, 'applied', { by: 'executor' });
    });

  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    provider = fakeProvider({
      id: PROVIDER,
      state: { resources: [], relations: [], health: {}, costs: {}, restarts: {}, events: [] },
    });
    // The fake platform doesn't scope a plan; a real provider plans only what the environment's target reaches.
    const plan = provider.plan;
    provider.plan = async (ctx, desired) => {
      const all = provider.state.resources;
      provider.state.resources = all.filter((r) => r.id.startsWith(ctx.scope.target));
      try {
        return await plan(ctx, desired);
      } finally {
        provider.state.resources = all;
      }
    };
    await runInDurableObject(store(), (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
    });
  });

  it('refuses a task that asks while the repository has no template, and says where it goes', async () => {
    const task = await addTask('Try the new checkout');
    await tick();
    expect(await requestFor(task)).toMatchObject({
      state: 'refused',
      environment: null,
      askedBy: 'tag',
      error: `widgets has no template for short-lived environments: add ${SHORT_LIVED_PATH} to its default branch`,
    });
    expect(await envNamed(task.wid.toLowerCase())).toBeUndefined();
    const { templates } = await body(await api('infra/short-lived?repo=widgets'));
    expect(templates).toEqual([expect.objectContaining({ repo: 'widgets', state: 'none', path: SHORT_LIVED_PATH })]);
  });

  it('reads the template from the desired-state folder, and keeps the last valid one when it breaks', async () => {
    await readTemplate(TEMPLATE);
    const read = async () => (await body(await api('infra/short-lived?repo=widgets'))).templates[0];
    expect(await read()).toMatchObject({ state: 'valid', sha: 'sl-1', template: { target: 'app-{environment}' } });
    await readTemplate({ ...TEMPLATE, target: 'app' }, 'sl-2');
    expect(await read()).toMatchObject({
      state: 'invalid',
      sha: 'sl-1',
      error: { field: 'target' },
      template: { target: 'app-{environment}' },
    });
    await readTemplate(TEMPLATE, 'sl-3');
    expect((await read()).state).toBe('valid');
  });

  it('a task that asks gets an environment owned by it, and its plan waits for the owner under the default policy', async () => {
    const task = await addTask('Preview the onboarding');
    await tick();
    const name = task.wid.toLowerCase();
    const made = await envNamed(name);
    expect(made).toMatchObject({
      kind: 'short-lived',
      provider: PROVIDER,
      target: `app-${name}`,
      task: { uuid: task.uuid, wid: task.wid },
      gates: false,
      observeOnly: false,
    });
    const request = await requestFor(task);
    expect(request).toMatchObject({ state: 'creating', environment: made.id, askedBy: 'tag', error: null });
    const created = await plan(request.createPlan);
    expect(created).toMatchObject({
      state: 'waiting',
      by: 'board',
      source: { kind: 'short-lived', ref: task.wid },
      changes: 2,
      policy: { policy: 'default', outcome: 'needs-owner', rule: 'every' },
    });
    expect(created.diff.changes.map((c) => [c.op, c.resource])).toEqual([
      ['create', `app-${name}`],
      ['create', `app-${name}-route`],
    ]);
    expect(made.waitingPlan).toBe(created.id);
    // Nothing exists until the owner approves and the executor applies.
    expect(provider.state.resources).toEqual([]);
    const entries = await audit(made.id);
    expect(entries.find((e) => e.kind === 'environment')).toMatchObject({
      by: 'board',
      outcome: 'added',
      summary: expect.stringContaining(task.wid),
    });
    // A second tick asks nothing twice.
    await tick();
    expect((await requests()).filter((r) => r.task?.uuid === task.uuid)).toHaveLength(1);
    expect((await body(await api(`infra/plans?environment=${made.id}`))).plans).toHaveLength(1);

    // The owner approves, the executor applies, and it's ready.
    expect((await board(`infra/plans/${created.id}/approve`, { method: 'POST' })).status).toBe(200);
    expect((await applyPlan(created.id)).ok).toBe(true);
    await tick();
    expect(await requestFor(task)).toMatchObject({ state: 'ready' });
    expect(provider.state.resources.map((r) => r.id)).toEqual([`app-${name}`, `app-${name}-route`]);
  });

  it('closing the task makes the plan that removes it, which waits for the owner, and applying it removes the environment', async () => {
    const task = (await requests()).find((r) => r.state === 'ready').task;
    const name = task.wid.toLowerCase();
    const envId = (await envNamed(name)).id;
    expect((await api(`tasks/${task.wid}/done`, { method: 'POST', body: {} })).status).toBe(200);
    await tick();
    const request = await requestFor(task);
    expect(request).toMatchObject({ state: 'removing', environment: envId });
    const removal = await plan(request.removePlan);
    expect(removal).toMatchObject({
      state: 'waiting',
      by: 'board',
      source: { kind: 'short-lived', ref: task.wid },
      changes: 2,
      policy: { outcome: 'needs-owner', rule: 'destructive' },
    });
    expect(removal.diff.changes.every((c) => c.op === 'delete')).toBe(true);
    // Still there until it's applied.
    expect(await envNamed(name)).toBeDefined();
    await tick();
    expect((await requestFor(task)).removePlan).toBe(removal.id);

    expect((await board(`infra/plans/${removal.id}/approve`, { method: 'POST' })).status).toBe(200);
    expect((await applyPlan(removal.id)).ok).toBe(true);
    await tick();
    expect(await requestFor(task)).toMatchObject({ state: 'removed', environment: null });
    expect(await envNamed(name)).toBeUndefined();
    expect(provider.state.resources).toEqual([]);
    const gone = (await body(await api('infra/audit?kind=environment&limit=200'))).entries.filter(
      (e) => e.environment === name,
    );
    expect(gone.map((e) => e.outcome)).toEqual(['removed', 'added']);
    // The tag is still on the closed task: it asks for nothing more.
    await tick();
    expect((await requestFor(task)).state).toBe('removed');
  });

  it('closing a task whose plan still waits rejects that plan, and the empty environment goes at once', async () => {
    const task = await addTask('Try a cheaper plan');
    await tick();
    const request = await requestFor(task);
    expect((await plan(request.createPlan)).state).toBe('waiting');
    await api(`tasks/${task.wid}/done`, { method: 'POST', body: {} });
    await tick();
    expect(await plan(request.createPlan)).toMatchObject({ state: 'rejected' });
    await tick();
    expect(await requestFor(task)).toMatchObject({ state: 'removed', removePlan: null });
    expect(await envNamed(task.wid.toLowerCase())).toBeUndefined();
  });

  it('a repository’s policy may let the plan that makes one through, never the plan that removes it', async () => {
    await readPolicy({ version: 1, allow: [{ name: 'task environments', environmentKinds: ['short-lived'] }] }, 'p-1');
    const task = await addTask('Demo for the meeting');
    await tick();
    const request = await requestFor(task);
    const created = await plan(request.createPlan);
    expect(created).toMatchObject({
      state: 'approved',
      policy: { policy: 'repository', outcome: 'allowed', rule: 'task environments' },
    });
    await applyPlan(created.id);
    await api(`tasks/${task.wid}/done`, { method: 'POST', body: {} });
    await tick();
    await tick();
    const removal = await plan((await requestFor(task)).removePlan);
    expect(removal).toMatchObject({ state: 'waiting', policy: { outcome: 'needs-owner', rule: 'destructive' } });
    await board(`infra/plans/${removal.id}/reject`, { method: 'POST', body: {} });
    // The owner keeps it: the board asks again only after another grace period.
    await tick();
    expect(await requestFor(task)).toMatchObject({ state: 'ready', removePlan: null });
    await tick();
    expect((await requestFor(task)).removePlan).toBeNull();
    await tick(GRACE_MS + 1000);
    expect((await requestFor(task)).state).toBe('removing');
    await readPolicy({ version: 1 }, 'p-2');
  });

  it('an environment whose task stays open is offered for removal after the grace period', async () => {
    const task = await addTask('Long-running experiment');
    await tick();
    const request = await requestFor(task);
    expect(request.removeBy).toBe(new Date(Date.parse(request.created) + GRACE_MS).toISOString());
    await tick(GRACE_MS - 60_000);
    expect((await requestFor(task)).state).toBe('creating');
    await tick(GRACE_MS + 1000);
    // Nothing was made yet (its plan still waits), so the board rejects nothing: it waits for the owner's answer.
    expect((await requestFor(task)).state).toBe('creating');
    await board(`infra/plans/${request.createPlan}/reject`, { method: 'POST', body: {} });
    await tick(GRACE_MS + 1000);
    expect(await requestFor(task)).toMatchObject({ state: 'removed' });
  });

  it('makes at most a few at once in a repository', async () => {
    const open = async () =>
      (await body(await api('infra/environments?repo=widgets'))).environments.filter((e) => e.kind === 'short-lived')
        .length;
    const tasks = [];
    while ((await open()) < MAX_SHORT_LIVED) {
      tasks.push(await addTask(`Preview ${tasks.length}`));
      await tick();
    }
    const over = await addTask('One too many');
    await tick();
    expect(await requestFor(over)).toMatchObject({
      state: 'refused',
      error: `widgets has ${MAX_SHORT_LIVED} short-lived environments already: close a task that has one first`,
    });
    // Looked at again in a while; once one closes, it gets its turn.
    const freed = (await requests()).find((r) => r.state === 'creating');
    await api(`tasks/${freed.task.wid}/done`, { method: 'POST', body: {} });
    await tick();
    await tick();
    expect((await requestFor(over)).state).toBe('refused');
    await tick(REFUSED_RETRY_MS + 1000);
    expect((await requestFor(over)).state).toBe('creating');
  });

  it('the owner asks from the board; the bearer token and an agent’s by can’t', async () => {
    const task = await addTask('Owner’s own preview', []);
    const viaToken = await body(await api(`infra/short-lived/${task.wid}`, { method: 'POST', body: {} }));
    expect(viaToken).toMatchObject({ status: 403, error: /agents tag their task \+environment/u });
    const asAgent = await body(await board(`infra/short-lived/${task.wid}`, { method: 'POST', body: { by: 'bot' } }));
    expect(asAgent.status).toBe(403);
    const asked = await body(await board(`infra/short-lived/${task.wid}`, { method: 'POST', body: {} }));
    // The repository is at its cap from the test before: the press says so.
    expect(asked).toMatchObject({ status: 409, error: /short-lived environments already/u });
    expect(await requestFor(task)).toMatchObject({ state: 'refused', askedBy: 'owner' });
  });

  it('only GET and POST answer', async () => {
    expect((await board('infra/short-lived', { method: 'DELETE' })).status).toBe(404);
  });
});
