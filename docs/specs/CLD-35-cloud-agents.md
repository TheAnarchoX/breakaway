# CLD-35 · Start Claude cloud agents from the board

Task: `CLD-35` on the board · Status: approved (29 Sep 2026, by the owner: "build it, make it amazing, make it smart")

## Problem

The board knows what's ready, what waits for what, and when a PR merges. Starting an agent on a task still means copying a prompt into claude.ai by hand, one at a time, and watching sessions elsewhere. The board should start them itself: one task, the next few that won't collide, or on its own the moment a task's dependencies finish. And the owner should see what each agent is doing without leaving the board.

## Design

**Starting sessions: a Claude Code routine with an API trigger.** The owner creates one routine (the repository, the cloud environment with the board's API credential, and the agent prompt; since [IDEA-14](IDEA-14-multi-repo.md) the routine holds a stub that points to the prompt in the repository) and adds an API trigger. `node scripts/tasks.mjs agents-connect` puts its URL and token in the Secrets Store (`ROUTINE_URL` and `ROUTINE_TOKEN`, after the install's secrets prefix; `unset` means not connected). The board starts a session by POSTing to the routine's `/fire` endpoint with a short payload (the work ID, the agent's name, who started it, the owner's note). The routine's prompt acts only on the work ID; the payload arrives marked as untrusted data, so anything else in it is context at most. The token can only start that routine: it reads nothing.

**One start, done atomically.** Before calling `/fire`, the Durable Object claims the task for `claude-<id>` (`claude-ops-5`) in the same step as checking it may start, so two clicks, the auto-starter, and a batch can never start two agents on one task. If `/fire` fails, the claim is released. On success, the task's `session` field gets the session's link (a UDA, so Taskwarrior sees it too), and Activity gets an "agent started" event. The agent then claims the task under the same name, which succeeds.

A task may start when it's pending, ready (nothing it waits for is open, not waiting for a date), tagged `+agent`, not `+decide`, and unclaimed.

**Three ways to start.**

- **This task**: "Start an agent" on a task, with an optional note for the agent.
- **The next few**: "Start the next N" picks the best ready tasks and explains its choice before anything starts. It takes at most one task per area and skips areas that already have an agent running, so parallel agents don't edit the same files. Horizon `now` goes first, then by priority.
- **By itself**: a task marked **Start when ready** (`autostart`) starts its own agent as soon as it's ready, for example `OPS-8` the moment the PR for `DEBT-1` merges. The board checks after every change that can unblock a task (a merge, a task finished from the board or from Taskwarrior) and every 5 minutes. When the task can't start yet, it waits in the queue with the reason (no free slot, its area is busy, the hourly budget is used).

**Limits** (Agents settings, shared): at most 3 agents running at once (1 to 6), and the auto-starter can be switched off. An agent counts as running while its task is pending and claimed by it without an open closing PR, for up to 12 hours; once its PR is open, the task is In review and the slot frees up. At most 20 starts an hour (the routine allows 30). Every start draws on the owner's Claude subscription, and routines have a daily run cap.

**Watching a session.** No API reads a session's output, so the session sends it. The repository's `.claude/settings.json` has `async` hooks (they never slow the agent down): after each tool call, when the agent stops to talk, and at session start, `scripts/tasks/session-hook.mjs` sends a short entry to the task it has claimed (`.task-session`, written by `claim`): what the agent said, the tool and what it was run on, and the first lines of the result. Secrets are redacted before anything leaves the session (tokens, keys, and the install's secret values). The board shows it live on the task, and the Agents view shows each running agent's latest line. This works for local agents too. It's for watching, not record-keeping: at most 1,000 entries a task, gone after 14 days, never in a version, so never in Taskwarrior. `BREAKAWAY_SESSION_LOG=off` turns it off for a session.

**The Agents view** (`x`): what's running (task, agent, how long, its latest line, live or quiet, and a link to the session), what's queued and why, "Start the next N" with a preview, the settings, and how to connect the routine.

## Privacy

Session output can include code and command output from the repository. Production data never enters an agent session (the repository's `AGENTS.md` says so), so it can't reach the board this way. Output is redacted for secrets, kept 14 days at most, and shown only to whoever holds the board's token.

## Out of scope

Reading sessions through an API (none exists), steering a running session through an API (none exists; the session's own hooks fetch the owner's messages instead, [IDEA-15](IDEA-15-message-a-running-agent.md)), and cost reporting beyond counting starts.

## Done when

- The owner connects a routine and starts an agent on a task from the board. The task shows the session link and its live output.
- "Start the next 3" starts three agents in three different areas.
- A task marked Start when ready starts by itself when the PR it waits for merges.
- `pnpm test` covers atomic starts, failures, limits, batch selection, the auto-starter, logs, and redaction.
