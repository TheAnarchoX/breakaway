/**
 * The checkout `mcp --headers` works in (CLI-20). The plugin's headersHelper runs in the plugin's own folder, and
 * Anthropic's plugin directory refuses a helper that moves itself with `cd "${CLAUDE_PROJECT_DIR}"`, so the CLI finds
 * the session's checkout itself: CLAUDE_PROJECT_DIR when the environment has it, else, when it runs in the plugin's
 * folder, the folder of the nearest process above it that works somewhere else, which is Claude Code's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

/**
 * The folder to work in, or null to stay where it is.
 * @param {{
 *   env: Record<string, string | undefined>,
 *   cwd: string,
 *   pid: number,
 *   parentOf: (pid: number) => number | null,
 *   cwdOf: (pid: number) => string | null,
 *   depth?: number,
 * }} options `parentOf` and `cwdOf` read a process's parent and folder, or null when they can't
 */
export function sessionDir({ env, cwd, pid, parentOf, cwdOf, depth = 8 }) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  const root = env.CLAUDE_PLUGIN_ROOT;
  // Only the plugin's helper, run in the plugin's folder: anywhere else, the folder it runs in is the checkout.
  if (!root || !inside(cwd, root)) return null;
  let at = pid;
  for (let i = 0; i < depth; i++) {
    const parent = parentOf(at);
    if (!parent || parent <= 1 || parent === at) return null;
    const dir = cwdOf(parent);
    if (dir && dir !== cwd && !inside(dir, root)) return dir;
    at = parent;
  }
  return null;
}

const inside = (/** @type {string} */ dir, /** @type {string} */ root) => {
  const r = root.replace(/[\\/]+$/u, '');
  return dir === r || dir.startsWith(`${r}/`) || dir.startsWith(`${r}\\`);
};

/** A process's parent: from /proc on Linux, from `ps` elsewhere. */
export function parentOf(/** @type {number} */ pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid …, and comm may hold spaces and parentheses.
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
    }
    if (process.platform === 'win32') return null;
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(out.trim()) || null;
  } catch {
    return null;
  }
}

/** A process's working folder: from /proc on Linux, from `lsof` on macOS and the BSDs. */
export function cwdOf(/** @type {number} */ pid) {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === 'win32') return null;
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}
