import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CalendarCheck, CalendarRange, Hand, MoveHorizontal, TriangleAlert, X } from 'lucide-preact';
import { plural } from '../lib/model.js';
import { actions, roadmapZoom, tasks } from '../lib/store.js';
import {
  DAY,
  WEEKS_PX,
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
  shiftPlan,
  span,
  statusWords,
  suggest,
} from '../lib/roadmap-timeline.js';
import { Title } from '../lib/richtext.jsx';
import { Segmented } from './ui.jsx';
import { STANDINGS, featureHref, nextUp } from './Feature.jsx';

/**
 * The roadmap as a timeline (WEB-102): a lane per release, a bar per feature from its first work to when it's
 * likely done, with the range it could land in, the steps that wait on the owner, and its tasks' states inside.
 * Dragging a bar to another lane, or Alt+arrow on one, aims the feature there; clicking it opens the feature.
 * Projections come from the board's history (web/src/lib/roadmap-timeline.js), never from dates someone typed.
 * The owner's plan (WEB-106) is a frame around the bar, from the planned start to the planned end: Plan it sets it
 * from the pace, its ends drag (or Alt+left and Alt+right on the bar, with Shift for the start), and the bar says
 * in words how the pace compares.
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

/** Where the plan's frame sits: from its start (or the bar's, for a plan with only an end) to the end of its last day. */
function frameOf(plan, x, barLeft) {
  if (!plan) return null;
  const left = plan.start === null ? Math.min(barLeft, x(plan.end)) : x(plan.start);
  const right = plan.end === null ? null : x(plan.end + DAY);
  return { left, width: right === null ? null : Math.max(MIN_BAR, right - left), open: plan.start === null };
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

/** The plan's day `which` end dragged with the pointer, a day at a time. */
function Handle({ which, at, px, plan, setDraft, save }) {
  const down = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = /** @type {HTMLElement} */ (e.currentTarget);
    el.setPointerCapture(e.pointerId);
    const from = e.clientX;
    let moved = plan;
    const move = (m) => {
      moved = shiftPlan(plan, which, Math.round((m.clientX - from) / px));
      setDraft(moved);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      save(moved);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <span
      class={`tl-handle is-${which}`}
      style={{ left: `${at}px` }}
      title={which === 'start' ? 'Drag to move the planned start' : 'Drag to move the planned end'}
      aria-hidden="true"
      onPointerDown={down}
    />
  );
}

function Bar({ f, p, x, px, now, past, lanes, compact, onShow, dragging, setDragging }) {
  const [draft, setDraft] = useState(null);
  const timer = useRef(null);
  const saved = { plannedStart: f.plannedStart ?? null, plannedEnd: f.plannedEnd ?? null };
  const fp = { ...f, ...(draft ?? saved) };
  const plan = planOf(fp);
  const status = planStatus(fp, p, now);
  const offer = !plan && !f.shipped ? suggest(p, now) : null;
  // A plan the pace can't check draws on its own.
  const planOnly = plan && (p.state === 'unknown' || p.state === 'empty');
  const g = geometry(p, x, now);
  const frame = frameOf(plan, x, g.left);
  const left = planOnly ? frame.left : g.left;
  const id = `tl-why-${f.slug}`;
  const why = `${explainPlan(fp, p, now)} ${explain(p, past, now)}`.trim();
  const when =
    p.state === 'open'
      ? `likely by ${day(p.likely, now)}`
      : p.state === 'done'
        ? 'done'
        : planOnly
          ? `planned ${planDays(fp, now)}`
          : p.state === 'unknown'
            ? 'no estimate yet'
            : 'no tasks yet';
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
    if (!e.altKey || f.shipped) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plan) {
      e.preventDefault();
      const next = shiftPlan(fp, e.shiftKey ? 'start' : 'end', e.key === 'ArrowLeft' ? -1 : 1);
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
  const show = () => onShow(f.slug);
  const trackEnd = left + (planOnly ? 0 : g.width);
  const after = Math.max(trackEnd, frame && frame.width !== null ? frame.left + frame.width : trackEnd) + 10;
  return (
    <li class={`tl-row ${compact ? 'is-compact' : ''}`}>
      {frame && (
        <span
          class={`tl-frame ${frame.open ? 'is-open' : ''} ${frame.width === null ? 'is-no-end' : ''} ${status ? `is-${status.kind}` : ''} ${draft ? 'is-moving' : ''}`}
          style={{ left: `${frame.left}px`, width: frame.width === null ? undefined : `${frame.width}px` }}
          aria-hidden="true"
        >
          {draft && <span class="tl-frame-days">{planDays(fp, now)}</span>}
        </span>
      )}
      <a
        class={`tl-bar ${f.chase?.on ? 'is-chasing' : ''} ${dragging === f.slug ? 'is-dragging' : ''} ${
          f.needsYou.length && !f.done ? 'is-yours' : ''
        }`}
        style={{ left: `${left}px` }}
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
              <PlanStatus status={status} />
            </span>
          </span>
        )}
        {planOnly ? (
          <span class="tl-track is-plan-only" style={{ width: `${frame.width ?? MIN_BAR}px` }} />
        ) : (
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
        )}
        {compact && (
          <span class="tl-label is-after">
            <Title text={f.title} />
            <PlanStatus status={status} />
          </span>
        )}
        <span id={id} class="visually-hidden">
          {`${f.title}: ${why} ${nextUp(f)}${plan && !f.shipped ? ' Alt+left and Alt+right move the planned end, with Shift the start.' : ''}`}
        </span>
      </a>
      {frame && !f.shipped && !compact && (
        <>
          {!frame.open && <Handle which="start" at={frame.left} px={px} plan={fp} setDraft={setDraft} save={save} />}
          {frame.width !== null && (
            <Handle which="end" at={frame.left + frame.width} px={px} plan={fp} setDraft={setDraft} save={save} />
          )}
        </>
      )}
      {!compact && (offer || (plan && !f.shipped)) && (
        <span class="tl-row-actions" style={{ left: `${after}px` }}>
          {offer ? (
            <button
              type="button"
              class="btn btn-sm tl-plan-it"
              onClick={() => actions.planFeature(f, offer)}
              onFocus={show}
            >
              <CalendarRange size={14} aria-hidden="true" />
              Plan it: {day(fromDay(offer.plannedStart), now)} to {day(fromDay(offer.plannedEnd), now)}
            </button>
          ) : (
            <button
              type="button"
              class="btn btn-sm btn-quiet tl-plan-it"
              aria-label={`Clear the plan for ${f.title}`}
              onClick={() => actions.planFeature(f, { plannedStart: null, plannedEnd: null })}
              onFocus={show}
            >
              <X size={14} aria-hidden="true" />
              Clear plan
            </button>
          )}
        </span>
      )}
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
 * @param {{ all: any, pace: ReturnType<typeof usePace>, groups: any[], released: any[], head: (g: any) => any, other: (g: any) => any }} props
 */
export function RoadmapTimeline({ all, pace, groups, released, head, other }) {
  const zoom = roadmapZoom.value;
  const { now, past, projections } = pace;
  const [dragging, setDragging] = useState(null);
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
        px={px}
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

  return (
    <div class="tl">
      <div class="tl-tools">
        <p class="muted small tl-hint">
          <MoveHorizontal size={15} aria-hidden="true" />
          Drag a bar to another release (or Alt+↑, Alt+↓) to aim it there, and a plan’s ends (or Alt+←, Alt+→, with
          Shift for the start) to move it. The pace is an estimate from the last {past.windowDays} days.
        </p>
        <span class="tl-legend small muted" aria-hidden="true">
          <span class="tl-key tl-key-sure" />
          Likely
          <span class="tl-key tl-key-range" />
          Could run to
          <span class="tl-key tl-key-owner" />
          Your steps
          <span class="tl-key tl-key-plan" />
          Plan
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
            const planned = lanePlanEnd(g.features);
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
