import { Logo } from './Logo.jsx';

export function SignIn() {
  const failed = new URLSearchParams(location.search).get('signin') === 'failed';
  return (
    <main id="main" class="signin">
      <div class="signin-card">
        <h1 class="signin-logo">
          <Logo kind="logo" />
          <span class="visually-hidden">breakaway</span>
        </h1>
        <p class="display signin-tagline">Sign in.</p>
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
          <label class="field">
            <span class="field-label">Token</span>
            <input
              class="input"
              type="password"
              name="token"
              required
              autocomplete="current-password"
              spellcheck={false}
              autoFocus
            />
          </label>
          <button class="btn btn-primary btn-block" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
