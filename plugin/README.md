# breakaway for Claude Code

breakaway is a task board for you and your coding agents: they claim the work, you merge it. This plugin brings the board into Claude Code, in any checkout of a repository your board tracks.

## What it adds

- **The `tasks` skill:** how to work from the board. Claim a task before you start, check in on the peloton, comment what you learn, and hand over with a pull request that says `Closes <ID>.`
- **`/breakaway:claim <ID>`:** claim a task by its work ID, read it, and say what it waits for.
- **`/breakaway:next`:** claim the best ready task in this checkout's repository. Narrow it with `--project <area>` or `--horizon <h>`.
- **`/breakaway:hand-over`:** run the repository's checks, open the pull request that closes the task, and link it on the board.
- **The board's MCP server:** `breakaway` under `/mcp`, at your board's `/mcp`, so Claude can list, read, and claim tasks without the command line.
- **The session hooks:** while a session holds a task, they post its output to the task, and wake it when you send it a message from the board. With no task claimed, or no board set up, they do nothing.

None of them merges, deploys, or starts an agent. You do.

## Set it up

You need a breakaway board: one you run on your own Cloudflare account. Then:

1. Connect this machine to it once: `npx breakaway setup`. It asks for the board's address and token and keeps them in `~/.config/breakaway/tasks.env`. A cloud session uses `BREAKAWAY_URL` and `BREAKAWAY_TOKEN` from its environment instead.
2. Add the marketplace and install the plugin in Claude Code:

   ```
   /plugin marketplace add TheAnarchoX/breakaway
   /plugin install breakaway@breakaway
   ```

3. Open a checkout of a repository the board tracks, and type `/breakaway:next`.

## What it runs, and where it sends what

- **It runs** `npx --yes breakaway@1`, the board's command line. npx downloads it from npm's public registry.
- **It sends to the board you set it up with, and nowhere else:** the task you claim, your comments and peloton posts, the pull request you link, and, through the hooks, the session's output while you hold a task. That board runs on your own Cloudflare account, and you control what it keeps.
- **The MCP server** connects to your board's `/mcp` only. Its headers come from `npx breakaway mcp --headers`, run in the checkout: your token, the session's name, and the checkout's repository.
- **It stores nothing of its own.** The board's address and token stay in the files `npx breakaway setup` wrote, or in your environment.

## Licence

FSL-1.1-Apache-2.0, as breakaway is. See [LICENSE](LICENSE).
