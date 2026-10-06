import { useState } from 'preact/hooks';
import { Plug, Unplug } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { confirmDialog, toast } from '../lib/store.js';

/**
 * Pasting a provider's read-only token on Connections (BRK-194): sent once to PUT /api/infra/connections/<provider>,
 * which asks the provider about it, refuses one that can change anything, and keeps it encrypted. Nothing gives it
 * back, so the field empties once it's stored. Forgetting it is the owner's too.
 *
 * `connected` says whether the board holds a token now; `onDone` reloads Connections.
 * @param {{ id: string, name: string, connected: boolean, onDone?: () => any }} props
 */
export function ProviderConnect({ id, name, connected, onDone }) {
  const [shown, setShown] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const field = `provider-${id}`;

  const close = () => {
    setShown(false);
    setToken('');
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api(`infra/connections/${enc(id)}`, { method: 'PUT', body: { token, by: 'owner' } });
      close();
      toast(res.replaced ? 'Replaced.' : 'Connected.', 'success');
      await onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    const ok = await confirmDialog({
      title: `Forget ${name}’s token?`,
      body: `The board stops seeing what runs on ${name} until you paste a token again. The token itself still works on ${name}: delete it there too if you don’t need it.`,
      confirmLabel: 'Forget the token',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`infra/connections/${enc(id)}`, { method: 'DELETE', body: { by: 'owner' } });
      toast('Forgotten.', 'success');
      await onDone?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!shown)
    return (
      <div class="routine-connect">
        <div class="routine-connect-actions">
          <button type="button" class="btn btn-outline btn-sm" onClick={() => setShown(true)}>
            <Plug size={16} aria-hidden="true" />
            {connected ? 'Replace the token' : 'Paste a token'}
            <span class="visually-hidden"> for {name}</span>
          </button>
          {connected && (
            <button type="button" class="btn btn-quiet btn-sm" disabled={busy} aria-busy={busy} onClick={forget}>
              <Unplug size={16} aria-hidden="true" />
              Forget the token<span class="visually-hidden"> for {name}</span>
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div class="routine-connect">
      <form class="setup-register" onSubmit={submit} aria-describedby={error ? `${field}-error` : undefined}>
        <label class="field">
          <span class="field-label">Read-only token</span>
          <input
            class="input"
            type="password"
            name="token"
            required
            autoComplete="off"
            spellcheck={false}
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            aria-describedby={`${field}-hint`}
          />
          <span class="field-hint" id={`${field}-hint`}>
            Only the permissions listed below, all read. The board checks it with {name}, keeps it encrypted, sends it
            only to {name}, and never shows it again.
          </span>
        </label>
        {error && (
          <p class="field-error" id={`${field}-error`} role="alert">
            {error}
          </p>
        )}
        <div class="routine-connect-actions">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
            {busy ? (connected ? 'Replacing…' : 'Connecting…') : connected ? 'Replace' : 'Connect'}
          </button>
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
