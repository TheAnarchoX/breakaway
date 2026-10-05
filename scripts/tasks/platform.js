/**
 * The systems the install supports (CLI-3, decided in BRK-140): macOS, Linux, and Windows through WSL. The commands
 * that write a secret run `npx wrangler` without a shell, and `setup` runs a `#!/bin/sh` script, so on Windows
 * itself (PowerShell or cmd) they stop before doing anything. Where wrangler can't run, the reason it gives is what's
 * reported, not a guess. Pure, so it's tested without Windows or wrangler.
 */

export const WSL_URL = 'https://learn.microsoft.com/windows/wsl/install';

/**
 * Null on a supported system; on Windows itself, the message that stops `command`.
 *
 * @param {string} command
 * @param {string} platform `process.platform`
 * @returns {string | null}
 */
export function unsupportedSystem(command, platform) {
  if (platform !== 'win32') return null;
  return `npx breakaway ${command} doesn't run on Windows itself, so nothing was changed. Install WSL (${WSL_URL}), then run it in WSL's terminal: the board supports macOS, Linux, and Windows through WSL.`;
}

/** Colours and wrangler's box-drawing around its messages. */
const NOISE = /\u001b\[[0-9;]*m|[│┌┐└┘─╭╮╰╯]/gu;

/** Lines that say nothing about the failure: wrangler's banner and npm's warnings. */
const CHATTER = /^(\S+\s+)?wrangler \d+\.\d+|^npm (warn|notice)|^Update available/iu;

/** @param {string | null | undefined} text */
const meaningful = (text) =>
  (text ?? '')
    .replace(NOISE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !CHATTER.test(line));

/**
 * Why a `spawnSync('npx', ['wrangler', …])` failed, in one line: npx missing or not runnable, else wrangler's own
 * error (its `✘ [ERROR]` line, or its last line of output), else its exit code.
 *
 * @param {{ error?: (Error & { code?: string }) | undefined, status: number | null, signal?: string | null, stdout?: string | null, stderr?: string | null }} res
 * @returns {string}
 */
export function wranglerFailure(res) {
  if (res.error?.code === 'ENOENT')
    return "npx isn't on this machine's PATH; install Node.js 20 or newer, then run this again";
  if (res.error) return `npx couldn't run (${res.error.message})`;
  const stderr = meaningful(res.stderr);
  const stdout = meaningful(res.stdout);
  const error = [...stderr, ...stdout].find((line) => /^✘\s*\[ERROR\]/u.test(line));
  if (error) return `wrangler said: ${error.replace(/^✘\s*\[ERROR\]\s*/u, '')}`;
  const last = (stderr.length ? stderr : stdout).at(-1);
  if (last) return `wrangler said: ${last}`;
  if (res.signal) return `wrangler stopped (${res.signal})`;
  return `wrangler stopped with exit code ${res.status}`;
}
