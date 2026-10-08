---
name: claim
description: Claim a task on the breakaway board by its work ID, read it, and say what it waits for. Use when the person types /breakaway:claim <ID>.
argument-hint: <work ID, like BRK-12>
disable-model-invocation: true
---

# Claim a task

Claim `$ARGUMENTS` on the board that tracks this checkout's repository, then read it. The `tasks` skill holds the board's rules; follow it from here on.

1. **No work ID?** If `$ARGUMENTS` is empty, say: "Name the task: /breakaway:claim BRK-12, or /breakaway:next for the best ready one." and stop.
2. **An idea?** If the work ID starts with `IDEA-`, don't claim it to build: an idea is shaped into a spec and tasks, never built. Say so, point at "Shaping an idea" in the board's core, and stop.
3. **Name the session.** Use `$BREAKAWAY_AGENT` when it's set, else the plugin's agent name setting (`$CLAUDE_PLUGIN_OPTION_AGENT_NAME`), else `claude-<branch>` from `git branch --show-current`. Pass it to every command below as `--as <name>`, since each command runs in its own shell.
4. **Claim it:** `npx --yes breakaway@2 claim $ARGUMENTS --as <name>`. The claim is atomic, and it's the lock.
   - `409`: someone else holds it, or it's blocked. Say who or what, and stop. Never take another agent's claim.
   - It belongs to another repository: say so. That work is done in a checkout of its own repository; never cross it with `--repo`.
   - No board configured, or this checkout's repository isn't on the board: say what the CLI said, and that the board's address and token go in the plugin's settings (`/plugin`, then breakaway) or `npx breakaway setup` connects this machine, and the board's owner adds a repository with `repos add`.
5. **Read it:** `npx --yes breakaway@2 show $ARGUMENTS`. Tell the person, in a few lines: the title, what it waits for and holds up, its done when, and its spec if it has one. If it's tagged `+decide`, say it needs the owner's decision first, release it with `npx --yes breakaway@2 release $ARGUMENTS --as <name>`, and stop.
6. **Before any change**, read the repository's `AGENTS.md` and check in on the peloton: `npx --yes breakaway@2 peloton checkin "<what you'll change>" --as <name>`.

Don't change any file in this command: claiming and reading is the whole of it. The work follows, and `/breakaway:hand-over` finishes it.
