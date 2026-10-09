import { api, enc } from './api.js';
import { footprintsOverlap } from '../../../src/footprint.js';

/**
 * Footprints on the board (docs/specs/IDEA-55-footprints.md, section 5): reading a task's footprint, and its paths and
 * hit rate in words, for the task panel, the Agents view, the chase, and the Graph view.
 */

/** How long a task's footprint stays fresh, so stepping through tasks doesn't read each one again. */
const FRESH_MS = 20_000;
/** @type {Map<string, { at: number, read: Promise<any> }>} */
const reads = new Map();

/**
 * Task `uuid`'s footprint (GET /api/tasks/:id/footprint), read once per FRESH_MS; `again` reads now. Resolves to null
 * on a board without the route, so the section just stays away.
 * @param {string} uuid
 * @returns {Promise<any>}
 */
export function readFootprint(uuid, again = false) {
  const had = reads.get(uuid);
  if (!again && had && Date.now() - had.at < FRESH_MS) return had.read;
  const read = api(`tasks/${enc(uuid)}/footprint`).then(
    (body) => body.footprint ?? null,
    (error) => {
      reads.delete(uuid);
      if (error.status === 404) return null;
      throw error;
    },
  );
  reads.set(uuid, { at: Date.now(), read });
  return read;
}

/** Forgets the reads, after the owner releases a claim. */
export function forgetFootprint(uuid) {
  reads.delete(uuid);
}

/** What kind of footprint a task has, as its heading says it. */
export const KIND_WORDS = {
  actual: 'What it changes',
  claimed: 'What it claims',
  predicted: 'Predicted',
  unknown: 'Unknown',
};

/** Where a predicted path came from. */
const SOURCE_WORDS = {
  named: 'named on the task',
  spec: 'named in its spec',
  related: 'named on a related task',
  similar: 'changed by tasks like it',
};

/** How a claim was made, when it wasn't an edit or `tasks paths`. */
const CLAIM_WORDS = { dirty: ' when it changed it', checkin: ' at check-in' };

/** Minutes until `iso`, in words. */
export function runsOut(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  return minutes < 1 ? 'runs out now' : `runs out in ${minutes} min`;
}

/**
 * One path's mark, in words: `label` is the short mark shown beside it, `detail` the rest.
 * @param {any} p
 * @param {number} [now]
 * @returns {{ label: string, detail: string }}
 */
export function pathMark(p, now = Date.now()) {
  if (p.state === 'claimed')
    return {
      label: 'Claimed',
      detail: `by ${p.agent}${CLAIM_WORDS[p.source] ?? ''}, ${runsOut(p.until, now)}`,
    };
  if (p.state === 'dirty') return { label: 'Changed', detail: 'not claimed' };
  if (p.state === 'pull')
    return {
      label: 'Pull request',
      detail: p.holds === false ? 'quiet over a day, so it holds nothing' : 'its files',
    };
  return { label: 'Predicted', detail: SOURCE_WORDS[p.source] ?? p.source ?? '' };
}

/**
 * The repository's hit rate in words, or null before any merged task had a prediction to compare.
 * @param {{ rate: number | null, count: number, trusted?: boolean } | null | undefined} hit
 */
export function hitRateWords(hit) {
  if (!hit?.count || hit.rate === null || hit.rate === undefined) return null;
  const words = `Predictions covered ${Math.round(hit.rate * 100)}% of the files the last ${hit.count === 1 ? 'merged task' : `${hit.count} merged tasks`} changed`;
  return hit.trusted === false ? `${words}, under half, so the board schedules by area here.` : `${words}.`;
}

/** How often the Graph view reads every open task's footprint again while it's open. */
export const GRAPH_EVERY_MS = 60_000;

/**
 * Every open task's footprint (GET /api/footprints, WEB-130) as a map by task UUID, each `{ repo, kind, patterns,
 * paths, trusted, shared }`. Resolves to an empty map on a board without the route.
 * @returns {Promise<Map<string, any>>}
 */
export async function readFootprints() {
  try {
    const { repos } = await api('footprints');
    const out = new Map();
    for (const r of repos ?? [])
      for (const f of r.footprints) out.set(f.uuid, { ...f, repo: r.repo, shared: r.shared });
    return out;
  } catch (error) {
    if (error.status === 404) return new Map();
    throw error;
  }
}

/**
 * The open tasks among `uuids` whose footprints overlap, as `[a, b, path]` with the first shared path (the file
 * rather than the folder or glob it falls under). Only footprints a starter would trust count, and shared files never
 * do, the same as the board's own collision rule.
 * @param {string[]} uuids
 * @param {Map<string, any>} prints
 * @returns {[string, string, string][]}
 */
export function sharePairs(uuids, prints) {
  const hasGlob = (/** @type {string} */ p) => /[*?]|\/$/u.test(p);
  const known = uuids.filter((u) => {
    const f = prints.get(u);
    return f && f.trusted !== false && f.patterns?.length;
  });
  /** @type {[string, string, string][]} */
  const out = [];
  for (let i = 0; i < known.length; i++)
    for (let j = i + 1; j < known.length; j++) {
      const a = prints.get(known[i]);
      const b = prints.get(known[j]);
      if (a.repo !== b.repo) continue;
      const hit = footprintsOverlap(a.patterns, b.patterns, { shared: a.shared ?? [] });
      if (hit) out.push([known[i], known[j], hasGlob(hit.a) && !hasGlob(hit.b) ? hit.b : hit.a]);
    }
  return out;
}
