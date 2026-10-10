// Who must approve a plan (BRK-303, docs/specs/BRK-299-people-and-roles.md, point 7): an approval rule per environment,
// the two-person rule, and the owner's Approve alone. Fixtures are made-up people and repositories.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RULE,
  approvalState,
  approveRefusal,
  checkRule,
  loosens,
  ruleWords,
} from '../src/infra-approval-rules.js';
import { makeAuthenticator } from './authenticator.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

describe('approval rules, the pure part (src/infra-approval-rules.js)', () => {
  it('checks a rule, and defaults to one maintainer', () => {
    expect(checkRule({})).toEqual(DEFAULT_RULE);
    expect(checkRule({ role: 'owner', people: 2 })).toEqual({ role: 'owner', people: 2 });
    expect(() => checkRule({ role: 'member' })).toThrow(/role must be maintainer or owner/);
    expect(() => checkRule({ people: 3 })).toThrow(/people must be 1 or 2/);
  });

  it('says a change loosens when it lowers the role or the people', () => {
    expect(loosens({ role: 'maintainer', people: 1 }, { role: 'maintainer', people: 2 })).toBe(false);
    expect(loosens({ role: 'maintainer', people: 1 }, { role: 'owner', people: 1 })).toBe(false);
    expect(loosens({ role: 'maintainer', people: 2 }, { role: 'maintainer', people: 1 })).toBe(true);
    expect(loosens({ role: 'owner', people: 1 }, { role: 'maintainer', people: 2 })).toBe(true);
    expect(ruleWords({ role: 'maintainer', people: 2 })).toBe('two different maintainers');
  });

  it('counts two different people, never the proposer, and lets the owner approve alone only with nobody else', () => {
    const rule = { role: 'maintainer', people: 2 };
    const eligible = ['owner', 'ana', 'ben'];
    const first = approvalState(rule, { approvals: [{ person: 'ana', at: 1 }], eligible, proposer: 'ben' });
    expect(first.needs).toBe(1);
    expect(first.mayApprove).toEqual(['owner']);
    expect(first.alone).toBe(true);
    const what = 'plan-1';
    expect(approveRefusal(rule, 'ana', { approvals: [{ person: 'ana' }], eligible, what })).toMatch(/already/);
    expect(approveRefusal(rule, 'ben', { approvals: [], eligible, proposer: 'ben', what })).toMatch(/you proposed/);
    expect(approveRefusal(rule, 'cat', { approvals: [], eligible, what })).toMatch(/only a maintainer/);
    expect(approveRefusal(rule, 'ben', { approvals: [{ person: 'ana' }], eligible, what })).toBeNull();
    const ownerRule = { role: 'owner', people: 1 };
    expect(approveRefusal(ownerRule, 'ana', { approvals: [], eligible: ['owner'], what })).toMatch(
      /only the owner approves plan-1/,
    );
  });
});

// ---- On the board ---------------------------------------------------------------------------------------------------

const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const unique = (base) => `${base}${Math.random().toString(36).slice(2, 7)}`;

function call(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** Invites a made-up person with `grants`, and signs them in. */
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
  return { handle, cookie: joined.headers.get('Set-Cookie').split(';')[0] };
}

/** An environment in `repo`, by name. */
const environment = (repo) =>
  inStore((store) => {
    const now = Date.now();
    const name = unique('appr');
    store.sql.exec(
      "INSERT INTO infra_environments (repo, name, kind, provider, created, edited) VALUES (?, ?, ?, 'fake', ?, ?)",
      repo,
      name,
      'production',
      now,
      now,
    );
    return name;
  });

/** A plan that waits on environment `name`, by its ID; `proposer` pressed for its draft, when given. */
const waitingPlan = (name, proposer = null) =>
  inStore((store) => {
    const now = Date.now();
    const envRow = store.sql.exec('SELECT id, repo FROM infra_environments WHERE name = ?', name).one();
    const n = store.sql
      .exec(
        "INSERT INTO infra_plans (environment, repo, provider, source, state, diff, cost, blast, reversible, by, created, updated) VALUES (?, ?, 'fake', 'manual', 'waiting', '{\"changes\":[]}', '{}', '{}', 1, 'owner', ?, ?) RETURNING n",
        envRow.id,
        envRow.repo,
        now,
        now,
      )
      .one().n;
    if (proposer)
      store.appendInfraAudit({
        kind: 'plan',
        repo: envRow.repo,
        environment: name,
        environmentId: envRow.id,
        plan: `plan-${n}`,
        ...(proposer === 'owner' ? { by: 'owner' } : { by: 'person', person: proposer }),
        outcome: 'draft',
        summary: 'a test draft',
      });
    return `plan-${n}`;
  });

/** A plan's page as the owner reads it: a person's answers are cut until BRK-323 filters reads. */
const planPage = async (plan) => (await call(`/api/infra/plans/${plan}`, { token: TEST_API_TOKEN })).json();
const planState = async (plan) => (await planPage(plan)).plan.state;

const audit = (plan) =>
  inStore((store) =>
    store.sql.exec('SELECT by, person, outcome, summary FROM infra_audit WHERE plan = ? ORDER BY id', plan).toArray(),
  );

let world;
let fetchSpy;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}, { status: 404 }));
  const session = await ownerCookie();
  const added = await call('/api/repos', {
    method: 'POST',
    token: TEST_API_TOKEN,
    body: { slug: 'gizmos', github: 'acme/gizmos', areas: ['product:GIZ'], defaultBranch: 'main' },
  });
  expect([201, 400]).toContain(added.status);
  world = {
    session,
    ana: await person(session, unique('ana'), [{ repository: 'widgets', role: 'maintainer' }]),
    ben: await person(session, unique('ben'), [{ repository: 'widgets', role: 'maintainer' }]),
    mia: await person(session, unique('mia'), [{ repository: 'widgets', role: 'member' }]),
  };
}, 60_000);

afterAll(() => fetchSpy?.mockRestore());

const approve = (plan, who, body = {}) =>
  call(`/api/infra/plans/${plan}/approve`, { method: 'POST', cookie: who.cookie, body });
const setRule = (name, who, rule, repo = 'widgets') =>
  call(`/api/infra/environments/${name}/approval?repo=${repo}`, { method: 'PUT', cookie: who.cookie, body: rule });

describe('approving a plan under its environment’s rule (BRK-303)', () => {
  it('lets one maintainer approve by default, and names them in the audit trail', async () => {
    const name = await environment('widgets');
    const plan = await waitingPlan(name);
    const rule = await (
      await call(`/api/infra/environments/${name}/approval?repo=widgets`, { cookie: world.session })
    ).json();
    expect(rule.rule).toEqual(DEFAULT_RULE);
    expect(rule.approvers).toEqual(expect.arrayContaining(['owner', world.ana.handle, world.ben.handle]));
    expect(rule.approvers).not.toContain(world.mia.handle);
    const res = await approve(plan, world.ana);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await planState(plan)).toBe('approved');
    const approved = (await audit(plan)).find((e) => e.outcome === 'approved');
    expect(approved).toMatchObject({ by: 'person', person: world.ana.handle });
    expect(approved.summary).toMatch(new RegExp(`^approved by ${world.ana.handle}; digest `, 'u'));
  });

  it('keeps the owner’s approval the owner’s, as before', async () => {
    const name = await environment('widgets');
    const plan = await waitingPlan(name);
    const res = await approve(plan, { cookie: world.session });
    expect(res.status).toBe(200);
    const approved = (await audit(plan)).find((e) => e.outcome === 'approved');
    expect(approved).toMatchObject({ by: 'owner', person: 'owner' });
    expect(approved.summary).toMatch(/^approved by the owner; digest /u);
  });

  it('needs two different people under the two-person rule, and refuses one person approving twice', async () => {
    const name = await environment('widgets');
    expect((await setRule(name, world.ana, { people: 2 })).status).toBe(200);
    const plan = await waitingPlan(name);
    const first = await approve(plan, world.ana);
    expect(first.status).toBe(200);
    const kept = await planPage(plan);
    expect(kept.plan.state).toBe('waiting');
    expect(kept.approval.needs).toBe(1);
    expect(kept.approval.approvals.map((a) => a.person)).toEqual([world.ana.handle]);
    expect(kept.approval.mayApprove).toEqual(expect.arrayContaining(['owner', world.ben.handle]));
    expect(kept.approval.mayApprove).not.toContain(world.ana.handle);
    expect(kept.approval.words).toBe('two different maintainers');

    const again = await approve(plan, world.ana);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/you’ve approved plan-\d+ already/u);

    const second = await approve(plan, world.ben);
    expect(second.status).toBe(200);
    expect(await planState(plan)).toBe('approved');
    const entries = await audit(plan);
    expect(entries.find((e) => e.outcome === 'needs another approval')).toMatchObject({
      by: 'person',
      person: world.ana.handle,
    });
    expect(entries.find((e) => e.outcome === 'approved')).toMatchObject({ by: 'person', person: world.ben.handle });
    expect(entries.find((e) => e.outcome === 'approved').summary).toBe(
      `approved by ${world.ana.handle} and ${world.ben.handle}`,
    );
  });

  it('never counts the person who proposed it under the two-person rule', async () => {
    const name = await environment('widgets');
    expect((await setRule(name, world.ana, { people: 2 })).status).toBe(200);
    const plan = await waitingPlan(name, world.ana.handle);
    const res = await approve(plan, world.ana);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/you proposed plan-\d+/u);
  });

  it('lets a maintainer tighten the rule, and only the owner loosen it, each in the audit trail', async () => {
    const name = await environment('widgets');
    expect((await setRule(name, world.ana, { people: 2 })).status).toBe(200);
    const loosen = await setRule(name, world.ana, { people: 1 });
    expect(loosen.status).toBe(403);
    expect((await loosen.json()).error).toMatch(/only the owner/u);
    expect((await setRule(name, { cookie: world.session }, { people: 1 })).status).toBe(200);
    // A member doesn't change it, and a bearer token never does.
    expect((await setRule(name, world.mia, { people: 2 })).status).toBe(403);
    const token = await call(`/api/infra/environments/${name}/approval?repo=widgets`, {
      method: 'PUT',
      token: TEST_API_TOKEN,
      body: { people: 2 },
    });
    expect(token.status).toBe(403);
    const entries = await inStore((store) =>
      store.sql
        .exec("SELECT by, person, outcome FROM infra_audit WHERE environment = ? AND kind = 'policy' ORDER BY id", name)
        .toArray(),
    );
    expect(entries).toEqual([
      { by: 'person', person: world.ana.handle, outcome: 'tightened' },
      { by: 'owner', person: 'owner', outcome: 'loosened' },
    ]);
  });

  it('keeps a plan the owner’s alone when its rule says so', async () => {
    const name = await environment('widgets');
    expect((await setRule(name, world.ana, { role: 'owner' })).status).toBe(200);
    const plan = await waitingPlan(name);
    const res = await approve(plan, world.ana);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only the owner approves plan-\d+/u);
    expect((await approve(plan, { cookie: world.session })).status).toBe(200);
  });

  it('lets the owner approve alone when nobody else could, with the override in the audit trail', async () => {
    // Nobody but the owner maintains gizmos.
    const name = await environment('gizmos');
    expect((await setRule(name, { cookie: world.session }, { people: 2 }, 'gizmos')).status).toBe(200);
    const plan = await waitingPlan(name);
    const first = await approve(plan, { cookie: world.session });
    expect((await first.json()).approval).toMatchObject({ needs: 1, alone: true, mayApprove: [] });
    const alone = await approve(plan, { cookie: world.session }, { alone: true });
    expect(alone.status).toBe(200);
    expect((await alone.json()).plan.state).toBe('approved');
    const approved = (await audit(plan)).find((e) => e.outcome === 'approved');
    expect(approved.summary).toMatch(
      /^approved alone by the owner, overriding its environment’s rule \(two different maintainers\)/u,
    );

    // In widgets, where another maintainer could approve, alone is refused, and it's never a person's.
    const other = await environment('widgets');
    expect((await setRule(other, world.ana, { people: 2 })).status).toBe(200);
    const waiting = await waitingPlan(other);
    const refused = await approve(waiting, { cookie: world.session }, { alone: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/can approve plan-\d+ too: ask them/u);
    expect((await approve(waiting, world.ana, { alone: true })).status).toBe(403);
  });
});

describe('while the owner is the only person on the board (the owner’s call, 9 Oct)', () => {
  it('neither shows nor enforces the two-person rule: a rule of two acts as one', async () => {
    const name = await environment('widgets');
    expect((await setRule(name, { cookie: world.session }, { people: 2 })).status).toBe(200);
    const plan = await waitingPlan(name);
    // Everyone invited is removed for a moment: the owner is alone again.
    const removed = await inStore((store) =>
      store.sql
        .exec('UPDATE people SET removed = ? WHERE removed IS NULL RETURNING handle', Date.now())
        .toArray()
        .map((r) => r.handle),
    );
    try {
      const rule = await (
        await call(`/api/infra/environments/${name}/approval?repo=widgets`, { cookie: world.session })
      ).json();
      expect(rule.shown).toBe(false);
      expect(rule.rule.people).toBe(1);
      expect((await planPage(plan)).approval).toBeNull();
      expect((await approve(plan, { cookie: world.session })).status).toBe(200);
      expect(await planState(plan)).toBe('approved');
    } finally {
      await inStore((store) => {
        for (const handle of removed) store.sql.exec('UPDATE people SET removed = NULL WHERE handle = ?', handle);
      });
    }
    // With people again, the rule of two is back, as it was kept.
    const back = await (
      await call(`/api/infra/environments/${name}/approval?repo=widgets`, { cookie: world.session })
    ).json();
    expect(back).toMatchObject({ shown: true, rule: { people: 2 } });
  });
});

describe('words that name who pressed, not the owner (BRK-303)', () => {
  it('names who set an envelope, and who pressed the Promote a Deployment came from', async () => {
    const name = await environment('widgets');
    const { setter, presser, owners, later } = await inStore((store) => {
      const id = store.sql.exec('SELECT id FROM infra_environments WHERE name = ?', name).one().id;
      store.sql.exec(
        "INSERT INTO infra_envelopes (environment, repo, envelope, created, edited, person) VALUES (?, 'widgets', '{}', 1, 1, 'ana')",
        id,
      );
      store.sql.exec(
        "INSERT INTO gh_events (at, data, repo) VALUES (?, ?, 'widgets')",
        Date.now() - 1000,
        JSON.stringify({ kind: 'promote_started', sha7: 'abcdef1', by: 'ben' }),
      );
      const deploy = { sha: 'abcdef1234', created: new Date().toISOString() };
      return {
        setter: store.envelopeSetter(id),
        presser: store.deployPresser('widgets', deploy, 'promote'),
        owners: store.deployPresser('widgets', { ...deploy, sha: '9999999' }, 'promote'),
        // A Roll back made on GitHub a day after the board's last press isn't that press's.
        later: (() => {
          store.sql.exec(
            "INSERT INTO gh_events (at, data, repo) VALUES (?, ?, 'widgets')",
            Date.now() - 2 * 86_400_000,
            JSON.stringify({ kind: 'rollback_started', by: 'ben' }),
          );
          return store.deployPresser(
            'widgets',
            { sha: 'x', created: new Date(Date.now() - 86_400_000).toISOString() },
            'rollback',
          );
        })(),
      };
    });
    expect(setter).toBe('ana');
    expect(presser).toBe('ben');
    // A Deployment from a commit nobody promoted on the board is the owner's, as before.
    expect(owners).toBe('owner');
    expect(later).toBe('owner');
  });
});
