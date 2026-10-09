# IDEA-55 · Footprints: the board schedules agents by the files each task will touch

Task: IDEA-55 on the board · Status: draft · Feature: `footprints`, aimed at 2.1.0 (the owner's note: chase it before `people`)

The idea names the chase. The owner widened it while it was shaped: "i think this should be expanded to all agents, not single chases". So footprints decide what every starter on the board starts: a chase, auto-start, and `agents next`.

## Problem

The board keeps agents out of each other's files with blunt rules. Outside a chase, auto-start (`autostartQueue`) and `agents next` (`startNext`, both in `src/store-agents.js`) start one agent per area. A chase ([IDEA-28](IDEA-28-features-and-chase.md), section 3.4, `chaseQueue` in `src/store-chase.js`) allows up to `parallel` agents per area, but never two at once on tasks in one area that are `related`. All of them guess at files from labels: two auto-start tasks in `board` that change unrelated files take turns; in a chase, two related tasks in `web` that touch different views wait for each other (WEB-97 then WEB-98 in an earlier chase), while two unrelated tasks that both change `src/store-chase.js` start together and meet as a merge conflict, which the chase then spends a fix agent on. The agents make up for it by hand: they post the files they'll touch on the peloton, and the relation-fixer routine writes "Footprint" comments on tasks.

The board already sees most of what it needs. GitHub tells it which files every pull request touches (`fetchWorkers` in `src/store-github.js` reads them for merged ones today, but keeps only the Workers they map to), a task's description and spec name files (`filesNamed` in `src/similar.js`), and every agent's check-in says what it will change.

## Fit

- **The person who runs the board decides.** Footprints only change which ready task a starter starts first, and when the owner presses Start on one task they warn, never refuse. They start nothing a starter wouldn't, never merge, and never block an agent that's running: straying is a note, not a stop.
- **An install keeps its data.** Everything comes from GitHub, which the owner connected, and from the board itself. No model call: the prediction is plain code, so it costs nothing and gives the same answer every time.
- **Taskwarrior stays first-class.** Footprints live in a table of their own, not on the task, so sync and the task model don't change.
- **One claim per task.** Unchanged. A footprint isn't a claim: it's what the board expects a claim to touch.

## Design

### 1. What a footprint is

A task's footprint is a set of paths in its repository: files (`src/store-chase.js`) and folders (`web/src/views/`), each with where it came from. A folder covers every file under it. Two footprints **overlap** when they share a file, or one's folder holds a file or folder of the other's.

A footprint is one of three, and the board uses the best it has:

1. **Actual**: the files of the task's open pull request, read again whenever its head changes.
2. **Declared**: what the agent said it will change, once it checks in. `peloton checkin` takes `--files <paths>` (comma-separated, folders allowed); without it, the board takes the paths the check-in's text names, the way `filesNamed` reads them. A later check-in or `tasks footprint <ID> --add <paths>` adds to it.
3. **Predicted**: what the board expects before an agent starts (section 2).

A running task's footprint is its actual and declared paths together, or its predicted one until it has either. *Why:* the agent knows better than a guess within minutes of starting, and the pull request knows for certain; keeping the declared paths next to the pull request's covers what the agent hasn't pushed yet.

**Shared files don't count.** Files most changes touch and git merges cleanly or tools regenerate (the lockfile, `CHANGELOG.md`, `release.json`, generated files like `plugin/`'s) never make two footprints overlap. The list is each repository's lockfiles plus the files more than 40% of its last 50 merged pull requests touched, recomputed on sync and shown with the footprint, so nobody wonders why a file was ignored.

*Storage:* a `footprints` table in the Durable Object (`uuid`, `kind`: `predicted`, `declared`, or `actual`, `paths` as JSON with each path's source, `head` for actual, `updated`), and the file list (with renamed files' old names) kept on each pull request's row in `gh_pulls`. Merged pull requests' files are read the way `fetchWorkers` reads them now, within its per-sync limit, whether or not the repository has a deploy pipeline. The migration is idempotent and a fresh install has none.

### 2. The prediction

Plain code in `src/footprint.js`, pure so it's tested on fixtures. In order of weight:

1. **What the task names**: paths in its description, done when, comments (the relation-fixer's "Footprint" comments among them), and its spec, and in the description of tasks it's `related` to only where they name the same folder. A named path is kept as named.
2. **What tasks like it changed**: the files merged pull requests of completed tasks in the same repository touched, for the tasks most like this one (`similarTasks`' scoring, the five closest that have a merged pull request). A file at least two of them changed is kept; otherwise its folder, one level up, so a weak guess is wide rather than wrong.
3. **Nothing found**: the footprint is **unknown**, and the task is scheduled the old way (section 3).

*How good is enough.* A miss costs a merge conflict, which the chase already fixes, and lasts only until the agent checks in. So the prediction doesn't have to be right, only right often enough. The board measures it: when a task's pull request merges, it compares the predicted footprint with the files the pull request changed (the share of changed files the prediction covered) and keeps the last 20 per repository. When that share is under half, the chase stops trusting predictions in that repository, treats every predicted footprint there as unknown, and says so in its queue; declared and actual footprints still count. *Why a share of files covered, not exactness:* a wide prediction that holds a task back a little is cheap; a narrow one that misses a file is what causes the conflict.

### 3. How every starter uses them

One rule in the store, `collision(t, beside)`, used by every starter: `chaseQueue`, `autostartQueue`, and `startNext`. `beside` is the running agents plus what the starter is starting this tick. It answers null, or why the task waits.

- **A ready task whose footprint is known** waits only when it overlaps a running task or one starting this tick, whatever their area and whether or not they're `related`. The reason, in the queues' words: "it would touch `src/store-chase.js`, which BRK-12 is changing (claude-brk-12)".
- **A task whose footprint is unknown, or a running task whose footprint is unknown,** falls back to today's rule for that starter: one agent per area outside a chase, never two related tasks in one area inside one.
- **How many per area.** The area rule was only ever about files, so with known footprints it gives way to a ceiling: a chase keeps its `parallel` (the owner's speed control, default 3); auto-start and `agents next` get the same ceiling as a board-wide setting, **Agents per area** in Settings, Agents, default 3, where 1 is today's rule. *Why a ceiling at all:* footprints are a better reason to hold a task, not a reason to start more in one place than the owner wants. Slots, the hourly budget, each repository's caps, and a chase's review cap stay as they are.
- **Who's exempt, as today.** A security fix doesn't wait for files. A general agent and a kickoff's run have no footprint until they check in, and the owner pressed for them, so nothing holds them back; once they check in, their declared footprint holds others. Refine and review agents change no code and neither hold nor wait. A fix agent (Fix with an agent, or a chase's fix) uses its pull request's actual footprint.
- **The owner's Start** on one task never refuses for a footprint: the Start button and `agents start` say "BRK-12 (claude-brk-12) is changing `src/store-chase.js`" and start it when pressed again or with `--anyway`. *Why:* the person who runs the board decides; the warning is so they decide knowing.
- **Order** is unchanged in each starter (security fixes, then what the owner pressed, then auto-start, then the chase, each by its own ranking). Of two overlapping ready tasks, the one ahead starts.

The auto-start queue on the Agents view, `agents next --dry-run`, `chase --dry-run`, and the feature's chase show each held task's footprint reason.

### 4. Telling the agents

- **When an agent starts,** its payload names the footprints of the agents already running in its repository, one line each: `Riding beside you: BRK-12 (claude-brk-12) is changing src/store-chase.js, test/chase.test.js`. It's information, like every peloton post.
- **When an agent checks in,** the output lists each rider's footprint next to its name, and says which of the new agent's paths overlap one.
- **When an agent strays** (its declared or actual footprint grows into a path another running task's footprint holds), the board posts once on the peloton, as the board, mentioning both agents: "@claude-brk-12 @claude-web-40: both of you are changing `web/src/views/GraphView.jsx`; agree who goes first." Once per pair and path, never a block or a ping. *Why not block:* the agent may be right that the change needs the file, and only the two of them can settle the order.
- **The core prompt** (`prompts/core.md`, "Riding the peloton" and the check-in step) says to pass `--files` and that the board shows who touches what, in place of asking agents to list files by hand. It stays about the board, as every repository copies it.

### 5. Showing footprints

- **The task panel and `tasks show`**: a Footprint section with the paths, each marked predicted, declared, or from the pull request, and the shared files left out.
- **The Graph view**: a task's node shows its footprint as a short list on hover and focus, and two open tasks whose footprints overlap get a dashed "shares files" edge between them, labelled with the first shared path. Both themes, no colour-only state, reduced motion respected.
- **The Agents view and the feature's chase**: the held tasks' reasons, as above, and the prediction's hit rate for the repository ("predictions covered 78% of the files the last 20 merged tasks changed").
- **The API and MCP server**: `GET /api/tasks/:id/footprint` and a `footprint` read tool return the same.

## Out of scope

- Footprints by symbol or function, structural merges, and live edits: that's IDEA-54, on breakaway git.
- Asking a model to predict footprints.
- Warning on claim when another open change touches the same files: BRK-19, on Artifacts, can build on the stored file lists later.
- Blocking or stopping an agent for straying.

## Open questions

- Is 40% of the last 50 merged pull requests the right line for a shared file? The build task picks it from breakaway's own history and says what it found.
- Should the owner be able to mark a file shared, or never shared, in Repo settings? Left out of the first version; added if the computed list gets it wrong.

## Done when

One pull request each, all waiting for this spec to merge, in the feature `footprints` (2.1.0):

1. **BRK-316 · Keep the files each pull request touches**: merged and open pull requests' file lists in `gh_pulls`, within the sync's limits, with tests.
2. **BRK-317 · Predict a task's footprint**: `src/footprint.js`, pure: paths named, tasks like it, shared files, overlap, and the hit rate, with tests on fixtures.
3. **BRK-318 · Footprints in the store, the CLI, and the API**: the table, declared from check-ins and `--files`, actual from the pull request, `tasks footprint`, `show`, the route, and the MCP read. Waits for 1 and 2.
4. **BRK-319 · Every starter schedules by footprints**: the shared rule in section 3 in `chaseQueue`, `autostartQueue`, and `startNext`, Agents per area, the exemptions, the owner's Start warning, the reasons, and the fallback. Waits for 3.
5. **BRK-320 · Tell the riders who touches what**: the start payload's line, the check-in's output, the straying note, and the core prompt, for every agent. Waits for 3.
6. **WEB-130 · Footprints on the board**: the task panel, the held tasks' reasons on the chase and the Agents view, the hit rate, Agents per area in Settings, the Start warning, and the Graph view's shared-files edges. Waits for 3 and 4.
7. **DOC-49 · Document footprints**: the manual, the site's docs, and IDEA-28's section 3.4 pointing here. Waits for 4, 5, and 6.

## How to check it

Once the tasks are built and the board is deployed:

1. Open a feature with a few ready tasks in one area, say `web`, two of which are linked as related but change different views. Press **Chase**.
2. On the feature's chase, both related tasks start together; nothing says "never two at once".
3. Make two ready tasks whose descriptions both name the same file (`src/store-chase.js`). Chase them: one starts, and the other waits with "it would touch src/store-chase.js, which <the first> is changing".
4. Open either running task: its Footprint lists the files, marked predicted, then declared once its agent checks in, then from the pull request once it opens one.
5. Outside a chase: turn auto-start on for two ready tasks in one area that name different files. Both start together. Turn it on for two that name the same file: one starts, and the Agents view says why the other waits.
6. Press Start on a task whose file a running agent is changing: the board warns you which agent and file, and starts it if you press again.
7. Open the Graph view: the two tasks that share a file are joined by a dashed "shares files" line.
8. On the peloton, a new agent's check-in lists what the others are changing; if one starts changing another's file, the board posts a note naming both.
