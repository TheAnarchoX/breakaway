# The web board

> Every view in the browser, what it shows, how to install it on a phone, and the keyboard shortcuts.

Open the board’s address and paste the token once. Let your password manager keep it: the form has a username field with the install’s name. The browser stays signed in for 180 days; rotating the token signs every browser out.

## On a phone

Add the board to your home screen (Safari: Share, Add to Home Screen; Chrome: the menu, Add to Home screen) and it opens like an app, with the views behind the menu button at the top left. The web board is the supported way to use breakaway on a phone.

## The frame

The views are in a sidebar on the left. It collapses to a rail of icons (its **Collapse** button, or `[`); the browser remembers it. Agents and GitHub carry counts there: agents working, with a dot while one is live, and pull requests ready to merge. The bottom says whether the board reaches its server and opens **Settings**. On a phone the sidebar is a drawer. The top bar keeps search, **New agent** (once an agent routine is connected), **New task**, and the bell.

## The views

| View | What it shows |
| --- | --- |
| **Board** | A column per state (needs a decision, ready, in progress, in review, blocked or waiting, done in the last 30 days) and a row per horizon or area. Cards show their pull request’s number, checks, and review. On a phone you pick the column at the top. **Close now** is here. |
| **List** | Every task in a table you can sort by any column and group by state, area, or horizon. |
| **Roadmap** | Releases in version order, then Unplanned, each with its feature cards: progress, the next thing in the way, and **Chasing** while a chase is on. Open a feature for its tasks in order and its **Chase** section. See [Features, chase, and the peloton](https://leavethepack.dev/docs/features/). |
| **Infrastructure** | Architect: each repository’s environments with their health, drift, estimated cost, freeze, and the plan waiting for you, and **Add an environment**. Open one for what runs there and what each resource uses, its plans, signals, incidents, cost, and audit trail; open a plan to read what it changes and **Approve** or **Reject** it. A waiting plan’s push opens its page. With no provider connected, it says what to connect. See [Architect](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect). |
| **Dependencies** | Each chain of tasks that wait for each other, left to right. Hover or focus a task to follow its chain. Above each group, the features its tasks are in, and **Make a feature** (or **Chase**, when its tasks are all in one). |
| **Activity** | How fast the work moves: tasks finished, pull requests merged, deploys, agent runs, and tasks added over 7, 30, or 90 days next to the stretch before; your pace; lead times; who finished the work; and the stream of every change, newest first. |
| **Inbox** | Pings from agents and notes from the board, including a chase that ended. Incidents come first, production’s before the rest. Apply a proposal, mark a ping handled, or dismiss it. The bell counts the open ones, and its list dismisses a ping or a note without opening the inbox. |
| **Specs** | The repository’s specs, read from GitHub, each with its status and the tasks that link it. Open one to read it beside the list, and **Refine with an agent** to have an agent change it and bring its tasks in line, in one pull request. |
| **Agents** | The cloud agents the board started, what’s waiting to start and why, **Start the next few**, every chase that’s on, each repository’s peloton, the Agents settings, and the agent prompts. |
| **Routines** | Saved agent runs, how they start, runs used today, and a **Run** button. A routine’s **Signal trigger** makes it a runbook, started by what the board hears about an environment. |
| **GitHub** | A dashboard of what’s live: open pull requests, Live now (with a deploy pipeline), Checks on main, Packages (with npm packages), and security alerts, with the longer lists in tabs under it. **Next version** prepares the next minor or major. Select a pull request to read, review, update, and merge it without leaving the board. See [GitHub](https://leavethepack.dev/docs/github/#the-github-view). |
| **MCP** | How to connect any MCP client to the board: its address, a config with the board’s token, the apps you approved (with **Revoke**), and the Claude Code plugin. See [MCP clients](https://leavethepack.dev/docs/mcp/). |
| **Connections** | What the board leans on, each **Working**, **Needs attention**, or **Not connected**, with the fix. |
| **Settings** | This browser’s settings, the board’s, and every repository, each with a page of its own. See [Settings](#settings). |

## Settings

**Settings** at the bottom of the sidebar opens the Settings page (`#/settings`). It’s a page, not a dialog, so it works on a phone and has a link. It has three sections.

| Section | What’s in it | Where it’s kept |
| --- | --- | --- |
| **This browser** | Claim as (the name on claims you make here, `owner` by default), theme, open tasks in (sidebar or modal), notifications, and the merge method that Merge starts with and Merge when green uses | This browser only |
| **The board** | Agents: your Claude plan, agents at once, starts an hour, start by itself, and new security alerts. Routines: whether routines can run, and all routines a day. Updates: self-updates on or off, with a link to Connections for the rest. Currency: the currency Architect shows costs in, and the rate you set (**Fetch today’s rate** fills it in only when you press it) | The board, for everyone who uses it |
| **Repositories** | Each repository with its GitHub repository and areas, and a link to its page; **Add a repository**; and the ones taken off the board, collapsed. On a board with no repository yet, the wizard’s first step | The board |

The server’s state, the link to Connections, **Refresh**, **Shortcuts**, and **Sign out** are at the foot of the page.

The Agents and Routines views keep their settings too. They’re the same controls, saved the same way, so a change in one place shows in the other. A routine’s own settings, like its schedule and triggers, stay on Routines.

### A repository’s page

Each repository has a page of its own (`#/settings/<slug>`). Open it from its row on Settings, **Repository settings…** in the repository switcher (under All repositories it opens Settings at the list), its row on Connections, the Agents view’s Repositories section, or the GitHub view’s repository header. Each section saves by itself with **Save**, so a refusal names its field and the other sections keep your edits. If someone changed the same thing somewhere else since you opened the page, it says so, shows what it is now, and keeps your edit.

| Section | What you change | The same from the command line |
| --- | --- | --- |
| **General** | Its name, its GitHub repository (it asks first), its default branch (with GitHub’s beside it when they differ), and its specs directory. Its short name never changes | `repos modify <slug> --name`, `--github`, `--branch`, `--specs` |
| **Areas** | Add an area with its prefix, rename one, or remove one that never had a task. A prefix never changes, so a work ID means one task forever. Ideas and Routines are the whole board’s, so they have no settings here | `repos modify <slug> --area <project:PREFIX:Name>` adds or renames one, `--remove-area` removes one |
| **Agents** | Its caps under the board’s limits (at once and starts an hour), and its agent prompt’s path. It shows whether its routine is connected and how many saved routines run in it | `repos modify <slug> --agents-max`, `--agents-hourly`, `--prompt` |
| **Deploys** | Its pipeline: the staging and production Workers, its npm package, or both, the deploy paths file, and the workflow files (deploy, promote, roll back, and release). Without a pipeline, once the move’s config and workflows are on the default branch, it shows the [Turn on deploys](https://leavethepack.dev/docs/github/#turn-on-deploys) card, with **Set it by hand** under it to fill in the form yourself. **Copy as JSON** copies what `--pipeline` takes, and **Turn off deploys** clears it | `repos modify <slug> --pipeline <file.json\|none>` |
| **Pull requests** | Keep branches up to date and Merge when green for this repository. They stay this browser’s, and work while the board is open in it | none |
| **Infrastructure** | The policy in force for its environments, in words (it’s read from the repository’s `.github/breakaway-infra/policy.json`, so it changes by pull request), and each environment’s **Freeze** and envelope: **Add an envelope**, **Change**, and **Revoke**. Only you can, from the board | none: an agent’s token can read them and nothing else |
| **Take it off the board** | What removing it does, its open tasks and running agents, and the command to copy. The default repository stays | `repos remove <slug>` |

A repository taken off the board shows its page read only, with **Release its short name and prefixes** when nothing holds them.

### What stays in the command line

Anything that holds a secret or changes the install itself has no button. Where the page needs one, it shows the command to copy:

- `agents-connect [--repo <slug>]` connects a repository’s agent routine. The form on Connections and in the Add a repository wizard does the same without a terminal, and keeps the routine encrypted on the board.
- `github-connect` stores the GitHub App’s keys.
- `rotate-sync` and `rotate-token` make new sync credentials or a new API token.
- `init-secrets` writes a new board’s secrets.
- `repos remove <slug>` takes a repository off the board, since it also drops its routine’s secret from the Secrets Store.

`repos modify` still changes everything a repository’s page does, with the same checks and refusals. See [the CLI](https://leavethepack.dev/docs/cli/#repositories).

## A task

A task opens beside the view, or in a modal with the description and thread on the left and the fields, dependencies, pull request, and agent run in a rail on the right. On a phone it is full screen. Everything is editable in place: the title, area, horizon, priority, tags, dates, spec, pull request, and dependencies. You can add comments, claim or release, mark done, open again, or delete. Claims you make here use the name in Settings (`owner` by default).

The **Agent** section of a task starts an agent on it, with an optional note, and refines it with an agent instead of building it. Under a running agent’s live output you can send it a message.

### The task menu

Right-click a task in the Board, List, or Dependencies view (a long press on a touch screen, or the Menu key or Shift+F10 on a focused task) to act on it where it is: open it, start an agent (or **Force start** one that waits on the board’s limits), review its pull request with an agent, refine it, refine from a decided decision’s answers, start by itself when ready, claim or release, add a comment, move it to another horizon, mark it done or open it again, archive a finished one (Board and List), and copy its work ID or link. It shows only what applies to that task. Shift with the right-click, or a right-click in a text field, still opens the browser’s own menu.

### New agent

**New agent** in the top bar (`a`) starts an agent from what you write, without a task first: rough is fine, with up to 4 images and, with several repositories, the repository. The agent makes the task its own. See [Agents](https://leavethepack.dev/docs/agents/#from-a-prompt-new-agent).

### Dictation

The board’s long text fields (a task’s description and comments, New task, New idea, New agent, a decision’s answers, a message to a running agent, and the notes and prompts you give an agent) have a microphone button: press it and speak, and the words go into the field. It’s the browser’s own speech recognition. Chrome, Edge, and Safari have it; Firefox doesn’t, and Brave turns it off, so the button isn’t there. Where the browser can recognise your language on the device it does; otherwise it sends the audio to its own speech service while dictation is on. The board never sees the audio.

Filters (area, horizon, who can move it, claimed, finished) and search live in the URL, so every view and every task has a link.

## Keyboard shortcuts

One key does what you do most, and `g` then a letter goes to a view. They don’t fire while you type in a field; `?` shows them all.

| Key | Does |
| --- | --- |
| `/` | Search |
| `n` | New task |
| `i` | New idea |
| `a` | New agent |
| `s` | Switch repository (with several) |
| `[` | Collapse or expand the sidebar |
| `r` | Refresh |
| `?` | Show all shortcuts |

On the open task:

| Key | Does |
| --- | --- |
| `j` `k` | Next and previous task |
| `c` | Claim or release |
| `d` | Done |
| `m` | Write a comment |
| `Esc` | Close |

Go to a view with `g`, then:

| Key | View |
| --- | --- |
| `b` | Board |
| `l` | List |
| `m` | Roadmap |
| `d` | Dependencies |
| `n` | Infrastructure |
| `i` | Inbox |
| `t` | Activity |
| `h` | GitHub |
| `s` | Specs |
| `a` | Agents |
| `r` | Routines |
| `p` | MCP |
| `c` | Connections |
| `,` | Settings |

## Several repositories

With a second repository registered, the sidebar gets a switcher: one repository, or all of them. Board, list, dependencies, the activity stream, the inbox, Agents, and Routines follow it, and it’s kept in the browser and in the URL as `?repo=<slug>`. Every task, card, and row shows a small chip with its repository. While there’s only one repository, none of this shows.

To add one, use **Add a repository** (`#/add-repo`). It lists every step in order and ticks each one itself from what the board can see, so it never asks you to confirm what it can check.

## Themes and motion

Carbon (dark) is the default, and chalk (light) follows the system or your choice. The board respects the system’s reduced-motion setting.
