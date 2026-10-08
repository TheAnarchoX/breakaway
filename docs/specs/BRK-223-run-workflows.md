# BRK-223 · Run a repository's workflows from the board

Task: BRK-223 on the board · Status: built (#304 and #305, in 1.5.2, then #435; approved 6 Oct 2026, by the owner)

## Problem

The board already starts workflows, but only its own: Promote, Roll back, and Release dispatch the workflows the pipeline renders. Every other workflow a repository can run by hand (one with a `workflow_dispatch` trigger, like this repository's **Plugin**, which puts a released tag on the `plugin` branch) means leaving the board for GitHub: open the repository, Actions, find the workflow, Run workflow, pick the branch, fill in the inputs. You asked for that button on the board, so a by-hand run is one more thing you don't leave breakaway for.

## Fit

- **You decide; agents don't run workflows.** A workflow can deploy, publish, or move a branch, so running one is yours, like Promote: the signed-in browser only, never the bearer token agents, the CLI, the MCP server, and routines hold. Nothing runs a workflow by itself. This keeps "Nothing in breakaway merges or deploys on an agent's word", and `AGENTS.md`'s rule that agents never run the Release, Site, or Plugin workflows: the board refuses them, not only the prompt.
- **An install keeps its data.** It talks only to GitHub, through the App the install already connected. Nothing new leaves the install.
- **Words.** "Workflow" is GitHub's word, and the brand guide keeps it for GitHub's workflows (a **routine** is the board's). The button says **Run workflow…**, the verb GitHub uses, never "dispatch" or "trigger".

## Design

### Which workflows

For a repository on the board, the Worker lists the workflows that can run by hand:

1. `GET /repos/{owner}/{name}/actions/workflows`, keeping the ones whose `state` is `active` and whose path is under `.github/workflows/` (GitHub's own dynamic workflows, like Dependabot's and CodeQL's default setup, have no file to read and are left out).
2. Each one's file on the default branch (`GET /contents/<path>?ref=<default>`), parsed for its `on:` triggers. `on: workflow_dispatch`, `on: [push, workflow_dispatch]`, and `on: { workflow_dispatch: … }` all count.
3. Each input's `name`, `description`, `type` (`string`, `boolean`, `choice`, `number`, `environment`; `string` when missing, as GitHub does), `required`, `default`, and `options` (for `choice`).

The answer is kept for 5 minutes per repository, and dropped when a push to the default branch changes a file under `.github/workflows/` (the `push` webhook already arrives; its commits list the files they change), so a workflow merged a minute ago shows without waiting.

**Parsing.** The CLI's `parseYaml` (`scripts/tasks/pipeline.js`) reads the YAML the pipeline templates use. Hand-written workflows use more of YAML (comments after values, flow mappings like `{ type: string }`, folded `>` scalars, anchors), so the parser grows to read what the `on:` block of a real workflow uses, and moves where both the Worker and the CLI import it, without breaking the copy of the CLI that `repos init` puts in other repositories. A file it still can't read is listed anyway, without inputs, marked **Run it on GitHub**, with a link to the workflow's page there: the board never guesses a workflow's inputs.

### The API

- `GET /api/github/workflows?repo=<slug>`: anyone signed in. `{ workflows: [{ id, name, path, url, inputs: [...], readable }], branch, branches, actions: { ok, reason } }`, where `branch` is the default branch, `branches` the ones the board already knows (the default and its open pull requests' heads), and `actions` is the App's Actions permission from `pullAccess` (below). An empty list is `[]`, not an error. GitHub not connected, or the App not on the repository, answers 409 with what to do, the way the Packages feed does.
- `POST /api/github/workflows/run` with `{ repo, workflow, ref, inputs }`: **the signed-in browser only** (`via === 'cookie'`), answering anything else with 403 "only the signed-in web board can run a workflow". The Worker:
  - reads the list again (the kept one is fine) and refuses a `workflow` that isn't in it, or isn't readable: the board runs only what it can show you;
  - checks `ref` names a branch or tag (`[A-Za-z0-9._/-]`, up to 255 characters), and `inputs` against the inputs it read: no unknown name, every required one present, a `choice` one of its options, a `boolean` `true` or `false`, a `number` a number, each value up to 1,000 characters, at most 25 (GitHub's limit);
  - starts it with the existing `dispatchRelease` path (`POST /actions/workflows/<id>/dispatches`), so a missing Actions permission answers with the message Promote already gives, and GitHub's own refusal (a branch where the file doesn't exist, an input that branch's copy doesn't take) comes back with GitHub's reason;
  - records an Activity event, `workflow_started`: the workflow's name, the repository, the ref, and the **names** of the inputs sent, never their values, since you may type something private into one; and syncs 5 seconds later, so the run shows under the runs tab.

### Permissions

Running a workflow needs read and write on **Actions**, which the App's manifest has asked for on every install since `CLD-105`. Today the board checks it only where a repository has a deploy pipeline (`pipeline: true` in `NEEDED_PERMISSIONS`); it becomes needed on every repository, for "Run workflow, Promote, and Roll back", so Connections and `pullAccess` say when an App has less. `docs/tasks.md`'s GitHub section says so.

### The board

On the GitHub view's runs tab, a **Run workflow…** button above the list (the tab is labelled **CI runs**; it becomes **Runs**, since it lists every workflow run, not only CI).

- **The dialog** asks, in order: the repository (only when the view shows all repositories; preselected when it's scoped to one), the workflow (a list of the ones that run by hand, by name, with the file's path under it), **Run on** (a text field with the default branch filled in and the known branches offered), and then one field per input, in the workflow's order, labelled with the input's name and its description as help: a text field for `string`, a number field for `number`, a switch for `boolean`, a list for `choice`, and a text field for `environment`, offering the environments the board has seen deploys to. Defaults are filled in and required ones are marked. **Run workflow** runs it; **Cancel** closes.
- **After it runs**, the dialog closes and a note says "Started Plugin on main. It shows under Runs in a few seconds." with a link to the workflow's runs on GitHub. The run appears in the list when the sync reads it.
- **States.**
  - *No workflows run by hand:* the button is there, and the dialog says "None of <repository>'s workflows run by hand. Add a `workflow_dispatch` trigger to one, and it shows here." with a link to GitHub's docs on it.
  - *A workflow the board can't read:* listed, with "The board can't read this file's inputs." and **Run it on GitHub** instead of the fields.
  - *No Actions permission:* the button is disabled, with `pullAccess`'s reason next to it, the way Promote's is.
  - *GitHub refuses:* the dialog stays open with GitHub's reason in plain words and what to do.
  - *Loading:* the workflow list loads when the dialog opens, with a line saying so; it never blocks the runs tab.
  - *GitHub not connected, or held because GitHub isn't working* (`BRK-217`): the runs tab is already not shown before GitHub is connected; while GitHub's status is held the button still works, as everything you press by hand does.
- **Phone and keyboard.** The dialog is the board's usual dialog: full width on a phone, every field labelled, focus on the workflow list when it opens and back on the button when it closes. Both themes, from the tokens.

## Privacy

The board keeps the list of workflows and their inputs in memory for 5 minutes, all of it from files already in the repository. Activity keeps the workflow, the ref, and the input names, never their values. Nothing goes anywhere but GitHub. Agents see none of it: the routes that run a workflow refuse their token, and listing workflows tells them nothing the repository doesn't.

## Out of scope

- Running a workflow from the CLI, the MCP server, a routine, or an agent. If you want it from your own CLI later, that's a task of its own with the same owner-only check `release` uses; agents never get it.
- Re-running, cancelling, or approving a run (an environment's required reviewers still approve on GitHub).
- Showing a run's logs on the board: the run links to GitHub, as the runs tab does today.
- `workflow_call`, `repository_dispatch`, and schedules: only `workflow_dispatch` runs by hand.
- Reading inputs from the chosen branch's copy of the file: the board reads the default branch's, and GitHub's refusal covers a branch whose copy differs.
- Favourites, saved inputs, or running the same workflow on several repositories at once.

## Open questions

None that block building. Whether you want **Run workflow** from your own CLI too can be a later task.

## Done when

- `BRK-224`: the Worker lists each repository's workflows that run by hand, with their inputs, and runs one on the signed-in owner's press only, checking the workflow and its inputs, recording `workflow_started` in Activity without input values, and asking for Actions write on every repository; tested with GitHub mocked, and `docs/tasks.md` says how.
- `WEB-82`: **Run workflow…** on the GitHub view's runs tab opens the dialog above, with every state, in both themes, narrow and wide.

## How to check it

1. Open the board's **GitHub** view and pick the breakaway repository. Open the **Runs** tab.
2. Press **Run workflow…**. The list shows **Plugin**, and the other workflows that can run by hand.
3. Pick **Plugin**. A **ref** field appears, with the help "A release tag of breakaway, like v1.6.0, …", and **Run on** says `main`.
4. Fill in the latest release's tag and press **Run workflow**. A note says it started; within a few seconds a new **Plugin** run is at the top of the runs list, and its link opens the run on GitHub.
5. Open **Activity**: it says you ran Plugin on `main`, without the tag you typed.
6. Pick a repository with no workflow you can run by hand: the dialog says so, and how to add one.
