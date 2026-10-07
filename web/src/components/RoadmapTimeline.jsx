import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CalendarCheck, CalendarRange, Hand, MoveHorizontal, TriangleAlert } from 'lucide-preact';
import { plural } from '../lib/model.js';
import { actions, roadmapZoom, tasks } from '../lib/store.js';
import {
  DAY,
  WEEKS_PX,
  barDays,
  dragPlan,
  day,
  explain,
  explainPlan,
  fitPx,
  fromDay,
  history,
  lanePlanEnd,
  neighbour,
  ordered,
  planDays,
  planOf,
  planStatus,
  project,
  scale,
  span,
  statusWords,
  suggest,
} from '../lib/roadmap-timeline.js';
import { Title } from '../lib/richtext.jsx';
import { Segmented } from './ui.jsx';
import { STANDINGS, featureHref, nextUp } from './Feature.jsx';

/**
 * The roadmap as a timeline (WEB-102): a lane per release, a bar per feature with its tasks' states inside.
 * Dragging a bar into another lane, or Alt+up and Alt+down on one, aims the feature there; clicking it opens the
 * feature. The pace comes from the board's history (web/src/lib/roadmap-timeline.js).
 * The bar is the owner's plan (WEB-106, WEB-111): it runs from the planned start to the planned end, the pace's
 * suggestion until there is one, and fills with the feature's progress. The pace says in words how it compares.
 */

const ZOOM_OPTIONS = [
  { id: 'weeks', label: 'Weeks' },
  { id: 'fit', label: 'Fit' },
];
/** How long Alt+arrow waits after the last press before it saves the plan, so a run of presses saves once. */
const KEY_SAVE_MS = 700;
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

const STATUS_ICON = { behind: TriangleAlert, 'not-started': TriangleAlert, on: CalendarCheck };

/** How the pace compares to the plan, in words, with an icon where it's a warning. */
export function PlanStatus({ status }) {
  if (!status) return null;
  const Icon = STATUS_ICON[status.kind];
  return (
    <span class={`tl-status is-${status.kind}`}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {statusWords(status)}
    </span>
  );
}

/** How far the pointer moves before a press on a bar becomes a drag rather than a click. */
const DRAG_SLOP = 4;

/**
 * A feature's bar (WEB-111): it is the plan, from the planned start to the end of the planned end (the pace's
 * suggestion until there is one), filled with the feature's progress. Drag it to move it in time, or into another
 * lane to aim it there; drag an end to change how long it runs. The pace says in words how it compares.
 */
function Bar({ f, p, x, px, now, past, lanes, compact, onShow, laneAt, setOver }) {
  const [draft, setDraft] = useState(null);
  const [moving, setMoving] = useState(false);
  const timer = useRef(null);
  const dragged = useRef(false);
  const saved = { plannedStart: f.plannedStart ?? null, plannedEnd: f.plannedEnd ?? null };
  const fp = { ...f, ...(draft ?? saved) };
  const bar = barDays(fp, p, now);
  const status = planStatus(fp, p, now);
  const left = x(bar.start);
  const width = Math.max(MIN_BAR, x(bar.end + DAY) - left);
  const id = `tl-why-${f.slug}`;
  const why = `${explainPlan(fp, p, now)} ${explain(p, past, now)}`.trim();
  const when = bar.planned
    ? planDays(fp, now)
    : p.state === 'open'
      ? `likely by ${day(p.likely, now)}`
      : p.state === 'done'
        ? 'done'
        : p.state === 'unknown'
          ? 'no estimate yet'
          : 'no tasks yet';
  const fixed = Boolean(f.shipped);
  const save = async (next) => {
    clearTimeout(timer.current);
    if (next.plannedStart === saved.plannedStart && next.plannedEnd === saved.plannedEnd) {
      setDraft(null);
      return;
    }
    await actions.planFeature(f, next);
    setDraft(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const keys = (e) => {
    if (!e.altKey || fixed) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = dragPlan(barDays(fp, p, now), e.shiftKey ? 'end' : 'move', e.key === 'ArrowLeft' ? -1 : 1);
      setDraft(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save(next), KEY_SAVE_MS);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const to = neighbour(lanes, f.release ?? null, e.key === 'ArrowUp' ? -1 : 1);
    if (to === undefined) return;
    e.preventDefault();
    actions.moveFeature(f, to);
  };
  const down = (e) => {
    if (fixed || e.button !== 0 || e.pointerType === 'touch') return;
    const edge = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tl-edge'));
    const how = /** @type {'move' | 'start' | 'end'} */ (edge?.dataset.edge ?? 'move');
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    const base = barDays(fp, p, now);
    const from = { x: e.clientX, y: e.clientY };
    const home = f.release ?? null;
    let next = null;
    let lane = home;
    dragged.current = false;
    const move = (m) => {
      if (!dragged.current && Math.hypot(m.clientX - from.x, m.clientY - from.y) < DRAG_SLOP) return;
      if (!dragged.current) {
        dragged.current = true;
        el.setPointerCapture(e.pointerId);
        setMoving(true);
      }
      next = dragPlan(base, how, Math.round((m.clientX - from.x) / px));
      setDraft(next);
      if (how === 'move') {
        const at = laneAt(m.clientX, m.clientY);
        if (at !== undefined) lane = at;
        setOver(lane === home ? null : LANE_KEY(lane));
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setMoving(false);
      setOver(null);
      if (!dragged.current) return;
      if (lane !== home) actions.moveFeature(f, lane);
      if (next) save(next);
      else setDraft(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const show = () => onShow(f.slug);
  return (
    <li class={`tl-row ${compact ? 'is-compact' : ''}`}>
      <a
        class={`tl-bar ${f.chase?.on ? 'is-chasing' : ''} ${moving ? 'is-dragging' : ''} ${
          f.needsYou.length && !f.done ? 'is-yours' : ''
        } ${fixed ? 'is-fixed' : ''}`}
        style={{ left: `${left}px` }}
        href={featureHref(f.slug)}
        data-feature={f.slug}
        draggable={false}
        aria-describedby={id}
        onPointerDown={down}
        onClick={(e) => {
          // A drag ends with a click on the bar; it isn't one.
          if (dragged.current) {
            e.preventDefault();
            dragged.current = false;
          }
        }}
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
              <PlanStatus status={status} />
            </span>
          </span>
        )}
        <span
          class={`tl-track ${p.state === 'empty' ? 'is-empty' : ''} ${bar.planned ? 'is-planned' : ''}`}
          style={{ width: `${width}px` }}
        >
          <span class="tl-sure">
            <Segments progress={f.progress} />
          </span>
          {!fixed && !compact && (
            <>
              <span class="tl-edge is-start" data-edge="start" title="Drag to move the start" aria-hidden="true" />
              <span class="tl-edge is-end" data-edge="end" title="Drag to move the end" aria-hidden="true" />
            </>
          )}
        </span>
        {draft && moving && <span class="tl-drag-days">{planDays(fp, now)}</span>}
        {compact && (
          <span class="tl-label is-after">
            <Title text={f.title} />
            <PlanStatus status={status} />
          </span>
        )}
        <span id={id} class="visually-hidden">
          {`${f.title}: ${why} ${nextUp(f)}${fixed ? '' : ' Alt+left and Alt+right move it a day, with Shift its end; Alt+up and Alt+down move it to another release.'}`}
        </span>
      </a>
    </li>
  );
}

/** Plan from the pace on a lane's head: every feature in it without a plan gets the pace's suggestion. */
function PlanFromPace({ features, projections, now }) {
  const [busy, setBusy] = useState(false);
  const plans = features
    .filter((f) => !f.plannedStart && !f.plannedEnd)
    .map((f) => ({ f, plan: suggest(projections.get(f.slug), now) }))
    .filter((x) => x.plan);
  if (!plans.length) return null;
  return (
    <button
      type="button"
      class="btn btn-sm"
      disabled={busy}
      aria-busy={busy}
      title={`${plural(plans.length, 'feature')} without a plan get the pace’s start and likely end`}
      onClick={async () => {
        setBusy(true);
        await actions.planFeatures(plans);
        setBusy(false);
      }}
    >
      <CalendarRange size={15} aria-hidden="true" />
      Plan from the pace
    </button>
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
 * The pace for the roadmap's features: the board's history and each feature's projection, worked out once for the
 * timeline and the cards. The clock moves with the data, so a bar doesn't creep between reloads.
 * @param {any} all the roadmap's data, or null while it loads
 * @param {any[]} released
 */
export function usePace(all, released) {
  const list = tasks.value;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [all, list]);
  const { past, projections } = useMemo(() => {
    const past = history(list, now);
    if (!all) return { past, projections: new Map() };
    const open = all.features.filter((f) => !f.shipped);
    const projections = project(open, list, now, past);
    for (const [slug, p] of project(released, list, now, past)) projections.set(slug, p);
    return { past, projections };
  }, [all, list, now, released]);
  return { now, past, projections };
}

/**
 * @param {{ pace: ReturnType<typeof usePace>, groups: any[], released: any[], head: (g: any) => any, other: (g: any) => any }} props
 */
export function RoadmapTimeline({ pace, groups, released, head, other }) {
  const zoom = roadmapZoom.value;
  const { now, past, projections } = pace;
  const [over, setOver] = useState(null);
  const [shown, setShown] = useState(null);
  const [width, setWidth] = useState(0);
  const scroller = useRef(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const lanes = useMemo(() => {
    const out = groups.map((g) => g.release);
    return out.includes(null) ? out : [...out, null];
  }, [groups]);
  const shownFeatures = [...groups.flatMap((g) => g.features), ...released];
  const shownFeature = shownFeatures.find((f) => f.slug === shown && projections.has(f.slug)) ?? null;
  const range = useMemo(
    () =>
      span(
        shownFeatures.map((f) => projections.get(f.slug)).filter(Boolean),
        now,
        shownFeatures.map((f) => planOf(f)),
      ),
    [projections, now, groups, released],
  );
  // Fit: today and the last likely or planned end of the open features fill what's in view.
  const open = groups.flatMap((g) => g.features);
  const last = Math.max(
    now,
    ...open.map((f) => {
      const p = projections.get(f.slug);
      return Math.max(p?.state === 'open' ? p.likely : 0, (fromDay(f.plannedEnd ?? null) ?? 0) + DAY);
    }),
  );
  const px = zoom === 'fit' && width ? fitPx(width, now, last) : WEEKS_PX;
  const s = scale(range, px, now);
  const today = s.x(now);
  // Open on today, with a little of the past in view, and the start of every open feature's bar (at Fit, a week
  // before today).
  const earliest =
    zoom === 'fit'
      ? s.x(now - 7 * DAY)
      : Math.min(today - 160, ...open.map((f) => s.x(projections.get(f.slug)?.start ?? now) - 24));
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = Math.max(0, earliest);
  }, [zoom, range.from, zoom === 'fit' ? px : 0]);

  /** The release of the lane under a point, or undefined when it's over none. */
  const laneAt = (clientX, clientY) => {
    const key = /** @type {HTMLElement | null} */ (
      document.elementFromPoint(clientX, clientY)?.closest('.tl-lane[data-lane]')
    )?.dataset.lane;
    return key === undefined ? undefined : lanes.find((r) => LANE_KEY(r) === key);
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
        px={px}
        now={now}
        past={past}
        lanes={lanes}
        compact={compact}
        onShow={setShown}
        laneAt={laneAt}
        setOver={setOver}
      />
    ) : null;
  };

  return (
    <div class="tl">
      <div class="tl-tools">
        <p class="muted small tl-hint">
          <MoveHorizontal size={15} aria-hidden="true" />
          Drag a bar to plan when it runs, or its ends to change how long, and into another release to aim it there. On
          a bar, Alt+← and Alt+→ move it a day (Shift its end), and Alt+↑ and Alt+↓ change its release. The pace is an
          estimate from the last {past.windowDays} days.
        </p>
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
            const planned = lanePlanEnd(g.features);
            return (
              <section
                key={key}
                class={`tl-lane ${over === key ? 'is-over' : ''}`}
                aria-labelledby={`tl-l-${key}`}
                data-lane={key}
              >
                <div class="tl-lane-head">
                  <h2 id={`tl-l-${key}`}>
                    {g.release ? <span class="mono">{g.release}</span> : 'Unplanned'}
                    {g.features.length > 0 && <span class="count">{plural(g.features.length, 'feature')}</span>}
                  </h2>
                  {g.release && end && (
                    <span class="tl-lane-end small muted">{end <= now ? 'Done' : `Likely by ${day(end, now)}`}</span>
                  )}
                  {g.release && planned !== null && (
                    <span class="tl-lane-end small muted">Planned by {day(planned, now)}</span>
                  )}
                  <span class="tl-lane-actions">
                    <PlanFromPace features={g.features} projections={projections} now={now} />
                    {head(g)}
                  </span>
                </div>
                {g.release && end && end > now && (
                  <span class="tl-marker" style={{ left: `${s.x(end)}px` }} aria-hidden="true" />
                )}
                {g.features.length > 0 ? (
                  <ol class="tl-rows">{ordered(g.features, projections, now).map((f) => row(f))}</ol>
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
              <ol class="tl-rows">{ordered(released, projections, now).map((f) => row(f, true))}</ol>
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
            {`${explainPlan(shownFeature, projections.get(shownFeature.slug), now)} ${explain(
              projections.get(shownFeature.slug),
              past,
              now,
            )}`.trim()}
          </>
        ) : (
          'Point at a bar, or move to it with Tab, to see how its dates are worked out and how it’s doing against its plan.'
        )}
      </p>
    </div>
  );
}
