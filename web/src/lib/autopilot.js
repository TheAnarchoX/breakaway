// What the owner's pull request settings (Keep branches up to date, Merge when green) would do to
// the open pull requests the board last synced. Pure, so it's tested in the Workers pool; the store
// sends the actions through the same cookie-only endpoints as the buttons on a pull request's page.

/** One try per action, pull request, and head commit: a new push gets a new try. */
export const actionKey = ({ action, number, sha }) => `${action}:${number}:${sha}`;

/**
 * The actions to take, in order: set merge when green before updating a branch, because the update
 * is a new head commit and both requests carry the one the board saw.
 * `skip` holds the pull requests the owner turned merge when green off on; `tried` the actionKeys
 * already sent from this tab (GitHub's answer shows on the next sync, not straight away).
 */
export function planPullActions(
  pulls,
  { keepUpdated = false, mergeWhenGreen = false, method = 'squash', skip = new Set(), tried = new Set() } = {},
) {
  const plan = [];
  const add = (step) => {
    if (!tried.has(actionKey(step))) plan.push(step);
  };
  for (const p of pulls ?? []) {
    if (p.state !== 'open' || p.draft || !p.headSha) continue;
    if (p.mergeable === false || p.mergeableState === 'dirty') continue; // conflicts are an agent's
    const sha = p.headSha;
    // A risky-path review holds it (BRK-280) until the author answers what blocks it.
    if (mergeWhenGreen && !skip.has(p.number) && !p.riskHold) {
      if (p.verdict === 'ready') add({ action: 'merge', number: p.number, sha, method });
      else if (!p.autoMerge) add({ action: 'auto-merge', number: p.number, sha, method });
    }
    if (keepUpdated && p.mergeableState === 'behind') add({ action: 'update-branch', number: p.number, sha });
  }
  return plan;
}
