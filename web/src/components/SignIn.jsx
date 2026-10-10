import { useEffect, useState } from 'preact/hooks';
import { KeyRound } from 'lucide-preact';
import { Logo } from './Logo.jsx';
import { api, reopen } from '../lib/api.js';
import { passkeysWork, usePasskey } from '../lib/passkey.js';

/**
 * The board's sign-in. `next` is the consent page of a sign-in from MCP apps (BRK-157), which the board comes
 * back to once you're in. A passkey (WEB-124) shows only once someone on the board has one, the owner included; the
 * token always signs the owner in, whatever passkeys there are.
 * @param {{ next?: string | null }} props
 */
export function SignIn({ next = null }) {
  const failed = new URLSearchParams(location.search).get('signin') === 'failed';
  const [passkeys, setPasskeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    api('signin')
      .then((d) => setPasskeys(Boolean(d.passkeys) && passkeysWork()))
      .catch(() => setPasskeys(false));
  }, []);

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, publicKey } = await api('signin/options', { method: 'POST', body: {}, open: true });
      const credential = await usePasskey(publicKey);
      await api('signin', { method: 'POST', body: { challengeId, credential }, open: true });
      reopen(next ?? '');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <main id="main" class="signin">
      <div class="signin-card">
        <h1 class="signin-logo">
          <Logo kind="logo" />
          <span class="visually-hidden">breakaway</span>
        </h1>
        <p class="display signin-tagline">Sign in.</p>
        {next && <p>Then you can approve the app that’s asking to connect.</p>}
        {passkeys && (
          <div class="signin-passkey">
            <button
              type="button"
              class="btn btn-primary btn-block"
              onClick={signInWithPasskey}
              disabled={busy}
              aria-busy={busy}
            >
              <KeyRound size={18} aria-hidden="true" />
              {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
            </button>
            {error && (
              <p class="field-error" role="alert">
                {error}
              </p>
            )}
            <p class="signin-or muted small">
              <span>or, if you run this board</span>
            </p>
          </div>
        )}
        <p class="muted">
          Paste the board’s token: the one its CLI and agents use. This browser stays signed in for 180 days.
        </p>
        {failed && (
          <p class="field-error" role="alert">
            That token didn’t work. Check you copied all of it.
          </p>
        )}
        <form method="post" action="/login" class="signin-form">
          <input type="text" name="username" value={location.host} autocomplete="username" hidden readOnly />
          {next && <input type="hidden" name="next" value={next} />}
          <label class="field">
            <span class="field-label">Token</span>
            <input
              class="input"
              type="password"
              name="token"
              required
              autocomplete="current-password"
              spellcheck={false}
              autoFocus={!passkeys}
            />
          </label>
          <button class={`btn btn-block ${passkeys ? 'btn-outline' : 'btn-primary'}`} type="submit">
            {passkeys ? 'Sign in with the token' : 'Sign in'}
          </button>
        </form>
        {passkeys && (
          <p class="meta">Lost your passkey? Ask whoever invited you to Reset you: they’ll send you a new link.</p>
        )}
      </div>
    </main>
  );
}
