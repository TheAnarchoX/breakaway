/**
 * `npx breakaway infra check` (docs/specs/IDEA-19-architect.md, "Desired state" and "CLI"; CLI-14), the pure part: it
 * checks a checkout's `.github/breakaway-infra/` folder before a pull request, the way `pipeline check` checks the
 * deploy config. Each environment's file goes through BRK-180's checkDesiredFile, `policy.json` through BRK-181's
 * checkPolicyFile, and `scaling.json` through BRK-241's checkScalingFile, so the CLI says what the board would: the file, the line, and the field that's wrong. The board's
 * preview (store-infra-check.js) then shows the plan a valid file would make, kept nowhere.
 *
 * Pure and Node-safe, so the CLI imports it: no store and no network.
 */
import { checkDesiredFile, DESIRED_DIR, environmentOfFile } from './infra-desired.js';
import { checkPolicyFile, POLICY_FILE } from './infra-policy.js';
import { checkScalingFile, SCALING_FILE } from './infra-scaling.js';

/** How many previews one repository asks the board for a minute: each one asks the provider for a plan. */
export const CHECK_PER_MINUTE = 10;

/**
 * One file's result. `kind` is `desired` (an environment's file), `policy`, `scaling`, `skipped` (not JSON, or
 * reserved for a later piece), or `problem` (a name no environment could have).
 * @typedef {object} FileCheck
 * @property {string} path the file's path in the repository
 * @property {'desired' | 'policy' | 'scaling' | 'skipped' | 'problem'} kind
 * @property {string | null} environment the environment it's for, when it's an environment's
 * @property {boolean} ok
 * @property {import('./infra-desired.js').DesiredError | null} error
 * @property {number} [resources] how many resources a valid desired state declares
 * @property {number} [rules] how many rules a valid scaling file holds
 */

/**
 * Checks the folder's files, by name and text, in name order. `policy.json` is checked as the policy and
 * `scaling.json` as the scaling rules; every other `.json` file is an environment's.
 * @param {{ name: string, text: string }[]} files the folder's files, without the folder in their names
 * @returns {{ ok: boolean, files: FileCheck[] }}
 */
export function checkInfraFolder(files) {
  /** @type {FileCheck[]} */
  const out = [];
  for (const { name, text } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${DESIRED_DIR}/${name}`;
    if (name === POLICY_FILE) {
      const checked = checkPolicyFile(text);
      out.push({
        path,
        kind: 'policy',
        environment: null,
        ok: checked.ok,
        error: 'error' in checked ? checked.error : null,
      });
      continue;
    }
    if (name === SCALING_FILE) {
      const checked = checkScalingFile(text);
      out.push({
        path,
        kind: 'scaling',
        environment: null,
        ok: checked.ok,
        error: 'error' in checked ? checked.error : null,
        ...('rules' in checked ? { rules: checked.rules.length } : {}),
      });
      continue;
    }
    const of = environmentOfFile(name);
    if (of === null) {
      out.push({ path, kind: 'skipped', environment: null, ok: true, error: null });
      continue;
    }
    if ('problem' in of) {
      out.push({
        path,
        kind: 'problem',
        environment: null,
        ok: false,
        error: { line: null, field: null, message: of.problem },
      });
      continue;
    }
    const checked = checkDesiredFile(text);
    out.push({
      path,
      kind: 'desired',
      environment: of.environment,
      ok: checked.ok,
      error: 'error' in checked ? checked.error : null,
      ...('desired' in checked ? { resources: checked.desired.resources.length } : {}),
    });
  }
  return { ok: out.every((f) => f.ok), files: out };
}

/**
 * Where a problem is and what to change, the way a compiler says it: `path:line: field: message`.
 * @param {string} path
 * @param {import('./infra-desired.js').DesiredError} error
 */
export function problemLine(path, error) {
  return `${path}${error.line ? `:${error.line}` : ''}: ${error.field ? `${error.field}: ` : ''}${error.message}`;
}
