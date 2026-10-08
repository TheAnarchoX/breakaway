import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowLeft,
  Check,
  CircleX,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-preact';
import { accessFor, allowFor, limitsFor, money } from '../../../src/infra-policy.js';
import { policyEdit } from '../../../src/infra-policy-changes.js';
import { api, enc } from '../lib/api.js';
import { hashFor, policyFor, repoName, repoScope, repos, toast } from '../lib/store.js';
import { KIND_LABEL } from './InfrastructureView.jsx';

/**
 * The Policy view (WEB-123, docs/specs/WEB-123-policy-manager.md), at #/infrastructure/policy?of=<repository>: the rules a
 * repository's plans are checked against, the default first and then each environment's, with what an environment
 * takes from the default and what it sets itself; the recent plans and the rules that applied to them; and the policy
 * as a change you approve. Change on a section, or on one rule, edits it in place (WEB-128); Add to the change keeps it
 * in one change, and Propose the change opens the board's own pull request for `policy.json`, which Approve merges.
 * Editing never changes the rules here. A change that loosens the policy is marked and is never one press: Approve
 * names what will no longer wait for you, and a second press approves exactly that. Tightening is one press. A policy
 * change applies nothing and approves no plan.
 */

const CHANGE_OPS = [
  ['create', 'Add'],
  ['update', 'Change'],
  ['delete', 'Delete'],
  ['scale', 'Scale'],
  ['restart', 'Restart'],
];
const OP_LABEL = Object.fromEntries(CHANGE_OPS);
const ENV_KINDS = ['production', 'staging', 'short-lived'];
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

/** A clean copy of a rule for the form: only what it names. */
const ruleOf = (r) => ({
  name: r.name ?? '',
  ...(r.environments ? { environments: [...r.environments] } : {}),
  ...(r.environmentKinds ? { environmentKinds: [...r.environmentKinds] } : {}),
  ...(r.changes ? { changes: [...r.changes] } : {}),
  ...(r.kinds ? { kinds: [...r.kinds] } : {}),
  ...(r.maxChanges !== undefined ? { maxChanges: r.maxChanges } : {}),
});

/**
 * A scope is where rules are set: '' for the default (the repository's rules, what every environment starts from), or
 * an environment's name for its own.
 */
const ownOf = (rules, scope) => rules.environments?.[scope] ?? {};
/** The rules with one environment's own replaced; an environment left with nothing of its own is dropped. */
function withOwn(rules, scope, own) {
  const out = {};
  if (own.costLimit !== undefined) out.costLimit = own.costLimit;
  if (own.budget !== undefined) out.budget = own.budget;
  if (own.access?.kinds?.length || own.access?.settings?.length)
    out.access = { kinds: own.access.kinds ?? [], settings: own.access.settings ?? [] };
  if (own.allow) out.allow = own.allow;
  const environments = { ...(rules.environments ?? {}) };
  if (Object.keys(out).length) environments[scope] = out;
  else delete environments[scope];
  return { ...rules, environments };
}
/** The allow rules set at a scope, and the rules with them replaced. */
const rulesAt = (rules, scope) => (scope === '' ? (rules.allow ?? []) : (ownOf(rules, scope).allow ?? []));
const withRules = (rules, scope, allow) =>
  scope === '' ? { ...rules, allow } : withOwn(rules, scope, { ...ownOf(rules, scope), allow });
/** What a scope sets, as the file would hold it: to tell whether the change edits it. */
function scopeText(rules, scope) {
  const sent = policyEdit(rules);
  if (scope !== '') return JSON.stringify(sent.environments?.[scope] ?? null);
  const { environments: _environments, ...rest } = sent;
  return JSON.stringify(rest);
}

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
  // The rules with what you added to the change; null until the policy loads.
  const [draft, setDraft] = useState(/** @type {any} */ (null));
  // What's open for editing: a scope's section ({ scope, rule: null }) or one rule in it ({ scope, rule: index }).
  const [editing, setEditing] = useState(/** @type {{ scope: string, rule: number | null } | null} */ (null));
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
    load();
  }, [repo]);
  const { data } = state;
  useEffect(() => {
    setDraft(data ? structuredClone(data.rules) : null);
    setEditing(null);
  }, [data]);

  const back = (
    <a class="fr-back" href={hashFor({ view: 'infrastructure', environment: null, policy: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Infrastructure
    </a>
  );
  const editable = Boolean(data && draft && !data.open && data.environments.length > 0);
  const changed = Boolean(
    data && draft && JSON.stringify(policyEdit(draft)) !== JSON.stringify(policyEdit(data.rules)),
  );
  const scope = {
    data,
    draft,
    editing,
    editable,
    onEdit: setEditing,
    onDraft: (/** @type {(rules: any) => any} */ next) => {
      setDraft((d) => next(d));
      setEditing(null);
    },
  };
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
      {data && draft && (
        <>
          <PolicySource data={data} />
          {data.open && <OpenChange change={data.open} onChanged={load} />}
          <section class="pol-section" aria-labelledby="pol-scopes">
            <h2 id="pol-scopes">Rules</h2>
            {data.open && (
              <p class="meta">Approve or reject the change that waits for you before you change the policy again.</p>
            )}
            <ol class="pol-scopes">
              <ScopeRules {...scope} scope="" env={null} />
              {data.environments.map((env) => (
                <ScopeRules key={env.id} {...scope} scope={env.name} env={env} />
              ))}
            </ol>
            {!data.environments.length && (
              <p class="muted">
                {repoName(data.repo)} has no environment the board plans for yet. Add one on Infrastructure; its plans
                are checked against this policy, and you can change it here.
              </p>
            )}
          </section>
          {editable && changed && (
            <ProposeChange
              data={data}
              draft={draft}
              editing={editing !== null}
              onDiscard={() => {
                setDraft(structuredClone(data.rules));
                setEditing(null);
              }}
              onProposed={load}
            />
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
      Each environment starts from the default and can set its own rules over it.
    </p>
  );
}

/** Where a value comes from, as a small tag: the board's, the default's, or the environment's own. */
function From({ level }) {
  const words = { board: 'Always', default: 'From default', own: 'Own' };
  return <span class={`pol-from pol-from-${level}`}>{words[level]}</span>;
}

/**
 * One scope's rules, grouped: what always waits, the limits, what counts as access, and what passes without you. Change
 * turns the section into its form, right here; Change on a rule card edits that rule.
 */
function ScopeRules({ data, draft, editing, editable, onEdit, onDraft, scope, env }) {
  const isDefault = scope === '';
  const label = isDefault ? 'the default' : scope;
  const currency = data.currency?.currency ?? null;
  const own = ownOf(draft, scope);
  const inChange = scopeText(draft, scope) !== scopeText(data.rules, scope);
  const open = editing?.scope === scope;
  const headId = isDefault ? 'pol-scope-default' : `pol-scope-${scope}`;
  const head = (
    <div class="pol-scope-head">
      <h3 id={headId}>
        {isDefault ? (
          'Default'
        ) : (
          <a href={hashFor({ view: 'infrastructure', environment: String(env.id), policy: null, task: null })}>
            {scope}
          </a>
        )}
      </h3>
      {env && <span class="infra-kind">{KIND_LABEL[env.kind] ?? env.kind}</span>}
      {env && draft.environments?.[scope] && <span class="pill">Own rules</span>}
      {env?.frozen && <span class="pill pill-warn">Frozen</span>}
      {inChange && <span class="pill pol-pill-change">In your change</span>}
      {editable && !open && (
        <button
          type="button"
          class="btn btn-quiet btn-sm pol-scope-edit"
          onClick={() => onEdit({ scope, rule: null })}
          disabled={editing !== null}
          aria-label={`Change ${label}’s rules`}
        >
          <Pencil size={16} aria-hidden="true" />
          Change
        </button>
      )}
    </div>
  );
  if (open && editing.rule === null)
    return (
      <li class="pol-scope pol-scope-editing" aria-labelledby={headId}>
        {head}
        <ScopeForm
          draft={draft}
          scope={scope}
          names={data.environments.map((e) => e.name)}
          onSave={(rules) => onDraft(() => rules)}
          onCancel={() => onEdit(null)}
        />
      </li>
    );

  const { costLimit, budget } = limitsFor(draft, isDefault ? '' : scope);
  const limitFrom = (key) => (isDefault ? null : own[key] !== undefined ? 'own' : 'default');
  const { allow, level } = isDefault ? { allow: draft.allow ?? [], level: 'repository' } : allowFor(draft, scope);
  const ownRules = isDefault || level === 'environment';
  const rules = ownRules
    ? allow
    : allow.filter(
        (r) =>
          (!r.environments || r.environments.includes(scope)) &&
          (!r.environmentKinds || !env.kind || r.environmentKinds.includes(env.kind)),
      );
  const access = isDefault ? (draft.access ?? { kinds: [], settings: [] }) : accessFor(draft, scope);
  const inherited = new Set([...(draft.access?.kinds ?? []), ...(draft.access?.settings ?? [])]);
  const editingRule = open && editing.rule !== null ? editing.rule : null;

  return (
    <li class="pol-scope" aria-labelledby={headId}>
      {head}
      <p class="meta pol-scope-intro">
        {isDefault
          ? 'What every environment starts from. An environment’s own limits replace these, its access names add to them, and its own allow rules, when it has them, replace these there.'
          : 'The rules that decide for this environment: what it takes from the default, and what it sets itself.'}
      </p>

      <div class="pol-group">
        <h4 class="pol-group-title">
          Always waits for you <From level="board" />
        </h4>
        <ul class="pol-always">
          {isDefault ? (
            <li>
              <Lock size={14} aria-hidden="true" /> In production, every plan.
            </li>
          ) : (
            <li class={env.gates ? '' : 'muted'}>
              <Lock size={14} aria-hidden="true" />{' '}
              {env.gates ? 'Every plan here: production needs you.' : `${scope} has no production gates.`}
            </li>
          )}
          <li>
            <Lock size={14} aria-hidden="true" /> A plan that deletes something, or can’t be undone.
          </li>
          <li class={env?.frozen ? 'pol-always-warn' : ''}>
            <Lock size={14} aria-hidden="true" />{' '}
            {env?.frozen
              ? `${scope} is frozen: every plan is refused until you unfreeze it.`
              : 'A frozen environment refuses every plan, envelopes included, until you unfreeze it.'}
          </li>
        </ul>
      </div>

      <div class="pol-limits">
        <Limit
          label="Cost limit"
          value={money(costLimit, currency)}
          hint="A plan that adds more a month, or whose cost isn’t known, waits for you."
          from={limitFrom('costLimit')}
        />
        <Limit
          label="Budget"
          value={money(budget, currency)}
          hint={`A plan that takes ${isDefault ? 'an environment' : scope} past this a month waits for you.`}
          from={limitFrom('budget')}
        />
      </div>

      <div class="pol-group">
        <h4 class="pol-group-title">Counts as access {!isDefault && own.access && <From level="own" />}</h4>
        <p class="meta">
          A plan that changes who or what can reach something waits for you: what the provider marks as access
          {access.kinds.length || access.settings.length ? ', and these' : ''}.
        </p>
        {(access.kinds.length > 0 || access.settings.length > 0) && (
          <div class="pol-chips">
            {access.kinds.map((k) => (
              <Chip key={`k-${k}`} text={k} what="Resource kind" own={!isDefault && !inherited.has(k)} />
            ))}
            {access.settings.map((s) => (
              <Chip key={`s-${s}`} text={s} what="Setting" own={!isDefault && !inherited.has(s)} />
            ))}
          </div>
        )}
      </div>

      <div class="pol-group">
        <h4 class="pol-group-title">
          Let through without you {!isDefault && <From level={ownRules ? 'own' : 'default'} />}
        </h4>
        {rules.length === 0 && editingRule === null && (
          <p class="meta">
            {ownRules && !isDefault
              ? `${scope}’s own rules let nothing through: every plan here waits for you.`
              : 'No rule lets a plan through: every plan waits for you.'}
          </p>
        )}
        {(rules.length > 0 || editingRule !== null) && (
          <ul class="pol-cards">
            {rules.map((r, i) =>
              ownRules && editingRule === i ? (
                <li key={i} class="pol-card pol-card-editing">
                  <RuleForm
                    rule={r}
                    id={`pol-${isDefault ? 'd' : `e-${scope}`}-${i}`}
                    names={isDefault ? data.environments.map((e) => e.name) : []}
                    scoped={!isDefault}
                    onSave={(rule) =>
                      onDraft((d) =>
                        withRules(
                          d,
                          scope,
                          rulesAt(d, scope).map((x, j) => (j === i ? rule : x)),
                        ),
                      )
                    }
                    onRemove={() =>
                      onDraft((d) =>
                        withRules(
                          d,
                          scope,
                          rulesAt(d, scope).filter((_, j) => j !== i),
                        ),
                      )
                    }
                    onCancel={() => onEdit(null)}
                  />
                </li>
              ) : (
                <RuleCard
                  key={i}
                  rule={r}
                  showWhere={isDefault}
                  from={isDefault ? null : ownRules ? 'own' : 'default'}
                  onEdit={editable && ownRules && editing === null ? () => onEdit({ scope, rule: i }) : null}
                />
              ),
            )}
            {ownRules && editingRule === rules.length && (
              <li class="pol-card pol-card-editing">
                <RuleForm
                  rule={{ name: `rule ${rules.length + 1}`, maxChanges: 3 }}
                  id={`pol-${isDefault ? 'd' : `e-${scope}`}-new`}
                  names={isDefault ? data.environments.map((e) => e.name) : []}
                  scoped={!isDefault}
                  onSave={(rule) => onDraft((d) => withRules(d, scope, [...rulesAt(d, scope), rule]))}
                  onCancel={() => onEdit(null)}
                />
              </li>
            )}
          </ul>
        )}
        {rules.length > 0 && <p class="meta">Any other plan waits for you.</p>}
        {editable && ownRules && editing === null && (
          <button
            type="button"
            class="btn btn-outline btn-sm pol-add"
            onClick={() => onEdit({ scope, rule: rules.length })}
          >
            <Plus size={16} aria-hidden="true" />
            Add a rule
          </button>
        )}
      </div>

      {env && (
        <p class="meta pol-envelope">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            {env.envelope ? (
              <>Envelope: {env.envelope.join(', ')}. Inside it, scaling and restarts don’t wait for you. </>
            ) : (
              <>No envelope: every scale and restart is a plan. </>
            )}
            <a href={hashFor({ view: 'repo-settings', settings: data.repo, task: null })}>
              Set in the repository’s settings
            </a>
          </span>
        </p>
      )}
    </li>
  );
}

/** A limit as a big value, with what it does and where it comes from. */
function Limit({ label, value, hint, from }) {
  return (
    <div class="pol-limit">
      <span class="pol-limit-label">
        {label} {from && <From level={from} />}
      </span>
      <span class="pol-limit-value">
        {value} <span class="pol-limit-unit">a month</span>
      </span>
      <span class="meta">{hint}</span>
    </div>
  );
}

/** One access name, marked when the environment adds it to the default's. */
function Chip({ text, what, own }) {
  return (
    <span class={`pol-chip${own ? ' pol-chip-own' : ''}`} title={`${what}${own ? ', this environment’s own' : ''}`}>
      <span class="visually-hidden">{what}: </span>
      {text}
      {own && <span class="visually-hidden"> (own)</span>}
    </span>
  );
}

/** One allow rule as a card: its name, which changes, which kinds, how many, and where. */
function RuleCard({ rule, showWhere, from, onEdit }) {
  return (
    <li class="pol-card">
      <div class="pol-card-head">
        <strong class="pol-card-name">{rule.name}</strong>
        {from && <From level={from} />}
        {onEdit && (
          <button
            type="button"
            class="btn btn-quiet btn-sm pol-card-edit"
            onClick={onEdit}
            aria-label={`Change the rule ${rule.name}`}
          >
            <Pencil size={16} aria-hidden="true" />
            Change
          </button>
        )}
      </div>
      <dl class="pol-card-facts">
        <div>
          <dt>Changes</dt>
          <dd>{rule.changes ? rule.changes.map((c) => OP_LABEL[c] ?? c).join(', ') : 'Any'}</dd>
        </div>
        <div>
          <dt>Kinds</dt>
          <dd>{rule.kinds ? rule.kinds.join(', ') : 'Any'}</dd>
        </div>
        <div>
          <dt>Most changes</dt>
          <dd>{rule.maxChanges ?? 'Any number'}</dd>
        </div>
        {showWhere && (
          <div>
            <dt>Where</dt>
            <dd>
              {rule.environments || rule.environmentKinds
                ? [
                    ...(rule.environments ?? []),
                    ...(rule.environmentKinds ?? []).map((k) => `every ${k} environment`),
                  ].join(', ')
                : 'Every environment'}
            </dd>
          </div>
        )}
      </dl>
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
  const [passes, setPasses] = useState(/** @type {any[]} */ ([]));
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
        setPasses(err.data?.passes ?? []);
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
          {passes.length > 0 && (
            <ul class="rs-list">
              {passes.map((u) => (
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
 * One change for everything you edited: what it changes, asked of the board as you edit, and Propose the change, which
 * opens the pull request.
 */
function ProposeChange({ data, draft, editing, onDiscard, onProposed }) {
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const sent = JSON.stringify(policyEdit(draft));

  useEffect(() => {
    setPreview(null);
    const timer = setTimeout(async () => {
      try {
        const got = await api('infra/policy/changes', {
          method: 'POST',
          body: { repo: data.repo, policy: JSON.parse(sent) },
        });
        setPreview(got);
        setError(null);
      } catch (err) {
        setPreview(null);
        setError(err.message);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [sent]);

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('infra/policy/changes', {
        method: 'POST',
        body: { repo: data.repo, policy: JSON.parse(sent), propose: true },
      });
      toast(`Proposed: the board opened #${res.change.pull?.number}. It waits for you here.`, 'success');
      onProposed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="pol-propose" aria-labelledby="pol-propose-title">
      <div class="pol-change-head">
        <h2 id="pol-propose-title">Your change</h2>
        {preview?.loosens.length > 0 && <span class="pill pill-warn">Loosens your policy</span>}
      </div>
      <div class="pol-preview" aria-live="polite">
        <h3>What it changes</h3>
        {preview ? (
          <>
            {preview.loosens.length > 0 && (
              <p class="pol-mark">Approving it takes a second press that names what will no longer wait for you.</p>
            )}
            <ChangeLines lines={preview.lines} />
            {preview.passes?.length > 0 && (
              <p class="meta">
                {preview.passes.map((u) => `${u.id} in ${u.environment}`).join(', ')}{' '}
                {preview.passes.length === 1 ? 'waits' : 'wait'} for you and would pass under it: answer{' '}
                {preview.passes.length === 1 ? 'it' : 'them'} first, and the change can be approved after.
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
      {editing && <p class="meta">Add what you’re editing to the change, or discard it, before you propose.</p>}
      <div class="pol-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={propose}
          disabled={busy || editing || !preview || Boolean(error)}
          aria-busy={busy}
        >
          Propose the change
        </button>
      </div>
    </section>
  );
}

/**
 * A scope's form, in place of its section: the default's limits, access, and allow rules, or an environment's own. Add
 * to the change keeps it in your change; Discard leaves the section as it was.
 */
function ScopeForm({ draft, scope, names, onSave, onCancel }) {
  const isDefault = scope === '';
  const id = isDefault ? 'pol-d' : `pol-e-${scope}`;
  const [form, setForm] = useState(() =>
    structuredClone(
      isDefault
        ? {
            costLimit: draft.costLimit,
            budget: draft.budget,
            access: draft.access ?? { kinds: [], settings: [] },
            allow: (draft.allow ?? []).map(ruleOf),
          }
        : ownOf(draft, scope),
    ),
  );
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const save = () => onSave(isDefault ? { ...draft, ...form } : withOwn(draft, scope, form));

  return (
    <div class="pol-form">
      {isDefault ? (
        <>
          <div class="pol-grid">
            <NumberField
              id={`${id}-cost`}
              label="Cost limit, a month"
              value={form.costLimit}
              onChange={(v) => set({ costLimit: v ?? 0 })}
              hint="A plan that adds more than this waits for you."
            />
            <NumberField
              id={`${id}-budget`}
              label="Budget, a month"
              value={form.budget}
              onChange={(v) => set({ budget: v ?? 0 })}
              hint="A plan that takes an environment past this waits for you."
            />
          </div>
          <AccessFields access={form.access} onChange={(access) => set({ access })} id={id} />
          <RulesFields rules={form.allow} names={names} onChange={(allow) => set({ allow })} scoped={false} id={id} />
        </>
      ) : (
        <>
          <div class="pol-grid">
            <NumberField
              id={`${id}-cost`}
              label="Own cost limit, a month"
              value={form.costLimit}
              onChange={(v) => set({ costLimit: v })}
              hint={`Empty uses the default’s, ${draft.costLimit}.`}
            />
            <NumberField
              id={`${id}-budget`}
              label="Own budget, a month"
              value={form.budget}
              onChange={(v) => set({ budget: v })}
              hint={`Empty uses the default’s, ${draft.budget}.`}
            />
          </div>
          <AccessFields
            access={form.access ?? { kinds: [], settings: [] }}
            onChange={(access) => set({ access })}
            id={id}
            hint="Added to the default’s."
          />
          <label class="pol-check">
            <input
              type="checkbox"
              checked={Boolean(form.allow)}
              onChange={(e) =>
                set({
                  allow: e.currentTarget.checked
                    ? (draft.allow ?? []).map(ruleOf).map(({ environments, environmentKinds, ...r }) => r)
                    : undefined,
                })
              }
            />{' '}
            {scope} has its own allow rules, in place of the default’s
          </label>
          {form.allow && (
            <RulesFields rules={form.allow} names={[]} onChange={(allow) => set({ allow })} scoped id={id} />
          )}
        </>
      )}
      <div class="pol-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={onCancel}>
          Discard
        </button>
        <button type="button" class="btn btn-primary btn-sm" onClick={save}>
          <Check size={16} aria-hidden="true" />
          Add to the change
        </button>
      </div>
    </div>
  );
}

/** One rule's form, in place of its card. */
function RuleForm({ rule, id, names, scoped, onSave, onRemove = null, onCancel }) {
  const [form, setForm] = useState(() => ruleOf(rule));
  return (
    <div class="pol-form">
      <RuleFields
        rule={form}
        id={id}
        names={names}
        scoped={scoped}
        onChange={(patch) => setForm((f) => patchRule(f, patch))}
      />
      <div class="pol-actions">
        {onRemove && (
          <button type="button" class="btn btn-quiet btn-sm pol-remove" onClick={onRemove}>
            <Trash2 size={16} aria-hidden="true" />
            Remove the rule
          </button>
        )}
        <button type="button" class="btn btn-quiet btn-sm" onClick={onCancel}>
          Discard
        </button>
        <button type="button" class="btn btn-primary btn-sm" onClick={() => onSave(form)}>
          <Check size={16} aria-hidden="true" />
          Add to the change
        </button>
      </div>
    </div>
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

function AccessFields({ access, onChange, id, hint = '' }) {
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
          Resource kinds whose every change waits for you, like route. Commas between them. {hint}
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
          Settings that decide who can reach something, like public. {hint}
        </span>
      </div>
    </div>
  );
}

/** A rule with a patch, leaving out what the patch empties. */
const patchRule = (rule, patch) =>
  Object.fromEntries(Object.entries({ ...rule, ...patch }).filter(([, v]) => v !== undefined));

/** A ticked set as a list, or undefined when nothing is ticked. */
function toggle(list, value, on) {
  const next = new Set(list ?? []);
  if (on) next.add(value);
  else next.delete(value);
  return next.size ? [...next] : undefined;
}

/** The allow rules in a section's form: what passes without you, once nothing else caught the plan. */
function RulesFields({ rules, names, onChange, scoped, id }) {
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
          <RuleFields
            rule={r}
            id={`${id}-${i}`}
            names={names}
            scoped={scoped}
            onChange={(patch) => onChange(rules.map((x, j) => (j === i ? patchRule(x, patch) : x)))}
          />
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

/** One rule's fields: its name, how many changes, which changes and kinds, and, outside an environment, where. */
function RuleFields({ rule: r, id, names, scoped, onChange }) {
  return (
    <>
      <div class="pol-grid">
        <div class="field">
          <label for={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            class="input"
            value={r.name}
            onInput={(e) => onChange({ name: e.currentTarget.value })}
          />
        </div>
        <div class="field">
          <label for={`${id}-max`}>Most changes in a plan</label>
          <input
            id={`${id}-max`}
            class="input"
            type="number"
            min="1"
            max="1000"
            value={r.maxChanges ?? ''}
            onInput={(e) => onChange({ maxChanges: amount(e.currentTarget.value) })}
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
              onChange={(e) => onChange({ changes: toggle(r.changes, op, e.currentTarget.checked) })}
            />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for={`${id}-kinds`}>Only these resource kinds</label>
        <input
          id={`${id}-kinds`}
          class="input"
          value={listText(r.kinds)}
          onChange={(e) => {
            const kinds = textList(e.currentTarget.value);
            onChange({ kinds: kinds.length ? kinds : undefined });
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
                  onChange={(e) => onChange({ environments: toggle(r.environments, n, e.currentTarget.checked) })}
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
                    onChange({ environmentKinds: toggle(r.environmentKinds, k, e.currentTarget.checked) })
                  }
                />{' '}
                {KIND_LABEL[k] ?? k}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </>
  );
}
