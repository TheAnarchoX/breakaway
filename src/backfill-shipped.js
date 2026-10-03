/**
 * Merged pull requests that reached production before the Deploy workflow recorded deploys as
 * GitHub Deployments (29 Sep 2026), so no deploy carries them on the board. Each is matched to the
 * first production deploy in WORK.md's deploy log whose commit has the pull request's merge in its
 * history (`git merge-base --is-ancestor`), and the tasks it closed show as shipped there (`CLD-45`).
 * A live deploy that later carries a pull request replaces its row.
 *
 * Only pull requests that change what runs in a Worker are here; the rest need no deploy.
 */
const samewave = (version, sha, at) => ({ env: 'samewave', version, sha, at });

// From the deploy log. 37eacfb4's commit is a guess (it may include local changes).
const V_37EACFB4 = samewave('37eacfb4', '5b7c48894b1d9eb6624b1aab020d53c8127b23fa', '2026-09-29T00:59:00Z');
const V_4756548C = samewave('4756548c', 'f1a2af36c4b53aed20d63b0ce47abfd6c88ac227', '2026-09-29T11:13:00Z');
const V_29F6F9DF = samewave('29f6f9df', '25ef18ee2bf551fce359d435877ddd6dd0de5846', '2026-09-29T11:23:00Z');
// dc8f84fe (a52728b) failed its health check and rolled back, so #54 first reached production in this one.
const V_6BC4B273 = samewave('6bc4b273', '18bfc3da9f6636f5cb1535a488717e9a786b33fe', '2026-09-29T11:47:00Z');
// The task board's docs name this version, deployed from main at 8d545f8, as the first after these.
const TASKS_63546200 = {
  env: 'samewave-tasks',
  version: '63546200',
  sha: '8d545f8bde92c3a6f377c33c4066827797e2d974',
  at: '2026-09-29T10:17:00Z',
};

/** Pull request number → the deploy that first carried it. */
export const BACKFILL_SHIPPED = {
  29: V_37EACFB4,
  32: TASKS_63546200,
  33: V_37EACFB4,
  34: V_37EACFB4,
  35: V_37EACFB4,
  36: V_37EACFB4,
  37: V_37EACFB4,
  40: TASKS_63546200,
  42: V_4756548C,
  43: V_4756548C,
  49: V_4756548C,
  52: V_4756548C,
  53: V_29F6F9DF,
  54: V_6BC4B273,
  55: V_6BC4B273,
};
