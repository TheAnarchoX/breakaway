import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  ArrowLeft,
  ArrowUpToLine,
  CalendarRange,
  ChevronsUp,
  FastForward,
  GanttChart,
  Group,
  Hand,
  LayoutDashboard,
  LayoutList,
  ListChecks,
  ListOrdered,
  Milestone,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-preact';
import { plural } from '../lib/model.js';
import {
  actions,
  byUuid,
  closeFeature,
  featureOpen,
  features,
  hashFor,
  inScope,
  loadFeature,
  loadFeatures,
  navOrder,
  repoName,
  repoScope,
  roadmapLayout,
  selected,
  selectedFeature,
} from '../lib/store.js';
import { ClaimChip, Dialog, RepoChip, Segmented, widClass } from '../components/ui.jsx';
import { ChasePanel, ReviewPill, RoadCaptain } from '../components/Chase.jsx';
import { FeatureForm } from '../components/FeatureForm.jsx';
import { Progress, STANDINGS, featureHref, nextUp } from '../components/Feature.jsx';
import { RefineFeature } from '../components/RefineFeature.jsx';
import { FeatureOverview, featureTab } from '../components/FeatureOverview.jsx';
import { FeaturePlanning } from '../components/AgentPlanning.jsx';
import { PlanStatus, RoadmapTimeline, usePace } from '../components/RoadmapTimeline.jsx';
import { day, fromDay, planDays, planStatus, suggest } from '../lib/roadmap-timeline.js';
import { RichText, Title } from '../lib/richtext.jsx';

/**
 * The roadmap (docs/specs/IDEA-28-features-and-chase.md, section 2): releases in version order, then
 * Unplanned, each with its feature cards; a feature opens for its tasks in dependency order. On a wide screen
 * it's a timeline by default (WEB-102, components/RoadmapTimeline.jsx), with the cards one press away and on a phone. Features
 * are install-wide: with a repository picked in the switcher, the roadmap shows the features with tasks in it
 * (and those with none yet), its loose release tasks, and its suggestions (WEB-78). A feature's progress and
 * its page stay whole, and its tasks carry repository chips.
 */

const STANDING_LABEL = Object.fromEntries(STANDINGS.map((s) => [s.id, s.label]));
const LAYOUTS = [
  { id: 'timeline', label: 'Timeline', icon: <GanttChart size={15} aria-hidden="true" /> },
  { id: 'list', label: 'List', icon: <LayoutList size={15} aria-hidden="true" /> },
];

/** The server's reason as a sentence; one that starts with an agent's name keeps its case. */
const sentence = (why) => `${why.startsWith('it') ? `I${why.slice(1)}` : why}.`;
const taskHref = (t) => hashFor({ task: t.wid ?? t.uuid });

/**
 * A feature's plan in a line (WEB-106): `Planned 12 to 19 Oct · Behind by 2 days`, or nothing without one.
 * @param {{ f: any, pace: ReturnType<typeof usePace> }} props
 */
function PlanLine({ f, pace }) {
  const days = planDays(f, pace.now);
  if (!days) return null;
  return (
    <span class="fr-plan">
      <CalendarRange size={14} aria-hidden="true" />
      Planned {days}
      <PlanStatus status={planStatus(f, pace.projections.get(f.slug), pace.now)} />
    </span>
  );
}

function FeatureCard({ f, pace }) {
  return (
    <li>
      <a class="fr-card" href={featureHref(f.slug)} data-feature={f.slug}>
        <span class="fr-card-top">
          <span class="fr-slug">+{f.slug}</span>
          {f.chase?.on && <span class="fr-pill fr-pill-chase">Chasing</span>}
          <ReviewPill chase={f.chase} />
          {f.shipped && <span class="fr-pill">Released</span>}
          {!f.shipped && f.done && <span class="fr-pill">Done</span>}
        </span>
        <span class="fr-card-title">
          <Title text={f.title} />
        </span>
        <Progress progress={f.progress} compact />
        <PlanLine f={f} pace={pace} />
        <span class={`fr-next ${f.needsYou.length && !f.done ? 'is-yours' : ''}`}>
          {f.needsYou.length > 0 && !f.done && <Hand size={14} aria-hidden="true" />}
          {nextUp(f)}
        </span>
        {f.conflicts.length > 0 && (
          <span class="fr-next foot-warn">
            <TriangleAlert size={14} aria-hidden="true" />
            {plural(f.conflicts.length, 'task')} also in another feature
          </span>
        )}
      </a>
    </li>
  );
}

/** Tasks with this release's tag and no feature, so the release shows everything aimed at it. */
function OtherTasks({ tasks }) {
  const open = tasks.filter((t) => t.status === 'pending');
  const done = tasks.length - open.length;
  if (!open.length) return null;
  return (
    <details class="fr-other">
      <summary>
        Other tasks <span class="count">{open.length}</span>
        {done > 0 && <span class="meta"> and {done} done</span>}
      </summary>
      <ul class="fr-task-list">
        {open.map((t) => {
          const task = byUuid.value.get(t.uuid);
          return (
            <li key={t.uuid}>
              <a class="fr-other-row" href={taskHref(t)} data-task={t.uuid}>
                <span class={task ? widClass(task) : 'wid'}>{t.wid ?? t.uuid.slice(0, 8)}</span>
                <span class="fr-task-title">
                  <Title text={t.description} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Suggestions({ list, first }) {
  const [busy, setBusy] = useState(null);
  if (!list.length) return null;
  const make = async (s) => {
    setBusy(s.slug);
    await actions.saveFeature(null, { slug: s.slug }, `+${s.slug} is a feature now.`);
    setBusy(null);
  };
  return (
    <section class="gh-section fr-suggest" aria-labelledby="fr-suggest-title">
      <h2 id="fr-suggest-title">
        Suggested features <span class="count">{list.length}</span>
      </h2>
      <p class="muted small">
        {first
          ? 'These tags are on open tasks. Make one a feature to give it a title, a release, and its progress.'
          : 'Tags on open tasks that aren’t features yet.'}
      </p>
      <ul class="fr-suggest-list">
        {list.map((s) => (
          <li key={s.slug} class="fr-suggest-row">
            <span class="fr-slug">+{s.slug}</span>
            <span class="meta">
              {plural(s.open, 'open task')}
              {s.tasks > s.open ? `, ${s.tasks - s.open} done` : ''}
              {s.release ? ` · aimed at ${s.release}` : ''}
            </span>
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy !== null}
              aria-busy={busy === s.slug}
              onClick={() => make(s)}
            >
              Make it a feature
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A task's row; `grouped` leaves out its state, which the group it's in already says. */
function FeatureTask({ t, grouped = false }) {
  const task = byUuid.value.get(t.uuid);
  return (
    <li>
      <a
        class={`fr-task ${grouped ? 'is-grouped' : ''} ${selected.value && task && [task.wid, task.uuid].includes(selected.value) ? 'is-open' : ''}`}
        href={taskHref(t)}
        data-task={t.uuid}
      >
        {!grouped && (
          <span class={`state fr-state-${t.state}`}>
            <span class="state-dot" aria-hidden="true" />
            {STANDING_LABEL[t.state] ?? t.state}
          </span>
        )}
        <span class="fr-task-main">
          <span class="fr-task-head">
            <span class={task ? widClass(task) : 'wid'}>{t.wid ?? t.uuid.slice(0, 8)}</span>
            <RepoChip slug={t.repo} />
            {task?.claim && t.state !== 'done' && <ClaimChip task={task} compact />}
          </span>
          <span class="fr-task-title">
            <Title text={t.description} />
          </span>
          {t.why && <span class="meta">{sentence(t.why)}</span>}
          {t.alsoIn?.length > 0 && (
            <span class="meta foot-warn">
              <TriangleAlert size={13} aria-hidden="true" /> Also tagged {t.alsoIn.map((s) => `+${s}`).join(', ')}: it
              counts here only.
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

/** The task list's layout: grouped by where each task stands, or in the order they can be done. */
const taskLayout = signal(/** @type {'state' | 'order'} */ ('state'));
const TASK_LAYOUTS = [
  { id: 'state', label: 'By state', icon: <Group size={15} aria-hidden="true" /> },
  { id: 'order', label: 'In order', icon: <ListOrdered size={15} aria-hidden="true" /> },
];
/** The groups, what needs you first and Done last, folded. */
const GROUPS = ['needs-you', 'running', 'in-review', 'ready', 'waiting', 'done'];

/** The feature's full task list (WEB-118): a section for each state with Done folded to a count, or in order. */
function FeatureTasks({ f }) {
  if (!f.tasks.length)
    return (
      <section class="gh-section" aria-labelledby="fr-tasks-title">
        <h2 id="fr-tasks-title">Tasks</h2>
        <p class="muted small">
          No tasks yet. Add the tag <span class="fr-slug">+{f.slug}</span> to a task to put it in this feature.
        </p>
      </section>
    );
  const layout = taskLayout.value;
  return (
    <section class="gh-section" aria-labelledby="fr-tasks-title">
      <div class="fo-tasks-head">
        <h2 id="fr-tasks-title">
          Tasks <span class="count">{f.progress.total}</span>
        </h2>
        <Segmented
          label="Show the tasks"
          options={TASK_LAYOUTS}
          value={layout}
          onChange={(v) => {
            taskLayout.value = v;
          }}
        />
      </div>
      {layout === 'order' ? (
        <>
          <p class="muted small">In the order they can be done: a task comes after the ones it waits for.</p>
          <ol class="fr-task-list">
            {f.tasks.map((t) => (
              <FeatureTask key={t.uuid} t={t} />
            ))}
          </ol>
        </>
      ) : (
        GROUPS.map((state) => {
          const list = f.tasks.filter((t) => t.state === state);
          if (!list.length) return null;
          const rows = (
            <ul class="fr-task-list">
              {list.map((t) => (
                <FeatureTask key={t.uuid} t={t} grouped />
              ))}
            </ul>
          );
          const head = (
            <>
              <span class={`state fr-state-${state}`}>
                <span class="state-dot" aria-hidden="true" />
                {STANDING_LABEL[state]}
              </span>
              <span class="count">{list.length}</span>
            </>
          );
          return state === 'done' ? (
            <details key={state} class="fo-group fo-done">
              <summary>{head}</summary>
              {rows}
            </details>
          ) : (
            <div key={state} class="fo-group">
              <h3>{head}</h3>
              {rows}
            </div>
          );
        })
      )}
    </section>
  );
}

/** The feature page's plan (WEB-106): the plan and how the pace compares, or Plan it from the pace. */
function FeaturePlan({ f }) {
  const all = features.value.data;
  const released = useMemo(() => (all ? all.features.filter((x) => x.shipped) : []), [all]);
  const pace = usePace(all, released);
  const p = pace.projections.get(f.slug);
  const offer = !f.plannedStart && !f.plannedEnd && !f.shipped ? suggest(p, pace.now) : null;
  if (!f.plannedStart && !f.plannedEnd && !offer) return null;
  return (
    <p class="fr-plan">
      {offer ? (
        <button type="button" class="btn btn-sm" onClick={() => actions.planFeature(f, offer)}>
          <CalendarRange size={15} aria-hidden="true" />
          Plan it: {day(fromDay(offer.plannedStart), pace.now)} to {day(fromDay(offer.plannedEnd), pace.now)}
        </button>
      ) : (
        <PlanLine f={f} pace={pace} />
      )}
    </p>
  );
}

function FeatureDetail({ slug }) {
  const open = featureOpen.value;
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (featureOpen.peek()?.slug !== slug) featureOpen.value = { slug, data: null, error: null };
    loadFeature(slug);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadFeature(slug);
    }, 10000);
    return () => clearInterval(id);
  }, [slug]);
  const f = open?.slug === slug ? open.data : null;
  useEffect(() => {
    navOrder.value = (f?.tasks ?? []).map((t) => t.uuid);
  }, [f]);
  const back = (
    <a class="fr-back" href={hashFor({ view: 'roadmap', feature: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Roadmap
    </a>
  );
  if (!f)
    return (
      <div class="roadmap-view">
        {back}
        {open?.error ? (
          <div class="empty">
            <h2>Can’t show +{slug}.</h2>
            <p class="muted">{open.error}</p>
            <button type="button" class="btn" onClick={closeFeature}>
              Back to the roadmap
            </button>
          </div>
        ) : (
          <p class="muted" aria-busy="true">
            Loading +{slug}…
          </p>
        )}
      </div>
    );
  return (
    <div class="roadmap-view">
      {back}
      <div class="gh-intro">
        <div class="view-intro">
          <p class="fr-kicker">
            <span class="fr-slug">+{f.slug}</span> · {f.release ? `aimed at ${f.release}` : 'unplanned'}
            {f.shipped ? ' · released' : f.done ? ' · done' : ''}
          </p>
          <h1>
            <Title text={f.title} />
          </h1>
        </div>
        <div class="fr-actions">
          {!f.shipped && <RefineFeature feature={f} />}
          <RoadCaptain feature={f} onDone={() => loadFeature(slug)} />
          <button type="button" class="btn btn-sm" onClick={() => setEditing(true)}>
            <Pencil size={15} aria-hidden="true" />
            Edit
          </button>
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => actions.deleteFeature(f)}>
            <Trash2 size={15} aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>
      {open.error && (
        <p class="field-error" role="alert">
          {open.error}
        </p>
      )}
      <div class="fr-detail">
        <div class="gh-col">
          {f.brief && (
            <section class="gh-section fr-brief" aria-label="Brief">
              <RichText text={f.brief} />
            </section>
          )}
          <div class="fo-tabs">
            <Segmented
              label="Show the feature as"
              options={[
                { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={15} aria-hidden="true" /> },
                {
                  id: 'tasks',
                  label: 'Tasks',
                  icon: <ListChecks size={15} aria-hidden="true" />,
                  count: f.progress.total,
                },
              ]}
              value={featureTab.value}
              onChange={(v) => {
                featureTab.value = v;
              }}
            />
          </div>
          {featureTab.value === 'overview' ? <FeatureOverview f={f} /> : <FeatureTasks f={f} />}
        </div>
        <div class="gh-col">
          <section class="gh-section" aria-labelledby="fr-progress-title">
            <h2 id="fr-progress-title">Progress</h2>
            <Progress progress={f.progress} />
            <p class={`fr-next ${f.needsYou.length && !f.done ? 'is-yours' : ''}`}>{nextUp(f)}</p>
            <FeaturePlan f={f} />
          </section>
          {f.chase && (
            <section class="gh-section" aria-labelledby="fr-chase-title">
              <h2 id="fr-chase-title">
                <FastForward size={18} aria-hidden="true" />
                Chase
              </h2>
              <ChasePanel feature={f} chase={f.chase} open={f.progress.total > 0 && !f.done} captain={false} />
            </section>
          )}
          <FeaturePlanning f={f} />
          {f.conflicts.length > 0 && (
            <section class="gh-section" aria-labelledby="fr-conflicts-title">
              <h2 id="fr-conflicts-title">
                <TriangleAlert size={18} aria-hidden="true" class="foot-warn" />
                In two features <span class="count">{f.conflicts.length}</span>
              </h2>
              <p class="muted small">
                A task belongs to one feature: the first of its feature tags alphabetically. Remove the tag it shouldn’t
                have.
              </p>
              <ul class="fr-conflicts">
                {f.conflicts.map((c) => (
                  <li key={c.wid}>
                    <a class="wid" href={hashFor({ task: c.wid })}>
                      {c.wid}
                    </a>{' '}
                    <span class="meta">{c.features.map((s) => `+${s}`).join(', ')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} labelledBy="fr-form-title">
        {editing && <FeatureForm feature={f} onDone={() => setEditing(false)} />}
      </Dialog>
    </div>
  );
}

/** The roadmap's data narrowed to the repository the switcher shows; all of it under All. */
function scoped(data) {
  const scope = repoScope.value;
  if (!data || !scope) return data;
  const here = (repos) => !repos?.length || repos.includes(scope);
  return {
    ...data,
    features: data.features.filter((f) => here(f.repos)),
    suggestions: data.suggestions.filter((s) => here(s.repos)),
    releaseTasks: data.releaseTasks.map((r) => ({ ...r, tasks: r.tasks.filter((t) => inScope(t.repo)) })),
  };
}

/** Releases in the order the server sent the features (version order, then Unplanned), with their other tasks. */
function releaseGroups(data) {
  const groups = new Map();
  const group = (release) => {
    if (!groups.has(release)) groups.set(release, { release, features: [], other: [] });
    return groups.get(release);
  };
  for (const f of data.features.filter((x) => !x.shipped)) group(f.release).features.push(f);
  for (const r of data.releaseTasks) if (r.tasks.some((t) => t.status === 'pending')) group(r.release).other = r.tasks;
  const order = (r) => (r ? r.split('.').map(Number) : [Infinity]);
  return [...groups.values()].sort((a, b) => {
    const [x, y] = [order(a.release), order(b.release)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || 0;
  });
}

/**
 * The button on the next release with work outside now (BRK-126), or, `into` next, on the next release with
 * work still in later (BRK-209); the store asks before it moves anything.
 */
function PullInto({ release, tasks, into }) {
  const [busy, setBusy] = useState(false);
  const pull = async () => {
    setBusy(true);
    await actions.pullRelease(release, into);
    setBusy(false);
  };
  const Icon = into === 'next' ? ChevronsUp : ArrowUpToLine;
  return (
    <button
      type="button"
      class="btn btn-sm fr-pull"
      disabled={busy}
      aria-busy={busy}
      title={`${plural(tasks, 'task')} for ${release}, with what they wait for, ${
        into === 'next' ? 'aren’t in now or next yet' : 'aren’t in now yet'
      }`}
      onClick={pull}
    >
      <Icon size={15} aria-hidden="true" />
      Pull into {into}
    </button>
  );
}

/** The release's Pull into next and Pull into now, when it's the one they'd pull. */
function Pulls({ d, release }) {
  if (!release || (d.stagePull?.release !== release && d.nextPull?.release !== release)) return null;
  return (
    <div class="fr-pulls">
      {d.stagePull?.release === release && <PullInto release={release} tasks={d.stagePull.tasks} into="next" />}
      {d.nextPull?.release === release && <PullInto release={release} tasks={d.nextPull.tasks} into="now" />}
    </div>
  );
}

function Overview() {
  const state = features.value;
  const [adding, setAdding] = useState(false);
  const all = state.data;
  const d = scoped(all);
  const scope = repoScope.value;
  const released = useMemo(() => (d ? d.features.filter((f) => f.shipped) : []), [all, scope]);
  const groups = d ? releaseGroups(d) : [];
  const pace = usePace(all, released);
  const none = all && !all.features.length;
  // Features elsewhere on the board, and none in the repository the switcher shows.
  const noneHere = !none && d && !d.features.length;
  const timeline = roadmapLayout.value === 'timeline' && d && !none && !noneHere;
  return (
    <div class="roadmap-view">
      <div class="gh-intro">
        <div class="view-intro">
          <h1>Roadmap</h1>
          <p class="muted">
            {scope ? `Features with tasks in ${repoName(scope)}, ` : 'Features '}by the release they’re aimed at. A task
            joins a feature by carrying its tag.
          </p>
        </div>
        <div class="fr-actions">
          {d && !none && !noneHere && (
            <span class="fr-layout">
              <Segmented
                label="Show the roadmap as"
                options={LAYOUTS}
                value={roadmapLayout.value}
                onChange={(v) => {
                  roadmapLayout.value = v;
                }}
              />
            </span>
          )}
          <button type="button" class="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" />
            New feature
          </button>
        </div>
      </div>
      {timeline && (
        <RoadmapTimeline
          pace={pace}
          groups={groups}
          released={released}
          head={(g) => <Pulls d={d} release={g.release} />}
          other={(g) => <OtherTasks tasks={g.other} />}
        />
      )}
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {!d && !state.error && (
        <p class="muted" aria-busy="true">
          Loading the roadmap…
        </p>
      )}
      {none && (
        <div class="empty fr-empty">
          <Milestone size={28} aria-hidden="true" />
          <h2>No features yet.</h2>
          <p class="muted">
            {d.suggestions.length
              ? 'Start from a tag your tasks already carry, below, or add a feature of your own.'
              : 'A feature is a tag on tasks, with a title, a release, and its progress. Add one, then tag its tasks.'}
          </p>
        </div>
      )}
      {noneHere && (
        <div class="empty fr-empty">
          <Milestone size={28} aria-hidden="true" />
          <h2>No features in {repoName(scope)}.</h2>
          <p class="muted">Tag its tasks with a feature’s slug, add a feature, or switch to every repository.</p>
        </div>
      )}
      {d && (
        <div class="fr-releases">
          {groups.map((g) => (
            <section
              key={g.release ?? 'none'}
              class={`fr-release ${timeline ? 'is-fallback' : ''}`}
              aria-labelledby={`fr-r-${g.release ?? 'none'}`}
            >
              <div class="fr-release-head">
                <h2 id={`fr-r-${g.release ?? 'none'}`}>
                  {g.release ? <span class="mono">{g.release}</span> : 'Unplanned'}
                  {g.features.length > 0 && <span class="count">{plural(g.features.length, 'feature')}</span>}
                </h2>
                <Pulls d={d} release={g.release} />
              </div>
              {g.features.length > 0 && (
                <ul class="fr-cards">
                  {g.features.map((f) => (
                    <FeatureCard key={f.slug} f={f} pace={pace} />
                  ))}
                </ul>
              )}
              <OtherTasks tasks={g.other} />
            </section>
          ))}
          <Suggestions list={d.suggestions} first={none} />
          {released.length > 0 && (
            <details class={`fr-release fr-released ${timeline ? 'is-fallback' : ''}`}>
              <summary>
                <h2>
                  Released <span class="count">{plural(released.length, 'feature')}</span>
                </h2>
              </summary>
              <ul class="fr-cards">
                {released.map((f) => (
                  <FeatureCard key={f.slug} f={f} pace={pace} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="fr-form-title">
        {adding && (
          <FeatureForm
            onDone={(slug) => {
              setAdding(false);
              if (slug) location.hash = featureHref(slug);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

export function RoadmapView() {
  const slug = selectedFeature.value;
  useEffect(() => {
    loadFeatures();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadFeatures();
    }, 10000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!slug) navOrder.value = [];
  }, [slug]);
  return slug ? <FeatureDetail slug={slug} /> : <Overview />;
}
