/**
 * What the owner keeps (DOC-22): the files on their machine that hold the only copy of a value the board needs again.
 * The Secrets Store, Worker secrets, and the board never give a value back. init-secrets prints this list, and the
 * operations docs give a recovery for each (docs/tasks.md#what-to-keep). Names files only, never a value.
 *
 * @param {{ envFile: string, routinesFile: string, githubFile: string }} paths  as the owner should read them (~/…)
 * @returns {string[]}
 */
export function keepLines({ envFile, routinesFile, githubFile }) {
  const width = Math.max(envFile.length, routinesFile.length, githubFile.length) + 2;
  return [
    "Keep these in your password manager: the board can't give their values back (docs/tasks.md#what-to-keep).",
    `  ${envFile.padEnd(width)}the token, and the only copy of the sync secret`,
    `  ${routinesFile.padEnd(width)}once agents-connect --repo writes it: the other repositories' routines`,
    `  ${githubFile.padEnd(width)}only if github-connect writes it: the App's keys, until they're stored`,
  ];
}
