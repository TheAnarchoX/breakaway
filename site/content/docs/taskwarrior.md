---
title: Taskwarrior
description: Use Taskwarrior 3 with the board: sync, the reports and contexts breakaway adds, how a checkout is set up, and why the web board and the CLI are enough without it.
---

Taskwarrior stays a first-class way in. The board speaks the **TaskChampion sync protocol**, the same one Taskwarrior 3 uses, so `task sync` reads and writes the board like any other replica. Taskwarrior is optional: the web board and the CLI work without it, and cloud agents use the CLI because Ubuntu ships Taskwarrior 2.6.

## Connect a machine

On your machine, after `init-secrets` and with `BREAKAWAY_URL` in `tasks.env`:

```sh
npx breakaway setup
```

It writes `taskrc` in `~/.config/breakaway` (the credentials, and each repository’s report and context) and runs the first `task sync`. Then use `scripts/task …`, or install [direnv](https://direnv.net/) and run `direnv allow` once in the checkout so plain `task` uses the board. Each checkout and worktree keeps its own replica in `.task/` (ignored by Git), so parallel agents never share one database file.

### A checkout

Taskwarrior can’t read the environment, so a checkout’s `.taskrc` names the server and the file with this machine’s credentials:

```text
include tools/tasks/taskrc
sync.server.url=https://tasks.example.org
include ~/.config/breakaway/taskrc
```

`repos init` writes these lines for a new repository. The first line includes the board’s shared `taskrc`.

### Another machine

Copy `tasks.env` to `~/.config/breakaway/tasks.env` on the other machine (mode 0600) and run `npx breakaway setup`. Without Taskwarrior, the CLI still works with just the token.

## Reports and contexts

```sh
task sync            # before reading and after changing: it's not automatic
task board           # open work, best first
task agent           # ready for an agent
task claimed         # in progress, oldest claim first
task owner           # needs you: owner work and open decisions
task breakaway       # one report per repository
task context breakaway   # only that repository's work
task wid:BRK-12 info # one task
task +BLOCKED        # anything Taskwarrior can filter
```

Taskwarrior’s numeric IDs belong to one replica; use the `wid` (or the UUID) when talking about a task anywhere else.

## Fields

The board’s fields are Taskwarrior UDAs (`wid`, `repo`, `horizon`, `claim`, `spec`, `pr`, `brief`, `done_when`, and more), declared in the shared `taskrc`. Taskwarrior carries `repo` like any field, so `repo:breakaway` filters. Tasks you make in Taskwarrior get their work IDs from the server.

> **Claims go through the CLI.** Taskwarrior’s conflict resolution keeps the later of two edits, so two agents could each think they won a claim. The claim is atomic only through the board’s API.

## If sync breaks

- `task sync` fails with a 403: this replica has another client ID. Run `npx breakaway setup` again.
- `410 Gone` on `get-child-version`: this replica last synced with another server, so the board doesn’t have its version. Start the replica again: `mv .task .task-stale`, then `scripts/task sync`, which fetches every task from the board’s snapshot. If the old one had changes that never reached the board, look them up with `TASKDATA=.task-stale task export` and make them again.
- `Could not read include file '~/.config/breakaway/taskrc'`: run `npx breakaway setup`.

More in [Operating a board](/docs/operations/#when-somethings-wrong).
