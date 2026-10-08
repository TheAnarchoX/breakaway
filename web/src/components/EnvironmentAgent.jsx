import { useEffect, useRef, useState } from 'preact/hooks';
import { Bot, Check, Plug } from 'lucide-preact';
import { api } from '../lib/api.js';
import { ENV_AGENT_STEPS, ENV_KINDS, envAgentProblems, envAgentPrompt } from '../lib/env-agent.js';
import {
  agents,
  connections,
  hashFor,
  loadAgents,
  loadConnections,
  multiRepo,
  repoName,
  repoScope,
  repos,
  routineConnected,
  toast,
} from '../lib/store.js';
import { startAgent } from './EnvironmentChange.jsx';
import { Dialog, Dictate } from './ui.jsx';

/**
 * Have an agent do it, for a new environment (WEB-121): a three-step wizard in the board's Dialog, from Add an
 * environment and from the console of an environment with nothing in it yet. 1, how: the owner's words, or let the
 * agent work it out from the repository. 2, which environment: its name, kind, and provider (fixed when it opens from
 * an environment's console). 3, the prompt (web/src/lib/env-agent.js), shown and editable. The last press ends in New
 * agent with it filled in, through the console's startAgent; from Add an environment it adds the environment first,
 * empty, so the agent's pull request has somewhere to plan. Nothing starts until the owner presses Start agent there.
 */

/** The providers connected on Connections, as `{ id, name }`. */
export const connectedProviders = () =>
  (connections.value.data?.connections ?? [])
    .filter((/** @type {any} */ c) => c.group === 'providers' && c.provider?.connected && c.state !== 'off')
    .map((/** @type {any} */ c) => ({ id: c.provider?.id ?? c.id.replace(/^provider\./u, ''), name: c.name }));

/** A provider's name on Connections, else its ID. */
const providerName = (/** @type {string} */ id) => connectedProviders().find((p) => p.id === id)?.name ?? id;

const HOW = /** @type {const} */ ([
  {
    id: 'describe',
    title: 'Describe what you need',
    note: 'Say it in your own words, like “a Worker with a D1 database and a queue for exports”.',
  },
  {
    id: 'infer',
    title: 'Let the agent work it out',
    note: 'It reads the repository: its wrangler config, bindings, code, and any files in .github/breakaway-infra/.',
  },
]);

/** No provider connected: what to connect, and where. */
function ConnectFirst() {
  return (
    <div class="infra-notice" role="status">
      <Plug size={20} aria-hidden="true" />
      <div>
        <p>
          <strong>Connect Cloudflare first.</strong> The agent sets up an environment on a provider the board can see,
          and none is connected yet. Give the board a read-only token in Connections, then come back.
        </p>
        <a class="btn btn-outline btn-sm" href={hashFor({ view: 'connections', environment: null, task: null })}>
          Open Connections
        </a>
      </div>
    </div>
  );
}

/** The repository's agent routine isn't connected: how to connect one. */
function ConnectRoutine({ repo }) {
  return (
    <div class="infra-notice" role="status">
      <Plug size={20} aria-hidden="true" />
      <div>
        <p>
          <strong>{repoName(repo)}’s agent routine isn’t connected,</strong> so no agent can start there. Connect it in
          Connections, or with <code>npx breakaway agents-connect</code> in a terminal, then open this again.
        </p>
        <a class="btn btn-outline btn-sm" href={hashFor({ view: 'connections', environment: null, task: null })}>
          Open Connections
        </a>
      </div>
    </div>
  );
}

/**
 * What Kickoff's Run it (WEB-126) fills the wizard in with: the repository, how, the first environment, the others
 * for the same pull request (`also`), the names already on the board (`existing`, never added twice), and the idea
 * whose plan the project follows.
 * @typedef {{ repo: string, how: 'describe' | 'infer', name: string, kind: string,
 *   also: { name: string, kind: string }[], existing: string[], plan: string | null }} EnvAgentPreset
 */

/**
 * The wizard. `env` is the environment whose console opened it, else null for a new one, filled in from `preset`
 * when Kickoff opens it.
 * @param {{ env: any, onClose: () => void, onAdded?: (env: any) => void, preset?: EnvAgentPreset | null }} props
 */
function Wizard({ env, onClose, onAdded, preset = null }) {
  const providers = connectedProviders();
  const [step, setStep] = useState(0);
  const [how, setHow] = useState(/** @type {'describe' | 'infer'} */ (preset?.how ?? 'describe'));
  const [need, setNeed] = useState('');
  const [repo, setRepo] = useState(env?.repo ?? preset?.repo ?? repoScope.value ?? repos.value.default);
  const [name, setName] = useState(env?.name ?? preset?.name ?? '');
  const [kind, setKind] = useState(env?.kind ?? preset?.kind ?? 'staging');
  const [provider, setProvider] = useState(env?.provider ?? providers[0]?.id ?? '');
  const [target, setTarget] = useState(env?.target ?? '');
  const [prompt, setPrompt] = useState('');
  const [problems, setProblems] = useState(/** @type {Record<string, string>} */ ({}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const heading = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const form = useRef(/** @type {HTMLFormElement | null} */ (null));
  const moved = useRef(false);

  useEffect(() => {
    if (!connections.value.loaded) loadConnections();
    if (!agents.value.loaded) loadAgents();
  }, []);
  // The first choice takes focus on opening; after that, each step's heading does, so a screen reader hears where
  // the owner is.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    else form.current?.querySelector(/** @type {'input'} */ ('input, textarea'))?.focus();
    moved.current = true;
  }, [step]);
  // The provider list may arrive after the wizard opens.
  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id);
  }, [providers.length]);

  const ask = {
    repo,
    name,
    kind,
    provider: provider ? providerName(provider) : '',
    target: target.trim() || null,
    how,
    need,
    also: preset?.also ?? [],
    plan: preset?.plan ?? null,
  };
  // The environments a Start adds: this one, and the others from Kickoff, unless the board already has them.
  const adding = env
    ? []
    : [{ name: name.trim(), kind }, ...(preset?.also ?? [])].filter(
        (e, i, all) => !preset?.existing.includes(e.name) && all.findIndex((o) => o.name === e.name) === i,
      );
  const also = (preset?.also ?? []).filter((e) => e.name !== name.trim());
  const noProvider = connections.value.loaded && !providers.length;
  const noRoutine = agents.value.loaded && !routineConnected(repo);

  const next = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const { need: needs, ...where } = envAgentProblems(ask);
    const here = step === 0 ? (needs ? { need: needs } : {}) : step === 1 ? where : {};
    setProblems(here);
    if (Object.keys(here).length) return;
    if (step === 0) return setStep(1);
    if (step === 1) {
      // The prompt is written fresh from the answers each time the owner reaches it.
      setPrompt(envAgentPrompt(ask));
      return setStep(2);
    }
    if (!prompt.trim()) {
      setError('Write what the agent should do first, or go back to have it written again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const added = [];
      for (const e of adding) {
        const first = e.name === name.trim();
        const { environment } = await api('infra/environments', {
          method: 'POST',
          body: {
            repo,
            name: e.name,
            kind: e.kind,
            provider,
            target: first ? target.trim() || null : null,
            by: 'owner',
          },
        });
        added.push(environment.name);
        onAdded?.(environment);
      }
      if (added.length) toast(`Added ${added.join(' and ')}. Start the agent from New agent.`, 'success');
      onClose();
      startAgent({ repo }, prompt.trim());
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (/** @type {string} */ key) =>
    problems[key] ? (
      <span class="field-error" id={`env-agent-${key}-error`}>
        {problems[key]}
      </span>
    ) : null;
  const described = (/** @type {string} */ key, /** @type {string} */ hint = '') =>
    [problems[key] ? `env-agent-${key}-error` : '', hint].filter(Boolean).join(' ') || undefined;
  const last = step === ENV_AGENT_STEPS.length - 1;

  return (
    <form ref={form} class="sheet env-agent" onSubmit={next} noValidate aria-busy={busy ? 'true' : undefined}>
      <div class="env-agent-head">
        <h2 id="env-agent-title">{env ? `Set up ${env.name} with an agent` : 'Set up an environment with an agent'}</h2>
        <ol class="env-agent-steps">
          {ENV_AGENT_STEPS.map((s, i) => (
            <li
              key={s.id}
              class={i < step ? 'done' : i === step ? 'now' : ''}
              aria-current={i === step ? 'step' : undefined}
            >
              <span class="env-agent-dot" aria-hidden="true">
                {i < step ? <Check size={12} /> : i + 1}
              </span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && (
        <>
          <h3 class="env-agent-q" ref={heading} tabIndex={-1}>
            How should the agent know what it needs?
          </h3>
          {noProvider ? (
            <ConnectFirst />
          ) : (
            <>
              <fieldset class="field env-agent-how">
                <legend class="visually-hidden">How the agent finds out what it needs</legend>
                {HOW.map((h) => (
                  <label key={h.id} class="env-agent-option">
                    <input
                      type="radio"
                      name="how"
                      value={h.id}
                      checked={how === h.id}
                      onChange={() => {
                        setHow(h.id);
                        setProblems({});
                      }}
                    />
                    <span>
                      <strong>{h.title}</strong>
                      <span class="meta">{h.note}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {how === 'describe' && (
                <label class="field">
                  <span class="field-label">What does it need?</span>
                  <Dictate>
                    <textarea
                      class="textarea"
                      rows={4}
                      maxLength={2000}
                      value={need}
                      aria-invalid={problems.need ? 'true' : undefined}
                      aria-describedby={described('need')}
                      onInput={(e) => {
                        setNeed(/** @type {HTMLTextAreaElement} */ (e.currentTarget).value);
                        setProblems({});
                      }}
                    />
                  </Dictate>
                  {fieldError('need')}
                </label>
              )}
            </>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <h3 class="env-agent-q" ref={heading} tabIndex={-1}>
            Which environment?
          </h3>
          {env && (
            <dl class="infra-facts env-agent-facts">
              <div>
                <dt>Repository</dt>
                <dd>{repoName(env.repo)}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{env.name}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{ENV_KINDS.find(([k]) => k === env.kind)?.[1] ?? env.kind}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{env.provider ? providerName(env.provider) : 'None'}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{env.target ?? 'None yet: the agent names one in its pull request'}</dd>
              </div>
            </dl>
          )}
          {env && Object.keys(problems).length > 0 && (
            <p class="field-error" role="alert">
              {Object.values(problems).join(' ')}
            </p>
          )}
          {!env && (
            <>
              {multiRepo.value && (
                <label class="field">
                  <span class="field-label">Repository</span>
                  <select class="select" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
                    {repos.value.list.map((r) => (
                      <option key={r.slug} value={r.slug}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div class="field-row">
                <label class="field">
                  <span class="field-label">Name</span>
                  <input
                    class="input"
                    value={name}
                    maxLength={40}
                    placeholder={kind === 'short-lived' ? 'brk-12' : kind}
                    autocomplete="off"
                    aria-invalid={problems.name ? 'true' : undefined}
                    aria-describedby={described('name', 'env-agent-name-hint')}
                    onInput={(e) => {
                      setName(e.currentTarget.value);
                      setProblems(({ name: _, ...rest }) => rest);
                    }}
                  />
                  {fieldError('name')}
                </label>
                <label class="field">
                  <span class="field-label">Kind</span>
                  <select class="select" value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
                    {ENV_KINDS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {fieldError('kind')}
                </label>
              </div>
              <span class="field-hint infra-form-hint" id="env-agent-name-hint">
                Lowercase letters, digits, and hyphens. The agent writes{' '}
                <code>.github/breakaway-infra/{name.trim() || '<name>'}.json</code>.
              </span>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">Provider</span>
                  <select
                    class="select"
                    value={provider}
                    aria-invalid={problems.provider ? 'true' : undefined}
                    aria-describedby={described('provider')}
                    onChange={(e) => {
                      setProvider(e.currentTarget.value);
                      setProblems(({ provider: _, ...rest }) => rest);
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {fieldError('provider')}
                </label>
                <label class="field">
                  <span class="field-label">Target (optional)</span>
                  <input
                    class="input"
                    value={target}
                    maxLength={100}
                    placeholder="widgets-staging"
                    autocomplete="off"
                    aria-describedby="env-agent-target-hint"
                    onInput={(e) => setTarget(e.currentTarget.value)}
                  />
                </label>
              </div>
              <span class="field-hint infra-form-hint" id="env-agent-target-hint">
                The Worker it runs on. Leave it empty and the agent names one in its pull request.
              </span>
              {also.length > 0 && (
                <p class="meta">
                  {also.map((e) => e.name).join(' and ')} too, in the same pull request, each in its own file.
                </p>
              )}
            </>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <h3 class="env-agent-q" ref={heading} tabIndex={-1}>
            The agent’s prompt
          </h3>
          <label class="field">
            <span class="visually-hidden">Prompt</span>
            <textarea
              class="textarea env-agent-prompt"
              rows={12}
              maxLength={4000}
              value={prompt}
              aria-describedby="env-agent-prompt-hint"
              onInput={(e) => {
                setPrompt(e.currentTarget.value);
                setError(null);
              }}
            />
            <span class="field-hint" id="env-agent-prompt-hint">
              Change anything; Back writes it again from your answers.{' '}
              {!adding.length
                ? 'New agent opens with it, and nothing starts until you press Start agent there.'
                : `${adding.map((e) => e.name).join(' and ')} ${adding.length > 1 ? 'are' : 'is'} added to the board with nothing in ${adding.length > 1 ? 'them' : 'it'} yet, then New agent opens with this. Nothing starts until you press Start agent there.`}
            </span>
          </label>
          {noRoutine && <ConnectRoutine repo={repo} />}
        </>
      )}

      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="sheet-actions">
        {step > 0 ? (
          <button
            type="button"
            class="btn btn-quiet"
            onClick={() => {
              setError(null);
              setProblems({});
              setStep(step - 1);
            }}
          >
            Back
          </button>
        ) : (
          <button type="button" class="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy || (step === 0 && noProvider) || (last && noRoutine)}
          aria-busy={busy}
        >
          {last ? (
            <>
              <Bot size={16} aria-hidden="true" />
              {busy
                ? 'Adding…'
                : !adding.length
                  ? 'Open New agent'
                  : `Add ${adding.map((e) => e.name).join(' and ')} and open New agent`}
            </>
          ) : (
            'Next'
          )}
        </button>
      </div>
    </form>
  );
}

/**
 * The wizard's dialog, for a view that opens it from its own button (Add an environment, Kickoff's Run it).
 * @param {{ open: boolean, onClose: () => void, env?: any, onAdded?: (env: any) => void,
 *   preset?: EnvAgentPreset | null }} props
 */
export function EnvironmentAgentDialog({ open, onClose, env = null, onAdded, preset = null }) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="env-agent-title">
      {open && <Wizard env={env} onClose={onClose} onAdded={onAdded} preset={preset} />}
    </Dialog>
  );
}

/**
 * Have an agent do it, on the console of an environment with nothing in it yet.
 * @param {{ env: any }} props
 */
export function EnvironmentAgentButton({ env }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="env-agent-start">
      <button type="button" class="btn btn-outline btn-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Bot size={16} aria-hidden="true" />
        Have an agent do it
      </button>
      <span class="meta">Describe what it needs, or let an agent work it out from the repository.</span>
      <EnvironmentAgentDialog open={open} onClose={() => setOpen(false)} env={env} />
    </div>
  );
}
