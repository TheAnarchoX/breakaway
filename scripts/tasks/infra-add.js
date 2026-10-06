/**
 * `npx breakaway infra add <template> [<environment>] [<input>=<value> …]` (CLI-15, docs/specs/IDEA-19-architect.md,
 * "Golden paths"): writes the change one of the owner's templates makes into the checkout, so an agent opens an
 * ordinary pull request. It adds to the environment's `.github/breakaway-infra/<environment>.json` and writes the
 * template's code files; it never asks the board for anything, and never plans or applies. The checks and the filling
 * in are src/infra-templates.js.
 *
 * Templates are found in the repository first, `.github/breakaway-infra/templates/<name>/template.json`, then among
 * the examples breakaway ships, template/infra/templates/<name>/, so the owner's own template of the same name wins.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIRED_DIR, environmentOfFile } from '../../src/infra-desired.js';
import {
  TEMPLATE_FILE,
  TEMPLATE_NAME,
  TEMPLATES_DIR,
  addFromTemplate,
  checkTemplate,
  inputValues,
} from '../../src/infra-templates.js';

/** The examples breakaway ships, beside the runner's workflow. */
export const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'template', 'infra', 'templates');

/**
 * Every template there is, by name: the repository's, then the shipped examples the repository doesn't override.
 * @param {string} root the checkout's top
 * @param {string} [shipped]
 * @returns {Array<{ name: string, dir: string, from: 'repository' | 'example' }>}
 */
export function findTemplates(root, shipped = SHIPPED) {
  /** @param {string} dir */
  const names = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && TEMPLATE_NAME.test(e.name) && existsSync(join(dir, e.name, TEMPLATE_FILE)))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  const own = names(join(root, TEMPLATES_DIR)).map((name) => ({
    name,
    dir: join(root, TEMPLATES_DIR, name),
    from: /** @type {const} */ ('repository'),
  }));
  const examples = names(shipped)
    .filter((name) => !own.some((t) => t.name === name))
    .map((name) => ({ name, dir: join(shipped, name), from: /** @type {const} */ ('example') }));
  return [...own, ...examples];
}

/** The environments that have a file in the checkout. @param {string} root */
function environmentsIn(root) {
  try {
    return readdirSync(join(root, DESIRED_DIR), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => environmentOfFile(e.name))
      .flatMap((x) => (x && 'environment' in x ? [x.environment] : []))
      .sort();
  } catch {
    return [];
  }
}

/** One line per template, with its title, or what's wrong with it. */
function listing(found) {
  return found.map((t) => {
    const checked = checkTemplate(readFileSync(join(t.dir, TEMPLATE_FILE), 'utf8'));
    const what = 'error' in checked ? `doesn’t check: ${checked.error}` : checked.template.title;
    return { name: t.name, from: t.from, ok: checked.ok, title: what };
  });
}

/**
 * Runs `infra add`. `code` is what the CLI exits with.
 * @param {string[]} args what follows `infra add`
 * @param {{ root: string, dryRun?: boolean, shipped?: string }} ctx
 * @returns {{ code: number, data: any, text: string }}
 */
export function infraAdd(args, { root, dryRun = false, shipped = SHIPPED }) {
  const found = findTemplates(root, shipped);
  const list = listing(found);
  const lines = list.map(
    (t) => `  ${t.name.padEnd(16)} ${t.title}${t.from === 'example' ? ' (breakaway’s example)' : ''}`,
  );
  const fail = (error, extra = {}) => ({ code: 1, data: { ok: false, error, ...extra }, text: error });
  const [name, ...rest] = args;
  if (!name)
    return {
      code: 0,
      data: { ok: true, templates: list },
      text: [
        'Templates (npx breakaway infra add <template> [<environment>] [<input>=<value> …]):',
        ...lines,
        '',
        `Keep your own in ${TEMPLATES_DIR}/<name>/${TEMPLATE_FILE}: one of the same name replaces breakaway’s example.`,
      ].join('\n'),
    };
  const t = found.find((x) => x.name === name);
  if (!t)
    return {
      code: 1,
      data: { ok: false, error: `no template ${name}`, templates: list },
      text: [`No template ${name}. There are:`, ...lines].join('\n'),
    };

  const checked = checkTemplate(readFileSync(join(t.dir, TEMPLATE_FILE), 'utf8'));
  const where = t.from === 'repository' ? `${TEMPLATES_DIR}/${name}/${TEMPLATE_FILE}` : `breakaway’s example ${name}`;
  if ('error' in checked) return fail(`${where} doesn’t check: ${checked.error}`);
  const { template } = checked;

  /** @type {Record<string, string>} */
  const given = {};
  const positional = [];
  for (const arg of rest) {
    const at = arg.indexOf('=');
    if (at > 0) given[arg.slice(0, at)] = arg.slice(at + 1);
    else positional.push(arg);
  }
  if (positional.length > 1) return fail(`infra add takes one environment, and got ${positional.join(', ')}`);
  const have = environmentsIn(root);
  let environment = positional[0];
  if (!environment) {
    if (have.length !== 1)
      return fail(
        have.length
          ? `name the environment: ${have.join(', ')} (npx breakaway infra add ${name} <environment> …)`
          : `name the environment, like staging (npx breakaway infra add ${name} staging …)`,
      );
    environment = have[0];
  }
  const env = environmentOfFile(`${environment}.json`);
  if (!env || 'problem' in env)
    return fail(`${environment} isn’t an environment’s name: lowercase letters, digits, and -, like staging`);

  const values = inputValues(template, given);
  if ('error' in values) return fail(`${name}: ${values.error}`);

  /** @type {Record<string, string>} */
  const sources = {};
  for (const f of template.files) {
    try {
      sources[f.from] = readFileSync(join(t.dir, f.from), 'utf8');
    } catch {
      return fail(`${where} names ${f.from}, and its folder has no such file`);
    }
  }
  const desiredFile = join(root, DESIRED_DIR, `${environment}.json`);
  const desired = existsSync(desiredFile) ? readFileSync(desiredFile, 'utf8') : null;
  const made = addFromTemplate({ template, values: values.values, environment, desired, sources });
  if ('error' in made) return fail(made.error);
  const taken = made.files.filter((f) => existsSync(join(root, f.path))).map((f) => f.path);
  if (taken.length)
    return fail(
      `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already there, and infra add never overwrites a file: pick another name`,
    );

  if (!dryRun) {
    mkdirSync(dirname(desiredFile), { recursive: true });
    writeFileSync(desiredFile, made.desired);
    for (const f of made.files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.text);
    }
  }
  const verb = dryRun ? 'Would' : '';
  const out = [
    `${dryRun ? 'Would change' : 'Changed'} ${made.desiredPath}${made.created ? ` (${dryRun ? 'made' : 'new'})` : ''}:`,
    ...made.added.map((a) => `  adds ${a}`),
    ...made.extended.map((e) => `  adds to ${e}`),
    ...made.files.map((f) => `${verb ? `${verb} write` : 'Wrote'} ${f.path}`),
    '',
    `Next: npx breakaway infra check ${environment}, then open a pull request. Nothing is applied until the owner approves the plan.`,
  ];
  return {
    code: 0,
    data: {
      ok: true,
      template: name,
      from: t.from,
      environment,
      values: values.values,
      dryRun,
      desired: { path: made.desiredPath, created: made.created, added: made.added, extended: made.extended },
      files: made.files.map((f) => f.path),
    },
    text: out.join('\n'),
  };
}
