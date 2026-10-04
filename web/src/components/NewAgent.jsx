import { useState } from 'preact/hooks';
import { ref } from '../lib/model.js';
import { MAX_IMAGES } from '../lib/images.js';
import { actions, multiRepo, newAgent, openTask, repoScope, routineConnected, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';
import { ImagePicker, Thumbnails } from './Attachments.jsx';
import { RepoField, uploadDraftImages, useDraftImages } from './NewTask.jsx';

const sentence = (text) => {
  const s = String(text).trim();
  const capital = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
};

/** Why New agent can't start in repository `slug`, or null when it can. */
const notConnected = (slug) => (routineConnected(slug) ? null : 'its agent routine isn’t connected');

/**
 * New agent (docs/specs/IDEA-30-new-agent.md, section 5): the owner's prompt becomes a task with no area yet,
 * and an agent starts on it, or waits at the front of the queue for room.
 */
function NewAgentForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refusal, setRefusal] = useState(null);
  // Preset to the repository in scope when its routine is connected; with every repository in scope, picked.
  const [repo, setRepo] = useState(() => {
    const scope = repoScope.value;
    return scope && !notConnected(scope) ? scope : '';
  });
  const [repoError, setRepoError] = useState(null);
  const { images, pick, drop, dropZone } = useDraftImages();

  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const prompt = String(data.get('prompt')).trim();
    if (!prompt) {
      setError('Write what the agent should do first.');
      return;
    }
    if (multiRepo.value && !repo) {
      setRepoError('Pick the repository this is for.');
      return;
    }
    setBusy(true);
    setRefusal(null);
    let result;
    try {
      result = await actions.startGeneral({
        prompt,
        repo: multiRepo.value ? repo : undefined,
        force: Boolean(data.get('force')),
      });
    } catch (failure) {
      // Nothing was made: say why here, and keep what the owner wrote.
      setBusy(false);
      setRefusal(failure.message);
      return;
    }
    const task = result.task;
    await uploadDraftImages(task, images, `Some images didn’t attach. Add them from ${ref(task)}.`);
    for (const i of images) URL.revokeObjectURL(i.url);
    setBusy(false);
    if (result.run) toast(`Started an agent on ${ref(task)}.`, 'success');
    else if (result.already) toast(`${ref(task)} has an agent already: ${result.already}.`, 'info');
    else toast(`${ref(task)} waits to start. ${sentence(result.waiting ?? 'There’s no room yet')}`, 'info');
    newAgent.value = false;
    openTask(task);
  };

  return (
    <form {...dropZone('sheet')} onSubmit={submit} noValidate aria-busy={busy ? 'true' : undefined}>
      <h2 id="new-agent-title">New agent</h2>
      <label class="field">
        <span class="field-label">What should the agent do?</span>
        <textarea
          name="prompt"
          class="textarea"
          rows={7}
          maxLength={4000}
          autoFocus
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'new-agent-error new-agent-hint' : 'new-agent-hint'}
          onInput={() => {
            setError(null);
            setRefusal(null);
          }}
        />
        {error && (
          <span class="field-error" id="new-agent-error">
            {error}
          </span>
        )}
        <span class="field-hint" id="new-agent-hint">
          Rough is fine. The agent makes this its task, picks the area, and does what it asks: a pull request, changes
          to tasks on the board, or a plan you review.
        </span>
      </label>
      <RepoField
        id="new-agent-repo"
        repo={repo}
        setRepo={(slug) => {
          setRepo(slug);
          setRepoError(null);
          setRefusal(null);
        }}
        error={repoError}
        unavailable={notConnected}
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
      <label class="check-row">
        <input type="checkbox" name="force" aria-describedby="new-agent-force-hint" />
        <span>Force start</span>
      </label>
      <p class="field-hint" id="new-agent-force-hint">
        Starts it now, past the board’s own limits on agents at once and starts an hour. Claude’s limits still apply.
      </p>
      {refusal && (
        <p class="field-error" role="alert">
          {refusal} No task was made.
        </p>
      )}
      <div class="sheet-actions">
        <button
          type="button"
          class="btn btn-quiet"
          onClick={() => {
            newAgent.value = false;
          }}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Starting…' : 'Start agent'}
        </button>
      </div>
    </form>
  );
}

export function NewAgentDialog() {
  return (
    <Dialog
      open={newAgent.value}
      onClose={() => {
        newAgent.value = false;
      }}
      labelledBy="new-agent-title"
    >
      {newAgent.value && <NewAgentForm />}
    </Dialog>
  );
}
