import { describe, expect, it } from 'vitest';
import {
  messageOutput,
  messageText,
  releasedOutput,
  sentAt,
  WAIT_EVERY_MS,
  WAIT_WINDOW_MS,
  waitForMessages,
} from './session-messages.js';

describe('messageOutput', () => {
  it('turns the board’s waiting messages into context for Claude’s next turn', () => {
    const out = messageOutput(
      {
        added: 1,
        messages: [
          { id: 1, text: 'Also update the runbook.', sent: '2026-10-01T14:02:31.000Z' },
          { id: 2, text: '  Don’t touch the migration.\n', sent: '2026-10-01T14:05:00.000Z' },
        ],
      },
      'PostToolUse',
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          'Message from the owner (via the board, 1 Oct 2026, 14:02 UTC): Also update the runbook.\n\n' +
          'Message from the owner (via the board, 1 Oct 2026, 14:05 UTC): Don’t touch the migration.',
      },
    });
  });

  it('names the event it answers, for every event that can carry context', () => {
    const answer = { messages: [{ text: 'Hi', sent: '2026-10-01T09:00:00.000Z' }] };
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse'])
      expect(messageOutput(answer, event)?.hookSpecificOutput.hookEventName).toBe(event);
  });

  it('stays quiet with nothing to deliver', () => {
    for (const answer of [undefined, null, {}, { messages: [] }, { messages: 'x' }, { error: 'not found' }])
      expect(messageOutput(answer, 'PostToolUse')).toBeNull();
    expect(messageOutput({ messages: [{ text: '  ' }, { id: 3 }, null, { text: 7 }] }, 'PostToolUse')).toBeNull();
  });

  it('says nothing on events whose output can’t reach Claude', () => {
    const answer = { messages: [{ text: 'Hi', sent: '2026-10-01T09:00:00.000Z' }] };
    for (const event of ['Stop', 'SubagentStop', undefined]) expect(messageOutput(answer, event)).toBeNull();
  });

  it('leaves the time out when the board didn’t send a usable one', () => {
    expect(
      messageOutput({ messages: [{ text: 'Hi', sent: 'soon' }] }, 'PostToolUse').hookSpecificOutput.additionalContext,
    ).toBe('Message from the owner (via the board): Hi');
  });
});

describe('sentAt', () => {
  it('reads an ISO time as a date and a UTC time', () => {
    expect(sentAt('2026-12-31T23:59:59.000Z')).toBe('31 Dec 2026, 23:59 UTC');
    expect(sentAt(undefined)).toBe('');
    expect(sentAt(12)).toBe('');
  });
});

/** A fake clock: sleep moves it on, and each ask answers from `answers` in turn (then nothing). */
function harness({ answers = [], listening = () => true } = {}) {
  let t = 0;
  const asks = [];
  const io = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ask: async () => {
      asks.push(t);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? { messages: [] };
    },
    listening: () => listening(t),
  };
  return { io, asks };
}

describe('waitForMessages', () => {
  const hi = { messages: [{ id: 1, text: 'Also update the runbook.', sent: '2026-10-01T14:02:31.000Z' }] };

  it('listens a 4-minute window, asking every 20 seconds, inside the 5 idle minutes a cloud session keeps it', () => {
    expect(WAIT_WINDOW_MS).toBe(240_000);
    expect(WAIT_EVERY_MS).toBe(20_000);
  });

  it('wakes Claude with the message as soon as one is waiting', async () => {
    const { io, asks } = harness({ answers: [{ messages: [] }, { messages: [] }, hi] });
    expect(await waitForMessages(io)).toBe(messageText(hi));
    expect(asks).toEqual([0, 20_000, 40_000]);
  });

  it('ends quietly when the window ends with nothing waiting, asking last at its end', async () => {
    const { io, asks } = harness();
    expect(await waitForMessages(io)).toBe('');
    expect(asks[0]).toBe(0);
    expect(asks.at(-1)).toBe(WAIT_WINDOW_MS);
    expect(asks).toHaveLength(WAIT_WINDOW_MS / WAIT_EVERY_MS + 1);
  });

  it('keeps the last ask inside a window that isn’t a multiple of the interval', async () => {
    const { io, asks } = harness();
    expect(await waitForMessages({ ...io, window: 50_000 })).toBe('');
    expect(asks).toEqual([0, 20_000, 40_000, 50_000]);
  });

  it('stops when it should stop listening: the claim went, or a newer wait took over', async () => {
    const { io, asks } = harness({ listening: (t) => t < 60_000 });
    expect(await waitForMessages(io)).toBe('');
    expect(asks).toEqual([0, 20_000, 40_000]);

    const never = harness({ answers: [hi], listening: () => false });
    expect(await waitForMessages(never.io)).toBe('');
    expect(never.asks).toEqual([]);
  });

  it('takes a failed or odd answer as nothing waiting and asks again', async () => {
    const { io, asks } = harness({
      answers: [new Error('offline'), null, { error: 'not found' }, { messages: 'x' }, hi],
    });
    expect(await waitForMessages(io)).toBe(messageText(hi));
    expect(asks).toHaveLength(5);
  });
});

describe('messageText', () => {
  it('is empty with no messages', () => {
    expect(messageText({ messages: [] })).toBe('');
    expect(messageText(null)).toBe('');
  });
});

describe('releasedOutput', () => {
  it('says once that the checkout stopped sending, on events that carry context', () => {
    const out = releasedOutput({ wid: 'BRK-79', agent: 'claude-brk-79' }, 'PostToolUse');
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/^BRK-79 is no longer claimed by claude-brk-79/u);
    expect(releasedOutput({ wid: 'BRK-79' }, 'Stop')).toBeNull();
  });
});
