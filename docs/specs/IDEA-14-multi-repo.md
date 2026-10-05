# IDEA-14 · Multi-repo support, and a Connections view

Task: IDEA-14 on the board · Status: built (before the move to breakaway, under the first install's work IDs)

## Problem

The board runs one repository, samewave's (the install it was written for), and that is hard-wired: one `TASKS_GITHUB_REPO` variable, one GitHub client, one routine (the two `ROUTINE_URL` and `ROUTINE_TOKEN` secrets), one prompt, one set of area prefixes in `PROJECTS`, one Durable Object named `samewave`, one Taskwarrior client ID. IDEA-13 (making it breakaway, a project of its own) needs one install that tracks samewave's repository and breakaway's own, so breakaway is developed on breakaway from day one, and so self-hosters with several repositories aren't left out.

A second problem sits next to it, and the owner asked for it as part of this: **the connections are invisible.** GitHub App, Cloudflare Worker and Secrets Store, Claude routine, Taskwarrior sync, push: if one breaks (a GitHub App without the Actions permission, a refused routine token, a missing webhook, an unset secret) the first sign is a button that doesn't work, and the fix is hunting through docs. With several repositories there would be several of each, so seeing them is no longer optional.

## Fit

Nothing in the [decision log](../decisions.md) is touched. The board holds no personal data, and none of this changes that. One owner, one sign-in: accounts, permissions, and tenants stay out. Agents still never deploy, promote, merge, or touch production; **Merge**, **Promote**, **Roll back** and the pull request settings stay cookie-only and owner-only, per repository. The Secrets Store stays the owner's: the Worker can read a secret binding but never write one.

## Design

### 1. What a repository is on the board

A **repository** is a row in a new `repos` table in the Durable Object's SQLite (additive; nothing existing changes):

| Field | Meaning |
| --- | --- |
| `slug` | Short name used everywhere on the board and the CLI: `samewave`, later `breakaway`. Lowercase, never reused. |
| `github` | `owner/name`. Unique. |
| `default_branch`, `name` | Shown in the board. |
| `areas` | The areas (Taskwarrior `project` values) this repository owns, each with its work-ID prefix (see 2). |
| `pipeline` | Optional deploy pipeline: Worker names, the deploy/promote/rollback workflow files, deploy paths (the `deploy-paths.js` rules). Absent means the repository has no Releases card, no Promote, no Roll back, and no "merging deploys" warning. |
| `routine` | Optional: whether agents can start here, the prompt path, per-repository caps (see 4). |
| `settings` | Merge when green and Keep branches up to date, per repository (today the browser-held pull request settings, `CLD-98`). |

`samewave` is registered by the migration, from today's `TASKS_GITHUB_REPO` and `PROJECTS`, with its pipeline matching today's `release.js` constants. Other repositories are added with `node scripts/tasks.mjs repos add <owner/name> --slug … --area …` and on the board; adding is owner-only (a request signed with an agent's name is refused, as for routines).

**Every task belongs to exactly one repository** through a new plain property `repo` (declared as a UDA in [`taskrc`](../../taskrc), so Taskwarrior and `task sync` carry it like `horizon`). **A task with no `repo` belongs to the default repository (`samewave`).** That is the whole migration for existing data: no task is rewritten, no history changes, no work ID is renumbered, Taskwarrior replicas keep syncing untouched, and the old CLI keeps working because everything it sees is samewave. Nothing is lost and nothing has to be planned around: the first deploy only adds a table and a code path that reads "no `repo`" as samewave.

### 2. Work IDs

- IDs stay the bare `PRD-12` form. **A prefix belongs to exactly one repository**, and registering a repository fails on a prefix already taken, so an ID is unique across the install and `Closes BRK-3.` can only mean one task.
- `wid` allocation is unchanged in shape (highest in use for the prefix plus one, never reused); `PROJECTS` becomes a lookup through the repository's areas instead of a constant. A task's area, and so its prefix, must be one of its repository's.
- **Recommended: `ideas` (IDEA) and `routines` (RUN) are install-wide.** They are the owner's inbox and the owner's saved prompts, not a repository's work, and IDEA-13 and IDEA-14 are themselves ideas that span repositories. They keep one number sequence for the whole install, and an idea or run still has a `repo` (where its spec or pull request goes), defaulting to the repository the board is showing. The other areas are per repository, each with its own prefix. This is a [decision](#decisions-for-the-owner).
- A pull request closes only tasks of its own repository: in a pull request on `breakaway`, `Closes PRD-12.` is a mention, not a close, and the board says so on the pull request page. Cross-repository work is two tasks and a `depends` between them (a dependency may cross repositories; the graph shows it).

### 3. GitHub, per repository

One GitHub App serves every repository: it is installed on each, and `installation` is already looked up by repository (`/repos/{full}/installation`). What changes is that the client, cache, and rows are keyed by repository.

- `repoOf(env)` becomes a registry lookup. `GitHubClient` is created per repository. The webhook finds the repository from the delivery's `repository.full_name` (today it ignores any other with a 202); an unregistered repository still gets that 202.
- Stored pull requests, runs, commits, alerts, deploys, and events get a `repo` column (default `samewave`, additive). Sync and the 5-minute cron loop over registered repositories, each independently, so one repository's failure or rate limit never stops another.
- The GitHub view shows one repository or all (see 6). Releases, Promote, and Roll back appear only for a repository with a `pipeline`; breakaway's won't have samewave's, and a self-hoster's usually won't either. Update branch, Merge, and Merge when green work wherever the App has write access and the repository allows auto-merge, and the board says plainly when it doesn't.
- The App's manifest and `github-connect` flow stay as they are, plus a step "install it on this repository too" per registered repository, which the Connections view checks.

### 4. Agents and routines, per repository

A cloud session starts in whichever repository its Claude routine was saved with, so **each repository has its own Claude routine** ("samewave task agent", "breakaway task agent"), connected with `node scripts/tasks.mjs agents-connect --repo <slug>`.

- **Secrets.** Today's two Secrets Store secrets stay as the default repository's, so nothing changes for samewave. Other repositories' URLs and tokens go in **one** new Secrets Store secret holding JSON keyed by slug, written by `agents-connect --repo` (merging, never echoing a token). That way adding a repository needs no wrangler change and no redeploy, and a self-hoster never edits a binding list.
- **Payload.** Every start now says `Repository: <slug> (<owner/name>)`. The agent must check its checkout is that repository before claiming (see 5); a mismatch means stop and `comment`.
- **Prompt.** Today the full prompt is pasted into claude.ai and re-pasted on every change (`CLD-65`). Recommended: the claude.ai routine holds a short stub ("you were started by the task board; read `<prompt path>` in this repository and follow it"), and each repository keeps its own prompt in its own checkout, reviewed like code. The shared parts (claim, show, ping, decisions, shaping ideas) live in one core file the repository's prompt includes by name, so breakaway starts from the same rules and adds its own project rules. This is a [decision](#decisions-for-the-owner).
- **Limits add up across the install.** One subscription pays for everyone: the concurrent agents limit (default 3) and the hourly start budget (default 20, at most 30, Claude's own cap per routine) stay global and are checked before any start, whichever repository it's for. **Recommended:** an optional per-repository cap below the global one, so a busy repository can't starve another. "At most one task per area, none where an agent already works" becomes per (repository, area). The Agents view shows the shared budget and each repository's use of it. This is a [decision](#decisions-for-the-owner).
- **Saved routines (`RUN-n`).** A routine belongs to a repository (it runs where its prompt's work lives); its runs are started in that repository's routine. Caps stay per routine and for all routines.
- **Cloud environment.** Each repository's routine needs the board's host allowed in its cloud environment, as the first repository's does today; the Connections view reminds, since it can't check it.

### 5. The CLI, Taskwarrior, and teaching agents

- **The CLI picks its repository from the checkout:** the trailing `owner/name` of `git remote get-url origin` (a cloud session's proxied remote ends the same way), matched against `GET /api/repos`. `--repo <slug>` or `BREAKAWAY_REPO=<slug>` overrides it, `--all` widens it. `list`, `next`, and `claim` default to the checkout's repository; `show <ID>` works for any ID, since IDs are unique. `claim` refuses a task of another repository unless `--repo` names it, so an agent can't build breakaway's task in samewave's checkout. `add` puts the task in the checkout's repository, `--depends` may name any ID. `claim` writes the repository into `.task-session`, so the session hook reports to the right task.
- **Taskwarrior is one replica of everything** (one TaskChampion client, as now). Filter with `repo:samewave`; the shipped `taskrc` gets a `repo` UDA, a default report per repository, and `context` definitions to switch. A machine that never sets a context sees all repositories, and a task without `repo` shows up as samewave, so old machines keep working.
- **Teaching agents** is part of the build, not an afterthought: the `tasks` skill gets "Working across repositories" (the checkout decides the repository, never cross it, cross-repository work is two tasks and a dependency), the routine prompt core gets the payload's `Repository:` line and the mismatch rule, `AGENTS.md` gets a short "One board, several repositories" section (and breakaway's own AGENTS.md will carry the same), `docs/tasks.md` is reorganised so per-repository settings and install-wide settings are separate sections, and `docs/decisions.md` records the model. Each repository's `AGENTS.md` stays the source for how to work in that repository: the board's skill and prompt say how to use the board, never how to build.

### 6. On the board

- A **repository switcher** in the header: one repository or **All**, remembered in the browser, in the URL (`?repo=`), and with a key. Board, list, graph, activity, GitHub, Agents, Routines, and the inbox all follow it.
- **Every task, card, row, graph node, activity line, and ping shows its repository** as a small chip (hidden while one repository is the only one registered, so samewave's board looks the same as today until a second is added). New task and the quick-add pick the repository, defaulting to the one selected.
- Counts (ready to merge, open pings, agents running) say which repository when "All" is selected.

### 7. Connections

A new view, **Connections** (nav item and `#/connections`), answers "is everything wired up, and if not, what do I do". It lists each connection with a state (**Working**, **Needs attention**, **Not connected**), what the board saw and when, and the exact fix, with a link to the place that fixes it. A **Check now** button re-runs the live checks (rate limited; a check never starts an agent, never writes to GitHub, never costs a Claude start).

**What the Worker can see about itself (Cloudflare):**
- the Worker, its version and deploy time (the `VERSION` binding), its custom domain, the Durable Object answering;
- each Secrets Store binding: **set or `unset`**, by name only. Never a value, a length, or a fragment; the check is whether the binding resolves;
- the cron's last run and result; the TaskChampion sync server: last sync, the number of versions, and whether the stored key can read the history (what `health` says today);
- the optional pipeline's **Workers** (staging, production) as the GitHub deploy records show them, since the Worker has no Cloudflare API token and the board should not get one for this.

**GitHub, per repository:**
- the App: its ID and name, and for each registered repository whether it is **installed**;
- the installation's **permissions against what the board needs** (Pull requests and Contents write for Merge and Update branch, Actions write for Promote and Roll back, Dependabot alerts read, and so on), each shown as granted or missing. This is the check that would have caught `CLD-56` and `CLD-104` before a button said "can't write yet", and the fix text is those steps;
- the repository's **Allow auto-merge** setting (Merge when green needs it);
- the webhook: the time of the last delivery received, its last failure from GitHub's delivery log (`GET /app/hook/deliveries`, which uses the App's JWT), and signature failures the Worker rejected;
- sync: last success per repository, last error, and rate limit remaining.

**Claude, per repository:**
- the routine: **connected** (the URL and token resolve) or not, and the last start's result: started, refused ("token was refused" means regenerate it), rate limited, and the three-failures-in-a-row switch-off;
- the shared budget: concurrent and hourly use;
- **live output**: when the last session hook entry arrived (a quiet hook is the `CLD-37` failure, which was invisible for a day);
- what it can't verify, listed so nobody assumes: the routine's cloud environment allowlist and its prompt, with a link to claude.ai/code/routines.

**Also:** Taskwarrior (last sync, replicas seen) and Push (VAPID configured; subscriptions registered; last send result, `CLD-116`).

**Where it surfaces:** a count of connections needing attention on the Connections nav item and on the board's settings gear, and in the inbox as an `fyi` (no push), once when a connection goes bad and again when it recovers, so a broken link is seen without opening the view. Whether it pushes is a [decision](#decisions-for-the-owner).

**Privacy.** The view holds no personal data and no secret value. It stores states and timestamps in the Durable Object, and shows an error message only after the same token and secret redaction the session hook uses (`scripts/tasks/session-hook.mjs`). The bearer token (agents, CLI) gets the read-only `GET /api/connections` and `connections` command; **Check now** and anything that could cost or write is cookie-only.

**Manage, honestly.** The board can't write the Secrets Store or the App's settings, so "manage" means seeing the state, running the checks, and following guided steps (the owner runs `agents-connect`, `github-connect`, rotation); **adding or removing a repository and its routine settings is done in the board**. It doesn't pretend to repair what only GitHub, Cloudflare, or claude.ai can.

## Decisions for the owner

Asked as a decision on the board (the task that carries them blocks every build task but Connections, which is useful before multi-repo and is the safety net for it):

1. **One board for everything, or one install per repository.** Recommended: one board (this spec). One install per repository would be simpler to build and would need no changes, but it breaks "breakaway runs breakaway on the same infrastructure", two Taskwarrior syncs, no cross-repository dependencies, and two of every connection.
2. **How agent limits are shared.** Recommended: global pool (slots and hourly budget) plus an optional cap per repository.
3. **Areas and prefixes.** Recommended: Ideas and Routines install-wide, every other area per repository.
4. **Where each repository's agent prompt lives.** Recommended: a short stub in the claude.ai routine, the real prompt in the repository.
5. **Whether a broken connection pings you.** Recommended: inbox only.

## Out of scope

- Several people, teams, accounts, permissions, or tenants. One owner, one sign-in, as today.
- A repository per Durable Object, or per-repository Taskwarrior client IDs. One replica holds everything; `repo` is a filter.
- The Cloudflare API from the board, or an API token for it; writing the Secrets Store or GitHub App settings from the board.
- Moving, copying, or renaming a task between repositories after it exists beyond changing its `repo` (and `wid` with it, an owner-only action; the old ID stays reserved).
- Anything IDEA-13 owns: the breakaway repository, its identity, landing page, licence, self-hosting button. This only makes the board able to hold it.
- Repositories outside GitHub.

## Rollout, so samewave's board never stops

Every step is additive and each pull request leaves the board as it is today for samewave: a new table and columns with defaults; "no `repo` means samewave" in code before any task has one; the default repository's secrets and the existing `TASKS_GITHUB_REPO` var keep working (the var becomes the registry's first row and then a fallback); the repository switcher and chips stay hidden until a second repository exists. Nothing requires a maintenance window; `pnpm interop` runs against real Taskwarrior on every step. The Durable Object's SQLite has point-in-time recovery, and `task export` is a full backup to take before the first deploy that carries the migration.

## Done when

- The Connections view shows the real state of samewave's GitHub App, Worker and secrets, routine, sync, and push, with a fix for each failure it can tell apart, before any repository is added.
- A scratch repository can be registered, installed with the App, connected to its own routine, and used: tasks with its own prefixes, `Closes <ID>.` in its pull requests finishing them, an agent started in it, and the CLI picking it from its checkout, with samewave's tasks, history, claims, links, routines, and Taskwarrior sync unchanged throughout.
- The shared agent budget holds across repositories, and an agent in the wrong checkout is refused.
- The skill, routine prompt, `AGENTS.md`, `docs/tasks.md`, and `docs/decisions.md` explain it.

Follow-up tasks (all horizon `next`). Only the decision and Connections start now; the rest wait for the decision:

| Task | What | Waits for |
| --- | --- | --- |
| `CLD-119` | Decide the five questions above (owner) | IDEA-14 |
| `CLD-120` | Connections: API and CLI checks | IDEA-14 |
| `CLD-121` | Connections view and attention count | `CLD-120` |
| `CLD-122` | Registry, `repo` field, work IDs per repository | `CLD-119` |
| `CLD-123` | CLI and agents work from the checkout's repository | `CLD-122` |
| `CLD-124` | GitHub per repository (clients, webhook, sync, PR linking) | `CLD-122` |
| `CLD-125` | GitHub view, Merge, and the pipeline per repository | `CLD-124` |
| `CLD-126` | Agents per repository (routine, payload, shared limits) | `CLD-122` |
| `CLD-127` | Prompts and saved routines per repository; teaching agents, docs | `CLD-123`, `CLD-126` |
| `CLD-128` | Board repository switcher and chips | `CLD-122` |
| `CLD-129` | Connections per repository | `CLD-121`, `CLD-124`, `CLD-126` |
| `CLD-130` | Rehearsal with a scratch repository (owner) | `CLD-125`, `CLD-127`, `CLD-128`, `CLD-129` |

`CLD-130` is the gate for IDEA-13: every task made from that idea depends on it (and so on the whole build).
