/**
 * Freeze and the deploy pause as one switch (BRK-235's decision; BRK-236). A pipeline's production environment is
 * frozen exactly when the repository variable `DEPLOYS_PAUSED` is `true`: freezing it on the board sets the variable
 * through the GitHub App, and setting it on GitHub by hand freezes production on the next sync. The Promote workflow
 * already refuses while it's `true`, and the board's Promote refuses on a frozen production; Roll back is never
 * refused. Freezing staging stops only Architect's plans: merges keep deploying it (30 Sep 2026).
 *
 * Pure, so the CLI can import it: the variable's name, how its value reads, the words, and which side wins on sync.
 */

/** The repository variable the Promote and Release workflows read. */
export const PAUSE_VARIABLE = 'DEPLOYS_PAUSED';

/** Whether a variable's value pauses deploys: only `true`, as the workflows read it. */
export const pausedValue = (value) => String(value ?? '').trim() === 'true';

/** Why the board's Promote waits on a frozen production. */
export const FROZEN_PROMOTE =
  'Production is frozen, so Promote waits. Unfreeze production on its environment page to promote; Roll back still works.';

/** What the owner is told when they freeze a pipeline's staging. */
export const STAGING_FREEZE_NOTE =
  'Merges keep deploying staging: freezing it stops Architect’s plans there, not deploys.';

/** The fix when the App can't read or write the variable. */
export const PAUSE_PERMISSION =
  'The board’s GitHub App needs read and write on Variables to sync the deploy pause: until then, the freeze holds on the board but not in the workflows.';

/**
 * Which side wins when the board's freeze and GitHub's `DEPLOYS_PAUSED` disagree on a sync. `last` is the value both
 * last agreed on (null before the first sync that read it). GitHub changed since then: the board follows it. The
 * board changed since then (its write didn't reach GitHub): the board writes it again. Neither known yet: the paused
 * side wins, so a sync never lifts a pause or a freeze nobody lifted.
 * @param {{ github: boolean, board: boolean, last: boolean | null }} state
 * @returns {'agree' | 'follow' | 'push'} follow: the board takes GitHub's value; push: GitHub takes the board's
 */
export function pauseSync({ github, board, last }) {
  if (github === board) return 'agree';
  if (last === null) return github ? 'follow' : 'push';
  return github !== last ? 'follow' : 'push';
}

/** The freeze's audit summary once the board tried to set the variable. */
export function pauseSummary(paused, { synced, error }) {
  if (synced) return `${PAUSE_VARIABLE} set to ${paused} on GitHub: Promote ${paused ? 'waits' : 'can run again'}.`;
  return `Couldn’t set ${PAUSE_VARIABLE} on GitHub (${error}): the freeze holds on the board, and the sync tries again.`;
}

/** The audit summary when the board follows a change made on GitHub. */
export const followSummary = (paused) =>
  paused
    ? `${PAUSE_VARIABLE} was set to true on GitHub, so production is frozen too.`
    : `${PAUSE_VARIABLE} was cleared on GitHub, so production is unfrozen too.`;
