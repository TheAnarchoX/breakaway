# IDEA-31 · Specs: read a repository's specs on the board, and refine one with an agent

Task: IDEA-31 on the board · Status: built (#161, #165, #167, #169, #172)

## Problem
Specs are where the board's bigger work is decided, but on the board they are only a path in a task's `spec` field, which opens the file on GitHub. The owner can't see a repository's specs together, can't read one beside the tasks it made, and has no way to change one from the board. Changing a spec today means starting an agent on one of its tasks and explaining which spec, which tasks, and what to change, or editing by hand.

The owner wants a **Specs** view: the repository's specs, each one readable on the board, and an agent button on a spec to refine it. They write what to change ("I want this and this"), and an agent updates the spec, updates the tasks it covers, and opens a pull request with the new spec. The specs come from where the repository already keeps them, or from a directory the owner sets; the idea says either is fine.

## Fit
- **The person who runs the board decides.** The view only reads. A change to a spec arrives as a pull request the owner merges, and the task edits are the cross-task edits a general agent already makes, each one noted on the task it changed ([IDEA-30](IDEA-30-new-agent.md), section 2). Only the owner starts the agent.
- **An install keeps its data.** The board reads the files through the GitHub App the owner already connected, as it reads a repository's agent prompt for the Agents view (`routinePromptApi`). Nothing new leaves the install.
- **One claim per task, and pull requests close tasks.** Refining a spec is a general agent with a board-written prompt, like **Refine from the answers** (IDEA-30, section 8): it holds its own task, and its pull request closes that task, not the spec's tasks.
- **Several repositories.** Every repository has its own specs, so the view follows the repository in scope, and an agent on a spec runs in that spec's repository.

## Design

### 1. Where a repository's specs are
- A repository's **specs directory** is a new optional field in its registry row's `settings` JSON: `settings.specs`, a relative directory path like `docs/specs`. Left out, it is `docs/specs`, where breakaway and the template for other repositories already put them, so most repositories need nothing set.
- It is checked like `routine.prompt`: relative, no `..`, at most 200 characters. The owner sets it with `npx breakaway repos modify <slug> --specs <dir>` (owner only, like every `repos` command). Its place on the web is the repository's settings page from IDEA-29 when that is built; this spec adds no form for it.
- Why a setting rather than only `docs/specs`: other repositories on an install keep specs elsewhere, and each repository's prompt already says where under **Direction**. Why a default rather than reading **Direction**: the board would have to parse a prompt, and a wrong guess shows nothing.
- A spec is any `*.md` file directly in the directory except `README.md`, which the view shows as the directory's introduction when it is there. Subdirectories are not read.

### 2. Reading them on the server
- `GET /api/specs?repo=<slug>` lists the repository's specs from its default branch: for each file its path, its title (the first `# ` heading, else the file name), its status (the `Status:` on the line under the heading, as the template has it, else none), and the work ID at the start of the file name when there is one. With it come the tasks that link the spec (their `spec` field is the path), by work ID, title, and status, so the list can say "4 tasks, 2 open" without another call.
- `GET /api/specs/<path>?repo=<slug>` returns one spec: the Markdown, the commit that last changed it (sha, date, and message's first line), its GitHub link, and the same linked tasks. The path must be inside the specs directory; anything else is a 400.
- Both read through the GitHub App's contents API on the default branch, and keep the result for a minute per repository, as the agent prompt does. The board never stores a spec.
- Edge states: GitHub not connected (409, "Connect GitHub to read the specs"), the App can't read the repository (502 with GitHub's reason), no such directory (200 with an empty list and `missing: true`), and a file over 1 MB (its entry says so, and the view links to GitHub instead). Owner and agents can read both, like any board read.

### 3. The Specs view
- **Where.** A **Specs** item in the sidebar, after GitHub, with the repository switcher deciding whose. With every repository in scope it groups the specs by repository.
- **The list.** One row per spec: its work ID, title, status as a quiet badge (draft, approved, built), and its tasks' count with how many are open. Sorted by work ID's number, newest first; a filter field narrows by title or ID. The directory's `README.md`, when there is one, is a link above the list, not a row.
- **A spec.** Opening a row shows the spec beside the list (the way a task docks beside the board), rendered with the board's Markdown (`web/src/lib/markdown.js`), so a work ID in the text opens that task and a link to another spec opens it here. Its header has the title, status, when it last changed and by which commit, **Open on GitHub**, and **Refine with an agent**. Under the Markdown, **Tasks** lists the tasks that link it, each opening in the task panel.
- **From a task.** A task's `spec` link opens the spec in this view instead of on GitHub, with **Open on GitHub** still one press away.
- **States.** GitHub not connected: the view says so and links to Connections. No specs directory: "No specs in `<dir>` yet", with one line on where specs go and how to set another directory. A spec over 1 MB: a link to GitHub. Loading and errors as in the GitHub view. Both themes, narrow (the spec replaces the list, with a back button) and wide, keyboard and screen reader, per the brand guide.

### 4. Refine a spec with an agent
- **The button.** **Refine with an agent** on an open spec, shown when the spec's repository has a connected agent routine. It opens a dialog like **Refine from the answers**: a required field, "What should change?", the **Force start** checkbox (IDEA-30, section 4), and **Start agent**. On success it opens the new task.
- **The task** is an ordinary general task (IDEA-30, section 1) in the spec's repository, with `spec` set to the spec's path, so the spec's view lists it under **Tasks** while it runs. While one for that spec is open, the button links to it ("an agent is on this spec") instead of starting another.
- **The board writes the prompt**, like `refinePrompt` for a decision: the spec's path and title; the owner's request, in their words; the tasks that link the spec, with their work IDs, status, and feature tags; and what to do:
  - change the spec as the request asks, keeping the repository's spec template and **Direction**;
  - bring the open tasks that link it in line, with the cross-task edits a general agent may make (description, done when, area, horizon, tags, dependencies), each noted;
  - add the tasks the change needs, filled in, linking the spec and depending on what they wait for; never set `--autostart`;
  - ask a decision for anything only the owner can choose;
  - open one pull request with the spec change that closes its own task, and never touch a claimed or closed task, an idea's description, or a `horizon-*` tag.
- **On the server**, `POST /api/agents/general` takes `{ spec: <path>, note: <the request>, repo }` as it takes `decision`: the board reads the spec's tasks, writes the prompt, and starts or queues the agent. A spec path outside the directory, or a file that isn't there, is a 400. Owner only.
- **On the command line**, `npx breakaway agents new --spec <path> "<what should change>" [--repo <slug>] [--force]`, and `npx breakaway specs [list]` and `specs show <path>` to read them, in the checkout's repository unless `--repo` names another.
- **Teaching agents.** The board-written prompt carries the steps, so the core needs only a line under "Running a general agent": a run that names a spec is about that spec and the tasks that link it.

## Privacy
The board reads the repository's spec files from GitHub when the view asks and keeps them for a minute in memory, never in storage. The owner's request is a general task's description, as any prompt is. An agent sees what any agent in that repository already can.

## Out of scope
- Editing a spec in the browser, or the board committing one: changes come as an agent's pull request the owner merges. The one exception is a spec's status: **Mark approved** and **Mark built** (`BRK-215`) open a pull request that changes only its `Status:` line, which the owner merges like any other.
- Specs on branches or in open pull requests (a spec still in review is read on the pull request page).
- Subdirectories, files other than Markdown, and specs that live outside a repository.
- A web form for the specs directory: that is IDEA-29's settings page.
- Making a spec's status a board field: the view reads it from the file.
- Refining several specs at once.

## Open questions
None the idea leaves open: it said either a fixed directory or a configurable one is fine, so this spec takes both, `docs/specs` with a per-repository setting.

## Done when
Built in breakaway, one pull request each, tests first, all on horizon next (the owner's `horizon-next` tag) and tagged `+specs`:

1. **This spec** (IDEA-31).
2. **Specs on the server** (`BRK-119`): the `settings.specs` directory and its check, `repos modify --specs`, `GET /api/specs` and `GET /api/specs/<path>` with their linked tasks, the one-minute cache, and the edge states.
3. **Refine a spec on the server** (`BRK-120`): `spec` on `POST /api/agents/general`, the board-written prompt, and one open agent per spec.
4. **CLI** (`BRK-121`): `specs`, `specs show`, and `agents new --spec`; `CLI_VERSION` and `CLI_FINGERPRINT` move with it.
5. **The Specs view** (`WEB-25`): the list, a spec beside it, its tasks, a task's spec link opening here, and every state above.
6. **Refine with an agent on a spec** (`WEB-26`): the button and dialog.
7. **Docs and the core** (`DOC-16`): `docs/tasks.md` on the Specs view, the line in the core, and the `tasks` skill; other repositories then refresh their copied core.
