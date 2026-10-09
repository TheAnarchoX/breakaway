// A change from the environment console (WEB-99; docs/specs/BRK-258-plan-from-the-board.md): the owner's edits to one
// environment's desired state, kept in this browser until they're proposed, as operations (set a setting, add from a
// template or of a kind the provider can create (WEB-107), remove a resource), never as a copy of the file. The board replays them onto the file at the default
// branch's head (BRK-259). This file keeps them, merges a new edit into the ones before it, words them at once (the
// board's own preview follows), turns the settings form's values into edits, checks a field the way the provider
// declares it (BRK-262), and says what the change's card shows. Pure, so the tests can check it.

import { bindingLabels, sameSetting, sameWords, settingWords, valueWords } from '../../../src/infra-setting-words.js';

/** At most this many edits in one change (BRK-259's CHANGE_MAX_EDITS). */
export const CHANGE_MAX_EDITS = 50;
/** The console asks the board for a preview this long after the last edit. */
export const PREVIEW_DELAY_MS = 1_500;

const KEY = 'breakaway.change.';

const isObject = (/** @type {unknown} */ v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** The storage a change lives in, or null when the browser blocks it (then a change lasts until the page closes). */
const local = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * One edit, as BRK-259 takes it.
 * @typedef {{ op: 'set', resource: string, path: string, value: unknown }
 *   | { op: 'add', template: string, inputs: Record<string, string> }
 *   | { op: 'remove', resource: string }
 *   | { op: 'rename', resource: string, name: string }
 *   | { op: 'create', kind: string, name: string, attrs: Record<string, unknown>,
 *       bindTo?: { worker: string, binding: string } }} Edit
 */

/**
 * The edits kept for environment `envId`, or none.
 * @param {string | number} envId
 * @returns {Edit[]}
 */
export function readEdits(envId, storage = local()) {
  try {
    const edits = JSON.parse(storage?.getItem(KEY + envId) ?? '[]');
    return Array.isArray(edits)
      ? edits.filter((e) => isObject(e) && ['set', 'add', 'create', 'remove', 'rename'].includes(e.op))
      : [];
  } catch {
    return [];
  }
}

/**
 * Keeps environment `envId`'s edits, or forgets them when there are none.
 * @param {string | number} envId
 * @param {Edit[]} edits
 */
export function writeEdits(envId, edits, storage = local()) {
  try {
    if (edits.length) storage?.setItem(KEY + envId, JSON.stringify(edits));
    else storage?.removeItem(KEY + envId);
  } catch {
    /* storage full or blocked: the change lasts until the page closes */
  }
}

/**
 * The change with `more` joined to it: a setting set again replaces the earlier edit of the same setting, a resource
 * renamed again replaces its earlier rename, a resource added again under the same kind and name replaces its earlier
 * add, and removing a resource drops the edits that set its settings or rename it. Answers the edits, or why they don't
 * fit.
 * @param {Edit[]} edits
 * @param {Edit[]} more
 * @returns {{ edits: Edit[] } | { error: string }}
 */
export function joinEdits(edits, more) {
  let out = [...edits];
  for (const e of more) {
    if (e.op === 'set') out = out.filter((x) => !(x.op === 'set' && x.resource === e.resource && x.path === e.path));
    else if (e.op === 'rename') out = out.filter((x) => !(x.op === 'rename' && x.resource === e.resource));
    else if (e.op === 'create') out = out.filter((x) => !(x.op === 'create' && x.kind === e.kind && x.name === e.name));
    else if (e.op === 'remove') {
      if (out.some((x) => x.op === 'remove' && x.resource === e.resource)) continue;
      out = out.filter((x) => !((x.op === 'set' || x.op === 'rename') && x.resource === e.resource));
    }
    out.push(e);
  }
  if (out.length > CHANGE_MAX_EDITS)
    return { error: `A change holds at most ${CHANGE_MAX_EDITS} edits: propose this one, then change more.` };
  return { edits: out };
}

/**
 * The value at a dotted path inside an object, or undefined.
 * @param {unknown} obj
 * @param {string} path
 */
export function getPath(obj, path) {
  let at = obj;
  for (const p of path.split('.')) {
    if (!isObject(at) || !Object.hasOwn(/** @type {object} */ (at), p)) return undefined;
    at = /** @type {Record<string, unknown>} */ (at)[p];
  }
  return at;
}

/**
 * A copy of `obj` with the value at a dotted path set, or removed when it's null or undefined; objects on the way are
 * made.
 * @param {Record<string, any>} obj
 * @param {string} path
 * @param {unknown} value
 */
export function setPath(obj, path, value) {
  const out = structuredClone(obj ?? {});
  const parts = path.split('.');
  let at = out;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(at[p])) at[p] = {};
    at = at[p];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete at[last];
  else at[last] = value;
  return out;
}

/** Whether two settings are the same, whatever the order of an object's keys. */
export function sameValue(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  const norm = (/** @type {unknown} */ v) =>
    v === undefined
      ? null
      : Array.isArray(v)
        ? v.map(norm)
        : isObject(v)
          ? Object.fromEntries(
              Object.entries(/** @type {object} */ (v))
                .sort(([x], [y]) => x.localeCompare(y))
                .map(([k, x]) => [k, norm(x)]),
            )
          : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * One setting the console may change, as the provider declares it (BRK-262; EditableField in src/infra-provider.js).
 * @typedef {{ path: string, label: string, type: string, help: string, optional?: boolean, min?: number, max?: number,
 *   integer?: boolean, unit?: string, pattern?: string, options?: { value: string, label: string }[], kinds?: string[],
 *   targets?: { type: string, label: string, kind: string, field: string, by: 'id' | 'name' }[],
 *   fields?: EditableField[], template?: Record<string, unknown>, deploy?: string }} EditableField
 */

/**
 * A field's value as the form starts it from the resource's settings: names as lines, a number as text.
 * @param {EditableField} field
 * @param {unknown} value
 */
export function formValue(field, value) {
  if (field.type === 'names') return Array.isArray(value) ? value.map(String).join('\n') : '';
  if (field.type === 'number') return typeof value === 'number' ? String(value) : '';
  if (field.type === 'yesno') return isObject(value) ? Boolean(/** @type {any} */ (value).enabled) : Boolean(value);
  if (field.type === 'text' || field.type === 'choice' || field.type === 'resource')
    return typeof value === 'string' ? value : '';
  if (field.type === 'bindings' || field.type === 'rules')
    return Array.isArray(value)
      ? value.map((item) =>
          field.type === 'rules' && isObject(item)
            ? ruleForm(/** @type {EditableField[]} */ (field.fields ?? []), item)
            : structuredClone(item),
        )
      : [];
  return value;
}

/** A rule's fields as the form edits them, every other key kept. */
function ruleForm(/** @type {EditableField[]} */ fields, /** @type {Record<string, any>} */ rule) {
  let out = structuredClone(rule);
  for (const f of fields) out = setPath(out, f.path, formValue(f, getPath(rule, f.path)));
  return out;
}

/**
 * What's wrong with a field's value in the form, in words, or null.
 * @param {EditableField} field
 * @param {unknown} raw the form's value (formValue's shape)
 * @returns {string | null}
 */
export function fieldProblem(field, raw) {
  const pattern = field.pattern ? new RegExp(field.pattern, 'u') : null;
  if (field.type === 'number') {
    const text = String(raw ?? '').trim();
    if (!text) return field.optional ? null : `${field.label} needs a number.`;
    const n = Number(text);
    if (!Number.isFinite(n)) return `${field.label} is a number.`;
    if (field.integer && !Number.isInteger(n)) return `${field.label} is a whole number.`;
    if (field.min !== undefined && n < field.min) return `${field.label} is at least ${field.min}.`;
    if (field.max !== undefined && n > field.max) return `${field.label} is at most ${field.max}.`;
    return null;
  }
  if (field.type === 'text' || field.type === 'resource' || field.type === 'choice') {
    const text = String(raw ?? '').trim();
    if (!text) return field.optional || field.type === 'text' ? null : `Pick a ${field.label.toLowerCase()}.`;
    if (field.type === 'choice' && field.options && !field.options.some((o) => o.value === text))
      return `${field.label} is one of ${field.options.map((o) => o.label).join(', ')}.`;
    return pattern && !pattern.test(text) ? `${field.label} doesn’t look right: ${field.help}` : null;
  }
  if (field.type === 'names') {
    const bad = names(raw).find((n) => pattern && !pattern.test(n));
    return bad ? `${bad} doesn’t fit ${field.label.toLowerCase()}: ${field.help}` : null;
  }
  if (field.type === 'bindings') {
    const list = Array.isArray(raw) ? raw : [];
    const types = new Set((field.targets ?? []).map((t) => t.type));
    const seen = new Set();
    for (const b of list) {
      if (!isObject(b)) continue;
      const name = String(b.name ?? '').trim();
      if (!name) return 'Every binding needs a name its code uses.';
      if (seen.has(name)) return `Two bindings are called ${name}: give each its own name.`;
      seen.add(name);
      const target = (field.targets ?? []).find((t) => t.type === b.type);
      // A binding that gives no target keeps what it binds now (BRK-285); one with an empty one needs a pick.
      const picked = String(b[target?.field ?? ''] ?? '').trim() || String(b.resource ?? '').trim();
      const kept = target && b.resource === undefined && b[target.field] === undefined;
      if (types.has(b.type) && target && !picked && !kept)
        return `Pick the ${target.label.toLowerCase()} ${name} binds.`;
    }
    return null;
  }
  if (field.type === 'rules') {
    for (const rule of Array.isArray(raw) ? raw : [])
      for (const f of field.fields ?? []) {
        const problem = fieldProblem(f, getPath(rule, f.path));
        if (problem) return problem;
      }
    return null;
  }
  return null;
}

/** The lines of a names field, trimmed, without the empty ones. */
const names = (/** @type {unknown} */ raw) =>
  String(raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A field's value as the desired state keeps it, from the form's: null where it's left unset.
 * @param {EditableField} field
 * @param {unknown} raw
 * @param {unknown} [before] the value the resource has now, so a yes or no kept as `{ enabled }` stays that shape
 */
export function settingValue(field, raw, before = undefined) {
  if (field.type === 'number') {
    const text = String(raw ?? '').trim();
    return text ? Number(text) : null;
  }
  if (field.type === 'names') return names(raw);
  if (field.type === 'yesno')
    return isObject(before) ? { .../** @type {object} */ (before), enabled: Boolean(raw) } : Boolean(raw);
  if (field.type === 'text' || field.type === 'choice' || field.type === 'resource') {
    const text = String(raw ?? '').trim();
    return text ? text : field.optional || field.type !== 'text' ? null : '';
  }
  if (field.type === 'bindings')
    return (Array.isArray(raw) ? raw : []).map((b) => (isObject(b) ? { ...b, name: String(b.name ?? '').trim() } : b));
  if (field.type === 'rules')
    return (Array.isArray(raw) ? raw : []).map((rule) => {
      let out = structuredClone(rule);
      for (const f of field.fields ?? []) out = setPath(out, f.path, settingValue(f, getPath(rule, f.path), undefined));
      return out;
    });
  return raw;
}

/**
 * The set edits a resource's settings form makes: one for each field whose value differs from the resource's.
 * @param {{ id: string, attrs?: Record<string, unknown> }} resource as the desired state has it
 * @param {EditableField[]} fields
 * @param {Record<string, unknown>} form the form's values, by path
 * @returns {Edit[]}
 */
export function settingEdits(resource, fields, form) {
  /** @type {Edit[]} */
  const out = [];
  for (const f of fields) {
    if (!Object.hasOwn(form, f.path)) continue;
    const before = getPath(resource.attrs, f.path);
    const value = settingValue(f, form[f.path], before);
    // The same value, or the same bindings in another order, changes nothing (WEB-110).
    if (sameSetting(before ?? null, value)) continue;
    // An empty list where nothing was set changes nothing either.
    if (before === undefined && Array.isArray(value) && !value.length) continue;
    out.push({ op: 'set', resource: resource.id, path: f.path, value });
  }
  return out;
}

/**
 * A resource's name as the provider lets the console change it (BRK-262's `name`: a route's pattern).
 * @typedef {{ label: string, help: string, pattern?: string }} EditableName
 */

/**
 * What's wrong with a new name in the form, in words, or null.
 * @param {EditableName} name
 * @param {unknown} raw
 * @returns {string | null}
 */
export function nameProblem(name, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return `${name.label} needs a value.`;
  return name.pattern && !new RegExp(name.pattern, 'u').test(text)
    ? `${name.label} doesn’t look right: ${name.help}`
    : null;
}

/**
 * The rename the form makes, or none when the name stays the resource's.
 * @param {{ id: string, name: string }} resource as the desired state has it
 * @param {unknown} raw the form's name
 * @returns {Edit[]}
 */
export function nameEdits(resource, raw) {
  const name = String(raw ?? '').trim();
  return name && name !== resource.name ? [{ op: 'rename', resource: resource.id, name }] : [];
}

/**
 * The name a resource has with this change's edits on it.
 * @param {Edit[]} edits
 * @param {{ id: string, name: string }} resource
 */
export const nameAfter = (edits, resource) =>
  edits.reduce((name, e) => (e.op === 'rename' && e.resource === resource.id ? e.name : name), resource.name);

/**
 * The change as words, an edit a line, from what this browser knows: the board's preview says it again from the file.
 * @param {Edit[]} edits
 * @param {{ id: string, name: string, kind: string, attrs?: Record<string, unknown> }[]} resources the desired state's
 * @param {Map<string, EditableField[]>} [labels] each kind's fields, for the settings' names
 * @param {Map<string, EditableName>} [names] each kind's name, where the console may change it
 * @returns {string[]}
 */
export function editLines(edits, resources, labels = new Map(), names = new Map()) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  return edits.map((e) => {
    if (e.op === 'add') {
      const name = e.inputs?.name ?? Object.values(e.inputs ?? {})[0];
      return `+ ${e.template}${name ? ` ${name}` : ''} (from a template)`;
    }
    if (e.op === 'create')
      return `+ ${e.kind} ${e.name}${e.bindTo ? `, bound to ${e.bindTo.worker} as ${e.bindTo.binding}` : ''}`;
    const r = byId.get(e.resource);
    const name = r?.name ?? e.resource;
    if (e.op === 'remove') return `− ${r?.kind ?? 'resource'} ${name}`;
    if (e.op === 'rename')
      return `~ ${r?.kind ?? 'resource'} ${name}: ${(r && names.get(r.kind)?.label.toLowerCase()) ?? 'name'} → ${e.name}`;
    const field = r ? labels.get(r.kind)?.find((f) => f.path === e.path) : null;
    const label = field?.label.toLowerCase() ?? e.path;
    const before = getPath(r?.attrs, e.path);
    // In words, never JSON: bindings one at a time ('+ CHAT (Durable Object)'), a setting as 'standard → bundled'.
    const words = settingWords({ label, before: before ?? null, after: e.value ?? null, labels: bindingLabels(field) });
    return `~ ${name}: ${words ?? `${label} as it is`}`;
  });
}

/**
 * What the next deploy does to an edit, in a line, or null when it leaves it alone (BRK-313): a setting the provider
 * marks as the deploy's too (`deploy`, where the deploy reads it, like a Worker's wrangler config), on a Worker the
 * repository's deploy flow deploys, goes back at the next deploy unless that config says it too; and so does a binding
 * a new resource gives such a Worker. docs/specs/BRK-258's console never names a vendor: the words come from the field.
 * @param {Edit} edit
 * @param {{ declared: { id: string, name: string, kind: string }[], editable: Record<string, { fields?: EditableField[] }> | null,
 *   workers: string[] }} at the desired state's resources, each kind's fields, and the Workers the deploy flow deploys
 * @returns {string | null}
 */
export function deployLine(edit, { declared, editable, workers }) {
  const fieldsOf = (/** @type {string} */ kind) => editable?.[kind]?.fields ?? [];
  if (edit.op === 'set') {
    const r = declared.find((d) => d.id === edit.resource);
    if (!r || !workers.includes(r.name)) return null;
    const field = fieldsOf(r.kind).find((f) => f.path === edit.path);
    if (!field?.deploy) return null;
    return `The next deploy sets ${r.name}’s ${field.label.toLowerCase()} from ${field.deploy}: change it there too, or the deploy puts it back.`;
  }
  if (edit.op === 'create' && edit.bindTo && workers.includes(edit.bindTo.worker)) {
    const w = declared.find(
      (d) => d.name === edit.bindTo?.worker && fieldsOf(d.kind).some((f) => f.type === 'bindings'),
    );
    const field = w ? fieldsOf(w.kind).find((f) => f.type === 'bindings') : null;
    if (!field?.deploy) return null;
    return `The next deploy sets ${edit.bindTo.worker}’s ${field.label.toLowerCase()} from ${field.deploy}: once this plan applies, add ${edit.bindTo.binding} there too, or the deploy takes it off.`;
  }
  return null;
}

/**
 * The edits that change nothing, by their index, each with a line saying why: a setting set to what it already is,
 * like the same bindings in another order (WEB-110). The board drops them too.
 * @param {Edit[]} edits
 * @param {{ id: string, name: string, kind: string, attrs?: Record<string, unknown> }[]} resources the desired state's
 * @param {Map<string, EditableField[]>} [labels]
 * @returns {Map<number, string>}
 */
export function idleEdits(edits, resources, labels = new Map()) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const out = new Map();
  for (const [n, e] of edits.entries()) {
    if (e.op !== 'set') continue;
    const r = byId.get(e.resource);
    if (!r) continue;
    const before = getPath(r.attrs, e.path);
    if (!sameSetting(before ?? null, e.value ?? null)) continue;
    const field = labels.get(r.kind)?.find((f) => f.path === e.path);
    out.set(n, `${sameWords(r.name, field?.label.toLowerCase() ?? e.path, before)}, so it changes nothing`);
  }
  return out;
}

/**
 * What the change does to each resource the console knows of before the board answers: changes or removes it.
 * @param {Edit[]} edits
 * @returns {Map<string, { op: string, effect: 'adds' | 'changes' | 'removes' }>}
 */
export function editMarks(edits) {
  const out = new Map();
  for (const e of edits) {
    if (e.op === 'remove') out.set(e.resource, { op: 'delete', effect: /** @type {const} */ ('removes') });
    else if ((e.op === 'set' || e.op === 'rename') && !out.has(e.resource))
      out.set(e.resource, { op: 'update', effect: /** @type {const} */ ('changes') });
  }
  return out;
}

/**
 * A kind the console may add (BRK-270's CreatableKind, from the editable route's `creatable`): its fields are the kind's
 * own create-only ones first, then its editable ones, each `required` or carrying its `default`.
 * @typedef {{ label: string, help: string, name: { label: string, help: string, pattern?: string, max?: number },
 *   fields: Array<EditableField & { required?: boolean, default?: unknown }>,
 *   bind?: { kind: string, list: string, target: { type: string, label: string, kind: string, field: string,
 *     by: 'id' | 'name' }, required?: boolean }, needsCode?: string }} CreatableKind
 */

/** What a binding is called in its Worker's code: upper snake case, like JOBS (BRK-270's BINDING_NAME). */
export const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,62}$/u;

/**
 * The binding name the form suggests for a new resource: its name in capitals, with underscores, like ACME_JOBS for
 * acme-jobs; empty for a name with no letters or digits.
 * @param {string} name
 */
export function bindingFor(name) {
  const s = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (!s) return '';
  return (/^[A-Z]/u.test(s) ? s : `R_${s}`).slice(0, 63).replace(/_+$/u, '');
}

/**
 * The form a new resource of `kind` starts from: each field's default, as the form shows it.
 * @param {CreatableKind} kind
 * @returns {Record<string, unknown>}
 */
export function createForm(kind) {
  return Object.fromEntries(kind.fields.map((f) => [f.path, formValue(f, structuredClone(f.default))]));
}

/**
 * What's wrong with a new resource in the form, in words, by where it shows: its name, each field, and its binding.
 * The board checks it again, with what runs in the account.
 * @param {string} kindId
 * @param {CreatableKind} kind
 * @param {{ name: string, form: Record<string, unknown>, bindTo: { worker: string, binding: string } }} input
 * @param {{ taken: Array<{ kind: string, name: string }>, declared: Array<{ kind: string, name: string,
 *   attrs?: Record<string, unknown> }> }} where what the environment has (its file and what runs, and this change's
 *   adds), and the file's resources, for the binder's bindings
 * @returns {{ name: string | null, fields: Record<string, string | null>, worker: string | null,
 *   binding: string | null }}
 */
export function createProblems(kindId, kind, { name, form, bindTo }, { taken, declared }) {
  const text = String(name ?? '').trim();
  let named = nameProblem(kind.name, text);
  if (!named && kind.name.max !== undefined && text.length > kind.name.max)
    named = `${kind.name.label} is at most ${kind.name.max} characters.`;
  if (!named && taken.some((r) => r.kind === kindId && r.name === text))
    named = `${text} is taken by another ${kind.label} here: pick another ${kind.name.label.toLowerCase()}.`;
  /** @type {Record<string, string | null>} */
  const fields = {};
  for (const f of kind.fields) {
    const value = settingValue(f, form[f.path]);
    fields[f.path] =
      f.required && (value === null || value === '') ? `${f.label} needs a value.` : fieldProblem(f, form[f.path]);
  }
  let worker = null;
  let binding = null;
  if (kind.bind) {
    const by = String(bindTo.worker ?? '').trim();
    if (!by) {
      if (kind.bind.required) worker = 'Pick what binds it: it’s made only when something does.';
    } else {
      const b = String(bindTo.binding ?? '').trim();
      const binder = declared.find((r) => r.kind === kind.bind?.kind && r.name === by);
      const list = binder ? getPath(binder.attrs, kind.bind.list) : undefined;
      if (!b) binding = 'Give the binding the name its code uses.';
      else if (!BINDING_NAME.test(b))
        binding = 'Capital letters, digits, and underscores, starting with a letter, like JOBS.';
      else if (Array.isArray(list) && list.some((x) => isObject(x) && x.name === b))
        binding = `${by} already has a binding called ${b}: pick another name.`;
    }
  }
  return { name: named, fields, worker, binding };
}

/**
 * The create edit a new resource's form makes: its name, the settings given (the kind's defaults fill the rest on the
 * board), and its binding when one is picked.
 * @param {string} kindId
 * @param {CreatableKind} kind
 * @param {{ name: string, form: Record<string, unknown>, bindTo: { worker: string, binding: string } }} input
 * @returns {Edit}
 */
export function createEdit(kindId, kind, { name, form, bindTo }) {
  /** @type {Record<string, unknown>} */
  const attrs = {};
  for (const f of kind.fields) {
    const value = settingValue(f, form[f.path]);
    if (value === null || value === '') continue;
    if (Array.isArray(value) && !value.length && f.default === undefined) continue;
    attrs[f.path] = value;
  }
  /** @type {Edit} */
  const edit = { op: 'create', kind: kindId, name: String(name).trim(), attrs };
  const worker = String(bindTo.worker ?? '').trim();
  if (kind.bind && worker) edit.bindTo = { worker, binding: String(bindTo.binding ?? '').trim() };
  return edit;
}

/** A resource this change adds, by the ID the board gives it in the file and on the map (`<kind>:<name>`). */
export const createId = (/** @type {{ kind: string, name: string }} */ e) => `${e.kind}:${e.name}`;

/**
 * The resources this change adds, as the file will have them, so a form can pick or bind one like any other.
 * @param {Edit[]} edits
 * @returns {Array<{ id: string, kind: string, name: string, attrs: Record<string, unknown>, planned: true }>}
 */
export const pendingCreates = (edits) =>
  edits.flatMap((e) =>
    e.op === 'create'
      ? [{ id: createId(e), kind: e.kind, name: e.name, attrs: e.attrs, planned: /** @type {const} */ (true) }]
      : [],
  );

/**
 * Where the create edit behind a node the map draws dashed is in the change, or -1 (a template's add has none).
 * @param {Edit[]} edits
 * @param {{ kind: string, name: string }} r
 */
export const createAt = (edits, r) =>
  edits.findIndex((e) => e.op === 'create' && e.kind === r.kind && e.name === r.name);

/**
 * The form a create edit opens in when it's changed (WEB-119): its name, its settings (the kind's default for any it
 * doesn't give), and what binds it.
 * @param {CreatableKind} kind
 * @param {Extract<Edit, { op: 'create' }>} edit
 * @returns {{ name: string, form: Record<string, unknown>, worker: string, binding: string | null }}
 */
export function createStart(kind, edit) {
  const form = Object.fromEntries(
    kind.fields.map((f) => [
      f.path,
      formValue(f, structuredClone(Object.hasOwn(edit.attrs ?? {}, f.path) ? edit.attrs[f.path] : f.default)),
    ]),
  );
  return { name: edit.name, form, worker: edit.bindTo?.worker ?? '', binding: edit.bindTo?.binding ?? null };
}

/** Whether the bindings list `path` of a resource of `kind` is where a create of this kind's binding goes. */
const bindsInto = (/** @type {CreatableKind['bind']} */ bind, /** @type {string} */ kind, /** @type {string} */ path) =>
  Boolean(bind && bind.kind === kind && bind.list === path);

/** The binding a create's bindTo makes on its binder, as the board writes it (applyCreate in src/infra-changes.js). */
const bindingRow = (/** @type {NonNullable<CreatableKind['bind']>} */ bind, /** @type {any} */ e) => ({
  name: e.bindTo.binding,
  type: bind.target.type,
  ...(bind.target.by === 'id' ? { resource: createId(e) } : { [bind.target.field]: e.name }),
});

/**
 * The bindings this change's adds give `binder` with their bindTo, as rows of its bindings field `path`, so its form
 * shows them like the ones it has (WEB-119).
 * @param {Edit[]} edits
 * @param {Record<string, CreatableKind>} creatable
 * @param {{ kind: string, name: string }} binder
 * @param {string} path
 */
export function boundRows(edits, creatable, binder, path) {
  return edits.flatMap((e) => {
    if (e.op !== 'create' || e.bindTo?.worker !== binder.name) return [];
    const bind = creatable[e.kind]?.bind;
    return bind && bindsInto(bind, binder.kind, path) ? [bindingRow(bind, e)] : [];
  });
}

/**
 * A binder's bindings field as its form leaves it, split (WEB-119): a row that binds one of this change's adds, which
 * nothing else binds yet, becomes that add's bindTo; the other rows stay the field's. An add bound to the binder
 * before (by its name `was`, when it's renamed) whose row is gone isn't bound any more.
 * @param {Edit[]} edits
 * @param {Record<string, CreatableKind>} creatable
 * @param {{ kind: string, name: string, was?: string }} binder
 * @param {string} path
 * @param {unknown} rows the field's value, as the form has it
 * @returns {{ edits: Edit[], rows: unknown[] }}
 */
export function rebind(edits, creatable, binder, path, rows) {
  const was = binder.was ?? binder.name;
  /** @type {Map<number, string>} */
  const bound = new Map();
  const kept = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const n = !isObject(row)
      ? -1
      : edits.findIndex((e, i) => {
          if (e.op !== 'create' || bound.has(i)) return false;
          const bind = creatable[e.kind]?.bind;
          if (!bind || !bindsInto(bind, binder.kind, path) || row.type !== bind.target.type) return false;
          if (e.bindTo && e.bindTo.worker !== was) return false;
          return bind.target.by === 'id'
            ? row.resource === createId(e)
            : row.resource === undefined && row[bind.target.field] === e.name;
        });
    if (n === -1) kept.push(row);
    else bound.set(n, String(/** @type {any} */ (row).name ?? '').trim());
  }
  const out = edits.map((e, i) => {
    if (e.op !== 'create') return e;
    const binding = bound.get(i);
    if (binding !== undefined) return { ...e, bindTo: { worker: binder.name, binding } };
    if (e.bindTo?.worker === was && bindsInto(creatable[e.kind]?.bind, binder.kind, path)) {
      const { bindTo: _, ...rest } = e;
      return rest;
    }
    return e;
  });
  return { edits: out, rows: kept };
}

/**
 * The change with the create at `n` replaced by `edit` (WEB-119): where it was renamed, the adds that name it (what
 * binds them, a route's Worker) follow the new name.
 * @param {Edit[]} edits
 * @param {number} n
 * @param {Extract<Edit, { op: 'create' }>} edit
 * @param {Record<string, CreatableKind>} creatable
 * @returns {{ edits: Edit[] } | { error: string }}
 */
export function replaceCreate(edits, n, edit, creatable) {
  const was = edits[n];
  if (was?.op !== 'create') return { error: 'That resource isn’t in your change any more.' };
  if (edits.some((e, i) => i !== n && e.op === 'create' && e.kind === edit.kind && e.name === edit.name))
    return { error: `Your change already adds a ${edit.kind} called ${edit.name}: pick another name.` };
  let out = edits.map((e, i) => (i === n ? edit : e));
  if (was.name !== edit.name)
    out = out.map((e, i) => {
      if (i === n || e.op !== 'create') return e;
      const kind = creatable[e.kind];
      let next = e;
      if (e.bindTo?.worker === was.name && kind?.bind?.kind === was.kind)
        next = { ...next, bindTo: { ...e.bindTo, worker: edit.name } };
      for (const f of kind?.fields ?? [])
        if (f.type === 'resource' && (f.kinds ?? []).includes(was.kind) && next.attrs?.[f.path] === was.name)
          next = { ...next, attrs: { ...next.attrs, [f.path]: edit.name } };
      return next;
    });
  return { edits: orderCreates(out, creatable) };
}

/**
 * The change with each add bound to another add after it: the board makes them in order, and a binding needs its
 * binder made first.
 * @param {Edit[]} edits
 * @param {Record<string, CreatableKind>} creatable
 * @returns {Edit[]}
 */
export function orderCreates(edits, creatable) {
  const out = [...edits];
  const binderAt = (/** @type {Edit} */ e) =>
    e.op === 'create' && e.bindTo
      ? out.findIndex(
          (x) => x.op === 'create' && x.kind === creatable[e.kind]?.bind?.kind && x.name === e.bindTo?.worker,
        )
      : -1;
  for (let guard = 0; guard < out.length; guard++) {
    const i = out.findIndex((e, at) => binderAt(e) > at);
    if (i === -1) break;
    const [e] = out.splice(i, 1);
    out.splice(binderAt(e) + 1, 0, e);
  }
  return out;
}

/** The kinds the map puts in front: what a Worker serves, not what it uses. */
const SERVED = new Set(['route', 'custom-domain', 'domain']);

/**
 * What the change's adds put on the map before the board answers: a dashed node for each, by the ID the board gives it
 * (`<kind>:<name>`), and a line to what binds or runs it, from the resources the map draws.
 * @param {Edit[]} edits
 * @param {Array<{ id: string, kind: string, name: string }>} resources what runs, by the map's IDs
 * @param {Record<string, CreatableKind>} [creatable] for what binds each kind
 * @returns {{ adds: any[], relations: Array<{ from: string, to: string, kind: string }> }}
 */
export function createOverlay(edits, resources, creatable = {}) {
  const adds = [];
  const relations = [];
  const all = [...resources];
  for (const e of edits) {
    if (e.op !== 'create') continue;
    const id = `${e.kind}:${e.name}`;
    const node = { id, kind: e.kind, name: e.name, health: null, cost: null, planned: true };
    adds.push(node);
    all.push(node);
    const kind = creatable[e.kind];
    if (e.bindTo) {
      const by = all.find((r) => r.kind === (kind?.bind?.kind ?? r.kind) && r.name === e.bindTo?.worker);
      if (by) relations.push({ from: by.id, to: id, kind: 'uses' });
    }
    for (const f of kind?.fields ?? []) {
      if (f.type !== 'resource' || typeof e.attrs?.[f.path] !== 'string') continue;
      const to = all.find((r) => (f.kinds ?? []).includes(r.kind) && r.name === e.attrs[f.path]);
      if (to) relations.push({ from: to.id, to: id, kind: SERVED.has(e.kind) ? 'serves' : 'uses' });
    }
  }
  return { adds, relations };
}

/**
 * The prompt Have an agent write it starts with, for a new resource made by code (a Durable Object's class, a
 * container's image): what to add, and what the console already proposes.
 * @param {{ name: string, repo: string }} env
 * @param {CreatableKind} kind
 * @param {Extract<Edit, { op: 'create' }>} edit
 */
export function codePrompt(env, kind, edit) {
  const settings = kind.fields
    .filter((f) => edit.attrs[f.path] !== undefined)
    .map((f) => `- ${f.label}: ${valueWords(edit.attrs[f.path])}`);
  return [
    `Write the code for ${edit.name}, a new ${kind.label} in ${env.name} (${env.repo}), by pull request.`,
    '',
    `What must exist: ${kind.needsCode}`,
    ...(settings.length ? ['', 'Its settings, as the console adds it:', ...settings] : []),
    ...(edit.bindTo ? ['', `${edit.bindTo.worker} binds it as ${edit.bindTo.binding}.`] : []),
    '',
    `The console proposes the resource in .github/breakaway-infra/${env.name}.json; its plan applies only once this code is deployed.`,
  ].join('\n');
}

/**
 * The desired state's resource behind a resource of the inventory: the same ID, else the same kind and name.
 * @template {{ id: string, kind: string, name: string }} R
 * @param {R[]} declared
 * @param {{ id: string, kind: string, name: string }} r
 * @returns {R | null}
 */
export function declaredFor(declared, r) {
  return declared.find((d) => d.id === r.id) ?? declared.find((d) => d.kind === r.kind && d.name === r.name) ?? null;
}

/** A resource's ID on its platform: its inventory ID after `<kind>:` (BindingTarget in src/infra-provider.js). */
const platformId = (/** @type {string} */ id) => id.slice(id.indexOf(':') + 1);

/**
 * @typedef {{ type: string, label: string, kind: string, field: string, by: 'id' | 'name' }} BindingTarget
 * @typedef {{ key: string, label: string, binds: Record<string, string> }} BindingChoice
 */

/**
 * The resources a binding of `target` may bind, each with what the binding says to bind it (BRK-285): by name in the
 * target's field, or by the platform's ID for one that runs (matched as the plan matches it: the same ID, else kind
 * and name); one the plan still makes has no platform ID yet, so it's named by its ID in the file, in `resource`.
 * @param {BindingTarget} target
 * @param {Array<{ id: string, kind: string, name: string }>} declared the file's resources
 * @param {Array<{ id: string, kind: string, name: string }>} [running] what the board sees running
 * @returns {BindingChoice[]}
 */
export function bindingChoices(target, declared, running = []) {
  const live = running.filter((r) => r.kind === target.kind);
  return declared
    .filter((r) => r.kind === target.kind)
    .map((r) => {
      if (target.by === 'name') return { key: r.id, label: r.name, binds: { [target.field]: r.name } };
      const runs = declaredFor(live, r);
      return { key: r.id, label: r.name, binds: runs ? { [target.field]: platformId(runs.id) } : { resource: r.id } };
    });
}

/**
 * What a binding binds, among `choices`: the choice's key, `other` with the value when it names something no choice
 * is, or neither when it names nothing. A binding the file gives without a target keeps what it binds now (the plan
 * fills it in), so that's read from the running Worker's binding of the same name and type, and `kept` says so.
 * @param {BindingTarget} target
 * @param {Record<string, any>} b
 * @param {BindingChoice[]} choices
 * @param {unknown} [live] the running Worker's bindings
 * @returns {{ key: string | null, other: string | null, kept: boolean }}
 */
export function boundChoice(target, b, choices, live = []) {
  const kept = b.resource === undefined && b[target.field] === undefined;
  const from = kept
    ? ((Array.isArray(live) ? live : []).find((x) => isObject(x) && x.name === b.name && x.type === b.type) ?? {})
    : b;
  if (typeof from.resource === 'string' && from.resource) {
    const c = choices.find((x) => x.key === from.resource);
    return { key: c ? c.key : null, other: c ? null : from.resource, kept };
  }
  const value = String(from[target.field] ?? '');
  if (!value) return { key: null, other: null, kept };
  const c = choices.find((x) => x.binds[target.field] === value);
  return { key: c ? c.key : null, other: c ? null : value, kept };
}

/**
 * A binding once a choice is picked: its name and type, and what the choice says, nothing else it bound to before;
 * with no choice, an empty target to pick.
 * @param {BindingTarget} target
 * @param {Record<string, any>} b
 * @param {BindingChoice | null} choice
 */
export const bindChoice = (target, b, choice) => ({
  name: b.name,
  type: b.type,
  ...(choice ? choice.binds : { [target.field]: '' }),
});

/** The change's card, in the brand's words (BRK-258, "The words"). */
export const CARD = {
  checking: 'Checking',
  waiting: 'Waiting for you',
  merging: 'Merging',
  cant: 'Can’t merge',
  merged: 'Merged',
  'taken over': 'Taken over',
  rejected: 'Rejected',
  closed: 'Closed',
  nothing: 'Nothing to apply',
  refused: 'Refused by your policy',
};

/**
 * Whether a change plans nothing, so it merges instead of asking for an approval: the board's draft of an environment
 * with no file, proposed with no edits (BRK-258, "Describe it as code"), or any change whose plan has no changes, like
 * a first file with edits that leave it as it runs (BRK-286). The board keeps the plan's size when it proposes, and
 * again when Approve finds the head plans nothing.
 * @param {{ edits?: unknown[], changes?: number | null }} change
 */
export const plansNothing = (change) =>
  (Array.isArray(change.edits) && change.edits.length === 0) || change.changes === 0;

/**
 * The plan a merged change's card follows: the one the first compare after its merge found (WEB-110), or the one
 * its approval settled (BRK-260). Null before either, and for a change that isn't merged.
 * @param {{ state: string, outcome?: { plan?: string | null } | null, approval?: { plan?: string | null } | null }} change
 */
export const changePlanId = (change) =>
  change.state === 'merged' ? (change.outcome?.plan ?? change.approval?.plan ?? null) : null;

/**
 * What a change's card shows: the state's key (CARD's, or a plan's once the merged change has one) and whether the
 * owner can approve, merge (a change that plans nothing), reject, or propose it again from here. A merged change ends
 * in what the compare after its merge found (WEB-110): Nothing to apply, Refused by your policy, Waiting for you (its
 * plan, or the environment holds it), or its plan's own state (Applied, Failed, Rolled back).
 * @param {{ state: string, why?: string | null, approval?: { plan?: string | null } | null, digest?: string | null,
 *   commit?: string | null, edits?: unknown[], changes?: number | null,
 *   outcome?: { kind: string, plan?: string | null } | null }} change
 * @param {{ checks?: string | null, plan?: { state: string } | null }} [seen] the pull request's checks (from the board's
 *   GitHub data: `pending`, `success`, `failure`) and the plan the merge made, when the console has them
 * @returns {{ state: string, plan: boolean, approve: boolean, merge: boolean, reject: boolean, again: boolean }}
 */
export function cardState(change, { checks = null, plan = null } = {}) {
  const none = { plan: false, approve: false, merge: false, reject: false, again: false };
  if (change.state === 'open') {
    // A change whose plan has no changes (the board's draft with no edits, or edits that leave it as it runs): it merges.
    const nothing = plansNothing(change);
    return {
      ...none,
      state: checks === 'pending' ? 'checking' : 'waiting',
      approve: !nothing && Boolean(change.digest && change.commit),
      merge: nothing && checks !== 'pending' && Boolean(change.commit),
      reject: true,
      again: checks === 'failure',
    };
  }
  if (change.state === 'approved')
    return change.why
      ? { ...none, state: 'cant', reject: true, again: true }
      : { ...none, state: 'merging', reject: false };
  if (change.state === 'merged') {
    const kind = change.outcome?.kind ?? null;
    if (kind === 'nothing') return { ...none, state: 'nothing' };
    if (kind === 'refused') return { ...none, state: 'refused', plan: Boolean(plan) };
    if (plan) return { ...none, state: plan.state, plan: true };
    return { ...none, state: kind === 'waits' ? 'waiting' : 'merged' };
  }
  return { ...none, state: change.state };
}

/** Whether a finished change's card still shows: a day after it last moved, it goes. */
export const recentChange = (/** @type {{ updated: string }} */ change, now = Date.now()) =>
  now - Date.parse(change.updated) < 24 * 60 * 60 * 1000;

/** A finished change's card shows its end state this long, then folds to a line (WEB-110). */
export const FOLD_MS = 10 * 60 * 1000;
/** A merge the board hasn't compared yet keeps its card this long, then folds as if it ended. */
export const MERGED_CARD_MS = 60 * 60 * 1000;
/** The plan states in which a merged change's card has nothing more to follow. */
const PLAN_ENDS = ['applied', 'failed', 'rolled back', 'rejected'];

/**
 * When a change's card ended, in ms, or null while it still follows something: a change that's still the board's, or
 * a merged change whose plan is approved or applying.
 * @param {Parameters<typeof cardState>[0] & { updated: string, outcome?: { kind: string, plan?: string | null,
 *   at?: string } | null }} change
 * @param {{ state: string }} card cardState's
 * @param {{ state: string, updated?: string | null } | null} plan the plan it follows, when the console has it
 * @returns {number | null}
 */
export function cardEnded(change, card, plan) {
  if (change.state === 'open' || change.state === 'approved') return null;
  if (change.state !== 'merged') return Date.parse(change.updated);
  if (card.state === 'nothing' || card.state === 'refused' || card.state === 'waiting')
    return Date.parse(change.outcome?.at ?? change.updated);
  if (plan && PLAN_ENDS.includes(plan.state)) return Date.parse(plan.updated ?? change.updated);
  if (card.state === 'merged') return Date.parse(change.updated) + MERGED_CARD_MS - FOLD_MS;
  return null;
}

/**
 * Where a change shows on the console (WEB-110): its `card` while it's the board's, follows a plan, or ended a short
 * while ago; a `line` above the map once it folds ("Last change: #253 applied, 51 min ago"), until the owner dismisses
 * it or a day has gone; else nowhere.
 * @param {Parameters<typeof cardEnded>[0]} change
 * @param {{ plan?: { state: string, updated?: string | null } | null, dismissed?: boolean, now?: number }} [options]
 * @returns {'card' | 'line' | null}
 */
export function changeShows(change, { plan = null, dismissed = false, now = Date.now() } = {}) {
  const ended = cardEnded(change, cardState(change, { plan }), plan);
  if (ended === null) return recentChange(change, now) ? 'card' : null;
  if (now - ended < FOLD_MS) return 'card';
  return !dismissed && now - ended < 24 * 60 * 60 * 1000 ? 'line' : null;
}

/** What the folded line says a change became, after its number. */
const ENDED_WORDS = {
  nothing: 'nothing to apply',
  refused: 'refused by your policy',
  waiting: 'waits for you',
  applied: 'applied',
  failed: 'failed',
  'rolled back': 'rolled back',
  rejected: 'rejected',
  closed: 'closed',
  'taken over': 'taken over',
  merged: 'merged',
};

/**
 * The folded line's words, without when: "#253 applied".
 * @param {{ n: number, pull?: { number: number } | null }} change
 * @param {{ state: string }} card
 */
export const endedWords = (change, card) =>
  `${change.pull ? `#${change.pull.number}` : `Change ${change.n}`} ${ENDED_WORDS[/** @type {keyof typeof ENDED_WORDS} */ (card.state)] ?? card.state}`;

const FOLDED_KEY = 'breakaway.change.folded.';

/** The change whose folded line the owner dismissed on environment `envId`, by its number, or null. */
export function readDismissed(/** @type {string | number} */ envId, storage = local()) {
  try {
    const n = Number(storage?.getItem(FOLDED_KEY + envId));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Keeps the dismissed line's change number for environment `envId`. */
export function writeDismissed(/** @type {string | number} */ envId, /** @type {number} */ n, storage = local()) {
  try {
    storage?.setItem(FOLDED_KEY + envId, String(n));
  } catch {
    /* blocked: the line comes back when the page reloads */
  }
}

/**
 * The prompt Have an agent do it starts with: the environment, and what the owner was changing, for them to finish.
 * @param {{ name: string, repo: string }} env
 * @param {string[]} lines the change so far, in words
 */
export function agentPrompt(env, lines) {
  const out = [
    `Change ${env.name}'s desired state (.github/breakaway-infra/${env.name}.json in ${env.repo}) by pull request, with infra check passing first.`,
  ];
  if (lines.length) out.push('', 'What I was changing on the console:', ...lines.map((l) => `- ${l}`));
  out.push('', 'What the console couldn’t do: ');
  return out.join('\n');
}

/** What an environment with no target and nothing running says where it would show what runs (BRK-291). */
export const EMPTY_START = 'Add a resource to start, or point it at what runs';
