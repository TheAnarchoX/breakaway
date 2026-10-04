import { useState } from 'preact/hooks';
import {
  ArrowDown,
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  LoaderCircle,
  Rocket,
  TriangleAlert,
  Undo2,
} from 'lucide-preact';
import { api } from '../lib/api.js';
import { ago, shortVersion } from '../lib/model.js';
import { hashFor, loadGitHub, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

export const STATES = {
  live: { label: 'Live', Icon: CircleCheck, tone: 'ok' },
  deploying: { label: 'Deploying', Icon: LoaderCircle, tone: 'pending' },
  failed: { label: 'Failed', Icon: CircleX, tone: 'bad' },
  rolledback: { label: 'Rolled back', Icon: Undo2, tone: 'warn' },
  none: { label: 'Nothing deployed yet', Icon: CircleDashed, tone: 'muted' },
};

/** The words a screen reader hears for a card; also what the polite live region announces when they change. */
export function summary(name, card) {
  const s = STATES[card.state];
  const build = card.build ? `, ${card.build.sha7}` : '';
  const step = card.state === 'deploying' && card.step ? `, ${card.step}` : '';
  return `${name}: ${s.label.toLowerCase()}${build}${step}`;
}

/** @param {Record<string, any>} props */
function Card({ name, card, children }) {
  const s = STATES[card.state];
  const b = card.build;
  return (
    <div class={`flow-card flow-${s.tone}`} role="group" aria-label={summary(name, card)}>
      <div class="flow-head">
        <h3>{name}</h3>
        <span class="flow-state">
          <s.Icon size={16} aria-hidden="true" class={card.state === 'deploying' ? 'spin' : ''} />
          {s.label}
          {card.state === 'deploying' && card.step ? `: ${card.step}` : ''}
        </span>
      </div>
      {b ? (
        <dl class="flow-facts">
          <div>
            <dt>Commit</dt>
            <dd>
              {card.commitUrl ? (
                <a class="gh-sha" href={card.commitUrl} {...ext}>
                  {b.sha7}
                </a>
              ) : (
                <span class="gh-sha">{b.sha7}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>
              <code>{shortVersion(b)}</code>
              {b.preRelease && <span class="meta"> pre-release</span>}
            </dd>
          </div>
          <div>
            <dt>Went live</dt>
            <dd>
              <span title={b.at}>{ago(b.at)}</span>
            </dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>
              {b.ci ? (
                <a href={b.ci.url} {...ext}>
                  {b.ci.state === 'success' ? 'CI passed' : b.ci.state === 'failure' ? 'CI failed' : 'CI running'}
                </a>
              ) : (
                'CI not seen'
              )}
              ; deploy check passed
            </dd>
          </div>
          {b.migrations && (
            <div>
              <dt>Migrations</dt>
              <dd>{b.migrations}</dd>
            </div>
          )}
          {card.tasks?.length > 0 && (
            <div>
              <dt>Tasks</dt>
              <dd>
                {card.tasks.map((w) => (
                  <a key={w} class="gh-task" href={hashFor({ task: w })}>
                    <span class="wid">{w}</span>
                  </a>
                ))}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p class="muted small">Nothing has been deployed here yet.</p>
      )}
      {card.attempt && card.state !== 'deploying' && (
        <p class="flow-attempt meta">
          The last try, {card.attempt.sha7}
          {card.attempt.at ? `, ${ago(card.attempt.at)}` : ''}: {card.attempt.description ?? card.state}
          {card.attempt.url && (
            <>
              {' '}
              <a href={card.attempt.url} {...ext}>
                Open the run
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </>
          )}
        </p>
      )}
      {children}
    </div>
  );
}

/** Promote and Roll back name their repository, unless it's the default one (a legacy install's calls stay as they were). */
const repoBody = (view) => (view.isDefault === false ? { repo: view.slug } : {});

/** @param {Record<string, any>} props */
function PromoteDialog({ flow, view, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sure, setSure] = useState(false);
  const { ahead, promote, candidate } = flow;
  const destructive = ahead?.destructive ?? [];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('github/promote', {
        method: 'POST',
        body: { sha: promote.sha, destructiveOk: destructive.length ? sure : undefined, ...repoBody(view) },
      });
      toast(`Promoting ${candidate.sha7}. Production changes in a few minutes.`, 'success');
      onClose();
      loadGitHub({ sync: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="promote-title" className="dialog-small">
      <div class="sheet">
        <h2 id="promote-title">Promote {candidate.sha7} to production?</h2>
        {promote.tried && (
          <p class="flow-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            This build was tried in production {ago(promote.tried.at)} and{' '}
            {promote.tried.rolledBack ? 'rolled back' : 'failed'}. Promote it again?
          </p>
        )}
        <ul class="merge-facts">
          <li>{flow.line}</li>
          {ahead?.tasks.length > 0 && <li>Carries {ahead.tasks.map((t) => t.wid).join(', ')}.</li>}
          {ahead?.migrations.length > 0 && (
            <li>Applies {ahead.migrations.join(', ')} to the production database first. Migrations only go forward.</li>
          )}
          {ahead?.config && (
            <li>
              A Worker config file changed. The promote stops before it touches anything if that needs a deploy by hand.
            </li>
          )}
          {view.isDefault !== false ? (
            <li>
              Live conversations end, like any deploy. If the health check fails, the previous version comes back by
              itself.
            </li>
          ) : (
            <li>{view.name}’s promote workflow does the rest and records how it went on the deployment.</li>
          )}
        </ul>
        {destructive.length > 0 && (
          <label class="check-inline flow-warning flow-sure">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.currentTarget.checked)} />
            <span>
              <TriangleAlert size={16} aria-hidden="true" /> I’ve read {destructive.join(', ')}. It removes or renames
              something, and I want it to run.
            </span>
          </label>
        )}
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={submit}
            disabled={busy || (destructive.length > 0 && !sure)}
            aria-busy={busy}
          >
            Promote to production
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** @param {Record<string, any>} props */
function RollbackDialog({ flow, view, onClose }) {
  const versions = flow.rollback.versions;
  const [version, setVersion] = useState(versions[0]?.version ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('github/rollback', { method: 'POST', body: { version, reason, ...repoBody(view) } });
      toast('Rolling production back. It takes a few minutes.', 'success');
      onClose();
      loadGitHub({ sync: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="rollback-title" className="dialog-small">
      <form class="sheet" onSubmit={submit}>
        <h2 id="rollback-title">Roll production back?</h2>
        <p>
          Puts an earlier version in front of everyone. It rolls the Worker back, not the database: migrations only go
          forward. A rollback holds until the next promote.
        </p>
        <fieldset class="flow-versions">
          <legend class="meta">Go back to</legend>
          {versions.map((v, i) => (
            <label key={v.version} class="check-inline">
              <input
                type="radio"
                name="rollback-version"
                checked={version === v.version}
                onChange={() => setVersion(v.version)}
              />
              <span>
                <code>{shortVersion(v)}</code> from {v.sha7}, {ago(v.at)}
                {i === 0 ? ' (the one before)' : ''}
              </span>
            </label>
          ))}
        </fieldset>
        <label class="field">
          <span class="field-label">What broke</span>
          <input
            class="input"
            value={reason}
            maxLength={140}
            required
            onInput={(e) => setReason(e.currentTarget.value)}
          />
          <span class="field-hint">It shows in Cloudflare and on the deployment.</span>
        </label>
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy || !reason.trim()} aria-busy={busy}>
            Roll back
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Staging and production as two cards joined by what a promote would do, for one repository with a
 * pipeline (`view`: its slug, name, flow, and access). The owner's buttons; the workflows re-check
 * everything. `label` names the repository when the view shows several.
 * @param {Record<string, any>} props
 */
export function ReleaseFlow({ view, label = null }) {
  const flow = view?.flow;
  const [dialog, setDialog] = useState(null);
  if (!flow) return null;
  const { staging, production } = flow;
  // A button that can't work says why: the workflows can't be started (Actions), before the flow's own reasons.
  const actions = view.access?.actions ?? { ok: true, reason: null };
  const promote = actions.ok ? flow.promote : { ...flow.promote, allowed: false, reason: actions.reason };
  const rollback = actions.ok ? flow.rollback : { ...flow.rollback, allowed: false, reason: actions.reason };
  const id = (name) => (label ? `${name}-${view.slug}` : name);
  return (
    <section class="gh-section flow" aria-labelledby={id('flow-title')}>
      <h2 id={id('flow-title')}>
        <Rocket size={18} aria-hidden="true" />
        {label ? `Releases: ${label}` : 'Releases'}
      </h2>
      {/* One polite announcement when a card's state changes, not one per poll. */}
      <p class="visually-hidden" aria-live="polite">
        {summary('Staging', staging)}. {summary('Production', production)}.
      </p>
      <div class="flow-row">
        <Card name="Staging" card={staging}>
          <div class="flow-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={!promote.allowed}
              aria-describedby={id('promote-reason')}
              onClick={() => setDialog('promote')}
            >
              Promote to production…
            </button>
            {!promote.allowed && (
              <span id={id('promote-reason')} class="meta">
                {promote.reason}
              </span>
            )}
          </div>
        </Card>
        <div class="flow-line" role="group" aria-label="What a promote would do">
          <ArrowRight size={18} aria-hidden="true" class="flow-arrow-wide" />
          <ArrowDown size={18} aria-hidden="true" class="flow-arrow-narrow" />
          <p>{flow.line}</p>
          {flow.ahead?.destructive.length > 0 && (
            <p class="flow-warning">
              <TriangleAlert size={15} aria-hidden="true" />
              Destructive migration: {flow.ahead.destructive.join(', ')}
            </p>
          )}
          {flow.ahead?.config && (
            <p class="meta">A Worker config changed; the promote may stop for a deploy by hand.</p>
          )}
        </div>
        <Card name="Production" card={production}>
          <div class="flow-actions">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              disabled={!rollback.allowed}
              aria-describedby={id('rollback-reason')}
              onClick={() => setDialog('rollback')}
            >
              Roll back…
            </button>
            {!rollback.allowed && (
              <span id={id('rollback-reason')} class="meta">
                {rollback.reason}
              </span>
            )}
          </div>
        </Card>
      </div>
      {dialog === 'promote' && <PromoteDialog flow={flow} view={view} onClose={() => setDialog(null)} />}
      {dialog === 'rollback' && <RollbackDialog flow={flow} view={view} onClose={() => setDialog(null)} />}
    </section>
  );
}
