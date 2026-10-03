import { CLI_PACKAGE } from './init.js';

/**
 * Checks the CLI makes before and after it runs a command (CLD-193), kept pure so they're tested without a board.
 */

/** The subcommands each command knows. Without one, each lists or shows (horizon needs close). */
export const SUBCOMMANDS = {
  agents: ['next', 'start', 'refine'],
  repos: ['add', 'init', 'modify', 'remove', 'setup'],
  routines: ['add', 'modify', 'run', 'trigger', 'revoke', 'pause', 'resume'],
  horizon: ['close'],
  hook: ['session', 'wait'],
};

/** Commands that take nothing after their name, so a word there is a mistake (an old copy's missing subcommand, say). */
export const NO_ARGUMENTS = new Set([
  'list',
  'next',
  'activity',
  'github',
  'health',
  'connections',
  'export',
  'setup',
  'rotate-sync',
  'rotate-token',
  'agents-connect',
  'init-secrets',
]);

/**
 * Why `command first…` can't run, or null when it can: an unknown subcommand fails, naming the ones there
 * are, instead of quietly doing what the command does without one (CLD-192 ran repos remove on a copy that
 * had no remove, and it printed the repository list).
 */
export function unknownSubcommand(command, first) {
  if (first === undefined) return null;
  const known = SUBCOMMANDS[command];
  if (known && !known.includes(first))
    return `${command} has no "${String(first).slice(0, 40)}"; it has ${known.join(', ')}. npx breakaway help says what each does.`;
  if (NO_ARGUMENTS.has(command))
    return `${command} takes no "${String(first).slice(0, 40)}" (only options). npx breakaway help says what it takes.`;
  return null;
}

/**
 * What a CLI says about where it runs from, or null to say nothing (BRK-7). The CLI ships on npm, so `packaged` (run
 * through npx) has nothing to say. In a checkout of the board's own repository, `own` older than the board's (`board`,
 * its X-Tasks-Cli header) means pull. Anywhere else the CLI is an old copy that `repos init` used to commit: it
 * works while the API stays compatible, and on each run it says how to switch.
 */
export function staleCliWarning({ own, board, boardCheckout, slug, packaged = false }) {
  if (packaged) return null;
  const theirs = Number(board);
  const older = Number.isInteger(theirs) && theirs > own;
  if (boardCheckout) {
    if (!older) return null;
    return `this checkout's board CLI (version ${own}) is older than the board's (${theirs}), so a command may be missing or behave differently: pull the default branch to update it.`;
  }
  const newer = older ? `, older than the board's (${theirs}), so a command may be missing or behave differently` : '';
  return `this checkout carries a copy of the board's CLI (version ${own}${newer}). The CLI is on npm now: run it as npx ${CLI_PACKAGE} <command> instead of node scripts/tasks.mjs, and remove the copy with npx ${CLI_PACKAGE} repos init ${slug || '<slug>'} --update, which opens a pull request here.`;
}

/**
 * The task an idea becomes (`npx breakaway idea`): its first line, kept short, as the title, and the whole text as its
 * description. Like `add`, it lands in the repository of the checkout it was written in (BRK-71): without one, the
 * board would file it in its default repository.
 * @param {string} idea
 * @param {{ horizon?: string, auto?: boolean, repo?: string | null }} [options]
 */
export function ideaTask(idea, { horizon = 'auto', auto = false, repo = null } = {}) {
  const first = (idea.split('\n').find((l) => l.trim()) ?? '').trim();
  return {
    description: first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first,
    project: 'ideas',
    horizon: 'now',
    tags: ['agent', 'idea', `horizon-${horizon}`],
    autostart: auto ? 'yes' : undefined,
    brief: idea,
    ...(repo ? { repo } : {}),
  };
}
