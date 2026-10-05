/**
 * Before github-connect trades its code: whether the board already has a GitHub App (CLI-2). Each code comes
 * from a new App on GitHub, so a second run on a board that has one would overwrite the keys of the App that works
 * with a second App's. Read from the board's Connections report (`GET /api/connections`, its `github.app`
 * row). Pure, so it's tested without a board.
 */

/**
 * `ok` false stops the command before the code is traded (it still works, within its hour); `note` is what
 * a run that goes ahead says first.
 *
 * @param {{ connections?: { id: string, state: string, detail?: string, at?: string | null, link?: string | null }[] } | null | undefined} report
 * @param {{ replace: boolean }} options
 * @returns {{ ok: boolean, message?: string, note?: string }}
 */
export function appInPlace(report, { replace }) {
  const row = Array.isArray(report?.connections) ? report.connections.find((c) => c.id === 'github.app') : undefined;
  if (!row)
    return replace
      ? {
          ok: true,
          note: "Couldn't ask the board whether it already has a GitHub App; connecting a new one (--replace).",
        }
      : {
          ok: false,
          message:
            "couldn't ask the board whether it already has a GitHub App, so nothing was changed; the code still works within its hour. Check the board answers (npx breakaway connections), then run this again; or add --replace to connect a new App whatever is there.",
        };
  if (row.state === 'off') return { ok: true };
  const what = `${row.detail}${row.link ? `, ${row.link}` : ''}`;
  const deleteOld = `Once the new one works, delete the old one on GitHub (Settings → Developer settings → GitHub Apps)${row.link ? `: ${row.link}` : ''}.`;
  if (replace) return { ok: true, note: `Replacing the board's GitHub App (${what}). ${deleteOld}` };
  // Checked, and GitHub refused it: it doesn't work, so a new one takes its place.
  if (row.state === 'attention' && row.at)
    return {
      ok: true,
      note: `The board's GitHub App doesn't work (${row.detail}); connecting the new one in its place. ${deleteOld}`,
    };
  const kept =
    "Nothing was changed: this code's App would replace that one. If you made the new App by mistake, delete it on GitHub (Settings → Developer settings → GitHub Apps). To switch the board to it, run npx breakaway github-connect <code> --replace within the code's hour, then delete the old one.";
  if (row.state === 'working')
    return {
      ok: false,
      message: `the board already has a working GitHub App: ${what}. ${kept}`,
    };
  return {
    ok: false,
    message: `the board already has a GitHub App's keys (${what}); press Check now on its Connections view to see whether it works. ${kept}`,
  };
}
