import { CLI_PACKAGE } from './init.js';

/**
 * Checks the CLI makes before and after it runs a command (CLD-193), kept pure so they're tested without a board.
 */

/** The subcommands each command knows. Without one, each lists or shows (horizon needs close). */
export const SUBCOMMANDS = {
  agents: ['next', 'start', 'refine', 'new'],
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
 * agent" and "Safe to merge?" or "Review with an agent" buttons (`POST github/pulls/<n>/fix` and `/review`). It names the checkout's repository
 * like `github` does. Returns an error message instead when the number or `problem` can't be right.
 * @param {'fix' | 'review'} action
 * @param {string | number | undefined} number
 * @param {{ repo?: string | null, problem?: string, note?: string, force?: boolean, by?: string }} [options]
 * @returns {{ error?: string, request?: [string, string, Record<string, string | boolean>] }}
 */
export function pullAgentRequest(action, number, { repo = null, problem, note, force = false, by } = {}) {
  const n = String(number ?? '').replace(/^#/u, '');
  if (!/^[1-9]\d{0,8}$/u.test(n)) return { error: `say which pull request: npx breakaway github ${action} <number>` };
  if (problem !== undefined && action !== 'fix') return { error: '--problem is for github fix' };
  if (problem !== undefined && !FIX_PROBLEMS.includes(problem))
    return { error: `--problem is ${FIX_PROBLEMS.join(', ')}` };
  const body = {
    ...(repo ? { repo } : {}),
    ...(problem ? { problem } : {}),
    ...(typeof note === 'string' && note.trim() ? { note } : {}),
    // Review with an agent is the owner's, so a review always says who asks (BRK-111); a fix only when forcing.
    ...(action === 'review' ? { ...(force ? { force: true } : {}), ...(by ? { by } : {}) } : forceFields(force, by)),
  };
  return { request: ['POST', `github/pulls/${n}/${action}`, body] };
}

export const REVIEW_VERDICTS = ['ready', 'follow-up', 'changes'];

/**
 * `npx breakaway review <ID> --verdict ready|follow-up|changes "<note>"` (BRK-111): an agent's answer on the pull
 * request that closes its task. The board adds it to the task as a comment and keeps it for the pull request page.
 * `pr` picks the pull request when the task has several open.
 * @param {string | undefined} ref
 * @param {string | undefined} verdict
 * @param {string | undefined} note
 * @param {{ by?: string, pr?: string | number }} [options]
 */
export function reviewRequest(ref, verdict, note, { by, pr } = {}) {
  if (!ref) return { error: 'say which task: npx breakaway review <task> --verdict ready "<note>"' };
  if (!REVIEW_VERDICTS.includes(String(verdict)))
    return { error: `say the verdict: --verdict ${REVIEW_VERDICTS.join('|')}` };
  const text = String(note ?? '').trim();
  if (!text) return { error: 'say what you found: the note is the review (Markdown)' };
  const n = pr === undefined ? null : String(pr).replace(/^#/u, '');
  if (n !== null && !/^[1-9]\d{0,8}$/u.test(n)) return { error: '--pr is a pull request number' };
  return {
    request: [
      'POST',
      `tasks/${encodeURIComponent(ref)}/review`,
      { verdict, note: text, ...(by ? { by } : {}), ...(n ? { pr: Number(n) } : {}) },
    ],
  };
}

/**
 * Force start on a request that starts an agent (BRK-107): `force`, and who is asking, so the board can refuse an
 * agent's name (only the owner forces a start). Nothing when it isn't forced.
 * @param {unknown} force
 * @param {string | undefined} by
 */
export function forceFields(force, by) {
  return force ? { force: true, ...(by ? { by } : {}) } : {};
}

/**
 * `agents new`: the request that makes a task from a prompt and starts an agent on it. It's the checkout's repository
 * unless `--repo` names another. It always says who asks, so the board refuses an agent's name: only the owner starts one.
 * With `decision` (`agents new --decision <ID> ["<note>"]`, BRK-110) the board writes the prompt from that answered
 * decision, in the decision's repository, and the text is the owner's note under it.
 * @param {string} prompt
 * @param {{ repo?: string | null, force?: boolean, by?: string, decision?: string | null }} [options]
 */
export function generalAgentRequest(prompt, { repo = null, force = false, by, decision = null } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text && !decision)
    return { error: 'say what the agent should do: npx breakaway agents new "Tidy the docs" [--image <file>]' };
  const body = {
    ...(decision ? { decision, ...(text ? { note: text } : {}) } : { prompt: text }),
    ...(repo ? { repo } : {}),
    ...(force ? { force: true } : {}),
    ...(by ? { by } : {}),
  };
  return { request: ['POST', 'agents/general', body] };
}

/**
 * What the CLI says about a general agent's answer: the task and that it started, or why it waits (and whether Force
 * start could skip that), or, from a decision, the open one that already has it.
 * @param {{ task: { wid?: string, short?: string }, run?: { url?: string, agent?: string } | null, waiting?: string | null, forceable?: boolean, already?: string | null }} answer
 */
export function generalAgentSummary({ task, run, waiting, forceable, already }) {
  const id = task.wid ?? task.short;
  if (!run && already) return `${id} already refines from these answers: ${already}.`;
  if (run) return `Started ${run.agent ? `${run.agent} ` : 'an agent '}on ${id}${run.url ? `: ${run.url}` : ''}`;
  return `Saved ${id}, waiting to start: ${waiting ?? 'no room yet'}.${forceable ? ` Start it now past the board's limits: npx breakaway agents start ${id} --force` : ''}`;
}

/**
 * What the CLI says about an answer to those requests: which task and agent took the pull request, or who already has it.
 * @param {'fix' | 'review'} action
 * @param {string | number} number
 * @param {{ task: { wid?: string, short?: string }, run?: { url?: string, agent?: string, kind?: string } | null, already?: string | null }} answer
 */
export function pullAgentSummary(action, number, { task, run, already }) {
  const id = task.wid ?? task.short;
  if (!run) return `${id} already has it: ${already}.`;
  const what =
    action === 'fix' ? `fixing #${number}` : run.kind === 'pr-review' ? `reviewing #${number}` : `testing #${number}`;
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
