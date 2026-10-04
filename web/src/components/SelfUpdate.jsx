import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, CircleDashed, ExternalLink, LoaderCircle, TriangleAlert, Undo2 } from 'lucide-preact';
import { api } from '../lib/api.js';
import { confirmDialog, loadConnections, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** The steps an update runs, in order (docs/specs/IDEA-20-self-updating-installs.md, section 3). */
const STEPS = [
  { id: 'verify', label: 'Checking the release’s signature' },
  { id: 'upload', label: 'Uploading the new version' },
  { id: 'deploy', label: 'Deploying it' },
  { id: 'check', label: 'Checking that it answers' },
];

const busy = (state) => state?.status === 'running' || state?.status === 'checking';

/** @param {Record<string, any>} props */
function TurnOn({ onClose, onDone }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setWorking(true);
    setError(null);
    try {
      await api('self-update/enable', {
        method: 'POST',
        body: { token: String(form.get('token') ?? '').trim(), accountId: String(form.get('account') ?? '').trim() },
      });
      toast('Updates are on. Check for updates to see what’s available.', 'success');
      onDone();
    } catch (err) {
      setError(err.message);
      setWorking(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="turnon-title" className="dialog-small">
      <form class="sheet" onSubmit={submit}>
        <h2 id="turnon-title">Turn on updates</h2>
        <p>
          This board can install a new release itself, when you press Update. It needs a Cloudflare API token that can
          upload and deploy this one Worker: create one with <strong>Workers Scripts: edit</strong> on your account and
          paste it here.
        </p>
        <p class="muted small">
          The token is kept as a secret on this board’s Worker, never shown again, and only ever sent to Cloudflare.
          Nothing updates until you press Update.
        </p>
        <label class="field">
          <span class="field-label">Cloudflare API token</span>
          <input
            name="token"
            type="password"
            required
            autoComplete="off"
            spellcheck={false}
            aria-describedby="turnon-token-hint"
          />
          <span class="field-hint" id="turnon-token-hint">
            Create it under My profile, API tokens, on Cloudflare.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Account ID</span>
          <input name="account" required autoComplete="off" spellcheck={false} aria-describedby="turnon-account-hint" />
          <span class="field-hint" id="turnon-account-hint">
            32 characters, on the right of your account’s Workers page.
          </span>
        </label>
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={working} aria-busy={working}>
            {working ? 'Checking the token…' : 'Turn on updates'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The result of the last update, in words. */
function Outcome({ state, running }) {
  if (!state?.message) return null;
  if (state.status === 'done')
    return (
      <p class="selfupd-note is-ok">
        <CircleCheck size={16} aria-hidden="true" />
        <span>{state.message}</span>
      </p>
    );
  if (state.status === 'failed' || state.status === 'rolledback')
    return (
      <p class="selfupd-note is-bad" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>{state.message}</span>
      </p>
    );
  return running ? null : <p class="selfupd-note meta">{state.message}</p>;
}

/**
 * The Update row's controls on Connections' Version row, for an install with no repository of its own: turn on
 * updates, Update with its steps, and Roll back. Every press is the owner's; nothing updates by itself.
 */
export function SelfUpdate() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(null);
  const [turnOn, setTurnOn] = useState(false);

  const load = async () => {
    try {
      setData((await api('self-update')).selfUpdate);
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const updating = busy(data?.state);
  // While an update runs the page asks every few seconds, and refreshes the row once it is over.
  useEffect(() => {
    if (!updating) return undefined;
    const t = setInterval(load, 3000);
    return () => {
      clearInterval(t);
      loadConnections();
    };
  }, [updating]);

  if (error && !data)
    return (
      <p class="field-error" role="alert">
        {error}
      </p>
    );
  if (!data?.allowed) return null;

  const call = async (action, label, after) => {
    setWorking(action);
    setError(null);
    try {
      const res = await api(`self-update/${action}`, { method: 'POST', body: {} });
      if (after) toast(after(res), 'success');
      await load();
      if (action !== 'start') loadConnections();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  };

  if (!data.enabled)
    return (
      <div class="selfupd">
        <p class="selfupd-note meta">
          Updates from the board are off. Turn them on to install a release here, after the board checks its signature.
          You press Update every time.
        </p>
        <div class="selfupd-actions">
          <button type="button" class="btn btn-outline btn-sm" onClick={() => setTurnOn(true)}>
            Turn on updates…
          </button>
        </div>
        {turnOn && (
          <TurnOn
            onClose={() => setTurnOn(false)}
            onDone={() => {
              setTurnOn(false);
              load();
              loadConnections();
            }}
          />
        )}
      </div>
    );

  const { state, running } = data;
  // What the last check saw only counts while this version is the one it compared with.
  const check = data.check?.running === running ? data.check : null;
  const latest = check?.latest;
  const verdict = check?.verdict;
  const manual = Boolean(latest?.manual && verdict);
  const available = verdict?.ok && !manual;
  const canRollBack = state?.status === 'done' && state.previousId && state.target === running;

  const update = async () => {
    const ok = await confirmDialog({
      title: `Update to ${verdict.version}?`,
      body: 'The board installs it, checks that it answers, and goes back to this version if it doesn’t. Live conversations end, like any deploy.',
      confirmLabel: 'Update',
    });
    if (ok) call('start', 'Update');
  };
  const rollBack = async () => {
    const ok = await confirmDialog({
      title: `Roll back to ${state.from}?`,
      body: 'Puts the version before the last update in front of everyone. Data the board keeps still reads fine in it.',
      confirmLabel: 'Roll back',
    });
    if (ok) call('rollback', 'Roll back', () => `Rolled back to ${state.from}.`);
  };
  const turnOff = async () => {
    const ok = await confirmDialog({
      title: 'Turn off updates?',
      body: 'The board stops using its Cloudflare token. You delete the token on Cloudflare yourself: the board can’t.',
      confirmLabel: 'Turn off updates',
      tone: 'danger',
    });
    if (ok) call('disable', 'Turn off', (res) => res.message ?? 'Updates are off.');
  };

  return (
    <div class="selfupd">
      {updating ? (
        <div role="status" aria-live="polite">
          <p class="selfupd-note">
            <LoaderCircle size={16} aria-hidden="true" class="spin" />
            <span>
              Updating from {state.from}
              {state.target ? ` to ${state.target}` : ''}. The board stays up until the new version is deployed.
            </span>
          </p>
          <ol class="selfupd-steps">
            {STEPS.map((s, i) => {
              const at = STEPS.findIndex((x) => x.id === state.step);
              const done = i < at;
              return (
                <li key={s.id} class={done ? 'is-done' : i === at ? 'is-now' : ''}>
                  {done ? (
                    <CircleCheck size={15} aria-hidden="true" />
                  ) : i === at ? (
                    <LoaderCircle size={15} aria-hidden="true" class="spin" />
                  ) : (
                    <CircleDashed size={15} aria-hidden="true" />
                  )}
                  {s.label}
                  <span class="visually-hidden">{done ? ', done' : i === at ? ', now' : ', to do'}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <>
          <Outcome state={state} running={running} />
          {!check && <p class="selfupd-note meta">Not checked for updates yet.</p>}
          {check?.error && !latest && (
            <p class="selfupd-note is-bad" role="alert">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>Can’t read the update feed. The board keeps running as it is; try again later.</span>
            </p>
          )}
          {latest && !verdict && <p class="selfupd-note meta">Up to date.</p>}
          {verdict && !verdict.ok && (
            <p class="selfupd-note is-bad" role="alert">
              <TriangleAlert size={16} aria-hidden="true" />
              <span>
                {verdict.step === 'signature' || verdict.step === 'checksum'
                  ? 'This release didn’t pass its signature check, so it wasn’t installed. Nothing changed.'
                  : verdict.message}
              </span>
            </p>
          )}
          {manual && (
            <div class="selfupd-note">
              <p>
                <strong>{latest.version} needs steps by hand,</strong> so the board won’t install it.
              </p>
              {latest.manualSteps?.length > 0 && (
                <ol class="selfupd-manual">
                  {latest.manualSteps.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {available && (
            <p class="selfupd-note">
              <span>
                {verdict.version} is available, and its signature checks out.
                {latest.notes && (
                  <>
                    {' '}
                    <a href={latest.notes} {...ext}>
                      Read the release notes
                      <ExternalLink size={15} aria-hidden="true" />
                      <span class="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </>
                )}
              </span>
            </p>
          )}
        </>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="selfupd-actions">
        {available && (
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={updating || Boolean(working)}
            aria-busy={updating || working === 'start'}
            onClick={update}
          >
            {updating ? 'Updating…' : `Update to ${verdict.version}`}
          </button>
        )}
        {canRollBack && !updating && (
          <button
            type="button"
            class="btn btn-outline btn-sm"
            disabled={Boolean(working)}
            aria-busy={working === 'rollback'}
            onClick={rollBack}
          >
            <Undo2 size={15} aria-hidden="true" />
            Roll back to {state.from}
          </button>
        )}
        <button
          type="button"
          class="btn btn-outline btn-sm"
          disabled={updating || Boolean(working)}
          aria-busy={working === 'check'}
          onClick={() => call('check', 'Check')}
        >
          {working === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        <button type="button" class="btn btn-quiet btn-sm" disabled={updating || Boolean(working)} onClick={turnOff}>
          Turn off updates
        </button>
      </div>
    </div>
  );
}
