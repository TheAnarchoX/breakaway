import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Hand, MoveHorizontal } from 'lucide-preact';
import { plural } from '../lib/model.js';
import { actions, roadmapZoom, tasks } from '../lib/store.js';
import { day, explain, history, neighbour, project, scale, span } from '../lib/roadmap-timeline.js';
import { Title } from '../lib/richtext.jsx';
import { Segmented } from './ui.jsx';
import { STANDINGS, featureHref, nextUp } from './Feature.jsx';

/**
 * The roadmap as a timeline (WEB-102): a lane per release, a bar per feature from its first work to when it's
 * likely done, with the range it could land in, the steps that wait on the owner, and its tasks' states inside.
 * Dragging a bar to another lane, or Alt+arrow on one, aims the feature there; clicking it opens the feature.
 * Projections come from the board's history (web/src/lib/roadmap-timeline.js), never from dates someone typed.
 */

const ZOOM_OPTIONS = [
  { id: 'weeks', label: 'Weeks' },
  { id: 'months', label: 'Months' },
];
const LANE_KEY = (release) => release ?? 'none';
/** The narrowest a bar draws, so a feature due today still shows and takes a click. */
const MIN_BAR = 12;

/** The task states inside a bar, as the cards show them. */
function Segments({ progress: p }) {
  const parts = STANDINGS.filter((s) => p[s.count] > 0);
  return (
    <span class="tl-segs">
      {parts.map((s) => (
        <span key={s.id} class={`fr-seg fr-seg-${s.id}`} style={{ flexGrow: p[s.count] }} />
      ))}
    </span>
  );
}

/** Where the bar's pieces sit, in pixels, from its projection. */
function geometry(p, x, now) {
  if (p.state === 'empty') return { left: x(now), width: MIN_BAR, empty: true };
  const left = x(p.start ?? now);
  if (p.state === 'done') return { left, width: Math.max(MIN_BAR, x(p.end ?? now) - left) };
  if (p.state === 'unknown') return { left, width: Math.max(MIN_BAR, x(now) - left) + 120, unknown: true };
  const width = Math.max(MIN_BAR, x(p.likely) - left);
  const at = (ms) => Math.min(width, Math.max(0, x(ms) - left));
  return { left, width, sure: Math.max(at(p.optimistic), 4), owner: at(p.ownerFrom) };
}

function Bar({ f, p, x, now, past, lanes, compact, onShow, dragging, setDragging }) {
  const g = geometry(p, x, now);
  const id = `tl-why-${f.slug}`;
  const why = explain(p, past, now);
  const when =
    p.state === 'open'
      ? `likely by ${day(p.likely, now)}`
      : p.state === 'done'
        ? 'done'
        : p.state === 'unknown'
          ? 'no estimate yet'
          : 'no tasks yet';
  const keys = (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || f.shipped) return;
    const to = neighbour(lanes, f.release ?? null, e.key === 'ArrowUp' ? -1 : 1);
    if (to === undefined) return;
    e.preventDefault();
    actions.moveFeature(f, to);
  };
  const show = () => onShow(f.slug);
  return (
    <li class={`tl-row ${compact ? 'is-compact' : ''}`}>
      <a
        class={`tl-bar ${f.chase?.on ? 'is-chasing' : ''} ${dragging === f.slug ? 'is-dragging' : ''} ${
          f.needsYou.length && !f.done ? 'is-yours' : ''
        }`}
        style={{ left: `${g.left}px` }}
        href={featureHref(f.slug)}
        data-feature={f.slug}
        draggable={!f.shipped}
        aria-describedby={id}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-breakaway-feature', f.slug);
          setDragging(f.slug);
        }}
        onDragEnd={() => setDragging(null)}
        onKeyDown={keys}
        onMouseEnter={show}
        onFocus={show}
      >
        {!compact && (
          <span class="tl-label">
            <span class="tl-title">
              <Title text={f.title} />
            </span>
            <span class="tl-when">
              {f.chase?.on && <span class="fr-pill fr-pill-chase">Chasing</span>}
              {f.needsYou.length > 0 && !f.done && <Hand size={13} aria-label="Needs you" />}
              {when}
            </span>
          </span>
        )}
        <span
          class={`tl-track ${g.unknown ? 'is-unknown' : ''} ${g.empty ? 'is-empty' : ''}`}
          style={{ width: `${g.width}px` }}
        >
          <span class="tl-sure" style={g.sure !== undefined ? { width: `${g.sure}px` } : undefined}>
            <Segments progress={f.progress} />
          </span>
          {g.sure !== undefined && g.owner > g.sure && (
            <span class="tl-range" style={{ left: `${g.sure}px`, width: `${g.owner - g.sure}px` }} />
          )}
          {g.owner !== undefined && g.width > g.owner && (
            <span class="tl-owner" style={{ left: `${g.owner}px`, width: `${g.width - g.owner}px` }} />
          )}
        </span>
        {compact && (
          <span class="tl-label is-after">
            <Title text={f.title} />
          </span>
        )}
        <span id={id} class="visually-hidden">
          {`${f.title}: ${why} ${nextUp(f)}`}
        </span>
      </a>
    </li>
  );
}

/** The latest likely end of a lane's features, or null when one of them has no estimate. */
function laneEnd(features, projections) {
  let end = 0;
  for (const f of features) {
    const p = projections.get(f.slug);
    if (!p || p.state === 'empty') continue;
    if (p.state === 'unknown') return null;
    end = Math.max(end, p.state === 'done' ? (p.end ?? 0) : p.likely);
  }
  return end || null;
}

/**
 * @param {{ all: any, groups: any[], released: any[], head: (g: any) => any, other: (g: any) => any }} props
 */
export function RoadmapTimeline({ all, groups, released, head, other }) {
  const list = tasks.value;
  const zoom = roadmapZoom.value;
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [shown, setShown] = useState(null);
  const scroller = useRef(null);
  // The projection's clock moves with the data, so a bar doesn't creep between reloads.
  useEffect(() => setNow(Date.now()), [all, list]);
  const { past, projections } = useMemo(() => {
    const past = history(list, now);
    const open = all.features.filter((f) => !f.shipped);
    const projections = project(open, list, now, past);
    for (const [slug, p] of project(released, list, now, past)) projections.set(slug, p);
    return { past, projections };
  }, [all, list, now, released]);
  const lanes = useMemo(() => {
    const out = groups.map((g) => g.release);
    return out.includes(null) ? out : [...out, null];
  }, [groups]);
  const shownFeatures = [...groups.flatMap((g) => g.features), ...released];
  const shownFeature = shownFeatures.find((f) => f.slug === shown && projections.has(f.slug)) ?? null;
  const range = useMemo(
    () => span(shownFeatures.map((f) => projections.get(f.slug)).filter(Boolean), now),
    [projections, now, groups, released],
  );
  const s = scale(range, zoom, now);
  const today = s.x(now);
  // Open on today, with a little of the past in view, and the start of every open feature's bar.
  const earliest = Math.min(
    today - 160,
    ...groups.flatMap((g) => g.features).map((f) => s.x(projections.get(f.slug)?.start ?? now) - 24),
  );
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = Math.max(0, earliest);
  }, [zoom, range.from]);

  const drop = (release) => (e) => {
    e.preventDefault();
    const slug = e.dataTransfer.getData('application/x-breakaway-feature') || dragging;
    setOver(null);
    setDragging(null);
    const f = all.features.find((x) => x.slug === slug);
    if (f) actions.moveFeature(f, release);
  };
  const lanesShown = lanes.map(
    (release) => groups.find((g) => g.release === release) ?? { release, features: [], other: [] },
  );
  const row = (f, compact = false) => {
    const p = projections.get(f.slug);
    return p ? (
      <Bar
        key={f.slug}
        f={f}
        p={p}
        x={s.x}
        now={now}
        past={past}
        lanes={lanes}
        compact={compact}
        onShow={setShown}
        dragging={dragging}
        setDragging={setDragging}
      />
    ) : null;
  };
  const byStart = (a, b) =>
    (projections.get(a.slug)?.start ?? now) - (projections.get(b.slug)?.start ?? now) || a.title.localeCompare(b.title);

  return (
    <div class="tl">
      <div class="tl-tools">
        <p class="muted small tl-hint">
          <MoveHorizontal size={15} aria-hidden="true" />
          Drag a bar to another release, or press Alt+↑ or Alt+↓ on it, to aim it there. Dates are estimates from what
          the board finished in the last {past.windowDays} days.
        </p>
        <span class="tl-legend small muted" aria-hidden="true">
          <span class="tl-key tl-key-sure" />
          Likely
          <span class="tl-key tl-key-range" />
          Could run to
          <span class="tl-key tl-key-owner" />
          Your steps
        </span>
        <Segmented
          label="Zoom"
          options={ZOOM_OPTIONS}
          value={zoom}
          onChange={(z) => {
            roadmapZoom.value = z;
          }}
        />
      </div>
      <div class="tl-scroll" ref={scroller}>
        <div class="tl-canvas" style={{ width: `${s.width}px` }}>
          <div class="tl-axis" aria-hidden="true">
            {s.ticks.map((t) => (
              <span key={t.at} class="tl-tick" style={{ left: `${t.x}px` }}>
                {t.label}
              </span>
            ))}
          </div>
          {s.ticks.map((t) => (
            <span key={t.at} class="tl-grid" style={{ left: `${t.x}px` }} aria-hidden="true" />
          ))}
          <span class="tl-today" style={{ left: `${today}px` }} aria-hidden="true">
            <span>Today</span>
          </span>
          {lanesShown.map((g) => {
            const key = LANE_KEY(g.release);
            const end = laneEnd(g.features, projections);
            return (
              <section
                key={key}
                class={`tl-lane ${over === key ? 'is-over' : ''} ${dragging ? 'is-target' : ''}`}
                aria-labelledby={`tl-l-${key}`}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== key) setOver(key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(/** @type {Node} */ (e.relatedTarget))) setOver(null);
                }}
                onDrop={drop(g.release)}
              >
                <div class="tl-lane-head">
                  <h2 id={`tl-l-${key}`}>
                    {g.release ? <span class="mono">{g.release}</span> : 'Unplanned'}
                    {g.features.length > 0 && <span class="count">{plural(g.features.length, 'feature')}</span>}
                  </h2>
                  {g.release && end && (
                    <span class="tl-lane-end small muted">{end <= now ? 'Done' : `Likely by ${day(end, now)}`}</span>
                  )}
                  {head(g)}
                </div>
                {g.release && end && end > now && (
                  <span class="tl-marker" style={{ left: `${s.x(end)}px` }} aria-hidden="true" />
                )}
                {g.features.length > 0 ? (
                  <ol class="tl-rows">{[...g.features].sort(byStart).map((f) => row(f))}</ol>
                ) : (
                  <p class="tl-lane-empty muted small">
                    {g.release
                      ? 'No features aimed here yet. Drop one here to aim it at this release.'
                      : 'Drop a feature here to take it off its release.'}
                  </p>
                )}
                <div class="tl-lane-foot">{other(g)}</div>
              </section>
            );
          })}
          {released.length > 0 && (
            <details class="tl-lane tl-past">
              <summary>
                <h2>
                  Released <span class="count">{plural(released.length, 'feature')}</span>
                </h2>
              </summary>
              <ol class="tl-rows">{[...released].sort(byStart).map((f) => row(f, true))}</ol>
            </details>
          )}
        </div>
      </div>
      <p class="tl-why small" aria-hidden="true">
        {shownFeature ? (
          <>
            <strong>
              <Title text={shownFeature.title} />
            </strong>{' '}
            {explain(projections.get(shownFeature.slug), past, now)}
          </>
        ) : (
          'Point at a bar, or move to it with Tab, to see how its dates are worked out.'
        )}
      </p>
    </div>
  );
}
