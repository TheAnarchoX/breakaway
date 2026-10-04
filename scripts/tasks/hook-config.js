/**
 * What the session hooks share: the task this checkout claimed (.task-session, written by
 * `tasks claim`) and where the board is, found the same way as the CLI (scripts/tasks/settings.js).
 * Each returns null/undefined rather than throwing when something's missing, because the hooks stay quiet.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boardUrl, configDir, parseEnvFile, readSetting } from './settings.js';

/** The git root of the current folder, or null outside a repository. */
function gitRoot() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The project's root: as Claude Code gives it to hooks, and where it doesn't (a cloud session can leave
 * CLAUDE_PROJECT_DIR empty, BRK-88), the git root of the folder the hook runs in, where `tasks claim` marks the task.
 */
export function projectRoot(env = process.env, root = gitRoot, cwd = process.cwd()) {
  return env.CLAUDE_PROJECT_DIR || root() || cwd;
}

/** A file's text, or null when it can't be read. */
function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** This machine's tasks.env, as `{ NAME: value }`. */
function envFile() {
  const dir = configDir({ env: process.env, home: homedir() });
  return parseEnvFile(readOptional(join(dir, 'tasks.env')));
}

/** `{ uuid, agent, … }` from .task-session, or null without one (or with BREAKAWAY_SESSION_LOG=off). */
export function claimedTask(root = projectRoot()) {
  if (readSetting('SESSION_LOG', { env: process.env, file: envFile() }) === 'off') return null;
  const marker = join(root, '.task-session');
  if (!existsSync(marker)) return null;
  try {
    const claim = JSON.parse(readFileSync(marker, 'utf8'));
    return claim?.uuid ? claim : null;
  } catch {
    return null;
  }
}

/** The board's base URL (null when nothing says which board) and, outside a cloud session, its token. */
export function boardConfig(root = projectRoot()) {
  const file = envFile();
  let config = null;
  try {
    config = JSON.parse(readOptional(join(root, 'tools', 'tasks', 'breakaway.config.json')) ?? 'null');
  } catch {
    /* the CLI says what's wrong with it */
  }
  const { url } = boardUrl({ env: process.env, file, taskrc: readOptional(join(root, '.taskrc')), config });
  // In a cloud session there's no token here: the environment's API credential adds it.
  const token = readSetting('TOKEN', { env: process.env, file });
  return { base: url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

/** The board says this checkout's task isn't claimed by its agent any more: drop the marker so later calls post nothing (BRK-87). */
export function dropClaim(claim, root = projectRoot()) {
  try {
    const marker = join(root, '.task-session');
    if (JSON.parse(readFileSync(marker, 'utf8'))?.uuid === claim.uuid) rmSync(marker);
  } catch {
    /* already gone */
  }
}
