import { useEffect, useState } from 'preact/hooks';
import { Bike, Bot, CircleX, Copy, ExternalLink, FastForward, FileText, Rocket, Zap } from 'lucide-preact';
import { api } from '../lib/api.js';
import { ago, plural, ref } from '../lib/model.js';
import {
  actions,
  agents,
  areaLabel,
  confirmDialog,
  hashFor,
  inScope,
  loadAgents,
  multiRepo,
  navOrder,
  repoBySlug,
  repoName,
  repoSettingsHref,
  repoScope,
  repos,
  toast,
} from '../lib/store.js';
import { RepoChip, Segmented } from '../components/ui.jsx';
import { ForcedMark, MessageButton, SILENT_AFTER, TRIGGER_LABEL } from '../components/Agents.jsx';
import { ChasePanel } from '../components/Chase.jsx';
import { PelotonPanel } from '../components/Peloton.jsx';
import { Title } from '../lib/richtext.jsx';
import STUB from '../../../prompts/stub.md?raw';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, 'success');
  } catch {
    toast('Couldn’t copy. Select it and copy it yourself.', 'error');
  }
}

/** Where a repository keeps its agent prompt when its registry entry doesn't say (src/repos.js, promptPathOf). */
const DEFAULT_PROMPT_PATH = 'tools/tasks/routine-prompt.md';
const promptPathOf = (repo) => repo?.routine?.prompt || DEFAULT_PROMPT_PATH;
/** The routine's instructions on claude.ai: the stub, pointed at the repository's prompt (src/repos.js, stubFor). */
const stubFor = (path) => STUB.replaceAll('<prompt path>', path);

/**
 * Repository `slug`'s agent prompt as it is on its default branch, read through the board's GitHub App
 * (CLD-132): its text, or why there's none (`missing`, or GitHub's `error`).
 */
function usePrompt(slug) {
  const [prompt, setPrompt] = useState(null);
  useEffect(() => {
    let live = true;
    setPrompt(null);
    api(`agents/prompt${slug ? `?repo=${encodeURIComponent(slug)}` : ''}`)
      .then((data) => {
        if (live) setPrompt(data);
      })
      .catch((error) => {
        if (live) setPrompt({ ...error.data, text: null, error: error.message, status: error.status });
      });
    return () => {
      live = false;
    };
  }, [slug]);
  return prompt;
}

/**
 * What the board knows about a repository's prompt, in one line.
 * @param {Record<string, any>} props
 */
function PromptState({ prompt, repo }) {
  const branch = repo?.defaultBranch ?? 'main';
  if (!prompt) return <p class="meta">Reading the prompt…</p>;
  if (prompt.text) {
    const left = prompt.placeholders ?? [];
    return (
      <>
        <p class="meta">
          On {branch}
          {prompt.commit && (
            <>
              , last changed {ago(prompt.commit.date)} in{' '}
              {prompt.commit.url ? (
                <a href={prompt.commit.url} {...ext}>
                  {prompt.commit.message}
                </a>
              ) : (
                prompt.commit.message
              )}
            </>
          )}
          .
        </p>
        {left.length > 0 && (
          <p class="meta field-error">
            {left.length === 1 ? 'A placeholder is' : `${left.length} placeholders are`} still in it:{' '}
            {left.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <code>{p}</code>
              </span>
            ))}
            . Its agents don’t start until {left.length === 1 ? 'it’s' : 'they’re'} filled in on {branch}, since an
            agent would take {left.length === 1 ? 'it' : 'them'} as instructions.
          </p>
        )}
      </>
    );
  }
  if (prompt.missing) {
    const where = repo?.github ?? 'this repository';
    return (
      <p class="meta field-error">
        {prompt.empty
          ? `${where} has no commits yet, so it has no prompt.`
          : `${prompt.path} isn’t on ${branch} in ${where}.`}{' '}
        Its agents stop until it’s there:{' '}
        <code>{`npx breakaway repos init ${prompt.slug ?? repo?.slug ?? '<slug>'}`}</code> adds it with the other files
        the board’s agents need.
      </p>
    );
  }
  if (prompt.status === 409)
    return <p class="meta">GitHub isn’t connected, so the board can’t read the prompt. The stub still works.</p>;
  return (
    <p class="meta field-error">
      Couldn’t read the prompt: {prompt.error} Check the GitHub App can read {repo?.github ?? 'this repository'}.
    </p>
  );
}

/**
 * One repository's stub and prompt, each a button away from the clipboard.
 * @param {Record<string, any>} props
 */
function PromptRow({ repo, slug, many }) {
  const prompt = usePrompt(slug);
  const path = prompt?.path ?? promptPathOf(repo);
  const text = prompt?.text ?? null;
  const name = repo?.name ?? repoName(slug);
  const of = many ? ` for ${name}` : '';
  return (
    <li>
      {many && (
        <span class="repo-share-name">
          <strong>{name}</strong> <span class="meta">{repo?.github}</span>
        </span>
      )}
      <span class="meta">
        Prompt: <code>{path}</code>
        {prompt?.url && (
          <>
            {' '}
            ·{' '}
            <a href={prompt.url} {...ext}>
              on GitHub<span class="visually-hidden"> (opens in a new tab)</span>
            </a>
          </>
        )}
      </span>
      <span class="prompt-copy">
        <button
          type="button"
          class="btn btn-outline btn-sm"
          aria-label={`Copy the stub${of}`}
          onClick={() => copy(stubFor(path), 'Stub')}
        >
          <Copy size={16} aria-hidden="true" />
          Copy stub
        </button>
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          aria-label={`Copy the full prompt${of}`}
          disabled={!text}
          onClick={() => copy(text, 'Prompt')}
        >
          <Copy size={16} aria-hidden="true" />
          Copy full prompt
        </button>
      </span>
      <PromptState prompt={prompt} repo={repo} />
      {text && (
        <details class="prompt-show">
          <summary>Show the prompt</summary>
          <pre>{text}</pre>
        </details>
      )}
    </li>
  );
}

/** Every repository's stub and prompt (the switcher's one when it's set), so nothing needs GitHub open. */
function RoutinePrompt() {
  const list = repos.value.list.filter((r) => inScope(r.slug));
  const many = repos.value.list.length > 1;
  return (
    <section class="gh-section" aria-labelledby="routine-prompt">
      <h2 id="routine-prompt">
        <FileText size={18} aria-hidden="true" />
        Agent prompts
      </h2>
      <p class="muted small">
        A repository’s routine at{' '}
        <a href="https://claude.ai/code/routines" {...ext}>
          claude.ai/code/routines
        </a>{' '}
        holds its stub, which sends the agent to the repository’s prompt in its checkout. Paste the stub once; a change
        to the prompt needs no paste. Copy the full prompt to read it or share it.
      </p>
      <ul class="repo-shares">
        {list.length ? (
          list.map((r) => <PromptRow key={r.slug} repo={r} slug={r.slug} many={many} />)
        ) : (
          <PromptRow slug={null} many={false} />
        )}
      </ul>
    </section>
  );
}

/** The default repository's stub, to paste into its routine while setting it up. */
function StubBox() {
  const repo = repoBySlug.value.get(repos.value.default);
  const stub = stubFor(promptPathOf(repo));
  return (
    <div class="gh-command prompt-box">
      <pre>{stub}</pre>
      <button
        type="button"
        class="btn btn-quiet btn-icon btn-sm"
        aria-label="Copy the stub"
        onClick={() => copy(stub, 'Stub')}
      >
        <Copy size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function Setup() {
  return (
    <section class="gh-setup" aria-labelledby="agents-setup">
      <h2 id="agents-setup">Connect the agent routine</h2>
      <p class="muted">
        The board starts Claude Code cloud sessions through one routine on your claude.ai account. It uses your
        subscription, and it can’t read anything back. About three minutes, once.
      </p>
      <ol class="gh-steps">
        <li>
          <strong>Make the routine.</strong> At{' '}
          <a href="https://claude.ai/code/routines" {...ext}>
            claude.ai/code/routines
          </a>
          , select New routine: name it “{repoName()} task agent”, add the repository{' '}
          {repoBySlug.value.get(repos.value.default)?.github ?? repoName()}, pick the cloud environment that has the
          board’s API credential, and paste this stub as its instructions. It sends each agent to the prompt in its
          checkout.
          <StubBox />
        </li>
        <li>
          <strong>Give it an API trigger.</strong> Save it, then edit it: under Select a trigger, add another trigger,
          choose API, and select Generate token. Copy the URL and the token.
        </li>
        <li>
          <strong>Store them.</strong> In your checkout of {repoName()}, with wrangler logged in, run this and paste the
          two when it asks. They go straight into the Secrets Store.
          <div class="gh-command">
            <code>npx breakaway agents-connect</code>
            <button
              type="button"
              class="btn btn-quiet btn-icon btn-sm"
              aria-label="Copy the command"
              onClick={() => copy('npx breakaway agents-connect', 'Command')}
            >
              <Copy size={16} aria-hidden="true" />
            </button>
          </div>
        </li>
      </ol>
    </section>
  );
}

/** @param {Record<string, any>} props */
function Launcher({ d }) {
  const [count, setCount] = useState('3');
  // Up to the plan's slots: buttons while they fit (Pro's six), a number past that (CLD-198).
  const most = Math.max(1, d.settings.max);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const free = Math.max(0, d.settings.max - d.running.length);
  const preview = async () => setPlan(await actions.startNext(Number(count), true));
  useEffect(() => {
    setPlan(null);
  }, [count, d.running.length]);
  const go = async () => {
    setBusy(true);
    const result = await actions.startNext(Number(count));
    setBusy(false);
    if (result) setPlan(null);
  };
  return (
    <section class="gh-section launcher" aria-labelledby="launch">
      <h2 id="launch">
        <Rocket size={18} aria-hidden="true" />
        Start the next few
      </h2>
      <p class="muted small">
        The best ready tasks for agents{repoScope.value ? ` in ${repoName(repoScope.value)}` : ''}, one per area and
        none where an agent is already working, so they stay out of each other’s files.{' '}
        {free ? `${free} of ${d.settings.max} slots free.` : `All ${d.settings.max} slots are in use.`}
      </p>
      <div class="launch-row">
        {most <= 6 ? (
          <Segmented
            label="How many"
            options={upTo(most).map((n) => ({ id: n, label: n }))}
            value={count}
            onChange={setCount}
          />
        ) : (
          <input
            class="input input-sm launch-count"
            type="number"
            aria-label="How many"
            min="1"
            max={most}
            step="1"
            value={count}
            onInput={(e) => setCount(e.currentTarget.value)}
          />
        )}
        <button type="button" class="btn btn-outline btn-sm" onClick={preview}>
          See which
        </button>
        <button type="button" class="btn btn-primary btn-sm" disabled={busy || !free} onClick={go}>
          <Bot size={16} aria-hidden="true" />
          {busy ? 'Starting…' : `Start ${count === '1' ? 'one' : count}`}
        </button>
      </div>
      {plan && (
        <div class="plan">
          {plan.started.length ? (
            <ul class="plan-list">
              {plan.started.map((t) => (
                <li key={t.uuid}>
                  <a href={hashFor({ task: t.wid })}>
                    <span class="wid">{t.wid}</span> <Title text={t.description} />
                  </a>
                  <RepoChip slug={t.repo} />
                  <span class="meta">{areaLabel(t.project)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted small">Nothing can start right now.</p>
          )}
          {plan.skipped.length > 0 && (
            <details class="plan-skipped">
              <summary>Why not the others ({plan.skipped.length})</summary>
              <ul>
                {plan.skipped.slice(0, 20).map((t) => (
                  <li key={t.uuid}>
                    <span class="wid">{t.wid}</span> {t.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

const upTo = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

/**
 * The chases that are on (docs/specs/IDEA-28-features-and-chase.md, section 3.9), each with its live line, its
 * limit, Needs you, Stuck, and the queue. Features are the board's, so the repository switcher doesn't narrow
 * them; the agents a chase started are in Running above, marked as the chase's.
 * @param {Record<string, any>} props
 */
function Chases({ list }) {
  if (!list?.length) return null;
  return (
    <section class="gh-section" aria-labelledby="chases">
      <h2 id="chases">
        <FastForward size={18} aria-hidden="true" />
        Chases <span class="count">{list.length}</span>
      </h2>
      <ul class="ch-chases">
        {list.map((c) => (
          <li key={c.slug} aria-labelledby={`chase-${c.slug}`}>
            <h3 id={`chase-${c.slug}`} class="ch-chase-title">
              <a href={hashFor({ view: 'roadmap', feature: c.slug, task: null })}>
                <Title text={c.title} />
              </a>{' '}
              <span class="fr-slug">+{c.slug}</span>
            </h3>
            <ChasePanel feature={c} chase={c} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Each repository's peloton under the switcher (docs/specs/IDEA-32-peloton.md, section 5): who rides it and what
 * they said, newest last. Read-only: to steer one agent, message it from Running.
 */
function Pelotons() {
  const scope = repoScope.value;
  const list = repos.value.list;
  const slugs = scope ? [scope] : list.length ? list.map((r) => r.slug) : [repos.value.default].filter(Boolean);
  if (!slugs.length) return null;
  return (
    <section class="gh-section" aria-labelledby="peloton">
      <h2 id="peloton">
        <Bike size={18} aria-hidden="true" />
        Peloton
      </h2>
      <p class="muted small">Running agents check in here and say what they did. To steer one, message it.</p>
      {multiRepo.value && !scope ? (
        <ul class="ch-chases">
          {slugs.map((slug) => (
            <li key={slug} aria-labelledby={`peloton-${slug}`}>
              <h3 id={`peloton-${slug}`} class="ch-chase-title">
                {repoName(slug)}
              </h3>
              <PelotonPanel name={slug} />
            </li>
          ))}
        </ul>
      ) : (
        <PelotonPanel name={slugs[0]} />
      )}
    </section>
  );
}

/**
 * The owner's Claude plan (CLD-198). Claude doesn't tell the board which plan an account is on, so the owner
 * picks it here, and it sets the ceilings and defaults of the board's limits. Claude's own limits on starting
 * a routine are the same on every plan.
 * @param {Record<string, any>} props
 */
function PlanField({ d }) {
  const plans = d.plans ?? [];
  const pick = async (id) => {
    const plan = plans.find((p) => p.id === id);
    if (!plan || id === d.settings.plan) return;
    const ok = await confirmDialog({
      title: `Switch to ${plan.name}?`,
      body: `Agents at once goes to ${plan.agents.default} (up to ${plan.agents.most}), starts an hour to ${Math.min(plan.hourly.default, d.limits.hourly)}, and routine runs a day to ${plan.routinesDaily.default}. You can change each one after.`,
      confirmLabel: `Use ${plan.name}`,
    });
    if (ok) actions.claudePlan(id);
  };
  return (
    <div class="field plan-field">
      <span class="field-label">Your Claude plan</span>
      <Segmented
        label="Your Claude plan"
        options={plans.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.usage > 1 ? `${p.usage}× Pro’s usage` : 'Claude Pro',
        }))}
        value={d.settings.plan}
        onChange={pick}
      />
      <span class="field-hint">
        Claude doesn’t tell the board your plan, so pick it here. It sets how high the limits below can go. Claude
        allows {d.limits.routineHourly} starts an hour for each routine and {d.limits.accountHourly} for your account,
        on every plan.
      </span>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Settings({ d }) {
  const s = d.settings;
  const limits = d.limits ?? { agents: 6, hourly: 30 };
  const setHourly = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= limits.hourly) actions.agentSettings({ hourly: n });
  };
  const setMax = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= limits.agents) actions.agentSettings({ max: n });
  };
  return (
    <section class="gh-section" aria-labelledby="agent-settings">
      <h2 id="agent-settings">Settings</h2>
      <PlanField d={d} />
      <div class="settings-grid">
        {limits.agents <= 6 ? (
          <div class="field">
            <span class="field-label">Agents at once</span>
            <Segmented
              label="Agents at once"
              options={upTo(limits.agents).map((n) => ({ id: n, label: n }))}
              value={String(s.max)}
              onChange={(v) => actions.agentSettings({ max: Number(v) })}
            />
            <span class="field-hint">A task in review doesn’t count: its slot frees up when the PR opens.</span>
          </div>
        ) : (
          <label class="field">
            <span class="field-label">Agents at once</span>
            <input
              class="input input-sm"
              type="number"
              min="1"
              max={limits.agents}
              step="1"
              defaultValue={s.max}
              key={`${s.plan}-${s.max}`}
              onChange={setMax}
            />
            <span class="field-hint">
              1 to {limits.agents} on your plan. A task in review doesn’t count: its slot frees up when the PR opens.
            </span>
          </label>
        )}
        <label class="field">
          <span class="field-label">Starts an hour</span>
          <input
            class="input input-sm"
            type="number"
            min="1"
            max={limits.hourly}
            step="1"
            defaultValue={s.hourly}
            key={`${s.plan}-${s.hourly}`}
            onChange={setHourly}
          />
          <span class="field-hint">
            Most agents the board starts in an hour, 1 to {limits.hourly} (
            {limits.hourly > limits.routineHourly
              ? `${limits.routineHourly} for each routine`
              : 'Claude’s limit for the routine'}
            ). Every start uses your Claude subscription.
          </span>
        </label>
        <div class="field">
          <span class="field-label">Start by itself</span>
          <Segmented
            label="Start by itself"
            options={[
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
            ]}
            value={s.autostart ? 'on' : 'off'}
            onChange={(v) => actions.agentSettings({ autostart: v === 'on' })}
          />
          <span class="field-hint">
            Tasks marked Start when ready start their agent as soon as nothing blocks them.
          </span>
        </div>
        <label class="field">
          <span class="field-label">New security alerts</span>
          <select
            class="select select-sm"
            value={s.alerts}
            onChange={(e) => actions.agentSettings({ alerts: e.currentTarget.value })}
          >
            <option value="off">Leave them to me</option>
            <option value="critical">Critical ones get an agent</option>
            <option value="high">High and critical get an agent</option>
            <option value="medium">Medium and up get an agent</option>
            <option value="all">Every alert gets an agent</option>
          </select>
          <span class="field-hint">A new alert at that level becomes a task that starts its own agent.</span>
        </label>
      </div>
      <p class="meta">
        {d.budget.used} of {d.budget.limit} starts used this hour. Every start uses your Claude subscription.
      </p>
    </section>
  );
}

/**
 * Each repository's share of the board's agents (IDEA-14 section 4): the slots and the hourly starts are
 * shared, and a repository can be capped below them. Hidden while there is only one repository.
 * @param {Record<string, any>} props
 */
function Repositories({ d }) {
  if ((d.repos?.length ?? 0) < 2) return null;
  const capOptions = (most) => [
    { id: '', label: 'No cap' },
    ...Array.from({ length: most }, (_, i) => ({ id: String(i + 1), label: String(i + 1) })),
  ];
  return (
    <section class="gh-section" aria-labelledby="agent-repos">
      <h2 id="agent-repos">Repositories</h2>
      <p class="muted small">
        Every repository shares the {d.settings.max} slots and {d.settings.hourly} starts an hour, and Claude starts at
        most {d.limits?.routineHourly ?? 30} an hour through each one’s routine. Cap one so a busy repository can’t take
        them all.
      </p>
      <ul class="repo-shares">
        {d.repos.map((r) => (
          <li key={r.slug}>
            <span class="repo-share-name">
              <strong>{r.name}</strong> <span class="meta">{r.github}</span>
              <a class="repo-share-settings" href={repoSettingsHref(r.slug)}>
                Settings<span class="visually-hidden"> for {r.name}</span>
              </a>
            </span>
            {r.connected ? (
              <>
                <span class="meta">
                  {r.running} running · {r.used} {r.used === 1 ? 'start' : 'starts'} this hour
                </span>
                <span class="repo-share-caps">
                  <label class="field">
                    <span class="field-label">At once</span>
                    <select
                      class="select select-sm"
                      aria-label={`At once in ${r.name}`}
                      value={r.caps.max ?? ''}
                      onChange={(e) =>
                        actions.repoCaps(r.slug, { max: e.currentTarget.value ? Number(e.currentTarget.value) : null })
                      }
                    >
                      {capOptions(d.settings.max).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">An hour</span>
                    <select
                      class="select select-sm"
                      aria-label={`An hour in ${r.name}`}
                      value={r.caps.hourly ?? ''}
                      onChange={(e) =>
                        actions.repoCaps(r.slug, {
                          hourly: e.currentTarget.value ? Number(e.currentTarget.value) : null,
                        })
                      }
                    >
                      {capOptions(Math.min(d.settings.hourly, d.limits?.routineHourly ?? 30)).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </span>
              </>
            ) : (
              <>
                <span class="meta">
                  Its routine isn’t connected. Make one for {r.github} like {repoName()}’s, then store it:
                </span>
                <div class="gh-command">
                  <code>{`npx breakaway agents-connect --repo ${r.slug}`}</code>
                  <button
                    type="button"
                    class="btn btn-quiet btn-icon btn-sm"
                    aria-label="Copy the command"
                    onClick={() => copy(`npx breakaway agents-connect --repo ${r.slug}`, 'Command')}
                  >
                    <Copy size={16} aria-hidden="true" />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentsView() {
  const state = agents.value;
  useEffect(() => {
    navOrder.value = [];
    loadAgents();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadAgents();
    }, 5000);
    return () => clearInterval(id);
  }, []);
  const all = state.data;
  // The switcher's repository: its running agents, queue, and recent starts. Slots and the budget stay the board's.
  const d = all && {
    ...all,
    running: all.running.filter((r) => inScope(r.repo)),
    queue: all.queue.filter((q) => inScope(q.repo)),
    recent: all.recent.filter((r) => inScope(r.repo)),
  };
  const scope = repoScope.value;
  return (
    <div class="agents-view">
      <div class="view-intro">
        <h1>Agents</h1>
        <p class="muted">
          {!d
            ? 'Loading…'
            : d.connected
              ? `${scope ? `${d.running.length} in ${repoName(scope)}, ${all.running.length}` : d.running.length} of ${d.settings.max} running · ${d.queue.length} waiting to start · starts itself ${d.settings.autostart ? 'when ready' : 'never (off)'}${all.chases?.length ? ` · ${plural(all.chases.length, 'chase')} on` : ''}`
              : 'Claude Code cloud sessions, started from the board.'}
        </p>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {d && !d.connected && <Setup />}
      {d?.connected && (
        <div class="gh-grid">
          <div class="gh-col">
            <Chases list={all.chases} />
            <section class="gh-section" aria-labelledby="running">
              <h2 id="running">
                <Bot size={18} aria-hidden="true" />
                Running <span class="count">{d.running.length}</span>
              </h2>
              {d.running.length ? (
                <ul class="agent-cards">
                  {d.running.map((r) => (
                    <li key={r.uuid} class={`agent-card ${r.live ? 'is-live' : ''}`}>
                      <div class="agent-card-top">
                        <a href={hashFor({ task: r.wid })} class="agent-card-task">
                          <span class="wid">{r.wid}</span> <RepoChip slug={r.repo} /> <Title text={r.description} />
                        </a>
                        {r.url && (
                          <a
                            class="btn btn-quiet btn-icon btn-sm"
                            href={r.url}
                            {...ext}
                            aria-label={`Open ${r.agent}’s session`}
                          >
                            <ExternalLink size={16} aria-hidden="true" />
                          </a>
                        )}
                      </div>
                      <span class="agent-card-meta">
                        <span class={`live-state ${r.live ? 'is-live' : ''}`}>
                          {r.live ? (
                            <>
                              <span class="live-dot" aria-hidden="true" />
                              Working
                            </>
                          ) : r.lastAt ? (
                            `Quiet for ${ago(r.lastAt).replace(' ago', '')}`
                          ) : Date.now() - Date.parse(r.startedAt) > SILENT_AFTER ? (
                            'No live output'
                          ) : (
                            'Starting'
                          )}
                        </span>
                        <span class="meta">
                          {r.agent} · {TRIGGER_LABEL[r.trigger] ?? r.trigger} {ago(r.startedAt)}
                        </span>
                        {r.forced && <ForcedMark />}
                      </span>
                      {r.lastLine && <code class="agent-last">{r.lastLine}</code>}
                      <div class="agent-card-actions">
                        <MessageButton run={r} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted small">No agents running. Start one from a task, or the next few below.</p>
              )}
            </section>
            <Pelotons />
            <Launcher d={all} />
            <section class="gh-section" aria-labelledby="queue">
              <h2 id="queue">
                <Zap size={18} aria-hidden="true" />
                Waiting to start <span class="count">{d.queue.length}</span>
              </h2>
              {d.queue.length ? (
                <ul class="queue-list">
                  {d.queue.map((q) => (
                    <li key={q.uuid}>
                      <a href={hashFor({ task: ref(q) })}>
                        <span class="wid">{ref(q)}</span> <RepoChip slug={q.repo} /> <Title text={q.description} />
                      </a>
                      <span class={`meta ${q.ready ? 'queue-ready' : ''}`}>
                        {q.ready ? 'Starts on the next check' : q.reason}
                      </span>
                      {q.forceable && (
                        <button
                          type="button"
                          class="btn btn-outline btn-sm"
                          aria-label={`Force start ${ref(q)}, past: ${q.reason}`}
                          onClick={() => actions.startAgent(q, '')}
                        >
                          Force start
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted small">
                  Mark a task Start when ready and it waits here until nothing blocks it, then starts its own agent.
                </p>
              )}
            </section>
            <section class="gh-section" aria-labelledby="recent-runs">
              <h2 id="recent-runs">Recent starts</h2>
              {d.recent.length ? (
                <ul class="queue-list">
                  {d.recent.map((r) => (
                    <li key={r.id}>
                      <span>
                        {r.status === 'failed' ? (
                          <CircleX size={14} aria-hidden="true" class="checks-failure" />
                        ) : (
                          <Bot size={14} aria-hidden="true" />
                        )}{' '}
                        <a href={hashFor({ task: r.wid })}>
                          <span class="wid">{r.wid}</span>
                        </a>{' '}
                        <RepoChip slug={r.repo} /> {TRIGGER_LABEL[r.trigger] ?? r.trigger} {ago(r.startedAt)}{' '}
                        {r.forced && <ForcedMark />}
                      </span>
                      <span class="meta">
                        {r.status === 'failed' ? (
                          r.error
                        ) : r.taskStatus === 'completed' ? (
                          'done'
                        ) : r.url ? (
                          <a href={r.url} {...ext}>
                            session
                          </a>
                        ) : (
                          r.status
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted small">Nothing started yet.</p>
              )}
            </section>
          </div>
          <div class="gh-col">
            <Settings d={d} />
            <Repositories d={d} />
            <RoutinePrompt />
          </div>
        </div>
      )}
    </div>
  );
}
