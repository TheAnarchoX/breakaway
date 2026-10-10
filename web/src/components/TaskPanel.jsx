import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  ExternalLink,
  Hand,
  Link2,
  Maximize2,
  PanelRight,
  RotateCcw,
  Rocket,
  ScrollText,
  Terminal,
  Trash2,
  Undo2,
  X,
  TriangleAlert,
} from 'lucide-preact';
import {
  HORIZONS,
  PICKS_AREA,
  PRIORITIES,
  ago,
  dateInput,
  day,
  isStale,
  picksArea,
  prLabel,
  prUrl,
  ref,
  shipState,
  shortVersion,
  specUrl,
  stateOf,
} from '../lib/model.js';
import {
  actions,
  areasOfRepo,
  byUuid,
  closeTask,
  multiRepo,
  repoBySlug,
  repos,
  confirmDialog,
  current,
  focusComment,
  hashFor,
  loaded,
  me,
  navOrder,
  openTask,
  releaseOther,
  selected,
  setTaskMode,
  tasks,
  toast,
} from '../lib/store.js';
import { Popover, RepoChip, StateBadge, useAutosize, widClass, Dictate } from './ui.jsx';
import { RichText, Title } from '../lib/richtext.jsx';
import { copy } from '../lib/clipboard.js';
import { inSpecsDir, specsDirOf } from '../lib/specs.js';
import { PrRow } from './GitHub.jsx';
import { AgentSection } from './Agents.jsx';
import { DecisionSection } from './Decision.jsx';
import { AttachmentsSection } from './Attachments.jsx';
import { FeatureSection } from './Feature.jsx';
import { IncidentSection } from './Incidents.jsx';
import { RunEventLine } from './InfraEvents.jsx';
import { ShortLivedSection } from './ShortLived.jsx';
import { FootprintSection } from './Footprint.jsx';
import { WhoField } from './Who.jsx';

const TAG = /^[A-Za-z][\w-]*$/u;

/**
 * A text field that saves when you leave it or press Enter, and goes back on Escape.
 * @param {Record<string, any>} props
 */
function InlineText({ value, onSave, label, placeholder, type = 'text', multiline = false, className = '' }) {
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef(null);
  useEffect(() => setDraft(value ?? ''), [value]);
  useAutosize(multiline ? ref : { current: null }, draft);
  const save = () => {
    const next = draft.trim();
    if (next !== (value ?? '')) onSave(next);
  };
  const props = {
    ref,
    class: `${multiline ? 'textarea' : 'input'} input-inline ${className}`,
    value: draft,
    placeholder,
    'aria-label': label,
    onInput: (e) => setDraft(e.currentTarget.value),
    onBlur: save,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.currentTarget.blur();
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDraft(value ?? '');
        requestAnimationFrame(() => e.target.blur());
      }
    },
  };
  return multiline ? <textarea rows={1} {...props} /> : <input type={type} {...props} />;
}

/** @param {Record<string, any>} props */
function Field({ label, children, id }) {
  return (
    <div class="fact">
      <dt id={id}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Actions({ task: t }) {
  const state = stateOf(t);
  const mine = t.claim === me.value;
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${ref(t)}?`,
      body: 'It leaves the board and every Taskwarrior replica after their next sync. Its work ID isn’t used again.',
      confirmLabel: 'Delete task',
      tone: 'danger',
    });
    if (ok && (await actions.remove(t))) closeTask();
  };
  return (
    <div class="panel-actions">
      {state === 'done' ? (
        <button type="button" class="btn btn-outline btn-sm" onClick={() => actions.reopen(t)}>
          <RotateCcw size={16} aria-hidden="true" />
          Open again
        </button>
      ) : (
        <>
          {!t.claim && !t.blocked && (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => actions.claim(t)}>
              <Hand size={16} aria-hidden="true" />
              Claim as {me.value}
            </button>
          )}
          {t.claim && mine && (
            <button type="button" class="btn btn-outline btn-sm" onClick={() => actions.release(t)}>
              <Undo2 size={16} aria-hidden="true" />
              Release
            </button>
          )}
          {t.claim && !mine && (
            <button type="button" class="btn btn-outline btn-sm" onClick={() => releaseOther(t)}>
              <Undo2 size={16} aria-hidden="true" />
              Release {t.claim}’s claim
            </button>
          )}
          <button type="button" class="btn btn-accent btn-sm" onClick={() => actions.done(t)}>
            <CircleCheck size={16} aria-hidden="true" />
            Mark done
          </button>
        </>
      )}
      <Popover label="More" buttonClass="btn btn-quiet btn-sm" align="end">
        {(close) => (
          <div class="menu" role="group" aria-label="More actions">
            <button
              type="button"
              onClick={() => {
                close();
                copy(`${location.origin}/${hashFor({ task: ref(t), view: 'board' })}`, 'Link');
              }}
            >
              <Link2 size={16} aria-hidden="true" />
              Copy link
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                copy(t.wid ? `task wid:${t.wid} info` : `task ${t.uuid} info`, 'Taskwarrior command');
              }}
            >
              <Terminal size={16} aria-hidden="true" />
              Copy Taskwarrior command
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                copy(t.uuid, 'UUID');
              }}
            >
              <Copy size={16} aria-hidden="true" />
              Copy UUID
            </button>
            <button
              type="button"
              class="menu-danger"
              onClick={() => {
                close();
                remove();
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              Delete task
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Tags({ task: t }) {
  const [draft, setDraft] = useState('');
  const add = (e) => {
    e.preventDefault();
    const tag = draft.trim().replace(/^\+/u, '');
    if (!tag) return;
    if (!TAG.test(tag)) {
      toast('Tags are letters, digits, - and _, starting with a letter.', 'error');
      return;
    }
    setDraft('');
    actions.update(t, { addTags: [tag] }, `Tagged +${tag}.`);
  };
  return (
    <div class="tags-editor">
      {t.tags.map((tag) => (
        <span key={tag} class="chip">
          +{tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => actions.update(t, { removeTags: [tag] }, null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      ))}
      <form class="chip-add" onSubmit={add}>
        <input
          class="input input-sm"
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="Add a tag"
          aria-label="Add a tag"
        />
      </form>
    </div>
  );
}

/**
 * Where a task's spec opens on the board (WEB-25): the Specs view, when the path is in its repository's specs
 * directory, else null and the spec opens on GitHub only.
 */
function specHere(t) {
  const slug = t.repo || repos.value.default;
  const path = String(t.spec ?? '').replace(/^(?:\.\/|\/)+/u, '');
  if (!t.spec || !inSpecsDir(specsDirOf(repoBySlug.value.get(slug)), path)) return null;
  return hashFor({ view: 'specs', spec: { slug, path }, task: null, pr: null, ping: null });
}

/** @param {Record<string, any>} props */
function TaskLink({ uuid, onRemove, removeLabel = 'Stop waiting for' }) {
  const d = byUuid.value.get(uuid);
  if (!d) return <li class="dep-row muted">A task that’s gone ({uuid.slice(0, 8)})</li>;
  return (
    <li class="dep-row">
      <span class={`state-dot dot-${stateOf(d)}`} aria-hidden="true" />
      <a href={hashFor({ task: ref(d) })}>
        <span class="wid">{ref(d)}</span> <Title text={d.description} />
      </a>
      {d.status === 'completed' && <span class="meta">done</span>}
      {onRemove && (
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          aria-label={`${removeLabel} ${ref(d)}`}
          onClick={onRemove}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/** @param {Record<string, any>} props */
function Dependencies({ task: t }) {
  const [draft, setDraft] = useState('');
  const listId = `dep-options-${t.uuid}`;
  const options = tasks.value.filter((o) => o.uuid !== t.uuid && o.status === 'pending' && !t.depends.includes(o.uuid));
  const add = (e) => {
    e.preventDefault();
    const value = draft.trim().split(/\s/u)[0];
    if (!value) return;
    setDraft('');
    actions.update(t, { addDepends: [value] }, `${ref(t)} now waits for ${value.toUpperCase()}.`);
  };
  return (
    <section class="panel-section" aria-labelledby={`deps-${t.uuid}`}>
      <h3 id={`deps-${t.uuid}`}>Waits for</h3>
      {t.depends.length ? (
        <ul class="dep-list">
          {t.depends.map((u) => (
            <TaskLink key={u} uuid={u} onRemove={() => actions.update(t, { removeDepends: [u] }, null)} />
          ))}
        </ul>
      ) : (
        <p class="muted small">Nothing. It can start any time.</p>
      )}
      <form class="dep-add" onSubmit={add}>
        <input
          class="input input-sm"
          list={listId}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="Add a task it waits for, like OPS-12"
          aria-label="Add a task it waits for"
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o.uuid} value={ref(o)}>
              {o.description}
            </option>
          ))}
        </datalist>
        <button type="submit" class="btn btn-outline btn-sm">
          Add
        </button>
      </form>
      {t.blocking.length > 0 && (
        <>
          <h3>Holds up</h3>
          <ul class="dep-list">
            {t.blocking.map((u) => (
              <TaskLink key={u} uuid={u} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Markdown text that is edited in place (the description, done when) and says who wrote it last.
 * @param {Record<string, any>} props
 */
function Brief({ task: t, field, label, empty, by, rows = 6, preview = false }) {
  const value = t[field] ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const area = useRef(null);
  const edit = useRef(null);
  useAutosize(area, draft);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const id = `${field}-${t.uuid}`;
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => edit.current?.focus());
  };
  const save = async (e) => {
    e?.preventDefault();
    const next = draft.trim();
    if (next === value.trim()) return close();
    const key = field === 'brief' ? 'brief' : 'done_when';
    if (await actions.update(t, { [key]: next || null }, `${label} saved.`)) close();
  };
  return (
    <section class="panel-section" aria-labelledby={`${id}-h`}>
      <div class="section-head">
        <h3 id={`${id}-h`}>{label}</h3>
        {!editing && (
          <button type="button" ref={edit} class="btn btn-quiet btn-sm" onClick={() => setEditing(true)}>
            {value ? 'Edit' : 'Add'}
            <span class="visually-hidden"> {label.toLowerCase()}</span>
          </button>
        )}
      </div>
      {editing ? (
        <form class="note-add" onSubmit={save}>
          <label class="visually-hidden" for={id}>
            {label}
          </label>
          <div class={preview ? 'brief-split' : ''}>
            <Dictate>
              <textarea
                id={id}
                ref={area}
                class="textarea brief-input"
                rows={rows}
                maxLength={10000}
                value={draft}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(e);
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setDraft(value);
                    close();
                  }
                }}
              />
            </Dictate>
            {preview && (
              <div class="brief-preview" aria-label={`Preview of the ${label.toLowerCase()}`} role="group">
                <span class="meta">Preview</span>
                {draft.trim() ? <RichText text={draft} /> : <p class="muted small">Nothing to preview yet.</p>}
              </div>
            )}
          </div>
          <div class="note-actions">
            <span class="meta">Ctrl + Enter saves it</span>
            <span class="row-gap">
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => {
                  setDraft(value);
                  close();
                }}
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary btn-sm">
                Save
              </button>
            </span>
          </div>
        </form>
      ) : value ? (
        <RichText text={value} />
      ) : (
        <p class="muted small">{empty}</p>
      )}
      {!editing && value && by !== undefined && (
        <p class="meta">{by ? `Last edited by ${by === '?' ? 'someone' : by}.` : 'Author unknown.'}</p>
      )}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Related({ task: t }) {
  const [draft, setDraft] = useState('');
  const listId = `rel-options-${t.uuid}`;
  const back = tasks.value.filter((o) => o.related?.includes(t.uuid) && !t.related.includes(o.uuid)).map((o) => o.uuid);
  const options = tasks.value.filter((o) => o.uuid !== t.uuid && !t.related.includes(o.uuid) && o.status !== 'deleted');
  const add = (e) => {
    e.preventDefault();
    const value = draft.trim().split(/\s/u)[0];
    if (!value) return;
    setDraft('');
    actions.update(t, { addRelated: [value] }, `${ref(t)} now links to ${value.toUpperCase()}.`);
  };
  return (
    <section class="panel-section" aria-labelledby={`rel-${t.uuid}`}>
      <h3 id={`rel-${t.uuid}`}>Related</h3>
      {t.related.length || back.length ? (
        <ul class="dep-list">
          {t.related.map((u) => (
            <TaskLink
              key={u}
              uuid={u}
              onRemove={() => actions.update(t, { removeRelated: [u] }, null)}
              removeLabel="Stop linking"
            />
          ))}
          {back.map((u) => (
            <TaskLink key={u} uuid={u} />
          ))}
        </ul>
      ) : (
        <p class="muted small">Nothing linked. Related tasks don’t block each other.</p>
      )}
      <form class="dep-add" onSubmit={add}>
        <input
          class="input input-sm"
          list={listId}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="Link a task, like OPS-12"
          aria-label="Link a related task"
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o.uuid} value={ref(o)}>
              {o.description}
            </option>
          ))}
        </datalist>
        <button type="submit" class="btn btn-outline btn-sm">
          Link
        </button>
      </form>
    </section>
  );
}

function authorLabel(by) {
  if (by === null) return 'Earlier note';
  if (by === 'board') return 'The board';
  if (by.startsWith('routine:')) return `Routine ${by.slice(8)}`;
  return by;
}

/** Where the owner's words came from, as the section says it (BRK-284). */
function saidSource(q) {
  const [kind, ...rest] = String(q.from ?? 'board').split(' ');
  const where =
    {
      board: 'on this task',
      message: 'in a message',
      peloton: 'on the peloton',
      ping: 'answering a ping',
      decision: 'in a decision',
      comment: 'in a comment',
    }[kind] ?? kind;
  const pointer = rest.length ? ` (${rest.join(' ')})` : '';
  const who = q.by === 'owner' ? 'You' : kind === 'board' ? q.by : `Quoted by ${q.by}`;
  return `${who}, ${where}${pointer} · ${day(q.at)}`;
}

/**
 * The owner's words, quoted (BRK-284): first on the task, and handed to every agent that picks it up before the
 * description. Shown only when the task has some; Keep for agents under the owner's comments adds them.
 * @param {Record<string, any>} props
 */
function OwnerSaid({ task: t }) {
  const said = t.ownerSaid ?? [];
  if (!said.length) return null;
  return (
    <section class="panel-section" aria-labelledby={`said-${t.uuid}`}>
      <h3 id={`said-${t.uuid}`}>You said</h3>
      <p class="meta">Every agent that picks this task up reads these first.</p>
      <ol class="notes">
        {said.map((q) => (
          <li key={q.id} class="note said">
            <blockquote class="said-quote">
              <RichText text={q.text} />
            </blockquote>
            <span class="meta said-meta">
              <span>{saidSource(q)}</span>
              <button type="button" class="btn btn-quiet btn-sm" onClick={() => actions.unquote(t, q)}>
                Remove<span class="visually-hidden"> this quote</span>
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** @param {Record<string, any>} props */
function Comments({ task: t }) {
  const [draft, setDraft] = useState('');
  const [hideBoard, setHideBoard] = useState(false);
  const area = useRef(null);
  useAutosize(area, draft);
  const board = t.comments.filter((c) => c.by === 'board').length;
  const shown = hideBoard ? t.comments.filter((c) => c.by !== 'board') : t.comments;
  const submit = async (e) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await actions.comment(t, text)) setDraft('');
  };
  return (
    <section class="panel-section" aria-labelledby={`comments-${t.uuid}`}>
      <div class="section-head">
        <h3 id={`comments-${t.uuid}`}>Comments</h3>
        {board > 0 && (
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            aria-pressed={hideBoard}
            onClick={() => setHideBoard(!hideBoard)}
          >
            {hideBoard ? `Show ${board} from the board` : 'Hide the board’s'}
          </button>
        )}
      </div>
      {shown.length ? (
        <ol class="notes">
          {shown.map((c, i) => (
            <li key={`${c.at}-${i}`} class={`note ${c.by === 'board' ? 'note-board' : ''}`}>
              <span class="meta">
                <strong class="note-by">{authorLabel(c.by)}</strong> ·{' '}
                <time dateTime={c.at} title={c.at}>
                  {day(c.at)}
                </time>
              </span>
              <RichText text={c.text} />
              {c.by === 'owner' &&
                t.status === 'pending' &&
                !(t.ownerSaid ?? []).some((q) => q.text === c.text.trim()) && (
                  <button type="button" class="btn btn-quiet btn-sm note-keep" onClick={() => actions.quote(t, c.text)}>
                    Keep for agents
                  </button>
                )}
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted small">No comments yet.</p>
      )}
      <form class="note-add" onSubmit={submit}>
        <label class="visually-hidden" for={`comment-${t.uuid}`}>
          Add a comment
        </label>
        <Dictate>
          <textarea
            id={`comment-${t.uuid}`}
            ref={area}
            class="textarea"
            rows={2}
            value={draft}
            placeholder="What happened, what you found, what’s next"
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
        </Dictate>
        <div class="note-actions">
          <span class="meta">Ctrl + Enter adds it</span>
          <button type="submit" class="btn btn-outline btn-sm" disabled={!draft.trim()}>
            Add comment
          </button>
        </div>
      </form>
    </section>
  );
}

/** @param {Record<string, any>} props */
function Details({ task: t }) {
  const save = (changes, message = null) => actions.update(t, changes, message);
  return (
    <dl class="facts">
      {multiRepo.value && (
        <Field label="Repository">
          <span title={repoBySlug.value.get(t.repo)?.github}>{repoBySlug.value.get(t.repo)?.name ?? t.repo}</span>
        </Field>
      )}
      <Field label="Area" id={`area-${t.uuid}`}>
        <select
          class="select select-sm"
          aria-labelledby={`area-${t.uuid}`}
          value={t.project ?? ''}
          onChange={(e) => save({ project: e.currentTarget.value || null })}
        >
          <option value="">None</option>
          {areasOfRepo(t.repo).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {picksArea(t) && <span class="meta area-pending">{PICKS_AREA}, and its work ID comes with it.</span>}
      </Field>
      <Field label="Horizon" id={`horizon-${t.uuid}`}>
        <select
          class="select select-sm"
          aria-labelledby={`horizon-${t.uuid}`}
          value={t.horizon ?? ''}
          onChange={(e) => save({ horizon: e.currentTarget.value || null })}
        >
          <option value="">None</option>
          {HORIZONS.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Priority" id={`priority-${t.uuid}`}>
        <select
          class="select select-sm"
          aria-labelledby={`priority-${t.uuid}`}
          value={t.priority ?? ''}
          onChange={(e) => save({ priority: e.currentTarget.value || null })}
        >
          <option value="">None</option>
          {PRIORITIES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Who does it">
        <WhoField task={t} />
      </Field>
      <Field label="Tags">
        <Tags task={t} />
      </Field>
      <Field label="Due" id={`due-${t.uuid}`}>
        <input
          type="date"
          class="input input-sm"
          aria-labelledby={`due-${t.uuid}`}
          value={dateInput(t.due)}
          onChange={(e) => save({ due: e.currentTarget.value || null })}
        />
      </Field>
      <Field label="Wait until" id={`wait-${t.uuid}`}>
        <input
          type="date"
          class="input input-sm"
          aria-labelledby={`wait-${t.uuid}`}
          value={dateInput(t.wait)}
          onChange={(e) => save({ wait: e.currentTarget.value || null })}
        />
      </Field>
      <Field label="Spec">
        <div class="with-link">
          <InlineText
            value={t.spec}
            label="Spec path"
            placeholder="docs/specs/…"
            onSave={(v) => save({ spec: v || null }, 'Spec saved.')}
          />
          {specHere(t) && (
            <a class="btn btn-quiet btn-icon btn-sm" href={specHere(t)} aria-label="Read the spec on the board">
              <ScrollText size={16} aria-hidden="true" />
            </a>
          )}
          {specUrl(t.spec) && (
            <a
              class="btn btn-quiet btn-icon btn-sm"
              href={specUrl(t.spec)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open the spec on GitHub"
            >
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          )}
        </div>
      </Field>
      <Field label="Pull request">
        <div class="with-link">
          <InlineText
            value={t.pr}
            label="Pull request number or link"
            placeholder="Number or link"
            onSave={(v) => save({ pr: v || null }, 'Pull request saved.')}
          />
          {prUrl(t.pr) && (
            <a class="btn btn-quiet btn-sm" href={prUrl(t.pr)} target="_blank" rel="noopener noreferrer">
              {prLabel(t.pr)}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      </Field>
    </dl>
  );
}

/** @param {Record<string, any>} props */
function Shipping({ task: t }) {
  const ships = [...(t.ships ?? [])].sort((a, b) =>
    a.stage === b.stage ? String(a.at).localeCompare(b.at) : a.stage === 'staging' ? -1 : 1,
  );
  const state = shipState(t);
  const note = {
    staged: 'On staging, not live yet.',
    unshipped: "Merged, but staging doesn't run it yet.",
    nodeploy: 'Merged. It only changes docs, skills, or CI, so it needs no deploy.',
  }[state];
  if (!ships.length && !note) return null;
  return (
    <section class="panel-section" aria-labelledby={`ship-${t.uuid}`}>
      <h3 id={`ship-${t.uuid}`}>Deployment</h3>
      <dl class="facts">
        {ships.map((x) => (
          <div key={x.env} class="fact fact-top">
            <dt>
              <Rocket size={14} aria-hidden="true" />
              {x.stage === 'staging' ? 'Staging' : 'Live'}
            </dt>
            <dd>
              <span class="ship-main">
                <code>{shortVersion(x)}</code> <span class="meta">{ago(x.at)}</span>
              </span>
              <span class="ship-detail meta">
                commit <code>{x.sha.slice(0, 7)}</code>
                {x.mergeSha && x.mergeSha !== x.sha ? (
                  <>
                    , merged as <code>{x.mergeSha.slice(0, 7)}</code>
                  </>
                ) : null}
                {x.tag ? (
                  <>
                    , release <code>{x.tag}</code>
                  </>
                ) : null}
                {x.run ? (
                  <>
                    {' '}
                    ·{' '}
                    <a href={x.run} target="_blank" rel="noopener noreferrer">
                      view run
                    </a>
                  </>
                ) : null}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {note && <p class="meta ship-note">{note}</p>}
    </section>
  );
}

/** @param {Record<string, any>} props */
function PullRequests({ task: t }) {
  if (!t.github?.length) return null;
  return (
    <section class="panel-section" aria-labelledby={`gh-${t.uuid}`}>
      <h3 id={`gh-${t.uuid}`}>Pull requests</h3>
      <ul class="gh-prs gh-prs-compact">
        {t.github.map((p) => (
          <PrRow
            key={`${p.repo}#${p.number}`}
            pr={p}
            showTasks={false}
            note={p.closes ? 'closes this task' : 'mentions this task'}
          />
        ))}
      </ul>
    </section>
  );
}

/** @param {Record<string, any>} props */
function ModeButton({ modal }) {
  return modal ? (
    <button type="button" class="btn btn-quiet btn-sm" onClick={() => setTaskMode('sidebar')}>
      <PanelRight size={16} aria-hidden="true" />
      Open in sidebar
    </button>
  ) : (
    <button type="button" class="btn btn-quiet btn-sm mode-button" onClick={() => setTaskMode('modal')}>
      <Maximize2 size={16} aria-hidden="true" />
      Open in modal
    </button>
  );
}

/** @param {Record<string, any>} props */
function PanelBody({ task: t, onClose, headingRef }) {
  const order = navOrder.value;
  const index = order.indexOf(t.uuid);
  const step = (delta) => {
    const next = byUuid.value.get(order[index + delta]);
    if (next) openTask(next);
  };
  return (
    <div class="panel-body">
      <div class="panel-top">
        <span class={widClass(t, 'wid-lg')}>{ref(t)}</span>
        <RepoChip slug={t.repo} />
        <StateBadge task={t} />
        <span class="panel-nav">
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Previous task (k)"
            disabled={index <= 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Next task (j)"
            disabled={index < 0 || index >= order.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </span>
      </div>
      <h2 class="visually-hidden" ref={headingRef} tabIndex={-1}>
        {ref(t)}: {t.description}
      </h2>
      <div class="panel-title">
        <InlineText
          multiline
          value={t.description}
          label="Title"
          className="title-input"
          onSave={(v) =>
            v ? actions.update(t, { description: v }, 'Title saved.') : toast('A task needs a title.', 'error')
          }
        />
      </div>
      {t.claim && (
        <p class={`claim-line ${isStale(t) ? 'claim-line-stale' : ''}`}>
          {isStale(t) && <TriangleAlert size={16} aria-hidden="true" />}
          Claimed by <strong>{t.claim}</strong> {ago(t.start)}
          {isStale(t) ? '. No change for 2 days or more.' : '.'}
        </p>
      )}
      {t.blocked && (
        <p class="claim-line claim-line-stale">
          <TriangleAlert size={16} aria-hidden="true" />
          Blocked until what it waits for is done.
        </p>
      )}
      <div class="panel-actions-row">
        <Actions task={t} />
        <ModeButton modal={false} />
      </div>
      <OwnerSaid task={t} />
      <AgentSection task={t} />
      <DecisionSection task={t} />
      <IncidentSection task={t} />
      <RunEventLine task={t} />
      <Brief task={t} field="brief" label="Description" empty="No description yet." by={t.briefBy ?? ''} rows={8} />
      <Brief task={t} field="doneWhen" label="Done when" empty="Nothing written down yet." rows={3} />
      <AttachmentsSection task={t} />
      <FeatureSection task={t} />
      <Details task={t} />
      <Shipping task={t} />
      <ShortLivedSection task={t} />
      <PullRequests task={t} />
      <FootprintSection task={t} />
      <Dependencies task={t} />
      <Related task={t} />
      <Comments task={t} />
      <p class="panel-meta meta">
        Added {day(t.entry)} · updated {ago(t.modified)}
        {t.end ? ` · finished ${day(t.end)}` : ''}
        <br />
        <span class="mono">{t.uuid}</span>
      </p>
    </div>
  );
}

/** @param {Record<string, any>} props */
function ModalBody({ task: t, onClose, headingRef }) {
  const order = navOrder.value;
  const index = order.indexOf(t.uuid);
  const step = (delta) => {
    const next = byUuid.value.get(order[index + delta]);
    if (next) openTask(next);
  };
  return (
    <div class="modal-body">
      <header class="modal-head">
        <span class={widClass(t, 'wid-lg')}>{ref(t)}</span>
        <RepoChip slug={t.repo} />
        <StateBadge task={t} />
        <span class="panel-nav">
          <ModeButton modal />
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Previous task (k)"
            disabled={index <= 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Next task (j)"
            disabled={index < 0 || index >= order.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </span>
      </header>
      <div class="modal-scroll">
        <h2 class="visually-hidden" ref={headingRef} tabIndex={-1}>
          {ref(t)}: {t.description}
        </h2>
        <div class="modal-grid">
          <div class="modal-lead">
            <div class="panel-title">
              <InlineText
                multiline
                value={t.description}
                label="Title"
                className="title-input"
                onSave={(v) =>
                  v ? actions.update(t, { description: v }, 'Title saved.') : toast('A task needs a title.', 'error')
                }
              />
            </div>
            {t.claim && (
              <p class={`claim-line ${isStale(t) ? 'claim-line-stale' : ''}`}>
                {isStale(t) && <TriangleAlert size={16} aria-hidden="true" />}
                Claimed by <strong>{t.claim}</strong> {ago(t.start)}
                {isStale(t) ? '. No change for 2 days or more.' : '.'}
              </p>
            )}
            {t.blocked && (
              <p class="claim-line claim-line-stale">
                <TriangleAlert size={16} aria-hidden="true" />
                Blocked until what it waits for is done.
              </p>
            )}
            <Actions task={t} />
          </div>
          <div class="modal-agents">
            <AgentSection task={t} />
          </div>
          <div class="modal-main">
            <OwnerSaid task={t} />
            <DecisionSection task={t} />
            <IncidentSection task={t} />
            <RunEventLine task={t} />
            <Brief
              task={t}
              field="brief"
              label="Description"
              empty="No description yet."
              by={t.briefBy ?? ''}
              rows={12}
              preview
            />
            <Brief task={t} field="doneWhen" label="Done when" empty="Nothing written down yet." rows={4} preview />
            <AttachmentsSection task={t} />
            <Comments task={t} />
          </div>
          <div class="modal-rail">
            <FeatureSection task={t} />
            <Details task={t} />
            <Shipping task={t} />
            <ShortLivedSection task={t} />
            <PullRequests task={t} />
            <FootprintSection task={t} />
            <Dependencies task={t} />
            <Related task={t} />
            <p class="panel-meta meta">
              Added {day(t.entry)} · updated {ago(t.modified)}
              {t.end ? ` · finished ${day(t.end)}` : ''}
              <br />
              <span class="mono">{t.uuid}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The open task: docked beside the view on wide screens, a full sheet on small ones.
 * @param {Record<string, any>} props
 */
export function TaskPanel({ docked, modal = false }) {
  const t = current.value;
  const heading = useRef(null);
  const uuid = t?.uuid;
  const toComment = Boolean(uuid) && focusComment.value === uuid;
  const shown = useRef('');
  useEffect(() => {
    if (!uuid) return;
    // Opened from the task menu's Add a comment: start in the comment field instead of at the top.
    const field = toComment && document.getElementById(`comment-${uuid}`);
    if (field) {
      focusComment.value = null;
      field.scrollIntoView({ block: 'center' });
      field.focus({ preventScroll: true });
    } else if ((docked || modal) && shown.current !== `${uuid} ${docked} ${modal}`)
      heading.current?.focus({ preventScroll: true });
    shown.current = `${uuid} ${docked} ${modal}`;
  }, [uuid, docked, modal, toComment]);
  const onClose = () => {
    const card = uuid && document.querySelector(`[data-task="${uuid}"]`);
    closeTask();
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (card)?.focus());
  };
  if (!t) {
    if (!loaded.value) return null;
    return (
      <aside class="panel" aria-label="Task">
        <div class="panel-body">
          <div class="panel-top">
            <span class="wid wid-lg">{selected.value}</span>
            <span class="panel-nav">
              <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close" onClick={onClose}>
                <X size={18} aria-hidden="true" />
              </button>
            </span>
          </div>
          <p class="muted">
            There’s no task {selected.value} on the board. It may have been deleted, or the link is off.
          </p>
        </div>
      </aside>
    );
  }
  if (modal) {
    return (
      <section class="panel panel-modal" aria-label={`Task ${ref(t)}`}>
        <ModalBody task={t} onClose={onClose} headingRef={heading} />
      </section>
    );
  }
  return (
    <aside class={`panel ${docked ? 'panel-docked' : 'panel-sheet'}`} aria-label={`Task ${ref(t)}`}>
      <PanelBody task={t} onClose={onClose} headingRef={heading} />
    </aside>
  );
}
