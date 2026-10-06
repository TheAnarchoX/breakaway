import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { CHECK_PER_MINUTE, checkInfraFolder, problemLine } from '../src/infra-check.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const PROVIDER = 'fakecheck';

/** A desired-state file's text: what the fake platform runs now, with `change` applied by resource ID (null drops one). */
const fileOf = (provider, change = {}) =>
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

describe('infra check, the files (CLI-14)', () => {
  it('names the file, line, and field of a desired state that doesn’t check, and checks the policy beside it', () => {
    const staging =
      '{\n  "version": 1,\n  "resources": [\n    { "id": "svc-api", "kind": "Service", "name": "api" }\n  ]\n}\n';
    const result = checkInfraFolder([
      { name: 'staging.json', text: staging },
      { name: 'production.json', text: '{ "version": 1, "resources": [] }' },
      { name: 'policy.json', text: '{\n  "version": 1,\n  "ask": true\n}' },
      { name: 'scaling.json', text: 'not yet' },
      { name: 'README.md', text: '# notes' },
      { name: 'Prod.json', text: '{}' },
    ]);
    expect(result.ok).toBe(false);
    const by = Object.fromEntries(result.files.map((f) => [f.path.split('/').pop(), f]));
    expect(by['staging.json']).toMatchObject({
      kind: 'desired',
      environment: 'staging',
      ok: false,
      error: { line: 4, field: 'resources[0].kind' },
    });
    expect(problemLine(by['staging.json'].path, by['staging.json'].error)).toMatch(
      /^\.github\/breakaway-infra\/staging\.json:4: resources\[0\]\.kind: kind is the kind of resource/u,
    );
    expect(by['production.json']).toMatchObject({ kind: 'desired', ok: true, resources: 0 });
    expect(by['policy.json']).toMatchObject({ kind: 'policy', ok: false, error: { line: 3, field: 'ask' } });
    // scaling.json is a later piece's (BRK-186), and anything not JSON isn't the folder's to check.
    expect(by['scaling.json'].kind).toBe('skipped');
    expect(by['README.md'].kind).toBe('skipped');
    expect(by['Prod.json']).toMatchObject({ kind: 'problem', ok: false, error: { line: null, field: null } });
    expect(problemLine(by['Prod.json'].path, by['Prod.json'].error)).toMatch(
      /^\.github\/breakaway-infra\/Prod\.json: Prod\.json isn’t an environment’s name/u,
    );
  });

  it('says a JSON mistake’s line', () => {
    const { files } = checkInfraFolder([{ name: 'staging.json', text: '{\n  "version": 1,\n  "resources": [\n}' }]);
    expect(files[0]).toMatchObject({ ok: false, error: { line: 4, field: null, message: /it isn’t JSON/u } });
  });
});

describe('infra check, the board’s preview (CLI-14)', () => {
  let cookie;
  let provider;
  /** @type {Record<string, any>} */
  const envs = {};
  const board = (path, { method = 'GET', body: b } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    for (const [name, kind, extra] of [
      ['check-staging', 'staging', {}],
      ['check-production', 'production', {}],
      ['check-watched', 'staging', { observeOnly: true }],
    ]) {
      const made = await body(
        await board('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind, target: 'svc-api', ...extra },
        }),
      );
      envs[name] = made.environment;
    }
    provider = fakeProvider({ id: PROVIDER });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      instance.infraChecks = new Map();
      await instance.refreshInventory(PROVIDER);
    });
  });
  /** How many plans and audit entries the store holds: a preview adds to neither. */
  const kept = () =>
    runInDurableObject(store(), (instance) => ({
      plans: Number(instance.sql.exec('SELECT COUNT(*) AS n FROM infra_plans').toArray()[0].n),
      audit: Number(instance.sql.exec('SELECT COUNT(*) AS n FROM infra_audit').toArray()[0].n),
    }));
  const resetCap = () =>
    runInDurableObject(store(), (instance) => {
      instance.infraChecks = new Map();
    });
  const check = (fields) => api('infra/check', { method: 'POST', body: { repo: 'widgets', policy: null, ...fields } });

  it('shows the plan a file would make, with its cost, blast radius, and the default policy’s answer, keeping nothing', async () => {
    const before = await kept();
    const res = await body(
      await check({
        environment: 'check-staging',
        file: fileOf(provider, { 'svc-api': { attrs: { instances: 4, version: '1.0.0' } }, 'db-main': null }),
      }),
    );
    expect(res.status).toBe(200);
    const { preview } = res;
    expect(preview).toMatchObject({
      repo: 'widgets',
      environment: { id: envs['check-staging'].id, name: 'check-staging' },
      provider: PROVIDER,
      target: 'svc-api',
      changes: 2,
      reversible: false,
      irreversible: [{ resource: 'db-main', op: 'delete' }],
      cost: { currency: 'USD', delta: 3.5 },
      blastRadius: { changed: 2 },
      policy: { policy: 'default', outcome: 'needs-owner' },
    });
    expect(preview.diff.changes.map((c) => `${c.op} ${c.resource}`)).toEqual(['scale svc-api', 'delete db-main']);
    expect(preview.policy.rules.find((r) => r.rule === 'destructive').applies).toBe(true);
    // A preview has no ID and no state: nothing to approve, nothing to apply.
    expect(preview.id).toBeUndefined();
    expect(preview.state).toBeUndefined();
    expect(await kept()).toEqual(before);
  });

  it('checks against the checkout’s own policy, so an allow rule shows what it lets through', async () => {
    const policy = JSON.stringify({ version: 1, allow: [{ name: 'small staging scales', changes: ['scale'] }] });
    const file = fileOf(provider, { 'svc-api': { attrs: { instances: 3, version: '1.0.0' } } });
    const staging = await body(await check({ environment: 'check-staging', file, policy }));
    expect(staging.preview.policy).toMatchObject({
      policy: 'repository',
      outcome: 'allowed',
      rule: 'small staging scales',
    });
    // Production's gate still asks: a policy can't turn a guard off.
    const production = await body(await check({ environment: 'check-production', file, policy }));
    expect(production.preview.policy).toMatchObject({ outcome: 'needs-owner', rule: 'production' });
  });

  it('says when a file already matches what runs', async () => {
    const res = await body(await check({ environment: 'check-staging', file: fileOf(provider) }));
    expect(res.status).toBe(200);
    expect(res.preview).toMatchObject({ changes: 0, cost: null, blastRadius: null, policy: null });
  });

  it('names the line and field of a file that doesn’t check, with the provider’s kinds, and sends nothing to it', async () => {
    const calls = provider.calls.length;
    const file = fileOf(provider).replace('"kind": "route"', '"kind": "queue"');
    const res = await body(await check({ environment: 'check-staging', file }));
    expect(res.status).toBe(422);
    expect(res.problem).toMatchObject({
      path: '.github/breakaway-infra/check-staging.json',
      field: 'resources[2].kind',
      line: expect.any(Number),
      message: /fakecheck has no kind queue/u,
    });
    const policy = await body(
      await check({ environment: 'check-staging', file: fileOf(provider), policy: '{ "version": 2 }' }),
    );
    expect(policy).toMatchObject({ status: 422, problem: { path: '.github/breakaway-infra/policy.json' } });
    const other = await body(
      await check({ environment: 'check-staging', file: fileOf(provider).replace(PROVIDER, 'otherco') }),
    );
    expect(other).toMatchObject({ status: 422, problem: { field: 'provider' } });
    expect(provider.calls.length).toBe(calls);
  });

  it('refuses an observe-only environment and one the board doesn’t have', async () => {
    const watched = await body(await check({ environment: 'check-watched', file: fileOf(provider) }));
    expect(watched).toMatchObject({ status: 409, error: /observe only/u });
    const none = await body(await check({ environment: 'check-nowhere', file: fileOf(provider) }));
    expect(none).toMatchObject({ status: 404, error: /no environment check-nowhere/u });
    const missing = await body(await check({ environment: 'check-staging' }));
    expect(missing.status).toBe(400);
  });

  it(`asks the provider at most ${CHECK_PER_MINUTE} times a minute for one repository`, async () => {
    await resetCap();
    const file = fileOf(provider, { 'svc-api': { attrs: { instances: 5, version: '1.0.0' } } });
    for (let n = 0; n < CHECK_PER_MINUTE; n += 1)
      expect((await check({ environment: 'check-staging', file })).status).toBe(200);
    const capped = await body(await check({ environment: 'check-staging', file }));
    expect(capped).toMatchObject({ status: 429, error: /try again in a minute/u });
    await resetCap();
  });
});
