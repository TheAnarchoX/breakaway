import { useEffect, useRef, useState } from 'preact/hooks';
import { Boxes, List, Maximize2, Network, Target, X, ZoomIn, ZoomOut } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { hashFor, repoName } from '../lib/store.js';
import { MAP_MAX, NODE, collapse, fitName, layoutTopology, planOverlay } from '../lib/topology.js';
import { LEVEL } from '../lib/env-stream.js';
import { ZOOM_MAX, ZOOM_STEP, clampView, fitView, panView, viewBox, zoomOf, zoomView } from '../lib/pan-zoom.js';
import { amountText } from './InfraCosts.jsx';
import { planHref } from './EnvironmentPlans.jsx';
import { HEALTH } from '../views/InfrastructureView.jsx';

/**
 * An environment's topology (WEB-94; docs/specs/WEB-94-environment-console.md): its resources as a map, what's in front,
 * what runs, and what it holds, each node coloured by health with its cost, its drift, and what a waiting plan does to
 * it, and the same resources as a list, which a keyboard and a screen reader read in full. Selecting a node opens its
 * detail. The list keeps everything WEB-61's Resources section showed. On the console (WEB-97) the map fills the space
 * it's given, zooms and pans (the wheel where the page doesn't scroll, or with Ctrl; a drag; the buttons), and the
 * selected node's detail opens over it.
 */

/** How far a pointer moves before a press on the map is a drag, not a click, in pixels. */
const DRAG_PX = 4;

/** Space above the nodes for the columns' names. */
const LABEL_H = 26;

/** A plan's effect on a node, in words and a sign: the words carry it, the sign is for the eye. */
const EFFECT = {
  adds: { sign: '+', label: 'Plan adds' },
  changes: { sign: '~', label: 'Plan changes' },
  removes: { sign: '−', label: 'Plan removes' },
};

/** Drift's op, as what the plan to bring it back would do. */
const DRIFT_OP = {
  create: 'missing: the desired state adds it',
  update: 'differs from the repository',
  scale: 'scaled away from the repository',
  restart: 'differs from the repository',
  delete: 'runs, but the repository doesn’t declare it',
};

/** @param {{ iso: string | null | undefined }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

const healthOf = (/** @type {any} */ r) => (HEALTH[r?.health?.state] ? r.health.state : 'unknown');

/**
 * The resources grouped by kind with the target's kind first, and for each what it uses and what uses it.
 * @param {any[]} resources
 * @param {{ from: string, to: string, kind: string }[]} relations
 * @param {string | null} target the environment's target: its ID or name
 */
export function resourceGroups(resources, relations, target = null) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const name = (/** @type {string} */ id) => byId.get(id)?.name ?? id;
  const groups = new Map();
  for (const r of [...resources].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    const uses = relations
      .filter((rel) => rel.from === r.id)
      .map((rel) => ({ id: rel.to, name: name(rel.to), kind: rel.kind }));
    const usedBy = relations
      .filter((rel) => rel.to === r.id)
      .map((rel) => ({ id: rel.from, name: name(rel.from), kind: rel.kind }));
    groups.set(r.kind, [...(groups.get(r.kind) ?? []), { ...r, uses, usedBy }]);
  }
  const first = resources.find((r) => target && (r.id === target || r.name === target))?.kind;
  return [...groups]
    .sort(([a], [b]) => Number(b === first) - Number(a === first))
    .map(([kind, items]) => ({ kind, items }));
}

/** @param {{ label: string, links: { id: string, name: string, kind: string }[], onPick: (id: string) => void }} props */
function Relations({ label, links, onPick }) {
  if (!links.length) return null;
  return (
    <div class="infra-rel">
      <dt>{label}</dt>
      <dd>
        <ul class="infra-rel-list">
          {links.map((l) => (
            <li key={`${l.id} ${l.kind}`}>
              <button type="button" class="infra-rel-link" onClick={() => onPick(l.id)}>
                {l.name}
              </button>
              <span class="meta"> {l.kind}</span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

/** A resource's settings, as names and short values: the inventory keeps settings, never secrets' values. */
function Settings({ attrs }) {
  const entries = Object.entries(attrs ?? {});
  if (!entries.length) return null;
  return (
    <details class="infra-settings">
      <summary>
        Settings <span class="count">{entries.length}</span>
      </summary>
      <dl>
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>
              <code>{k}</code>
            </dt>
            <dd>
              <code>{typeof v === 'string' ? v : JSON.stringify(v)}</code>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** @param {{ state: string }} props */
function HealthPill({ state }) {
  const { label, Icon } = HEALTH[state] ?? HEALTH.unknown;
  return (
    <span class={`infra-health infra-health-${state}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * What the console knows about a resource besides the inventory: its drift, what the waiting plan does to it.
 * @param {{ r: any, drift: Map<string, string>, ops: Map<string, { op: string, effect: string }>, plan: any, mine?: boolean }} props
 */
function Marks({ r, drift, ops, plan, mine = false }) {
  const d = drift.get(r.id);
  const o = ops.get(r.id);
  if (!d && !o && !(r.cost?.amount > 0)) return null;
  return (
    <ul class="topo-marks">
      {r.cost?.amount > 0 && (
        <li class="topo-mark">
          {amountText(r.cost.amount, r.cost.currency)} a month, estimated
          {r.group ? ' together' : ''}
        </li>
      )}
      {d && <li class="topo-mark topo-mark-drift">Drift: {DRIFT_OP[d] ?? d}</li>}
      {o && mine && (
        <li class={`topo-mark topo-mark-${o.effect}`}>
          Your change {o.effect === 'adds' ? 'adds it' : o.effect === 'removes' ? 'removes it' : 'changes it'}
        </li>
      )}
      {o && plan && !mine && (
        <li class={`topo-mark topo-mark-${o.effect}`}>
          <a href={planHref(plan)}>{plan.id}</a>{' '}
          {o.effect === 'adds' ? 'adds it' : o.effect === 'removes' ? 'removes it' : `${o.op}s it`}
          {plan.state === 'waiting' ? ', waiting for you' : ''}
        </li>
      )}
    </ul>
  );
}

/**
 * One resource, as a card: the list view's row and the map's detail.
 * @param {{ r: any, env: any, drift: Map<string, string>, ops: Map<string, any>, plan: any, onPick: (id: string) => void, signals?: any[], headingLevel?: 'h3' | 'h4', headingId?: string, mine?: boolean }} props
 */
function Resource({ r, env, drift, ops, plan, onPick, signals, headingLevel = 'h4', headingId, mine = false }) {
  const isTarget = env.target && (r.id === env.target || r.name === env.target);
  const state = healthOf(r);
  const task = r.owner?.task;
  const H = headingLevel;
  return (
    <>
      <div class="infra-res-head">
        <H class="infra-res-name" id={headingId}>
          {r.name}
        </H>
        {isTarget && (
          <span class="infra-res-target">
            <Target size={13} aria-hidden="true" />
            Target
          </span>
        )}
        {r.planned ? (
          <span class="infra-health infra-health-unknown">Not running yet</span>
        ) : (
          <HealthPill state={state} />
        )}
      </div>
      {r.health?.text && <p class="infra-res-text">{r.health.text}</p>}
      <p class="meta infra-res-id">
        <code>{r.id}</code>
        {' · '}
        {r.kind}
        {r.owner && (
          <>
            {' · '}
            {repoName(r.owner.repo)}
          </>
        )}
        {task && (
          <>
            {' · for '}
            <a href={hashFor({ task: task.wid ?? task.uuid })}>{task.wid ?? task.description}</a>
          </>
        )}
        {(r.health?.at || r.seen) && (r.health?.at ? ' · checked ' : ' · seen ')}
        <When iso={r.health?.at ?? r.seen} />
      </p>
      <Marks r={r} drift={drift} ops={ops} plan={plan} mine={mine} />
      {(r.uses?.length > 0 || r.usedBy?.length > 0) && (
        <dl class="infra-rels">
          <Relations label="Uses" links={r.uses} onPick={onPick} />
          <Relations label="Used by" links={r.usedBy} onPick={onPick} />
        </dl>
      )}
      <Settings attrs={r.attrs} />
      {signals && signals.length > 0 && (
        <div class="topo-signals">
          <h5 class="kicker">Recent signals</h5>
          <ul>
            {signals.map((s) => (
              <li key={s.id} class={`topo-signal topo-signal-${s.level}`}>
                <span class="topo-signal-level">{LEVEL[s.level] ?? s.level}</span> {s.text}{' '}
                <span class="meta">
                  <When iso={s.at} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The map: plain SVG, three columns, a line per relation, filling its box. Each node is a button; the list view says
 * the same in text.
 * @param {{ map: ReturnType<typeof layoutTopology>, selected: string | null, onSelect: (id: string | null) => void, drift: Map<string, string>, ops: Map<string, any>, mine?: boolean }} props
 *   `mine`: the marks are the owner's change, not a plan's.
 */
function TopologyMap({ map, selected, onSelect, drift, ops, mine = false }) {
  const wrap = useRef(/** @type {HTMLDivElement | null} */ (null));
  const svg = useRef(/** @type {SVGSVGElement | null} */ (null));
  const drag = useRef(/** @type {{ x: number, y: number, moved: boolean } | null} */ (null));
  const dragged = useRef(false);
  const [box, setBox] = useState(/** @type {{ w: number, h: number } | null} */ (null));
  const [view, setView] = useState(/** @type {import('../lib/pan-zoom.js').View | null} */ (null));
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox(width > 0 && height > 0 ? { w: width, h: height } : null);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const near = new Set(
    selected
      ? map.edges.flatMap((e) => (e.from === selected || e.to === selected ? [e.from, e.to] : [])).concat(selected)
      : [],
  );
  const height = map.height + LABEL_H;
  const fit = fitView({ x: 0, y: 0, w: map.width, h: height }, box);
  const v = view ? clampView(view, fit) : fit;
  const zoom = zoomOf(v, fit);
  /** A pointer's place in the map's units: the view has the box's shape, so it maps straight across. */
  const at = (/** @type {{ clientX: number, clientY: number }} */ e) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r?.width) return null;
    return { x: v.x + ((e.clientX - r.left) / r.width) * v.w, y: v.y + ((e.clientY - r.top) / r.height) * v.h };
  };
  const zoomBy = (/** @type {number} */ factor, /** @type {{ x: number, y: number } | null} */ p = null) =>
    setView((cur) => zoomView(cur ? clampView(cur, fit) : fit, factor, p, fit));
  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    // The wheel zooms where the page doesn't scroll (the console on a wide screen); elsewhere only with Ctrl, so the
    // page still scrolls past the map.
    const page = document.scrollingElement;
    const scrolls = page ? page.scrollHeight > page.clientHeight + 1 : false;
    if (scrolls && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(ZOOM_STEP ** (-Math.sign(e.deltaY) * Math.min(2, Math.abs(e.deltaY) / 60 || 1)), at(e));
  };
  /** @param {PointerEvent} e */
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  /** @param {PointerEvent} e */
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      d.moved = true;
      svg.current?.setPointerCapture(e.pointerId);
    }
    const r = svg.current?.getBoundingClientRect();
    const k = r?.width ? v.w / r.width : 1;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((cur) => panView(cur ? clampView(cur, fit) : fit, dx * k, dy * k, fit));
  };
  /** @param {PointerEvent} e */
  const onPointerUp = (e) => {
    const moved = Boolean(drag.current?.moved);
    dragged.current = moved;
    // A press on the map's ground, not a drag, puts the detail away.
    if (drag.current && !moved && /** @type {Element} */ (e.target).classList?.contains('topo-ground')) onSelect(null);
    drag.current = null;
  };
  return (
    <>
      <div
        class={`topo-map-wrap ${zoom > 1.001 ? 'is-zoomed' : ''}`}
        ref={wrap}
        style={{ '--map-ratio': `${map.width} / ${height}` }}
      >
        <svg
          ref={svg}
          class={`topo-map ${selected ? 'has-selection' : ''}`}
          viewBox={viewBox(v)}
          role="group"
          aria-label={`Map of ${map.nodes.length} ${map.nodes.length === 1 ? 'resource' : 'resources'}: select one for its detail`}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClickCapture={(e) => {
            // A drag ends with a click on whatever it ended over: that one doesn't select anything.
            if (!dragged.current) return;
            dragged.current = false;
            e.stopPropagation();
          }}
        >
          <defs>
            <pattern id="topo-dots" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" class="topo-dot" />
            </pattern>
          </defs>
          <rect x={fit.x} y={fit.y} width={fit.w} height={fit.h} fill="url(#topo-dots)" class="topo-ground" />
          <g>
            {map.columns.map((c) => (
              <text key={c.id} x={c.x} y={16} class="topo-col-label">
                {c.label}
              </text>
            ))}
          </g>
          <g transform={`translate(0 ${LABEL_H})`}>
            <g>
              {map.edges.map((e) => {
                const on = selected && (e.from === selected || e.to === selected);
                return (
                  <path
                    key={`${e.from} ${e.to} ${e.kind}`}
                    d={e.path}
                    class={`topo-edge topo-edge-${e.kind} ${on ? 'is-on' : selected ? 'is-dim' : ''}`}
                  />
                );
              })}
            </g>
            {map.nodes.map((n) => {
              const state = n.planned ? 'planned' : healthOf(n);
              const o = ops.get(n.id);
              const d = drift.get(n.id);
              const cost = n.cost?.amount > 0 ? amountText(n.cost.amount, n.cost.currency) : '';
              const mark = o ? `${EFFECT[o.effect].sign} ${o.effect}` : d ? 'drift' : '';
              const words = [
                n.name,
                n.group ? `${n.group.members.length} ${n.kind}` : n.kind,
                n.planned ? 'not running yet' : HEALTH[state]?.label.toLowerCase(),
                n.target ? 'the target' : '',
                cost ? `${cost} a month, estimated` : '',
                o ? (mine ? `your change ${o.effect} it` : EFFECT[o.effect].label.toLowerCase()) : '',
                d ? 'drift' : '',
              ].filter(Boolean);
              const pick = () => onSelect(selected === n.id ? null : n.id);
              return (
                // biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>; it takes the role instead.
                <g
                  key={n.id}
                  class={`topo-node topo-health-${state} ${o ? `topo-plan-${o.effect}` : ''} ${d ? 'has-drift' : ''} ${n.target ? 'is-target' : ''} ${selected === n.id ? 'is-selected' : ''} ${selected && !near.has(n.id) ? 'is-dim' : ''}`}
                  transform={`translate(${n.x} ${n.y})`}
                  role="button"
                  // Lowercase: SVG keeps an attribute’s case, and only `tabindex` makes it focusable.
                  tabindex={0}
                  aria-pressed={selected === n.id}
                  aria-label={words.join(', ')}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pick();
                    } else if (e.key === 'Escape') onSelect(null);
                  }}
                >
                  <title>{words.join(', ')}</title>
                  <rect class="topo-node-box" width={NODE.w} height={NODE.h} rx="6" />
                  <rect class="topo-node-bar" width="4" height={NODE.h - 12} x="6" y="6" rx="2" />
                  <text x="18" y="20" class="topo-node-name">
                    {fitName(n.name, cost ? 14 : 19)}
                  </text>
                  <text x="18" y="37" class="topo-node-sub">
                    {n.group ? `kind × ${n.group.members.length}` : fitName(n.kind, 12)}
                  </text>
                  {cost && (
                    <text x={NODE.w - 8} y="20" class="topo-node-cost" text-anchor="end">
                      {cost}
                    </text>
                  )}
                  {mark && (
                    <text
                      x={NODE.w - 8}
                      y="37"
                      class={`topo-node-mark ${o ? `is-${o.effect}` : 'is-drift'}`}
                      text-anchor="end"
                    >
                      {mark}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div class="topo-zoom" role="group" aria-label="Zoom the map">
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX - 0.001}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>
        <span class="topo-zoom-level" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={zoom <= 1.001}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <ZoomOut size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          onClick={() => setView(null)}
          disabled={zoom <= 1.001}
          aria-label="Fit the map"
          title="Fit the map"
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

/**
 * The topology panel: the map (wide) or the list (phones, and anyone who picks it), and the selected node's detail.
 * @param {{ env: any, resources: any[], relations: any[], plan: any, drift: any, signals: any[], mode: 'map' | 'list', onMode: (m: 'map' | 'list') => void, nodeActions?: (r: any) => any, change?: { ops: Map<string, any>, adds: any[], relations?: any[] } | null, headActions?: any, note?: string | null, lead?: any }} props
 *   `nodeActions` renders the owner's actions for a resource in its detail and its row in the list (WEB-99's Change
 *   and Remove); `change` is the owner's change (WEB-99), whose marks show instead of a plan's while they edit, labelled
 *   "your change", with lines from each add to what binds it (WEB-107); `headActions` sit in the panel's header (Add
 *   resource), and are the call to action when nothing runs yet; `note` is a line under it; `lead` is a line above
 *   the map (the last change, folded, WEB-110).
 */
export function Topology({
  env,
  resources,
  relations,
  plan,
  drift,
  signals,
  mode,
  onMode,
  nodeActions,
  change = null,
  headActions = null,
  note = null,
  lead = null,
}) {
  const [selected, setSelected] = useState(/** @type {string | null} */ (null));
  // Escape puts a node's detail away, wherever focus is, unless a dialog is open over the page.
  useEffect(() => {
    if (!selected) return;
    const close = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) setSelected(null);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [selected]);
  const mine = Boolean(change);
  const { ops, adds } = change ?? planOverlay(plan?.diff);
  const driftOf = new Map((drift?.resources ?? []).map((/** @type {any} */ d) => [d.id, d.op]));
  const running = new Set(resources.map((r) => r.id));
  const planned = adds.filter((a) => !running.has(a.id));
  const nodes = new Set([...running, ...planned.map((a) => a.id)]);
  const lines = [...relations, ...(change?.relations ?? []).filter((r) => nodes.has(r.from) && nodes.has(r.to))];
  const shown = collapse([...resources, ...planned], lines, MAP_MAX);
  const map = layoutTopology(shown.resources, shown.relations, { target: env.target });
  const all = resourceGroups([...resources, ...planned], lines, env.target);
  const byId = new Map(all.flatMap((g) => g.items).map((r) => [r.id, r]));
  const group = shown.resources.find((r) => r.id === selected && r.group);
  const current = selected ? (byId.get(selected) ?? group ?? null) : null;
  const pick = (/** @type {string} */ id) => {
    setSelected(id);
    if (mode === 'list') {
      const el = document.getElementById(`infra-res-${id}`);
      if (!el) return;
      const reduce =
        document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    }
  };
  const count = resources.length;
  // Something your change adds draws the map even before anything runs.
  const drawn = count + planned.length;
  return (
    <section class="console-panel topo" aria-labelledby="infra-resources">
      <header class="console-panel-head">
        <h2 id="infra-resources">
          <Boxes size={16} aria-hidden="true" />
          Resources {count > 0 && <span class="count">{count}</span>}
        </h2>
        {headActions && drawn > 0 && <div class="topo-head-actions">{headActions}</div>}
        {drawn > 0 && (
          <div class="segmented segmented-xs" role="group" aria-label="Show resources as">
            <button type="button" aria-pressed={mode === 'map'} onClick={() => onMode('map')}>
              <Network size={14} aria-hidden="true" />
              Map
            </button>
            <button type="button" aria-pressed={mode === 'list'} onClick={() => onMode('list')}>
              <List size={14} aria-hidden="true" />
              List
            </button>
          </div>
        )}
      </header>
      {lead}
      {note && <p class="console-quiet">{note}</p>}
      {!drawn ? (
        <div class="console-quiet topo-empty">
          <p>
            {env.target ? (
              <>
                Nothing seen yet: connect its provider on{' '}
                <a href={hashFor({ view: 'connections', environment: null, task: null })}>Connections</a>, and the board
                looks at once and every 15 minutes after. Press Refresh above to look now.
              </>
            ) : (
              'No target yet: give it one, like a Worker’s name, and the board maps what it uses.'
            )}
            {headActions && ' Or start it here: add its first resource, and the board plans it for you to approve.'}
          </p>
          {headActions && <div class="topo-empty-actions">{headActions}</div>}
        </div>
      ) : mode === 'map' ? (
        <>
          <div class="topo-stage">
            <TopologyMap map={map} selected={selected} onSelect={setSelected} drift={driftOf} ops={ops} mine={mine} />
            {current && (
              <article class="topo-detail" aria-labelledby="topo-detail-name">
                <button
                  type="button"
                  class="btn btn-quiet btn-icon btn-sm topo-detail-close"
                  onClick={() => setSelected(null)}
                  aria-label="Close the detail"
                >
                  <X size={16} aria-hidden="true" />
                </button>
                {current.group ? (
                  <>
                    <h3 id="topo-detail-name" class="infra-res-name">
                      {current.name}
                    </h3>
                    <ul class="infra-rel-list">
                      {current.group.members.map((/** @type {string} */ m) => (
                        <li key={m}>
                          <button type="button" class="infra-rel-link" onClick={() => setSelected(m)}>
                            {byId.get(m)?.name ?? m}
                          </button>
                          <span class="meta"> {HEALTH[healthOf(byId.get(m))].label.toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <Resource
                    r={current}
                    env={env}
                    drift={driftOf}
                    ops={ops}
                    plan={plan}
                    onPick={setSelected}
                    signals={signals.filter((s) => s.resource === current.id).slice(0, 5)}
                    headingLevel="h3"
                    headingId="topo-detail-name"
                    mine={mine}
                  />
                )}
                {!current.group && nodeActions && <div class="topo-detail-actions">{nodeActions(current)}</div>}
              </article>
            )}
          </div>
          <p class="meta topo-legend">
            {shown.grouped && `Over ${MAP_MAX} resources, so each kind is one node; the list has every one. `}
            {mine && ops.size > 0 && (
              <>
                Your change:{' '}
                {[...new Set([...ops.values()].map((o) => o.effect))].map((e) => `${EFFECT[e].sign} ${e}`).join(', ')}.{' '}
              </>
            )}
            {plan && !mine && ops.size > 0 && (
              <>
                <a href={planHref(plan)}>{plan.id}</a>
                {plan.state === 'waiting' ? ' waits for you: ' : ' is applying: '}
                {[...new Set([...ops.values()].map((o) => o.effect))].map((e) => `${EFFECT[e].sign} ${e}`).join(', ')}.{' '}
              </>
            )}
            Select a node for its detail.
          </p>
        </>
      ) : (
        all.map((g) => (
          <section key={g.kind} class="infra-kind-group" aria-labelledby={`infra-kind-${g.kind}`}>
            <h3 id={`infra-kind-${g.kind}`}>
              {g.kind} <span class="count">{g.items.length}</span>
            </h3>
            <ul class="infra-res-list">
              {g.items.map((r) => (
                <li
                  key={r.id}
                  class={`infra-res ${selected === r.id ? 'is-selected' : ''} ${r.planned ? 'is-planned' : ''}`}
                  id={`infra-res-${r.id}`}
                  tabIndex={-1}
                >
                  <Resource r={r} env={env} drift={driftOf} ops={ops} plan={plan} onPick={pick} mine={mine} />
                  {nodeActions && <div class="topo-detail-actions">{nodeActions(r)}</div>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
