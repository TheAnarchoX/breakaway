#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook on the edit tools (synchronous, see sessionHooks() in src/init.js): claims the file an
 * edit names for the task this checkout holds before the edit runs (docs/specs/IDEA-55-footprints.md, section 1a).
 * Granted, or already the task's: the edit goes ahead and the hook says nothing. Claimed by another task: the edit is
 * denied with who holds it and how to back off, which Claude reads. The board not answering in time, or answering
 * anything else: the edit goes ahead and Claude hears why it isn't claimed. Claims are advisory, so a board that's
 * down never stops work.
 *
 * Quiet by design: without a claimed task (.task-session), with BREAKAWAY_SESSION_LOG=off, for a file outside the
 * checkout, or on any error of its own, it does nothing and exits 0, which lets the edit through.
 */
import { checkoutRunsHooks } from './plugin-hooks.js';
import { boardConfig, claimedTask, projectRoot } from './hook-config.js';
import { EDIT_CLAIM_MS, editedPath, editOutput, isEdit } from './footprint-hook.js';
import { sessionRequest } from './proxy.js';

async function main() {
  const root = projectRoot();
  // The plugin's copy of this hook steps aside when the checkout's settings run it too (BRK-159).
  if (checkoutRunsHooks(root, process.env, undefined, 'edit')) return;
  const claim = claimedTask(root);
  if (!claim?.agent) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const hook = JSON.parse(input || '{}');
  if (!isEdit(hook)) return;
  const path = editedPath(hook, root);
  if (!path) return;

  const { base, headers } = boardConfig(root);
  if (!base) return;
  /** @type {{ status: number, data?: any } | { error: string }} */
  let answer;
  try {
    // Through curl in a cloud session, so it works on whichever Node runs hooks there (BRK-86).
    const res = await sessionRequest(`${base}/api/tasks/${encodeURIComponent(claim.uuid)}/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ agent: claim.agent, claim: [path] }),
      timeoutMs: EDIT_CLAIM_MS,
    });
    answer = { status: res.status, data: await res.json().catch(() => null) };
  } catch (error) {
    answer = { error: /** @type {Error} */ (error)?.message ?? String(error) };
  }
  const output = editOutput(answer, path, claim);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
