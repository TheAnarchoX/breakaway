/**
 * Have an agent do it, for a new environment (WEB-121): the wizard's steps, what it checks, and the prompt it writes
 * for New agent. The owner describes what the environment needs, or lets the agent work it out from the repository;
 * either way the agent writes `.github/breakaway-infra/<environment>.json`, runs `infra check`, and opens a pull
 * request whose plan waits for the owner. Pure, so the tests read it without a DOM.
 */

/** The board's kinds of environment, in the order Add an environment shows them. */
export const ENV_KINDS = /** @type {const} */ ([
  ['production', 'Production'],
  ['staging', 'Staging'],
  ['short-lived', 'Short-lived'],
]);

/** The wizard's three steps: how the agent finds out what's needed, which environment, then the prompt. */
export const ENV_AGENT_STEPS = /** @type {const} */ ([
  { id: 'how', label: 'How' },
  { id: 'where', label: 'Environment' },
  { id: 'prompt', label: 'Prompt' },
]);

/** An environment's name, as Add an environment and the board take it. */
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;

/**
 * @typedef {{ repo: string, name: string, kind: string, provider: string, target?: string | null,
 *   how: 'describe' | 'infer', need?: string }} EnvAgentAsk
 */

/**
 * What the wizard can't go on with, by field: `need` on the first step, the rest on the second. Empty when it's fine.
 * @param {EnvAgentAsk} ask
 * @returns {{ need?: string, name?: string, kind?: string, provider?: string }}
 */
export function envAgentProblems(ask) {
  /** @type {{ need?: string, name?: string, kind?: string, provider?: string }} */
  const out = {};
  if (ask.how === 'describe' && !(ask.need ?? '').trim()) out.need = 'Say what the environment needs first.';
  const name = ask.name.trim();
  if (!name) out.name = 'Name the environment, like staging.';
  else if (!NAME.test(name))
    out.name =
      name.length > 40
        ? 'Keep the name to 40 characters.'
        : 'Use lowercase letters, digits, and hyphens, starting with a letter or digit.';
  if (!ENV_KINDS.some(([k]) => k === ask.kind)) out.kind = 'Pick production, staging, or short-lived.';
  if (!ask.provider.trim()) out.provider = 'Pick a provider.';
  return out;
}

/**
 * The prompt New agent opens with: the repository, the environment, its kind and provider, then the owner's words or
 * the instruction to work it out from the repository, and how to hand it over. It never asks the agent to apply.
 * @param {EnvAgentAsk} ask
 */
export function envAgentPrompt(ask) {
  const name = ask.name.trim();
  const file = `.github/breakaway-infra/${name}.json`;
  const out = [
    `Set up ${name}, a new ${ask.kind} environment for ${ask.repo} on ${ask.provider}, by pull request.`,
    '',
  ];
  if (ask.how === 'describe') {
    out.push('What it needs, in the owner’s words:', (ask.need ?? '').trim());
  } else {
    out.push(
      `Work out what it needs from ${ask.repo}: its wrangler config and bindings, the code that uses them, and any files already in .github/breakaway-infra/. Say in the pull request what you found and why each resource is there.`,
    );
  }
  out.push(
    '',
    ask.target
      ? `Its target is ${ask.target}: the Worker it runs on has that name.`
      : 'It has no target yet: name the Worker it runs on in the pull request, so the owner can make it the target.',
  );
  if (ask.kind === 'short-lived')
    out.push(
      'If every task’s short-lived environment should look like this, say so: .github/breakaway-infra/short-lived.json is the template the board makes each one from.',
    );
  out.push(
    '',
    'How:',
    `- Write ${file}. Where one of the owner’s templates fits, start from it: npx breakaway infra add lists them, and npx breakaway infra add <template> ${name} writes it.`,
    '- Run npx breakaway infra check, and open the pull request once it passes, with what it printed in the description.',
    '- Merging it makes a plan that waits for the owner to approve. Never apply, and never hold a provider’s write token.',
  );
  return out.join('\n');
}
