/**
 * Rendering and checking a workflow from a template (BRK-90, BRK-307): `fill` puts a template's values in, and
 * `lintWorkflow` finds what GitHub (or actionlint) would refuse in the result. Pure and Node-safe, so `pipeline init`,
 * `infra init`, and the Worker (the board's change brings the apply workflow, src/infra-runner-render.js) render and
 * check the same way.
 */
import { parseYaml } from './yaml.js';

/** The secrets a rendered workflow may read: each lives in a GitHub environment only the default branch can use. */
const SECRETS = new Set(['CLOUDFLARE_API_TOKEN', 'NPM_TOKEN']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * A template with its values: `{{key}}` is replaced inline, a line that is only `{{@key}}` becomes the list's lines at
 * that indentation (none for an empty list), and lines between `{{#if key}}` and `{{/if}}` stay only when the value is
 * truthy.
 * @param {string} template
 * @param {Record<string, any>} values
 */
export function fill(template, values) {
  const out = [];
  const keep = [true];
  for (const line of template.split('\n')) {
    const cond = /^\s*\{\{#if (\w+)\}\}\s*$/u.exec(line);
    if (cond) {
      keep.push(keep.at(-1) && Boolean(values[cond[1]]));
      continue;
    }
    if (/^\s*\{\{\/if\}\}\s*$/u.test(line)) {
      if (keep.length === 1) throw new Error('{{/if}} without {{#if}}');
      keep.pop();
      continue;
    }
    if (!keep.at(-1)) continue;
    const list = /^(\s*)\{\{@(\w+)\}\}\s*$/u.exec(line);
    if (list) {
      const items = values[list[2]];
      if (!Array.isArray(items)) throw new Error(`{{@${list[2]}}} needs a list`);
      for (const item of items) out.push(`${list[1]}${item}`);
      continue;
    }
    out.push(
      line.replace(/(?<!\$)\{\{(\w+)\}\}/gu, (_, key) => {
        if (!(key in values)) throw new Error(`the template's {{${key}}} has no value`);
        return String(values[key]);
      }),
    );
  }
  if (keep.length !== 1) throw new Error('{{#if}} without {{/if}}');
  return out.join('\n');
}

const CONTEXTS = new Set([
  'github',
  'inputs',
  'secrets',
  'vars',
  'steps',
  'env',
  'job',
  'needs',
  'runner',
  'matrix',
  'strategy',
]);

/** The `${{ }}` expressions in a value, and the value itself when it's an `if:` (an expression without the braces). */
function expressionsIn(text, isIf) {
  const found = [...String(text).matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].map((m) => m[1]);
  if (isIf && !found.length) found.push(String(text));
  return found;
}

/** Every string under a value, with whether it's an `if:`. */
function stringsIn(value, key = '') {
  if (typeof value === 'string') return [{ text: value, isIf: key === 'if' }];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => stringsIn(v, k));
  return [];
}

/**
 * The problems GitHub (or actionlint) would find in a rendered workflow, as messages; none when it's sound. It parses
 * the YAML, then checks the shape (on, permissions, jobs with runs-on, a timeout, and steps), that every action is
 * pinned to a commit, that every expression names a context Actions has, a step that ran before, an input the workflow
 * takes, or a secret the pipeline uses, that secrets are read only in a job with an environment, that run scripts take
 * no `${{ }}` (they read env instead), and that nothing of the template is left over.
 * @param {string} text
 * @returns {string[]}
 */
export function lintWorkflow(text) {
  const problems = [];
  const leftover = text.replace(/\$\{\{[\s\S]*?\}\}/gu, '').match(/\{\{[#/@]?\w+\}\}/u);
  if (leftover) problems.push(`the template's ${leftover[0]} is left over`);
  let doc;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return [...problems, error.message];
  }
  if (typeof doc.name !== 'string' || !doc.name) problems.push('it has no name');
  if (!isObject(doc.on)) problems.push('it has no on: triggers');
  else if ('pull_request_target' in doc.on) problems.push('pull_request_target runs untrusted code with secrets');
  if (!isObject(doc.permissions) || Object.keys(doc.permissions).length)
    problems.push('the workflow sets permissions: {}, and each job asks for what it needs');
  if (!isObject(doc.jobs) || !Object.keys(doc.jobs).length) return [...problems, 'it has no jobs'];
  const inputs = Object.keys(doc.on?.workflow_dispatch?.inputs ?? {});
  for (const [name, input] of Object.entries(doc.on?.workflow_dispatch?.inputs ?? {}))
    if (!['string', 'boolean', 'choice', 'number', 'environment'].includes(input?.type))
      problems.push(`input ${name} has no type`);

  const checkExpressions = (strings, where, steps, jobLevel) => {
    for (const { text: value, isIf } of strings)
      for (const expression of expressionsIn(value, isIf)) {
        const code = expression.replace(/'(?:[^']|'')*'/gu, "''");
        for (const m of code.matchAll(/(?<![\w.-])([A-Za-z_][\w-]*)((?:\.[\w-]+)*)/gu)) {
          const [, context, path] = m;
          if (!path) {
            if (!/^\s*\(/u.test(code.slice(m.index + context.length)) && !['true', 'false', 'null'].includes(context))
              problems.push(`${where}: "${context}" isn't a context or a function`);
            continue;
          }
          const [first] = path.slice(1).split('.');
          if (!CONTEXTS.has(context)) problems.push(`${where}: no context "${context}"`);
          else if (context === 'secrets' && !SECRETS.has(first))
            problems.push(`${where}: the pipeline uses no secret ${first}`);
          else if (context === 'inputs' && !inputs.includes(first)) problems.push(`${where}: no input ${first}`);
          else if (context === 'steps' && !steps.includes(first))
            problems.push(`${where}: no step ${first} before this one`);
          else if (context === 'env' && jobLevel) problems.push(`${where}: env isn't available here`);
        }
      }
  };
  checkExpressions(stringsIn({ on: doc.on, env: doc.env, concurrency: doc.concurrency }), 'the workflow', [], false);

  for (const [jobName, job] of Object.entries(doc.jobs)) {
    const where = `job ${jobName}`;
    if (!isObject(job)) {
      problems.push(`${where} isn't a mapping`);
      continue;
    }
    if (!job['runs-on']) problems.push(`${where} has no runs-on`);
    if (typeof job['timeout-minutes'] !== 'number') problems.push(`${where} has no timeout-minutes`);
    if (!isObject(job.permissions)) problems.push(`${where} doesn't say its permissions`);
    for (const need of [job.needs ?? []].flat())
      if (!(need in doc.jobs)) problems.push(`${where} needs ${need}, which isn't a job`);
    const { steps = [], ...rest } = job;
    checkExpressions(stringsIn({ if: rest.if }), where, [], true);
    checkExpressions(stringsIn({ ...rest, if: undefined, outputs: undefined }), where, [], false);
    // A job's outputs read its steps once they've all run.
    const stepIds = Array.isArray(steps) ? steps.map((s) => s?.id).filter(Boolean) : [];
    checkExpressions(stringsIn({ outputs: rest.outputs }), `${where}'s outputs`, stepIds, false);
    if (stringsIn(job).some(({ text: value }) => /\bsecrets\./u.test(value)) && !job.environment)
      problems.push(`${where} reads a secret outside an environment`);
    if (!Array.isArray(steps) || !steps.length) {
      problems.push(`${where} has no steps`);
      continue;
    }
    const ids = [];
    steps.forEach((step, i) => {
      const at = `${where}, step ${i + 1}${step?.name ? ` (${step.name})` : ''}`;
      if (!isObject(step)) {
        problems.push(`${at} isn't a mapping`);
        return;
      }
      if ('uses' in step === 'run' in step) problems.push(`${at} has one of uses or run`);
      if ('uses' in step && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u.test(String(step.uses)))
        problems.push(`${at} uses ${step.uses}, which isn't pinned to a commit`);
      if (typeof step.run === 'string' && step.run.includes('${{'))
        problems.push(`${at} puts \${{ }} in its script: pass it through env`);
      checkExpressions(stringsIn(step), at, ids, false);
      if (step.id !== undefined) {
        if (ids.includes(step.id)) problems.push(`${at} repeats the id ${step.id}`);
        ids.push(String(step.id));
      }
    });
  }
  return problems;
}
