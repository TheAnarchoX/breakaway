/**
 * The owner's commands that write an install's secrets (rotate-sync, rotate-token, github-connect, agents-connect,
 * repos remove) name them from the checkout's breakaway.config.json. In breakaway's own checkout that's the template's
 * defaults, and under npx in another repository the package's, so before writing, the CLI checks the config is the
 * board's own install, as the board's health reports it (BRK-95). Pure, so it's tested without a board.
 */

/** What the CLI compares, and how each is named when they differ. @type {[string, (v: any) => string][]} */
const FIELDS = [
  ['worker', (v) => `the Worker ${v}`],
  ['secretsPrefix', (v) => `secrets named ${v}…`],
  ['secretsStore', (v) => (v ? `the Secrets Store ${v}` : 'Worker secrets, no Secrets Store')],
];

/**
 * Whether `local` (the checkout's install config, parsed) is the board's install (`board`, health's `install`).
 * `ok` false stops the command before it writes anything; `warning` is for a board too old to say which it is.
 *
 * @param {{ worker: string, secretsPrefix: string, secretsStore: string | null }} local
 * @param {{ worker?: string, secretsPrefix?: string, secretsStore?: string | null, installRepository?: string | null } | null | undefined} board
 * @param {{ command: string, configFile: string }} where
 * @returns {{ ok: boolean, message?: string, warning?: string }}
 */
export function checkInstall(local, board, { command, configFile }) {
  if (!board || typeof board !== 'object')
    return {
      ok: true,
      warning: `the board doesn't say which install it is (it runs a release from before BRK-95), so ${command} can't check that ${configFile} is its config. Update the board when you can.`,
    };
  // A board deployed before its config carried the Secrets Store doesn't say which it uses: compare the rest.
  const differ = FIELDS.filter(([key]) => board[key] !== undefined && board[key] !== local[key]);
  if (!differ.length) return { ok: true };
  const describe = (side) => differ.map(([key, name]) => name(side[key])).join(', ');
  const from = board.installRepository
    ? `a checkout of ${board.installRepository}, the repository the board deploys from`
    : `the checkout whose breakaway.config.json is the board's (the Worker ${board.worker ?? 'it runs as'})`;
  return {
    ok: false,
    message: `${configFile} isn't this board's install: it says ${describe(local)}, and the board is ${describe(board)}. Nothing was written. Run npx breakaway ${command} from ${from}.`,
  };
}
