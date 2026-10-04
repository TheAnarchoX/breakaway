#!/usr/bin/env node
/**
 * Claude Code Stop hook (async, asyncRewake; see .claude/settings.json): while the agent is idle,
 * waiting on CI or a review, asks the board every 20 seconds whether the owner sent it a message.
 * It wakes for a reply to one of the agent's peloton posts too, never for the peloton's other posts
 * (docs/specs/IDEA-32-peloton.md). On one, it writes the message to stderr and exits 2, which wakes Claude with it as a system
 * reminder (docs/specs/IDEA-15-message-a-running-agent.md). After its 4-minute window it ends
 * quietly, and a message waits for the agent's next turn; its `timeout` (300 s) outlasts the window,
 * because Claude Code kills an async hook at its timeout (CLD-146).
 *
 * Quiet by design: without a claimed task (.task-session), with BREAKAWAY_SESSION_LOG=off, or
 * on any error, it exits 0. It writes nothing inside the repository: a cloud session's Stop check
 * would take a dirty file as work to commit.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { boardConfig, claimedTask, projectRoot } from './hook-config.js';
import { sessionRequest } from './proxy.js';
import { waitForMessages } from './session-messages.js';

async function main() {
  const root = projectRoot();
  const claim = claimedTask(root);
  if (!claim?.agent) return 0;
  for await (const _ of process.stdin); // Claude Code sends the hook's input; it isn't needed.

  // Each stop starts a new wait; the newest one listens and older ones stop, so only one asks at a time.
  const turn = randomUUID();
  const latest = join(tmpdir(), `breakaway-message-wait-${claim.uuid.replace(/[^\w-]/gu, '')}`);
  writeFileSync(latest, turn);
  const listening = () => {
    const now = claimedTask(root);
    if (now?.uuid !== claim.uuid || now?.agent !== claim.agent) return false;
    try {
      return readFileSync(latest, 'utf8') === turn;
    } catch {
      return false;
    }
  };

  const { base, headers } = boardConfig(root);
  if (!base) return;
  const url = `${base}/api/tasks/${encodeURIComponent(claim.uuid)}/messages/waiting?agent=${encodeURIComponent(claim.agent)}`;
  // Through curl in a cloud session, so it works on whichever Node runs hooks there (BRK-86).
  const ask = async () => {
    const res = await sessionRequest(url, { headers, timeoutMs: 10_000 });
    return res.ok ? res.json() : null;
  };

  const text = await waitForMessages({ ask, sleep, now: Date.now, listening });
  if (listening()) rmSync(latest, { force: true });
  if (!text) return 0;
  process.stderr.write(`${text}\n`);
  return 2;
}

main()
  .catch(() => 0)
  .then((code) => process.exit(code));
