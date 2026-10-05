---
name: next
description: Claim the best ready task on the breakaway board for this checkout's repository, read it, and say what it is. Use when the person types /breakaway:next.
argument-hint: "[--project <area>] [--horizon <now|next|later>]"
disable-model-invocation: true
---

# Claim the next task

Claim the best ready task in this checkout's repository, then read it. The `tasks` skill holds the board's rules; follow it from here on.

1. **Name the session.** Use `$BREAKAWAY_AGENT` when it's set, else `claude-<branch>` from `git branch --show-current`. Pass it to every command below as `--as <name>`, since each command runs in its own shell.
2. **Claim the next one:** `npx --yes breakaway@1 next --claim $ARGUMENTS --as <name>`. `$ARGUMENTS` may narrow it with `--project <area>` or `--horizon <h>`; pass nothing else through.
   - Nothing ready: say so in a line ("Nothing ready in this repository.") and stop.
   - `409`: another agent claimed it first. Run the same command once more; if it fails again, say so and stop. Never `--force`.
   - No board configured, or this checkout's repository isn't on the board: say what the CLI said, and that `npx breakaway setup` connects this machine and the board's owner adds a repository with `repos add`.
3. **Read it:** `npx --yes breakaway@1 show <ID>` with the work ID it claimed. Tell the person, in a few lines: the work ID and title, what it waits for and holds up, its done when, and its spec if it has one. If it's tagged `+decide`, say it needs the owner's decision first, release it with `npx --yes breakaway@1 release <ID> --as <name>`, and stop.
4. **Before any change**, read the repository's `AGENTS.md` and check in on the peloton: `npx --yes breakaway@1 peloton checkin "<what you'll change>" --as <name>`.

Don't change any file in this command: claiming and reading is the whole of it. The work follows, and `/breakaway:hand-over` finishes it.
