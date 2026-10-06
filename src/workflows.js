/**
 * A repository's workflows that run by hand (BRK-224, docs/specs/BRK-223-run-workflows.md): which of a workflow
 * file's triggers is `workflow_dispatch`, the inputs it takes, and whether what the owner sent fits them. Pure, so
 * it's tested without GitHub; the reading and the run are in store-github.js.
 */
import { YamlError, parseYaml } from './yaml.js';

/** The input types `workflow_dispatch` takes; one without a type is a string, as GitHub reads it. */
export const INPUT_TYPES = ['string', 'boolean', 'choice', 'number', 'environment'];
/** GitHub takes at most 25 inputs on one run. */
export const MAX_INPUTS = 25;
export const MAX_VALUE = 1000;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (value === null || value === undefined ? null : String(value));

/**
 * @typedef {{ name: string, description: string | null, type: string, required: boolean,
 *   default: string | boolean | null, options: string[] | null }} WorkflowInput
 */

/** The top-level `on:` block of a file, alone, so a file whose jobs this reader can't parse still shows its inputs. */
function onBlock(source) {
  const lines = String(source).replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.findIndex((l) => /^(on|"on"|'on'):(\s|$)/u.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^[\s#]/u.test(lines[end]))) end += 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Whether a workflow file runs by hand, and its inputs, in the file's order: `null` when it has no `workflow_dispatch`
 * trigger; `{ readable: false }` when it names one but the board can't read the file's inputs (the board never
 * guesses them); else `{ readable: true, inputs }`.
 * @param {string} source
 * @returns {{ readable: true, inputs: WorkflowInput[] } | { readable: false, reason: string } | null}
 */
export function dispatchOf(source) {
  let doc;
  try {
    doc = parseYaml(source);
  } catch (error) {
    if (!(error instanceof YamlError)) throw error;
    const only = onBlock(source);
    try {
      doc = only === null ? null : parseYaml(only);
    } catch (inner) {
      if (!(inner instanceof YamlError)) throw inner;
      doc = null;
    }
    if (!doc) return /\bworkflow_dispatch\b/u.test(String(source)) ? { readable: false, reason: error.message } : null;
  }
  if (!isObject(doc)) return null;
  const on = doc.on;
  let dispatch;
  if (on === 'workflow_dispatch') dispatch = null;
  else if (Array.isArray(on) && on.includes('workflow_dispatch')) dispatch = null;
  else if (isObject(on) && Object.hasOwn(on, 'workflow_dispatch')) dispatch = on.workflow_dispatch;
  else return null;
  if (dispatch === null || dispatch === undefined || (isObject(dispatch) && !dispatch.inputs))
    return { readable: true, inputs: [] };
  if (!isObject(dispatch) || !isObject(dispatch.inputs))
    return { readable: false, reason: 'workflow_dispatch’s inputs aren’t a mapping' };
  /** @type {WorkflowInput[]} */
  const inputs = [];
  for (const [name, raw] of Object.entries(dispatch.inputs)) {
    const spec = raw ?? {};
    if (!isObject(spec)) return { readable: false, reason: `input ${name} isn’t a mapping` };
    const type = spec.type === undefined || spec.type === null ? 'string' : String(spec.type);
    if (!INPUT_TYPES.includes(type)) return { readable: false, reason: `input ${name} has type ${type}` };
    let options = null;
    if (type === 'choice') {
      if (
        !Array.isArray(spec.options) ||
        !spec.options.length ||
        spec.options.some((o) => isObject(o) || Array.isArray(o))
      )
        return { readable: false, reason: `choice input ${name} has no options` };
      options = spec.options.map((o) => String(o));
    }
    let fallback = null;
    if (spec.default !== undefined && spec.default !== null) {
      if (type === 'boolean') fallback = spec.default === true || spec.default === 'true';
      else fallback = String(spec.default);
    }
    inputs.push({
      name,
      description: text(spec.description),
      type,
      required: spec.required === true || spec.required === 'true',
      default: fallback,
      options,
    });
  }
  if (inputs.length > MAX_INPUTS) return { readable: false, reason: `it takes more than ${MAX_INPUTS} inputs` };
  return { readable: true, inputs };
}

/** A branch or tag a run may start on: GitHub's ref characters, never `..`, a leading `-` or `/`, or more than 255. */
export function validRef(ref) {
  return (
    typeof ref === 'string' &&
    /^[A-Za-z0-9._/-]{1,255}$/u.test(ref) &&
    !ref.includes('..') &&
    !/^[-/]/u.test(ref) &&
    !ref.endsWith('/')
  );
}

/**
 * What the owner sent for a run, checked against the inputs the board read: each value as the string GitHub takes,
 * or the first thing wrong with it. A required input left out is fine while it has a default (GitHub fills it in).
 * @param {WorkflowInput[]} wanted
 * @param {unknown} sent
 * @returns {{ inputs: Record<string, string> } | { error: string }}
 */
export function checkInputs(wanted, sent) {
  if (sent !== undefined && sent !== null && !isObject(sent))
    return { error: 'send the inputs as an object of names and values' };
  const given = /** @type {Record<string, unknown>} */ (sent ?? {});
  const names = Object.keys(given);
  if (names.length > MAX_INPUTS) return { error: `GitHub takes at most ${MAX_INPUTS} inputs` };
  const unknown = names.find((n) => !wanted.some((w) => w.name === n));
  if (unknown !== undefined)
    return { error: `this workflow takes no input named ${JSON.stringify(unknown.slice(0, 60))}` };
  /** @type {Record<string, string>} */
  const inputs = {};
  for (const input of wanted) {
    const raw = given[input.name];
    if (raw === undefined || raw === null || raw === '') {
      if (input.required && input.default === null) return { error: `${input.name} is required` };
      continue;
    }
    if (!['string', 'number', 'boolean'].includes(typeof raw)) return { error: `${input.name} takes one value` };
    const value = String(raw);
    if (value.length > MAX_VALUE) return { error: `${input.name} is longer than ${MAX_VALUE} characters` };
    if (input.type === 'boolean' && value !== 'true' && value !== 'false')
      return { error: `${input.name} is true or false` };
    if (input.type === 'number' && (!value.trim() || !Number.isFinite(Number(value))))
      return { error: `${input.name} is a number` };
    if (input.type === 'choice' && !input.options?.includes(value))
      return { error: `${input.name} is one of ${input.options?.join(', ')}` };
    inputs[input.name] = value;
  }
  return { inputs };
}

/**
 * Whether a delivery is a push to the default branch that changed a file under .github/workflows/, so the board reads
 * the repository's workflows that run by hand again (BRK-224). A push GitHub lists only part of counts as one.
 */
export function workflowsChanged(event, payload) {
  if (event !== 'push') return false;
  const branch = payload?.repository?.default_branch;
  if (!branch || payload.ref !== `refs/heads/${branch}`) return false;
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  if (commits.length >= 20 || (typeof payload.size === 'number' && payload.size > commits.length)) return true;
  return commits.some((c) =>
    ['added', 'modified', 'removed'].some((k) =>
      (Array.isArray(c?.[k]) ? c[k] : []).some((f) => String(f).startsWith('.github/workflows/')),
    ),
  );
}
