/**
 * What the session hooks do about footprints (docs/specs/IDEA-55-footprints.md, sections 1a and 1b): the edit hook
 * claims the file an edit names before it runs, and the session hook reports the agent's dirty paths. Pure, apart from
 * the notes kept in the system's temp folder (never the repository, where a cloud session's Stop check would take a new
 * file as work to commit), so it's tested without git or a board.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDIT_MATCHER } from '../../src/init.js';

const EDIT_TOOLS = new Set(EDIT_MATCHER.split('|'));

/**
 * How long the edit hook waits for the board before it lets the edit through. Claude Code's own `timeout` on the hook
 * (EDIT_HOOK_TIMEOUT in src/init.js) is the backstop: a PreToolUse command hook that times out doesn't block the tool
 * call (source: https://code.claude.com/docs/en/hooks, "A timed-out command, http, or mcp_tool hook doesn't block the
 * tool call").
 */
export const EDIT_CLAIM_MS = 3000;
/** Dirty paths go to the board at most this often (section 1b). */
export const DIRTY_EVERY_MS = 60_000;

/** Whether a hook event is an edit tool's. */
export function isEdit(hook) {
  return EDIT_TOOLS.has(hook?.tool_name);
}

/**
 * The repository path an edit names, or null when it names none or one outside the checkout (or inside `.git/`).
 * Claude Code hands the file tools' `file_path` over absolute, with backslashes on Windows (source:
 * https://code.claude.com/docs/en/hooks, "For the file tools Write, Edit, and Read, tool_input.file_path is always
 * absolute"); NotebookEdit names `notebook_path`.
 * @param {any} hook the hook's input
 * @param {string} root the checkout's root
 */
export function editedPath(hook, root) {
  const raw = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const path = raw.replaceAll('\\', '/');
  const base = String(root ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/u, '');
  let rel;
  if (/^(?:\/|[A-Za-z]:\/)/u.test(path)) {
    if (!base || !path.startsWith(`${base}/`)) return null;
    rel = path.slice(base.length + 1);
  } else rel = path;
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..') || parts[0] === '.git') return null;
  return parts.join('/');
}

/**
 * What the edit hook prints for the board's answer to its claim, or null to stay quiet and let the edit go ahead.
 * Granted or already the task's: quiet. Refused (409): the edit is denied, with the board's reason, which Claude reads
 * (`permissionDecision: "deny"` shows `permissionDecisionReason` to Claude; source: https://code.claude.com/docs/en/hooks,
 * PreToolUse decision control). Anything else: the edit goes ahead, and Claude hears why it isn't claimed
 * (`additionalContext`, same source), because a board that's down never stops work.
 * @param {{ status: number, data?: any } | { error: string }} answer
 * @param {string} path
 * @param {{ wid?: string | null }} claim
 */
export function editOutput(answer, path, claim) {
  if ('status' in answer && answer.status >= 200 && answer.status < 300) return null;
  if ('status' in answer && answer.status === 409) {
    const reason =
      typeof answer.data?.error === 'string' && answer.data.error.trim()
        ? answer.data.error.trim()
        : `\`${path}\` is claimed by another task. Back off: change other files, ask its holder on the peloton, or comment why and release your task.`;
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  }
  const why =
    'error' in answer
      ? answer.error
      : typeof answer.data?.error === 'string'
        ? `HTTP ${answer.status}: ${answer.data.error}`
        : `HTTP ${answer.status}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `The board didn't grant a claim on \`${path}\` (${String(why).slice(0, 200)}), so this edit went ahead unclaimed. Claims are advisory: carry on, and once the board answers, claim it with npx breakaway paths ${claim?.wid ?? '<your task>'} --claim ${path}.`,
    },
  };
}

/**
 * `git status --porcelain -z` → the paths it names: a rename's or copy's new path and its old one, an untracked file,
 * and a deleted one alike.
 * @param {string} out
 */
export function porcelainPaths(out) {
  const parts = String(out ?? '').split('\0');
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // -z puts a rename's or a copy's old path in the next entry, on its own.
    if (/[RC]/u.test(entry.slice(0, 2)) && parts[i + 1]) paths.push(parts[++i]);
  }
  return paths;
}

/**
 * The agent's dirty paths (section 1b): what `git status` lists and what differs from the default branch's merge base,
 * paths only, never contents, sorted. `git(args)` runs git in the checkout and answers its output, or null when it
 * fails. Null when git can't say at all (not a checkout).
 * @param {(args: string[]) => string | null} git
 */
export function dirtyPaths(git) {
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all']);
  if (status === null) return null;
  const paths = new Set(porcelainPaths(status));
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  for (const branch of [head, 'origin/main', 'origin/master'].filter(Boolean)) {
    const base = git(['merge-base', 'HEAD', /** @type {string} */ (branch)])?.trim();
    if (!base) continue;
    const diff = git(['diff', '--name-only', '-z', base]);
    for (const path of String(diff ?? '').split('\0')) if (path) paths.add(path);
    break;
  }
  return [...paths].sort();
}

const notePath = (kind, uuid, dir) => join(dir, `breakaway-${kind}-${String(uuid).replace(/[^\w-]/gu, '')}`);

/** Whether the session hook should report dirty paths now: an edit tool's call or a stop, at most once a minute. */
export function dirtyDue(hook, uuid, { dir = tmpdir(), now = Date.now() } = {}) {
  if (!isEdit(hook) && hook?.hook_event_name !== 'Stop') return false;
  let last = 0;
  try {
    last = Number(readFileSync(notePath('dirty', uuid, dir), 'utf8')) || 0;
  } catch {
    /* never sent */
  }
  if (now - last < DIRTY_EVERY_MS) return false;
  try {
    writeFileSync(notePath('dirty', uuid, dir), String(now));
  } catch {
    /* nowhere to note it: it sends again next time */
  }
  return true;
}

/**
 * The board's answer about the dirty paths → what Claude hears: each conflict the board flagged for the first time
 * (section 1b), or '' when there's none.
 * @param {{ conflicts?: { path: string, task: string, agent: string, pattern: string, new?: boolean }[] } | undefined} footprint
 */
export function conflictText(footprint) {
  const fresh = (footprint?.conflicts ?? []).filter((c) => c?.new);
  return fresh
    .map(
      (c) =>
        `You changed \`${c.path}\`, which ${c.agent} claims on ${c.task} (\`${c.pattern}\`). Agree on the peloton who goes first (@${c.agent}); by default the second one backs off and leaves the file to its holder.`,
    )
    .join('\n');
}

/**
 * A note the session hook couldn't hand Claude yet (a Stop's output can't carry context): kept for the task until its
 * next event that can. `keepNote` adds to it; `takeNote` answers it and clears it.
 */
export function keepNote(uuid, text, dir = tmpdir()) {
  if (!text) return;
  const before = takeNote(uuid, dir);
  try {
    writeFileSync(notePath('note', uuid, dir), [before, text].filter(Boolean).join('\n').slice(-4000));
  } catch {
    /* nowhere to keep it */
  }
}

/** The kept note for task `uuid`, cleared, or ''. */
export function takeNote(uuid, dir = tmpdir()) {
  const path = notePath('note', uuid, dir);
  try {
    const text = readFileSync(path, 'utf8');
    rmSync(path, { force: true });
    return text;
  } catch {
    return '';
  }
}
