import { describe, expect, it } from 'vitest';
import { cloudflare, rid } from '../src/infra-cloudflare.js';
import {
  MANAGED,
  PlanRefused,
  STARTER_MODULE,
  STARTER_SCRIPT,
  apply,
  estimate,
  plan,
  rollbackWorker,
} from '../src/infra-cloudflare-plan.js';
import { checkApplyResult, checkPlan, creatableKinds, desiredFrom } from '../src/infra-provider.js';
import { applyEdits } from '../src/infra-changes.js';
import { keptDiff } from '../src/infra-plans.js';
import { checkEnvelope, judgeChange } from '../src/infra-envelopes.js';
import { healthVerdict } from '../src/infra-runs.js';
import {
  ACCOUNT,
  CONTAINER,
  D1_ID,
  KV_CACHE,
  KV_SESSIONS,
  QUEUE_JOBS,
  ZONE,
  cloudflareAnswers,
  cloudflareApi,
} from './cloudflare-fixture.js';
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

  // One container application, as `GET …/applications/{id}` answers it: the same one the list shows.
  answers[`${a}/containers/applications/${CONTAINER}`] = ok(list(`${a}/containers/applications`)[0]);

  const writes = {
    'POST /workers/workers': (body) => {
      list(`${a}/workers/scripts`).push({ id: body.name, handlers: [] });
      answers[`${script(body.name)}/settings`] = ok({ bindings: [] });
      answers[`${script(body.name)}/deployments`] = ok({ deployments: [] });
      answers[`${script(body.name)}/secrets`] = ok([]);
      answers[`${script(body.name)}/schedules`] = ok({ schedules: [] });
      return { id: `id-${body.name}`, name: body.name };
    },
    'PUT /workers/scripts/:name': (body, [name]) => {
      const settings = answers[`${script(name)}/settings`].result;
      settings.bindings = body.metadata.bindings;
      settings.compatibility_date = body.metadata.compatibility_date;
      answers[`${script(name)}/deployments`].result.deployments.unshift({
        id: `dep-${++n}`,
        created_on: '2026-10-06T12:00:00Z',
        versions: [{ version_id: `ver-${name}-${n}`, percentage: 100 }],
      });
      return { id: name };
    },
    'POST /queues': (body) => {
      const queue_id = `0000000000000000000000000000c1${String(++n).padStart(2, '0')}`;
      list(`${a}/queues?page=1&per_page=100`).push({ queue_id, ...body, consumers: [], producers: [] });
      return { queue_id, queue_name: body.queue_name };
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
    'PATCH /containers/applications/:id': (body, [id]) => {
      const app = list(`${a}/containers/applications`).find((x) => x.id === id);
      Object.assign(app, body);
      return app;
    },
    'POST /containers/applications/:id/rollouts': (body, [id]) => ({ id: `rollout-${id.slice(-4)}`, ...body }),
    'PUT /queues/:id/consumers/:consumer': (body, [id, consumer]) => {
      const c = list(`${a}/queues/${id}/consumers`).find((x) => x.consumer_id === consumer);
      c.settings = body.settings;
      return c;
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
      if (method === 'GET' || String(input).endsWith('/graphql')) {
        const res = await reads(input, init);
        const last = reads.calls.at(-1);
        calls.push({ ...last });
        return res;
      }
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/client\/v4/u, '') + url.search;
      const auth = new Headers(init.headers).get('authorization');
      let body;
      if (init.body instanceof FormData && init.body.has('metadata'))
        body = {
          metadata: JSON.parse(await /** @type {Blob} */ (init.body.get('metadata')).text()),
          modules: Object.fromEntries(
            await Promise.all(
              [...init.body.entries()]
                .filter(([k]) => k !== 'metadata')
                .map(async ([k, v]) => [k, await /** @type {Blob} */ (v).text()]),
            ),
          ),
        };
      else if (init.body instanceof FormData)
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

/** The context the apply runner calls with (CLI-12): the board's read token and the environment's write token. */
const runner = (fetch, extra = {}) => ctxFor(fetch, READ, { writeToken: WRITE, ...extra });

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

providerContract('cloudflare plan and apply', async () => {
  const fetch = account();
  const desired = await changed(fetch);
  return { provider: cloudflare, ctx: runner(fetch), desired, since: '2026-10-01T00:00:00Z' };
});

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

describe('the Cloudflare provider keeps plans and acts inside the environment’s own resources (BRK-251)', () => {
  const APP = rid('container', CONTAINER);
  const scoped = (fetch, scope) => ctxFor(fetch, READ, { scope: { target: 'acme-api', ...scope } });
  const edit = async (fetch, change) => {
    const d = await current(fetch);
    change(d);
    return d;
  };

  it('never plans for the install’s Worker, and never changes or deletes it when the target reaches it', async () => {
    const fetch = account();
    await expect(plan(scoped(fetch, { board: 'acme-api' }), await current(fetch))).rejects.toThrow(
      /acme-api is the Worker this board runs on: Architect only observes it/u,
    );
    // acme-api calls acme-auth: say acme-auth is the install's Worker.
    const ctx = scoped(fetch, { board: 'acme-auth' });
    expect((await plan(ctx, await current(fetch))).changes).toEqual([]);
    const changeAuth = await edit(fetch, (d) => {
      d.resources.find((r) => r.id === W('acme-auth')).attrs = { bindings: [] };
    });
    await expect(plan(ctx, changeAuth)).rejects.toThrow(/acme-auth is the Worker this board runs on/u);
    // Left out of the desired state, it and what only it binds aren't deleted: they aren't the environment's.
    const leftOut = await edit(fetch, (d) => {
      d.resources = d.resources.filter((r) => r.id !== W('acme-auth') && r.id !== `kv:${KV_SESSIONS}`);
    });
    expect((await plan(ctx, leftOut)).changes).toEqual([]);
    // A namespace only it binds isn't the environment's to change either.
    await expect(
      plan(
        ctx,
        await edit(fetch, (d) => {
          d.resources.find((r) => r.id === `kv:${KV_SESSIONS}`).name = 'acme-sessions-2';
        }),
      ),
    ).rejects.toThrow(/acme-sessions is reached only through a Worker outside production/u);
    expect(fetch.writes()).toEqual([]);
  });

  it('refuses to delete what a Worker outside the environment still uses', async () => {
    const fetch = account();
    // The install's Worker binds the cache namespace too.
    fetch.answers[`${a}/workers/scripts/acme-auth/settings`].result.bindings.push({
      type: 'kv_namespace',
      name: 'CACHE',
      namespace_id: KV_CACHE,
    });
    const desired = await edit(fetch, (d) => {
      const api = d.resources.find((r) => r.id === W('acme-api'));
      api.attrs = { bindings: api.attrs.bindings.filter((b) => b.name !== 'CACHE') };
      // The install's Worker isn't the environment's, so its desired state needn't list it.
      d.resources = d.resources.filter(
        (r) => r.id !== `kv:${KV_CACHE}` && r.id !== W('acme-auth') && r.id !== `kv:${KV_SESSIONS}`,
      );
    });
    await expect(plan(scoped(fetch, { board: 'acme-auth' }), desired)).rejects.toThrow(
      /acme-cache is still used by acme-auth, which is outside production: Architect never deletes what another Worker relies on/u,
    );
    expect(fetch.writes()).toEqual([]);
  });

  it('refuses a change to another environment’s target, or to what only it runs', async () => {
    const fetch = account();
    // acme-api binds acme-rooms' Room class: say acme-rooms is another environment's target.
    const ctx = scoped(fetch, { others: ['acme-rooms'] });
    expect((await plan(ctx, await current(fetch))).changes).toEqual([]);
    await expect(
      plan(
        ctx,
        await edit(fetch, (d) => {
          d.resources.find((r) => r.id === APP).attrs = { maxInstances: 9 };
        }),
      ),
    ).rejects.toThrow(/acme-rooms-sandbox is reached only through a Worker outside production/u);
    await expect(
      plan(
        ctx,
        await edit(fetch, (d) => {
          d.resources.find((r) => r.id === W('acme-rooms')).attrs = { compatibilityDate: '2026-10-01' };
        }),
      ),
    ).rejects.toThrow(/acme-rooms is another environment’s target: change it in that environment/u);
    // Without that, the container is the environment's, through the class its target binds.
    const own = await plan(
      scoped(fetch, {}),
      await edit(fetch, (d) => {
        d.resources.find((r) => r.id === APP).attrs = { maxInstances: 9 };
      }),
    );
    expect(own.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([`update ${APP}`]);
  });

  it('sends a route or custom domain only to the environment’s Workers, on a pattern or hostname nobody has', async () => {
    const fetch = account();
    const ctx = scoped(fetch, { board: 'acme-auth' });
    const route = (name, worker, kind = 'route') =>
      edit(fetch, (d) => {
        d.resources.push({ id: `${kind}:new`, kind, name, attrs: { zone: 'acme.example', worker } });
      });
    // A pattern or hostname another Worker already has.
    await expect(plan(ctx, await route('other.acme.example/*', 'acme-api'))).rejects.toThrow(
      /other\.acme\.example\/\* already sends to acme-other: a route can’t take a pattern that’s already in use/u,
    );
    await expect(plan(ctx, await route('other.acme.example', 'acme-api', 'custom-domain'))).rejects.toThrow(
      /already sends to acme-other: a custom-domain can’t take a hostname/u,
    );
    // A Worker outside the environment, on the account or the install's own.
    await expect(plan(ctx, await route('new.acme.example/*', 'acme-other'))).rejects.toThrow(
      /would send to acme-other, which isn’t one of production’s Workers/u,
    );
    await expect(plan(ctx, await route('new.acme.example/*', 'acme-auth'))).rejects.toThrow(
      /would send to acme-auth, which isn’t one of production’s Workers/u,
    );
    // A route already there can't be pointed outside the environment, or renamed onto a pattern in use.
    const retarget = (worker) =>
      edit(fetch, (d) => {
        d.resources.find((r) => r.id === ROUTE).attrs.worker = worker;
      });
    await expect(plan(ctx, await retarget('acme-other'))).rejects.toThrow(/isn’t one of production’s Workers/u);
    await expect(plan(ctx, await retarget('acme-auth'))).rejects.toThrow(/isn’t one of production’s Workers/u);
    const renamed = await edit(fetch, (d) => {
      d.resources.find((r) => r.id === ROUTE).name = 'other.acme.example/*';
    });
    await expect(plan(ctx, renamed)).rejects.toThrow(/already sends to acme-other/u);
    // A new pattern, to the target, is fine.
    const p = await plan(ctx, await route('new.acme.example/*', 'acme-api'));
    expect(p.changes).toMatchObject([{ op: 'create', resource: 'route:new', after: { worker: 'acme-api' } }]);
    expect(fetch.writes()).toEqual([]);
  });

  it('refuses an envelope act on a resource outside the environment', async () => {
    const fetch = account();
    const found = await cloudflare.discover(ctxFor(fetch));
    const app = found.resources.find((r) => r.id === APP);
    const jobs = found.resources.find((r) => r.id === rid('queue', QUEUE_JOBS));
    const outside = (scope, r) => cloudflare.outside?.(scoped(fetch, scope), found, r) ?? null;
    expect(outside({}, app)).toBeNull();
    expect(outside({}, jobs)).toBeNull();
    expect(outside({ others: ['acme-rooms'] }, app)).toMatch(/reached only through a Worker outside production/u);
    expect(outside({ board: 'acme-rooms' }, app)).toMatch(/reached only through a Worker outside production/u);
    const auth = found.resources.find((r) => r.id === W('acme-auth'));
    expect(outside({ board: 'acme-auth' }, auth)).toMatch(/the Worker this board runs on/u);
    // A queue whose Worker consumer is outside: its concurrency is that Worker's.
    const theirs = structuredClone(jobs);
    theirs.attrs.consumers = [{ type: 'worker', worker: 'acme-auth' }];
    expect(outside({ board: 'acme-auth' }, theirs)).toMatch(/consumed by acme-auth, which is outside production/u);
  });
});

describe('the Cloudflare provider’s apply (BRK-192)', () => {
  it('calls the expected API sequence with the write token, then plans nothing more', async () => {
    const fetch = account();
    const desired = await changed(fetch);
    const p = keptDiff(await plan(ctxFor(fetch), desired));
    const result = checkApplyResult(cloudflare, p, await apply(runner(fetch), p));
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

  it('is refused before any call without the runner’s write token, and the board’s read token can’t write', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    const before = fetch.calls.length;
    // The board never sets writeToken: an apply that reached the provider there sends nothing.
    await expect(apply(ctxFor(fetch, READ), p)).rejects.toThrow(/only the apply runner holds: nothing was sent/u);
    await expect(
      rollbackWorker(ctxFor(fetch, READ), {
        worker: 'acme-api',
        versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
      }),
    ).rejects.toThrow(/only the apply runner holds/u);
    expect(fetch.calls.length).toBe(before);
    // A read-only token in the runner's secret by mistake: Cloudflare's 403 stops the first write.
    const result = checkApplyResult(cloudflare, p, await apply(runner(fetch, { writeToken: READ }), p));
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

  it('names Cloudflare’s Workers roles when the write token is refused, legacy names included (BRK-243)', async () => {
    /** The account, but refusing these writes with a 403, as a write token with only per-Worker Workers Editor does. */
    const refusing = (fetch, re) =>
      Object.assign(
        async (input, init = {}) =>
          (init.method ?? 'GET') !== 'GET' && re.test(String(input))
            ? Response.json(
                { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
                { status: 403 },
              )
            : fetch(input, init),
        { calls: fetch.calls, answers: fetch.answers, writes: fetch.writes },
      );

    // Editor's own work: a settings change, refused, names Editor on the Worker and the legacy permission.
    let fetch = account();
    let desired = await current(fetch);
    desired.resources.find((r) => r.id === W('acme-api')).attrs = { compatibilityDate: '2026-10-01' };
    let p = await plan(ctxFor(fetch), desired);
    let result = await apply(runner(refusing(fetch, /\/settings$/u)), p);
    expect(result.steps.at(-1).error).toMatch(
      /write token needs Workers Editor on this Worker \(or the legacy Workers Scripts Write\)/u,
    );
    await expect(
      rollbackWorker(runner(refusing(fetch, /\/deployments/u)), {
        worker: 'acme-api',
        versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
      }),
    ).rejects.toThrow(/needs Workers Editor on this Worker/u);

    // Editor can't make or delete a Worker: the plan says a delete needs Admin, and a refused one says so too.
    fetch = account();
    desired = await current(fetch);
    const api = desired.resources.find((r) => r.id === W('acme-api'));
    api.attrs = { bindings: api.attrs.bindings.filter((b) => b.name !== 'AUTH') };
    desired.resources = desired.resources.filter((r) => r.id !== W('acme-auth') && r.id !== `kv:${KV_SESSIONS}`);
    desired.resources.push({ id: W('acme-new'), kind: 'worker', name: 'acme-new', attrs: {} });
    p = await plan(ctxFor(fetch), desired);
    expect(p.changes.find((c) => c.resource === W('acme-auth')).why).toMatch(/needs Workers Admin on the write token/u);
    result = await apply(runner(refusing(fetch, /\/workers\/workers$/u)), p);
    expect(result.steps.at(-1)).toMatchObject({
      resource: W('acme-new'),
      ok: false,
      error: expect.stringMatching(
        /needs Workers Admin at the Workers product scope, because Workers Editor can’t make/u,
      ),
    });
    fetch = account();
    p = await plan(ctxFor(fetch), { ...desired, resources: desired.resources.filter((r) => r.id !== W('acme-new')) });
    result = await apply(runner(refusing(fetch, /\/workers\/scripts\/acme-auth$/u)), p);
    expect(result.steps.at(-1)).toMatchObject({
      resource: W('acme-auth'),
      ok: false,
      error: expect.stringMatching(/needs Workers Admin, because Workers Editor can’t delete a Worker/u),
    });
  });

  it('refuses an observe-only environment before it calls Cloudflare', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    const before = fetch.calls.length;
    await expect(apply(runner(fetch, { observeOnly: true }), p)).rejects.toThrow(/observe only/u);
    expect(fetch.calls.length).toBe(before);
  });

  it('stops at a resource that changed since it was planned', async () => {
    const fetch = account();
    const p = await plan(ctxFor(fetch), await changed(fetch));
    fetch.answers[`${a}/workers/scripts/acme-api/settings`].result.compatibility_date = '2026-09-15';
    const result = checkApplyResult(cloudflare, p, await apply(runner(fetch), p));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      resource: W('acme-api'),
      ok: false,
      error: expect.stringMatching(/changed since it was planned/u),
    });
    // The namespace was made before it; the Worker and the route weren't touched.
    expect(fetch.writes()).toEqual([`POST ${a}/storage/kv/namespaces`]);
  });

  it('deletes after it unbinds, and a new Worker starts with a script that answers /health', async () => {
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
    expect((await apply(runner(fetch), p)).ok).toBe(true);
    expect(fetch.writes()).toEqual([
      `POST ${a}/workers/workers`,
      `PUT ${a}/workers/scripts/acme-new`,
      `PUT ${a}/workers/scripts/acme-new/schedules`,
      `PATCH ${a}/workers/scripts/acme-api/settings`,
      `PATCH ${a}/workers/scripts/acme-auth/settings`,
      `DELETE ${a}/storage/kv/namespaces/${KV_SESSIONS}`,
    ]);
    const [upload, schedules] = fetch.calls.filter((c) => c.method === 'PUT');
    expect(upload.body.metadata).toMatchObject({
      main_module: STARTER_MODULE,
      bindings: [],
      compatibility_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    });
    expect(upload.body.modules).toEqual({ [STARTER_MODULE]: STARTER_SCRIPT });
    expect(STARTER_SCRIPT).toContain("'/health'");
    expect(schedules.body).toEqual([{ cron: '0 * * * *' }]);
  });

  it('plans and applies what a create edit adds from the console (BRK-270)', async () => {
    const fetch = account();
    const kinds = creatableKinds(cloudflare);
    const made = (edits, desired) =>
      applyEdits({
        file: desired,
        edits,
        templates: new Map(),
        environment: 'production',
        creatable: (kind) => kinds[kind] ?? null,
      });
    const queue = made(
      [
        {
          op: 'create',
          kind: 'queue',
          name: 'acme-mail',
          attrs: { retention: 86_400 },
          bindTo: { worker: 'acme-api', binding: 'MAIL' },
        },
      ],
      await current(fetch),
    );
    expect(queue.problems).toEqual([]);
    const p = checkPlan(cloudflare, await plan(ctxFor(fetch), queue.file));
    expect(p.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([
      'create queue:acme-mail',
      `update ${W('acme-api')}`,
    ]);
    expect(p.changes[0].after).toEqual({ deliveryDelay: 0, deliveryPaused: false, retention: 86_400 });
    expect(p.reversible).toBe(true);
    expect((await apply(runner(fetch), p)).ok).toBe(true);
    const [made1, bound] = fetch.calls.filter((c) => c.method !== 'GET');
    expect(made1).toMatchObject({
      path: `${a}/queues`,
      body: {
        queue_name: 'acme-mail',
        settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 86_400 },
      },
    });
    expect(bound.body.bindings).toContainEqual({ name: 'MAIL', type: 'queue', queue_name: 'acme-mail' });

    // A Durable Object is added to the file, but the plan waits for its Worker's code.
    const counter = made(
      [
        {
          op: 'create',
          kind: 'durable-object',
          name: 'acme-api_Ticket',
          attrs: { class: 'Ticket', script: 'acme-api' },
        },
      ],
      await current(account()),
    );
    expect(counter.problems).toEqual([]);
    await expect(plan(ctxFor(account()), counter.file)).rejects.toThrow(/made by a migration in its Worker’s code/u);
  });

  it('rolls a Worker back with a deployment of its earlier versions, forced only when asked', async () => {
    const fetch = account();
    await rollbackWorker(runner(fetch), {
      worker: 'acme-api',
      versions: [{ id: 'ver-acme-api-2', percentage: 100 }],
    });
    await rollbackWorker(runner(fetch), {
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
      rollbackWorker(runner(fetch, { observeOnly: true }), { worker: 'acme-api', versions: [] }),
    ).rejects.toThrow(/observe only/u);
  });
});

describe('the Cloudflare provider’s estimate (BRK-192)', () => {
  it('prices a new resource from its settings, a changed one from its use, and nothing for a delete', async () => {
    const fetch = account();
    const ctx = ctxFor(fetch);
    const p = checkPlan(cloudflare, await plan(ctx, await changed(fetch)));
    const [kv, worker] = p.changes;
    expect(await estimate(ctx, kv)).toEqual({ resource: 'kv:acme-flags', amount: 0, currency: 'USD', estimate: true });
    const priced = await estimate(ctx, worker);
    expect(priced).toMatchObject({ resource: W('acme-api'), currency: 'USD', estimate: true });
    expect(priced.amount).toBeGreaterThan(0);
    expect(fetch.calls.some((c) => c.path === '/graphql')).toBe(true);
    expect(await estimate(ctx, { ...worker, op: 'delete', after: null })).toBeNull();
    expect(typeof cloudflare.estimate).toBe('function');
  });
});

describe('the Cloudflare provider’s scale and restart, inside an envelope (BRK-227)', () => {
  const APP = rid('container', CONTAINER);
  const JOBS = rid('queue', QUEUE_JOBS);
  const envelope = checkEnvelope(
    {
      scale: [
        { kind: 'container', min: 1, max: 8 },
        { kind: 'queue', resource: 'acme-jobs', min: 1, max: 10 },
      ],
      restarts: { cap: 2, hours: 24 },
    },
    cloudflare.kinds,
  );

  /** The one change an act plans, built as the board builds it (store-infra-envelopes.js), from what runs now. */
  async function act(fetch, resource, op, value = null) {
    const found = await cloudflare.discover(ctxFor(fetch));
    const r = found.resources.find((x) => x.id === resource);
    const scales = cloudflare.kinds[r.kind].scales;
    const change = {
      op,
      resource: r.id,
      kind: r.kind,
      name: r.name,
      before: structuredClone(r.attrs),
      after: op === 'scale' ? { ...structuredClone(r.attrs), [scales]: value } : structuredClone(r.attrs),
      reversible: true,
    };
    const diff = checkPlan(
      cloudflare,
      { provider: 'cloudflare', environment: 'production', changes: [change], reversible: true },
      ctxFor(fetch),
    );
    return {
      diff,
      verdict: judgeChange(envelope, change, { scales, costAfter: null, currency: 'USD', restartsUsed: 0 }),
    };
  }

  /** The executor's health check after a run: what observe says of what the plan touched. */
  async function health(fetch, diff) {
    return healthVerdict(diff, await cloudflare.observe(ctxFor(fetch)));
  }

  it('declares scale for containers and queues, restart for containers, and nothing else', () => {
    expect(cloudflare.kinds.container).toEqual({
      changes: ['create', 'update', 'delete', 'scale', 'restart'],
      scales: 'maxInstances',
      settings: ['maxInstances'],
    });
    expect(cloudflare.kinds.queue).toMatchObject({
      changes: ['create', 'update', 'delete', 'scale'],
      scales: 'maxConcurrency',
    });
    // BRK-240's adopt keeps a kind's settings, so a queue's concurrency is kept in its draft too.
    expect(cloudflare.kinds.queue.settings).toContain('maxConcurrency');
    for (const kind of ['worker', 'durable-object', 'd1', 'kv', 'r2', 'route', 'custom-domain']) {
      expect(cloudflare.kinds[kind].changes).toEqual(['create', 'update', 'delete']);
      expect(cloudflare.kinds[kind].scales).toBeUndefined();
    }
    // So the envelope form offers only those two, and an envelope can't bound anything else.
    expect(() => checkEnvelope({ scale: [{ kind: 'worker', min: 1, max: 2 }] }, cloudflare.kinds)).toThrow(
      /doesn’t scale/u,
    );
  });

  it('scales a container application: one PATCH with the write token, read back, and healthy after', async () => {
    const fetch = account();
    const { diff, verdict } = await act(fetch, APP, 'scale', 8);
    expect(verdict).toMatchObject({ inside: true, why: '8 is inside 1 to 8' });
    const result = checkApplyResult(cloudflare, diff, await apply(runner(fetch), diff));
    expect(result).toEqual({ ok: true, steps: [{ resource: APP, op: 'scale', ok: true }] });
    expect(fetch.writes()).toEqual([`PATCH ${a}/containers/applications/${CONTAINER}`]);
    const write = fetch.calls.find((c) => c.method === 'PATCH');
    expect(write).toMatchObject({ auth: `Bearer ${WRITE}`, body: { max_instances: 8 } });
    // The apply read it back after the write.
    const after = fetch.calls.slice(fetch.calls.indexOf(write) + 1);
    expect(after.some((c) => c.method === 'GET' && c.path === `${a}/containers/applications/${CONTAINER}`)).toBe(true);
    expect(await health(fetch, diff)).toEqual({ ok: true, problems: [], unknown: [], touched: 1 });
  });

  it('restarts a container application with a rollout of the configuration it runs, then checks its health', async () => {
    const fetch = account();
    const { diff, verdict } = await act(fetch, APP, 'restart');
    expect(verdict).toMatchObject({ inside: true, why: 'restart 1 of 2 in a day' });
    const result = checkApplyResult(cloudflare, diff, await apply(runner(fetch), diff));
    expect(result).toEqual({ ok: true, steps: [{ resource: APP, op: 'restart', ok: true }] });
    expect(fetch.writes()).toEqual([`POST ${a}/containers/applications/${CONTAINER}/rollouts`]);
    const rollout = fetch.calls.find((c) => c.method === 'POST');
    expect(rollout.auth).toBe(`Bearer ${WRITE}`);
    expect(rollout.body).toEqual({
      description: 'Restarted by breakaway',
      strategy: 'rolling',
      kind: 'full_auto',
      step_percentage: 10,
      target_configuration: { image: 'registry.example/acme/sandbox:1', instance_type: 'basic' },
    });
    // The configuration went from Cloudflare to Cloudflare: the plan never held it.
    expect(JSON.stringify(diff)).not.toContain('registry.example');
    expect(await health(fetch, diff)).toMatchObject({ ok: true, touched: 1 });

    // A rollout that leaves no instance running fails the health check, so the executor knows.
    fetch.answers[`${a}/containers/applications`].result[0].health.instances.active = 0;
    expect(await health(fetch, diff)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/acme-rooms-sandbox is down/u)],
    });
  });

  it('scales a queue’s Worker consumer, keeping its other settings, and checks its health', async () => {
    const fetch = account();
    const { diff, verdict } = await act(fetch, JOBS, 'scale', 6);
    expect(verdict).toMatchObject({ inside: true });
    const result = checkApplyResult(cloudflare, diff, await apply(runner(fetch), diff));
    expect(result).toEqual({ ok: true, steps: [{ resource: JOBS, op: 'scale', ok: true }] });
    expect(fetch.writes()).toEqual([`PUT ${a}/queues/${QUEUE_JOBS}/consumers/consumer-1`]);
    expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual({
      type: 'worker',
      script_name: 'acme-api',
      dead_letter_queue: 'acme-jobs-dlq',
      settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 5000, max_concurrency: 6 },
    });
    const now = await cloudflare.discover(ctxFor(fetch));
    expect(now.resources.find((r) => r.id === JOBS).attrs.maxConcurrency).toBe(6);
    expect((await health(fetch, diff)).problems).toEqual([]);
  });

  it('a scale outside the envelope isn’t inside it, and the cap counts restarts', async () => {
    const fetch = account();
    expect((await act(fetch, APP, 'scale', 9)).verdict).toMatchObject({
      inside: false,
      why: '9 is outside its envelope’s 1 to 8',
    });
    const { diff } = await act(fetch, APP, 'restart');
    expect(
      judgeChange(envelope, diff.changes[0], { scales: undefined, costAfter: null, currency: 'USD', restartsUsed: 2 }),
    ).toMatchObject({ inside: false, capUsed: true });
  });

  it('refuses, in words, a kind or an application Cloudflare can’t scale or restart', async () => {
    const fetch = account();
    const found = await cloudflare.discover(ctxFor(fetch));
    const get = (id) => found.resources.find((r) => r.id === id);
    expect(cloudflare.refuses(get(W('acme-api')), 'scale')).toBe(
      'acme-api is a worker: Cloudflare scales it by itself, so there’s nothing to scale',
    );
    expect(cloudflare.refuses(get(`d1:${D1_ID}`), 'restart')).toMatch(/is a d1: Cloudflare scales it by itself/u);
    expect(cloudflare.refuses(get(JOBS), 'restart')).toBe(
      'acme-jobs is a queue: Cloudflare has no restart for one, only its consumer’s concurrency scales',
    );
    expect(cloudflare.refuses(get(APP), 'scale')).toBeNull();
    expect(cloudflare.refuses(get(JOBS), 'scale')).toBeNull();
    expect(cloudflare.refuses(get(APP), 'update')).toBeNull();

    const onDurableObjects = { ...get(APP), attrs: { ...get(APP).attrs, schedulingPolicy: 'durable_objects' } };
    expect(cloudflare.refuses(onDurableObjects, 'restart')).toBe(
      'acme-rooms-sandbox runs on the durable_objects scheduling policy: its own code starts and stops its instances, so Cloudflare can’t restart it',
    );
    const unconsumed = { ...get(JOBS), attrs: { ...get(JOBS).attrs, consumers: [] } };
    expect(cloudflare.refuses(unconsumed, 'scale')).toBe(
      'acme-jobs has no Worker consuming it, so there’s no concurrency to scale',
    );

    // Apply refuses it too, from what runs at apply, before any write.
    fetch.answers[`${a}/containers/applications`].result[0].scheduling_policy = 'durable_objects';
    const diff = {
      provider: 'cloudflare',
      environment: 'production',
      changes: [{ ...(await act(account(), APP, 'restart')).diff.changes[0] }],
      reversible: true,
    };
    diff.changes[0].before = { ...diff.changes[0].before, schedulingPolicy: 'durable_objects' };
    diff.changes[0].after = { ...diff.changes[0].before };
    const result = await apply(runner(fetch), diff);
    expect(result.steps).toEqual([
      { resource: APP, op: 'restart', ok: false, error: expect.stringMatching(/durable_objects scheduling policy/u) },
    ]);
    expect(fetch.writes()).toEqual([]);
  });

  it('isn’t stopped by instance counts Cloudflare moved since the plan, but is by a changed setting', async () => {
    const fetch = account();
    const { diff } = await act(fetch, APP, 'scale', 4);
    const app = fetch.answers[`${a}/containers/applications`].result[0];
    app.health.instances.active = 1;
    expect((await apply(runner(fetch), diff)).ok).toBe(true);

    const again = account();
    const second = (await act(again, APP, 'scale', 4)).diff;
    again.answers[`${a}/containers/applications`].result[0].max_instances = 7;
    expect((await apply(runner(again), second)).steps[0].error).toMatch(/changed since it was planned/u);
    expect(again.writes()).toEqual([]);
  });
});
