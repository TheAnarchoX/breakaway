import { useState } from 'preact/hooks';
import { CircleCheck, CircleDashed, Rocket } from 'lucide-preact';
import { api } from '../lib/api.js';
import { loadGitHub, loadRepos, toast } from '../lib/store.js';

/*
 * Turn on deploys (WEB-13, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 5): the move's pull request
 * merged, so its config and workflows are on the default branch, and one press sets the repository's pipeline. The
 * board reads the branch again on the press, so it sets exactly what's there; nothing changes before it.
 */

/**
 * The card for one repository without a pipeline whose default branch has the move's files (`view.pipelineFound`).
 * `label` names the repository when the view shows several.
 * @param {Record<string, any>} props
 */
export function TurnOnDeploys({ view, label = null }) {
  const found = view?.pipelineFound;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  if (!found) return null;
  const id = `gh-turn-on-${view.slug}`;
  const pipeline = found.pipeline;
  const workers = pipeline?.workers ?? found.workers;
  const pkg = pipeline ? (pipeline.package ?? null) : found.package;
  const flows = [workers && 'deploys', pkg && 'releases'].filter(Boolean).join(' and ');

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`repos/${encodeURIComponent(view.slug)}/pipeline`, { method: 'POST', body: { pipeline } });
      toast(`Turned on for ${view.name}.`, 'success');
      await Promise.all([loadGitHub({ sync: true }), loadRepos()]);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
      // A 409 carries what the branch says now: show that, not what was loaded.
      if (failure.status === 409) loadGitHub({ quiet: true });
    }
  };

  return (
    <section class="gh-section turn-on" aria-labelledby={id}>
      <h2 id={id}>
        <Rocket size={18} aria-hidden="true" />
        {label ? `Turn on deploys: ${label}` : 'Turn on deploys'}
      </h2>
      {pipeline ? (
        <p class="small">
          The move to breakaway’s deploy flow is on {view.branch}. Turn it on and the board follows its {flows}
          {workers ? ': Releases, Promote, and Roll back, and what each merge deploys.' : '.'}
        </p>
      ) : (
        <p class="small" role="status">
          {found.problem}
        </p>
      )}
      <dl class="turn-on-facts">
        {workers && (
          <>
            <dt>Staging</dt>
            <dd>
              <code>{workers.staging}</code>
            </dd>
            <dt>Production</dt>
            <dd>
              <code>{workers.production}</code>
            </dd>
          </>
        )}
        {pkg && (
          <>
            <dt>Package</dt>
            <dd>
              <code>{pkg}</code>
            </dd>
          </>
        )}
      </dl>
      <ul class="turn-on-files" aria-label={`Files read from ${view.branch}`}>
        <li>
          <CircleCheck size={14} aria-hidden="true" />
          <code>{found.config}</code>
        </li>
        {found.files.map((f) => (
          <li key={f}>
            <CircleCheck size={14} aria-hidden="true" />
            <code>{f}</code>
          </li>
        ))}
        {found.missing.map((f) => (
          <li key={f} class="is-missing">
            <CircleDashed size={14} aria-hidden="true" />
            <code>{f}</code>
            <span class="meta">not there yet</span>
          </li>
        ))}
      </ul>
      {pipeline && (
        <div class="turn-on-actions">
          <button type="button" class="btn btn-outline btn-sm" onClick={turnOn} disabled={busy} aria-busy={busy}>
            {busy ? 'Turning on…' : 'Turn on deploys'}
          </button>
          <span class="meta">Nothing deploys from the press: the workflows run on the next merge.</span>
        </div>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
