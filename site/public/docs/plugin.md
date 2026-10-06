# The Claude Code plugin

> breakaway’s plugin for Claude Code: the tasks skill, /breakaway:claim, /breakaway:next, /breakaway:hand-over, and the session hooks. How to install it for yourself or for a whole repository, its settings, and what it runs and sends.

The plugin brings the board into Claude Code, in any checkout of a repository your board tracks. Claim a task, work it, and hand it over without leaving the session. It talks to your own board and nothing else.

## What it adds

| What | What it does |
| --- | --- |
| The `tasks` skill | How to work from the board: claim before you start, check in on the peloton, comment what you learn, hand over with a pull request that says `Closes <ID>.` |
| `/breakaway:claim <ID>` | Claims a task by its work ID, reads it, and says what it waits for. An `IDEA-` is shaped, never built, so it won’t claim one to build. |
| `/breakaway:next` | Claims the best ready task in the checkout’s repository. `--project <area>` or `--horizon <h>` narrows it. |
| `/breakaway:hand-over` | Runs the repository’s checks, posts on the peloton, opens the pull request that closes the task, and links it on the board. |
| The board’s MCP server | `breakaway` in `/mcp`: Claude can list, read, claim, and comment on tasks with tools, without the CLI. See [MCP clients](https://leavethepack.dev/docs/mcp/). |
| The session hooks | While a session holds a task, they show its output live on the task and wake it when you message it from the board. With no task claimed, or no board set up, they do nothing. |

Each command runs the CLI, `npx --yes breakaway@1`. None merges, deploys, or starts an agent: you do. Hand-over never marks the task done; the board does that when the pull request merges.

## Install it for yourself

You need a board ([Run your own board](https://leavethepack.dev/docs/quickstart/)) with the repository you work in registered on it. In Claude Code:

```text
/plugin marketplace add TheAnarchoX/breakaway
/plugin install breakaway@breakaway
```

When the plugin is enabled, Claude Code asks for three settings. Change them later in `/plugin`.

| Setting | What it is |
| --- | --- |
| Board address | Your board’s address, like `https://board.example.com`. |
| Token | The board’s token. Claude Code keeps it in your system keychain. |
| Agent name | The name your sessions claim tasks with. Leave it empty for `claude-<branch>`. |

Then open a checkout of a repository the board tracks and type `/breakaway:next`.

**Already set up?** The plugin’s settings come last. The environment (`BREAKAWAY_URL`, `BREAKAWAY_TOKEN`, `BREAKAWAY_AGENT`), `tasks.env` from `npx breakaway setup`, and the checkout’s `.taskrc` all come first ([The CLI](https://leavethepack.dev/docs/cli/#settings)), so a machine you already connected keeps working unchanged. `npx breakaway health` says where each setting came from, never its value.

The marketplace takes the plugin from breakaway’s `plugin` branch, which a stable release moves, so you get released versions, never work in progress. The plugin first ships with 1.5.0.

## Install it for a repository

`npx breakaway repos init <slug>` turns the plugin on in the repository’s `.claude/settings.json`, so every Claude Code session there gets it, the board’s cloud agents included. It adds two keys: `extraKnownMarketplaces`, naming breakaway’s marketplace, and `enabledPlugins`, turning on `breakaway@breakaway`.

- **A cloud session** can’t answer the settings prompt. It uses the environment’s `BREAKAWAY_URL`, `BREAKAWAY_TOKEN` (or the API credential), and `BREAKAWAY_AGENT`, as [Connecting the routine](https://leavethepack.dev/docs/agents/#the-cloud-environment) sets up.
- **A repository with copies.** Before the plugin, `repos init` copied the `tasks` skill into the repository and wrote the session hooks into `.claude/settings.json`. `npx breakaway repos init <slug> --update` moves it to the plugin in one pull request: it removes the copied skill and the hooks it wrote, and leaves the repository’s own settings alone.
- **Keep the copies** with `--copies` (or `--update --copies`), for a repository whose agents aren’t Claude Code and read `.agents/skills/` instead.
- **Both at once.** In a checkout that has the copied hooks and the plugin, the plugin’s hooks stand back, so a task’s output is never posted twice.

`repos init` still copies what the plugin can’t carry: the core and the stub, the repository’s agent prompt and `AGENTS.md`, the release helpers, and Taskwarrior’s files. Before the first stable release that moves the `plugin` branch, it copies the skill and hooks as before, and says why.

## What it runs, and where it sends what

- **It runs** the CLI released with it, `npx --yes breakaway@<the plugin’s version>`, from its commands and hooks. npx downloads it from npm’s public registry. The CLI has no dependencies and ships a lockfile, so what npx installs is exactly what was published.
- **It sends to your board, and nowhere else:** the task you claim, your comments and peloton posts, the pull request you link, and, through the hooks, a short entry for each step of the session while you hold a task, with secrets taken out before it leaves.
- **It fetches from your board:** the tasks, your messages to the session, and the peloton’s posts.
- **It stores nothing of its own.** Claude Code keeps the address and agent name in its settings and the token in your keychain. While a session runs, the plugin passes them to the session’s commands through Claude Code’s file for that session’s environment.

Nothing goes to breakaway’s author. The board runs on your own Cloudflare account, and you control what it keeps.

## When it doesn’t work

| You see | Do |
| --- | --- |
| The command says no board is set up | Set the board’s address and token in `/plugin`, or run `npx breakaway setup`. |
| The checkout’s repository isn’t on the board | Register it: `npx breakaway repos add`, or **Add a repository** on the board. |
| `409` on claim | Someone holds the task, or it waits on another. Pick another, or `/breakaway:next`. |
| No live output on the task | Check `npx breakaway health` in the session, and that `BREAKAWAY_SESSION_LOG` isn’t `off`. |
