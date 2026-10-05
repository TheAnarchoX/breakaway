/**
 * Hands the plugin's settings to the session's Bash commands (CLI-8, docs/specs/IDEA-25-claude-plugin.md, section 2).
 * Claude Code gives a plugin's options to its hooks as CLAUDE_PLUGIN_OPTION_<option>, but not to the commands its
 * skills run, so `/breakaway:next` would find no board. A SessionStart hook may append `export` lines to
 * CLAUDE_ENV_FILE, which Claude Code applies to every later Bash command, so the plugin's SessionStart hook passes
 * them on under the same names: the CLI still reads them after its own settings (scripts/tasks/settings.js).
 */
import { appendFileSync } from 'node:fs';
import { PLUGIN_OPTIONS } from './settings.js';

/** `value` quoted for a POSIX shell. */
const quote = (value) => `'${String(value).replace(/'/gu, `'\\''`)}'`;

/**
 * The `export` lines for the plugin's options that are set, or '' outside a plugin's hook (no CLAUDE_PLUGIN_ROOT)
 * or when none is.
 * @param {Record<string, string | undefined>} env
 */
export function pluginEnvLines(env) {
  if (!env.CLAUDE_PLUGIN_ROOT) return '';
  return Object.values(PLUGIN_OPTIONS)
    .filter((name) => env[name])
    .map((name) => `export ${name}=${quote(env[name])}\n`)
    .join('');
}

/** Appends them to CLAUDE_ENV_FILE when Claude Code gave one (only SessionStart does). Never throws: hooks stay quiet. */
export function passPluginEnv(env = process.env, append = appendFileSync) {
  const lines = env.CLAUDE_ENV_FILE ? pluginEnvLines(env) : '';
  if (!lines) return false;
  try {
    append(env.CLAUDE_ENV_FILE, lines, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
