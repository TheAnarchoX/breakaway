import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FastForward, Hand, Layers, Milestone } from 'lucide-preact';
import { plural, rank, ref, stateOf } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { byUuid, features, filters, graphShowDone, hashFor, loadFeatures, navOrder, visible } from '../lib/store.js';
import { criticalPath, foldDone, isFold, isPass, layered, orderSteps } from '../lib/graph-layout.js';
import { TaskCard } from '../components/TaskCard.jsx';
import { EmptyBoard } from '../components/EmptyBoard.jsx';
import { Dialog } from '../components/ui.jsx';
import { ChasePanel } from '../components/Chase.jsx';
import { FeatureForm } from '../components/FeatureForm.jsx';
import { Title } from '../lib/richtext.jsx';

/**
 * Chains of tasks that wait for each other, each laid out left to right: a task sits one
 * column to the right of everything it waits for. Finished tasks that something still points
 * to are shown faded, for context, or folded into one card a step (layoutChain).
 */
function buildChains(list, all) {
  const nodes = new Map();
  for (const t of list) {
    if (t.status !== 'pending') continue;
    if (t.depends.length || t.blocking.length) nodes.set(t.uuid, t);
  }
  for (const t of [...nodes.values()]) {
    for (const d of [...t.depends, ...t.blocking]) {
      const other = all.get(d);
      if (other && other.status !== 'deleted') nodes.set(d, other);
    }
  }
  const edges = [];
  for (const t of nodes.values()) for (const d of t.depends) if (nodes.has(d)) edges.push([d, t.uuid]);

  // Connected groups, so separate chains don't tangle.
  const neighbours = new Map([...nodes.keys()].map((u) => [u, []]));
  for (const [a, b] of edges) {
    neighbours.get(a).push(b);
    neighbours.get(b).push(a);
  }
  const seen = new Set();
  const chains = [];
  for (const start of nodes.keys()) {
    if (seen.has(start)) continue;
    const members = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop();
      members.push(u);
      for (const v of neighbours.get(u))
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
    }
    const level = new Map();
    const depth = (u, trail = new Set()) => {
      if (level.has(u)) return level.get(u);
      if (trail.has(u)) return 0; // a cycle: Taskwarrior allows it, so don't loop forever
      trail.add(u);
      const deps = nodes.get(u).depends.filter((d) => nodes.has(d));
      const value = deps.length ? Math.max(...deps.map((d) => depth(d, trail) + 1)) : 0;
      level.set(u, value);
      return value;
    };
    members.forEach((u) => depth(u));
    const columns = [];
    for (const u of members) (columns[level.get(u)] ??= []).push(nodes.get(u));
    columns.forEach((c) => c.sort(rank));
    chains.push({
      id: start,
      columns: columns.filter(Boolean),
      edges: edges.filter(([a]) => members.includes(a)),
      size: members.length,
    });
  }
  chains.sort((a, b) => b.size - a.size || rank(a.columns[0][0], b.columns[0][0]));
  return chains;
}

/** Whether the owner holds a task's next step: a step for them (+owner) or a decision they haven't answered. */
const forOwner = (t) =>
  t.tags.includes('owner') || t.tags.includes('decide') || Boolean(t.decision && !t.decisionAnswers);

/**
 * How a chain is drawn (WEB-98): finished work folded into one card a step unless `showDone` or the step is
 * unfolded, the steps ordered to cross fewer arrows with a gap where a long arrow passes, and the path to its last
 * task.
 */
function layoutChain(chain, { showDone, unfold }) {
  const tasks = new Map(chain.columns.flat().map((t) => [t.uuid, t]));
  const done = (id) => tasks.get(id)?.status === 'completed';
  const steps = chain.columns.map((c) => c.map((t) => t.uuid));
  const folded = showDone
    ? { steps, edges: chain.edges, folded: new Map() }
    : foldDone(steps, chain.edges, { done, unfold });
  const { steps: withGaps, links, routes } = layered(folded.steps, folded.edges);
  const ordered = orderSteps(withGaps, links);
  const path = criticalPath(
    chain.columns.flat().map((t) => t.uuid),
    folded.edges,
    (id) => tasks.get(id)?.status === 'pending',
  );
  return { tasks, steps: ordered, edges: folded.edges, folded: folded.folded, routes, path };
}

/** The tasks of a laid-out chain in the order they read: step by step, top to bottom. */
const readingOrder = (layout) => layout.steps.flat().filter((id) => layout.tasks.has(id));

/** @param {Record<string, any>} props */
function Chain({ chain, layout, unfolded, onFold }) {
  const box = useRef(null);
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => {
      const origin = el.getBoundingClientRect();
      // Size the arrow layer to the cards, never to the scroll area: the layer is part of that
      // area, so measuring it would keep a stale, wider size (and a scrollbar) alive.
      let right = 0;
      let bottom = 0;
      for (const node of el.querySelectorAll('[data-node]')) {
        const r = node.getBoundingClientRect();
        right = Math.max(right, r.right - origin.left + el.scrollLeft);
        bottom = Math.max(bottom, r.bottom - origin.top);
      }
      setSize({ w: Math.ceil(right), h: Math.ceil(bottom) });
      const at = (id) => el.querySelector(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      const x = (px) => px - origin.left + el.scrollLeft;
      const y = (r) => r.top + r.height / 2 - origin.top;
      // A short straight run out of a card and a longer one into the next, so fanned-out arrows still arrive
      // level and each arrowhead points into its card, not up or down.
      const bend = (x1, y1, x2, y2) => {
        const bendStart = x1 + 10;
        const bendEnd = x2 - 18;
        const dx = Math.max(12, (bendEnd - bendStart) / 2);
        return `H${bendStart} C${bendStart + dx},${y1} ${bendEnd - dx},${y2} ${bendEnd},${y2} H${x2}`;
      };
      setPaths(
        layout.edges
          .map(([from, to]) => {
            const a = at(from);
            const b = at(to);
            if (!a || !b) return null;
            // An arrow that skips a step runs through the gap kept for it there, between the cards.
            const gaps = (layout.routes.get(`${from}>${to}`) ?? []).map(at);
            if (gaps.some((g) => !g)) return null;
            let d = `M${x(a.right)},${y(a)}`;
            let last = { x: x(a.right), y: y(a) };
            for (const g of gaps) {
              d += ` ${bend(last.x, last.y, x(g.left), y(g))} H${x(g.right)}`;
              last = { x: x(g.right), y: y(g) };
            }
            d += ` ${bend(last.x, last.y, x(b.left) - 6, y(b))}`;
            return { from, to, d };
          })
          .filter(Boolean),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout]);

  // Everything a focused task waits for, and everything that waits for it.
  const related = new Set();
  if (focus) {
    const walk = (u, dir) => {
      for (const [a, b] of layout.edges) {
        const next = dir === 'up' ? (b === u ? a : null) : a === u ? b : null;
        if (next && !related.has(`${dir}${next}`)) {
          related.add(`${dir}${next}`);
          walk(next, dir);
        }
      }
    };
    walk(focus, 'up');
    walk(focus, 'down');
  }
  const lit = (u) => !focus || u === focus || related.has(`up${u}`) || related.has(`down${u}`);
  const onPath = new Set(layout.path);
  const pathEdge = new Set(layout.path.slice(1).map((id, i) => `${layout.path[i]}>${id}`));
  const finished = (id) => isFold(id) || layout.tasks.get(id)?.status === 'completed';

  return (
    <div class={`chain ${layout.path.length ? 'has-path' : ''}`} ref={box} onMouseLeave={() => setFocus(null)}>
      <svg class="chain-edges" aria-hidden="true" width={size.w} height={size.h}>
        <defs>
          <marker
            id={`arrow-${chain.id}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" class="arrow-head" />
          </marker>
        </defs>
        {paths.map((p) => {
          const kind = pathEdge.has(`${p.from}>${p.to}`) ? 'edge-path' : finished(p.from) ? 'edge-done' : 'edge-open';
          return (
            <path
              key={`${p.from}-${p.to}`}
              d={p.d}
              class={`edge ${kind} ${lit(p.from) && lit(p.to) ? '' : 'edge-dim'}`}
              marker-end={`url(#arrow-${chain.id})`}
            />
          );
        })}
      </svg>
      {layout.steps.map((ids, i) => (
        <ul key={i} class="chain-col" aria-label={i === 0 ? 'Starts with' : `Step ${i + 1}`}>
          {ids.map((id) => {
            if (isPass(id)) return <li key={id} class="node-pass" data-node={id} aria-hidden="true" />;
            if (isFold(id)) {
              const inside = layout.folded.get(id).map((u) => layout.tasks.get(u));
              return (
                <li key={id} data-node={id} class={`node node-done ${lit(id) ? '' : 'node-dim'}`}>
                  <button
                    type="button"
                    class="fold-card"
                    aria-expanded="false"
                    onClick={() => onFold(i, true)}
                    onMouseEnter={() => setFocus(id)}
                    onFocus={() => setFocus(id)}
                  >
                    <span class="fold-count">
                      <Layers size={15} aria-hidden="true" />
                      {inside.length} done
                    </span>
                    <span class="fold-ids">{inside.map(ref).join(', ')}</span>
                    <span class="fold-show">Show them</span>
                  </button>
                </li>
              );
            }
            const t = layout.tasks.get(id);
            const open = t.status === 'pending';
            const yours = open && forOwner(t);
            const state = [
              stateOf(t) === 'done' ? 'node-done' : '',
              onPath.has(id) ? 'node-path' : open && layout.path.length ? 'node-aside' : '',
              lit(id) ? '' : 'node-dim',
            ].join(' ');
            return (
              <li
                key={id}
                data-node={id}
                class={`node ${state}`}
                onMouseEnter={() => setFocus(id)}
                onFocusIn={() => setFocus(id)}
              >
                {yours && (
                  <span class="node-yours">
                    <Hand size={13} aria-hidden="true" />
                    {t.blocked || t.waiting ? 'Yours, once it’s free' : 'Needs you'}
                  </span>
                )}
                <TaskCard task={t} />
              </li>
            );
          })}
          {unfolded.has(i) && (
            <li class="node-refold">
              <button type="button" class="btn btn-sm btn-quiet" onClick={() => onFold(i, false)}>
                <Layers size={15} aria-hidden="true" />
                Fold done
              </button>
            </li>
          )}
        </ul>
      ))}
    </div>
  );
}

const featureHref = (slug) => hashFor({ view: 'roadmap', feature: slug, task: null });

/** The feature a task is in: the first of its tags that's a feature, alphabetically (one feature per task). */
const featureOf = (t, slugs) => t.tags.filter((tag) => slugs.has(tag)).sort()[0] ?? null;

/**
 * What a group can become (WEB-15): its open tasks, each with the feature it's already in, the features among
 * them, and the one feature they all share, if they do.
 */
function groupFeatures(chain, slugs) {
  const open = chain.columns.flat().filter((t) => t.status === 'pending');
  const pick = open.map((task) => ({ task, feature: featureOf(task, slugs) }));
  const counts = new Map();
  for (const p of pick) if (p.feature) counts.set(p.feature, (counts.get(p.feature) ?? 0) + 1);
  const free = pick.filter((p) => !p.feature).length;
  const only = counts.size === 1 && !free ? [...counts.keys()][0] : null;
  return { pick, counts: [...counts], free, only };
}

/**
 * Making a feature from a group, or chasing one: the form with the group's tasks to pick, then (or straight
 * away, for a group that's one feature already) the feature's chase with the same controls as its page.
 * @param {{ chain: Record<string, any>, start: { mode: 'make' | 'chase', slug?: string }, onClose: () => void }} props
 */
function GroupDialog({ chain, start, onClose }) {
  const [step, setStep] = useState(start);
  const [made, setMade] = useState(null);
  const [feature, setFeature] = useState(null);
  const [error, setError] = useState(null);
  const slug = step.mode === 'chase' ? step.slug : null;
  const fetchFeature = async () => {
    if (!slug) return;
    try {
      setFeature((await api(`features/${enc(slug)}`)).feature);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    fetchFeature();
    if (!slug) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchFeature();
    }, 10000);
    return () => clearInterval(id);
  }, [slug]);
  if (step.mode === 'make') {
    const slugs = new Set((features.value.data?.features ?? []).map((f) => f.slug));
    return (
      <FeatureForm
        pick={groupFeatures(chain, slugs).pick}
        onDone={(result) => {
          if (!result) return onClose();
          setMade(result);
          setStep({ mode: 'chase', slug: result.feature.slug });
          setFeature(result.feature);
          return undefined;
        }}
      />
    );
  }
  const f = feature?.slug === slug ? feature : null;
  return (
    <div class="sheet">
      <h2 id="fr-form-title">{made ? `+${slug} is a feature.` : `Chase +${slug}`}</h2>
      {made && (
        <p class="muted small">
          {made.joined.join(', ')} {made.joined.length === 1 ? 'carries' : 'carry'} its tag now.
          {made.kept.length > 0 &&
            ` ${made.kept.map((k) => `${k.wid} stays in +${k.feature}`).join(', ')}: a task is in one feature.`}
        </p>
      )}
      {f ? (
        <>
          {!made && (
            <p class="small">
              <Title text={f.title} /> · {f.progress.done} of {f.progress.total} done
            </p>
          )}
          {f.chase && (
            <ChasePanel feature={f} chase={f.chase} open={f.progress.total > 0 && !f.done} onChange={fetchFeature} />
          )}
        </>
      ) : error ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p class="muted" aria-busy="true">
          Loading +{slug}…
        </p>
      )}
      <div class="sheet-actions">
        <a class="btn btn-quiet" href={featureHref(slug)} onClick={onClose}>
          Open the feature
        </a>
        <button type="button" class="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A group's line above it: its size, the features its tasks are in, and what you can make of it. */
function ChainHead({ chain, onOpen }) {
  const data = features.value.data;
  const slugs = new Set((data?.features ?? []).map((f) => f.slug));
  const { pick, counts, free, only } = groupFeatures(chain, slugs);
  const chasing = only && data?.features.find((f) => f.slug === only)?.chase?.on;
  return (
    <div class="chain-head">
      <p class="chain-sum">
        <span>
          {plural(chain.size, 'task')}
          {pick.length < chain.size ? `, ${pick.length} open` : ''}
        </span>
        {counts.map(([slug, n]) => (
          <a key={slug} class="chain-feature" href={featureHref(slug)}>
            {only ? `In +${slug}` : `${n} in +${slug}`}
          </a>
        ))}
        {chasing && <span class="fr-pill fr-pill-chase">Chasing</span>}
      </p>
      {data && (
        <div class="chain-actions">
          {only && (
            <button type="button" class="btn btn-sm" onClick={() => onOpen({ mode: 'chase', slug: only })}>
              <FastForward size={15} aria-hidden="true" />
              {chasing ? 'See the chase' : 'Chase'}
            </button>
          )}
          {free > 0 && (
            <button type="button" class="btn btn-sm" onClick={() => onOpen({ mode: 'make' })}>
              <Milestone size={15} aria-hidden="true" />
              Make a feature
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function GraphView() {
  const chains = buildChains(visible.value, byUuid.value);
  const [open, setOpen] = useState(null);
  // The steps the person unfolded, per chain: chain id, then step.
  const [unfolded, setUnfolded] = useState(() => new Map());
  const showDone = graphShowDone.value;
  const layouts = useMemo(
    () => chains.map((c) => layoutChain(c, { showDone, unfold: unfolded.get(c.id) ?? new Set() })),
    [visible.value, byUuid.value, showDone, unfolded],
  );
  const fold = (id, step, out) =>
    setUnfolded((was) => {
      const next = new Map(was);
      const steps = new Set(next.get(id) ?? []);
      if (out) steps.add(step);
      else steps.delete(step);
      next.set(id, steps);
      return next;
    });
  useEffect(() => {
    navOrder.value = layouts.flatMap(readingOrder);
  });
  useEffect(() => {
    loadFeatures();
  }, []);
  return (
    <div class="graph-view">
      <div class="view-intro">
        <h1>Dependencies</h1>
        <p class="muted">
          Arrows point from a task to what waits for it. The bright line is the path to each group’s last task, and
          Needs you marks your steps. Finished work folds into one card a step. Hover or focus a task to follow its
          chain, and make a group a feature to chase it.
        </p>
        {chains.length > 0 && (
          <label class="check-row graph-show-done">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => {
                graphShowDone.value = e.currentTarget.checked;
              }}
            />
            <span>Show done</span>
          </label>
        )}
      </div>
      {chains.length ? (
        chains.map((c, i) => (
          <section key={c.id} class="chain-wrap" aria-label={`Chain from ${ref(c.columns[0][0])}, ${c.size} tasks`}>
            <ChainHead chain={c} onOpen={(start) => setOpen({ chain: c, start })} />
            <Chain
              chain={c}
              layout={layouts[i]}
              unfolded={showDone ? new Set() : (unfolded.get(c.id) ?? new Set())}
              onFold={(step, out) => fold(c.id, step, out)}
            />
          </section>
        ))
      ) : visible.value.length || filters.value.q ? (
        <div class="empty">
          <h2>No task waits for another</h2>
          <p class="muted">When one task depends on another, the chain shows here.</p>
        </div>
      ) : (
        <EmptyBoard />
      )}
      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} labelledBy="fr-form-title">
        {open && <GroupDialog chain={open.chain} start={open.start} onClose={() => setOpen(null)} />}
      </Dialog>
    </div>
  );
}
