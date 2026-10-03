/**
 * Asking the owner for a value in the terminal (agents-connect's routine URL and token), and failing
 * clearly where there is no terminal to ask in (CLD-191): Claude Code's `!` prefix or a pipe closes stdin,
 * and a question that never resolves left Node's "unsettled top-level await" (exit 13). Pure apart from
 * the streams and readline it's handed, so it's tested without a terminal.
 */

export const NO_TERMINAL = 'this needs a terminal to ask in; run it in your own terminal, outside Claude Code';

/**
 * Asks `question` and resolves with the trimmed answer. Rejects with NO_TERMINAL when `input` isn't a
 * terminal, or when it closes before an answer. `hidden` doesn't echo what's typed (the token).
 * `createInterface` is node:readline's.
 */
export function ask(question, { hidden = false, input, output, createInterface }) {
  if (!input?.isTTY) return Promise.reject(new Error(NO_TERMINAL));
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: true });
    let answered = false;
    if (hidden)
      rl._writeToOutput = (text) => {
        if (text.includes(question)) output.write(text);
      };
    rl.on('close', () => {
      if (!answered) reject(new Error(NO_TERMINAL));
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) output.write('\n');
      resolve(String(answer).trim());
    });
  });
}
