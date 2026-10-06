import { useState } from 'preact/hooks';
import { ref } from '../lib/model.js';
import { actions, multiRepo, openTask, repoScope, routineConnected, toast } from '../lib/store.js';
import { Dialog, Dictate } from './ui.jsx';
import { RepoField } from './NewTask.jsx';
import { sentence } from './NewAgent.jsx';

/** Why Make with an agent can't start in repository `slug`, or null when it can. */
const notConnected = (slug) => (routineConnected(slug) ? null : 'its agent routine isn’t connected');

/**
 * Make with an agent (docs/specs/BRK-220-routines-with-an-agent.md, section 1): the owner's words become a routine
 * maker's task, and its agent starts on it (or waits for room), asks what it needs, and makes the routines.
 * @param {{ onDone: () => void }} props
 */
function MakeRoutinesForm({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refusal, setRefusal] = useState(null);
  // Preset to the repository in scope when its routine is connected; with every repository in scope, picked.
  const [repo, setRepo] = useState(() => {
    const scope = repoScope.value;
    return scope && !notConnected(scope) ? scope : '';
  });
  const [repoError, setRepoError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const prompt = String(data.get('prompt')).trim();
    if (!prompt) {
      setError('Say what the routine should do first.');
      return;
    }
    if (multiRepo.value && !repo) {
      setRepoError('Pick the repository the routines run in.');
      return;
    }
    setBusy(true);
    setRefusal(null);
    let result;
    try {
      result = await actions.startRoutineMaker({
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
    setBusy(false);
    if (result.run) toast(`Started an agent on ${ref(task)}. It asks on its task if it needs to know more.`, 'success');
    else toast(`${ref(task)} waits to start. ${sentence(result.waiting ?? 'There’s no room yet')}`, 'info');
    onDone();
    openTask(task);
  };

  return (
    <form class="sheet" onSubmit={submit} noValidate aria-busy={busy ? 'true' : undefined}>
      <h2 id="make-routines-title">Make routines with an agent</h2>
      <label class="field">
        <span class="field-label">What should the routine do, and when?</span>
        <Dictate>
          <textarea
            name="prompt"
            class="textarea"
            rows={7}
            maxLength={4000}
            autoFocus
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'make-routines-error make-routines-hint' : 'make-routines-hint'}
            onInput={() => {
              setError(null);
              setRefusal(null);
            }}
          />
        </Dictate>
        {error && (
          <span class="field-error" id="make-routines-error">
            {error}
          </span>
        )}
        <span class="field-hint" id="make-routines-hint">
          Rough is fine. The agent asks on its task if it needs to know more, then makes the routines and turns them on.
          It never adds webhooks or alerts: it tells you which to add.
        </span>
      </label>
      <RepoField
        id="make-routines-repo"
        repo={repo}
        setRepo={(slug) => {
          setRepo(slug);
          setRepoError(null);
          setRefusal(null);
        }}
        error={repoError}
        unavailable={notConnected}
      />
      <label class="check-row">
        <input type="checkbox" name="force" aria-describedby="make-routines-force-hint" />
        <span>Force start</span>
      </label>
      <p class="field-hint" id="make-routines-force-hint">
        Starts it now, past the board’s own limits on agents at once and starts an hour. Claude’s limits still apply.
      </p>
      {refusal && (
        <p class="field-error" role="alert">
          {refusal} No task was made.
        </p>
      )}
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Starting…' : 'Start agent'}
        </button>
      </div>
    </form>
  );
}

/** @param {{ open: boolean, onClose: () => void }} props */
export function MakeRoutinesDialog({ open, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="make-routines-title">
      {open && <MakeRoutinesForm onDone={onClose} />}
    </Dialog>
  );
}
