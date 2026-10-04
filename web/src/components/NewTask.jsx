import { useState } from 'preact/hooks';
import { HORIZONS, PRIORITIES, ROLES, ref } from '../lib/model.js';
import {
  actions,
  areasOfRepo,
  filters,
  multiRepo,
  newTask,
  openTask,
  repoScope,
  repos,
  tasks,
  toast,
} from '../lib/store.js';
import { isImage, MAX_IMAGES, prepareImage } from '../lib/images.js';
import { Dialog } from './ui.jsx';
import { ImagePicker, Thumbnails, attachFiles, pastedImages } from './Attachments.jsx';

/** @param {Record<string, any>} props */
function Form({ defaults }) {
  const f = filters.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = tasks.value.filter((t) => t.status === 'pending');
  // The repository the switcher shows, else the default; the areas are that repository's own.
  const [repo, setRepo] = useState(defaults.repo ?? repoScope.value ?? repos.value.default);
  const areas = areasOfRepo(repo).filter((a) => !['ideas', 'routines'].includes(a.id));
  const wanted = defaults.project ?? (f.areas.length === 1 ? f.areas[0] : 'product');
  const initialArea = areas.some((a) => a.id === wanted) ? wanted : areas[0]?.id;
  const initialHorizon = defaults.horizon ?? (f.horizons.length === 1 ? f.horizons[0] : 'next');

  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const description = String(data.get('description')).trim();
    if (!description) {
      setError('Say what needs doing.');
      return;
    }
    setBusy(true);
    const created = await actions.create({
      description,
      project: data.get('project'),
      repo: multiRepo.value ? repo : undefined,
      horizon: data.get('horizon') || undefined,
      priority: data.get('priority') || undefined,
      tags: data.getAll('tags'),
      depends: String(data.get('depends'))
        .split(/[\s,]+/u)
        .filter(Boolean),
      spec: String(data.get('spec')).trim() || undefined,
      brief: String(data.get('brief')).trim() || undefined,
      done_when: String(data.get('done_when')).trim() || undefined,
    });
    setBusy(false);
    if (created) {
      newTask.value = null;
      openTask(created);
    }
  };

  return (
    <form class="sheet" onSubmit={submit} noValidate>
      <h2 id="new-title">New task</h2>
      <ModeSwitch mode="task" />
      <label class="field">
        <span class="field-label">What needs doing</span>
        <input
          name="description"
          class="input"
          maxLength={300}
          autoFocus
          aria-describedby={error ? 'new-error' : undefined}
          onInput={() => setError(null)}
        />
        {error && (
          <span class="field-error" id="new-error">
            {error}
          </span>
        )}
      </label>
      {multiRepo.value && (
        <label class="field">
          <span class="field-label">Repository</span>
          <select name="repo" class="select" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
            {repos.value.list.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
          <span class="field-hint">A task stays in its repository. It can still wait for tasks in another.</span>
        </label>
      )}
      <div class="field-row">
        <label class="field">
          <span class="field-label">Area</span>
          <select key={repo} name="project" class="select">
            {areas.map((a) => (
              <option key={a.id} value={a.id} selected={a.id === initialArea}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Horizon</span>
          <select name="horizon" class="select">
            {HORIZONS.map((h) => (
              <option key={h.id} value={h.id} selected={h.id === initialHorizon}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Priority</span>
          <select name="priority" class="select">
            <option value="">None</option>
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset class="field">
        <legend class="field-label">Who can move it</legend>
        <div class="check-inline">
          {ROLES.map((r) => (
            <label key={r.id} class="check-row" title={r.hint}>
              <input type="checkbox" name="tags" value={r.id} defaultChecked={r.id === 'agent'} />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label class="field">
        <span class="field-label">Waits for</span>
        <input
          name="depends"
          class="input"
          list="new-dep-options"
          placeholder="Work IDs, like OPS-12, PRD-10"
          autocomplete="off"
        />
        <datalist id="new-dep-options">
          {open.map((o) => (
            <option key={o.uuid} value={ref(o)}>
              {o.description}
            </option>
          ))}
        </datalist>
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <textarea name="brief" class="textarea" rows={4} maxLength={10000} placeholder="What it’s for and why" />
        <span class="field-hint">The current brief. You can edit it later; comments never change it.</span>
      </label>
      <label class="field">
        <span class="field-label">Done when</span>
        <textarea
          name="done_when"
          class="textarea"
          rows={2}
          maxLength={10000}
          placeholder="What has to be true to call it done"
        />
      </label>
      <label class="field">
        <span class="field-label">Spec</span>
        <input name="spec" class="input" placeholder="docs/specs/… (optional)" />
      </label>
      <div class="sheet-actions">
        <button
          type="button"
          class="btn btn-quiet"
          onClick={() => {
            newTask.value = null;
          }}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add task'}
        </button>
      </div>
    </form>
  );
}

/** @param {Record<string, any>} props */
function ModeSwitch({ mode }) {
  const pick = (next) => {
    if (next !== mode) newTask.value = next === 'idea' ? { mode: 'idea' } : {};
  };
  return (
    <div class="segmented" role="group" aria-label="What are you adding?">
      <button type="button" aria-pressed={mode === 'task'} onClick={() => pick('task')}>
        Task
      </button>
      <button type="button" aria-pressed={mode === 'idea'} onClick={() => pick('idea')}>
        Idea
      </button>
    </div>
  );
}

/** The first line of an idea, kept short, as the title of its task. */
export function ideaTitle(text) {
  const line =
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

const IDEA_HORIZONS = [...HORIZONS, { id: 'auto', label: 'Auto', hint: 'The agent chooses a horizon for each task' }];

/**
 * The repository an idea (or a new agent) is for: preset to the one in scope, and with every repository in scope
 * empty and required. A board with one repository shows nothing. Pass the same `repo`/`setRepo` pair to the form.
 * @param {{ repo: string, setRepo: (slug: string) => void, error?: string | null, id?: string }} props
 */
export function RepoField({ repo, setRepo, error, id = 'idea-repo' }) {
  if (!multiRepo.value) return null;
  return (
    <label class="field">
      <span class="field-label">Repository</span>
      <select
        name="repo"
        class="select"
        value={repo}
        aria-required="true"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => setRepo(e.currentTarget.value)}
      >
        <option value="">Pick a repository</option>
        {repos.value.list.map((r) => (
          <option key={r.slug} value={r.slug}>
            {r.name}
          </option>
        ))}
      </select>
      {error && (
        <span class="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}

function IdeaForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [repo, setRepo] = useState(repoScope.value ?? '');
  const [repoError, setRepoError] = useState(null);
  const [images, setImages] = useState([]);
  const [over, setOver] = useState(false);

  // Images wait in the form (already shrunk) and go up once the idea has its work ID.
  const pick = async (files) => {
    for (const file of files.filter(isImage).slice(0, Math.max(MAX_IMAGES - images.length, 0))) {
      try {
        const { blob, name } = await prepareImage(file);
        setImages((list) =>
          list.length >= MAX_IMAGES ? list : [...list, { blob, name, alt: '', url: URL.createObjectURL(blob) }],
        );
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  };
  const drop = (image) => {
    URL.revokeObjectURL(image.url);
    setImages((list) => list.filter((i) => i !== image));
  };

  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const idea = String(data.get('idea')).trim();
    if (!idea) {
      setError('Write the idea first, rough is fine.');
      return;
    }
    if (multiRepo.value && !repo) {
      setRepoError('Pick the repository this idea is for.');
      return;
    }
    setBusy(true);
    // Auto-start and the horizon are the owner's choices, made here and nowhere else: the agent never changes them.
    const created = await actions.create({
      description: ideaTitle(idea),
      project: 'ideas',
      repo: multiRepo.value ? repo : undefined,
      horizon: 'now',
      tags: ['agent', 'idea', `horizon-${data.get('horizon')}`],
      autostart: data.get('autostart') ? 'yes' : undefined,
      brief: idea,
    });
    if (created && images.length) {
      const sent = await attachFiles(
        ref(created),
        images.map((i) => new File([i.blob], i.name, { type: i.blob.type })),
      );
      if (sent.length < images.length) toast('Some images didn’t attach. Add them again from the idea.', 'error');
    }
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setBusy(false);
    if (created) {
      newTask.value = null;
      openTask(created);
    }
  };

  return (
    <form
      class={`sheet ${over ? 'attach-over' : ''}`}
      onSubmit={submit}
      noValidate
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick([...e.dataTransfer.files]);
      }}
      onPaste={(e) => {
        const files = pastedImages(e);
        if (files.length) {
          e.preventDefault();
          pick(files);
        }
      }}
    >
      <h2 id="new-title">New idea</h2>
      <ModeSwitch mode="idea" />
      <label class="field">
        <span class="field-label">Your idea</span>
        <textarea
          name="idea"
          class="textarea"
          rows={7}
          maxLength={4000}
          autoFocus
          aria-describedby={error ? 'idea-error idea-hint' : 'idea-hint'}
          onInput={() => setError(null)}
        />
        {error && (
          <span class="field-error" id="idea-error">
            {error}
          </span>
        )}
        <span class="field-hint" id="idea-hint">
          Rough is fine. An agent turns it into tasks with an area, a horizon and what they wait for, and writes a spec
          if it needs one. You review all of it in a pull request.
        </span>
      </label>
      <RepoField
        repo={repo}
        setRepo={(slug) => {
          setRepo(slug);
          setRepoError(null);
        }}
        error={repoError}
      />
      <div class="field">
        <span class="field-label">Images</span>
        <Thumbnails images={images} onRemove={drop} />
        <div class="attach-actions">
          <ImagePicker
            onFiles={pick}
            disabled={busy || images.length >= MAX_IMAGES}
            full={images.length >= MAX_IMAGES}
          />
        </div>
      </div>
      <fieldset class="field">
        <legend class="field-label">Horizon for the tasks it makes</legend>
        <div class="check-inline">
          {IDEA_HORIZONS.map((h) => (
            <label key={h.id} class="check-row" title={h.hint}>
              <input type="radio" name="horizon" value={h.id} defaultChecked={h.id === 'auto'} />
              {h.label}
            </label>
          ))}
        </div>
        <span class="field-hint">Auto lets the agent choose for each task, from what’s already on the board.</span>
      </fieldset>
      <label class="check-row" title="Off: the idea waits on the board until you start its agent yourself.">
        <input type="checkbox" name="autostart" defaultChecked />
        <span>Start its agent as soon as there’s room</span>
      </label>
      <p class="field-hint">
        Off, the idea waits until you start its agent. Either way, the agent never turns this on for the tasks it makes.
      </p>
      <div class="sheet-actions">
        <button
          type="button"
          class="btn btn-quiet"
          onClick={() => {
            newTask.value = null;
          }}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save idea'}
        </button>
      </div>
    </form>
  );
}

export function NewTaskDialog() {
  return (
    <Dialog
      open={Boolean(newTask.value)}
      onClose={() => {
        newTask.value = null;
      }}
      labelledBy="new-title"
    >
      {newTask.value && (newTask.value.mode === 'idea' ? <IdeaForm /> : <Form defaults={newTask.value} />)}
    </Dialog>
  );
}
