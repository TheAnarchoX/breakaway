import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Bot,
  Check,
  CircleX,
  FilePlus2,
  GitPullRequest,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { writeDraft } from '../lib/drafts.js';
import { confirmDialog, github, hashFor, newAgent, pullParam, repoName, toast } from '../lib/store.js';
import { planOverlay } from '../lib/topology.js';
import {
  CARD,
  PREVIEW_DELAY_MS,
  agentPrompt,
  cardState,
  declaredFor,
  editLines,
  editMarks,
  fieldProblem,
  formValue,
  getPath,
  joinEdits,
  readEdits,
  recentChange,
  setPath,
  settingEdits,
  writeEdits,
} from '../lib/infra-change.js';
import { PLAN_STATE, amount, settingChanges } from '../views/PlanView.jsx';

/**
 * Plan from the console (WEB-99; docs/specs/BRK-258-plan-from-the-board.md): the owner changes an environment where
 * they see it. **Change** on a node's detail turns its settings into fields (the provider says which, BRK-262), **Add
 * from a template** adds what a golden path adds, and **Remove** takes a resource out. Every edit joins the
 * environment's one change, kept in this browser until it's proposed or discarded. The panel beside the map says the
 * change in words at once, then the board's own plan of it (BRK-259: the diff, the cost change, what can't be undone,
 * and the policy's answer), 1.5 seconds after the last edit. **Propose the change** has the board open its pull
 * request, and the change's card follows it without leaving the page: Checking, Waiting for you (Approve, Reject),
 * Merging, then the plan's own states (BRK-260). Apply is never a button: Approve is the owner's press, and the board
 * applies. No code or JSON shows here.
 */

/** A plan's words, and the card's own. */
const STATE_WORDS = { ...PLAN_STATE, ...CARD };

/** The card's own states, coloured like a plan's. */
const PILL = { waiting: 'waiting', merging: 'approved', cant: 'failed', merged: 'approved' };

const short = (/** @type {string | null | undefined} */ sha) => (sha ? sha.slice(0, 7) : '');

/**
 * The change's state for one environment: the edits kept in this browser, the board's preview of them, the resource
 * being changed or the template form, what the provider lets the console change, and the change the board holds.
 * @param {any} env
 * @param {{ desired: any, tick: number, plans: any[] }} options
 */
export function useChange(env, { desired, tick, plans }) {
  const id = env?.id;
  const [edits, setEdits] = useState(/** @type {import('../lib/infra-change.js').Edit[]} */ ([]));
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const [adding, setAdding] = useState(false);
  const [editable, setEditable] = useState(/** @type {Record<string, any> | null} */ (null));
  const [draft, setDraft] = useState(/** @type {any[] | null} */ (null));
  const [held, setHeld] = useState(/** @type {{ open: any, changes: any[] } | null} */ (null));
  const [plan, setPlan] = useState(/** @type {any} */ (null));
  const [preview, setPreview] = useState(
    /** @type {{ busy: boolean, key: string | null, data: any, problems: any[], error: string | null, wait: number | null }} */ ({
      busy: false,
      key: null,
      data: null,
      problems: [],
      error: null,
      wait: null,
    }),
  );
  const asking = useRef(false);
  const again = useRef(false);
  const latest = useRef(/** @type {any[]} */ ([]));

  // Each environment starts from what this browser kept for it.
  useEffect(() => {
    if (id == null) return;
    setEdits(readEdits(id));
    setEditing(null);
    setAdding(false);
    setEditable(null);
    setDraft(null);
    setHeld(null);
    setPreview({ busy: false, key: null, data: null, problems: [], error: null, wait: null });
    api(`infra/environments/${enc(id)}/editable`)
      .then((d) => setEditable(d.editable?.kinds ?? {}))
      .catch(() => setEditable({}));
  }, [id]);

  // An environment with no file yet changes the board's draft of it (BRK-240).
  const fromDraft = Boolean(env) && !env.observeOnly && !desired;
  useEffect(() => {
    if (!fromDraft || id == null) return;
    api(`infra/environments/${enc(id)}/draft`)
      .then((d) => setDraft(JSON.parse(d.draft.json).resources ?? []))
      .catch(() => setDraft([]));
  }, [id, fromDraft]);

  // The change the board holds, read with the rest of the console.
  useEffect(() => {
    if (id == null) return;
    api(`infra/environments/${enc(id)}/changes`)
      .then((d) => setHeld({ open: d.open, changes: d.changes }))
      .catch(() => {});
  }, [id, tick]);

  const shown = held?.open ?? held?.changes?.find((c) => c.state !== 'rejected' && recentChange(c)) ?? null;
  const planId = shown?.state === 'merged' ? (shown.approval?.plan ?? null) : null;
  useEffect(() => {
    if (!planId) {
      setPlan(null);
      return;
    }
    const known = plans.find((p) => p.id === planId);
    if (known) setPlan(known);
    else
      api(`infra/plans/${enc(planId)}`)
        .then((p) => setPlan(p.plan))
        .catch(() => {});
  }, [planId, tick]);

  const declared = desired?.desired?.resources ?? draft ?? [];
  const key = JSON.stringify(edits);
  latest.current = edits;

  const ask = async () => {
    if (asking.current) {
      again.current = true;
      return;
    }
    const sent = latest.current;
    const sentKey = JSON.stringify(sent);
    if (!sent.length && !fromDraft) {
      setPreview({ busy: false, key: sentKey, data: null, problems: [], error: null, wait: null });
      return;
    }
    asking.current = true;
    setPreview((p) => ({ ...p, busy: true, wait: null }));
    try {
      const data = await api(`infra/environments/${enc(id)}/changes`, { method: 'POST', body: { edits: sent } });
      setPreview({ busy: false, key: sentKey, data, problems: [], error: null, wait: null });
    } catch (err) {
      const body = err.data ?? {};
      if (err.status === 429 && body.retryAfter) {
        // The board plans an environment at most 6 times a minute: ask again when it says.
        setPreview((p) => ({ ...p, busy: true, wait: Number(body.retryAfter) }));
        setTimeout(() => {
          if (JSON.stringify(latest.current) === sentKey) ask();
        }, Number(body.retryAfter) * 1000);
      } else
        setPreview({
          busy: false,
          key: sentKey,
          data: body.lines ? { lines: body.lines, dropped: body.dropped ?? [], head: body.head } : null,
          problems: body.problems ?? [],
          error: body.problems ? null : err.message,
          wait: null,
        });
    } finally {
      asking.current = false;
      if (again.current) {
        again.current = false;
        ask();
      }
    }
  };

  // The board's preview, 1.5 seconds after the last edit, one request at a time.
  useEffect(() => {
    if (id == null || env.observeOnly || !env.provider) return;
    if (!edits.length && !fromDraft) {
      setPreview({ busy: false, key, data: null, problems: [], error: null, wait: null });
      return;
    }
    const timer = setTimeout(ask, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [id, key, fromDraft]);

  const save = (/** @type {import('../lib/infra-change.js').Edit[]} */ next) => {
    setEdits(next);
    writeEdits(id, next);
  };
  return {
    env,
    edits,
    declared,
    fromDraft,
    editable,
    editing,
    adding,
    preview,
    held: shown,
    plan,
    current: preview.key === key && !preview.busy,
    /** Joins edits to the change; answers why not when they don't fit. */
    add(
      /** @type {import('../lib/infra-change.js').Edit[]} */ more,
      { replacing = /** @type {string | null} */ (null) } = {},
    ) {
      const base = replacing ? edits.filter((e) => !(e.op === 'set' && e.resource === replacing)) : edits;
      const joined = joinEdits(base, more);
      if ('error' in joined) return joined.error;
      save(joined.edits);
      return null;
    },
    drop: (/** @type {number} */ n) => save(edits.filter((_, i) => i !== n)),
    discard: () => {
      save([]);
      setEditing(null);
      setAdding(false);
    },
    edit: (/** @type {string | null} */ rid) => {
      setAdding(false);
      setEditing(rid);
    },
    addTemplate: (/** @type {boolean} */ on) => {
      setEditing(null);
      setAdding(on);
    },
    /** After a propose: the change is the board's now, so this browser forgets it. */
    proposed(/** @type {any} */ change) {
      save([]);
      setEditing(null);
      setAdding(false);
      setHeld((h) => ({ open: change, changes: [change, ...(h?.changes ?? []).filter((c) => c.n !== change.n)] }));
    },
    changed(/** @type {any} */ change) {
      setHeld((h) => ({
        open: ['open', 'approved'].includes(change.state) ? change : null,
        changes: [change, ...(h?.changes ?? []).filter((c) => c.n !== change.n)],
      }));
    },
    /** The map's marks for the change: the board's plan of it once it matches, else what this browser knows. */
    overlay() {
      if (!edits.length) return null;
      if (preview.key === key && preview.data?.preview) {
        const { ops, adds } = planOverlay(preview.data.preview.diff);
        return { ops, adds };
      }
      return { ops: editMarks(edits), adds: [] };
    },
  };
}

/** @typedef {ReturnType<typeof useChange>} Change */

/** Why the console can't change this environment, in a line, or null when it can. */
export function cantChange(/** @type {any} */ env, /** @type {number} */ seen) {
  if (env.observeOnly) return 'Observe only: the board watches it and never changes it.';
  if (!env.provider) return 'Pick its provider and connect it on Connections to change it here.';
  if (!seen) return 'Nothing seen yet: once the board sees what runs, you can change it here.';
  return null;
}

/**
 * Change and Remove, under a selected node's detail; a resource the desired state doesn't declare says why it can't.
 * @param {{ r: any, ch: Change }} props
 */
export function NodeChange({ r, ch }) {
  if (r.planned) return null;
  const d = declaredFor(ch.declared, r);
  if (!d)
    return (
      <p class="meta change-node-line">
        {ch.fromDraft
          ? 'The board’s draft leaves it out.'
          : 'The desired state doesn’t declare it, so it’s not changed here.'}
      </p>
    );
  const removing = ch.edits.some((e) => e.op === 'remove' && e.resource === d.id);
  const kind = ch.editable?.[d.kind];
  return (
    <>
      {kind?.fields?.length > 0 && !removing && (
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => ch.edit(d.id)}
          aria-pressed={ch.editing === d.id}
        >
          <Pencil size={14} aria-hidden="true" />
          Change
        </button>
      )}
      {removing ? (
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => ch.drop(ch.edits.findIndex((e) => e.op === 'remove' && e.resource === d.id))}
        >
          <X size={14} aria-hidden="true" />
          Keep it
        </button>
      ) : (
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => {
            const error = ch.add([{ op: 'remove', resource: d.id }]);
            if (error) toast(error, 'error');
            if (ch.editing === d.id) ch.edit(null);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          Remove
        </button>
      )}
    </>
  );
}

/**
 * One field the provider declares, as an input: text, a number with bounds, yes or no, a choice, a list of names, or
 * another resource of the environment.
 * @param {{ field: import('../lib/infra-change.js').EditableField, value: any, onChange: (v: any) => void, id: string,
 *   resources: any[], problem?: string | null }} props
 */
function FieldInput({ field, value, onChange, id, resources, problem = null }) {
  const describe = `${id}-help${problem ? ` ${id}-problem` : ''}`;
  const invalid = problem ? 'true' : undefined;
  let input;
  if (field.type === 'yesno')
    input = (
      <label class="check-row">
        <input
          type="checkbox"
          id={id}
          checked={Boolean(value)}
          onChange={(e) => onChange(/** @type {HTMLInputElement} */ (e.currentTarget).checked)}
          aria-describedby={describe}
        />
        <span>{field.label}</span>
      </label>
    );
  else if (field.type === 'choice' || field.type === 'resource') {
    const options =
      field.type === 'choice'
        ? (field.options ?? [])
        : resources.filter((r) => (field.kinds ?? []).includes(r.kind)).map((r) => ({ value: r.name, label: r.name }));
    input = (
      <select
        id={id}
        class="select input-sm"
        value={value ?? ''}
        onChange={(e) => onChange(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}
        aria-describedby={describe}
        aria-invalid={invalid}
      >
        {(field.optional || !value) && (
          <option value="">{field.optional ? 'Unset: the platform decides' : 'Pick one'}</option>
        )}
        {value && !options.some((o) => o.value === value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'names')
    input = (
      <textarea
        id={id}
        class="textarea input-sm"
        rows={Math.min(6, Math.max(2, String(value ?? '').split('\n').length + 1))}
        value={value ?? ''}
        onInput={(e) => onChange(/** @type {HTMLTextAreaElement} */ (e.currentTarget).value)}
        aria-describedby={describe}
        aria-invalid={invalid}
        spellcheck={false}
      />
    );
  else
    input = (
      <span class="change-input-unit">
        <input
          id={id}
          class="input input-sm"
          type="text"
          inputMode={field.type === 'number' ? (field.integer ? 'numeric' : 'decimal') : undefined}
          value={value ?? ''}
          placeholder={field.optional ? 'Unset' : undefined}
          onInput={(e) => onChange(/** @type {HTMLInputElement} */ (e.currentTarget).value)}
          aria-describedby={describe}
          aria-invalid={invalid}
          spellcheck={false}
        />
        {field.unit && <span class="meta">{field.unit}</span>}
      </span>
    );
  return (
    <div class="field change-field">
      {field.type !== 'yesno' && (
        <label class="field-label" for={id}>
          {field.label}
        </label>
      )}
      {input}
      <span class="field-hint" id={`${id}-help`}>
        {field.help}
        {field.type === 'names' ? ' One a line.' : ''}
        {field.type === 'number' && (field.min !== undefined || field.max !== undefined)
          ? ` ${field.min ?? '…'} to ${field.max ?? 'any'}.`
          : ''}
      </span>
      {problem && (
        <span class="field-error" id={`${id}-problem`}>
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * A Worker's bindings: each one the provider lets the console change, by its name and what it binds; any other (a
 * variable, a secret) by its name and type, kept as it is.
 * @param {{ field: import('../lib/infra-change.js').EditableField, value: any, onChange: (v: any[]) => void, id: string, resources: any[], problem: string | null }} props
 */
function BindingsInput({ field, value, onChange, id, resources, problem }) {
  const targets = field.targets ?? [];
  const set = (/** @type {number} */ n, /** @type {Record<string, any>} */ patch) =>
    onChange(value.map((b, i) => (i === n ? { ...b, ...patch } : b)));
  return (
    <fieldset class="field change-field change-group" aria-describedby={`${id}-help`}>
      <legend class="field-label">{field.label}</legend>
      <span class="field-hint" id={`${id}-help`}>
        {field.help}
      </span>
      <ul class="change-rows">
        {value.map((b, n) => {
          const target = targets.find((t) => t.type === b.type);
          if (!target)
            return (
              <li key={`${b.name}-${n}`} class="change-row change-row-kept">
                <code>{b.name}</code>
                <span class="meta">{b.type}, kept as it is</span>
              </li>
            );
          const choices = resources.filter((r) => r.kind === target.kind);
          return (
            <li key={n} class="change-row">
              <input
                class="input input-sm"
                aria-label={`Binding ${n + 1}: name`}
                value={b.name ?? ''}
                onInput={(e) => set(n, { name: /** @type {HTMLInputElement} */ (e.currentTarget).value })}
                spellcheck={false}
              />
              <select
                class="select input-sm"
                aria-label={`Binding ${n + 1}: what it binds`}
                value={b.type}
                onChange={(e) => {
                  const t = targets.find((x) => x.type === /** @type {HTMLSelectElement} */ (e.currentTarget).value);
                  if (t) {
                    const { [target.field]: _old, ...rest } = b;
                    onChange(value.map((x, i) => (i === n ? { ...rest, type: t.type, [t.field]: '' } : x)));
                  }
                }}
              >
                {targets.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              <select
                class="select input-sm"
                aria-label={`Binding ${n + 1}: which ${target.label.toLowerCase()}`}
                value={b[target.field] ?? ''}
                onChange={(e) => set(n, { [target.field]: /** @type {HTMLSelectElement} */ (e.currentTarget).value })}
              >
                <option value="">Pick one</option>
                {b[target.field] && !choices.some((r) => (target.by === 'id' ? r.id : r.name) === b[target.field]) && (
                  <option value={b[target.field]}>{b[target.field]}</option>
                )}
                {choices.map((r) => (
                  <option key={r.id} value={target.by === 'id' ? r.id : r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                class="btn btn-quiet btn-icon btn-sm"
                onClick={() => onChange(value.filter((_, i) => i !== n))}
                aria-label={`Remove binding ${b.name || n + 1}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {targets.length > 0 && (
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => onChange([...value, { name: '', type: targets[0].type, [targets[0].field]: '' }])}
        >
          <Plus size={14} aria-hidden="true" />
          Add a binding
        </button>
      )}
      {problem && <span class="field-error">{problem}</span>}
    </fieldset>
  );
}

/**
 * A list of rules (a bucket's CORS or lifecycle): each with the fields the provider offers, every other key kept; a
 * new one starts from the provider's template.
 * @param {{ field: import('../lib/infra-change.js').EditableField, value: any, onChange: (v: any[]) => void, id: string, resources: any[], problem: string | null }} props
 */
function RulesInput({ field, value, onChange, id, resources, problem }) {
  const fields = field.fields ?? [];
  return (
    <fieldset class="field change-field change-group" aria-describedby={`${id}-help`}>
      <legend class="field-label">{field.label}</legend>
      <span class="field-hint" id={`${id}-help`}>
        {field.help}
      </span>
      {value.map((rule, n) => (
        <div key={n} class="change-rule">
          <div class="change-rule-head">
            <span class="kicker">Rule {n + 1}</span>
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              onClick={() => onChange(value.filter((_, i) => i !== n))}
            >
              <X size={14} aria-hidden="true" />
              Remove the rule
            </button>
          </div>
          {fields.map((f) => (
            <FieldInput
              key={f.path}
              field={f}
              id={`${id}-${n}-${f.path.replaceAll('.', '-')}`}
              value={getPath(rule, f.path)}
              resources={resources}
              problem={fieldProblem(f, getPath(rule, f.path))}
              onChange={(v) => onChange(value.map((r, i) => (i === n ? setPath(r, f.path, v) : r)))}
            />
          ))}
        </div>
      ))}
      <button
        type="button"
        class="btn btn-quiet btn-sm"
        onClick={() => {
          let rule = structuredClone(field.template ?? {});
          for (const f of fields) rule = setPath(rule, f.path, formValue(f, getPath(rule, f.path)));
          onChange([...value, rule]);
        }}
      >
        <Plus size={14} aria-hidden="true" />
        Add a rule
      </button>
      {problem && <span class="field-error">{problem}</span>}
    </fieldset>
  );
}

/**
 * A resource's settings as fields, from the provider's list; Done joins what changed to the change.
 * @param {{ ch: Change }} props
 */
function SettingsForm({ ch }) {
  const d = ch.declared.find((r) => r.id === ch.editing);
  const kind = d ? ch.editable?.[d.kind] : null;
  const fields = /** @type {import('../lib/infra-change.js').EditableField[]} */ (kind?.fields ?? []);
  // The form starts from the resource with this change's edits on it, so it shows what you set before.
  const start = () => {
    let attrs = structuredClone(d?.attrs ?? {});
    for (const e of ch.edits) if (e.op === 'set' && e.resource === d?.id) attrs = setPath(attrs, e.path, e.value);
    return Object.fromEntries(fields.map((f) => [f.path, formValue(f, getPath(attrs, f.path))]));
  };
  const [form, setForm] = useState(start);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const first = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  useEffect(() => {
    setForm(start());
    setError(null);
    first.current?.focus({ preventScroll: true });
    first.current?.scrollIntoView({ block: 'nearest' });
  }, [ch.editing]);
  if (!d || !kind) return null;
  const problems = Object.fromEntries(fields.map((f) => [f.path, fieldProblem(f, form[f.path])]));
  const wrong = Object.values(problems).some(Boolean);
  const done = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (wrong) {
      setError('Fix the fields marked first.');
      return;
    }
    const why = ch.add(settingEdits(d, fields, form), { replacing: d.id });
    if (why) setError(why);
    else ch.edit(null);
  };
  return (
    <form class="change-form" onSubmit={done} noValidate aria-labelledby="change-form-title">
      <h3 id="change-form-title" class="change-form-title" tabIndex={-1} ref={first}>
        Change {d.name}
      </h3>
      <p class="meta">{d.kind}</p>
      {fields.map((f) => {
        const id = `change-${f.path.replaceAll('.', '-')}`;
        const props = {
          field: f,
          id,
          value: form[f.path],
          resources: ch.declared,
          problem: problems[f.path],
          onChange: (/** @type {any} */ v) => setForm((s) => ({ ...s, [f.path]: v })),
        };
        if (f.type === 'bindings') return <BindingsInput key={f.path} {...props} />;
        if (f.type === 'rules') return <RulesInput key={f.path} {...props} />;
        return <FieldInput key={f.path} {...props} />;
      })}
      {(kind.shown ?? []).map((/** @type {any} */ s) => {
        const value = getPath(d.attrs, s.path);
        const list = Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : (v?.name ?? ''))) : [];
        return (
          <div key={s.path} class="field change-field">
            <span class="field-label">{s.label}</span>
            {list.length ? (
              <ul class="change-names">
                {list.map((n) => (
                  <li key={n}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <span class="meta">None</span>
            )}
            <span class="field-hint">{s.help}</span>
          </div>
        );
      })}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="change-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => ch.edit(null)}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm">
          <Check size={14} aria-hidden="true" />
          Add to the change
        </button>
      </div>
    </form>
  );
}

/**
 * Add from a template: the repository's golden paths and the one breakaway ships, each asking for its inputs.
 * @param {{ ch: Change }} props
 */
function TemplateForm({ ch }) {
  const [list, setList] = useState(/** @type {{ templates: any[], folder: string } | null} */ (null));
  const [failed, setFailed] = useState(/** @type {string | null} */ (null));
  const [name, setName] = useState('');
  const [inputs, setInputs] = useState(/** @type {Record<string, string>} */ ({}));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    api(`infra/environments/${enc(ch.env.id)}/templates`)
      .then((d) => {
        setList(d);
        const first = d.templates.find((/** @type {any} */ t) => !t.error);
        if (first) pick(first);
      })
      .catch((err) => setFailed(err.message));
  }, [ch.env.id]);
  const pick = (/** @type {any} */ t) => {
    setName(t.name);
    setInputs(
      Object.fromEntries(Object.entries(t.inputs ?? {}).map(([k, v]) => [k, /** @type {any} */ (v).default ?? ''])),
    );
    setError(null);
  };
  const template = list?.templates.find((t) => t.name === name) ?? null;
  const ours = (list?.templates ?? []).every((t) => t.from === 'breakaway');
  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (!template) return;
    const empty = Object.keys(template.inputs ?? {}).find((k) => !String(inputs[k] ?? '').trim());
    if (empty) {
      setError(`Give it a ${empty}.`);
      return;
    }
    const bad = Object.entries(template.inputs ?? {}).find(
      ([k, v]) => /** @type {any} */ (v).pattern && !new RegExp(/** @type {any} */ (v).pattern, 'u').test(inputs[k]),
    );
    if (bad) {
      setError(`${bad[0]} doesn’t look right: ${/** @type {any} */ (bad[1]).help}`);
      return;
    }
    const why = ch.add([
      {
        op: 'add',
        template: template.name,
        inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.trim()])),
      },
    ]);
    if (why) setError(why);
    else ch.addTemplate(false);
  };
  return (
    <form class="change-form" onSubmit={submit} noValidate aria-labelledby="change-template-title">
      <h3 id="change-template-title" class="change-form-title">
        Add from a template
      </h3>
      {failed ? (
        <p class="field-error" role="alert">
          Couldn’t list the templates. {failed}
        </p>
      ) : !list ? (
        <p class="muted" aria-busy="true">
          Reading the templates…
        </p>
      ) : (
        <>
          <fieldset class="field change-field">
            <legend class="field-label">Template</legend>
            <div class="change-templates">
              {list.templates.map((t) => (
                <label key={t.name} class={`change-template ${t.error ? 'is-broken' : ''}`}>
                  <input
                    type="radio"
                    name="change-template"
                    value={t.name}
                    checked={name === t.name}
                    disabled={Boolean(t.error)}
                    onChange={() => pick(t)}
                  />
                  <span>
                    <strong>{t.title ?? t.name}</strong>
                    <span class="meta">
                      {' '}
                      {t.error
                        ? `doesn’t check: ${t.error}`
                        : t.from === 'breakaway'
                          ? 'from breakaway'
                          : `from ${repoName(ch.env.repo)}`}
                    </span>
                    {t.description && <span class="change-template-text">{t.description}</span>}
                  </span>
                </label>
              ))}
            </div>
            {ours && (
              <span class="field-hint">
                Your own templates go in <code>{list.folder}/</code>, one folder each. Have an agent write one.
              </span>
            )}
          </fieldset>
          {template &&
            Object.entries(template.inputs ?? {}).map(([k, v]) => (
              <div key={k} class="field change-field">
                <label class="field-label" for={`change-input-${k}`}>
                  {k}
                </label>
                <input
                  id={`change-input-${k}`}
                  class="input input-sm"
                  value={inputs[k] ?? ''}
                  onInput={(e) => {
                    setInputs((s) => ({ ...s, [k]: /** @type {HTMLInputElement} */ (e.currentTarget).value }));
                    setError(null);
                  }}
                  aria-describedby={`change-input-${k}-help`}
                  spellcheck={false}
                />
                <span class="field-hint" id={`change-input-${k}-help`}>
                  {/** @type {any} */ (v).help}
                </span>
              </div>
            ))}
          {template?.files?.length > 0 && (
            <p class="meta">
              It also adds {template.files.length === 1 ? 'a file' : `${template.files.length} files`} to the repository
              in the same pull request.
            </p>
          )}
        </>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="change-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => ch.addTemplate(false)}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={!template}>
          <Plus size={14} aria-hidden="true" />
          Add to the change
        </button>
      </div>
    </form>
  );
}

/**
 * The board's plan of the change: how many changes, the cost change, what can't be undone, what else it touches, and
 * the policy's answer a rule a line, then each change.
 * @param {{ preview: any }} props
 */
export function PlanPreview({ preview }) {
  const cost = preview.cost;
  const deletes = preview.blastRadius?.deletesInUse ?? [];
  const reached = (preview.blastRadius?.resources ?? []).filter((/** @type {any} */ r) => !r.changed);
  const policy = preview.policy;
  return (
    <div class="change-preview-plan">
      <dl class="change-facts">
        <div>
          <dt>Changes</dt>
          <dd>{preview.changes || 'None to what runs'}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd class="infra-num">
            {!cost || cost.delta === null
              ? 'Not known'
              : cost.delta === 0
                ? 'Nothing a month'
                : `${amount(cost.delta, cost.currency ?? null, { signed: true })} a month`}
          </dd>
        </div>
        <div>
          <dt>Undo</dt>
          <dd>{preview.reversible ? 'Can be undone' : 'Can’t all be undone'}</dd>
        </div>
        {reached.length > 0 && (
          <div>
            <dt>Touches</dt>
            <dd>
              {reached.length} more:{' '}
              {reached
                .slice(0, 3)
                .map((/** @type {any} */ r) => r.name ?? r.id)
                .join(', ')}
              {reached.length > 3 ? '…' : ''}
            </dd>
          </div>
        )}
      </dl>
      {preview.irreversible?.map((/** @type {any} */ c) => (
        <p key={c.resource} class="infra-plan-irreversible">
          <TriangleAlert size={14} aria-hidden="true" />
          {c.name}: can’t be undone{c.why ? `: ${c.why}` : ''}
        </p>
      ))}
      {deletes.map((/** @type {any} */ d) => (
        <p key={d.resource} class="infra-plan-irreversible">
          <TriangleAlert size={14} aria-hidden="true" />
          It removes {d.name}, which {d.by.length === 1 ? 'something still uses' : `${d.by.length} things still use`}.
        </p>
      ))}
      {policy && (
        <div class={`change-policy change-policy-${policy.outcome}`}>
          <p class="change-policy-lead">
            {policy.outcome === 'refused'
              ? 'The policy refuses it:'
              : policy.outcome === 'allowed'
                ? 'Your policy lets it through.'
                : 'It needs your approval:'}
          </p>
          {policy.outcome !== 'allowed' && (
            <ul>
              {policy.reasons.map((/** @type {string} */ r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {preview.diff?.changes?.length > 0 && (
        <ul class="change-diff">
          {preview.diff.changes.map((/** @type {any} */ c) => {
            const settings = settingChanges(c);
            return (
              <li key={`${c.op} ${c.resource}`} class={`change-diff-item infra-plan-op-${c.op}`}>
                <span class="change-diff-op">{c.op === 'create' ? '+' : c.op === 'delete' ? '−' : '~'}</span>
                <span>
                  <strong>{c.name}</strong> <span class="meta">{c.kind}</span>
                  {settings.length > 0 && (
                    <span class="change-diff-settings">
                      {settings.map((s) => (
                        <span key={s.key}>
                          {s.key}: {s.before ?? 'unset'} → {s.after ?? 'unset'}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Opens New agent with the prompt filled in, for what the console can't express. */
function haveAnAgent(/** @type {any} */ env, /** @type {string[]} */ lines) {
  writeDraft('agent', { fields: { prompt: agentPrompt(env, lines), repo: env.repo }, typed: true });
  newAgent.value = true;
}

/**
 * The change's card, once proposed: its state, its pull request, and the owner's buttons.
 * @param {{ ch: Change }} props
 */
function ChangeCard({ ch }) {
  const change = ch.held;
  const { env } = ch;
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [moved, setMoved] = useState(/** @type {any} */ (null));
  if (!change) return null;
  const pull = change.pull
    ? (github.value.data?.open ?? []).find(
        (/** @type {any} */ p) => Number(p.number) === change.pull.number && (!p.repo || p.repo === change.repo),
      )
    : null;
  const card = cardState(change, { checks: pull?.checks?.state ?? null, plan: ch.plan });
  // A plan that moved since the change was proposed can't be approved: proposing again plans it on the current head.
  if (moved) Object.assign(card, { approve: false, again: true });
  const word = STATE_WORDS[card.state] ?? card.state;
  const pullHref = change.pull
    ? hashFor({ view: 'github', task: null, pr: pullParam(change.pull.number, change.repo) })
    : null;

  const approve = async () => {
    const ok = await confirmDialog({
      title: `Approve this plan for ${env.name}?`,
      body: `The board merges its pull request, applies the plan, and rolls back if the health check fails.`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy('approve');
    setError(null);
    try {
      const res = await api(`infra/changes/${enc(change.n)}/approve`, {
        method: 'POST',
        body: { sha: change.commit, digest: change.digest },
      });
      setMoved(null);
      ch.changed(res.change);
      toast(`Approved: the board merges #${change.pull?.number} and applies the plan.`, 'success');
    } catch (err) {
      setError(err.message);
      if (err.data?.preview) setMoved(err.data.preview);
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    const ok = await confirmDialog({
      title: 'Reject this change?',
      body: 'The board closes its pull request. Nothing changes.',
      confirmLabel: 'Reject',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('reject');
    setError(null);
    try {
      const res = await api(`infra/changes/${enc(change.n)}/reject`, { method: 'POST', body: {} });
      ch.changed(res.change);
      toast(`Rejected: #${change.pull?.number} is closed and nothing changes.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const proposeAgain = async () => {
    setBusy('again');
    setError(null);
    try {
      const res = await api(`infra/environments/${enc(env.id)}/changes`, {
        method: 'POST',
        body: { edits: change.edits, propose: true },
      });
      setMoved(null);
      ch.changed(res.change);
      toast(`Proposed again on the current head: the new plan needs your approval.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const review = /review/iu.test(change.why ?? '');
  return (
    <article class={`change-card change-card-${card.state.replace(' ', '-')}`} aria-labelledby="change-card-title">
      <header class="change-card-head">
        <h3 id="change-card-title">
          {change.pull ? (
            <a href={pullHref ?? undefined}>
              <GitPullRequest size={14} aria-hidden="true" />#{change.pull.number}
            </a>
          ) : (
            `Change ${change.n}`
          )}
        </h3>
        <span class={`infra-plan-state infra-plan-${PILL[card.state] ?? card.state.replace(' ', '-')}`} role="status">
          {word}
        </span>
      </header>
      <ul class="change-lines">
        {change.lines.map((/** @type {string} */ l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {card.state === 'checking' && <p class="meta">The board’s plan check is running on its pull request.</p>}
      {card.state === 'waiting' && (
        <p class="meta">
          Planned from {short(change.head) || 'the draft'}. Approve merges it and applies this plan; nothing applies
          before.
        </p>
      )}
      {card.state === 'merging' && (
        <p class="meta">
          {change.approval?.merge === 'auto' || change.approval?.merge === 'sync'
            ? 'Approved: it merges once its checks pass, then the board applies the plan.'
            : 'Approved: the board is merging it, then applies the plan.'}
        </p>
      )}
      {card.state === 'merged' && <p class="meta">Merged: the board is making its plan from the merge.</p>}
      {card.state === 'taken over' && (
        <p class="meta">
          Someone else pushed to it, so it’s an ordinary pull request now. Merge it from its page when it reads right;
          its plan waits for you after.
        </p>
      )}
      {card.plan && ch.plan && (
        <p class="meta">
          <a href={hashFor({ view: 'infrastructure', environment: String(env.id), plan: ch.plan.id, task: null })}>
            {ch.plan.id}
          </a>
          {ch.plan.state === 'waiting' ? ' waits for you: the plan changed between your approval and the merge.' : ''}
        </p>
      )}
      {change.why && card.state !== 'merging' && (
        <p class={card.state === 'cant' ? 'field-error' : 'meta'} role={card.state === 'cant' ? 'alert' : undefined}>
          {change.why}
          {review && change.pull?.url && (
            <>
              {' '}
              <a href={change.pull.url} target="_blank" rel="noopener noreferrer">
                Open it on GitHub
              </a>
              .
            </>
          )}
        </p>
      )}
      {card.approve && env.frozen && (
        <p class="meta change-frozen">
          {`${env.name[0].toUpperCase()}${env.name.slice(1)}`} is frozen: unfreeze it to approve.
        </p>
      )}
      {moved && (
        <div class="change-moved">
          <p class="change-policy-lead">What runs changed since you looked. Here’s the plan now.</p>
          <PlanPreview preview={moved} />
        </div>
      )}
      {error && !moved && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {(card.approve || card.reject || card.again) && (
        <div class="change-actions">
          {card.reject && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={reject} disabled={busy !== null}>
              <CircleX size={14} aria-hidden="true" />
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          )}
          {card.again && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={proposeAgain} disabled={busy !== null}>
              <RefreshCw size={14} aria-hidden="true" />
              {busy === 'again' ? 'Proposing…' : 'Propose again'}
            </button>
          )}
          {card.approve && (
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={approve}
              disabled={busy !== null || env.frozen}
              aria-busy={busy === 'approve'}
            >
              <Check size={14} aria-hidden="true" />
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The change beside the map: the form you're filling in, the change in words, the board's plan of it, and Propose;
 * once proposed, the change's card.
 * @param {{ ch: Change, cant: string | null }} props
 */
export function ChangePanel({ ch, cant }) {
  const { env, edits } = ch;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const panel = useRef(/** @type {HTMLElement | null} */ (null));
  const labels = new Map(Object.entries(ch.editable ?? {}).map(([k, v]) => [k, v.fields ?? []]));
  const local = editLines(edits, ch.declared, labels);
  const p = ch.preview;
  const fresh = ch.current && p.data;
  const problemsOf = (/** @type {number} */ n) => p.problems.filter((x) => x.edit === n);
  const general = p.problems.filter((x) => x.edit === null);
  const editing = Boolean(ch.editing) || ch.adding;
  const draftOnly = ch.fromDraft && !ch.held;
  const shows = editing || edits.length > 0 || ch.held || draftOnly;

  // On a phone the panel sits under the map: bring it into view when a form opens in it.
  useEffect(() => {
    if (editing && panel.current && typeof matchMedia === 'function' && matchMedia('(max-width: 1099.98px)').matches)
      panel.current.scrollIntoView({ block: 'start' });
  }, [ch.editing, ch.adding]);

  if (cant || !shows) return null;

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`infra/environments/${enc(env.id)}/changes`, {
        method: 'POST',
        body: { edits, propose: true },
      });
      ch.proposed(res.change);
      toast(
        `Proposed: the board opened #${res.change.pull?.number} and checks its plan. It waits for you here.`,
        'success',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    const ok = await confirmDialog({
      title: 'Discard this change?',
      body: `Your ${edits.length === 1 ? 'edit goes' : `${edits.length} edits go`}. Nothing on the board or in the repository changes.`,
      confirmLabel: 'Discard',
    });
    if (ok) ch.discard();
  };
  const heldLive = ch.held && ['open', 'approved'].includes(ch.held.state);
  return (
    <section class="console-panel change-panel" aria-labelledby="change-title" ref={panel}>
      <header class="console-panel-head">
        <h2 id="change-title">
          <Pencil size={16} aria-hidden="true" />
          {edits.length || editing || !ch.held ? 'Your change' : 'The change'}
          {edits.length > 0 && <span class="count">{edits.length}</span>}
        </h2>
      </header>

      {ch.editing && <SettingsForm ch={ch} />}
      {ch.adding && <TemplateForm ch={ch} />}

      {(edits.length > 0 || draftOnly) && (
        <>
          {draftOnly && (
            <p class="meta">
              {env.name} has no desired state yet. Propose it opens the pull request with the board’s draft of what runs
              {edits.length ? ', with your edits' : ''}.
            </p>
          )}
          {heldLive && (
            <p class="meta">
              Proposing replaces #{ch.held.pull?.number}’s commit with these edits, and its plan needs your approval
              again.
            </p>
          )}
          {edits.length > 0 && (
            <ul class="change-lines" aria-label="Your edits">
              {edits.map((_, n) => (
                <li key={`${n}-${local[n]}`} class={problemsOf(n).length ? 'has-problem' : ''}>
                  <span>{local[n]}</span>
                  <button
                    type="button"
                    class="btn btn-quiet btn-icon btn-sm"
                    onClick={() => ch.drop(n)}
                    aria-label={`Undo: ${local[n]}`}
                    title="Undo this edit"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                  {problemsOf(n).map((x) => (
                    <span key={x.message} class="field-error">
                      {x.message}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {p.data?.dropped?.map((/** @type {any} */ d) => (
            <p key={d.line} class="meta">
              Dropped: {d.line}.
            </p>
          ))}

          <div class="change-preview" aria-live="polite" aria-busy={p.busy}>
            <h3 class="kicker">The plan</h3>
            {p.busy || !ch.current ? (
              <p class="muted">{p.wait ? `Checking… The board plans again in ${p.wait} seconds.` : 'Checking…'}</p>
            ) : p.error ? (
              <p class="field-error">{p.error}</p>
            ) : general.length ? (
              general.map((x) => (
                <p key={x.message} class="field-error">
                  {x.message}
                </p>
              ))
            ) : p.problems.length ? (
              <p class="field-error">Fix the edits marked above, and the board plans it again.</p>
            ) : p.data?.preview ? (
              <>
                <PlanPreview preview={p.data.preview} />
                {p.data.files?.length > 0 && (
                  <p class="meta">
                    It adds {p.data.files.length === 1 ? 'a file' : `${p.data.files.length} files`} from a template.
                  </p>
                )}
                <p class="meta">
                  Planned from {p.data.head ? `the default branch at ${short(p.data.head)}` : 'the board’s draft'}.
                </p>
              </>
            ) : null}
          </div>

          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
          <div class="change-actions change-propose">
            {edits.length > 0 && (
              <button type="button" class="btn btn-quiet btn-sm" onClick={discard} disabled={busy}>
                Discard
              </button>
            )}
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              onClick={() => haveAnAgent(env, local)}
              title="Start an agent with what you were changing, for what the console can’t do"
            >
              <Bot size={14} aria-hidden="true" />
              Have an agent do it
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={propose}
              disabled={busy || !fresh || p.problems.length > 0 || Boolean(p.error)}
              aria-busy={busy}
            >
              <Send size={14} aria-hidden="true" />
              {busy ? 'Proposing…' : ch.fromDraft ? 'Propose it' : 'Propose the change'}
            </button>
          </div>
        </>
      )}

      {ch.held && <ChangeCard ch={ch} />}
    </section>
  );
}

/**
 * Add from a template, on the map's header.
 * @param {{ ch: Change }} props
 */
export function AddFromTemplate({ ch }) {
  return (
    <button
      type="button"
      class="btn btn-quiet btn-sm"
      onClick={() => ch.addTemplate(!ch.adding)}
      aria-pressed={ch.adding}
    >
      <FilePlus2 size={14} aria-hidden="true" />
      Add from a template
    </button>
  );
}

/**
 * The Plan tile's words for the change when nothing else is planned: your edits, or the change's card state.
 * @param {Change} ch
 * @returns {{ value: string, detail: string } | null}
 */
export function changeTile(ch) {
  if (ch.edits.length)
    return {
      value: 'Your change',
      detail: `${ch.edits.length} ${ch.edits.length === 1 ? 'edit' : 'edits'}, not proposed`,
    };
  if (ch.held && ['open', 'approved'].includes(ch.held.state)) {
    const card = cardState(ch.held);
    return {
      value: STATE_WORDS[card.state] ?? card.state,
      detail: `#${ch.held.pull?.number ?? ch.held.n}, your change`,
    };
  }
  return null;
}
