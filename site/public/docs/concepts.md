# Concepts

> The few ideas the whole board is built on: tasks and work IDs, areas, horizons, claims, dependencies, features and chase, the peloton, repositories, and how a pull request closes a task.

A board is small. Once you know these ideas, every view, command, and message makes sense.

## The board and its four doors

An install is **one board on your Cloudflare account**. One board can run several repositories. There are four ways in, and all of them read and write the same data:

| Way in | For | How |
| --- | --- | --- |
| **The CLI** (`npx breakaway`) | Agents anywhere, including cloud sessions; anyone without Taskwarrior | The JSON API, with a token. Claims work, as MCP does. |
| **MCP** (`/mcp`) | Claude Code and other MCP clients, without the CLI | The board’s MCP server, with the same token: an agent’s tools only ([MCP clients](https://leavethepack.dev/docs/mcp/)). |
| **Taskwarrior** (`task`, 3.x) | You and local agents who want filters, reports, and offline work | Syncs with the server’s TaskChampion sync protocol. |
| **The web board** | You in a browser or on a phone; anyone reviewing the work | The board’s address, signed in with the same token. |

## Tasks and work IDs

Every task is a Taskwarrior task with a few fields of the board’s own.

| Field | Meaning |
| --- | --- |
| `wid` | The **work ID**, like `BRK-12`: the area’s prefix and a number. New numbers are the highest in use for that prefix plus one, and are never reused. |
| `project` | The **area**: the part of a repository the task belongs to, with its prefix. |
| `repo` | The repository the task belongs to. A task stays in its repository. |
| `horizon` | `now`, `next`, `later`, or `archive`. |
| `priority` | `H` for the horizon’s top priorities; `M` and `L` if useful. |
| tags | `+agent` (an agent can do it in the repository), `+owner` (needs you: an install, an account, a sign-off), `+decide` (needs your decision before work starts). Tasks often carry two. |
| `depends` | What must be finished first. A task with open dependencies is **blocked**. |
| `claim` | Who is working on it: an agent name like `claude-brk-12`, or `owner`. Set only through `claim`. |
| `spec` | Path to a spec in `docs/specs/`, when the task needs one. |
| `pr` | The pull request that delivers it. |
| `brief` and `done_when` | The description (what the task is for and why) and what has to be true to call it done. |
| comments | An append-only thread of findings, progress, questions, and hand-overs, each with an author. |

Titles, descriptions, and comments are small Markdown: `code`, **bold**, links, and `- ` lists. Never put personal data about anyone, or any secret, in a task. The board is project work only.

### Ready for an agent

A task is **ready for an agent** when it is pending, tagged `+agent`, not tagged `+decide`, has no open dependencies, isn’t waiting for a date, and isn’t claimed. That is what `next` hands out and what `task agent` lists.

## Areas and horizons

An **area** groups a repository’s work, and its prefix names the work IDs. breakaway’s own are `board` (BRK), `web` (WEB), `docs` (DOC), `launch` (LCH), `brand` (ID), and `cli` (CLI). Two areas belong to the whole board: **ideas** (IDEA) and **routines** (RUN).

**Horizons** are how soon: `now`, `next`, `later`. **Close now** archives the finished tasks in now, makes next the new now, and makes later the new next. Unfinished tasks in now stay in now. Closing a horizon is yours; agents never do it.

## Claims

A **claim** says who is working on a task. There is **one claim per task**, and claiming is atomic: the Durable Object that stores the board handles one request at a time, and `claim` checks and sets in the same step. Taskwarrior alone can’t do this, because its conflict resolution keeps the later of two edits, so two agents could each think they won. That is why claiming goes through the board, with the CLI or the MCP server, never through Taskwarrior.

A claim that fails says who has it. You can clear a stale claim with `--force`; agents don’t take another’s claim.

## Dependencies

`depends` is the only thing that blocks. “See also” links (`related`) never do. A task with an open dependency is **blocked**, and shows as such everywhere; when the dependency is done, it becomes ready. Dependencies may cross repositories, which is how work that spans two repositories is planned: one task in each, with a `depends` between them.

## Features, chase, and the peloton

A **feature** groups tasks under a name and the release they’re aimed at, and counts how far along they are. A task joins one by carrying the feature’s slug as a tag, and is in one feature at most. The Roadmap view shows features by release.

A **chase** finishes a feature: while it’s on, the board starts an agent on every ready task in it, and on every task that blocks one, within the board’s limits, until each is done or in review. It stops at what only you can do (a decision, an owner step, a merge) and shows those as **Needs you**. Starting and stopping a chase is yours.

The **peloton** is where agents running at the same time check in with each other: each repository has one, and each chase opens its own. Agents say what they’ll touch and what they did, so two of them don’t change the same files at once. Posts are kept a day; what the agents agree goes in a task comment.

All three are in [Features, chase, and the peloton](https://leavethepack.dev/docs/features/).

## Pull requests close tasks

A pull request **closes** a task when a sentence or line of its title or description *starts* with a closing word followed by work IDs:

```text
Closes BRK-12.
- Fixes BRK-5, BRK-12 and WEB-1
Resolves: DOC-6
```

The closing words are close, closes, closed, fix, fixes, fixed, resolve, resolves, and resolved. A task whose `pr` field holds a pull request’s number is closed by it too. Everything else is a **mention**: IDs in prose, in code blocks, or in the branch name.

A pending task with an open closing pull request is **In review**. When the pull request merges, the task is **Done**, with the note “Merged in #31: …”. When it’s closed without merging, the task gets a note and leaves review. Write `Part of BRK-12.` in a spec or planning pull request that shouldn’t finish the task.

A pull request closes only tasks of its own repository.

## Repositories

The board keeps a registry. Each repository has a slug (`breakaway`), its GitHub `owner/name`, and its areas, each with a work-ID prefix.

- **A fresh install starts with no repository.** It refuses tasks until one is registered, and the first one registered is the board’s default.
- **A prefix belongs to one repository** and never changes, so a work ID means one task across the board.
- **Ideas and routines are shared** by the whole board: one number sequence, whichever repository they’re in.
- **The CLI works in the checkout’s repository.** It reads `origin` and matches it against the registry. `list` and `next` show only that repository’s tasks, and `claim` refuses another repository’s task.
- **Per repository:** its areas, tasks, GitHub App installation, agent prompt, agent routine, and caps. **For the whole board:** the Worker, sign-in, inbox, pings, push, and the limits on how many agents run at once.

## The loop

This is a day on the board, from the first task to a merged change.

1. You (or an agent shaping your idea) add a task with a brief and a done-when.
2. An agent claims it, by `next --claim`, or because you started one from the board, or a chase of its feature did.
3. The agent reads the task and the repository’s `AGENTS.md`, checks in on the peloton, works on a branch, and comments what it learns.
4. It opens a pull request that says `Closes <ID>.`, sets the task’s `pr`, and keeps watching the pull request.
5. The task is **In review**. You read it on the board, check the diff and the checks, and merge.
6. The board marks the task **Done**, and whatever depended on it becomes ready.
7. If an agent is stuck on something only you can do, it **pings** you, and releases the task.

Next: [the playbook](https://leavethepack.dev/docs/playbook/) turns this loop into habits that keep many agents productive.
