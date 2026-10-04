import { CLI_PACKAGE } from './init.js';

/**
 * Checks the CLI makes before and after it runs a command (CLD-193), kept pure so they're tested without a board.
 */

/** The subcommands each command knows. Without one, each lists or shows (horizon needs close). */
export const SUBCOMMANDS = {
  agents: ['next', 'start', 'refine'],
  github: ['fix', 'review'],
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
 * The request behind `npx breakaway github` (`--sync` for a fresh one): the view of the checkout's repository (BRK-72),
 * as `list` and `next` stay in it. Without one, the board answers with its default repository's.
 * @param {string | null} repo
 * @param {{ sync?: boolean }} [options]
 * @returns {[string, string, { repo: string } | undefined]}
 */
export function githubRequest(repo, { sync = false } = {}) {
  if (sync) return ['POST', 'github/sync', repo ? { repo } : undefined];
  return ['GET', repo ? `github?repo=${encodeURIComponent(repo)}` : 'github', undefined];
}

/** What `github fix` accepts for --problem: the same three the pull request page offers. */
export const FIX_PROBLEMS = ['conflicts', 'failing', 'review'];

/**
 * The request behind `npx breakaway github fix <n>` and `github review <n>` (BRK-81): the pull request page's "Fix with an
 * agent" and "Safe to merge?" buttons (`POST github/pulls/<n>/fix` and `/review`). It names the checkout's repository
 * like `github` does. Returns an error message instead when the number or `problem` can't be right.
 * @param {'fix' | 'review'} action
 * @param {string | number | undefined} number
 * @param {{ repo?: string | null, problem?: string, note?: string }} [options]
 * @returns {{ error?: string, request?: [string, string, Record<string, string>] }}
 */
export function pullAgentRequest(action, number, { repo = null, problem, note } = {}) {
  const n = String(number ?? '').replace(/^#/u, '');
  if (!/^[1-9]\d{0,8}$/u.test(n)) return { error: `say which pull request: npx breakaway github ${action} <number>` };
  if (problem !== undefined && action !== 'fix') return { error: '--problem is for github fix' };
  if (problem !== undefined && !FIX_PROBLEMS.includes(problem))
    return { error: `--problem is ${FIX_PROBLEMS.join(', ')}` };
  const body = {
    ...(repo ? { repo } : {}),
    ...(problem ? { problem } : {}),
    ...(typeof note === 'string' && note.trim() ? { note } : {}),
  };
  return { request: ['POST', `github/pulls/${n}/${action}`, body] };
}

/**
 * What the CLI says about an answer to those requests: which task and agent took the pull request, or who already has it.
 * @param {'fix' | 'review'} action
 * @param {string | number} number
 * @param {{ task: { wid?: string, short?: string }, run?: { url?: string, agent?: string } | null, already?: string | null }} answer
 */
export function pullAgentSummary(action, number, { task, run, already }) {
  const id = task.wid ?? task.short;
  if (!run) return `${id} already has it: ${already}.`;
  const what = action === 'fix' ? `fixing #${number}` : `testing #${number}`;
  return `Started ${run.agent ? `${run.agent}, ` : 'an agent '}${what} on ${id}${run.url ? `: ${run.url}` : ''}`;
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
