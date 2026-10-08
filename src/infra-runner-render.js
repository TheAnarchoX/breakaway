/**
 * The apply workflow, rendered (CLI-12, BRK-307; docs/specs/IDEA-19-architect.md, "Executor"):
 * `.github/workflows/breakaway-infra.yml` from template/infra/apply.yml, for every environment with a desired-state
 * file. `npx breakaway infra init` writes it in a checkout, and the board's change brings it in the same commit as the
 * desired state (store-infra-changes.js), so both render byte-identical files from the same template: the CLI reads
 * it from disk, the Worker from src/infra-runner-template.json, which scripts/board-files.mjs generates from it.
 *
 * Pure and Node-safe: no store, no network, no disk.
 */
import { DESIRED_DIR, environmentOfFile } from './infra-desired.js';
import { RUNNER_WORKFLOW } from './infra-runner.js';
import { SHORT_LIVED_FILE } from './infra-short-lived.js';
import { fill, lintWorkflow } from './workflow-render.js';

/** Where the template is, in breakaway's own files. */
export const RUNNER_TEMPLATE = 'template/infra/apply.yml';

/** The first line of the rendered workflow: how `--update`, and the board, know the file is theirs to replace. */
export const RUNNER_RENDER_HEADER = `Rendered by npx breakaway infra init from the environments in ${DESIRED_DIR}/: add one there and run npx breakaway infra init --update, not this file.`;

/** What the change card and the plan check say when the board couldn't bring the workflow itself. */
export const RUNNER_NEEDS_WORKFLOWS = `Applying needs ${RUNNER_WORKFLOW}: give the board’s GitHub App Workflows: write and propose again, or run npx breakaway infra init in the repository and merge it.`;

/** The same, for a pull request the board didn't write, where proposing again isn't the way. */
export const RUNNER_NEEDS_INIT = `Applying needs ${RUNNER_WORKFLOW}: run npx breakaway infra init in the repository and merge it.`;

const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u;

/** A reason the workflow can't be rendered, in words for the owner or the agent. */
export class RunnerRenderError extends Error {}
const bad = (message) => {
  throw new RunnerRenderError(message);
};

/**
 * The environments the runner offers, from the file names in the desired-state folder: each `<environment>.json`,
 * sorted, skipping policy.json, scaling.json, and anything that isn't JSON.
 * @param {string[]} names
 */
export function environmentsIn(names) {
  const environments = new Set();
  for (const name of names) {
    const found = environmentOfFile(name);
    if (!found) continue;
    if ('problem' in found) throw new RunnerRenderError(`${DESIRED_DIR}/${found.problem}.`);
    environments.add(found.environment);
  }
  if (!environments.size)
    bad(
      `${DESIRED_DIR}/ has no environment's file, so there's nothing to apply to: write <environment>.json for each (like staging.json), then run this again.`,
    );
  return [...environments].sort();
}

/**
 * The runner's workflow for these environments, applied from `branch`, running breakaway `version`. With `shortLived`
 * (the folder has short-lived.json), the environment is any name, since each short-lived one is new, and the run may
 * name the GitHub environment that holds the write token: `short-lived` for all of them (BRK-242).
 * @param {{ environments: string[], branch: string, version: string, shortLived?: boolean }} input
 * @param {string} template template/infra/apply.yml
 * @returns {{ path: string, text: string }}
 */
export function renderRunner({ environments, branch, version, shortLived = false }, template) {
  if (!BRANCH.test(branch)) bad(`${branch.slice(0, 80)} isn't a branch's name.`);
  if (!VERSION.test(version)) bad(`${version} isn't a breakaway release.`);
  const text = fill(template, {
    header: RUNNER_RENDER_HEADER,
    branchName: branch,
    version,
    shortLived,
    fixedOnly: !shortLived,
    environments: environments.map((name) => `- ${JSON.stringify(name)}`),
  });
  const problems = lintWorkflow(text);
  if (problems.length) throw new Error(`${RUNNER_WORKFLOW} renders with problems: ${problems.join('; ')}`);
  return { path: RUNNER_WORKFLOW, text };
}

/** Whether a workflow's text is the board's own render, which `--update` and the board may replace. */
export const isRenderedRunner = (text) => String(text ?? '').startsWith(`# ${RUNNER_RENDER_HEADER}`);

/**
 * What to do with the rendered file, given what's there (null when nothing): write it, leave it (the same), or refuse
 * it (the repository's own, or rendered before when `update` isn't set).
 * @param {{ path: string, text: string }} file
 * @param {string | null} there
 * @param {{ update?: boolean }} [options]
 * @returns {{ write: boolean, same?: boolean, refused?: string }}
 */
export function runnerStep(file, there, { update = false } = {}) {
  if (there === null) return { write: true };
  if (there === file.text) return { write: false, same: true };
  if (!isRenderedRunner(there))
    return { write: false, refused: "it's the repository's own, not rendered: rename it, then run infra init again" };
  if (!update) return { write: false, refused: 'it differs from what infra init renders: run infra init --update' };
  return { write: true };
}

/**
 * What a change does with the apply workflow (BRK-307): the environments come from the desired-state folder's file
 * names on the default branch plus the environment the change writes, and the workflow is rendered for them.
 * - `add`: there's none; `update`: it's the board's own render and differs (an environment, the branch, or the
 *   release); the change commits `file` either way.
 * - `current`: it's already what the board renders.
 * - `own`: it's the repository's own, which the board never overwrites; `missing` names the environments it doesn't
 *   offer, as far as the board can tell.
 * @param {{ names: string[], environment: string, there: string | null, branch: string, version: string,
 *   template: string }} input
 * @returns {{ action: 'add' | 'update' | 'current' | 'own', file: { path: string, text: string },
 *   environments: string[], missing: string[] }}
 */
export function runnerChange({ names, environment, there, branch, version, template }) {
  const environments = environmentsIn([...names, `${environment}.json`]);
  const shortLived = names.includes(SHORT_LIVED_FILE);
  const file = renderRunner({ environments, branch, version, shortLived }, template);
  const out = { file, environments, missing: [] };
  if (there === null) return { ...out, action: 'add' };
  if (there === file.text) return { ...out, action: 'current' };
  if (isRenderedRunner(there)) return { ...out, action: 'update' };
  return { ...out, action: 'own', missing: runnerMissing(there, environments) };
}

/**
 * The environments a workflow doesn't offer: none when it takes any environment's name (an input of type string, as
 * the render does with short-lived environments, or a repository's own that the board can't read), else the ones not
 * among its environment input's choices.
 * @param {string} text
 * @param {string[]} environments
 * @returns {string[]}
 */
export function runnerMissing(text, environments) {
  const options = /\n {6}environment:\n(?: {8}.*\n)*? {8}options:\n((?: {10}- .*\n?)+)/u.exec(String(text ?? ''));
  if (!options) return [];
  const offered = new Set(
    options[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/u, '').trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return String(JSON.parse(value));
        } catch {
          return value.replace(/^['"]|['"]$/gu, '');
        }
      }),
  );
  return environments.filter((name) => !offered.has(name));
}

/** The words for an apply workflow the board left alone because it's the repository's own. */
export function runnerOwnWords(missing) {
  if (!missing.length) return null;
  return `${RUNNER_WORKFLOW} is the repository’s own, and it doesn’t offer ${missing.join(', ')}: add ${missing.length === 1 ? 'it' : 'them'} to its environment choices, or rename it and run npx breakaway infra init, then merge it.`;
}

/**
 * What a pull request's plan check says about the apply workflow (BRK-307), given the workflow at its head (null when
 * there's none) and the environments it plans: null when the workflow offers them all, else what to do before
 * Approve. A waiting note, never a failure.
 * @param {string | null} there
 * @param {string[]} environments
 * @returns {string | null}
 */
export function runnerNote(there, environments) {
  if (!environments.length) return null;
  if (there === null) return RUNNER_NEEDS_INIT;
  const missing = runnerMissing(there, environments);
  if (!missing.length) return null;
  if (!isRenderedRunner(there)) return runnerOwnWords(missing);
  return `${RUNNER_WORKFLOW} doesn’t offer ${missing.join(', ')} yet: run npx breakaway infra init --update in the repository and merge it.`;
}
