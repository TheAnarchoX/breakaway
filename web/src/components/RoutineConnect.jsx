import { useState } from 'preact/hooks';
import { Copy, Plug, Terminal } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { repos, toast } from '../lib/store.js';

/**
 * Connecting or replacing a repository's agent routine from the board (WEB-38): its /fire URL and token, sent once
 * to PUT /api/repos/<slug>/routine (BRK-133), which checks them the way agents-connect does and keeps them
 * encrypted. Nothing gives them back, so the fields empty once it's stored. The wizard's connect step and
 * Connections' routine row both use it; agents-connect stays under it for a terminal, and wins when both exist.
 *
 * `source` is where the routine is now: null (none), `board` (this form), or `secrets` (agents-connect).
 * `open` shows the fields straight away instead of behind a button; `onDone` reloads what shows the routine.
 * @param {{ slug: string, source?: 'board' | 'secrets' | null, open?: boolean, onDone?: () => any }} props
 */
export function RoutineConnect({ slug, source = null, open = false, onDone }) {
  const [shown, setShown] = useState(open);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const replace = source !== null;
  const command =
    slug === repos.value.default ? 'npx breakaway agents-connect' : `npx breakaway agents-connect --repo ${slug}`;
  const id = `routine-${slug}`;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api(`repos/${enc(slug)}/routine`, { method: 'PUT', body: { url, token, by: 'owner' } });
      setUrl('');
      setToken('');
      setShown(open && !res.connected);
      toast(
        res.secretsStoreWins
          ? 'Kept. The routine agents-connect stored still starts agents here while it’s in the Secrets Store.'
          : res.replaced
            ? 'Replaced.'
            : 'Connected.',
        'success',
      );
      await onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const terminal = (
    <div class="wiz-cmd">
      <p class="meta">Prefer a terminal? It asks for the token there, and wins when both exist.</p>
      <div class="wiz-cmd-row">
        <code>{command}</code>
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          aria-label={`Copy ${command}`}
          onClick={() => copy(command, 'Command')}
        >
          <Copy size={16} aria-hidden="true" />
        </button>
      </div>
      <p class="meta">
        <span class="wiz-terminal">
          <Terminal size={14} aria-hidden="true" />
          In your own terminal
        </span>
      </p>
    </div>
  );

  // agents-connect's routine wins over one kept here, so replacing it from the form would change nothing.
  if (source === 'secrets')
    return (
      <div class="routine-connect">
        <p class="meta">Connected with agents-connect. To replace it, run it again with the new token.</p>
        {terminal}
      </div>
    );

  if (!shown)
    return (
      <div class="routine-connect">
        <button type="button" class="btn btn-outline btn-sm" onClick={() => setShown(true)}>
          <Plug size={16} aria-hidden="true" />
          {replace ? 'Replace the routine' : 'Connect the routine'}
          <span class="visually-hidden"> for {slug}</span>
        </button>
      </div>
    );

  return (
    <div class="routine-connect">
      <form class="setup-register" onSubmit={submit} aria-describedby={error ? `${id}-error` : undefined}>
        <label class="field">
          <span class="field-label">Routine URL</span>
          <input
            class="input"
            type="url"
            name="url"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            aria-describedby={`${id}-url-hint`}
          />
          <span class="field-hint" id={`${id}-url-hint`}>
            The URL of the routine’s API trigger, on claude.ai/code/routines.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Token</span>
          <input
            class="input"
            type="password"
            name="token"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            aria-describedby={`${id}-token-hint`}
          />
          <span class="field-hint" id={`${id}-token-hint`}>
            Generate one in the same API trigger. The board keeps it encrypted and never shows it again.
          </span>
        </label>
        {error && (
          <p class="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        )}
        <div class="routine-connect-actions">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
            {busy ? (replace ? 'Replacing…' : 'Connecting…') : replace ? 'Replace' : 'Connect'}
          </button>
          {!open && (
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              disabled={busy}
              onClick={() => {
                setShown(false);
                setUrl('');
                setToken('');
                setError(null);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      {terminal}
    </div>
  );
}
