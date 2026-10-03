// Small charts for the Activity view's dashboard (CLD-185), drawn in SVG and CSS with the theme's
// tokens: no chart library. Each one says what it shows in text too, for screen readers.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

// ---- numbers and time --------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 42 min, 5.5 h, 3.2 days: how long something took, in the unit that reads best. */
export function duration(ms) {
  if (ms === null || ms === undefined) return '–';
  if (ms < 90 * MIN) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < 36 * HOUR) return `${trim(ms / HOUR)} h`;
  return `${trim(ms / (24 * HOUR))} days`;
}

const trim = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/u, ''));

export const percent = (rate) => (rate === null || rate === undefined ? '–' : `${Math.round(rate * 100)}%`);

/** A day key (2026-10-02) as people read it, in their own locale. */
export function dayName(key, { weekday = true } = {}) {
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString(undefined, { ...(weekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' });
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts up to a number when it first shows or changes; reduced motion shows it straight away. */
export function useCountUp(value, ms = 700) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduced() || typeof value !== 'number') {
      setShown(value);
      return undefined;
    }
    const start = performance.now();
    const begin = from.current;
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      setShown(begin + (value - begin) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

/** @returns {[import('preact').RefObject<HTMLDivElement>, number]} */
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round numbers for an axis: 0, a step, and the step above the top value. */
function niceMax(max) {
  if (max <= 4) return Math.max(max, 1);
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= max);
  return Math.ceil(max / step) * step;
}

// ---- change against the period before ----------------------------------------------------------

/**
 * "▲ 40%" against the period before. `better` says which way is good: up for counts, down for times.
 * @param {Record<string, any>} props
 */
export function Delta({ now, before, better = 'up', days, unit = 'count' }) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  const span = `the ${days} days before`;
  if (!before && !now) return null;
  if (!before)
    return (
      <span class="delta delta-up delta-good" title={`None in ${span}`}>
        new
      </span>
    );
  const change = (now - before) / before;
  const pct = Math.round(Math.abs(change) * 100);
  if (pct === 0)
    return (
      <span class="delta" title={`The same as ${span}`}>
        same
      </span>
    );
  const up = change > 0;
  const good = up === (better === 'up');
  const words = unit === 'time' ? (up ? 'slower' : 'faster') : up ? 'up' : 'down';
  return (
    <span
      class={`delta ${up ? 'delta-up' : 'delta-down'} ${good ? 'delta-good' : ''}`}
      title={`${pct}% ${words} on ${span}`}
    >
      <span aria-hidden="true">{up ? '▲' : '▼'} </span>
      <span class="visually-hidden">{words} </span>
      {pct}%
    </span>
  );
}

// ---- sparkline ---------------------------------------------------------------------------------

/**
 * A tiny line of daily values: decoration beside a number that says the same thing.
 * @param {Record<string, any>} props
 */
export function Sparkline({ values }) {
  if (!values?.length) return null;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(28 - (v / max) * 26).toFixed(2)}`);
  return (
    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path class="spark-area" d={`M0,30 L${points.join(' L')} L100,30 Z`} />
      <path class="spark-line" d={`M${points.join(' L')}`} vector-effect="non-scaling-stroke" />
    </svg>
  );
}

// ---- the daily chart ---------------------------------------------------------------------------

const SERIES = [
  { key: 'finished', one: 'task finished', many: 'tasks finished' },
  { key: 'merged', one: 'pull request merged', many: 'pull requests merged' },
  { key: 'added', one: 'task added', many: 'tasks added' },
];

/**
 * Bars for tasks finished each day, a line for pull requests merged, dots for tasks added. Arrow keys read a day.
 * @param {Record<string, any>} props
 */
export function DailyChart({ daily }) {
  const [ref, width] = useWidth();
  const [focus, setFocus] = useState(null);
  const height = 210;
  const pad = { top: 12, right: 8, bottom: 26, left: 30 };
  const n = daily.length;
  const top = niceMax(Math.max(1, ...daily.flatMap((d) => [d.finished, d.merged, d.added])));
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const slot = n ? innerW / n : 0;
  const barW = Math.max(2, Math.min(28, slot * 0.62));
  const x = (i) => pad.left + slot * i + slot / 2;
  const y = (v) => pad.top + innerH - (v / top) * innerH;
  const ticks = [0, top / 2, top].map((v) => Math.round(v));
  const every = n <= 10 ? 1 : n <= 31 ? 7 : 14;
  const line = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.merged).toFixed(1)}`).join(' L');
  const shown = focus ?? n - 1;
  const today = daily[shown];

  const fromPointer = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - pad.left) / (slot || 1));
    setFocus(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n };
    if (!(e.key in moves)) return;
    e.preventDefault();
    setFocus(Math.max(0, Math.min(n - 1, (focus ?? n - 1) + moves[e.key])));
  };

  return (
    <div class="daily">
      <div class="daily-readout" aria-live="polite">
        {today && (
          <>
            <strong>{dayName(today.day)}</strong>
            {SERIES.map((s) => (
              <span key={s.key} class={`legend legend-${s.key}`}>
                <i aria-hidden="true" />
                {today[s.key]} {today[s.key] === 1 ? s.one : s.many}
              </span>
            ))}
          </>
        )}
      </div>
      <div
        ref={ref}
        class="daily-plot"
        tabIndex={0}
        role="group"
        aria-label="Every day of the period. Use the left and right arrow keys to read a day."
        onPointerMove={fromPointer}
        onPointerLeave={() => setFocus(null)}
        onKeyDown={onKey}
        onBlur={() => setFocus(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true" focusable="false">
            {ticks.map((t) => (
              <g key={t} class="axis">
                <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
                <text x={pad.left - 8} y={y(t) + 4} text-anchor="end">
                  {t}
                </text>
              </g>
            ))}
            {focus !== null && (
              <rect class="daily-hover" x={pad.left + slot * focus} y={pad.top} width={slot} height={innerH} rx="6" />
            )}
            {daily.map((d, i) => (
              <rect
                key={d.day}
                class={`daily-bar ${i === shown ? 'is-on' : ''}`}
                style={{ '--i': i }}
                x={x(i) - barW / 2}
                y={y(d.finished)}
                width={barW}
                height={Math.max(0, pad.top + innerH - y(d.finished))}
                rx={Math.min(4, barW / 2)}
              />
            ))}
            <path class="merged-line" d={`M${line}`} />
            {daily.map((d, i) =>
              d.added ? (
                <circle key={`a${d.day}`} class="added-dot" cx={x(i)} cy={y(d.added)} r={n > 45 ? 2 : 3} />
              ) : null,
            )}
            {daily.map((d, i) =>
              i % every === (n - 1) % every ? (
                <text
                  key={`t${d.day}`}
                  class="axis-day"
                  x={i === n - 1 ? width - pad.right : x(i)}
                  y={height - 8}
                  text-anchor={i === n - 1 ? 'end' : 'middle'}
                >
                  {dayName(d.day, { weekday: n <= 10 })}
                </text>
              ) : null,
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

// ---- gauges ------------------------------------------------------------------------------------

/** How good a rate is, for the gauge's color: health rates go green, amber, red; others stay accent. */
function toneOf(rate, tone) {
  if (tone !== 'health' || rate === null) return 'neutral';
  if (rate >= 0.9) return 'good';
  if (rate >= 0.7) return 'ok';
  return 'bad';
}

/**
 * A half-ring that fills to a rate, with the rate in the middle and what it counts below.
 * @param {Record<string, any>} props
 */
export function Gauge({ rate, label, detail, tone = 'health' }) {
  const value = rate === null || rate === undefined ? null : Math.max(0, Math.min(1, rate));
  const shown = useCountUp(value === null ? 0 : value * 100);
  const arc = 'M 10 60 A 50 50 0 0 1 110 60';
  return (
    <figure class={`gauge gauge-${toneOf(value, tone)}`}>
      <svg viewBox="0 0 120 68" aria-hidden="true" focusable="false">
        <path class="gauge-track" d={arc} pathLength="100" />
        {value !== null && (
          <path class="gauge-fill" d={arc} pathLength="100" style={{ strokeDasharray: `${value * 100} 100` }} />
        )}
      </svg>
      <div class="gauge-value">{value === null ? '–' : `${Math.round(shown)}%`}</div>
      <figcaption>
        <span class="gauge-label">{label}</span>
        <span class="gauge-detail">{detail}</span>
      </figcaption>
    </figure>
  );
}

// ---- bars --------------------------------------------------------------------------------------

/**
 * Labeled horizontal bars, longest first, with an optional muted note after each count.
 * @param {Record<string, any>} props
 */
export function BarList({ rows, label }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul class="barlist" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key ?? r.label}>
          <span class="barlist-label">{r.label}</span>
          <span class="barlist-track" aria-hidden="true">
            <span class="barlist-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span class="barlist-value">
            {r.value}
            {r.note ? <span class="muted"> · {r.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One bar split into parts, with a legend that carries the numbers.
 * @param {Record<string, any>} props
 */
export function SplitBar({ parts, label }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <div class="split">
      <div
        class="split-bar"
        role="img"
        aria-label={`${label}: ${
          parts
            .filter((p) => p.value)
            .map((p) => `${p.label} ${p.value}`)
            .join(', ') || 'none yet'
        }`}
      >
        {total > 0 &&
          parts
            .filter((p) => p.value)
            .map((p) => <span key={p.key} class={`split-part split-${p.key}`} style={{ flexGrow: p.value }} />)}
      </div>
      <ul class="split-legend">
        {parts.map((p) => (
          <li key={p.key} class={p.value ? '' : 'is-empty'}>
            <i class={`split-${p.key}`} aria-hidden="true" />
            <span>{p.label}</span>
            <strong>{p.value}</strong>
            {total > 0 && <span class="muted">{Math.round((p.value / total) * 100)}%</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Columns for a few buckets (how long tasks took), with the label under each.
 * @param {Record<string, any>} props
 */
export function Columns({ buckets, label }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <ul class="columns" aria-label={label}>
      {buckets.map((b) => (
        <li key={b.label}>
          <span class="columns-count">{b.count}</span>
          <span class="columns-track" aria-hidden="true">
            <span class="columns-fill" style={{ height: `${(b.count / max) * 100}%` }} />
          </span>
          <span class="columns-label">{b.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- when work lands ---------------------------------------------------------------------------

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEK_LONG = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/**
 * A week of hours, darker where more tasks finished and pull requests merged.
 * @param {Record<string, any>} props
 */
export function Heatmap({ punch }) {
  const max = Math.max(0, ...punch.flat());
  let peak = null;
  punch.forEach((row, d) =>
    row.forEach((v, h) => {
      if (v && (!peak || v > peak.v)) peak = { d, h, v };
    }),
  );
  const level = (v) => (v ? Math.min(4, Math.ceil((v / max) * 4)) : 0);
  const summary = peak
    ? `Most work lands on ${WEEK_LONG[peak.d]} around ${String(peak.h).padStart(2, '0')}:00.`
    : 'Nothing finished or merged in this period yet.';
  return (
    <div class="heat">
      <p class="heat-summary">{summary}</p>
      <div class="heat-grid" role="img" aria-label={summary}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} class="heat-hour" aria-hidden="true">
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
        {punch.map((row, d) => [
          <span key={`d${d}`} class="heat-day" aria-hidden="true">
            {WEEK[d]}
          </span>,
          ...row.map((v, h) => (
            <span
              key={`${d}-${h}`}
              class={`heat-cell heat-${level(v)}`}
              title={`${WEEK[d]} ${String(h).padStart(2, '0')}:00 · ${v}`}
            />
          )),
        ])}
      </div>
      <div class="heat-scale" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} class={`heat-cell heat-${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ---- deploys -----------------------------------------------------------------------------------

const RESULT = { landed: 'Deployed', failed: 'Failed', rollback: 'Rolled back' };

/**
 * Staging and production on one timeline: a dot per deploy, colored by how it went.
 * @param {Record<string, any>} props
 */
export function DeployStrip({ recent, from, to }) {
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T23:59:59`).getTime();
  const span = Math.max(1, end - start);
  return (
    <div class="strip">
      {['staging', 'production'].map((env) => {
        const list = recent.filter((d) => d.env === env);
        return (
          <div key={env} class="strip-row">
            <span class="strip-env">{env === 'staging' ? 'Staging' : 'Production'}</span>
            <ul
              class="strip-line"
              aria-label={`${env === 'staging' ? 'Staging' : 'Production'}: ${list.length} deploys`}
            >
              {list.map((d) => {
                const left = Math.max(0, Math.min(100, ((Date.parse(d.at) - start) / span) * 100));
                const when = new Date(d.at).toLocaleString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                });
                return (
                  <li
                    key={`${d.at}-${d.result}`}
                    class={`strip-dot strip-${d.result}`}
                    style={{ left: `${left}%` }}
                    title={`${RESULT[d.result]} · ${when}`}
                  >
                    <span class="visually-hidden">
                      {RESULT[d.result]}, {when}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div class="strip-axis" aria-hidden="true">
        <span>{dayName(from, { weekday: false })}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
