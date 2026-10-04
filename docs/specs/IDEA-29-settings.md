# IDEA-29 · Settings in the web app: a page per repository, and a home for the board's own

Task: IDEA-29 on the board · Status: draft

## Problem
A repository's settings live only in the owner's CLI. `npx breakaway repos modify` changes its name, GitHub repository, default branch, and areas (add one with its prefix, rename one, remove one with no tasks), its agent caps under the board's shared limits, where its agent prompt is, and its deploy pipeline. The web app can register a repository (the Add a repository wizard) and cap its agents (Agents, Repositories), and nothing else. Changing a pipeline means writing a JSON file and running a command.

The board's own options are spread across five places: the Settings dialog (your name on claims, theme, where tasks open, notifications, and each repository's pull request automation), Agents (your Claude plan, agents at once, starts an hour, start by itself, security alerts, and each repository's caps), Routines (all routines on or off, and the daily cap), Connections (self-updates), and a pull request's Merge menu (the merge method). Nobody can find them all, and every new setting has to pick a view.

## Fit
- **The person who runs the board decides.** Every change on these pages is the owner's, as the CLI commands they mirror are. The pages save through the same routes with the same checks (`checkRepo` in `src/repos.js`), so the web app can't set anything the CLI would refuse. The new route is cookie only, like Promote, so an agent's token never reaches it.
- **An install keeps its data.** Nothing leaves the install. Secrets and anything that changes the install itself stay in the CLI: `agents-connect`, `github-connect`, `rotate-sync`, `rotate-token`, `init-secrets`, and `repos remove` (it drops the repository's routine secrets from the Secrets Store). The pages say which command to run and copy it, as the Agents view already does for `agents-connect --repo`.
- **One claim per task, and pull requests close tasks.** A work ID means one task forever, so an area's prefix and its name in Taskwarrior (`project`) never change here either. Only its display name does.
- **Taskwarrior stays first-class.** The pages change no task, and an area's `project` stays what Taskwarrior filters on.
- **One board, several repositories.** A repository's page shows only that repository's settings and counts.

## Design

### 1. Where settings live
Two kinds of page, both full views in the hash router (like `#/add-repo`), not dialogs, so they work on a phone and can be linked:

| Page | Address | Holds |
| --- | --- | --- |
| **Settings** | `#/settings` | The board's own settings, this browser's settings, and the list of repositories, each linking to its page |
| **A repository's settings** | `#/settings/<slug>` | Everything `repos modify` can change for that repository, plus pointers to what lives elsewhere |

The ways in:
- The sidebar's **Settings** opens `#/settings`. The Settings dialog it opens today goes away: its settings move to the page (`WEB-29`).
- The repository switcher gets **Repository settings** under its list (next to Add a repository), for the repository it shows. Under All repositories, it opens Settings, at the list.
- Connections, Repositories: each repository's row links **Settings**.
- The Agents view's Repositories section and the GitHub page's repository header link to the repository's page.

With one repository the switcher is hidden, as today; the repository's page is reached from Settings and Connections.

### 2. A repository's page
Sections, in order. Each section saves on its own with a **Save** button (not on every keystroke): one `PATCH /api/repos/<slug>` with only that section's fields, so a refusal names the field that caused it and the other sections keep their edits.

**General**
| Field | CLI | Notes |
| --- | --- | --- |
| Name | `--name` | Up to 60 characters; empty means the slug |
| GitHub repository | `--github` | `owner/name`. Changing it asks first: "Webhooks, pull requests, and the GitHub App's access follow the new repository. Tasks and work IDs stay." |
| Default branch | `--branch` | Shows GitHub's default beside it when it differs ("GitHub says `trunk`. Use it") |
| Slug | none | Read only: a repository keeps its slug |

**Areas.** A table: display name, `project`, prefix, open tasks, and all tasks.
- **Add an area**: project, prefix, display name. Checked as it's typed with a dry run (section 4), so a clash ("BRK already belongs to …") shows under the field before Save.
- **Rename**: the display name only, inline. The `project` and the prefix are read only, with a hint: "A prefix never changes, so a work ID means one task forever." Renaming the `project` would change every task's Taskwarrior `project` and every replica's filters, so it's out of scope.
- **Remove**: only for an area that has no tasks at all, open or done (the server's `inUse` check). Otherwise the button is disabled with the reason: "12 tasks are in this area, so it stays." Removing asks first. A repository keeps at least one area, so the last one has no Remove.
- The shared areas, ideas (`IDEA`) and routines (`RUN`), show under the table as the whole board's, with no actions.

**Agents**
| Field | CLI | Notes |
| --- | --- | --- |
| At once | `--agents-max` | No cap, or 1 to the board's agents at once (the same control as Agents, Repositories) |
| Starts an hour | `--agents-hourly` | No cap, or 1 to the lower of the board's starts an hour and Claude's per-routine limit |
| Agent prompt | `--prompt` | A path in the checkout; empty means the default, `tools/tasks/routine-prompt.md`, shown as the placeholder |
| Routine | none (`agents-connect`) | Connected or not, read only, with the `agents-connect --repo <slug>` command to copy when it isn't |
| Saved routines | none | How many routines run here, linking to Routines narrowed to this repository |

**Deploys.** The pipeline (`--pipeline`):
- **No pipeline.** Once IDEA-27's card exists (`WEB-12`, `WEB-13`), this section shows the same card, so **Move to breakaway's deploy flow** and **Turn on deploys** work from here too, and it ends the same way: by setting the pipeline. Below it, **Set it by hand** opens the form. Before that card lands, the form alone.
- **The form**: staging Worker, production Worker, and, under **Workflow files**, closed by default, deploy, promote, and roll back (blank means the defaults `deploy.yml`, `promote.yml`, `rollback.yml`), and the deploy paths file. When `BRK-103` lands, **npm package** joins it and the Workers become optional when it's set. A form, not a JSON editor: every field is a name or a path the server checks one by one, and its errors name the field (`pipeline.workers.staging is a Worker name…`), which a form can put under the field. **Copy as JSON** copies what `repos modify --pipeline` takes, so the CLI and the page stay one format.
- **Turn off deploys** clears the pipeline, after asking: "The Releases card, Promote, and Roll back go away for <name>. Its workflows on GitHub don't change."

**Specs.** When `BRK-119` lands, its specs directory (`--specs`) joins General.

**Pull requests.** Keep branches up to date and Merge when green move here from the Settings dialog for this repository. They stay settings of this browser, and the section says so.

**Take it off the board.** At the bottom, apart. For a repository that isn't the default: what removing does (its sync, webhooks, agents, and routines stop; its tasks stay; its slug and prefixes stay its own), its open tasks and running agents, and `npx breakaway repos remove <slug>` to copy, because removing drops its routine's secrets from the Secrets Store, which only the CLI does (`WEB-29`). The page has no Remove button and sends no `DELETE`. The default repository says why it stays. A repository already taken off the board shows its page read only, with **Release** when it can be released (the wizard's button and route).

### 3. The Settings page
Three sections:

- **This browser**: claim as, theme, open tasks in, notifications, merge method. They stay in `localStorage`, as today, and the section says they're only for this browser.
- **The board**: agents (Claude plan, agents at once, starts an hour, start by itself, security alerts), routines (all on or off, runs a day), and updates (self-updates on or off, with a link to Connections for the rest). They save to the same routes they use today (`agents/settings`, `routines/settings`, the self-update routes). The Agents and Routines views keep their controls too (`WEB-29`): each group is one component that both places render, saving through the one route, so a change in either shows in both.
- **Repositories**: each registered one with its name, GitHub repository, areas, and a link to its page; **Add a repository** opens the wizard; repositories taken off the board are listed, collapsed. On a fresh install with no repository, the section is the wizard's first step, as `EmptyBoard` is today.

The server status, Connections link, Refresh, Shortcuts, and Sign out stay at the foot of the page.

New board-level settings go on this page from now on, in **The board**, and a view that uses one may link to it.

### 4. The server
Most of it exists: `PATCH /api/repos/<slug>` with `checkRepo`. What's new (`BRK-129`):
- `GET /api/repos/<slug>`: the row, plus what the page needs and the list doesn't carry: each area's open and total task counts, whether its routine is connected (a yes or no, never the URL or token), how many saved routines run in it, its open tasks and running agents (for Take it off the board), and GitHub's default branch when the App can read it (`githubDefaultBranch`, already there). Anyone signed in reads it.
- `PATCH /api/repos/<slug>` takes `dryRun`, as `POST /api/repos` does: the row it would save, or the refusal, and nothing saved. The page uses it to check an area or a pipeline as it's typed.
- `PATCH` takes `edited`, the row's last-changed time the page loaded. If the row changed since, it's refused (409) with the current row, and the page says "Changed somewhere else. Here's what it is now." and keeps your edits beside it. The CLI sends none and saves as today.
- From the web app (cookie), `PATCH` and `DELETE` on repositories are allowed only from the signed-in board (they already are, through `sameOrigin`). No new owner check: the cookie is the owner's, and `ownerOnlyRepos` still refuses an agent's `by`.

### 5. Edge states
| State | What happens |
| --- | --- |
| Signed out | The sign-in page, then back to the page asked for |
| No repository yet | Settings shows the board's settings and the wizard's first step; `#/settings/<slug>` says "No repository called <slug>." with a link to Settings |
| One repository | No switcher; the page is reached from Settings and Connections |
| Unknown or misspelt slug | "No repository called <slug>." and the list |
| Taken off the board | Read only, with Release when it can be released |
| GitHub not connected | General, Areas, and Agents work; the default branch hint and the Deploys card are hidden, and the form still saves |
| Save refused | The field's error under it, the edit kept, Save enabled again |
| Changed elsewhere | Section 4's 409: the current value shown, your edit kept |
| Offline or the server unreachable | Save says it couldn't reach the board and keeps the edit; nothing is half saved, since each Save is one request |
| Narrow screens | One column; the areas table becomes a list with the same actions |

Every state has words, not color alone. Buttons are verbs. Tokens only, in carbon and chalk, and no motion beyond what the board already has, none under reduced motion ([brand guide](../../brand/README.md)).

## Privacy
Nothing new is stored. The pages read and write the repository's row and the board's existing settings. The routine shows only whether it's connected. No secret, token, or routine URL reaches the browser.

## Out of scope
- Writing secrets, connecting routines or the GitHub App, rotating credentials, and removing a repository's routine secrets: CLI only.
- Changing an area's `project` or prefix, or a repository's slug.
- Moving a task between areas or repositories.
- Making the pull request automation (Keep up to date, Merge when green) a server setting: it stays per browser.
- A routine's own settings: they stay on Routines.

## Decisions
The owner answered `WEB-29`:
1. **The Agents and Routines views' settings** stay in the views too, the same controls as on Settings, from one shared component and one route.
2. **The Settings dialog** goes away: the sidebar's Settings opens the page.
3. **Take it off the board** shows the `repos remove` command to copy. Nothing in the web app removes a repository or touches its secrets.

## Open questions
None.

## Done when
- The owner can change, from the web app, everything `repos modify` changes, with the same refusals.
- The board's own settings are on one Settings page, as the decision answers.
- Docs say where each setting is.

The tasks, all tagged `repo-settings`, each waiting for this spec (IDEA-29):

| Task | What | Waits for |
| --- | --- | --- |
| `WEB-29` | Decision: the three questions under Decisions (answered) | IDEA-29 |
| `BRK-129` | One repository's settings, `dryRun` and `edited` on `PATCH` (section 4) | IDEA-29 |
| `WEB-30` | A repository's page: the route, General, Areas, and the ways in (sections 1, 2) | `BRK-129` |
| `WEB-31` | A repository's page: Agents, Deploys (the form), Pull requests, and Take it off the board | `WEB-30`, `WEB-29` |
| `WEB-32` | The Settings page (section 3); the dialog goes, the views keep their settings | `WEB-31` (it moves the pull request settings out of the dialog) |
| `WEB-33` | Deploys shows IDEA-27's card and the package field | `WEB-31`, `WEB-13`, `BRK-103` |
| `WEB-34` | The specs directory in General | `WEB-30`, `BRK-119` |
| `DOC-19` | Docs: where each setting is | `WEB-32` |
