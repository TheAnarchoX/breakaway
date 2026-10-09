import { useEffect, useState } from 'preact/hooks';
import { Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { confirmDialog, hashFor, toast } from '../lib/store.js';
import { plural } from '../lib/model.js';
import { EnvironmentFlags, FreezeButton, KIND_LABEL } from '../views/InfrastructureView.jsx';
import { limitsFor, money } from '../../../src/infra-policy.js';
import {
  CAP_MAX,
  DEFAULT_RESTARTS,
  HOURS_MAX,
  SCALE_MAX,
  envelopeWords,
  windowWords,
} from '../../../src/infra-envelopes.js';

/**
 * Infrastructure in a repository's settings (WEB-64; docs/specs/IDEA-19-architect.md, "Views", "Policy",
 * "Envelopes"): the policy in force, in words, guards first, with its cost limit and budgets; and each environment's
 * freeze and envelope. The policy is read from the repository (GET /api/infra/policy) and changed on the Policy view (WEB-123). An
 * envelope is the owner's to add, change, and revoke (PUT and DELETE /api/infra/envelopes/<environment>, which the
 * Worker takes from the signed-in browser only, so an agent's token can read it and nothing else). Freeze is WEB-60's.
 */

/** Restart windows to choose from, in hours. */
const WINDOWS = [1, 6, 12, 24, 72, 168, 720];

/** The window choices, with a saved one that isn't in the list kept choosable. */
const windowOptions = (saved) => [...new Set([...WINDOWS, saved])].filter((h) => h <= HOURS_MAX).sort((a, b) => a - b);

const upper = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "a, b, and c". */
const listWords = (list) =>
  list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;

/**
 * The policy in force as lines of words: which policy decides, then each guard in the order the board checks them,
 * then what's let through.
 * @param {any} out one repository's policy from GET /api/infra/policy
 * @param {string[]} names the repository's environments, for their own limits
 */
export function policyLines(out, names) {
  const p = out.rules;
  const cur = out.currency?.currency ?? null;
  const m = (n) => money(n, cur);
  const guards = [
    { rule: 'Frozen', text: 'A frozen environment refuses every plan until you unfreeze it.' },
    { rule: 'Production', text: 'A plan in production waits for you.' },
    { rule: 'Can’t be undone', text: 'A plan that deletes something, or can’t be undone, waits for you.' },
    {
      rule: 'Access',
      text: `A plan that changes who or what can reach something waits for you${
        p.access?.kinds?.length || p.access?.settings?.length
          ? `, including ${listWords([
              ...(p.access.kinds ?? []).map((k) => `any ${k}`),
              ...(p.access.settings ?? []).map((s) => `the ${s} setting`),
            ])}`
          : ''
      }.`,
    },
    {
      rule: 'Cost limit',
      text: `A plan that adds more than ${m(p.costLimit)} a month to an environment, or whose cost isn’t known, waits for you.`,
    },
    {
      rule: 'Budget',
      text: `A plan that would take an environment over its budget of ${m(p.budget)} a month waits for you.`,
    },
  ];
  const own = [...new Set([...names, ...Object.keys(p.environments ?? {})])]
    .filter((name) => p.environments?.[name])
    .map((name) => {
      const l = limitsFor(p, name);
      return `${name}: cost limit ${m(l.costLimit)}, budget ${m(l.budget)} a month.`;
    });
  const allow = (p.allow ?? []).map((a) => {
    const parts = [
      a.changes?.length ? listWords(a.changes) : 'any change',
      a.kinds?.length ? `to ${listWords(a.kinds)}` : null,
      a.environments?.length ? `in ${listWords(a.environments)}` : 'in any environment',
    ].filter(Boolean);
    const most = a.maxChanges ? `, up to ${plural(a.maxChanges, 'change')} a plan` : '';
    return { name: a.name, text: `${upper(parts.join(' '))}${most}.` };
  });
  return { guards, own, allow };
}

/** Where the policy comes from, in a sentence. */
function PolicySource({ out }) {
  const file = <code>{out.path}</code>;
  if (out.state === 'invalid') {
    const e = out.error ?? {};
    return (
      <p class="rs-state" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          {file} doesn’t check{e.line ? ` on line ${e.line}` : ''}
          {e.field ? (
            <>
              {' '}
              (<code>{e.field}</code>)
            </>
          ) : null}
          {e.message ? `: ${e.message}` : ''}. Until it’s fixed on the default branch, the default policy decides, and
          every plan waits for you.
        </span>
      </p>
    );
  }
  if (out.policy === 'repository')
    return (
      <p class="meta">
        The repository’s own policy, from {file} on its default branch
        {out.sha ? (
          <>
            {' at '}
            <span class="gh-sha">{out.sha.slice(0, 7)}</span>
          </>
        ) : null}
        .{' '}
        <a href={hashFor({ view: 'infrastructure', environment: null, policy: out.repo, task: null })}>
          Change it on the Policy view
        </a>
        , as a pull request you approve.
      </p>
    );
  return (
    <p class="meta">
      The default policy: the repository has no {file}, so every plan waits for you.{' '}
      <a href={hashFor({ view: 'infrastructure', environment: null, policy: out.repo, task: null })}>
        Change it on the Policy view
      </a>
      , as a pull request you approve.
    </p>
  );
}

/** @param {{ out: any, names: string[] }} props */
function Policy({ out, names }) {
  const { guards, own, allow } = policyLines(out, names);
  return (
    <div class="ifs-policy">
      <h3>Policy</h3>
      <PolicySource out={out} />
      <ul class="ifs-rules">
        {guards.map((g) => (
          <li key={g.rule}>
            <strong>{g.rule}.</strong> {g.text}
          </li>
        ))}
      </ul>
      {own.length > 0 && (
        <>
          <p class="meta">Some environments have their own limits:</p>
          <ul class="rs-list small">
            {own.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {allow.length ? (
        <>
          <p class="meta">Let through without asking you, once no guard caught it:</p>
          <ul class="ifs-rules">
            {allow.map((a) => (
              <li key={a.name}>
                <strong>“{a.name}”.</strong> {a.text}
              </li>
            ))}
          </ul>
          <p class="meta">Every other plan waits for you.</p>
        </>
      ) : (
        <p class="meta">Nothing else is let through: every other plan waits for you.</p>
      )}
      <p class="meta">
        Envelopes are the only standing exception: inside one, scaling and restarts happen without asking you.
      </p>
    </div>
  );
}

/** An envelope as the form holds it: strings while they're typed. */
const toDraft = (envelope) => ({
  scale: (envelope?.scale ?? []).map((b) => ({
    kind: b.kind,
    resource: b.resource ?? '',
    min: String(b.min),
    max: String(b.max),
  })),
  monthly: envelope?.monthly === null || envelope?.monthly === undefined ? '' : String(envelope.monthly),
  cap: String(envelope?.restarts.cap ?? DEFAULT_RESTARTS.cap),
  hours: envelope?.restarts.hours ?? DEFAULT_RESTARTS.hours,
});

/** A whole number from a field, or NaN. */
const whole = (s) => (/^\d+$/u.test(String(s).trim()) ? Number(String(s).trim()) : Number.NaN);

/**
 * The draft as the envelope to send, or the first thing wrong with it in words.
 * @returns {{ envelope: any } | { error: string }}
 */
function fromDraft(d) {
  const scale = [];
  for (const b of d.scale) {
    const min = whole(b.min);
    const max = whole(b.max);
    const what = b.resource.trim() || `every ${b.kind}`;
    if (Number.isNaN(min) || Number.isNaN(max) || max > SCALE_MAX)
      return { error: `Give ${what} a lowest and a highest, as whole numbers up to ${SCALE_MAX}.` };
    if (min > max) return { error: `${upper(what)}’s lowest (${min}) is more than its highest (${max}).` };
    scale.push({ kind: b.kind, resource: b.resource.trim() || null, min, max });
  }
  let monthly = null;
  if (d.monthly.trim()) {
    monthly = Number(d.monthly.trim());
    if (!Number.isFinite(monthly) || monthly < 0)
      return { error: 'The most it may cost a month is a number, or empty.' };
  }
  const cap = whole(d.cap);
  if (Number.isNaN(cap) || cap > CAP_MAX) return { error: `Restarts is a whole number from 0 to ${CAP_MAX}.` };
  return { envelope: { scale, monthly, restarts: { cap, hours: Number(d.hours) } } };
}

/**
 * The envelope's form: scale bounds for the kinds its provider scales, the most it may cost a month, and the
 * restart cap. Saving asks first, naming the environment and the bounds.
 * @param {{ env: any, out: any, currency: string | null, onSaved: (out: any) => void, onCancel: () => void }} props
 */
function EnvelopeForm({ env, out, currency, onSaved, onCancel }) {
  const [draft, setDraft] = useState(() => toDraft(out.envelope));
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const kinds = out.scalable ?? [];
  const id = `ifs-${env.id}`;
  const setBound = (i, field) => (/** @type {any} */ e) =>
    setDraft((d) => ({ ...d, scale: d.scale.map((b, j) => (j === i ? { ...b, [field]: e.currentTarget.value } : b)) }));
  const addBound = () =>
    setDraft((d) => ({ ...d, scale: [...d.scale, { kind: kinds[0].kind, resource: '', min: '1', max: '2' }] }));
  const removeBound = (i) => setDraft((d) => ({ ...d, scale: d.scale.filter((_, j) => j !== i) }));

  const save = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const checked = fromDraft(draft);
    if ('error' in checked) {
      setProblem(checked.error);
      return;
    }
    setProblem(null);
    const changing = Boolean(out.envelope);
    const ok = await confirmDialog({
      title: changing ? `Change ${env.name}’s envelope?` : `Set an envelope on ${env.name}?`,
      body: `Scaling and restarts inside these bounds happen without asking you: ${envelopeWords(checked.envelope)}. Anything outside them waits for you.`,
      confirmLabel: changing ? 'Change envelope' : 'Set envelope',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const saved = await api(`infra/envelopes/${enc(env.id)}`, {
        method: 'PUT',
        body: { envelope: checked.envelope, by: 'owner' },
      });
      toast(changing ? `Changed ${env.name}’s envelope.` : `${env.name} has an envelope now.`, 'success');
      onSaved(saved);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="ifs-form" onSubmit={save} noValidate aria-label={`${env.name}’s envelope`}>
      <fieldset class="field">
        <legend class="field-label">Scaling</legend>
        {kinds.length === 0 ? (
          <p class="field-hint">
            {env.provider ?? 'Its provider'} has nothing that scales yet, so this envelope bounds restarts only.
          </p>
        ) : (
          <>
            {draft.scale.length === 0 && <p class="field-hint">No scaling bounds: every scale waits for you.</p>}
            {draft.scale.map((b, i) => {
              return (
                <div class="ifs-bound" key={i}>
                  <label class="field">
                    <span class="field-label">Kind</span>
                    <select class="select" value={b.kind} onChange={setBound(i, 'kind')}>
                      {kinds.map((k) => (
                        <option key={k.kind} value={k.kind}>
                          {k.kind} ({k.setting})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">Resource</span>
                    <input
                      class="input"
                      autoComplete="off"
                      spellcheck={false}
                      maxLength={100}
                      placeholder={`Every ${b.kind}`}
                      value={b.resource}
                      onInput={setBound(i, 'resource')}
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">Lowest</span>
                    <input
                      class="input"
                      inputMode="numeric"
                      autoComplete="off"
                      value={b.min}
                      onInput={setBound(i, 'min')}
                    />
                  </label>
                  <label class="field">
                    <span class="field-label">Highest</span>
                    <input
                      class="input"
                      inputMode="numeric"
                      autoComplete="off"
                      value={b.max}
                      onInput={setBound(i, 'max')}
                    />
                  </label>
                  <button
                    type="button"
                    class="btn btn-quiet btn-icon btn-sm ifs-remove"
                    aria-label={`Remove the bound for ${b.resource.trim() || `every ${b.kind}`}`}
                    onClick={() => removeBound(i)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <p>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                onClick={addBound}
                disabled={draft.scale.length >= 20}
              >
                <Plus size={16} aria-hidden="true" />
                Add a bound
              </button>
            </p>
            <p class="field-hint">
              A resource by name, or leave it empty for every one of its kind. A resource’s own bound comes first.
            </p>
          </>
        )}
      </fieldset>
      <div class="rs-fields rs-fields-3">
        {kinds.length > 0 && (
          <label class="field">
            <span class="field-label">Most it may cost a month{currency ? ` (${currency})` : ''}</span>
            <input
              class="input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="No cost bound"
              value={draft.monthly}
              onInput={(e) => setDraft((d) => ({ ...d, monthly: e.currentTarget.value }))}
              aria-describedby={`${id}-monthly-hint`}
            />
            <span class="field-hint" id={`${id}-monthly-hint`}>
              After a scale. Empty means no cost bound; a scale whose cost isn’t known then still applies.
            </span>
          </label>
        )}
        <label class="field">
          <span class="field-label">Restarts</span>
          <input
            class="input"
            inputMode="numeric"
            autoComplete="off"
            value={draft.cap}
            onInput={(e) => setDraft((d) => ({ ...d, cap: e.currentTarget.value }))}
            aria-describedby={`${id}-cap-hint`}
          />
          <span class="field-hint" id={`${id}-cap-hint`}>
            How many restarts happen without asking you. 0 asks you for every one.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Within</span>
          <select
            class="select"
            value={String(draft.hours)}
            onChange={(e) => setDraft((d) => ({ ...d, hours: Number(e.currentTarget.value) }))}
          >
            {windowOptions(draft.hours).map((h) => (
              <option key={h} value={String(h)}>
                {windowWords(h)}
              </option>
            ))}
          </select>
          <span class="field-hint">Once they’re used, the next restart waits for you, with a push.</span>
        </label>
      </div>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      <div class="rs-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
          {busy ? 'Saving…' : out.envelope ? 'Change envelope' : 'Set envelope'}
        </button>
      </div>
    </form>
  );
}

/** The approval rules there are (BRK-303), in the order they get stricter. */
const RULES = [
  { key: 'maintainer:1', role: 'maintainer', people: 1, label: 'One maintainer' },
  { key: 'maintainer:2', role: 'maintainer', people: 2, label: 'Two different maintainers' },
  { key: 'owner:1', role: 'owner', people: 1, label: 'The owner' },
  { key: 'owner:2', role: 'owner', people: 2, label: 'The owner and one other person' },
];

/**
 * Who approves an environment's plans and changes (BRK-303): one maintainer by default, or the two-person rule, or
 * the owner. Tightening it is a maintainer's; loosening it the owner's, and the board says so if it refuses.
 * @param {{ env: any }} props
 */
function ApprovalRule({ env }) {
  const [rule, setRule] = useState(/** @type {string | null} */ (null));
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const where = `infra/environments/${enc(env.id)}/approval?repo=${enc(env.repo)}`;
  useEffect(() => {
    api(where)
      .then((r) => {
        const key = `${r.rule.role}:${r.rule.people}`;
        setRule(key);
        setPicked(key);
      })
      .catch(() => setRule(null));
  }, [env.id]);
  if (!rule) return null;
  const save = async () => {
    const next = RULES.find((r) => r.key === picked);
    if (!next || picked === rule) return;
    const ok = await confirmDialog({
      title: `Change who approves ${env.name}’s plans?`,
      body: `${next.label} must approve each plan and change from now on. Plans inside an envelope still apply without asking.`,
      confirmLabel: 'Change',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const saved = await api(where, { method: 'PUT', body: { role: next.role, people: next.people } });
      setRule(`${saved.rule.role}:${saved.rule.people}`);
      toast(`${next.label} approves ${env.name}’s plans now.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
      setPicked(rule);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="ifs-approval">
      <label class="ifs-approval-label" for={`approval-${env.id}`}>
        Who approves its plans
      </label>
      <div class="ifs-approval-row">
        <select
          class="select"
          id={`approval-${env.id}`}
          value={picked}
          onChange={(e) => setPicked(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}
          disabled={busy}
        >
          {RULES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        {picked !== rule && (
          <button type="button" class="btn btn-outline btn-sm" onClick={save} disabled={busy} aria-busy={busy}>
            Change
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One environment: its kind and flags, Freeze, who approves its plans, and its envelope with Add, Change, and Revoke.
 * @param {{ env: any, out: any | null, currency: string | null, onEnv: (env: any) => void, onOut: (out: any) => void }} props
 */
function Environment({ env, out, currency, onEnv, onOut }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const envelope = out?.envelope ?? null;
  const revoke = async () => {
    const ok = await confirmDialog({
      title: `Revoke ${env.name}’s envelope?`,
      body: 'Every scale and restart there waits for you again.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      onOut(await api(`infra/envelopes/${enc(env.id)}`, { method: 'DELETE', body: { by: 'owner' } }));
      toast(`Revoked ${env.name}’s envelope.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (env.observeOnly)
    body = (
      <p class="meta">
        {env.runsTheBoard
          ? 'It runs this board, so the board only watches it: no plans and no envelope.'
          : 'Observe only: the board watches it and never changes it, so it has no envelope.'}
      </p>
    );
  else if (!out) body = <p class="meta">Its envelope couldn’t be read.</p>;
  else if (editing)
    body = (
      <EnvelopeForm
        env={env}
        out={out}
        currency={currency}
        onSaved={(saved) => {
          onOut(saved);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  else
    body = (
      <>
        {envelope ? (
          <>
            <p class="ifs-envelope">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                <strong>Envelope:</strong> {out.words}.
              </span>
            </p>
            {envelope.restarts.cap > 0 && (
              <p class="meta">
                {out.restartsUsed} of {plural(envelope.restarts.cap, 'restart')} used in the last{' '}
                {windowWords(envelope.restarts.hours).replace(/^an? /u, '')}.
              </p>
            )}
          </>
        ) : (
          <p class="meta">No envelope: every scale and restart waits for you.</p>
        )}
        {out.blocked ? (
          <p class="meta">{upper(out.blocked)}.</p>
        ) : (
          <div class="rs-actions">
            {envelope && (
              <button type="button" class="btn btn-quiet btn-sm" onClick={revoke} disabled={busy} aria-busy={busy}>
                Revoke
              </button>
            )}
            <button type="button" class="btn btn-outline btn-sm" onClick={() => setEditing(true)} disabled={busy}>
              {envelope ? 'Change' : 'Add an envelope'}
            </button>
          </div>
        )}
      </>
    );

  return (
    <li class={`infra-env ifs-env ${env.frozen ? 'is-frozen' : ''}`}>
      <div class="infra-env-head">
        <h4 class="infra-env-name">
          <a href={hashFor({ view: 'infrastructure', environment: String(env.id), task: null })}>{env.name}</a>
        </h4>
        <span class="infra-kind">{KIND_LABEL[env.kind] ?? env.kind}</span>
        <span class="ifs-freeze">
          <FreezeButton env={env} onChange={onEnv} />
        </span>
      </div>
      <EnvironmentFlags env={env} />
      {!env.observeOnly && <ApprovalRule env={env} />}
      {body}
    </li>
  );
}

/**
 * The repository's Infrastructure section.
 * @param {{ repo: any }} props
 */
export function InfraSettings({ repo }) {
  const [state, setState] = useState(
    /** @type {{ policy: any, environments: any[], envelopes: Record<string, any>, error: string | null } | null} */ (
      null
    ),
  );
  const load = () => {
    const q = `repo=${enc(repo.slug)}`;
    Promise.all([api(`infra/policy?${q}`), api(`infra/environments?${q}`), api(`infra/envelopes?${q}`)])
      .then(([p, e, v]) =>
        setState({
          policy: p.policies[0] ?? null,
          environments: e.environments,
          envelopes: Object.fromEntries(v.envelopes.map((o) => [o.environment.id, o])),
          error: null,
        }),
      )
      .catch((err) => setState({ policy: null, environments: [], envelopes: {}, error: err.message }));
  };
  useEffect(load, [repo.slug]);

  const onEnv = (env) =>
    setState((s) => s && { ...s, environments: s.environments.map((x) => (x.id === env.id ? { ...x, ...env } : x)) });
  const onOut = (out) => setState((s) => s && { ...s, envelopes: { ...s.envelopes, [out.environment.id]: out } });

  return (
    <section class="rs-section" aria-labelledby="rs-infra">
      <h2 id="rs-infra">Infrastructure</h2>
      {!state ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : state.error ? (
        <div class="rs-load-error">
          <p class="field-error" role="alert">
            Couldn’t load the policy and envelopes: {state.error}
          </p>
          <button type="button" class="btn btn-outline btn-sm" onClick={load}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {state.policy && <Policy out={state.policy} names={state.environments.map((e) => e.name)} />}
          <div class="ifs-envs">
            <h3>Environments</h3>
            {state.environments.length === 0 ? (
              <p class="meta">
                {repo.name} has no environments yet.{' '}
                <a href={hashFor({ view: 'infrastructure', environment: null, task: null })}>Open Infrastructure</a> to
                add one; its freeze and envelope show here.
              </p>
            ) : (
              <>
                <p class="meta">
                  An envelope is bounds you approve once: inside them the board scales and restarts without asking you,
                  production included. Freezing stops every plan there, envelopes included.
                </p>
                <ul class="ifs-env-list">
                  {state.environments.map((env) => (
                    <Environment
                      key={env.id}
                      env={env}
                      out={state.envelopes[env.id] ?? null}
                      currency={state.policy?.currency?.currency ?? null}
                      onEnv={onEnv}
                      onOut={onOut}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
