import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL, TOOL_NAMES } from '../src/mcp.js';
import { INFRA_TOOL_NAMES } from '../src/mcp-infra.js';
import { ProviderRegistry } from '../src/infra-provider.js';
import { api, boardApi } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { fakeProvider, fakeState } from './fake-infra-provider.js';

const AGENT = 'claude-mcp-infra';
const PROVIDER = 'fakemcp';
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const json = async (res) => ({ status: res.status, ...(await res.json()) });

let next = 1;
/** A request from a client of the newest revision, as the agent, in a repository. */
function modern(method, params = {}, { repo = 'widgets' } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TEST_API_TOKEN}`,
    'X-Breakaway-Agent': AGENT,
    'X-Breakaway-Repo': repo,
    'MCP-Protocol-Version': PROTOCOL,
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params: { ...params, _meta: meta } }),
  });
}

async function call(name, args = {}, options = {}) {
  const res = await json(await modern('tools/call', { name, arguments: args }, options));
  return res.result ?? res;
}
const text = (result) => result.content.map((c) => c.text).join('\n');

/** The fake platform's desired state: what it runs now, with `change` applied by resource ID (null drops one). */
const desired = (provider, change = {}) => ({
  version: 1,
  provider: PROVIDER,
  resources: provider.state.resources
    .filter((r) => change[r.id] !== null)
    .map((r) => ({ ...structuredClone(r), ...(change[r.id] ?? {}) })),
});

describe('Architect on the MCP server (BRK-202)', () => {
  let staging;
  let elsewhere;
  let plan;
  let incident;
  beforeAll(async () => {
    const repo = await api('repos', {
      method: 'POST',
      body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['gear:GR'] },
    });
    expect([201, 409]).toContain(repo.status);
    const made = await json(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: PROVIDER, name: 'mcp-staging', kind: 'staging', target: 'svc-api' },
      }),
    );
    expect(made.status).toBe(201);
    staging = made.environment;
    const theirs = await json(
      await boardApi('infra/environments', {
        method: 'POST',
        body: { repo: 'gadgets', provider: 'fakeother', name: 'mcp-staging', kind: 'staging' },
      }),
    );
    expect(theirs, theirs.error).toMatchObject({ status: 201 });
    elsewhere = theirs.environment;
    // No events of its own: a refresh pulls a provider's events into the stream (BRK-191), and these tests read only
    // the signals recorded below.
    const provider = fakeProvider({ id: PROVIDER, state: { ...fakeState(), events: [] } });
    await runInDurableObject(store(), async (instance) => {
      instance.infraProviders = new ProviderRegistry();
      instance.infraProviders.register(provider);
      await instance.refreshInventory(PROVIDER);
      const state = desired(provider, { 'svc-api': { attrs: { instances: 4, version: '1.0.0' } }, 'db-main': null });
      instance.sql.exec(
        `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error)
         VALUES ('widgets', 'mcp-staging.json', 'mcp-staging', ?, 'abc1234', ?, ?, 'abc1234', ?, NULL)`,
        PROVIDER,
        Date.now(),
        JSON.stringify(state),
        Date.now(),
      );
      const at = new Date(Date.now() - 60_000).toISOString();
      await instance.recordSignals([
        {
          source: PROVIDER,
          environment: 'mcp-staging',
          environmentId: staging.id,
          resource: 'db-main',
          kind: 'alert',
          level: 'warning',
          value: 81,
          at,
          text: 'main is 81% full',
        },
        {
          source: PROVIDER,
          environment: 'mcp-staging',
          environmentId: elsewhere.id,
          resource: null,
          kind: 'health',
          level: 'critical',
          value: null,
          at,
          text: 'a gadget is down',
        },
      ]);
    });
    const res = await json(
      await api('infra/plans', {
        method: 'POST',
        body: { environment: staging.id, source: 'pull-request', ref: '#42', by: 'claude-someone' },
      }),
    );
    expect(res.status).toBe(201);
    plan = res.plan;
    const tasks = await json(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'The api is down', project: 'ops', tags: ['incident'], horizon: 'now' },
          { description: 'A gadget is down', repo: 'gadgets', project: 'gear', tags: ['incident'], horizon: 'now' },
        ],
      }),
    );
    expect(tasks.status).toBe(201);
    incident = tasks.tasks[0];
  });

  it('lists the Architect tools, read only, with no tool that writes to infrastructure', async () => {
    const { result } = await json(await modern('tools/list'));
    expect(INFRA_TOOL_NAMES).toEqual([
      'infra_environments',
      'infra_environment',
      'infra_plans',
      'infra_plan',
      'infra_signals',
      'infra_incidents',
    ]);
    expect(TOOL_NAMES.slice(-INFRA_TOOL_NAMES.length)).toEqual(INFRA_TOOL_NAMES);
    const tools = result.tools.filter((t) => t.name.startsWith('infra_'));
    expect(tools.map((t) => t.name)).toEqual(INFRA_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    // Approving, rejecting, freezing, and applying are the owner's and the board's: no tool does them.
    expect(
      result.tools.map((t) => t.name).filter((n) => /approve|reject|freeze|apply|environment_add/u.test(n)),
    ).toEqual([]);
  });

  it('reads this repository’s environments, never another’s', async () => {
    const result = await call('infra_environments');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.repo).toBe('widgets');
    expect(result.structuredContent.environments.map((e) => e.id)).toEqual([staging.id]);
    expect(text(result)).toMatch(/^mcp-staging \(\d+\): staging · fakemcp · svc-api/u);
    const gadgets = await call('infra_environments', {}, { repo: 'gadgets' });
    expect(gadgets.structuredContent.environments.map((e) => e.id)).toEqual([elsewhere.id]);
  });

  it('reads one environment with its desired state and the fake provider’s inventory', async () => {
    const result = await call('infra_environment', { environment: 'mcp-staging' });
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent;
    expect(data.environment).toMatchObject({ id: staging.id, name: 'mcp-staging', repo: 'widgets' });
    expect(data.resources.map((r) => r.id).sort()).toEqual(['db-main', 'route-api', 'svc-api']);
    expect(data.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: 'svc-api', to: 'db-main', kind: 'uses' })]),
    );
    expect(data.desired).toMatchObject({ sha: 'abc1234' });
    expect(text(result)).toMatch(/Desired state: .*mcp-staging\.json at abc1234/u);
    expect(text(result)).toMatch(/service api/u);
    expect(text(result)).toMatch(/uses database main/u);
    // By its ID too; another repository's, by ID or name, is refused.
    expect(
      (await call('infra_environment', { environment: String(staging.id) })).structuredContent.environment.id,
    ).toBe(staging.id);
    const theirs = await call('infra_environment', { environment: String(elsewhere.id) });
    expect(theirs).toMatchObject({ isError: true });
    expect(text(theirs)).toMatch(/no environment \d+ in widgets/u);
    expect(await call('infra_environment', { environment: 'nowhere' })).toMatchObject({ isError: true });
  });

  it('says how to add a desired state when an environment has none', async () => {
    const result = await call('infra_environment', { environment: 'mcp-staging' }, { repo: 'gadgets' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.desired).toBeNull();
    expect(text(result)).toMatch(/Propose \.github\/breakaway-infra\/mcp-staging\.json by pull request/u);
  });

  it('reads plans and one plan, with its changes, cost, and why it can’t be undone', async () => {
    const list = await call('infra_plans');
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.plans.map((p) => p.id)).toEqual([plan.id]);
    expect(text(list)).toMatch(
      new RegExp(`^${plan.id}  Draft  mcp-staging  2 changes · adds .* · can’t be undone`, 'u'),
    );
    expect((await call('infra_plans', { state: 'waiting' })).structuredContent.plans).toEqual([]);
    expect((await call('infra_plans', { environment: 'mcp-staging' })).structuredContent.plans).toHaveLength(1);
    expect((await call('infra_plans', {}, { repo: 'gadgets' })).structuredContent.plans).toEqual([]);
    expect(await call('infra_plans', { state: 'nope' })).toMatchObject({ isError: true });

    const one = await call('infra_plan', { plan: plan.id });
    expect(one.isError).toBeUndefined();
    expect(one.structuredContent.plan).toMatchObject({ id: plan.id, state: 'draft', reversible: false });
    expect(one.structuredContent.plan.diff.changes.map((c) => `${c.op} ${c.resource}`)).toEqual([
      'scale svc-api',
      'delete db-main',
    ]);
    const words = text(one);
    expect(words).toMatch(/From a pull request \(#42\), made by claude-someone\./u);
    expect(words).toMatch(/It can’t be undone: delete main/u);
    expect(words).toMatch(/scale service api/u);
    // Another repository's plan isn't read through this one.
    const theirs = await call('infra_plan', { plan: plan.id }, { repo: 'gadgets' });
    expect(theirs).toMatchObject({ isError: true });
    expect(text(theirs)).toMatch(/no plan .* in gadgets/u);
  });

  it('reads this repository’s signals, by environment, kind, and level, and the daily summaries', async () => {
    const all = await call('infra_signals');
    expect(all.isError).toBeUndefined();
    expect(all.structuredContent.signals.map((s) => s.text)).toEqual(['main is 81% full']);
    expect(text(all)).toMatch(/warning {2}alert {2}mcp-staging · db-main {2}main is 81% full \(81\)/u);
    expect(
      (await call('infra_signals', { environment: 'mcp-staging', level: 'warning' })).structuredContent.signals,
    ).toHaveLength(1);
    expect((await call('infra_signals', { kind: 'health' })).structuredContent.signals).toEqual([]);
    const gadgets = await call('infra_signals', {}, { repo: 'gadgets' });
    expect(gadgets.structuredContent.signals.map((s) => s.text)).toEqual(['a gadget is down']);
    const days = await call('infra_signals', { days: true });
    expect(days.isError).toBeUndefined();
    expect(days.structuredContent.days).toEqual([]);
    expect(await call('infra_signals', { days: true, level: 'warning' })).toMatchObject({ isError: true });
    expect(await call('infra_signals', { kind: 'metric' })).toMatchObject({ isError: true });
  });

  it('reads this repository’s open incidents', async () => {
    const result = await call('infra_incidents');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.incidents.map((t) => t.wid)).toEqual([incident.wid]);
    expect(text(result)).toMatch(/The api is down/u);
    expect((await call('infra_incidents', { closed: true })).structuredContent.incidents).toEqual([]);
  });

  it('changes nothing: every Architect tool is a read', async () => {
    const before = await json(await api(`infra/audit?environmentId=${staging.id}`));
    for (const name of INFRA_TOOL_NAMES) {
      const args =
        name === 'infra_environment' ? { environment: 'mcp-staging' } : name === 'infra_plan' ? { plan: plan.id } : {};
      expect((await call(name, args)).isError, name).toBeUndefined();
    }
    const after = await json(await api(`infra/audit?environmentId=${staging.id}`));
    expect(after.entries).toEqual(before.entries);
    expect((await call('infra_plan', { plan: plan.id })).structuredContent.plan.state).toBe('draft');
  });
});
