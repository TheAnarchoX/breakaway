import { useEffect, useState } from 'preact/hooks';
import { KeyRound, Plus, Shuffle } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { Avatar, shuffleAvatar } from '../lib/avatar.jsx';
import { copy } from '../lib/clipboard.js';
import { PasskeyCancelled, makePasskey, passkeysWork } from '../lib/passkey.js';
import { ago, loadMine, mine, repoWords, roleLabel, whoami } from '../lib/people.js';
import { confirmDialog, repoName, toast } from '../lib/store.js';
import { YourClaude } from './YourClaude.jsx';

/**
 * Your avatar (WEB-134, docs/specs/ID-9-avatars.md): a pattern drawn from a seed, your handle until you shuffle.
 * Shuffle picks a new one at once, and you keep it until you shuffle again.
 * @param {{ handle: string }} props
 */
function AvatarShuffle({ handle }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const shuffle = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await shuffleAvatar();
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <div class="you-avatar">
      <Avatar name={handle} size={40} />
      <p class="muted small">
        Everyone sees this beside your name. Shuffle draws a new one, and it stays until you shuffle again.
      </p>
      <button type="button" class="btn btn-outline btn-sm" onClick={shuffle} disabled={busy} aria-busy={busy}>
        <Shuffle size={15} aria-hidden="true" />
        Shuffle
      </button>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * You, in Settings (WEB-124, docs/specs/BRK-299-people-and-roles.md, points 1 and 2): your name, your profile, your
 * passkeys, and for a person their personal tokens and the browsers they're signed in on. The owner's handle stays
 * `owner` and the token is theirs, so the owner has no tokens or sessions here. Every change is a press on the
 * signed-in board; a personal token only reads these.
 */
export function YouSettings() {
  const { data, error } = mine.value;
  const w = whoami.value;
  return (
    <section class="rs-section" id="settings-you" aria-labelledby="st-you" tabIndex={-1}>
      <div class="st-head">
        <h2 id="st-you">You</h2>
        <p class="muted small">
          {w && !w.owner
            ? `Signed in as ${w.handle}. Only you can change these.`
            : 'You run this board: the token is yours, and it always signs you in.'}
        </p>
      </div>
      {error && !data ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : (
        <>
          <div class="st-groups">
            <div class="st-group">
              <h3>Name</h3>
              <NameForm data={data} />
            </div>
            <div class="st-group">
              <h3>Avatar</h3>
              <AvatarShuffle handle={data.person.handle} />
            </div>
            {!data.person.owner && (
              <div class="st-group">
                <h3>Your roles</h3>
                <Roles grants={data.grants} />
              </div>
            )}
          </div>
          <div class="st-group">
            <h3>Profile</h3>
            <Profile />
          </div>
          <div class="st-group">
            <h3>Passkeys</h3>
            <Passkeys data={data} />
          </div>
          {!data.person.owner && (
            <>
              <div class="st-group">
                <h3>Personal tokens</h3>
                <Tokens data={data} />
              </div>
              <div class="st-group">
                <h3>Signed in</h3>
                <Sessions data={data} />
              </div>
              <div class="st-group">
                <h3>Your Claude</h3>
                <YourClaude />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** A person's display name, or the owner's optional one ("<name> (owner)" to people, "the owner" without). */
function NameForm({ data }) {
  const owner = Boolean(data.person.owner);
  const [name, setName] = useState(data.person.name ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api('me', { method: 'PATCH', body: { name: name.trim() || null } });
      await loadMine();
      toast('Name saved.', 'success');
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <form class="you-row" onSubmit={save}>
      <label class="field">
        <span class="field-label">Display name</span>
        <input
          class="input input-sm"
          value={name}
          maxLength={80}
          required={!owner}
          autocomplete="name"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <span class="field-hint">
          {owner
            ? name.trim()
              ? `People on the board see you as ${name.trim()} (owner).`
              : 'Empty, people on the board see you as the owner.'
            : `Your handle, ${data.person.handle}, never changes.`}
        </span>
      </label>
      <button
        type="submit"
        class="btn btn-outline btn-sm"
        disabled={busy || name.trim() === (data.person.name ?? '')}
        aria-busy={busy}
      >
        Save
      </button>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/** A person's grants: what they may do, and where. Whoever manages people changes them. */
function Roles({ grants }) {
  if (!grants?.length) return <p class="meta">No role yet. Ask whoever invited you.</p>;
  return (
    <>
      <ul class="you-list">
        {grants.map((g) => (
          <li key={g.repository}>
            <strong>{roleLabel(g.role)}</strong> <span class="muted">on {repoWords(g.repository, repoName)}</span>
          </li>
        ))}
      </ul>
      <p class="meta">The owner, or a maintainer of your repositories, changes these.</p>
    </>
  );
}

/**
 * Your profile (BRK-329): what you do, and a line for the agents you start. Agents read both to pitch how they answer
 * you. Neither is a permission: what you may do is your role.
 */
function Profile() {
  const [state, setState] = useState(/** @type {any} */ (null));
  const [work, setWork] = useState(/** @type {string | null} */ (null));
  const [other, setOther] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const fill = (d) => {
    setState(d);
    setWork(d.profile.work);
    setOther(d.profile.other ?? '');
    setNotes(d.profile.notes ?? '');
  };
  useEffect(() => {
    api('me/profile')
      .then(fill)
      .catch((e) => setProblem(e.message));
  }, []);
  if (!state)
    return problem ? (
      <p class="field-error" role="alert">
        {problem}
      </p>
    ) : (
      <p class="muted" aria-busy="true">
        Loading…
      </p>
    );
  const p = state.profile;
  const changed =
    work !== p.work || (work === 'other' && other.trim() !== (p.other ?? '')) || notes.trim() !== (p.notes ?? '');
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      fill(
        await api('me/profile', {
          method: 'PATCH',
          body: { work, other: work === 'other' ? other : null, notes },
        }),
      );
      toast('Profile saved.', 'success');
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <form class="you-profile" onSubmit={save}>
      <fieldset class="field">
        <legend class="field-label">Work</legend>
        <div class="you-works">
          {state.works.map((option) => (
            <label key={option.id} class={`you-work ${work === option.id ? 'is-on' : ''}`}>
              <input
                type="radio"
                name="work"
                value={option.id}
                checked={work === option.id}
                onChange={() => setWork(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                <span class="meta">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        {work && (
          <button type="button" class="link-button you-clear" onClick={() => setWork(null)}>
            Clear
          </button>
        )}
      </fieldset>
      {work === 'other' && (
        <label class="field">
          <span class="field-label">In your words</span>
          <input
            class="input input-sm"
            value={other}
            maxLength={40}
            required
            onInput={(e) => setOther(e.currentTarget.value)}
          />
        </label>
      )}
      <label class="field">
        <span class="field-label">Notes for agents</span>
        <input
          class="input input-sm"
          value={notes}
          maxLength={200}
          placeholder="New to Git, explain the steps"
          onInput={(e) => setNotes(e.currentTarget.value)}
        />
        <span class="field-hint">
          One line the agents you start read, to pitch how they answer you. It’s not a permission: your role is.
        </span>
      </label>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      <div>
        <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !changed} aria-busy={busy}>
          Save profile
        </button>
      </div>
    </form>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : null);

/** Your passkeys: add one on this device, rename, or remove. A person keeps at least one; the owner has the token. */
function Passkeys({ data }) {
  const owner = Boolean(data.person.owner);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const list = data.passkeys ?? [];
  const add = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { challengeId, publicKey } = await api('me/passkeys/options', { method: 'POST', body: {} });
      const credential = await makePasskey(publicKey);
      const name = `Passkey ${list.length + 1}`;
      await api('me/passkeys', { method: 'POST', body: { challengeId, credential, name } });
      await loadMine();
      toast('Passkey added. Rename it so you know which device it’s on.', 'success');
    } catch (err) {
      if (!(err instanceof PasskeyCancelled)) setProblem(err.message);
    }
    setBusy(false);
  };
  const remove = async (p) => {
    const sure = await confirmDialog({
      title: `Remove ${p.name}?`,
      body: owner
        ? 'It stops signing you in. The board’s token always does.'
        : 'It stops signing you in. Your other passkeys still do.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      await api(`me/passkeys/${enc(p.id)}`, { method: 'DELETE' });
      await loadMine();
      toast(`Removed ${p.name}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <>
      <p class="meta">
        {owner
          ? 'Sign in with your fingerprint, face, or device PIN instead of pasting the token. The token still signs you in, whatever you do here.'
          : 'How you sign in to the web board. Add one on each device you use.'}
      </p>
      {list.length > 0 && (
        <ul class="you-list">
          {list.map((p) => (
            <li key={p.id}>
              <Rename item={p} path={`me/passkeys/${enc(p.id)}`} what="passkey" />
              <span class="meta">
                Added {when(p.created)}
                {p.used ? `, last used ${ago(p.used)}` : ', not used yet'}
              </span>
              {(owner || list.length > 1) && (
                <button type="button" class="btn btn-quiet btn-sm" onClick={() => remove(p)}>
                  Remove<span class="visually-hidden"> {p.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!owner && list.length === 1 && (
        <p class="meta">Add another before you remove this one: you can’t sign in without one.</p>
      )}
      {passkeysWork() ? (
        <div>
          <button type="button" class="btn btn-outline btn-sm" onClick={add} disabled={busy} aria-busy={busy}>
            <KeyRound size={16} aria-hidden="true" />
            {busy ? 'Waiting for your passkey…' : 'Add a passkey'}
          </button>
        </div>
      ) : (
        <p class="meta">This browser can’t make passkeys. Add one from an up-to-date browser.</p>
      )}
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/** A passkey's or a token's name, renamed in place. */
function Rename({ item, path, what }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api(path, { method: 'PATCH', body: { name: name.trim() } });
      await loadMine();
      setEditing(false);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  if (!editing)
    return (
      <span class="you-name">
        <strong>{item.name}</strong>
        <button type="button" class="link-button" onClick={() => setEditing(true)}>
          Rename<span class="visually-hidden"> {item.name}</span>
        </button>
      </span>
    );
  return (
    <form class="you-rename" onSubmit={save}>
      <input
        class="input input-sm"
        value={name}
        maxLength={80}
        required
        aria-label={`The ${what}’s name`}
        autoFocus
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <button type="submit" class="btn btn-outline btn-sm">
        Save
      </button>
      <button type="button" class="btn btn-quiet btn-sm" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

/** A person's own tokens, for their CLI and MCP: shown once when made, revoked here. They never sign in to the web. */
function Tokens({ data }) {
  const [name, setName] = useState('');
  const [made, setMade] = useState(/** @type {null | { name: string, token: string }} */ (null));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const make = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const t = await api('me/tokens', { method: 'POST', body: { name: name.trim() } });
      setMade({ name: t.name, token: t.token });
      setName('');
      await loadMine();
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  const revoke = async (t) => {
    const sure = await confirmDialog({
      title: `Revoke ${t.name}?`,
      body: 'Whatever uses it, a CLI or an agent’s environment, stops reaching the board at once.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      await api(`me/tokens/${enc(t.id)}`, { method: 'DELETE' });
      if (made?.name === t.name) setMade(null);
      await loadMine();
      toast(`Revoked ${t.name}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <>
      <p class="meta">
        For the CLI and MCP on your computer, or your own cloud environment. Each acts as you, with your roles. None of
        them signs in to the web board.
      </p>
      {made && (
        <div class="you-made" role="status">
          <p>
            <strong>{made.name}</strong>: copy it now. The board keeps only a hash, so it can’t show it again.
          </p>
          <code class="you-token">{made.token}</code>
          <div class="you-row">
            <button type="button" class="btn btn-primary btn-sm" onClick={() => copy(made.token, 'Token')}>
              Copy the token
            </button>
            <button type="button" class="btn btn-quiet btn-sm" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {data.tokens?.length > 0 && (
        <ul class="you-list">
          {data.tokens.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong>
              <span class="meta">
                Made {when(t.created)}
                {t.used ? `, last used ${ago(t.used)}` : ', not used yet'}
              </span>
              <button type="button" class="btn btn-quiet btn-sm" onClick={() => revoke(t)}>
                Revoke<span class="visually-hidden"> {t.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form class="you-row" onSubmit={make}>
        <label class="field">
          <span class="field-label">New token’s name</span>
          <input
            class="input input-sm"
            value={name}
            maxLength={80}
            required
            placeholder="laptop"
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !name.trim()} aria-busy={busy}>
          <Plus size={16} aria-hidden="true" />
          Make a token
        </button>
      </form>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/** The browsers a person is signed in on: sign one out, or every one, this browser too. */
function Sessions({ data }) {
  const list = data.sessions ?? [];
  const end = async (s) => {
    try {
      await api(`me/sessions/${enc(s.id)}`, { method: 'DELETE' });
      if (s.current) location.replace('/');
      else {
        await loadMine();
        toast(`Signed out ${s.device}.`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const everywhere = async () => {
    const sure = await confirmDialog({
      title: 'Sign out everywhere?',
      body: 'Every browser you’re signed in on, this one too, needs your passkey again. Your tokens keep working.',
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      await api('me/sessions', { method: 'DELETE' });
      location.replace('/');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <>
      <ul class="you-list">
        {list.map((s) => (
          <li key={s.id}>
            <strong>
              {s.device}
              {s.current && <span class="muted"> · this browser</span>}
            </strong>
            <span class="meta">Last seen {ago(s.seen)}</span>
            <button type="button" class="btn btn-quiet btn-sm" onClick={() => end(s)}>
              Sign out<span class="visually-hidden"> {s.device}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" class="btn btn-outline btn-sm" onClick={everywhere}>
          Sign out everywhere
        </button>
      </div>
    </>
  );
}
