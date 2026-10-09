import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';
import { FAKE_CREATABLE, FAKE_EDITABLE, fakeProvider } from './fake-infra-provider.js';
import {
  checkCreatable,
  checkEditable,
  checkProvider,
  creatableKinds,
  editableKinds,
  ProviderRegistry,
} from '../src/infra-provider.js';
import { cloudflare, CREATABLE, EDITABLE, MANAGED } from '../src/infra-cloudflare.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));

describe('editable settings in the provider interface (BRK-262)', () => {
  const provider = fakeProvider({ id: 'fake-editable' });
  /** @param {any} field */
  const one = (field, kind = 'service') => checkEditable(provider, kind, { fields: [field] });
  const base = { path: 'instances', label: 'Instances', type: 'number', help: 'How many run.' };

  it('passes the fake’s and Cloudflare’s', () => {
    expect(() => checkProvider(provider)).not.toThrow();
    expect(() => checkProvider(cloudflare)).not.toThrow();
    expect(editableKinds(provider)).toEqual(FAKE_EDITABLE);
  });

  it('refuses a field without a path, label, help, or a known type', () => {
    expect(() => one({ ...base, path: 'attrs..instances' })).toThrow(/no path/u);
    expect(() => one({ ...base, label: '' })).toThrow(/no label or no help/u);
    expect(() => one({ ...base, help: undefined })).toThrow(/no label or no help/u);
    expect(() => one({ ...base, type: 'slider' })).toThrow(/unknown type "slider"/u);
    expect(() => checkEditable(provider, 'service', { fields: [base, base] })).toThrow(/listed twice/u);
    expect(() => one({ ...base, deploy: true })).toThrow(/deploy is not words/u);
    expect(() => one({ ...base, deploy: 'the deploy’s config' })).not.toThrow();
  });

  it('refuses a path the plan doesn’t compare, when the kind lists its settings', () => {
    const narrow = {
      ...provider,
      kinds: { ...provider.kinds, service: { ...provider.kinds.service, settings: ['instances'] } },
    };
    expect(() => checkEditable(narrow, 'service', { fields: [base] })).not.toThrow();
    expect(() => checkEditable(narrow, 'service', { fields: [{ ...base, path: 'memory' }] })).toThrow(
      /memory: isn't a setting the plan compares/u,
    );
  });

  it('checks what each type needs', () => {
    expect(() => one({ ...base, min: 5, max: 1 })).toThrow(/min is more than max/u);
    expect(() => one({ ...base, type: 'text', min: 1 })).toThrow(/min is not a number/u);
    expect(() => one({ ...base, type: 'choice' })).toThrow(/no options/u);
    expect(() =>
      one({
        ...base,
        type: 'choice',
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'B' },
        ],
      }),
    ).toThrow(/option a is listed twice/u);
    expect(() => one({ ...base, type: 'resource', kinds: ['queue'] })).toThrow(/doesn't declare/u);
    expect(() =>
      one({
        ...base,
        type: 'bindings',
        targets: [{ type: 'db', label: 'Database', kind: 'database', field: 'resource', by: 'uuid' }],
      }),
    ).toThrow(/neither id nor name/u);
    expect(() => one({ ...base, type: 'rules' })).toThrow(/no fields/u);
    expect(() => one({ ...base, type: 'text', pattern: '(' })).toThrow(/isn't a regular expression/u);
    expect(() => one({ ...base, options: [{ value: 'a', label: 'A' }] })).toThrow(/only a choice has options/u);
  });

  it('refuses a setting both editable and shown, and an editable that isn’t a function', () => {
    expect(() =>
      checkEditable(provider, 'service', { fields: [base], shown: [{ path: 'instances', label: 'I', help: 'h' }] }),
    ).toThrow(/both editable and shown/u);
    expect(() => checkProvider({ ...provider, editable: {} })).toThrow(/editable is not a function/u);
    expect(() => checkProvider({ ...provider, editable: () => ({ fields: [{ ...base, type: 'x' }] }) })).toThrow(
      /unknown type/u,
    );
  });

  it('gives nothing for a provider without editable', () => {
    expect(editableKinds({ ...provider, editable: undefined })).toEqual({});
  });
});

describe('Cloudflare’s editable settings (BRK-262)', () => {
  it('offers only what its plan manages, and every kind with a managed setting', () => {
    for (const [kind, e] of Object.entries(EDITABLE)) {
      expect(MANAGED[kind]).toBeDefined();
      for (const f of e.fields) expect(MANAGED[kind]).toContain(f.path.split('.')[0]);
    }
    expect(Object.keys(editableKinds(cloudflare)).sort()).toEqual(
      ['container', 'custom-domain', 'queue', 'r2', 'route', 'worker'].sort(),
    );
    for (const kind of ['d1', 'kv', 'durable-object']) expect(cloudflare.editable?.(kind)).toBeNull();
  });

  it('has no memory field, and shows a Worker’s secrets by name, never as a field', () => {
    const worker = EDITABLE.worker;
    expect(worker.fields.map((f) => f.path)).toEqual([
      'compatibilityDate',
      'compatibilityFlags',
      'usageModel',
      'observability',
      'placement',
      'crons',
      'bindings',
    ]);
    expect(JSON.stringify(EDITABLE)).not.toMatch(/memory/iu);
    expect(worker.shown).toEqual([
      { path: 'secrets', label: 'Secrets', help: 'Set with the Worker’s deploy, never here.' },
    ]);
  });

  it('marks the Worker settings each deploy sets from its wrangler config (BRK-313)', () => {
    const deploys = EDITABLE.worker.fields.filter((f) => f.deploy).map((f) => f.path);
    expect(deploys).toEqual([
      'compatibilityDate',
      'compatibilityFlags',
      'observability',
      'placement',
      'crons',
      'bindings',
    ]);
    expect(new Set(EDITABLE.worker.fields.flatMap((f) => (f.deploy ? [f.deploy] : [])))).toEqual(
      new Set(['the wrangler config']),
    );
  });

  it('binds only to Cloudflare resources, never a variable or a secret', () => {
    const bindings = EDITABLE.worker.fields.find((f) => f.type === 'bindings');
    expect(bindings?.targets?.map((t) => t.type)).toEqual(['d1', 'kv_namespace', 'r2_bucket', 'queue', 'service']);
    expect(bindings?.help).toContain('Variables and secrets are kept as they are');
  });

  it('scales a container by its max instances, and changes a route’s pattern and Worker', () => {
    expect(EDITABLE.container.fields.map((f) => f.path)).toEqual(['maxInstances']);
    expect(EDITABLE.route.name?.label).toBe('Pattern');
    expect(EDITABLE.route.fields).toMatchObject([{ path: 'worker', type: 'resource', kinds: ['worker'] }]);
    expect(EDITABLE['custom-domain'].fields).toMatchObject([{ path: 'worker', type: 'resource', kinds: ['worker'] }]);
  });
});

describe('creatable kinds in the provider interface (BRK-270)', () => {
  const provider = fakeProvider({ id: 'fake-creatable' });
  const base = () => structuredClone(FAKE_CREATABLE.database);
  /** @param {(c: any) => void} change */
  const one = (change, kind = 'database') => {
    const c = base();
    change(c);
    return () => checkCreatable(provider, kind, c);
  };

  it('passes the fake’s and Cloudflare’s, and lists each kind with one list of fields', () => {
    expect(() => checkProvider(provider)).not.toThrow();
    expect(() => checkProvider(cloudflare)).not.toThrow();
    const kinds = creatableKinds(provider);
    expect(Object.keys(kinds)).toEqual(['service', 'database']);
    expect(kinds.service.fields).toEqual([
      { ...FAKE_EDITABLE.service.fields[0], required: true, default: 1 },
      FAKE_EDITABLE.service.fields[1],
    ]);
    expect(kinds.database).toMatchObject({
      label: 'Database',
      fields: [
        { path: 'engine', type: 'text' },
        { path: 'size', type: 'choice', default: 'small' },
      ],
      bind: { kind: 'service', list: 'uses', required: true, target: { type: 'database', by: 'id' } },
    });
    expect(creatableKinds({ ...provider, creatable: undefined })).toEqual({});
  });

  it('refuses one without a label, a name rule, or with fields, defaults, or a binding that don’t fit', () => {
    expect(one((c) => delete c.label)).toThrow(/no label or no help/u);
    expect(one((c) => delete c.name.help)).toThrow(/name has no label or no help/u);
    expect(one((c) => (c.name.pattern = '('))).toThrow(/isn't a regular expression/u);
    expect(one((c) => (c.name.max = 0))).toThrow(/max is not a whole number/u);
    expect(one((c) => c.fields.push({ path: 'size', label: 'S', type: 'text', help: 'h' }))).toThrow(
      /size: is editable already/u,
    );
    expect(one((c) => (c.required = ['nope']))).toThrow(/requires nope, which isn't one of its fields/u);
    expect(one((c) => (c.defaults = { size: 'huge' }))).toThrow(/default size: Size is one of small, large/u);
    expect(one((c) => (c.defaults = { nope: 1 }))).toThrow(/default for nope/u);
    expect(one((c) => (c.bind.kind = 'gadget'))).toThrow(/bind names no kind/u);
    expect(one((c) => (c.bind.target.kind = 'service'))).toThrow(/binds service, not database/u);
    expect(one((c) => (c.bind.required = 'yes'))).toThrow(/required is not true or false/u);
    expect(one((c) => (c.needsCode = ' '))).toThrow(/needsCode is empty/u);
    expect(one(() => {}, 'gadget')).toThrow(/doesn't declare gadget/u);
    expect(() => checkProvider({ ...provider, creatable: {} })).toThrow(/creatable is not a function/u);
  });
});

describe('Cloudflare’s creatable kinds (BRK-270)', () => {
  const kinds = creatableKinds(cloudflare);

  it('covers every kind Architect plans, each with a name rule', () => {
    expect(Object.keys(CREATABLE).sort()).toEqual(Object.keys(MANAGED).sort());
    expect(Object.keys(kinds).sort()).toEqual(Object.keys(MANAGED).sort());
    for (const k of Object.values(kinds)) {
      expect(k.name.pattern).toBeTruthy();
      expect(k.name.max).toBeGreaterThan(0);
    }
    expect(new RegExp(kinds.queue.name.pattern, 'u').test('acme-jobs')).toBe(true);
    expect(new RegExp(kinds.queue.name.pattern, 'u').test('Acme_Jobs')).toBe(false);
    expect(new RegExp(kinds.r2.name.pattern, 'u').test('ab')).toBe(false);
    expect(new RegExp(kinds['custom-domain'].name.pattern, 'u').test('api.acme.example')).toBe(true);
    expect(new RegExp(kinds['durable-object'].name.pattern, 'u').test('acme-api_Counter')).toBe(true);
  });

  it('binds a database, namespace, bucket, and queue to a Worker, required, and a Worker by its name', () => {
    // In Cloudflare's own field, the one the plan compares (BRK-285): a database and a namespace by ID, the rest by name.
    for (const [k, field, by] of [
      ['d1', 'id', 'id'],
      ['kv', 'namespace_id', 'id'],
      ['r2', 'bucket_name', 'name'],
      ['queue', 'queue_name', 'name'],
    ])
      expect(kinds[k].bind).toMatchObject({ kind: 'worker', list: 'bindings', required: true, target: { field, by } });
    expect(kinds.worker.bind).toEqual({
      kind: 'worker',
      list: 'bindings',
      target: { type: 'service', label: 'Worker', kind: 'worker', field: 'service', by: 'name' },
    });
    for (const k of ['route', 'custom-domain', 'durable-object', 'container']) expect(kinds[k].bind).toBeUndefined();
  });

  it('gives a new Worker today’s compatibility date and says it starts with a script that answers /health', () => {
    const date = kinds.worker.fields.find((f) => f.path === 'compatibilityDate');
    expect(date).toMatchObject({ required: true, default: new Date().toISOString().slice(0, 10) });
    expect(kinds.worker.help).toMatch(/\/health/u);
    expect(kinds.queue.fields.find((f) => f.path === 'retention')?.default).toBe(345_600);
  });

  it('asks a route and a custom domain for a zone and a Worker', () => {
    for (const k of ['route', 'custom-domain'])
      expect(kinds[k].fields.filter((f) => f.required).map((f) => f.path)).toEqual(['zone', 'worker']);
  });

  it('says what code a Durable Object and a container need, and nothing else does', () => {
    expect(kinds['durable-object'].needsCode).toMatch(/exports the class/u);
    expect(kinds['durable-object'].fields.filter((f) => f.required).map((f) => f.path)).toEqual(['class', 'script']);
    expect(kinds.container.needsCode).toMatch(/image/u);
    expect(kinds.container.fields.filter((f) => f.required).map((f) => f.path)).toEqual(['image', 'maxInstances']);
    for (const k of ['worker', 'queue', 'r2', 'kv', 'd1', 'route', 'custom-domain'])
      expect(kinds[k].needsCode).toBeUndefined();
  });
});

describe('GET /api/infra/environments/<id>/editable (BRK-262)', () => {
  const PROVIDER = 'fake-editable-route';
  /** @type {Record<string, any>} */
  const envs = {};

  beforeAll(async () => {
    for (const [name, provider] of [
      ['editable-staging', PROVIDER],
      ['editable-bare', PROVIDER],
      ['editable-unknown', PROVIDER],
    ]) {
      const made = await body(
        await boardApi('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider, name, kind: 'staging', target: 'api' },
        }),
      );
      envs[name] = made.environment;
    }
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(fakeProvider({ id: PROVIDER }));
      instance.sql.exec('UPDATE infra_environments SET provider = NULL WHERE id = ?', envs['editable-bare'].id);
      instance.sql.exec(
        "UPDATE infra_environments SET provider = 'acme-cloud' WHERE id = ?",
        envs['editable-unknown'].id,
      );
    });
  });

  it('answers with the token and with the cookie, naming no vendor, and changes nothing', async () => {
    const id = envs['editable-staging'].id;
    const count = () =>
      runInDurableObject(store(), (instance) =>
        Number(instance.sql.exec('SELECT COUNT(*) AS n FROM infra_audit').toArray()[0].n),
      );
    const before = await count();
    for (const res of [
      await api(`infra/environments/${id}/editable`),
      await boardApi(`infra/environments/${id}/editable`),
    ]) {
      const got = await body(res);
      expect(got.status).toBe(200);
      expect(got.editable).toEqual({
        repo: 'widgets',
        environment: 'editable-staging',
        environmentId: id,
        kinds: FAKE_EDITABLE,
        creatable: creatableKinds(fakeProvider()),
      });
      expect(Object.keys(got.editable.creatable)).toEqual(['service', 'database']);
    }
    expect(await count()).toBe(before);
  });

  it('finds the environment by name with ?repo=', async () => {
    const got = await body(await api('infra/environments/editable-staging/editable?repo=widgets'));
    expect(got.status).toBe(200);
    expect(got.editable.environmentId).toBe(envs['editable-staging'].id);
  });

  it('refuses with the fix when there’s no provider, or one the board doesn’t have', async () => {
    const bare = await body(await api(`infra/environments/${envs['editable-bare'].id}/editable`));
    expect(bare.status).toBe(409);
    expect(bare.error).toBe('editable-bare has no provider: pick one on the board, then ask again');
    const unknown = await body(await api(`infra/environments/${envs['editable-unknown'].id}/editable`));
    expect(unknown.status).toBe(409);
    expect(unknown.error).toBe(
      'editable-unknown’s provider acme-cloud isn’t one this board has: pick another on the board, then ask again',
    );
  });

  it('is a 404 for an environment that isn’t there, and refuses a write', async () => {
    expect((await api('infra/environments/99999/editable')).status).toBe(404);
    expect(
      (await boardApi(`infra/environments/${envs['editable-staging'].id}/editable`, { method: 'POST', body: {} }))
        .status,
    ).not.toBe(200);
  });
});
