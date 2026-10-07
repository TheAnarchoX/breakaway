import { useEffect, useState } from 'preact/hooks';
import { Bot, Copy, GitPullRequest } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { hashFor, loadAgents, loadTasks, pullParam, repoName, toast } from '../lib/store.js';

/**
 * Describe it as code (WEB-92; docs/specs/IDEA-19-architect.md, "Desired state"), in the empty state of an
 * environment's desired state: the board's draft of `.github/breakaway-infra/<environment>.json` (BRK-240), read only
 * with Copy, and one press, Have an agent open the pull request, which adds a task in the environment's repository and
 * starts its agent there: it runs `infra adopt` (CLI-23), then `infra check`, and opens the pull request. The board
 * opens none itself, and nothing is applied; you merge as always. Once the task is open, it shows here with its pull
 * request, instead of the button. Propose it, on the console's change beside the map (WEB-99), is the board's own
 * pull request of the same draft.
 */

/** The open task describing the environment, with its agent or its pull request, in words. */
function TaskLine({ task, repo }) {
  const ref = task.wid ?? task.description;
  const href = hashFor({ task: task.wid ?? task.uuid });
  const pr = /^\d+$/u.test(String(task.pr ?? '')) ? Number(task.pr) : null;
  return (
    <p class="infra-describe-task">
      <Bot size={16} aria-hidden="true" />
      <span>
        <a href={href}>{ref}</a>
        {pr ? (
          <>
            {': pull request '}
            <a href={hashFor({ view: 'github', task: null, pr: pullParam(pr, repo) })}>
              <GitPullRequest size={14} aria-hidden="true" />#{pr}
            </a>
            {' is open. Merge it when it reads right, and the board compares the file with what runs.'}
          </>
        ) : task.claim ? (
          `: ${task.claim} is writing the file and opens the pull request next.`
        ) : (
          ': waiting to start. Start it from the task when there’s room.'
        )}
      </span>
    </p>
  );
}

/** @param {{ env: { id: number, name: string, repo: string, observeOnly?: boolean } }} props */
export function DescribeAsCode({ env }) {
  const [state, setState] = useState(
    /** @type {{ draft: any, draftError: string | null, task: any, refusal: string | null, routine: boolean, loading: boolean }} */ ({
      draft: null,
      draftError: null,
      task: null,
      refusal: null,
      routine: false,
      loading: true,
    }),
  );
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const load = async () => {
    const [draft, describe] = await Promise.all([
      api(`infra/environments/${enc(env.id)}/draft`).then(
        (d) => ({ draft: d.draft, draftError: null }),
        (err) => ({ draft: null, draftError: err.message }),
      ),
      api(`infra/environments/${enc(env.id)}/describe`).catch((err) => ({
        task: null,
        refusal: err.message,
        routine: false,
      })),
    ]);
    setState({ ...draft, task: describe.task, refusal: describe.refusal, routine: describe.routine, loading: false });
  };
  useEffect(() => {
    setWaiting(null);
    setError(null);
    load();
  }, [env.id]);

  if (env.observeOnly) return null;
  if (state.loading)
    return (
      <p class="muted" aria-busy="true">
        Drafting it from what runs…
      </p>
    );
  if (!state.draft)
    return <p class="muted">The board drafts the file from what runs once it can see it. {state.draftError}</p>;

  const press = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`infra/environments/${enc(env.id)}/describe`, { method: 'POST', body: {} });
      setState((s) => ({ ...s, task: res.task, refusal: null }));
      setWaiting(res.waiting ?? null);
      const ref = res.task.wid ?? res.task.description;
      toast(
        res.already
          ? `${ref} is already open.`
          : res.waiting
            ? `Added ${ref}. Start its agent from the task when there’s room.`
            : `Started an agent to describe ${env.name} as code.`,
        'success',
      );
      loadTasks();
      loadAgents();
    } catch (err) {
      setError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const { draft } = state;
  return (
    <div class="infra-describe">
      <h3>Describe it as code</h3>
      <p class="muted">
        The board drafted this file from what runs. Propose it, beside the map, and the board opens the pull request
        itself, with any changes you make there. Or have an agent write it into {repoName(env.repo)} with{' '}
        <code>infra adopt</code>, check it, and open one. Nothing is applied.
      </p>
      <div class="infra-describe-file">
        <div class="infra-describe-head">
          <code>{draft.path}</code>
          <span class="meta">
            {draft.resources} {draft.resources === 1 ? 'resource' : 'resources'}
          </span>
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => copy(draft.json, 'Draft')}>
            <Copy size={14} aria-hidden="true" />
            Copy
          </button>
        </div>
        <pre class="infra-describe-json" tabIndex={0}>
          {draft.json}
        </pre>
      </div>
      {draft.notes.length > 0 && (
        <ul class="infra-describe-notes meta">
          {draft.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {state.task ? (
        <>
          <TaskLine task={state.task} repo={env.repo} />
          {waiting && <p class="meta">It didn’t start yet: {waiting}.</p>}
        </>
      ) : state.refusal ? (
        <p class="meta infra-describe-refusal" role="status">
          {state.routine ? (
            <>
              {repoName(env.repo)}’s agent routine isn’t connected, so no agent can start there. Connect it on{' '}
              <a href={hashFor({ view: 'connections', environment: null, task: null })}>Connections</a>, then reload, or
              copy the draft and open the pull request yourself.
            </>
          ) : (
            state.refusal
          )}
        </p>
      ) : (
        <div class="infra-describe-actions">
          <button type="button" class="btn btn-primary btn-sm" onClick={press} disabled={busy} aria-busy={busy}>
            <Bot size={16} aria-hidden="true" />
            {busy ? 'Starting…' : 'Have an agent open the pull request'}
          </button>
        </div>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
