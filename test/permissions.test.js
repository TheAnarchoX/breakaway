// Roles enforced everywhere (BRK-301, docs/specs/BRK-299-people-and-roles.md, points 3 and 4): one permissions module,
// can(person, action, repository), and every gated write route asking it with the person behind the credential.
// Fixtures are made-up people (ana, ben, …) and repositories (acme/widgets, acme/gadgets).
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTIONS, OWN_CLAUDE, ROLE_RANK, agentOf, can, refusal, roleIn } from '../src/permissions.js';
import { NOT_YET } from '../src/people.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// ---- The spec's table, written out again here, so the module can't drift from it ------------------------------------

/**
 * Every action: the least role it needs (`owner` is the owner's alone), and whether it's press-only. The spec's
 * table in point 3, one row per action the board gates.
 * @type {Record<string, [string, boolean]>}
 */
const SPEC = {
  read: ['viewer', false],
  'pull.write': ['maintainer', true],
  'deploy.promote': ['maintainer', true],
  'workflow.run': ['maintainer', true],
  'release.prerelease': ['maintainer', true],
  'release.publish': ['maintainer', false],
  'release.pull': ['member', false],
  'github.sync': ['member', false],
  'spec.status': ['maintainer', true],
  'plan.create': ['member', false],
  'plan.approve': ['maintainer', true],
  'plan.start-again': ['maintainer', true],
  'plan.front': ['member', true],
  'change.propose': ['member', true],
  'change.approve': ['maintainer', true],
  'policy.propose': ['member', true],
  'policy.tighten': ['maintainer', true],
  'policy.loosen': ['owner', true],
  'envelope.set': ['maintainer', true],
  'envelope.set-production': ['owner', true],
  'envelope.revoke': ['maintainer', true],
  'envelope.act': ['owner', false],
  'environment.write': ['maintainer', true],
  'environment.freeze': ['maintainer', true],
  'environment.describe': ['maintainer', true],
  'inventory.refresh': ['member', true],
  'infra.check': ['member', false],
  'lock.release': ['maintainer', true],
  'drift.break-glass': ['maintainer', true],
  'github-environment.make': ['maintainer', true],
  'short-lived.ask': ['member', true],
  'runbook.trigger': ['maintainer', true],
  currency: ['owner', true],
  'provider.connect': ['owner', true],
  'decision.answer': ['maintainer', false],
  'decision.carry-on': ['maintainer', true],
  'ping.apply': ['maintainer', true],
  'ping.resolve': ['maintainer', true],
  'agent.start': ['member', false],
  'agent.force': ['maintainer', false],
  'agent.next': ['maintainer', false],
  'agent.general': ['maintainer', false],
  'agent.message': ['maintainer', true],
  'agent.settings': ['owner', false],
  'task.write': ['member', false],
  'task.plan': ['maintainer', false],
  'task.quote': ['maintainer', true],
  'task.unquote': ['maintainer', true],
  'planning.undo': ['maintainer', true],
  'risk.answer': ['maintainer', true],
  'horizon.close': ['owner', false],
  'feature.edit': ['member', false],
  'feature.shape': ['maintainer', false],
  chase: ['maintainer', false],
  'peloton.post': ['member', true],
  'peloton.plan': ['maintainer', true],
  'routine.write': ['maintainer', false],
  'routine.settings': ['owner', false],
  'repo.add': ['owner', false],
  'repo.modify': ['maintainer', false],
  'repo.init': ['maintainer', true],
  'repo.routine': ['owner', true],
  'repo.deploys': ['maintainer', true],
  'repo.move': ['maintainer', true],
  kickoff: ['owner', true],
  'connections.check': ['member', true],
  'connections.owner': ['owner', true],
  'github.setup': ['owner', false],
  'install.update': ['owner', true],
  'install.admin': ['owner', false],
  oauth: ['owner', true],
  push: ['owner', true],
  'people.manage': ['maintainer', true],
};

/** The actions an agent may take on the owner's token, as today: everything else refuses an agent's name. */
const AGENTS_MAY = new Set([
  'read',
  'release.pull',
  'github.sync',
  'plan.create',
  'envelope.act',
  'infra.check',
  'agent.start',
  'agent.next',
  'task.write',
  'task.plan',
  'feature.edit',
]);
/** Starts an agent, so it runs on the starter's own Claude (BRK-302): a person's waits until then. */
const STARTS = new Set([
  'environment.describe',
  'decision.carry-on',
  'agent.start',
  'agent.force',
  'agent.next',
  'agent.general',
  'chase',
  'repo.move',
]);
const ROLES = [null, 'viewer', 'member', 'maintainer'];
const rank = (role) => (role ? ROLE_RANK[role] : 0);
/** What the spec says a person with `role` there may do, as a press or not. */
const allowedBySpec = (action, role, press) => {
  const [need, pressOnly] = SPEC[action];
  if (pressOnly && !press) return false;
  if (need === 'owner') return false;
  return rank(role) >= rank(need);
};

describe('the permissions module (src/permissions.js)', () => {
  it('has exactly the spec’s actions, with its roles, presses, and agent ceiling', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(SPEC).sort());
    for (const [action, [role, press]] of Object.entries(SPEC)) {
      expect(ACTIONS[action].role, action).toBe(role);
      expect(Boolean(ACTIONS[action].press), action).toBe(press);
      expect(Boolean(ACTIONS[action].agents), action).toBe(AGENTS_MAY.has(action));
      expect(Boolean(ACTIONS[action].starts), action).toBe(STARTS.has(action));
    }
  });

  it('answers every action for every role, as a press and with a token', () => {
    const rows = [];
    for (const action of Object.keys(SPEC))
      for (const role of ROLES)
        for (const press of [true, false]) {
          const person = { person: 'ana', grants: role ? [{ repository: 'widgets', role }] : [], press };
          const got = can(person, action, 'widgets');
          if (got !== allowedBySpec(action, role, press)) rows.push(`${action} ${role ?? 'none'} press=${press}`);
        }
    expect(rows).toEqual([]);
  });

  it('lets the owner do everything a press may, and never lets an agent past the agent ceiling', () => {
    for (const action of Object.keys(SPEC)) {
      expect(can({ person: 'owner', press: true }, action, 'widgets'), action).toBe(true);
      expect(can({ person: 'owner', press: false }, action, 'widgets'), action).toBe(!SPEC[action][1]);
      expect(can({ person: 'owner', agent: 'claude-x-1' }, action, 'widgets'), action).toBe(AGENTS_MAY.has(action));
      // Whoever the agent works for: a maintainer's agent never merges, deploys, or approves either.
      const theirs = {
        person: 'owner',
        agent: 'claude-x-1',
        for: { person: 'ana', grants: [{ repository: 'widgets', role: 'maintainer' }] },
      };
      expect(can(theirs, action, 'widgets'), action).toBe(AGENTS_MAY.has(action) && SPEC[action][0] !== 'owner');
    }
    for (const action of ['pull.write', 'deploy.promote', 'plan.approve', 'decision.answer'])
      expect(refusal({ person: 'owner', agent: 'claude-x-1' }, action, 'widgets')?.code).toBe('agent');
  });

  it('caps an agent at the rights of the person its run is for', () => {
    const forViewer = {
      person: 'owner',
      agent: 'claude-x-1',
      for: { person: 'ana', grants: [{ repository: 'widgets', role: 'viewer' }] },
    };
    expect(can(forViewer, 'task.write', 'widgets')).toBe(false);
    expect(refusal(forViewer, 'task.write', 'widgets')?.message).toMatch(/^claude-x-1 acts for ana, and only a member/);
    const forMember = { ...forViewer, for: { person: 'ana', grants: [{ repository: 'widgets', role: 'member' }] } };
    expect(can(forMember, 'task.write', 'widgets')).toBe(true);
    expect(can(forMember, 'task.write', 'gadgets')).toBe(false);
    // A person's own token caps their agent too.
    const own = { person: 'ana', grants: [{ repository: 'widgets', role: 'member' }], agent: 'claude-x-1' };
    expect(can(own, 'task.write', 'widgets')).toBe(true);
    expect(can(own, 'task.plan', 'widgets')).toBe(false);
  });

  it('reads a role from the repository’s grant or the * grant, and install-wide only from *', () => {
    const grants = [
      { repository: 'widgets', role: 'member' },
      { repository: '*', role: 'viewer' },
    ];
    expect(roleIn(grants, 'widgets')).toBe('member');
    expect(roleIn(grants, 'gadgets')).toBe('viewer');
    expect(roleIn(grants, null)).toBe('viewer');
    expect(roleIn([{ repository: 'widgets', role: 'maintainer' }], null)).toBeNull();
    expect(can({ person: 'ana', grants: [{ repository: '*', role: 'member' }] }, 'connections.check', null)).toBe(true);
    expect(can({ person: 'ana', grants: [{ repository: 'widgets', role: 'maintainer' }] }, 'chase', null)).toBe(false);
  });

  it('says why, in words a person can act on', () => {
    const ana = { person: 'ana', grants: [{ repository: 'widgets', role: 'member' }], press: true };
    expect(refusal(ana, 'pull.write', 'widgets')?.message).toBe(
      'only a maintainer in widgets can publish, update, merge, or set auto-merge on a pull request, and ana is a member in widgets',
    );
    expect(refusal(ana, 'repo.add', null)?.message).toBe('only the owner can add, remove, or release a repository');
    expect(refusal({ ...ana, press: false }, 'pull.write', 'widgets')?.code).toBe('press');
    expect(refusal(ana, 'no.such')?.code).toBe('unknown');
  });

  it('never takes the owner, an empty name, or the person’s own handle for an agent', () => {
    expect(agentOf(undefined)).toBeNull();
    expect(agentOf('')).toBeNull();
    expect(agentOf('owner')).toBeNull();
    expect(agentOf('ana', 'ana')).toBeNull();
    expect(agentOf('claude-brk-1', 'ana')).toBe('claude-brk-1');
    expect(agentOf('board')).toBe('board');
  });
});

// ---- Every gated write route, for every role ---------------------------------------------------------------------

const COOKIE = '__Host-sw_tasks';
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));

function call(path, { method = 'GET', body, cookie, token, raw } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

async function ownerCookie() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

const owner = (path, opts = {}) => call(path, { token: TEST_API_TOKEN, ...opts });
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

/** Invites a made-up person with `grants`, and signs them in: their cookie and a personal token. */
async function person(ownerSession, handle, grants) {
  const made = await call('/api/people/invites', { method: 'POST', cookie: ownerSession, body: { grants } });
  expect(made.status).toBe(201);
  const { code } = (await made.json()).invite;
  const auth = await makeAuthenticator();
  const options = await call(`/api/join/${code}/options`, { method: 'POST', body: { name: handle, handle } });
  const { challengeId, publicKey } = await options.json();
  const credential = await auth.create(publicKey);
  const joined = await call(`/api/join/${code}`, { method: 'POST', body: { challengeId, credential } });
  expect(joined.status).toBe(201);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  expect(cookie.startsWith(`${COOKIE}=p`)).toBe(true);
  const tokens = await call('/api/me/tokens', { method: 'POST', cookie, body: { name: 'cli' } });
  return { handle, cookie, token: (await tokens.json()).token, grants };
}

/** A refusal by role (src/permissions.js): "only a maintainer in widgets can …", "only the owner can …". */
const ROLE_REFUSAL = /^only (a (viewer|member|maintainer) (in [\w*.-]+|on every repository)|the owner) can /u;

/** Everything a test here needs on the board, made once. */
let world;
let fetchSpy;

beforeAll(async () => {
  // Nothing reaches the network: GitHub and Claude answer 404 to everything.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  // A second repository, which nobody below but the outsider has a role in.
  const added = await owner('/api/repos', {
    method: 'POST',
    body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GAD'], defaultBranch: 'main' },
  });
  expect([201, 400]).toContain(added.status);
  const task = async (body) => {
    const res = await owner('/api/tasks', { method: 'POST', body: { force: true, ...body } });
    expect(res.status).toBe(201);
    return (await res.json()).tasks[0];
  };
  const gadget = await task({
    description: 'A gadget task nobody in widgets sees',
    project: 'product',
    repo: 'gadgets',
  });
  const widget = await task({
    description: 'A widget task',
    project: 'product',
    depends: [gadget.uuid],
    tags: ['perm-feat'],
  });
  const done = await task({ description: 'A widget task to finish', project: 'product' });
  const feature = unique('perm-feat');
  await owner('/api/features', { method: 'POST', body: { slug: 'perm-feat' } });
  await owner(`/api/features`, { method: 'POST', body: { slug: feature } });
  await owner(`/api/tasks/${widget.uuid}`, { method: 'PATCH', body: { addTags: [feature] } });
  const routine = unique('perm-routine');
  const made = await owner('/api/routines', {
    method: 'POST',
    body: { slug: routine, name: 'Tidy', prompt: 'Tidy up', enabled: false },
  });
  expect(made.status).toBe(201);
  // What the infrastructure routes act on: an environment, a plan, a change, a policy change, a ping, an image, and
  // an agent's planning change, made straight in the store.
  const ids = await inStore((store) => {
    const now = Date.now();
    const env = store.sql
      .exec(
        "INSERT INTO infra_environments (repo, name, kind, created, edited) VALUES ('widgets', ?, 'staging', ?, ?) RETURNING id",
        unique('perm-env'),
        now,
        now,
      )
      .one().id;
    const plan = store.sql
      .exec(
        "INSERT INTO infra_plans (environment, repo, provider, source, state, diff, cost, blast, reversible, by, created, updated) VALUES (?, 'widgets', 'fake', 'manual', 'waiting', '{\"changes\":[]}', '{}', '{}', 1, 'owner', ?, ?) RETURNING n",
        env,
        now,
        now,
      )
      .one().n;
    const change = store.sql
      .exec(
        "INSERT INTO infra_changes (n, environment, repo, name, edits, lines, branch, state, created, updated) VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM infra_changes), ?, 'widgets', 'x', '[]', '[]', 'b', 'open', ?, ?) RETURNING n",
        env,
        now,
        now,
      )
      .one().n;
    const policy = store.sql
      .exec(
        "INSERT INTO infra_policy_changes (n, repo, policy, lines, branch, state, created, updated) VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM infra_policy_changes), 'widgets', '{}', '[]', 'b', 'open', ?, ?) RETURNING n",
        now,
        now,
      )
      .one().n;
    const ping = store.sql
      .exec(
        "INSERT INTO pings (task, kind, message, agent, created) VALUES (?, 'question', 'which?', 'claude-x-1', ?) RETURNING id",
        widget.uuid,
        now,
      )
      .one().id;
    const image = store.sql
      .exec(
        "INSERT INTO attachments (task, name, type, size, alt, added_at, data) VALUES (?, 'a.png', 'image/png', 1, '', ?, ?) RETURNING id",
        widget.uuid,
        now,
        new Uint8Array([1]),
      )
      .one().id;
    const planning = store.sql
      .exec(
        "INSERT INTO planning_edits (at, agent, kind, target, fields) VALUES (?, 'claude-x-1', 'task', ?, '{}') RETURNING id",
        now,
        widget.uuid,
      )
      .one().id;
    const name = store.sql.exec('SELECT name FROM infra_environments WHERE id = ?', env).one().name;
    return { env, name, plan, change, policy, ping, image, planning };
  });
  const people = {
    viewer: await person(session, unique('vic'), [{ repository: 'widgets', role: 'viewer' }]),
    member: await person(session, unique('mia'), [{ repository: 'widgets', role: 'member' }]),
    maintainer: await person(session, unique('max'), [{ repository: 'widgets', role: 'maintainer' }]),
    // A maintainer of another repository only: a stranger to widgets.
    outsider: await person(session, unique('oli'), [{ repository: 'gadgets', role: 'maintainer' }]),
    // A member of every repository, which install-wide actions count.
    everywhere: await person(session, unique('eve'), [{ repository: '*', role: 'member' }]),
  };
  world = { session, gadget, widget, done, feature, routine, people, ...ids };
}, 120_000);

afterAll(() => fetchSpy?.mockRestore());

/** Puts the environment back as it was made, by its ID, when a maintainer's run removed it. */
const restoreEnvironment = () =>
  inStore((store) => {
    const now = Date.now();
    store.sql.exec(
      "INSERT OR IGNORE INTO infra_environments (id, repo, name, kind, created, edited) VALUES (?, 'widgets', ?, 'staging', ?, ?)",
      world.env,
      world.name,
      now,
      now,
    );
  });

/** The role a person has where a route acts: their grant there, or their `*` grant. */
const roleOf = (who, repo) => roleIn(who.grants, repo);

/**
 * Every gated write route: its method, path, body, the action it gates on, and where it acts (`widgets`, or null for
 * the whole install). Built once the world exists, from its IDs.
 */
function routes(w) {
  const t = w.widget.uuid;
  const env = encodeURIComponent(w.name);
  const r = (method, path, action, body = {}, repo = 'widgets', tokenAction = action) => ({
    method,
    path,
    action,
    body,
    repo,
    tokenAction,
  });
  return [
    // Tasks
    r('POST', '/api/tasks', 'task.write', { description: unique('Added by hand'), project: 'product', force: true }),
    r('POST', '/api/tasks', 'task.plan', { description: unique('Starts by itself'), autostart: 'yes', force: true }),
    r('PATCH', `/api/tasks/${t}`, 'task.write', { priority: 'L' }),
    r('PATCH', `/api/tasks/${t}`, 'task.plan', { addTags: ['horizon-now'] }),
    r('POST', `/api/tasks/${t}/comments`, 'task.write', { text: 'a note' }),
    r('POST', `/api/tasks/${w.done.uuid}/done`, 'task.write', {}),
    r('POST', `/api/tasks/${t}/claim`, 'task.write', { agent: 'claude-perm-1' }),
    r('POST', `/api/tasks/${t}/claim`, 'task.plan', { agent: 'claude-perm-2', force: true }),
    r('POST', `/api/tasks/${t}/release`, 'task.write', { agent: 'nobody-holds-it' }),
    r('POST', `/api/tasks/${t}/release`, 'task.plan', { agent: 'nobody', force: true }),
    r('POST', `/api/tasks/${t}/review`, 'task.write', {}),
    r('POST', `/api/tasks/${t}/risk-review`, 'task.write', {}),
    r('POST', `/api/tasks/${t}/risk-answer`, 'risk.answer', {}, 'widgets', 'task.write'),
    r('POST', `/api/tasks/${t}/session`, 'task.write', {}),
    r('POST', `/api/tasks/${t}/paths`, 'task.plan', {}),
    r('POST', `/api/tasks/${t}/pings`, 'task.write', {}),
    r('POST', `/api/tasks/${t}/messages`, 'agent.message', { text: 'hello' }),
    r('POST', `/api/tasks/${t}/said`, 'task.quote', { text: 'do it this way' }, 'widgets', 'task.write'),
    r('DELETE', `/api/tasks/${t}/said/1`, 'task.unquote'),
    r('POST', `/api/tasks/${t}/decision/answers`, 'decision.answer', { answers: {} }),
    r('POST', `/api/tasks/${t}/decision/answers`, 'decision.carry-on', { answers: {}, carryOn: true }),
    r('DELETE', `/api/tasks/${t}/decision/answers`, 'decision.answer'),
    r('POST', `/api/tasks/${t}/attachments`, 'task.write', {}),
    r('DELETE', `/api/attachments/${w.image}`, 'task.write'),
    r('POST', '/api/next', 'read', { repo: 'widgets', agent: 'claude-perm-3' }),
    r('POST', '/api/next', 'task.write', { repo: 'widgets', agent: 'claude-perm-3', claim: true }),
    // Agents
    r('POST', '/api/agents/start', 'agent.start', { ref: t }),
    r('POST', '/api/agents/start', 'agent.force', { ref: t, force: true }),
    r('POST', '/api/agents/general', 'agent.general', { repo: 'widgets', prompt: 'x', dryRun: true }),
    r('POST', '/api/agents/next', 'agent.next', { repo: 'widgets', dryRun: true }),
    r('PATCH', '/api/agents/settings', 'agent.settings', {}, null),
    r('POST', '/api/github/pulls/1/fix', 'agent.start', { repo: 'widgets' }),
    r('POST', '/api/github/alerts/1/fix', 'agent.start', { repo: 'widgets' }),
    r('POST', '/api/github/pulls/1/review', 'agent.general', { repo: 'widgets' }),
    // GitHub, releases, and specs
    r('POST', '/api/github/pulls/1/merge', 'pull.write', { repo: 'widgets' }),
    r('POST', '/api/github/promote', 'deploy.promote', { repo: 'widgets' }),
    r('POST', '/api/github/rollback', 'deploy.promote', { repo: 'widgets' }),
    r('POST', '/api/github/release', 'release.publish', { repo: 'widgets' }),
    r('POST', '/api/github/prerelease', 'release.prerelease', { repo: 'widgets' }),
    r('POST', '/api/github/workflows/run', 'workflow.run', { repo: 'widgets' }),
    r('POST', '/api/github/sync', 'github.sync', { repo: 'widgets' }),
    r('POST', '/api/github/setup', 'github.setup', {}, null),
    r('POST', '/api/specs/docs/specs/X-1-x.md?repo=widgets', 'spec.status', { status: 'approved' }),
    r('POST', '/api/releases/9.9.9/pull', 'release.pull', { dryRun: true }),
    // Planning, horizons, and the install
    r('POST', `/api/planning/${w.planning}/undo`, 'planning.undo'),
    r('POST', '/api/horizons/close', 'horizon.close', { dryRun: true }, null),
    r('POST', '/api/admin/rebuild', 'install.admin', {}, null),
    r('POST', '/api/import', 'install.admin', {}, null),
    r('POST', '/api/backfill/structure', 'install.admin', {}, null),
    r('POST', '/api/connections/check', 'connections.check', {}, null),
    r('POST', '/api/connections/github-status/override', 'connections.owner', {}, null),
    r('POST', '/api/connections/notices/x/dismiss', 'connections.owner', {}, null),
    r('PUT', '/api/infra/connections/fake', 'provider.connect', {}, null),
    r('DELETE', '/api/infra/connections/fake', 'provider.connect', {}, null),
    r('POST', '/api/self-update/check', 'install.update', {}, null),
    // Repositories and kickoffs
    r('POST', '/api/repos', 'repo.add', {}, null),
    r('PATCH', '/api/repos/widgets', 'repo.modify', {}),
    r('DELETE', '/api/repos/gadgets', 'repo.add', {}, null),
    r('POST', '/api/repos/gone/release', 'repo.add', {}, null),
    r('POST', '/api/repos/widgets/init', 'repo.init'),
    r('PUT', '/api/repos/widgets/routine', 'repo.routine', {}, null),
    r('POST', '/api/repos/widgets/pipeline', 'repo.deploys'),
    r('POST', '/api/repos/widgets/move', 'repo.move'),
    r('POST', '/api/kickoffs', 'kickoff', {}, null),
    r('POST', '/api/kickoffs/IDEA-1/images', 'kickoff', {}, null),
    // Infrastructure
    r('POST', `/api/infra/environments/${env}/describe?repo=widgets`, 'environment.describe'),
    r('POST', `/api/infra/environments/${env}/changes?repo=widgets`, 'change.propose', { edits: [] }),
    r('POST', `/api/infra/changes/${w.change}/reject`, 'change.approve'),
    r('POST', `/api/infra/changes/${w.change}/approve`, 'change.approve'),
    r('POST', '/api/infra/environments', 'environment.write', { repo: 'widgets', name: 'x', kind: 'staging' }),
    r('PATCH', `/api/infra/environments/${env}?repo=widgets`, 'environment.write'),
    r('POST', '/api/infra/policy/changes', 'policy.propose', { repo: 'widgets' }),
    r('POST', `/api/infra/policy/changes/${w.policy}/approve`, 'policy.tighten'),
    r('POST', `/api/infra/policy/changes/${w.policy}/reject`, 'policy.tighten'),
    r('PUT', '/api/infra/currency', 'currency', {}, null),
    r('POST', '/api/infra/currency/rate', 'currency', {}, null),
    r('POST', '/api/infra/check', 'infra.check', { repo: 'widgets' }),
    r('POST', '/api/infra/inventory/refresh', 'inventory.refresh', {}, null),
    r('DELETE', `/api/infra/locks/${env}?repo=widgets`, 'lock.release'),
    r('POST', `/api/infra/envelopes/${env}/act?repo=widgets`, 'envelope.act'),
    r('PUT', `/api/infra/envelopes/${env}?repo=widgets`, 'envelope.set'),
    r('DELETE', `/api/infra/envelopes/${env}?repo=widgets`, 'envelope.revoke'),
    r('POST', `/api/infra/plans/plan-${w.plan}/approve`, 'plan.approve'),
    r('POST', `/api/infra/plans/plan-${w.plan}/reject`, 'plan.approve'),
    r('POST', `/api/infra/plans/plan-${w.plan}/start-again`, 'plan.start-again'),
    r('POST', '/api/infra/plans', 'plan.create', { environment: w.name, repo: 'widgets' }),
    r('PATCH', `/api/infra/plans/plan-${w.plan}`, 'plan.front', { state: 'waiting' }),
    r('POST', `/api/infra/drift/${env}?repo=widgets`, 'inventory.refresh'),
    r('POST', `/api/infra/break-glass/${env}?repo=widgets`, 'drift.break-glass'),
    r('POST', '/api/infra/tokens/environments/staging?repo=widgets', 'github-environment.make'),
    r('POST', `/api/infra/short-lived/${t}`, 'short-lived.ask'),
    r('PUT', `/api/infra/runbooks/${w.routine}`, 'runbook.trigger'),
    r('DELETE', `/api/infra/runbooks/${w.routine}`, 'runbook.trigger'),
    // Features and chases
    r('POST', '/api/features', 'feature.shape', { slug: unique('perm-made'), tasks: [t] }),
    r('POST', '/api/features', 'feature.edit', { slug: unique('perm-loose') }, null),
    r('PATCH', '/api/features/perm-feat', 'feature.edit', { title: 'Retitled' }),
    r('POST', '/api/features/perm-feat/chase', 'chase', { dryRun: true }),
    r('POST', '/api/features/perm-feat/captain', 'task.write', {}),
    r('DELETE', `/api/features/${w.feature}`, 'feature.shape'),
    // Routines
    r('POST', '/api/routines', 'routine.write', { slug: unique('perm-r'), name: 'R', prompt: 'P', repo: 'widgets' }),
    r('POST', '/api/routines/agent', 'agent.general', { repo: 'widgets' }),
    r('PATCH', '/api/routines/settings', 'routine.settings', {}, null),
    r('PATCH', `/api/routines/${w.routine}`, 'routine.write', {}),
    r('POST', `/api/routines/${w.routine}/triggers`, 'routine.write', { label: 'hook' }),
    r('DELETE', `/api/routines/${w.routine}/triggers/999999`, 'routine.write'),
    r('POST', `/api/routines/${w.routine}/run`, 'routine.write'),
    // The peloton, pings, sign-ins, notifications, and people
    r('POST', '/api/peloton/widgets', 'peloton.post', { text: 'hello' }, 'widgets', 'task.write'),
    r('PUT', '/api/peloton/chase:perm-feat/plan', 'peloton.plan', { text: 'the plan' }, 'widgets', 'task.write'),
    r('POST', `/api/pings/${w.ping}/apply`, 'ping.apply'),
    r('POST', `/api/pings/${w.ping}/dismiss`, 'ping.resolve'),
    r('POST', `/api/pings/${w.ping}/handled`, 'ping.resolve'),
    r('POST', '/api/oauth/requests/x/approve', 'oauth', {}, null),
    r('POST', '/api/push/subscriptions', 'push', {}, null),
    r('POST', '/api/people/invites', 'people.manage', { grants: [{ repository: 'widgets', role: 'viewer' }] }),
    // Who approves an environment's plans (BRK-303): tightening is a maintainer's, loosening the owner's.
    r('PUT', `/api/infra/environments/${env}/approval?repo=widgets`, 'policy.tighten', { people: 2 }),
    // Last, since a maintainer's goes through (BRK-303): the next role finds it put back.
    r('DELETE', `/api/infra/environments/${env}?repo=widgets`, 'environment.write'),
  ];
}

/**
 * What a person's request to `route` must answer: a refusal by press or role when the spec refuses it, the wait for
 * BRK-302 when the spec allows it but it starts an agent, and otherwise anything but
 * a refusal by role (it may still fail on its own terms: no GitHub here, a missing field).
 */
async function check(route, who, credential) {
  const press = Boolean(credential.cookie);
  // A route that answers a press one way and a token another (a person's own words, or an agent's) gates on each.
  const action = press ? route.action : route.tokenAction;
  const res = await call(route.path, { method: route.method, body: route.body, ...credential });
  const body = await res.json().catch(() => ({}));
  const where = `${route.method} ${route.path} as ${who.handle} (${press ? 'cookie' : 'token'})`;
  const role = roleOf(who, route.repo);
  const allowed = allowedBySpec(action, role, press);
  expect(res.status, where).not.toBe(500);
  expect(body.error, where).not.toBe(NOT_YET);
  if (!allowed) {
    expect(res.status, `${where}: ${body.error}`).toBe(403);
    if (SPEC[action][1] && !press) expect(body.error, where).toMatch(/signed-in web board/u);
    else expect(body.error, where).toMatch(ROLE_REFUSAL);
    return;
  }
  if (STARTS.has(action)) {
    expect(res.status, where).toBe(403);
    expect(body.error, where).toBe(OWN_CLAUDE);
    return;
  }
  if (res.status === 403) expect(body.error, where).not.toMatch(ROLE_REFUSAL);
}

describe('every gated write route, for every role (BRK-301)', () => {
  it('covers every action the board gates on', () => {
    const covered = new Set(routes(world).flatMap((r) => [r.action, r.tokenAction]));
    const missing = Object.keys(SPEC).filter(
      // Not a route of its own: decided inside another route's store check.
      (a) => !covered.has(a) && !['policy.loosen', 'envelope.set-production', 'environment.freeze'].includes(a),
    );
    expect(missing).toEqual([]);
  });

  for (const role of ['viewer', 'member', 'maintainer', 'outsider', 'everywhere'])
    it(`answers a ${role}’s press on each route as the spec says`, async () => {
      const who = world.people[role];
      // What a maintainer before them deleted comes back, so every role meets the same board.
      await owner('/api/features', { method: 'POST', body: { slug: world.feature } });
      await restoreEnvironment();
      world.image = await inStore(
        (store) =>
          store.sql
            .exec(
              "INSERT INTO attachments (task, name, type, size, alt, added_at, data) VALUES (?, 'a.png', 'image/png', 1, '', ?, ?) RETURNING id",
              world.widget.uuid,
              Date.now(),
              new Uint8Array([1]),
            )
            .one().id,
      );
      const since = await inStore(
        (store) => store.sql.exec('SELECT COALESCE(MAX(id), 0) AS id FROM infra_audit').one().id,
      );
      for (const route of routes(world)) await check(route, who, { cookie: who.cookie });
      // Every press of theirs that reached the audit trail names them, never the owner (BRK-303).
      const pressed = await inStore((store) =>
        store.sql
          .exec("SELECT by, person FROM infra_audit WHERE id > ? AND by IN ('owner', 'person')", since)
          .toArray(),
      );
      for (const entry of pressed) expect(entry).toEqual({ by: 'person', person: who.handle });
    }, 120_000);

  it('answers a member’s personal token on each route as the spec says: never a press', async () => {
    const who = world.people.member;
    await restoreEnvironment();
    for (const route of routes(world)) await check(route, who, { token: who.token });
  }, 120_000);

  it('lets a person read their repository since BRK-323 (test/people-reads.test.js has the rest)', async () => {
    const who = world.people.maintainer;
    for (const path of [
      '/api/tasks',
      `/api/tasks/${world.widget.uuid}`,
      '/api/activity',
      '/api/people',
      '/api/repos',
    ]) {
      const res = await call(path, { cookie: who.cookie });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(world.gadget.uuid);
    }
    expect((await call(`/api/tasks/${world.gadget.uuid}`, { cookie: who.cookie })).status).toBe(404);
  });
});

describe('a person’s writes (BRK-301)', () => {
  it('answers a write whole, with what’s in another repository taken out (BRK-323)', async () => {
    const who = world.people.member;
    const res = await call('/api/tasks', {
      method: 'POST',
      cookie: who.cookie,
      body: { description: unique('Waits on a gadget'), project: 'product', depends: [world.gadget.uuid], force: true },
    });
    expect(res.status).toBe(201);
    const made = (await res.json()).tasks[0];
    expect(made.wid).toMatch(/^PRD-\d+$/u);
    expect(made.depends).toEqual([]);
    expect(JSON.stringify(made)).not.toContain(world.gadget.uuid);
    expect(JSON.stringify(made)).not.toContain('gadgets');
    const changed = await call(`/api/tasks/${made.uuid}`, {
      method: 'PATCH',
      cookie: who.cookie,
      body: { priority: 'M' },
    });
    const text = await changed.text();
    expect(JSON.parse(text).task.priority).toBe('M');
    expect(text).not.toContain(world.gadget.uuid);
    // What it made names the person, not the owner.
    const task = await (await owner(`/api/tasks/${made.uuid}`)).json();
    expect(task.task.briefBy ?? task.task.brief_by ?? who.handle).toBe(who.handle);
  });

  it('names the person on a comment, and never lets them write as the owner, the board, or a routine', async () => {
    const who = world.people.member;
    const t = world.widget.uuid;
    expect(
      (await call(`/api/tasks/${t}/comments`, { method: 'POST', cookie: who.cookie, body: { text: 'mine' } })).status,
    ).toBe(200);
    const task = (await (await owner(`/api/tasks/${t}`)).json()).task;
    expect(task.comments.at(-1)).toMatchObject({ text: 'mine', by: who.handle });
    for (const by of ['owner', 'board', 'routine:tidy', world.people.maintainer.handle]) {
      const res = await call(`/api/tasks/${t}/comments`, {
        method: 'POST',
        cookie: who.cookie,
        body: { text: 'x', by },
      });
      expect(res.status, by).toBe(403);
    }
    // Nor claim as someone else.
    const claimed = await call(`/api/tasks/${t}/claim`, {
      method: 'POST',
      cookie: who.cookie,
      body: { agent: world.people.viewer.handle },
    });
    expect(claimed.status).toBe(403);
    expect((await claimed.json()).error).toMatch(/is a person on this board, not an agent/u);
  });

  it('keeps a member to their own repository', async () => {
    const who = world.people.member;
    const res = await call('/api/tasks', {
      method: 'POST',
      cookie: who.cookie,
      body: { description: unique('In gadgets'), project: 'product', repo: 'gadgets', force: true },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^only a member in gadgets can .+ has no role in gadgets$/u);
    const comment = await call(`/api/tasks/${world.gadget.uuid}/comments`, {
      method: 'POST',
      cookie: who.cookie,
      body: { text: 'x' },
    });
    expect(comment.status).toBe(403);
  });

  it('lets a maintainer manage members and viewers of their repositories, and nobody else', async () => {
    const max = world.people.maintainer;
    const invite = (grants) => call('/api/people/invites', { method: 'POST', cookie: max.cookie, body: { grants } });
    const made = await invite([{ repository: 'widgets', role: 'member' }]);
    expect(made.status).toBe(201);
    expect((await made.json()).invite.code).toMatch(/^[\w-]{40,}$/u);
    for (const [grants, why] of [
      [[{ repository: 'widgets', role: 'maintainer' }], /only the owner makes someone a maintainer/],
      [[{ repository: '*', role: 'viewer' }], /only the owner gives the grant on every repository/],
      [[{ repository: 'gadgets', role: 'viewer' }], /^only a maintainer in gadgets can .+ has no role in gadgets$/u],
    ]) {
      const res = await invite(grants);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(why);
    }
    // A member of widgets is theirs to Reset; the outsider (a maintainer elsewhere) and a peer maintainer are not.
    const reset = await call(`/api/people/${world.people.member.handle}/reset`, { method: 'POST', cookie: max.cookie });
    expect(reset.status).toBe(200);
    expect((await reset.json()).invite.code).toBeTruthy();
    for (const other of [world.people.outsider, world.people.everywhere]) {
      const res = await call(`/api/people/${other.handle}/reset`, { method: 'POST', cookie: max.cookie });
      expect(res.status, other.handle).toBe(403);
    }
    // A member manages nobody, and a token never does.
    const viewerMade = await call('/api/people/invites', {
      method: 'POST',
      cookie: world.people.viewer.cookie,
      body: { grants: [{ repository: 'widgets', role: 'viewer' }] },
    });
    expect(viewerMade.status).toBe(403);
    const tokenMade = await call('/api/people/invites', {
      method: 'POST',
      token: max.token,
      body: { grants: [{ repository: 'widgets', role: 'viewer' }] },
    });
    expect(tokenMade.status).toBe(403);
  });

  it('names the maintainer who answers a decision, never the owner (BRK-303)', async () => {
    const max = world.people.maintainer;
    const made = await owner('/api/tasks', {
      method: 'POST',
      body: {
        description: unique('Pick one'),
        project: 'product',
        force: true,
        decision: [{ id: 'q', prompt: 'Which?', type: 'yesno' }],
      },
    });
    const { uuid } = (await made.json()).tasks[0];
    const res = await call(`/api/tasks/${uuid}/decision/answers`, {
      method: 'POST',
      cookie: max.cookie,
      body: { answers: { q: { value: 'yes' } } },
    });
    expect(res.status).toBe(200);
    const task = (await (await owner(`/api/tasks/${uuid}`)).json()).task;
    expect(task.decisionAnswers.by).toBe(max.handle);
    expect(task.comments.at(-1).text).toMatch(new RegExp(`^Decided by ${max.handle}: `, 'u'));
    // A viewer hears it's a maintainer's first.
    const viewer = await call(`/api/tasks/${uuid}/decision/answers`, {
      method: 'POST',
      cookie: world.people.viewer.cookie,
      body: { answers: { q: { value: 'yes' } } },
    });
    expect((await viewer.json()).error).toMatch(/^only a maintainer in widgets can answer or reopen a decision/u);
  });
});

describe('the owner, with nobody invited, as before', () => {
  it('records every run as the owner’s, and refuses a start for anyone else until BRK-302', async () => {
    const runs = await inStore((store) =>
      store.sql
        .exec('SELECT DISTINCT for_person AS p FROM agent_runs')
        .toArray()
        .map((r) => r.p),
    );
    expect(runs.every((p) => p === 'owner')).toBe(true);
    await expect(
      inStore((store) => store.startAgent(world.widget.uuid, { forPerson: world.people.member.handle })),
    ).rejects.toThrow(OWN_CLAUDE);
  });

  it('never lets an agent on the owner’s token past the agent ceiling, in the store either', async () => {
    const res = await owner(`/api/tasks/${world.widget.uuid}/decision/answers`, {
      method: 'POST',
      body: { answers: {}, by: 'claude-perm-9' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      'only the owner can answer a decision; agents ask a question and read the answer',
    );
  });
});
