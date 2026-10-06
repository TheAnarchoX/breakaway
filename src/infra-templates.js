/**
 * Golden paths (docs/specs/IDEA-19-architect.md, "Golden paths"; CLI-15): the owner's own templates for a capability
 * (a queue, a database, a new service), kept in the repository, and what `npx breakaway infra add <template>` writes
 * from one. A template adds resources to one environment's desired state, adds to a list setting of a resource the
 * file already has (a Worker's bindings, say), and writes code files that aren't there yet. The result is an ordinary
 * change in the checkout: an agent checks it with `infra check` and opens a pull request, and nothing is applied.
 *
 * A template is a folder with `template.json`:
 *
 *   { "version": 1, "title": "…", "description": "…", "provider": "cloudflare",
 *     "inputs": { "name": { "help": "…", "pattern": "^…$", "default": "…" } },
 *     "resources": [ { "id": "queue:{{name}}", "kind": "queue", "name": "{{name}}", "attrs": { … } } ],
 *     "extend": [ { "kind": "worker", "name": "{{worker}}", "list": "bindings", "add": { … } } ],
 *     "files": [ … ] }
 *
 * Each of `files` names a file in the template's folder (its from) and the path in the checkout it's written at (its
 * to), like `src/queues/{{name}}.js`.
 *
 * `{{input}}` in any string, a file's text, or its path is the input's value; `{{input|upper}}` is it in capitals, with
 * `-` as `_` (a binding's name from a queue's). Values are put in after the JSON is read, so they can't change its
 * shape. Pure and Node-safe, so the CLI imports it: no store, no network, no file system.
 */
import { problemLine } from './infra-check.js';
import { checkDesiredFile, DESIRED_DIR, DESIRED_VERSION } from './infra-desired.js';

/** Where the owner keeps templates in a repository: one folder each, beside the environments' files. */
export const TEMPLATES_DIR = `${DESIRED_DIR}/templates`;
/** The file in a template's folder that says what it adds. */
export const TEMPLATE_FILE = 'template.json';
export const TEMPLATE_VERSION = 1;
/** A template's name, as `infra add` takes it: its folder's name. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** What a value may be when its input gives no pattern: a name, never a path or anything to escape. */
export const VALUE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/u;
const INPUT = /^[a-z][a-zA-Z0-9]{0,30}$/u;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*(?:\|\s*([a-z]+)\s*)?\}\}/gu;
const TRANSFORMS = {
  /** @param {string} v */
  upper: (v) => v.toUpperCase().replaceAll('-', '_'),
};
const TOP = ['version', 'title', 'description', 'provider', 'inputs', 'resources', 'extend', 'files'];
const MAX_FILES = 20;

/** A template, checked: what `infra add` lists, and what it fills in. */
/**
 * @typedef {object} Template
 * @property {string} title
 * @property {string} description
 * @property {string | null} provider the provider its resources are for, which the environment's file must match
 * @property {Record<string, { help: string, pattern: string | null, default: string | null }>} inputs
 * @property {Array<Record<string, any>>} resources
 * @property {Array<{ kind: string, name: string, list: string, add: Record<string, any> }>} extend
 * @property {Array<{ from: string, to: string }>} files
 */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** The placeholders in a value, anywhere in it. @param {unknown} v @returns {string[]} */
function placeholders(v) {
  if (typeof v === 'string') return [...v.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (Array.isArray(v)) return v.flatMap(placeholders);
  if (isObject(v)) return Object.entries(v).flatMap(([k, x]) => [...placeholders(k), ...placeholders(x)]);
  return [];
}

/** A path inside the checkout: relative, with no `..`, and nowhere git or the desired state keeps its own files. */
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 200) return false;
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/u.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts[0] === '.git') return false;
  return !path.startsWith(`${DESIRED_DIR}/`);
}

/**
 * Checks a template's `template.json`. The result is the template, or what's wrong with it, in words.
 * @param {string} source the file's text
 * @returns {{ ok: true, template: Template } | { ok: false, error: string }}
 */
export function checkTemplate(source) {
  const wrong = (error) => ({ ok: /** @type {const} */ (false), error });
  let t;
  try {
    t = JSON.parse(String(source ?? ''));
  } catch (error) {
    return wrong(`it isn’t JSON: ${/** @type {Error} */ (error).message}`);
  }
  if (!isObject(t)) return wrong('it’s one JSON object: { "version": 1, "title": …, "resources": [ … ] }');
  for (const key of Object.keys(t))
    if (!TOP.includes(key)) return wrong(`“${key}” isn’t part of a template: it has ${TOP.join(', ')}`);
  if (t.version !== TEMPLATE_VERSION)
    return wrong(`version is ${TEMPLATE_VERSION}: add "version": ${TEMPLATE_VERSION}`);
  if (!text(t.title)) return wrong('title says what it adds, in a few words, like “A queue a Worker sends to”');
  if (t.description !== undefined && typeof t.description !== 'string') return wrong('description is text');
  if (t.provider !== undefined && !(typeof t.provider === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(t.provider)))
    return wrong('provider is the ID of the provider its resources are for, like cloudflare');

  /** @type {Template['inputs']} */
  const inputs = {};
  if (t.inputs !== undefined && !isObject(t.inputs)) return wrong('inputs is an object: { "name": { "help": … } }');
  for (const [name, input] of Object.entries(t.inputs ?? {})) {
    if (!INPUT.test(name)) return wrong(`input ${name} needs a name of letters and digits, starting lowercase`);
    if (!isObject(input) || !text(input.help)) return wrong(`input ${name} needs help: what to give, in words`);
    let pattern = null;
    if (input.pattern !== undefined) {
      if (typeof input.pattern !== 'string') return wrong(`input ${name}’s pattern is a regular expression, as text`);
      try {
        new RegExp(input.pattern, 'u');
      } catch {
        return wrong(`input ${name}’s pattern isn’t a regular expression JavaScript reads`);
      }
      pattern = input.pattern;
    }
    if (input.default !== undefined && typeof input.default !== 'string')
      return wrong(`input ${name}’s default is text`);
    inputs[name] = { help: input.help, pattern, default: input.default ?? null };
  }

  const resources = t.resources ?? [];
  if (!Array.isArray(resources) || !resources.every(isObject))
    return wrong('resources is a list of resources, as in an environment’s file');
  const extend = t.extend ?? [];
  if (!Array.isArray(extend)) return wrong('extend is a list');
  for (const [n, e] of extend.entries())
    if (!isObject(e) || !text(e.kind) || !text(e.name) || !text(e.list) || !isObject(e.add))
      return wrong(`extend[${n}] names the resource (kind and name), the list setting it adds to, and what it adds`);
  const files = t.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) return wrong(`files is a list of up to ${MAX_FILES}`);
  for (const [n, f] of files.entries()) {
    if (!isObject(f) || !text(f.from) || !text(f.to)) return wrong(`files[${n}] has a from and a to`);
    if (!/^[A-Za-z0-9._-]+$/u.test(f.from) || f.from === TEMPLATE_FILE || f.from.startsWith('.'))
      return wrong(`files[${n}].from is a file in the template’s folder, by its name`);
  }
  if (!resources.length && !extend.length && !files.length)
    return wrong('a template adds something: resources, extend, or files');

  const used = new Set([...placeholders(resources), ...placeholders(extend), ...placeholders(files)]);
  for (const input of Object.values(inputs)) for (const p of placeholders(input.default ?? '')) used.add(p);
  for (const name of used)
    if (!Object.hasOwn(inputs, name)) return wrong(`{{${name}}} isn’t one of its inputs: add it to inputs`);
  for (const m of JSON.stringify([resources, extend, files, t.inputs ?? {}]).matchAll(PLACEHOLDER))
    if (m[2] && !Object.hasOwn(TRANSFORMS, m[2])) return wrong(`{{${m[1]}|${m[2]}}}: the only change is |upper`);
  return {
    ok: true,
    template: {
      title: t.title,
      description: t.description ?? '',
      provider: t.provider ?? null,
      inputs,
      resources,
      extend,
      files,
    },
  };
}

/**
 * Puts the values in: in every string of `v`, including keys.
 * @template T
 * @param {T} v
 * @param {Record<string, string>} values
 * @returns {T}
 */
export function fillIn(v, values) {
  if (typeof v === 'string')
    return /** @type {T} */ (
      v.replace(PLACEHOLDER, (_, name, transform) =>
        transform ? TRANSFORMS[/** @type {'upper'} */ (transform)](values[name]) : values[name],
      )
    );
  if (Array.isArray(v)) return /** @type {T} */ (v.map((x) => fillIn(x, values)));
  if (isObject(v))
    return /** @type {T} */ (
      Object.fromEntries(
        Object.entries(/** @type {object} */ (v)).map(([k, x]) => [fillIn(k, values), fillIn(x, values)]),
      )
    );
  return v;
}

/**
 * Each input's value: what was given, else its default (filled in from the others), checked against its pattern, or
 * the plain-name rule when it has none. Unknown names are refused, so a typo doesn't pass unseen.
 * @param {Template} template
 * @param {Record<string, string>} given
 * @returns {{ ok: true, values: Record<string, string> } | { ok: false, error: string }}
 */
export function inputValues(template, given) {
  const names = Object.keys(template.inputs);
  for (const name of Object.keys(given))
    if (!names.includes(name))
      return {
        ok: false,
        error: `${name} isn’t one of its inputs: it takes ${names.length ? names.join(', ') : 'none'}`,
      };
  /** @type {Record<string, string>} */
  const values = {};
  const missing = names.filter((n) => given[n] === undefined && template.inputs[n].default === null);
  if (missing.length)
    return {
      ok: false,
      error: `give ${missing.map((n) => `${n}=<${template.inputs[n].help}>`).join(' ')}`,
    };
  for (const n of names) if (given[n] !== undefined) values[n] = given[n];
  for (const n of names) {
    if (values[n] !== undefined) continue;
    const def = /** @type {string} */ (template.inputs[n].default);
    const needs = placeholders(def);
    if (needs.some((x) => values[x] === undefined))
      return { ok: false, error: `${n}’s default uses an input that has no value yet: give ${n}=<…>` };
    values[n] = fillIn(def, values);
  }
  for (const n of names) {
    const { pattern } = template.inputs[n];
    const ok = pattern ? new RegExp(pattern, 'u').test(values[n]) : VALUE.test(values[n]);
    if (!ok || !VALUE.test(values[n]))
      return {
        ok: false,
        error: `${n}=${values[n]} isn’t ${template.inputs[n].help}${pattern ? ` (it matches ${pattern})` : ''}: letters, digits, - and _, up to 63`,
      };
  }
  return { ok: true, values };
}

/**
 * What `infra add` writes: the environment's desired state with the template's resources added (made when there's
 * no file yet), and its code files, each at its path. Refused, with why, when the result wouldn't check, when the file
 * already has a resource the template adds, or when a resource to extend isn't in it.
 * @param {object} args
 * @param {Template} args.template
 * @param {Record<string, string>} args.values from inputValues
 * @param {string} args.environment
 * @param {string | null} args.desired the environment's file now, or null when there's none
 * @param {Record<string, string>} args.sources the template's code files, by `from`
 * @returns {{ ok: true, desiredPath: string, desired: string, created: boolean, added: string[], extended: string[],
 *   files: Array<{ path: string, text: string }> } | { ok: false, error: string }}
 */
export function addFromTemplate({ template, values, environment, desired, sources }) {
  const wrong = (error) => ({ ok: /** @type {const} */ (false), error });
  const path = `${DESIRED_DIR}/${environment}.json`;
  /** @type {any} */
  let file;
  if (desired === null) {
    file = {
      version: DESIRED_VERSION,
      ...(template.provider ? { provider: template.provider } : {}),
      resources: [],
    };
  } else {
    const checked = checkDesiredFile(desired);
    if ('error' in checked) return wrong(`${problemLine(path, checked.error)}. Fix that first, then add again`);
    file = JSON.parse(desired);
    if (template.provider && file.provider && file.provider !== template.provider)
      return wrong(`${path} is for ${file.provider}, and this template is for ${template.provider}`);
  }

  const resources = fillIn(template.resources, values);
  const added = [];
  for (const r of resources) {
    const clash = file.resources.find((x) => x.id === r.id || (x.kind === r.kind && x.name === r.name));
    if (clash) return wrong(`${path} already has ${clash.kind} ${clash.name}: pick another name`);
    file.resources.push(r);
    added.push(`${r.kind} ${r.name}`);
  }

  const extended = [];
  for (const e of fillIn(template.extend, values)) {
    const target = file.resources.find((x) => x.kind === e.kind && x.name === e.name);
    if (!target)
      return wrong(
        `${path} has no ${e.kind} ${e.name}: give the name of one it has${
          file.resources.some((x) => x.kind === e.kind)
            ? ` (${file.resources
                .filter((x) => x.kind === e.kind)
                .map((x) => x.name)
                .join(', ')})`
            : `, or add the ${e.kind} first`
        }`,
      );
    const list = target.attrs?.[e.list];
    // A list the file doesn't give is the platform's to keep: one made here would hold only the new entry, and the
    // plan would drop the rest.
    if (!Array.isArray(list))
      return wrong(
        `${e.kind} ${e.name} in ${path} doesn’t list its ${e.list}, so adding one would drop the rest: list them first (npx breakaway infra show ${environment} shows them), then add again`,
      );
    if (e.add.name !== undefined && list.some((x) => isObject(x) && x.name === e.add.name))
      return wrong(`${e.kind} ${e.name} already has ${e.list.replace(/s$/u, '')} ${e.add.name}: pick another name`);
    list.push(e.add);
    extended.push(`${e.kind} ${e.name}’s ${e.list}`);
  }

  const files = [];
  for (const f of template.files) {
    const to = fillIn(f.to, values);
    if (!safePath(to))
      return wrong(
        `files: ${to} isn’t a path in the checkout this can write (relative, no .., not in .git or ${DESIRED_DIR})`,
      );
    if (!Object.hasOwn(sources, f.from)) return wrong(`files: the template has no ${f.from}`);
    files.push({ path: to, text: fillIn(sources[f.from], values) });
  }

  const out = `${JSON.stringify(file, null, 2)}\n`;
  const checked = checkDesiredFile(out);
  if ('error' in checked)
    return wrong(
      `the template makes a file that doesn’t check (${checked.error.field ? `${checked.error.field}: ` : ''}${checked.error.message}): fix the template`,
    );
  return { ok: true, desiredPath: path, desired: out, created: desired === null, added, extended, files };
}
