// An environment's topology (WEB-94; docs/specs/WEB-94-environment-console.md): the inventory's resources and relations
// laid out as three columns, what's in front (routes, domains), what runs (Workers, services), and what they hold
// (databases, stores, queues), with a waiting plan's changes on the same nodes. Pure, so the tests can check it.

/** The most resources the map draws one by one; beyond it, each kind with more than one becomes one node. */
export const MAP_MAX = 60;

/** A node's size and the gaps between them, in the map's own units (the SVG scales to its box). */
export const NODE = { w: 172, h: 48, gapY: 14, gapX: 92, pad: 16 };

/** Kinds that sit in front when no relation says so: what people's requests reach first. */
const FRONT_KINDS = new Set(['route', 'custom-domain', 'domain']);

/** Worst first, like the environment's health: one resource that couldn't be read doesn't outrank healthy ones. */
const WORST = ['down', 'degraded', 'healthy', 'idle', 'unknown'];

/** The map's columns, left to right, with their names. */
export const COLUMNS = [
  { id: 'front', label: 'In front' },
  { id: 'runs', label: 'Runs' },
  { id: 'holds', label: 'Holds' },
];

/**
 * Which column each resource goes in: in front if something serves it (or its kind sits in front), runs if it uses,
 * serves, or feeds anything, and holds otherwise. Providers relate a Worker to what it serves (`serves`), uses, and
 * produces for or consumes from (src/infra-cloudflare.js); the fake provider's service the same way.
 * @param {{ id: string, kind: string }[]} resources
 * @param {{ from: string, to: string, kind: string }[]} relations
 * @returns {Map<string, number>}
 */
export function columnsOf(resources, relations) {
  const served = new Set(relations.filter((r) => r.kind === 'serves').map((r) => r.to));
  const acts = new Set(relations.map((r) => r.from));
  const col = new Map();
  for (const r of resources) {
    if (served.has(r.id) || (FRONT_KINDS.has(r.kind) && !acts.has(r.id))) col.set(r.id, 0);
    else if (acts.has(r.id)) col.set(r.id, 1);
    else col.set(r.id, 2);
  }
  return col;
}

/**
 * The worst health of a set of resources' states.
 * @param {(string | null | undefined)[]} states
 */
export const worstHealth = (states) => WORST.find((s) => states.some((x) => (x ?? 'unknown') === s)) ?? 'unknown';

/**
 * Collapses kinds into one node each when there are more resources than the map draws: a group node carries its
 * count, its worst health, and its members' summed cost. Relations move to the groups and repeat only once.
 * @param {any[]} resources
 * @param {{ from: string, to: string, kind: string }[]} relations
 * @param {number} [max]
 */
export function collapse(resources, relations, max = MAP_MAX) {
  if (resources.length <= max) return { resources, relations, grouped: false };
  const count = new Map();
  for (const r of resources) count.set(r.kind, (count.get(r.kind) ?? 0) + 1);
  const groupOf = (/** @type {any} */ r) => (count.get(r.kind) > 1 ? `kind:${r.kind}` : r.id);
  const byId = new Map(resources.map((r) => [r.id, r]));
  /** @type {Map<string, any>} */
  const nodes = new Map();
  for (const r of resources) {
    const id = groupOf(r);
    if (id === r.id) {
      nodes.set(id, r);
      continue;
    }
    const g = nodes.get(id) ?? {
      id,
      kind: r.kind,
      name: `${count.get(r.kind)} ${r.kind}`,
      group: { kind: r.kind, members: [] },
      health: null,
      cost: null,
    };
    g.group.members.push(r.id);
    const states = g.group.members.map((m) => byId.get(m)?.health?.state);
    g.health = { state: worstHealth(states) };
    if (r.cost && typeof r.cost.amount === 'number')
      g.cost = { amount: (g.cost?.amount ?? 0) + r.cost.amount, currency: r.cost.currency };
    nodes.set(id, g);
  }
  const seen = new Set();
  const rels = [];
  for (const rel of relations) {
    const from = byId.get(rel.from);
    const to = byId.get(rel.to);
    if (!from || !to) continue;
    const moved = { from: groupOf(from), to: groupOf(to), kind: rel.kind };
    const key = `${moved.from} ${moved.to} ${moved.kind}`;
    if (moved.from === moved.to || seen.has(key)) continue;
    seen.add(key);
    rels.push(moved);
  }
  return { resources: [...nodes.values()], relations: rels, grouped: true };
}

/**
 * A plan's changes by resource: what it adds, changes, or removes, and the resources it adds that don't run yet.
 * @param {{ changes: { op: string, resource: string, kind: string, name: string }[] } | null | undefined} diff
 */
export function planOverlay(diff) {
  /** @type {Map<string, { op: string, effect: 'adds' | 'changes' | 'removes' }>} */
  const ops = new Map();
  for (const c of diff?.changes ?? [])
    ops.set(c.resource, { op: c.op, effect: c.op === 'create' ? 'adds' : c.op === 'delete' ? 'removes' : 'changes' });
  const adds = (diff?.changes ?? [])
    .filter((c) => c.op === 'create')
    .map((c) => ({ id: c.resource, kind: c.kind, name: c.name, health: null, cost: null, planned: true }));
  return { ops, adds };
}

/**
 * Lays the map out: each column's nodes top to bottom, the target first in its column, then each node beside the
 * nodes it's related to (the average row of its neighbours, so lines cross less), then by name. Empty columns close up.
 * @param {any[]} resources what runs, plus any a plan adds (`planned: true`)
 * @param {{ from: string, to: string, kind: string }[]} relations
 * @param {{ target?: string | null }} [options]
 */
export function layoutTopology(resources, relations, { target = null } = {}) {
  const col = columnsOf(resources, relations);
  const isTarget = (/** @type {any} */ r) => Boolean(target) && (r.id === target || r.name === target);
  const byName = (/** @type {any} */ a, /** @type {any} */ b) =>
    Number(isTarget(b)) - Number(isTarget(a)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  /** @type {any[][]} */
  const cols = [[], [], []];
  for (const r of resources) cols[col.get(r.id) ?? 2].push(r);
  cols[1].sort(byName);
  const row = new Map(cols[1].map((r, i) => [r.id, i]));
  const neighbours = (/** @type {string} */ id) =>
    relations.flatMap((rel) => (rel.from === id ? [rel.to] : rel.to === id ? [rel.from] : []));
  const centre = (/** @type {any} */ r) => {
    const rows = neighbours(r.id)
      .map((n) => row.get(n))
      .filter((n) => n !== undefined);
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
  };
  for (const c of [0, 2]) {
    const at = new Map(cols[c].map((r) => [r.id, centre(r)]));
    cols[c].sort((a, b) => at.get(a.id) - at.get(b.id) || byName(a, b));
  }
  const used = cols.map((c, i) => ({ c, i })).filter(({ c }) => c.length);
  const tallest = Math.max(1, ...cols.map((c) => c.length));
  const height = NODE.pad * 2 + tallest * NODE.h + (tallest - 1) * NODE.gapY;
  const width = NODE.pad * 2 + Math.max(1, used.length) * NODE.w + Math.max(0, used.length - 1) * NODE.gapX;
  /** @type {Map<string, any>} */
  const nodes = new Map();
  used.forEach(({ c, i }, slot) => {
    const x = NODE.pad + slot * (NODE.w + NODE.gapX);
    const block = c.length * NODE.h + (c.length - 1) * NODE.gapY;
    const top = (height - block) / 2;
    c.forEach((r, j) => {
      nodes.set(r.id, { ...r, x, y: top + j * (NODE.h + NODE.gapY), column: i, target: isTarget(r) });
    });
  });
  const edges = relations.flatMap((rel) => {
    const a = nodes.get(rel.from);
    const b = nodes.get(rel.to);
    if (!a || !b) return [];
    // Lines run left to right, whichever way the relation points.
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    const x1 = l.x + NODE.w;
    const y1 = l.y + NODE.h / 2;
    const x2 = l.x === r.x ? r.x + NODE.w : r.x;
    const y2 = r.y + NODE.h / 2;
    const bend = l.x === r.x ? 40 : (x2 - x1) / 2;
    const path =
      l.x === r.x
        ? `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 + bend} ${y2} ${x2} ${y2}`
        : `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
    return [{ from: rel.from, to: rel.to, kind: rel.kind, path }];
  });
  return {
    nodes: [...nodes.values()],
    edges,
    width,
    height,
    columns: used.map(({ i }, slot) => ({ ...COLUMNS[i], x: NODE.pad + slot * (NODE.w + NODE.gapX) })),
  };
}

/**
 * A name cut to fit a node, with an ellipsis: SVG text doesn't wrap or clip by itself.
 * @param {string} name
 * @param {number} [max]
 */
export const fitName = (name, max = 20) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);
