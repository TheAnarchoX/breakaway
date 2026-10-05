import { useState } from 'preact/hooks';
import { Bot, CircleSlash, ExternalLink, GitMerge, Rocket } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { hashFor, loadGitHub, toast } from '../lib/store.js';
import { PrRow } from './GitHub.jsx';
import { TurnOnDeploys } from './TurnOnDeploys.jsx';

/*
 * Deploy with breakaway (WEB-12, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 6): one card for a
 * repository without a pipeline that follows the move from the press to Turn on deploys. Move to breakaway's deploy
 * flow adds the move's task and starts its agent; the card then shows the agent, its pull request and what's left for
 * you after merging, the merge, or why the agent stopped with Try again. Once the move's files are on the default
 * branch it is Turn on deploys (WEB-13). The GitHub page and a repository's settings page (WEB-33) both show it.
 */

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** Skip hides the card for one repository in this browser. */
const skipKey = (slug) => `tasks.deploySkip.${slug}`;
function skipped(slug) {
  try {
    return localStorage.getItem(skipKey(slug)) === '1';
  } catch {
    return false;
  }
}
function saveSkip(slug) {
  try {
    localStorage.setItem(skipKey(slug), '1');
  } catch {
    /* storage blocked: the card stays hidden until reload */
  }
}

/** What the default branch suggests the repository ships (the server's `move.shape`), in the card's words. */
function flowsOf(view) {
  const shape = view.move?.shape ?? null;
  const pkg = shape?.package?.name ?? null;
  const publishes = Boolean(pkg && !shape.package.private);
  const deploys = !publishes || Boolean(shape?.worker);
  return { pkg, publishes, deploys, isPrivate: Boolean(pkg && shape.package.private) };
}

function titleOf({ publishes, deploys }) {
  if (publishes && deploys) return 'Deploy and release with breakaway';
  return publishes ? 'Release with breakaway' : 'Deploy with breakaway';
}

/** What you still do by hand once the move merges, as the spec's checklist says; the pull request repeats it. */
function AfterMerging({ deploys, publishes, branch }) {
  return (
    <ul class="deploy-card-steps">
      {deploys && (
        <>
          <li>Create the staging and production Workers, and a Cloudflare API token for each.</li>
          <li>
            Make the <code>staging</code> and <code>production</code> environments on GitHub, with the token as{' '}
            <code>CLOUDFLARE_API_TOKEN</code>, restricted to {branch}.
          </li>
          <li>Give the board’s GitHub App read and write on Actions, for Promote and Roll back.</li>
        </>
      )}
      {publishes && (
        <>
          <li>
            Make the <code>npm</code> environment, restricted to {branch}, and add a trusted publisher on npm.
          </li>
          <li>Approve each staged version on npm with 2FA.</li>
        </>
      )}
    </ul>
  );
}

/**
 * The card for one repository without a pipeline: Turn on deploys when the move's files are on its default branch,
 * else the move's stage. `label` names the repository when the view shows several, `heading` is its heading's level,
 * `skippable` offers Skip (the GitHub page; a repository's settings page doesn't), and `onDone` runs once it's on.
 * @param {Record<string, any>} props
 */
export function DeployCard({ view, label = null, heading = 'h2', skippable = true, onDone = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [hidden, setHidden] = useState(() => skippable && skipped(view?.slug));
  if (!view || view.pipeline || view.empty) return null;
  if (view.pipelineFound) return <TurnOnDeploys view={view} label={label} heading={heading} onDone={onDone} />;
  const move = view.move;
  if (!move) return null;
  const { stage, task, pr } = move;
  // Skip hides only the offer: a move under way still shows.
  if (hidden && stage === 'start') return null;

  const flows = flowsOf(view);
  const title = titleOf(flows);
  const flowName = flows.publishes && !flows.deploys ? 'release flow' : 'deploy flow';
  const id = `gh-deploy-${view.slug}`;
  const Heading = heading;
  const write = view.access?.write ?? { ok: true, reason: null };
  const taskLink = task && <a href={hashFor({ task: task.wid ?? task.uuid.slice(0, 8) })}>{task.wid ?? 'the task'}</a>;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`repos/${enc(view.slug)}/move`, { method: 'POST', body: {} });
      toast('Agent started.', 'success');
      await loadGitHub({ quiet: true });
    } catch (failure) {
      setError(failure.message);
      // A 409 carries where the move is now: show that, not what was loaded.
      if (failure.status === 409 || failure.data?.move) loadGitHub({ quiet: true });
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    saveSkip(view.slug);
    setHidden(true);
  };
  const sync = () => loadGitHub({ sync: true });

  const deploysLine = `every merge to ${view.branch} deploys to staging, and Promote and Roll back move production`;
  const releasesLine = `every merge stages a pre-release of ${flows.pkg} on npm, and Release publishes a stable one once you approve it with 2FA`;
  const what =
    flows.publishes && flows.deploys ? `${deploysLine}; ${releasesLine}` : flows.publishes ? releasesLine : deploysLine;

  return (
    <section class="gh-section turn-on deploy-card" aria-labelledby={id}>
      <Heading id={id}>
        <Rocket size={18} aria-hidden="true" />
        {label ? `${title}: ${label}` : title}
      </Heading>

      {stage === 'start' && (
        <>
          <p class="small">
            Move {view.name} to breakaway’s {flowName}: {what}. An agent reads your workflows and opens one pull request
            that keeps your checks as they are.
          </p>
          {flows.isPrivate && (
            <p class="meta">
              <code>{flows.pkg}</code>’s package.json says it’s private, so the move adds no release flow for it.
            </p>
          )}
          <div class="turn-on-actions">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              onClick={start}
              disabled={busy || !write.ok}
              aria-busy={busy}
              aria-describedby={write.ok ? undefined : `${id}-why`}
            >
              {busy ? 'Starting…' : `Move to breakaway’s ${flowName}`}
            </button>
            {skippable && (
              <button type="button" class="btn btn-quiet btn-sm" onClick={skip}>
                Skip
              </button>
            )}
            {write.ok ? (
              <span class="meta">Nothing deploys until you merge it and turn deploys on.</span>
            ) : (
              <span class="meta" id={`${id}-why`}>
                {write.reason} <a href={hashFor({ view: 'connections', task: null })}>Open Connections</a>
              </span>
            )}
          </div>
        </>
      )}

      {stage === 'running' && (
        <>
          <p class="small deploy-card-state" role="status">
            <Bot size={16} aria-hidden="true" />
            <span>
              An agent is reading your workflows: <code>{task.claim}</code> on {taskLink}.
            </span>
          </p>
          <div class="turn-on-actions">
            <a class="btn btn-quiet btn-sm" href={hashFor({ task: task.wid ?? task.uuid.slice(0, 8) })}>
              Watch live output
            </a>
            {task.session && (
              <a class="btn btn-quiet btn-sm" href={task.session} {...ext}>
                Open the session
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            )}
          </div>
        </>
      )}

      {stage === 'pr' && (
        <>
          <p class="small" role="status">
            The move’s pull request is open. Review it, then merge it.
          </p>
          <ul class="gh-prs">
            <PrRow pr={pr} showTasks={false} />
          </ul>
          <p class="small deploy-card-after">After merging, the rest is yours:</p>
          <AfterMerging deploys={flows.deploys} publishes={flows.publishes} branch={view.branch} />
          <p class="meta">The pull request’s After merging says the same, with anything it couldn’t move.</p>
        </>
      )}

      {stage === 'merged' && (
        <>
          <p class="small deploy-card-state" role="status">
            <GitMerge size={16} aria-hidden="true" />
            <span>
              #{pr?.number} merged. The board reads {view.branch} on its next sync, then offers Turn on deploys here.
            </span>
          </p>
          <div class="turn-on-actions">
            <button type="button" class="btn btn-outline btn-sm" onClick={sync}>
              Sync now
            </button>
          </div>
        </>
      )}

      {stage === 'stopped' && (
        <>
          <p class="small deploy-card-state" role="status">
            <CircleSlash size={16} aria-hidden="true" />
            <span>
              The agent on {taskLink} stopped without a pull request
              {pr && pr.state === 'closed' ? ` (#${pr.number} was closed)` : ''}.
            </span>
          </p>
          {move.reason && (
            <blockquote class="deploy-card-reason">
              <p>{move.reason.text}</p>
              {move.reason.by && <footer class="meta">{move.reason.by}</footer>}
            </blockquote>
          )}
          <div class="turn-on-actions">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              onClick={start}
              disabled={busy || !write.ok}
              aria-busy={busy}
              aria-describedby={write.ok ? undefined : `${id}-why`}
            >
              {busy ? 'Starting…' : 'Try again'}
            </button>
            {!write.ok && (
              <span class="meta" id={`${id}-why`}>
                {write.reason}
              </span>
            )}
          </div>
        </>
      )}

      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
