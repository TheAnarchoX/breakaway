import { useEffect, useState } from 'preact/hooks';
import { CircleCheck, CircleHelp, ExternalLink, KeyRound, RefreshCw, TriangleAlert } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { confirmDialog, toast } from '../lib/store.js';
import { ProviderConnect } from './ProviderConnect.jsx';

/**
 * Guided token setup (BRK-304): a checklist for one repository's infrastructure tokens, on its Connections card and in
 * Kickoff's Run it step. The board's read token for each provider its environments run on, with a link that opens the
 * provider's create-token page prefilled; then, for each GitHub environment the apply workflow runs in, the
 * environment, its branch rule, and a secret of the right name, checked through the GitHub App by name only. The board
 * never asks for a write token: the owner makes it from the list and adds it on GitHub.
 *
 * `paste` shows the read token's paste field when it isn't connected (Kickoff; Connections has it on the provider's
 * own row). `onChange` hears each fresh checklist, so Kickoff can tell when it's done.
 * @param {{ repo: string, paste?: boolean, onChange?: (view: any) => void }} props
 */
export function TokenSetup({ repo, paste = false, onChange }) {
  const [view, setView] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const load = async (fresh = false) => {
    const body = await api(`infra/tokens?repo=${enc(repo)}${fresh ? '&fresh=1' : ''}`);
    setView(body);
    onChange?.(body);
    return body;
  };

  useEffect(() => {
    let live = true;
    setView(null);
    // A board without the route, or a read that fails, leaves the checklist away: it's never in the way.
    api(`infra/tokens?repo=${enc(repo)}`).then(
      (body) => {
        if (!live) return;
        setView(body);
        onChange?.(body);
      },
      () => live && setView(null),
    );
    return () => {
      live = false;
    };
  }, [repo]);

  if (!view || (!view.read.length && !view.environments.length)) return null;

  const again = async () => {
    setBusy('check');
    setError(null);
    try {
      await load(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const make = async (/** @type {any} */ e) => {
    const ok = await confirmDialog({
      title: `Make ${e.name} on GitHub?`,
      body: `The board’s GitHub App makes the GitHub environment ${e.name} in ${view.github}, and lets only ${view.branch} deploy to it. It adds no secret: you add the write token there yourself.`,
      confirmLabel: 'Make it on GitHub',
    });
    if (!ok) return;
    setBusy(e.name);
    setError(null);
    try {
      const body = await api(`infra/tokens/environments/${enc(e.name)}?repo=${enc(repo)}`, {
        method: 'POST',
        body: { by: 'owner' },
      });
      setView(body);
      onChange?.(body);
      toast(body.made ? `Made ${e.name} on GitHub.` : `${e.name} was already set up.`, 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const id = `tokens-${repo}`;
  return (
    <section class="token-setup" aria-labelledby={id}>
      <header class="token-setup-head">
        <KeyRound size={16} aria-hidden="true" />
        <h4 id={id}>Infrastructure tokens</h4>
        <span class={`token-setup-state ${view.done ? 'is-ok' : 'is-bad'}`}>
          {view.done ? 'All in place' : 'Not done yet'}
        </span>
      </header>
      <p class="muted small">
        The board reads with one read-only token per provider. It never holds a write token: each environment’s goes in
        its GitHub environment, where only the apply workflow reads it.
      </p>
      <ol class="token-steps">
        {view.read.map((r) => (
          <li key={`read:${r.provider}`} class="token-step">
            <StepHead ok={r.ok} label={`The board’s read token for ${r.name}`} />
            {!r.ok && r.fix && (
              <p class="token-fix">
                {paste || r.connected
                  ? r.fix
                  : `Make it from this list, then paste it on ${r.name}’s row under Infrastructure, on Connections.`}
              </p>
            )}
            {!r.ok && <Permissions list={r.permissions} template={r.template} url={r.url} provider={r.name} />}
            {!r.ok && paste && (
              <ProviderConnect id={r.provider} name={r.name} connected={r.connected} onDone={() => load(true)} />
            )}
          </li>
        ))}
        {view.environments.map((e) => (
          <li key={`env:${e.name}`} class="token-step">
            <StepHead
              ok={e.ok}
              label={`Write token for ${e.name}`}
              note={
                e.environments.length && (e.environments.length > 1 || e.environments[0] !== e.name)
                  ? `used by ${e.environments.join(', ')}`
                  : null
              }
            />
            <ul class="token-checks">
              {e.steps.map((s) => (
                <li key={s.id} class={s.ok === true ? '' : s.ok === false ? 'is-bad' : 'is-unknown'}>
                  <StepIcon ok={s.ok} />
                  <span>
                    {s.label}
                    <span class="visually-hidden">
                      : {s.ok === true ? 'done' : s.ok === false ? 'missing' : 'can’t check'}
                    </span>
                    {s.ok !== true && s.fix && <span class="token-fix-line">{s.fix}.</span>}
                  </span>
                </li>
              ))}
            </ul>
            {e.canMake && (
              <button
                type="button"
                class="btn btn-outline btn-sm"
                disabled={Boolean(busy)}
                aria-busy={busy === e.name}
                onClick={() => make(e)}
              >
                {busy === e.name ? 'Making…' : 'Make it on GitHub'}
                <span class="visually-hidden"> for {e.name}</span>
              </button>
            )}
            {!e.ok && (
              <>
                {!e.desired && (
                  <p class="muted small">
                    {e.name} has no desired state yet, so this is the least it needs. Check again once its file merges.
                  </p>
                )}
                <Permissions list={e.permissions} template={e.template} provider={e.providerName} write />
              </>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="token-setup-foot">
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          disabled={Boolean(busy)}
          aria-busy={busy === 'check'}
          onClick={again}
        >
          <RefreshCw size={15} aria-hidden="true" class={busy === 'check' ? 'spin' : ''} />
          {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
        <a class="btn btn-quiet btn-sm" href={view.settings} target="_blank" rel="noopener noreferrer">
          GitHub environments
          <ExternalLink size={15} aria-hidden="true" />
          <span class="visually-hidden"> (opens in a new tab)</span>
        </a>
        <span class="meta">
          Checked <time dateTime={view.checked}>{ago(view.checked)}</time>
        </span>
      </div>
    </section>
  );
}

/** @param {{ ok: boolean | null }} props */
function StepIcon({ ok }) {
  if (ok === true) return <CircleCheck size={15} aria-hidden="true" />;
  if (ok === false) return <TriangleAlert size={15} aria-hidden="true" />;
  return <CircleHelp size={15} aria-hidden="true" />;
}

/** @param {{ ok: boolean, label: string, note?: string | null }} props */
function StepHead({ ok, label, note = null }) {
  return (
    <p class={`token-step-head ${ok ? 'is-ok' : 'is-bad'}`}>
      <StepIcon ok={ok} />
      <strong>{label}</strong>
      <span class="visually-hidden">: {ok ? 'done' : 'not done'}</span>
      {note && <span class="muted"> {note}</span>}
    </p>
  );
}

/** Where a permission is given, in words. */
const SCOPE = {
  account: 'account',
  zones: 'only the zones it uses',
  'workers-product': 'every Worker',
};

/**
 * The permissions a token needs, and the link that opens the provider's page with what it can prefill.
 * @param {{ list: any[], template: any, url?: string, provider: string, write?: boolean }} props
 */
function Permissions({ list, template, url, provider, write = false }) {
  const link = template?.url ?? url;
  const byHand = new Set(template?.byHand ?? []);
  return (
    <details class="conn-items token-permissions" open={write}>
      <summary>{write ? 'Make the write token with exactly these' : 'Make it with exactly these, all read'}</summary>
      <ul>
        {list.map((p) => (
          <li key={p.name}>
            <span>
              <strong>{p.name}</strong>
              {p.legacy?.length ? ` (or the legacy ${p.legacy.join(' or ')})` : ''}, on{' '}
              {p.scope === 'workers' ? `only ${p.workers.join(', ')}` : (SCOPE[p.scope] ?? p.scope)}
              {p.once ? ', only for the first apply' : ''}
              {template && byHand.has(p.name) ? ' · add by hand' : ''}
              <span class="muted">, for {p.for}</span>
            </span>
          </li>
        ))}
      </ul>
      {write && (
        <p class="muted small">
          Give it an expiry date and use it for this environment only. Then add it on GitHub as the secret named above,
          never on the board.
        </p>
      )}
      {link && (
        <a class="btn btn-outline btn-sm" href={link} target="_blank" rel="noopener noreferrer">
          {template?.prefilled?.length ? `Open ${provider} with these filled in` : `Open ${provider}’s token page`}
          <ExternalLink size={15} aria-hidden="true" />
          <span class="visually-hidden"> (opens in a new tab)</span>
        </a>
      )}
    </details>
  );
}
