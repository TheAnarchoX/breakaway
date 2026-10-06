/**
 * Architect's break-glass, the pure part (docs/specs/IDEA-19-architect.md, "Break-glass"; BRK-187): the owner changed
 * something by hand, outside a plan, and marks the drift it made as break-glass. The board records it once in the audit
 * trail and makes one task, in the environment's repository, to put the change into its desired-state file by pull
 * request (BRK-171). It never proposes undoing it: no drift plan is made for a change marked as break-glass while it
 * still differs. The store (store-infra-break-glass.js) keeps the marks.
 *
 * Pure and Node-safe, so the CLI can import it: no store and no network.
 */
import { AgentError } from './store-agents.js';
import { redact } from './redact.js';
import { desiredPath } from './infra-desired.js';
import { driftLine } from './infra-drift.js';

/** @typedef {import('./infra-provider.js').Change} Change */
/** @typedef {import('./infra-provider.js').PlanDiff} PlanDiff */

/** The longest note the owner gives a break-glass, in characters. */
export const BREAK_GLASS_NOTE_MAX = 500;
/** The most changes a follow-up task lists one by one; the rest are counted. */
export const BREAK_GLASS_LISTED = 40;
/** The longest setting's value a follow-up task quotes. */
const VALUE_MAX = 80;

/**
 * The owner's note on a break-glass: what they changed by hand and why. Required, redacted, one paragraph, at most
 * BREAK_GLASS_NOTE_MAX characters; an AgentError (400) says what's wrong.
 * @param {unknown} note
 */
export function breakGlassNote(note) {
  const text = redact(String(note ?? ''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) throw new AgentError('say what you changed by hand and why: a break-glass needs a note', 400);
  if (text.length > BREAK_GLASS_NOTE_MAX)
    throw new AgentError(`a break-glass note is at most ${BREAK_GLASS_NOTE_MAX} characters`, 400);
  return text;
}

/**
 * A key per change, sorted: hex SHA-256 of each change's line (infra-drift.js's driftLine). A mark covers the changes
 * whose keys it holds, so the same change found again is still the one the owner marked.
 * @param {PlanDiff} diff
 * @returns {Promise<string[]>}
 */
export async function breakGlassKeys(diff) {
  const keys = await Promise.all(
    diff.changes.map(async (c) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(driftLine(c)));
      return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }),
  );
  return [...new Set(keys)].sort();
}

/**
 * Whether a mark still stands for what differs now: at least one change it covers is still in the drift.
 * @param {string[]} marked a mark's keys
 * @param {string[]} now the keys of what differs now
 */
export function breakGlassCovers(marked, now) {
  const set = new Set(now);
  return marked.some((k) => set.has(k));
}

/** A setting's value, quoted short and redacted. */
function quoted(value) {
  const s = redact(JSON.stringify(value ?? null));
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s;
}

/**
 * What to write into the desired-state file for one change, so the file says what runs. The drift's change is what a
 * plan would do to bring what runs back to the file: `before` is what runs, `after` what the file says.
 * @param {Change} c
 */
export function breakGlassLine(c) {
  const what = `${c.kind} \`${c.name}\` (\`${c.resource}\`)`;
  if (c.op === 'create') return `- Remove ${what}: the file has it, and nothing like it runs.`;
  if (c.op === 'delete') {
    const settings = Object.entries(c.before ?? {}).map(([k, v]) => `${k}: ${quoted(v)}`);
    return `- Add ${what}, which runs but isn’t in the file${settings.length ? `, with ${settings.join(', ')}` : ''}.`;
  }
  const before = c.before ?? {};
  const after = c.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const differs = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!differs.length) return `- Check ${what}: it differs from the file (${c.op}).`;
  const set = differs.map((k) =>
    k in before
      ? `${k}: ${quoted(before[k])} (the file says ${k in after ? quoted(after[k]) : 'nothing'})`
      : `remove ${k}`,
  );
  return `- In ${what}, set ${set.join('; ')}.`;
}

/**
 * The follow-up task a break-glass makes in the environment's repository: put what runs into the desired-state file
 * by pull request. Its brief names the file and each change to write into it.
 * @param {{ environment: string, note: string, changes: Change[] }} input
 * @returns {{ description: string, brief: string, done_when: string }}
 */
export function breakGlassTask({ environment, note, changes }) {
  const file = desiredPath(environment);
  const listed = changes.slice(0, BREAK_GLASS_LISTED).map(breakGlassLine);
  const more = changes.length - listed.length;
  const brief = [
    `The owner changed ${environment} by hand and marked it as break-glass: “${note}”`,
    '',
    `Put the change into code: write what runs now into \`${file}\`, so the file says what runs and the drift is gone. Don’t undo the change, and don’t apply anything: the pull request changes only the file.`,
    '',
    ...listed,
    ...(more > 0 ? [`- And ${more} more: compare the environment on the board for the rest.`] : []),
  ].join('\n');
  return {
    description: `Put ${environment}’s break-glass change into ${file}`,
    brief,
    done_when: `${file} says what runs, so the board's next comparison of ${environment} finds no drift from these changes, and the file passes its check.`,
  };
}
