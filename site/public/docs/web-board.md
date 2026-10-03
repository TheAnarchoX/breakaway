# The web board

> Every view in the browser, what it shows, how to install it on a phone, and the keyboard shortcuts.

Open the board’s address and paste the token once. Let your password manager keep it: the form has a username field with the install’s name. The browser stays signed in for 180 days; rotating the token signs every browser out.

## On a phone

Add the board to your home screen (Safari: Share, Add to Home Screen; Chrome: the menu, Add to Home screen) and it opens like an app, with the views behind the menu button at the top left. The web board is the supported way to use breakaway on a phone.

## The frame

The views are in a sidebar on the left. It collapses to a rail of icons (its **Collapse** button, or `[`); the browser remembers it. Agents and GitHub carry counts there: agents working, with a dot while one is live, and pull requests ready to merge. The bottom says whether the board reaches its server and opens **Settings**. On a phone the sidebar is a drawer. The top bar keeps search, **New task**, and the bell.

## The views

| View | What it shows |
| --- | --- |
| **Board** | A column per state (needs a decision, ready, in progress, in review, blocked or waiting, done in the last 30 days) and a row per horizon or area. Cards show their pull request’s number, checks, and review. On a phone you pick the column at the top. **Close now** is here. |
| **List** | Every task in a table you can sort by any column and group by state, area, or horizon. |
| **Dependencies** | Each chain of tasks that wait for each other, left to right. Hover or focus a task to follow its chain. |
| **Activity** | How fast the work moves: tasks finished, pull requests merged, deploys, agent runs, and tasks added over 7, 30, or 90 days next to the stretch before; your pace; lead times; who finished the work; and the stream of every change, newest first. |
| **Inbox** | Pings from agents and notes from the board. Apply a proposal, mark a ping handled, or dismiss it. The bell counts the open ones. |
| **Agents** | The cloud agents the board started, what’s waiting to start and why, **Start the next few**, the Agents settings, and the agent prompts. |
| **Routines** | Saved agent runs, how they start, runs used today, and a **Run** button. |
| **GitHub** | Open pull requests with checks and reviews, Dependabot alerts, deploys, CI runs, and commits on `main`. Select a pull request to read, update, and merge it without leaving the board. |
| **Connections** | What the board leans on, each **Working**, **Needs attention**, or **Not connected**, with the fix. |
| **Settings** | The name your claims use, how tasks open, notifications, and the two pull request settings. |

## A task

A task opens beside the view, or in a modal with the description and thread on the left and the fields, dependencies, pull request, and agent run in a rail on the right. On a phone it is full screen. Everything is editable in place: the title, area, horizon, priority, tags, dates, spec, pull request, and dependencies. You can add comments, claim or release, mark done, open again, or delete. Claims you make here use the name in Settings (`owner` by default).

The **Agent** section of a task starts an agent on it, with an optional note, and refines it with an agent instead of building it. Under a running agent’s live output you can send it a message.

Filters (area, horizon, who can move it, claimed, finished) and search live in the URL, so every view and every task has a link.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `/` | Search |
| `n` | New task |
| `i` | New idea |
| `b` `l` `g` `o` `a` `h` `x` `u` | Switch views |
| `w` | Connections |
| `[` | Collapse or expand the sidebar |
| `s` | Switch repository (with several) |
| `j` `k` | Next and previous task |
| `c` | Claim or release |
| `d` | Done |
| `Esc` | Close |
| `?` | Show all shortcuts |

## Several repositories

With a second repository registered, the sidebar gets a switcher: one repository, or all of them. Board, list, dependencies, the activity stream, the inbox, Agents, and Routines follow it, and it’s kept in the browser and in the URL as `?repo=<slug>`. Every task, card, and row shows a small chip with its repository. While there’s only one repository, none of this shows.

To add one, use **Add a repository** (`#/add-repo`). It lists every step in order and ticks each one itself from what the board can see, so it never asks you to confirm what it can check.

## Themes and motion

Carbon (dark) is the default, and chalk (light) follows the system or your choice. The board respects the system’s reduced-motion setting.
