import { describe, expect, it } from 'vitest';
import {
  MAP_MAX,
  NODE,
  collapse,
  columnsOf,
  fitName,
  layoutTopology,
  planOverlay,
  worstHealth,
} from '../web/src/lib/topology.js';
import { STREAM_MAX, agentsAtWork, arrived, runWords, stepsText, streamItems } from '../web/src/lib/env-stream.js';

// The environment console (WEB-94): its map's layout and its stream, from made-up resources.
const now = Date.now();
const ago = (/** @type {number} */ minutes) => new Date(now - minutes * 60_000).toISOString();

const res = (/** @type {string} */ id, /** @type {string} */ kind, health = 'healthy', name = id) => ({
  id,
  kind,
  name,
  health: { state: health },
  cost: null,
});

/** A Worker behind a route and a domain, using a database, a store, and a queue it produces for. */
function acme() {
  return {
    resources: [
      res('worker:acme-api', 'worker', 'healthy', 'acme-api'),
      res('d1:acme-db', 'd1', 'degraded', 'acme-db'),
      res('kv:acme-cache', 'kv', 'healthy', 'acme-cache'),
      res('queue:acme-jobs', 'queue', 'healthy', 'acme-jobs'),
      res('route:1', 'route', 'unknown', 'api.acme.example/*'),
      res('custom-domain:1', 'custom-domain', 'healthy', 'acme.example'),
    ],
    relations: [
      { from: 'worker:acme-api', to: 'd1:acme-db', kind: 'uses' },
      { from: 'worker:acme-api', to: 'kv:acme-cache', kind: 'uses' },
      { from: 'worker:acme-api', to: 'queue:acme-jobs', kind: 'produces' },
      { from: 'worker:acme-api', to: 'route:1', kind: 'serves' },
      { from: 'worker:acme-api', to: 'custom-domain:1', kind: 'serves' },
    ],
  };
}

describe('the map', () => {
  it('puts what’s served in front, what acts in the middle, and what it holds on the right', () => {
    const { resources, relations } = acme();
    const col = columnsOf(resources, relations);
    expect(col.get('route:1')).toBe(0);
    expect(col.get('custom-domain:1')).toBe(0);
    expect(col.get('worker:acme-api')).toBe(1);
    expect(col.get('d1:acme-db')).toBe(2);
    expect(col.get('queue:acme-jobs')).toBe(2);
  });

  it('keeps a route in front even when nothing serves it yet, and a lone resource on the right', () => {
    const col = columnsOf([res('route:2', 'route'), res('r2:acme-files', 'r2')], []);
    expect(col.get('route:2')).toBe(0);
    expect(col.get('r2:acme-files')).toBe(2);
  });

  it('lays every resource out once, inside the box, with a line per relation', () => {
    const { resources, relations } = acme();
    const map = layoutTopology(resources, relations, { target: 'acme-api' });
    expect(map.nodes).toHaveLength(6);
    expect(map.edges).toHaveLength(5);
    for (const n of map.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + NODE.w).toBeLessThanOrEqual(map.width);
      expect(n.y + NODE.h).toBeLessThanOrEqual(map.height);
    }
    expect(map.nodes.find((n) => n.id === 'worker:acme-api').target).toBe(true);
    expect(map.columns.map((c) => c.label)).toEqual(['In front', 'Runs', 'Holds']);
  });

  it('never overlaps two nodes in a column', () => {
    const resources = Array.from({ length: 12 }, (_, i) => res(`kv:${i}`, 'kv'));
    const map = layoutTopology(resources, []);
    const ys = map.nodes.map((n) => n.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(NODE.h);
  });

  it('closes up empty columns', () => {
    const map = layoutTopology([res('kv:1', 'kv')], []);
    expect(map.columns).toHaveLength(1);
    expect(map.width).toBe(NODE.pad * 2 + NODE.w);
  });

  it('is the same layout for the same inventory, whatever order it came in', () => {
    const { resources, relations } = acme();
    const a = layoutTopology(resources, relations);
    const b = layoutTopology([...resources].reverse(), [...relations].reverse());
    const at = (/** @type {any} */ m) => Object.fromEntries(m.nodes.map((n) => [n.id, [n.x, n.y]]));
    expect(at(b)).toEqual(at(a));
  });

  it('draws up to the limit one by one, and groups each kind beyond it', () => {
    const many = Array.from({ length: MAP_MAX }, (_, i) => res(`kv:${i}`, 'kv'));
    expect(collapse(many, []).grouped).toBe(false);
    const worker = res('worker:acme-api', 'worker');
    const over = [
      worker,
      ...Array.from({ length: MAP_MAX }, (_, i) => ({
        ...res(`kv:${i}`, 'kv', i === 7 ? 'down' : 'healthy'),
        cost: { amount: 0.5, currency: 'USD' },
      })),
    ];
    const relations = over.slice(1).map((r) => ({ from: worker.id, to: r.id, kind: 'uses' }));
    const out = collapse(over, relations);
    expect(out.grouped).toBe(true);
    expect(out.resources).toHaveLength(2);
    const group = out.resources.find((r) => r.group);
    expect(group.name).toBe(`${MAP_MAX} kv`);
    expect(group.group.members).toHaveLength(MAP_MAX);
    expect(group.health.state).toBe('down');
    expect(group.cost.amount).toBe(MAP_MAX * 0.5);
    expect(out.relations).toEqual([{ from: worker.id, to: 'kind:kv', kind: 'uses' }]);
  });

  it('reads health worst first', () => {
    expect(worstHealth(['healthy', 'degraded', 'unknown'])).toBe('degraded');
    expect(worstHealth(['healthy', null])).toBe('unknown');
    expect(worstHealth(['healthy'])).toBe('healthy');
  });

  it('shows a waiting plan’s changes on the nodes, and what it adds as new ones', () => {
    const { ops, adds } = planOverlay({
      changes: [
        { op: 'create', resource: 'r2:acme-files', kind: 'r2', name: 'acme-files' },
        { op: 'scale', resource: 'queue:acme-jobs', kind: 'queue', name: 'acme-jobs' },
        { op: 'delete', resource: 'kv:acme-cache', kind: 'kv', name: 'acme-cache' },
      ],
    });
    expect(ops.get('r2:acme-files').effect).toBe('adds');
    expect(ops.get('queue:acme-jobs').effect).toBe('changes');
    expect(ops.get('kv:acme-cache').effect).toBe('removes');
    expect(adds).toEqual([
      { id: 'r2:acme-files', kind: 'r2', name: 'acme-files', health: null, cost: null, planned: true },
    ]);
    expect(planOverlay(null).ops.size).toBe(0);
  });

  it('cuts long names to fit a node', () => {
    expect(fitName('acme-api')).toBe('acme-api');
    expect(fitName('a-very-long-acme-worker-name')).toHaveLength(20);
    expect(fitName('a-very-long-acme-worker-name').endsWith('…')).toBe(true);
  });
});

describe('the stream', () => {
  const signals = [
    {
      id: 4,
      source: 'fake',
      resource: 'd1:acme-db',
      kind: 'alert',
      level: 'warning',
      at: ago(5),
      text: 'acme-db is 81% full',
    },
  ];
  const audit = [{ id: 9, at: now - 2 * 60_000, kind: 'approve', by: 'owner', plan: 'plan-3', summary: '2 changes' }];
  const runs = [
    {
      plan: 'plan-3',
      phase: 'applying',
      outcome: null,
      rollback: false,
      steps: [{ resource: 'queue:acme-jobs', op: 'scale', ok: true }],
      updated: ago(1),
      created: ago(2),
    },
  ];
  const incidents = [
    {
      id: 2,
      opened: ago(30),
      closed: null,
      level: 'critical',
      kind: 'health',
      resource: 'd1:acme-db',
      signals: 3,
      task: { uuid: 'u-1', wid: 'BRK-901', description: 'acme-db is down' },
    },
  ];

  it('puts every source in one stream, newest first', () => {
    const items = streamItems({ signals, audit, runs, incidents });
    expect(items.map((i) => i.type)).toEqual(['run', 'audit', 'signal', 'incident']);
    expect(items[0]).toMatchObject({ label: 'Applying', text: '1 of 1 change applied', plan: 'plan-3', live: true });
    expect(items[1]).toMatchObject({ label: 'Approved', who: 'you', plan: 'plan-3' });
    expect(items[2]).toMatchObject({ label: 'Alert', outcome: 'Warning', resource: 'd1:acme-db' });
    expect(items[3]).toMatchObject({ label: 'Incident opened', task: { wid: 'BRK-901' } });
  });

  it('keeps one entry per run that moves as the run does', () => {
    const done = streamItems({ runs: [{ ...runs[0], phase: 'done', outcome: 'failed', updated: ago(0) }] });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ key: 'run:plan-3', label: 'Apply failed', level: 'critical', live: false });
  });

  it('keeps at most the newest entries', () => {
    const lots = Array.from({ length: STREAM_MAX + 5 }, (_, i) => ({ ...signals[0], id: i, at: ago(i) }));
    const items = streamItems({ signals: lots });
    expect(items).toHaveLength(STREAM_MAX);
    expect(items[0].key).toBe('signal:0');
  });

  it('slides in only what’s new since the last poll, and nothing on the first load', () => {
    const first = streamItems({ signals });
    expect(arrived(null, first).size).toBe(0);
    const next = streamItems({ signals, audit });
    expect([...arrived(new Set(first.map((i) => i.key)), next)]).toEqual(['audit:9']);
  });

  it('words a run where it is and how it ended', () => {
    expect(runWords({ phase: 'queued' })).toBe('Waiting to apply');
    expect(runWords({ phase: 'rollback-applying' })).toBe('Rolling back');
    expect(runWords({ phase: 'done', outcome: 'applied' })).toBe('Applied');
    expect(stepsText(null)).toBe('');
    expect(
      stepsText([
        { resource: 'a', op: 'update', ok: true },
        { resource: 'b', op: 'delete', ok: false },
      ]),
    ).toBe('1 of 2 changes applied; delete of b failed');
  });
});

describe('the agents at work', () => {
  const tasks = [
    { uuid: 'u-1', wid: 'BRK-901', description: 'acme-db is down', claim: 'claude-brk-901', status: 'pending' },
    { uuid: 'u-2', wid: 'BRK-902', description: 'try acme', claim: 'claude-brk-902', status: 'pending' },
    { uuid: 'u-3', wid: 'BRK-903', description: 'nobody', claim: null, status: 'pending' },
  ];

  it('names the agents on its task, its open incidents, and its open plans, once each', () => {
    const out = agentsAtWork(tasks, {
      env: { task: { uuid: 'u-2' } },
      incidents: [
        { closed: null, task: { uuid: 'u-1' } },
        { closed: ago(1), task: { uuid: 'u-3' } },
      ],
      plans: [
        { id: 'plan-4', state: 'draft', agent: 'claude-brk-904' },
        { id: 'plan-5', state: 'applied', agent: 'claude-brk-905' },
        { id: 'plan-6', state: 'waiting', agent: 'claude-brk-901' },
      ],
    });
    expect(out.map((o) => [o.agent, o.why])).toEqual([
      ['claude-brk-902', 'its task'],
      ['claude-brk-901', 'incident'],
      ['claude-brk-904', 'plan-4'],
    ]);
  });

  it('is nobody when nothing is claimed', () => {
    expect(agentsAtWork([], { env: {} })).toEqual([]);
  });
});
