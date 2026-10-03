---
name: tasks
description: Use when picking up, claiming, starting, handing over, or finishing breakaway work; when asked what to work on next or about a work ID like BRK-12 or WEB-3; when adding follow-up tasks, dependencies, or notes; when several agents work in parallel; and at the start of any session, local or cloud, that should work from the task board.
---

# Working from the board

breakaway's work is on the board that tracks this repository. The CLI is `npx breakaway` (`tasks` below; in breakaway's own checkout, `node scripts/tasks.mjs` is the same); `tasks help` lists every command. The board's rules for agents it starts are in [`prompts/core.md`](../../../prompts/core.md).

**The claim is the lock.** Many agents share the board. Only work on a task you claimed, claim only through the CLI (it's atomic), and never set a claim any other way.

## The loop

1. **Name yourself** once: the name the board gave you if it started you, or `claude-<branch>`; export the agent-name variable `npx breakaway help` names (`BREAKAWAY_AGENT`), or pass `--as <name>` to every command.
2. **Check the board works:** `tasks health`. No token? Stop and tell the owner; don't hunt for one.
3. **Pick:**
   - asked for a task → `tasks claim <ID>`
   - asked to "pick something" → `tasks next --claim` (add `--project`, `--horizon` to narrow it)

   A `409` means someone has it or it's blocked. Pick another; never `--force` someone else's claim.
4. **Read it:** `tasks show <ID>` (description, done when, comments, spec, what it waits for and holds up), then [`AGENTS.md`](../../../AGENTS.md) if you haven't this session.
5. **Work** on a branch. Record what you learn as you go: `tasks comment <ID> "<finding>"`. Comments are append-only; the description is the current brief, and you edit it only on a task you made or are refining. New work you find becomes `tasks add "<title>" --project <area> --tag agent|owner --horizon <h> --brief "<what and why>" --done-when "<done when>"`, with `--depends <ID>` when it waits for something. breakaway's areas: `board`, `web`, `docs`, `launch`, `brand`.
6. **Hand over:** open the pull request with `Closes <ID>.` in its description, then `tasks modify <ID> --pr <number>` and `tasks comment <ID> "<one-line result>"`. The board moves the task to In review and marks it done when the pull request merges; don't mark it done yourself. If you stop before a pull request: `comment` where you got to, then `release <ID>`.

## Rules

| Situation | Do |
| --- | --- |
| Task is `+decide` | Don't start it. If it has no questions, add some with `modify <ID> --decision <file.json>` (`decision --template` prints an example). |
| You need the owner to choose | Ask with a decision, not prose: `add "<title>" --tag owner --decision <file.json>` and make the work that waits `--depends` on it. Only the owner answers, on the board; read the answers with `show`. |
| Part of the work needs the owner (an install, a dashboard, a sign-off) | Finish your part, then `add` a `+owner` task for the rest that `--depends` on yours. |
| Task needs design choices | Write the spec in `docs/specs/<ID>-<slug>.md` and `modify <ID> --spec <path>`. |
| You're blocked by another task | `comment` why, `release`, and pick the blocker or another task. |
| A claim looks abandoned | Ask the owner; don't take it. |
| Opening a pull request for a spec, plan, or partial step | Write `Part of <ID>.`, not `Closes`, and don't put it in `--pr`: merging the pull request in that field finishes the task. A branch name alone never closes anything. |
| Checking your pull request | `tasks github` (checks, reviews, failing runs) or `tasks show <ID>`. |
| `claim` says the task belongs to another repository | Don't cross it with `--repo`: that work belongs in a checkout of its own repository. `comment` and `release` if the board started you on it. |
| The board started you | Follow [`prompts/breakaway.md`](../../../prompts/breakaway.md), which starts with the core. Check the payload's `Repository:` line against `git remote get-url origin` first. |
| The task is an `IDEA-` | Shape it, don't build it: "Shaping an idea" in the core. |
| Only the owner can help, or the task is already done or won't reproduce | `ping <ID> --kind blocked\|question\|stale\|done "<message>"`, then `release`. Ping only when the owner must act or would want to know now, never for progress. Full rules: "Pinging the owner" in the core. |
| Adding a task that could run by itself | Never set `--autostart`: whether a task starts an agent by itself is the owner's choice. |

## Working across repositories

The board runs several repositories, and every task belongs to one. The CLI works in the repository `git remote get-url origin` names: `list`, `next`, `claim`, and `add` stay in it, and `show <ID>` works for any ID. Work that spans repositories is a task in each, with a `depends` between them; a task never moves, and `Closes <ID>.` in this repository's pull request only closes this repository's tasks.

This repository is public and the board isn't. Never copy another repository's tasks, comments, or names into a file, commit, or pull request here, and never put a person's details or any secret in a task's title, description, or comments.

## Common mistakes

- Starting work before `claim` returns: another agent may already have it.
- Marking `done` yourself while the pull request is open: the board does it on merge.
- Writing `Closes <ID>` in a spec pull request, or putting it in `--pr`.
- Pinging to report progress or a pull request: the board shows both.
- Leaving a claim when you stop: always `release` with a comment.
