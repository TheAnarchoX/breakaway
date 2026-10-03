import { describe, expect, it } from 'vitest';
import { NO_TERMINAL, ask } from './ask.js';

/** A stand-in for node:readline's interface: `answer` answers the question, `close` closes stdin first. */
function fakeReadline({ answer = null, close = false } = {}) {
  const made = [];
  const createInterface = (options) => {
    const handlers = {};
    const rl = {
      options,
      closed: false,
      on: (event, fn) => {
        handlers[event] = fn;
        return rl;
      },
      close: () => {
        rl.closed = true;
        handlers.close?.();
      },
      question: (_question, callback) => {
        if (close) rl.close();
        else callback(answer);
      },
    };
    made.push(rl);
    return rl;
  };
  return { createInterface, made };
}

const terminal = { isTTY: true };
const output = {
  written: '',
  write(text) {
    this.written += text;
  },
};

describe('asking in the terminal (CLD-191)', () => {
  it('answers with what was typed, trimmed', async () => {
    const { createInterface, made } = fakeReadline({ answer: '  https://example/fire \n' });
    await expect(ask('URL: ', { input: terminal, output, createInterface })).resolves.toBe('https://example/fire');
    expect(made[0].closed).toBe(true);
  });

  it('fails clearly without a terminal, before asking', async () => {
    const { createInterface, made } = fakeReadline({ answer: 'x' });
    for (const input of [{ isTTY: false }, {}, undefined]) {
      await expect(ask('URL: ', { input, output, createInterface })).rejects.toThrow(NO_TERMINAL);
    }
    expect(made).toHaveLength(0);
  });

  it('fails clearly when stdin closes before an answer, instead of hanging', async () => {
    const { createInterface } = fakeReadline({ close: true });
    await expect(ask('Token: ', { hidden: true, input: terminal, output, createInterface })).rejects.toThrow(
      /needs a terminal/,
    );
  });
});
