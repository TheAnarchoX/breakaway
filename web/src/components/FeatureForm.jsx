import { useState } from 'preact/hooks';
import { actions, multiRepo, repoScope } from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { IDEA_HORIZONS, RepoField } from './NewTask.jsx';
import { RepoChip, widClass, Dictate } from './ui.jsx';

const SLUG = '[a-z][a-z0-9_\\-]{0,39}';
const RELEASE = '\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}';
/** The horizons a shaped feature's tasks can start in: new work is never archived. */
const SHAPE_HORIZONS = IDEA_HORIZONS.filter((h) => h.id !== 'archive');

/**
 * The open tasks of a group to pick from (WEB-15): each one picked to start with, except a task already in
 * another feature, which stays there (one feature per task) and is shown with it.
 * @param {{ pick: { task: Record<string, any>, feature: string | null }[] }} props
 */
function TaskPicker({ pick }) {
  const free = pick.filter((p) => !p.feature).length;
  return (
    <fieldset class="field ff-pick">
      <legend class="field-label">Tasks</legend>
      <span class="field-hint">
        The open tasks in this group. Each one you pick gets the tag; leave out any that belong elsewhere.
      </span>
      <ul class="ff-pick-list">
        {pick.map(({ task: t, feature }) => (
          <li key={t.uuid}>
            <label class={`check-row ff-pick-row ${feature ? 'is-taken' : ''}`}>
              <input type="checkbox" name="task" value={t.uuid} defaultChecked={!feature} disabled={Boolean(feature)} />
              <span class={widClass(t)}>{t.wid ?? t.uuid.slice(0, 8)}</span>
              <RepoChip slug={t.repo} />
              <span class="ff-pick-title">
                <Title text={t.description} />
              </span>
              {feature && <span class="ff-pick-in">In +{feature}</span>}
            </label>
          </li>
        ))}
      </ul>
      {free < pick.length && (
        <span class="field-hint">A task is in one feature, so the ones in another stay there.</span>
      )}
    </fieldset>
  );
}

/**
 * Adds a feature, or edits `feature`. The slug is the tag its tasks carry, so it can't change later. With
 * `pick`, the feature is made from those tasks (a group on the Dependencies view, or part of one), and `onDone`
 * gets the board's answer with what joined and what stayed in another feature.
 * @param {{ feature?: Record<string, any>, pick?: { task: Record<string, any>, feature: string | null }[], onDone: (result: any) => void }} props
 */
export function FeatureForm({ feature, pick, onDone }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  // Shape it with an agent (WEB-42): only a new feature with no tasks picked; its brief becomes an idea.
  const canShape = !feature && !pick;
  const [shape, setShape] = useState(false);
  const [repo, setRepo] = useState(repoScope.value ?? '');
  const [repoError, setRepoError] = useState(null);
  const [briefError, setBriefError] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const release = String(f.get('release') ?? '').trim();
    const body = { title: String(f.get('title') ?? '').trim(), brief: String(f.get('brief') ?? '') };
    if (feature) {
      body.release = release;
      body.state = f.get('released') ? 'shipped' : 'open';
    } else {
      body.slug = String(f.get('slug') ?? '').trim();
      // Left out, the board aims a new feature at the release its tasks' tags share.
      if (release) body.release = release;
    }
    if (pick) {
      body.tasks = f.getAll('task').map(String);
      if (!body.tasks.length) {
        setProblem('Pick at least one task for the feature.');
        return;
      }
    }
    if (shape) {
      if (!body.brief.trim()) {
        setBriefError(true);
        e.currentTarget.querySelector('[name="brief"]')?.focus();
        return;
      }
      if (multiRepo.value && !repo) {
        setRepoError('Pick the repository the idea is for.');
        return;
      }
      body.shape = { horizon: String(f.get('horizon') ?? 'auto'), ...(multiRepo.value ? { repo } : {}) };
    }
    setProblem(null);
    setBusy(true);
    if (shape) {
      const made = await actions.shapeFeature(body);
      setBusy(false);
      if (made) onDone(made.slug);
      return;
    }
    if (pick) {
      const made = await actions.featureFromTasks(body);
      setBusy(false);
      if (made) onDone(made);
      return;
    }
    const saved = await actions.saveFeature(feature?.slug ?? null, body, feature ? 'Saved.' : 'Feature added.');
    setBusy(false);
    if (saved) onDone(saved.slug);
  };
  return (
    <form class="sheet" onSubmit={save}>
      <h2 id="fr-form-title">{feature ? `Edit ${feature.title}` : pick ? 'Make a feature' : 'New feature'}</h2>
      {!feature && (
        <label class="field">
          <span class="field-label">Tag</span>
          <input class="input mono" name="slug" required pattern={SLUG} maxLength={40} placeholder="self-update" />
          <span class="field-hint">
            Tasks join the feature by carrying this tag. Lowercase letters, digits, hyphens, and underscores. It can’t
            change later.
          </span>
        </label>
      )}
      <label class="field">
        <span class="field-label">Title</span>
        <input
          class="input"
          name="title"
          maxLength={200}
          required={Boolean(feature)}
          defaultValue={feature?.title ?? ''}
          placeholder={feature ? undefined : 'Made from the tag when left empty'}
        />
      </label>
      <label class="field">
        <span class="field-label">Release</span>
        <input
          class="input mono"
          name="release"
          pattern={RELEASE}
          maxLength={14}
          placeholder="1.2.0"
          defaultValue={feature?.release ?? ''}
        />
        <span class="field-hint">
          The stable release it’s aimed at. Leave it empty to keep it unplanned
          {feature ? '.' : ', or to use the release its tasks’ tags share.'}
        </span>
      </label>
      <label class="field">
        <span class="field-label">Brief</span>
        <Dictate>
          <textarea
            class="textarea"
            name="brief"
            rows={pick ? 3 : 5}
            maxLength={4000}
            defaultValue={feature?.brief ?? ''}
            aria-required={shape ? 'true' : undefined}
            aria-invalid={briefError ? 'true' : undefined}
            aria-describedby={briefError ? 'ff-brief-error' : undefined}
            onInput={() => setBriefError(false)}
          />
        </Dictate>
        {briefError ? (
          <span class="field-error" id="ff-brief-error" role="alert">
            Write the brief first: the agent shapes the feature from it.
          </span>
        ) : (
          <span class="field-hint">
            {shape ? 'What it is and why, in your words. Rough is fine.' : 'What it is and why, in Markdown.'}
          </span>
        )}
      </label>
      {canShape && (
        <>
          <label class="check-row">
            <input
              type="checkbox"
              name="shape"
              checked={shape}
              aria-describedby="ff-shape-hint"
              onChange={(e) => {
                setShape(e.currentTarget.checked);
                setBriefError(false);
              }}
            />
            <span>Shape it with an agent, like an idea</span>
          </label>
          <p class="field-hint" id="ff-shape-hint">
            The board adds the feature and an idea from its brief, and starts an agent on it. The agent writes the tasks
            with this tag, keeps them to the title and brief, and leaves the release to you. You review it all in a pull
            request.
          </p>
          {shape && (
            <>
              <RepoField
                repo={repo}
                setRepo={(slug) => {
                  setRepo(slug);
                  setRepoError(null);
                }}
                error={repoError}
                id="ff-repo"
              />
              <fieldset class="field">
                <legend class="field-label">Horizon for the tasks it makes</legend>
                <div class="check-inline">
                  {SHAPE_HORIZONS.map((h) => (
                    <label key={h.id} class="check-row" title={h.hint}>
                      <input type="radio" name="horizon" value={h.id} defaultChecked={h.id === 'auto'} />
                      {h.label}
                    </label>
                  ))}
                </div>
                <span class="field-hint">
                  Auto lets the agent choose for each task, from what’s already on the board.
                </span>
              </fieldset>
            </>
          )}
        </>
      )}
      {pick && <TaskPicker pick={pick} />}
      {feature && (
        <label class="check-row">
          <input type="checkbox" name="released" defaultChecked={feature.state === 'shipped'} />
          It’s out in its release
        </label>
      )}
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy} aria-busy={busy}>
          {feature ? 'Save' : pick ? 'Make it a feature' : shape ? 'Add and start shaping' : 'Add feature'}
        </button>
      </div>
    </form>
  );
}
