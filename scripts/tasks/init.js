/**
 * What `npx breakaway repos init <slug>` adds to a registered repository (CLD-191): the least a board-started
 * agent needs to claim and work a task there, and Taskwarrior set up the way the board has it. Nothing here
 * overwrites a file the repository already has: it's skipped and said, and `.gitignore` only gets the lines
 * it lacks. Pure (the files come through `read` and `readTarget`), so it's tested without git or a disk;
 * the clone, commit, and push are in scripts/tasks.mjs.
 */
import { SKILL, areaList, routinePrompt } from '../../src/prompt.js';
import { promptPathOf } from '../../src/repos.js';

/** This machine's folder for the board, as .taskrc names it, where a caller doesn't say (scripts/tasks/settings.js). */
const DEFAULT_DIR = '~/.config/breakaway';

export { routinePrompt };

/**
 * The CLI on npm (BRK-7), as a repository runs it: `npx breakaway`, pinned to the major (BRK-47), so a breaking change
 * never reaches a repository by itself. It was the `next` channel until the first stable release.
 */
export const CLI_PACKAGE = 'breakaway@1';
/**
 * Where the CLI starts: the command, and the two session hooks. repos init no longer copies them (BRK-7): an old copy
 * is replaced by npx, and these still version the CLI and say which files an old copy holds.
 */
export const CLI_ENTRIES = ['scripts/tasks.mjs', 'scripts/tasks/session-hook.mjs', 'scripts/tasks/message-wait.mjs'];
/**
 * While breakaway was private, nothing reached npm (BRK-57), so repos init copied the two hooks and what they import
 * under HOOKS_DIR and settings.json ran them from there (BRK-64). breakaway is public and on npm now, so the hooks run
 * through npx again (BRK-69), and `repos init --update` removes a copy an older repos init left.
 */
export const HOOKS_FROM_COPY = false;
/** The session hooks' entry files, and where their copy goes: its own folder, so it never touches the repository's src/. */
export const HOOK_ENTRIES = ['scripts/tasks/session-hook.mjs', 'scripts/tasks/message-wait.mjs'];
export const HOOKS_DIR = 'tools/tasks/cli/';
/** The release helpers a repository's Deploy, Promote, and Roll back workflows run (BRK-45), copied with what they import. */
export const RELEASE_ENTRIES = [
  'scripts/record-deployment.mjs',
  'scripts/promote-check.mjs',
  'scripts/release-notes.mjs',
  'scripts/check-migrations.mjs',
  'scripts/release-artifact.mjs',
];
/** Copied unchanged: the board's shared core and stub, and the Taskwarrior settings the new .taskrc includes. */
const COPIED = ['prompts/core.md', 'prompts/stub.md'];
/** Copied with a change for the repository, or made from the board's: their source is versioned too. */
const ADAPTED = ['taskrc', 'scripts/task', SKILL];
/**
 * Where the board's files (the prompts, the shared taskrc) go in another repository. In the board's own checkout they
 * sit at the root, so the paths `read` takes are the board's; what is written keeps this folder.
 */
const TARGET_DIR = 'tools/tasks/';
const GITIGNORE = ['.task/', '.task-session', '.env'];
/** Pinned to LF so the shell scripts run on a checkout with core.autocrlf=true (BRK-41). */
const GITATTRIBUTES = ['scripts/task text eol=lf', '.envrc text eol=lf'];

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
 * `read(path)` gives a file's text. Tests are never followed.
 */
export function importClosure(entries, read) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const dir = path.split('/').slice(0, -1).join('/');
    for (const m of read(path).matchAll(RELATIVE_IMPORT)) {
      const next = normalize(`${dir}/${m[1]}`);
      if (!/\.test\.js$/u.test(next) && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/**
 * Every file CLI_VERSION in src/cli-version.js versions (repository paths, sorted): what repos init copies, as it is
 * or adapted, and the CLI's own files, which the npm package carries and an old copy still holds. cli-version.js
 * itself is left out, so the fingerprint can live in it.
 */
export function copiedSources(read) {
  return [
    ...new Set([...importClosure(CLI_ENTRIES, read), ...importClosure(RELEASE_ENTRIES, read), ...COPIED, ...ADAPTED]),
  ]
    .filter((path) => path !== 'src/cli-version.js')
    .sort();
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
  const entry = HOOK_ENTRIES.find((path) => path.includes(name === 'wait' ? 'message-wait' : 'session-hook'));
  return `node "$CLAUDE_PROJECT_DIR/${HOOKS_DIR}${entry}"`;
}

/** The session hooks .claude/settings.json runs (see HOOKS_FROM_COPY). */
export function sessionHooks(pkg = CLI_PACKAGE) {
  const hook = (name, extra = {}) => ({
    type: 'command',
    command: hookCommand(name, { pkg }),
    async: true,
    ...extra,
  });
  const session = [{ hooks: [hook('session')] }];
  return {
    SessionStart: session,
    UserPromptSubmit: session,
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
  for (const name of ['session', 'wait'])
    for (const fromCopy of [true, false]) {
      const was = JSON.stringify(hookCommand(name, { fromCopy })).slice(1, -1);
      const now = JSON.stringify(hookCommand(name)).slice(1, -1);
      out = out.split(was).join(now);
    }
  return out.replace(/npx --yes breakaway(?:@[^\s"\\]+)? hook (session|wait)\b/gu, (_, name) =>
    JSON.stringify(hookCommand(name)).slice(1, -1),
  );
}

/** A short SHA-256 of `paths` and their text: changes whenever one of them does. */
export async function fingerprint(paths, read) {
  const text = paths.map((path) => `${path}\0${read(path)}\0`).join('');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
export function skillFor(text, board) {
  return String(text)
    .replace(/\]\((?:\.\.\/)+((?:docs|tools)\/[^)]+)\)/gu, `](https://github.com/${board}/blob/main/$1)`)
    .replace(/\]\(((?:\.\.\/)+)prompts\//gu, ']($1tools/tasks/prompts/');
}

/** A starter AGENTS.md: how this repository works with the board. The owner adds how to build here. */
export function agentsMd(repo, board, dir = DEFAULT_DIR) {
  return `# Agent instructions

<!-- Started by \`npx breakaway repos init\` (breakaway's task board). Add how to build here: setup, tests, style, and anything agents must never do. -->

- **Work lives on the task board.** This repository's tasks are in the areas ${areaList(repo)}. Use the \`tasks\` skill (\`${SKILL}\`) and the CLI, \`npx breakaway\` (the \`breakaway\` package on npm), to claim, comment, and hand over. It works in this checkout's repository, so \`list\` and \`next\` show only this repository's tasks. The skill is breakaway's copy: where it names breakaway's own files or rules, the board's part applies and the rest doesn't.
- **Agents started by the board** follow [\`${promptPathOf(repo)}\`](${promptPathOf(repo)}), which starts with the board's core, \`tools/tasks/prompts/core.md\`.
- **Copied files.** \`tools/tasks/\`, the release helpers in \`scripts/\`, and \`${SKILL}\` come from [${board}](https://github.com/${board}). Don't edit them here: change them there. \`.claude/settings.json\` holds the session hooks that show a cloud agent's output on its task, and they run through \`npx\`, so this repository carries no copy of the CLI.
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
  sections = {},
  defaulted = [],
}) {
  const files = [];
  const skipped = [];
  const current = [];
  const notes = [];
  const todo = [];
  const add = (path, content, extra = {}) => {
    if (readTarget(path) !== null) skipped.push(path);
    else files.push({ path, content, ...extra });
  };
  /** A file copied from the board: added when it's missing, and with `update`, replaced when it differs. */
  const copy = (path, content, extra = {}) => {
    const there = readTarget(path);
    if (there === null) files.push({ path, content, ...extra });
    else if (!update) skipped.push(path);
    else if (there === content) current.push(path);
    else files.push({ path, content, ...extra, changed: true });
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
  for (const path of importClosure(RELEASE_ENTRIES, read)) copy(path, read(path));
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

  add('.claude/settings.json', `${JSON.stringify({ hooks: sessionHooks() }, null, 2)}\n`);
  if (skipped.includes('.claude/settings.json')) {
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
  }
  if (readTarget('.claude/skills') === null) files.push({ path: '.claude/skills', link: '../.agents/skills' });
  copy(SKILL, skillFor(read(SKILL), board));
  add('AGENTS.md', agentsMd(repo, board, configDir));
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
  return { files, removals, skipped, current, notes, todo };
}
