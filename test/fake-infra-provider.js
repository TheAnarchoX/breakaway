/**
 * An in-memory Architect provider (BRK-173) for every Architect test: it discovers, plans, applies, observes, prices,
 * and reports events from state held in the test, and never reaches the network. Its kinds: `service` (scales and
 * restarts), `database` (deleting one can't be undone), and `route`. It estimates what a change would cost, too, and
 * says which settings the console may change (`FAKE_EDITABLE`).
 *
 * `fakeProvider()` takes the starting state; `provider.state` is live, so a test can change the platform by hand
 * (drift, break-glass) and `provider.calls` records every call, with its environment.
 *
 * Its read-only token (BRK-194) is one of `FAKE_TOKENS`: the platform knows each and says what it can do;
 * `provider.tokensSeen` records every token it was asked about.
 */
import { checkApply } from '../src/infra-provider.js';

/** @typedef {import('../src/infra-provider.js').Provider} Provider */
/** @typedef {import('../src/infra-provider.js').Resource} Resource */
/** @typedef {import('../src/infra-provider.js').Relation} Relation */
/** @typedef {import('../src/infra-provider.js').Change} Change */

export const FAKE_KINDS = {
  service: { changes: ['create', 'update', 'delete', 'scale', 'restart'], scales: 'instances' },
  database: { changes: ['create', 'update', 'delete'] },
  route: { changes: ['create', 'update', 'delete'] },
};

/** What the console may change on each fake kind (BRK-262). The fake compares every attr, so any path is one it plans. */
export const FAKE_EDITABLE = {
  service: {
    fields: [
      {
        path: 'instances',
        label: 'Instances',
        type: 'number',
        integer: true,
        min: 1,
        max: 10,
        help: 'How many copies run.',
      },
      { path: 'version', label: 'Version', type: 'text', help: 'The version it runs.' },
    ],
    shown: [{ path: 'secrets', label: 'Secrets', help: 'Set with its deploy, never here.' }],
  },
  database: {
    fields: [
      {
        path: 'size',
        label: 'Size',
        type: 'choice',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large' },
        ],
        help: 'How big a machine it runs on.',
      },
    ],
  },
  route: {
    name: { label: 'Hostname', help: 'Where it answers.' },
    fields: [{ path: 'path', label: 'Path', type: 'text', help: 'Which paths it sends to the service.' }],
  },
};

/** Tokens the fake platform knows, and the permissions each carries. Plainly fake values. */
export const FAKE_TOKENS = {
  'fake-read-token': [
    { name: 'Fake Services Read', level: 'read' },
    { name: 'Fake Alerts Read', level: 'read' },
  ],
  'fake-write-token': [
    { name: 'Fake Services Read', level: 'read' },
    { name: 'Fake Services Edit', level: 'write' },
  ],
  'fake-narrow-token': [{ name: 'Fake Services Read', level: 'read' }],
};

/** Attributes that scale a service: a change to only these is a `scale`. */
const SCALE_ATTRS = new Set(['instances']);

/** A time `hours` before now, to the second: the fake's events stay inside the signal stream's window whenever the tests run. */
const hoursAgo = (hours) => new Date(Math.floor(Date.now() / 1000 - hours * 3600) * 1000).toISOString();

/** A small platform: a service that uses a database and serves a route. Its events happened in the last few hours. */
export function fakeState() {
  return {
    resources: [
      { id: 'svc-api', kind: 'service', name: 'api', attrs: { instances: 2, version: '1.0.0' } },
      { id: 'db-main', kind: 'database', name: 'main', attrs: { size: 'small' } },
      { id: 'route-api', kind: 'route', name: 'api.acme.example', attrs: { path: '/*' } },
    ],
    relations: [
      { from: 'svc-api', to: 'db-main', kind: 'uses' },
      { from: 'svc-api', to: 'route-api', kind: 'serves' },
    ],
    /** @type {Record<string, string>} */
    health: { 'svc-api': 'healthy', 'db-main': 'healthy', 'route-api': 'healthy' },
    /** @type {Record<string, number>} */
    costs: { 'svc-api': 5, 'db-main': 1.5, 'route-api': 0 },
    /** @type {Record<string, number>} */
    restarts: {},
    /** @type {Array<{ resource: string | null, kind: string, level: string, value: number | null, at: string, text: string }>} */
    events: [
      {
        resource: 'svc-api',
        kind: 'health',
        level: 'info',
        value: null,
        at: hoursAgo(3),
        text: 'api is up',
      },
      {
        resource: 'db-main',
        kind: 'alert',
        level: 'warning',
        value: 81,
        at: hoursAgo(2),
        text: 'main is 81% full',
      },
      {
        resource: null,
        kind: 'cost',
        level: 'info',
        value: 6.5,
        at: hoursAgo(1),
        text: 'this month so far',
      },
    ],
  };
}

const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const clone = (v) => (v == null ? null : structuredClone(v));

/**
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {ReturnType<typeof fakeState>} [options.state]
 * @param {string[]} [options.failOn] resource IDs whose change fails on apply, for rollback tests
 * @param {string} [options.now] the time observe reports, ISO 8601
 * @param {Record<string, Array<{ name: string, level: 'read' | 'write' }>>} [options.tokens] the tokens the platform knows
 * @param {boolean} [options.readToken] false for a provider that needs no token
 * @returns {Provider & { state: ReturnType<typeof fakeState>, calls: Array<{ method: string, environment: string }>, failOn: Set<string>, tokensSeen: string[] }}
 */
export function fakeProvider({
  id = 'fake',
  state = fakeState(),
  failOn = [],
  now = '2026-10-06T12:00:00Z',
  tokens = FAKE_TOKENS,
  readToken = true,
} = {}) {
  /** @type {Array<{ method: string, environment: string }>} */
  const calls = [];
  const record = (method, ctx) => calls.push({ method, environment: ctx.environment });
  /** @type {string[]} */
  const tokensSeen = [];
  const find = (rid) => state.resources.find((r) => r.id === rid);

  /** @param {Resource} r @param {'create' | 'delete'} op @returns {Change} */
  const whole = (r, op) => {
    const reversible = !(op === 'delete' && r.kind === 'database');
    return {
      op,
      resource: r.id,
      kind: r.kind,
      name: r.name,
      before: op === 'create' ? null : clone(r.attrs ?? {}),
      after: op === 'delete' ? null : clone(r.attrs ?? {}),
      reversible,
      ...(reversible ? {} : { why: `deleting database ${r.name} deletes its data` }),
    };
  };

  const provider = {
    id,
    name: 'Fake platform',
    kinds: FAKE_KINDS,
    /** @param {string} kind */
    editable: (kind) => FAKE_EDITABLE[kind] ?? null,
    state,
    calls,
    failOn: new Set(failOn),
    tokensSeen,
    ...(readToken
      ? {
          readToken: {
            permissions: [
              { name: 'Fake Services Read', for: 'what runs, and its health' },
              { name: 'Fake Alerts Read', for: 'alerts, as signals' },
            ],
            url: 'https://fake.example/tokens',
            /** @param {{ token: string }} ctx */
            async check({ token }) {
              tokensSeen.push(token);
              const known = tokens[token];
              return known
                ? { ok: true, permissions: structuredClone(known) }
                : { ok: false, error: 'the platform doesn’t know this token' };
            },
          },
        }
      : {}),

    async discover(ctx) {
      record('discover', ctx);
      return { resources: state.resources.map((r) => structuredClone(r)), relations: structuredClone(state.relations) };
    },

    async plan(ctx, desired) {
      record('plan', ctx);
      /** @type {Change[]} */
      const changes = [];
      const wanted = new Set(desired.resources.map((r) => r.id));
      for (const r of desired.resources) {
        const now = find(r.id);
        if (!now) changes.push(whole(r, 'create'));
        else if (!same(now.attrs, r.attrs) || now.name !== r.name) {
          const moved = Object.keys({ ...now.attrs, ...r.attrs }).filter((k) => !same(now.attrs?.[k], r.attrs?.[k]));
          const scale =
            now.name === r.name &&
            moved.every((k) => SCALE_ATTRS.has(k)) &&
            FAKE_KINDS[r.kind].changes.includes('scale');
          changes.push({
            op: scale ? 'scale' : 'update',
            resource: r.id,
            kind: r.kind,
            name: r.name,
            before: clone(now.attrs ?? {}),
            after: clone(r.attrs ?? {}),
            reversible: true,
          });
        }
      }
      for (const r of state.resources) if (!wanted.has(r.id)) changes.push(whole(r, 'delete'));
      return { provider: id, environment: ctx.environment, changes, reversible: changes.every((c) => c.reversible) };
    },

    async apply(ctx, plan) {
      checkApply(provider, ctx, plan);
      record('apply', ctx);
      const steps = [];
      for (const c of plan.changes) {
        if (provider.failOn.has(c.resource)) {
          steps.push({ resource: c.resource, op: c.op, ok: false, error: `the platform refused to ${c.op} ${c.name}` });
          return { ok: false, steps };
        }
        if (c.op === 'create')
          state.resources.push({ id: c.resource, kind: c.kind, name: c.name, attrs: clone(c.after) });
        else if (c.op === 'delete') {
          state.resources = state.resources.filter((r) => r.id !== c.resource);
          state.relations = state.relations.filter((rel) => rel.from !== c.resource && rel.to !== c.resource);
        } else if (c.op === 'restart') state.restarts[c.resource] = (state.restarts[c.resource] ?? 0) + 1;
        else Object.assign(find(c.resource), { name: c.name, attrs: clone(c.after) });
        steps.push({ resource: c.resource, op: c.op, ok: true });
      }
      return { ok: true, steps };
    },

    async observe(ctx) {
      record('observe', ctx);
      return state.resources.map((r) => ({ resource: r.id, state: state.health[r.id] ?? 'unknown', at: now }));
    },

    async cost(ctx) {
      record('cost', ctx);
      return state.resources.map((r) => ({
        resource: r.id,
        amount: state.costs[r.id] ?? 0,
        currency: 'USD',
        estimate: /** @type {const} */ (true),
      }));
    },

    /** A service costs 2.5 an instance, a database by its size, a route nothing; anything else it can't say. */
    async estimate(ctx, change) {
      record('estimate', ctx);
      const attrs = change.after ?? {};
      let amount = null;
      if (change.kind === 'service') amount = 2.5 * Number(attrs.instances ?? 1);
      else if (change.kind === 'database') amount = { small: 1.5, large: 6 }[String(attrs.size)] ?? null;
      else if (change.kind === 'route') amount = 0;
      return amount === null
        ? null
        : { resource: change.resource, amount, currency: 'USD', estimate: /** @type {const} */ (true) };
    },

    async events(ctx, since) {
      record('events', ctx);
      const from = Date.parse(since);
      return state.events
        .filter((e) => Date.parse(e.at) >= from)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((e) => ({ source: id, environment: ctx.environment, ...e }));
    },
  };
  return provider;
}
