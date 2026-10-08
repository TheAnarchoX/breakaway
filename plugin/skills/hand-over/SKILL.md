---
name: hand-over
description: Hand a claimed breakaway task over for review. Runs the repository's checks, posts on the peloton, opens the pull request that closes the task, and links it. Use when the person types /breakaway:hand-over.
argument-hint: "[work ID, when the session holds more than one]"
disable-model-invocation: true
---

# Hand the task over

Hand over the task this session holds: `$ARGUMENTS` if given, else the one task claimed under this session's name. The person merges the pull request; the board marks the task done when it merges.

1. **Name the session.** Use `$BREAKAWAY_AGENT` when it's set, else `claude-<branch>` from `git branch --show-current`. Pass it to every command below as `--as <name>`.
2. **Find the task.** `npx --yes breakaway@2 list --mine --as <name>` lists what that name holds in this repository. None: say "This session holds no task: /breakaway:claim <ID> first." and stop. More than one and no `$ARGUMENTS`: list them and ask which.
3. **Run the checks** the repository's `AGENTS.md` names before handing back (lint, tests, build, and the rest). A check fails: fix it, or say what fails and stop. Never skip or disable a test to get green.
4. **Say what changed on the peloton:** `npx --yes breakaway@2 peloton step "<what the pull request changes>; does this affect anyone?" --as <name>`.
5. **Open the pull request** from the task's branch, as `AGENTS.md` says. Its title is the work ID and a plain sentence (`BRK-12: Sort the inbox by age`). Its description says what changed and why, what you ran and whether it passed, and what the owner has to do after merging, and ends with `Closes <ID>.` For a spec, a plan, or a partial step, end it with `Part of <ID>.` instead and skip step 6.
6. **Link it:** `npx --yes breakaway@2 modify <ID> --pr <number> --as <name>`. The board moves the task to In review.
7. **Note the result:** `npx --yes breakaway@2 comment <ID> "<one line: what the pull request does>" --as <name>`.

Never mark the task done, never merge, and never deploy: the person who runs the board does. Then keep an eye on the pull request: fix failing checks and answer review comments until it's merged.
