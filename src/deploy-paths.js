/**
 * Which Workers a set of changed files needs a deploy for. The Deploy workflow reads the same
 * file (`.github/deploy-paths.json`) to decide whether to deploy, so a merged pull request that
 * touches neither list never waits for a deploy that will never come.
 *
 * The default repository's file is built into the board: default-deploy-paths.json, a copy of the legacy install's
 * kept in the package so it builds on its own.
 * Another repository with a pipeline names its own file in the registry (`pipeline.deployPaths`), which
 * the sync reads from its default branch and compiles with `compileDeployPaths`
 * (docs/specs/IDEA-14-multi-repo.md, section 3).
 */
import DEPLOY_PATHS from './default-deploy-paths.json';

const MAX_WORKERS = 20;
const MAX_PATTERN = 2000;

/** `{ worker: "regex" }` → the patterns `workersFor` takes, or null when the file isn't that shape. */
export function compileDeployPaths(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const entries = Object.entries(json).slice(0, MAX_WORKERS);
  try {
    return entries.map(([worker, pattern]) => {
      if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN) throw new Error('not a pattern');
      return [worker, new RegExp(pattern, 'u')];
    });
  } catch {
    return null;
  }
}

const PATTERNS = compileDeployPaths(DEPLOY_PATHS);

/** The Workers (by deploy environment) whose code the files change: `[]` when nothing needs a deploy. */
export function workersFor(files, patterns = PATTERNS) {
  return patterns
    .filter(([, pattern]) => files.some((file) => /** @type {RegExp} */ (pattern).test(file)))
    .map(([worker]) => worker);
}

/** Every Worker: what a pull request needs when its file list can't be trusted (too many files to read them all). */
export const allWorkers = (patterns = PATTERNS) => patterns.map(([worker]) => worker);

/** The legacy install's own patterns, built in. */
export const defaultDeployPaths = () => PATTERNS;
