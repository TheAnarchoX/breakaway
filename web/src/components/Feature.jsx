import { useEffect } from 'preact/hooks';
import { FastForward, Hand, Milestone, TriangleAlert } from 'lucide-preact';
import { ago, plural } from '../lib/model.js';
import { actions, agents, features, hashFor, loadFeatures } from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { sentence } from './Chase.jsx';
import { taskLock } from './Who.jsx';

/**
 * A feature as a task shows it (WEB-77): the feature its tag puts it in, with the feature's release, progress, and
 * chase, and the task's own place in a chase that's on. The roadmap (docs/specs/IDEA-28-features-and-chase.md,
 * section 2) shares the progress bar and the line that says what holds a feature up.
 */

/** A task's place in its feature, in the order the progress bar draws them, with the words for each. */
export const STANDINGS = [
  { id: 'done', count: 'done', label: 'Done', words: 'done' },
  { id: 'in-review', count: 'inReview', label: 'In review', words: 'in review' },
  { id: 'running', count: 'running', label: 'Running', words: 'running' },
  { id: 'ready', count: 'ready', label: 'Ready', words: 'ready' },
  { id: 'needs-you', count: 'needsYou', label: 'Needs you', words: 'needs you', many: 'need you' },
  { id: 'waiting', count: 'waiting', label: 'Waiting', words: 'waiting' },
];

export const featureHref = (slug) => hashFor({ view: 'roadmap', feature: slug, digest: null, task: null });

/** What holds a feature up, in words: the first thing waiting on you, else what its tasks are doing. */
export function nextUp(f) {
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
export function Progress({ progress: p, compact = false }) {
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

/** The features whose tag the task carries: one, as a rule; more is a conflict the roadmap flags too. */
export function featuresOf(t) {
  const list = features.value.data?.features ?? [];
  return list.filter((f) => t.tags.includes(f.slug));
}

/**
 * The chase that's on with this task in it, from the Agents data: `{ chase, entry }`, or null. A task is in a
 * chase when it's in the chased feature, or when it blocks one of that feature's tasks.
 * @param {string} uuid
 */
export function chaseOf(uuid) {
  for (const chase of agents.value.data?.chases ?? []) {
    const entry = chase.tasks?.find((x) => x.uuid === uuid);
    if (entry) return { chase, entry };
  }
  return null;
}

/** Where the task stands in its chase, in one sentence. */
function placeWords({ state, why }) {
  if (state === 'done') return 'Done.';
  if (state === 'ready') return why ? `Ready, but not yet: ${why}.` : 'Ready: the chase starts an agent on it next.';
  if (state === 'needs-you') return `Waits for you: ${why}.`;
  if (state === 'stuck') return `Stuck: ${why}. The chase won’t try it again.`;
  return why ? sentence(why) : '';
}

/**
 * One line in the task's Agent section when a chase that's on has the task in it: which chase, why it's there,
 * and where the task stands.
 * @param {Record<string, any>} props
 */
export function ChaseLine({ task: t }) {
  const found = chaseOf(t.uuid);
  if (!found || t.status !== 'pending') return null;
  const { chase, entry } = found;
  return (
    <p class="small tp-chase">
      <FastForward size={14} aria-hidden="true" />
      <span>
        In the chase on{' '}
        <a href={featureHref(chase.slug)}>
          <Title text={chase.title} />
        </a>
        {entry.blocks?.length ? `, because it blocks ${entry.blocks.join(', ')}` : ''}. {placeWords(entry)}
      </span>
    </p>
  );
}

/** A small pill on an agent that works on a task in a chase that's on, linking to the chase's feature. */
export function ChasePill({ uuid }) {
  const found = chaseOf(uuid);
  if (!found) return null;
  return (
    <a
      class="fr-pill fr-pill-chase tp-chase-pill"
      href={featureHref(found.chase.slug)}
      title={`In the chase on ${found.chase.title}`}
    >
      Chase +{found.chase.slug}
    </a>
  );
}

/** What the feature's chase is doing, for a task in the feature. */
function chaseWords(chase) {
  if (chase.on && chase.held) return `On hold: ${chase.held}. Started ${ago(chase.startedAt)}.`;
  if (chase.on)
    return `Chasing since ${ago(chase.startedAt)}, with up to ${plural(chase.parallel, 'agent')} at once in an area.`;
  if (chase.state === 'stopped') return `Its chase stopped ${ago(chase.endedAt)}.`;
  if (chase.state === 'done') return `Its chase ended ${ago(chase.endedAt)}.`;
  return null;
}

/**
 * The task's feature: pick one, or see the one it's in, with its release, progress, what holds it up, and its
 * chase. A task joins a feature by carrying its tag, so picking one swaps the tag.
 * @param {Record<string, any>} props
 */
export function FeatureSection({ task: t }) {
  const state = features.value;
  useEffect(() => {
    loadFeatures();
  }, [t.uuid]);
  const mine = featuresOf(t);
  const f = mine[0] ?? null;
  const open = (state.data?.features ?? []).filter((x) => !x.shipped || x.slug === f?.slug);
  const pick = (slug) => {
    const removeTags = mine.map((x) => x.slug).filter((s) => s !== slug);
    const addTags = slug && !t.tags.includes(slug) ? [slug] : [];
    if (!removeTags.length && !addTags.length) return;
    const message = slug ? `Moved to +${slug}.` : `Taken out of +${f?.slug}.`;
    const changes = { ...(addTags.length ? { addTags } : {}), ...(removeTags.length ? { removeTags } : {}) };
    actions.update(t, changes, message).then(() => loadFeatures());
  };
  const chase = f?.chase ? chaseWords(f.chase) : null;
  // A task joins a feature by its tag, a task write: someone who can't change the task reads it (WEB-137).
  const lock = taskLock(t);
  return (
    <section class="panel-section tp-feature" aria-labelledby={`feature-${t.uuid}`}>
      <h3 id={`feature-${t.uuid}`}>
        <Milestone size={16} aria-hidden="true" />
        Feature
      </h3>
      {f ? (
        <div class="tp-feature-card">
          <div class="tp-feature-top">
            <p class="fr-kicker">
              <span class="fr-slug">+{f.slug}</span> · {f.release ? `aimed at ${f.release}` : 'unplanned'}
              {f.shipped ? ' · released' : f.done ? ' · done' : ''}
            </p>
            {f.chase?.on && <span class="fr-pill fr-pill-chase">Chasing</span>}
          </div>
          <a class="tp-feature-title" href={featureHref(f.slug)}>
            <Title text={f.title} />
          </a>
          <Progress progress={f.progress} compact />
          <p class={`fr-next ${f.needsYou.length && !f.done ? 'is-yours' : ''}`}>
            {f.needsYou.length > 0 && !f.done && <Hand size={14} aria-hidden="true" />}
            {nextUp(f)}
          </p>
          {chase && (
            <p class="fr-next">
              <FastForward size={14} aria-hidden="true" />
              {chase}
            </p>
          )}
          {mine.length > 1 && (
            <p class="fr-next foot-warn">
              <TriangleAlert size={14} aria-hidden="true" />
              {`Also tagged ${mine
                .slice(1)
                .map((x) => `+${x.slug}`)
                .join(', ')}: a task counts in one feature.`}
            </p>
          )}
        </div>
      ) : (
        state.loaded &&
        !state.error && (
          <p class="muted small">
            {lock
              ? 'Not in a feature.'
              : open.length
                ? 'Not in a feature yet. Pick one to add it.'
                : 'No features yet. Add one on the Roadmap.'}
          </p>
        )
      )}
      {state.error && !state.data && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {open.length > 0 && !lock && (
        <label class="tp-feature-pick">
          <span class="meta">{f ? 'Move to' : 'Add to'}</span>
          <select
            class="select select-sm"
            value={f?.slug ?? ''}
            onChange={(e) => pick(e.currentTarget.value || null)}
            aria-label={f ? 'Move to another feature' : 'Add to a feature'}
          >
            <option value="">None</option>
            {open.map((x) => (
              <option key={x.slug} value={x.slug}>
                {x.title} (+{x.slug})
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
