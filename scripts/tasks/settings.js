/**
 * Which board install the CLI and the session hooks talk to, and the names of their settings (CLD-136,
 * docs/specs/IDEA-13-breakaway.md, section 2). Every setting has a breakaway name (BREAKAWAY_URL) and the
 * name the first install used before breakaway (SAMEWAVE_TASKS_URL), read as a fallback so existing machines,
 * cloud environments, and agents keep working. Pure (the environment, files, and checks come in as arguments),
 * so it's tested without a disk.
 */
/** Each setting's breakaway name, then the fallback the first install set up. */
export const NAMES = Object.freeze({
  URL: ['BREAKAWAY_URL', 'SAMEWAVE_TASKS_URL'],
  TOKEN: ['BREAKAWAY_TOKEN', 'SAMEWAVE_TASKS_TOKEN'],
  AGENT: ['BREAKAWAY_AGENT', 'SAMEWAVE_AGENT'],
  REPO: ['BREAKAWAY_REPO', 'SAMEWAVE_TASKS_REPO'],
  CLIENT_ID: ['BREAKAWAY_CLIENT_ID', 'SAMEWAVE_TASKS_CLIENT_ID'],
  SECRET: ['BREAKAWAY_SECRET', 'SAMEWAVE_TASKS_SECRET'],
  SYNC_KEY: ['BREAKAWAY_SYNC_KEY', 'SAMEWAVE_TASKS_SYNC_KEY'],
  SESSION_LOG: ['BREAKAWAY_SESSION_LOG', 'SAMEWAVE_TASKS_SESSION_LOG'],
});

const LEGACY_NAMES = new Set(Object.values(NAMES).map(([, legacy]) => legacy));

/**
 * A setting's value: from the environment first (either name), then the env file (either name), else
 * `fallback`. The environment always wins, so `BREAKAWAY_URL=… npx breakaway` points one command elsewhere.
 */
export function readSetting(key, { env = {}, file = {} }, fallback) {
  const names = NAMES[key];
  if (!names) throw new Error(`no setting ${key}`);
  for (const source of [env, file]) for (const name of names) if (source[name]) return source[name];
  return fallback;
}

/** True when an env file uses the first install's names, so the CLI writes it back with the same ones. */
export const usesLegacyNames = (file) => Object.keys(file ?? {}).some((name) => LEGACY_NAMES.has(name));

/** A setting's name in an env file the CLI writes: the file's own style, breakaway's for a new one. */
export const nameFor = (key, legacy) => NAMES[key][legacy ? 1 : 0];

/**
 * This machine's folder for the board (tasks.env, the Taskwarrior credentials, the routines copy):
 * BREAKAWAY_HOME when it's set (one per install, for a machine that uses two), else ~/.config/breakaway,
 * else ~/.config/samewave when only that one exists (a machine set up before breakaway), else ~/.config/breakaway.
 */
/** @param {{ env?: Record<string, string | undefined>, home?: string, exists: (path: string) => boolean }} options */
export function configDir({ env = {}, home, exists }) {
  if (env.BREAKAWAY_HOME) return env.BREAKAWAY_HOME.replace(/\/$/u, '');
  const breakaway = `${home}/.config/breakaway`;
  const samewave = `${home}/.config/samewave`;
  return !exists(breakaway) && exists(samewave) ? samewave : breakaway;
}

/** `path` as a Taskwarrior include line can name it: `~/…` under `home`, else as it is. */
export const tildePath = (path, home) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** The `sync.server.url` a .taskrc sets (the last one wins, as in Taskwarrior), or null. */
export function taskrcUrl(text) {
  const all = [...String(text ?? '').matchAll(/^\s*sync\.server\.url\s*=\s*(\S+)\s*$/gmu)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * The board's base URL, and where it came from: the environment or env file (BREAKAWAY_URL, then
 * SAMEWAVE_TASKS_URL), else the checkout's own .taskrc (`sync.server.url`, so the CLI and Taskwarrior agree),
 * else the install's breakaway.config.json (`url`), else null: nothing says which board.
 */
export function boardUrl({ env = {}, file = {}, taskrc = null, config = null }) {
  const pick = () => {
    const set = readSetting('URL', { env, file });
    if (set) return { url: set, from: 'setting' };
    const rc = taskrcUrl(taskrc);
    if (rc) return { url: rc, from: '.taskrc' };
    if (config?.url) return { url: config.url, from: 'config' };
    return { url: null, from: 'default' };
  };
  const { url, from } = pick();
  return { url: url ? String(url).replace(/\/+$/u, '') : null, from };
}

/** An env file's text as `{ NAME: value }`: `NAME=value` lines, quotes stripped, comments ignored. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/u.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** `text` for a RegExp, matched literally. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * What a checkout's .taskrc (`text`, null when there's none) needs so Taskwarrior syncs with the same board as
 * the CLI: one line per fix, none when it already does. Taskwarrior can't read the environment, so .taskrc names
 * the server (`url`) and includes this machine's taskrc with the sync credentials (`include` as written, `file`
 * as an absolute path).
 */
export function taskrcFixes(text, { url, include, file }) {
  if (text === null || text === undefined) return ['This checkout has no .taskrc; see docs/tasks.md#another-install.'];
  const out = [];
  const set = taskrcUrl(text);
  if (set?.replace(/\/+$/u, '') !== url)
    out.push(`.taskrc syncs with ${set ?? 'no server'}, but the CLI uses ${url}: set sync.server.url=${url} in it.`);
  if (!new RegExp(`^\\s*include\\s+(?:${literal(include)}|${literal(file)})\\s*$`, 'mu').test(text))
    out.push(
      `.taskrc doesn't include ${include}, which has the sync credentials: add "include ${include}" as its last line.`,
    );
  return out;
}
