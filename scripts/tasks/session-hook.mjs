#!/usr/bin/env node
/**
 * Claude Code hook (async, see .claude/settings.json): sends one short entry about what this
 * session just did to the task it has claimed, so the board can show the session live
 * (docs/specs/CLD-35-cloud-agents.md). For watching only; the board keeps it 14 days at most.
 * The board answers with the owner's messages waiting for this agent, which the hook prints as
 * additionalContext so Claude gets them on its next turn (docs/specs/IDEA-15-message-a-running-agent.md), and with
 * the peloton's posts this agent hasn't seen, in the board's order, up to 10 at a time in a chase and 5 elsewhere
 * (docs/specs/IDEA-36-peloton-planning.md, section 3).
 *
 * Quiet by design: without a claimed task (.task-session, written by `tasks claim`), with
 * BREAKAWAY_SESSION_LOG=off, or on any error, it does nothing and exits 0. A post
 * that fails leaves its reason in the temp folder, which the CLI's next command here shows (BRK-86).
 *
 * Run by the plugin at SessionStart, it first passes the plugin's settings on to the session's Bash commands (CLI-8).
 *
 * After an edit tool's call and at a stop, at most once a minute, the post carries the agent's dirty paths (paths
 * only, never contents), and the board answers with what they conflict with, which Claude hears on its next turn
 * (docs/specs/IDEA-55-footprints.md, section 1b).
 */
import { checkoutRunsHooks } from './plugin-hooks.js';
import { boardConfig, claimedTask, dropClaim, projectRoot } from './hook-config.js';
import { execFileSync } from 'node:child_process';
import { conflictText, dirtyDue, dirtyPaths, keepNote, takeNote } from './footprint-hook.js';
import { passPluginEnv } from './plugin-env.js';
import { clearHookFailure, noteHookFailure, sessionRequest } from './proxy.js';
import { entryFor } from './session-log.js';
import { CONTEXT_EVENTS, messageOutput, releasedOutput } from './session-messages.js';

async function main() {
  passPluginEnv();
  const root = projectRoot();
  // The plugin's copy of this hook steps aside when the checkout's settings run it too (BRK-159).
  if (checkoutRunsHooks(root)) return;
  const claim = claimedTask(root);
  if (!claim) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const hook = JSON.parse(input || '{}');
  const entry = entryFor(hook, root);
  if (!entry) return;

  const { base, headers } = boardConfig(root);
  if (!base) return noteHookFailure(claim.uuid, 'no board address: set BREAKAWAY_URL');
  const dirty = claim.agent && dirtyDue(hook, claim.uuid) ? dirtyPaths(git(root)) : null;
  let res;
  try {
    // Through curl in a cloud session, so it works on whichever Node runs hooks there (BRK-86).
    res = await sessionRequest(`${base}/api/tasks/${encodeURIComponent(claim.uuid)}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        agent: claim.agent,
        session: hook.session_id ?? null,
        remote: process.env.CLAUDE_CODE_REMOTE === 'true',
        entries: [entry],
        // A Stop hook's output can't reach Claude, so it leaves the messages for the next event.
        messages: CONTEXT_EVENTS.has(hook.hook_event_name),
        ...(dirty ? { dirty } : {}),
      }),
      timeoutMs: 4000,
    });
  } catch (error) {
    return noteHookFailure(claim.uuid, /** @type {Error} */ (error)?.message ?? String(error));
  }
  if (!res.ok) return noteHookFailure(claim.uuid, `HTTP ${res.status}`);
  clearHookFailure(claim.uuid);
  const answer = await res.json();
  if (answer?.released) {
    dropClaim(claim, root);
    const output = releasedOutput(claim, hook.hook_event_name);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  // What the dirty paths conflict with, and what an earlier event couldn't say, go with the messages.
  const conflicts = conflictText(answer?.footprint);
  if (!CONTEXT_EVENTS.has(hook.hook_event_name)) return keepNote(claim.uuid, conflicts);
  const note = [takeNote(claim.uuid), conflicts].filter(Boolean).join('\n');
  const output = messageOutput(answer, hook.hook_event_name, note);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** Runs git in the checkout: its output, or null when it fails. */
function git(root) {
  return (/** @type {string[]} */ args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
