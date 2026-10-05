# IDEA-5 · A real structure for tasks: description, fields, and comments

Task: IDEA-5 on the board · Status: built (before the move to breakaway, under the first install's work IDs)

## Problem
A task is a title plus a stream of notes. The owner writes an idea as one line and an agent has nowhere to put a longer brief, so briefs pile up as notes (IDEA-4 needed a second note for its full text). To learn what a task is for, you read the whole stream, and nothing says which note is current. Notes also don't say who wrote them.

The board is used by one owner and agents, so the answer is small: one place for the current brief, a few fields that earn their place, and a comment thread. No status ceremony, no reporting.

## Fit
Nothing in the [decision log](../decisions.md) is touched. The board holds no personal data or secrets, and that still holds. The Taskwarrior sync stays first-class: every new field is a plain property Taskwarrior can carry, so `task sync` keeps working and nothing needs a schema migration in D1 (the board's data is TaskChampion operations in its Durable Object).

## Design

### Description and comments are different things
- **Description** (`brief`): Markdown, the current brief. It's *edited in place*, always shown first, and holds what the task is for and why. Whoever reads it can trust it's the latest, because comments never change it. It records who last edited it and when (`brief_by`); older versions stay in the sync history and show up in Activity as "description changed".
- **Done when** (`done_when`): a short Markdown checklist or sentence, shown right under the description. It's the one field that earns its place from how agents work: every task and spec already ends with "Done when", agents check their pull request against it before handing over, and the board can show it on the card and in a PR. It's part of the brief and follows the same edit rules.
- **Comments**: an append-only thread. Each has an author (`owner`, an agent name, `board` for what the board itself writes, or `routine:<slug>` for trigger data), a time, and Markdown text. For findings, progress, questions, and hand-offs. A comment is never edited into the brief; to change what the task is, edit the description. A correction is a new comment.
- **Who may edit the description.** The owner, anywhere. An agent on a task it made or is refining (`Mode: refine`). Agents building a task don't rewrite it; they comment. An idea's description is the owner's own words and is never rewritten by the agent shaping it (the spec and the tasks it makes carry the plan).

### Fields, decided
| Field | Decision | Why |
| --- | --- | --- |
| Title (`description` in Taskwarrior) | Keep | The one-line name. |
| Description (`brief`) | **New** | The current brief, above. |
| Done when (`done_when`) | **New** | Checked by the agent before handing over; shown on cards and PRs. |
| Related (`related`) | **New** | "See also" links to other tasks that don't block (`rel_<uuid>`, like `dep_<uuid>`), shown both ways. `depends` stays the only thing that blocks. |
| Area, horizon, priority, tags, depends, spec, pr, due, wait, autostart, claim, session, alert | Keep | They earn their place. |
| Assignee, estimate, labels beyond tags, status workflow, sub-tasks, attachments, reactions, threaded replies, comment editing | **Not adding** | One owner and agents: `claim` is the assignee, tags cover labels, a split makes new tasks. |

### Storage (Taskwarrior-compatible)
- `brief`, `brief_by`, `done_when` are plain string properties, declared as UDAs in [`taskrc`](../../taskrc) (`uda.brief`, `uda.done_when`) so `task <id> info` shows them and `task modify brief:…` works. `rel_<uuid>` plus a `related` list mirror how dependencies are stored.
- **Comments stay annotations.** `annotation_<epoch>` keeps holding the text, so Taskwarrior shows them as annotations and `task annotate` still works. The author sits beside it in `by_<epoch>` (same epoch, including the bump when two land in one second). Taskwarrior keeps properties it doesn't know, so an annotation added with `task annotate` simply has no author and the board shows it as `owner` (the only person who uses Taskwarrior).
- **Comment text is capped** (10,000 characters, like a note today).

### Existing tasks and notes
Nothing is deleted or reordered. A one-time, repeatable backfill in the board's store (like [`backfill-shipped.js`](../../src/backfill-shipped.js)):
1. If a task has no `brief` and its first annotation was written within a minute of the task's creation, that text is copied into `brief`. That first note *is* what the task was created with. `brief_by` is left empty (shown as "unknown").
2. All annotations stay as comments, in order, with no author (shown as "earlier note"). A comment identical to the description is hidden in the thread, since it's the same text.
3. A task with no such note gets no brief and shows "No description yet".

Running it twice does nothing. It runs on the board's first request after the deploy, and the deploy is the owner's merge like any other. Until the API and the web board move, `annotations` stays in the task JSON next to `comments` so older CLIs don't break.

### Who writes what today (all move to the new shape)
- **Board and CLI**: `add --note` and `idea` set the **description**. `note` adds a comment (`comment` is its new name). `show` prints title, description, done when, related, then the comments with authors.
- **The board's own writes** (Merged in #31, Shipped in …, took over the claim, the closed alert) become comments by `board`, and the thread can hide them. Tasks the board makes for agents (fix a PR, a security alert, a Dependabot review) put their brief in the description and their "Done when" in `done_when`, no longer in a note.
- **Taskwarrior sync**: annotations and UDAs sync as before. The Activity feed gets "description changed", "done-when changed", and comments with their author.
- **GitHub links**: PR closing words are read from the PR, not from notes, so they're untouched.
- **Session hooks**: they write to the task's `session` field, not notes; untouched. Live output keeps showing as it does.
- **Agent prompts** (the agent prompt, the `tasks` skill, `docs/tasks.md`): "the idea is the first note" becomes "the idea is the description"; "note" steps become "comment". The owner pastes the updated routine prompt once ([`CLD-65`](#done-when), which also carries IDEA-4's part).

### The web board: description first, comments below
- **Task view.** Title, then the **description** rendered as Markdown with an *Edit* button (a textarea with the same small Markdown as today, saved on a button or `Ctrl/Cmd+Enter`, and a line saying who edited it last), then **Done when**, related tasks, and the comment thread with a composer at the bottom. Comments show author and time; `board` ones are muted and can be hidden with one toggle.
- **Two ways to open it, and a setting.** The task opens in the **sidebar** (as it does now) by default. A control on the task offers **Open in modal**, and the modal offers **Open in sidebar**. *Settings → Open tasks in* (Sidebar / Modal) sets the default and keeps sidebar as the default. The choice is in the URL (`?task=IDEA-5&view=modal`) so a link opens the same way, and a phone always opens a task full screen.
- **The modal is its own layout, not the sidebar made wider.** It uses the width in two columns: on the left the reading column (description, done when, the thread and its composer, with room for a longer brief and wide code blocks); on the right a rail with the fields (state, area, horizon, priority, tags, dates), dependencies and related tasks as a small list with their state, the pull request with its checks, and the agent run with its live output. The rail sticks while the left column scrolls. The description edits full width with a side-by-side preview. Focus stays inside, `Esc` closes, and `j` `k` still move to the next and previous task. Below about 900px wide it collapses to one column.
- **New task and New idea** get a description box (the idea's words *are* the description) and a "Done when" box for tasks.

### IDEA-4 (routines): what changes there
The two ideas share one model, so IDEA-4's spec and tasks are updated by this pull request:
- A routine's **prompt is its description**: the same Markdown editor and the same "edited by" line. A routine may also carry a `done_when`.
- A **run** copies the routine's prompt into the run task's **description** (so a run is a stable record even if the routine is edited later) and the routine's `done_when` into the run's. It's no longer "the prompt as the first note".
- **Trigger data** is a **comment** authored `routine:<slug>`, labelled `Trigger data (untrusted)`, truncated as before, and never in the description. The description is what the agent follows; the comment is what it looks at.
- The payload's `Mode: routine` and the "Running a routine" section of the agent prompt say "do what the description says".
- The routine prompt file is pasted into claude.ai once for both changes.

## Privacy
No personal data is involved: the board holds none, and comments carry an agent name, `owner`, `board`, or `routine:<slug>`, nothing more. The tasks skill's rule against personal data or secrets in a task now covers the description and comments too.

## Out of scope
A separate comments service, edit or delete on comments, mentions or notifications, attachments, sub-tasks, estimates, assignees, per-field permissions beyond the edit rule above, and importing history from the old work board. Nothing here deploys or touches production; the merge of each pull request follows the usual pipeline.

## Done when
Built in order, one pull request each. Every task is `horizon-next`, as the idea says; note that `CLD-64` (routines) stays `now` and now waits for the first one:
1. **Storage and backfill**: `brief`, `brief_by`, `done_when`, related, comment authors, UDAs in taskrc, the backfill, the Activity summaries; `pnpm interop` passes.
2. **API**: comments endpoint (the old `annotate` route stays as an alias), `brief`, `done_when`, `related` on create and update, the board's own writes as `board` comments and agent-made task briefs in the description. Tests first.
3. **CLI**: `comment`, `note` as its alias, `--brief`, `--done-when`, `--related`, `show`, `idea`.
4. **Web board**: the description, done when, related, comments, new task and idea forms (sidebar layout).
5. **Web board modal**: the modal layout, *Open in modal / Open in sidebar*, the setting, the URL.
6. **Prompts and docs**: the agent prompt, the `tasks` skill, `docs/tasks.md`, `AGENTS.md`, the CLD-47 and IDEA-4 specs.

The owner-side step for the routine prompt is `CLD-65`, which now waits for the prompt and docs task as well.
