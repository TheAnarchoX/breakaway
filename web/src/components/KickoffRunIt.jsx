import { useEffect, useState } from 'preact/hooks';
import { Bot, Circle, CircleCheck, CircleDashed, Globe, Plus } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { connections, go, hashFor, loadConnections, openAddRepo, toast } from '../lib/store.js';
import { EnvironmentAgentDialog, connectedProviders } from './EnvironmentAgent.jsx';
import { TokenSetup } from './TokenSetup.jsx';

/**
 * Kickoff's last step, Run it (WEB-126): required, with three answers. Not needed (a library, research) is recorded
 * and done. Set it up now walks the setup here: a provider, each environment's write token, staging and production
 * with their first desired state from the console (Add resource builds one from nothing, BRK-291), the first plan
 * waiting for you, and deploys. Have an agent do it opens WEB-121's wizard, filled in from the kickoff, so an agent
 * drafts the environments from the repository and the plan and opens the pull request whose plan waits. Both show
 * each part's progress and what's left, from GET /api/kickoffs/<id>'s `runIt`; the answer is POST
 * /api/kickoffs/<id>/run-it, the owner's. KickoffSummary carries it to the repository's settings page.
 */

export const RUN_IT_OPTIONS = /** @type {const} */ ([
  {
    id: 'not-needed',
    title: 'Not needed',
    note: 'It doesn’t run anywhere: a library, research, notes. Nothing to set up, and agents build it either way.',
  },
  {
    id: 'now',
    title: 'Set it up now',
    note: 'You set it up here, part by part: a provider, the write tokens, staging and production, their first plan, and deploys.',
  },
  {
    id: 'agent',
    title: 'Have an agent do it',
    note: 'An agent reads the repository and the plan, writes what staging and production need, and opens a pull request whose plan waits for you.',
  },
]);

/** The environments a new project starts with. Short-lived ones, one per task, are optional and come later. */
const FIRST = [
  { name: 'staging', kind: 'staging' },
  { name: 'production', kind: 'production' },
];

/** The console of an environment, or one of its plans. */
const envHref = (/** @type {number} */ id, /** @type {string | null} */ plan = null) =>
  hashFor({ view: 'infrastructure', environment: String(id), plan, task: null });

/**
 * Run it's parts as a checklist: done, not yet, or couldn't check (the tokens, when GitHub didn't answer).
 * @param {{ runIt: any }} props
 */
export function RunItParts({ runIt }) {
  return (
    <ul class="wiz-checks ko-runit-parts">
      {runIt.parts.map((/** @type {any} */ p) => (
        <li key={p.id} class={p.done ? 'is-done' : ''}>
          {p.done ? (
            <CircleCheck size={16} aria-hidden="true" />
          ) : p.done === null ? (
            <CircleDashed size={16} aria-hidden="true" />
          ) : (
            <Circle size={16} aria-hidden="true" />
          )}
          <span>
            {p.name}
            {p.detail && <span class="meta">: {p.detail}</span>}
            <span class="visually-hidden">
              {p.done ? ', done' : p.done === null ? ', couldn’t check' : ', not yet'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What's left, in words: "Still to do: deploys on." or null when nothing is. */
export function leftWords(/** @type {any} */ runIt) {
  const names = runIt.parts
    .filter((/** @type {any} */ p) => runIt.left.includes(p.id))
    .map((/** @type {any} */ p) => p.name.charAt(0).toLowerCase() + p.name.slice(1));
  if (!names.length) return null;
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}` : names[0];
  return `Still to do: ${list}.`;
}

/**
 * The step itself, on the kickoff's page.
 * @param {{ k: any, runIt: any, idea: any, merged: boolean, onSaved: () => Promise<void> | void }} props
 */
export function RunItStep({ k, runIt, idea, merged, onSaved }) {
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [agentOpen, setAgentOpen] = useState(false);
  const choice = runIt?.choice ?? null;
  const setup = choice === 'now' || choice === 'agent';
  useEffect(() => {
    if (setup && !connections.value.loaded) loadConnections();
  }, [setup]);

  const answer = async (/** @type {string | null} */ next) => {
    setBusy('choice');
    try {
      await api(`kickoffs/${enc(k.id)}/run-it`, { method: 'POST', body: { choice: next, by: 'owner' } });
      await onSaved();
    } catch (error) {
      toast(/** @type {Error} */ (error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const part = (/** @type {string} */ id) => runIt?.parts.find((/** @type {any} */ p) => p.id === id);
  const have = new Set((runIt?.environments ?? []).map((/** @type {any} */ e) => e.name));
  const missing = FIRST.filter((e) => !have.has(e.name));
  const providers = connectedProviders();

  const addEnvironments = async () => {
    const provider = providers[0]?.id;
    if (!provider) return;
    setBusy('environments');
    try {
      for (const e of missing)
        await api('infra/environments', {
          method: 'POST',
          body: { repo: k.slug, name: e.name, kind: e.kind, provider, by: 'owner' },
        });
      toast(`Added ${missing.map((e) => e.name).join(' and ')}.`, 'success');
    } catch (error) {
      toast(/** @type {Error} */ (error).message, 'error');
    } finally {
      setBusy(null);
      await onSaved();
    }
  };

  const left = runIt && setup ? leftWords(runIt) : null;
  const plan = runIt?.plan ?? null;

  return (
    <>
      <p>
        Whether {k.github ?? k.name} runs somewhere, and how it gets there: its environments, their first plan, and
        deploys. Every repository answers this once; change the answer any time.
      </p>
      <fieldset class="field env-agent-how ko-runit-choice" disabled={!k.registered || busy === 'choice'}>
        <legend class="visually-hidden">How it runs</legend>
        {RUN_IT_OPTIONS.map((o) => (
          <label key={o.id} class="env-agent-option">
            <input
              type="radio"
              name={`run-it-${k.id}`}
              value={o.id}
              checked={choice === o.id}
              onChange={() => answer(o.id)}
            />
            <span>
              <strong>{o.title}</strong>
              <span class="meta">{o.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {!k.registered && <p class="meta">Add it to the board first, in step 2: it’s set up in its repository.</p>}
      {choice === 'not-needed' && (
        <p class="meta" role="status">
          Nothing to set up. If that changes, pick another answer.
        </p>
      )}
      {setup && runIt && (
        <div class="ko-runit">
          <RunItParts runIt={runIt} />
          <p class="meta" role="status">
            {left ?? (runIt.done ? 'All set up.' : 'Couldn’t check the tokens just now. Try again in a minute.')}
          </p>
          <ol class="ko-guide">
            {!part('provider')?.done && (
              <li>
                <p>
                  <strong>Connect Cloudflare:</strong> give the board a read-only token in Connections, so it can see
                  what runs.
                </p>
                <div class="wiz-actions">
                  <button type="button" class="btn btn-outline btn-sm" onClick={() => go('connections')}>
                    Open Connections
                  </button>
                </div>
              </li>
            )}
            {part('tokens')?.done !== true && (
              <li>
                <p>
                  <strong>The tokens:</strong> the board reads with a read-only token, and each environment applies with
                  its own write token, kept in a GitHub environment on {k.github ?? k.name}, never on the board.
                </p>
                {runIt.environments?.length ? (
                  <TokenSetup repo={k.slug} paste onChange={(view) => view?.done && onSaved()} />
                ) : (
                  <p class="meta">Each token’s checklist shows here once it has environments.</p>
                )}
              </li>
            )}
            {choice === 'now' && (
              <li>
                <p>
                  <strong>Staging and production:</strong>{' '}
                  {missing.length
                    ? `add ${missing.map((e) => e.name).join(' and ')}, then build each on its console: Add resource adds what it runs, and Propose it opens the pull request.`
                    : 'build each on its console: Add resource adds what it runs, and Propose it opens the pull request.'}{' '}
                  Short-lived ones, one per task, are optional: add them from Infrastructure later.
                </p>
                <div class="wiz-actions">
                  {missing.length > 0 && (
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      disabled={!providers.length || busy === 'environments'}
                      aria-busy={busy === 'environments'}
                      onClick={addEnvironments}
                    >
                      <Plus size={16} aria-hidden="true" />
                      {busy === 'environments' ? 'Adding…' : `Add ${missing.map((e) => e.name).join(' and ')}`}
                    </button>
                  )}
                  {(runIt.environments ?? []).map((/** @type {any} */ e) => (
                    <a key={e.id} class="btn btn-outline btn-sm" href={envHref(e.id)}>
                      Open {e.name}
                    </a>
                  ))}
                </div>
                {missing.length > 0 && !providers.length && connections.value.loaded && (
                  <p class="meta">Connect a provider first.</p>
                )}
              </li>
            )}
            {choice === 'agent' && (
              <li>
                <p>
                  <strong>The agent:</strong> it reads {k.github ?? k.name} and the plan, writes staging’s and
                  production’s desired state, runs the check, and opens a pull request. Merging it makes the first plan,
                  which waits for you. It never applies.
                </p>
                <div class="wiz-actions">
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    aria-haspopup="dialog"
                    disabled={!merged}
                    onClick={() => setAgentOpen(true)}
                  >
                    <Bot size={16} aria-hidden="true" />
                    Have an agent do it
                  </button>
                  {!merged && <span class="meta">Once the plan is merged: the agent reads it.</span>}
                  {(runIt.environments ?? []).map((/** @type {any} */ e) => (
                    <a key={e.id} class="btn btn-outline btn-sm" href={envHref(e.id)}>
                      Open {e.name}
                    </a>
                  ))}
                </div>
                <EnvironmentAgentDialog
                  open={agentOpen}
                  onClose={() => {
                    setAgentOpen(false);
                    onSaved();
                  }}
                  preset={{
                    repo: k.slug,
                    how: 'infer',
                    name: 'staging',
                    kind: 'staging',
                    also: FIRST,
                    existing: [...have],
                    plan: idea?.wid ?? null,
                  }}
                />
              </li>
            )}
            <li>
              <p>
                <strong>The first plan:</strong>{' '}
                {plan
                  ? plan.state === 'waiting'
                    ? `${plan.id} waits for you. Read it, then approve or reject it.`
                    : `${plan.id} is ${plan.state}.`
                  : 'it shows here once a change is proposed, and waits for you to approve it.'}
              </p>
              {plan && (
                <div class="wiz-actions">
                  <a
                    class={`btn ${plan.state === 'waiting' ? 'btn-primary' : 'btn-outline'} btn-sm`}
                    href={envHref(plan.environment, plan.id)}
                  >
                    Open {plan.id}
                  </a>
                </div>
              )}
            </li>
            <li>
              {part('deploys')?.done ? (
                <p>
                  <strong>Deploys are on.</strong> Releases on the GitHub page show what shipped where.
                </p>
              ) : (
                <>
                  <p>
                    <strong>Deploys:</strong> an agent moves {k.github ?? k.name} to breakaway’s deploy flow in a pull
                    request; you merge it, then turn deploys on. Every merge updates staging, and Promote puts it live.
                  </p>
                  <div class="wiz-actions">
                    <button
                      type="button"
                      class="btn btn-outline btn-sm"
                      disabled={!merged}
                      onClick={() => openAddRepo({ slug: k.slug }, 'deploys')}
                    >
                      <Globe size={16} aria-hidden="true" />
                      Turn on deploys
                    </button>
                    {!merged && <span class="meta">Once the plan is merged.</span>}
                  </div>
                </>
              )}
            </li>
          </ol>
        </div>
      )}
    </>
  );
}

/**
 * Kickoff's summary on the repository's settings page: what the kickoff that made this repository says about Run it,
 * and the way back to it. Nothing for a repository no kickoff made.
 * @param {{ slug: string }} props
 */
export function KickoffSummary({ slug }) {
  const [k, setK] = useState(/** @type {any} */ (null));
  useEffect(() => {
    let live = true;
    setK(null);
    api(`kickoffs?repo=${enc(slug)}`)
      .then((data) => {
        if (live) setK(data.kickoffs?.[0] ?? null);
      })
      .catch(() => {
        /* the summary is extra: the settings page stands without it */
      });
    return () => {
      live = false;
    };
  }, [slug]);
  if (!k) return null;
  const runIt = k.runIt;
  const title = RUN_IT_OPTIONS.find((o) => o.id === runIt?.choice)?.title ?? null;
  const setUp = Boolean(runIt?.choice) && runIt.choice !== 'not-needed';
  const left = setUp ? leftWords(runIt) : null;
  return (
    <section class="rs-section ko-summary" aria-labelledby="rs-kickoff">
      <h2 id="rs-kickoff">Kickoff</h2>
      <p class="muted small">
        {k.name} started as a pitch on Kickoff.{' '}
        {!title
          ? 'How it runs isn’t answered yet: it’s Kickoff’s last step.'
          : runIt.choice === 'not-needed'
            ? 'It doesn’t run anywhere: you answered Not needed.'
            : runIt.done
              ? `How it runs: ${title}, all set up.`
              : `How it runs: ${title}.`}
      </p>
      {setUp && (
        <>
          <RunItParts runIt={runIt} />
          {left && <p class="meta">{left}</p>}
        </>
      )}
      <div class="wiz-actions">
        <a class="btn btn-outline btn-sm" href={`#/kickoff/${k.id}`}>
          Open its kickoff
        </a>
      </div>
    </section>
  );
}
