/**
 * A task's footprint in words (docs/specs/IDEA-55-footprints.md, section 5), the same for `tasks show`, `tasks paths`,
 * and the MCP server's footprint read: each pattern marked predicted, claimed (with when it runs out), changed, or from
 * the pull request, and the shared files left out. Pure, so the CLI ships it.
 */

/** @param {string} iso @param {number} now */
function runsOut(iso, now) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  return minutes < 1 ? 'runs out now' : `runs out in ${minutes} min`;
}

/** @param {any} p one path of a footprint @param {number} now */
function pathNote(p, now) {
  if (p.state === 'claimed')
    return `claimed by ${p.agent}${p.source === 'claim' ? '' : ` (${p.source})`}, ${runsOut(p.until, now)}`;
  if (p.state === 'dirty') return 'changed, not claimed';
  if (p.state === 'pull') return p.holds === false ? 'pull request, quiet over a day: holds nothing' : 'pull request';
  return `predicted (${p.source})`;
}

const HEADS = {
  unknown: 'unknown: nothing names a path yet, so it’s scheduled by its area',
  predicted: 'predicted',
  claimed: 'claimed',
  actual: 'actual',
};

/**
 * The Footprint section's lines, indented like `tasks show`'s other sections.
 * @param {any} fp the footprint from GET /api/tasks/:id/footprint
 * @param {number} [now]
 * @returns {string[]}
 */
export function footprintLines(fp, now = Date.now()) {
  const kind = /** @type {keyof typeof HEADS} */ (fp?.kind ?? 'unknown');
  const out = [
    `  Footprint (${HEADS[kind] ?? kind}${kind === 'predicted' && fp.trusted === false ? ', not trusted in this repository' : ''})`,
  ];
  const paths = fp?.paths ?? [];
  const width = Math.min(48, Math.max(0, ...paths.map((/** @type {any} */ p) => p.pattern.length)));
  for (const p of paths) out.push(`    ${p.pattern.padEnd(width)}  ${pathNote(p, now)}`);
  if (fp?.pull) out.push(`    from #${fp.pull.number}${fp.pull.partial ? ' (more files than GitHub lists)' : ''}`);
  for (const c of fp?.conflicts ?? [])
    out.push(`    conflict: changed ${c.path}, which ${c.agent} claims on ${c.task} (${c.pattern})`);
  if (fp?.shared?.length) out.push(`    left out, shared: ${fp.shared.join(', ')}`);
  const rate = fp?.hitRate;
  if (rate?.count)
    out.push(
      `    predictions here covered ${Math.round(rate.rate * 100)}% of the files the last ${rate.count} merged task${rate.count === 1 ? '' : 's'} changed`,
    );
  return out;
}

/**
 * What a claim answered, in words: what was granted, already held, and refused, with who holds it.
 * @param {{ granted?: { pattern: string, until: string }[], held?: string[], refused?: { pattern: string, holder: any }[],
 *   released?: string[] }} result
 * @param {number} [now]
 */
export function claimLines(result, now = Date.now()) {
  const out = [];
  for (const g of result.granted ?? [])
    out.push(`Claimed ${g.pattern} (${runsOut(g.until, now)} without a heartbeat).`);
  for (const pattern of result.held ?? []) out.push(`Already yours: ${pattern}.`);
  for (const r of result.refused ?? [])
    out.push(
      `Refused ${r.pattern}: ${r.holder.agent} claims ${r.holder.pattern} on ${r.holder.task}, active ${new Date(r.holder.active).toISOString().slice(11, 16)} UTC. Change other files, ask @${r.holder.agent} on the peloton, or comment why and release your task.`,
    );
  if (result.released)
    out.push(result.released.length ? `Released ${result.released.join(', ')}.` : 'Nothing to release.');
  return out;
}

/** Riders and patterns a start payload names before "and n more" (section 4). */
const BESIDE_RIDERS = 8;
const BESIDE_PATTERNS = 6;

/**
 * The start payload's "Riding beside you" lines (section 4): one per agent already running in the repository, with
 * what it's changing. None when nobody with a known footprint is.
 * @param {{ task: string, agent: string, patterns: string[] }[] | null | undefined} riders
 * @returns {string[]}
 */
export function besideLines(riders) {
  const list = riders ?? [];
  const lines = list.slice(0, BESIDE_RIDERS).map((r) => {
    const more = r.patterns.length - BESIDE_PATTERNS;
    return `Riding beside you: ${r.task} (${r.agent}) is changing ${r.patterns.slice(0, BESIDE_PATTERNS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  });
  if (list.length > BESIDE_RIDERS) lines.push(`Riding beside you: ${list.length - BESIDE_RIDERS} more agents`);
  return lines;
}
