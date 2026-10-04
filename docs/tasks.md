# The task board

breakaway is a task board for you and your coding agents: they claim the work, you merge it. This is its manual: how work is organised, the commands, setting up machines and cloud agents, GitHub, routines, the install, and what to do when something's wrong. An install is one board on its owner's Cloudflare account, and one board can run several repositories. The examples use breakaway's own board, which tracks this repository.

There are three ways in, all on the same data:

| Way in | For | How |
| --- | --- | --- |
| **The CLI** (`npx breakaway`) | Agents anywhere, including cloud sessions; anyone without Taskwarrior | The JSON API, with a token. The only place to claim work. |
| **Taskwarrior** (`task`, 3.x) | The owner and local agents who want filters, reports, and offline work | Syncs with the server's TaskChampion sync protocol. |
| **The web board** | The owner in a browser or on a phone; anyone reviewing the work | The board's address, signed in with the same token. A board, a list, a dependency graph, and an activity feed. |

## How work is organised

Every task is a Taskwarrior task with a few fields of the board's own (UDAs):

| Field | Meaning |
| --- | --- |
| `wid` | The stable work ID, like `BRK-12`: the area's prefix and a number. The server gives one to every open task that has a known area, however it was made. **New numbers are the highest in use for that prefix plus one**, never reused. |
| `project` | The area. Each repository has its own areas, each with a work-ID prefix: breakaway's are `board` (BRK), `web` (WEB), `docs` (DOC), `launch` (LCH), `brand` (ID), and `cli` (CLI). Two are shared by the whole board: `ideas` (IDEA, [ideas](#ideas)) and `routines` (RUN, [routines](#routines)). |
| `repo` | The repository the task belongs to ([Repositories](#repositories)). Empty means the default repository, the first one registered. Set when the task is made (`add --repo <slug>`); a task stays in its repository. |
| `horizon` | `now`, `next`, `later`, or `archive`. `archive` is where finished work goes when a horizon is closed; the board and `list` hide it unless you filter for it. |
| `priority` | `H` for the horizon's top priorities; `M` and `L` if useful. |
| tags | `+agent` (an agent or contributor can do it in the repository), `+owner` (needs the owner: an install, dashboards, accounts, sign-offs), `+decide` (needs an owner decision before work starts; see [Decisions](#decisions)). Tasks often carry two. Any other tag can name the [feature](#features) a task belongs to. |
| `depends` | What must be finished first. A task with open dependencies is **blocked**; Taskwarrior's `+BLOCKED`, `+BLOCKING`, and `+READY` follow from it. |
| `claim` | Who is working on it (an agent name like `claude-brk-12`, or `owner`). Set only through `claim`, which is atomic. Claiming also starts the task. |
| `spec` | Path to a spec in [`docs/specs/`](specs/README.md), when the task needs one. |
| `pr` | The pull request (number or URL) that delivers it. A pull request whose number is here closes the task, like `Closes <ID>` in its description. |
| `brief` | The description: the current brief, what the task is for and why. Edited in place; `brief_by` records who last edited it. The owner may edit any; an agent only on a task it made or is refining (`Mode: refine`); an idea's is never rewritten by the agent shaping it. |
| `done_when` | What has to be true to call it done: a sentence or short checklist, part of the brief with the same edit rules. Agents check their pull request against it. |
| `rel_<uuid>` | "See also" links to other tasks. They never block; only `depends` does. |
| annotations | Comments: an append-only thread of findings, progress, questions, and hand-overs, each with an author (`owner`, an agent name, `board`, or `routine:<slug>`). A comment never changes the description; a correction is a new comment. Descriptions, comments, and titles are small Markdown: `code`, **bold**, `[links](…)`, bare `https://` URLs, and `- ` lists. Write repository paths from the root (`docs/tasks.md#secrets`); the web board links them, and code spans that are paths (`src/worker.js`), to GitHub. |

### Repositories

One board can run the work of several repositories ([IDEA-14](specs/IDEA-14-multi-repo.md)). The board keeps a registry: each repository has a slug (`breakaway`), its GitHub `owner/name`, and its **areas, each with a work-ID prefix**.

**A fresh install starts with no repository** (`CLD-131`). It refuses tasks until one is registered ("no repository yet"), and every view shows a note pointing to Connections, where **Set up the board** lists the steps in order (register a repository, connect the GitHub App, install it on that repository, add the board's files, connect its agent routine, connect the CLI and Taskwarrior) and the first step has a form to register it. `npx breakaway repos add` does the same from a terminal. **The first repository registered is the default**: a task without `repo` is its, and it stays the default, since those tasks, its GitHub state, and its routine's two secrets are keyed to it. Tasks made in Taskwarrior before then get their work IDs when it's registered. `GET /api/repos` says `default` (null with none) and `firstRun`. An install from before repositories registered its repository by itself, from its `TASKS_GITHUB_REPO` var and the areas it already had.

- **A prefix belongs to one repository**, so a work ID means one task across the board and `show <ID>` needs no repository. Registering an area whose prefix another repository has, or that tasks elsewhere already use, is refused, and a prefix never changes once given. **Ideas (IDEA) and Routines (RUN) are shared** by the whole board: one number sequence, whichever repository an idea or run is in.
- A task's area must be one of its repository's (or ideas or routines); the server gives it that area's prefix, from the API or from `task add … repo:<slug>` in Taskwarrior.
- **Dependencies may cross repositories.** Work that spans two is two tasks, one in each, and a `depends` between them; a task never moves to another repository.
- `npx breakaway repos` lists them (`GET /api/repos`). Adding and changing is the owner's: `repos add <slug> <owner/name> --area board:BRK --area web:WEB`, `repos modify <slug> --area docs:DOC` (adds) or `--remove-area <project>` (only with no tasks in it), and `repos modify <slug> --pipeline pipeline.json` sets its [deploy pipeline](#deploy-pipelines) (`--pipeline none` clears it). A request signed with an agent's name is refused.
- Taskwarrior carries `repo` like any field: filter with `repo:breakaway`. Each repository has a report and a context: `task breakaway` lists breakaway's open work, and `task context breakaway` narrows everything to it until `task context none`. They're in this machine's `~/.config/breakaway/taskrc`, which `npx breakaway setup` writes and `repos add`, `init`, and `remove` refresh, so a new repository needs no commit here (`CLD-193`); a task without `repo` counts as the default repository's in its pair. A machine that never sets a context sees every repository.

**The CLI works in the checkout's repository** (`CLD-123`). It reads the trailing `owner/name` of `git remote get-url origin` (https, ssh, and a cloud session's proxied remote all end that way) and matches it against `GET /api/repos`; `--repo <slug>` or `BREAKAWAY_REPO=<slug>` picks another.

- `list` and `next` show only that repository's tasks; `--all` shows every repository's.
- `claim` refuses a task of another repository (a `409` that names the repository and the fix), even with `--force`, unless `--repo` names it, so an agent can't build another repository's task in this checkout. `--all` doesn't widen a claim.
- `add` puts the task in the checkout's repository; `--depends` may name any ID.
- `show` works for any ID, since IDs are unique.
- `claim` writes the repository into `.task-session` with the task, for the session hook.
- A checkout the board doesn't know, or a board without `/api/repos`, works exactly as before repositories.

**GitHub works per repository** (`CLD-124`). One GitHub App serves them all: install it on each registered repository.

- A webhook syncs the repository its delivery names (`repository.full_name`); one that isn't registered gets a `202` and is ignored. The 5-minute cron syncs every registered repository, each on its own, so one repository's failure or rate limit never stops another; each shows its own last sync and error on Connections.
- **A pull request closes only tasks of its own repository.** `Closes BRK-3.` in another repository's pull request is a mention, and the pull request page says the ID belongs to breakaway. A task's `pr` field is a pull request number in the task's own repository.
- `GET /api/github?repo=<slug>`, `GET /api/github/pulls/<n>?repo=<slug>`, and `POST /api/github/sync?repo=<slug>` read one repository; without `repo` they read the default one. Releases, Promote, Roll back, the deploy paths, and tasks made from new security alerts by themselves are still the default repository's (`CLD-125`); a routine's GitHub events come from its own repository ([Routines](#routines)).

**The web board follows a repository switcher** (`CLD-128`). With a second repository registered, the sidebar gets a switcher under the name (a list of repositories on the rail): one repository, or all of them. Board, list, dependencies, the activity stream, the inbox and the bell, Agents (and its Start the next few), and Routines follow it; it's remembered in the browser and in the URL as `?repo=<slug>`, and `s` steps through All and each repository. Every task, card, row, graph node, activity line, ping, and running agent shows a small chip with its repository, the task panel names it, and New task picks it (the one shown, else the default), with that repository's areas. Under All, counts say where they are ("2 in breakaway, 1 in widgets"). The Activity numbers, the slots and hourly budget, and Close now stay the whole board's, and the GitHub view is still the default repository's until `CLD-125`. While there's only one repository, none of this shows. `GET /api/pings` and `GET /api/activity` say each item's `repo`.

**Agents work per repository** (`CLD-126`). Each repository has its own Claude routine, since a cloud session starts in the repository its routine was saved with; the limits are shared. See [Agents in several repositories](#agents-in-several-repositories).

**Prompts and saved routines work per repository** (`CLD-127`). Each repository keeps the prompt its agents follow in its own checkout, reviewed like code, and the claude.ai routine holds only a stub that points to it; a saved routine runs in one repository. See [Agent prompts](#agent-prompts) and [Routines](#routines).

#### Per repository, and for the whole board

What a repository has of its own, and what the board shares across all of them:

| Per repository | For the whole board |
| --- | --- |
| Its slug, GitHub `owner/name`, name, and default branch (`repos add`, `repos modify`) | The board itself: one Worker, one Durable Object, one Taskwarrior sync, one sign-in |
| Its areas and their work-ID prefixes | Ideas (`IDEA`) and Routines (`RUN`), one number sequence each |
| Its tasks (`repo`); dependencies may cross | The inbox and pings, push, and the bearer token |
| The GitHub App's installation on it, its pull requests, runs, alerts, and sync | The GitHub App, its key, and its webhook |
| Its Claude routine (the two `ROUTINE_URL` and `ROUTINE_TOKEN` secrets for the default repository, `ROUTINES` for the others) | The agents at once and starts an hour, shared by every start |
| Its caps under those limits (`repos modify --agents-max`, `--agents-hourly`) | The cap on routine runs a day, and pausing all routines |
| Its agent prompt (`repos modify --prompt <path>`, default `tools/tasks/routine-prompt.md`) | The prompt's shared core, [`prompts/core.md`](../prompts/core.md) |
| Its saved routines and their GitHub events | Connections' Cloudflare rows: the Worker, its secrets, the cron |
| Releases, Promote, and Roll back, only with a deploy pipeline (`repos modify --pipeline <file.json>`), and Merge when green and Keep branches up to date (`CLD-125`) | |

#### Adding a repository

**Use the wizard**: **Add a repository** on the web board (`#/add-repo`; from Connections, the repository switcher, and a fresh install's setup list, `CLD-194`). It has one page per repository being added, so you can stop and carry on later, and it lists every step in order: create the repository on GitHub (private, empty), install the GitHub App and turn on Allow auto-merge, register it, `repos init`, fill in the agent prompt and `AGENTS.md`, make its routine on claude.ai, `agents-connect`, a first task claimed from the new checkout, and the first agent start, its live output, its pull request, and the merge. **Each step ticks itself** from what the board can see (a live check of the repository's installation, permissions, and auto-merge; its sync; its agent prompt on the default branch and any `<…>` left in it; its routine's URL on the board; the claim the CLI records from a checkout of the repository; its agent runs, live output, and the task's pull request), so it never asks you to confirm what it can check; the page asks again every 20 seconds while it's open. A step the board can't see ticks with the next one that proves it (creating with installing, the claude.ai routine with connecting). Each step says what to do, why, the command or link to copy, and what you should see; a step that's stuck shows Connections' own row and fix. Commands that need your own terminal say so, and none takes a secret on its command line. Registering on the page checks the slug and prefixes for clashes as you type (`POST /api/repos` with `dryRun: true` saves nothing) and is signed as the owner, like connecting and starting agents. A clash with a repository taken off the board that no task ever used shows a **Release** button, which gives its slug and prefixes back ([below](#taking-a-repository-off-the-board)). At the bottom, **Changed your mind?** gives `repos remove` and `repos release`, and what's left to delete on GitHub and claude.ai.

**With an agent as sidekick**: **Copy a prompt for a local agent** on the wizard copies [`prompts/add-repository.md`](../prompts/add-repository.md) with the repository's slug and `owner/name` filled in. Paste it into Claude Code in a checkout of the board's repository: it reads the same state, checks each step with the CLI and `gh`, does what an agent may (a dry run of init, cloning, filling in the prompt and `AGENTS.md` on a branch with a pull request in the new repository, adding tasks for anything confusing), and hands you the exact command for the parts that are yours (creating it, registering, `repos init`, `agents-connect`, starting agents, merging). It never runs those, and never asks for or handles the routine's token.

The wizard's state is `GET /api/repos/setup?slug=<slug>` (or `?github=<owner/name>` before it's registered; `&check=1` asks GitHub live, at most every 15 seconds, and keeps the answer for Connections too), and `npx breakaway repos setup <slug|owner/name>` prints it: each step done, to do now, or to do, with any fix. Both only read.

The same steps by hand, for reference: register, init, routine, connect (the owner; Connections shows each step, `CLD-129`):

1. **Register** it: `npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>…` (prefixes no other repository has; `--branch <name>` only to override the default branch, which the board otherwise reads from GitHub through the App (it falls back to `main` when the App can't see the repository yet, and **Connections** flags a registered branch that differs from GitHub's, with the `repos modify <slug> --branch` that fixes it; `--prompt <path>` when its agent prompt won't be at `tools/tasks/routine-prompt.md`, or set it later with `repos modify <slug> --prompt <path>`), and install the board's GitHub App on it.
2. **Init** it: `npx breakaway repos init <slug>` in a checkout of the board's repository, in your own terminal (`CLD-191`). It clones the repository next to the checkout (`../<slug>`, or `--dir <path>`, which may be a checkout you already have) and adds what the board's agents need: its agent prompt at the path the registry gives (from [`prompts/repository.md`](../prompts/repository.md), with its name, slug, `owner/name`, and areas filled in), the core and the stub (at `tools/tasks/prompts/` in that repository), no copy of the CLI (it's the `breakaway` package on npm, `BRK-7`), the release helpers (`BRK-45`: `scripts/record-deployment.mjs`, `promote-check.mjs`, `release-notes.mjs`, `check-migrations.mjs`, and `release-artifact.mjs`, with `scripts/lib/` and `src/promote.js`, which they import; described below), the session hooks in `.claude/settings.json`, which run `npx --yes breakaway@1 hook session` and `hook wait`, pinned to the major so a breaking release never reaches a repository by itself (`BRK-47`) (a repository an older init set up while breakaway was private runs a copy of them under `tools/tasks/cli/` instead (`BRK-64`); `repos init --update` switches it to npx and removes the copy, `BRK-69`), a starter `AGENTS.md`, the `tasks` skill, a `package.json` with `"type": "module"` when there's none, and Taskwarrior (`.envrc`, `.taskrc` in the repository's own context, `scripts/task`, the shared `taskrc` at `tools/tasks/taskrc`, and `.task/` in `.gitignore`). **Nothing it finds is overwritten**: it lists what it skipped, and `.gitignore` only gets the lines it lacks. On an empty repository it pushes them as the first commit on the default branch; otherwise it opens a pull request from `tasks-board-init` (with `gh`, or prints the link). Its new `.taskrc` makes plain `task` list the repository's own report, with the Work column. `--dry-run` lists what it would add. **It fills in every section of the agent prompt before it pushes** (`CLD-196`): in a terminal it asks for each one (Building, Checks, Pull requests, Direction, Dependency updates, Never share), and Enter takes a default that only points to `AGENTS.md` (Checks' is "there are no tests or build yet"); `--building`, `--checks`, `--pull-requests`, `--direction`, `--dependency-updates`, and `--never-share <text>` answer them from a script or for an agent, and `--defaults`, a dry run, or no terminal take the default for the rest. It lists the sections that took the default in its pull request and output, so you can sharpen them. Then say how to build in `AGENTS.md`.
3. **Routine**: make its routine on claude.ai, with the stub as its instructions ([Agents in several repositories](#agents-in-several-repositories)).
4. **Connect** it: `npx breakaway agents-connect --repo <slug>`. It asks for the routine's URL and token, so it needs a terminal: from Claude Code's `!` prefix or a pipe it stops with "this needs a terminal to ask in" instead of hanging.

**Keeping a repository's copy current** (`CLD-193`, `BRK-7`): the CLI runs from npm (`npx breakaway`), so only the files init copies (the core and stub, the `tasks` skill, `scripts/task`, the shared `taskrc`, the release helpers) fall behind the board's. A repository that carries an old copy of the CLI keeps working while the API stays compatible within a major, and says on each run how to switch: `npx breakaway repos init <slug> --update` deletes the copy (`scripts/tasks.mjs` and `scripts/tasks/`), points the session hooks at npx, and opens a pull request; a copy that `package.json` or `.claude/settings.json` still runs stays, with a note on how to switch. `--update` replaces only the files `tools/tasks/copied.json` says init wrote (or anything in `tools/tasks/`): a repository's own file at a path breakaway copies to, like its own `scripts/check-migrations.mjs`, is left alone (`BRK-79`). A repository set up before that record existed gets one on its next `--update`: the copies that match the board's, and the files its `AGENTS.md` lists under **Copied files**, as `repos init` wrote it. A release helper the repository keeps as its own doesn't bring in what breakaway's version imports. Their version is `CLI_VERSION` in [`src/cli-version.js`](../src/cli-version.js); the board reports the one it was built with (the `X-Tasks-Cli` header on every API answer, and `cli` in `health`), and a copy of the CLI says how to switch on each run. The fix is `npx breakaway repos init <slug> --update` from a checkout of the board's repository: it opens a pull request from `tasks-board-update` that replaces the copied files that differ and adds missing ones, and never touches the repository's own (its agent prompt, `AGENTS.md`, `.taskrc`, `.envrc`, `package.json`, `.claude/settings.json`). Here, a change to any of those files has to bump `CLI_VERSION`: `scripts/tasks/version.test.js` fails until it does, and prints the new fingerprint to put next to it. A copy from before `CLD-193` has no version and never warns; update it once by hand with `--update`.

**Release helpers** (`BRK-45`). A repository's Deploy, Promote, and Roll back workflows run these Node scripts, so every repository makes the same checks and records the same GitHub Deployments the board reads. Each takes its repository's names as options, and `repos init --update` keeps them current like the CLI (they count toward `CLI_VERSION`). They read `GITHUB_TOKEN` and, without `--repo`, `GITHUB_REPOSITORY`.

| Script | What it does |
| --- | --- |
| `record-deployment.mjs --environment <worker> --sha <commit> --state <state>` | Records a Deployment and its status (`--task deploy\|rollback\|try`, `--version`, `--migrations`, `--artifact`, `--deployment <id>` to add a status to the same one). |
| `promote-check.mjs --staging <worker> --production <worker> --sha <commit>` | The board's rules for whether a commit may be promoted ([`src/promote.js`](../src/promote.js)); exits 1 with the reason. `DEPLOYS_PAUSED=true` or `--paused` blocks it. |
| `release-notes.mjs --title <name> --from <sha> --to <sha>` | Markdown notes grouped by work-ID area: `--areas BRK:Board,WEB:Web`, or the repository's areas from the board's registry (`BREAKAWAY_URL`, `BREAKAWAY_TOKEN`). |
| `check-migrations.mjs --dir <path>` | Migrations in order with no gap or repeat; a destructive one needs `-- owner-approved: <who and why>` (with `--base <ref>`, only the new ones). |
| `release-artifact.mjs digest <dir>` | A sha256 over a manifest of every file under `<dir>` (`manifest <dir>` prints it): the same tree gives the same digest. |

**An empty repository** (no commits yet; GitHub answers `409 Git Repository is empty` until the first push) syncs as "no commits yet": Connections shows its sync, and its agent routine, as not connected (neutral, not Needs attention), with `repos init` as the fix, the GitHub view says the same, and the Agents view says its prompt is missing for that reason. It never fails a sync or puts the cron on Needs attention. Once it has commits, a routine that's still missing needs attention.

#### Deploy pipelines

A repository with a deploy pipeline gets Releases, Promote, Roll back, and the warnings that merging deploys. Without one, the GitHub view shows none of them and merging deploys nothing. Set it with `npx breakaway repos modify <slug> --pipeline pipeline.json` (the owner; a request signed with an agent's name is refused):

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "workflows": { "deploy": "deploy.yml", "promote": "promote.yml", "rollback": "rollback.yml" },
  "deployPaths": ".github/deploy-paths.json"
}
```

`workers` is required: the names of the staging and production Workers. `workflows` (the workflow files in the repository) and `deployPaths` (the JSON file that says which paths deploy) are optional. A pipeline the board couldn't use is refused with the reason instead of saved. `--pipeline none` clears it.

#### Taking a repository off the board

`npx breakaway repos remove <slug>` (the owner; `DELETE /api/repos/<slug>`). Its sync, webhooks, agent starts, and place on Connections and in the switcher stop, its saved routines are switched off, its agent routine leaves the `ROUTINES` secret and `~/.config/breakaway/tasks-routines.json`, and its report and context leave this machine's `~/.config/breakaway/taskrc`. It's refused while the repository has open tasks or running agents, unless `--force`. Its tasks stay: finished ones are readable with their chip, and **its slug and prefixes stay its own**, since a work ID means one task forever (`GET /api/repos` lists it under `removed`). Its GitHub repository can be registered again under a new slug. The default repository can't be removed.

**Registered one by mistake** (a typo, a wrong prefix, no `--prompt`)? Once it's removed, `npx breakaway repos release <slug>` (the owner; `POST /api/repos/<slug>/release`, `CLD-205`) forgets it and its leftover GitHub state, so the same slug and prefixes can be registered again. It's refused while any task, of any status, is in it or has one of its prefixes, or a saved routine still names it: then the slug and prefixes stay its own. When registering clashes with a removed repository that could be released, the dry run's `400` lists it as `releasable`, and the wizard's Release button does the same as the command.

Deleting the repository itself is on GitHub: `gh repo delete` needs the `delete_repo` scope first (`gh auth refresh -h github.com -s delete_repo`, once), or use its Settings, Danger zone; then delete its routine on claude.ai and the local clone.

**Ready for an agent** means: pending, `+agent`, not `+decide`, no open dependencies, not waiting for a date, and not claimed. That's what `next` hands out and what `task agent` lists.

Never put personal data about anyone (accounts, handles, names) or any secret in a task. The board is project work only.

## Working on a task

For agents this is the [`tasks` skill](../.agents/skills/tasks/SKILL.md). In short:

1. **Pick.** `npx breakaway next --claim --as <you>` takes the best ready task in one step, or `claim <ID>` if you were asked for a specific one. A `409` means someone else has it or it's blocked; pick another.
2. **Read.** `show <ID>`: the description, done when, comments, spec, what it waits for and what it holds up. Read `AGENTS.md` and the [decision log](decisions.md) if you haven't this session.
3. **Work** on a branch. Add comments as you learn things (`comment <ID> "…"`; `note` is the same), and add new tasks for work you find (`add`), with `--depends` where one waits for another.
4. **Hand over.** Open the pull request with `Closes <ID>.` in its description, then `modify <ID> --pr <number>` and a `comment` with the result. The board shows the task **In review** with the pull request's checks and reviews, and marks it done when the pull request merges ([GitHub](#github)). If you stop before a pull request, `release <ID>` with a note saying where you got to.

An owner part left after the agent part (for example "deploy, then check X") becomes its own `+owner` task, so the agent's task can be done.

## Commands

`npx breakaway help` lists everything.

```sh
npx breakaway                      # open tasks, best first
npx breakaway list --ready         # ready and unclaimed (also --blocked --active --mine --owner, --project, --tag, --horizon)
npx breakaway show BRK-12          # everything about one task
npx breakaway next --claim --as claude-brk-12
npx breakaway comment BRK-12 "The inbox sorts by age; the oldest ping is first."
npx breakaway done BRK-12 --pr 31 --note "The inbox sorts by age."
npx breakaway horizon close --dry-run   # what closing now would move; drop --dry-run to do it (owner only)
npx breakaway add "Check the inbox order after the deploy" --project board --tag owner --horizon now --depends BRK-12
npx breakaway modify BRK-13 --tag decide --depends BRK-12 --spec docs/specs/BRK-13-inbox-filters.md
npx breakaway release BRK-12 --as claude-brk-12
npx breakaway decision --template   # an example decision file; attach one with add/modify --decision <file.json>
npx breakaway ping BRK-12 --kind blocked "Needs the DNS record added in the dashboard." --proposal proposal.json   # ask the owner (ping --template prints a proposal)
npx breakaway activity --limit 10   # what changed lately, and who claimed what
npx breakaway github fix 12        # start an agent on pull request 12 (owner): --problem conflicts|failing|review, --note "…"
npx breakaway github review 12     # start an agent that reviews pull request 12 before you merge it, or Safe to merge? on a Dependabot one (owner)
npx breakaway github               # open pull requests with checks and reviews, failed runs, alerts (--sync to refresh)
npx breakaway agents               # cloud agents: running, waiting to start (agents start <ID>, agents next)
npx breakaway agents new "The inbox shows pings twice" --image shot.png   # start an agent from a prompt; it makes its own task (owner)
npx breakaway features             # features by release, their progress and chase, and tags that could be features
npx breakaway chase self-update --dry-run   # what a chase would start now; drop --dry-run to start it, `stop` to stop it (owner)
npx breakaway connections          # is GitHub, Cloudflare, Claude, sync, and push wired up, and the fix for each that isn't
npx breakaway health
npx breakaway export --out tasks-backup.json   # every task, checked against health's count (see Backups)
```

Add `--json` to any of them for machine-readable output. `--as` defaults to `$BREAKAWAY_AGENT`, then `user@host`.

With Taskwarrior (`scripts/task`, or plain `task` with direnv), all of Taskwarrior works. The board adds these reports:

```sh
task sync            # before reading and after changing: it's not automatic
task board           # open work, best first
task agent           # ready for an agent
task claimed         # in progress, oldest claim first
task owner           # needs the owner: owner work and open decisions
task breakaway       # breakaway's open work (one report per repository; see Repositories)
task context <slug>  # only that repository's work; a checkout set up by repos init starts in its own
task wid:BRK-12 info # one task
task +BLOCKED        # anything Taskwarrior can filter
```

Taskwarrior's numeric IDs belong to one replica; use the `wid` (or the UUID) when talking about a task anywhere else.

## Setting up

### This machine (the owner)

`~/.config/breakaway/tasks.env` (mode 0600) holds the token, the sync client ID and secret, and the derived key. `npx breakaway init-secrets` makes it, once per install, and it's **the only copy of the sync secret**: keep it in your password manager too.

```sh
npx breakaway setup     # writes ~/.config/breakaway/taskrc (credentials, and each repository's report and context) and runs the first `task sync`
```

Then either use `scripts/task …`, or install [direnv](https://direnv.net/) and run `direnv allow` once in the checkout, so plain `task` uses the board. Each checkout and worktree keeps its own replica in `.task/` (ignored by Git), so parallel agents never share one database file.

### Another machine or a contributor

Copy `tasks.env` to `~/.config/breakaway/tasks.env` on that machine (chmod 600), then `npx breakaway setup`. Without Taskwarrior, the CLI still works with just the token (`BREAKAWAY_TOKEN`).

### Another install

The CLI and Taskwarrior work against any install of the board without changing the code (`CLD-136`). These are the settings ([`scripts/tasks/settings.js`](../scripts/tasks/settings.js)):

| Setting | Name | What it is |
| --- | --- | --- |
| Token | `BREAKAWAY_TOKEN` | the board's API token, unless the cloud environment's API credential adds it |
| Board | `BREAKAWAY_URL` | the install's address |
| Agent | `BREAKAWAY_AGENT` | your name on claims |
| Repository | `BREAKAWAY_REPO` | the repository to work in, instead of the checkout's |
| Sync | `BREAKAWAY_CLIENT_ID`, `BREAKAWAY_SECRET`, `BREAKAWAY_SYNC_KEY` | Taskwarrior's credentials, for `setup` |
| Live output | `BREAKAWAY_SESSION_LOG=off` | turns the session hook off |

Each comes from the environment first, then from `tasks.env` in this machine's folder for the board: `$BREAKAWAY_HOME` when it's set, else `~/.config/breakaway`. The Taskwarrior credentials `setup` writes (`taskrc`) and the owner's routines copy live in the same folder.

**Which board.** `BREAKAWAY_URL` when it's set; otherwise the checkout's `.taskrc` (its `sync.server.url`, so the CLI and Taskwarrior always agree); otherwise the install's `breakaway.config.json` (`url`); otherwise none, and the CLI says which setting to add. The session hooks find it the same way, so a started agent's live output goes to the board it claimed on.

To connect a machine and a checkout to an install:

1. Put the install's values in `~/.config/breakaway/tasks.env` (chmod 600; the install's owner has them from `init-secrets`):

   ```sh
   BREAKAWAY_URL=https://tasks.example.org
   BREAKAWAY_TOKEN=…
   BREAKAWAY_CLIENT_ID=…
   BREAKAWAY_SECRET=…
   ```

   Already using another install on this machine? Don't use `~/.config/breakaway` for both: give the second install a folder of its own, and set `BREAKAWAY_HOME` to it in that checkout's `.envrc` (direnv).
2. Check the CLI reaches it: `npx breakaway health`.
3. Point Taskwarrior at the same board. Taskwarrior can't read the environment, so the checkout's `.taskrc` names both the server and the file with this machine's credentials:

   ```sh
   include tools/tasks/taskrc
   sync.server.url=https://tasks.example.org
   include ~/.config/breakaway/taskrc
   ```

   The first line includes the board's shared `taskrc`: at `tools/tasks/taskrc` in a repository `repos init` set up, and at the root in this one. `repos init` writes these lines for a new repository from the install and folder the CLI uses, so a repository set up from another install needs no edit.
4. `npx breakaway setup` writes `taskrc` in the machine's folder and runs the first `task sync`. It says which `.taskrc` line to change when the checkout points at another board or doesn't include that file.

In a cloud environment for an install, allow its host under **Allowed domains**, add its token as an API credential for that host (or `BREAKAWAY_TOKEN`), and set `BREAKAWAY_URL` when the checkout's `.taskrc` doesn't name it.

### Cloud agents

Claude Code on the web and other cloud sessions don't have Taskwarrior 3 (Ubuntu ships 2.6), so they use `npx breakaway`, which needs the environment's network access to allow `registry.npmjs.org`. In Claude Code, set it up once per cloud environment (`CLD-23`): at [claude.ai/code](https://claude.ai/code), open the environment selector (the cloud button above the message box), hover over the environment, and select its settings icon.

- **Best: an API credential** (Pro and Max plans; it's in the **Update cloud environment** dialog, below **Environment variables**, for an environment that already exists). Select **Add credential**: type **Bearer**, a name like `breakaway task board`, the board's host as the allowed website, and paste the token as the **Value** of the `Authorization` header (prefix `Bearer`). The proxy adds it to every request to the board after it leaves the session, so the token never enters the session. Leave `BREAKAWAY_TOKEN` unset; the CLI sends its requests without a token and the proxy fills it in. After `npx breakaway rotate-token`, delete the credential and add it again with the new token.
- **And network access**: set **Network access** to **Custom**, add the board's host under **Allowed domains** (and `api.githubcopilot.com`, for the GitHub MCP server), and tick **Also include default list of common package managers** so installs keep working. With the credential alone, every call from the board's agents comes back 403 (`CLD-37`).
- **Otherwise: an environment variable** plus the same network access. Under **Environment variables** add `BREAKAWAY_TOKEN=<token>` (values there are visible to anyone using the environment, and to the session itself).
- Either way, add `BREAKAWAY_AGENT=claude-cloud` under **Environment variables** (or pass `--as` each time).

**Setup script.** A cloud environment can run a setup script, and Claude Code caches its result, so slow steps happen when the snapshot is rebuilt (about weekly), not at every session start. Building Taskwarrior 3 from source there makes `pnpm interop` work in cloud sessions; it needs `github.com`, `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org`, and `sh.rustup.rs` under **Allowed domains**.

A cloud session reaches the internet through a proxy (`HTTPS_PROXY`), and that's where the credential is added. Node's `fetch` ignores `HTTPS_PROXY` by itself, so the CLI and the session hook turn it on ([`scripts/tasks/proxy.js`](../scripts/tasks/proxy.js)) and trust the system's certificates, which include the proxy's; other Node scripts that call the board need the same (`NODE_USE_ENV_PROXY=1` and `NODE_USE_SYSTEM_CA=1` do it from outside). If the CLI says "can't reach https://…" or "HTTP 403 from the session's proxy", the network settings don't allow the host; if it says "no token", neither the credential nor the variable is set. A cloud session follows the same `tasks` skill as a local one.

### The web board, and on a phone

Open the board's address and paste the token once (let your password manager keep it: the form has a username field with the install's name). The browser stays signed in for 180 days; rotating the token signs every browser out. On a phone, add it to your home screen (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen) and it opens like an app, with the views behind the menu button at the top left. Taskwarrior's own phone apps weren't checked for TaskChampion sync; the web board is the supported way.

- **The frame** (`CLD-156`): the views are in a sidebar on the left that collapses to a rail of icons (its **Collapse** button, or `[`; this browser remembers it, and it starts as icons on a window under 1280 px). Agents and GitHub carry counts there (agents working, with a dot while one is live; pull requests ready to merge), and the bottom of it says whether the board reaches its server and opens **Settings**. On a phone the same sidebar is a drawer behind the menu button. The top bar keeps search, **New agent** (when an agent routine is connected; [New agent](#new-agent-general-agents)), **New task**, and the bell.
- **Inbox**: the bell at the top right counts the open pings; it opens the latest five, each going to the inbox at that ping (`#/inbox?ping=<id>`), and **Open inbox** for the full view, where you apply, mark handled, or dismiss ([Pings and proposals](#pings-and-proposals)). `o` opens the inbox.
- **Board**: a column per state (needs a decision, ready, in progress, in review, blocked or waiting, done in the last 30 days) and a row per horizon or area. Cards show their pull request's number, checks, and review. The board never scrolls sideways: the columns shrink to the room the sidebar and an open task leave, cards get more compact in narrow columns, and where even that doesn't fit (a phone) you pick the column at the top.
- **Close now**: the button in the Now row confirms with the counts, then archives the finished tasks in now, makes next the new now, and makes later the new next ([spec](specs/IDEA-3-close-a-horizon.md)). Unfinished tasks in now stay in now. It's the owner's action; agents never close a horizon. `POST /api/horizons/close` (with `dryRun: true` to only count) does the same, and Activity logs it as one event.
- **List**: every task in a table you can sort by any column and group by state, area, or horizon.
- **Dependencies**: each chain of tasks that wait for each other, left to right. Hover or focus a task to follow its chain.
- **Activity** (`CLD-185`): how fast the work moves, over the last 7, 30, or 90 days next to the same stretch before it, then every change as it happens. Headline numbers with a line per day (tasks finished, pull requests merged, production deploys, agent runs, tasks added), a chart of every day (keyboard: arrow keys read a day), your pace (tasks a day, days in a row with a finished task, the busiest day), gauges for checks passing (all, and on `main`), deploys that landed, agents that started, agent builds whose task is done, and routines that ran, how long things take (added to done, pull request to merge, done to production) with a spread of lead times, what's open now (the now horizon done so far, ready, in progress, blocked, decisions, open pull requests, alerts), who finished the work (Claude agents, you, others, unclaimed: by the claim's name), tasks finished by area, a week-by-hour grid of when work lands, the deploys of the period on a timeline, and pass rates per workflow and routine. Days are counted in your browser's time zone. The stream sits beside the numbers on a wide screen and below them otherwise: every change, newest first, from the board and agents, from `task sync`, and from GitHub: who claimed what, comments, description changes, fields changed, pull requests opened and merged, checks failing and passing, alerts. The numbers come from `GET /api/stats?days=<1–365>&tz=<IANA zone>`. GitHub's tables keep only the latest pull requests, runs, and deploys, and agent runs go after 30 days, so the board copies the finished ones into a small log every 5 minutes (counts and times only, no titles or output) and keeps it 400 days.
- **GitHub**: open Dependabot alerts, open pull requests with their checks, reviews, and tasks, recently merged and closed ones, deploys (with the tasks each shipped, and the latest releases), CI runs (running and failing first), and commits on `main`. `h` opens it.
- **A task** opens beside the view, or in a modal with the description and thread on the left and the fields, dependencies, pull request, and agent run in a rail on the right (*Open in modal* / *Open in sidebar* on the task, or *Settings → Open tasks in*; the link carries `&view=modal`). On a phone it is full screen. Everything is editable in place: the title, area, horizon, priority, tags, dates, spec, pull request, and dependencies; add comments, claim or release, mark done, open again, or delete. Claims you make here use the name in Settings (`owner` by default).
- **The task menu** (`WEB-24`): right-click a task in the Board, List, or Dependencies view (a long press on a touch screen, or the Menu key or Shift+F10 on a focused task) to act on it where it is: open it, start an agent (or **Force start** one that waits on the board's limits), review its pull request with an agent, refine it, refine from a decided decision's answers, start by itself when ready, claim or release, add a comment, move it to another horizon, mark it done or open it again, and copy its work ID or link. It shows only what applies to that task. Shift with the right-click, and a right-click in a text field, still opens the browser's own menu.
- **Agents**: the Claude cloud agents the board started, what's waiting to start and why, Start the next few, and their settings ([Cloud agents from the board](#cloud-agents-from-the-board)). `x` opens it; the Agents item in the sidebar counts the agents working.
- Filters (area, horizon, who can move it, claimed, finished) and search live in the URL, so every view and every task has a link. Keyboard: `/` search, `n` new task, `p` new agent, `b` `l` `g` `o` `a` `h` `x` `u` switch views, `[` collapse or expand the sidebar, `s` switch repository (with several), `j` `k` next and previous task, `c` claim or release, `d` done, `Esc` close, `?` all shortcuts.

## Pings and proposals

An agent that can't finish a task because only the owner can help, or whose task turns out to be done or not reproducible, **pings** the owner instead of leaving a comment nobody sees ([spec](specs/IDEA-12-agent-pings.md)). `ping <ID> --kind <kind> "<message>"` (you must hold the task) writes a `Ping (<kind>): …` comment and an entry in the owner's inbox. Kinds: `blocked`, `question`, `stale`, `done` (each sends a push) and `fyi` (inbox only). The message is up to 500 characters and is refused if it looks like a token. Caps: 3 pings per task and 10 per agent a day, and a repeat of the same kind and message on a task is dropped. A ping stays open until the owner resolves it or the task is finished.

An optional **proposal** (`--proposal <file.json>`, `ping --template` prints one) is up to 10 changes and 20 KB the owner can apply in one press: `add` tasks (with local `ref`s), `depend` (add or remove dependencies), `modify` (horizon, tags, brief, done when), `done` (with a note), and `release`. The server checks it when it's proposed, refusing cycles, dependencies another path already implies, `autostart`, changes to `horizon-*` tags, and finishing a task in review. Agents propose; only the owner applies, dismisses, or marks a ping handled, with the cookie, so the API token can't. The routes are `POST /api/pings/<id>/apply` (body `{ chosen?: [change numbers], edits?: { <number>: { fields of an add } } }`), `/dismiss`, and `/handled` (only for a ping with no proposal); each answers 403 to the bearer token. Apply checks every chosen change again against the board as it is then and, if any no longer holds, changes nothing and answers 409 with the reason; otherwise it is one version, with a `board` comment on the ping's task ("Applied: added BRK-21; BRK-14 now waits for BRK-21"). Dismissed and handled pings show in Activity.

The push goes to the installed board app (Web Push). It is **off until the owner turns on Notifications in the board's Settings**, per browser, and it needs the VAPID key pair ([Secrets](#secrets)); until then pings show in the inbox only. Agents learn when to ping from "Pinging the owner" in the prompt's core ([`prompts/core.md`](../prompts/core.md)).

## Ideas

When you'd rather write down an idea than fill in a task, use **New idea** (`i` on the board, or the Idea tab in the New task dialog; `npx breakaway idea "…"` on the command line). It takes your words as they are and makes a task in the Ideas area (`IDEA-12`) with them as its description ([spec](specs/CLD-47-idea-intake.md)).

- **You choose whether an agent starts on it by itself.** The toggle *Start its agent as soon as there's room* sets the idea's `autostart` when you save it (on by default in the web form, `--auto` on the command line). Off, the idea waits until you start its agent from the task or the Agents view. Agents never change this setting, for the idea or for any task they make.
- **It belongs to a repository**, the one its agent shapes it in: the repository in scope, and with every repository in scope the form asks which one (`--repo <slug>` on the command line; default the checkout's). Its work ID stays `IDEA-n`, one sequence for the board.
- **You choose the horizon too:** Now, Next, Later, or Auto. The choice is kept on the idea as a tag (`horizon-now`, …) and every task the agent makes gets exactly that horizon; with Auto, the agent picks one for each task from what's already on the board. The idea itself always sits in Now so an agent gets to it first.
- **The agent shapes it, it doesn't build it.** It checks the idea against the repository's settled decisions, looks at the board for overlaps and blockers, writes a spec in `docs/specs/IDEA-12-<slug>.md`, and adds the real tasks with area, horizon, tags, dependencies, description, and done when filled in. Every one of them waits for the idea's own ID, so nothing is built before you've read the spec.
- **One pull request, yours to merge.** It holds the spec and closes the idea. Merging it releases the tasks; a task that needs a decision from you is tagged `+decide` and carries its questions, which you answer on the board ([Decisions](#decisions)). Ask for changes on the pull request and the agent carries on.

The agent follows the "Shaping an idea" part of the prompt's core ([`prompts/core.md`](../prompts/core.md)).

## Features

A feature is a piece of the roadmap with a name, a release it's aimed at, and its progress ([spec](specs/IDEA-28-features-and-chase.md), `BRK-83`, `WEB-9`). It's a small record of its own (`slug`, `title`, a short Markdown `brief`, `release`, and `state`, `open` or `shipped`), and **a task joins it by carrying its slug as a tag** (`modify BRK-50 --tag self-update`). Tasks gain no field, so Taskwarrior and sync carry membership as they are.

- **One feature per task.** A task with two feature tags shows a warning and counts toward the first, alphabetically.
- **The release is the feature's.** A feature's `release` (like `1.3.0`, or none for unplanned) is where its tasks are aimed, so new tasks don't need a release tag. Release tags already on tasks (`v1_2-0`) still count: a task with one and no feature groups under that release.
- **Progress is computed**, never typed: done over all, with the counts that explain the rest (running, ready, waiting, needs you, in review). Each task's place says why in words ("it waits for BRK-50", "its pull request is open: merging is yours").
- **Suggested features.** A tag on open tasks that isn't a feature yet is suggested, with **Make it a feature**, aimed at the release its tasks' release tags share. Nothing is made until someone presses. The board's own tags (`agent`, `owner`, `decide`, `idea`, `general`, `routine`, `security`, `horizon-*`) and release tags are never suggested and can't be features.
- **Who changes what.** Anyone signed in reads features, and an agent shaping an idea adds one for its tasks (without a release). Aiming one at a release, changing it, deleting it, and chasing it are the owner's: a request signed with an agent's name is refused.

**The Roadmap** (`#/roadmap`, `m`) shows releases in version order, then Unplanned, each with its feature cards: the title, a progress bar with the counts, the next blocker in words, and a chip while a chase is on. Open a feature for its brief and its tasks in dependency order with each one's state. **New feature** makes one; a fresh install shows "No features yet." with the suggested tags.

From a terminal: `npx breakaway features` (by release, with suggestions), `features show <slug>`, `features add <slug> [--title …] [--brief … | --brief-file <path>] [--release <x.y.z>]`, and `features modify <slug> --title|--brief|--brief-file|--release <x.y.z|none>|--state open|shipped` (the owner's). The API is `GET/POST /api/features` and `GET/PATCH/DELETE /api/features/<slug>`.

## Images on tasks

Images are kept in the board's Durable Object (an `attachments` table), never public ([spec](specs/IDEA-8-images-on-ideas.md), `CLD-92`). PNG, JPEG, WebP, and GIF only, found by their first bytes (not the file name or the sender's `Content-Type`; SVG is refused), up to 1 MB each and 4 per task. Deleting a task deletes its images. All of it needs the board's auth.

- `POST /api/tasks/<ID>/attachments`: the raw image as the body, with `X-Attachment-Name` and an optional `X-Attachment-Alt` (caption, up to 300 characters), both URL-encoded. `201` with the image, or `400` saying which image and why.
- `GET /api/tasks/<ID>/attachments`: the list (`id`, `name`, `type`, `size`, `alt`, `added`) and the limits.
- `GET /api/attachments/<id>`: the bytes, with the stored type, `nosniff`, and a sandboxing `Content-Security-Policy`. `DELETE` removes it.

The bearer token can't tell the owner from an agent, so "only the owner attaches" is held by the board and CLI never offering it to agents (`CLD-93`, `CLD-94`).

**On the board** (`CLD-93`): the New idea form and every task's sidebar take images by the **Add image** button, drag and drop, or paste. Screenshots over 1 MB or 1600 px are shrunk in the browser first; if one is still too big, a message names it and says to crop. Thumbnails show each caption as alt text with a remove button (it asks first). A thumbnail opens the viewer: a contained panel on a darkened backdrop with the file name (and "2 of 3") above the image and the caption under it. The cross, Escape, or a click outside closes it and focus goes back to the thumbnail; with several images, the arrow buttons and the left and right keys move between them.

**On the command line:**

- `npx breakaway idea "…" --image shot.png` (repeatable) saves the idea with its images.
- `npx breakaway attach <ID> <file> [--alt "caption"]` adds one to any task.
- `npx breakaway attachments <ID> [--save <dir>]` lists them; `--save` downloads them so an agent can look at each with `Read`.

When a task has images, the routine payload gets an `Attachments: <n>` line (the count only; the images stay on the board). "Shaping an idea", "Refining a task", and "Running a general agent" in the prompt's core ([`prompts/core.md`](../prompts/core.md)) tell the agent to fetch and read them first. **New agent** takes images the same way as New idea.

## GitHub

The board reads each registered repository through a private GitHub App named after the install ([spec](specs/CLD-24-github.md)). It reads, and writes in exactly five cases, all for the owner: Publish, Update branch, Merge, and Merge when green, either pressed on the pull request page ([below](#update-branch-merge-and-merge-when-green)) or sent by the two pull request settings the owner can turn on in their browser ([below](#pull-request-settings)). The fifth is [Promote and Roll back](#promote-and-roll-back), which start two workflows. Nothing else writes to GitHub.

**How pull requests link to tasks.** A pull request **closes** a task when a sentence or line of its title or description *starts* with a closing word directly followed by the work IDs: `Closes BRK-12.`, `- Fixes BRK-5, BRK-12 and WEB-1`, `Resolves: DOC-6` (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved; backticks around the ID are fine). It also closes a task whose `pr` field is the pull request's number, so only a closing pull request goes in that field (the board refuses one while a refining agent holds the task). Everything else is only a **mention**: IDs in prose ("its first sync finished BRK-8"), in code blocks or quotes, and in the branch name. A pending task with an open closing pull request is **In review**; when the pull request merges, the task is done with the note "Merged in #31: …"; when it's closed without merging, it gets a note and leaves review. So write `Part of <ID>.` in a spec or planning pull request. The first sync after connecting only records history.

**How it stays current.** Webhooks for pull requests, reviews, checks, workflow runs, statuses, pushes, Dependabot alerts, deployments, and releases schedule a sync 5 seconds later (a burst becomes one), and a cron syncs every 5 minutes in case one went missing. **Sync now** in the GitHub view, or `npx breakaway github --sync`, does it at once.

**Pull request page (`CLD-55`, [spec](specs/IDEA-2-review-and-merge-on-the-board.md)).** Select a pull request in the GitHub view (`#/github?pr=<number>`) to read it without leaving the board: a verdict, its checks (each linking to the run and its log), reviews, the conversation, and the diff, file by file (unified, or split on a wide screen; a filter for files that run in a Worker). The verdict comes from GitHub's `mergeable_state`, read on every sync and again when the page opens: **Ready to merge**, **Has conflicts**, **Checks failing**, **Behind main**, **Checks running**, **Waiting on review**, or **Draft**. The open list sorts by it (ready first, then conflicts and failures, then behind, then running), and the GitHub nav item counts what's ready to merge. The page is read live through the installation token, and diffs are never stored. The write buttons are [below](#update-branch-merge-and-merge-when-green). Review threads show as conversations without their resolved state (that needs GraphQL); GitHub lists at most 300 files.

### Update branch, Merge, and Merge when green

`CLD-57`, [spec](specs/IDEA-2-review-and-merge-on-the-board.md). On an open draft the page shows **Publish…** (`CLD-143`): it asks first, then marks the pull request ready for review through GitHub's GraphQL API (the REST API has no endpoint for it), and says when Merge when green is on that it will merge as soon as its checks pass. On an open, non-draft pull request the page shows **Update branch** when it's behind `main`, **Merge…** when it's ready, and **Merge when green…** while it isn't (**Turn off** once set). Update branch asks first, then merges `main` into the branch (a merge commit, never a rebase or force-push). Merge and Merge when green open a dialog with the method (squash or merge commit, the two the repository allows; it remembers the last one in this browser), the tasks it finishes, and whether merging deploys a Worker. The head commit the page showed goes to GitHub with the request, so a push in between refuses the merge instead of merging code you haven't seen. Merge when green turns on GitHub's auto-merge, which needs **Allow auto-merge** in the repository's settings.

- **Cookie only.** `POST /api/github/pulls/<n>/publish`, `…/update-branch`, `…/merge`, and `…/auto-merge` accept only the signed-in web board, from this origin. The bearer token that agents, the CLI, and cloud sessions hold gets a 403, so none of them can merge, whatever they try. The owner merges every pull request; the owner can also do that through a [setting](#pull-request-settings).
- **The repository's rules stay in charge.** The board refuses to merge drafts (and to publish anything that isn't one), closed pull requests, and ones that are behind, blocked, or conflicting, and if GitHub refuses anyway (a required check, a ruleset) it shows GitHub's own message and changes nothing. Conflicts go to an agent.
- **Activity.** Each button press is an event (`You published #… for review`, `You merged #…`, `You updated #… with main`, merge when green on or off), and the merge finishes its tasks through the usual sync. What the [settings](#pull-request-settings) do says so (`Keep branches up to date updated #… with main`, `Merge when green (your setting) merged #…`).
- **Permissions.** The App needs read and write on **Pull requests** and **Contents** (everything else stays read-only). An App made from the board's manifest has them. One made before `CLD-57` has read only, so the buttons answer "The board's GitHub App can't write yet" until you change it: GitHub → Settings → Developer settings → GitHub Apps → your board's App → Permissions & events, set **Pull requests** and **Contents** to read and write, save, then accept the request on the installation (`CLD-56`). Merge when green also needs auto-merge allowed in the repository's settings.

### Promote and Roll back

`CLD-105`, [spec](specs/IDEA-10-promote-releases.md). For a repository with a deploy pipeline (its `pipeline` in the registry), the top of the GitHub view shows **Releases**: a card for staging and one for production, joined by a line saying what a promote would do ("Staging is 3 merges ahead: 4 tasks, 1 migration"; a destructive migration or a changed Worker config shows there too, before anyone presses). Each card shows the commit, version, when it went live, CI and the deploy's own check, and the tasks it carries; its state is *live*, *deploying* (with the step: checking, migrating, deploying), *failed*, *rolled back*, or *nothing deployed yet*.

- **Promote to production…** (staging's card) asks first, listing the tasks and migrations, and dispatches the repository's `promote.yml` on `main` with the candidate's commit, the latest successful staging deploy. A destructive migration needs a tick in the dialog. **Roll back…** (production's card) asks for the version to go back to (the one before is preselected) and what broke, and dispatches `rollback.yml`. A button that can't work is disabled with the reason next to it.
- **Only the signed-in browser** can press them: the endpoints refuse the bearer token that agents and the CLI hold, and cross-origin requests. The workflows check everything again (latest build, staging not deploying, `DEPLOYS_PAUSED`, the artifact), so a forged request can at worst fail. Each press is an Activity event.
- **Permissions.** Starting a workflow needs read and write on **Actions**. An App made before `CLD-105` has read only, so the buttons answer "The board's GitHub App can't start workflows yet" until you change it (as above: Permissions & events, **Actions** to read and write, then accept the request on the installation; `CLD-104`). Until then, run the same workflows from GitHub: Actions, Promote or Roll back, Run workflow.

### Pull request settings

`CLD-98`. The board's Settings (the gear at the bottom of the sidebar) has two switches under **Pull requests**, both off until the owner turns them on. They send the same cookie-only requests as the buttons above, so the repository's rules, the head-commit check, and the refusals all still apply; they're a standing "press it for me".

- **Keep branches up to date.** When `main` moves on, the board updates the branch of every open pull request that's behind (a merge commit from `main`, as Update branch does), and its checks run again. It skips drafts and pull requests with conflicts (those are an agent's, through Fix with an agent).
- **Merge when green.** Every open pull request that isn't a draft merges once its required checks pass, Dependabot's included: the board turns on GitHub's auto-merge for each one that's still running or waiting, and merges one that's already ready. It uses the merge method last chosen in the merge dialog (squash unless you picked merge commit). In a repository with a pipeline, merging to `main` deploys to staging (production waits for Promote), so turning it on asks first and says how many pull requests are ready to merge straight away. **Turn off** on a pull request's page keeps the setting away from that one (remembered in this browser); setting Merge when green on it again by hand hands it back.

How they work:

- **Owner only, this browser only.** They're kept in the browser's local storage (`tasks.keepUpdated`, `tasks.mergeWhenGreen`), not on the server, so they're on only where the owner turned them on, and only while the board is open there (a hidden tab keeps checking, though the browser may slow it to about once a minute). Agents, the CLI, and cloud sessions can't turn them on or send what they send: the endpoints refuse a bearer token.
- **One tab acts.** With several board tabs open, the one holding a Web Lock (`breakaway-pull-settings`) acts, and the next takes over when it closes. Each action is tried once per pull request and head commit, so a refusal isn't repeated until something is pushed or the setting is turned on again. GitHub's refusals show as a toast with its reason; the board's own "that sync was out of date" refusals (pushed, merged, or no longer ready since) stay quiet, and the next sync decides again.
- **What they act on** is the board's last sync (webhooks, a 5-minute cron, and the 30-second poll), and GitHub's live state decides: the server reads the pull request again before every write. Merge when green is set before an update, because the update is a new head commit. The sync keeps whether each open pull request already has auto-merge on (`autoMerge`), so nothing is sent twice.
- **Activity** records each one as done by the setting (the event has `setting: true`), and the GitHub view says which settings are on in this browser.

**Deploys and shipped tasks (`CLD-32`).** A repository's Deploy (staging), Promote (production), and Roll back workflows record each deploy as a GitHub Deployment (environment = Worker, `ref` = commit, statuses `in_progress` then `success` or `failure`, and a description like `version <id> · migrations <names>`). The board reads them, lists them in the GitHub view (and `github` on the command line), and adds a deployed, rolled back, or deploy failed event to Activity. When a deploy succeeds, the board compares its commit with the previous successful deploy of the same Worker, finds the merged pull requests in between, and marks the tasks they closed **shipped in that environment** (`CLD-106`): staging and production are compared separately, and branch deploys (`try`) and rollbacks never mark anything. A task shows **On staging** `<version>` once staging runs it and **Live** `<version>` once production does (notes: "On staging in `<version>`", "Live in `<version>`"), and its detail, `show`, and `github` list the exact commits (the merge and the deployed one), the Actions run, the version, the time, and, for production, the release tag. A task that's done but staging doesn't run yet shows "Merged", and the **Finished** filter has **Not on staging** and **On staging, not live** (what a promote would carry). A merged pull request that changes only docs, skills, or CI runs nothing in a Worker, so no deploy will ever carry it: the board reads each merged pull request's files once and shows "No deploy needed" instead (`CLD-45`). What counts as running in a Worker is the pipeline's deploy paths, which the Deploy workflow reads too, so the two can't disagree. Releases and tags show under Deploys; the board doesn't make them: the Promote workflow publishes a release after each production promote, and staging builds get none.

**Connecting it (the owner, once, `CLD-25`).**

1. Open the board's **GitHub** view and select **Create the App on GitHub**. GitHub shows the App and its permissions (metadata, contents, pull requests, checks, actions, commit statuses, deployments, Dependabot alerts); create it. GitHub sends you back to the board.
2. The view shows `npx breakaway github-connect <code>`. Run it in a checkout of the board's repository, with `wrangler` logged in, within the hour. It trades the code for the App's ID, private key, and webhook secret and stores them as the board's secrets ([Secrets](#secrets)); they never pass through the board or a command line.
3. Open the install link it prints, choose **Only select repositories**, pick the repository, and install. The board fills in within seconds.

**Deploys need one more permission.** An App made before `CLD-32` can't read Deployments, so the board shows none until you accept the new permission: on GitHub, Settings → Developer settings → GitHub Apps → your board's App → Permissions & events, set **Deployments** to read-only and subscribe to **Deployment**, **Deployment status**, and **Release**, save, then accept the request on the installation (the App's install page shows it). Without it the board carries on and just has no deploys. An App made from the board's manifest already has them.

Because the App can merge, a leaked key matters more: if it leaks, generate a new private key in the App's settings on GitHub, and store it as the board's `GITHUB_KEY` secret as one line of base64 PKCS#8 (`node -e "console.log(require('crypto').createPrivateKey(require('fs').readFileSync('key.pem')).export({type:'pkcs8',format:'der'}).toString('base64'))"`, piped into `wrangler secrets-store secret update … --remote`, or `wrangler secret put` on an install without a Secrets Store), then delete the old key on GitHub. To disconnect, uninstall the App on GitHub.

## Decisions

A decision is how someone asks you for a choice ([spec](specs/IDEA-6-decisions-with-questions.md)). A task can carry an ordered list of questions of seven types: `open` (free text), `yesno`, `choice` (pick one), `multi` (pick any, with optional `min` and `max`), `rank` (put in order), `scale` (a whole number between two labelled ends), and `date`. Each has a stable `id`, a prompt, optional help, and, for choices, options that say what picking them means. Every answer can take a short comment. A task with questions gets `+decide`.

- **Asking (agents and you).** `npx breakaway decision --template` prints an example file; attach it with `add … --decision <file.json>` or `modify <ID> --decision <file.json>` (answers to questions that still exist are kept). `show` prints the questions and, once answered, the answers. Up to 20 questions and 20 KB; no personal data and no secrets. Work that waits for the answer depends on the task.
- **Answering (you only).** In the task's view on the board the questions are a form; Send answers turns on when every required question has an answer, and a draft stays in your browser. Sending is one step: it stores the answers, removes `+decide`, marks the task done, and adds a comment that summarises them, so whatever waited for it is released. The route uses your identity, so an agent's name is refused, and the CLI has no command to answer. The API is `POST /api/tasks/<ID>/decision/answers`.
- **Reopening.** Reopen a submitted decision on the board (`DELETE /api/tasks/<ID>/decision/answers`) to change an answer: the task is pending with `+decide` again, the answers stay editable, and Activity logs it.
- **Refine from the answers.** Once a decision is answered, the work waiting for it usually has to change to match. **Refine from the answers** under the answers (or in the task menu; `npx breakaway agents new --decision <ID> ["<note>"]`) starts a [general agent](#new-agent-general-agents) for that, when the decision's repository has its agent routine connected. The board writes its prompt: the questions and answers with your notes on them, the open tasks that wait for the decision and their feature tags, the specs they link, and what to do. The dialog shows that prompt with an optional note for the agent under it, Force start, and **Start agent**. The agent changes the waiting tasks and their dependencies to match, updates the spec in one pull request you merge, adds the tasks the answers need, and asks a new decision for anything they leave open; it never changes your answers. Its task is related to the decision, and while it's open the button opens it instead of starting another.
- **Tasks without questions.** A `+decide` task from before decisions has **Decide…** on the board: one note that becomes your comment, removes `+decide`, and finishes the task.

Storage is two plain properties (`decision` and `decision_answers`, declared in [`taskrc`](../taskrc)), so Taskwarrior and `task sync` carry them like any other field. Settled decisions that every change must respect go in the [decision log](decisions.md).

## Cloud agents from the board

The board starts Claude Code cloud sessions on tasks, and shows what each one is doing ([spec](specs/CLD-35-cloud-agents.md)). Each session is a normal cloud agent: it follows the [`tasks` skill](../.agents/skills/tasks/SKILL.md) and its repository's [agent prompt](#agent-prompts) (breakaway's is [`prompts/breakaway.md`](../prompts/breakaway.md)), opens a pull request that closes its task, and keeps watching it until it merges.

**Ways to start one.**

- **On a task:** Start an agent (with an optional note for the agent), in the task's Agent section. It sits right below the task's actions, above the description (in the modal it's the left column), and holds Refine with an agent too, so it shows on every open task.
- **The next few:** in the Agents view, Start the next N. It shows which tasks it would pick, and why not the others, before anything starts. At most one task per area, none in an area where an agent already works, horizon `now` first, then by priority.
- **By itself when ready:** tick Start by itself when ready on a task (the `autostart` field; `modify <ID> --autostart yes`). It starts its own agent the moment nothing blocks it, for example right after the pull request it waits for merges. It checks after every change that can unblock a task, and every 5 minutes. Until then it waits in the Agents view with the reason.
- **For a Dependabot pull request:** **Safe to merge?** on a Dependabot pull request in the GitHub view (on its page) makes a task from it if it has none (in the repository's Tech debt area, `+agent`, its `pr` field set, so merging finishes it) and starts an agent in review mode ([prompt](../prompts/core.md)). The agent tests the update with the repository's own checks, reads the release notes, and answers with a verdict and the test output as a comment on the task and a comment on the pull request. The agent claims the task as `claude-<id>-check` (taking over a quiet agent's claim, as below). You still press Merge; the agent never merges. The API is `POST /api/github/pulls/<number>/review`, and `npx breakaway github review <number> [--note …]` does the same from a terminal; it says which task and agent took it, or who already has it. Like `agents start`, it starts an agent, so it's the owner's.
- **From a prompt:** **New agent** in the top bar, or `agents new "…"`: the agent makes its own task ([below](#new-agent-general-agents)).
- **To review a pull request:** **Review with an agent** on a pull request's page ([below](#review-with-an-agent)).
- **For a whole feature:** **Chase** on a [feature](#features), or `chase <slug>`: it starts an agent on every ready task in the feature and on what blocks it, until they're all done or in review ([below](#chase)).
- **For a security alert:** Fix with an agent on a Dependabot alert in the GitHub view makes a task from the alert (Tech debt, `+agent +security`, priority from the severity, the advisory and fixed version in its description, the alert in its `alert` field) and starts an agent on it. In the Agents settings, New security alerts can make that happen by itself for every new alert at or above a severity; it's off unless you choose one. A security task doesn't wait for its area to be free.

Every start claims the task for `claude-<id>` first, in one step, so nothing ever starts two agents on one task; if Claude won't start the session, the claim is released. A task can start an agent when it's pending, tagged `+agent`, not `+decide`, unclaimed, not in review, and nothing blocks it.

**Refining a task.** To make a task better without building it, refine it with an agent: `agents refine <ID> --note "…"` on the command line, or `POST /api/agents/start` with `mode: "refine"` ([spec](specs/IDEA-1-refine-with-an-agent.md)). The note is required: it says what the agent should look at or change. Only you start one; there's no auto-start for refining. The agent claims the task as `claude-refine-<id>` (so nobody builds it meanwhile), then improves it on the board: it rewrites the description and done when, fixes area, horizon, tags, and dependencies, splits it into filled-in tasks, or asks a question only you can answer with a [decision](#decisions). It never builds the task, never sets `--autostart`, and never changes your `horizon-*` tag. If it writes or edits a spec, that's a pull request that says `Part of <ID>.` for you to merge; it stays out of the task's `pr` field, so merging it leaves the task open. It ends with a comment on the task and releases the claim. It counts against the same limits. The agent follows "Refining a task" in the prompt's core ([`prompts/core.md`](../prompts/core.md)).

**Fixing a pull request.** On a pull request's page in the GitHub view, an open, non-draft pull request that has a merge conflict, failing checks, or review comments (an [agent's review](#review-with-an-agent) that needs changes counts) shows **Fix with an agent** (or **Address review comments**). It starts an agent on the pull request's own task (the one it closes, even though that task is in review) or, when it has none, on a task the board makes from it (Tech debt, `+agent`, with the pull request in its `pr` field). `POST /api/github/pulls/<number>/fix` does the same, with an optional `problem` (`conflicts`, `failing`, `review`) and `note`; `npx breakaway github fix <number> [--problem …] [--note …]` is the same from a terminal, and says which task and agent took it, or who already has it (it starts an agent, so it's the owner's). The payload has `Mode: fix-pr`, `Pull request: #<n>`, and `What is wrong:`; the agent claims the task as `claude-<id>-fix`, merges `main` in or fixes the checks or answers the review threads on the pull request's own branch, never rewrites history, and never merges. It ends with a push or a comment on the task. It counts against the same limits, and a start on a pull request whose task is claimed takes the claim over when the claimant is an agent that has been quiet for two minutes (the build agent that opened the pull request keeps its claim while it watches it); it says who is working on it when they are still producing output, and never takes a claim from a person. The takeover is noted on the task. The agent follows "Fixing a pull request" in the prompt's core ([`prompts/core.md`](../prompts/core.md)).

**Limits.** At most 3 agents working at once on Pro (up to 6, in the Agents settings). An agent counts while its task is claimed by it and has no open pull request, for up to 12 hours; once its pull request is open, the task is In review and the slot is free. At most 20 starts an hour by default on Pro, which you can change from 1 to 30 in the Agents settings (Claude allows 30 for each routine). Every start uses your Claude subscription, and routines have a daily run cap.

**Force start** (`BRK-105`, [spec](specs/IDEA-30-new-agent.md#4-force-start)). When only the board's own limits stop a start, the start says which one and offers **Force start**, which starts the agent now anyway. It's on every start: Start an agent, Refine with an agent, Fix with an agent, Safe to merge?, Review with an agent, a routine's Run now, the Agents view's queue, the task menu, and the New agent and Refine from the answers dialogs (a checkbox there). On the command line it's `--force` on `agents start`, `agents refine`, `agents new`, `github fix`, `github review`, and `routines run`, and `force: true` on every route that starts an agent.

- **It skips** the agents at once, the starts an hour, a repository's own caps, a routine's daily caps, one agent per area, and the auto-start switch.
- **It never skips** Claude's limits (30 starts an hour for each routine, 100 for the account), which the board doesn't manage: over them the start is refused with `429` and when to try again. Nor what makes a start wrong rather than early: a task that's blocked, claimed, done, or tagged `+decide`, a routine that isn't connected, or a prompt with a `<…>` left in it. Then the reason shows and Force start doesn't.
- **Only you** force a start (a request signed with an agent's name is refused); agents never ask for one, and nothing forces a start by itself.
- **It still counts.** A forced agent takes a slot and a start like any other. The run is marked **Forced** on the task and in the Agents view, and Activity says "forced past the board's limits".

**Your Claude plan** (`CLD-198`). Claude has no API that says which plan an account is on, so the owner picks it at the top of the Agents settings (or `agents plan max5`; `agents plan` lists them). Claude's own limits on starting a routine are the same on every plan ([routines: usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits)): 30 starts an hour for each routine, whether by the API, **Run now**, or a re-armed one-off, and 100 API starts an hour for the account. Over either, `/fire` answers `429` with a `Retry-After`. The daily routine caps from routines' launch (Pro 5, Max 15, Team 25 a day) don't hold back API starts. What a plan changes is how much the sessions may use (Max 5x and Max 20x give five and twenty times Pro's), so the plan sets how high the board's own limits go and what they're set to when it's picked:

| Plan | Agents at once | Starts an hour | All routines a day | One routine a day |
| --- | --- | --- | --- | --- |
| Pro (the board's limits from before plans; the default) | 3, up to 6 | 20 | 10, up to 100 | 3, up to 50 |
| Max 5x | 6, up to 12 | 30 | 25, up to 250 | 6, up to 100 |
| Max 20x | 10, up to 24 | 60 | 50, up to 500 | 10, up to 200 |

Starts an hour can go up to 30 for each connected routine and 100 in all, on any plan (so 60 needs two repositories), and each repository's routine is held to its 30 an hour whatever the board's budget. Picking a plan sets agents at once, starts an hour, and the daily cap for all routines to its defaults (change them after), and brings a routine's daily cap or a repository's cap on agents at once above the new ceilings down to them. Only the owner picks the plan (a request signed with an agent's name is refused). The numbers live in [`src/plans.js`](../src/plans.js); when Claude's limits change, change them there.

**Watching a session.** No API reads a session's output, so the session sends it: `.claude/settings.json` has `async` hooks (they never slow the agent down) that run [`scripts/tasks/session-hook.mjs`](../scripts/tasks/session-hook.mjs) after each tool call, when the agent stops to report, and at the start. It sends a short entry to the task the checkout claimed (`claim` writes `.task-session`, `release` and `done` remove it): what the agent said, which tool it ran on what, and the first lines of the output. Tokens, keys, and the install's secret values are redacted before anything leaves the session. The task shows it live; the Agents view shows each agent's latest line. It works for local agents too. In a Claude Code session, `claim` sends the first entry itself ("Claimed BRK-12 as …") and warns in the session if the board didn't take it, because the hook stays quiet when it fails; in a cloud session the hook goes through the session's proxy like the CLI (see [Cloud agents](#cloud-agents)). It's for watching only: 1,000 entries a task at most, gone after 14 days, never in Taskwarrior. `BREAKAWAY_SESSION_LOG=off` turns it off for a session.

**Messaging the agent** ([IDEA-15](specs/IDEA-15-message-a-running-agent.md)). Under a running agent's live output, and from **Message** in the Agents view, the owner can send it a note (up to 2,000 characters). The board queues it for the agent that holds the claim, and hands it over once, when that agent's hook asks: in the answer to `POST /api/tasks/<ID>/session`, or from `GET /api/tasks/<ID>/messages/waiting?agent=<name>`. Each message shows Waiting, Delivered, or Not delivered (the agent finished: the claim changed first). `POST /api/tasks/<ID>/messages` is cookie only, so the token agents hold gets a 403; it's a 409 without a running agent and a 429 past 10 waiting. `GET /api/tasks/<ID>/messages` lists them. Kept 14 days, never in Taskwarrior. Two hooks in `.claude/settings.json` deliver them. While the agent works, the session hook gets them in the board's answer and passes them on as context, so the agent reads them before its next action. When it has stopped (waiting on CI or a review), [`scripts/tasks/message-wait.mjs`](../scripts/tasks/message-wait.mjs), an `async` Stop hook with `asyncRewake`, asks the board every 20 seconds for 4 minutes and wakes the agent with a message as soon as one is there. After that window, and after about 5 idle minutes in any case (a cloud session's container pauses), a message waits for the agent's next turn: a pull request event, a check-in, or you opening its session. The box says so ("The agent is idle and won't see this until it wakes") when the session has been quiet for 3 minutes and no wait hook has asked in the last minute. The agent gets each one as "Message from the owner (via the board, <time>): …", treats it as your guidance for the task it holds, within its assignment and rules (never another task, production, secrets, or a merge), and answers with a comment on the task; that comment is the lasting record. Agents the board starts read this in "Messages from the owner" in the prompt's core ([`prompts/core.md`](../prompts/core.md)). Local agents run the same hooks. No secrets and no personal data in a message: it passes through the agent's session.

**Connecting the routine (the owner, once).** The Agents view walks through it:

1. At [claude.ai/code/routines](https://claude.ai/code/routines), select **New routine**: name it after the repository ("breakaway task agent"), add the repository, pick the cloud environment with the board's [API credential](#cloud-agents), and paste the [stub](#agent-prompts) as its instructions. Choose the model there.
2. Save it, edit it, and under **Select a trigger** add an **API** trigger; select **Generate token**. Copy the URL and the token (the token is shown once).
3. Run `npx breakaway agents-connect` in the checkout (with `wrangler` logged in) and paste both when it asks. They're stored as the board's `ROUTINE_URL` and `ROUTINE_TOKEN` secrets ([Secrets](#secrets)) and never go onto a command line.

From the command line: `npx breakaway agents` (what's running and waiting), `agents start <ID> --note "…"`, `agents refine <ID> --note "…"` (an agent that improves the task instead of building it; the note says what to look at or change, and `+decide`, `+owner`, and untagged tasks can be refined), `agents next --count 3 --dry-run`, and `agents plan [pro|max5|max20]` (your Claude plan and what it allows; picking one is the owner's).

**When something's off.** An agent that stays "Starting" never claimed its task: open its session. One that comments "Started in …, but … is …'s" was started by a routine saved with the wrong repository: fix the routine's repository on claude.ai. A task that never shows live output while its agent works means the hook can't reach the board: look for `claim`'s warning in the session (`CLD-37`), or the CLI's "the session hook couldn't post" line, which any command in that checkout prints with the hook's last reason (`BRK-86`). Claude Code runs hooks with the image's default Node, not the one the agent's shell finds (a cloud image can have Node 20 there), so in a cloud session the hooks send through `curl`, which uses the session's proxy on any Node. A task shows "Quiet" when its session hasn't sent anything for 2 minutes; the session may be waiting on something, or done. "The routine's token was refused" means the token was regenerated on claude.ai: run `npx breakaway agents-connect` again (with `--repo <slug>` for another repository's routine, which the message names). The routine's `/fire` endpoint is a research preview, so its shape can change; the board's call to it is in one place (`fireRoutine` in [`src/store-agents.js`](../src/store-agents.js)).

### New agent (general agents)

`BRK-106`, `WEB-19`, [spec](specs/IDEA-30-new-agent.md). Some work isn't one task, or isn't worth writing one for: a change across several tasks, a quick fix to something you can see on a page, bringing work in line with a decision. **New agent** in the top bar (`p`; an icon on a phone) starts an agent from what you write, and the agent makes the task its own.

- **The dialog** is like the idea form: "What should the agent do?" (rough is fine), up to 4 images (picked, dropped, or pasted), the **Repository** when the board runs more than one (preset to the one in scope; a repository whose routine isn't connected shows why and can't be picked), **Force start**, and **Start agent**. It opens the new task, where the live output appears. An empty prompt, no repository, or a routine that can't start (not connected, or a prompt with a `<…>` left in it) is refused before any task is made. The button shows only when an agent routine is connected.
- **Its task** is in that repository: the prompt's first line is its title, the prompt is its description (never rewritten), horizon now, `+agent +general`, Start by itself when ready, and the images attached. It has **no area, and so no work ID, yet**: it shows by its short ID until its agent picks one of the repository's own areas, and then gets the next work ID there, once (any open task without a work ID does the same when it's given an area). The agent is `claude-<short ID>` and keeps that name. The payload says `Mode: general`, and Activity says it started "by a prompt from the owner".
- **What the agent does** ("Running a general agent" in [`prompts/core.md`](../prompts/core.md)): it gives the task its area and a title that says what the work is, then takes the smallest path that does what you asked. A change in the repository is a pull request that closes its task. Changes on the board only: it edits open, unclaimed tasks in its repository (not ideas) and comments `Changed by <its task>: …` on each, so they show in Activity. Something bigger is shaped like an idea, a spec and filled-in tasks in one pull request. Work for another repository becomes a task there. What it can't do becomes a decision or a ping. Released with no pull request, its task is closed by the board. It never sets a `horizon-*` tag or Start by itself when ready, never changes a decision, never takes a claim, never starts or forces an agent, and never deploys or merges.
- **When there's no room** it waits at the front of the queue: security fixes first, then general agents, then other tasks that start by themselves. Only room holds it back: not the auto-start switch, and not one agent per area (it has no area yet). The Agents view and the task say why it waits, with Force start beside it.
- **The API** is `POST /api/agents/general` with `{ prompt, repo, force? }` (`repo` is required with more than one repository), or `{ decision, note?, force? }` for [Refine from the answers](#decisions); it returns the task and the run, or why it waits. Images go to the task's attachments route. Your cookie or token only: a request signed with an agent's name is refused. `npx breakaway agents new "<prompt>" [--image <file>]… [--repo <slug>] [--force]` does the same from a terminal, in the checkout's repository unless `--repo` names another.

### Review with an agent

`BRK-111`, `WEB-23`, [spec](specs/IDEA-30-new-agent.md#9-review-with-an-agent). Before you merge, an agent can review a pull request and leave its answer on the pull request's page.

- **When it shows.** On the pull request's page, **Review with an agent** shows for a pull request that can merge as it stands: open, not a draft, mergeable with no conflicts and not behind, its checks passed or still running, and closing an open task in its repository (it's in the task menu too). One that's behind, conflicts, fails its checks, or has changes requested shows Update branch or Fix with an agent instead, and the server checks it all again against GitHub when you press it. A Dependabot pull request keeps **Safe to merge?**. With an agent already on the task, the page says who.
- **The agent** works on the task the pull request closes, as `claude-<id>-review`, with `Mode: pr-review` and `Pull request: #<n>` (taking over a quiet agent's claim, as Fix with an agent does). It checks out the branch, runs the repository's checks, and reads the diff against the task's description, done when, and spec, for what the checks can't see: wrong behaviour, missing tests, work outside the task, the repository's own rules. It never pushes and never merges ("Reviewing a pull request" in [`prompts/core.md`](../prompts/core.md)).
- **Its answer** is one verdict, **Looks ready**, **Ready with a follow-up** (it adds the task and names it), or **Needs changes** (what and where), left with `npx breakaway review <ID> --verdict ready|follow-up|changes "<note>"`: a comment on the task, and the review the board keeps for the pull request with the commit it reviewed. Safe to merge? answers the same way.
- **On the pull request's page**, an **Agent review** section below the description shows the latest one: the verdict, the agent, when, the commit, and the note as Markdown, marked when the branch has moved since. Earlier ones stay as comments on the task. Nothing is posted to GitHub.
- **Needs changes leads to the fix.** A review that needs changes, of the branch as it is, counts as review comments for Fix with an agent, and the fix agent's `What is wrong:` quotes it.
- **The route** is `POST /api/github/pulls/<n>/review` (with `note` and `force`), the one Safe to merge? uses, and `npx breakaway github review <n> [--note …] [--repo <slug>] [--force]` from a terminal. Owner only.

### Chase

`BRK-84`, `BRK-85`, `WEB-10`, [spec](specs/IDEA-28-features-and-chase.md#3-chase-mode). When you want a [feature](#features) finished, chase it: **Chase** on the feature, or `npx breakaway chase <slug>`. While the chase is on, the board starts the agents for you, and stops at what only you can do.

- **What it works on.** The feature's open tasks, and every open task that blocks one of them, followed through `depends` across the whole board (any area, any repository). A blocker pulled in that way says which chase tasks it blocks and needs no feature tag. Agents start only on `+agent` tasks.
- **When it starts them.** On the same tick as Start by itself when ready (after anything that could unblock a task, and every 5 minutes), every ready task starts at once, without waiting for the others, and a task that becomes ready when its blocker's pull request merges starts on the next tick. Each start goes through its own repository's routine and prompt, so a blocker in another repository works when that repository's routine is connected.
- **Its limits.** The board's shared agents at once and starts an hour, each repository's caps and its routine's limits: a chase has no budget of its own and never forces a start. Security fixes, general agents, and other tasks that start by themselves go first; then the chase, the task that frees the most work first. Waiting for a slot is shown, never pinged.
- **Several agents in an area.** Outside a chase, one agent per area. Inside one, up to `parallel` agents run at once in an area of a repository (default 3, from 1, which is the usual rule, up to the agents-at-once ceiling), counting every agent running there; two tasks `related` to each other never run at once. Set it when you start the chase or while it runs: `chase <slug> --parallel <n>`.
- **Needs you.** It never answers a decision, does a `+owner` step (or a task without `+agent`), or merges a pull request, and it can't start in a repository whose routine isn't connected: those show as **Needs you** on the feature, each with why and what it unblocks, and the chase keeps going on everything that doesn't wait for them. A task refused twice (a start that failed, or an agent that let go without a pull request) is **Stuck**, shown with the last refusal, and isn't tried again.
- **When nothing can move.** If no agent runs, none can start, and only Needs you or Stuck holds the rest, it pings you once (`blocked`, with a push), naming the one thing that frees the most. It stays on and carries on by itself once you act.
- **It ends** when every task is done or in review, with one note in the inbox and no push, or when you stop it (**Stop chase**, `chase <slug> stop`). Stopping starts nothing new and leaves running agents alone to finish and open their pull requests. A stopped or ended chase can be started again; one with no tasks, or all done, can't start.
- **Seeing it.** `npx breakaway features show <slug>` and `chase <slug>` print it: what's running, ready, Needs you, Stuck, and the next ones in the order they'd start with why each waits. `chase <slug> --dry-run` shows what would start now and starts nothing. Activity records chase started, stopped, and ended, and each start says "started by a chase". The chase lives on the board only, never in a repository.
- **Owner only.** Starting, stopping, and `parallel` are yours (a request signed with an agent's name is refused); agents never start a chase, and a chase never sets Start by itself when ready on a task. The route is `POST /api/features/<slug>/chase` with `{ on, parallel, dryRun }`.

### Agents in several repositories

Each registered repository starts its agents through its own routine ([spec](specs/IDEA-14-multi-repo.md#4-agents-and-routines-per-repository), `CLD-126`):

- **Connecting one.** Make a routine for that repository on claude.ai the way the first one is made (its repository, a cloud environment that allows the board's host and has the board's credential, the stub with that repository's prompt path as its instructions, which **Copy stub** in the Agents view gives you, an API trigger), then run `npx breakaway agents-connect --repo <slug>`. The default repository's routine stays in its two secrets; every other one goes in one secret, `ROUTINES`, JSON keyed by slug, so adding a repository needs no change to the Worker. The Secrets Store never gives a value back, so the command keeps the owner's copy in `~/.config/breakaway/tasks-routines.json` (private) and merges into it; if the board has a routine that copy doesn't hold, it stops rather than drop it (`--replace` drops it on purpose).
- **Starting.** A start goes to the routine of the task's repository; a repository without one says so ("isn't connected yet") and its Start-when-ready tasks wait with that reason. The payload says `Repository: <slug> (<owner/name>)`. **Safe to merge?**, **Fix with an agent** on a pull request, and Fix with an agent on an alert take the repository with `repo` (`?repo=<slug>` or in the body) and make their task in it, in its Tech debt area or its first area when it has none.
- **Limits are shared.** The agents at once and starts an hour above are the whole board's, checked before every start whichever repository it's for. Each repository also starts at most 30 an hour, Claude's limit for its routine. A repository can also be capped below them, so a busy one can't take every slot: in the Agents view's Repositories section (it shows once there's a second repository), or `repos modify <slug> --agents-max <n|none> --agents-hourly <n|none>`. Both are stored in the repository's `routine` settings (`{ "max": 1, "hourly": 10 }`). The Agents view and `agents` show each repository's running agents and starts this hour.
- **Each follows its own prompt.** The stub sends the agent to its repository's prompt, which includes the shared core; the core checks the payload's `Repository:` line against the checkout's `origin` before anything else, and an agent in the wrong checkout comments, releases, and stops. See [Agent prompts](#agent-prompts).
- **One per area is per repository.** Start the next few and Start by itself keep to one task per area of a repository, so one repository's `board` area and another's don't hold each other up. `agents next --repo <slug>` picks from one repository only.

### Agent prompts

What an agent the board starts follows comes in three files ([spec](specs/IDEA-14-multi-repo.md#4-agents-and-routines-per-repository), `CLD-127`):

- **The stub**, [`prompts/stub.md`](../prompts/stub.md): the routine's instructions on claude.ai. It only says to read the repository's prompt in the checkout, so a change to the prompt needs no re-paste. Paste it with `<prompt path>` replaced by the repository's prompt path (breakaway's: `prompts/breakaway.md`). A routine that still holds a full prompt pasted before `CLD-127` keeps working (that prompt is self-contained), but it doesn't change with the files; switch it to the stub once.
- **The repository's prompt**, at the path its registry entry gives (`repos modify <slug> --prompt <path>`; default `tools/tasks/routine-prompt.md`). It is short: it sends the agent to the core, then says under fixed headings (**Checks**, **Pull requests**, **Direction**, **Building**, **Dependency updates**, **Never share**) what each step means in that repository. A new repository starts from [`prompts/repository.md`](../prompts/repository.md). How to build there stays in that repository's `AGENTS.md`.
- **The core**, [`prompts/core.md`](../prompts/core.md): the board's rules every repository shares (the assignment, the repository check, claim, show, hand-over, the modes, messages, decisions, pings). It never says how to build. Another repository keeps an unchanged copy beside its prompt (`tools/tasks/prompts/core.md`) until the CLI ships as a package.

The Agents view's **Agent prompts** section has, for each registered repository (the switcher's one when it's set), **Copy stub** (the stub with that repository's prompt path filled in) and **Copy full prompt** (its prompt as it is on its default branch, read through the GitHub App and kept for a minute), with the commit that last changed it (`CLD-132`). It says when the file isn't on that branch (the repository's agents stop until it is) or when the App can't read the repository; without GitHub, the default repository's falls back to the copy the board was built with. The API is `GET /api/agents/prompt?repo=<slug>` (default: the default repository's): `{ slug, path, missing, text, url, commit }` (with `empty` when the repository has no commits yet), or a 502 with GitHub's reason. A missing prompt points to `npx breakaway repos init <slug>`. A prompt that still has a `<…>` placeholder on its default branch (one `repos init` made before `CLD-196`, or a section someone emptied) is flagged in three places (`CLD-196`): the Agents view lists them under the prompt (the API's `placeholders`), its repository's agent routine row on Connections needs attention with the fix, and **no agent starts in that repository** until they're filled in and merged: a start, by hand, from Start next, or from auto-start, is refused with the placeholders and the fix (auto-start tries again on its next tick). The check uses the same reading of the file as the wizard, kept for a minute; a prompt the board can't read doesn't stop a start.

## Routines

A routine is a saved prompt the owner runs with a button ([spec](specs/IDEA-4-routines.md)); every run is a normal task in area `routines` (`RUN-n`) named `<routine> · <date>`, with the prompt as its description and the routine's done when, started through the same path as any agent (claim, slots, hourly budget). The payload says `Mode: routine` and `Routine: <slug>`, and the agent follows "Running a routine" in the prompt's core ([`prompts/core.md`](../prompts/core.md)). **A routine belongs to one repository** (`CLD-127`): its runs are that repository's tasks (still `RUN-n`, one sequence for the board), its agents start through that repository's routine, and its GitHub events come from that repository only. A routine made before repositories, or without one, is the default repository's; pick another in its form (with several repositories) or with `routines add <slug> --repo <slug>` (default: the checkout's) and `routines modify <slug> --repo <slug>`. The board's Routines view (`u`) is an overview: a row for each routine with its state, how it starts (by hand, a schedule, triggers, GitHub events), runs used today, and a Run button, beside the On/Paused switch and the latest runs of all routines. Selecting a routine opens it where a task opens, in the sidebar (a full sheet on small screens), at `#/routines?routine=<slug>`, with Edit and On/Off, a note-and-Run box, its prompt, done when, schedule and limits, triggers, and recent runs; a run's task opens in its place and Escape goes back. From a terminal: `npx breakaway routines`, `routines add <slug> --name … --prompt …`, `routines modify <slug>`, `routines run <slug> [--note …]`, `routines pause|resume`, `routines cap <n>`.

Only the owner creates or edits routines (a request signed with an agent's name is refused). Caps, per routine: one run open at a time, a daily cap (default 3 in the last 24 hours on Pro; see [Your Claude plan](#cloud-agents-from-the-board) for the others), and a minimum gap (default 60 minutes) that applies to triggered runs, not to the button. For all routines: a daily cap (default 10 on Pro), set in the Routines view's **All routines a day** field or with `routines cap <n>` (`CLD-199`), and a pause switch. A run over a cap gets `429` (or `409` for an open run) and is never queued. A run Claude refuses to start leaves no task behind, and three such failures in a row switch the routine off.

**A prompt in the repository.** A routine's prompt can live in its repository as a file, so it's reviewed like code. Save it once with `npx breakaway routines add <slug> --name "…" --prompt-file <path> --done-when "…"`, and after a change to the file update it with `routines modify <slug> --prompt-file <path>`. For example, an Update changelog routine whose prompt lists the pull requests merged since the changelog's newest entry, writes entries in the repository's voice, edits only the changelog, and opens a pull request for the owner to merge. To run it weekly, add a schedule (`routines modify <slug> --schedule "0 9 * * 1"`).

**Schedules.** A routine can have a schedule: five-field cron text in UTC (`0 9 * * 1` is Mondays at 09:00), set with `routines modify <slug> --schedule "…"` or in the routine's form. The board's 5-minute check (the cron trigger and the Durable Object alarm) starts the routine once for each slot that has come, within ten minutes of it, under the same caps as any run (a run open, the gap, the daily caps, paused, off). A slot that a cap, a pause, or downtime skips is not made up, and setting or changing a schedule starts from now. Runs it starts say `Started: by a routine's schedule`, and the Routines view shows the next run.

**Webhook and API triggers** (`CLD-68`). A routine can have up to 10 triggers, each with its own secret. Make one with `routines trigger <slug> [--label …]` or **Add a trigger** on the routine: the board shows the secret once (`swr_…`), keeps only its SHA-256, and compares in constant time. Revoke one with `routines revoke <slug> <id>` or **Revoke**; rotating is making a new one and revoking the old. Callers send `POST /api/routines/<slug>/fire` with `Authorization: Bearer <secret>` (or an `X-Routine-Secret` header, for services that only send a header) and an optional JSON object body of at most 16 KB: `note` (plain text, up to 1,000 characters) and `data` (up to 10 keys with short string, number, or boolean values). Nothing else is read. A wrong, revoked, or other routine's secret gets `401`, the same answer whether or not the routine exists.

What the caller sends is **data, never instructions**: it becomes a comment by `routine:<slug>` labelled `Trigger data (untrusted)`, in a code block and truncated. It never reaches the run's description, the payload's `Task:` line, the branch, or the target. Caps are the button's plus the gap: `429` when the daily cap, the gap, the all-routines cap, or the pause stops it, `409` while the routine is off, `413` over 16 KB, each logged in Activity and never queued. A trigger that arrives while a run is open is noted on that run (up to 20 a day) instead of starting another. Per routine, **When a webhook or API trigger fires** (`--trigger-start`) is `wait` (the default: the board makes the run's task and you press Start, which sends it as a routine run) or `auto` (it starts the agent itself). Either way the run ends in a pull request you merge.

**Cloudflare alerts** (`CLD-70`). Cloudflare's notification webhooks use the same trigger: make a trigger, then in Cloudflare add a webhook destination with the URL `https://<your board>/api/routines/<slug>/fire` and the secret (Cloudflare sends it as `cf-webhook-auth`). Only the alert's name, its time, and the Worker it names are kept, as the labelled `Trigger data (untrusted)` comment, plus a line saying the run is read-only: it may note and open a pull request, never act on Cloudflare or production. The caps, gap, open-run noting, and wait or auto setting are the webhook trigger's, and the run says `Started: by a Cloudflare alert`.

**GitHub event triggers** (`CLD-69`). A routine can also start on events from the board's GitHub App webhook (already signature-checked), on the routine's own repository only: `pr_merged`, `release_published`, and `workflow_failed`. Set them in the routine's form, or with `routines modify <slug> --github-events pr_merged,release_published` (`""` clears them). Only the title, number, and link (or tag, branch) are passed, as the same labelled `Trigger data (untrusted)` comment; nothing else from the event is read. Each thing that happens starts a routine once (a redelivery does nothing). The caps, gap, open-run noting, and wait or auto setting are the webhook trigger's; a refusal shows in Activity, and the runs say `Started: by a routine’s GitHub event`. The App already subscribes to these events, so nothing changes on GitHub.

## How it works

The board is one Cloudflare Worker (named by the install's `worker`), on the install's address:

- **`/v1/client/*`** is the [TaskChampion sync protocol](https://gothenburgbitfactory.org/taskchampion/) (the same one as [`taskchampion-sync-server`](https://github.com/GothenburgBitFactory/taskchampion-sync-server)): a linear chain of encrypted versions, each a batch of Taskwarrior operations, plus snapshots. It accepts only the install's client ID.
- **One SQLite Durable Object** (`TaskStore`, in the install's jurisdiction when it sets one) stores the chain. It also holds the **derived sync key** (the client decrypts with PBKDF2 of the secret; the Worker only ever sees the result), so it decrypts every version as it arrives and keeps the tasks in a table. Changes made through the API are written back as ordinary encrypted versions, so `task sync` picks them up like any other replica's. The server takes its own snapshot every 50 versions, so replicas never need to send one and a new replica starts fast.
- **Claims are atomic**: the Durable Object runs one request at a time, and `claim` checks and sets in the same step. Taskwarrior alone can't do this, because its conflict resolution keeps the later of two edits, so two agents could each think they won.
- **`/api/*`** is the JSON API behind the CLI and the web board, including `/api/activity`, which summarises the latest versions, and `/api/stats`, the Activity view's numbers. **`/`** is the web board: a Preact app in [`web/`](../web/) built by Vite (`pnpm build`) on breakaway's tokens and fonts, served as static files. The API needs the token as a bearer token, or the cookie the web board gets at `/login`; cookie requests that change something must come from the same origin.
- **GitHub** (`src/github.js`, `src/store-github.js`): `/github/webhook` checks each delivery's signature and schedules a Durable Object alarm; the alarm and the cron reconcile with GitHub's REST API using a short-lived installation token (kept in memory only), and store pull requests, runs, commits, alerts, and events in the same SQLite.
- The Worker logs nothing about tasks and has no invocation logs. Pages and API answers are `noindex` and never cached.

Tests: `pnpm test` runs the server's tests (crypto against TaskChampion's own test vector, the protocol, the replica, the API, sign-in, rotation, activity, and the Markdown and link parser the web board uses). **`pnpm interop`** checks it against real Taskwarrior: two and three replicas, API changes and claims, conflicting edits, and a replica that starts from the server's snapshot. Each test replica gets its own `TASKDATA`, so your checkout's `.task/` is never touched. Run it after changing sync, the replica, or the task model, and after upgrading Taskwarrior.

## The install

What makes one board itself and not another is in one file, [`breakaway.config.json`](../breakaway.config.json) (`CLD-133`, [IDEA-13](specs/IDEA-13-breakaway.md), section 2):

| Setting | What | A new install's default |
| --- | --- | --- |
| `name` | The name people see: push notifications, the GitHub App, `/api/session` | `breakaway` |
| `worker` | The Worker's name on Cloudflare | `breakaway` |
| `url` | Where the board answers: its custom domain and push's VAPID subject | none: the board answers on workers.dev, and goes by the address it was opened at |
| `aliases` | Other addresses the board answers on beside `url`, each a custom domain too, while it moves to a new one ([Moving to a new address](#moving-to-a-new-address)) | none |
| `secretsPrefix` | Starts every secret's name in the Secrets Store ([Secrets](#secrets)) | `BREAKAWAY_` |
| `secretsStore` | The Secrets Store's ID | none: the secrets are Worker secrets |
| `store` | The Durable Object's name. Changing it starts an empty board, so it never changes on a running install | `breakaway` |
| `installRepository`, `channel` | The repository the install deploys from (`owner/name`) and the channel it follows, `stable` or `main`. With an install repository, the board looks for a newer release on its cron and shows it on Connections' Version row; on `main` it starts that repository's Deploy workflow when a newer pre-release is out ([Updates](#updates)). Without one, nothing changes | none, `stable` |
| `jurisdiction`, `repository`, `vapidPublic`, `docs` | The Durable Object's jurisdiction, the repository an install from before repositories starts with, push's public key, and where Connections links to | none |

`node install.mjs` turns it into the Worker's wrangler config (`--config <file>` for another install, `--local` for `wrangler dev`). [`wrangler.jsonc`](../wrangler.jsonc) is that output with comments, and a test fails when the two differ, so change both together. The Worker reads the names back from its `TASKS_INSTALL` var; a Worker without it is the first install's (from before installs had a config), so an older deploy keeps its Durable Object. The bindings in the code (`TASKS_*`, `STORE`) are the same on every install. `pnpm interop` runs the board as an install with breakaway's prefix and its own names.

### Moving to a new address

A board moves without a moment where it doesn't answer, in three deploys of its install repository (`BRK-78`). Each changes the address, so its Deploy runs `wrangler deploy`: that takes a token that can and `BREAKAWAY_DEPLOY_CHANGES` set to `true` ([the install template's README](../template/README.md#which-token-does-what)), with Workers Routes write on both zones when the new address is in another one. Without them, apply each step with `wrangler deploy` yourself.

1. **Add the new address as an alias**: `"aliases": ["https://new.example.com"]`. Both addresses answer, with the same board behind them.
2. **Swap them**: `url` becomes the new address and the old one the alias. Then move everything that names the board: the GitHub App's webhook and callback URLs, each routine's cloud environment (its allowed host and API credential), `BREAKAWAY_URL` in `tasks.env` and in cloud environments, each checkout's `.taskrc` (`sync.server.url`), and the repository variable `BREAKAWAY_URL` if you set it. Sign in at the new address, install the app from it, and turn notifications on there: sign-ins, the installed app, and push subscriptions belong to the address they were made at. Connections checks each as you go.
3. **Remove the alias** once nothing has used the old address for a day: its custom domain goes, and it stops answering.

### A new install

A new install starts from the root [`wrangler.jsonc`](../wrangler.jsonc) and [`breakaway.config.json`](../breakaway.config.json) (`BRK-5`; the install template, `BRK-9`, copies them). There is no Deploy to Cloudflare button. They have no custom domain (the board answers on workers.dev, and goes by the address it was opened at), no Secrets Store, and no repository, so the board starts with Connections' **Set up the board** ([Repositories](#repositories)). Its files:

- `wrangler.jsonc` is `install.mjs` with comments (a test keeps them the same).
- `.dev.vars.example`: the secrets to set as Worker secrets. Three are needed, from `npx breakaway init-secrets`, which writes `tasks.env` and says which value goes where: `TASKS_API_TOKEN`, `TASKS_CLIENT_ID`, and `TASKS_SYNC_KEY`. The rest stay `unset` until a command writes them. A token shorter than 32 characters signs nobody in.

On an install without a Secrets Store, the commands that write secrets (`github-connect`, `agents-connect`, `rotate-sync`, `rotate-token`) set them on the Worker with `wrangler secret put`, under the same binding names; each one deploys a new version of it.

After the deploy, the first run is the one Connections already shows a fresh install: open the board's workers.dev address, sign in with the token, and follow **Set up the board**: register a repository, connect the GitHub App, install it on the repository, add the board's files (`repos init`), connect its routine, and connect the CLI and Taskwarrior (`BREAKAWAY_URL` in `tasks.env`, then `npx breakaway setup`; done once a replica syncs). Each step ticks itself from the connection it names. [The self-hosting guide](self-hosting.md) walks through them (`DOC-2`).

To check it without a Cloudflare account, run `vite build` and `wrangler deploy --dry-run`.

## Updates

An install whose config names its `installRepository` knows its version and channel (`BRK-10`). Connections' **Version** row says what the board runs, the latest release in its channel with a link to its notes, and the install repository's update pull request when there is one. The board reads the update feed ([`site/`](../site/README.md)) on its cron: every run on `main`, hourly on `stable`. While the feed has nothing (breakaway's repository is private), it reads breakaway's releases through its GitHub App when breakaway is registered on the board, and a `release` webhook from breakaway makes it look within a minute.

- **`stable`**: a newer release waits for you. The install repository's update workflow opens the pull request; merging it deploys. The board adds a note to the inbox (no push), once per release, and clears it when the board runs that release.
- **`main`**: the board starts the install repository's **Deploy** workflow on its default branch when there's a newer pre-release, so a merge to breakaway reaches the board within minutes. That needs the board's GitHub App installed on the install repository with read and write on Actions. It doesn't start the same release twice in 30 minutes, leaves a release that needs steps by hand (or one this version can't update from) to you, and the row needs attention if a started deploy isn't running after 45 minutes. The install repository's hourly update run is the fallback.

An install with no `installRepository` makes no call and shows only what it runs. `install init` writes `installRepository` (from `origin` or `--install-repository`) and `channel` in `breakaway.config.json`, the same channel as `breakaway.json`.

## Secrets

On an install with a Secrets Store, the secrets are in it (scope `workers`), bound in [`wrangler.jsonc`](../wrangler.jsonc), and their names start with the install's `secretsPrefix` ([the install](#the-install)), `BREAKAWAY_` by default. On an install without one, they're Worker secrets under their binding names ([A new install](#a-new-install)).

| Secrets Store name | Binding | What |
| --- | --- | --- |
| `BREAKAWAY_CLIENT_ID` | `TASKS_CLIENT_ID` | The Taskwarrior client ID. Anyone with it and the secret can read and write the board through Taskwarrior. |
| `BREAKAWAY_SYNC_KEY` | `TASKS_SYNC_KEY` | PBKDF2-HMAC-SHA256(secret, client ID, 600000) as base64. Not the secret itself. |
| `BREAKAWAY_API_TOKEN` | `TASKS_API_TOKEN` | The API and web token, at least 32 characters. Also signs the web cookie. |
| `BREAKAWAY_ROUTINE_URL`, `BREAKAWAY_ROUTINE_TOKEN` | `TASKS_ROUTINE_*` | The default repository's agent routine: its `/fire` URL and its token, written by `npx breakaway agents-connect`. The token can only start that routine. `unset` means not connected. |
| `BREAKAWAY_ROUTINES` | `TASKS_ROUTINES` | Every other repository's routine, JSON keyed by slug (`{ "<slug>": { "url": "…", "token": "…" } }`), written by `npx breakaway agents-connect --repo <slug>` ([agents in several repositories](#agents-in-several-repositories)). `unset` means none. |
| `BREAKAWAY_VAPID_KEY` (and the var `TASKS_VAPID_PUBLIC` in `wrangler.jsonc`) | `TASKS_VAPID_KEY` | The VAPID key pair for Web Push on pings (`CLD-113`): the private key (32 bytes, base64url) as the secret, the public key (65 bytes, base64url) as the var. `unset` means notifications are off: the settings menu says so, and pings work without them. The owner generates the pair (`generateVapidKeys()` in `src/push.js`) and sets both (`CLD-116`). |
| `BREAKAWAY_GITHUB_APP_ID`, `…_GITHUB_KEY`, `…_GITHUB_WEBHOOK_SECRET` | `TASKS_GITHUB_*` | The GitHub App's ID, private key (one line of base64 PKCS#8), and webhook secret, written by `npx breakaway github-connect`. `unset` means not connected. |

Both rotations are one command on the owner's machine (with `wrangler` logged in). Each writes the new values to `tasks.env.next` before anything changes, keeps the old file as `tasks.env.<time>.bak` (its values stop working, so delete it once you've updated your password manager), and never puts a secret on a command line.

**Rotate the sync credentials** (the client ID or secret leaked, or a machine that had them is gone):

```sh
npx breakaway rotate-sync
```

It makes a new client ID and secret and sends only the derived key to the server, which decrypts every stored version and the snapshot with the old key and seals them again with the new one, **keeping every version ID**, in one transaction. So no history is lost and every replica carries on from where it was, including work it hadn't synced yet: from that moment the old client ID gets a 403, and a replica syncs again once it has the new values (copy `tasks.env` to it and run `npx breakaway setup`). The Durable Object switches to the new values itself, then the command updates the stored secrets; `health` shows `secretsStoreInSync: false` until the store has caught up (a few seconds), or if updating it failed, in which case update it by hand. Cloud agents only use the token, so they need nothing. If the server can't read part of its history, it refuses to rotate until that's fixed.

**Rotate the API token** (it leaked, or someone should lose access):

```sh
npx breakaway rotate-token
```

It updates the stored secret, waits until the server accepts the new token, and saves it. Every browser is signed out; update `BREAKAWAY_TOKEN`, or the API credential, in cloud environments.

## Connections

`npx breakaway connections` (or `GET /api/connections`, `CLD-120`, [spec](specs/IDEA-14-multi-repo.md#7-connections)) lists everything the board leans on, each **Working**, **Needs attention**, or **Not connected**, with what the board saw, when, and the exact fix for each failure it can tell apart:

- **Cloudflare:** the Worker's version, each secret binding as `set` or `unset` (by name only, never a value), the 5-minute cron's last run and its first error, and whether the sync server's key reads its history and the stored secrets match after a rotation.
- **GitHub:** the App (GitHub refusing its key), whether it's installed on each registered repository (or suspended), its permissions against what the board needs (Pull requests and Contents write, Actions write where there's a deploy pipeline: the `CLD-56` and `CLD-104` problem), **Allow auto-merge**, the webhook (when the Worker last got one, signatures it refused, and failures from GitHub's own delivery log), and the sync: last success, last error, and requests left.
- **Claude:** the routine connected or not, the last start's result (a refused token, Claude's hourly limit, a paused routine), routines switched off after three failed starts, the shared budget, and whether a started session is sending live output (the `CLD-37` failure).
- **Per repository** (`CLD-129`): each registered repository gets its own rows: the App installed on it (a repository other than the default without it needs attention), its permissions, **Allow auto-merge**, its sync, its routine ("Agent routine for <slug>", which needs attention with `npx breakaway agents-connect --repo <slug>` when it's missing, or while its agent prompt still has a `<…>` placeholder, `CLD-196`) and its last start, and its live output once the routine is connected. With several repositories, the Webhook row lists the last delivery for each. The view follows the repository switcher, and shared rows always show.
- **Taskwarrior** (when a replica last synced) and **Push** (keys set, browsers subscribed, the last send).
- **A fresh install's setup** (`CLD-131`): on an install that started with no repository, a **Repositories** row says whether one is registered, and the report's `setup` lists the steps (register a repository, connect the App, install it, add the board's files, connect the routine, connect the CLI and Taskwarrior), each done or not, with the connection that shows it. Until a machine syncs, Taskwarrior shows as not connected with the steps to connect one. There the default repository's missing installation and routine need attention instead of showing as not connected. An install from before repositories gets neither, and `setup` is null.

It also lists what it can't check: the routine's cloud environment and prompt on claude.ai, and Cloudflare's own settings. The GitHub checks run once an hour from the cron, and again when the owner presses **Check now** on the board (`POST /api/connections/check`: the signed-in browser only, once every 30 seconds). A check only reads: it never writes to GitHub, never starts an agent, and never costs a Claude start. The board keeps states and timestamps in its Durable Object, and redacts a message from outside it the way the session hook does.

**On the board** (`CLD-121`): the **Connections** view (`#/connections`, in the sidebar, shortcut `w`) shows the same report grouped by Cloudflare, GitHub, Claude, and Sync and push, each with its state, what the board saw and when, the fix with a link to where it's fixed, and **Check now**. How many connections need attention shows as a count on the Connections item and on Settings (on a phone, as a dot on the menu button), so a broken link is seen without opening the view; "Not connected" doesn't count, since a feature can be off on purpose. The cron builds the report every 5 minutes, and `GET /api/health` carries its count (`connections: { attention, at }`). When a connection has needed attention for 10 minutes, the inbox gets a note, and another when it works again: an `fyi` with no push (the owner's choice in `CLD-119`), one open note per connection, and none for the shared agent budget, which rolls over by itself. The notes come with `GET /api/pings` as `notices`; the owner dismisses one with `POST /api/connections/notices/<id>/dismiss` (the signed-in browser only), and resolved notes are deleted after 30 days.

## When something's wrong

| What you see | What to do |
| --- | --- |
| A button on the board doesn't work, or something seems off | Run `npx breakaway connections`: it says which connection is broken and how to fix it. |
| `Could not read include file '~/.config/breakaway/taskrc'` | Run `npx breakaway setup` (it needs `tasks.env`). |
| `task sync` fails with a 403 | This replica has another client ID. Run `npx breakaway setup` again. |
| `task sync` fails with `410 Gone` on `get-child-version` (Connections shows Taskwarrior sync needing attention) | This replica last synced with another server, so the board doesn't have its version and it can't sync here again: the board never deletes versions (`CLD-195`). Start the replica again: move `.task/` aside (`mv .task .task-stale`), then `scripts/task sync`, which fetches every task from the board's snapshot. If the old one has changes that never reached the board, look them up with `TASKDATA=.task-stale task export` and make them again; then delete it. `scripts/task sync` prints these steps when it gets a 410. |
| `health` says the server can't read its history | A replica synced with the right client ID but a different secret. The versions are kept, but the API stops writing until it's fixed: set that replica's secret right, remove what it added (or accept it's unreadable), then rebuild with `curl -X POST -H "Authorization: Bearer $BREAKAWAY_TOKEN" https://<your board>/api/admin/rebuild`. |
| A claim fails with "claimed by …" | Someone has it. Pick another, or ask the owner; `--force` is for the owner clearing a stale claim. |
| "can't reach https://…" or "HTTP 403 from the session's proxy" in a cloud session | The environment's network settings don't allow the board's host (see [Cloud agents](#cloud-agents)). A bare `HTTP 403` means a script called the board around the proxy. |
| The GitHub view says the last sync failed | A 401 or 404 means the App was uninstalled or its key changed: reinstall it, or store the current key ([Secrets](#secrets)). A 403 on Dependabot alerts is fine: the view just leaves them out. |
| A merged pull request didn't finish its task | The pull request has to close it: `Closes <ID>.` in its title or description, or its number in the task's `pr` field. A branch name only mentions. |
| The web board keeps asking for the token | The token was rotated, or the cookie expired after 180 days. Sign in again. |
| A command says "this checkout carries a copy of the board's CLI" | Run it as `npx breakaway <command>`. To remove the copy, run `npx breakaway repos init <slug> --update` and merge its pull request ([Keeping a repository's copy current](#adding-a-repository)). In this repository, it says "older than the board's" instead: pull `main`. |
| A command says "<command> has no …" or "takes no …" | The command doesn't have that subcommand: `npx breakaway help` lists them. On an old copy of the CLI, run `npx breakaway` instead (above). |

**Backups.** The Durable Object's SQLite storage has Cloudflare's point-in-time recovery for the last 30 days. For a copy of your own, take `npx breakaway export --out tasks-backup.json` (keep it out of Git): every task in every repository, status, and horizon, as the board's JSON with comments, and it checks the count against `health` (`tasks.total`), failing when they differ (`CLD-193`). A Taskwarrior replica is a full copy only while it syncs: `task export > tasks.json` from a replica whose `task sync` fails (like the `410 Gone` above) quietly exports a stale one, so compare `task count` with `health`'s total, and if they differ, start the replica again ([above](#when-somethings-wrong)). A point-in-time restore of the Durable Object puts every replica that synced after the restore point in the same state: each one gets `410 Gone` and has to be started again. `list --status all` lists the archive too, but stays in the checkout's repository unless `--all`.

## Changing the server

Deploying is the owner's: `pnpm run deploy` builds the web board, then runs `wrangler deploy -c wrangler.jsonc`. Agents never deploy (`AGENTS.md`). The Worker answers a public `GET /api/ping` (`{ ok, version, release }`, nothing about tasks: `version` is the Cloudflare version ID, `release` the semver release, see the README's releases section), so a check after a deploy can tell the new version answers ([CLD-27](specs/CLD-27-continuous-deployment.md)).

To work on the web board locally, run `wrangler dev -c wrangler.test.jsonc --var TASKS_CLIENT_ID:… --var TASKS_SYNC_KEY:… --var TASKS_API_TOKEN:…` (throwaway values, like the ones in `test/constants.js`) and `pnpm dev`, which proxies the API to it. Check a change in both themes, narrow and wide.
