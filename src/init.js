/**
 * What `npx breakaway repos init <slug>` adds to a registered repository (CLD-191): the least a board-started
 * agent needs to claim and work a task there, and Taskwarrior set up the way the board has it. Nothing here
 * overwrites a file the repository already has: it's skipped and said, and `.gitignore` only gets the lines
 * it lacks. Pure (the files come through `read` and `readTarget`), so it's tested without git or a disk.
 * It's the one renderer for both ways the files arrive (BRK-132): the CLI's clone, commit, and push are in
 * scripts/tasks.mjs, and the board's first commit to an empty repository, through its GitHub App, is in
 * src/store-init.js, which reads the board's files from src/board-files.json (BOARD_SOURCES).
 */
import { PIPELINE_SKILL, SKILL, areaList, routinePrompt } from './prompt.js';
import { promptPathOf } from './repos.js';

/** This machine's folder for the board, as .taskrc names it, where a caller doesn't say (scripts/tasks/settings.js). */
const DEFAULT_DIR = '~/.config/breakaway';

export { routinePrompt };

/**
 * The CLI on npm (BRK-7), as a repository runs it: `npx breakaway`, pinned to the major (BRK-47), so a breaking change
 * never reaches a repository by itself. It was the `next` channel until the first stable release.
 */
export const CLI_PACKAGE = 'breakaway@2';
/**
 * Where the CLI starts: the command, and the session hooks (the edit hook since IDEA-55). repos init no longer copies
 * them (BRK-7): an old copy is replaced by npx, and these still version the CLI and say which files an old copy holds.
 */
export const CLI_ENTRIES = [
  'scripts/tasks.mjs',
  'scripts/tasks/session-hook.mjs',
  'scripts/tasks/message-wait.mjs',
  'scripts/tasks/edit-hook.mjs',
];
/**
 * While breakaway was private, nothing reached npm (BRK-57), so repos init copied the two hooks and what they import
 * under HOOKS_DIR and settings.json ran them from there (BRK-64). breakaway is public and on npm now, so the hooks run
 * through npx again (BRK-69), and `repos init --update` removes a copy an older repos init left.
 */
export const HOOKS_FROM_COPY = false;
/** The session hooks' entry files, and where their copy goes: its own folder, so it never touches the repository's src/. */
export const HOOK_ENTRIES = [
  'scripts/tasks/session-hook.mjs',
  'scripts/tasks/message-wait.mjs',
  'scripts/tasks/edit-hook.mjs',
];
/** Each session hook's name (`npx breakaway hook <name>`) → its entry file. */
const HOOK_FILES = { session: 'session-hook', wait: 'message-wait', edit: 'edit-hook' };
/**
 * The edit tools the edit hook runs on (IDEA-55 section 1a), as a PreToolUse matcher: exact tool names split by `|`
 * (source: the matcher table in Claude Code's hooks reference, https://code.claude.com/docs/en/hooks).
 */
export const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
/**
 * The edit hook's `timeout`, in seconds: the field is in seconds and a command hook's defaults to 600, and a PreToolUse
 * command hook that times out doesn't block the tool call (source: https://code.claude.com/docs/en/hooks, the hook
 * handler fields and PreToolUse). Room for npx to start the CLI and for the hook's own wait on the board (3 s).
 */
export const EDIT_HOOK_TIMEOUT = 15;
export const HOOKS_DIR = 'tools/tasks/cli/';
/**
 * The release helpers a repository's Deploy, Promote, Roll back, and Release workflows run (BRK-45), copied with what
 * they import: the deploy helpers, and the package's version numbers (BRK-90, `npx breakaway pipeline init`).
 */
export const RELEASE_ENTRIES = [
  'scripts/record-deployment.mjs',
  'scripts/promote-check.mjs',
  'scripts/release-notes.mjs',
  'scripts/check-migrations.mjs',
  'scripts/release-artifact.mjs',
  'scripts/deploy-plan.mjs',
  'scripts/package-release.mjs',
];
/** Copied unchanged: the board's shared core and stub, and the Taskwarrior settings the new .taskrc includes. */
const COPIED = ['prompts/core.md', 'prompts/stub.md'];
/** Copied with a change for the repository, or made from the board's: their source is versioned too. */
const ADAPTED = ['taskrc', 'scripts/task', SKILL, PIPELINE_SKILL];
/**
 * Where the board's files (the prompts, the shared taskrc) go in another repository. In the board's own checkout they
 * sit at the root, so the paths `read` takes are the board's; what is written keeps this folder.
 */
const TARGET_DIR = 'tools/tasks/';
/**
 * The record of what repos init wrote into a repository (BRK-79): `--update` replaces a copied file only when it's
 * listed here, or sits in TARGET_DIR, breakaway's own folder. Anything else at a path it copies to is the repository's.
 */
export const MANIFEST = `${TARGET_DIR}copied.json`;
const GITIGNORE = ['.task/', '.task-session', '.env'];

/**
 * breakaway's Claude Code plugin (docs/specs/IDEA-25-claude-plugin.md, section 3): repos init sets a repository up with
 * it by default (BRK-158), so .claude/settings.json names breakaway's marketplace and turns the plugin on instead of
 * running the session hooks, and the tasks skill comes with the plugin instead of a copy. The marketplace lives on
 * breakaway's own repository, and gives out the plugin from its `plugin` branch, which moves at a stable release.
 */
export const PLUGIN_REPO = 'TheAnarchoX/breakaway';
export const PLUGIN_MARKETPLACE = 'breakaway';
export const PLUGIN = `breakaway@${PLUGIN_MARKETPLACE}`;
export const PLUGIN_BRANCH = 'plugin';

/** The two keys .claude/settings.json gets for the plugin: breakaway's marketplace, and the plugin turned on. */
export function pluginSettings() {
  return {
    extraKnownMarketplaces: { [PLUGIN_MARKETPLACE]: { source: { source: 'github', repo: PLUGIN_REPO } } },
    enabledPlugins: { [PLUGIN]: true },
  };
}

/** Whether a hook command is one of the session hooks repos init wrote: through npx, any version, or an old copy's. */
const BOARD_HOOK =
  /\bbreakaway(?:@[^\s"]+)? hook (?:session|wait|edit)\b|scripts\/tasks\/(?:session-hook|message-wait|edit-hook)\.mjs/u;

/**
 * settings.json moved to the plugin (repos init --update): the session hooks repos init wrote are gone, with any event
 * left empty, and the plugin's two keys are there. A plugin the settings turn off stays off, and the rest is untouched.
 * Null when it isn't JSON, so the caller says what to do instead.
 */
export function withPluginSettings(text) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((group) =>
          Array.isArray(group?.hooks)
            ? { ...group, hooks: group.hooks.filter((h) => !BOARD_HOOK.test(String(h?.command ?? ''))) }
            : group,
        )
        .filter((group, i) => !(Array.isArray(group?.hooks) && !group.hooks.length && groups[i].hooks.length));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete settings.hooks;
  }
  const want = pluginSettings();
  settings.extraKnownMarketplaces = {
    ...want.extraKnownMarketplaces,
    ...settings.extraKnownMarketplaces,
  };
  if (typeof settings.enabledPlugins?.[PLUGIN] !== 'boolean')
    settings.enabledPlugins = { ...settings.enabledPlugins, ...want.enabledPlugins };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Whether two JSON texts hold the same value, whatever their layout. */
const sameJson = (a, b) => {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

/** Whether settings.json already has the plugin: breakaway's marketplace, and the plugin named in enabledPlugins. */
function hasPlugin(text) {
  try {
    const settings = JSON.parse(text);
    return (
      Boolean(settings?.extraKnownMarketplaces?.[PLUGIN_MARKETPLACE]) && PLUGIN in (settings?.enabledPlugins ?? {})
    );
  } catch {
    return false;
  }
}

/**
 * Why repos init copies the tasks skill and the session hooks when it was asked for the plugin: the plugin isn't out
 * yet (its branch isn't there), or GitHub couldn't say (`released` null).
 */
export function pluginPendingNote(slug, released = false) {
  const why =
    released === null
      ? `GitHub couldn't say whether breakaway's plugin is out yet (the ${PLUGIN_BRANCH} branch on ${PLUGIN_REPO})`
      : `breakaway's plugin isn't out yet (${PLUGIN_REPO} has no ${PLUGIN_BRANCH} branch until a stable release moves it)`;
  return `${why}, so this copies the tasks skill and the session hooks instead. Once it's out, npx breakaway repos init ${slug} --update moves the repository to the plugin.`;
}
/** Pinned to LF so the shell scripts run on a checkout with core.autocrlf=true (BRK-41). */
const GITATTRIBUTES = ['scripts/task text eol=lf', '.envrc text eol=lf'];

/**
 * The board's own files initPlan reads (repository paths, sorted): the prompt template, what it copies as it is or
 * adapted, and the release helpers with what they import. src/board-files.json holds them for the Worker, and
 * `node scripts/board-files.mjs` writes it before every build and test run (it isn't committed, BRK-148).
 */
export function boardSources(read) {
  return [...new Set(['prompts/repository.md', ...COPIED, ...ADAPTED, ...importClosure(RELEASE_ENTRIES, read)])].sort();
}

/** The first commit's message for a repository set up from scratch: its title and body, the CLI's and the board's alike. */
export function initCommitMessage(slug, { by = `npx breakaway repos init ${slug}`, plugin = true } = {}) {
  const agentParts = plugin
    ? "breakaway's Claude Code plugin, turned on in .claude/settings.json (it brings the tasks skill and the session hooks)"
    : 'the session hooks (they run the CLI through npx), the tasks skill';
  return {
    title: "Set up the task board's agent files",
    body: `What a board-started agent needs to claim and work a task here: the agent prompt, the board's core, ${agentParts}, AGENTS.md, and Taskwarrior with direnv. Added by ${by}.`,
  };
}

/** `a/b/../c` → `a/c`, for import paths (no node:path here). */
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;

/**
 * Every file the CLI needs, from `entries` and the relative imports they lead to (repository paths, sorted).
 * `read(path)` gives a file's text. Tests are never followed, and only JavaScript is read for imports.
 */
export function importClosure(entries, read) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    // A JSON module (src/board-files.json) holds other files' text, not imports of its own.
    if (!/\.m?js$/u.test(path)) continue;
    const dir = path.split('/').slice(0, -1).join('/');
    for (const m of read(path).matchAll(RELATIVE_IMPORT)) {
      const next = normalize(`${dir}/${m[1]}`);
      if (!/\.test\.js$/u.test(next) && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/**
 * The files an old copy of the CLI holds that npx replaces (repository paths, sorted): the CLI, its hooks, and what
 * only they import. The release helpers' files stay copied, so they are not here.
 */
export function cliCopySources(read) {
  const kept = new Set(importClosure(RELEASE_ENTRIES, read));
  // scripts/install/ (BRK-9) is the npm package's own: no old copy ever held it.
  return importClosure(CLI_ENTRIES, read).filter(
    (path) => !kept.has(path) && path !== 'src/cli-version.js' && !path.startsWith('scripts/install/'),
  );
}

/** The command a session hook runs: from the copy under HOOKS_DIR while breakaway is private, else through npx (BRK-7). */
export function hookCommand(name, { fromCopy = HOOKS_FROM_COPY, pkg = CLI_PACKAGE } = {}) {
  if (!fromCopy) return `npx --yes ${pkg} hook ${name}`;
  const file = HOOK_FILES[/** @type {keyof typeof HOOK_FILES} */ (name)] ?? HOOK_FILES.session;
  const entry = HOOK_ENTRIES.find((path) => path.endsWith(`/${file}.mjs`));
  return `node "$CLAUDE_PROJECT_DIR/${HOOKS_DIR}${entry}"`;
}

/**
 * The session hooks .claude/settings.json runs (see HOOKS_FROM_COPY). All run in the background but the edit hook
 * (IDEA-55 section 1a), which claims the file an edit names before the edit runs: a hook with `async: true` runs in
 * the background without blocking, so it couldn't turn an edit away (source: https://code.claude.com/docs/en/hooks,
 * the `async` field). It has a short `timeout` instead (EDIT_HOOK_TIMEOUT), and a board that doesn't answer lets the
 * edit through.
 */
export function sessionHooks(pkg = CLI_PACKAGE) {
  const hook = (name, extra = {}) => ({
    type: 'command',
    command: hookCommand(name, { pkg }),
    async: true,
    ...extra,
  });
  const session = [{ hooks: [hook('session')] }];
  const edit = { type: 'command', command: hookCommand('edit', { pkg }), timeout: EDIT_HOOK_TIMEOUT };
  return {
    SessionStart: session,
    UserPromptSubmit: session,
    PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [edit] }],
    PostToolUse: session,
    Stop: [{ hooks: [hook('session'), hook('wait', { asyncRewake: true, timeout: 300 })] }],
  };
}

/**
 * settings.json with the session hooks' commands set to the current one, whichever form they had: the copy's, or npx
 * with an earlier channel or version of the package (`breakaway@next` before BRK-47). The rest is untouched.
 */
export function rewireHooks(text) {
  let out = text;
  for (const name of ['session', 'wait', 'edit'])
    for (const fromCopy of [true, false]) {
      const was = JSON.stringify(hookCommand(name, { fromCopy })).slice(1, -1);
      const now = JSON.stringify(hookCommand(name)).slice(1, -1);
      out = out.split(was).join(now);
    }
  const current = (_, name) => JSON.stringify(hookCommand(name === 'message-wait' ? 'wait' : name)).slice(1, -1);
  return (
    out
      .replace(/npx --yes breakaway(?:@[^\s"\\]+)? hook (session|wait|edit)\b/gu, current)
      // The old CLI copy's hook scripts, from before BRK-7, quoted or not (BRK-79): its copy is about to go.
      .replace(
        /node (\\")?(?:\$CLAUDE_PROJECT_DIR\/)?(?:tools\/tasks\/cli\/)?scripts\/tasks\/(session-hook|message-wait)\.mjs\1/gu,
        (_, _q, name) => current(_, name === 'session-hook' ? 'session' : name),
      )
  );
}

/**
 * The paths a repository's AGENTS.md says came from the board, in its "Copied files." bullet as any version of repos
 * init wrote it; a folder ends in `/`. None when AGENTS.md is the repository's own (BRK-79).
 */
export function declaredCopies(agents) {
  const line = String(agents ?? '')
    .split('\n')
    .find((l) => /^- \*\*Copied files\.\*\*/u.test(l));
  if (!line) return [];
  return [...line.split(/ come from \[/u)[0].matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
}

/**
 * The Taskwarrior report and context for repository `slug` (IDEA-14): `task <slug>` lists its open work, and
 * `task context <slug>` narrows everything to it and puts new tasks in it. For the shared taskrc.
 * The default repository's pair also counts tasks without a `repo` (that is what empty means), and has no write
 * filter: a new task with no `repo` is already its own.
 */
export function taskrcLines(slug, isDefault = false) {
  const filter = isDefault ? `(repo: or repo:${slug})` : `repo:${slug}`;
  return [
    `report.${slug}.description=${slug}'s open work, best first`,
    `report.${slug}.columns=id,wid,priority,horizon,project,tags,claim,depends.indicator,description.count`,
    `report.${slug}.labels=ID,Work,P,Horizon,Area,Tags,Claimed by,D,Description`,
    `report.${slug}.filter=status:pending -WAITING ${filter}`,
    `report.${slug}.sort=urgency-`,
    `context.${slug}.read=${filter}`,
    ...(isDefault ? [] : [`context.${slug}.write=repo:${slug}`]),
  ];
}

/** `taskrc` with repository `slug`'s report and context added, or as it is when it has them. */
export function withRepoInTaskrc(taskrc, slug, isDefault = false) {
  const text = String(taskrc);
  if (text.includes(`context.${slug}.read=`)) return text;
  return `${text.replace(/\n*$/u, '\n')}${taskrcLines(slug, isDefault).join('\n')}\n`;
}

const MACHINE_MARK = '# Each repository on the board: its report and context.';

/**
 * This machine's taskrc in the board's folder (CLD-193): its sync credentials as they are, then a report and
 * context for each repository in `slugs` that the shared taskrc (`shared`) doesn't already have, so
 * `task <slug>` and `task context <slug>` work in any checkout without a commit. `defaultSlug`'s pair also
 * counts tasks without a `repo`. `npx breakaway setup` writes it; repos add, init, and remove refresh it.
 */
export function machineTaskrc(current, slugs, shared = '', defaultSlug = null) {
  const mark = String(current ?? '').indexOf(MACHINE_MARK);
  const own = (mark === -1 ? String(current ?? '') : String(current).slice(0, mark)).replace(/\n*$/u, '\n');
  const missing = [...new Set(slugs)].filter((slug) => !String(shared).includes(`context.${slug}.read=`));
  if (!missing.length) return own;
  return `${own}${MACHINE_MARK} Refreshed by npx breakaway setup and repos add, init, and remove.\n${missing.flatMap((slug) => taskrcLines(slug, slug === defaultSlug)).join('\n')}\n`;
}

/**
 * The agent prompt's sections the core refers to by name (CLD-196), in the template's order: the heading, the
 * repos init flag that sets it, what init asks, and the answer it takes when there's none. A default never names
 * a rule the repository may not have: it says to read AGENTS.md, which the owner fills in next.
 */
export const PROMPT_SECTIONS = [
  {
    heading: 'Building',
    flag: 'building',
    ask: 'How is work done here (tests first, a style guide, anything about personal data)?',
    default:
      'Do the work the way `AGENTS.md` says. Keep each change small and to the task, and add tests for new logic where the repository has them.',
  },
  {
    heading: 'Checks',
    flag: 'checks',
    ask: 'Which commands must pass before handing over (like `npm test` and `npm run build`)?',
    default:
      'There are no tests or build yet. Run any check `AGENTS.md` names, and say in the pull request what you checked by hand.',
  },
  {
    heading: 'Pull requests',
    flag: 'pull-requests',
    ask: 'How is a pull request opened (a template, anything its description must hold)?',
    default:
      'Use the repository’s pull request template if it has one. Otherwise say what changed and why, how you checked it, and what the owner has to do after merging.',
  },
  {
    heading: 'Direction',
    flag: 'direction',
    ask: 'Where are the principles, settled decisions, and plans, and where do specs go?',
    default: '`AGENTS.md` and the task itself. Specs go in `docs/specs/`, named after the task’s work ID.',
  },
  {
    heading: 'Dependency updates',
    flag: 'dependency-updates',
    ask: 'Any extra checks for a Dependabot review, and does merging deploy anything?',
    default: 'No extra checks beyond **Checks**. Merging deploys nothing.',
  },
  {
    heading: 'Never share',
    flag: 'never-share',
    ask: 'What must never go into a task, comment, or pull request?',
    default: 'Personal data of the project’s users, and any secret, token, or key.',
  },
];

/**
 * The answer for each section from `given` (flag → text, as repos init's options hold them), else its default:
 * `{ sections: heading → text, defaulted: headings that took the default }`.
 */
export function promptSections(given = {}) {
  const sections = {};
  const defaulted = [];
  for (const s of PROMPT_SECTIONS) {
    const text = String(given[s.flag] ?? '').trim();
    sections[s.heading] = text || s.default;
    if (!text) defaulted.push(s.heading);
  }
  return { sections, defaulted };
}

/** The `tasks` skill for another repository: links into the board's docs point at them on GitHub. */
export function skillFor(text, board, repo = null) {
  const linked = String(text)
    .replace(/\]\((?:\.\.\/)+((?:docs|tools)\/[^)]+)\)/gu, `](https://github.com/${board}/blob/main/$1)`)
    .replace(/\]\(((?:\.\.\/)+)prompts\//gu, ']($1tools/tasks/prompts/');
  if (!repo) return linked;
  // The skill is breakaway's own: in another repository it names that repository's work, areas, and prompt (BRK-79).
  const prompt = promptPathOf(repo);
  return linked
    .replace(/breakaway's work is on the board/gu, "This repository's work is on the board")
    .replace(/breakaway's areas: [^.\n]+\./gu, `This repository's areas: ${areaList(repo)}.`)
    .replace(
      /\[`prompts\/breakaway\.md`\]\(((?:\.\.\/)+)tools\/tasks\/prompts\/breakaway\.md\)/gu,
      (_, up) => `[\`${prompt}\`](${up}${prompt})`,
    );
}

/** A starter AGENTS.md: how this repository works with the board. The owner adds how to build here. */
export function agentsMd(repo, board, dir = DEFAULT_DIR, { plugin = true } = {}) {
  const skill = plugin
    ? `Use the \`tasks\` skill (from breakaway's Claude Code plugin, which \`.claude/settings.json\` turns on) and the CLI, \`npx breakaway\` (the \`breakaway\` package on npm), to claim, comment, and hand over. It works in this checkout's repository, so \`list\` and \`next\` show only this repository's tasks. The skill is the board's, written for any repository: this repository's areas are above, and its rules are here.`
    : `Use the \`tasks\` skill (\`${SKILL}\`) and the CLI, \`npx breakaway\` (the \`breakaway\` package on npm), to claim, comment, and hand over. It works in this checkout's repository, so \`list\` and \`next\` show only this repository's tasks. The skill is breakaway's, written for this repository's areas and prompt: where it names breakaway's own files or rules, the board's part applies and the rest doesn't.`;
  const copied = plugin
    ? `\`tools/tasks/\`, the release helpers in \`scripts/\`, and \`${PIPELINE_SKILL}\` come from [${board}](https://github.com/${board}). Don't edit them here: change them there. \`${MANIFEST}\` lists every file it copied, and \`repos init --update\` replaces only those: a file it doesn't list is this repository's own, even at a path breakaway copies to. \`.claude/settings.json\` turns on breakaway's plugin (\`${PLUGIN}\`), which brings the \`tasks\` skill, its commands, and the session hooks that show a cloud agent's output on its task, so this repository carries no copy of them.`
    : `\`tools/tasks/\`, the release helpers in \`scripts/\`, \`${SKILL}\`, and \`${PIPELINE_SKILL}\` come from [${board}](https://github.com/${board}). Don't edit them here: change them there. \`${MANIFEST}\` lists every file it copied, and \`repos init --update\` replaces only those: a file it doesn't list is this repository's own, even at a path breakaway copies to. \`.claude/settings.json\` holds the session hooks that show a cloud agent's output on its task, and they run through \`npx\`, so this repository carries no copy of the CLI.`;
  return `# Agent instructions

<!-- Started by \`npx breakaway repos init\` (breakaway's task board). Add how to build here: setup, tests, style, and anything agents must never do. -->

- **Work lives on the task board.** This repository's tasks are in the areas ${areaList(repo)}. ${skill}
- **Agents started by the board** follow [\`${promptPathOf(repo)}\`](${promptPathOf(repo)}), which starts with the board's core, \`tools/tasks/prompts/core.md\`.
- **Copied files.** ${copied}
- **Taskwarrior** (optional): \`scripts/task\`, or plain \`task\` with direnv after \`direnv allow\`, uses the board with this checkout's own \`.task/\` database, in the \`${repo.slug}\` context. \`npx breakaway setup\` connects the machine once.
- **Changes reach \`${repo.defaultBranch || 'main'}\` through pull requests**, which the owner merges. Never merge, force-push, or rewrite \`${repo.defaultBranch || 'main'}\`.
- **Never put a secret or token** in a file, task, comment, or pull request. The board's token lives in \`${dir}/tasks.env\` (or \`$BREAKAWAY_HOME/tasks.env\`) or the cloud environment's credentials, never in this repository.
`;
}

const ENVRC = (
  slug,
) => `# direnv: plain \`task\` in this checkout uses the task board, in ${slug}'s context. Run \`direnv allow\` once.
export TASKRC="$PWD/.taskrc"
export TASKDATA="$PWD/.task"
`;

const TASKRC = (
  slug,
  url,
  dir,
) => `# The task board's Taskwarrior config for ${slug}. Use it through scripts/task or direnv (.envrc),
# which also point TASKDATA at this checkout's own .task/ database.
include tools/tasks/taskrc
# The board this checkout uses; the CLI reads it too when BREAKAWAY_URL isn't set (docs/tasks.md#another-install).
sync.server.url=${url}
# Plain \`task\` shows ${slug}'s work, and new tasks land in it; \`task context none\` shows every repository.
context=${slug}
default.command=${slug}

# sync.server.client_id and sync.encryption_secret, written by \`npx breakaway setup\` (in the board's checkout).
include ${dir}/taskrc
`;

/**
 * The plan for repository `repo` (a registry row): `files` to write (`{path, content, mode?}` or a symlink
 * `{path, link}`; `changed` when it replaces the repository's copy), `skipped` paths it already has,
 * `removals` files of an old CLI copy to delete (with `update` only), `current` copied files that are already the same, `notes` the owner should read, and `todo` for what's left
 * to fill in. `read(path)` reads this checkout (the board's); `readTarget(path)` reads the new repository's,
 * null when the file isn't there. `board` is the board's own repository, owner/name; `url` is the board's
 * address and `configDir` this machine's folder for it as .taskrc names it (`~/.config/…`), both from the CLI.
 *
 * With `update` (repos init --update), the files copied from the board (the CLI, the release helpers, the core and stub, the skill,
 * the shared taskrc, scripts/task) replace the repository's copies when they differ; the repository's own
 * (its agent prompt, AGENTS.md, .taskrc, .envrc, package.json, .claude/settings.json) are still never touched.
 */
export function initPlan({
  repo,
  board,
  read,
  readTarget,
  url,
  configDir = DEFAULT_DIR,
  update = false,
  plugin = true,
  pluginReleased = true,
  sections = {},
  defaulted = [],
}) {
  const files = [];
  const skipped = [];
  const current = [];
  const notes = [];
  const todo = [];
  // The plugin unless the repository asked for copies (--copies), and copies while the plugin isn't out yet.
  const usePlugin = plugin && pluginReleased === true;
  if (plugin && !usePlugin) notes.push(pluginPendingNote(repo.slug, pluginReleased));
  const add = (path, content, extra = {}) => {
    if (readTarget(path) !== null) skipped.push(path);
    else files.push({ path, content, ...extra });
  };
  // What an earlier run recorded writing (BRK-79): null for a repository set up before the record existed.
  const recorded = (() => {
    try {
      const files = JSON.parse(readTarget(MANIFEST) ?? 'null')?.files;
      return Array.isArray(files) ? new Set(files) : null;
    } catch {
      return null;
    }
  })();
  // Set up before the record: the AGENTS.md repos init wrote says the copied files came from the board, and a
  // repository's own AGENTS.md doesn't, so only then are files at the copied paths breakaway's.
  const declared = recorded === null ? declaredCopies(readTarget('AGENTS.md')) : [];
  /** Whether repos init wrote `path` here: in breakaway's own folder, on the record, or in AGENTS.md's copied files. */
  const owns = (path) =>
    path.startsWith(TARGET_DIR) ||
    Boolean(recorded?.has(path)) ||
    declared.some((d) => (d.endsWith('/') ? path.startsWith(d) : path === d));
  const ours = new Set();
  const theirs = [];
  /**
   * A file copied from the board: added when it's missing, and with `update`, replaced when it differs, but only when
   * repos init wrote it (the record lists it, or it's in breakaway's own folder). A repository's own file at a path
   * breakaway copies to is left alone (BRK-79).
   */
  const copy = (path, content, extra = {}) => {
    const there = readTarget(path);
    if (there === null) {
      files.push({ path, content, ...extra });
      ours.add(path);
    } else if (there === content) {
      (update ? current : skipped).push(path);
      ours.add(path);
    } else if (!update) skipped.push(path);
    else if (owns(path)) {
      files.push({ path, content, ...extra, changed: true });
      ours.add(path);
    } else {
      skipped.push(path);
      theirs.push(path);
    }
  };

  const prompt = promptPathOf(repo);
  add(prompt, routinePrompt(read('prompts/repository.md'), repo, sections));
  if (!skipped.includes(prompt)) {
    const open = PROMPT_SECTIONS.map((s) => s.heading).filter((h) => !String(sections[h] ?? '').trim());
    if (open.length) todo.push(`${prompt}: fill in each <…> (${open.join(', ')})`);
    const took = defaulted.filter((h) => !open.includes(h));
    if (took.length) todo.push(`${prompt}: check the sections that took the default (${took.join(', ')})`);
  }
  for (const path of COPIED) copy(TARGET_DIR + path, read(path));
  copy(`${TARGET_DIR}taskrc`, withRepoInTaskrc(read('taskrc'), repo.slug, Boolean(repo.isDefault)));
  // A release helper the repository keeps as its own doesn't bring the files breakaway's version imports (BRK-79).
  const kept = (entry) => {
    const there = readTarget(entry);
    return there === null || there === read(entry) || (update && owns(entry));
  };
  const needed = new Set(importClosure(RELEASE_ENTRIES.filter(kept), read));
  for (const path of importClosure(RELEASE_ENTRIES, read))
    if (needed.has(path) || readTarget(path) !== null) copy(path, read(path));
  if (HOOKS_FROM_COPY) for (const path of importClosure(HOOK_ENTRIES, read)) copy(HOOKS_DIR + path, read(path));
  // An old copy of the CLI is replaced by npx: with update, its files go. The src/ files it imported may be the
  // repository's own by now, so those are only named.
  const old = update && !HOOKS_FROM_COPY ? cliCopySources(read).filter((path) => readTarget(path) !== null) : [];
  const removals = old.filter((path) => path.startsWith('scripts/'));
  // The hook copy of BRK-64 goes once the hooks run through npx again.
  if (update && !HOOKS_FROM_COPY)
    for (const path of importClosure(HOOK_ENTRIES, read))
      if (readTarget(HOOKS_DIR + path) !== null) removals.push(HOOKS_DIR + path);
  const leftover = old.filter((path) => !path.startsWith('scripts/'));
  if (leftover.length)
    notes.push(
      `${leftover.join(', ')} came with the old copy of the CLI. Nothing here needs them now: delete the ones this repository doesn't use itself.`,
    );

  add(
    '.claude/settings.json',
    `${JSON.stringify(usePlugin ? pluginSettings() : { hooks: sessionHooks() }, null, 2)}\n`,
  );
  if (usePlugin && skipped.includes('.claude/settings.json')) {
    // Moving to the plugin (BRK-159): --update takes out the hooks repos init wrote and adds the plugin's two keys.
    const there = readTarget('.claude/settings.json');
    const moved = withPluginSettings(there);
    if (update && moved !== null && !sameJson(moved, there)) {
      skipped.splice(skipped.indexOf('.claude/settings.json'), 1);
      files.push({ path: '.claude/settings.json', content: moved, changed: true });
    } else if (!hasPlugin(there))
      notes.push(
        `.claude/settings.json is already there${moved === null ? " and isn't JSON" : ''}: add breakaway's plugin to it (${JSON.stringify(pluginSettings())}), or a started agent won't have the tasks skill and its output won't show on its task.${update ? '' : ` npx breakaway repos init ${repo.slug} --update adds it.`}`,
      );
  } else if (skipped.includes('.claude/settings.json')) {
    const there = readTarget('.claude/settings.json');
    const rewired = update ? rewireHooks(there) : there;
    if (rewired !== there) {
      skipped.splice(skipped.indexOf('.claude/settings.json'), 1);
      files.push({ path: '.claude/settings.json', content: rewired, changed: true });
    } else if (
      !there.includes(hookCommand('session')) &&
      !(HOOKS_FROM_COPY && there.includes('scripts/tasks/session-hook.mjs'))
    )
      notes.push(
        `.claude/settings.json is already there: set its session hooks to \`${hookCommand('session')}\` (and \`${hookCommand('wait')}\` on Stop), or a started agent's output won't show on its task.${HOOKS_FROM_COPY ? '' : ' Hooks that run scripts/tasks/session-hook.mjs stop working once the old copy is removed.'}`,
      );
    // Settings from before the edit hook (IDEA-55): agents there don't claim the files they edit until it's added.
    if (!rewired.includes(hookCommand('edit')))
      notes.push(
        `.claude/settings.json has no edit hook: add ${JSON.stringify({ PreToolUse: sessionHooks().PreToolUse })} to its hooks, so agents claim each file before they edit it.`,
      );
  }
  if (readTarget('.claude/skills') === null) files.push({ path: '.claude/skills', link: '../.agents/skills' });
  if (!usePlugin) copy(SKILL, skillFor(read(SKILL), board, repo));
  else if (update && readTarget(SKILL) !== null) {
    // The plugin brings the tasks skill: the copy repos init wrote goes, and a skill of the repository's own stays.
    if (owns(SKILL)) {
      removals.push(SKILL);
      if (String(readTarget('AGENTS.md') ?? '').includes(SKILL))
        notes.push(
          `AGENTS.md still names ${SKILL} and the session hooks in .claude/settings.json: the tasks skill and the hooks come from breakaway's plugin now (${PLUGIN}, turned on in .claude/settings.json), so say that there instead.`,
        );
    } else theirs.push(SKILL);
  }
  copy(PIPELINE_SKILL, skillFor(read(PIPELINE_SKILL), board, repo));
  add('AGENTS.md', agentsMd(repo, board, configDir, { plugin: usePlugin }));
  if (!skipped.includes('AGENTS.md')) todo.push('AGENTS.md: add how to build in this repository');

  const pkg = readTarget('package.json');
  if (pkg === null) {
    files.push({
      path: 'package.json',
      content: `${JSON.stringify({ name: repo.slug, private: true, type: 'module' }, null, 2)}\n`,
    });
  } else {
    skipped.push('package.json');
    let type = null;
    try {
      type = JSON.parse(pkg).type ?? null;
    } catch {
      /* said below */
    }
    if (type !== 'module')
      notes.push(
        'package.json has no "type": "module", which the CLI\'s .js files need: add it, or run the CLI from a folder with its own package.json that has it.',
      );
  }

  add('.envrc', ENVRC(repo.slug));
  add('.taskrc', TASKRC(repo.slug, url, configDir));
  copy('scripts/task', read('scripts/task'), { mode: 0o755 });

  const ignore = readTarget('.gitignore');
  const have = new Set(
    String(ignore ?? '')
      .split('\n')
      .map((l) => l.trim()),
  );
  const missing = GITIGNORE.filter((l) => !have.has(l));
  if (missing.length) {
    const before = ignore === null ? '' : ignore.replace(/\n*$/u, '\n');
    files.push({ path: '.gitignore', content: `${before}${missing.join('\n')}\n`, append: ignore !== null });
  }
  const attributes = readTarget('.gitattributes');
  const haveAttributes = new Set(
    String(attributes ?? '')
      .split('\n')
      .map((l) => l.trim()),
  );
  const missingAttributes = GITATTRIBUTES.filter((l) => !haveAttributes.has(l));
  if (missingAttributes.length) {
    const before = attributes === null ? '' : attributes.replace(/\n*$/u, '\n');
    files.push({
      path: '.gitattributes',
      content: `${before}${missingAttributes.join('\n')}\n`,
      append: attributes !== null,
    });
  }
  // A file the repository still runs stays, with the old copy it belongs to (BRK-79): package.json, or settings the
  // rewiring above couldn't move to npx.
  const settingsNow =
    files.find((f) => f.path === '.claude/settings.json')?.content ?? readTarget('.claude/settings.json');
  const uses = [
    ['package.json', readTarget('package.json')],
    ['.claude/settings.json', settingsNow],
  ];
  for (const group of [(p) => p.startsWith('scripts/'), (p) => p.startsWith(HOOKS_DIR)]) {
    const inGroup = removals.filter(group);
    const used = uses.flatMap(([file, text]) =>
      inGroup.filter((p) => String(text ?? '').includes(p)).map((p) => `${file} still runs ${p}`),
    );
    if (!used.length) continue;
    for (const p of inGroup) removals.splice(removals.indexOf(p), 1);
    notes.push(
      `${used.join('; ')}, so its copy stays: switch it to npx breakaway (\`${hookCommand('session')}\` for the hooks), then run --update again to remove the copy.`,
    );
  }
  if (theirs.length)
    notes.push(
      `${theirs.join(', ')} ${theirs.length > 1 ? 'are' : 'is'} at a path breakaway copies to, but repos init has no record of writing ${theirs.length > 1 ? 'them' : 'it'}, so ${theirs.length > 1 ? 'they are left as they are' : 'it is left as it is'}. If one is breakaway's older copy, delete it and run --update again.`,
    );
  // The record of what is breakaway's here; a run without --update leaves an existing one alone.
  const record = `${JSON.stringify(
    {
      about: `Files repos init copied from ${board} and keeps in step with it (npx breakaway repos init <slug> --update). A file not listed is this repository's own, even at a path breakaway copies to.`,
      from: board,
      files: [...ours].sort(),
    },
    null,
    2,
  )}\n`;
  const recordThere = readTarget(MANIFEST);
  if (recordThere === null) files.push({ path: MANIFEST, content: record });
  else if (recordThere === record) current.push(MANIFEST);
  else if (update) files.push({ path: MANIFEST, content: record, changed: true });
  else skipped.push(MANIFEST);
  return { files, removals, skipped, current, notes, todo, plugin: usePlugin };
}
