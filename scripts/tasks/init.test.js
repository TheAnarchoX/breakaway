import { describe, expect, it } from 'vitest';
import { areaList } from '../../src/prompt.js';
import {
  CLI_ENTRIES,
  CLI_PACKAGE,
  HOOKS_DIR,
  HOOKS_FROM_COPY,
  MANIFEST,
  hookCommand,
  PROMPT_SECTIONS,
  agentsMd,
  boardSources,
  cliCopySources,
  copiedSources,
  importClosure,
  initCommitMessage,
  initPlan,
  machineTaskrc,
  promptSections,
  rewireHooks,
  routinePrompt,
  sessionHooks,
  skillFor,
  taskrcLines,
  withRepoInTaskrc,
} from './init.js';
import { promptPlaceholders } from '../../src/wizard.js';
import BOARD_FILES from '../../src/board-files.json';

// This checkout's files, as repos init reads them, keyed by their path from the repository's root.
const RAW = import.meta.glob(
  [
    '../tasks.mjs',
    '../*.mjs',
    '../lib/*.js',
    '../install/*.js',
    '../task',
    './*.js',
    './*.mjs',
    '../../src/*.js',
    '../../prompts/*.md',
    '../../taskrc',
    '../../.claude/settings.json',
    '../../.agents/skills/tasks/SKILL.md',
  ],
  { query: '?raw', import: 'default', eager: true },
);
const FILES = new Map(
  Object.entries(RAW).map(([key, text]) => [
    key
      .replace(/^\.\.\/\.\.\//u, '')
      .replace(/^\.\.\//u, 'scripts/')
      .replace(/^\.\//u, 'scripts/tasks/'),
    text,
  ]),
);
const read = (path) => {
  if (!FILES.has(path)) throw new Error(`no ${path} in the fixture`);
  return FILES.get(path);
};

const repo = {
  slug: 'bwy-cld-130-test',
  github: 'acme/bwy-cld-130-test',
  name: 'bwy-cld-130-test',
  defaultBranch: 'main',
  areas: [
    { project: 'product', prefix: 'BWYP', name: 'Product' },
    { project: 'cloud', prefix: 'BWYC', name: 'Cloud' },
  ],
  routine: null,
};
const board = 'acme/board';
const BOARD_URL = 'https://board.example.org';
const empty = () => null;

describe('repos init (CLD-191)', () => {
  it('copies the CLI with everything it imports, and no tests', () => {
    const files = importClosure(CLI_ENTRIES, read);
    expect(files).toEqual(
      expect.arrayContaining([
        'scripts/tasks.mjs',
        'scripts/tasks/ask.js',
        'scripts/tasks/init.js',
        'src/init.js',
        'scripts/tasks/proxy.js',
        'scripts/tasks/repo.js',
        'scripts/tasks/structure.js',
        'scripts/tasks/hook-config.js',
        'scripts/tasks/session-hook.mjs',
        'scripts/tasks/session-log.js',
        'scripts/tasks/session-messages.js',
        'scripts/tasks/message-wait.mjs',
        'src/ping.js',
        'src/model.js',
        'src/decision.js',
        'src/repos.js',
      ]),
    );
    expect(files.filter((f) => f.endsWith('.test.js'))).toEqual([]);
    expect(files).not.toContain('scripts/tasks/import-workboard.mjs');
    // Every file it names exists, so the copy can never miss one the CLI imports.
    for (const f of files) expect(FILES.has(f), f).toBe(true);
  });

  it('fills in the agent prompt from the template, leaving the owner’s parts to fill', () => {
    const prompt = routinePrompt(read('prompts/repository.md'), repo);
    expect(prompt).not.toMatch(/<!--/u);
    expect(prompt).toMatch(/^You are an agent for bwy-cld-130-test, started by the task board/u);
    expect(prompt).toContain(
      'bwy-cld-130-test, `acme/bwy-cld-130-test`. Its areas on the board, with their work-ID prefixes: product (`BWYP`), cloud (`BWYC`). Its rules are in `AGENTS.md`',
    );
    expect(prompt).toContain('the `tasks` skill (`.agents/skills/tasks/SKILL.md`)');
    expect(prompt).not.toMatch(/<(name|slug|owner\/name|path of the skill)>/u);
    // The headings the core refers to by name stay.
    for (const heading of ['Building', 'Checks', 'Pull requests', 'Direction', 'Dependency updates', 'Never share'])
      expect(prompt).toContain(`## ${heading}\n`);
  });

  it('fills every section of the prompt from the answers, and leaves no placeholder (CLD-196)', () => {
    const template = read('prompts/repository.md');
    const { sections, defaulted } = promptSections({ checks: '`npm test` and `npm run build`', 'never-share': '  ' });
    expect(sections.Checks).toBe('`npm test` and `npm run build`');
    // Blank counts as no answer: it takes the default.
    expect(defaulted).toEqual(['Building', 'Pull requests', 'Direction', 'Dependency updates', 'Never share']);
    const prompt = routinePrompt(template, repo, sections);
    expect(prompt).toContain('## Checks\n\n`npm test` and `npm run build`\n');
    for (const s of PROMPT_SECTIONS) {
      expect(prompt).toContain(`## ${s.heading}\n\n${sections[s.heading]}`);
      expect(s.default).not.toMatch(/<[^>]*>/u);
    }
    // The board's own check finds nothing left to fill in.
    expect(promptPlaceholders(prompt)).toEqual([]);
    // Without answers, the sections keep their placeholders, and the board flags each one.
    expect(promptPlaceholders(routinePrompt(template, repo))).toHaveLength(PROMPT_SECTIONS.length);
    // An answer with $ in it goes in as it is.
    expect(routinePrompt(template, repo, { Checks: 'Run `$ make check`.' })).toContain(
      '## Checks\n\nRun `$ make check`.\n',
    );
  });

  it('says which sections took the default, and only asks to fill in what’s left', () => {
    const { sections, defaulted } = promptSections({ building: 'Tests first.' });
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: empty, sections, defaulted });
    const prompt = plan.files.find((f) => f.path === 'tools/tasks/routine-prompt.md').content;
    expect(promptPlaceholders(prompt)).toEqual([]);
    expect(plan.todo).toEqual([
      'tools/tasks/routine-prompt.md: check the sections that took the default (Checks, Pull requests, Direction, Dependency updates, Never share)',
      'AGENTS.md: add how to build in this repository',
    ]);
    const all = promptSections(Object.fromEntries(PROMPT_SECTIONS.map((s) => [s.flag, `Our ${s.heading}.`])));
    expect(all.defaulted).toEqual([]);
    expect(initPlan({ url: BOARD_URL, repo, board, read, readTarget: empty, ...all }).todo).toEqual([
      'AGENTS.md: add how to build in this repository',
    ]);
  });

  it('points the skill’s links at where the copy has them', () => {
    const skill = skillFor(
      'See [the core](../../../prompts/core.md), [the manual](../../../docs/tasks.md#repositories), [rules](../../../AGENTS.md).',
      board,
    );
    expect(skill).toContain('(../../../tools/tasks/prompts/core.md)');
    expect(skill).toContain('(https://github.com/acme/board/blob/main/docs/tasks.md#repositories)');
    expect(skill).toContain('(../../../AGENTS.md)');
    // The skill the board ships links nowhere a copy can't reach.
    expect(skillFor(read('.agents/skills/tasks/SKILL.md'), board)).toContain('(../../../tools/tasks/prompts/core.md)');
  });

  it('writes the tasks skill for this repository: its areas and its prompt, not breakaway’s (BRK-79)', () => {
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: empty });
    const skill = plan.files.find((f) => f.path === '.agents/skills/tasks/SKILL.md').content;
    expect(skill).not.toMatch(
      /breakaway’s areas|breakaway's areas|prompts\/breakaway\.md|breakaway's work is on the board/u,
    );
    expect(skill).toContain(`This repository's areas: ${areaList(repo)}.`);
    expect(skill).toContain('[`tools/tasks/routine-prompt.md`](../../../tools/tasks/routine-prompt.md)');
    const own = { ...repo, routine: { prompt: 'docs/agents.md' } };
    expect(
      initPlan({ url: BOARD_URL, repo: own, board, read, readTarget: empty }).files.find(
        (f) => f.path === '.agents/skills/tasks/SKILL.md',
      ).content,
    ).toContain('[`docs/agents.md`](../../../docs/agents.md)');
  });

  it('gives each repository a Taskwarrior report and context, once', () => {
    expect(taskrcLines('breakaway')).toEqual(
      expect.arrayContaining([
        'report.breakaway.filter=status:pending -WAITING repo:breakaway',
        'context.breakaway.read=repo:breakaway',
        'context.breakaway.write=repo:breakaway',
      ]),
    );
    const once = withRepoInTaskrc(read('taskrc'), 'breakaway');
    expect(once).toContain('context.breakaway.write=repo:breakaway');
    expect(withRepoInTaskrc(once, 'breakaway')).toBe(once);
    // The shipped taskrc names no repository: every pair is added where it's needed.
    expect(read('taskrc')).not.toContain('context.breakaway.');
    // The default repository's pair also counts tasks without a repo, so they aren't lost, and has no write filter.
    expect(taskrcLines('acme', true)).toEqual(
      expect.arrayContaining([
        'report.acme.filter=status:pending -WAITING (repo: or repo:acme)',
        'context.acme.read=(repo: or repo:acme)',
      ]),
    );
    expect(taskrcLines('acme', true).join('\n')).not.toContain('context.acme.write=');
    expect(withRepoInTaskrc(read('taskrc'), 'acme', true)).toContain('context.acme.read=(repo: or repo:acme)');
  });

  it('plans every file an empty repository needs', () => {
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: empty });
    const paths = plan.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'tools/tasks/routine-prompt.md',
        'tools/tasks/prompts/core.md',
        'tools/tasks/prompts/stub.md',
        'tools/tasks/taskrc',
        'scripts/record-deployment.mjs',
        '.claude/settings.json',
        '.claude/skills',
        '.agents/skills/tasks/SKILL.md',
        'AGENTS.md',
        'package.json',
        '.envrc',
        '.taskrc',
        'scripts/task',
        '.gitignore',
      ]),
    );
    expect(plan.skipped).toEqual([]);
    // The CLI is on npm (BRK-7): no copy of it, and no removals on a first init.
    expect(paths.filter((p) => p.startsWith('scripts/tasks') || p === 'src/cli-version.js')).toEqual([]);
    expect(plan.removals).toEqual([]);
    const file = (path) => plan.files.find((f) => f.path === path);
    expect(file('tools/tasks/prompts/core.md').content).toBe(read('prompts/core.md'));
    // The session hooks run through npx, with the same events and flags as this repository's own.
    const { hooks } = JSON.parse(file('.claude/settings.json').content);
    expect(Object.keys(hooks)).toEqual(Object.keys(JSON.parse(read('.claude/settings.json')).hooks));
    expect(hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: hookCommand('session'),
      async: true,
    });
    expect(hooks.Stop[0].hooks[1]).toEqual({
      type: 'command',
      command: hookCommand('wait'),
      async: true,
      asyncRewake: true,
      timeout: 300,
    });
    expect(file('AGENTS.md').content).toContain('npx breakaway');
    // While breakaway is private the hooks run from a copy (BRK-64): both entries and what they import, in their own folder.
    expect(hookCommand('session', { fromCopy: false })).toBe(`npx --yes ${CLI_PACKAGE} hook session`);
    expect(hookCommand('wait', { fromCopy: true })).toBe(
      `node "$CLAUDE_PROJECT_DIR/${HOOKS_DIR}scripts/tasks/message-wait.mjs"`,
    );
    const hookFiles = paths.filter((p) => p.startsWith(HOOKS_DIR));
    if (HOOKS_FROM_COPY) {
      expect(hookFiles).toContain(`${HOOKS_DIR}scripts/tasks/session-hook.mjs`);
      expect(hookFiles).toContain(`${HOOKS_DIR}scripts/tasks/message-wait.mjs`);
      expect(hookFiles).toContain(`${HOOKS_DIR}src/redact.js`);
      expect(hookFiles.some((p) => p.endsWith('cli.js') || p.endsWith('init.js'))).toBe(false);
    } else expect(hookFiles).toEqual([]);
    expect(file('.claude/skills')).toEqual({ path: '.claude/skills', link: '../.agents/skills' });
    expect(JSON.parse(file('package.json').content)).toEqual({
      name: 'bwy-cld-130-test',
      private: true,
      type: 'module',
    });
    expect(file('.taskrc').content).toMatch(/^include tools\/tasks\/taskrc$/mu);
    expect(file('.taskrc').content).toMatch(/^context=bwy-cld-130-test$/mu);
    // Plain task lists with the repository's report, which has the Work column (CLD-193).
    expect(file('.taskrc').content).toMatch(/^default\.command=bwy-cld-130-test$/mu);
    // The board's address as the CLI gives it, and this machine's folder for the board when it doesn't say (CLD-136).
    expect(file('.taskrc').content).toMatch(/^sync\.server\.url=https:\/\/board\.example\.org$/mu);
    expect(file('.taskrc').content).toMatch(/^include ~\/\.config\/breakaway\/taskrc$/mu);
    expect(file('.envrc').content).toContain('export TASKRC="$PWD/.taskrc"');
    expect(file('.envrc').content).toContain('direnv allow');
    expect(file('scripts/task')).toMatchObject({ mode: 0o755 });
    expect(file('tools/tasks/taskrc').content).toContain('context.bwy-cld-130-test.write=repo:bwy-cld-130-test');
    expect(file('.gitignore').content).toBe('.task/\n.task-session\n.env\n');
    expect(file('AGENTS.md').content).toContain('product (`BWYP`), cloud (`BWYC`)');
    expect(plan.todo.join('\n')).toMatch(/routine-prompt\.md.*\n.*AGENTS\.md/u);
  });

  it('points a repository at the install the CLI uses, and this machine’s folder for it (CLD-136)', () => {
    const plan = initPlan({
      repo,
      board,
      read,
      readTarget: empty,
      url: 'https://board.example.org',
      configDir: '~/.config/breakaway',
    });
    const file = (path) => plan.files.find((f) => f.path === path);
    expect(file('.taskrc').content).toMatch(/^sync\.server\.url=https:\/\/board\.example\.org$/mu);
    expect(file('.taskrc').content).toMatch(/^include ~\/\.config\/breakaway\/taskrc$/mu);
    expect(file('AGENTS.md').content).toContain('`~/.config/breakaway/tasks.env`');
  });

  it('pins LF for the shell scripts, appending only the .gitattributes lines it lacks (BRK-41)', () => {
    const fresh = initPlan({ repo, board, read, readTarget: () => null });
    expect(fresh.files.find((f) => f.path === '.gitattributes').content).toBe(
      'scripts/task text eol=lf\n.envrc text eol=lf\n',
    );
    const target = { '.gitattributes': '* text=auto\n.envrc text eol=lf' };
    const plan = initPlan({ repo, board, read, readTarget: (p) => target[p] ?? null });
    expect(plan.files.find((f) => f.path === '.gitattributes')).toEqual({
      path: '.gitattributes',
      content: '* text=auto\n.envrc text eol=lf\nscripts/task text eol=lf\n',
      append: true,
    });
  });

  it('never overwrites what the repository has, and appends only missing ignore lines', () => {
    const target = {
      'AGENTS.md': '# Ours\n',
      '.claude/settings.json': '{}\n',
      'package.json': '{ "name": "ours" }\n',
      '.gitignore': 'node_modules/\n.env',
      'tools/tasks/routine-prompt.md': 'Ours.\n',
    };
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: (p) => target[p] ?? null });
    const paths = plan.files.map((f) => f.path);
    for (const p of ['AGENTS.md', '.claude/settings.json', 'package.json', 'tools/tasks/routine-prompt.md']) {
      expect(paths).not.toContain(p);
      expect(plan.skipped).toContain(p);
    }
    expect(plan.files.find((f) => f.path === '.gitignore')).toEqual({
      path: '.gitignore',
      content: 'node_modules/\n.env\n.task/\n.task-session\n',
      append: true,
    });
    expect(plan.notes.join('\n')).toMatch(/session hooks/u);
    expect(plan.notes.join('\n')).toMatch(/"type": "module"/u);
    expect(plan.todo).toEqual([]);
    // Settings that already run the board's hooks need nothing said.
    const hooked = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => (p === '.claude/settings.json' ? JSON.stringify({ hooks: sessionHooks() }) : null),
    });
    expect(hooked.notes).toEqual([]);
  });

  it('puts the prompt where the registry says, and names it in AGENTS.md', () => {
    const elsewhere = { ...repo, routine: { prompt: 'agents/prompt.md' } };
    const plan = initPlan({ url: BOARD_URL, repo: elsewhere, board, read, readTarget: empty });
    expect(plan.files.map((f) => f.path)).toContain('agents/prompt.md');
    expect(agentsMd(elsewhere, board)).toContain('[`agents/prompt.md`](agents/prompt.md)');
  });
});

describe('repos init --update (CLD-193)', () => {
  // A repository set up earlier: every file as init wrote it, then the board's copies moved on.
  // It still carries the CLI copy repos init wrote before BRK-7.
  const original = {
    ...Object.fromEntries(
      initPlan({ url: BOARD_URL, repo, board, read, readTarget: empty })
        .files.filter((f) => !f.link)
        .map((f) => [f.path, f.content]),
    ),
    ...Object.fromEntries(cliCopySources(read).map((path) => [path, read(path)])),
  };

  it('replaces only the copied files that are older, and never the repository’s own', () => {
    const target = {
      ...original,
      'scripts/lib/promote.js': '// an old copy\n',
      'tools/tasks/prompts/core.md': 'An old core.\n',
      'tools/tasks/routine-prompt.md': 'Our filled-in prompt.\n',
      'AGENTS.md': '# Ours, filled in\n',
      '.taskrc': 'context=bwy-cld-130-test\n',
      '.claude/skills': '',
    };
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: (p) => target[p] ?? null, update: true });
    expect(plan.files.map((f) => f.path).sort()).toEqual(['scripts/lib/promote.js', 'tools/tasks/prompts/core.md']);
    expect(plan.files.every((f) => f.changed)).toBe(true);
    expect(plan.files.find((f) => f.path === 'scripts/lib/promote.js').content).toBe(read('scripts/lib/promote.js'));
    for (const own of ['tools/tasks/routine-prompt.md', 'AGENTS.md', '.taskrc', '.envrc', 'package.json'])
      expect(plan.skipped).toContain(own);
    expect(plan.current).toContain('scripts/lib/release-notes.js');
    expect(plan.todo).toEqual([]);
  });

  it('leaves a repository’s own file at a path it copies to alone, unless its record says repos init wrote it (BRK-79)', () => {
    // Set up before repos init kept a record, with its own scripts at the release helpers' paths.
    const { [MANIFEST]: _, ...unrecorded } = original;
    const target = {
      ...unrecorded,
      'AGENTS.md': '# Our own rules\n',
      'scripts/check-migrations.mjs': '// ours: compares against a base branch\n',
      'scripts/lib/promote.js': '// ours too\n',
      '.claude/skills': '',
    };
    const plan = initPlan({ url: BOARD_URL, repo, board, read, readTarget: (p) => target[p] ?? null, update: true });
    const paths = plan.files.map((f) => f.path);
    expect(paths).not.toContain('scripts/check-migrations.mjs');
    expect(paths).not.toContain('scripts/lib/promote.js');
    expect(plan.skipped).toEqual(expect.arrayContaining(['scripts/check-migrations.mjs', 'scripts/lib/promote.js']));
    expect(plan.notes.join('\n')).toMatch(
      /scripts\/check-migrations\.mjs, scripts\/lib\/promote\.js .*left as they are/u,
    );
    // The record it writes lists what is breakaway's (the copies that match), and not the repository's own.
    const record = JSON.parse(plan.files.find((f) => f.path === MANIFEST).content);
    expect(record.files).toContain('scripts/release-notes.mjs');
    expect(record.files).toContain('tools/tasks/prompts/core.md');
    expect(record.files).not.toContain('scripts/check-migrations.mjs');
    expect(record.files).not.toContain('scripts/lib/promote.js');
    // A file the record lists is replaced when it's older, as before.
    const recorded = { ...original, 'scripts/lib/promote.js': '// an old copy\n', '.claude/skills': '' };
    const again = initPlan({ url: BOARD_URL, repo, board, read, readTarget: (p) => recorded[p] ?? null, update: true });
    expect(again.files.map((f) => f.path)).toEqual(['scripts/lib/promote.js']);
    // Breakaway's promote.js imports src/promote.js: a repository that keeps its own promote.js doesn't get it.
    expect(paths).not.toContain('src/promote.js');
    // An older AGENTS.md from repos init names the copied files differently: its folders still count.
    const olderAgents = {
      ...target,
      'AGENTS.md':
        '- **Copied files.** `scripts/tasks.mjs`, `tools/tasks/`, and `.agents/skills/tasks/` come from [acme/board](https://github.com/acme/board).\n',
      '.agents/skills/tasks/SKILL.md': 'An old copy of the skill.\n',
    };
    const skill = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => olderAgents[p] ?? null,
      update: true,
    });
    expect(skill.files.map((f) => f.path)).toContain('.agents/skills/tasks/SKILL.md');
    expect(skill.files.map((f) => f.path)).not.toContain('scripts/check-migrations.mjs');
    // So is one in a repository set up before the record, whose AGENTS.md (as repos init wrote it) says it's copied.
    const declared = { ...unrecorded, 'scripts/lib/promote.js': '// an old copy\n', '.claude/skills': '' };
    const older = initPlan({ url: BOARD_URL, repo, board, read, readTarget: (p) => declared[p] ?? null, update: true });
    expect(older.files.map((f) => f.path).sort()).toEqual([MANIFEST, 'scripts/lib/promote.js'].sort());
  });

  it('has nothing to do when every copy is current, and adds a copied file that’s missing', () => {
    const current = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => original[p] ?? (p === '.claude/skills' ? '' : null),
      update: true,
    });
    expect(current.files).toEqual([]);
    const { 'scripts/lib/promote.js': _, ...without } = original;
    const missing = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => without[p] ?? (p === '.claude/skills' ? '' : null),
      update: true,
    });
    expect(missing.files).toEqual([expect.objectContaining({ path: 'scripts/lib/promote.js' })]);
    expect(missing.files[0].changed).toBeUndefined();
  });

  it('without --update leaves an older copy as it is, as before', () => {
    const plan = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => ({ ...original, 'scripts/lib/promote.js': 'old' })[p] ?? (p === '.claude/skills' ? '' : null),
    });
    expect(plan.files).toEqual([]);
    expect(plan.skipped).toContain('scripts/lib/promote.js');
    // Nor does it delete the old CLI copy.
    expect(plan.removals).toEqual([]);
  });

  it('moves hooks that run an earlier npm channel or version to the current package on update (BRK-47)', () => {
    const settings = (pkg) =>
      JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ command: `npx --yes ${pkg} hook session` }] }],
          Stop: [{ hooks: [{ command: `npx --yes ${pkg} hook session` }, { command: `npx --yes ${pkg} hook wait` }] }],
        },
      });
    for (const earlier of ['breakaway@next', 'breakaway', 'breakaway@1.0.1-main.3', 'breakaway@0'])
      expect(rewireHooks(settings(earlier)), earlier).toBe(settings(CLI_PACKAGE));
    // Another package's hooks, and other commands, are left alone.
    const other = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'npx --yes breakaway-extra hook session' }] }] },
    });
    expect(rewireHooks(other)).toBe(other);
  });

  it('points an existing settings.json at the current hook commands on update, leaving the rest (BRK-64)', () => {
    const settings = (fromCopy) =>
      JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ command: hookCommand('session', { fromCopy }) }] }] } });
    const plan = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => (p === '.claude/settings.json' ? settings(!HOOKS_FROM_COPY) : (original[p] ?? null)),
      update: true,
    });
    const file = plan.files.find((f) => f.path === '.claude/settings.json');
    expect(file.content).toBe(settings(HOOKS_FROM_COPY));
    expect(plan.skipped).not.toContain('.claude/settings.json');
    expect(rewireHooks(settings(HOOKS_FROM_COPY))).toBe(settings(HOOKS_FROM_COPY));
    // Without update it is left alone.
    const kept = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) => (p === '.claude/settings.json' ? settings(!HOOKS_FROM_COPY) : (original[p] ?? null)),
    });
    expect(kept.files.find((f) => f.path === '.claude/settings.json')).toBeUndefined();
  });

  // While the hooks run from a copy (BRK-64) an old copy of the CLI stays: its hooks still work.
  it.skipIf(HOOKS_FROM_COPY)(
    'deletes the old copy of the CLI, and only names the src/ files that came with it (BRK-7)',
    () => {
      const plan = initPlan({
        url: BOARD_URL,
        repo,
        board,
        read,
        readTarget: (p) => original[p] ?? (p === '.claude/skills' ? '' : null),
        update: true,
      });
      expect(plan.removals).toContain('scripts/tasks.mjs');
      expect(plan.removals).toContain('scripts/tasks/session-hook.mjs');
      expect(plan.removals.every((p) => p.startsWith('scripts/tasks'))).toBe(true);
      // The release helpers' own files stay, and so does src/ (it may be the repository's by now).
      expect(plan.removals).not.toContain('scripts/lib/promote.js');
      expect(plan.notes.join('\n')).toMatch(/src\/install\.js.*came with the old copy of the CLI/u);
      // Their settings still run the old hook script, so the note says to switch it.
      const hooked = initPlan({
        url: BOARD_URL,
        repo,
        board,
        read,
        readTarget: (p) =>
          p === '.claude/settings.json'
            ? '{"command":"node \\"$CLAUDE_PROJECT_DIR/scripts/tasks/session-hook.mjs\\""}'
            : (original[p] ?? null),
        update: true,
      });
      // Their settings still run the old CLI copy's hook script: rewired to npx, so removing the copy breaks nothing.
      const settings = hooked.files.find((f) => f.path === '.claude/settings.json');
      expect(settings.content).toBe(`{"command":"${hookCommand('session')}"}`);
      expect(hooked.removals).toContain('scripts/tasks/session-hook.mjs');
      // A package.json that still runs the copy keeps it, and says how to move off it (BRK-79).
      const scripted = initPlan({
        url: BOARD_URL,
        repo,
        board,
        read,
        readTarget: (p) =>
          p === 'package.json'
            ? '{"type":"module","scripts":{"tasks":"node scripts/tasks.mjs"}}'
            : (original[p] ?? null),
        update: true,
      });
      expect(scripted.removals).toEqual([]);
      expect(scripted.notes.join('\n')).toMatch(/package\.json still runs scripts\/tasks\.mjs/u);
    },
  );

  it('keeps an old copy of the CLI while the hooks run from a copy (BRK-64)', () => {
    if (!HOOKS_FROM_COPY) return;
    const plan = initPlan({
      url: BOARD_URL,
      repo,
      board,
      read,
      readTarget: (p) =>
        p === '.claude/settings.json'
          ? '{"command":"node \\"$CLAUDE_PROJECT_DIR/scripts/tasks/session-hook.mjs\\""}'
          : (original[p] ?? null),
      update: true,
    });
    expect(plan.removals).toEqual([]);
    expect(plan.notes.join('\n')).not.toMatch(/session hooks to/u);
  });

  it('versions every file it copies, and not cli-version.js itself', () => {
    const sources = copiedSources(read);
    expect(sources).toEqual(
      expect.arrayContaining([
        'scripts/tasks.mjs',
        'scripts/record-deployment.mjs',
        'prompts/core.md',
        'taskrc',
        'scripts/task',
        '.agents/skills/tasks/SKILL.md',
      ]),
    );
    expect(sources).not.toContain('src/cli-version.js');
  });
});

describe('this machine’s taskrc (CLD-193)', () => {
  const credentials =
    '# Written by npx breakaway setup. Keep private.\nsync.server.client_id=x\nsync.encryption_secret=y\n';
  const shared = read('taskrc');

  it('adds a report and context for each repository the shared taskrc lacks, after the credentials', () => {
    const text = machineTaskrc(credentials, ['acme', 'breakaway'], shared, 'acme');
    expect(text.startsWith(credentials)).toBe(true);
    expect(text).toContain('context.breakaway.read=repo:breakaway');
    // The default repository's pair also counts tasks without a repository.
    expect(text).toContain('context.acme.read=(repo: or repo:acme)');
    expect(text).toContain('report.acme.filter=status:pending -WAITING (repo: or repo:acme)');
  });

  it('refreshes on add and remove without touching the credentials', () => {
    const two = machineTaskrc(credentials, ['breakaway', 'scratch'], shared);
    expect(machineTaskrc(two, ['breakaway', 'scratch'], shared)).toBe(two);
    const one = machineTaskrc(two, ['breakaway'], shared);
    expect(one).not.toContain('scratch');
    expect(one).toContain('context.breakaway.write=repo:breakaway');
    expect(machineTaskrc(one, [], shared)).toBe(credentials);
  });
});

describe('the board’s copy of the files, for an empty repository’s first commit (BRK-132)', () => {
  it('holds every file repos init reads, as it is in this checkout', () => {
    const sources = boardSources(read);
    expect(sources).toEqual(expect.arrayContaining(['prompts/repository.md', 'prompts/core.md', 'scripts/task']));
    expect(
      BOARD_FILES,
      'src/board-files.json is behind the files repos init copies: run node scripts/board-files.mjs and commit it.',
    ).toEqual(Object.fromEntries(sources.map((path) => [path, read(path)])));
  });

  it('renders the same plan from it as from the checkout', () => {
    const fromCopy = (path) => {
      if (!(path in BOARD_FILES)) throw new Error(`no ${path} in src/board-files.json`);
      return BOARD_FILES[path];
    };
    const args = { repo, board, url: BOARD_URL, readTarget: empty, ...promptSections({}) };
    expect(initPlan({ ...args, read: fromCopy })).toEqual(initPlan({ ...args, read }));
  });

  it('gives the CLI and the board one first commit message', () => {
    expect(initCommitMessage('widgets')).toEqual({
      title: "Set up the task board's agent files",
      body: expect.stringMatching(/Added by npx breakaway repos init widgets\.$/u),
    });
    expect(initCommitMessage('widgets', { by: 'the board' }).body).toMatch(/Added by the board\.$/u);
  });
});
