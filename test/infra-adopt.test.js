import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';
import { fakeProvider } from './fake-infra-provider.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { draftDesired } from '../src/infra-adopt.js';
import { checkDesiredFile, DESIRED_MAX_RESOURCES } from '../src/infra-desired.js';
import { cloudflare, MANAGED } from '../src/infra-cloudflare.js';
import { cloudflareApi } from './cloudflare-fixture.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));

describe('a draft of the desired state (BRK-240)', () => {
  const provider = fakeProvider({ id: 'fake-draft' });
  const environment = { name: 'staging', provider: 'fake-draft' };
  const resources = [
    { id: 'svc-api', kind: 'service', name: 'api', attrs: { instances: 2, version: '1.0.0' } },
    { id: 'route-api', kind: 'route', name: 'api.acme.example', attrs: { path: '/*' } },
    { id: 'db-main', kind: 'database', name: 'main', attrs: { size: 'small' } },
  ];

  it('describes what runs, in the desired-state file’s format, sorted, and valid as written', () => {
    const draft = draftDesired({ environment, resources, provider });
    expect(draft.path).toBe('.github/breakaway-infra/staging.json');
    expect(draft.observeOnly).toBe(false);
    expect(draft.resources).toBe(3);
    expect(draft.notes).toEqual([]);
    expect(draft.json.endsWith('\n')).toBe(true);
    expect(JSON.parse(draft.json)).toEqual({
      version: 1,
      provider: 'fake-draft',
      resources: [
        { id: 'db-main', kind: 'database', name: 'main', attrs: { size: 'small' } },
        { id: 'route-api', kind: 'route', name: 'api.acme.example', attrs: { path: '/*' } },
        { id: 'svc-api', kind: 'service', name: 'api', attrs: { instances: 2, version: '1.0.0' } },
      ],
    });
    const checked = checkDesiredFile(draft.json, { provider, expectProvider: 'fake-draft' });
    expect(checked.ok).toBe(true);
  });

  it('leaves out a setting that held a secret’s value, and says so', () => {
    const draft = draftDesired({
      environment,
      provider,
      resources: [
        {
          id: 'svc-api',
          kind: 'service',
          name: 'api',
          attrs: {
            instances: 2,
            env: ['API_TOKEN=[redacted]', 'MODE=live'],
            header: 'Bearer abcdefghijklmnopqrstuvwxyz',
          },
        },
      ],
    });
    const file = JSON.parse(draft.json);
    expect(file.resources[0].attrs).toEqual({ instances: 2 });
    expect(draft.json).not.toContain('redacted');
    expect(draft.json).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(draft.notes).toEqual([
      'Left out api’s env and header: they looked like a secret’s value. Name the secret in the file, never its value.',
    ]);
    expect(checkDesiredFile(draft.json, { provider }).ok).toBe(true);
  });

  it('leaves out a kind the provider doesn’t manage, and says so', () => {
    const draft = draftDesired({
      environment,
      provider,
      resources: [...resources, { id: 'q-1', kind: 'queue', name: 'jobs', attrs: {} }],
    });
    expect(JSON.parse(draft.json).resources.map((r) => r.id)).not.toContain('q-1');
    expect(draft.notes).toEqual(['Left out 1 queue (jobs): fake-draft doesn’t manage that kind.']);
    expect(checkDesiredFile(draft.json, { provider }).ok).toBe(true);
  });

  it('keeps every kind when the provider isn’t connected, and says the kinds weren’t checked', () => {
    const draft = draftDesired({ environment, resources, provider: null });
    expect(draft.resources).toBe(3);
    expect(draft.notes).toEqual(['fake-draft isn’t connected, so the kinds weren’t checked against it.']);
    expect(checkDesiredFile(draft.json).ok).toBe(true);
  });

  it('says an observe-only environment’s draft is never applied', () => {
    const draft = draftDesired({ environment: { ...environment, observeOnly: true }, resources, provider });
    expect(draft.observeOnly).toBe(true);
    expect(draft.notes).toEqual([
      'staging is observe only: this describes it, and Architect never applies a change to it. Keep it out of the repository: an observe-only environment takes no desired state.',
    ]);
  });

  it('leaves out what the platform reports by itself, so an adopted file doesn’t drift by itself', () => {
    const managed = {
      ...provider,
      kinds: { ...provider.kinds, service: { ...provider.kinds.service, settings: ['instances'] } },
    };
    const draft = draftDesired({ environment, resources, provider: managed });
    const api_ = JSON.parse(draft.json).resources.find((r) => r.id === 'svc-api');
    expect(api_.attrs).toEqual({ instances: 2 });
    expect(draft.notes).toEqual([
      'Kept only the settings fake-draft manages: what the platform reports by itself, like versions and sizes, is left out so the file doesn’t drift by itself.',
    ]);
  });

  it('drafts a Cloudflare account that plans no changes, with only the settings Architect manages', async () => {
    const ctx = {
      environment: 'production',
      scope: { target: 'acme-api' },
      token: 'cf-read-token',
      fetch: cloudflareApi(),
    };
    const found = await cloudflare.discover(ctx);
    const draft = draftDesired({
      environment: { name: 'production', provider: 'cloudflare' },
      resources: found.resources,
      provider: cloudflare,
    });
    const file = JSON.parse(draft.json);
    for (const r of file.resources)
      for (const key of Object.keys(r.attrs ?? {})) expect(MANAGED[r.kind]).toContain(key);
    expect(draft.json).not.toContain('secrets');
    const checked = checkDesiredFile(draft.json, { provider: cloudflare, expectProvider: 'cloudflare' });
    expect(checked.ok).toBe(true);
    const plan = await cloudflare.plan(ctx, checked.desired);
    expect(plan.changes).toEqual([]);
  });

  it('keeps at most as many resources as a file holds', () => {
    const many = Array.from({ length: DESIRED_MAX_RESOURCES + 2 }, (_, n) => ({
      id: `svc-${String(n).padStart(4, '0')}`,
      kind: 'service',
      name: `s${n}`,
      attrs: {},
    }));
    const draft = draftDesired({ environment, resources: many, provider });
    expect(draft.resources).toBe(DESIRED_MAX_RESOURCES);
    expect(draft.notes).toEqual([
      `Kept the first ${DESIRED_MAX_RESOURCES} of ${DESIRED_MAX_RESOURCES + 2} resources: a file holds at most ${DESIRED_MAX_RESOURCES}. Point the environment’s target at what the repository runs.`,
    ]);
    expect(checkDesiredFile(draft.json, { provider }).ok).toBe(true);
  });
});

describe('GET /api/infra/environments/<id>/draft (BRK-240)', () => {
  const PROVIDER = 'fake-adopt';
  /** @type {Record<string, any>} */
  const envs = {};
  let provider;

  beforeAll(async () => {
    for (const [name, extra] of [
      ['adopt-staging', { target: 'api' }],
      ['adopt-watch', { target: 'api', observeOnly: true }],
      ['adopt-empty', {}],
      ['adopt-bare', {}],
    ]) {
      const made = await body(
        await boardApi('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: PROVIDER, name, kind: 'staging', ...extra },
        }),
      );
      envs[name] = made.environment;
    }
    provider = fakeProvider({ id: PROVIDER });
    provider.state.resources[0].attrs.env = ['API_TOKEN=abcdef123456'];
    // Something on the same platform that the environment's target doesn't reach: never in its draft.
    provider.state.resources.push({ id: 'svc-other', kind: 'service', name: 'someone-elses', attrs: {} });
    provider.state.relations.push({ from: 'svc-other', to: 'db-main', kind: 'uses' });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
      // One a pipeline made before it had a provider (BRK-195): the form always asks for one.
      instance.sql.exec('UPDATE infra_environments SET provider = NULL WHERE id = ?', envs['adopt-bare'].id);
    });
  });

  it('returns a draft that passes the check and holds no secret, with the token and with the cookie', async () => {
    const id = envs['adopt-staging'].id;
    for (const res of [await api(`infra/environments/${id}/draft`), await boardApi(`infra/environments/${id}/draft`)]) {
      const got = await body(res);
      expect(got.status).toBe(200);
      expect(got.draft).toMatchObject({
        environment: 'adopt-staging',
        environmentId: id,
        repo: 'widgets',
        path: '.github/breakaway-infra/adopt-staging.json',
        resources: 3,
        observeOnly: false,
      });
      expect(checkDesiredFile(got.draft.json, { provider, expectProvider: PROVIDER }).ok).toBe(true);
      expect(got.draft.json).not.toContain('abcdef123456');
      expect(got.draft.json).not.toContain('redacted');
      expect(JSON.parse(got.draft.json).resources.map((r) => r.id)).toEqual(['db-main', 'route-api', 'svc-api']);
      expect(got.draft.notes).toEqual([
        'Left out api’s env: it looked like a secret’s value. Name the secret in the file, never its value.',
      ]);
    }
  });

  it('finds the environment by name with ?repo=, and changes nothing', async () => {
    const before = await runInDurableObject(store(), (instance) =>
      Number(instance.sql.exec('SELECT COUNT(*) AS n FROM infra_audit').toArray()[0].n),
    );
    const got = await body(await api('infra/environments/adopt-staging/draft?repo=widgets'));
    expect(got.status).toBe(200);
    expect(got.draft.environmentId).toBe(envs['adopt-staging'].id);
    const after = await runInDurableObject(store(), (instance) =>
      Number(instance.sql.exec('SELECT COUNT(*) AS n FROM infra_audit').toArray()[0].n),
    );
    expect(after).toBe(before);
  });

  it('drafts an observe-only environment too, and says it’s never applied', async () => {
    const got = await body(await api(`infra/environments/${envs['adopt-watch'].id}/draft`));
    expect(got.status).toBe(200);
    expect(got.draft.observeOnly).toBe(true);
    expect(got.draft.notes).toContain(
      'adopt-watch is observe only: this describes it, and Architect never applies a change to it. Keep it out of the repository: an observe-only environment takes no desired state.',
    );
  });

  it('refuses with the fix when there’s no inventory yet', async () => {
    const got = await body(await api(`infra/environments/${envs['adopt-empty'].id}/draft`));
    expect(got.status).toBe(409);
    expect(got.error).toBe(
      'adopt-empty has no target, so the inventory has nothing for it yet: give it a target on the board, then refresh the inventory from Connections',
    );
    const bare = await body(await api(`infra/environments/${envs['adopt-bare'].id}/draft`));
    expect(bare.status).toBe(409);
    expect(bare.error).toBe(
      'adopt-bare has no provider: pick one on the board, connect it on Connections, then refresh the inventory',
    );
  });

  it('refuses when the inventory hasn’t been refreshed since the target was set', async () => {
    const made = await body(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'adopt-new', kind: 'staging', target: 'api' },
      }),
    );
    const got = await body(await api(`infra/environments/${made.environment.id}/draft`));
    expect(got.status).toBe(409);
    expect(got.error).toBe(
      `adopt-new has no inventory yet: connect ${PROVIDER} on Connections and refresh the inventory, then ask again`,
    );
  });

  it('is a 404 for an environment that isn’t there', async () => {
    expect((await api('infra/environments/99999/draft')).status).toBe(404);
  });
});
