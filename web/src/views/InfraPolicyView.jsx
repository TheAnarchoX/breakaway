import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, CircleX, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { hashFor, policyFor, repoName, repoScope, repos, toast } from '../lib/store.js';
import { KIND_LABEL } from './InfrastructureView.jsx';

/**
 * The Policy view (WEB-123, docs/specs/WEB-123-policy-manager.md), at #/infrastructure/policy?of=<repository>: the rules a
 * repository's plans are checked against, in words, per environment and with the level each comes from; the recent
 * plans and the rules that applied to them; and the policy as a change you approve. Editing never changes the rules
 * here: Propose the change opens the board's own pull request for `policy.json`, and Approve merges it. A change that
 * loosens the policy is marked and is never one press: Approve names what will no longer wait for you, and a second
 * press approves exactly that. Tightening is one press. A policy change applies nothing and approves no plan.
 */

const CHANGE_OPS = [
  ['create', 'Add'],
  ['update', 'Change'],
  ['delete', 'Delete'],
  ['scale', 'Scale'],
  ['restart', 'Restart'],
];
const ENV_KINDS = ['production', 'staging', 'short-lived'];
const LEVEL_WORDS = {
  board: 'Always',
  default: 'Default',
  repository: 'Repository',
  environment: 'This environment',
};
const STATE_WORDS = {
  open: 'Waiting for you',
  approved: 'Merging',
  merged: 'Merged',
  rejected: 'Rejected',
  closed: 'Closed',
  'taken over': 'Taken over',
};

/** "a, b" from a list, and a list from "a, b". */
const listText = (list) => (list ?? []).join(', ');
const textList = (text) =>
  String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
/** A number field's value: a number, or undefined when it's empty. */
const amount = (text) => (String(text).trim() === '' ? undefined : Number(text));

/** The policy as the board sends it to propose: what the file holds, without its version. */
function toSend(draft) {
  const environments = {};
  for (const [name, own] of Object.entries(draft.environments ?? {})) {
    const out = {};
    if (own.costLimit !== undefined) out.costLimit = own.costLimit;
    if (own.budget !== undefined) out.budget = own.budget;
    if (own.access && (own.access.kinds?.length || own.access.settings?.length)) out.access = own.access;
    if (own.allow) out.allow = own.allow;
    if (Object.keys(out).length) environments[name] = out;
  }
  return {
    costLimit: draft.costLimit,
    budget: draft.budget,
    ...(Object.keys(environments).length ? { environments } : {}),
    access: draft.access,
    allow: draft.allow,
  };
}

/** A clean copy of a rule for the form: only what it names. */
const ruleOf = (r) => ({
  name: r.name ?? '',
  ...(r.environments ? { environments: [...r.environments] } : {}),
  ...(r.environmentKinds ? { environmentKinds: [...r.environmentKinds] } : {}),
  ...(r.changes ? { changes: [...r.changes] } : {}),
  ...(r.kinds ? { kinds: [...r.kinds] } : {}),
  ...(r.maxChanges !== undefined ? { maxChanges: r.maxChanges } : {}),
});

/** Which repository the view is on: the link's, else the board's filter, else the default. */
function useRepo() {
  const named = policyFor.value;
  if (named) return named;
  const scope = repoScope.value;
  return scope ?? repos.value.default ?? null;
}

export function InfraPolicyView() {
  const repo = useRepo();
  const [state, setState] = useState(
    /** @type {{ data: any, error: string | null, loading: boolean }} */ ({
      data: null,
      error: null,
      loading: true,
    }),
  );
  const [editing, setEditing] = useState(false);
  const load = async () => {
    if (!repo) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api(`infra/policy/view?repo=${enc(repo)}`);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, loading: false }));
    }
  };
  useEffect(() => {
    setState({ data: null, error: null, loading: true });
    setEditing(false);
    load();
  }, [repo]);

  const back = (
    <a class="fr-back" href={hashFor({ view: 'infrastructure', environment: null, policy: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Infrastructure
    </a>
  );
  const { data } = state;
  return (
    <div class="infra-view pol-view">
      {back}
      <div class="conn-top">
        <div class="view-intro">
          <h1>Policy</h1>
          <p class="muted">
            {repo ? `${repoName(repo)}: ` : ''}what waits for you before the board applies a plan, and what passes
            without you. You change it as a pull request you approve; nothing applies on its own.
          </p>
        </div>
        <div class="conn-buttons">
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            onClick={load}
            disabled={state.loading}
            aria-busy={state.loading}
          >
            <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
            Reload
          </button>
          {data && !editing && !data.open && data.environments.length > 0 && (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => setEditing(true)}>
              Change the policy
            </button>
          )}
        </div>
      </div>
      {!repo && <p class="muted">Pick a repository from the switcher to see its policy.</p>}
      {state.error && (
        <p class="field-error" role="alert">
          Couldn’t load the policy. {state.error} Reload tries again.
        </p>
      )}
      {repo && !data && !state.error && (
        <p class="muted" aria-busy="true">
          Loading the policy…
        </p>
      )}
      {data && (
        <>
          <PolicySource data={data} />
          {data.open && <OpenChange change={data.open} onChanged={load} />}
          {editing && (
            <PolicyEditor
              data={data}
              onCancel={() => setEditing(false)}
              onProposed={() => {
                setEditing(false);
                load();
              }}
            />
          )}
          {data.environments.length ? (
            <section class="pol-section" aria-labelledby="pol-envs">
              <h2 id="pol-envs">By environment</h2>
              <ul class="pol-envs">
                {data.environments.map((env) => (
                  <EnvironmentRules key={env.id} env={env} repo={data.repo} />
                ))}
              </ul>
            </section>
          ) : (
            <p class="muted">
              {repoName(data.repo)} has no environment the board plans for yet. Add one on Infrastructure; its plans are
              checked against this policy.
            </p>
          )}
          <RecentPlans plans={data.plans} />
          <PastChanges changes={data.changes.filter((c) => c.n !== data.open?.n)} />
        </>
      )}
    </div>
  );
}

/** Where the policy comes from, in a sentence. */
function PolicySource({ data }) {
  const file = <code>{data.path}</code>;
  if (data.state === 'invalid')
    return (
      <p class="rs-state" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          {file} doesn’t check{data.error?.line ? ` on line ${data.error.line}` : ''}
          {data.error?.message ? `: ${data.error.message}` : ''}. Until it’s fixed, the default policy decides, and
          every plan waits for you. Changing the policy here writes a file that checks.
        </span>
      </p>
    );
  return (
    <p class="meta">
      {data.policy === 'repository' ? (
        <>The repository’s own policy, from {file} on its default branch.</>
      ) : (
        <>The default policy: the repository has no {file}, so every plan waits for you.</>
      )}{' '}
      Each environment can have its own rules over the repository’s.
    </p>
  );
}

/** One environment's rules in words, with the level each comes from, and its envelope, read only. */
function EnvironmentRules({ env, repo }) {
  return (
    <li class="pol-env">
      <div class="pol-env-head">
        <a href={hashFor({ view: 'infrastructure', environment: String(env.id), policy: null, task: null })}>
          {env.name}
        </a>
        <span class="infra-kind">{KIND_LABEL[env.kind] ?? env.kind}</span>
        {env.own && <span class="pill">Own rules</span>}
        {env.frozen && <span class="pill pill-warn">Frozen</span>}
      </div>
      <ul class="pol-rules">
        {env.rules.map((r) => (
          <li key={r.rule}>
            <span class="pol-level">{LEVEL_WORDS[r.level] ?? r.level}</span>
            <span>{r.words}</span>
          </li>
        ))}
      </ul>
      <p class="meta pol-envelope">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>
          {env.envelope ? (
            <>Envelope: {env.envelope.join(', ')}. Inside it, scaling and restarts don’t wait for you. </>
          ) : (
            <>No envelope: every scale and restart is a plan. </>
          )}
          <a href={hashFor({ view: 'repo-settings', settings: repo, task: null })}>Set in the repository’s settings</a>
        </span>
      </p>
    </li>
  );
}

const OUTCOME_WORDS = { allowed: 'Let through', 'needs-owner': 'Waited for you', refused: 'Refused' };

/** The recent plans, and the rules that applied to each. */
function RecentPlans({ plans }) {
  if (!plans.length) return null;
  return (
    <section class="pol-section" aria-labelledby="pol-plans">
      <h2 id="pol-plans">Recent plans</h2>
      <ul class="pol-plans">
        {plans.map((p) => (
          <li key={p.id}>
            <div class="pol-plan-head">
              <span class="gh-sha">{p.id}</span>
              <span>{p.environment ?? 'a removed environment'}</span>
              <span class={`pill ${p.outcome === 'refused' ? 'pill-danger' : ''}`}>
                {OUTCOME_WORDS[p.outcome] ?? 'Not checked'}
              </span>
              {p.from === 'default' && <span class="meta">by the default policy</span>}
            </div>
            {p.applied.length > 0 && (
              <ul class="rs-list small">
                {p.applied.map((a) => (
                  <li key={a.rule}>{a.reason}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The lines a change makes, each marked loosens or tightens. */
function ChangeLines({ lines }) {
  if (!lines.length) return <p class="meta">It changes how the file is written, not what waits for you.</p>;
  return (
    <ul class="pol-lines">
      {lines.map((l) => (
        <li key={l.line} class={`pol-line pol-${l.effect}`}>
          <span class={`pill ${l.effect === 'loosens' ? 'pill-warn' : ''}`}>
            {l.effect === 'loosens' ? 'Loosens' : 'Tightens'}
          </span>
          <span>{l.line}</span>
        </li>
      ))}
    </ul>
  );
}

/** The open policy change: its lines, Approve (twice when it loosens), and Reject. */
function OpenChange({ change, onChanged }) {
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [confirm, setConfirm] = useState(/** @type {string[] | null} */ (null));
  const [unlocks, setUnlocks] = useState(/** @type {any[]} */ ([]));
  const confirmRef = useRef(/** @type {HTMLFieldSetElement | null} */ (null));
  const loosens = change.lines.some((l) => l.effect === 'loosens');
  const number = change.pull?.number;

  const approve = async (lines = null) => {
    setBusy('approve');
    setError(null);
    try {
      await api(`infra/policy/changes/${enc(change.n)}/approve`, {
        method: 'POST',
        body: { sha: change.commit, ...(lines ? { loosens: lines } : {}) },
      });
      setConfirm(null);
      toast(`Approved: the board merged #${number}. Plans made from now on are checked against it.`, 'success');
      onChanged();
    } catch (err) {
      if (err.data?.confirm) {
        setConfirm(err.data.loosens);
        requestAnimationFrame(() => confirmRef.current?.focus());
      } else {
        setConfirm(null);
        setUnlocks(err.data?.unlocks ?? []);
        setError(err.message);
      }
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await api(`infra/policy/changes/${enc(change.n)}/reject`, { method: 'POST', body: {} });
      toast(`Rejected: the board closed #${number}. The policy stays as it was.`, 'success');
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="pol-change" aria-labelledby="pol-change-title">
      <div class="pol-change-head">
        <h2 id="pol-change-title">A policy change waits for you</h2>
        {loosens && <span class="pill pill-warn">Loosens your policy</span>}
      </div>
      <p class="meta">
        {number ? (
          <a href={change.pull.url} target="_blank" rel="noreferrer">
            #{number}
          </a>
        ) : (
          'Its pull request'
        )}{' '}
        changes <code>.github/breakaway-infra/policy.json</code>. Approving merges it; it applies nothing and approves
        no plan.
      </p>
      <ChangeLines lines={change.lines} />
      {confirm ? (
        <fieldset class="pol-confirm" ref={confirmRef} tabIndex={-1}>
          <legend>
            <strong>This loosens your policy.</strong> Once it merges, these will no longer wait for you:
          </legend>
          <ul class="rs-list">
            {confirm.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <div class="pol-actions">
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              onClick={() => setConfirm(null)}
              disabled={busy !== null}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => approve(confirm)}
              disabled={busy !== null}
              aria-busy={busy === 'approve'}
            >
              <Check size={16} aria-hidden="true" />
              Loosen it
            </button>
          </div>
        </fieldset>
      ) : (
        <div class="pol-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => approve()}
            disabled={busy !== null || !change.commit}
            aria-busy={busy === 'approve'}
          >
            <Check size={16} aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            onClick={reject}
            disabled={busy !== null}
            aria-busy={busy === 'reject'}
          >
            <CircleX size={16} aria-hidden="true" />
            Reject
          </button>
        </div>
      )}
      {error && (
        <div class="field-error" role="alert">
          <p>{error}</p>
          {unlocks.length > 0 && (
            <ul class="rs-list">
              {unlocks.map((u) => (
                <li key={u.id}>
                  <a
                    href={hashFor({
                      view: 'infrastructure',
                      environment: String(u.environmentId),
                      plan: u.id,
                      task: null,
                    })}
                  >
                    {u.id}
                  </a>{' '}
                  in {u.environment}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The policy changes before the open one. */
function PastChanges({ changes }) {
  if (!changes.length) return null;
  return (
    <section class="pol-section" aria-labelledby="pol-past">
      <h2 id="pol-past">Earlier changes</h2>
      <ul class="rs-list small">
        {changes.map((c) => (
          <li key={c.n}>
            {c.pull ? (
              <a href={c.pull.url} target="_blank" rel="noreferrer">
                #{c.pull.number}
              </a>
            ) : (
              `Change ${c.n}`
            )}{' '}
            · {STATE_WORDS[c.state] ?? c.state}
            {c.loosens.length ? ' · loosened it' : ''} · {new Date(c.updated).toLocaleDateString()}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The editor: the repository's rules, then any environment's own. Each edit asks the board what it loosens and
 * tightens; Propose the change opens the pull request.
 */
function PolicyEditor({ data, onCancel, onProposed }) {
  const [draft, setDraft] = useState(() => structuredClone(data.rules));
  const [level, setLevel] = useState('');
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const names = data.environments.map((e) => e.name);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const got = await api('infra/policy/changes', {
          method: 'POST',
          body: { repo: data.repo, policy: toSend(draft) },
        });
        setPreview(got);
        setError(null);
      } catch (err) {
        setPreview(null);
        setError(err.message);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [JSON.stringify(draft)]);

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('infra/policy/changes', {
        method: 'POST',
        body: { repo: data.repo, policy: toSend(draft), propose: true },
      });
      toast(`Proposed: the board opened #${res.change.pull?.number}. It waits for you here.`, 'success');
      onProposed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const own = level ? (draft.environments?.[level] ?? {}) : null;
  const setOwn = (patch) =>
    setDraft((d) => ({
      ...d,
      environments: { ...d.environments, [level]: { ...(d.environments?.[level] ?? {}), ...patch } },
    }));

  return (
    <section class="pol-editor" aria-labelledby="pol-editor-title">
      <h2 id="pol-editor-title">Change the policy</h2>
      <div class="field">
        <label for="pol-level">Rules for</label>
        <select id="pol-level" class="select" value={level} onChange={(e) => setLevel(e.currentTarget.value)}>
          <option value="">Every environment (the repository’s rules)</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n} only{draft.environments?.[n] ? ' (own rules)' : ''}
            </option>
          ))}
        </select>
        <span class="field-hint">
          An environment’s own limits replace the repository’s, its access names add to them, and its own allow rules,
          when it has them, replace the repository’s there.
        </span>
      </div>

      {level === '' ? (
        <>
          <div class="pol-grid">
            <NumberField
              id="pol-cost"
              label="Cost limit, a month"
              value={draft.costLimit}
              onChange={(v) => setDraft((d) => ({ ...d, costLimit: v ?? 0 }))}
              hint="A plan that adds more than this waits for you."
            />
            <NumberField
              id="pol-budget"
              label="Budget, a month"
              value={draft.budget}
              onChange={(v) => setDraft((d) => ({ ...d, budget: v ?? 0 }))}
              hint="A plan that takes an environment past this waits for you."
            />
          </div>
          <AccessFields access={draft.access} onChange={(access) => setDraft((d) => ({ ...d, access }))} id="pol" />
          <RulesFields
            rules={draft.allow}
            names={names}
            onChange={(allow) => setDraft((d) => ({ ...d, allow }))}
            scoped={false}
          />
        </>
      ) : (
        <>
          <div class="pol-grid">
            <NumberField
              id="pol-own-cost"
              label="Own cost limit, a month"
              value={own.costLimit}
              onChange={(v) => setOwn({ costLimit: v })}
              hint={`Empty uses the repository’s, ${draft.costLimit}.`}
            />
            <NumberField
              id="pol-own-budget"
              label="Own budget, a month"
              value={own.budget}
              onChange={(v) => setOwn({ budget: v })}
              hint={`Empty uses the repository’s, ${draft.budget}.`}
            />
          </div>
          <AccessFields
            access={own.access ?? { kinds: [], settings: [] }}
            onChange={(access) => setOwn({ access })}
            id="pol-own"
          />
          <label class="pol-check">
            <input
              type="checkbox"
              checked={Boolean(own.allow)}
              onChange={(e) =>
                setOwn({
                  allow: e.currentTarget.checked
                    ? (draft.allow ?? []).map(ruleOf).map(({ environments, environmentKinds, ...r }) => r)
                    : undefined,
                })
              }
            />{' '}
            {level} has its own allow rules, in place of the repository’s
          </label>
          {own.allow && <RulesFields rules={own.allow} names={[]} onChange={(allow) => setOwn({ allow })} scoped />}
        </>
      )}

      <div class="pol-preview" aria-live="polite">
        <h3>What it changes</h3>
        {preview ? (
          <>
            {preview.loosens.length > 0 && (
              <p class="pol-mark">
                <span class="pill pill-warn">Loosens your policy</span> Approving it takes a second press that names
                what will no longer wait for you.
              </p>
            )}
            <ChangeLines lines={preview.lines} />
            {preview.unlocks?.length > 0 && (
              <p class="meta">
                {preview.unlocks.map((u) => `${u.id} in ${u.environment}`).join(', ')}{' '}
                {preview.unlocks.length === 1 ? 'waits' : 'wait'} for you and would pass under it: answer{' '}
                {preview.unlocks.length === 1 ? 'it' : 'them'} first, and the change can be approved after.
              </p>
            )}
          </>
        ) : (
          !error && <p class="meta">Checking…</p>
        )}
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div class="pol-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={onCancel} disabled={busy}>
          Discard
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={propose}
          disabled={busy || !preview || Boolean(error)}
          aria-busy={busy}
        >
          Propose the change
        </button>
      </div>
    </section>
  );
}

function NumberField({ id, label, value, onChange, hint }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        id={id}
        class="input"
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={value ?? ''}
        onInput={(e) => onChange(amount(e.currentTarget.value))}
        aria-describedby={`${id}-hint`}
      />
      <span class="field-hint" id={`${id}-hint`}>
        {hint}
      </span>
    </div>
  );
}

function AccessFields({ access, onChange, id }) {
  return (
    <div class="pol-grid">
      <div class="field">
        <label for={`${id}-kinds`}>Access kinds</label>
        <input
          id={`${id}-kinds`}
          class="input"
          value={listText(access?.kinds)}
          onChange={(e) => onChange({ ...access, kinds: textList(e.currentTarget.value) })}
          aria-describedby={`${id}-kinds-hint`}
        />
        <span class="field-hint" id={`${id}-kinds-hint`}>
          Resource kinds whose every change waits for you, like route. Commas between them.
        </span>
      </div>
      <div class="field">
        <label for={`${id}-settings`}>Access settings</label>
        <input
          id={`${id}-settings`}
          class="input"
          value={listText(access?.settings)}
          onChange={(e) => onChange({ ...access, settings: textList(e.currentTarget.value) })}
          aria-describedby={`${id}-settings-hint`}
        />
        <span class="field-hint" id={`${id}-settings-hint`}>
          Settings that decide who can reach something, like public.
        </span>
      </div>
    </div>
  );
}

/** The allow rules: what passes without you, once nothing else caught the plan. */
function RulesFields({ rules, names, onChange, scoped }) {
  const set = (i, patch) =>
    onChange(
      rules.map((r, j) =>
        j === i ? Object.fromEntries(Object.entries({ ...r, ...patch }).filter(([, v]) => v !== undefined)) : r,
      ),
    );
  const toggle = (list, value, on) => {
    const next = new Set(list ?? []);
    if (on) next.add(value);
    else next.delete(value);
    return next.size ? [...next] : undefined;
  };
  return (
    <fieldset class="field pol-rules-edit">
      <legend class="field-label">Let through without you</legend>
      <p class="field-hint">
        {rules.length
          ? 'A plan passes without you when one rule covers every change in it, and nothing above caught it.'
          : 'No rules: every plan waits for you.'}
      </p>
      {rules.map((r, i) => (
        <div class="pol-rule" key={i}>
          <div class="pol-grid">
            <div class="field">
              <label for={`pol-rule-${scoped}-${i}`}>Name</label>
              <input
                id={`pol-rule-${scoped}-${i}`}
                class="input"
                value={r.name}
                onInput={(e) => set(i, { name: e.currentTarget.value })}
              />
            </div>
            <div class="field">
              <label for={`pol-rule-max-${scoped}-${i}`}>Most changes in a plan</label>
              <input
                id={`pol-rule-max-${scoped}-${i}`}
                class="input"
                type="number"
                min="1"
                max="1000"
                value={r.maxChanges ?? ''}
                onInput={(e) => set(i, { maxChanges: amount(e.currentTarget.value) })}
              />
            </div>
          </div>
          <fieldset class="pol-checks">
            <legend class="field-hint">Only these changes (none ticked: any)</legend>
            {CHANGE_OPS.map(([op, label]) => (
              <label class="pol-check" key={op}>
                <input
                  type="checkbox"
                  checked={(r.changes ?? []).includes(op)}
                  onChange={(e) => set(i, { changes: toggle(r.changes, op, e.currentTarget.checked) })}
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
          <div class="field">
            <label for={`pol-rule-kinds-${scoped}-${i}`}>Only these resource kinds</label>
            <input
              id={`pol-rule-kinds-${scoped}-${i}`}
              class="input"
              value={listText(r.kinds)}
              onChange={(e) => {
                const kinds = textList(e.currentTarget.value);
                set(i, { kinds: kinds.length ? kinds : undefined });
              }}
              placeholder="Any kind"
            />
          </div>
          {!scoped && (
            <>
              <fieldset class="pol-checks">
                <legend class="field-hint">Only in these environments (none ticked: every one)</legend>
                {names.map((n) => (
                  <label class="pol-check" key={n}>
                    <input
                      type="checkbox"
                      checked={(r.environments ?? []).includes(n)}
                      onChange={(e) => set(i, { environments: toggle(r.environments, n, e.currentTarget.checked) })}
                    />{' '}
                    {n}
                  </label>
                ))}
              </fieldset>
              <fieldset class="pol-checks">
                <legend class="field-hint">Only in these kinds of environment (none ticked: every kind)</legend>
                {ENV_KINDS.map((k) => (
                  <label class="pol-check" key={k}>
                    <input
                      type="checkbox"
                      checked={(r.environmentKinds ?? []).includes(k)}
                      onChange={(e) =>
                        set(i, { environmentKinds: toggle(r.environmentKinds, k, e.currentTarget.checked) })
                      }
                    />{' '}
                    {KIND_LABEL[k] ?? k}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            <Trash2 size={16} aria-hidden="true" />
            Remove the rule
          </button>
        </div>
      ))}
      <button
        type="button"
        class="btn btn-outline btn-sm pol-add"
        onClick={() => onChange([...rules, { name: `rule ${rules.length + 1}`, maxChanges: 3 }])}
      >
        <Plus size={16} aria-hidden="true" />
        Add a rule
      </button>
    </fieldset>
  );
}
