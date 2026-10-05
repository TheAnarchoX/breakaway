#!/usr/bin/env node
/**
 * Writes the breakaway plugin's generated files (CLI-7, docs/specs/IDEA-25-claude-plugin.md): the `tasks` skill, made
 * from .agents/skills/tasks/SKILL.md for any repository, the session hooks from sessionHooks() in src/init.js, and the
 * licence. Unlike src/board-files.json they're committed, because the plugin is read from git; a test in
 * scripts/tasks/plugin.test.js fails when one is behind its source. The rest of plugin/ is written by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SKILL } from '../src/prompt.js';
import { sessionHooks, skillFor } from '../src/init.js';
import { BREAKAWAY_REPO } from '../src/updates.js';

export const BOARD = BREAKAWAY_REPO;
export const PLUGIN_DIR = 'plugin/';

/**
 * The tasks skill as the plugin ships it. A plugin works in any checkout, so the skill names no breakaway rule and
 * links nowhere a checkout may not have: the board's docs and the core point at GitHub, `AGENTS.md` is the checkout's
 * own. Each change must find its text, so a skill reworded there fails here instead of shipping half changed.
 */
export function pluginSkill(text, board = BOARD) {
  /** @type {[RegExp, string][]} */
  const changes = [
    [
      /breakaway's work is on the board that tracks this repository/gu,
      "This repository's work is on the board that tracks it",
    ],
    [/breakaway's areas: [^.\n]+\./gu, "This repository's areas are in its `AGENTS.md`."],
    [
      /\[`prompts\/core\.md`\]\(\.\.\/\.\.\/\.\.\/prompts\/core\.md\)/gu,
      `the core: \`tools/tasks/prompts/core.md\` in a repository \`repos init\` set up, and [on GitHub](https://github.com/${board}/blob/main/prompts/core.md)`,
    ],
    [/\[`AGENTS\.md`\]\(\.\.\/\.\.\/\.\.\/AGENTS\.md\)/gu, '`AGENTS.md`'],
    [
      /Follow \[`prompts\/breakaway\.md`\]\(\.\.\/\.\.\/\.\.\/prompts\/breakaway\.md\), which starts with the core\./gu,
      "Follow the repository's agent prompt, which `AGENTS.md` names and which starts with the core.",
    ],
  ];
  let out = String(text);
  for (const [pattern, replacement] of changes) {
    if (!pattern.test(out))
      throw new Error(`The tasks skill no longer has ${pattern}: update pluginSkill in scripts/plugin.mjs.`);
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  // The rest of the board's docs are on GitHub, as they are for a copy (skillFor).
  return skillFor(out, board);
}

/** The plugin's generated files, by their path from the repository's root. */
export function pluginFiles(read) {
  return {
    [`${PLUGIN_DIR}skills/tasks/SKILL.md`]: pluginSkill(read(SKILL)),
    [`${PLUGIN_DIR}hooks/hooks.json`]: `${JSON.stringify({ hooks: sessionHooks() }, null, 2)}\n`,
    [`${PLUGIN_DIR}LICENSE`]: read('LICENSE'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = new URL('../', import.meta.url);
  const read = (/** @type {string} */ path) => readFileSync(new URL(path, ROOT), 'utf8');
  for (const [path, content] of Object.entries(pluginFiles(read))) writeFileSync(new URL(path, ROOT), content);
  console.error('Wrote the plugin’s skill, hooks, and licence in plugin/.');
}
