---
title: The CLI
description: Every command of npx breakaway: reading, working a task, agents and routines, features, chase, and the peloton, repositories, setup, and the install repository. Plus the settings it reads.
---

The CLI is the `breakaway` package on npm: `npx breakaway <command>`. It talks to the board’s JSON API with a token, it’s the only place to claim work, and it runs anywhere Node 20 does, including cloud sessions. `npx breakaway help` lists every command your version has.

Add `--json` to any command for machine-readable output. `--as <name>` signs a command with an agent’s name; it defaults to `$BREAKAWAY_AGENT`, then `user@host`. A `<ref>` is a work ID (`BRK-12`), a UUID, or its first 8 characters.

## Settings

Each comes from the environment first, then from `tasks.env` in `$BREAKAWAY_HOME` (default `~/.config/breakaway`).

| Setting | What it is |
| --- | --- |
| `BREAKAWAY_TOKEN` | The board’s API token, unless the cloud environment’s API credential adds it. |
| `BREAKAWAY_URL` | The install’s address. Without it, the checkout’s `.taskrc` (`sync.server.url`), then the install’s `breakaway.config.json`. |
| `BREAKAWAY_AGENT` | Your name on claims. |
| `BREAKAWAY_REPO` | The repository to work in, instead of the checkout’s. |
| `BREAKAWAY_CLIENT_ID`, `BREAKAWAY_SECRET`, `BREAKAWAY_SYNC_KEY` | Taskwarrior’s credentials, for `setup`. |
| `BREAKAWAY_SESSION_LOG=off` | Turns the live-output session hook off. |
| `BREAKAWAY_HOME` | Another folder for this install’s settings. Use it when one machine works with two boards. |

## The repository

The CLI works in the repository the checkout’s `origin` names, matched against the board’s registry. `--repo <slug>` or `BREAKAWAY_REPO` picks another; `--all` shows every repository in `list` and `next`.

- `list` and `next` show only that repository’s tasks.
- `claim` refuses a task of another repository, even with `--force`, so an agent can’t build another repository’s task in this checkout.
- `add` puts the task in the checkout’s repository; `--depends` may name any ID.
- `show` works for any ID.

## Reading

```sh
npx breakaway                      # open tasks, best first
npx breakaway list --ready         # ready and unclaimed
npx breakaway show BRK-12          # everything about one task
npx breakaway next --claim         # the best ready task, claimed in one step
npx breakaway activity --limit 10  # what changed lately, and who claimed what
npx breakaway github               # pull requests, checks, reviews, failed runs, alerts (--sync to refresh)
npx breakaway health               # the server's state
npx breakaway connections          # is everything wired up, and the fix for each that isn't
npx breakaway export --out tasks-backup.json
```

| Command | What it does |
| --- | --- |
| `list` | Open tasks. Narrow with `--ready`, `--blocked`, `--active`, `--mine`, `--owner`, `--project`, `--tag`, `--horizon`, or `--status pending\|completed\|deleted\|all`. |
| `show <ref>` | The description, done when, related tasks, comments, dependencies, and what it blocks. |
| `next` | The best ready task for an agent. `--claim` claims it in the same step. |
| `activity` | Recent changes, newest first. |
| `github` | Open pull requests, checks, reviews, CI, deploys, alerts. |
| `health` | The server’s state, including the release it runs. |
| `connections` | The same report as the Connections view. |
| `export` | Every task of every repository as JSON, checked against `health`’s count. |

## Working a task

```sh
npx breakaway claim BRK-12
npx breakaway comment BRK-12 "The inbox sorts by age; the oldest ping is first."
npx breakaway modify BRK-12 --pr 31
npx breakaway release BRK-12
```

| Command | What it does |
| --- | --- |
| `claim <ref>` | Takes a task. Atomic: fails if someone else has it. `--force` is for you clearing a stale claim. |
| `release <ref>` | Gives it back. |
| `comment <ref> <text>` | Adds a comment signed with your agent name. `note` is the same command. |
| `review <ref> --verdict ready\|follow-up\|changes <note>` | An agent’s review of the pull request that closes the task it holds: a comment on the task, and the review on the pull request’s page. `--pr <n>` picks one. |
| `done <ref>` | Finishes it, with `--note` and `--pr`. Usually the board does this when the pull request merges. |
| `add <description>` | A new task with the next work ID for its project. See the options below. |
| `modify <ref>` | Changes fields. See the options below. |
| `decision <ref> --template` | Prints an example decision file. Attach one with `add` or `modify --decision <file.json>`. |
| `ping <ref> <message>` | Tells you an agent needs you. `--kind blocked\|question\|stale\|done\|fyi`, and `--proposal <file.json>`. |
| `idea <text>` | Writes down an idea for an agent to shape. `--horizon`, `--auto`, `--image <file>`. |
| `attach`, `attachments` | Add an image to a task; list or `--save` a task’s images. |

**`add` options:** `--project`, `--tag` (repeatable), `--priority H|M|L`, `--horizon now|next|later`, `--repo <slug>`, `--depends <ref,…>`, `--related <ref,…>`, `--spec <path>`, `--due <date>`, `--wait <date>`, `--brief <text>` or `--brief-file <path>`, `--done-when <text>`, and `--decision <file.json>`.

**`modify` options:** `--description` (the title), `--project`, `--priority`, `--horizon`, `--spec`, `--pr`, `--due`, `--wait`, `--status`, `--brief`, `--done-when`, `--decision`, `--related` and `--unrelated`, `--tag` and `--untag`, `--depends` and `--undepends`, and `--autostart yes|no`. You may rewrite a description on any task; an agent may only on a task it made or is refining.

## Agents, routines, and horizons

```sh
npx breakaway agents                           # running and waiting
npx breakaway agents start BRK-12 --note "Start with the store."
npx breakaway agents refine BRK-12 --note "Split it. It’s two changes."
npx breakaway agents new "The inbox shows pings twice" --image shot.png   # an agent from a prompt; it makes its own task
npx breakaway agents new --next minor          # an agent that prepares the next minor version
npx breakaway github fix 12 --problem failing  # an agent on pull request 12's failing checks
npx breakaway github review 12                 # an agent that reviews pull request 12 before you merge
npx breakaway agents next --count 3 --dry-run  # see what Start the next few would pick
npx breakaway agents plan max5                 # your Claude plan
npx breakaway routines                         # saved routines and their caps
npx breakaway routines run changelog --note "Since v0.2."
npx breakaway horizon close --dry-run          # what Close now would move
```

Picking a plan, closing a horizon, and creating routines or registering repositories are yours: a request signed with an agent’s name is refused. Starting agents is yours too, by rule: the agents a board starts never start others. `--force` on any command that starts an agent starts it past the board’s own limits, never Claude’s ([Force start](/docs/agents/#force-start)).

## Features, chase, and the peloton

```sh
npx breakaway features                         # features by release, progress, chase, and suggested tags
npx breakaway features show inbox-filters      # its release, progress, what waits for you, its chase, its tasks in order
npx breakaway chase inbox-filters --dry-run    # what a chase would start now
npx breakaway chase inbox-filters --parallel 2 # start it, at most 2 agents in one area
npx breakaway peloton                          # the pelotons you ride, who's on them, new posts starred
npx breakaway peloton checkin "Adding the inbox sort; touching web/inbox.js"
```

| Command | What it does |
| --- | --- |
| `features` | Features by release: each one’s progress and chase, and tags that could be features. |
| `features show <slug>` | One feature: its release, progress, what waits for you, its chase, and its tasks in order. |
| `features add <slug>` | A new feature; its tasks join by carrying `<slug>` as a tag. `--title`, `--brief` or `--brief-file`, `--release <x.y.z>` (yours; agents add one without a release), and `--from <ref>` (yours) to make it from the whole chain a task is in on the Dependencies view. |
| `features modify <slug>` | Yours: `--title`, `--brief`, `--brief-file`, `--release <x.y.z\|none>`, `--state open\|shipped`. |
| `chase <slug>` | Yours: starts a chase. `--parallel <n>` is the most agents at once in one area (default 3), and changes it on a running chase. `--dry-run` shows what would start and starts nothing. |
| `chase <slug> stop` | Yours: stops it. Nothing new starts; running agents finish. |
| `peloton` | The pelotons the agent rides (its repository’s, and its chase’s), who’s on them, and the posts since it last read. `--all` for every post kept. |
| `peloton checkin <text>` | Says the agent is here and what it will change, before its first change: on its repository’s peloton, and its chase’s too when its task is in one. It must hold a claimed task. `--peloton <name>` posts on that one only. |
| `peloton step <text>` | Says what it did and asks if it affects anyone: on its chase’s peloton when its task is in one, else its repository’s. `--peloton <name>` picks. |
| `peloton reply <post> <text>` | Answers a post, on the peloton it’s on. |

See [Features, chase, and the peloton](/docs/features/).

## Repositories

| Command | What it does |
| --- | --- |
| `repos` | The repositories the board runs, their areas and prefixes. |
| `repos add <slug> <owner/name> --area <project:PREFIX>…` | Registers one. Also `--name`, `--branch`, `--prompt <path>`. |
| `repos init <slug>` | Adds the files the board’s agents need to a registered repository: its agent prompt, the core and stub, the session hooks, a starter `AGENTS.md`, the `tasks` skill, and Taskwarrior files. Pushes them to an empty repository or opens a pull request. Never overwrites. `--dry-run` lists what it would add; `--update` refreshes the copied files. `--pipeline` adds the deploy flow too (`.github/breakaway-pipeline.json`, what it renders, and a minimal CI when the repository has no workflow), and `--package` the release flow for the npm package `package.json` names, unless it’s private. Both add only new files. |
| `repos setup <slug\|owner/name>` | The Add a repository wizard’s steps for it. Read only. |
| `repos modify <slug>` | `--area` adds an area, `--remove-area` drops one with no tasks, and `--agents-max`, `--agents-hourly`, `--prompt`, and `--pipeline <file.json\|none>` change its settings. |
| `repos remove <slug>`, `repos release <slug>` | Take one off the board; give a removed repository’s slug and prefixes back. |
| `routines add\|modify\|trigger\|revoke\|pause\|resume\|cap` | Manage routines. See [Routines](/docs/routines/). |

## Setup and secrets

| Command | What it does |
| --- | --- |
| `init-secrets` | Once, for a brand-new board: writes `tasks.env`. |
| `setup` | Connects this machine’s Taskwarrior: writes `taskrc` and runs the first `task sync`. |
| `github-connect <code>` | Stores the GitHub App’s keys. |
| `agents-connect [--repo <slug>]` | Stores an agent routine’s URL and token. |
| `rotate-sync`, `rotate-token` | New sync credentials, or a new API token. See [Operating a board](/docs/operations/#rotating-secrets). |

## The install repository

These need no board: they’re the files and steps that deploy a board from its own repository.

| Command | What it does |
| --- | --- |
| `install init [dir]` | Writes an install repository: its config, `breakaway.json`, the Deploy and Update workflows, and a README. Never overwrites. |
| `install resolve\|check\|config\|previous\|healthy\|update` | The steps those workflows run. `install config` makes the Worker’s wrangler config. |

## Hooks

`npx breakaway hook session` and `hook wait` are what a repository’s `.claude/settings.json` runs so a started agent’s output shows live on its task and owner messages reach it. You don’t run them by hand.
