import { CLI_PACKAGE } from './init.js';
import { INFRA_READS } from './infra-read.js';

/**
 * Checks the CLI makes before and after it runs a command (CLD-193), kept pure so they're tested without a board.
 */

/** The subcommands each command knows. Without one, each lists or shows (horizon needs close). */
export const SUBCOMMANDS = {
  agents: ['next', 'start', 'refine', 'new'],
  github: ['fix', 'review'],
  repos: ['add', 'init', 'modify', 'remove', 'setup'],
  routines: ['add', 'modify', 'run', 'trigger', 'revoke', 'pause', 'resume', 'cap', 'new'],
  features: ['list', 'add', 'show', 'modify', 'pull'],
  horizon: ['close'],
  hook: ['session', 'wait'],
  peloton: [
    'checkin',
    'step',
    'note',
    'ask',
    'propose',
    'review',
    'reply',
    'huddle',
    'in',
    'outcome',
    'plan',
    'listen',
  ],
  specs: ['list', 'show'],
  infra: ['init', 'runner', 'check', 'adopt', 'act', ...INFRA_READS],
};

/** Commands that take nothing after their name, so a word there is a mistake (an old copy's missing subcommand, say). */
export const NO_ARGUMENTS = new Set([
  'list',
  'next',
  'activity',
  'health',
  'mcp',
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
 * through npx) has nothing to say. In a checkout of the board's own repository, `behind` (the board's `release`, its
 * X-Tasks-Release header, isn't in this checkout's history: releaseBehind) means pull (BRK-148). Anywhere else the
 * CLI is an old copy that `repos init` used to commit: it works while the API stays compatible, and on each run it says
 * how to switch. `own` and `board` are the frozen CLI number (src/cli-version.js) such a copy carries and the board sends.
 */
export function staleCliWarning({ own, board, boardCheckout, slug, packaged = false, release = null, behind = false }) {
  if (packaged) return null;
  const theirs = Number(board);
  const older = Number.isInteger(theirs) && theirs > own;
  if (boardCheckout) {
    if (!release || !behind) return null;
    return `this checkout is behind the board's release (v${release}), so a command may be missing or behave differently: pull the default branch to update it.`;
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

/**
 * Whether the checkout `git` runs in is behind the board's release `release` (BRK-148): it has the release's tag
 * (`v1.4.0-main.9`, which the release workflow pushes) and that commit isn't in HEAD's history. Without the tag (tags
 * not fetched yet), or in a `shallow` clone, whose cut history can hide an ancestor, it can't tell, and says no.
 * `git(args)` runs git and returns its exit code.
 * @param {string | null} release
 * @param {(args: string[]) => number | null} git
 * @param {{ shallow?: boolean }} [options]
 */
export function releaseBehind(release, git, { shallow = false } = {}) {
  if (shallow || !release || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release)) return false;
  const tag = `refs/tags/v${release}`;
  if (git(['rev-parse', '-q', '--verify', `${tag}^{commit}`]) !== 0) return false;
  return git(['merge-base', '--is-ancestor', tag, 'HEAD']) === 1;
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

/**
 * `npx breakaway github release <pre-release> [--next patch|minor|major]` (BRK-103, WEB-39): the owner releases a
 * package's pre-release as its stable, as Release on the GitHub page does, with what the default branch works toward
 * next. The board starts the repository's release.yml stable job, and npm waits for the owner's 2FA; it refuses an
 * agent, so the request always says who asks, and refuses a pre-release whose stable is already out (409).
 * @param {string | undefined} version the pre-release, like 1.4.0-main.5 (or its tag)
 * @param {{ repo?: string | null, by?: string, next?: string | null }} [options]
 * @returns {{ error?: string, request?: [string, string, Record<string, string>] }}
 */
export function packageReleaseRequest(version, { repo = null, by, next = null } = {}) {
  const v = String(version ?? '').trim();
  if (!/^(?:\S+@|v)?\d+\.\d+\.\d+-main\.\d+$/u.test(v))
    return { error: 'say which pre-release: npx breakaway github release <version>, like 1.4.0-main.5' };
  if (next !== null && next !== undefined && !['patch', 'minor', 'major'].includes(String(next)))
    return { error: '--next is patch, minor, or major' };
  return {
    request: [
      'POST',
      'github/release',
      { version: v, ...(next ? { next: String(next) } : {}), ...(repo ? { repo } : {}), ...(by ? { by } : {}) },
    ],
  };
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
 * Who writes a routine (BRK-220 section 5): every routines write says who asks, like `features` does, so the board
 * can tell an agent from the owner and let only a routine maker's agent through. Nothing when no name is set.
 * @template {Record<string, unknown>} T
 * @param {T} body
 * @param {string | undefined} by
 */
export function routineWrite(body, by) {
  return by ? { ...body, by } : body;
}

/**
 * `routines new` (BRK-220 section 1, Make with an agent): the request that makes a routine maker's task from the
 * owner's words and starts its agent, in the checkout's repository unless `--repo` names another. It says who asks,
 * so the board refuses an agent's name: only the owner starts one.
 * @param {string} prompt
 * @param {{ repo?: string | null, force?: boolean, by?: string }} [options]
 */
export function routineMakerRequest(prompt, { repo = null, force = false, by } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text)
    return {
      error:
        'say what the routine should do, and when: npx breakaway routines new "Every Monday, update the changelog from what merged"',
    };
  const body = {
    prompt: text,
    ...(repo ? { repo } : {}),
    ...(force ? { force: true } : {}),
  };
  return { request: ['POST', 'routines/agent', routineWrite(body, by)] };
}

/**
 * `agents new`: the request that makes a task from a prompt and starts an agent on it. It's the checkout's repository
 * unless `--repo` names another. It always says who asks, so the board refuses an agent's name: only the owner starts one.
 * With `decision` (`agents new --decision <ID> ["<note>"]`, BRK-110) the board writes the prompt from that answered
 * decision, in the decision's repository, and the text is the owner's note under it. With `next`
 * (`agents new --next minor|major ["<note>"]`, BRK-100) it writes the prompt that sets the repository's next version.
 * With `spec` (`agents new --spec <path> "<what should change>"`, BRK-121) it writes the prompt that refines that spec
 * and the tasks that link it, and the text, required, is what should change.
 * @param {string} prompt
 * @param {{ repo?: string | null, force?: boolean, by?: string, decision?: string | null, next?: string | null, spec?: string | null }} [options]
 */
export function generalAgentRequest(
  prompt,
  { repo = null, force = false, by, decision = null, next = null, spec = null } = {},
) {
  const text = String(prompt ?? '').trim();
  if ([decision, next, spec].filter(Boolean).length > 1)
    return { error: 'start one from --decision, --spec, or --next: only one of them' };
  if (next && !['minor', 'major'].includes(next))
    return { error: 'patches count by themselves: --next minor or --next major' };
  if (spec && !text)
    return {
      error: 'say what should change in the spec: npx breakaway agents new --spec <path> "<what should change>"',
    };
  if (!text && !decision && !next)
    return { error: 'say what the agent should do: npx breakaway agents new "Tidy the docs" [--image <file>]' };
  const board = decision ? { decision } : next ? { next } : spec ? { spec: specPath(spec) } : null;
  const body = {
    ...(board ? { ...board, ...(text ? { note: text } : {}) } : { prompt: text }),
    ...(repo ? { repo } : {}),
    ...(force ? { force: true } : {}),
    ...(by ? { by } : {}),
  };
  return { request: ['POST', 'agents/general', body] };
}

/**
 * What the CLI says about a general agent's answer: the task and that it started, or why it waits (and whether Force
 * start could skip that), or, from a decision, for the next version (`next`), or on a spec (`spec`), the open one
 * that already has it.
 * @param {{ task: { wid?: string, short?: string }, run?: { url?: string, agent?: string } | null, waiting?: string | null, forceable?: boolean, already?: string | null }} answer
 * @param {{ next?: string | null, spec?: unknown }} [options]
 */
export function generalAgentSummary({ task, run, waiting, forceable, already }, { next = null, spec = null } = {}) {
  const id = task.wid ?? task.short;
  if (!run && already) {
    const what = next ? 'prepares the next version' : spec ? 'refines this spec' : 'refines from these answers';
    return `${id} already ${what}: ${already}.`;
  }
  if (run) return `Started ${run.agent ? `${run.agent} ` : 'an agent '}on ${id}${run.url ? `: ${run.url}` : ''}`;
  return `Saved ${id}, waiting to start: ${waiting ?? 'no room yet'}.${forceable ? ` Start it now past the board's limits: npx breakaway agents start ${id} --force` : ''}`;
}

/** A spec's path as the board reads it: no leading `./`, no doubled or trailing slashes. */
const specPath = (path) =>
  String(path ?? '')
    .trim()
    .replace(/^(\.\/)+/u, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');

/**
 * The request behind `npx breakaway specs [list]` (BRK-121): the specs of the checkout's repository, or the one `--repo`
 * names; without either, the board answers with its default repository's.
 * @param {string | null} repo
 * @returns {[string, string, undefined]}
 */
export function specsRequest(repo) {
  return ['GET', repo ? `specs?repo=${encodeURIComponent(repo)}` : 'specs', undefined];
}

/**
 * The request behind `npx breakaway specs show <path>` (BRK-121): one spec, by its path in the repository. The board
 * refuses a path outside the specs directory; one that climbs out with `..` is refused here first.
 * @param {string | undefined} path
 * @param {string | null} repo
 */
export function specRequest(path, repo) {
  const clean = specPath(path);
  if (!clean) return { error: 'say which spec: npx breakaway specs show <path>, like docs/specs/BRK-1-thing.md' };
  if (clean.split('/').includes('..')) return { error: `${clean.slice(0, 200)} climbs out of the repository` };
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return { request: ['GET', `specs/${clean.split('/').map(encodeURIComponent).join('/')}${query}`, undefined] };
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

/**
 * The fields `features add` and `features modify` send (BRK-85, IDEA-28 section 1): only the ones given. `--release none`
 * (or an empty one) leaves the feature unplanned, and `v1.2.0` is read as `1.2.0`.
 * @param {{ title?: string, brief?: string, release?: string, state?: string }} options
 */
export function featureBody({ title, brief, release, state } = {}) {
  const body = {};
  if (title !== undefined) body.title = String(title);
  if (brief !== undefined) body.brief = String(brief);
  if (release !== undefined) {
    const r = String(release).trim();
    body.release = r === 'none' ? '' : r.replace(/^v(?=\d)/u, '');
  }
  if (state !== undefined) body.state = String(state);
  return body;
}

/**
 * The request behind `npx breakaway chase <slug> [stop] [--parallel <n>] [--dry-run]` (BRK-85, IDEA-28 section 3):
 * without `stop` it starts the chase, or keeps a running one going with the new `--parallel`; `--dry-run` shows what
 * would start now and changes nothing. It always says who asks, so the board refuses an agent's name: a chase is the
 * owner's.
 * @param {string | undefined} slug
 * @param {string | undefined} action
 * @param {{ parallel?: string | number, dryRun?: boolean, by?: string, captain?: boolean, watch?: string | number }} [options]
 * @returns {{ error?: string, request?: [string, string, Record<string, unknown>] }}
 */
export function chaseRequest(slug, action, { parallel, dryRun = false, by, captain, watch } = {}) {
  if (!slug) return { error: 'say which feature: npx breakaway chase <slug> [stop] [--parallel <n>] [--dry-run]' };
  if (action !== undefined && action !== 'stop')
    return { error: `chase has no "${String(action).slice(0, 40)}": npx breakaway chase <slug> [stop]` };
  let limit;
  if (parallel !== undefined) {
    limit = Number(parallel);
    if (!Number.isInteger(limit) || limit < 1)
      return { error: '--parallel is how many agents at once in one area: a whole number, 1 or more' };
  }
  if (action === 'stop' && limit !== undefined)
    return { error: '--parallel is for a chase that runs: npx breakaway chase <slug> --parallel <n>' };
  let hours;
  if (watch !== undefined) {
    hours = Number(watch);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72)
      return { error: '--watch is a road captain’s watch before it hands over: whole hours from 1 to 72' };
  }
  if (action === 'stop' && (captain !== undefined || hours !== undefined))
    return { error: 'the road captain is for a chase that runs: npx breakaway chase <slug> --captain' };
  const body = {
    on: action !== 'stop',
    ...(limit !== undefined ? { parallel: limit } : {}),
    // The road captain (BRK-275): left out, the board decides from the chase's size.
    ...(captain !== undefined ? { captain: Boolean(captain) } : {}),
    ...(hours !== undefined ? { captainHours: hours } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(by ? { by } : {}),
  };
  return { request: ['POST', `features/${encodeURIComponent(slug.toLowerCase())}/chase`, body] };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const idOf = (t) => t.wid ?? t.short ?? String(t.uuid ?? '').slice(0, 8);

/**
 * A feature's progress in one line: "4 of 10 done: 2 running, 1 ready, 1 waiting for you".
 * @param {{ total: number, done: number, running?: number, ready?: number, waiting?: number, needsYou?: number, inReview?: number }} p
 */
export function progressLine(p) {
  if (!p.total) return 'no tasks yet';
  const rest = [
    p.inReview && `${p.inReview} in review`,
    p.running && `${p.running} running`,
    p.ready && `${p.ready} ready`,
    p.waiting && `${p.waiting} waiting on other tasks`,
    p.needsYou && `${p.needsYou} waiting for you`,
  ].filter(Boolean);
  return `${p.done} of ${p.total} done${rest.length ? `: ${rest.join(', ')}` : ''}`;
}

/** The chase in a few words for a feature's line, or null when it's off. */
function chaseWords(chase) {
  if (!chase || chase.state === 'off') return null;
  if (chase.state === 'on') return `chasing, ${chase.parallel} at once in an area`;
  if (chase.state === 'done') return 'chase ended';
  return 'chase stopped';
}

/**
 * A feature's plan in a few words (WEB-104): "2026-10-12 to 2026-10-19", "by 2026-10-19", "from 2026-10-12", or null.
 * @param {{ plannedStart?: string | null, plannedEnd?: string | null }} f
 */
export function planWords({ plannedStart, plannedEnd }) {
  if (plannedStart && plannedEnd) return `${plannedStart} to ${plannedEnd}`;
  if (plannedEnd) return `by ${plannedEnd}`;
  if (plannedStart) return `from ${plannedStart}`;
  return null;
}

/**
 * What `npx breakaway features` prints: features by release, then unplanned, then the tags that could be features
 * and the tasks with a release tag and no feature.
 * @param {{ features: any[], suggestions?: any[], releaseTasks?: any[] }} data
 */
export function featureListLines({ features, suggestions = [], releaseTasks = [] }) {
  const out = [];
  if (!features.length)
    out.push('No features yet. Make one: npx breakaway features add <slug> --title "<title>" [--release 1.2.0]');
  const width = Math.max(12, ...features.map((f) => f.slug.length));
  let group;
  for (const f of features) {
    const release = f.release ?? 'Unplanned';
    if (release !== group) {
      if (group !== undefined) out.push('');
      out.push(release);
      group = release;
    }
    const notes = [
      progressLine(f.progress),
      planWords(f) ? `planned ${planWords(f)}` : null,
      f.shipped ? 'shipped' : null,
      chaseWords(f.chase),
      f.conflicts?.length ? `${plural(f.conflicts.length, 'task')} in two features` : null,
    ].filter(Boolean);
    out.push(`  ${f.slug.padEnd(width)} ${f.title} · ${notes.join(' · ')}`);
  }
  if (suggestions.length) {
    out.push('', 'Tags that could be features (npx breakaway features add <slug>):');
    for (const s of suggestions)
      out.push(`  ${s.slug} (${plural(s.open, 'open task')}${s.release ? `, ${s.release}` : ''})`);
  }
  for (const r of releaseTasks)
    out.push('', `Other tasks in ${r.release}: ${r.tasks.map((t) => t.wid ?? t.description).join(', ')}`);
  return out;
}

/**
 * A chase's state, live line, and what holds it, as `features show` and `chase` print them (IDEA-28 section 3.9).
 * @param {any} chase
 * @param {string} [slug] the feature's, for the command that starts it
 */
export function chaseLines(chase, slug = '<slug>') {
  if (!chase) return [];
  const out = [];
  const head = {
    on: `On since ${String(chase.startedAt ?? '')
      .slice(0, 16)
      .replace('T', ' ')} UTC, ${plural(chase.parallel, 'agent')} at once in an area`,
    stopped: 'Stopped: running agents finish, nothing new starts',
    done: 'Ended: every task is done or in review',
    off: `Off (npx breakaway chase ${slug} starts it, ${plural(chase.parallel, 'agent')} at once in an area)`,
  }[chase.state];
  out.push(`  Chase       ${head ?? chase.state}`);
  if (chase.summary) out.push(`              ${chase.summary}`);
  if (chase.state === 'on') out.push(...captainLines(chase.captain));
  for (const n of chase.needsYou ?? []) out.push(`  Needs you   ${idOf(n)} ${n.why}${blocking(n)}`);
  for (const s of chase.stuck ?? [])
    out.push(`  Stuck       ${idOf(s)} ${s.why}${s.last ? `; last: ${oneLine(s.last)}` : ''}`);
  const queue = chase.queue ?? [];
  if (queue.length) {
    out.push('  Next');
    for (const q of queue) out.push(`    ${idOf(q).padEnd(9)} ${q.ready ? 'ready to start' : q.reason}${blocking(q)}`);
  }
  return out;
}

/**
 * What `npx breakaway captain <slug> [log --file <path> [--handover]]` sends (BRK-275): with no action, the feature, for
 * its captain and log; `log`, the captain's log, read from `text`, and with `handover`, the hand over.
 * @param {string | undefined} slug
 * @param {string | undefined} action
 * @param {{ text?: string | null, handover?: boolean, by?: string }} [options]
 */
export function captainRequest(slug, action, { text = null, handover = false, by } = {}) {
  const usage = 'npx breakaway captain <feature> [log --file <path> [--handover]]';
  if (!slug) return { error: `say which feature: ${usage}` };
  const route = `features/${encodeURIComponent(slug.toLowerCase())}`;
  if (action === undefined) {
    if (handover || text !== null) return { error: `--file and --handover go with log: ${usage}` };
    return { request: ['GET', route] };
  }
  if (action !== 'log') return { error: `captain has no "${String(action).slice(0, 40)}": ${usage}` };
  if (text === null) return { error: 'write the log in a file and pass --file <path>' };
  if (!String(text).trim())
    return { error: 'the log is empty: where the chase stands, what you decided, what comes next' };
  if (!by) return { error: 'say who you are: the log is the road captain’s (BREAKAWAY_AGENT or --as)' };
  return { request: ['POST', `${route}/captain`, { log: String(text), handover: Boolean(handover), by }] };
}

/**
 * The chase's road captain in a few lines (BRK-275): who holds it and when its watch ends, or whether it starts with
 * the chase, then its log, newest first.
 * @param {any} captain the chase view's `captain`
 * @param {{ all?: boolean }} [options] all prints every entry kept, else the last 3
 */
export function captainLines(captain, { all = false } = {}) {
  if (!captain) return [];
  const when = (iso) =>
    String(iso ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const out = [];
  if (captain.agent)
    out.push(
      `  Captain     ${captain.agent}, since ${when(captain.since)} UTC; its watch ends ${when(captain.watchEndsAt)} UTC${captain.askedAt ? ' (asked to hand over)' : ''}`,
    );
  else if (captain.on)
    out.push(`  Captain     on: the board starts one on its next check (${captain.hours}-hour watches)`);
  else out.push('  Captain     off');
  const log = all ? (captain.log ?? []) : (captain.log ?? []).slice(0, 3);
  for (const entry of log)
    out.push(
      `  Log         ${when(entry.at)} ${entry.agent}${entry.handover ? ' (handed over)' : ''}: ${oneLine(entry.text)}`,
    );
  return out;
}

const oneLine = (text) => {
  const flat = String(text).replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
};
/** Why a pulled-in blocker is in the chase (section 3.1). */
const blocking = (t) => (t.blocks?.length ? ` (in the chase because it blocks ${t.blocks.join(', ')})` : '');

/**
 * What `npx breakaway features show <slug>` prints: the record, its progress, its chase, and its tasks in dependency order.
 * @param {any} f
 */
export function featureLines(f) {
  const out = [`${f.title} (${f.slug})`, ''];
  const row = (k, v) => v && out.push(`  ${k.padEnd(11)} ${v}`);
  row('Release', f.release ?? 'unplanned');
  row('Planned', planWords(f) ?? 'no dates yet');
  row('State', f.shipped && f.state !== 'shipped' ? 'shipped (every task is done and live)' : f.state);
  row('Progress', progressLine(f.progress));
  out.push(...chaseLines(f.chase, f.slug));
  // The chase's own Needs you says more (merges, connections), so the feature's is shown only without one.
  if (!f.chase?.needsYou) for (const n of f.needsYou ?? []) row('Needs you', `${idOf(n)} ${n.why}`);
  for (const c of f.conflicts ?? []) row('Two features', `${c.wid} is in ${c.features.join(' and ')}: it counts here`);
  if (f.brief) out.push('', ...f.brief.split('\n').map((l) => `  ${l}`));
  if (f.tasks?.length) {
    out.push('', '  Tasks');
    for (const t of f.tasks)
      out.push(`    ${idOf(t).padEnd(9)} ${t.state.padEnd(9)} ${t.description}${t.why ? ` (${t.why})` : ''}`);
  } else out.push('', `  No tasks yet: tag them with ${f.slug} (npx breakaway modify <ref> --tag ${f.slug}).`);
  return out;
}

/**
 * What `npx breakaway chase` prints after the board answers: what it started or would start, then the chase. `parallel`
 * is the limit a dry run tried, which the board doesn't keep.
 * @param {string} slug
 * @param {{ dryRun?: boolean, chase: any, started?: string[], wouldStart?: string[] }} answer
 * @param {{ stop?: boolean, parallel?: number }} [options]
 */
export function chaseSummary(slug, { dryRun, chase, started = [], wouldStart = [] }, { stop = false, parallel } = {}) {
  let first;
  if (dryRun) {
    const limit = parallel ? ` with ${plural(parallel, 'agent')} at once in an area` : '';
    first = `A chase of ${slug}${limit} would start ${wouldStart.length ? `${wouldStart.join(', ')} now` : 'nothing now'}. Nothing was started.`;
  } else if (stop) first = `Stopped the chase of ${slug}. Running agents finish and open their pull requests.`;
  else if (chase.state !== 'on') first = `The chase of ${slug} isn’t on (${chase.state}).`;
  else if (started.length) first = `Chasing ${slug}: started ${started.join(', ')}.`;
  else {
    const next = (chase.queue ?? []).filter((q) => q.ready).map(idOf);
    first = next.length
      ? `Chasing ${slug}: the board starts ${next.join(', ')} on its next check.`
      : `Chasing ${slug}: nothing can start right now; the board starts each task when it’s ready.`;
  }
  return [first, '', ...chaseLines(chase, slug)].join('\n');
}

/** A spec's tasks in a few words: "3 tasks, 2 open", or "no tasks". */
const specTaskCount = (tasks = []) => {
  if (!tasks.length) return 'no tasks';
  const open = tasks.filter((t) => t.status === 'pending').length;
  return `${plural(tasks.length, 'task')}, ${open} open`;
};

/**
 * What `npx breakaway specs` prints: the repository's specs newest first, each with its work ID, status, title, and its
 * tasks' count; with none, where specs go and how to point the board at another directory.
 * @param {{ slug: string, dir: string, missing?: boolean, readme?: { path: string } | null, specs: any[] }} answer
 */
export function specListLines({ slug, dir, missing, readme, specs }) {
  if (!specs.length)
    return [
      `No specs in ${dir} yet${missing ? `: ${slug} has no ${dir} on its default branch` : ''}.`,
      'A spec is a Markdown file in that directory, merged like any change.',
      `If ${slug} keeps its specs somewhere else, the owner sets it with npx breakaway repos modify ${slug} --specs <dir>.`,
    ];
  const intro = readme ? ` (its introduction is ${readme.path})` : '';
  const out = [`${slug}: ${plural(specs.length, 'spec')} in ${dir}${intro}`, ''];
  for (const s of specs) {
    const extra = s.tooLarge ? ', over 1 MB: read it on GitHub' : '';
    out.push(
      `  ${(s.wid ?? '').padEnd(9)} ${(s.status ?? '-').padEnd(10)} ${s.title}  (${specTaskCount(s.tasks)}${extra})`,
    );
  }
  out.push('', `Read one: npx breakaway specs show <path>, like ${specs[0].path}`);
  return out;
}

/**
 * What `npx breakaway specs show <path>` prints: the spec's title and path, status, the commit that last changed it,
 * its GitHub link, its Markdown (or, over 1 MB, a pointer to GitHub), and the tasks that link it.
 * @param {any} spec
 */
export function specLines(spec) {
  const out = [`${spec.title} (${spec.path})`, ''];
  const row = (k, v) => v && out.push(`  ${k.padEnd(11)} ${v}`);
  row('Status', spec.status);
  const c = spec.commit;
  if (c)
    row(
      'Changed',
      `${c.date ? `${String(c.date).slice(0, 16).replace('T', ' ')} ` : ''}in ${String(c.sha).slice(0, 7)}${c.message ? `: ${c.message}` : ''}`,
    );
  row('GitHub', spec.url);
  out.push('');
  if (spec.tooLarge || spec.text === null || spec.text === undefined)
    out.push('Over 1 MB, too large to show here: read it on GitHub.');
  else out.push(String(spec.text).replace(/\s+$/u, ''));
  const tasks = spec.tasks ?? [];
  out.push('');
  if (tasks.length) {
    out.push(`  Tasks (${tasks.length}, ${tasks.filter((t) => t.status === 'pending').length} open)`);
    for (const t of tasks) out.push(`    ${idOf(t).padEnd(9)} ${t.status.padEnd(9)} ${t.description}`);
  } else out.push(`  No task links it yet: npx breakaway modify <ref> --spec ${spec.path}`);
  out.push('', `Refine it: npx breakaway agents new --spec ${spec.path} "<what should change>"`);
  return out;
}

/**
 * What's left by hand once `repos remove` took a repository off the board (CLI-4): the board can't delete its routine
 * on claude.ai, connected or not, nor the repository on GitHub. `repos remove` ends with these, and `--json` carries
 * them as `byHand`.
 * @param {string} github the repository, as owner/name
 * @returns {string[]}
 */
export function removedRepoByHand(github) {
  return [
    `Delete its routine on claude.ai, with its API trigger: open claude.ai/code/routines, then the routine for ${github}. The board can't delete it, whether or not it was connected.`,
    `Made ${github} only for a rehearsal? Delete it on GitHub too (Settings, then Danger zone; or gh auth refresh -h github.com -s delete_repo once, then gh repo delete ${github}), and your local clone.`,
  ];
}
