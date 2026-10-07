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
import {
  STREAM_MAX,
  agentsAtWork,
  arrived,
  filterStream,
  groupStream,
  runWords,
  stepsText,
  streamItems,
} from '../web/src/lib/env-stream.js';
import { clampView, fitView, panView, viewBox, zoomOf, zoomView } from '../web/src/lib/pan-zoom.js';

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
    // One resource that couldn't be read doesn't outrank healthy ones (BRK-266); idle ranks with healthy.
    expect(worstHealth(['healthy', null])).toBe('healthy');
    expect(worstHealth(['idle', 'unknown'])).toBe('idle');
    expect(worstHealth([null])).toBe('unknown');
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

describe('the stream, folded and filtered (WEB-97)', () => {
  const alert = (/** @type {number} */ id, /** @type {number} */ minutes, extra = {}) => ({
    id,
    at: ago(minutes),
    source: 'cloudflare',
    kind: 'alert',
    level: 'warning',
    resource: null,
    text: 'Cloudflare alert: acme incidents (major+)',
    ...extra,
  });

  it('folds an alert that repeats into its newest row, with a count and when the first came', () => {
    const items = groupStream(
      streamItems({
        signals: [
          alert(1, 600),
          alert(2, 300),
          alert(3, 10),
          alert(4, 20, { text: 'Cloudflare alert: acme-api errors' }),
        ],
        audit: [{ id: 9, at: ago(15), kind: 'freeze', by: 'owner', outcome: 'on', summary: 'Frozen' }],
      }),
    );
    expect(items.map((i) => [i.key, i.count ?? null])).toEqual([
      ['signal:3', 3],
      ['audit:9', null],
      ['signal:4', 1],
    ]);
    expect(items[0].firstAt).toBe(Date.parse(ago(600)));
  });

  it('keeps alerts apart when their level or resource differs', () => {
    const items = groupStream(
      streamItems({
        signals: [alert(1, 5), alert(2, 6, { level: 'critical' }), alert(3, 7, { resource: 'worker:acme-api' })],
      }),
    );
    expect(items).toHaveLength(3);
  });

  it('filters by kind and by level', () => {
    const items = streamItems({
      signals: [alert(1, 5), alert(2, 6, { level: 'info', kind: 'health' }), alert(3, 7, { source: 'deploy' })],
      audit: [
        { id: 10, at: ago(8), kind: 'plan', by: 'board', plan: 'plan-1', outcome: 'waiting', summary: 'Plan made' },
        { id: 11, at: ago(9), kind: 'environment', by: 'agent', agent: 'claude-acme-1', summary: 'Adopted' },
        { id: 12, at: ago(10), kind: 'apply', by: 'owner', outcome: 'ok', summary: 'Deploy of acme 1.2.0' },
      ],
      runs: [{ plan: 'plan-1', phase: 'applying', created: ago(4) }],
      incidents: [{ id: 3, opened: ago(3), level: 'critical', kind: 'down', signals: 2 }],
    });
    const keys = (/** @type {any} */ f) => filterStream(items, f).map((i) => i.key);
    expect(keys({ kind: 'alert' })).toEqual(['incident:3', 'signal:1', 'signal:2']);
    expect(keys({ kind: 'deploy' })).toEqual(['signal:3', 'audit:12']);
    expect(keys({ kind: 'plan' })).toEqual(['run:plan-1', 'audit:10']);
    expect(keys({ kind: 'agent' })).toEqual(['audit:11']);
    expect(keys({ level: 'warning' })).toEqual(['incident:3', 'signal:1', 'signal:3']);
    expect(keys({ kind: 'alert', level: 'critical' })).toEqual(['incident:3']);
    expect(filterStream(items, {})).toHaveLength(items.length);
  });
});

describe('pan and zoom (WEB-97)', () => {
  const bounds = { x: 0, y: 0, w: 400, h: 200 };
  const box = { w: 800, h: 800 };

  it('fits the drawing to the box’s shape, centred, and no larger than the cap', () => {
    const fit = fitView(bounds, box);
    expect(fit.w / fit.h).toBeCloseTo(1);
    expect(fit.w).toBeCloseTo(800 / 1.4);
    expect(fit.x + fit.w / 2).toBeCloseTo(200);
    expect(fit.y + fit.h / 2).toBeCloseTo(100);
    expect(fitView(bounds, { w: 400, h: 400 })).toEqual({ x: 0, y: -100, w: 400, h: 400 });
    expect(fitView(bounds, null)).toEqual(bounds);
  });

  it('zooms about a point that stays put, between fitting and the most', () => {
    const fit = fitView(bounds, { w: 400, h: 400 });
    const at = { x: 100, y: 50 };
    const z = zoomView(fit, 2, at, fit);
    expect(zoomOf(z, fit)).toBeCloseTo(2);
    // The point sits the same share of the way across before and after.
    expect((at.x - z.x) / z.w).toBeCloseTo((at.x - fit.x) / fit.w);
    expect(zoomOf(zoomView(z, 100, at, fit), fit)).toBeCloseTo(4);
    expect(zoomView(z, 0.01, at, fit)).toEqual(fit);
  });

  it('pans with the pointer and stops at the edge', () => {
    const fit = fitView(bounds, { w: 400, h: 400 });
    const z = zoomView(fit, 2, null, fit);
    const moved = panView(z, 20, 0, fit);
    expect(moved.x).toBeCloseTo(z.x - 20);
    expect(panView(z, 10_000, 10_000, fit)).toMatchObject({ x: fit.x, y: fit.y });
    expect(panView(fit, 50, 50, fit)).toEqual(fit);
    expect(clampView({ x: -999, y: -999, w: 9999, h: 1 }, fit)).toEqual(fit);
    expect(viewBox({ x: 1, y: 2, w: 3, h: 4 })).toBe('1 2 3 4');
  });
});
