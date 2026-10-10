import { useEffect, useState } from 'preact/hooks';
import { Link2, Plus, Trash2, UserPlus } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { Avatar, Named } from '../lib/avatar.jsx';
import { ROLES, ago, inviteLink, isOwner, loadPeople, people, repoWords, roleLabel, whoami } from '../lib/people.js';
import { confirmDialog, repoName, repos, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';

/**
 * People, in Settings (WEB-124, docs/specs/BRK-299-people-and-roles.md, point 3, "Managing people"): who's on the
 * board, the invites still open, and, for whoever may, Invite, Change roles, Reset, and Remove. The owner reaches
 * everyone; a maintainer invites members and viewers to the repositories they maintain, and changes only the people
 * whose every grant is there and who aren't maintainers. The store checks it all again: this only says so first.
 */

/** The repositories the signed-in person maintains, or null for the owner, who reaches every one. */
function maintained() {
  const w = whoami.value;
  if (!w || w.owner) return null;
  return w.grants.filter((g) => g.role === 'maintainer' && g.repository !== '*').map((g) => g.repository);
}

/** Whether the signed-in person may invite anyone at all. */
const canInvite = () =>
  isOwner.value ||
  maintained().length > 0 ||
  whoami.value?.grants.some((g) => g.repository === '*' && g.role === 'maintainer');

/**
 * Why the signed-in person can't change `person`'s place on the board, or null when they can (the store's
 * personReach, in the board's words).
 */
function cannotChange(person) {
  if (isOwner.value) return null;
  const w = whoami.value;
  if (person.handle === w?.handle) return 'Ask someone else to change your own place on the board.';
  if (person.grants.some((g) => g.role === 'maintainer'))
    return 'Only the owner changes, resets, or removes a maintainer.';
  if (person.grants.some((g) => g.repository === '*')) return 'Only the owner changes someone with every repository.';
  const mine = new Set(maintained());
  const every = w?.grants.some((g) => g.repository === '*' && g.role === 'maintainer');
  const outside = person.grants.find((g) => !every && !mine.has(g.repository));
  if (outside) return `Only the owner or a maintainer of ${repoName(outside.repository)} can change ${person.name}.`;
  return null;
}

/** The repositories a grant may name for the signed-in person: every one and `*` for the owner, their own for a maintainer. */
function grantable() {
  const list = repos.value.list.map((r) => r.slug);
  if (isOwner.value) return ['*', ...list];
  if (whoami.value?.grants.some((g) => g.repository === '*' && g.role === 'maintainer')) return list;
  const mine = new Set(maintained());
  return list.filter((s) => mine.has(s));
}

/** The roles the signed-in person may give: only the owner makes maintainers. */
const givable = () => (isOwner.value ? ROLES : ROLES.filter((r) => r.id !== 'maintainer'));

export function PeopleSettings() {
  useEffect(() => {
    loadPeople();
  }, []);
  const { data, error } = people.value;
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(/** @type {any} */ (null));
  const [link, setLink] = useState(/** @type {null | { code: string, who: string | null }} */ (null));
  const active = (data?.people ?? []).filter((p) => !p.removed);
  const removed = (data?.people ?? []).filter((p) => p.removed);
  const open = (data?.invites ?? []).filter((i) => i.state === 'open');
  const inviter = canInvite();

  const reset = async (p) => {
    const sure = await confirmDialog({
      title: `Reset ${p.name}?`,
      body: 'Their passkeys, personal tokens, and sessions stop working now. You get a new link to give them, with the same roles.',
      confirmLabel: 'Reset',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      const { invite } = await api(`people/${enc(p.handle)}/reset`, { method: 'POST', body: {} });
      setLink({ code: invite.code, who: p.name });
      loadPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const remove = async (p) => {
    const sure = await confirmDialog({
      title: `Remove ${p.name} from the board?`,
      body: 'Their passkeys, tokens, and sessions stop working. Their name stays on what they did.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      await api(`people/${enc(p.handle)}`, { method: 'DELETE' });
      toast(`Removed ${p.name}.`, 'success');
      loadPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const revoke = async (i) => {
    try {
      await api(`people/invites/${enc(i.id)}`, { method: 'DELETE' });
      toast('Invite revoked. Its link no longer works.', 'success');
      loadPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <section class="rs-section" id="settings-people" aria-labelledby="st-people" tabIndex={-1}>
      <div class="st-head">
        <h2 id="st-people">People</h2>
        <p class="muted small">Who works on this board with you, and their role in each repository.</p>
        {inviter && (
          <button type="button" class="btn btn-outline btn-sm st-head-action" onClick={() => setInviting(true)}>
            <UserPlus size={16} aria-hidden="true" />
            Invite
          </button>
        )}
      </div>
      {!inviter && <p class="meta">Only the owner or a maintainer can invite people.</p>}
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
          {active.length === 0 ? (
            <p class="muted">Just you. Invite someone to work on a repository with you.</p>
          ) : (
            <ul class="people-list">
              {active.map((p) => {
                const no = cannotChange(p);
                const self = p.handle === whoami.value?.handle;
                return (
                  <li key={p.handle}>
                    <div class="people-who">
                      <Avatar name={p.handle} size={32} />
                      <strong>{p.name}</strong>
                      <span class="meta">
                        {p.handle}
                        {self && ' · you'}
                      </span>
                    </div>
                    <ul class="people-grants" aria-label={`${p.name}’s roles`}>
                      {p.grants.map((g) => (
                        <li key={g.repository}>
                          <span class={`pill ${g.role === 'maintainer' ? 'pill-role' : ''}`}>{roleLabel(g.role)}</span>{' '}
                          {repoWords(g.repository, repoName)}
                        </li>
                      ))}
                    </ul>
                    <span class="meta people-seen">
                      {p.seen ? `Last seen ${ago(p.seen)}` : 'Not signed in yet'}
                      {p.passkeys === 0 && ' · no passkey: Reset gives them a new link'}
                    </span>
                    <div class="people-actions">
                      {no ? (
                        !self && <span class="meta">{no}</span>
                      ) : (
                        <>
                          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setEditing(p)}>
                            Change roles<span class="visually-hidden"> of {p.name}</span>
                          </button>
                          <button type="button" class="btn btn-quiet btn-sm" onClick={() => reset(p)}>
                            Reset<span class="visually-hidden"> {p.name}</span>
                          </button>
                          <button type="button" class="btn btn-quiet btn-sm" onClick={() => remove(p)}>
                            Remove<span class="visually-hidden"> {p.name}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {open.length > 0 && (
            <div class="st-group">
              <h3>Open invites</h3>
              <ul class="people-list">
                {open.map((i) => (
                  <li key={i.id}>
                    <div class="people-who">
                      <strong>{i.person ? `Reset for ${i.person}` : 'New person'}</strong>
                      <span class="meta">Works until {new Date(i.expires).toLocaleDateString()}</span>
                    </div>
                    <ul class="people-grants">
                      {i.grants.map((g) => (
                        <li key={g.repository}>
                          <span class="pill">{roleLabel(g.role)}</span> {repoWords(g.repository, repoName)}
                        </li>
                      ))}
                    </ul>
                    <span class="meta people-seen">
                      The link was shown once, when it was made. Revoke it and invite again if it’s lost.
                    </span>
                    <div class="people-actions">
                      <button type="button" class="btn btn-quiet btn-sm" onClick={() => revoke(i)}>
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {removed.length > 0 && (
            <details class="rs-details">
              <summary>Removed ({removed.length})</summary>
              <ul class="st-repos">
                {removed.map((p) => (
                  <li key={p.handle}>
                    <span class="st-repo-name">
                      <Named name={p.handle} label={p.name} size={24} /> <span class="meta">{p.handle} (removed)</span>
                    </span>
                    <span class="meta">Removed {new Date(p.removed).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onMade={(code) => {
          setInviting(false);
          setLink({ code, who: null });
          loadPeople();
        }}
      />
      <GrantsDialog person={editing} onClose={() => setEditing(null)} />
      <LinkDialog link={link} onClose={() => setLink(null)} />
    </section>
  );
}

/** Grants, edited: a repository and a role on each row, one row per repository. */
function GrantRows({ rows, setRows }) {
  const choices = grantable();
  const roles = givable();
  const used = new Set(rows.map((r) => r.repository));
  const spare = choices.find((c) => !used.has(c));
  return (
    <fieldset class="field">
      <legend class="field-label">Roles</legend>
      <div class="grant-rows">
        {rows.map((row, i) => (
          <div class="grant-row" key={i}>
            <select
              class="input input-sm"
              aria-label="Repository"
              value={row.repository}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, repository: e.currentTarget.value } : r)))}
            >
              {choices
                .filter((c) => c === row.repository || !used.has(c))
                .map((c) => (
                  <option key={c} value={c}>
                    {repoWords(c, repoName)}
                  </option>
                ))}
            </select>
            <select
              class="input input-sm"
              aria-label="Role"
              value={row.role}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, role: e.currentTarget.value } : r)))}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            {rows.length > 1 && (
              <button
                type="button"
                class="btn btn-quiet btn-icon btn-sm"
                aria-label={`Remove ${repoWords(row.repository, repoName)}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
      {spare && (
        <button
          type="button"
          class="link-button grant-add"
          onClick={() => setRows([...rows, { repository: spare, role: roles[roles.length - 2]?.id ?? 'viewer' }])}
        >
          <Plus size={14} aria-hidden="true" /> Add a repository
        </button>
      )}
      <ul class="grant-hints">
        {roles.map((r) => (
          <li key={r.id} class="meta">
            <strong>{r.label}</strong>: {r.hint}
          </li>
        ))}
      </ul>
      {!isOwner.value && <p class="meta">Only the owner makes maintainers or gives every repository.</p>}
    </fieldset>
  );
}

/** A first row for an invite: the repository in view or the first the person may give, as a member. */
const firstRow = () => {
  const choices = grantable();
  const pick = choices.find((c) => c !== '*') ?? choices[0];
  return pick ? [{ repository: pick, role: 'member' }] : [];
};

function InviteDialog({ open, onClose, onMade }) {
  const [rows, setRows] = useState(firstRow);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    if (open) {
      setRows(firstRow());
      setDays(7);
      setProblem(null);
    }
  }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const { invite } = await api('people/invites', { method: 'POST', body: { grants: rows, days: Number(days) } });
      onMade(invite.code);
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <Dialog open={open} onClose={onClose} labelledBy="invite-title" className="dialog-small">
      {open && (
        <form class="sheet" onSubmit={submit}>
          <h2 id="invite-title">Invite someone</h2>
          <p class="muted">
            You get a link to send them yourself. It works once: they pick a name and make a passkey. No email.
          </p>
          <GrantRows rows={rows} setRows={setRows} />
          <label class="field">
            <span class="field-label">The link works for</span>
            <span class="invite-days">
              <input
                class="input input-sm"
                type="number"
                min={1}
                max={30}
                required
                value={days}
                onInput={(e) => setDays(Number(e.currentTarget.value))}
              />
              <span class="muted">days</span>
            </span>
          </label>
          {problem && (
            <p class="field-error" role="alert">
              {problem}
            </p>
          )}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy || !rows.length} aria-busy={busy}>
              <Link2 size={16} aria-hidden="true" />
              Make the link
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function GrantsDialog({ person, onClose }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    if (person) {
      setRows(person.grants.map((g) => ({ ...g })));
      setProblem(null);
    }
  }, [person]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api(`people/${enc(person.handle)}`, { method: 'PATCH', body: { grants: rows } });
      toast(`Saved ${person.name}’s roles.`, 'success');
      loadPeople();
      onClose();
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  return (
    <Dialog open={Boolean(person)} onClose={onClose} labelledBy="grants-title" className="dialog-small">
      {person && (
        <form class="sheet" onSubmit={submit}>
          <h2 id="grants-title">{person.name}’s roles</h2>
          <GrantRows rows={rows} setRows={setRows} />
          {problem && (
            <p class="field-error" role="alert">
              {problem}
            </p>
          )}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy || !rows.length} aria-busy={busy}>
              Save roles
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** A new invite's link, shown this once: the board keeps only its hash. */
function LinkDialog({ link, onClose }) {
  const url = link ? inviteLink(link.code) : '';
  return (
    <Dialog open={Boolean(link)} onClose={onClose} labelledBy="link-title" className="dialog-small">
      {link && (
        <div class="sheet">
          <h2 id="link-title">{link.who ? `Send ${link.who} this link` : 'Send them this link'}</h2>
          <p class="muted">
            Copy it now: the board can’t show it again. Send it the way you’d send anything private. It works once.
          </p>
          <code class="you-token">{url}</code>
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={onClose}>
              Done
            </button>
            <button type="button" class="btn btn-primary" onClick={() => copy(url, 'Link')}>
              Copy the link
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
