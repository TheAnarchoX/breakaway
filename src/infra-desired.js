/**
 * Architect's desired state (docs/specs/IDEA-19-architect.md, "Desired state"; BRK-180): what should exist in one
 * environment, as code, one file per environment at `.github/breakaway-infra/<environment>.json` on the repository's
 * default branch (BRK-169). This module checks a file's text and says which line and field is wrong; the board's
 * sync (store-infra-desired.js) and `npx breakaway infra check` (CLI-14) both use it. Pure: no store, no network,
 * and it runs in Node as well as the Worker.
 *
 * A file is `{ "version": 1, "provider": "<id>", "resources": [ … ] }`: `resources` is BRK-173's DesiredState, each
 * one `{ id, kind, name, attrs? }`. `provider` is optional and, when given, must be the environment's. Nothing else
 * goes at the top level: policy (BRK-181) is `policy.json` and scaling rules (BRK-186) are `scaling.json` in the same
 * folder, so neither name is an environment's, and envelope bounds live on the board, never in the repository.
 */
import { checkDesired } from './infra-provider.js';
import { redact } from './redact.js';

/** The folder on the default branch, and where one environment's file is. */
export const DESIRED_DIR = '.github/breakaway-infra';
/** @param {string} environment */
export const desiredPath = (environment) => `${DESIRED_DIR}/${environment}.json`;
/**
 * Files in the folder that aren't an environment's: policy (BRK-181), scaling rules (BRK-186), and the template
 * short-lived environments are made from (BRK-200).
 */
export const RESERVED_FILES = ['policy', 'scaling', 'short-lived'];
/** The only version there is. */
export const DESIRED_VERSION = 1;
/** Bigger than any one environment needs, and small enough to keep a copy of each in the store. */
export const DESIRED_MAX_BYTES = 256 * 1024;
export const DESIRED_MAX_RESOURCES = 500;
/** How many files one read takes from the folder: an environment per file, and a repository has at most 50. */
export const DESIRED_MAX_FILES = 60;
/** How deep a file may nest: far more than any real one, and well inside the stack. */
export const MAX_DEPTH = 64;

const TOP = ['version', 'provider', 'resources'];
const RESOURCE = ['id', 'kind', 'name', 'attrs'];
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/u;
const KIND = /^[a-z][a-z0-9-]{0,39}$/u;
const ID_MAX = 200;
const RESOURCE_NAME_MAX = 200;

/**
 * What's wrong with a file: the line it's on (1-based, null when it's about the whole file), the field as a path
 * like `resources[2].kind` (null when it's the JSON itself), and what to change, in words.
 * @typedef {{ line: number | null, field: string | null, message: string }} DesiredError
 */

/**
 * The environment a file in the folder is for, from its name: `staging.json` is staging's. null for a file the check
 * skips (not `.json`, or a reserved one, RESERVED_FILES); `{ problem }` for one no environment could have.
 * @param {string} file the file's name, without the folder
 * @returns {{ environment: string } | { problem: string } | null}
 */
export function environmentOfFile(file) {
  const base = String(file ?? '');
  if (!base.endsWith('.json')) return null;
  const environment = base.slice(0, -'.json'.length);
  if (RESERVED_FILES.includes(environment)) return null;
  if (!NAME.test(environment))
    return {
      problem: `${base} isn’t an environment’s name: name the file after the environment, with lowercase letters, digits, and - (up to 40), like staging.json`,
    };
  return { environment };
}

class JsonError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

/**
 * Parses JSON, keeping the line each value starts on, by its path (`resources[0].kind`), so a check can say where a
 * field is. Refuses a key given twice, which JSON.parse would let through with the last one winning.
 * @param {string} text
 * @returns {{ value: unknown, lines: Map<string, number> }}
 */
export function parseWithLines(text) {
  const src = String(text);
  let i = 0;
  let line = 1;
  /** @type {Map<string, number>} */
  const lines = new Map();
  const fail = (message) => {
    throw new JsonError(message, line);
  };
  const space = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') line += 1;
      else if (c !== ' ' && c !== '\t' && c !== '\r') break;
      i += 1;
    }
  };
  const shown = () => (i >= src.length ? 'the end of the file' : `“${src[i]}”`);
  const string = () => {
    const start = i;
    i += 1;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\n') fail('a string runs past the end of its line: close it with "');
      i += src[i] === '\\' ? 2 : 1;
    }
    if (i >= src.length) fail('a string isn’t closed: end it with "');
    i += 1;
    try {
      return JSON.parse(src.slice(start, i));
    } catch {
      return fail('a string has an escape JSON doesn’t allow');
    }
  };
  const literal = () => {
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(src.slice(i, i + 400));
    if (!match) fail(`expected a value, and found ${shown()}`);
    i += match[0].length;
    return JSON.parse(match[0]);
  };
  /** @param {string} path @param {number} depth */
  const value = (path, depth = 0) => {
    // A file nested deeper than any real one would overflow the stack: it's refused with its line (BRK-229).
    if (depth > MAX_DEPTH) fail(`it’s nested more than ${MAX_DEPTH} deep`);
    space();
    lines.set(path, line);
    const c = src[i];
    if (c === '{') {
      i += 1;
      /** @type {Record<string, unknown>} */
      const out = {};
      space();
      if (src[i] === '}') {
        i += 1;
        return out;
      }
      for (;;) {
        space();
        if (src[i] !== '"') fail(`expected a key in quotes, and found ${shown()}`);
        const key = string();
        if (Object.hasOwn(out, key)) fail(`“${key}” is given twice: keep one`);
        space();
        if (src[i] !== ':') fail(`expected : after “${key}”, and found ${shown()}`);
        i += 1;
        // Defined, never assigned, so a key like __proto__ is a plain key and never the object's prototype.
        Object.defineProperty(out, key, {
          value: value(path ? `${path}.${key}` : key, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        if (src[i] === ',') {
          i += 1;
          continue;
        }
        if (src[i] === '}') {
          i += 1;
          return out;
        }
        fail(`expected , or } after “${key}”, and found ${shown()}`);
      }
    }
    if (c === '[') {
      i += 1;
      const out = [];
      space();
      if (src[i] === ']') {
        i += 1;
        return out;
      }
      for (;;) {
        out.push(value(`${path}[${out.length}]`, depth + 1));
        space();
        if (src[i] === ',') {
          i += 1;
          continue;
        }
        if (src[i] === ']') {
          i += 1;
          return out;
        }
        fail(`expected , or ] in a list, and found ${shown()}`);
      }
    }
    if (c === '"') return string();
    return literal();
  };
  const out = value('');
  space();
  if (i < src.length) fail(`expected the end of the file, and found ${shown()}`);
  return { value: out, lines };
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** Whether a value anywhere in `attrs` looks like a secret, by redact.js's patterns; its path, or null. */
function secretIn(value, path) {
  if (typeof value === 'string') return redact(value) === value ? null : path;
  if (Array.isArray(value)) {
    for (let n = 0; n < value.length; n += 1) {
      const found = secretIn(value[n], `${path}[${n}]`);
      if (found) return found;
    }
  } else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      const found = secretIn(v, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Checks one environment's desired-state file. The result is the desired state, or the first thing wrong with it,
 * with its line and field. With `provider` (the environment's adapter from the registry, when it's connected), each
 * resource's kind must be one it declares. With `expectProvider` (the environment's provider ID), a `provider` in the
 * file must be that one.
 * @param {string} source the file's text
 * @param {{ provider?: import('./infra-provider.js').Provider | null, expectProvider?: string | null, extra?: string[] }} [options]
 *   `extra` names more top-level keys a caller reads itself, like a short-lived template's `target` (BRK-200)
 * @returns {{ ok: true, desired: import('./infra-provider.js').DesiredState, provider: string | null } | { ok: false, error: DesiredError }}
 */
export function checkDesiredFile(source, { provider = null, expectProvider = null, extra = [] } = {}) {
  /** @param {string | null} field @param {string} message @param {number | null} [at] */
  const wrong = (field, message, at) => ({
    ok: /** @type {const} */ (false),
    error: { line: at ?? (field === null ? null : (lines.get(field) ?? null)), field, message },
  });
  /** @type {Map<string, number>} */
  let lines = new Map();
  const raw = String(source ?? '');
  if (new TextEncoder().encode(raw).length > DESIRED_MAX_BYTES)
    return wrong(null, `the file is over ${DESIRED_MAX_BYTES / 1024} KB: split what it declares, or trim it`);
  let file;
  try {
    ({ value: file, lines } = parseWithLines(raw));
  } catch (error) {
    if (error instanceof JsonError) return wrong(null, `it isn’t JSON: ${error.message}`, error.line);
    throw error;
  }
  if (!isObject(file))
    return wrong(null, 'the file is one JSON object: { "version": 1, "resources": [ … ] }', lines.get('') ?? 1);
  for (const key of Object.keys(file))
    if (!TOP.includes(key) && !extra.includes(key))
      return wrong(
        key,
        `“${key}” isn’t part of a desired state: the file has ${[...TOP, ...extra].join(', ').replace(/, (?=[^,]*$)/u, ', and ')}`,
      );
  if (file.version !== DESIRED_VERSION)
    return wrong(
      file.version === undefined ? null : 'version',
      `version is ${DESIRED_VERSION}: add "version": ${DESIRED_VERSION}`,
      file.version === undefined ? (lines.get('') ?? 1) : undefined,
    );
  let named = null;
  if (file.provider !== undefined) {
    if (typeof file.provider !== 'string' || !PROVIDER.test(file.provider))
      return wrong('provider', 'provider is the ID of the provider the environment runs on, like cloudflare');
    named = file.provider;
    if (expectProvider && named !== expectProvider)
      return wrong(
        'provider',
        `provider is ${named}, and the environment runs on ${expectProvider}: change one so they match`,
      );
  }
  if (!Array.isArray(file.resources))
    return wrong(
      file.resources === undefined ? null : 'resources',
      'resources is a list of what should exist: [ { "id": …, "kind": …, "name": … } ]',
      file.resources === undefined ? (lines.get('') ?? 1) : undefined,
    );
  if (file.resources.length > DESIRED_MAX_RESOURCES)
    return wrong('resources', `resources has ${file.resources.length}: at most ${DESIRED_MAX_RESOURCES}`);
  const ids = new Map();
  for (let n = 0; n < file.resources.length; n += 1) {
    const at = `resources[${n}]`;
    const r = file.resources[n];
    if (!isObject(r)) return wrong(at, 'each resource is an object with an id, a kind, and a name');
    for (const key of Object.keys(r))
      if (!RESOURCE.includes(key))
        return wrong(`${at}.${key}`, `“${key}” isn’t part of a resource: it has id, kind, name, and attrs`);
    if (!text(r.id) || r.id.length > ID_MAX)
      return wrong(
        r.id === undefined ? at : `${at}.id`,
        `id is the provider’s own ID for it, up to ${ID_MAX} characters`,
      );
    if (ids.has(r.id))
      return wrong(`${at}.id`, `${r.id} is listed twice: as resources[${ids.get(r.id)}] too. Keep one`);
    ids.set(r.id, n);
    if (typeof r.kind !== 'string' || !KIND.test(r.kind))
      return wrong(
        r.kind === undefined ? at : `${at}.kind`,
        'kind is the kind of resource, lowercase, like worker or database',
      );
    if (!text(r.name) || r.name.length > RESOURCE_NAME_MAX)
      return wrong(
        r.name === undefined ? at : `${at}.name`,
        `name is what the platform calls it, up to ${RESOURCE_NAME_MAX} characters`,
      );
    if (r.attrs !== undefined) {
      if (!isObject(r.attrs)) return wrong(`${at}.attrs`, 'attrs is an object of its settings');
      const secret = secretIn(r.attrs, `${at}.attrs`);
      if (secret)
        return wrong(
          secret,
          'this looks like a secret’s value: the repository is read by the board, so name the secret, never its value',
        );
    }
    if (provider && !provider.kinds[r.kind])
      return wrong(
        `${at}.kind`,
        `${provider.id} has no kind ${r.kind}: it has ${Object.keys(provider.kinds).sort().join(', ')}`,
      );
  }
  /** @type {import('./infra-provider.js').DesiredState} */
  const desired = {
    resources: file.resources.map(({ id, kind, name, attrs }) => ({ id, kind, name, ...(attrs ? { attrs } : {}) })),
  };
  if (provider) checkDesired(provider, desired);
  return { ok: true, desired, provider: named };
}
