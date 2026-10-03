/**
 * What the owner's GitHub buttons can do in one repository, and why not (CLD-125): Update branch,
 * Merge, and Publish need the App to write pull requests and contents; Merge when green also needs
 * the repository to allow auto-merge; Promote and Roll back need it to start workflows (Actions).
 *
 * Read from the Connections view's last live check (store-connections.js, meta `conn_live`), so a
 * button that can't work says so before it's pressed. Pure, so it's tested without GitHub. While
 * nothing has been checked yet, everything is allowed and GitHub's own answer says what's wrong.
 */
import { comparePermissions } from './connections.js';

const allowed = { ok: true, reason: null };

/**
 * `check`: one repository's entry in the live check (`{ installed, suspended, permissions, autoMerge }`),
 * or null. `github`: its `owner/name`, for the messages. `at`: when it was checked (ms), or null.
 */
/**
 * @param {any} check
 * @param {{ github?: string, at?: number | null, pipeline?: boolean }} [options]
 */
export function pullAccess(check, { github, at = null, pipeline = false } = {}) {
  const checked = at ? new Date(at).toISOString() : null;
  if (!check || check.installed === null || check.installed === undefined)
    return { checked, write: allowed, autoMerge: allowed, actions: allowed };
  const blocked = (reason) => ({ ok: false, reason });
  if (check.installed === false) {
    const no = blocked(`The board’s GitHub App isn’t installed on ${github}. Install it there; Connections shows how.`);
    return { checked, write: no, autoMerge: no, actions: no };
  }
  if (check.suspended) {
    const no = blocked(`The board’s GitHub App is suspended on ${github}. Unsuspend it; Connections shows how.`);
    return { checked, write: no, autoMerge: no, actions: no };
  }
  const items = comparePermissions(check.permissions ?? {}, { pipeline });
  const missing = (names) => items.filter((p) => names.includes(p.name) && !p.ok).map((p) => p.label);
  const writeMissing = missing(['pull_requests', 'contents']);
  const write = writeMissing.length
    ? blocked(
        `The board’s GitHub App can’t write to ${github}: give it read and write on ${writeMissing.join(' and ')}. Connections shows the fix.`,
      )
    : allowed;
  let autoMerge = write;
  if (write.ok && check.autoMerge === false && !check.autoMergeError) {
    autoMerge = blocked(
      `Auto-merge is off on ${github}. Turn on “Allow auto-merge” in its settings on GitHub (General, Pull Requests).`,
    );
  }
  const actionsMissing = pipeline ? missing(['actions']) : [];
  const actions = actionsMissing.length
    ? blocked(
        `The board’s GitHub App can’t start workflows on ${github}: give it read and write on Actions. Connections shows the fix.`,
      )
    : allowed;
  return { checked, write, autoMerge, actions };
}
