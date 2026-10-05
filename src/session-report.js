/**
 * A cloud session's report on its own environment (BRK-142, docs/specs/IDEA-33-onboarding-hardening.md): the CLI
 * sends it with a board-started agent's claim, and the routine that started the session reads Verified on
 * Connections. Only yes/no facts and a hash of a public file are sent, never a value: whether a name was set,
 * where the token came from, and the sha-256 of the checkout's copy of the stub. Pure, so it's tested without a
 * Worker; the CLI builds a report with `sessionReport`, the board checks it with `checkReport`
 * and `judgeStub` when it arrives, and reads it back with `reportProblems`.
 */

/** Where the session's token came from: the cloud environment's API credential, a variable, or a tasks.env file. */
export const TOKEN_SOURCES = Object.freeze(['credential', 'variable', 'file']);

/** The stub's text the way it's hashed on both sides: line endings and trailing space don't count. */
export const stubText = (text) => String(text).replace(/\r\n/gu, '\n').trim();

/**
 * The report a cloud session's CLI sends with its claim, or null outside a cloud session. `env` is the environment,
 * `file` the tasks.env settings, `named` whether --as named the agent, and `stub` the hash of the checkout's
 * stub (null when the checkout has none).
 * @param {{ env: Record<string, string | undefined>, file?: Record<string, string>, named?: boolean, stub?: string | null }} input
 */
export function sessionReport({ env, file = {}, named = false, stub = null }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return null;
  const token = env.BREAKAWAY_TOKEN ? 'variable' : file.BREAKAWAY_TOKEN ? 'file' : 'credential';
  return { token, agent: Boolean(named || env.BREAKAWAY_AGENT || file.BREAKAWAY_AGENT), stub: stub ?? null };
}

/**
 * The report as the board keeps it, or null when it isn't one: only the known facts, so nothing else a client
 * sends is ever stored.
 * @returns {{ token: string, agent: boolean, stub: string | null } | null}
 */
export function checkReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!TOKEN_SOURCES.includes(input.token) || typeof input.agent !== 'boolean') return null;
  const stub = typeof input.stub === 'string' && /^[0-9a-f]{16}$/u.test(input.stub) ? input.stub : null;
  return { token: input.token, agent: input.agent, stub };
}

/**
 * The checkout's stub against the board's, both hashes: `same`, `different`, or `missing` (the checkout has none),
 * and null when the board has no copy to compare with, so the stub isn't judged.
 * @returns {'same' | 'different' | 'missing' | null}
 */
export function judgeStub(stub, boardStub) {
  if (!boardStub) return null;
  if (!stub) return 'missing';
  return stub === boardStub ? 'same' : 'different';
}

/**
 * What's wrong in a kept report, each with its fix: no agent name, the token in a variable or a file instead of
 * the API credential, and a stub that's missing from the checkout or differs from the board's (`stub`, judgeStub's
 * verdict). `slug` names the repository and `host` the board in the fixes.
 * @param {{ token: string, agent: boolean, stub: string | null }} report
 * @param {{ slug: string, host: string }} board
 * @returns {{ what: string, fix: string }[]}
 */
export function reportProblems(report, { slug, host }) {
  const out = [];
  if (!report.agent)
    out.push({
      what: 'it had no agent name (BREAKAWAY_AGENT)',
      fix: 'Make the routine’s instructions the stub from the Agents view (Copy stub): it sends each agent to the prompt that sets BREAKAWAY_AGENT to the name the board gave it.',
    });
  if (report.token !== 'credential')
    out.push({
      what:
        report.token === 'variable'
          ? 'it read the board’s token from BREAKAWAY_TOKEN, a variable anyone using the environment can see'
          : 'it read the board’s token from a tasks.env file',
      fix: `In the routine’s cloud environment on claude.ai, add the token as an API credential for ${host} and remove BREAKAWAY_TOKEN: the proxy then adds it, and the token never enters the session.`,
    });
  if (report.stub === 'different' || report.stub === 'missing')
    out.push({
      what:
        report.stub === 'different'
          ? 'its checkout’s copy of the stub differs from the board’s'
          : 'its checkout has no copy of the stub',
      fix: `Bring ${slug}’s copy of the board’s files up to date (npx breakaway repos init ${slug} --update opens a pull request; in the board’s own repository, update the board to the same release), then paste the stub from the Agents view (Copy stub) as the routine’s instructions.`,
    });
  return out;
}

/** The first 16 hex digits of the sha-256 of `text`, with Web Crypto (the Worker and Node alike). */
export async function shortHash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
