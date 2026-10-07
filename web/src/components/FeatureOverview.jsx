import { useEffect, useMemo, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  Bike,
  CalendarClock,
  CircleCheck,
  GitMerge,
  Hand,
  Hourglass,
  Milestone,
  Route,
  Sparkles,
  StepForward,
} from 'lucide-preact';
import { ago, mainPr, openPr, plural } from '../lib/model.js';
import { agents, byUuid, features, hashFor, loadAgents, pullParam } from '../lib/store.js';
import { criticalPath } from '../lib/graph-layout.js';
import { day, planDays } from '../lib/roadmap-timeline.js';
import { Title } from '../lib/richtext.jsx';
import { Tile } from './EnvironmentStatus.jsx';
import { PrBadge } from './GitHub.jsx';
import { usePace } from './RoadmapTimeline.jsx';
import { RepoChip, widClass } from './ui.jsx';

/**
 * A feature page's overview (WEB-118): where it stands at a glance in the console's tiles (WEB-103), what waits for
 * you first, the agents riding it as live cards, the path to its release (WEB-98's critical path), and what finished
 * in the last day. The full task list is the page's other tab, in RoadmapView.jsx.
 */

const DAY = 86_400_000;
/** The feature page's tab, kept while you open a task and come back. */
export const featureTab = signal(/** @type {'overview' | 'tasks'} */ ('overview'));

const taskHref = (t) => hashFor({ task: t.wid ?? t.uuid });
const label = (t) => t.wid ?? t.uuid.slice(0, 8);

/** The work ID as the board shows it everywhere: its state's colour when the board has the task. */
function Wid({ t }) {
  const task = byUuid.value.get(t.uuid);
  return <span class={task ? widClass(task) : 'wid'}>{label(t)}</span>;
}

/**
 * Keys seen since the page opened: a key that turns up later is new, for the light touch when an agent claims or a
 * pull request merges. Nothing is new on the first render, so opening the page stays still.
 * @param {string} scope resets with the feature
 * @param {string[]} keys
 */
function useArrivals(scope, keys) {
  const seen = useRef(/** @type {{ scope: string, keys: Set<string> } | null} */ (null));
  if (!seen.current || seen.current.scope !== scope) seen.current = { scope, keys: new Set(keys) };
  const fresh = new Set(keys.filter((k) => !seen.current.keys.has(k)));
  useEffect(() => {
    for (const k of keys) seen.current.keys.add(k);
  });
  return fresh;
}

/** The status band: progress, running, what waits for you and on other work, the release, and when it's likely done. */
function Band({ f, pace, riders }) {
  const p = f.progress;
  const percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const yours = p.needsYou + p.inReview;
  const projection = pace.projections.get(f.slug);
  const plan = planDays(f, pace.now);
  const likely =
    f.shipped || f.done
      ? { value: f.shipped ? 'Released' : 'Done', detail: 'Every task is done' }
      : !p.total
        ? { value: 'Not yet', detail: 'No tasks to go by', muted: true }
        : projection?.likely
          ? {
              value: day(projection.likely, pace.now),
              detail:
                projection.optimistic && day(projection.optimistic, pace.now) !== day(projection.likely, pace.now)
                  ? `${day(projection.optimistic, pace.now)} at best, an estimate`
                  : 'An estimate from the board’s pace',
            }
          : { value: 'Can’t tell', detail: 'No pace to go by yet', muted: true };
  const names = riders.map((r) => r.agent).join(', ');
  return (
    <section class="console-status fo-band" aria-label={`${f.title}’s status`}>
      <dl class="console-band">
        <Tile
          label="Progress"
          Icon={CircleCheck}
          value={p.total ? `${percent}%` : 'No tasks'}
          muted={!p.total}
          detail={p.total ? `${p.done} of ${p.total} done` : `Tag a task +${f.slug}`}
        />
        <Tile
          label="Running"
          Icon={Bike}
          value={p.running ? `${p.running}` : 'None'}
          muted={!p.running}
          detail={names || 'No agent on it now'}
          detailTitle={names}
        />
        <Tile
          label="For you"
          Icon={Hand}
          tone={yours ? 'waiting' : ''}
          value={yours ? `${yours}` : 'Nothing'}
          muted={!yours}
          detail={
            yours
              ? [p.needsYou && plural(p.needsYou, 'step'), p.inReview && `${p.inReview} to merge`]
                  .filter(Boolean)
                  .join(', ')
              : 'Nothing’s yours now'
          }
        />
        <Tile
          label="Blocked"
          Icon={Hourglass}
          value={p.waiting ? `${p.waiting}` : 'None'}
          muted={!p.waiting}
          detail={p.waiting ? 'On other tasks or a date' : p.ready ? `${p.ready} ready to start` : 'Nothing blocked'}
        />
        <Tile
          label="Release"
          Icon={Milestone}
          value={f.release ? <code>{f.release}</code> : 'Unplanned'}
          valueTitle={f.release ?? 'Unplanned'}
          muted={!f.release}
          detail={plan ? `Planned ${plan}` : 'No planned dates'}
        />
        <Tile
          label="Likely done"
          Icon={CalendarClock}
          value={likely.value}
          muted={likely.muted}
          detail={likely.detail}
        />
      </dl>
    </section>
  );
}

/** What the open task's pull request is called on a row: its number and verdict, or nothing. */
function Pull({ uuid, merged = false }) {
  const task = byUuid.value.get(uuid);
  const pr = task ? (merged ? mainPr(task) : openPr(task)) : null;
  if (!pr) return null;
  return (
    <a class="fo-pr" href={hashFor({ view: 'github', task: null, pr: pullParam(pr.number, pr.repo ?? task.repo) })}>
      <PrBadge pr={pr} />
    </a>
  );
}

/** What waits for you, in the order the work can go: decisions and steps for you, then pull requests to merge. */
function Yours({ f }) {
  const list = f.tasks.filter((t) => t.state === 'needs-you' || t.state === 'in-review');
  if (!list.length) return null;
  const steps = list.filter((t) => t.state === 'needs-you');
  const merges = list.filter((t) => t.state === 'in-review');
  return (
    <section class="gh-section fo-yours" aria-labelledby="fo-yours-title">
      <h2 id="fo-yours-title">
        <Hand size={18} aria-hidden="true" />
        Waits for you <span class="count">{list.length}</span>
      </h2>
      <ol class="fo-list">
        {[...steps, ...merges].map((t) => (
          <li key={t.uuid} class="fo-row">
            <a class="fo-row-main" href={taskHref(t)} data-task={t.uuid}>
              <span class="fo-row-head">
                <Wid t={t} />
                <RepoChip slug={t.repo} />
                <span class={`fo-ask ${t.state === 'in-review' ? 'is-merge' : ''}`}>
                  {t.state === 'in-review' ? 'Merge' : /decision/u.test(t.why ?? '') ? 'Decide' : 'Your step'}
                </span>
              </span>
              <span class="fo-row-title">
                <Title text={t.description} />
              </span>
            </a>
            {t.state === 'in-review' && <Pull uuid={t.uuid} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One agent riding the feature: its task, what it last said on the peloton, its live line, and its pull request. */
function Rider({ r, t, run, arriving }) {
  return (
    <li class={`fo-rider ${arriving ? 'is-arriving' : ''}`}>
      <span class="fo-rider-head">
        {run?.live ? (
          <span class="live-state is-live" title="Working now">
            <span class="live-dot" aria-hidden="true" />
            <span class="visually-hidden">Working now</span>
          </span>
        ) : (
          <Bike size={14} aria-hidden="true" />
        )}
        <span class="fo-agent">{r.agent}</span>
        {run?.startedAt && <span class="meta">started {ago(run.startedAt)}</span>}
      </span>
      <a class="fo-rider-task" href={taskHref(r)} data-task={r.uuid}>
        <Wid t={r} />
        <span class="fo-row-title">
          <Title text={t?.description ?? ''} />
        </span>
      </a>
      {r.last ? (
        <p class="fo-said">
          <StepForward size={13} aria-hidden="true" />
          <span>{r.last.text}</span>
          <time class="meta" dateTime={r.last.at} title={new Date(r.last.at).toLocaleString()}>
            {ago(r.last.at)}
          </time>
        </p>
      ) : run?.lastLine ? (
        <code class="agent-last">{run.lastLine}</code>
      ) : (
        <p class="fo-said muted">Hasn’t posted on the peloton yet.</p>
      )}
      <Pull uuid={r.uuid} />
    </li>
  );
}

/** The agents riding the feature now, a card each; a new one rides in, unless you'd rather nothing moved. */
function Moving({ f }) {
  const riders = f.riders ?? [];
  const runs = new Map((agents.value.data?.running ?? []).map((r) => [r.uuid, r]));
  const byTask = new Map(f.tasks.map((t) => [t.uuid, t]));
  const arriving = useArrivals(
    f.slug,
    riders.map((r) => `${r.uuid}:${r.agent}`),
  );
  return (
    <section class="gh-section fo-moving" aria-labelledby="fo-moving-title">
      <h2 id="fo-moving-title">
        <Bike size={18} aria-hidden="true" />
        Moving now <span class="count">{riders.length}</span>
      </h2>
      {riders.length ? (
        <ul class="fo-riders" aria-live="polite">
          {riders.map((r) => (
            <Rider
              key={r.uuid}
              r={r}
              t={byTask.get(r.uuid)}
              run={runs.get(r.uuid)}
              arriving={arriving.has(`${r.uuid}:${r.agent}`)}
            />
          ))}
        </ul>
      ) : (
        <p class="muted small">
          {f.done
            ? 'Every task is done.'
            : f.progress.ready
              ? `No agent holds a task here. ${plural(f.progress.ready, 'task')} ${f.progress.ready === 1 ? 'is' : 'are'} ready to start.`
              : 'No agent holds a task here.'}
        </p>
      )}
    </section>
  );
}

/** The longest chain of open tasks, each waiting for the one before, as a strip: the path to the release. */
function Path({ f }) {
  const path = useMemo(() => {
    const inside = new Set(f.tasks.map((t) => t.uuid));
    const edges = /** @type {[string, string][]} */ ([]);
    for (const t of f.tasks)
      for (const d of byUuid.value.get(t.uuid)?.depends ?? []) if (inside.has(d)) edges.push([d, t.uuid]);
    const open = new Set(f.tasks.filter((t) => t.status === 'pending').map((t) => t.uuid));
    return criticalPath(
      f.tasks.map((t) => t.uuid),
      edges,
      (id) => open.has(id),
    );
  }, [f, byUuid.value]);
  if (!path.length) return null;
  const byTask = new Map(f.tasks.map((t) => [t.uuid, t]));
  const steps = path.map((id) => byTask.get(id)).filter(Boolean);
  return (
    <section class="gh-section fo-path" aria-labelledby="fo-path-title">
      <h2 id="fo-path-title">
        <Route size={18} aria-hidden="true" />
        Path to {f.release ? <span class="mono">{f.release}</span> : 'done'}{' '}
        <span class="count">{plural(steps.length, 'task')}</span>
      </h2>
      <p class="muted small">The longest chain of open tasks, each waiting for the one before.</p>
      <ol class="fo-strip">
        {steps.map((t) => (
          <li key={t.uuid} class={`fo-step fr-state-${t.state}`}>
            <a href={taskHref(t)} data-task={t.uuid} title={t.description}>
              <span class="state-dot" aria-hidden="true" />
              <Wid t={t} />
              <span class="fo-step-title">
                <Title text={t.description} />
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What finished in the last day, newest first; one that finishes while you look gets a quiet flourish. */
function Recent({ f }) {
  const since = Date.now() - DAY;
  const list = f.tasks
    .filter((t) => t.state === 'done')
    .map((t) => ({ t, end: Date.parse(byUuid.value.get(t.uuid)?.end ?? '') }))
    .filter((x) => x.end >= since)
    .sort((a, b) => b.end - a.end);
  const fresh = useArrivals(
    f.slug,
    list.map((x) => x.t.uuid),
  );
  return (
    <section class="gh-section fo-recent" aria-labelledby="fo-recent-title">
      <h2 id="fo-recent-title">
        <GitMerge size={18} aria-hidden="true" />
        Done in the last day <span class="count">{list.length}</span>
      </h2>
      {list.length ? (
        <ul class="fo-list">
          {list.map(({ t, end }) => (
            <li key={t.uuid} class={`fo-row ${fresh.has(t.uuid) ? 'is-fresh' : ''}`}>
              <a class="fo-row-main" href={taskHref(t)} data-task={t.uuid}>
                <span class="fo-row-head">
                  {fresh.has(t.uuid) && <Sparkles size={14} aria-hidden="true" class="fo-flourish" />}
                  <Wid t={t} />
                  <RepoChip slug={t.repo} />
                  <span class="meta">{ago(new Date(end).toISOString())}</span>
                </span>
                <span class="fo-row-title">
                  <Title text={t.description} />
                </span>
              </a>
              <Pull uuid={t.uuid} merged />
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">Nothing finished in the last day.</p>
      )}
    </section>
  );
}

/** @param {{ f: any }} props the feature page's data, from GET /api/features/<slug> */
export function FeatureOverview({ f }) {
  const all = features.value.data;
  const released = useMemo(() => (all ? all.features.filter((x) => x.shipped) : []), [all]);
  const pace = usePace(all, released);
  // The live cards read each agent's live line from the Agents data: keep it as fresh as the page.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadAgents();
    }, 10000);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="fo">
      <Band f={f} pace={pace} riders={f.riders ?? []} />
      <Yours f={f} />
      <Moving f={f} />
      <Path f={f} />
      <Recent f={f} />
    </div>
  );
}
