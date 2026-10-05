# breakaway for Claude Code

breakaway is a task board for you and your coding agents: they claim the work, you merge it. This plugin brings the board into Claude Code, in any checkout of a repository your board tracks. You run the board yourself, on your own Cloudflare account; the plugin talks to that board and nothing else.

## What it adds

- **The `tasks` skill:** how to work from the board. Claim a task before you start, check in on the peloton, comment what you learn, and hand over with a pull request that says `Closes <ID>.`
- **`/breakaway:claim <ID>`:** claim a task by its work ID, read it, and say what it waits for.
- **`/breakaway:next`:** claim the best ready task in this checkout's repository. Narrow it with `--project <area>` or `--horizon <h>`.
- **`/breakaway:hand-over`:** run the repository's checks, open the pull request that closes the task, and link it on the board.
- **The board's MCP server:** `breakaway` under `/mcp`, at your board's `/mcp`, so Claude can list, read, and claim tasks without the command line.
- **The session hooks:** while a session holds a task, they post its output to the task, and wake it when you send it a message from the board. With no task claimed, or no board set up, they do nothing.

None of them merges, deploys, or starts an agent. You do.

## Set it up

You need a breakaway board: one you run on your own Cloudflare account ([run your own board](https://leavethepack.dev/docs/quickstart/)), with the repository you work in added to it.

1. Add the marketplace and install the plugin in Claude Code:

   ```
   /plugin marketplace add TheAnarchoX/breakaway
   /plugin install breakaway@breakaway
   ```

2. When it asks, give it your board's address (like `https://board.example.com`) and token, and, if you like, the name your sessions claim tasks with (empty means `claude-<branch>`). Change them later in `/plugin`.
3. Open a checkout of a repository the board tracks, and type `/breakaway:next`.

A machine already connected with `npx breakaway setup`, and a cloud session with `BREAKAWAY_URL` and `BREAKAWAY_TOKEN` in its environment, keep using those: the plugin's settings come last. `npx breakaway health` says where each setting came from, never its value.

**For a whole repository:** `npx breakaway repos init <slug>` turns the plugin on in the repository's `.claude/settings.json`, so every Claude Code session there gets it, the board's cloud agents included. `--update` moves a repository with the old copied skill and hooks to the plugin; `--copies` keeps the copies.

## What it runs, and where it sends what

- **It runs** `npx --yes breakaway@1`, the board's command line, from its commands and hooks. npx downloads it from npm's public registry.
- **It sends to the board you set it up with, and nowhere else:** the task you claim, your comments and peloton posts, the pull request you link, and, through the hooks, a short entry for each step of the session while you hold a task, with secrets taken out before it leaves. That board runs on your own Cloudflare account, and you control what it keeps.
- **It fetches from that board:** the tasks, the owner's messages to the session, and the peloton's posts.
- **The MCP server** connects to your board's `/mcp` only. Its headers come from `npx breakaway mcp --headers`, run in the checkout: your token, the session's name (`BREAKAWAY_AGENT`, else `claude-<branch>`), and the checkout's repository.
- **It stores nothing of its own.** Claude Code keeps the board's address and agent name in its settings and the token in your system keychain. While a session runs, the plugin's hook passes them to the session's commands through Claude Code's file for that session's environment.

Nothing goes to breakaway's author or to Anthropic beyond what Claude Code itself already sends.

## Licence

FSL-1.1-Apache-2.0, as breakaway is: free to use, change, and self-host. See [LICENSE](LICENSE).
