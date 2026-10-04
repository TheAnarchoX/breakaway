import { useEffect, useState } from 'preact/hooks';
import { ArrowLeft, FastForward, Hand, Milestone, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-preact';
import { plural } from '../lib/model.js';
import {
  actions,
  byUuid,
  closeFeature,
  featureOpen,
  features,
  hashFor,
  loadFeature,
  loadFeatures,
  navOrder,
  selected,
  selectedFeature,
} from '../lib/store.js';
import { ClaimChip, Dialog, RepoChip, widClass } from '../components/ui.jsx';
import { ChasePanel } from '../components/Chase.jsx';
import { FeatureForm } from '../components/FeatureForm.jsx';
import { RichText, Title } from '../lib/richtext.jsx';

/**
 * The roadmap (docs/specs/IDEA-28-features-and-chase.md, section 2): releases in version order, then
 * Unplanned, each with its feature cards; a feature opens for its tasks in dependency order. Features
 * are install-wide, so the repository switcher doesn't narrow them; their tasks carry repository chips.
 */

/** A task's place in its feature, in the order the progress bar draws them, with the words for each. */
const STANDINGS = [
  { id: 'done', count: 'done', label: 'Done', words: 'done' },
  { id: 'in-review', count: 'inReview', label: 'In review', words: 'in review' },
  { id: 'running', count: 'running', label: 'Running', words: 'running' },
  { id: 'ready', count: 'ready', label: 'Ready', words: 'ready' },
  { id: 'needs-you', count: 'needsYou', label: 'Needs you', words: 'needs you', many: 'need you' },
  { id: 'waiting', count: 'waiting', label: 'Waiting', words: 'waiting' },
];
const STANDING_LABEL = Object.fromEntries(STANDINGS.map((s) => [s.id, s.label]));

/** The server's reason as a sentence; one that starts with an agent's name keeps its case. */
const sentence = (why) => `${why.startsWith('it') ? `I${why.slice(1)}` : why}.`;
const featureHref = (slug) => hashFor({ view: 'roadmap', feature: slug, task: null });
const taskHref = (t) => hashFor({ task: t.wid ?? t.uuid });

/** What holds a feature up, in words: the first thing waiting on you, else what its tasks are doing. */
function nextUp(f) {
  const p = f.progress;
  if (!p.total) return `No tasks yet. Tag a task +${f.slug} to add it.`;
  if (f.done) return 'Every task is done.';
  const mine = f.needsYou[0];
  if (mine) {
    const label = mine.wid ?? 'a task';
    return /decision/u.test(mine.why ?? '')
      ? `Waits for ${label}, your decision.`
      : `Waits for ${label}, a step for you.`;
  }
  if (p.running) return `${plural(p.running, 'task')} running.`;
  if (p.ready) return `${plural(p.ready, 'task')} ready to start.`;
  if (p.inReview && !p.waiting)
    return `Waits for you to merge ${p.inReview === 1 ? 'its pull request' : 'its pull requests'}.`;
  return `${plural(p.waiting, 'task')} waiting on other work.`;
}

/** The progress bar and its counts in words, so no state is told by color alone. */
function Progress({ progress: p, compact = false }) {
  const parts = STANDINGS.filter((s) => p[s.count] > 0);
  const words = parts
    .filter((s) => s.id !== 'done')
    .map((s) => `${p[s.count]} ${p[s.count] > 1 && s.many ? s.many : s.words}`);
  return (
    <div class={`fr-progress ${compact ? 'is-compact' : ''}`}>
      <div class="fr-bar" aria-hidden="true">
        {p.total > 0 &&
          parts.map((s) => <span key={s.id} class={`fr-seg fr-seg-${s.id}`} style={{ flexGrow: p[s.count] }} />)}
      </div>
      <p class="fr-counts">
        <strong>
          {p.done} of {p.total}
        </strong>{' '}
        done{words.length ? ` · ${words.join(' · ')}` : ''}
      </p>
    </div>
  );
}

function FeatureCard({ f }) {
  return (
    <li>
      <a class="fr-card" href={featureHref(f.slug)} data-feature={f.slug}>
        <span class="fr-card-top">
          <span class="fr-slug">+{f.slug}</span>
          {f.chase?.on && <span class="fr-pill fr-pill-chase">Chasing</span>}
          {f.shipped && <span class="fr-pill">Released</span>}
          {!f.shipped && f.done && <span class="fr-pill">Done</span>}
        </span>
        <span class="fr-card-title">
          <Title text={f.title} />
        </span>
        <Progress progress={f.progress} compact />
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

function FeatureTask({ t }) {
  const task = byUuid.value.get(t.uuid);
  return (
    <li>
      <a
        class={`fr-task ${selected.value && task && [task.wid, task.uuid].includes(selected.value) ? 'is-open' : ''}`}
        href={taskHref(t)}
        data-task={t.uuid}
      >
        <span class={`state fr-state-${t.state}`}>
          <span class="state-dot" aria-hidden="true" />
          {STANDING_LABEL[t.state] ?? t.state}
        </span>
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
          <section class="gh-section" aria-labelledby="fr-tasks-title">
            <h2 id="fr-tasks-title">
              Tasks <span class="count">{f.progress.total}</span>
            </h2>
            {f.tasks.length ? (
              <>
                <p class="muted small">In the order they can be done: a task comes after the ones it waits for.</p>
                <ol class="fr-task-list">
                  {f.tasks.map((t) => (
                    <FeatureTask key={t.uuid} t={t} />
                  ))}
                </ol>
              </>
            ) : (
              <p class="muted small">
                No tasks yet. Add the tag <span class="fr-slug">+{f.slug}</span> to a task to put it in this feature.
              </p>
            )}
          </section>
        </div>
        <div class="gh-col">
          <section class="gh-section" aria-labelledby="fr-progress-title">
            <h2 id="fr-progress-title">Progress</h2>
            <Progress progress={f.progress} />
            <p class={`fr-next ${f.needsYou.length && !f.done ? 'is-yours' : ''}`}>{nextUp(f)}</p>
          </section>
          {f.chase && (
            <section class="gh-section" aria-labelledby="fr-chase-title">
              <h2 id="fr-chase-title">
                <FastForward size={18} aria-hidden="true" />
                Chase
              </h2>
              <ChasePanel feature={f} chase={f.chase} open={f.progress.total > 0 && !f.done} />
            </section>
          )}
          {/* A chase that's on lists its own Needs you, with the blockers it pulled in. */}
          {f.needsYou.length > 0 && !f.chase?.on && (
            <section class="gh-section" aria-labelledby="fr-yours-title">
              <h2 id="fr-yours-title">
                <Hand size={18} aria-hidden="true" />
                Needs you <span class="count">{f.needsYou.length}</span>
              </h2>
              <ul class="fr-task-list">
                {f.needsYou.map((t) => (
                  <FeatureTask key={t.uuid} t={t} />
                ))}
              </ul>
            </section>
          )}
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

function Overview() {
  const state = features.value;
  const [adding, setAdding] = useState(false);
  const d = state.data;
  const released = d ? d.features.filter((f) => f.shipped) : [];
  const groups = d ? releaseGroups(d) : [];
  const none = d && !d.features.length;
  return (
    <div class="roadmap-view">
      <div class="gh-intro">
        <div class="view-intro">
          <h1>Roadmap</h1>
          <p class="muted">Features by the release they’re aimed at. A task joins a feature by carrying its tag.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden="true" />
          New feature
        </button>
      </div>
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
      {d && (
        <div class="fr-releases">
          {groups.map((g) => (
            <section key={g.release ?? 'none'} class="fr-release" aria-labelledby={`fr-r-${g.release ?? 'none'}`}>
              <h2 id={`fr-r-${g.release ?? 'none'}`}>
                {g.release ? <span class="mono">{g.release}</span> : 'Unplanned'}
                {g.features.length > 0 && <span class="count">{plural(g.features.length, 'feature')}</span>}
              </h2>
              {g.features.length > 0 && (
                <ul class="fr-cards">
                  {g.features.map((f) => (
                    <FeatureCard key={f.slug} f={f} />
                  ))}
                </ul>
              )}
              <OtherTasks tasks={g.other} />
            </section>
          ))}
          <Suggestions list={d.suggestions} first={none} />
          {released.length > 0 && (
            <details class="fr-release fr-released">
              <summary>
                <h2>
                  Released <span class="count">{plural(released.length, 'feature')}</span>
                </h2>
              </summary>
              <ul class="fr-cards">
                {released.map((f) => (
                  <FeatureCard key={f.slug} f={f} />
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
