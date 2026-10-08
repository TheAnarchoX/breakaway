# MCP clients

> Connect Claude Code, or any MCP client, to your board’s MCP server at /mcp: the line to add, the three headers, the tools it has and the ones it never will, why the token goes only into a client you run, and how apps sign in instead.

Every board is also an MCP server, at `/mcp` on its own address. Any agent or app that speaks MCP over HTTP, in a terminal, an editor, or a chat app, lists, claims, and comments on tasks with tools instead of the CLI, with the same token and the same rules: one claim per task, and nothing merges or deploys on an agent’s word. It’s on as soon as your board updates, with nothing to turn on.

The board’s **MCP** page has its address to copy, a config to paste with the agent name and repository you pick, and the apps you connected. [The Claude Code plugin](https://leavethepack.dev/docs/plugin/) connects Claude Code for you. Without the plugin, it’s three steps.

## Connect Claude Code

**1. Print the config.** In a checkout of a repository your board tracks:

```sh
npx breakaway mcp
```

It prints a `claude mcp add` line and an `.mcp.json` entry, with your board’s address, the checkout’s repository, and `$BREAKAWAY_TOKEN` where the token goes, never the token itself. It writes nothing.

**2. Add it**, in a terminal where `BREAKAWAY_TOKEN` is set:

```sh
claude mcp add --transport http breakaway https://board.example.com/mcp \
  --header "Authorization: Bearer $BREAKAWAY_TOKEN" \
  --header "X-Breakaway-Agent: claude-my-branch" \
  --header "X-Breakaway-Repo: widgets"
```

Or put the printed entry in the checkout’s `.mcp.json`. Claude Code fills in `${BREAKAWAY_TOKEN}` from the environment when it starts, so the file never holds the token.

**3. Check it.** `npx breakaway mcp --check` says whether `/mcp` answers and lists its tools. In Claude Code, type `/mcp`: you should see `breakaway` connected. Ask “what’s the next task on the board?” and it answers from the board.

## The three headers

| Header | What it is |
| --- | --- |
| `Authorization: Bearer <token>` | The board’s token, the one the CLI uses. Without it, or with a wrong one, `/mcp` answers `401`. The web board’s sign-in isn’t accepted. |
| `X-Breakaway-Agent: <name>` | The name the client claims and comments as, like `BREAKAWAY_AGENT`. Every tool that writes needs it. |
| `X-Breakaway-Repo: <slug>` | The repository the client works in, like the checkout’s `origin`. Listing, `next_task`, adding tasks, and specs stay in it, and claiming another repository’s task is refused. |

## What it can do

| Tool | Does |
| --- | --- |
| `health` | The board’s state and release. |
| `list_tasks`, `show_task` | The repository’s open tasks, best first, and one task in full. |
| `next_task` | The best ready agent task; `claim: true` claims it too. |
| `claim_task`, `release_task` | Claim a task, atomically, and give it back. |
| `comment` | A comment, signed with the agent’s name. |
| `add_task`, `modify_task` | A new task, and changes an agent may make to one it holds or made. |
| `ping_owner` | A ping to you about the task it holds. |
| `review` | Its verdict on the pull request that closes the task it holds. |
| `peloton`, `peloton_post` | Who’s riding, and a check-in, step, or reply. |
| `messages` | Your messages to the session on the task it holds. |
| `list_specs`, `show_spec`, `features` | The repository’s specs and the features on the roadmap. |
| `pull_request` | A pull request’s checks, reviews, and whether it can merge. |
| `infra_environments`, `infra_environment` | The repository’s environments, and one with its desired state and inventory. |
| `infra_plans`, `infra_plan` | Plans, newest first, and one with its changes, cost, what else it touches, and the policy’s answer. |
| `infra_signals`, `infra_incidents` | The signal stream or its daily summaries, and open incidents. |

The read-only tools are marked so a client can run them without asking. A refused call, like a `409` on a claimed task, comes back with the board’s own message. The server also has **resources**, a task, a spec, and the repository’s agent prompt, and two **prompts**: `work_on_task` and `shape_idea`, so a client that never read the `tasks` skill follows the same loop: claim, read, check in, build, hand over.

## What it never does

There’s no tool for `done` (pull requests close tasks), for `force`, or for `autostart`, and none for starting agents, chases, routines, repositories, merging, releasing, promoting or rolling back, approving, rejecting, freezing, or applying a plan, answering a decision, resolving a ping, messaging an agent, settings, or updates. Those are yours, on the board or with your own CLI. Ask a connected client to merge, and it says it can’t.

## The token

The token is your board’s full token: it reaches everything the API does. Give it only to a client you run, on a machine you trust, and keep it in the environment, never in a committed file. When you rotate it ([Operating a board](https://leavethepack.dev/docs/operations/#rotating-secrets)), every MCP client stops with `401` until its config has the new one.

## Sign in from an app

An app that can open a sign-in, like claude.ai or Claude Desktop, signs in instead of sending the token. Add your board’s address followed by `/mcp`, like `https://board.example.com/mcp`, as a remote MCP server (some apps call it a custom connector). The board opens its sign-in page: signed in on the board, name the connection, pick its repository and the agent name it claims as, and press **Approve**, or **Deny**.

Each connection gets its own token, never the board’s: it works only on `/mcp`, for that one repository and agent name. The board’s **MCP** page lists them under **Connected apps**, with **Revoke**, which stops a connection at once.

## When it doesn’t work

| You see | Do |
| --- | --- |
| `--check` says the install has no MCP server yet | Update and deploy your board ([Deploying and updating](https://leavethepack.dev/docs/deploying/)). |
| `401` | Set `BREAKAWAY_TOKEN` to the board’s current token, and add the server again. |
| A tool asks for `X-Breakaway-Repo` | Run `npx breakaway mcp` in a checkout of a repository the board tracks, or add the repository on the board. |
| A tool asks you to name yourself | Add the `X-Breakaway-Agent` header. |
| `409` on claim | Someone holds the task, or it waits on another. Pick another, or call `next_task`. |
