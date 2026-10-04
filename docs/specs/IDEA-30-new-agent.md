# IDEA-30 · New agent: start an agent from a prompt

Task: IDEA-30 on the board, refined in BRK-108 · Status: draft, with the owner's answers (BRK-104, 4 Oct 2026)

The idea landed in another repository than the board's code, and its agent wrote this spec there. BRK-108 brought it here, where the tasks it makes live, with the answers to BRK-104 and the owner's follow-ups. Section 1 closes the gap that put it there: an idea always gets the repository it's for.

## Problem
Every agent the board starts today needs a task first: a build, a refinement, a fix on a pull request, a routine run, or an idea to shape. Some work doesn't fit one task, or isn't worth writing one for:

- **A change that runs across tasks.** Adding something to a feature that's already refined means editing several tasks by hand, or refining them one at a time. The idea's example: "change the Idea workflow so that an agent which picks up an `IDEA-*` task always prefers making a feature when it outputs more than one task".
- **A quick fix from what the owner sees.** "On this page, this is broken", with a screenshot, the way an idea takes images.
- **Bringing work in line with a decision.** Once the owner answers a decision, the tasks that wait for it, their dependencies, and their spec have to match the answers, and new tasks often follow. BRK-108 did that by hand for this spec.

The owner wants a **New agent** button beside **New task**: write what you want (with images), press Start, and an agent makes its own task and works it through. And a **Force start** that starts an agent now, even when the board's own limits say wait.

## Fit
- **The owner decides.** Only the owner starts a general agent, and it ends the way every agent does: a pull request the owner merges, or changes on the board the owner can see in Activity. It never deploys, never touches production, never merges, and never answers a decision.
- **One claim per task.** A general agent still holds exactly one task, its own, so the live output, the Agents view, limits, and Activity work unchanged.
- **One repository per task.** A cloud agent runs in one repository's routine and checkout, so its task belongs to that repository: the one in scope, or the one picked in the dialog. Work it finds for another repository becomes a task there.
- **A work ID is never reused or changed.** A general agent's task gets its work ID once, when its agent picks the area (section 1).
- **Limits.** A normal start queues for room like everything else. Force start skips only the board's own limits, never Claude's ([Force start](#4-force-start)).
- It reuses what exists: routine runs already turn a prompt into a task and start an agent on it ([IDEA-4](IDEA-4-routines.md)), and ideas already take images ([IDEA-8](IDEA-8-images-on-ideas.md)).

## Design

### 1. What a general agent is
A **general agent** is an agent started from a prompt instead of a task. The board makes its task, and the agent works out what the prompt needs and does it.

- **Its task.** Pressing Start makes a task in the repository picked in the dialog (section 5), with **no area, and so no work ID yet**:
  - the **title** from the prompt's first line (as an idea's is, `ideaTitle`), which the agent may rewrite once it knows what the work is;
  - the **description** the prompt, in the owner's words, like an idea's: never rewritten;
  - horizon **now**, tags `+agent +general`, and the images as attachments;
  - `autostart` **yes**, so it starts as soon as there's room (section 3).
- **Its area.** The agent's first step is to pick one of the repository's own areas (`modify <short ID> --project <area>`), and the board gives the task the next work ID in that area there and then. Any open task without a work ID that gets an area works the same way, so nothing is ever renumbered. The shared areas (ideas, routines) can't be picked. A general agent that only changes the board may finish without an area (section 2).
  - Why not a shared `agents` area (`AGT-n`): its work belongs to the repository its agent runs in, and a shared area would hide which one (BRK-104, decision 3).
  - Why no area rather than a holding area that's renumbered later: the board can't renumber a task, and a work ID that changes breaks links and the agent's name (BRK-108, the owner's choice).
- **Its name** is `claude-<short ID>`, the name the board already gives a task without a work ID, and it keeps it after the task gets its work ID. Its payload says `Mode: general`, with the `Attachments: <n>` line when it has images, and Activity records the start with `trigger: 'general'` ("by a prompt from the owner, from the board"). The live output, the Agents view, and Activity follow the task's UUID, so the work ID arriving changes nothing for them.
- **Ideas and routine runs get a repository too.** A routine run takes its routine's. An idea takes the one in scope, and with every repository in scope the idea form now asks which one (WEB-20). Today it sends none, and the board puts the idea in the install's default repository, where its agent shapes it in the wrong checkout. The shared prefixes `IDEA` and `RUN` stay. What changes is that each task is always made in the repository it's for.
- **What it may do.** Anything an agent may do in a build, plus the cross-task edits in section 2: change code on a branch and open a pull request, add tasks (with dependencies), comment, ask a decision, ping. It never sets `--autostart` on another task, never changes a `horizon-*` tag, never rewrites an idea's description, and never takes another agent's claim.

### 2. What the agent does with the prompt
A new section of the prompt's core, "Running a general agent", tells it to look at the images first (`attachments`), read the prompt, and pick the smallest of these that does what it asks:

1. **A change in this repository** (the quick fix): pick the area, build it like a task, open a pull request that `Closes <its work ID>.`, put it in the task's `pr` field, and watch it.
2. **Changes on the board only** (the cross-task edit): change the tasks the prompt is about, within the rule below, then `comment` on its own task what it changed, task by task, and `release` it. A general task released with no pull request is closed by the board, as a routine run with nothing to do is.
3. **Something bigger than one pull request** (a feature, many tasks): shape it the way an idea is shaped, a spec and filled-in tasks, in one pull request that closes its task. When IDEA-28's features are built, the tasks get one feature tag.
4. **Work for another repository:** `add` a task there (`--repo`), say so in a comment, and release; it never changes another repository's files.
5. **Something it can't do** (production, a secret, a choice only the owner can make): ask the decision or ping, as any agent does, and release.

It retitles its own task (`modify <its task> --description …`) once it knows what the work is, so the board reads like a list of work, not of prompts.

**Cross-task edits: directly, each change noted** (BRK-104, decision 1; built in BRK-109). Today an agent may change a task's description and done when only on a task it made or is refining (`checkBriefEdit`). A general agent holding its task may also change the description, done when, area, horizon, tags, and dependencies of **unclaimed, open tasks in its own repository that aren't ideas**. It never sets a `horizon-*` tag or `autostart`, never changes a decision's questions or answers, and never touches a claimed or closed task or another repository's. Each change adds a board comment on the edited task (`Changed by <its task>: <the fields>`), so it shows in Activity and can be undone from history. Anything outside these limits goes to the owner as a ping proposal. Other agents keep today's rule.

### 3. Starting as soon as there's room
A general agent is the owner asking for work now, so it never waits behind the board's settings, only behind room:

- It goes to the **front of the auto-start queue**, ahead of other auto-start tasks (security fixes stay first), and it starts on the next tick when a slot is free. The board-wide auto-start switch doesn't hold it back: the owner pressed Start.
- When slots run short, the order is security fixes, general agents, other auto-start tasks, then a chase ([IDEA-28](IDEA-28-features-and-chase.md), section 3).
- It ignores the one-agent-per-area rule: it has no area until its agent picks one.
- While it waits, the Agents view and the task say why ("waiting for a free slot: 3 of 3 running"), as other queued tasks do, with **Force start** next to it.
- The routine's own checks still apply: a repository whose routine isn't connected, or whose prompt still has a `<…>` left in it, can't start one, and the dialog says so before the task is made.

### 4. Force start
**Force start** starts an agent now, past the board's own limits. It's on **every start** (BRK-104, decision 2, so there's one way past the limits instead of one per button that drifts apart): the New agent dialog (a checkbox), a task's **Start an agent**, **Refine with an agent**, **Fix with an agent**, **Safe to merge?**, and **Review with an agent** (section 9) on a pull request, a routine's **Run now**, the Agents view's queue, and **Refine from the answers** (section 8). It shows only when the board's own limits are what's in the way: with room, a start is just a start, and when something else refuses it, that reason shows instead.

- **It skips** the board's agents at once (`max`), its starts an hour, a repository's own caps (`--agents-max`, `--agents-hourly`), a routine's daily caps, the per-area rule, and the auto-start switch.
- **It never skips** Claude's limits, which the board doesn't manage: 30 starts an hour for each routine and 100 for the account ([plans.js](../../src/plans.js), `CLAUDE_LIMITS`). Over those, Claude answers `429` and the board shows its message and `Retry-After`, exactly as today. It also never skips what makes a start wrong rather than slow: a task that's blocked, claimed, or done, a routine that isn't connected, or a prompt with a `<…>` left in it.
- **A refusal says whether Force start could skip it**, so the web offers Force start only then.
- **Only the owner** forces a start (a request signed with an agent's name is refused, like picking the plan), and an agent never asks for one. A chase never forces.
- **It still counts.** A forced agent takes a slot and a start like any other, so the next normal start waits longer. The Agents view and the task mark it **Forced**, and Activity records `forced: true` on the start, so the budget stays accountable.
- **API:** `force: true` on every route that starts an agent, and on the general route; `startAgent(uuid, { …, force })` skips the board's checks and nothing else.

### 5. The New agent button and dialog
- **Where.** In the top bar, beside **New task**, a quiet button **New agent** (an icon button on a phone), shown when the agent routine of the repository in scope is connected (with every repository in scope, when any is), using the Agents API's `connected`; with no routine connected it isn't there, rather than shown and refused. A keyboard shortcut (`p`, free today) opens it, and it's listed in the shortcuts help.
- **The dialog**, like the idea form: one large field, "What should the agent do?", rough is fine; images by picking, dropping, or pasting (up to 4, shrunk in the browser, uploaded once the task exists, as on ideas); **Repository**, the idea form's field (WEB-20), when the board runs more than one: preset to the one in scope, and with every repository in scope, empty until one is picked, with a repository whose routine isn't connected shown but not pickable, and why; a **Force start** checkbox, off, with one line saying what it skips; and **Start agent**. On success it opens the new task, where the live output appears.
- **States.** Empty prompt: "Write what the agent should do first." No repository picked: "Pick the repository this is for." Routine not connected or prompt unfilled: the reason, and no task made. Over Claude's limit with Force start: Claude's message and when to try again, and the task stays, waiting. Images that fail to attach: a toast, as on ideas. Both themes, narrow and wide, keyboard and screen reader, per the brand guide.
- **A task with no area yet** shows by its short ID, and where its area would be, says its agent picks one.

### 6. Command line and API
- **API:** `POST /api/agents/general` with `{ prompt, repo, force?, decision? }` makes the task, queues or starts it, and returns the task and the run (or the reason it waits). `repo` is required when the board runs more than one repository. `decision` is section 8's. Images go to the task's attachments route as today. The owner's cookie or the owner's token only.
- **CLI:** `npx breakaway agents new "<prompt>" [--image <file>]… [--repo <slug>] [--force]`, in the checkout's repository unless `--repo` names another; `agents new --decision <ID> ["<note>"]` (section 8); and `--force` on every command that starts an agent: `agents start`, `agents refine`, `github fix`, `github review`, and `routines run`. `CLI_VERSION` and `CLI_FINGERPRINT` move with it.

### 7. Teaching agents
The core gets "Running a general agent": set the area first, the paths in section 2, the cross-task rule, and what to do when the run comes from a decision's answers (section 8). It also gets "Reviewing a pull request" for `Mode: pr-review` (section 9). Step 3 of "How to work" gets `Mode: general` and `Mode: pr-review`, and the `tasks` skill and `docs/tasks.md` get a line each. The core is a copied file, so every repository picks it up with `npx breakaway repos init <slug> --update`.

### 8. Refine from the answers
The owner's follow-up to BRK-104: a button that does what BRK-108 did by hand.

- **Where.** In the decision section of a task whose decision is answered, when the repository's agent routine is connected: **Refine from the answers**. On the command line, `agents new --decision <ID> ["<note>"]`.
- **The prompt is the board's.** The board writes it from the decision: the questions and the answers, with the owner's notes on them; the tasks the decision holds up and their feature tags; the spec they link; and what to do. The agent changes those tasks and their dependencies to match, updates the spec in one pull request, adds the tasks the answers need, and asks a new decision for anything the answers leave open.
- **The dialog** shows that prompt, short and read-only, with an optional note under it, like **Add a note** beside **Start an agent**, which the board adds below its own prompt. It also has the **Force start** checkbox and **Start agent**, and on success it opens the new task.
- **The task** is an ordinary general task (section 1) in the decision's repository, related to the decision. While one from a decision is open, the button links to it instead of starting another.
- **The edits** follow section 2's cross-task rule, and the spec change comes as a pull request the owner merges.
- BRK-100's **Prepare the next release** starts a general agent with a board-written prompt the same way, once this is built.

### 9. Review with an agent
Another follow-up from the owner. Before a pull request is merged, an agent reviews it and leaves its answer where the owner decides: on the pull request page. It isn't a general agent. It works on the task the pull request closes, as Fix with an agent does.

- **When it shows.** On the pull request page, **Review with an agent**, only for a pull request that can merge as it stands. That means it's open and not a draft, GitHub says it's mergeable (no conflicts) and not behind its base, and its checks passed or are still running (the `ready` and `running` verdicts, with `mergeable` true). It also has to close an open task in its repository. A pull request that's behind, conflicts, or fails its checks already has its own path (**Update branch**, **Fix with an agent**), so it shows that instead. A Dependabot pull request keeps **Safe to merge?**. With an agent already on the task, the page says who, as it does for Fix with an agent.
- **The route.** `POST /api/github/pulls/<n>/review`, the route Safe to merge? uses, and `github review <n>` on the command line. For a Dependabot pull request it does what it does today. For any other pull request it checks the conditions above again on the server, then starts an agent on the closing task with `Mode: pr-review` and `Pull request: #<n>`, named `claude-<id>-review`. Owner only; Force start applies, as on every start (section 4).
- **What the agent does.** It checks out the branch, reviews the diff against the task's description, done when, and spec, and runs the repository's checks. It looks for what the checks can't see: wrong behaviour, missing tests, work outside the task, and the brand guide for anything people see. It never pushes and never merges.
- **Its answer** is one verdict: **Looks ready**, **Ready with a follow-up** (it adds the task and names it), or **Needs changes** (what and where). It leaves it with `review <ID> --verdict ready|follow-up|changes "<note>"`. That adds a comment to the task, as every agent's answer does, and the board also keeps it for the pull request with the head commit it reviewed. Safe to merge? answers the same way, so its answer shows there too.
- **On the pull request page,** below the description, an **Agent review** section shows the latest review: the verdict, the agent, when, and the commit it reviewed, marked when the branch has moved since, with the note as Markdown. Earlier reviews stay as comments on the task.
- **Needs changes leads to the fix.** A review that needs changes counts as review comments for **Fix with an agent**, and the fix agent's payload carries the note, so the owner goes from review to fix in one press.

## Privacy
The prompt, the images, and the note are the owner's and stay on the board, as an idea's do. The agent sees them in its payload and attachments, and nothing new leaves the install. The agent follows its repository's prompt on what it never shares, including anything it sees in an image.

## Decisions
Answered by the owner on BRK-104 (4 Oct 2026):

1. **Cross-task edits:** directly, each change noted (section 2).
2. **Where Force start shows:** on every start, so the board has one way past its limits (section 4).
3. **The area:** an area of the repository, picked by the agent, not a shared `AGT` area; ideas and general agents always get a repository, from the scope or a picker (section 1). The task waits with no area until its agent picks one, so its work ID is given once (BRK-108).

## Out of scope
A chat with a running agent (the board's messages, [IDEA-15](IDEA-15-message-a-running-agent.md), already reach it), several agents from one prompt, scheduling a prompt for later (that's a routine), a general agent that deploys, merges, or answers decisions, skipping Claude's limits, a general agent started by an agent, a chase that forces, renumbering a task that already has a work ID, making `IDEA` and `RUN` areas of each repository, and an agent's review posted to GitHub as a pull request review (it stays on the board).

## Done when
Built in breakaway for 1.3.0, before features and chase ([IDEA-28](IDEA-28-features-and-chase.md)), one pull request each, tests first:

1. **This spec** with BRK-104's answers (`BRK-108`).
2. **Force start** on every start, on the server (`BRK-105`).
3. **General agents** on the server (`BRK-106`): the task with no area and its work ID when it gets one, `/api/agents/general`, `Mode: general`, the queue, and closing on release.
4. **Cross-task edits** (`BRK-109`).
5. **CLI** (`BRK-107`): `agents new`, and `--force` on every command that starts an agent.
6. **Refine from the answers** on the server and CLI (`BRK-110`), and **Review with an agent** on the server and CLI (`BRK-111`).
7. **Web**: an idea's repository (`WEB-20`), Force start on every start (`WEB-21`), the New agent button and dialog (`WEB-19`), Refine from the answers (`WEB-22`), and Review with an agent with its review below the description (`WEB-23`).
8. **Docs and prompts** (`DOC-14`), last; other repositories then refresh their copied core.
