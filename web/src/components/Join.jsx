import { useEffect, useState } from 'preact/hooks';
import { KeyRound } from 'lucide-preact';
import { Logo } from './Logo.jsx';
import { api } from '../lib/api.js';
import { passkeysWork, makePasskey } from '../lib/passkey.js';
import { repoWords, roleLabel } from '../lib/people.js';

/** A handle from a display name, as a first guess: lowercase letters, digits, and dashes, starting with a letter. */
const handleFrom = (name) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^[^a-z]+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 32);

/**
 * Joining by invite (WEB-124, docs/specs/BRK-299-people-and-roles.md, point 2): #/join/<code>, opened from the link
 * someone shared by hand. It shows who invited you and with what role, asks for a name and a handle, and makes your
 * first passkey; the invite is used up only once that passkey is saved. A Reset's link keeps your name and handle.
 * @param {{ code: string }} props
 */
export function Join({ code }) {
  const [info, setInfo] = useState(/** @type {any} */ (null));
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    api(`join/${code}`)
      .then(setInfo)
      .catch((e) => setProblem(e.message));
  }, [code]);

  const join = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = info.person ? {} : { name: name.trim(), handle: handle.trim() };
      const { challengeId, publicKey } = await api(`join/${code}/options`, { method: 'POST', body });
      const credential = await makePasskey(publicKey);
      await api(`join/${code}`, { method: 'POST', body: { challengeId, credential } });
      location.replace('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const grants = info?.grants ?? [];
  return (
    <main id="main" class="signin">
      <div class="signin-card">
        <h1 class="signin-logo">
          <Logo kind="logo" />
          <span class="visually-hidden">breakaway</span>
        </h1>
        {problem ? (
          <>
            <p class="display signin-tagline">This link doesn’t work.</p>
            <p class="field-error" role="alert">
              {problem}
            </p>
            <a class="btn btn-outline btn-block" href="/">
              Go to sign in
            </a>
          </>
        ) : !info ? (
          <p class="muted" aria-busy="true">
            Opening your invite…
          </p>
        ) : (
          <>
            <p class="display signin-tagline">
              {info.person ? `Welcome back, ${info.person.name}.` : 'Join the board.'}
            </p>
            <p>
              {info.person
                ? `${info.inviter} reset your way in. Make a new passkey on this device to sign in again.`
                : `${info.inviter} invited you to work on this board.`}
            </p>
            <ul class="join-grants">
              {grants.map((g) => (
                <li key={g.repository}>
                  <strong>{roleLabel(g.role)}</strong> on {repoWords(g.repository)}
                </li>
              ))}
            </ul>
            {!passkeysWork() ? (
              <p class="field-error" role="alert">
                This browser can’t make passkeys, and the board signs people in with one. Open the link in an up-to-date
                browser on your phone or computer.
              </p>
            ) : (
              <form class="signin-form" onSubmit={join}>
                {!info.person && (
                  <>
                    <label class="field">
                      <span class="field-label">Your name</span>
                      <input
                        class="input"
                        value={name}
                        required
                        maxLength={80}
                        autocomplete="name"
                        autoFocus
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setName(v);
                          if (!edited) setHandle(handleFrom(v));
                        }}
                      />
                      <span class="field-hint">What everyone on the board sees. You can change it later.</span>
                    </label>
                    <label class="field">
                      <span class="field-label">Handle</span>
                      <input
                        class="input"
                        value={handle}
                        required
                        maxLength={32}
                        pattern="[a-z][a-z0-9\-]{0,31}"
                        autocomplete="username"
                        spellcheck={false}
                        onInput={(e) => {
                          setEdited(true);
                          setHandle(e.currentTarget.value.toLowerCase());
                        }}
                      />
                      <span class="field-hint">
                        Lowercase letters, digits, and dashes. Activity names you by it, and it never changes.
                      </span>
                    </label>
                  </>
                )}
                {error && (
                  <p class="field-error" role="alert">
                    {error}
                  </p>
                )}
                <button type="submit" class="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
                  <KeyRound size={18} aria-hidden="true" />
                  {busy ? 'Waiting for your passkey…' : 'Make a passkey and join'}
                </button>
                <p class="meta">
                  A passkey signs you in with your fingerprint, face, or device PIN. There’s no password and no email.
                  This link works once, until {new Date(info.expires).toLocaleDateString()}.
                </p>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
