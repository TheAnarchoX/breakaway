import { describe, expect, it } from 'vitest';
import { cloudflare, rid } from '../src/infra-cloudflare.js';
import { MANAGED, PlanRefused, apply, plan, rollbackWorker } from '../src/infra-cloudflare-plan.js';
import { checkApplyResult, checkPlan, desiredFrom } from '../src/infra-provider.js';
import { keptDiff } from '../src/infra-plans.js';
import { ACCOUNT, D1_ID, KV_CACHE, KV_SESSIONS, ZONE, cloudflareAnswers, cloudflareApi } from './cloudflare-fixture.js';
import { providerContract } from './infra-provider-contract.js';

const READ = 'cf-read-token-for-tests-only';
const WRITE = 'cf-write-token-for-tests-only';
const a = `/accounts/${ACCOUNT}`;
const ROUTE = 'route:0000000000000000000000000000d101';
const W = (name) => rid('worker', name);
const ok = (result) => ({ success: true, errors: [], messages: [], result });

/**
 * The made-up account (cloudflare-fixture.js), answering writes as Cloudflare would and changing what it answers next,
 * so a test can apply a plan and discover again. Writes with any token but WRITE get a 403, as a read-only token does.
 * Every call is recorded, with its body.
 */
function account() {
  const answers = cloudflareAnswers();
  const reads = cloudflareApi(answers);
  /** @type {Array<{ method: string, path: string, auth: string | null, body?: any }>} */
  const calls = [];
  let n = 0;
  const list = (path) => /** @type {any[]} */ (answers[path].result);
  const kvList = () => list(`${a}/storage/kv/namespaces?page=2&per_page=100`);
  const script = (name) => `${a}/workers/scripts/${name}`;
  answers[`${a}/d1/database?name=acme-new-db&page=1&per_page=100`] = ok([]);
  answers[`${a}/d1/database?name=acme-db&page=1&per_page=100`] = ok([{ uuid: D1_ID, name: 'acme-db' }]);

  const writes = {
    'POST /workers/workers': (body) => {
      list(`${a}/workers/scripts`).push({ id: body.name, handlers: [] });
      answers[`${script(body.name)}/settings`] = ok({ bindings: [] });
      answers[`${script(body.name)}/deployments`] = ok({ deployments: [] });
      answers[`${script(body.name)}/secrets`] = ok([]);
      answers[`${script(body.name)}/schedules`] = ok({ schedules: [] });
      return { id: `id-${body.name}`, name: body.name };
    },
    'PATCH /workers/scripts/:name/settings': (body, [name]) => {
      const settings = answers[`${script(name)}/settings`].result;
      const kept = settings.bindings.filter((b) => body.keep_bindings.includes(b.type));
      settings.bindings = [...body.bindings, ...kept];
      if (body.compatibility_date) settings.compatibility_date = body.compatibility_date;
      if (body.compatibility_flags) settings.compatibility_flags = body.compatibility_flags;
      const deps = answers[`${script(name)}/deployments`].result.deployments;
      deps.unshift({
        id: `dep-${++n}`,
        created_on: '2026-10-06T12:00:00Z',
        versions: [{ version_id: `ver-${name}-${n + 2}`, percentage: 100 }],
      });
      return {};
    },
    'PUT /workers/scripts/:name/schedules': (body, [name]) => {
      answers[`${script(name)}/schedules`] = ok({ schedules: body });
      return {};
    },
    'POST /workers/scripts/:name/deployments': () => ({ id: 'dep-rollback' }),
    'DELETE /workers/scripts/:name': (_, [name]) => {
      answers[`${a}/workers/scripts`].result = list(`${a}/workers/scripts`).filter((s) => s.id !== name);
      return null;
    },
    'POST /storage/kv/namespaces': (body) => {
      const id = `0000000000000000000000000000b1${String(++n).padStart(2, '0')}`;
      kvList().push({ id, title: body.title, supports_url_encoding: true });
      return { id, title: body.title };
    },
    'PUT /storage/kv/namespaces/:id': (body, [id]) => {
      for (const p of [1, 2])
        for (const ns of list(`${a}/storage/kv/namespaces?page=${p}&per_page=100`))
          if (ns.id === id) ns.title = body.title;
      return null;
    },
    'DELETE /storage/kv/namespaces/:id': (_, [id]) => {
      for (const p of [1, 2]) {
        const path = `${a}/storage/kv/namespaces?page=${p}&per_page=100`;
        answers[path].result = list(path).filter((ns) => ns.id !== id);
      }
      return null;
    },
    'POST /d1/database': (body) => ({ uuid: `00000000-0000-4000-8000-0000000d0${++n}`, name: body.name }),
    'DELETE /d1/database/:id': () => null,
  };
  const zoneWrites = {
    'PUT /workers/routes/:id': (body, [id]) => {
      for (const r of list(`/zones/${ZONE}/workers/routes`)) if (r.id === id) Object.assign(r, body);
      return null;
    },
    'POST /workers/routes': (body) => {
      const r = { id: `0000000000000000000000000000d1${String(++n).padStart(2, '0')}`, ...body };
      list(`/zones/${ZONE}/workers/routes`).push(r);
      return r;
    },
    'DELETE /workers/routes/:id': (_, [id]) => {
      answers[`/zones/${ZONE}/workers/routes`].result = list(`/zones/${ZONE}/workers/routes`).filter(
        (r) => r.id !== id,
      );
      return null;
    },
  };

  /** @type {typeof fetch & { calls: typeof calls, writes: () => string[], answers: typeof answers }} */
  const api = Object.assign(
    async (input, init = {}) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        const res = await reads(input, init);
        const last = reads.calls.at(-1);
        calls.push({ ...last });
        return res;
      }
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/client\/v4/u, '') + url.search;
      const auth = new Headers(init.headers).get('authorization');
      let body;
      if (init.body instanceof FormData)
        body = JSON.parse(await /** @type {Blob} */ (init.body.get('settings')).text());
      else if (typeof init.body === 'string') body = JSON.parse(init.body);
      calls.push({ method, path, auth, body });
      if (auth !== `Bearer ${WRITE}`)
        return Response.json(
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status: 403 },
        );
      const [table, rest] = path.startsWith(a)
        ? [writes, path.slice(a.length)]
        : [zoneWrites, path.replace(`/zones/${ZONE}`, '')];
      for (const [key, handle] of Object.entries(table)) {
        const [m, pattern] = key.split(' ');
        const re = new RegExp(`^${pattern.replace(/:[a-z]+/gu, '([^/?]+)')}(\\?.*)?$`, 'u');
        const match = re.exec(rest);
        if (m === method && match) return Response.json(ok(handle(body, match.slice(1).map(decodeURIComponent))));
      }
      return Response.json({ success: false, errors: [{ code: 7003, message: 'no route' }] }, { status: 404 });
    },
    { calls, answers, writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`) },
  );
  return api;
}

const ctxFor = (fetch, token = READ, extra = {}) => ({
  environment: 'production',
  scope: { target: 'acme-api' },
  token,
  fetch,
  ...extra,
});

/** What the account runs, as a desired state: planning it changes nothing. */
async function current(fetch) {
  return desiredFrom(await cloudflare.discover(ctxFor(fetch)));
}

/** A desired state with a new KV namespace bound to acme-api, a newer compatibility date, and a renamed route. */
async function changed(fetch) {
  const desired = await current(fetch);
  const api = desired.resources.find((r) => r.id === W('acme-api'));
  api.attrs = {
    compatibilityDate: '2026-10-01',
    bindings: [...api.attrs.bindings, { name: 'FLAGS', type: 'kv_namespace', resource: 'kv:acme-flags' }],
  };
  desired.resources.push({ id: 'kv:acme-flags', kind: 'kv', name: 'acme-flags' });
  desired.resources.find((r) => r.id === ROUTE).name = 'api.acme.example/v2/*';
  return desired;
}

providerContract(
  'cloudflare plan and apply',
  async () => {
    const fetch = account();
    const desired = await changed(fetch);
    return { provider: cloudflare, ctx: ctxFor(fetch, WRITE), desired, since: '2026-10-01T00:00:00Z' };
  },
  { notYet: { observe: 'BRK-191', cost: 'BRK-193', events: 'BRK-191' } },
);

describe('the Cloudflare provider’s plan (BRK-192)', () => {
  it('plans nothing when the desired state is what runs, and writes nothing to plan', async () => {
    const fetch = account();
    const p = checkPlan(cloudflare, await plan(ctxFor(fetch), await current(fetch)));
    expect(p.changes).toEqual([]);
    expect(fetch.writes()).toEqual([]);
  });

  it('lists the right changes, in the order they apply, from a desired state', async () => {
    const fetch = account();
    const p = checkPlan(cloudflare, await plan(ctxFor(fetch), await changed(fetch)));
    expect(p.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([
      'create kv:acme-flags',
      `update ${W('acme-api')}`,
      `update ${ROUTE}`,
    ]);
    expect(p.reversible).toBe(true);
    const worker = p.changes[1];
    expect(worker.before.compatibilityDate).toBe('2026-09-01');
    expect(worker.after.compatibilityDate).toBe('2026-10-01');
    expect(worker.after.bindings).toContainEqual({ name: 'FLAGS', type: 'kv_namespace', resource: 'kv:acme-flags' });
    // Bindings to what exists name it; no variable's text is ever in the plan.
    expect(worker.after.bindings).toContainEqual({ name: 'CACHE', type: 'kv_namespace', namespace_id: KV_CACHE });
    expect(JSON.stringify(p)).not.toMatch(/hello-from-acme-vars|acme-json-config-value/u);
    expect(p.changes[2]).toMatchObject({
      name: 'api.acme.example/v2/*',
      before: { worker: 'acme-api', zone: 'acme.example' },
    });
  });

  it('marks every delete of a data kind irreversible, and says why', async () => {
    const fetch = account();
    const desired = await current(fetch);
    // acme-auth stops binding its sessions namespace, and the namespace goes.
    desired.resources.find((r) => r.id === W('acme-auth')).attrs = { bindings: [] };
    desired.resources = desired.resources.filter((r) => r.id !== `kv:${KV_SESSIONS}`);
    const p = checkPlan(cloudflare, await plan(ctxFor(fetch), desired));
    expect(p.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([
      `update ${W('acme-auth')}`,
      `delete kv:${KV_SESSIONS}`,
    ]);
    expect(p.changes[1]).toMatchObject({ reversible: false, after: null });
    expect(p.changes[1].why).toMatch(/deletes every key/u);
    expect(p.reversible).toBe(false);
  });

  it('marks deleting a route reversible, and a Worker not', async () => {
    const fetch = account();
    const desired = await current(fetch);
    desired.resources = desired.resources.filter((r) => r.id !== ROUTE);
    let p = await plan(ctxFor(fetch), desired);
    expect(p.changes).toMatchObject([{ op: 'delete', resource: ROUTE, reversible: true }]);

    const api = desired.resources.find((r) => r.id === W('acme-api'));
    api.attrs = { bindings: api.attrs.bindings.filter((b) => b.name !== 'AUTH') };
    desired.resources = desired.resources.filter((r) => r.id !== W('acme-auth') && r.id !== `kv:${KV_SESSIONS}`);
    p = checkPlan(cloudflare, await plan(ctxFor(fetch), desired));
    const gone = p.changes.find((c) => c.resource === W('acme-auth'));
    expect(gone).toMatchObject({ op: 'delete', reversible: false });
    expect(gone.why).toMatch(/every version/u);
  });

  it('refuses a change outside the environment’s scope', async () => {
    const fetch = account();
    const ctx = ctxFor(fetch);
    const add = async (r) => {
      const d = await current(fetch);
      d.resources.push(r);
      return plan(ctx, d);
    };
    // A Worker another environment runs.
    await expect(add({ id: W('acme-other'), kind: 'worker', name: 'acme-other' })).rejects.toThrow(
      /outside production’s scope/u,
    );
    // A namespace no Worker binds would never be discovered again.
    await expect(add({ id: 'kv:loose', kind: 'kv', name: 'loose' })).rejects.toThrow(/isn’t bound by any Worker/u);
    // One bound, but its name is taken on the account.
    const d = await current(fetch);
    d.resources.find((r) => r.id === W('acme-api')).attrs = {
      bindings: [
        ...(await current(fetch)).resources.find((r) => r.id === W('acme-api')).attrs.bindings,
        { name: 'X', type: 'kv_namespace', resource: 'kv:taken' },
      ],
    };
    d.resources.push({ id: 'kv:taken', kind: 'kv', name: 'acme-other-kv' });
    await expect(plan(ctx, d)).rejects.toThrow(/outside production’s scope/u);
    expect(fetch.writes()).toEqual([]);
  });

  it('refuses what Architect doesn’t change: variables, Durable Object classes, the target, and anything still bound', async () => {
    const fetch = account();
    const ctx = ctxFor(fetch);
    const base = async (edit) => {
      const d = await current(fetch);
      edit(d);
      return plan(ctx, d);
    };
    const api = (d) => d.resources.find((r) => r.id === W('acme-api'));
    await expect(
      base((d) => {
        api(d).attrs = { bindings: [...api(d).attrs.bindings, { name: 'NEW', type: 'plain_text', text: 'hi' }] };
      }),
    ).rejects.toThrow(/variables and secrets stay in the Worker’s own config/u);
    await expect(
      base((d) => {
        api(d).attrs = { bindings: api(d).attrs.bindings.filter((b) => b.name !== 'GREETING') };
      }),
    ).rejects.toThrow(/never removes a variable or a secret/u);
    await expect(
      base(
        (d) => (d.resources = d.resources.filter((r) => r.kind !== 'durable-object' || r.name !== 'acme-api_Counter')),
      ),
    ).rejects.toThrow(/migration in its Worker’s code/u);
    await expect(
      base((d) => d.resources.push({ id: 'container:new', kind: 'container', name: 'box' })),
    ).rejects.toThrow(/made by its Worker’s deploy/u);
    await expect(base((d) => (d.resources = d.resources.filter((r) => r.id !== `d1:${D1_ID}`)))).rejects.toThrow(
      /still bound by a Worker/u,
    );
    await expect(base((d) => (d.resources = d.resources.filter((r) => r.id !== W('acme-auth'))))).rejects.toThrow(
      /service binding/u,
    );
    await expect(
      base((d) => {
        d.resources.find((r) => r.id === `d1:${D1_ID}`).name = 'renamed';
      }),
    ).rejects.toThrow(/can’t rename a d1/u);
    await expect(base((d) => (d.resources = d.resources.filter((r) => r.id !== W('acme-api'))))).rejects.toThrow(
      PlanRefused,
    );
  });

  it('ignores the settings Cloudflare or the deploy owns', async () => {
    const fetch = account();
    const d = await current(fetch);
    const api = d.resources.find((r) => r.id === W('acme-api'));
    api.attrs = { ...api.attrs, handlers: ['fetch'], secrets: [], versions: [], deployed: null };
    d.resources.find((r) => r.id === `d1:${D1_ID}`).attrs = { size: 1 };
    expect((await plan(ctxFor(fetch), d)).changes).toEqual([]);
    expect(MANAGED.worker).not.toContain('secrets');
  });
});

describe('the Cloudflare provider’s apply (BRK-192)', () => {
  it('calls the expected API sequence with the write token, then plans nothing more', async () => {
    const fetch = account();
    const desired = await changed(fetch);
    const p = keptDiff(await plan(ctxFor(fetch), desired));
    const result = checkApplyResult(cloudflare, p, await apply(ctxFor(fetch, WRITE), p));
    expect(result).toEqual({
      ok: true,
      steps: [
        { resource: 'kv:acme-flags', op: 'create', ok: true },
        { resource: W('acme-api'), op: 'update', ok: true },
        { resource: ROUTE, op: 'update', ok: true },
      ],
    });
    expect(fetch.writes()).toEqual([
      `POST ${a}/storage/kv/namespaces`,
      `PATCH ${a}/workers/scripts/acme-api/settings`,
      `PUT /zones/${ZONE}/workers/routes/0000000000000000000000000000d101`,
    ]);
    const writes = fetch.calls.filter((c) => c.method !== 'GET');
    expect(writes.every((c) => c.auth === `Bearer ${WRITE}`)).toBe(true);
    const settings = writes[1].body;
    // The new namespace's ID, made one step earlier, and variables and secrets kept without being read.
    expect(settings.bindings).toContainEqual({
      name: 'FLAGS',
      type: 'kv_namespace',
      namespace_id: '0000000000000000000000000000b101',
    });
    expect(settings.keep_bindings).toEqual(['json', 'plain_text', 'secret_text']);
    expect(settings.bindings.map((b) => b.type)).not.toContain('plain_text');
    expect(settings.compatibility_date).toBe('2026-10-01');
    expect(writes[2].body).toEqual({ pattern: 'api.acme.example/v2/*', script: 'acme-api' });
    expect((await plan(ctxFor(fetch), desired)).changes).toEqual([]);
  });

  it('is refused with only the board’s read token: Cloudflare answers 403, and nothing after it runs', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    const result = checkApplyResult(cloudflare, p, await apply(ctxFor(fetch, READ), p));
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      {
        resource: 'kv:acme-flags',
        op: 'create',
        ok: false,
        error: expect.stringMatching(/write token needs Workers KV Storage Write/u),
      },
    ]);
    expect(fetch.writes()).toHaveLength(1);
  });

  it('refuses an observe-only environment before it calls Cloudflare', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    const before = fetch.calls.length;
    await expect(apply(ctxFor(fetch, WRITE, { observeOnly: true }), p)).rejects.toThrow(/observe only/u);
    expect(fetch.calls.length).toBe(before);
  });

  it('stops at a resource that changed since it was planned', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    fetch.answers[`${a}/workers/scripts/acme-api/settings`].result.compatibility_date = '2026-09-15';
    const result = checkApplyResult(cloudflare, p, await apply(ctxFor(fetch, WRITE), p));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      resource: W('acme-api'),
      ok: false,
      error: expect.stringMatching(/changed since it was planned/u),
    });
    // The namespace was made before it; the Worker and the route weren't touched.
    expect(fetch.writes()).toEqual([`POST ${a}/storage/kv/namespaces`]);
  });

  it('deletes after it unbinds, and a new Worker is the Worker alone', async () => {
    const fetch = account();
    const desired = await current(fetch);
    desired.resources.find((r) => r.id === W('acme-auth')).attrs = { bindings: [] };
    desired.resources = desired.resources.filter((r) => r.id !== `kv:${KV_SESSIONS}`);
    desired.resources.push({ id: W('acme-new'), kind: 'worker', name: 'acme-new', attrs: { crons: ['0 * * * *'] } });
    const api = desired.resources.find((r) => r.id === W('acme-api'));
    api.attrs = { bindings: [...api.attrs.bindings, { name: 'NEW', type: 'service', service: 'acme-new' }] };
    const p = await plan(ctxFor(fetch), desired);
    expect(p.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([
      `create ${W('acme-new')}`,
      `update ${W('acme-api')}`,
      `update ${W('acme-auth')}`,
      `delete kv:${KV_SESSIONS}`,
    ]);
    expect((await apply(ctxFor(fetch, WRITE), p)).ok).toBe(true);
    expect(fetch.writes()).toEqual([
      `POST ${a}/workers/workers`,
      `PUT ${a}/workers/scripts/acme-new/schedules`,
      `PATCH ${a}/workers/scripts/acme-api/settings`,
      `PATCH ${a}/workers/scripts/acme-auth/settings`,
      `DELETE ${a}/storage/kv/namespaces/${KV_SESSIONS}`,
    ]);
    expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual([{ cron: '0 * * * *' }]);
  });

  it('rolls a Worker back with a deployment of its earlier versions, forced only when asked', async () => {
    const fetch = account();
    await rollbackWorker(ctxFor(fetch, WRITE), {
      worker: 'acme-api',
      versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
    });
    await rollbackWorker(ctxFor(fetch, WRITE), {
      worker: 'acme-api',
      versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
      force: true,
    });
    expect(fetch.writes()).toEqual([
      `POST ${a}/workers/scripts/acme-api/deployments`,
      `POST ${a}/workers/scripts/acme-api/deployments?force=true`,
    ]);
    expect(fetch.calls.at(-1).body).toMatchObject({
      strategy: 'percentage',
      versions: [{ version_id: 'ver-acme-api-2', percentage: 100 }],
    });
    await expect(
      rollbackWorker(ctxFor(fetch, WRITE, { observeOnly: true }), { worker: 'acme-api', versions: [] }),
    ).rejects.toThrow(/observe only/u);
  });
});
