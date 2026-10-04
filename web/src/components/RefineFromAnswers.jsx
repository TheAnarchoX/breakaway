import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, Sparkles } from 'lucide-preact';
import { ref } from '../lib/model.js';
import { actions, isDecided, openTask, refiningFrom, routineConnected, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';
import { sentence } from './NewAgent.jsx';

/*
 * Refine from the answers (docs/specs/IDEA-30-new-agent.md, section 8): on a decided decision, a general agent
 * brings the work waiting for it in line with the answers. The board writes its prompt; the owner may add a note.
 */

/** What the decision section and the task menu offer on `t`: nothing, start one, or the one already open. */
export function refineFromAnswers(t) {
  if (!isDecided(t) || !routineConnected(t.repo)) return null;
  const open = refiningFrom(t);
  return open ? { open } : { start: true };
}

/**
 * The dialog: the board's prompt, short and read-only, an optional note under it, Force start, and Start agent.
 * @param {Record<string, any>} props
 */
export function RefineFromAnswersDialog({ task: t, open, onClose }) {
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [loadFailed, setLoadFailed] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(null);
    setLoadFailed(null);
    setRefusal(null);
    actions.previewRefine(t).then(
      (result) => live && setPreview(result),
      (failure) => live && setLoadFailed(failure.message),
    );
    return () => {
      live = false;
    };
  }, [open, t.uuid]);

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
    setBusy(true);
    setRefusal(null);
    let result;
    try {
      result = await actions.startGeneral({ decision: t.uuid, note: note.trim(), force });
    } catch (failure) {
      // Nothing was made: say why here, and keep the note.
      setBusy(false);
      setRefusal(failure.message);
      return;
    }
    setBusy(false);
    const task = result.task;
    if (result.run) toast(`Started an agent on ${ref(task)}.`, 'success');
    else if (result.already) toast(`${ref(task)} is refining from these answers already: ${result.already}.`, 'info');
    else toast(`${ref(task)} waits to start. ${sentence(result.waiting ?? 'There’s no room yet')}`, 'info');
    setNote('');
    setForce(false);
    onClose();
    openTask(task);
  };

  const id = `refine-answers-${t.uuid}`;
  return (
    <Dialog open={open} onClose={close} labelledBy={`${id}-title`}>
      <form
        class="sheet"
        onSubmit={submit}
        noValidate
        aria-busy={busy || (!preview && !loadFailed) ? 'true' : undefined}
      >
        <h2 id={`${id}-title`}>Refine from the answers to {ref(t)}</h2>
        <p class="muted small">
          An agent brings the tasks waiting for this decision, and their spec, in line with your answers. It never
          changes the answers.
        </p>
        <section class="field" aria-labelledby={`${id}-prompt-label`}>
          <h3 class="field-label" id={`${id}-prompt-label`}>
            What the agent will be asked
          </h3>
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
        </section>
        {loadFailed && (
          <p class="field-error" role="alert">
            {sentence(`Couldn’t write the prompt: ${loadFailed}`)} Close this and try again.
          </p>
        )}
        {already ? (
          <p class="meta" role="status">
            {ref(already)} is refining from these answers already: {preview.already}.
          </p>
        ) : (
          <>
            <label class="field">
              <span class="field-label">Note for the agent (optional)</span>
              <textarea
                class="textarea"
                rows={3}
                maxLength={4000}
                value={note}
                placeholder="Anything it should know or keep in mind"
                aria-describedby={`${id}-note-hint`}
                onInput={(e) => {
                  setNote(e.currentTarget.value);
                  setRefusal(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
                }}
              />
              <span class="field-hint" id={`${id}-note-hint`}>
                It goes under the board’s prompt. Ctrl + Enter starts it.
              </span>
            </label>
            <label class="check-row">
              <input
                type="checkbox"
                checked={force}
                aria-describedby={`${id}-force-hint`}
                onChange={(e) => setForce(e.currentTarget.checked)}
              />
              <span>Force start</span>
            </label>
            <p class="field-hint" id={`${id}-force-hint`}>
              Starts it now, past the board’s own limits on agents at once and starts an hour. Claude’s limits still
              apply.
            </p>
          </>
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
 * Under a decided decision's answers: Refine from the answers, or a link to the task already refining from them.
 * @param {Record<string, any>} props
 */
export function RefineFromAnswers({ task: t }) {
  const [open, setOpen] = useState(false);
  const offer = refineFromAnswers(t);
  if (!offer) return null;
  if (offer.open)
    return (
      <p class="meta refine-answers-link">
        <Sparkles size={14} aria-hidden="true" /> An agent is refining from these answers:{' '}
        <button type="button" class="linkish" onClick={() => openTask(offer.open)}>
          {ref(offer.open)}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </p>
    );
  return (
    <>
      <button type="button" class="btn btn-outline btn-sm refine-answers" onClick={() => setOpen(true)}>
        <Sparkles size={16} aria-hidden="true" />
        Refine from the answers
      </button>
      <RefineFromAnswersDialog task={t} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
