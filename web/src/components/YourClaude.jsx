import { useEffect, useState } from 'preact/hooks';
import { CircleAlert, CircleCheck, CircleSlash, Copy, ExternalLink, Plug } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { ago } from '../lib/people.js';
import { confirmDialog, repoBySlug, repoName, toast } from '../lib/store.js';
import STUB from '../../../prompts/stub.md?raw';
import { Dialog, Segmented } from './ui.jsx';

/**
 * Your own Claude, in Settings, under You (WEB-136, docs/specs/BRK-299-people-and-roles.md, point 5; the routes are
 * BRK-302's): the Claude plan your routines run on, the caps it gives you, and your routine for each repository you
 * may start agents in. A routine's URL and token go in once and never come back; its cloud environment holds your
 * personal token, never the board's. And, for the owner on People, a person's Claude and the limits the owner sets on it.
 */

const ROUTINES_URL = 'https://claude.ai/code/routines';
/** Where a repository keeps its agent prompt when it doesn't say (src/repos.js, promptPathOf). */
const DEFAULT_PROMPT_PATH = 'tools/tasks/routine-prompt.md';
/** The routine's instructions on claude.ai: the stub, pointed at the repository's prompt (src/repos.js, stubFor). */
const stubFor = (slug) =>
  STUB.replaceAll('<prompt path>', repoBySlug.value.get(slug)?.routine?.prompt || DEFAULT_PROMPT_PATH);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A plan's line in the picker: its name, and its usage against Pro's (the owner's picker says the same). */
const planOptions = (plans) =>
  plans.map((p) => ({ id: p.id, label: p.name, hint: p.usage > 1 ? `${p.usage}× Pro’s usage` : 'Claude Pro' }));

export function YourClaude() {
  const [claude, setClaude] = useState(/** @type {any} */ (null));
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const load = () =>
    api('me/claude')
      .then((d) => setClaude(d.claude))
      .catch((e) => setProblem(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!claude)
    return problem ? (
      <p class="field-error" role="alert">
        {problem}
      </p>
    ) : (
      <p class="muted" aria-busy="true">
        Loading…
      </p>
    );
  if (!claude.routines.length)
    return (
      <p class="meta">
        Only a member of a repository starts agents, so you have no Claude to connect yet. Ask whoever invited you.
      </p>
    );
  return (
    <div class="claude-you">
      <p class="meta">
        The agents you start run on your own Claude: a routine you make on claude.ai for each repository, on your Claude
        plan. Your plan sets how many you can run.
      </p>
      <Plan claude={claude} onSaved={setClaude} />
      {claude.plan && <Caps claude={claude} onSaved={setClaude} />}
      <ul class="claude-routines" aria-label="Your routines">
        {claude.routines.map((r) => (
          <Routine key={r.repo} r={r} claude={claude} onSaved={setClaude} />
        ))}
      </ul>
      {claude.routines.some((r) => r.lent && !r.connected) && (
        <p class="meta">
          On a routine the owner lends you, you can run {claude.lentCaps.max} at once and start {claude.lentCaps.hourly}{' '}
          an hour: it spends the owner’s plan, and its agents hold the board’s token.
        </p>
      )}
    </div>
  );
}

/** Your Claude plan: picked when you first connect a routine, changed here. A new plan sets your caps to its defaults. */
function Plan({ claude, onSaved }) {
  if (!claude.plan)
    return (
      <p class="meta">Connect a routine below and say which Claude plan its account is on: your caps come from it.</p>
    );
  const pick = async (id) => {
    const plan = claude.plans.find((p) => p.id === id);
    if (!plan || id === claude.plan) return;
    const ok = await confirmDialog({
      title: `Switch to ${plan.name}?`,
      body: `Agents at once goes to ${plan.agents.default} (up to ${plan.agents.most}), and starts an hour to ${Math.min(plan.hourly.default, claude.ceilings?.hourly ?? plan.hourly.default)}. You can change each one after.`,
      confirmLabel: `Use ${plan.name}`,
    });
    if (!ok) return;
    try {
      onSaved((await api('me/claude', { method: 'PATCH', body: { plan: id } })).claude);
      toast(`Your plan is ${plan.name}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <div class="field plan-field">
      <span class="field-label">Your Claude plan</span>
      <Segmented label="Your Claude plan" options={planOptions(claude.plans)} value={claude.plan} onChange={pick} />
      <span class="field-hint">
        Claude doesn’t tell the board your plan, so pick the one your routines’ account is on. It sets how high your
        limits below can go.
      </span>
    </div>
  );
}

/**
 * Your agents at once and starts an hour, in the Agents view's words: the plan's defaults, which you may change up to
 * its ceilings. The owner's limits on you hold on top, and say so.
 */
function Caps({ claude, onSaved }) {
  const caps = claude.caps;
  const most = claude.ceilings;
  const limited = claude.ownerLimits ?? {};
  const set = (key) => async (e) => {
    const raw = e.currentTarget.value.trim();
    const n = raw === '' ? null : Number(raw);
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= most[key])) {
      toast(`Pick a number from 1 to ${most[key]}.`, 'error');
      e.currentTarget.value = String(caps[key]);
      return;
    }
    try {
      onSaved((await api('me/claude', { method: 'PATCH', body: { [key]: n } })).claude);
      toast('Saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const owner = (key, words) =>
    Number.isInteger(limited[key]) ? ` The owner limits you to ${limited[key]} ${words}.` : '';
  const runs = claude.runs?.own;
  return (
    <>
      <div class="settings-grid">
        <label class="field">
          <span class="field-label">Agents at once</span>
          <input
            class="input input-sm"
            type="number"
            min="1"
            max={most.max}
            step="1"
            defaultValue={caps.max}
            key={`${claude.plan}-${caps.max}`}
            onChange={set('max')}
          />
          <span class="field-hint">
            1 to {most.max} on your plan. A task in review doesn’t count: its slot frees up when the PR opens.
            {owner('max', 'at once')}
          </span>
        </label>
        <label class="field">
          <span class="field-label">Starts an hour</span>
          <input
            class="input input-sm"
            type="number"
            min="1"
            max={most.hourly}
            step="1"
            defaultValue={caps.hourly}
            key={`${claude.plan}-${caps.hourly}`}
            onChange={set('hourly')}
          />
          <span class="field-hint">
            Most agents you start in an hour, 1 to {most.hourly}: Claude allows 30 for each of your routines, 100 in
            all. Every start uses your Claude subscription.
            {owner('hourly', 'an hour')}
          </span>
        </label>
      </div>
      {runs && (
        <p class="meta">
          Now: {runs.running} of {caps.max} running, {plural(runs.started, 'start')} of {caps.hourly} in the last hour.
          The board’s own limits count everyone’s agents too.
        </p>
      )}
    </>
  );
}

/** One repository's routine: connected or not, and the steps and form to connect, replace, or remove it. */
function Routine({ r, claude, onSaved }) {
  const [open, setOpen] = useState(false);
  const name = repoName(r.repo);
  const remove = async () => {
    const sure = await confirmDialog({
      title: `Remove your routine for ${name}?`,
      body: r.lent
        ? 'The board forgets its URL and token. Your agents there run on the routine the owner lends you until you connect yours again.'
        : 'The board forgets its URL and token, and you can’t start agents there until you connect one again. Delete it on claude.ai too if you’re done with it.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!sure) return;
    try {
      onSaved((await api(`me/routines/${enc(r.repo)}`, { method: 'DELETE' })).claude);
      toast(`Removed your routine for ${name}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const state = r.broken ? (
    <span class="rs-state is-bad">
      <CircleAlert size={16} aria-hidden="true" />
      <span>Can’t be read any more: the board’s key changed. Connect it again.</span>
    </span>
  ) : r.connected ? (
    <span class="rs-state is-ok">
      <CircleCheck size={16} aria-hidden="true" />
      <span>
        Connected {ago(r.editedAt ?? r.connectedAt)}. Your agents in {name} run on it.
      </span>
    </span>
  ) : (
    <span class="rs-state">
      <CircleSlash size={16} aria-hidden="true" />
      <span>
        {r.lent
          ? 'Not connected. Your agents here run on the routine the owner lends you.'
          : 'Not connected, so you can’t start agents here yet.'}
      </span>
    </span>
  );
  return (
    <li class="claude-routine">
      <div class="claude-routine-head">
        <strong>{name}</strong>
        {state}
        <div class="claude-routine-actions">
          {!open && (
            <button type="button" class="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
              <Plug size={16} aria-hidden="true" />
              {r.connected || r.broken ? 'Replace' : 'Connect'}
              <span class="visually-hidden"> your routine for {name}</span>
            </button>
          )}
          {(r.connected || r.broken) && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={remove}>
              Remove<span class="visually-hidden"> your routine for {name}</span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <Connect
          r={r}
          claude={claude}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            onSaved(next);
            setOpen(false);
          }}
        />
      )}
    </li>
  );
}

/** The owner's wizard's steps, for your own routine, then its URL, token, and (the first time) its plan. */
function Connect({ r, claude, onClose, onSaved }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState(claude.plan ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const github = repoBySlug.value.get(r.repo)?.github ?? r.repo;
  const id = `claude-${r.repo}`;
  const replace = r.connected || r.broken;
  const submit = async (e) => {
    e.preventDefault();
    if (!plan) {
      setError('Pick the Claude plan the routine’s account is on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { url: url.trim(), token: token.trim(), ...(claude.plan ? {} : { plan }) };
      const res = await api(`me/routines/${enc(r.repo)}`, { method: 'PUT', body });
      toast(res.replaced ? 'Replaced.' : 'Connected.', 'success');
      onSaved(res.claude);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div class="claude-connect">
      <ol class="claude-steps">
        <li>
          On claude.ai, make a cloud environment that allows <code>{location.host}</code>, with your{' '}
          <strong>personal token</strong> as its <code>BREAKAWAY_TOKEN</code> credential. Make one under Personal tokens
          above, named for it. Never put the board’s token there: your agents act as you, with only what your role
          allows.
        </li>
        <li>
          Make a routine for <strong>{github}</strong> in that environment, with the stub as its instructions and an API
          trigger.
          <div class="wiz-actions">
            <button type="button" class="btn btn-outline btn-sm" onClick={() => copy(stubFor(r.repo), 'Stub')}>
              <Copy size={16} aria-hidden="true" />
              Copy stub
            </button>
            <a class="btn btn-outline btn-sm" href={ROUTINES_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Open routines on claude.ai
            </a>
          </div>
        </li>
        <li>Paste the URL and token from its API trigger here.</li>
      </ol>
      <form class="setup-register" onSubmit={submit} aria-describedby={error ? `${id}-error` : undefined}>
        {!claude.plan && (
          <div class="field plan-field">
            <span class="field-label">The routine’s Claude plan</span>
            <Segmented
              label="The routine’s Claude plan"
              options={planOptions(claude.plans)}
              value={plan}
              onChange={setPlan}
            />
            <span class="field-hint">
              The plan of the claude.ai account the routine is on. Your caps come from it, and you can change it later.
            </span>
          </div>
        )}
        <label class="field">
          <span class="field-label">Routine URL</span>
          <input
            class="input"
            type="url"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            aria-describedby={`${id}-url-hint`}
          />
          <span class="field-hint" id={`${id}-url-hint`}>
            The URL of the routine’s API trigger, on claude.ai/code/routines.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Token</span>
          <input
            class="input"
            type="password"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            aria-describedby={`${id}-token-hint`}
          />
          <span class="field-hint" id={`${id}-token-hint`}>
            Generate one in the same API trigger. The board keeps it encrypted and never shows it again, not even to the
            owner.
          </span>
        </label>
        {error && (
          <p class="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        )}
        <div class="routine-connect-actions">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
            {busy ? (replace ? 'Replacing…' : 'Connecting…') : replace ? 'Replace' : 'Connect'}
          </button>
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * A person's Claude, for the owner on People: their plan, their routines, what they run, and the owner's limits on
 * their agents at once and starts an hour, on their own routines and on lent ones alike (PATCH
 * /api/people/<handle>/claude). Empty is no limit of the owner's: their plan's caps hold.
 * @param {{ person: any, onClose: () => void }} props
 */
export function PersonClaudeDialog({ person, onClose }) {
  const [claude, setClaude] = useState(/** @type {any} */ (null));
  const [max, setMax] = useState('');
  const [hourly, setHourly] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const fill = (c) => {
    setClaude(c);
    setMax(c.ownerLimits?.max ?? '');
    setHourly(c.ownerLimits?.hourly ?? '');
  };
  useEffect(() => {
    if (!person) return;
    setClaude(null);
    setProblem(null);
    api(`people/${enc(person.handle)}/claude`)
      .then((d) => fill(d.claude))
      .catch((e) => setProblem(e.message));
  }, [person]);
  const asLimit = (v) => (String(v).trim() === '' ? null : Number(v));
  const changed =
    claude &&
    (asLimit(max) !== (claude.ownerLimits?.max ?? null) || asLimit(hourly) !== (claude.ownerLimits?.hourly ?? null));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await api(`people/${enc(person.handle)}/claude`, {
        method: 'PATCH',
        body: { max: asLimit(max), hourly: asLimit(hourly) },
      });
      fill(res.claude);
      toast(`Saved ${person.name}’s limits.`, 'success');
      onClose();
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };
  const planName = claude?.plans.find((p) => p.id === claude.plan)?.name;
  const connected = claude?.routines.filter((r) => r.connected) ?? [];
  return (
    <Dialog open={Boolean(person)} onClose={onClose} labelledBy="person-claude-title" className="dialog-small">
      {person && (
        <form class="sheet" onSubmit={submit}>
          <h2 id="person-claude-title">{person.name}’s Claude</h2>
          {!claude ? (
            problem ? (
              <p class="field-error" role="alert">
                {problem}
              </p>
            ) : (
              <p class="muted" aria-busy="true">
                Loading…
              </p>
            )
          ) : (
            <>
              <ul class="claude-facts">
                <li>
                  {planName
                    ? `On ${planName}: ${claude.caps.max} at once and ${claude.caps.hourly} starts an hour on their own routines.`
                    : 'No plan yet: they haven’t connected a routine of their own.'}
                </li>
                <li>
                  {connected.length
                    ? `Their own routine for ${connected.map((r) => repoName(r.repo)).join(', ')}.`
                    : 'No routine of their own connected.'}
                </li>
                <li>
                  On a routine you lend them: {claude.lentCaps.max} at once and {claude.lentCaps.hourly} an hour.
                </li>
                {claude.runs && (
                  <li>
                    Now: {claude.runs.own.running + claude.runs.lent.running} running,{' '}
                    {plural(claude.runs.own.started + claude.runs.lent.started, 'start')} in the last hour.
                  </li>
                )}
              </ul>
              <div class="settings-grid">
                <label class="field">
                  <span class="field-label">Most at once</span>
                  <input
                    class="input input-sm"
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    placeholder="No limit"
                    value={max}
                    onInput={(e) => setMax(e.currentTarget.value)}
                  />
                  <span class="field-hint">0 stops them starting agents. Empty leaves their plan’s caps.</span>
                </label>
                <label class="field">
                  <span class="field-label">Most starts an hour</span>
                  <input
                    class="input input-sm"
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    placeholder="No limit"
                    value={hourly}
                    onInput={(e) => setHourly(e.currentTarget.value)}
                  />
                  <span class="field-hint">On their own routines and on lent ones. You can only lower their caps.</span>
                </label>
              </div>
              {problem && (
                <p class="field-error" role="alert">
                  {problem}
                </p>
              )}
            </>
          )}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy || !changed} aria-busy={busy}>
              Save limits
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
