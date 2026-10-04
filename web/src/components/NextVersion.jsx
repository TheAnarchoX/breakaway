import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, Tag } from 'lucide-preact';
import { ref } from '../lib/model.js';
import { actions, agents, openTask, routineConnected, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';
import { sentence } from './NewAgent.jsx';

/*
 * Prepare the next version (BRK-100, docs/specs/BRK-100-next-version.md): pre-releases count patches by themselves
 * from package.json's version, and the next minor or major takes a pull request that sets it. A button starts a
 * general agent with the board's prompt for it, the way Refine from the answers does.
 */

/**
 * The dialog: what the agent will be asked, short and read-only, an optional note under it, Force start, and Start agent.
 * @param {Record<string, any>} props
 */
function NextVersionDialog({ view, choice, onClose }) {
  const open = Boolean(choice);
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [loadFailed, setLoadFailed] = useState(/** @type {string | null} */ (null));
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!choice) return undefined;
    let live = true;
    setPreview(null);
    setLoadFailed(null);
    setRefusal(null);
    actions.previewNextVersion(view.slug, choice.next).then(
      (result) => live && setPreview(result),
      (failure) => live && setLoadFailed(failure.message),
    );
    return () => {
      live = false;
    };
  }, [choice?.next, view.slug]);

  const close = () => {
    if (!busy) onClose();
  };
  const already = preview?.task ?? null;
  const blocked = preview?.refusal ?? loadFailed;
  // The board answers with the version it would set now: the one to start, and to name.
  const version = preview?.version ?? choice?.version;

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
      result = await actions.startGeneral({ repo: view.slug, next: choice.next, version, note: note.trim(), force });
    } catch (failure) {
      // Nothing was made: say why here, and keep the note.
      setBusy(false);
      setRefusal(failure.message);
      return;
    }
    setBusy(false);
    const task = result.task;
    if (result.run) toast(`Started an agent on ${ref(task)}.`, 'success');
    else if (result.already) toast(`${ref(task)} is preparing the next version already: ${result.already}.`, 'info');
    else toast(`${ref(task)} waits to start. ${sentence(result.waiting ?? 'There’s no room yet')}`, 'info');
    setNote('');
    setForce(false);
    onClose();
    openTask(task);
  };

  const id = `next-version-${view.slug}`;
  return (
    <Dialog open={open} onClose={close} labelledBy={`${id}-title`}>
      {choice && (
        <form
          class="sheet"
          onSubmit={submit}
          noValidate
          aria-busy={busy || (!preview && !loadFailed) ? 'true' : undefined}
        >
          <h2 id={`${id}-title`}>Prepare {version}</h2>
          <p class="muted small">
            An agent sets {view.name}’s package.json to {version} and opens a pull request. Once you merge it, the next
            pre-release is <code>v{version}-main.1</code>.
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
              {ref(already)} is preparing the next version already: {preview.already}.
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
      )}
    </Dialog>
  );
}

/**
 * Next version, for one repository whose pre-releases count from package.json (`view`: its slug, name, and
 * `nextVersion`): the version they work toward, and a button for the next minor and the next major, or a link to
 * the agent already preparing one. `label` names the repository when the view shows several.
 * @param {Record<string, any>} props
 */
export function NextVersion({ view, label = null }) {
  const [choice, setChoice] = useState(/** @type {any} */ (null));
  const offer = view?.nextVersion;
  if (!offer) return null;
  const id = `gh-next-${view.slug}`;
  // Until the Agents view's answer is in, assume the routine is there: the dialog says if it can't start one.
  const connected = !agents.value.data || routineConnected(view.slug);
  const preparing = offer.preparing;
  return (
    <section class="gh-section next-version" aria-labelledby={id}>
      <h2 id={id}>
        <Tag size={18} aria-hidden="true" />
        {label ? `Next version: ${label}` : 'Next version'}
      </h2>
      <p class="small">
        Pre-releases count patches toward <code>{offer.base}</code> by themselves (the latest is{' '}
        <code>{offer.latest}</code>). A minor or major release starts with a pull request that sets package.json’s
        version.
      </p>
      {preparing ? (
        <p class="meta next-version-link">
          {preparing.claim ? `${preparing.claim} is preparing it on ` : 'An agent waits to prepare it on '}
          <button type="button" class="linkish" onClick={() => openTask(preparing)}>
            {ref(preparing)}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        </p>
      ) : connected ? (
        <div class="next-version-actions">
          {offer.choices.map((c) => (
            <button
              key={c.next}
              type="button"
              class="btn btn-outline btn-sm"
              aria-label={`Prepare ${c.version}, the next ${c.next} release`}
              onClick={() => setChoice(c)}
            >
              Prepare {c.version}
              <span class="meta">{c.next}</span>
            </button>
          ))}
        </div>
      ) : (
        <p class="meta">Connect {view.name}’s agent routine on the Agents view to prepare one from here.</p>
      )}
      <NextVersionDialog view={view} choice={choice} onClose={() => setChoice(null)} />
    </section>
  );
}
