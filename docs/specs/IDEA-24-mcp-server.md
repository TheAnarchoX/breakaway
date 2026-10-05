# IDEA-24 · An MCP server on every install

Task: IDEA-24 on the board · Status: draft

## Problem
Agents work the board through the CLI, `npx breakaway`. That needs Node, a checkout whose `origin` names the repository, the token in the environment, and an agent that knows the commands from the `tasks` skill. Claude Code in a terminal has all of that. Claude Desktop, claude.ai, and other MCP clients don't: they can't run the CLI, so today they can't see or work the board at all.

The owner's idea: every install also serves the board as an MCP server. Its tasks, claims, comments, pings, peloton, specs, and pull requests become MCP tools and resources, so any MCP client works the board without the CLI, with the same token and the same rules: one claim per task, and nothing merges or deploys on an agent's word.

## Fit
- **Free, and self-hosted.** The server is part of each install's own Worker, on its owner's Cloudflare account. There's no hosted MCP server and nothing to sign up for.
- **An install keeps its data.** The server only answers; it calls nothing new. A client reads what the CLI already shows an agent with the same token. Logs hold no task content, as everywhere in the Worker.
- **The person who runs the board decides.** The server is a second way for an *agent* in: it exposes only what an agent may do with the CLI today. Everything that is the owner's (merging, releasing, promoting, starting agents, chases, routines, repositories, answering decisions, resolving pings, messages, notifications) is left out, and the Worker's own guards (the cookie-only routes, the refused agent `by`) still stand behind it.
- **One claim per task, and pull requests close tasks.** Claiming through MCP is the same atomic claim; there is no `force`, and no `done` (the board finishes a task when its pull request merges).
- **One board, several repositories.** A connection is to one repository, as a checkout is (Design, section 2), so a public repository's agent can't list another repository's work through it.
- **Three ways in, one set of data.** This adds a fourth way in. The brand guide's claim changes in the same pull request that ships it (section 6).
- **Taskwarrior stays first-class.** Untouched: MCP tools call the same store methods the API does.

## Design

### 1. The endpoint
`/mcp` on the install's own URL, beside `/api/*`, speaking MCP's **Streamable HTTP** transport in its **stateless** form:

- `POST /mcp` takes one JSON-RPC message and answers with one JSON response (`Content-Type: application/json`). No server-sent events stream, no `Mcp-Session-Id`: every request carries everything it needs, so the Worker keeps no MCP session state and the Durable Object doesn't change shape.
- `GET /mcp` and `DELETE /mcp` answer `405`, which the transport allows for a server with no stream.
- Methods: `initialize` (server name `breakaway`, the release as its version, the capabilities `tools`, `resources`, `prompts`), `notifications/initialized` (`202`, no body), `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`. Anything else is JSON-RPC `-32601`.
- The protocol version is the newest revision MCP has published when it's built, and `initialize` also accepts the one before it.
- **Hand-written, not the SDK.** Stateless JSON-RPC over one route is a few hundred lines, tested like the rest of the Worker. The official SDK would bring its own dependencies and a transport built for long-lived sessions into a Worker that has no build step of its own. If a later MCP revision makes the hand-written server costly, swapping it is one task.

A tool's result is `content` with one text block (the same short summary the CLI prints) and `structuredContent` with the API's JSON, so clients that read either work. A refused call (a `409` claim, a `403`) is a tool result with `isError: true` and the Worker's own error text, which already says what failed and what to do; a malformed call is a JSON-RPC error.

### 2. Who's calling: the token, the agent, and the repository
- **The token.** `Authorization: Bearer <the install's API token>`, the token the CLI uses, checked by `authenticate` in `src/auth.js`. The cookie is not accepted on `/mcp`: the browser has the web board.
- **The agent's name.** `X-Breakaway-Agent: <name>`, as `BREAKAWAY_AGENT` is for the CLI. Every tool that writes needs it and refuses without it (`isError`, "name yourself: set the X-Breakaway-Agent header"). The server always sends it as the agent (`agent`, `by`) to the store, and never sends an empty `by`, so an MCP call is never taken for the owner's own CLI.
- **The repository.** `X-Breakaway-Repo: <slug>`, as the checkout's `origin` is for the CLI. It scopes `list_tasks`, `next_task`, `add_task`, and `list_specs` to that repository, and `claim_task` sends it so another repository's task is refused, exactly as the CLI's `claim` is (CLD-123). `show_task` works for any work ID, as `show` does. Without the header, the tools that need it refuse and name it; a slug the board doesn't track is refused at `initialize`.

A client sets all three once, in its config. For Claude Code:

```sh
claude mcp add --transport http breakaway https://<your board>/mcp \
  --header "Authorization: Bearer $TASKS_API_TOKEN" \
  --header "X-Breakaway-Agent: claude-<branch>" \
  --header "X-Breakaway-Repo: <slug>"
```

The CLI prints this for the checkout it runs in (section 5), with the token as an environment variable, never its value.

### 3. Tools
Each tool calls the same `TaskStore` method its CLI command's API route does, with the same guards.

| Tool | Does | CLI | Read only |
| --- | --- | --- | --- |
| `health` | The board's state and release | `health` | yes |
| `list_tasks` | Open tasks in the repository, best first; `ready`, `blocked`, `mine`, `project`, `tag`, `horizon` narrow it | `list` | yes |
| `show_task` | One task: description, done when, comments, spec, dependencies, what it blocks | `show` | yes |
| `next_task` | The best ready agent task in the repository; `claim: true` claims it in the same step | `next` | no |
| `claim_task` | Claim a task (atomic; never `force`) | `claim` | no |
| `release_task` | Give it back, with an optional closing comment | `release` | no |
| `comment` | Add a comment, signed with the agent's name | `comment` | no |
| `add_task` | A new task in the repository: `title`, `project`, `horizon`, `tags`, `depends`, `brief`, `done_when`, `spec`, `decision`; never `autostart` | `add` | no |
| `modify_task` | Change what an agent may: on a task it holds, `pr`, `spec`, `tags`, `depends`, `related`; on a task it made, also `brief` and `done_when`; never `autostart`, a `horizon-*` tag, or `status` | `modify` | no |
| `ping_owner` | A ping on the task the agent holds, with `kind` and an optional `proposal` | `ping` | no |
| `review` | The agent's verdict on the pull request that closes the task it holds | `review` | no |
| `peloton` | Who's riding and what they posted since the agent last read | `peloton` | yes |
| `peloton_post` | `checkin`, `step`, or `reply`, as the holder of a claimed task | `peloton checkin/step/reply` | no |
| `messages` | Messages from the owner on the task the agent holds, not yet seen | `hook wait` | yes |
| `list_specs`, `show_spec` | The repository's specs, read from GitHub's default branch | `specs`, `specs show` | yes |
| `features` | Features by release, and one feature's tasks | `features`, `features show` | yes |
| `pull_request` | A pull request's checks, reviews, and mergeability | `github` | yes |

Read-only tools carry MCP's `readOnlyHint`, so a client can run them without asking. Every input has a JSON Schema in `tools/list`, with the same limits the API enforces (a comment's length, a ping's 500 characters, the decision file's 20 questions).

**Never a tool**, whatever a client asks: `done`, `force` on anything, `autostart`, `agents start/next/new/refine`, `routines`, `chase`, `repos`, `github fix/review/release/promote/rollback/merge`, answering or reopening a decision, resolving a ping, messaging an agent, `attach`, `idea`, `horizon close`, `export`, `rekey`, push, connections, settings, and self-update. These are the owner's, or the owner's press on the board. `tools/call` with any other name is an error.

### 4. Resources and prompts
- **Resources:** `breakaway://task/{id}` (a task, as `show_task` returns it, `text/markdown`), `breakaway://spec/{path}` (a spec's Markdown), and `breakaway://prompt` (the repository's agent prompt, as `/api/agents/prompt` reads it from the default branch, and the board's core, `prompts/core.md`, read the same way and cached as briefly). `resources/list` lists the agent's claimed tasks and the prompt; the rest are templates.
- **Prompts:** `work_on_task` (argument: a work ID) gives a client the core's "How to work" with the task filled in, so an MCP client that never read the `tasks` skill follows the same loop: claim, read, check in, build, hand over. `shape_idea` does the same for an `IDEA-`.

Text from tasks, comments, and the peloton is returned as data, never as instructions; the prompts say so, as the core does.

### 5. Connecting: `npx breakaway mcp`
A new CLI command prints, for the checkout it runs in, the `claude mcp add` line above and an `.mcp.json` entry, with the board's URL, the checkout's repository, and `${TASKS_API_TOKEN}` where the token goes. It writes nothing and never prints the token's value. `npx breakaway mcp --check` calls `initialize` and `tools/list` and says whether the server answers, with the board's error if not.

`repos init` doesn't add the server to other repositories: the plugin idea (IDEA-25) packages the server, the skill, and the hooks together, and builds on this.

### 6. The manual and the brand
The manual (`docs/tasks.md`) and the site's docs get a section on connecting an MCP client: Claude Code with the line above, the headers, which tools exist and which never will, and that the token is the board's full token, so it goes only to a client the owner trusts. The brand guide's "Three ways in" claim becomes four (the web board, the CLI, MCP, and Taskwarrior sync), and the README and site follow it, in the pull request that ships the docs.

### 7. Edge states
- **No token, a short token, or a wrong one:** `401` with `WWW-Authenticate: Bearer`, before any JSON-RPC.
- **A fresh install with no repositories:** `initialize` works without `X-Breakaway-Repo`; the repository's tools refuse and say to add a repository on the board.
- **A repository that's removed later:** the repository's tools refuse with the Worker's own error.
- **The owner rotates the token:** every MCP client stops with `401` until its config has the new one, as the CLI does.
- **A request that's too large:** `413`, with the API's body limit.

## Privacy
- Nothing new is stored: the server is stateless, and every write is one the API already makes and logs in the task's activity, signed with the agent's name.
- Nothing new leaves the install: the server makes no outbound call that the API route it wraps doesn't already make (GitHub, for specs and pull requests).
- A client sees what the CLI shows an agent in that repository. The token is the board's full token: the manual says so, and that it goes only into a client the owner runs.

## Out of scope
- **Owner actions over MCP.** Merging, releasing, starting agents, answering decisions, and the rest in section 3's list stay on the signed-in board and the owner's CLI.
- **The server-sent events stream and server-initiated notifications** (a ping answered, a message arriving). A client asks with `messages` and `peloton`; pushing them can follow if clients need it.
- **Sign-in for clients that can't send a header** (claude.ai's and Claude Desktop's connectors use OAuth). It's a decision for the owner (Open questions) and its own task.
- **Packaging the server as a plugin, and hooks:** IDEA-25.
- **Images:** `attachments` stays in the CLI.

## Open questions
Asked as a decision on the board, in the task that waits for it:

1. **Claude's apps.** claude.ai and Claude Desktop connect to remote MCP servers through OAuth, not a header. Should the board offer a sign-in that the owner approves on the signed-in board, giving that connection its own token (named, scoped to one repository and one agent name, never the owner's, revocable on the board)? Recommended: yes, after the token version ships.
2. **On by default.** Should `/mcp` answer on every install as soon as it updates (recommended: it adds no new access, since the same token already reaches `/api/*`), or only once the owner turns it on in Settings?

## Done when
- `/mcp` on an install answers MCP's Streamable HTTP transport, statelessly, with the bearer token, and Claude Code connected with the documented line can list, show, claim, comment on, and release a task, and post on the peloton.
- No tool reaches an owner action, `force`, `autostart`, or `done`, and tests prove the refusals.
- `npx breakaway mcp` prints a working config for the checkout without the token's value.
- The manual, site docs, README, and brand claims describe the fourth way in.
- The owner has answered the decision, and the OAuth task is either built or set aside by that answer.

The tasks, all in the `ai-native` feature, all waiting for IDEA-24: listed in the pull request that adds this spec.

## How to check it
1. Update and deploy your board as usual once the tasks are merged.
2. In a checkout of one of your repositories, run `npx breakaway mcp`. You should see a `claude mcp add` line with your board's address and the repository's name, and `$TASKS_API_TOKEN` where the token goes, never the token itself.
3. Run that line in a terminal where `TASKS_API_TOKEN` is set, start Claude Code, and type `/mcp`. You should see `breakaway` connected, with tools like `list_tasks` and `claim_task`.
4. Ask Claude "what's the next task on the board?". It should answer from the board without running `npx breakaway`.
5. Ask it to claim a small task and comment on it. On the web board, the task should show it as claimed by the name you set, with the comment.
6. Ask it to merge a pull request or start an agent. It should say it can't: there's no tool for that.
