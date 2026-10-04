/**
 * Turn on deploys (WEB-13, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 5): what a repository without
 * a pipeline has on its default branch once the move's pull request has merged. `.github/breakaway-pipeline.json`
 * (the config `npx breakaway pipeline init` renders from) names the Workers and the package; the workflows it
 * rendered sit in `.github/workflows/`. From those the board works out the pipeline one press would set, and says
 * what's missing when it can't. Pure, so it's tested without GitHub: store-github.js reads the files.
 */
import { InputError } from './model.js';
import { checkPipeline } from './repos.js';

/** Where the config and the rendered files live, as `pipeline init` writes them (scripts/tasks/pipeline.js). */
export const CONFIG_PATH = '.github/breakaway-pipeline.json';
export const DEPLOY_PATHS = '.github/deploy-paths.json';
export const WORKFLOWS_DIR = '.github/workflows';
/** The workflows each flow runs: a Worker's three, and a package's one. */
const WORKER_FLOWS = ['deploy', 'promote', 'rollback'];
const PACKAGE_FLOWS = ['release'];

/**
 * @typedef {{
 *   config: string,
 *   workers: { staging: string, production: string } | null,
 *   package: string | null,
 *   files: string[],
 *   missing: string[],
 *   pipeline: Record<string, any> | null,
 *   problem: string | null,
 * }} Found
 */

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fileOf = (flow) => `${WORKFLOWS_DIR}/${flow}.yml`;

/**
 * What the default branch says, from the config's text (null: not there) and the file names in `.github/` and
 * `.github/workflows/`. null when there is no config: the repository hasn't moved, so there's nothing to turn on.
 * Otherwise `pipeline` is what the press sets (null with the `problem` that stops it), checked as
 * `repos modify --pipeline` checks it, and `files` and `missing` say which of the rendered files are there.
 * @param {{ config: string | null, github?: string[], workflows?: string[] }} read
 * @returns {Found | null}
 */
export function pipelineFound({ config, github = [], workflows = [] }) {
  if (config === null || config === undefined) return null;
  /** @type {Found} */
  const found = {
    config: CONFIG_PATH,
    workers: null,
    package: null,
    files: [],
    missing: [],
    pipeline: null,
    problem: null,
  };
  let raw;
  try {
    raw = JSON.parse(config);
  } catch {
    raw = undefined;
  }
  if (!isObject(raw)) {
    found.problem = `${CONFIG_PATH} isn’t a JSON object. Run npx breakaway pipeline check in the repository to see what’s wrong.`;
    return found;
  }
  const workers = isObject(raw.workers) ? raw.workers : null;
  if (workers && typeof workers.staging === 'string' && typeof workers.production === 'string')
    found.workers = { staging: workers.staging, production: workers.production };
  if (isObject(raw.package) && typeof raw.package.name === 'string' && raw.package.name)
    found.package = raw.package.name;
  if (!found.workers && !found.package) {
    found.problem = `${CONFIG_PATH} names no Workers and no package. Run npx breakaway pipeline check in the repository to see what’s wrong.`;
    return found;
  }

  const flows = [...(found.workers ? WORKER_FLOWS : []), ...(found.package ? PACKAGE_FLOWS : [])];
  const names = new Set(workflows);
  for (const flow of flows) (names.has(`${flow}.yml`) ? found.files : found.missing).push(fileOf(flow));
  const deployPaths = found.workers && raw.deployPaths != null;
  if (deployPaths) (github.includes('deploy-paths.json') ? found.files : found.missing).push(DEPLOY_PATHS);
  if (found.missing.length) {
    found.problem = `Not on the default branch yet: ${found.missing.join(', ')}. Run npx breakaway pipeline init in the repository and merge what it writes.`;
    return found;
  }

  /** @type {Record<string, any>} */
  const pipeline = {};
  if (found.workers) pipeline.workers = found.workers;
  pipeline.workflows = Object.fromEntries(flows.map((f) => [f, `${f}.yml`]));
  if (deployPaths) pipeline.deployPaths = DEPLOY_PATHS;
  if (found.package) pipeline.package = found.package;
  try {
    found.pipeline = checkPipeline(pipeline);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    found.problem = `${CONFIG_PATH} doesn’t make a pipeline the board takes: ${error.message}. Run npx breakaway pipeline check in the repository.`;
  }
  return found;
}

/** Whether two pipelines are the same, so the press sets exactly the one the page showed. */
export const samePipeline = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value) {
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}
