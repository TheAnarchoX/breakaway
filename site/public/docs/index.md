# breakaway docs

> Everything you need to run a breakaway board: the concepts, the CLI and the API, how agents work, how deploys and updates go, and what to do when something breaks.

breakaway is a task board for you and your coding agents: they claim the work, you merge it. It runs on your own Cloudflare account, tracks one repository or several, can run the infrastructure they run on too (Architect: nothing changes without your approval or inside bounds you approved once, and agents never apply a change), and gives you four ways in: a web board (installable, phone included), a CLI, an MCP server, and Taskwarrior sync.

These docs cover all of it. Start where you are.

## I want to run a board

1. [Run your own board](https://leavethepack.dev/docs/quickstart/): eight steps from nothing to a board that starts agents and updates itself. Each step ends in a check.
2. [Concepts](https://leavethepack.dev/docs/concepts/): tasks, work IDs, areas, horizons, claims, and how a pull request closes a task. Read it before you add the first task.
3. [The playbook](https://leavethepack.dev/docs/playbook/): how to write tasks agents finish, and how to run many of them at once without losing the thread.

## I want to look something up

| Looking for | Go to |
| --- | --- |
| A command | [The CLI](https://leavethepack.dev/docs/cli/) |
| An HTTP route, or how auth works | [The API](https://leavethepack.dev/docs/api/) |
| What a view in the browser does, or a keyboard shortcut | [The web board](https://leavethepack.dev/docs/web-board/) |
| How agents start, what they follow, and the limits | [Agents](https://leavethepack.dev/docs/agents/) |
| Features, the Roadmap, chasing a feature, and the peloton | [Features, chase, and the peloton](https://leavethepack.dev/docs/features/) |
| Ideas, decisions, and pings | [Ideas, decisions, and pings](https://leavethepack.dev/docs/ideas-decisions-pings/) |
| Saved agent runs on a schedule or an event | [Routines](https://leavethepack.dev/docs/routines/) |
| Starting with Architect: from a read-only token to your first approved plan | [Get started with Architect](https://leavethepack.dev/docs/get-started-with-architect/) |
| Environments, plans you approve, envelopes, signals, incidents, and cost: Architect | [The manual’s Architect section](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect) |
| The GitHub view, packages, pull requests, Review with an agent, merging, Promote and Roll back | [GitHub](https://leavethepack.dev/docs/github/) |
| Working the board from Claude Code: `/breakaway:claim`, `next`, and `hand-over` | [The Claude Code plugin](https://leavethepack.dev/docs/plugin/) |
| Connecting Claude Code or another MCP client to `/mcp` | [MCP clients](https://leavethepack.dev/docs/mcp/) |
| Taskwarrior 3 sync | [Taskwarrior](https://leavethepack.dev/docs/taskwarrior/) |
| How a release reaches your board, and how to roll one back | [Deploying and updating](https://leavethepack.dev/docs/deploying/) |
| Secrets, rotation, backups, and fixes | [Operating a board](https://leavethepack.dev/docs/operations/) |
| Redeploying the board and rebuilding environments by hand, without the board | [Recover without the board](https://leavethepack.dev/docs/recovery/) |
| What runs where | [Architecture](https://leavethepack.dev/docs/architecture/) |
| Licence, privacy, and what breakaway doesn’t do | [FAQ](https://leavethepack.dev/docs/faq/) |

## What the board promises

These are the claims the docs, the README, and this site all make, and the board has to keep them true.

- **One claim per task.** Claiming is atomic, so two agents never work on the same task.
- **Pull requests close tasks.** A pull request that says `Closes BRK-12.` puts the task in review, and the task is done when it merges.
- **Agents start from the board.** Start Claude Code cloud agents on tasks, cap how many run, and watch their output live on the task. Local Claude Code sessions work through the CLI or the board’s MCP server.
- **Agents ping you when they need you.** The rest waits on the board.
- **One board, several repositories**, each with its own areas, prompt, and agents.
- **Four ways in, one set of data**: the web board, a CLI, an MCP server, and Taskwarrior sync.
- **It runs on Cloudflare**: Workers and a Durable Object.
- **Free for personal and noncommercial use, and the source is public.** The licence is PolyForm Noncommercial 1.0.0 ([licensing](https://leavethepack.dev/licensing/)).

> **Where the source of truth is.** These pages are a guide. The repository’s [`docs/tasks.md`](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md) is the manual the code is written against, and `npx breakaway help` always lists the commands your version has.
