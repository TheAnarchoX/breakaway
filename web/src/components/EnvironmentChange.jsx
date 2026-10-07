import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowLeft,
  Bot,
  Check,
  FilePlus2,
  GitPullRequest,
  Pencil,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { writeDraft } from '../lib/drafts.js';
import { confirmDialog, github, hashFor, newAgent, pullParam, repoName, toast } from '../lib/store.js';
import { ago } from '../lib/model.js';
import { planOverlay } from '../lib/topology.js';
import {
  CARD,
  PREVIEW_DELAY_MS,
  agentPrompt,
  bindingFor,
  cardState,
  changePlanId,
  changeShows,
  codePrompt,
  createEdit,
  createForm,
  createOverlay,
  createProblems,
  declaredFor,
  editLines,
  editMarks,
  endedWords,
  fieldProblem,
  formValue,
  getPath,
  idleEdits,
  joinEdits,
  nameAfter,
  nameEdits,
  nameProblem,
  plansNothing,
  readEdits,
  readDismissed,
  recentChange,
  setPath,
  settingEdits,
  writeDismissed,
  writeEdits,
} from '../lib/infra-change.js';
import { PLAN_STATE, amount, settingChanges } from '../views/PlanView.jsx';
import { ChangeActions } from './ChangeActions.jsx';

/**
 * Plan from the console (WEB-99; docs/specs/BRK-258-plan-from-the-board.md): the owner changes an environment where
 * they see it. **Change** on a node's detail turns its settings into fields (the provider says which, BRK-262), **Add
 * from a template** adds what a golden path adds, and **Remove** takes a resource out. Every edit joins the
 * environment's one change, kept in this browser until it's proposed or discarded. **Add resource** (WEB-107) offers, in
 * one picker, every kind the provider can create (BRK-270), each asking for its name, its settings, and what binds it,
 * and the templates below them. The panel beside the map says the
 * change in words at once, then the board's own plan of it (BRK-259: the diff, the cost change, what can't be undone,
 * and the policy's answer), 1.5 seconds after the last edit. **Propose the change** has the board open its pull
 * request, and the change's card follows it without leaving the page: Checking, Waiting for you (Approve, Reject),
 * Merging, then the plan's own states (BRK-260). Apply is never a button: Approve is the owner's press, and the board
 * applies. No code or JSON shows here.
 */

/** A plan's words, and the card's own. */
const STATE_WORDS = { ...PLAN_STATE, ...CARD };

/** The card's own states, coloured like a plan's. */
const PILL = {
  waiting: 'waiting',
  merging: 'approved',
  cant: 'failed',
  merged: 'approved',
  nothing: 'applied',
  refused: 'failed',
  'rolled back': 'failed',
};

/** What the plan a merged change follows says on its card, after its ID. */
const PLAN_LINE = {
  approved: ' is approved: the board applies it.',
  applying: ' is being applied.',
  applied: ' is applied.',
  failed: ' failed: open it to see what happened and what to do.',
  'rolled back': ' was rolled back: open it to see why.',
  rejected: ' was rejected, so nothing changed.',
  draft: ' is refused by your policy, so nothing applies.',
};

const short = (/** @type {string | null | undefined} */ sha) => (sha ? sha.slice(0, 7) : '');
/** A line from the board, starting with a capital. */
const sentence = (/** @type {string} */ text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The change's state for one environment: the edits kept in this browser, the board's preview of them, the resource
 * being changed or the Add resource picker, what the provider lets the console change and create, and the change the
 * board holds.
 * @param {any} env
 * @param {{ desired: any, tick: number, plans: any[], seen?: number }} options `seen` is how many resources the board
 *   sees running: an environment with none and no file has no draft to propose until something is added
 */
export function useChange(env, { desired, tick, plans, seen = 1 }) {
  const id = env?.id;
  const [edits, setEdits] = useState(/** @type {import('../lib/infra-change.js').Edit[]} */ ([]));
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const [adding, setAdding] = useState(false);
  const [editable, setEditable] = useState(/** @type {Record<string, any> | null} */ (null));
  const [creatable, setCreatable] = useState(
    /** @type {Record<string, import('../lib/infra-change.js').CreatableKind> | null} */ (null),
  );
  const [draft, setDraft] = useState(/** @type {any[] | null} */ (null));
  const [held, setHeld] = useState(/** @type {{ open: any, changes: any[] } | null} */ (null));
  const [plan, setPlan] = useState(/** @type {any} */ (null));
  const [dismissed, setDismissed] = useState(/** @type {number | null} */ (null));
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
    setCreatable(null);
    setDraft(null);
    setHeld(null);
    setDismissed(readDismissed(id));
    setPreview({ busy: false, key: null, data: null, problems: [], error: null, wait: null });
    api(`infra/environments/${enc(id)}/editable`)
      .then((d) => {
        setEditable(d.editable?.kinds ?? {});
        setCreatable(d.editable?.creatable ?? {});
      })
      .catch(() => {
        setEditable({});
        setCreatable({});
      });
  }, [id]);

  // An environment with no file yet changes the board's draft of it (BRK-240); with nothing running, the draft is empty,
  // so there's nothing to propose until something is added.
  const fromDraft = Boolean(env) && !env.observeOnly && !desired && seen > 0;
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

  const latestChange = held?.open ?? held?.changes?.find((c) => c.state !== 'rejected' && recentChange(c)) ?? null;
  const planId = latestChange ? changePlanId(latestChange) : null;
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

  // Its card while it's the board's or just ended, then a line above the map until dismissed (WEB-110).
  const followed = plan && plan.id === planId ? plan : null;
  const where = latestChange
    ? changeShows(latestChange, { plan: followed, dismissed: dismissed === latestChange.n })
    : null;
  const starting = edits.length > 0 || Boolean(editing) || adding;

  const declared = desired?.desired?.resources ?? draft ?? [];
  const key = JSON.stringify(edits);
  latest.current = edits;

  // An edit kept in this browser that changes nothing now (the same bindings in another order, or the file moved to
  // it) leaves the change, with a line saying so (WEB-110).
  useEffect(() => {
    if (id == null || !editable || !edits.length) return;
    const labels = new Map(Object.entries(editable).map(([k, v]) => [k, v.fields ?? []]));
    const idle = idleEdits(edits, declared, labels);
    if (!idle.size) return;
    save(edits.filter((_, n) => !idle.has(n)));
    for (const line of idle.values()) toast(`Dropped from your change: ${line}.`, 'info');
  }, [id, key, editable, desired, draft]);

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
    creatable,
    editing,
    adding,
    preview,
    held: where === 'card' ? latestChange : null,
    /** The last change, folded to a line, until it's dismissed or a new change starts. */
    last: where === 'line' && !starting ? latestChange : null,
    plan: followed,
    /** Puts the folded line away for this change. */
    dismissLast() {
      if (!latestChange) return;
      writeDismissed(id, latestChange.n);
      setDismissed(latestChange.n);
    },
    current: preview.key === key && !preview.busy,
    /** Joins edits to the change; answers why not when they don't fit. */
    add(
      /** @type {import('../lib/infra-change.js').Edit[]} */ more,
      { replacing = /** @type {string | null} */ (null) } = {},
    ) {
      const base = replacing
        ? edits.filter((e) => !((e.op === 'set' || e.op === 'rename') && e.resource === replacing))
        : edits;
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
    /** Opens or closes the Add resource picker. */
    addResource: (/** @type {boolean} */ on) => {
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
    /**
     * The map's marks for the change: the board's plan of it once it matches, else what this browser knows; each add
     * is drawn with a line to what binds or serves it, among `resources` (what runs).
     * @param {Array<{ id: string, kind: string, name: string }>} [resources]
     */
    overlay(resources = []) {
      if (!edits.length) return null;
      const made = createOverlay(edits, resources, creatable ?? {});
      if (preview.key === key && preview.data?.preview) {
        const { ops, adds } = planOverlay(preview.data.preview.diff);
        return { ops, adds, relations: made.relations };
      }
      const ops = editMarks(edits);
      for (const a of made.adds) ops.set(a.id, { op: 'create', effect: /** @type {const} */ ('adds') });
      return { ops, adds: made.adds, relations: made.relations };
    },
  };
}

/** @typedef {ReturnType<typeof useChange>} Change */

/** Why the console can't change this environment, in a line, or null when it can. */
export function cantChange(/** @type {any} */ env) {
  if (env.observeOnly) return 'Observe only: the board watches it and never changes it.';
  if (!env.provider) return 'Pick its provider and connect it on Connections to change it here.';
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
      {(kind?.fields?.length > 0 || kind?.name) && !removing && (
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
  // Its name, where the provider lets the console change it (a route's pattern), with any rename this change has.
  const [name, setName] = useState(() => (d ? nameAfter(ch.edits, d) : ''));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const first = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  useEffect(() => {
    setForm(start());
    setName(d ? nameAfter(ch.edits, d) : '');
    setError(null);
    first.current?.focus({ preventScroll: true });
    first.current?.scrollIntoView({ block: 'nearest' });
  }, [ch.editing]);
  if (!d || !kind) return null;
  const problems = Object.fromEntries(fields.map((f) => [f.path, fieldProblem(f, form[f.path])]));
  const renaming = kind.name ? nameProblem(kind.name, name) : null;
  const wrong = Boolean(renaming) || Object.values(problems).some(Boolean);
  const done = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (wrong) {
      setError('Fix the fields marked first.');
      return;
    }
    const renamed = kind.name ? nameEdits(d, name) : [];
    const made = [...renamed, ...settingEdits(d, fields, form)];
    // A field you changed that ends as it is (the same bindings in another order) adds no edit: say so (WEB-110).
    const was = start();
    const idle = fields.filter(
      (f) =>
        JSON.stringify(form[f.path]) !== JSON.stringify(was[f.path]) &&
        !made.some((e) => e.op === 'set' && e.path === f.path),
    );
    const why = ch.add(made, { replacing: d.id });
    if (why) setError(why);
    else {
      const line = idle.length
        ? idleEdits(
            idle.map((f) => ({ op: 'set', resource: d.id, path: f.path, value: getPath(d.attrs, f.path) })),
            [d],
            new Map([[d.kind, fields]]),
          )
            .values()
            .next().value
        : null;
      if (line) toast(`${line}.`, 'info');
      ch.edit(null);
    }
  };
  return (
    <form class="change-form" onSubmit={done} noValidate aria-labelledby="change-form-title">
      <h3 id="change-form-title" class="change-form-title" tabIndex={-1} ref={first}>
        Change {d.name}
      </h3>
      <p class="meta">{d.kind}</p>
      {kind.name && (
        <FieldInput
          field={{ path: 'name', type: 'text', label: kind.name.label, help: kind.name.help }}
          id="change-name"
          value={name}
          resources={ch.declared}
          problem={renaming}
          onChange={setName}
        />
      )}
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

/** Opens New agent with `prompt` filled in. */
function startAgent(/** @type {any} */ env, /** @type {string} */ prompt) {
  writeDraft('agent', { fields: { prompt, repo: env.repo }, typed: true });
  newAgent.value = true;
}

/**
 * Add resource (WEB-107): every kind the provider can create, a line each on what it's for, then the repository's
 * templates and breakaway's. Picking one opens its form in the same place.
 * @param {{ ch: Change }} props
 */
function AddResource({ ch }) {
  const [choice, setChoice] = useState(/** @type {{ kind: string } | { template: any } | null} */ (null));
  const [list, setList] = useState(/** @type {{ templates: any[], folder: string } | null} */ (null));
  const [failed, setFailed] = useState(/** @type {string | null} */ (null));
  const title = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  useEffect(() => {
    api(`infra/environments/${enc(ch.env.id)}/templates`)
      .then(setList)
      .catch((err) => setFailed(err.message));
  }, [ch.env.id]);
  useEffect(() => {
    if (choice) return;
    title.current?.focus({ preventScroll: true });
    title.current?.scrollIntoView({ block: 'nearest' });
  }, [choice]);
  const back = () => setChoice(null);
  if (choice && 'kind' in choice && ch.creatable?.[choice.kind])
    return <CreateForm ch={ch} kindId={choice.kind} kind={ch.creatable[choice.kind]} onBack={back} />;
  if (choice && 'template' in choice) return <TemplateForm ch={ch} template={choice.template} onBack={back} />;
  const kinds = Object.entries(ch.creatable ?? {});
  const ours = (list?.templates ?? []).every((t) => t.from === 'breakaway');
  return (
    <section class="change-form" aria-labelledby="change-add-title">
      <h3 id="change-add-title" class="change-form-title" tabIndex={-1} ref={title}>
        Add a resource
      </h3>
      <p class="meta">
        It joins your change, and the plan shows what it makes. Nothing changes in {ch.env.name} until you propose it
        and approve the plan.
      </p>
      {ch.creatable === null ? (
        <p class="muted" aria-busy="true">
          Reading what {ch.env.name} can add…
        </p>
      ) : (
        kinds.length > 0 && (
          <ul class="change-kinds" aria-label="Kinds you can add">
            {kinds.map(([id, k]) => (
              <li key={id}>
                <button type="button" class="change-kind" onClick={() => setChoice({ kind: id })}>
                  <Plus size={14} aria-hidden="true" />
                  <span>
                    <strong>{k.label}</strong>
                    {k.needsCode && <span class="change-kind-tag">needs code</span>}
                    <span class="change-template-text">{k.help}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      <h4 class="kicker change-add-sub">From a template</h4>
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
          <ul class="change-kinds" aria-label="Templates">
            {list.templates.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  class={`change-kind ${t.error ? 'is-broken' : ''}`}
                  onClick={() => setChoice({ template: t })}
                  disabled={Boolean(t.error)}
                >
                  <FilePlus2 size={14} aria-hidden="true" />
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
                </button>
              </li>
            ))}
          </ul>
          {ours && (
            <span class="field-hint">
              Your own templates go in <code>{list.folder}/</code>, one folder each. Have an agent write one.
            </span>
          )}
        </>
      )}
      <div class="change-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => ch.addResource(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * A new resource of one kind: its name, checked as you type, its settings with the provider's defaults, and what binds
 * it, with a binding name suggested from its name. A kind made by code says what code must exist, and Have an agent
 * write it starts an agent on it.
 * @param {{ ch: Change, kindId: string, kind: import('../lib/infra-change.js').CreatableKind, onBack: () => void }} props
 */
function CreateForm({ ch, kindId, kind, onBack }) {
  // What this change already adds counts too: a route can name the Worker it adds, and a name can't repeat.
  const adds = ch.edits.flatMap((e) =>
    e.op === 'create' ? [{ id: '', kind: e.kind, name: e.name, attrs: e.attrs }] : [],
  );
  const resources = [...ch.declared, ...adds];
  const bind = kind.bind ?? null;
  const binders = bind ? resources.filter((r) => r.kind === bind.kind) : [];
  const binderLabel = bind ? (ch.creatable?.[bind.kind]?.label ?? bind.kind) : '';
  const [name, setName] = useState('');
  const [form, setForm] = useState(() => createForm(kind));
  const [worker, setWorker] = useState(() =>
    bind
      ? (binders.find((b) => b.name === ch.env.target)?.name ?? (bind.required ? (binders[0]?.name ?? '') : ''))
      : '',
  );
  const [binding, setBinding] = useState(/** @type {string | null} */ (null));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const first = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    first.current?.scrollIntoView({ block: 'nearest' });
  }, [kindId]);
  const bindingName = binding ?? bindingFor(name);
  const input = { name, form, bindTo: { worker, binding: bindingName } };
  const problems = createProblems(kindId, kind, input, { taken: resources, declared: resources });
  const wrong =
    Boolean(problems.name || problems.worker || problems.binding) || Object.values(problems.fields).some(Boolean);
  const filled = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '');
  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    setTried(true);
    if (wrong) {
      setError('Fix the fields marked first.');
      return;
    }
    const why = ch.add([createEdit(kindId, kind, input)]);
    if (why) setError(why);
    else ch.addResource(false);
  };
  const writeCode = () => {
    const edit = /** @type {any} */ (createEdit(kindId, kind, input));
    startAgent(ch.env, codePrompt(ch.env, kind, { ...edit, name: edit.name || `(name it)` }));
  };
  return (
    <form class="change-form" onSubmit={submit} noValidate aria-labelledby="change-create-title">
      <div class="change-rule-head">
        <h3 id="change-create-title" class="change-form-title" tabIndex={-1} ref={first}>
          {kind.label}
        </h3>
        <button type="button" class="btn btn-quiet btn-sm" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          Pick another
        </button>
      </div>
      <p class="meta">{kind.help}</p>
      <FieldInput
        field={{ path: 'name', type: 'text', label: kind.name.label, help: kind.name.help }}
        id="change-create-name"
        value={name}
        resources={resources}
        problem={tried || name.trim() ? problems.name : null}
        onChange={(v) => {
          setName(v);
          setError(null);
        }}
      />
      {kind.fields.map((f) => {
        const id = `change-create-${f.path.replaceAll('.', '-')}`;
        const props = {
          field: f,
          id,
          value: form[f.path],
          resources,
          problem: tried || filled(form[f.path]) ? problems.fields[f.path] : null,
          onChange: (/** @type {any} */ v) => {
            setForm((s) => ({ ...s, [f.path]: v }));
            setError(null);
          },
        };
        if (f.type === 'bindings') return <BindingsInput key={f.path} {...props} />;
        if (f.type === 'rules') return <RulesInput key={f.path} {...props} />;
        return <FieldInput key={f.path} {...props} />;
      })}
      {bind && (
        <fieldset class="field change-field change-group" aria-describedby="change-create-bind-help">
          <legend class="field-label">Bind it to</legend>
          <select
            id="change-create-worker"
            class="select input-sm"
            aria-label={`The ${binderLabel.toLowerCase()} that binds it`}
            value={worker}
            onChange={(e) => {
              setWorker(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
              setError(null);
            }}
            aria-invalid={tried && problems.worker ? 'true' : undefined}
          >
            <option value="">{bind.required ? 'Pick one' : 'Don’t bind it'}</option>
            {binders.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <span class="field-hint" id="change-create-bind-help">
            {binders.length === 0
              ? `${ch.env.name} has no ${binderLabel.toLowerCase()} in its file yet: add one first, or describe the one that runs as code.`
              : bind.required
                ? `It’s made only when a ${binderLabel.toLowerCase()} binds it: pick the one whose code uses it.`
                : `Optional: the ${binderLabel.toLowerCase()} whose code uses it.`}
          </span>
          {tried && problems.worker && <span class="field-error">{problems.worker}</span>}
          {worker && (
            <div class="field change-field">
              <label class="field-label" for="change-create-binding">
                Binding name
              </label>
              <input
                id="change-create-binding"
                class="input input-sm"
                value={bindingName}
                onInput={(e) => {
                  setBinding(/** @type {HTMLInputElement} */ (e.currentTarget).value);
                  setError(null);
                }}
                aria-describedby="change-create-binding-help"
                aria-invalid={problems.binding ? 'true' : undefined}
                spellcheck={false}
                autoCapitalize="characters"
              />
              <span class="field-hint" id="change-create-binding-help">
                What {worker}’s code calls it, like env.{bindingName || 'JOBS'}. Suggested from the name.
              </span>
              {(tried || binding !== null) && problems.binding && <span class="field-error">{problems.binding}</span>}
            </div>
          )}
        </fieldset>
      )}
      {kind.needsCode && (
        <div class="change-needs-code">
          <p>
            <strong>It needs code.</strong> {kind.needsCode}
          </p>
          <button type="button" class="btn btn-quiet btn-sm" onClick={writeCode}>
            <Bot size={14} aria-hidden="true" />
            Have an agent write it
          </button>
        </div>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="change-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => ch.addResource(false)}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm">
          <Plus size={14} aria-hidden="true" />
          Add to the change
        </button>
      </div>
    </form>
  );
}

/**
 * A template from the picker: the repository's golden path or the one breakaway ships, asking for its inputs.
 * @param {{ ch: Change, template: any, onBack: () => void }} props
 */
function TemplateForm({ ch, template, onBack }) {
  const [inputs, setInputs] = useState(
    () =>
      /** @type {Record<string, string>} */ (
        Object.fromEntries(
          Object.entries(template.inputs ?? {}).map(([k, v]) => [k, /** @type {any} */ (v).default ?? '']),
        )
      ),
  );
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const first = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    first.current?.scrollIntoView({ block: 'nearest' });
  }, [template.name]);
  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
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
    else ch.addResource(false);
  };
  return (
    <form class="change-form" onSubmit={submit} noValidate aria-labelledby="change-template-title">
      <div class="change-rule-head">
        <h3 id="change-template-title" class="change-form-title" tabIndex={-1} ref={first}>
          Add {template.title ?? template.name}
        </h3>
        <button type="button" class="btn btn-quiet btn-sm" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          Pick another
        </button>
      </div>
      <p class="meta">
        From a template, {template.from === 'breakaway' ? 'from breakaway' : `from ${repoName(ch.env.repo)}`}.
        {template.description ? ` ${template.description}` : ''}
      </p>
      {Object.entries(template.inputs ?? {}).map(([k, v]) => (
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
      {template.files?.length > 0 && (
        <p class="meta">
          It also adds {template.files.length === 1 ? 'a file' : `${template.files.length} files`} to the repository in
          the same pull request.
        </p>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="change-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => ch.addResource(false)}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm">
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
                          {s.label} {s.list ?? `${s.before ?? 'unset'} → ${s.after ?? 'unset'}`}
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
  startAgent(env, agentPrompt(env, lines));
}

/**
 * The change's card, once proposed: its state, its pull request, and the owner's buttons.
 * @param {{ ch: Change }} props
 */
function ChangeCard({ ch }) {
  const change = ch.held;
  const { env } = ch;
  if (!change) return null;
  const pull = change.pull
    ? (github.value.data?.open ?? []).find(
        (/** @type {any} */ p) => Number(p.number) === change.pull.number && (!p.repo || p.repo === change.repo),
      )
    : null;
  const card = cardState(change, { checks: pull?.checks?.state ?? null, plan: ch.plan });
  const word = STATE_WORDS[card.state] ?? card.state;
  const pullHref = change.pull
    ? hashFor({ view: 'github', task: null, pr: pullParam(change.pull.number, change.repo) })
    : null;

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
      {card.state === 'waiting' && plansNothing(change) && (
        <p class="meta">
          It describes {env.name} as it runs, so it plans nothing. Merge keeps it as code; nothing changes.
        </p>
      )}
      {card.state === 'waiting' && !plansNothing(change) && (
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
      {card.state === 'merged' && (
        <p class="meta">
          Merged: the board compares it with what runs at its next check, and says here what it became.
        </p>
      )}
      {card.state === 'nothing' && (
        <p class="meta">
          {change.outcome?.why
            ? `${sentence(change.outcome.why)}, so nothing changes.`
            : `What runs already matches ${change.pull ? `#${change.pull.number}` : 'it'}, so nothing changes.`}
        </p>
      )}
      {card.state === 'waiting' && change.state === 'merged' && !change.outcome?.plan && change.outcome?.why && (
        <p class="meta">{sentence(change.outcome.why)}.</p>
      )}
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
          {ch.plan.state === 'waiting'
            ? change.approval?.settled === 'waits'
              ? ' waits for you: the plan changed between your approval and the merge.'
              : ' waits for you: approve or reject it on its page.'
            : (PLAN_LINE[/** @type {keyof typeof PLAN_LINE} */ (ch.plan.state)] ?? '')}
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
      <ChangeActions change={change} env={env} card={card} onChanged={(c) => ch.changed(c)} />
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
  const names = new Map(Object.entries(ch.editable ?? {}).flatMap(([k, v]) => (v.name ? [[k, v.name]] : [])));
  const local = editLines(edits, ch.declared, labels, names);
  const p = ch.preview;
  // Propose waits for an edit that changes something: the board drops the rest, with a line saying why (WEB-110).
  const droppedByBoard = new Set((ch.current ? (p.data?.dropped ?? []) : []).map((/** @type {any} */ d) => d.edit));
  const changing = edits.filter((_, n) => !droppedByBoard.has(n)).length;
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
      {ch.adding && <AddResource ch={ch} />}

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
                  <NeedsCode ch={ch} edit={edits[n]} />
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
              disabled={busy || !fresh || p.problems.length > 0 || Boolean(p.error) || (!changing && !ch.fromDraft)}
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
 * Under an add of a kind made by code: what code must exist before its plan applies, and an agent to write it.
 * @param {{ ch: Change, edit: import('../lib/infra-change.js').Edit }} props
 */
function NeedsCode({ ch, edit }) {
  if (edit.op !== 'create') return null;
  const kind = ch.creatable?.[edit.kind];
  if (!kind?.needsCode) return null;
  return (
    <span class="change-line-code">
      Needs code: {kind.needsCode}{' '}
      <button
        type="button"
        class="btn btn-quiet btn-sm"
        onClick={() => startAgent(ch.env, codePrompt(ch.env, kind, edit))}
      >
        <Bot size={14} aria-hidden="true" />
        Have an agent write it
      </button>
    </span>
  );
}

/**
 * The last change, once its card folds (WEB-110): one line above the map, "Last change: #253 applied, 51 min ago",
 * with its plan or pull request, until the owner dismisses it or starts a new change.
 * @param {{ ch: Change }} props
 */
export function LastChange({ ch }) {
  const change = ch.last;
  if (!change) return null;
  const card = cardState(change, { plan: ch.plan });
  const when = change.outcome?.at ?? change.updated;
  const href = ch.plan
    ? hashFor({ view: 'infrastructure', environment: String(ch.env.id), plan: ch.plan.id, task: null })
    : change.pull
      ? hashFor({ view: 'github', task: null, pr: pullParam(change.pull.number, change.repo) })
      : null;
  return (
    <p class="change-last" role="status">
      <span class="change-last-text">
        Last change: {href ? <a href={href}>{endedWords(change, card)}</a> : endedWords(change, card)},{' '}
        <time dateTime={when} title={new Date(when).toLocaleString()}>
          {ago(when)}
        </time>
      </span>
      <button
        type="button"
        class="btn btn-quiet btn-icon btn-sm"
        onClick={() => ch.dismissLast()}
        aria-label="Dismiss the last change"
        title="Dismiss"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </p>
  );
}

/**
 * Add resource, on the resources panel's header, and as the call to action of an environment with nothing in it.
 * @param {{ ch: Change }} props
 */
export function AddResourceButton({ ch }) {
  return (
    <button
      type="button"
      class="btn btn-outline btn-sm"
      onClick={() => ch.addResource(!ch.adding)}
      aria-pressed={ch.adding}
    >
      <Plus size={14} aria-hidden="true" />
      Add resource
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
