/**
 * The session hooks when breakaway's plugin runs them (BRK-159, docs/specs/IDEA-25-claude-plugin.md, section 7): a
 * checkout repos init set up before the plugin, or with --copies, runs the same hooks from its .claude/settings.json,
 * so a person who installed the plugin would post each entry twice. Claude Code sets CLAUDE_PLUGIN_ROOT for a plugin's
 * hooks, and then the plugin's hooks step aside for the checkout's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A session hook command repos init writes: through npx, any version, or an old copy's script. */
const BOARD_HOOK =
  /\bbreakaway(?:@[^\s"]+)? hook (?:session|wait)\b|scripts\/tasks\/(?:session-hook|message-wait)\.mjs/u;
/** The edit hook (IDEA-55): settings from before it run the other hooks but not this one. */
const EDIT_HOOK = /\bbreakaway(?:@[^\s"]+)? hook edit\b|scripts\/tasks\/edit-hook\.mjs/u;

/** A file's text, or null when it can't be read. */
function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether this hook is the plugin's and the checkout's settings already run the board's hooks, so this one does
 * nothing. Outside the plugin it's always false: the checkout's own hooks always run.
 */
export function checkoutRunsHooks(root, env = process.env, read = readOptional, hook = 'session') {
  if (!env.CLAUDE_PLUGIN_ROOT) return false;
  const runs = hook === 'edit' ? EDIT_HOOK : BOARD_HOOK;
  return ['settings.json', 'settings.local.json'].some((name) => runs.test(read(join(root, '.claude', name)) ?? ''));
}
