/**
 * Changes from the board's console (docs/specs/BRK-258-plan-from-the-board.md; BRK-259), the pure part. A change is
 * the owner's edits to one environment's desired state, kept as operations, never as a copy of the file: set a
 * setting on a resource, add from a template with these inputs, remove a resource. The board replays them onto the
 * file at the default branch's head, so a file that moved since keeps its own changes, and an edit that no longer
 * applies (its resource is gone) is dropped with a line saying so.
 *
 * This file checks the edits, replays them, words them, and writes the pull request's title and description. The
 * store (src/store-infra-changes.js) reads the file, previews the plan, and opens the pull request. Pure and
 * Node-safe: no store and no network.
 */
import { checkDesiredFile, DESIRED_DIR, desiredPath } from './infra-desired.js';
import { fieldProblem } from './infra-provider.js';
import { addFromTemplate, inputValues, TEMPLATE_NAME } from './infra-templates.js';
import { costWords, policyWords } from './infra-pulls.js';
import { bindingLabels, sameSetting, sameWords, settingWords } from './infra-setting-words.js';

/** At most this many edits in one change. */
export const CHANGE_MAX_EDITS = 50;
/** The board plans an environment's change at most this many times a minute (BRK-258, "How often"). */
export const PREVIEWS_PER_MINUTE = 6;
/** The same edits on the same head are answered from what the board planned this long ago. */
export const PREVIEW_CACHE_MS = 60_000;
/**
 * A change's states: `open` (its pull request waits), `approved` (the owner approved its plan before the merge,
 * BRK-260), `merged`, `rejected` (the owner's Reject closed it), `closed` (closed on GitHub), and `taken over` (someone
 * else pushed to its branch, so it's an ordinary pull request now).
 */
export const CHANGE_STATES = ['open', 'approved', 'merged', 'rejected', 'closed', 'taken over'];
/** The states in which the change is still the board's, waiting on its pull request. */
export const LIVE_STATES = ['open', 'approved'];
/** What a pull request's description says about where it came from. */
export const PROPOSED_LINE =
  'Proposed on the board’s console. Approving its plan on the board merges it; nothing applies before.';

/** What a binding is called in its Worker's code: upper snake case, like JOBS (BRK-270). */
export const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,62}$/u;

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/u;
const KIND = /^[a-z][a-z0-9-]{0,39}$/u;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const PATH_DEPTH = 8;
const VALUE_MAX = 8 * 1024;
const ID_MAX = 200;
const NAME_MAX = 200;
const SUMMARY_MAX = 100;

/**
 * One edit, checked:
 * - `{ op: 'set', resource, path, value }`: the setting at `path` (dots between keys, inside the resource's attrs) is
 *   `value`, or the platform's again when `value` is null;
 * - `{ op: 'add', template, inputs }`: what the template adds, with these inputs (`infra add`'s);
 * - `{ op: 'remove', resource }`: the resource is gone from the file;
 * - `{ op: 'rename', resource, name }`: the resource is called `name`, for a kind whose provider declares its name
 *   editable (BRK-267: a route's pattern), so the plan updates it in place;
 * - `{ op: 'create', kind, name, attrs, bindTo? }`: a new resource of a kind its provider declares creatable (BRK-270),
 *   with these settings by path (the kind's defaults fill the rest), and with `bindTo` a binding called `binding` on
 *   `worker`, the resource of the environment that binds it, so it's usable in one change.
 * @typedef {{ op: 'set', resource: string, path: string, value: unknown }
 *   | { op: 'add', template: string, inputs: Record<string, string> }
 *   | { op: 'remove', resource: string }
 *   | { op: 'rename', resource: string, name: string }
 *   | { op: 'create', kind: string, name: string, attrs: Record<string, unknown>,
 *       bindTo?: { worker: string, binding: string } }} Edit
 */

/**
 * What's wrong with an edit, or with the file the edits make: the edit it belongs to (its index), the field in it,
 * and what to change, in words.
 * @typedef {{ edit: number | null, field: string | null, message: string }} ChangeProblem
 */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks the edits a request sends. The result is the edits as the board keeps them, or what's wrong, with the
 * edit's index.
 * @param {unknown} edits
 * @returns {{ ok: true, edits: Edit[] } | { ok: false, problem: ChangeProblem }}
 */
export function checkEdits(edits) {
  const wrong = (edit, field, message) => ({ ok: /** @type {const} */ (false), problem: { edit, field, message } });
  if (!Array.isArray(edits)) return wrong(null, 'edits', 'edits is a list: [ { "op": "set", … } ]');
  if (edits.length > CHANGE_MAX_EDITS)
    return wrong(null, 'edits', `a change has at most ${CHANGE_MAX_EDITS} edits: propose these, then change more`);
  /** @type {Edit[]} */
  const out = [];
  for (const [n, e] of edits.entries()) {
    if (!isObject(e)) return wrong(n, null, 'each edit is an object with an op: set, add, create, remove, or rename');
    const resource = () =>
      typeof e.resource === 'string' && e.resource.trim() && e.resource.length <= ID_MAX ? e.resource : null;
    if (e.op === 'set') {
      if (!resource()) return wrong(n, 'resource', 'resource is the ID of a resource in the file');
      const parts = typeof e.path === 'string' ? e.path.split('.') : [];
      if (!parts.length || parts.length > PATH_DEPTH || parts.some((p) => !SEGMENT.test(p) || UNSAFE.has(p)))
        return wrong(n, 'path', 'path names a setting, with dots between keys, like observability.enabled');
      if (e.value === undefined)
        return wrong(n, 'value', 'value is the setting’s new value, or null for the platform’s');
      let text;
      try {
        text = JSON.stringify(e.value);
      } catch {
        text = undefined;
      }
      if (text === undefined) return wrong(n, 'value', 'value is a JSON value');
      if (text.length > VALUE_MAX) return wrong(n, 'value', `value is at most ${VALUE_MAX / 1024} KB`);
      out.push({ op: 'set', resource: e.resource, path: e.path, value: JSON.parse(text) });
    } else if (e.op === 'add') {
      if (typeof e.template !== 'string' || !TEMPLATE_NAME.test(e.template))
        return wrong(n, 'template', 'template is a template’s name, like queue');
      if (e.inputs !== undefined && !isObject(e.inputs)) return wrong(n, 'inputs', 'inputs is an object of names');
      const inputs = /** @type {Record<string, string>} */ ({});
      for (const [k, v] of Object.entries(e.inputs ?? {})) {
        if (UNSAFE.has(k) || typeof v !== 'string') return wrong(n, `inputs.${k}`, `${k} is text`);
        inputs[k] = v;
      }
      out.push({ op: 'add', template: e.template, inputs });
    } else if (e.op === 'remove') {
      if (!resource()) return wrong(n, 'resource', 'resource is the ID of a resource in the file');
      out.push({ op: 'remove', resource: e.resource });
    } else if (e.op === 'rename') {
      if (!resource()) return wrong(n, 'resource', 'resource is the ID of a resource in the file');
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      if (!name || name.length > NAME_MAX || /\p{Cc}/u.test(name))
        return wrong(n, 'name', `name is what the platform calls it, up to ${NAME_MAX} characters`);
      out.push({ op: 'rename', resource: e.resource, name });
    } else if (e.op === 'create') {
      if (typeof e.kind !== 'string' || !KIND.test(e.kind))
        return wrong(n, 'kind', 'kind is a resource kind, like queue');
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      if (!name || name.length > NAME_MAX || /\p{Cc}/u.test(name))
        return wrong(n, 'name', `name is what the platform calls it, up to ${NAME_MAX} characters`);
      if (e.attrs !== undefined && !isObject(e.attrs))
        return wrong(n, 'attrs', 'attrs is an object of settings by path, like { "retention": 86400 }');
      /** @type {Record<string, unknown>} */
      const attrs = {};
      for (const [path, v] of Object.entries(e.attrs ?? {})) {
        const parts = path.split('.');
        if (parts.length > PATH_DEPTH || parts.some((p) => !SEGMENT.test(p) || UNSAFE.has(p)))
          return wrong(n, `attrs.${path}`, 'each setting’s path is names with dots between them');
        let text;
        try {
          text = JSON.stringify(v);
        } catch {
          text = undefined;
        }
        if (text === undefined) return wrong(n, `attrs.${path}`, `${path} is a JSON value`);
        if (text.length > VALUE_MAX) return wrong(n, `attrs.${path}`, `${path} is at most ${VALUE_MAX / 1024} KB`);
        attrs[path] = JSON.parse(text);
      }
      /** @type {Extract<Edit, { op: 'create' }>} */
      const create = { op: 'create', kind: e.kind, name, attrs };
      if (e.bindTo !== undefined && e.bindTo !== null) {
        const b = e.bindTo;
        if (!isObject(b) || typeof b.worker !== 'string' || !b.worker.trim() || b.worker.length > NAME_MAX)
          return wrong(n, 'bindTo.worker', 'bindTo.worker is the name of what binds it, like acme-api');
        if (typeof b.binding !== 'string' || !BINDING_NAME.test(b.binding))
          return wrong(n, 'bindTo.binding', 'bindTo.binding is what its code calls it, in capitals, like JOBS');
        create.bindTo = { worker: b.worker.trim(), binding: b.binding };
      }
      out.push(create);
    } else return wrong(n, 'op', 'op is set, add, create, remove, or rename');
  }
  return { ok: true, edits: out };
}

/** The value at a dotted path inside `attrs`, or undefined. */
function readPath(attrs, parts) {
  let at = attrs;
  for (const p of parts) {
    if (!isObject(at) || !Object.hasOwn(at, p)) return undefined;
    at = at[p];
  }
  return at;
}

/** Sets (or, with null, deletes) the value at a dotted path inside `resource.attrs`, making objects on the way. */
function writePath(resource, parts, value) {
  if (value === null && !isObject(resource.attrs)) return;
  resource.attrs = isObject(resource.attrs) ? resource.attrs : {};
  let at = resource.attrs;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(at[p])) {
      if (value === null) return;
      at[p] = {};
    }
    at = at[p];
  }
  const last = parts[parts.length - 1];
  if (value === null) delete at[last];
  else at[last] = value;
}

/**
 * A template the board found for an add: checked, with its code files by name, or why it can't be used.
 * @typedef {{ template: import('./infra-templates.js').Template, sources: Record<string, string>, from: 'repository' | 'breakaway' } | { error: string }} FoundTemplate
 */

/**
 * Replays the edits onto an environment's file, in order. Returns the file they make, the code files templates add,
 * a line of words per edit that applied, the edits dropped because their resource is gone (with a line saying so),
 * and the problems that stop the change (an add whose template or inputs don't fit). The file passed in is never
 * changed.
 * @param {object} args
 * @param {Record<string, any>} args.file the environment's file, parsed
 * @param {Edit[]} args.edits
 * @param {Map<string, FoundTemplate>} args.templates by name, for the adds
 * @param {string} args.environment
 * @param {(kind: string) => { label: string, help: string, pattern?: string } | null | undefined} [args.names] the name
 *   a kind's provider lets the console change (its editable `name`, BRK-262), for the renames; none without it
 * @param {Array<{ rid: string, kind: string, name: string, attrs?: unknown }>} [args.seen] what the board sees running
 *   in the environment (its inventory), so a rename never turns a resource matched by its name into a new one, a create
 *   never takes the name of one that runs, and a binding added to a Worker the file doesn't list the bindings of
 *   starts from the ones it has
 * @param {(kind: string) => import('./infra-provider.js').CreatableKind | null | undefined} [args.creatable] what a
 *   kind's provider lets the console add (its `creatableKinds`, BRK-270), for the creates; none without it
 * @param {(kind: string) => import('./infra-provider.js').EditableField[] | null | undefined} [args.fields] the
 *   settings a kind's provider lets the console change (its editable `fields`, BRK-262), so a set edit's line names
 *   the setting as the console does and reads its bindings one at a time
 * @returns {{ file: Record<string, any>, files: Array<{ path: string, text: string }>, lines: string[],
 *   dropped: Array<{ edit: number, line: string }>, problems: ChangeProblem[], touched: Map<string, number> }}
 */
export function applyEdits({
  file,
  edits,
  templates,
  environment,
  names = () => null,
  seen = [],
  creatable = () => null,
  fields = () => null,
}) {
  let out = structuredClone(file);
  if (!Array.isArray(out.resources)) out.resources = [];
  /** @type {Array<{ path: string, text: string }>} */
  const files = [];
  const lines = [];
  /** @type {Array<{ edit: number, line: string }>} */
  const dropped = [];
  /** @type {ChangeProblem[]} */
  const problems = [];
  /** Which edit last touched each resource, by ID, so a problem in the file can be put on its edit. */
  const touched = new Map();
  const find = (id) => out.resources.findIndex((r) => isObject(r) && r.id === id);

  for (const [n, edit] of edits.entries()) {
    if (edit.op === 'set') {
      const at = find(edit.resource);
      if (at < 0) {
        dropped.push({ edit: n, line: `${edit.resource} is gone from the file, so setting ${edit.path} was dropped` });
        continue;
      }
      const r = out.resources[at];
      const parts = edit.path.split('.');
      const before = readPath(r.attrs, parts);
      const field = fields(r.kind)?.find((f) => f.path === edit.path);
      const label = field?.label.toLowerCase() ?? edit.path;
      // An edit that leaves the setting as it is (the same bindings in another order) changes nothing: it's dropped.
      if (sameSetting(before ?? null, edit.value ?? null)) {
        dropped.push({
          edit: n,
          line: `${sameWords(r.name, label, before)}, so that edit changes nothing`,
        });
        continue;
      }
      writePath(r, parts, edit.value);
      touched.set(r.id, n);
      lines.push(
        `~ ${r.name}: ${settingWords({ label, before, after: edit.value ?? undefined, labels: bindingLabels(field), unset: 'the platform’s' })}`,
      );
    } else if (edit.op === 'remove') {
      const at = find(edit.resource);
      if (at < 0) {
        dropped.push({ edit: n, line: `${edit.resource} is already gone from the file, so removing it was dropped` });
        continue;
      }
      const [r] = out.resources.splice(at, 1);
      touched.delete(r.id);
      lines.push(`− ${r.kind} ${r.name}`);
    } else if (edit.op === 'rename') {
      const at = find(edit.resource);
      if (at < 0) {
        dropped.push({ edit: n, line: `${edit.resource} is gone from the file, so renaming it was dropped` });
        continue;
      }
      const r = out.resources[at];
      if (r.name === edit.name) continue;
      const declared = names(r.kind);
      const what = declared?.label.toLowerCase() ?? 'name';
      if (!declared) {
        problems.push({ edit: n, field: 'name', message: `a ${r.kind}’s name can’t be changed from the board` });
        continue;
      }
      if (declared.pattern && !new RegExp(declared.pattern, 'u').test(edit.name)) {
        problems.push({ edit: n, field: 'name', message: `${edit.name} isn’t a ${what}: ${declared.help}` });
        continue;
      }
      // The plan matches a resource by its ID, else by kind and name: one matched by its name would be made anew.
      const running = seen.some((x) => x.rid === r.id)
        ? null
        : seen.find((x) => x.kind === r.kind && x.name === r.name);
      if (running) {
        problems.push({
          edit: n,
          field: 'name',
          message: `${r.id} isn’t the ID the board sees for ${r.name} (${running.rid}), so a new ${what} would make another ${r.kind}: give it that ID in the file first`,
        });
        continue;
      }
      if (out.resources.some((x) => isObject(x) && x !== r && x.kind === r.kind && x.name === edit.name)) {
        problems.push({ edit: n, field: 'name', message: `another ${r.kind} already has the ${what} ${edit.name}` });
        continue;
      }
      lines.push(`~ ${r.kind} ${r.name}: ${what} → ${edit.name}`);
      r.name = edit.name;
      touched.set(r.id, n);
    } else if (edit.op === 'create') {
      const made = created(out, edit, creatable(edit.kind), { environment, seen });
      if ('problem' in made) {
        problems.push({ edit: n, ...made.problem });
        continue;
      }
      touched.set(made.id, n);
      if (made.binder) touched.set(made.binder, n);
      lines.push(made.line);
    } else {
      const found = templates.get(edit.template);
      if (!found) {
        problems.push({ edit: n, field: 'template', message: `there’s no template called ${edit.template}` });
        continue;
      }
      if ('error' in found) {
        problems.push({
          edit: n,
          field: 'template',
          message: `the ${edit.template} template doesn’t check: ${found.error}`,
        });
        continue;
      }
      const values = inputValues(found.template, edit.inputs);
      if ('error' in values) {
        problems.push({ edit: n, field: 'inputs', message: values.error });
        continue;
      }
      const added = addFromTemplate({
        template: found.template,
        values: /** @type {Record<string, string>} */ (values.values),
        environment,
        desired: `${JSON.stringify(out, null, 2)}\n`,
        sources: found.sources,
      });
      if ('error' in added) {
        problems.push({ edit: n, field: 'inputs', message: added.error });
        continue;
      }
      out = JSON.parse(added.desired);
      for (const f of added.files) {
        if (f.path.startsWith('.github/workflows/'))
          problems.push({ edit: n, field: 'template', message: `${f.path} is a workflow: the board never writes one` });
        else if (files.some((x) => x.path === f.path))
          problems.push({
            edit: n,
            field: 'inputs',
            message: `${f.path} is written by an earlier edit: pick another name`,
          });
        else files.push(f);
      }
      for (const r of out.resources)
        if (!file.resources?.some((x) => x?.id === r.id) && !touched.has(r.id)) touched.set(r.id, n);
      const what = [...added.added, ...added.extended.map((e) => e)];
      lines.push(`+ ${what.join(', ') || edit.template} (from ${edit.template})`);
    }
  }
  return { file: out, files, lines, dropped, problems, touched };
}

/**
 * Adds a `create` edit's resource to the file (`out`, changed in place), with the kind's defaults and the edit's
 * settings, and its binding on the Worker that binds it; or says what's wrong, on the edit's field. Nothing is added
 * when something is wrong.
 * @param {Record<string, any>} out
 * @param {Extract<Edit, { op: 'create' }>} edit
 * @param {import('./infra-provider.js').CreatableKind | null | undefined} kind
 * @param {{ environment: string, seen: Array<{ rid: string, kind: string, name: string, attrs?: unknown }> }} ctx
 * @returns {{ id: string, binder: string | null, line: string } | { problem: { field: string, message: string } }}
 */
function created(out, edit, kind, { environment, seen }) {
  const wrong = (field, message) => ({ problem: { field, message } });
  if (!kind) return wrong('kind', `a ${edit.kind} can’t be added from the board`);
  const label = kind.label.toLowerCase();
  const what = kind.name.label.toLowerCase();
  if (kind.name.max !== undefined && edit.name.length > kind.name.max)
    return wrong('name', `a ${label}’s ${what} is at most ${kind.name.max} characters: ${kind.name.help}`);
  if (kind.name.pattern && !new RegExp(kind.name.pattern, 'u').test(edit.name))
    return wrong('name', `${edit.name} isn’t a ${label}’s ${what}: ${kind.name.help}`);
  if (out.resources.some((x) => isObject(x) && x.kind === edit.kind && x.name === edit.name))
    return wrong('name', `${environment} already has a ${label} called ${edit.name}: pick another ${what}`);
  if (seen.some((x) => x.kind === edit.kind && x.name === edit.name))
    return wrong(
      'name',
      `a ${label} called ${edit.name} already runs in ${environment}: pick another ${what}, or describe the one that runs as code first`,
    );

  const given = edit.attrs ?? {};
  const fields = new Map(kind.fields.map((f) => [f.path, f]));
  for (const path of Object.keys(given))
    if (!fields.has(path)) return wrong(`attrs.${path}`, `a new ${label} has no setting ${path}`);
  /** @type {Record<string, any>} */
  const resource = { id: '', kind: edit.kind, name: edit.name, attrs: {} };
  for (const f of kind.fields) {
    const value = Object.hasOwn(given, f.path) ? given[f.path] : structuredClone(f.default);
    if (value === undefined || value === null) {
      if (f.required) return wrong(`attrs.${f.path}`, `a new ${label} needs its ${f.label.toLowerCase()}: ${f.help}`);
      continue;
    }
    const problem = fieldProblem(f, value);
    if (problem) return wrong(`attrs.${f.path}`, problem);
    if (f.type === 'resource') {
      const target = out.resources.find((x) => isObject(x) && f.kinds?.includes(x.kind) && x.name === value);
      if (!target)
        return wrong(`attrs.${f.path}`, `${environment} has no ${f.kinds?.join(' or ')} called ${value} in its file`);
    }
    writePath(resource, f.path.split('.'), value);
  }
  let id = `${edit.kind}:${edit.name}`;
  for (let i = 2; out.resources.some((x) => isObject(x) && x.id === id); i++) id = `${edit.kind}:${edit.name}-${i}`;
  resource.id = id;

  let binder = null;
  let bound = '';
  const bind = kind.bind;
  if (edit.bindTo) {
    if (!bind) return wrong('bindTo', `nothing binds a ${label}`);
    const { worker, binding } = edit.bindTo;
    const w = out.resources.find((x) => isObject(x) && x.kind === bind.kind && x.name === worker);
    if (!w)
      return wrong(
        'bindTo.worker',
        `${environment} has no ${bind.kind} called ${worker} in its file${seen.some((x) => x.kind === bind.kind && x.name === worker) ? ': describe it as code first' : ''}`,
      );
    const parts = bind.list.split('.');
    let list = readPath(w.attrs, parts);
    if (list === undefined) {
      // A list the file doesn't give is the platform's: start from what runs, so the plan keeps the rest.
      const running = seen.find((x) => x.kind === bind.kind && x.name === worker);
      const attrs = typeof running?.attrs === 'string' ? JSON.parse(running.attrs) : running?.attrs;
      list = structuredClone(readPath(attrs, parts) ?? []);
    }
    if (!Array.isArray(list)) return wrong('bindTo.worker', `${worker}’s ${bind.list} isn’t a list in the file`);
    if (list.some((b) => isObject(b) && b.name === binding))
      return wrong('bindTo.binding', `${worker} already has a binding called ${binding}: pick another name`);
    // A new resource has no ID on the platform yet: one bound by ID names its ID in the file until it runs (BRK-285).
    const target = bind.target.by === 'id' ? { resource: id } : { [bind.target.field]: edit.name };
    list.push({ name: binding, type: bind.target.type, ...target });
    writePath(w, parts, list);
    binder = w.id;
    bound = `, bound to ${worker} as ${binding}`;
  } else if (bind?.required)
    return wrong('bindTo', `a new ${label} is made only when a ${bind.kind} binds it: say which, and what it calls it`);

  out.resources.push(resource);
  return { id, binder, line: `+ ${edit.kind} ${edit.name}${bound}` };
}

/** The text the board commits for a file: two-space indents and a final newline. */
export const desiredText = (file) => `${JSON.stringify(file, null, 2)}\n`;

/**
 * Checks the file the edits make, with the environment's provider, putting what's wrong on the edit that touched
 * the resource it's in when there is one.
 * @param {string} text
 * @param {{ provider?: any, expectProvider?: string | null, touched: Map<string, number>, file: Record<string, any> }} args
 * @returns {{ ok: true, desired: import('./infra-provider.js').DesiredState } | { ok: false, problem: ChangeProblem }}
 */
export function checkChangedFile(text, { provider = null, expectProvider = null, touched, file }) {
  let checked;
  try {
    checked = checkDesiredFile(text, { provider, expectProvider });
  } catch (error) {
    // The provider's own check throws when a resource doesn't fit it.
    return {
      ok: false,
      problem: { edit: null, field: null, message: String(/** @type {Error} */ (error)?.message ?? error) },
    };
  }
  if ('desired' in checked) return { ok: true, desired: checked.desired };
  const field = checked.error.field;
  const at = /^resources\[(\d+)\]/u.exec(field ?? '');
  const id = at ? file.resources?.[Number(at[1])]?.id : null;
  const edit = id && touched.has(id) ? /** @type {number} */ (touched.get(id)) : null;
  return { ok: false, problem: { edit, field, message: checked.error.message } };
}

/**
 * The target a change gives an environment that has none (BRK-291): the one resource of a target kind (a Worker) the
 * file it makes has, or of several, the one the owner `chose`. Nothing when the environment has a target already, or
 * when its provider has no target kind. With no such resource, or several and no choice among them, it answers the
 * problem, with the names to choose from. `label` is what one is called (a Worker).
 * @param {{ target: string | null, file: Record<string, any>, kinds: string[], environment: string,
 *   chose?: string | null, label?: string }} args
 * @returns {{ name: string | null, choices: string[], line: string | null, problem?: ChangeProblem }}
 */
export function changeTarget({ target, file, kinds, environment, chose = null, label = kinds[0] }) {
  if (target || !kinds.length) return { name: null, choices: [], line: null };
  const choices = (Array.isArray(file.resources) ? file.resources : [])
    .filter((r) => isObject(r) && kinds.includes(r.kind) && typeof r.name === 'string')
    .map((r) => r.name);
  const pick = choices.length === 1 ? choices[0] : choices.includes(chose ?? '') ? chose : null;
  if (pick) return { name: pick, choices, line: targetLine(environment, pick) };
  return {
    name: null,
    choices,
    line: null,
    problem: {
      edit: null,
      field: 'target',
      message: choices.length
        ? `The change adds ${choices.length} ${label}s: pick which one is ${environment}’s target`
        : `${environment} has no target yet: add a ${label} for it to run, or point it at what runs`,
    },
  };
}

/** The line a change's new target shows as, in Your change and its pull request. */
export const targetLine = (environment, name) => `→ ${environment}’s target becomes ${name}`;

/** The branch a change is committed on: the board's own, the only one it ever moves by force. */
export const changeBranch = (environment, n) => `breakaway/infra/${environment}-${n}`;

/** The change in a line: the first edit's words, and how many more. */
export function changeSummary(lines) {
  const first = String(lines[0] ?? 'no edits').replace(/^[~+−]\s*/u, '');
  const line = lines.length > 1 ? `${first}, and ${lines.length - 1} more` : first;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** The pull request's title: "Change <environment>: <the change in a line>". It carries no work ID. */
export const changeTitle = (environment, lines) => `Change ${environment}: ${changeSummary(lines)}`;

/** The commit's message: "<environment>: <the change in a line>". */
export const changeCommitMessage = (environment, lines) => `${environment}: ${changeSummary(lines)}`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The pull request's description: what changes in words, the plan's summary, and where it came from. It names no
 * task, so it closes none.
 * `empty` is a change that starts an environment from nothing (BRK-291): its first file has only what the change adds.
 * @param {{ environment: string, lines: string[], dropped?: Array<{ line: string }>, files?: string[],
 *   preview: Record<string, any> | null, page?: string | null, created?: boolean, empty?: boolean }} args
 */
export function changeBody({
  environment,
  lines,
  dropped = [],
  files = [],
  preview,
  page = null,
  created = false,
  empty = false,
}) {
  const out = [
    empty
      ? `Starts ${environment} from nothing: its first desired state, \`${desiredPath(environment)}\`, with these edits.`
      : created
        ? `Describes ${environment} as code: \`${desiredPath(environment)}\`, from what runs${lines.length ? ', with these edits' : ''}.`
        : `Changes ${environment}’s desired state, \`${desiredPath(environment)}\`:`,
    '',
  ];
  for (const line of lines) out.push(`- ${line}`);
  if (lines.length) out.push('');
  if (files.length) {
    out.push('It adds these files, from a template:', '');
    for (const f of files) out.push(`- \`${f}\``);
    out.push('');
  }
  for (const d of dropped) out.push(`Dropped: ${d.line}.`);
  if (dropped.length) out.push('');
  if (preview) {
    const facts = preview.changes
      ? [
          plural(preview.changes, 'change'),
          costWords(preview.cost),
          preview.reversible ? 'can be undone' : 'can’t all be undone',
        ]
      : ['no changes to what runs'];
    out.push(`**The plan:** ${facts.join(' · ')}.`);
    const policy = policyWords(preview.policy);
    if (policy) out.push('', `**Policy:** ${policy}`);
    out.push('');
  }
  out.push('---', PROPOSED_LINE);
  if (page) out.push('', `[See it on the board](${page})`);
  return out.join('\n');
}

/** Whether a path is one a change may write a code file at: not in the desired-state folder or the workflows. */
export const writablePath = (path) => !path.startsWith(`${DESIRED_DIR}/`) && !path.startsWith('.github/workflows/');

/**
 * How long after GitHub says a pull request merged the board trusts that a read of the default branch includes it,
 * when the read's commit isn't the merge's own (a later commit landed, or the merge commit isn't known): GitHub's
 * clock and the board's may differ by a little.
 */
export const MERGE_READ_MARGIN_MS = 60_000;

/**
 * Whether the desired state the board last read from the default branch includes a merged change: read at the
 * merge's own commit, or read a while after the merge.
 * @param {{ sha?: string | null, readAt?: number | null }} read infra_desired's `sha` and `read_at`
 * @param {{ mergeSha?: string | null, mergedAt?: number | null }} merge the change's
 */
export function readHasMerge(read, merge) {
  if (merge.mergeSha && read.sha && read.sha === merge.mergeSha) return true;
  if (!merge.mergedAt || !read.readAt) return false;
  return read.readAt >= merge.mergedAt + MERGE_READ_MARGIN_MS;
}

/**
 * What a merged change became, found by the first compare of what runs with a desired state that includes it
 * (WEB-110): `nothing` (what runs already matches it, or the merge left the desired state as it was), `planned` (its
 * plan is approved, being applied, or done: the card follows the plan), `waits` (its plan waits for the owner, or the
 * environment holds it: frozen, or a break-glass change), or `refused` (the policy refuses its plan).
 * @typedef {{ kind: 'nothing' | 'planned' | 'waits' | 'refused', plan: string | null, why: string | null,
 *   at: string }} ChangeOutcome
 */

/**
 * A merged change's outcome from one compare.
 * @param {{ moved: boolean, empty: boolean, plan?: { id: string, state: string, policy?: { outcome?: string } | null }
 *   | null, held?: string | null, now?: number }} compare `moved`: the desired state changed since the last compare
 *   that settled; `empty`: nothing differs from what runs; `plan`: the open plan that covers it, or the one made for
 *   it; `held`: why the environment holds it without a plan
 * @returns {ChangeOutcome}
 */
export function mergeOutcome({ moved, empty, plan = null, held = null, now = Date.now() }) {
  const at = new Date(now).toISOString();
  if (empty) return { kind: 'nothing', plan: null, why: null, at };
  if (!moved) return { kind: 'nothing', plan: null, why: 'the merge left the desired state as it was', at };
  if (!plan) return { kind: 'waits', plan: null, why: held, at };
  if (plan.state === 'draft' && plan.policy?.outcome === 'refused')
    return { kind: 'refused', plan: plan.id, why: null, at };
  if (plan.state === 'draft' || plan.state === 'waiting') return { kind: 'waits', plan: plan.id, why: null, at };
  return { kind: 'planned', plan: plan.id, why: null, at };
}

/** The outcome in the audit trail's words, for change `ref` (#253). */
export function outcomeSummary(/** @type {string} */ ref, /** @type {ChangeOutcome} */ outcome) {
  if (outcome.kind === 'nothing')
    return outcome.why ? `${ref}: ${outcome.why}, so nothing applies` : `${ref}: what runs already matches it`;
  if (outcome.kind === 'refused') return `${ref}: your policy refuses ${outcome.plan}`;
  if (outcome.kind === 'waits')
    return outcome.plan ? `${ref}: ${outcome.plan} waits for you` : `${ref} waits for you: ${outcome.why}`;
  return `${ref}: ${outcome.plan} is approved; the board applies it`;
}
