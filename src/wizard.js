/**
 * The Add a repository wizard (CLD-194): which of the steps of adding a repository are done, from what the
 * board can already see, and the one to do now. Pure, so it's tested without GitHub or the Durable Object;
 * store-wizard.js gathers the facts. What each step says to people (what to do, why, the command, what you
 * should see) is the web board's; what's wrong and its fix come from Connections' rows, never a second copy.
 */

/**
 * The steps, in order. A step the board can't see itself ticks with the next one that proves it. Deploys is
 * optional (WEB-14): it ticks once the repository has a pipeline, and is never the step to do now.
 */
export const STEP_IDS = [
  'create',
  'install',
  'register',
  'init',
  'deploys',
  'prompt',
  'routine',
  'connect',
  'task',
  'agent',
];

/** What each step and check is called, for the web board and `repos setup` alike. */
export const STEP_NAMES = {
  create: 'Create the repository on GitHub',
  install: 'Install the GitHub App and turn on Allow auto-merge',
  register: 'Register it on the board',
  init: 'Add the board’s files (repos init)',
  deploys: 'Deploy with breakaway (optional)',
  prompt: 'Fill in the agent prompt and AGENTS.md',
  routine: 'Make its routine on claude.ai',
  connect: 'Connect the routine',
  task: 'Add a first task, and claim it from the new checkout',
  agent: 'Start the first agent and merge its pull request',
};
export const CHECK_NAMES = {
  installed: 'The App is installed',
  permissions: 'It has the permissions the board needs',
  automerge: 'Allow auto-merge is on',
  started: 'An agent started',
  output: 'Its live output reached the task',
  pull: 'It opened a pull request',
  merged: 'The pull request is merged',
};

/** The template's placeholders (tools/tasks/prompts/repository.md) that repos init fills in by itself. */
const NAMED = new Set(['name', 'slug', 'owner/name', 'path of the skill', 'prompt path']);
/** The ones that never mean anything else, so they count in code too: `<slug>` is a real argument in a command. */
const NAMED_IN_CODE = new Set(['path of the skill', 'prompt path']);

/**
 * The `<…>` placeholders still in an agent prompt, in order and once each. HTML comments and fenced code are
 * left out, and so are links, HTML tags, and a command's arguments in code (`repos init <slug>`). What's left is
 * a named template placeholder, or words a person was meant to replace: several words starting with a capital.
 */
export function promptPlaceholders(text) {
  const prose = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/```[\s\S]*?```/gu, '');
  const found = [];
  for (const line of prose.split('\n')) {
    for (const match of line.matchAll(/<([^<>\n]{1,300})>/gu)) {
      const words = match[1].trim();
      // Inside an inline code span (an odd number of backticks before it), only the names init always fills count.
      const inCode = (line.slice(0, match.index).match(/`/gu)?.length ?? 0) % 2 === 1;
      if (inCode && !NAMED_IN_CODE.has(words)) continue;
      const named = NAMED.has(words);
      if (!named && (/^(?:https?:|mailto:)/iu.test(words) || /^\/?[a-z][a-z0-9-]*(?:\s+[a-z-]+=.*)?\/?$/u.test(words)))
        continue;
      // The template's sections are sentences in brackets; `Closes <ID>.` and `<the task>` are the core's own words.
      if (!(named || (/^[A-Z]/u.test(words) && /\s/u.test(words)))) continue;
      const shown = `<${words.length > 60 ? `${words.slice(0, 59)}…` : words}>`;
      if (!found.includes(shown)) found.push(shown);
    }
  }
  return found;
}

/** A suggested slug from a GitHub repository's name: lowercase letters, digits, and hyphens, starting with a letter. */
export function slugFrom(github) {
  const name =
    String(github ?? '')
      .trim()
      .replace(/^https:\/\/github\.com\//u, '')
      .replace(/\.git$/u, '')
      .split('/')
      .pop() ?? '';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^[^a-z]+/u, '')
    .replace(/-+/gu, '-')
    .replace(/-$/u, '')
    .slice(0, 32);
  return slug || null;
}

/**
 * The first real result in a repository, from `work` as store-wizard.js gathers it (BRK-143): with a routine, its
 * agent step's four checks (an agent started, its live output, its pull request, the merge); without one, a task
 * closed by its merged pull request. Set up the board's last step and the wizard's agent step both read this.
 * Returns `{ done, wid, number }`, naming the merged task once there is one.
 */
export function firstResult(work, routine) {
  const merged = work?.merged ?? null;
  const done = routine ? Boolean(work?.started && work?.output && work?.pull && merged) : Boolean(merged);
  return { done, wid: merged?.wid ?? null, number: merged?.number ?? null };
}

/**
 * What to do about a start that failed (WEB-40), from the board's or Claude's refusal: `fix`, in words; `step`, a
 * wizard step that fixes it (`connect`, `prompt`), or null; `link`, `routines` when the fix is on claude.ai's
 * routines page, else null. The refusal itself says what failed; this only adds what to do, so the wizard's agent
 * step can show both with Try again. Matches store-agents.js's own messages; anything else is checked on claude.ai.
 * @param {string} message
 * @returns {{ fix: string, step: 'connect' | 'prompt' | null, link: 'routines' | null }}
 */
export function startFix(message) {
  const m = String(message ?? '');
  const fix = (text, step = null, link = null) => ({ fix: text, step, link });
  if (/token was refused/u.test(m))
    return fix(
      'Make a new token in the routine’s API trigger on claude.ai, then connect the routine again with it.',
      'connect',
      'routines',
    );
  // BRK-144's wordings for Claude's 403 and 404, and a routine it held after one.
  if (/has no access to it|is gone on claude\.ai|paused because Claude refused/u.test(m))
    return fix(
      'Check you can still open the routine on claude.ai, make a new token in its API trigger (or the routine again, if it’s gone), then connect it again.',
      'connect',
      'routines',
    );
  if (/isn’t connected yet|can’t be read any more/u.test(m))
    return fix('Connect the routine: its URL and token from its API trigger on claude.ai.', 'connect');
  if (/paused on claude\.ai/u.test(m))
    return fix('Turn the routine back on in your routines on claude.ai.', null, 'routines');
  if (/placeholder/u.test(m))
    return fix('Fill in what’s left of the agent prompt, merge it, then try again.', 'prompt');
  if (/Claude’s (?:hourly )?limit/u.test(m)) return fix('Wait for Claude’s limit to clear, then try again.');
  if (/already running|in the last hour|cap/u.test(m))
    return fix('Wait for a running agent to finish, or raise the board’s limits in Settings, then try again.');
  if (/can’t start an agent/u.test(m))
    return fix(
      'Do what it says on the task, or start one an agent can take: open, an agent’s to do (who: agent), and waiting for nothing.',
    );
  if (/couldn’t reach Claude/u.test(m)) return fix('Try again in a minute.');
  if (/\((?:403|404)\b/u.test(m))
    return fix(
      'Check you can still open the routine on claude.ai. If it was deleted or made again, connect the new one.',
      'connect',
      'routines',
    );
  return fix(
    'Check the routine on claude.ai: its repository, its environment, and its API trigger. Then try again.',
    null,
    'routines',
  );
}

/** The rows of `connections` about this repository, by id; `null` for none. */
const rowOf = (connections, id) => connections.find((c) => c.id === id) ?? null;

/** What's wrong with a step, from its Connections row: the fix and its link, or null when nothing is. */
function problemOf(row) {
  if (!row || row.state === 'working' || !row.fix) return null;
  return {
    connection: row.id,
    name: row.name,
    state: row.state,
    detail: row.detail ?? '',
    fix: row.fix,
    link: row.link ?? null,
  };
}

/**
 * The wizard's steps from the facts store-wizard.js gathers:
 *
 * - `github`: the repository's owner/name; `registered`: its registry row, or null before step 3;
 * - `connections`: Connections' rows for it (github.install, github.permissions, github.automerge, github.sync,
 *   claude.routine, claude.output), built from a live check of this repository;
 * - `app`: whether the GitHub App is connected to the board at all;
 * - `empty`: no commits yet; `synced`: when the board last synced it (ms);
 * - `prompt`: `{ status: 'ok' | 'missing' | 'empty' | 'unreadable', path, placeholders, url }`, or null;
 * - `routine`: whether its routine's URL and token are on the board;
 * - `work`: `{ tasks, claimed, started, output, pull, merged }`, each a `{ wid, … }` or null;
 * - `candidate`: the task the agent step offers Start on, `{ uuid, wid, description, blocker }`, or null;
 * - `failure`: the repository's last start, when it failed, `{ wid, error, at }`, or null.
 *
 * The agent step carries `start` (the candidate, while the routine is connected and no agent has started, or the
 * last start failed) and `failure` (with startFix's `fix`, `step`, and `link`), both null once the step is done.
 * Returns `{ steps, now, done }`: each step `{ id, done, detail, checks?, problem, optional? }`, and the first
 * not done that isn't optional; `done` once only optional steps are left.
 */
export function wizardSteps(facts) {
  const {
    registered = null,
    connections = [],
    app = false,
    empty = false,
    synced = null,
    prompt = null,
    routine = false,
  } = facts;
  const work = facts.work ?? {};
  const install = rowOf(connections, 'github.install');
  const permissions = rowOf(connections, 'github.permissions');
  const automerge = rowOf(connections, 'github.automerge');
  const sync = rowOf(connections, 'github.sync');
  const routineRow = rowOf(connections, 'claude.routine');
  const output = rowOf(connections, 'claude.output');
  const installed = install?.state === 'working';

  const checks = {
    install: [
      { id: 'installed', done: installed },
      { id: 'permissions', done: permissions?.state === 'working' },
      { id: 'automerge', done: automerge?.state === 'working' },
    ],
    agent: [
      { id: 'started', done: Boolean(work.started), wid: work.started?.wid ?? null },
      { id: 'output', done: Boolean(work.output), wid: work.output?.wid ?? null },
      {
        id: 'pull',
        done: Boolean(work.pull),
        wid: work.pull?.wid ?? null,
        number: work.pull?.number ?? null,
        url: work.pull?.url ?? null,
      },
      { id: 'merged', done: Boolean(work.merged), wid: work.merged?.wid ?? null, number: work.merged?.number ?? null },
    ],
  };
  const hasCommits = Boolean(registered) && !empty && Boolean(synced);
  const promptOk = prompt?.status === 'ok';
  const filled = promptOk && !prompt.placeholders?.length;
  const connected = Boolean(routine);
  const agentDone = firstResult(work, true).done;
  const failure = !agentDone && facts.failure ? { ...facts.failure, ...startFix(facts.failure.error) } : null;

  const steps = [
    // The App can only see a repository that exists, so being installed is how the board knows it was created.
    { id: 'create', done: installed, problem: null },
    {
      id: 'install',
      done: checks.install.every((c) => c.done),
      checks: checks.install,
      problem: !app
        ? {
            connection: 'github.app',
            name: 'GitHub App',
            state: 'off',
            detail: 'not connected',
            fix: 'Connect the GitHub App first, on the board’s GitHub view.',
            link: null,
          }
        : (problemOf(install) ?? problemOf(permissions) ?? problemOf(automerge)),
    },
    { id: 'register', done: Boolean(registered), problem: null },
    {
      id: 'init',
      done: hasCommits && prompt?.status !== 'missing' && prompt?.status !== 'empty',
      detail: !registered
        ? null
        : empty
          ? 'no commits yet'
          : prompt?.status === 'missing'
            ? `the agent prompt isn’t at ${prompt.path} on the default branch yet`
            : null,
      // "No commits yet" is the normal state before init, so only a real sync failure counts.
      problem: sync && sync.state === 'attention' ? problemOf(sync) : null,
    },
    // The move to breakaway's deploy flow (IDEA-27): the web board shows the GitHub page's card here. An agent can
    // claim tasks without a pipeline, so skipping it is a choice, and the steps after it never wait for it.
    { id: 'deploys', optional: true, done: Boolean(registered?.pipeline), problem: null },
    {
      id: 'prompt',
      done: filled,
      detail:
        prompt?.status === 'unreadable'
          ? `the board couldn’t read ${prompt.path}${prompt.error ? `: ${prompt.error}` : ''}`
          : promptOk && prompt.placeholders?.length
            ? `${prompt.placeholders.length === 1 ? '1 placeholder' : `${prompt.placeholders.length} placeholders`} left: ${prompt.placeholders.join(', ')}`
            : null,
      placeholders: promptOk ? (prompt.placeholders ?? []) : [],
      url: prompt?.url ?? null,
      problem: null,
    },
    // claude.ai's settings can't be read from here: the routine shows once the form or agents-connect hands the board its URL.
    { id: 'routine', done: connected, problem: null },
    { id: 'connect', done: connected, problem: null },
    {
      id: 'task',
      done: Boolean(work.claimed),
      detail: work.tasks ? `${work.tasks === 1 ? '1 task' : `${work.tasks} tasks`} in it so far` : null,
      wid: work.claimed?.wid ?? null,
      problem: null,
    },
    // Start on the task it found, and a failed start with its fix (WEB-40). A session that sends nothing back
    // shows on Connections with its fix.
    {
      id: 'agent',
      done: agentDone,
      checks: checks.agent,
      start: connected && !agentDone && (!work.started || failure) ? (facts.candidate ?? null) : null,
      failure,
      problem: connected ? (problemOf(routineRow) ?? problemOf(output)) : null,
    },
  ];
  for (const step of steps) {
    step.name = STEP_NAMES[step.id];
    for (const check of step.checks ?? []) check.name = CHECK_NAMES[check.id];
  }
  const now = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  return { steps, now, done: !now };
}
