/**
 * The owner's messages from the board, as the session hook hands them to Claude
 * (docs/specs/IDEA-15-message-a-running-agent.md), and the peloton's posts with them
 * (docs/specs/IDEA-32-peloton.md, IDEA-36-peloton-planning.md section 3). Pure, so it runs in the hook (Node) and in the Worker test runtime.
 */
import { pelotonContext } from './peloton.js';

/** Hook events whose output can carry `additionalContext`; on the others the hook doesn't ask for messages. */
export const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);

/** `2026-10-01T14:02:31.000Z` → `1 Oct 2026, 14:02 UTC`; anything else as it came. */
export function sentAt(sent) {
  const date = new Date(sent);
  if (typeof sent !== 'string' || Number.isNaN(date.getTime())) return '';
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const time = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${time} UTC`;
}

/**
 * The board's answer to the session post, and the hook's event → the JSON the hook prints, or
 * null when there's nothing to say (no messages or posts, an event that can't carry them, a bad answer).
 * `note` is the hook's own word after them: a conflict on a changed path (IDEA-55 section 1b).
 */
export function messageOutput(answer, event, note = '') {
  if (!CONTEXT_EVENTS.has(event)) return null;
  const text = [waitingText(answer), note].filter(Boolean).join('\n\n');
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** The one line the hook says when the board no longer has this checkout's task claimed by its agent (BRK-87), or null on an event that can't carry it. */
export function releasedOutput(claim, event) {
  if (!CONTEXT_EVENTS.has(event)) return null;
  const text = `${claim.wid ?? 'The task'} is no longer claimed by ${claim.agent ?? 'this agent'} (finished or released), so this checkout stops sending its live output. \`tasks claim\` starts it again on another task.`;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** The board's answer → the messages as Claude reads them, one paragraph each, or '' when there are none. */
export function messageText(answer) {
  const messages = Array.isArray(answer?.messages) ? answer.messages : [];
  return messages
    .filter((m) => typeof m?.text === 'string' && m.text.trim())
    .map((m) => {
      const at = sentAt(m.sent);
      return `Message from the owner (via the board${at ? `, ${at}` : ''}): ${m.text.trim()}`;
    })
    .join('\n\n');
}

/**
 * The board's answer → everything waiting for the agent, as Claude reads it: the owner's messages first, then the
 * peloton's posts it hasn't seen, in the board's order, and how many more it didn't send. '' when there's nothing.
 */
export function waitingText(answer) {
  return [messageText(answer), pelotonContext(answer?.peloton, answer?.pelotonMore)].filter(Boolean).join('\n\n');
}

/** How long the idle wait hook listens after Claude stops (CLD-146: a cloud session keeps it alive up to 5 idle minutes). */
export const WAIT_WINDOW_MS = 240_000;
/** How often it asks the board. */
export const WAIT_EVERY_MS = 20_000;

/**
 * The idle wait hook's loop (scripts/tasks/message-wait.mjs): asks the board for waiting messages (and the peloton's
 * posts when one is urgent: the owner's, a huddle opening or closing, a mention of the agent, or a reply to it; IDEA-36
 * section 3) every `every` ms until one comes, the window ends, or `listening()` says to stop (the claim
 * went, or a newer wait hook took over). Returns the text to wake Claude with, or '' to end
 * quietly. A failed ask counts as nothing waiting; the next one tries again.
 *
 * @param {object} io
 * @param {() => Promise<unknown>} io.ask the board's answer to GET …/messages/waiting
 * @param {(ms: number) => Promise<void>} io.sleep
 * @param {() => number} io.now
 * @param {() => boolean} io.listening
 * @param {number} [io.window]
 * @param {number} [io.every]
 */
export async function waitForMessages({ ask, sleep, now, listening, window = WAIT_WINDOW_MS, every = WAIT_EVERY_MS }) {
  const end = now() + window;
  for (;;) {
    if (!listening()) return '';
    const text = waitingText(await ask().catch(() => null));
    if (text) return text;
    const left = end - now();
    if (left <= 0) return '';
    await sleep(Math.min(every, left));
  }
}
