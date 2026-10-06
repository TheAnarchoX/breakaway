# BRK-176 · Agent providers: more than Claude, with pooled capacity

Task: BRK-176 on the board, in the `architect` feature · Status: draft

## Problem

The board starts every cloud agent the same way: it fires a Claude Code routine on claude.ai ([CLD-35](CLD-35-cloud-agents.md)). That works, but it ties the board's capacity to one vendor and one subscription. When Claude's hourly limit is reached or the plan's usage runs out, ready tasks wait, even if the owner pays for another service that could run them. [IDEA-19](IDEA-19-architect.md) lists this as a precursor: "Agents become pluggable, like hosts", with more providers (OpenAI's cloud agents among them) behind one start path, sharing the board's slots and budgets.

The owner decided in BRK-169 to have a spec now, inside Architect, and to build it later as its own idea. This is that spec. Nothing in Architect waits for it, and Architect's agents keep today's start path.

## Fit

- **Free and self-hosted.** A provider is a service the owner already pays for and connects themselves, on their own account. The board adds no hosted broker and no account of its own.
- **An install keeps its data.** A provider is a connection the owner makes, like GitHub, push, or the Claude routine today. The board calls only the providers the owner connected, and sends them only the start payload it sends Claude now: the work ID, the agent's name, the repository, the mode, and the owner's note. No telemetry.
- **The person who runs the board decides.** Which providers run, in which order, with which caps, is the owner's choice in Settings. An agent can't pick its provider, start another agent, or change the pool. Nothing here merges or deploys.
- **One claim per task.** The atomic claim stays before every start, whichever provider runs it. Two providers never start two agents on one task.
- **Taskwarrior stays first-class.** The task model gains nothing new. The `session` field keeps holding a link; only the hosts it accepts widen.
- **Claims that must stay true.** "Agents start from the board. Start Claude Code cloud agents on tasks…" stays true while Claude is the only provider. The build task that ships a second provider changes that claim in the same pull request (see **Done when**).

## Words

- **Agent provider:** a service that runs a cloud coding agent on a task, started over an API: Claude Code routines today. Always "agent provider" in code and docs, never bare "provider", which is Architect's word for an infrastructure platform (`src/infra-provider.js`, BRK-173). The two interfaces share nothing but the idea.
- **Connection:** one agent provider connected for one repository (today: one repository's routine). A repository can have several.
- **Pool:** the connections the board may start agents on, with their order and caps. The install has one pool; each repository draws on its own connections in it.

ID-5 owns the brand's words; the build adds these there.

## Design

### What exists, and stays

Every start already goes through one function: `startAgent()` in `src/store-agents.js`. It checks the task may start, checks the limits, claims the task atomically, calls `fireRoutine()` (the only call to Claude), records an `agent_runs` row, and releases the claim if the call fails. Manual starts, "Start the next N", autostart, the chase, refine, Dependabot review, fix-pr, pr-review, general agents, kickoff, routines mode, routine runs (manual, schedule, GitHub, webhook), alerts, and the move to the deploy flow all call it. Pings start nothing.

So the seam is narrow: the build replaces the one call to `fireRoutine()` with a call to the chosen connection's provider, and moves the limits that are Claude's into the Claude provider. Every caller stays as it is, and so do runs, routines, the chase, and pings.

### The interface

`src/agent-provider.js` defines an agent provider as a plain object. The Claude provider (`src/agent-claude.js`) is today's code moved behind it, with no change in behaviour. A fake provider backs the tests, and a shared contract test runs against every real one, as Architect does for its own providers.

| Member | What it is | Claude today |
| --- | --- | --- |
| `id`, `name` | A slug (`claude`) and the name people see (`Claude`) | — |
| `agentPrefix` | The agent-name prefix it starts under, unique across providers | `claude` (`claude-<id>`, `claude-refine-<id>`, `claude-<id>-fix`) |
| `credentials` | The fields a connection needs, each with a validator and whether it's secret | the routine's `/fire` URL and its token |
| `check(credentials)` | A cheap test that the connection works, for Connections; reads nothing from the repository | URL and token shape; the session report confirms the rest |
| `start(credentials, payload)` | Starts one session. Returns `{ id, url }`, or throws an `AgentError` with a `hold` | `fireRoutine()` |
| `sessionHosts` | The hosts a session link may be on, for the task's `session` field | `claude.ai/code/` |
| `limits` | The provider's own caps on starting, fixed or by plan (below) | 30 an hour a routine, 100 an hour the account, the Pro/Max plans |
| `output` | How a running session reaches the task: `hooks` or `cli` (below) | `hooks` |
| `stop(credentials, session)` | Optional. Stops a running session | none: Claude has no API for it |
| `modes` | The payload modes it can run | all of them |

`start` gets the payload as the board builds it now (`firePayload()`: `Task:`, `Title:`, `Agent name:`, `Started:`, `Repository:`, `Mode:` and the lines each mode adds), so every provider receives the same text. How it's sent (a JSON field, a prompt, a task body) is the provider's business.

Errors keep today's three holds, so the queue, the chase, and the views read them the same way for every provider:

- `limit` with an `until`: the provider's rate limit; try this connection again after `until`.
- `paused`: the connection is broken (token refused, routine gone); nothing starts on it until the owner connects it again, and Connections says how.
- `backoff`: anything else; try again in 10 minutes.

A provider adds nothing to the board's status words: the run states in `src/run-state.js` stay as they are.

### Connections and credentials

Each connection is a row: repository, provider, its credentials sealed the way kept routines are sealed now (AES-GCM with a key derived from the sync key), its order, its caps, and whether it's on. `kept_routines` becomes the Claude rows of an `agent_connections` table; the default repository's `TASKS_ROUTINE_URL` and `TASKS_ROUTINE_TOKEN`, and `TASKS_ROUTINES`, keep working as Claude connections read from the Secrets Store, so no install has to reconnect.

- The owner connects one from the repository's settings or Connections (a form, like the routine form today) or with `npx breakaway agents-connect --provider <id>`; `--provider` defaults to `claude`, so today's command is unchanged. Connecting stays the owner's: agents never run it (`AGENTS.md`).
- Credentials are shown only as "set", are sent only to their provider, and never reach an agent session, the CLI's output, a task, or a log.
- Each connection has a row on Connections, grouped by provider instead of under "Claude", with its fix in words when it's broken.
- Secret names come from `src/install.js`, never hard-coded, so an install keeps its own prefix.

### The pool: who runs the next task

When a task may start, `startAgent()` asks the pool for a connection:

1. The task's repository's connections that are on, in the owner's order, and that support the payload's mode.
2. Skip a connection that has a hold (`limit` before its `until`, `paused`, or `backoff`), or whose provider limits or the connection's own caps are used up this hour or day.
3. Take the first one left. If none is left, the task waits in the queue with the reason ("every connection is at its limit until 14:05 UTC"), as it does now when the routine is held.
4. If the start fails with `limit` or `backoff`, the hold goes on that connection and the board tries the next one in the same start, at most once per connection. A `paused` failure does the same and also shows on Connections. The claim is held across the retries and released only if every connection failed.

The order is the owner's, per repository; there is no automatic balancing by cost or speed, because the board doesn't know either. A start from a task's page can pick a connection ("Start with Claude ▾"); the rest use the order. Force start skips the board's own caps, as now, but never a provider's.

**What's shared, and what's per connection.** The owner's caps stay install-wide, whichever provider runs the agent: agents at once, starts an hour, the per-repository caps, the per-area rule in the chase, and routines' daily caps and gaps. "Agents at once" counts every running agent on every provider, so adding a provider adds no parallel agents unless the owner raises the cap. A provider's own limits (Claude's 30 an hour per routine and 100 an hour per account) count only that provider's starts. The plan picker (`src/plans.js`, `claude_plan`) moves into the Claude provider's `limits`: a plan sets the Claude ceilings and their defaults, and another provider may declare its own plans or none. The board-wide ceilings become the sum over connected providers.

### Agent names

A run's agent name starts with its provider's prefix: `claude-<id>` for Claude, `<prefix>-<id>` for another. The board recognises agent claims today with a fixed pattern, `/^(claude|codex)-/`, in `store.js`, `store-agents.js`, `store-chase.js`, `mcp.js`, and `stats.js`. The build replaces it with one helper that reads the registry's prefixes, so refine claims, takeovers of a quiet claim, chase tracking, and the stats work for every provider. Prefixes are lowercase words and never `owner` or `board`.

### Live output

There is still no read API to rely on, so sessions keep reporting themselves.

- **`hooks`:** the agent's runtime runs the CLI's session hook after each tool call and when it stops, as Claude Code does today (`sessionHooks()`, `.claude/settings.json`, the plugin). Live output, the quiet and silent states, and owner messages work as now. A provider whose runtime has hooks gets its own hook file rendered next to Claude's, from the same `sessionHooks()` description, by the build task that adds it; `session-log.js` learns that runtime's tool names.
- **`cli`:** the runtime has no hooks. The task shows what the agent does through the CLI (claim, comments, notes, check-in, the pull request), and each CLI call counts as a sign of life. Late and silent wait longer (an hour and two, instead of today's 10 and 30 minutes: `LATE_MS` and `SILENT_MS`), and the task says "Shows its board steps only" so the owner knows why it's sparse.

The environment report sent by `claim` (`src/session-report.js`) stays, keyed by provider: it's how Connections learns a connection's cloud environment can reach the board.

### Messages from the owner

Messages are stored the same way for every provider (`src/store-messages.js`). With `hooks`, they arrive as now. With `cli`, every CLI command prints messages waiting for the agent at the top of its output, and `tasks peloton listen` returns for one, so an agent that waits in a chase still hears them. The board says on the message box when the provider only delivers at the agent's next command.

### Stopping

`stop` is optional. When a provider has it, a running agent's row gets **Stop**: the board calls `stop`, releases the claim with a comment, and records the run as stopped. Claude has no stop API, so its agents keep today's path: the owner stops the session on claude.ai and releases the task, and once the task is released the hooks stop posting.

### Runs, routines, the chase, and pings stay neutral

- **Runs.** `agent_runs` gains a `provider` and a `connection`. `session_id` and `url` keep their names; `url` must be on the provider's `sessionHosts`.
- **Routines.** A saved routine runs through `startAgent()` like any start, so it uses the pool. Its daily cap and gap are the board's and count every provider. Disabling a routine after three refused starts counts starts every connection refused, not one provider's refusal.
- **The chase.** Picks tasks as now; the pool picks the connection. A chase's "Stuck after 2 refusals" counts a start the whole pool refused.
- **Pings, decisions, the peloton.** They key on the task and the claim, never the provider: nothing changes.
- **Prompts.** `prompts/core.md` and `prompts/stub.md` stop naming claude.ai: "the routine-fire-payload block" becomes "the payload", and "its routine on claude.ai" becomes "its connection on the board". Each provider gets a stub in its own words, rendered by `stubFor()`. The core stays about the board and is copied unchanged into every repository.

### Views

- **Agents view:** each running agent shows its provider by name next to its session link; the queue's reasons name the connection that's held; settings show the pool per repository (order, on or off, caps) and the install-wide caps above it.
- **A task:** "Open its session" names the provider ("Open in Claude"); a start menu lets the owner pick a connection.
- **Connections:** a group per provider. Empty state with no connection: "Connect an agent provider to start agents from the board", with the Claude routine first, as today.
- **First run:** unchanged. A fresh install connects a Claude routine as it does now; a second provider is something the owner adds later, in Settings.
- Copy names a provider only where it's that provider's (its session, its limits, its errors); the rest says "agent". Both themes, one column on a phone, as everywhere.

### Today's Claude-only code paths that change

| Where | What's Claude-only today | What it becomes |
| --- | --- | --- |
| `src/store-agents.js` `fireRoutine()`, `retryAt()` | The `/fire` call, its headers, and its error mapping | The Claude provider's `start` (`src/agent-claude.js`) |
| `src/store-agents.js` `startAgent()` | Calls `fireRoutine()` with one routine per repository | Asks the pool for a connection, calls its provider, tries the next on a hold |
| `src/store-agents.js` `routineCredentials()`, `otherRoutines()`, `checkRoutineReady()`, `connectedRepos()`, `routineHold()` and friends | One routine per repository, holds keyed per routine | Connections per repository, holds per connection |
| `src/store-routine-keep.js`, `src/routine-keep.js` | `kept_routines`, Claude's URL and token patterns | `agent_connections`; the patterns move to the Claude provider's `credentials` |
| `src/plans.js`, `claude_plan`, `agentSettings()` | Claude's limits and plans set the board's ceilings | The Claude provider's `limits`; ceilings summed over providers |
| `src/store-connections.js` `claudeConnections()`, `routineConnection` | A "Claude" group with one routine row | A group per provider, from `check()` |
| `src/model.js` `session` | Only `https://claude.ai/code/` links | Any connected provider's `sessionHosts` |
| `/^(claude\|codex)-/` in `store.js`, `store-agents.js`, `store-chase.js`, `mcp.js`, `stats.js` | Two fixed prefixes | One helper over the registry's prefixes |
| `src/store-routines.js` failure count | A routine is switched off after Claude refuses three times | After the pool refuses three times |
| `src/session-report.js`, `routine_verified:<slug>` | One report per repository's routine | One per connection |
| `src/repos.js` `stubFor()`, `prompts/stub.md`, `prompts/core.md` | The stub for claude.ai, "routine-fire-payload", "routine on claude.ai" | A stub per provider; neutral words in the core |
| `scripts/tasks.mjs` `agents-connect`, `agents plan` | Claude's URL and token, Claude's plans | `--provider`, defaulting to `claude`; `agents plan` names the provider |
| `scripts/tasks/session-log.js`, `src/init.js` `sessionHooks()` | Claude Code's hook events and tool names | Unchanged for Claude; another runtime's hooks and tool names beside them |
| `src/connections.js`, `src/wizard.js` | Fix texts that quote Claude's errors | Each provider's errors come from the provider |
| `web/src` Agents view, `Agents.jsx`, `BoardSettings.jsx`, Connections, `AddRepoView.jsx`, `RepoSettingsView.jsx`, `KickoffView.jsx`, `ActivityView.jsx` | "Claude" in setup copy, the plan picker, session links, the "Claude agents" filter | The provider's name where it's the provider's, "agent" elsewhere |

Unchanged: every caller of `startAgent()`, `firePayload()`, run states, the claim, the session log's storage and redaction, owner messages' storage, pings, decisions, and the peloton. Local agents keep working through the CLI and the plugin; the plugin stays Claude Code's.

## Privacy

The board stores, per connection, the provider, its sealed credentials, order, caps, and holds, and per run the provider and the session's link. It sends a provider only the start payload, which has no secret and nothing about people. Credentials are encrypted at rest, shown only as "set", and never in a session, a task, or a log. Session output is redacted as now, whichever runtime sends it. Adding a provider means its sessions see the repository and the CLI's output, the same as a Claude session does; the owner chooses that when they connect it.

## Out of scope

- Building any of it: this is a spec; the build is the owner's next idea (below).
- Picking a provider by cost, speed, or quality, or routing tasks to a provider by area or kind automatically. The order is the owner's.
- Model choice inside a provider, token or cost accounting, and budgets in money: the board counts starts, as CLD-35 says. Architect's cost work is for infrastructure, not agents.
- Local agents on other tools. The CLI already works from any terminal; a plugin for another tool is its own idea.
- A hosted broker, shared capacity between installs, or anything that resells a subscription.
- Starting an agent on a provider the owner didn't connect, or letting an agent choose or change the pool.
- Changing how Architect's agents start: they use today's path (BRK-169).

## Open questions

These go to the owner as a decision in the build's idea, not here:

- **Which provider comes second.** The idea expects OpenAI's cloud agents. The build's first task researches what it offers (a start API, a session link, a rate limit, hooks or not, a way to stop) before any adapter is written, as BRK-188 does for Architect's first provider.
- **Order or overflow.** This spec recommends one order per repository, with the next connection taking over only when the first is held. The alternative is to spread starts across connections in turn, which uses both subscriptions evenly but makes a repository's agents mix runtimes.
- **Per-area preference.** Whether the owner may pin an area (say, docs) to one provider. Recommended: not in the first version.

## Done when

- This spec is reviewed and merged with status draft; no code changes.
- The owner's next idea builds it. Its tasks, written here so the idea can make them, and not created by this task:

| Proposed task | What | Waits for |
| --- | --- | --- |
| 1. The agent provider interface | `src/agent-provider.js`, the registry, the fake provider, the contract test, and the prefix helper replacing `/^(claude\|codex)-/` | the idea |
| 2. Claude behind the interface | Move `fireRoutine()`, its holds, the URL and token checks, and `src/plans.js` into `src/agent-claude.js`; no change in behaviour, every existing test green | 1 |
| 3. Connections for agent providers | `agent_connections`, migrating `kept_routines` and reading the Secrets Store's routine secrets as Claude rows; holds per connection; `agents-connect --provider` | 2 |
| 4. The pool in `startAgent()` | Pick a connection, retry the next on a hold, queue reasons, Force start, routines and chase failure counts | 3 |
| 5. Live output and messages for `cli` providers | Sign of life from CLI calls, longer quiet and silent, messages at the top of CLI output and in `peloton listen` | 1 |
| 6. Neutral prompts and stubs | `prompts/core.md`, `prompts/stub.md`, `stubFor()` per provider | 3 |
| 7. The views | Pool settings, provider names on runs and links, Connections groups, the start menu, Stop where a provider has it | 4 |
| 8. Decide the second provider (`+owner`) | The open questions above, after research on its API | the idea |
| 9. The second provider | Its adapter, its stub, hooks if its runtime has them, the contract test passing | 8, 4, 5, 6 |
| 10. Docs and the claim | The manual's cloud agents section, the decision log, and the brand's "Agents start from the board" claim, in the same pull request as 9 or right after it | 9 |

## How to check it

Once the build ships:

1. Open **Connections**. You should see your Claude routine under Claude, working as before, with nothing to reconnect.
2. Connect a second agent provider for one repository from its settings. Its row on Connections should say it works and show its credentials only as "set".
3. In the Agents view's settings, put Claude first and the new provider second for that repository.
4. Start more agents than Claude's hourly limit allows on that repository (or wait until Claude refuses one). The next start should go to the second provider, and the running agent's row should name it, with a link to its session.
5. Set "agents at once" to 2 and start three. The third should wait with the reason, whichever provider is free.
6. Open a task the second provider runs. You should see its steps live (or its board steps, if that provider has no hooks), and a message you send should reach it.
