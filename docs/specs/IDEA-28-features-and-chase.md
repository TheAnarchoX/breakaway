# IDEA-28 · Features and Chase mode

Task: IDEA-28 on the board · Status: draft

## Problem
The roadmap is two tags put on by hand: a release tag (`v1_2-0`) and a feature tag (`self-update`, `legacy-free`, `artifacts`) on every task. The board can filter by them, but it has no idea what a feature is: nothing says what it's called, which release it's aimed at, how far along it is, or what is stopping it. And when the owner wants a feature finished, they start agents one task at a time, watch the budget, and notice by hand when something upstream (a decision, a manual step, a pull request to merge) is holding the rest.

## Fit
- **The person who runs the board decides.** A chase starts agents the way auto-start does, only on the owner's say-so, and never merges, deploys, or answers a decision. It stops at what only the owner can do and says so.
- **Taskwarrior stays first-class.** Membership is a plain tag, so `task` and sync keep working and nothing needs a migration.
- **One claim per task, one repository per task.** A chase starts agents through each repository's own routine and caps, and never crosses into another checkout.
- **Free and self-hosted, no telemetry.** Nothing new leaves the install.

## Design

### 1. What a feature is
A feature is **its own small record, joined by a tag**.
- **The record** (in the Durable Object, like routines and repositories): `slug`, `title`, a short Markdown `brief`, `release` (the stable release it's aimed at, like `1.2.0`, or none for unplanned), `state` (`open` or `shipped`), and `chase` (see section 3). Nothing else.
- **A task joins by the tag.** The tag is the feature's slug, as today (`self-update`). A task is in one feature; a second feature tag is shown as a warning on the task and counts toward the first alphabetically. No new field on the task, so Taskwarrior carries it and the CLI's `--tag` already sets it.
- **Existing tags adopt themselves.** A tag that is on tasks and isn't a record yet shows as a *suggested feature* on the roadmap with a one-press **Make it a feature** (its release is guessed from the release tag its tasks share). Nothing is created for the owner without being pressed, and `+agent`, `+owner`, `+decide`, `+idea`, `+horizon-*`, and release tags are never suggested.
- **The release is the feature's, not the task's.** A feature's release replaces the per-task release tag as the source of truth. Release tags stay readable (a task with `v1_2-0` and no feature still groups under 1.2.0 on the roadmap) and the board stops asking people to add them to new tasks.
- **Progress** is computed, never typed: done tasks over all tasks in the feature, plus the counts that explain the rest (running, ready, waiting on something, needs you, in review, shipped). A feature is *done* when every task is done and *shipped* once the release it's aimed at is promoted (the board already knows which tasks shipped).
- **Who edits:** the owner on the board and CLI (`features add|show|modify|list`). Agents may add a feature when they shape an idea (so the spec's tasks come with it) but never change a release, start a chase, or delete one.

### 2. The roadmap view
A new **Roadmap** view (next to Board and List). Releases are columns or rows in version order, then *Unplanned*; each holds its feature cards: title, a progress bar with the counts, the next blocker in words ("waits for BRK-50, a task for you"), and a chip when a chase is on. Open a feature for its tasks as a dependency-ordered list (the Graph view's data) with each task's state. A feature aimed at a release already promoted shows as shipped and folds away. Empty and first-run: a fresh install shows "No features yet" with the suggested tags and **New feature**. A phone gets a single column. Both themes, reduced motion respected, no colour-only states, per the brand guide.

### 3. Chase mode
The owner presses **Chase** on a feature (or `breakaway chase <slug>`). While the chase is on, the board starts agents for the feature:

1. **What it works on.** The feature's tasks that are open and `+agent`, plus every task that blocks one of them, found by following `depends` through the whole board (any area, any repository). Pulled-in blockers are marked "in chase because it blocks X" and don't need the feature tag.
2. **When it starts them.** On the same tick as auto-start (an alarm after anything that could unblock a task, and the cron). A task that's ready (the existing `agentBlocker` is null) starts straight away, **without waiting for the others to finish**: ready tasks start together, up to the limits below, and a task that becomes ready when a blocker's pull request merges starts on the next tick.
3. **The limits it never exceeds.** The shared agent slots and hourly budget, each repository's own cap and its routine's hourly limit, and a repository whose routine isn't connected (the same `repoRoom` and `repoCapBlocker` checks the other starters use). A chase doesn't get a budget of its own, and it never uses Force start ([IDEA-30](IDEA-30-new-agent.md), section 4). Order when slots run short: security fixes, general agents ([IDEA-30](IDEA-30-new-agent.md), section 3), and other auto-start tasks first, then the chase, nearest to unblocking the most work first (the ranking `startNext` uses, then by how many chase tasks a task unblocks).
4. **Areas.** The one-agent-per-area rule (to keep agents out of each other's files) is relaxed inside a chase up to a per-feature **parallelism** (default 3), because the owner chose speed; two agents in one area still never start on tasks that `related` each other. See the decision below.
5. **What it does at something only the owner can do.** It never starts, answers, or merges these; it shows them as **Needs you**, listed on the feature with what each unblocks, and keeps going on every branch that doesn't wait for them:
   - a `+decide` task or one with open questions: opens it on the board;
   - a `+owner` task (a manual step): the task, with its done when;
   - an open pull request that would close a chase task: **Merge** is the owner's, and the chase counts it as in review, not done. A task whose blocker's pull request is merged but not yet seen is picked up by the existing reconcile;
   - a `+agent` task that's been refused twice (failed starts, an agent that released it with a comment): shown as **Stuck** with the agent's last comment, not retried forever.
6. **When nothing can run.** If no agent is running, none can start, and Needs you or Stuck holds the rest, the chase **pings the owner once** (`blocked`, the existing ping, which pushes), naming the one thing that frees the most work. After that it stays on and starts again by itself when the owner acts. Capacity limits are not stalls: "waiting for a free slot" is shown, never pinged.
7. **It ends.** Automatically when every task in the chase is done or in review with nothing else to start (state `done`, one inbox note, no push), or when the owner presses **Stop chase**. Stopping starts nothing new and **leaves running agents alone** (they finish and open their pull requests); a stopped or ended chase can be started again.
8. **Across repositories.** The board starts an agent for a blocker in another repository through *that* repository's routine and prompt, in its own checkout, so cross-repository blockers work when that repository is connected. If it isn't, the blocker shows as Needs you: "connect <repo>". The chase and its progress are shown only on the board, never written into a repository, so a public repository learns nothing about another's tasks.
9. **Visibility.** The feature card and the Agents view show the chase: a live line ("3 running, 2 ready, 1 waiting for you"), the running agents with their live output, Needs you and Stuck, and the next ones in the order they'd start with the reason each is held (the autostart queue's wording). Activity records Chase started, stopped, ended, and each start (`trigger: 'chase'`), so the budget is accountable. `breakaway chase` prints the same, and `--dry-run` shows what would start now without starting it.
10. **Safety.** A chase is off by default and never survives a board-wide agents switch (the owner turning agents off stops it from starting anything), the auto-start toggle is separate and doesn't gate it, and a chase never sets `--autostart` on a task. A chase can't be started on a feature with no tasks.

### 4. Data and API
- **Storage:** a `features` table in the Durable Object's SQLite next to routines; its migration is idempotent and a fresh install has none. Chase state (`on`, `startedAt`, `parallel`, `stalledPingAt`) is columns on that record. Tasks gain nothing.
- **API:** `GET/POST /api/features`, `GET/PATCH/DELETE /api/features/:slug` (the view includes progress, tasks, Needs you, Stuck, and the queue), `POST /api/features/:slug/chase` (`{ on, parallel, dryRun }`). The rest of the auth is the board's.
- **Engine:** `chaseQueue(views)` computes who starts and why each other task waits (reusing `repoRoom`, `repoCapBlocker`, `agentBlocker`, `rank`); `chaseTick()` starts them through `startAgent(…, { trigger: 'chase' })`, called from `autostartTick`'s alarm and cron. Tests first, in the Workers pool, with GitHub and Claude mocked.
- **Privacy:** no new data, nothing about people.

### 5. Teaching agents
The core needs one line in "Shaping an idea": when you make tasks for an idea, give them one feature tag and add the feature (`tasks features add`) rather than a release tag. The CLI and skill are versioned copied files, so `CLI_VERSION` and `CLI_FINGERPRINT` move with that change.

## Decisions for the owner
Asked on the board as a decision (BRK-82): 
1. **One agent per area in a chase.** Keep the rule, relax it to a per-feature number (recommended, default 3), or drop it.
2. **A task in two features.** Allow, or one feature per task (recommended).
3. **Release on the task or the feature.** The feature's (recommended), keeping release tags only as a fallback.
4. **A chase's priority against auto-start.** After it (recommended), equal, or before.

## Out of scope
Features across installs, sub-features, estimates and dates, burn-down charts, a chase that merges, deploys, or answers decisions, killing a running agent when a chase stops, chase schedules (start Friday), and moving existing release tags (they stay as they are).

## Open questions
- Whether the roadmap should also show the one-off tasks that have a release tag and no feature, or only features. The spec assumes it shows them under the release as "other tasks".
- Whether a feature's `shipped` should wait for the owner to press Promote or follow the release tag on GitHub. The spec assumes the first, using the shipped data the board already has.

## Done when
Built in order, each its own pull request, tests first:
1. **Features**: the record, the tag membership, progress, suggested features, and the API; `pnpm interop` still passes.
2. **Chase engine**: the queue, the tick, the limits, Needs you and Stuck, the stall ping, and the end.
3. **CLI**: `features`, `chase`, and `--dry-run`; `CLI_VERSION` and the fingerprint move.
4. **Web**: the Roadmap view, the feature card and detail, and Chase in the feature and the Agents view.
5. **Docs and prompts**: `docs/tasks.md`, the core's one line, the skill, and the decision log entry for the settled choices.
