import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { planDigest } from '../src/infra-runner.js';
import { planMessage, toB64u } from '../src/push.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakeapprovals';

/** The fake platform's desired state: what it runs now, with `change` applied by resource ID. */
const desired = (provider, change = {}) => ({
  version: 1,
  provider: PROVIDER,
  resources: provider.state.resources.map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) })),
});

/** A browser's push subscription, with keys of the right size: the test only counts and reads what's sent. */
async function browser(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh: toB64u(p256dh), auth: toB64u(crypto.getRandomValues(new Uint8Array(16))) } };
}

/** Stands in for the push service: records each call. */
function pushService() {
  const sent = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith('https://push.example.com/')) return real(input, init);
    sent.push(url);
    return new Response(null, { status: 201 });
  });
  return sent;
}

describe('approving and rejecting a plan (BRK-182)', () => {
  let cookie;
  let staging;
  let provider;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    staging = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name: 'appr-staging', kind: 'staging', target: 'svc-api' },
        }),
      )
    ).environment;
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runInDurableObject(store(), (s) => {
      s.sql.exec('DELETE FROM infra_policy');
      s.sql.exec('DELETE FROM push_subscriptions');
    });
  });

  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  /** Puts a desired state on the environment, as a read of its file from the default branch would. */
  const want = (state, sha) =>
    runInDurableObject(store(), (s) => {
      s.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'appr-staging.json', 'appr-staging', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo, file) DO UPDATE SET desired = excluded.desired, sha = excluded.sha, valid_sha = excluded.valid_sha`,
        PROVIDER,
        sha,
        Date.now(),
        JSON.stringify(state),
        sha,
        Date.now(),
      );
    });
  /** A draft for the environment, `instances` asked of its service, from the desired state at `sha`. */
  const draft = async (instances, sha = `sha-${instances}`) => {
    await want(desired(provider, { 'svc-api': { attrs: { instances, version: '1.0.0' } } }), sha);
    const res = await body(
      await api('infra/plans', {
        method: 'POST',
        body: { environment: staging.id, source: 'pull-request', ref: '#7' },
      }),
    );
    expect(res.status).toBe(201);
    return res.plan;
  };
  const waiting = async (instances, sha) => {
    const plan = await draft(instances, sha);
    const res = await body(await board(`infra/plans/${plan.id}`, { method: 'PATCH', body: { state: 'waiting' } }));
    expect(res.plan.state).toBe('waiting');
    return res.plan;
  };
  const audit = async (plan) =>
    (await body(await api(`infra/audit?environmentId=${staging.id}`))).entries.filter((e) => e.plan === plan).reverse();

  it('is the owner’s alone: an agent token gets 403, and so does an agent’s by from the board', async () => {
    const plan = await waiting(3);
    for (const action of ['approve', 'reject']) {
      const token = await body(await api(`infra/plans/${plan.id}/${action}`, { method: 'POST', body: {} }));
      expect(token).toMatchObject({ status: 403, error: `only the signed-in web board can ${action} a plan` });
      const agent = await body(
        await board(`infra/plans/${plan.id}/${action}`, { method: 'POST', body: { by: 'claude-a' } }),
      );
      expect(agent.status).toBe(403);
      expect((await board(`infra/plans/${plan.id}/${action}`)).status).toBe(405);
    }
    expect((await body(await api(`infra/plans/${plan.id}`))).plan.state).toBe('waiting');
    expect((await audit(plan.id)).map((e) => e.kind)).toEqual(['plan', 'plan']);
  });

  it('sends one push when a plan starts waiting, linking to it', async () => {
    const sub = await browser('https://push.example.com/send/approvals');
    expect((await board('push/subscriptions', { method: 'POST', body: sub })).status).toBe(200);
    const sent = pushService();
    const plan = await draft(4);
    expect(sent).toHaveLength(0);
    await board(`infra/plans/${plan.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    expect(sent).toEqual([sub.endpoint]);
    // Approving it sends nothing more.
    await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} });
    expect(sent).toHaveLength(1);
    // The owner approving a draft from its page puts it in front of themselves quietly: no push to the phone in hand.
    const read = await draft(5);
    const quiet = await body(
      await board(`infra/plans/${read.id}`, { method: 'PATCH', body: { state: 'waiting', quiet: true } }),
    );
    expect(quiet.plan.state).toBe('waiting');
    expect(sent).toHaveLength(1);
    expect((await audit(read.id)).map((e) => e.kind)).toEqual(['plan', 'plan']);
    await board(`infra/plans/${read.id}/reject`, { method: 'POST', body: {} });
  });

  it('words the push: the environment, that the plan waits, and why', () => {
    expect(
      planMessage(
        {
          id: 'plan-12',
          repo: 'widgets',
          environment: { id: 3, name: 'production' },
          reason: 'Production needs you.\nMore.',
        },
        'widgets tasks',
      ),
    ).toEqual({
      title: 'widgets tasks',
      body: 'widgets’s production: plan-12 waits for you\nProduction needs you.',
      tag: 'plan-12',
      url: '/#/infrastructure/3?plan=plan-12',
    });
  });

  it('approves from the owner’s cookie, keeping the digest of what was approved', async () => {
    const plan = await waiting(5);
    const res = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
    expect(res.status).toBe(200);
    expect(res.plan).toMatchObject({ state: 'approved', digest: await planDigest(plan.diff) });
    expect(res.plan.approved).toMatch(/^\d{4}-/u);
    expect((await audit(plan.id)).map((e) => [e.kind, e.by, e.outcome])).toEqual([
      ['plan', 'owner', 'draft'],
      ['plan', 'owner', 'waiting'],
      ['approve', 'owner', 'approved'],
    ]);
    const again = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
    expect(again).toMatchObject({ status: 409, error: /approved: only a plan that waits for you/u });
  });

  it('approves only a plan that waits, and refuses one in a frozen environment', async () => {
    const plan = await draft(6);
    const early = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
    expect(early).toMatchObject({ status: 409, error: /put it in front of you first/u });
    await board(`infra/plans/${plan.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { frozen: true } });
    const frozen = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
    expect(frozen).toMatchObject({ status: 409, error: /frozen/u });
    await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { frozen: false } });
    // Rejecting still goes, frozen or not, and nothing changes.
    const rejected = await body(
      await board(`infra/plans/${plan.id}/reject`, { method: 'POST', body: { reason: 'not now' } }),
    );
    expect(rejected.plan).toMatchObject({ state: 'rejected', digest: null });
    expect((await audit(plan.id)).at(-1)).toMatchObject({
      kind: 'reject',
      by: 'owner',
      summary: 'rejected by the owner: not now',
    });
  });

  it('refuses an out-of-date plan, saying to reject it: its desired state moved, or its drift no longer matches', async () => {
    const plan = await waiting(7, 'sha-old');
    expect((await body(await api(`infra/plans/${plan.id}`))).outOfDate).toBeNull();
    await want(desired(provider, { 'svc-api': { attrs: { instances: 8, version: '1.0.0' } } }), 'sha-new');
    // The plan page reads why before the owner presses anything.
    expect((await body(await api(`infra/plans/${plan.id}`))).outOfDate).toMatch(/moved from sha-old to sha-new/u);
    const moved = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
    expect(moved).toMatchObject({ status: 409, error: /out of date: .*moved from sha-old to sha-new.*Reject it/u });
    expect((await body(await board(`infra/plans/${plan.id}/reject`, { method: 'POST', body: {} }))).plan.state).toBe(
      'rejected',
    );

    // A drift plan the drift no longer matches.
    await want(desired(provider, { 'svc-api': { attrs: { instances: 9, version: '1.0.0' } } }), 'sha-drift');
    const { value: drift } = await runInDurableObject(store(), async (s) => ({
      value: await s.makeInfraPlan(staging.id, { source: 'drift', by: 'board' }),
    }));
    await board(`infra/plans/${drift.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    await runInDurableObject(store(), (s) =>
      s.keepDrift(
        { id: staging.id, repo: 'widgets' },
        {
          desiredSha: 'sha-drift',
          count: 1,
          resources: '[]',
          fingerprint: 'x',
          plan: Number(drift.id.slice(5)),
          planMatches: false,
        },
      ),
    );
    const stale = await body(await board(`infra/plans/${drift.id}/approve`, { method: 'POST', body: {} }));
    expect(stale).toMatchObject({ status: 409, error: /drift has changed since it was planned.*Reject it/u });
    await board(`infra/plans/${drift.id}/reject`, { method: 'POST', body: {} });
  });

  it('refuses a plan once its environment’s kind, provider, or target changed since it was planned (BRK-253)', async () => {
    const plan = await waiting(5, 'sha-kind');
    const patch = (b) => board(`infra/environments/${staging.id}`, { method: 'PATCH', body: b });
    const outOfDate = async () => (await body(await api(`infra/plans/${plan.id}`))).outOfDate;
    for (const [change, back, why] of [
      [{ kind: 'production' }, { kind: 'staging', gates: false }, /kind changed from staging to production/u],
      [{ provider: 'fake' }, { provider: PROVIDER }, new RegExp(`provider changed from ${PROVIDER} to fake`, 'u')],
      [{ target: 'svc-other' }, { target: 'svc-api' }, /target changed from svc-api to svc-other/u],
    ]) {
      expect((await patch(change)).status).toBe(200);
      expect(await outOfDate()).toMatch(why);
      const refused = await body(await board(`infra/plans/${plan.id}/approve`, { method: 'POST', body: {} }));
      expect(refused).toMatchObject({ status: 409, error: /out of date: .*Reject it/u });
      expect((await patch(back)).status).toBe(200);
      expect(await outOfDate()).toBeNull();
    }
    await board(`infra/plans/${plan.id}/reject`, { method: 'POST', body: {} });
  });

  it('still reads a plan once its environment is removed, and never approves it (BRK-263)', async () => {
    const gone = (
      await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name: 'appr-gone', kind: 'staging', target: 'svc-api' },
        }),
      )
    ).environment;
    await runInDurableObject(store(), (s) => {
      s.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'appr-gone.json', 'appr-gone', ?, 'sha-gone', ?, ?, 'sha-gone', ?, NULL)`,
        PROVIDER,
        Date.now(),
        JSON.stringify(desired(provider, { 'svc-api': { attrs: { instances: 4, version: '1.0.0' } } })),
        Date.now(),
      );
    });
    const made = await body(
      await api('infra/plans', { method: 'POST', body: { environment: gone.id, source: 'pull-request', ref: '#8' } }),
    );
    expect(made.status).toBe(201);
    await board(`infra/plans/${made.plan.id}`, { method: 'PATCH', body: { state: 'waiting' } });
    expect((await board(`infra/environments/${gone.id}`, { method: 'DELETE', body: {} })).status).toBe(200);

    // Named as its environment was, and out of date: the record outlives the environment, the plan can't go ahead.
    const read = await body(await api(`infra/plans/${made.plan.id}`));
    expect(read).toMatchObject({
      status: 200,
      plan: { state: 'waiting', environment: { id: gone.id, name: 'appr-gone' } },
      outOfDate: 'its environment was removed',
    });
    const refused = await board(`infra/plans/${made.plan.id}/approve`, { method: 'POST', body: {} });
    expect(refused.status).toBe(404);
  });

  it('approves a plan the repository’s policy lets through by itself, naming the rule, with no push', async () => {
    const sub = await browser('https://push.example.com/send/policy');
    await board('push/subscriptions', { method: 'POST', body: sub });
    const sent = pushService();
    await runInDurableObject(store(), (s) =>
      s.sql.exec(
        `INSERT INTO infra_policy (repo, sha, read_at, policy, valid_sha, valid_at) VALUES ('widgets', 'p1', ?, ?, 'p1', ?)`,
        Date.now(),
        JSON.stringify({
          version: 1,
          costLimit: 5,
          budget: 20,
          environments: {},
          access: { kinds: [], settings: [] },
          allow: [{ name: 'scale staging', environments: ['appr-staging'], changes: ['scale'] }],
        }),
        Date.now(),
      ),
    );
    const plan = await draft(3);
    expect(plan).toMatchObject({ state: 'approved', policy: { outcome: 'allowed', rule: 'scale staging' } });
    expect(plan.digest).toBe(await planDigest(plan.diff));
    expect((await audit(plan.id)).map((e) => [e.kind, e.by, e.summary])).toEqual([
      ['plan', 'owner', expect.stringContaining('policy allows it by “scale staging”')],
      ['plan', 'board', 'your policy’s rule “scale staging” lets it through'],
      ['approve', 'board', 'approved by your policy’s rule “scale staging”'],
    ]);
    expect(sent).toHaveLength(0);
  });

  it('lets nothing through by itself under the default policy', async () => {
    const plan = await draft(3, 'sha-default');
    expect(plan).toMatchObject({ state: 'draft', digest: null, policy: { outcome: 'needs-owner', rule: 'every' } });
  });
});
