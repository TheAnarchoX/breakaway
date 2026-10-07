import { useEffect, useState } from 'preact/hooks';
import { GitCompareArrows, Hammer, LockOpen } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { confirmDialog, hashFor, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';

/**
 * The owner's actions on a whole environment, under the console's status band (WEB-95): **Compare now** (BRK-184),
 * **Mark as break-glass** on its drift (BRK-187), and **Release the lock** an apply left behind (BRK-179). Each is a
 * cookie-only route, so only the signed-in board shows them, and each asks first and says what follows. None applies
 * anything: comparing makes at most a draft plan, a mark records a change and adds a task, and a release only frees
 * the environment for the next plan.
 */

/** The longest break-glass note the board keeps (src/infra-break-glass.js's BREAK_GLASS_NOTE_MAX). */
const NOTE_MAX = 500;

/** @param {{ iso: string | null | undefined }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/**
 * Compare it now, rather than on the board's next check. Shown where the board can compare it at all.
 * @param {{ env: any, onDone: () => void }} props
 */
function CompareNow({ env, onDone }) {
  const [busy, setBusy] = useState(false);
  const compare = async () => {
    const ok = await confirmDialog({
      title: `Compare ${env.name} now?`,
      body: 'The board reads what runs and checks it against the repository. Nothing changes: drift from a change by hand becomes a draft plan, and drift from a merged change a plan that waits for you.',
      confirmLabel: 'Compare now',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { drift } = await api(`infra/drift/${enc(env.id)}`, { method: 'POST', body: { by: 'owner' } });
      if (drift.error) toast(`Couldn’t compare ${env.name}: ${drift.error}`, 'error');
      else if (!drift.count) toast(`No drift: ${env.name} matches the repository.`, 'success');
      else
        toast(
          `${drift.count} ${drift.count === 1 ? 'resource differs' : 'resources differ'} in ${env.name}.${drift.plan ? ` ${drift.plan} has the changes.` : ''}`,
          'info',
        );
      onDone();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class="btn btn-quiet btn-sm" onClick={compare} disabled={busy} aria-busy={busy}>
      <GitCompareArrows size={16} aria-hidden="true" />
      {busy ? 'Comparing…' : 'Compare now'}
    </button>
  );
}

/**
 * Mark as break-glass: the drift is a change the owner made by hand, on purpose. It takes a note, so it asks in a
 * dialog of its own rather than the plain confirm.
 * @param {{ env: any, drift: any, onDone: () => void }} props
 */
function MarkBreakGlass({ env, drift, onDone }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(/** @type {string | null} */ (null));
  const id = `break-glass-${env.id}`;
  const close = () => {
    if (!busy) setOpen(false);
  };
  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    if (busy) return;
    if (!note.trim()) {
      setEmpty(true);
      document.getElementById(`${id}-note`)?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const marked = await api(`infra/break-glass/${enc(env.id)}`, {
        method: 'POST',
        body: { note: note.trim(), by: 'owner' },
      });
      toast(
        marked.already
          ? `Those changes are marked already. ${marked.breakGlass.task} puts them into code.`
          : `Marked as break-glass. ${marked.breakGlass.task} puts the change into code.`,
        'success',
      );
      setNote('');
      setOpen(false);
      onDone();
    } catch (error) {
      setRefusal(error.message);
    } finally {
      setBusy(false);
    }
  };
  const count = drift.count;
  return (
    <>
      <button
        type="button"
        class="btn btn-outline btn-sm"
        onClick={() => {
          setRefusal(null);
          setEmpty(false);
          setOpen(true);
        }}
      >
        <Hammer size={16} aria-hidden="true" />
        Mark as break-glass
      </button>
      <Dialog open={open} onClose={close} labelledBy={`${id}-title`}>
        <form class="sheet" onSubmit={submit} noValidate aria-busy={busy ? 'true' : undefined}>
          <h2 id={`${id}-title`}>Mark {env.name}’s drift as break-glass?</h2>
          <p class="muted small">
            {count} {count === 1 ? 'resource differs' : 'resources differ'} from the repository. The board records the
            change you made by hand in the audit trail and adds a task to put it into{' '}
            <code>.github/breakaway-infra/{env.name}.json</code> by pull request. It never undoes it, and it rejects the
            open drift plans that would.
          </p>
          <label class="field">
            <span class="field-label">What did you change, and why?</span>
            <textarea
              id={`${id}-note`}
              class="textarea"
              rows={3}
              maxLength={NOTE_MAX}
              value={note}
              required
              aria-required="true"
              aria-invalid={empty ? 'true' : undefined}
              aria-describedby={empty ? `${id}-empty` : `${id}-hint`}
              placeholder="Raised the instance count by hand during the slowdown"
              disabled={busy}
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
                Say what you changed first: the task that puts it into code starts from your note.
              </span>
            ) : (
              <span class="field-hint" id={`${id}-hint`}>
                Goes in the audit trail and the task. Up to {NOTE_MAX} characters; no secrets.
              </span>
            )}
          </label>
          {refusal && (
            <p class="field-error" role="alert">
              {refusal} Nothing was marked.
            </p>
          )}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy ? 'Marking…' : 'Mark as break-glass'}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/**
 * Release the lock an apply holds on the environment, by force: for a run that stopped without releasing it. Reads
 * the lock itself, again on each of the console's reads.
 * @param {{ env: any, tick: number, onDone: () => void }} props
 */
function ReleaseLock({ env, tick, onDone }) {
  const [lock, setLock] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(`infra/locks/${enc(env.id)}`).then(
      (r) => live && setLock(r.lock),
      () => live && setLock(null),
    );
    return () => {
      live = false;
    };
  }, [env.id, tick]);
  if (!lock) return null;
  const release = async () => {
    const ok = await confirmDialog({
      title: `Release ${lock.holder}’s lock on ${env.name}?`,
      body: `Do this only once the apply that took it has stopped: the next approved plan can start here at once${lock.plan ? `, and ${lock.plan} may be half done` : ''}. The release goes in the audit trail.`,
      confirmLabel: 'Release the lock',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`infra/locks/${enc(env.id)}`, { method: 'DELETE' });
      setLock(null);
      toast(`Released the lock on ${env.name}.`, 'success');
      onDone();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const planLink = lock.plan
    ? hashFor({ view: 'infrastructure', environment: String(env.id), plan: lock.plan, task: null })
    : null;
  return (
    <span class="env-action-line">
      <span class="meta">
        Locked by {lock.holder}
        {planLink && (
          <>
            {' for '}
            <a href={planLink}>{lock.plan}</a>
          </>
        )}{' '}
        <When iso={lock.taken} />
      </span>
      <button type="button" class="btn btn-quiet btn-sm" onClick={release} disabled={busy} aria-busy={busy}>
        <LockOpen size={16} aria-hidden="true" />
        Release the lock
      </button>
    </span>
  );
}

/**
 * @param {{ env: any, drift: any, tick: number, onChange: () => void }} props
 */
export function EnvironmentActions({ env, drift, tick, onChange }) {
  if (env.observeOnly) return null;
  const mark = drift?.breakGlass ?? null;
  return (
    <>
      <ReleaseLock env={env} tick={tick} onDone={onChange} />
      {mark && (
        <span class="env-action-line meta">
          Marked as break-glass <When iso={mark.at} />
          {' · '}
          <a href={hashFor({ task: mark.task })}>{mark.task}</a> puts it into code
        </span>
      )}
      {drift && drift.count > 0 && !mark && <MarkBreakGlass env={env} drift={drift} onDone={onChange} />}
      {env.provider && <CompareNow env={env} onDone={onChange} />}
    </>
  );
}
