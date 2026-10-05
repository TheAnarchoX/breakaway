import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, Sparkles } from 'lucide-preact';
import { ref } from '../lib/model.js';
import { refiningSpec, SPEC_REQUEST_MAX } from '../lib/specs.js';
import { actions, agents, hashFor, openTask, repoName, repos, routineConnected, tasks, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';
import { sentence } from './NewAgent.jsx';

/*
 * Refine with an agent on a spec (WEB-26, docs/specs/IDEA-31-specs-view.md section 4): the owner says what should
 * change, and a general agent changes the spec and brings the tasks that link it in line, in one pull request. The
 * board writes its prompt from the spec and its tasks; the owner's request goes in it, in their words.
 */

/**
 * The dialog: a required "What should change?", the board's prompt under it, Force start, and Start agent. `load`
 * asks the board for its prompt (a dry run), and `start(note, force)` starts the agent; `what` names the thing it
 * refines ("this spec"), and `lead` says what the agent does. Refine a feature (BRK-150) uses it too.
 * @param {{ id: string, title: string, what: string, lead: string, load: () => Promise<any>, start: (note: string, force: boolean) => Promise<any>, open: boolean, onClose: () => void }} props
 */
export function RefineDialog({ id, title, what, lead, load, start, open, onClose }) {
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [loadFailed, setLoadFailed] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState('');
  const [empty, setEmpty] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(null);
    setLoadFailed(null);
    setRefusal(null);
    setEmpty(false);
    load().then(
      (result) => live && setPreview(result),
      (failure) => live && setLoadFailed(failure.message),
    );
    return () => {
      live = false;
    };
  }, [open, id]);

  const close = () => {
    if (!busy) onClose();
  };
  const already = preview?.task ?? null;
  const blocked = preview?.refusal ?? loadFailed;

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !preview || blocked) return;
    if (already) {
      onClose();
      openTask(already);
      return;
    }
    if (!note.trim()) {
      setEmpty(true);
      document.getElementById(`${id}-note`)?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    let result;
    try {
      result = await start(note.trim(), force);
    } catch (failure) {
      // Nothing was made: say why here, and keep the request.
      setBusy(false);
      setRefusal(failure.message);
      return;
    }
    setBusy(false);
    const task = result.task;
    if (result.run) toast(`Started an agent on ${ref(task)}.`, 'success');
    else if (result.already) toast(`${ref(task)} is on ${what} already: ${result.already}.`, 'info');
    else toast(`${ref(task)} waits to start. ${sentence(result.waiting ?? 'There’s no room yet')}`, 'info');
    setNote('');
    setForce(false);
    onClose();
    openTask(task);
  };

  const full = note.length >= SPEC_REQUEST_MAX;
  const near = note.length > SPEC_REQUEST_MAX - 400;
  const hint = full
    ? `That’s the most the board keeps: ${SPEC_REQUEST_MAX.toLocaleString()} characters. Say the rest in a comment on the task once it starts.`
    : near
      ? `${note.length.toLocaleString()} of ${SPEC_REQUEST_MAX.toLocaleString()} characters.`
      : 'In your words: what to add, drop, or decide. Ctrl + Enter starts it.';
  return (
    <Dialog open={open} onClose={close} labelledBy={`${id}-title`}>
      <form
        class="sheet"
        onSubmit={submit}
        noValidate
        aria-busy={busy || (!preview && !loadFailed) ? 'true' : undefined}
      >
        <h2 id={`${id}-title`}>Refine {title} with an agent</h2>
        <p class="muted small">{lead}</p>
        {already ? (
          <p class="meta" role="status">
            {ref(already)} is on {what} already: {preview.already}.
          </p>
        ) : (
          <>
            <label class="field">
              <span class="field-label">What should change?</span>
              <textarea
                id={`${id}-note`}
                class="textarea"
                rows={4}
                maxLength={SPEC_REQUEST_MAX}
                value={note}
                required
                aria-required="true"
                aria-invalid={empty ? 'true' : undefined}
                aria-describedby={empty ? `${id}-empty` : `${id}-note-hint`}
                placeholder="I want this and this"
                disabled={!preview || Boolean(blocked)}
                onInput={(e) => {
                  setNote(e.currentTarget.value);
                  setEmpty(false);
                  setRefusal(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
                }}
              />
              {empty ? (
                <span class="field-error" id={`${id}-empty`} role="alert">
                  Say what should change first: the agent works from your words.
                </span>
              ) : (
                <span class={`field-hint ${full ? 'is-full' : ''}`} id={`${id}-note-hint`} aria-live="polite">
                  {hint}
                </span>
              )}
            </label>
            <label class="check-row">
              <input
                type="checkbox"
                checked={force}
                aria-describedby={`${id}-force-hint`}
                disabled={!preview || Boolean(blocked)}
                onChange={(e) => setForce(e.currentTarget.checked)}
              />
              <span>Force start</span>
            </label>
            <p class="field-hint" id={`${id}-force-hint`}>
              Starts it now, past the board’s own limits on agents at once and starts an hour. Without it, an agent over
              those limits waits for room. Claude’s limits still apply.
            </p>
          </>
        )}
        <details class="refine-spec-prompt">
          <summary class="field-label">What the agent will be asked</summary>
          {preview ? (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the prompt scrolls, so it takes focus to scroll by keyboard.
            <pre class="refine-prompt" tabIndex={0}>
              {preview.prompt}
            </pre>
          ) : loadFailed ? null : (
            <p class="meta" role="status">
              Writing the prompt…
            </p>
          )}
        </details>
        {loadFailed && (
          <p class="field-error" role="alert">
            {sentence(`Couldn’t write the prompt: ${loadFailed}`)} Close this and try again.
          </p>
        )}
        {preview?.refusal && (
          <p class="field-error" role="alert">
            {sentence(`Can’t start one: ${preview.refusal}`)}
          </p>
        )}
        {refusal && (
          <p class="field-error" role="alert">
            {sentence(refusal)} No task was made.
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" disabled={busy} onClick={close}>
            Cancel
          </button>
          {already ? (
            <button type="submit" class="btn btn-primary">
              Open {ref(already)}
            </button>
          ) : (
            <button type="submit" class="btn btn-primary" disabled={busy || !preview || Boolean(blocked)}>
              {busy ? 'Starting…' : 'Start agent'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/**
 * In an open spec's header: Refine with an agent, a link to the task already on the spec, or why it can't start one.
 * @param {{ slug: string, path: string, title: string }} props
 */
export function RefineSpec({ slug, path, title }) {
  const [open, setOpen] = useState(false);
  const on = refiningSpec(tasks.value, slug, path, repos.value.default);
  if (on)
    return (
      <p class="meta refine-answers-link">
        <Sparkles size={14} aria-hidden="true" /> An agent is on this spec:{' '}
        <button type="button" class="linkish" onClick={() => openTask(on)}>
          {ref(on)}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </p>
    );
  // Until the board says, nothing: a button that turns off a moment later is worse than one that shows late.
  if (!agents.value.loaded) return null;
  if (!routineConnected(slug)) {
    const hintId = `refine-spec-off-${slug}`;
    return (
      <span class="refine-spec-off">
        <button type="button" class="btn btn-outline btn-sm" disabled aria-describedby={hintId}>
          <Sparkles size={16} aria-hidden="true" />
          Refine with an agent
        </button>
        <span class="meta" id={hintId}>
          Can’t start one: the agent routine for {repoName(slug)} isn’t connected yet.{' '}
          <a href={hashFor({ view: 'agents', task: null, spec: null })}>Open Agents</a>
        </span>
      </span>
    );
  }
  return (
    <>
      <button type="button" class="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
        <Sparkles size={16} aria-hidden="true" />
        Refine with an agent
      </button>
      <RefineDialog
        id={`refine-spec-${path.replace(/[^\w-]/gu, '-')}`}
        title={title}
        what="this spec"
        lead="An agent changes the spec as you ask, brings the tasks that link it in line, and opens a pull request for you to merge."
        load={() => actions.previewSpec(slug, path)}
        start={(note, force) => actions.startGeneral({ repo: slug, spec: path, note, force })}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
