import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { HORIZONS, PRIORITIES, WHO, ref, stateOf } from '../lib/model.js';
import {
  actions,
  areasOfRepo,
  filters,
  hashFor,
  multiRepo,
  newTask,
  openKickoff,
  openTask,
  repoScope,
  repos,
  tasks,
  toast,
} from '../lib/store.js';
import { canDictate } from '../lib/dictation.js';
import { clearDraft, draftOf, fillDraft, readDraft, writeDraft } from '../lib/drafts.js';
import { isImage, MAX_IMAGES, prepareImage } from '../lib/images.js';
import { Dialog, Dictate } from './ui.jsx';
import { ImagePicker, Thumbnails, attachFiles, pastedImages } from './Attachments.jsx';
import { similarTasks } from '../../../src/similar.js';
import { assignable, ensurePeople } from '../lib/people.js';

/** Areas whose tasks are never compared with a new one: an idea is the owner's words, and runs are alike on purpose. */
const NOT_COMPARED = ['ideas', 'routines'];

/** @param {Record<string, any>} props */
function Form({ defaults }) {
  const f = filters.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const draft = useFormDraft('task');
  const open = tasks.value.filter((t) => t.status === 'pending');
  // The draft's repository, else the one the switcher shows, else the default; the areas are that repository's own.
  const [repo, setRepo] = useState(() => {
    const kept = draft.saved?.repo;
    if (typeof kept === 'string' && repos.value.list.some((r) => r.slug === kept)) return kept;
    return defaults.repo ?? repoScope.value ?? repos.value.default;
  });
  const areas = areasOfRepo(repo).filter((a) => !NOT_COMPARED.includes(a.id));
  // The open tasks it resembles (BRK-283), as the title is typed, else the board's list from a refused add.
  const [title, setTitle] = useState(() => String(draft.saved?.description ?? ''));
  const [refused, setRefused] = useState(/** @type {any[] | null} */ (null));
  const [confirmed, setConfirmed] = useState(false);
  const alike =
    refused?.map((r) => open.find((t) => t.uuid === r.uuid) ?? { ...r, status: 'pending', tags: [] }) ??
    similarTasks(
      { description: title },
      open.filter((t) => t.repo === repo && !NOT_COMPARED.includes(t.project)),
    ).map((s) => s.task);
  const wanted = defaults.project ?? (f.areas.length === 1 ? f.areas[0] : 'product');
  const initialArea = areas.some((a) => a.id === wanted) ? wanted : areas[0]?.id;
  // Who does it, and on a person's task who it's for (WEB-133): the assignees are the task's repository's.
  const [who, setWho] = useState(() => (WHO.some((w) => w.id === draft.saved?.who) ? draft.saved.who : 'agent'));
  useEffect(ensurePeople, []);
  const initialHorizon = defaults.horizon ?? (f.horizons.length === 1 ? f.horizons[0] : 'next');

  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const description = String(data.get('description')).trim();
    if (!description) {
      setError('Say what needs doing.');
      return;
    }
    const link = alike.length > 0 && data.get('link_similar') === 'on';
    if (alike.length && !link && !confirmed) {
      setConfirmed(true);
      return;
    }
    setBusy(true);
    const created = await actions.create(
      {
        description,
        project: data.get('project'),
        repo: multiRepo.value ? repo : undefined,
        horizon: data.get('horizon') || undefined,
        priority: data.get('priority') || undefined,
        who: data.get('who') || undefined,
        assignee: (data.get('who') === 'person' && data.get('assignee')) || undefined,
        depends: String(data.get('depends'))
          .split(/[\s,]+/u)
          .filter(Boolean),
        spec: String(data.get('spec')).trim() || undefined,
        brief: String(data.get('brief')).trim() || undefined,
        done_when: String(data.get('done_when')).trim() || undefined,
        related: link ? alike.map((t) => t.uuid) : undefined,
        force: alike.length && !link ? true : undefined,
      },
      {
        onSimilar: (list) => {
          setRefused(list);
          setConfirmed(true);
        },
      },
    );
    setBusy(false);
    if (created) {
      draft.discard();
      newTask.value = null;
      openTask(created);
    }
  };

  return (
    <form class="sheet" onSubmit={submit} noValidate {...draft.form}>
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
          onInput={(e) => {
            setError(null);
            setTitle(e.currentTarget.value);
            setRefused(null);
            setConfirmed(false);
          }}
        />
        {error && (
          <span class="field-error" id="new-error">
            {error}
          </span>
        )}
      </label>
      {alike.length > 0 && <Similar tasks={alike} confirmed={confirmed} />}
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
        <legend class="field-label">Who does it</legend>
        <div class="check-inline">
          {WHO.map((w) => (
            <label key={w.id} class="check-row" title={w.hint}>
              <input
                type="radio"
                name="who"
                value={w.id}
                checked={who === w.id}
                onChange={(e) => e.currentTarget.checked && setWho(w.id)}
              />
              {w.label}
            </label>
          ))}
        </div>
      </fieldset>
      {who === 'person' && (
        <label class="field">
          <span class="field-label">For</span>
          <select key={repo} name="assignee" class="select">
            <option value="">Any member</option>
            {assignable(repo).map((o) => (
              <option key={o.handle} value={o.handle}>
                {o.label}
              </option>
            ))}
          </select>
          <span class="field-hint">Someone who can work in the repository, or leave it for any member to pick up.</span>
        </label>
      )}
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
        <Dictate>
          <textarea name="brief" class="textarea" rows={4} maxLength={10000} placeholder="What it’s for and why" />
        </Dictate>
        <span class="field-hint">The current brief. You can edit it later; comments never change it.</span>
      </label>
      <label class="field">
        <span class="field-label">Done when</span>
        <Dictate>
          <textarea
            name="done_when"
            class="textarea"
            rows={2}
            maxLength={10000}
            placeholder="What has to be true to call it done"
          />
        </Dictate>
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
            draft.discard();
            newTask.value = null;
          }}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : confirmed && alike.length ? 'Add anyway' : 'Add task'}
        </button>
      </div>
    </form>
  );
}

/**
 * The open tasks a new one resembles (BRK-283), before it's added: open one to check, link them as related, or press
 * Add again to add it anyway.
 * @param {Record<string, any>} props
 */
function Similar({ tasks: list, confirmed }) {
  return (
    <div class="field" role="status">
      <span class="field-label">{confirmed ? 'Add it anyway?' : 'Is it one of these?'}</span>
      <span class="field-hint">
        {confirmed
          ? 'These open tasks look like it. Press Add anyway if it’s different, or link them.'
          : 'These open tasks look like it. If it’s one of them, comment there instead.'}
      </span>
      <ul class="dep-list">
        {list.map((t) => (
          <li key={t.uuid} class="dep-row">
            <span class={`state-dot dot-${stateOf(t)}`} aria-hidden="true" />
            <a href={hashFor({ task: ref(t) })}>
              <span class="wid">{ref(t)}</span> {t.description}
            </a>
            {t.claim && <span class="meta">{t.claim} has it</span>}
          </li>
        ))}
      </ul>
      <label class="check-row">
        <input type="checkbox" name="link_similar" />
        Link them as related
      </label>
    </div>
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
      <button
        type="button"
        aria-pressed="false"
        title="Something new, with a repository of its own (Kickoff)"
        onClick={() => {
          newTask.value = null;
          openKickoff(null);
        }}
      >
        Project
      </button>
    </div>
  );
}

/**
 * A form's draft (WEB-84): what was typed is kept as the owner types, put back when the form opens again, and
 * thrown away by `discard()`, which Cancel and a successful submit call. Spread `form` on the `<form>`. `saved` is
 * the draft the form opened with, for the fields the form holds in state.
 * @param {string} key
 */
export function useFormDraft(key) {
  const [saved] = useState(() => readDraft(key));
  const form = useRef(/** @type {HTMLFormElement | null} */ (null));
  useLayoutEffect(() => {
    if (saved && form.current) fillDraft(form.current.elements, saved);
  }, []);
  const keep = () => {
    if (form.current) writeDraft(key, draftOf(form.current.elements));
  };
  return { saved, form: { ref: form, onInput: keep, onChange: keep }, discard: () => clearDraft(key) };
}

/** Images held for a form's draft until it's sent or cancelled, by the form's draft key. They last until a reload. */
const heldImages = new Map();

/**
 * Images a form holds until its task exists: picked, dropped, or pasted, shrunk in the browser, up to
 * MAX_IMAGES. `dropZone(className)` gives the form's class and its drop and paste handlers. With a `key`, they
 * stay when the form closes and come back when it opens, until `discard()`.
 * @param {string} [key]
 */
export function useDraftImages(key) {
  const [images, setImages] = useState(() => (key && heldImages.get(key)) || []);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!key) return;
    if (images.length) heldImages.set(key, images);
    else heldImages.delete(key);
  }, [key, images]);
  const discard = () => {
    for (const i of images) URL.revokeObjectURL(i.url);
    if (key) heldImages.delete(key);
  };
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
  const dropZone = (className) => ({
    class: `${className} ${over ? 'attach-over' : ''}`,
    onDragOver: (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      e.preventDefault();
      setOver(false);
      pick([...e.dataTransfer.files]);
    },
    onPaste: (e) => {
      const files = pastedImages(e);
      if (files.length) {
        e.preventDefault();
        pick(files);
      }
    },
  });
  return { images, pick, drop, dropZone, discard };
}

/** Uploads a form's images to the task it made, with a toast when some don't attach. */
export async function uploadDraftImages(task, images, failed) {
  if (!images.length) return;
  const sent = await attachFiles(
    task.uuid,
    images.map((i) => new File([i.blob], i.name, { type: i.blob.type })),
  );
  if (sent.length < images.length) toast(failed, 'error');
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

export const IDEA_HORIZONS = [
  ...HORIZONS,
  { id: 'auto', label: 'Auto', hint: 'The agent chooses a horizon for each task' },
];

/**
 * The repository an idea (or a new agent) is for: preset to the one in scope, and with every repository in scope
 * empty and required. A board with one repository shows nothing. Pass the same `repo`/`setRepo` pair to the form.
 * `unavailable` says why a repository can't be picked (shown, but not pickable), or null when it can.
 * @param {{ repo: string, setRepo: (slug: string) => void, error?: string | null, id?: string, unavailable?: (slug: string) => string | null }} props
 */
export function RepoField({ repo, setRepo, error, id = 'idea-repo', unavailable = () => null }) {
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
        {repos.value.list.map((r) => {
          const why = unavailable(r.slug);
          return (
            <option key={r.slug} value={r.slug} disabled={Boolean(why)}>
              {why ? `${r.name} (${why})` : r.name}
            </option>
          );
        })}
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
  const draft = useFormDraft('idea');
  const [repo, setRepo] = useState(() => {
    const kept = draft.saved?.repo;
    return typeof kept === 'string' && repos.value.list.some((r) => r.slug === kept) ? kept : (repoScope.value ?? '');
  });
  const [repoError, setRepoError] = useState(null);
  // Images wait in the form (already shrunk) and go up once the idea has its work ID.
  const { images, pick, drop, dropZone, discard } = useDraftImages('idea');

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
      who: 'agent',
      tags: ['idea', `horizon-${data.get('horizon')}`],
      autostart: data.get('autostart') ? 'yes' : undefined,
      brief: idea,
    });
    if (created) await uploadDraftImages(created, images, 'Some images didn’t attach. Add them again from the idea.');
    setBusy(false);
    if (created) {
      discard();
      draft.discard();
      newTask.value = null;
      openTask(created);
    }
  };

  return (
    <form {...dropZone('sheet')} onSubmit={submit} noValidate {...draft.form}>
      <h2 id="new-title">New idea</h2>
      <ModeSwitch mode="idea" />
      <label class="field">
        <span class="field-label">Your idea</span>
        <Dictate>
          <textarea
            name="idea"
            class="textarea"
            rows={7}
            maxLength={4000}
            autoFocus
            aria-describedby={error ? 'idea-error idea-hint' : 'idea-hint'}
            onInput={() => setError(null)}
          />
        </Dictate>
        {error && (
          <span class="field-error" id="idea-error">
            {error}
          </span>
        )}
        <span class="field-hint" id="idea-hint">
          Rough is fine{canDictate ? ', and you can say it instead of typing: press the microphone.' : '.'} An agent
          turns it into tasks with an area, a horizon and what they wait for, and writes a spec if it needs one. You
          review all of it in a pull request.
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
            discard();
            draft.discard();
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
