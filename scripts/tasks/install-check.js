/**
 * The owner's commands that write an install's secrets (rotate-sync, rotate-token, github-connect, agents-connect,
 * repos remove) name them from the checkout's breakaway.config.json. In breakaway's own checkout that's the template's
 * defaults, and under npx in another repository the package's, so before writing, the CLI checks the config is the
 * board's own install, as the board's health reports it (BRK-95). Pure, so it's tested without a board.
 *
 * Asking the board takes the token. When the owner has lost it, rotate-token can't ask, so the owner names the install
 * instead (CLI-5): the Worker's name, or the Secrets Store's ID, has to match the config before anything is written.
 */

import { secretName } from '../../src/install.js';

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

/**
 * Where rotate-token writes the new token, as the checkout's config says: the Secrets Store's secret, or the Worker's.
 *
 * @param {{ worker: string, secretsPrefix: string, secretsStore: string | null }} local
 */
export function tokenTarget(local) {
  return local.secretsStore
    ? `${secretName(local, 'API_TOKEN')} in the Secrets Store ${local.secretsStore}, for the Worker ${local.worker}`
    : `the secret TASKS_API_TOKEN on the Worker ${local.worker}`;
}

/**
 * What rotate-token says when the board refused the token, or there's none (CLI-5): it can't ask the board which
 * install it is, so it says where it would write and what the owner confirms.
 *
 * @param {{ worker: string, secretsPrefix: string, secretsStore: string | null }} local
 * @param {{ configFile: string, token: boolean }} where  `token`: whether there was a token the board refused
 * @returns {string}
 */
export function unverifiedInstall(local, { configFile, token }) {
  return [
    token
      ? "The board refused this machine's token, so rotate-token can't ask it which install it is."
      : "There's no token on this machine, so rotate-token can't ask the board which install it is.",
    `${configFile} says the new token goes in ${tokenTarget(local)}.`,
    `If that's this board, confirm with the Worker's name${local.secretsStore ? " or the Secrets Store's ID" : ''}; if it isn't, stop and run this from the checkout the board deploys from.`,
  ].join('\n');
}

/**
 * Whether the owner's answer names the install the config describes: the Worker's name, or with a Secrets Store, its ID.
 * Without a match nothing is written.
 *
 * @param {{ worker: string, secretsStore: string | null }} local
 * @param {string | null | undefined} answer
 * @param {{ configFile: string }} where
 * @returns {{ ok: boolean, message?: string }}
 */
export function confirmInstall(local, answer, { configFile }) {
  const given = String(answer ?? '').trim();
  if (given && (given === local.worker || (local.secretsStore && given === local.secretsStore))) return { ok: true };
  return {
    ok: false,
    message: given
      ? `"${given.slice(0, 64)}" isn't the Worker ${local.worker}${local.secretsStore ? ` or the Secrets Store ${local.secretsStore}` : ''} that ${configFile} names, so nothing was written. Run npx breakaway rotate-token from the checkout the board deploys from.`
      : `rotate-token needs the Worker's name to confirm, so nothing was written.`,
  };
}
