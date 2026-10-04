/**
 * `npx breakaway pipeline init` and `pipeline check` (BRK-90, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md,
 * sections 2 and 2b): a repository's Deploy, Promote, and Roll back workflows, its deploy paths, and its package's
 * Release workflow, rendered from one config the repository owns, `.github/breakaway-pipeline.json`. The judgment goes
 * into the config; the files come from the templates in template/pipeline/, so every repository runs the same
 * workflows and a fix to a template reaches them with `pipeline init --update`.
 *
 * The config, the rendering, and the workflow checks are pure (files come through `read`), so they're tested without a
 * disk; `run` is the command, which reads and writes the checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = '.github/breakaway-pipeline.json';
export const DEPLOY_PATHS = '.github/deploy-paths.json';
/** The first line of every workflow the renderer writes: how `--update` knows a file is its own to replace. */
export const HEADER = `Rendered by npx breakaway pipeline init from ${CONFIG_PATH}: change that file and run npx breakaway pipeline init --update, not this one.`;
/** The templates, and where each lands in the repository. */
export const WORKFLOWS = {
  deploy: '.github/workflows/deploy.yml',
  promote: '.github/workflows/promote.yml',
  rollback: '.github/workflows/rollback.yml',
  release: '.github/workflows/release.yml',
};
/** The helpers the rendered workflows run, which `repos init` copies (RELEASE_ENTRIES in scripts/tasks/init.js). */
export const HELPERS = {
  deploy: [
    'scripts/deploy-plan.mjs',
    'scripts/record-deployment.mjs',
    'scripts/release-artifact.mjs',
    'scripts/check-migrations.mjs',
  ],
  promote: [
    'scripts/deploy-plan.mjs',
    'scripts/promote-check.mjs',
    'scripts/record-deployment.mjs',
    'scripts/release-artifact.mjs',
    'scripts/release-notes.mjs',
  ],
  rollback: ['scripts/deploy-plan.mjs', 'scripts/record-deployment.mjs'],
  release: ['scripts/deploy-plan.mjs', 'scripts/package-release.mjs'],
};
/** The secrets a rendered workflow may read: each lives in a GitHub environment only the default branch can use. */
const SECRETS = new Set(['CLOUDFLARE_API_TOKEN', 'NPM_TOKEN']);

/** A config's or a workflow's mistake, in words the owner or the agent can act on. */
export class PipelineError extends Error {}

const KEYS = [
  'workers',
  'wranglerEnv',
  'branch',
  'checks',
  'install',
  'build',
  'beforeDeploy',
  'deployPaths',
  'healthCheck',
  'package',
];
const WORKER = /^[\w.-]{1,100}$/u;
const WRANGLER_ENV = /^[\w-]{1,64}$/u;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

/** An example config, the one `pipeline init` prints when a repository has none. */
export const EXAMPLE = {
  workers: { staging: 'widgets-staging', production: 'widgets' },
  checks: ['CI'],
  install: 'npm ci',
  build: 'npm run build',
  beforeDeploy: ['npx wrangler d1 migrations apply DB --remote --env $BREAKAWAY_ENV'],
  deployPaths: { widgets: '^(src|public|migrations)/|^wrangler\\.jsonc$|^package(-lock)?\\.json$' },
  healthCheck: { staging: 'https://widgets-staging.example.workers.dev/', production: 'https://widgets.example.com/' },
  package: { name: 'widgets', directory: '.', access: 'public' },
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bad = (message) => {
  throw new PipelineError(message);
};

function objectOf(value, field, keys) {
  if (!isObject(value)) bad(`${field} is an object with ${keys.join(' and ')}.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) bad(`${field} has no "${key.slice(0, 40)}"; it has ${keys.join(' and ')}.`);
  return value;
}

/** A command the workflows run as it is: one line, and nothing Actions would expand first. */
function command(value, field) {
  if (typeof value !== 'string' || !value.trim()) bad(`${field} is a command, like "npm ci".`);
  if (/[\r\n]/u.test(value)) bad(`${field} is one line: put several commands in beforeDeploy, one each.`);
  if (value.length > 500) bad(`${field} is 500 characters at most: put a longer one in a script.`);
  if (value.includes('${{')) bad(`${field} can't hold \${{ … }}: Actions would expand it before the shell runs.`);
  return value.trim();
}

function url(value, field) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s"'`$\\]+$/u.test(value))
    bad(`${field} is an address to check after a deploy, like https://widgets-staging.example.workers.dev/.`);
  return value;
}

/**
 * The config, checked and with its defaults: the field that's wrong is named, and what it should be. `packageJson`
 * is the parsed package.json in the package's directory (null when there is none), read only when the config names a
 * package.
 * @param {any} raw
 * @param {{ packageJson?: (directory: string) => any }} [read]
 */
export function checkConfig(raw, { packageJson = () => null } = {}) {
  if (!isObject(raw)) bad(`${CONFIG_PATH} is a JSON object: npx breakaway pipeline init prints an example.`);
  for (const key of Object.keys(raw))
    if (!KEYS.includes(key)) bad(`${CONFIG_PATH} has no "${key.slice(0, 40)}"; it has ${KEYS.join(', ')}.`);
  if (raw.workers == null && raw.package == null)
    bad(
      `${CONFIG_PATH} needs workers (a staging and a production Worker to deploy), package (an npm package to release), or both.`,
    );

  let workers = null;
  if (raw.workers != null) {
    objectOf(raw.workers, 'workers', ['staging', 'production']);
    for (const key of ['staging', 'production'])
      if (typeof raw.workers[key] !== 'string' || !WORKER.test(raw.workers[key]))
        bad(
          `workers.${key} is the ${key} Worker's name: letters, digits, dots, hyphens, and underscores, like widgets${key === 'staging' ? '-staging' : ''}.`,
        );
    if (raw.workers.staging === raw.workers.production)
      bad('workers.staging and workers.production are two different Workers.');
    workers = { staging: raw.workers.staging, production: raw.workers.production };
  }

  const wranglerEnv = { staging: null, production: null };
  if (raw.wranglerEnv != null) {
    if (!workers) bad('wranglerEnv is for workers: leave it out when the repository deploys none.');
    objectOf(raw.wranglerEnv, 'wranglerEnv', ['staging', 'production']);
    for (const key of ['staging', 'production']) {
      const value = raw.wranglerEnv[key];
      if (value == null || value === '') continue;
      if (typeof value !== 'string' || !WRANGLER_ENV.test(value))
        bad(`wranglerEnv.${key} is the name of an environment in the wrangler config, like ${key}.`);
      wranglerEnv[key] = value;
    }
  }

  const branch = raw.branch ?? 'main';
  if (typeof branch !== 'string' || !BRANCH.test(branch)) bad('branch is the default branch, like main.');

  if (!Array.isArray(raw.checks) || !raw.checks.length)
    bad('checks names the workflows that must pass before a deploy or a release, like ["CI"]: the name: line of each.');
  if (raw.checks.length > 20) bad('checks names 20 workflows at most.');
  const checks = raw.checks.map((name, i) => {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n]|\$\{\{/u.test(name))
      bad(`checks[${i}] is a workflow's name, as its name: line says, like CI.`);
    return name.trim();
  });
  if (new Set(checks).size !== checks.length) bad('checks names each workflow once.');

  const install = command(raw.install ?? 'npm ci', 'install');
  const build = raw.build == null || raw.build === '' ? '' : command(raw.build, 'build');
  if (raw.beforeDeploy != null && !Array.isArray(raw.beforeDeploy))
    bad('beforeDeploy is a list of commands that run before each deploy, like ["npm run migrate"].');
  if (raw.beforeDeploy?.length && !workers)
    bad('beforeDeploy runs before a Worker deploys: leave it out when the repository deploys none.');
  const beforeDeploy = (raw.beforeDeploy ?? []).map((value, i) => command(value, `beforeDeploy[${i}]`));

  let deployPaths = null;
  if (workers) {
    if (!isObject(raw.deployPaths) || !Object.keys(raw.deployPaths).length)
      bad(
        'deployPaths says which files need a deploy, as { "<worker>": "<regular expression>" }: the board reads the same file.',
      );
    deployPaths = {};
    for (const [worker, pattern] of Object.entries(raw.deployPaths)) {
      if (!WORKER.test(worker)) bad(`deployPaths has "${worker.slice(0, 40)}", which isn't a Worker name.`);
      if (typeof pattern !== 'string' || !pattern || pattern.length > 2000)
        bad(`deployPaths.${worker} is a regular expression of the paths that need a deploy, like ^src/.`);
      try {
        new RegExp(pattern, 'u');
      } catch {
        bad(`deployPaths.${worker} isn't a regular expression: ${pattern.slice(0, 80)}`);
      }
      deployPaths[worker] = pattern;
    }
  } else if (raw.deployPaths != null) bad('deployPaths is for workers: leave it out when the repository deploys none.');

  const healthCheck = { staging: null, production: null };
  if (raw.healthCheck != null) {
    if (!workers) bad('healthCheck is for workers: leave it out when the repository deploys none.');
    if (typeof raw.healthCheck === 'string') healthCheck.staging = url(raw.healthCheck, 'healthCheck');
    else {
      objectOf(raw.healthCheck, 'healthCheck', ['staging', 'production']);
      for (const key of ['staging', 'production'])
        if (raw.healthCheck[key] != null && raw.healthCheck[key] !== '')
          healthCheck[key] = url(raw.healthCheck[key], `healthCheck.${key}`);
    }
  }

  let pkg = null;
  if (raw.package != null) {
    objectOf(raw.package, 'package', ['name', 'directory', 'access']);
    const { name, directory = '.', access = 'public' } = raw.package;
    if (typeof name !== 'string' || name.length > 214 || !PACKAGE.test(name))
      bad("package.name is the npm package's name, as its package.json says, like widgets or @acme/widgets.");
    const dir =
      typeof directory === 'string'
        ? directory
            .trim()
            .replace(/^\.\/+/u, '')
            .replace(/\/+$/u, '') || '.'
        : '';
    if (!dir || dir.startsWith('/') || dir.split('/').includes('..') || !/^[\w./@-]+$/u.test(dir))
      bad('package.directory is the folder of its package.json in this repository, like . or packages/widgets.');
    if (!['public', 'restricted'].includes(access))
      bad('package.access is public or restricted, as npm publish --access takes.');
    const json = packageJson(dir);
    const where = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (!isObject(json)) bad(`package.directory is ${dir}, but ${where} isn't there.`);
    if (json.name !== name)
      bad(`package.name is ${name}, but ${where} names ${json.name ?? 'no package'}: they have to be the same.`);
    if (json.private === true)
      bad(`${where} says "private": true, so npm won't take it: there is no release flow for it.`);
    if (typeof json.version !== 'string' || !VERSION.test(json.version))
      bad(`${where}'s version is ${json.version ?? 'missing'}: the release flow counts from a version like 1.0.0.`);
    pkg = { name, directory: dir, access };
  }

  return { workers, wranglerEnv, branch, checks, install, build, beforeDeploy, deployPaths, healthCheck, package: pkg };
}

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

const quote = (value) => JSON.stringify(value ?? '');

/** The values the templates take, from a checked config. */
export function valuesOf(config) {
  const { workers, wranglerEnv, branch, checks, install, build, beforeDeploy, healthCheck, package: pkg } = config;
  const envFlag = (name) => (name ? ` --env ${name}` : '');
  return {
    header: HEADER,
    branch: quote(branch),
    branchName: branch,
    checks: `[${checks.map(quote).join(', ')}]`,
    checksEnv: quote(JSON.stringify(checks)),
    install: [install],
    build: build ? [build] : [],
    beforeDeploy,
    staging: quote(workers?.staging),
    production: quote(workers?.production),
    stagingName: workers?.staging ?? '',
    productionName: workers?.production ?? '',
    stagingEnvFlag: envFlag(wranglerEnv.staging),
    productionEnvFlag: envFlag(wranglerEnv.production),
    healthStaging: quote(healthCheck.staging),
    healthProduction: quote(healthCheck.production),
    package: quote(pkg?.name),
    packageName: pkg?.name ?? '',
    packageDirectory: pkg?.directory ?? '.',
    directory: quote(pkg?.directory),
    access: quote(pkg?.access),
    prefix: quote(pkg ? (workers ? `${pkg.name}@` : 'v') : ''),
    prefixName: pkg ? (workers ? `${pkg.name}@` : 'v') : '',
  };
}

/**
 * The files a checked config renders to, as `[{ path, text }]`: the three Worker workflows and the deploy paths for
 * `workers`, and release.yml for `package`. `readTemplate(name)` gives template/pipeline/<name>.
 */
export function renderPipeline(config, readTemplate) {
  const values = valuesOf(config);
  const files = [];
  if (config.workers) {
    for (const name of ['deploy', 'promote', 'rollback'])
      files.push({ path: WORKFLOWS[name], text: fill(readTemplate(`${name}.yml`), values) });
    files.push({ path: DEPLOY_PATHS, text: `${JSON.stringify(config.deployPaths, null, 2)}\n` });
  }
  if (config.package) files.push({ path: WORKFLOWS.release, text: fill(readTemplate('release.yml'), values) });
  return files;
}

/** The helpers the rendered files run, which the repository needs too. */
export function helpersFor(config) {
  const names = [...(config.workers ? ['deploy', 'promote', 'rollback'] : []), ...(config.package ? ['release'] : [])];
  return [...new Set(names.flatMap((name) => HELPERS[name]))].sort();
}

// ---- the workflow checks -------------------------------------------------------------------

/**
 * The YAML the templates use, parsed: block mappings and sequences, `|` block scalars, `[a, b]` flow sequences, and
 * plain, single-, and double-quoted scalars. Anything else is an error with its line, so a broken render fails here
 * instead of on GitHub.
 * @param {string} text
 */
export function parseYaml(text) {
  const src = text.split('\n');
  let pos = 0;
  const fail = (message, at = pos) => bad(`line ${at + 1}: ${message}`);
  src.forEach((line, i) => {
    if (/^\s*\t/u.test(line)) fail('a tab in the indentation; YAML indents with spaces', i);
  });
  const indentOf = (line) => line.length - line.trimStart().length;
  const blank = (line) => !line.trim() || line.trim().startsWith('#');
  const skip = () => {
    while (pos < src.length && blank(src[pos])) pos += 1;
  };
  const isItem = (t) => t === '-' || t.startsWith('- ');
  const KEY = /^("[^"]*"|'[^']*'|[^\s'"#[\]{}&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?):(?:\s+(.*))?$/u;

  function scalar(raw) {
    const s = raw.trim();
    if (!s) return null;
    if (s[0] === '"') {
      let end = 1;
      while (end < s.length && s[end] !== '"') end += s[end] === '\\' ? 2 : 1;
      if (end >= s.length) fail('a double-quoted string that never ends');
      const rest = s.slice(end + 1).trim();
      if (rest && !rest.startsWith('#')) fail(`text after a quoted string: ${rest.slice(0, 40)}`);
      return JSON.parse(s.slice(0, end + 1));
    }
    if (s[0] === "'") {
      const m = /^'((?:[^']|'')*)'\s*(#.*)?$/u.exec(s);
      if (!m) fail('a single-quoted string that never ends, or text after it');
      return m[1].replace(/''/gu, "'");
    }
    if (s[0] === '[') {
      const end = s.indexOf(']');
      if (end < 0) fail('a [list] that never ends');
      const rest = s.slice(end + 1).trim();
      if (rest && !rest.startsWith('#')) fail(`text after a [list]: ${rest.slice(0, 40)}`);
      const inner = s.slice(1, end).trim();
      return inner ? (inner.match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/gu) ?? []).map((item) => scalar(item)) : [];
    }
    if (s === '{}') return {};
    if (/^[{&*!|>%@`]/u.test(s)) fail(`a value the templates don't use: ${s.slice(0, 40)}`);
    const plain = s.replace(/\s+#.*$/u, '');
    if (/:\s/u.test(plain) || plain.endsWith(':'))
      fail(`a plain value can't hold ": " (quote it): ${plain.slice(0, 60)}`);
    if (plain === 'true' || plain === 'false') return plain === 'true';
    if (/^-?\d+$/u.test(plain)) return Number(plain);
    return plain;
  }

  function blockScalar(parent) {
    const lines = [];
    let indent = null;
    while (pos < src.length) {
      const line = src[pos];
      if (!line.trim()) {
        lines.push('');
        pos += 1;
        continue;
      }
      const n = indentOf(line);
      if (n <= parent) break;
      indent ??= n;
      if (n < indent) fail('a line of the block less indented than its first');
      lines.push(line.slice(indent));
      pos += 1;
    }
    while (lines.length && lines.at(-1) === '') lines.pop();
    if (!lines.length) fail('an empty block', pos - 1);
    return `${lines.join('\n')}\n`;
  }

  function entry(obj, content, indent) {
    const m = KEY.exec(content);
    if (!m) fail(`expected "key: value": ${content.slice(0, 60)}`);
    const key = /^["']/u.test(m[1]) ? m[1].slice(1, -1) : m[1].trim();
    if (Object.hasOwn(obj, key)) fail(`"${key}" twice in one mapping`);
    const rest = (m[2] ?? '').trim();
    if (rest && !rest.startsWith('#') && !/^\|-?(\s+#.*)?$/u.test(rest)) {
      if (rest.startsWith('>')) fail('folded blocks (>) are not used here: use |');
      obj[key] = scalar(rest);
      pos += 1;
      return;
    }
    pos += 1;
    if (!rest || rest.startsWith('#')) {
      skip();
      const next = src[pos];
      if (next !== undefined && indentOf(next) === indent && isItem(next.trim())) obj[key] = sequence(indent);
      else obj[key] = block(indent + 1);
    } else obj[key] = blockScalar(indent);
  }

  function mapping(indent, obj = {}) {
    for (;;) {
      skip();
      if (pos >= src.length) return obj;
      const n = indentOf(src[pos]);
      if (n < indent) return obj;
      if (n > indent) fail('more indented than the lines before it');
      const t = src[pos].trim();
      if (isItem(t)) return obj;
      entry(obj, t, indent);
    }
  }

  function sequence(indent) {
    const list = [];
    for (;;) {
      skip();
      if (pos >= src.length) return list;
      const n = indentOf(src[pos]);
      if (n < indent) return list;
      if (n > indent) fail('more indented than the lines before it');
      const t = src[pos].trim();
      if (!isItem(t)) return list;
      const content = t.slice(1).trimStart();
      const at = n + (t.length - content.length);
      if (!content) {
        pos += 1;
        list.push(block(indent + 1));
      } else if (KEY.test(content) && !/^["'[]/u.test(content.split(':')[0])) {
        const obj = {};
        entry(obj, content, at);
        list.push(mapping(at, obj));
      } else {
        list.push(scalar(content));
        pos += 1;
      }
    }
  }

  function block(min) {
    skip();
    if (pos >= src.length) return null;
    const n = indentOf(src[pos]);
    if (n < min) return null;
    return isItem(src[pos].trim()) ? sequence(n) : mapping(n);
  }

  const doc = block(0);
  skip();
  if (pos < src.length) fail('a line outside the document');
  return doc ?? {};
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
    checkExpressions(stringsIn({ ...rest, if: undefined }), where, [], false);
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

/** The run scripts of a parsed workflow, `[{ where, script }]`, for a shell's syntax check. */
export function runScripts(text) {
  const doc = parseYaml(text);
  return Object.entries(doc.jobs ?? {}).flatMap(([job, { steps = [] }]) =>
    steps
      .filter((s) => typeof s.run === 'string')
      .map((s, i) => ({ where: `${job}: ${s.name ?? `step ${i + 1}`}`, script: s.run })),
  );
}

// ---- the command ---------------------------------------------------------------------------

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'template', 'pipeline');

/**
 * What `pipeline init` does with each rendered file, given what the repository has there (`readTarget`, null when
 * nothing): write it, leave it (already the same), or refuse it (a file of the repository's own, or one rendered
 * before when `update` isn't set).
 * @param {Array<{ path: string, text: string }>} files
 * @param {(path: string) => string | null} readTarget
 * @param {{ update?: boolean }} [options]
 */
export function initPlan(files, readTarget, { update = false } = {}) {
  const write = [];
  const same = [];
  const refused = [];
  for (const file of files) {
    const there = readTarget(file.path);
    if (there === null) write.push(file);
    else if (there === file.text) same.push(file.path);
    else if (!update)
      refused.push({
        path: file.path,
        reason: 'it differs from what the config renders: run pipeline init --update to replace it',
      });
    else if (file.path === DEPLOY_PATHS || there.startsWith(`# ${HEADER}`)) write.push(file);
    else
      refused.push({
        path: file.path,
        reason:
          "it's the repository's own, not rendered: move what it does into the config, or rename it, then run pipeline init again",
      });
  }
  return { write, same, refused };
}

/** The checkout's top folder, or the folder the command runs in. */
function topOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

/** The repository's config, checked, and the files it renders. */
export function loadPipeline(root, templates = TEMPLATES) {
  const at = join(root, CONFIG_PATH);
  if (!existsSync(at))
    bad(
      `${CONFIG_PATH} isn't here. Write it, like this example (workers, package, or both), then run this again:\n${JSON.stringify(EXAMPLE, null, 2)}`,
    );
  let raw;
  try {
    raw = JSON.parse(readFileSync(at, 'utf8'));
  } catch (error) {
    bad(`${CONFIG_PATH} isn't JSON: ${error.message}`);
  }
  const config = checkConfig(raw, {
    packageJson: (dir) => {
      try {
        return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      } catch {
        return null;
      }
    },
  });
  return { config, files: renderPipeline(config, (name) => readFileSync(join(templates, name), 'utf8')) };
}

const readIn = (root) => (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);

/**
 * `npx breakaway pipeline init [--update] [--dry-run]` and `pipeline check`, in the checkout the command runs in.
 * @param {string[]} args
 * @param {Record<string, any>} opts
 * @param {{ cwd?: string, log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {number} the exit code
 */
export function run(args, opts, { cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  const [step] = args;
  const root = topOf(cwd);
  try {
    if (step !== 'init' && step !== 'check')
      bad('pipeline has init and check. npx breakaway help says what each does.');
    const { config, files } = loadPipeline(root);
    const read = readIn(root);
    const problems = files
      .filter((f) => f.path.endsWith('.yml'))
      .flatMap((f) => lintWorkflow(f.text).map((p) => `${f.path}: ${p}`));
    if (problems.length) bad(`The rendered workflows have problems, so nothing was written:\n${problems.join('\n')}`);
    const missing = helpersFor(config).filter((path) => read(path) === null);
    const helpersLine = missing.length
      ? `The workflows run ${missing.join(', ')}, which this repository doesn't have yet: npx breakaway repos init <slug> --update copies them.`
      : null;
    if (step === 'check') {
      const stale = files.filter((f) => read(f.path) !== f.text).map((f) => f.path);
      const orphan = !config.package && read(WORKFLOWS.release)?.startsWith(`# ${HEADER}`) ? [WORKFLOWS.release] : [];
      if (stale.length || orphan.length || missing.length) {
        for (const path of stale)
          error(`${path} isn't what ${CONFIG_PATH} renders: run npx breakaway pipeline init --update.`);
        for (const path of orphan) error(`${path} was rendered for a package the config no longer names: delete it.`);
        if (helpersLine) error(helpersLine);
        return 1;
      }
      log(`${CONFIG_PATH} is sound, and ${files.map((f) => f.path).join(', ')} are what it renders.`);
      return 0;
    }
    const plan = initPlan(files, read, { update: Boolean(opts.update) });
    if (!opts['dry-run'])
      for (const file of plan.write) {
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        writeFileSync(join(root, file.path), file.text);
      }
    const verb = opts['dry-run'] ? 'Would write' : 'Wrote';
    for (const file of plan.write) log(`${verb} ${file.path}`);
    for (const path of plan.same) log(`${path} is already current`);
    for (const { path, reason } of plan.refused) error(`Left ${path}: ${reason}.`);
    if (helpersLine) log(helpersLine);
    return plan.refused.length ? 1 : 0;
  } catch (e) {
    if (!(e instanceof PipelineError)) throw e;
    error(`pipeline: ${e.message}`);
    return 1;
  }
}
