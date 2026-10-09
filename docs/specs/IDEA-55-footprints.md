# IDEA-55 · Footprints: the board schedules agents by the files each task will touch

Task: IDEA-55 on the board · Status: draft · Feature: `footprints`, aimed at 2.1.0 (the owner's note: chase it before `people`)

The idea names the chase. The owner widened it while it was shaped: "i think this should be expanded to all agents, not single chases". So footprints decide what every starter on the board starts: a chase, auto-start, and `agents next`. They added: "claims can target individual files, entire directories, or wildcard globs (e.g., an agent "claims" apps/web/api/**" and "claims should ahve a ttl, never indefinite". Then they brought notes from sparring with another agent on how multi-agent tools handle it: advisory claims an agent asks for before it touches a path, a conflict answer that tells the second agent to back off, short leases kept alive by heartbeats, and watching the working tree for "dirty paths" an agent changed without claiming. So what an agent changes is a **path claim** with a short lease (section 1a), its working tree is watched (section 1b), and footprints decide what starts (section 3).

## Problem

The board keeps agents out of each other's files with blunt rules. Outside a chase, auto-start (`autostartQueue`) and `agents next` (`startNext`, both in `src/store-agents.js`) start one agent per area. A chase ([IDEA-28](IDEA-28-features-and-chase.md), section 3.4, `chaseQueue` in `src/store-chase.js`) allows up to `parallel` agents per area, but never two at once on tasks in one area that are `related`. All of them guess at files from labels: two auto-start tasks in `board` that change unrelated files take turns; in a chase, two related tasks in `web` that touch different views wait for each other (WEB-97 then WEB-98 in an earlier chase), while two unrelated tasks that both change `src/store-chase.js` start together and meet as a merge conflict, which the chase then spends a fix agent on. The agents make up for it by hand: they post the files they'll touch on the peloton, and the relation-fixer routine writes "Footprint" comments on tasks.

The board already sees most of what it needs. GitHub tells it which files every pull request touches (`fetchWorkers` in `src/store-github.js` reads them for merged ones today, but keeps only the Workers they map to), a task's description and spec name files (`filesNamed` in `src/similar.js`), and every agent's check-in says what it will change.

## Fit

- **The person who runs the board decides.** Footprints only change which ready task a starter starts first, and when the owner presses Start on one task they warn, never refuse. They start nothing a starter wouldn't and never merge. Path claims are advisory: the edit hook turns an agent away from a path another agent claims with a message it reads, nothing is locked, a board that's down lets every edit through, and the owner can release any claim.
- **An install keeps its data.** Everything comes from GitHub, which the owner connected, and from the board itself. No model call: the prediction is plain code, so it costs nothing and gives the same answer every time.
- **Taskwarrior stays first-class.** Footprints live in a table of their own, not on the task, so sync and the task model don't change.
- **One claim per task.** Unchanged: a task still has one holder. A path claim is held by that task, ends with it, and never outlives its time limit; an agent's task claim lapses only when it has gone silent with no pull request open (section 1c), which is the board releasing for a holder that's gone.

## Design

### 1. What a footprint is

A task's footprint is a set of **patterns** in its repository, each with where it came from:

- a file: `src/store-chase.js`;
- a folder, ending in `/`: `web/src/views/`, which covers every file under it (the same as `web/src/views/**`);
- a glob: `apps/web/api/**`, `test/*.test.js`, `src/infra-*.js`, with `*` (any name in one folder), `**` (any depth), and `?` (one character), matched against paths from the repository's root. No braces or negation: a pattern list says the same.

Two footprints **overlap** when a pattern of one can match a path a pattern of the other matches. The check is conservative and needs no file list: compare the two patterns segment by segment, where `**` matches any number of segments and a segment with `*` or `?` matches a literal one it could match, and call it an overlap unless some segment rules it out. *Why conservative:* a false overlap only makes a task wait; a missed one costs a merge conflict.

A footprint is one of three, and the board uses the best it has:

1. **Actual**: the task's dirty paths (section 1b) and its open pull request's files, read again whenever its head changes.
2. **Claimed**: the patterns the task holds live claims on (section 1a).
3. **Predicted**: what the board expects before an agent starts (section 2). A prediction is never a claim: it only decides what starts.

A running task's footprint is its live claims and its actual paths together, or its predicted one until it has either. *Why:* the agent knows better than a guess within minutes of starting, and its working tree and pull request know for certain.

**Shared files don't count.** Files most changes touch and git merges cleanly or tools regenerate (the lockfile, `CHANGELOG.md`, `release.json`, generated files like `plugin/`'s) never make two footprints overlap. The list is each repository's lockfiles plus the files more than 40% of its last 50 merged pull requests touched, recomputed on sync and shown with the footprint, so nobody wonders why a file was ignored.

*Storage:* a `footprints` table in the Durable Object (`uuid`, `kind`: `predicted` or `actual`, `paths` as JSON with each path's source, `head` for actual, `updated`), a `path_claims` table (`uuid`, `agent`, `pattern`, `claimed`, `heartbeat`, `ceiling`; expired rows are swept on the alarm and kept a day for Activity), and the file list (with renamed files' old names) kept on each pull request's row in `gh_pulls`. Merged pull requests' files are read the way `fetchWorkers` reads them now, within its per-sync limit, whether or not the repository has a deploy pipeline. The migration is idempotent and a fresh install has none.

### 1a. Path claims: advisory, asked for before an edit, answered with a conflict

An agent holding a task claims each path before it changes it. Claims are **advisory**: they're the board's record and its answer, never a lock on the file system or git, so a refused edit is a message the agent reads, not a failed save it can't explain.

- **The edit hook asks for it.** A synchronous `PreToolUse` hook on the edit tools (`Edit|Write|MultiEdit|NotebookEdit`), added to `sessionHooks()` and the plugin, claims the file the edit names before the edit runs. Granted (or already the task's own): the edit goes ahead, silently. Refused: the hook denies the edit with the reason, which Claude reads: "`apps/web/api/routes.js` is claimed by claude-web-40 on WEB-40 (`apps/web/api/**`, active 2 minutes ago). Back off: change other files, ask @claude-web-40 on the peloton, or if your task can't go on without it, comment why and release it so the board starts something else." The session hooks today are `async`, and an async hook can't block, so this one is synchronous, with a short timeout, and denies with `permissionDecision: "deny"` and the reason (source: the `PreToolUse` decision control and the `async` field in Claude Code's hooks reference, https://code.claude.com/docs/en/hooks). If the board can't be reached in time, it lets the edit through and says so in the agent's next context: advisory means a board that's down never stops work.
- **Broader claims by hand.** `peloton checkin --files <patterns>` at check-in and `tasks paths <ID> --claim <patterns>` claim folders and globs ahead of the edits (`apps/web/api/**`); `--release <patterns>` gives them back. The CLI answers an overlap with the same refusal and exits non-zero, and the API's `POST /api/tasks/:id/paths` answers `409`, like a taken task claim. Without `--files`, a check-in's text is read for paths the way `filesNamed` reads them, and those are claimed too.
- **What overlaps.** A pattern is refused when it overlaps another task's live claim (section 1's check). The rest of a request is granted. Two patterns of the same task never conflict.
- **The owner decides.** The owner can release any claim (`tasks paths <ID> --release <pattern>` as the owner, or on the task panel), and a claim never stops the owner's own edits.
- **Agents without the hook** (another agent provider, a person's session without the plugin) claim with the CLI; their pushes and pull requests still show what they changed (section 1b).

**Every claim runs out: a short lease kept alive by heartbeats.** A claim lasts **10 minutes** after the task's last heartbeat. Every session hook call the agent's session already makes (each tool call, check-in, and stop) is a heartbeat and renews every claim the task holds, so a working agent never thinks about it. An agent that crashes, hangs, or goes quiet loses its claims within 10 minutes; the alarm sweeps them, and the paths are free. A claim also has a **4-hour ceiling** from when it was made, so an agent stuck in a loop that still calls tools gives its paths back; its next edit claims them again, competing fairly with anyone who asked meanwhile. All of a task's claims end at once when its task claim ends (release, the pull request merges or closes, a takeover). An open pull request's files hold starts (section 3) only while its head changed in the last 24 hours or an agent holds its task; after that they show and hold nothing. Nothing is held indefinitely. *Why these numbers:* a session hook fires on every tool call, so 10 minutes of silence means the session has stopped or is waiting (a waiting agent with an open pull request is covered by the pull request's files), and 4 hours is longer than nearly every run. The build task checks both against breakaway's own agent logs and says what it found.

### 1b. Dirty paths: what an agent changed, claimed or not

The board doesn't rely on agents asking. The session hook also reports the agent's **dirty paths**: what `git status --porcelain` and `git diff --name-only` against the default branch's merge base list, on edit-tool calls and at stop, at most once a minute, paths only, never contents. They join the task's footprint as **dirty**, next to its pull request's files once it has one.

- A dirty path nobody else claims is claimed for the task, so a Bash `sed` or a generator's output is covered too.
- A dirty path another task's live claim matches is a **conflict**, flagged at once: the agent hears it in its next hook context ("you changed `web/src/views/GraphView.jsx`, which claude-web-40 claims on WEB-40"), and the board posts once on the peloton, mentioning both agents (section 4). It doesn't undo anything: only the two agents can settle it, and the second one backs off by default.
- Pushes count the same way: a task's branch and its pull request's files are dirty paths for agents whose session doesn't report them.

### 1c. Task claims lapse too, for agents

The owner agreed (9 Oct 2026) that a task's own claim gets a time limit as well, kept by the same heartbeats, and only where it's safe:

- **An agent's claim with no open pull request lapses after 60 minutes without a heartbeat** (no tool call, check-in, or `peloton listen`). The board releases it with a comment ("lapsed: claude-brk-12 silent since 14:20 UTC"), keeps any `Not pushed:` handover and names the branch if one was pushed, and the task is ready again for the next start. *Why 60, not 10:* releasing a task costs more than freeing a path; it leaves room for a long test run and a cloud session's idle pause.
- **An agent's claim with an open pull request doesn't lapse**: the pull request is its lease, because that agent waits on CI or on the owner and may be silent for hours. Fix agents can already take over from a quiet one, and its path claims lapse as above.
- **A person's claim never lapses.** People don't send heartbeats. After 3 days without activity on the task the board marks it stale for the owner, and does nothing else.
- **"One claim per task" holds.** A task still has exactly one holder at a time; a lapse is the board releasing for a holder that's gone, and claiming stays atomic. An agent whose claim lapsed and comes back finds it released and claims again, or stops if someone else has it.

### 2. The prediction

Plain code in `src/footprint.js`, pure so it's tested on fixtures. In order of weight:

1. **What the task names**: paths in its description, done when, comments (the relation-fixer's "Footprint" comments among them), and its spec, and in the description of tasks it's `related` to only where they name the same folder. A named path is kept as named.
2. **What tasks like it changed**: the files merged pull requests of completed tasks in the same repository touched, for the tasks most like this one (`similarTasks`' scoring, the five closest that have a merged pull request). A file at least two of them changed is kept; otherwise its folder, one level up, so a weak guess is wide rather than wrong.
3. **Nothing found**: the footprint is **unknown**, and the task is scheduled the old way (section 3).

*How good is enough.* A miss costs a merge conflict, which the chase already fixes, and lasts only until the agent claims its paths. So the prediction doesn't have to be right, only right often enough. The board measures it: when a task's pull request merges, it compares the predicted footprint with the files the pull request changed (the share of changed files the prediction covered) and keeps the last 20 per repository. When that share is under half, the starters stop trusting predictions in that repository, treat every predicted footprint there as unknown, and say so in their queues; claims and actual footprints still count. *Why a share of files covered, not exactness:* a wide prediction that holds a task back a little is cheap; a narrow one that misses a file is what causes the conflict.

### 3. How every starter uses them

One rule in the store, `collision(t, beside)`, used by every starter: `chaseQueue`, `autostartQueue`, and `startNext`. `beside` is the running agents plus what the starter is starting this tick. It answers null, or why the task waits.

- **A ready task whose footprint is known** waits only when it overlaps a running task or one starting this tick, whatever their area and whether or not they're `related`. The reason, in the queues' words: "it would touch `src/store-chase.js`, which BRK-12 is changing (claude-brk-12)".
- **A task whose footprint is unknown, or a running task whose footprint is unknown,** falls back to today's rule for that starter: one agent per area outside a chase, never two related tasks in one area inside one.
- **How many per area.** The area rule was only ever about files, so with known footprints it gives way to a ceiling: a chase keeps its `parallel` (the owner's speed control, default 3); auto-start and `agents next` get the same ceiling as a board-wide setting, **Agents per area** in Settings, Agents, default 3, where 1 is today's rule. *Why a ceiling at all:* footprints are a better reason to hold a task, not a reason to start more in one place than the owner wants. Slots, the hourly budget, each repository's caps, and a chase's review cap stay as they are.
- **Who's exempt, as today.** A security fix doesn't wait for files. A general agent and a kickoff's run have no footprint until they check in, and the owner pressed for them, so nothing holds them back; once they claim paths, their claims hold others. Refine and review agents change no code and neither hold nor wait. A fix agent (Fix with an agent, or a chase's fix) uses its pull request's actual footprint.
- **The owner's Start** on one task never refuses for a footprint: the Start button and `agents start` say "BRK-12 (claude-brk-12) is changing `src/store-chase.js`" and start it when pressed again or with `--anyway`. *Why:* the person who runs the board decides; the warning is so they decide knowing.
- **Order** is unchanged in each starter (security fixes, then what the owner pressed, then auto-start, then the chase, each by its own ranking). Of two overlapping ready tasks, the one ahead starts.

The auto-start queue on the Agents view, `agents next --dry-run`, `chase --dry-run`, and the feature's chase show each held task's footprint reason.

### 4. Telling the agents

- **When an agent starts,** its payload names the footprints of the agents already running in its repository, one line each: `Riding beside you: BRK-12 (claude-brk-12) is changing src/store-chase.js, test/chase.test.js`. It's information, like every peloton post.
- **When an agent checks in,** the output lists each rider's footprint next to its name, and says which of the new agent's paths overlap one.
- **When an agent strays** (a dirty path or its pull request's file matches another task's live claim, section 1b), the board posts once on the peloton, as the board, mentioning both agents: "@claude-brk-12 @claude-web-40: both of you are changing `web/src/views/GraphView.jsx`; agree who goes first." Once per pair and path, never a block or a ping. *Why not block:* the agent may be right that the change needs the file, and only the two of them can settle the order.
- **When a claim runs out** at its ceiling, the agent's next edit claims it again by itself; if someone else took it meanwhile, that edit is refused like any other.
- **The core prompt** (`prompts/core.md`, "Riding the peloton" and the check-in step) says: claim a folder or glob with `--files` when you know you'll change several files there, claim narrowly, back off from a refused path (other files, ask its holder, or release the task), and that claims run out when you go quiet. It replaces asking agents to list files by hand. It stays about the board, as every repository copies it.

### 5. Showing footprints

- **The task panel and `tasks show`**: a Footprint section with the patterns, each marked predicted, claimed (with when it runs out), or from the pull request, and the shared files left out.
- **The Graph view** shows no footprints: it draws only what waits for what. (WEB-130 gave its nodes a footprint list on hover and focus and a dashed "shares files" edge between overlapping tasks; the owner found it too much, and WEB-131 took both out.)
- **The Agents view and the feature's chase**: the held tasks' reasons, as above, and the prediction's hit rate for the repository ("predictions covered 78% of the files the last 20 merged tasks changed").
- **The API and MCP server**: `GET /api/tasks/:id/footprint` and a `footprint` read tool return the same.

## Out of scope

- Footprints by symbol or function, structural merges, and live edits: that's IDEA-54, on breakaway git.
- Asking a model to predict footprints.
- Warning on claim when another open change touches the same files: BRK-19, on Artifacts, can build on the stored file lists later.
- Mandatory locks (on the file system or git) and undoing an agent's changes: claims are advisory, refused at the edit tool, and a conflict is flagged, not reverted.

## Open questions

- Are a 10-minute lease, a 4-hour ceiling, and a 60-minute lapse for task claims right? The build tasks check them against breakaway's agent logs.
- Is 40% of the last 50 merged pull requests the right line for a shared file? The build task picks it from breakaway's own history and says what it found.
- Should the owner be able to mark a file shared, or never shared, in Repo settings? Left out of the first version; added if the computed list gets it wrong.

## Done when

One pull request each, all waiting for this spec to merge, in the feature `footprints` (2.1.0):

1. **BRK-316 · Keep the files each pull request touches**: merged and open pull requests' file lists in `gh_pulls`, within the sync's limits, with tests.
2. **BRK-317 · Predict a task's footprint**: `src/footprint.js`, pure: paths named, tasks like it, shared files, glob matching and the conservative overlap of two patterns, and the hit rate, with tests on fixtures.
3. **BRK-318 · Footprints and path claims in the store, the CLI, and the API**: the tables, path claims with globs and their `409`, leases renewed by heartbeats with the sweep and the ceiling, dirty paths and pull requests' files as actual, `tasks paths`, `show`, the routes, and the MCP read. Waits for 1 and 2.
4. **BRK-319 · Every starter schedules by footprints**: the shared rule in section 3 in `chaseQueue`, `autostartQueue`, and `startNext`, Agents per area, the exemptions, the owner's Start warning, the reasons, and the fallback. Waits for 3.
5. **BRK-320 · Claim at the edit, and tell the riders who touches what**: the synchronous edit hook in `sessionHooks()` and the plugin (claim, refuse with the reason, let through when the board is down), dirty paths from the session hook, the start payload's line, the check-in's output, the conflict note, and the core prompt, for every agent. Waits for 3.
6. **WEB-130 · Footprints on the board**: the task panel, the held tasks' reasons on the chase and the Agents view, the hit rate, Agents per area in Settings, the Start warning, and the Graph view's shared-files edges. Waits for 3 and 4.
7. **DOC-49 · Document footprints**: the manual, the site's docs, and IDEA-28's section 3.4 pointing here. Waits for 4, 5, 6, and 8.
8. **BRK-321 · Task claims lapse by heartbeat**: section 1c: an agent's claim without an open pull request lapses after 60 silent minutes with a comment and the task ready again; with one, it holds; a person's is marked stale after 3 days. Waits for 3.

## How to check it

Once the tasks are built and the board is deployed:

1. Open a feature with a few ready tasks in one area, say `web`, two of which are linked as related but change different views. Press **Chase**.
2. On the feature's chase, both related tasks start together; nothing says "never two at once".
3. Make two ready tasks whose descriptions both name the same file (`src/store-chase.js`). Chase them: one starts, and the other waits with "it would touch src/store-chase.js, which <the first> is changing".
4. Open either running task: its Footprint lists the files, marked predicted, then claimed (with when the claim runs out) once its agent checks in, then from the pull request once it opens one.
5. Outside a chase: turn auto-start on for two ready tasks in one area that name different files. Both start together. Turn it on for two that name the same file: one starts, and the Agents view says why the other waits.
6. Press Start on a task whose file a running agent is changing: the board warns you which agent and file, and starts it if you press again.
7. Open the Graph view: it shows only the dependency arrows, with no footprints and no "shares files" line.
8. On the peloton, a new agent's check-in lists what the others are changing. An agent that claims `apps/web/api/**` while another holds a file under it is told who holds it and until when. If one starts changing another's claimed file, the board posts a note naming both.
9. Have an agent try to edit a file another agent claims: its edit is refused with who holds it, and it carries on with other files.
10. Stop an agent's session mid-task: within about 10 minutes its claims are gone from the task's Footprint, and the files are free. Within about an hour, if it opened no pull request, the task itself is released with a "lapsed" comment and is ready to start again.
