// What's new (WEB-80): after the board updates, what to tell the person looking at it, from whats-new.json, the file
// the release workflow writes into the web app's files (scripts/release/lib.js, whatsNewOf). A stable gets a dialog;
// a pre-release on the main channel, which comes with every merge, only a small note in a corner. Kept free of JSX so
// it's tested in the Worker test runtime, like links.js.
import { MAIN, STABLE, compareVersions } from '../../../src/versions.js';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

/**
 * The notes for the release the board runs, from whats-new.json, or null when the file is missing, malformed, from
 * another build, or lists no changes.
 * @param {string | null | undefined} running the release the server says it is
 * @param {any} file whats-new.json, parsed
 * @returns {{ channel: 'stable' | 'main', version: string, from: string | null, notes: string, changes: number, url: string | null } | null}
 */
export function notesFor(running, file) {
  if (!running || !file || typeof file !== 'object' || !MAIN.test(String(file.version))) return null;
  let channel;
  let entry;
  if (MAIN.test(running) && file.version === running) {
    channel = 'main';
    entry = file.main;
  } else if (STABLE.test(running) && file.stable?.version === running) {
    channel = 'stable';
    entry = file.stable;
  } else return null;
  if (typeof entry?.notes !== 'string' || !(entry.changes > 0)) return null;
  const repository = typeof file.repository === 'string' && REPOSITORY.test(file.repository) ? file.repository : null;
  return {
    channel,
    version: running,
    from: channel === 'stable' && typeof entry.from === 'string' && STABLE.test(entry.from) ? entry.from : null,
    notes: entry.notes,
    changes: entry.changes,
    url: repository ? `https://github.com/${repository}/releases/tag/v${running}` : null,
  };
}

/**
 * Whether to show what's new on its own, and how: a `dialog` for a stable, a `note` for a pre-release. Only after an
 * update this browser saw happen: never on the first visit (nothing `seen` yet), for the release already seen, or
 * after a roll back to an older one.
 * @param {{ running: string | null | undefined, seen: string | null | undefined, file: any }} o
 * @returns {'dialog' | 'note' | null}
 */
export function showFor({ running, seen, file }) {
  if (!running || !seen || running === seen) return null;
  try {
    if (compareVersions(running, seen) <= 0) return null;
  } catch {
    return null;
  }
  const notes = notesFor(running, file);
  if (!notes) return null;
  return notes.channel === 'stable' ? 'dialog' : 'note';
}
