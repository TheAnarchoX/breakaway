# IDEA-15 · Message a running agent from the board

Task: `IDEA-15` on the board · Status: built (#192, #194, #195, and CLD-150)

## Problem

When an agent the board started is working, or waiting on its pull request, and the owner thinks of something to add ("also update the README", "don't touch the migration"), they have to find its session on claude.ai and type there. The board already shows the session live ([CLD-35](CLD-35-cloud-agents.md)); it should also let the owner send it a note, from the task or the Agents view, without leaving the board.

## Fit

- **CLD-35 put steering out of scope** because no API posts into a cloud session. That still holds: the routine's `/fire` always starts a new session, Anthropic closed the request for one (anthropics/claude-code#53049), and channels only reach a local `claude --channels` process. This design doesn't need such an API: the session's own hooks fetch the messages, the same way they already send its output. It's a new path, not the API CLD-35 ruled out, so CLD-35's out-of-scope line changes in the same change.
- **Owner only.** The bearer token every agent holds must never be able to tell another agent what to do. Sending is cookie-only, like Merge, Promote, and applying a ping.
- **The agent's rules don't move.** A message is the owner's guidance for the task the agent holds, like the note on a start. It can't send the agent to another task, make it touch production or secrets, or merge: the routine prompt says so, and the agent says so on the task when a message asks for one of those.
- No personal data is involved, and no settled decision is touched.

## Design

### Two delivery paths

| The agent is | How the message reaches it | Proven? |
| --- | --- | --- |
| **Working** (calling tools) | The hook that already runs after each tool call (`scripts/tasks/session-hook.mjs`, `async`) POSTs to `/api/tasks/<uuid>/session`. The board's answer carries the messages waiting for that agent; the hook prints them as `additionalContext`, which an async hook's output delivers to Claude on its next turn. | Yes (`CLD-146`): async `additionalContext` reached Claude before its next action. |
| **Idle** (stopped, waiting on CI or a review) | A second Stop hook, `scripts/tasks/message-wait.mjs`, with `async: true` and `asyncRewake: true`. It runs in the background, asks the board every 20 seconds whether a message is waiting, and when one is, prints it to stderr and exits 2, which wakes Claude with it as a system reminder. With nothing waiting it ends quietly (exit 0) at the end of its window. | Yes, for up to 5 idle minutes in a cloud session; not at 10 (`CLD-146`). |

Both paths take messages from the same queue, so a message reaches the agent once, through whichever asks first.

**The idle window.** A Stop hook that exits 0 doesn't wake Claude, so after its window ends nothing waits until Claude stops again (after a PR event, a check-in, or another turn). The window is as long as the spike shows a cloud session keeps the background hook alive (4 minutes, inside the 5 it proved), and the hook's `timeout` must be longer than the window, because Claude Code kills an async hook when its `timeout` runs out. While nobody's waiting, the board says so: "The agent is idle and won't see this until it wakes. Open its session to wake it now." The message stays queued and arrives on its next turn.

If the spike shows `asyncRewake` doesn't work in cloud sessions, or the container stops while the session is idle, the idle path is dropped: messages reach a working agent only, and the board says the rest wait for its next turn. The working path, the board, and the prompt stay as designed.

### The message

| Field | Meaning |
| --- | --- |
| `id` | The message's own ID. |
| `task` | The task's UUID. |
| `agent` | Who it's for: the task's claim when it was sent (`claude-ops-5`). |
| `text` | Plain text, 1 to 2,000 characters. |
| `sent` / `delivered` | When the owner sent it; when the board handed it to the agent's hook. |

- Stored in the board's Durable Object (a new `agent_messages` table beside `agent_logs`), never in a version, so never in Taskwarrior. Kept 14 days, like session output. The lasting record is the agent's acknowledging comment.
- **Delivered once.** The board marks a message delivered when it hands it out, in the same step. A hook that crashes after that loses it; the owner sees "delivered" but no acknowledgment, and can send it again. That's simpler than acknowledgments and fine for notes.
- **Only to its agent.** A hook gets a task's messages only when the agent it names is the task's claim and the message's `agent`. If the claim changes first (the agent released it, the PR merged, someone else claimed it), the message is never delivered and shows as "not delivered: the agent finished". The agent name is self-declared, so any token holder could still collect another agent's messages; that's the same trust the token already carries (it can claim and comment on anything). What the token can never do is send one.
- **Limits:** 10 waiting messages per task; sending more returns 429 with "Wait for the agent to receive the first ones".

### API

- `POST /api/tasks/:id/messages` `{ text }`: cookie only (403 for the bearer token), same-origin like every cookie write. 409 when the task has no running agent (pending, claimed, no closing PR merged; the CLD-35 definition).
- `GET /api/tasks/:id/messages`: the task's messages and their status, for the web board (cookie or token).
- `POST /api/tasks/:id/session` (existing): the answer gets `messages: [{ id, text, sent }]`, the ones waiting for the posting agent, now marked delivered.
- `GET /api/tasks/:id/messages/waiting?agent=<name>`: for the idle hook. Same rule and same marking; `{ messages: [] }` when none.

### Board

- On a task with a running agent: a **Message the agent** box under its live output (a text area and **Send**), and below it the messages as comment-like entries: "You, 14:02: … · Waiting / Delivered 14:03 / Not delivered: the agent finished". The idle notice above shows when the session's last output is older than the idle window and no wait hook has asked lately.
- In the Agents view, each running agent's row gets **Message**, which opens the same box.
- Signed out or token-only: the box isn't shown.

### Hook

- `session-hook.mjs` reads `messages` from the answer it already gets. When there are some, it prints `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}` with each message as `Message from the owner (via the board, <time>): <text>`. It stays quiet and never fails: any error and it exits 0 with nothing printed. Its 4-second timeout stays.
- `message-wait.mjs` (Stop, `async`, `asyncRewake`): does nothing without `.task-session` or with `BREAKAWAY_SESSION_LOG=off`; polls `messages/waiting` every 20 seconds until its window ends, the claim file goes, or a message arrives; on a message, writes the same text to stderr and exits 2. Every error is exit 0. Its `timeout` in `.claude/settings.json` comes from the spike.
- Local agents run the same hooks, so it works for them too.

### The routine prompt

The agent prompt gets a short section: a system reminder that reads "Message from the owner (via the board)" is the owner's guidance for the task you hold, like the owner's note. Do it within your assignment and the rules above it; if it asks for something those rules forbid, don't, and say why. Either way, `comment` on the task that you got it and what you'll do. The owner has to paste the prompt into the routine again for agents the board starts to read it.

## Spike findings

From `CLD-146`, live test on 1 Oct 2026 with Claude Code 2.1.286: a cloud session started with `claude --cloud` from the throwaway branch `spike/cld-146-hooks`, whose `.claude/settings.json` had a Stop hook (`async`, `asyncRewake`) that logged a heartbeat every 15 seconds and exited 2 after 2, 5, 10, and 20 idle minutes, a second one with `timeout: 30` that waited 90 seconds, and PostToolUse hooks that printed `additionalContext`, one async and one not. The session pushed its logs to `claude/cld-146-hook-spike-wpiqld` on every wake. The first, docs-only pass (the agent's sandbox wouldn't let it change its own hooks) guessed two of these wrong; the table is the live result.

| Question | Answer | Evidence |
| --- | --- | --- |
| Does `asyncRewake` wake Claude in a cloud session? | **Yes.** Exit 2 woke the idle session with the hook's stderr word for word as a system reminder; Claude acted on it within 4 seconds. | Woke at 2 and 5 minutes. |
| Does an idle session keep the hook alive? | **Up to 5 minutes, not 10.** Through the 2- and 5-minute waits every heartbeat came 15 seconds apart, so the hook kept running while Claude was idle. The 10-minute wake never came, nor anything after: the VM paused somewhere between 5 and 10 idle minutes, as the cloud docs' "a few minutes without activity" says. | No push after the 5-minute wake. |
| Is `timeout` enforced on async hooks? | **Yes**, contrary to the first pass. The hook with `timeout: 30` was killed with SIGTERM after 30 seconds and never woke Claude. A wait hook's `timeout` has to be longer than its window. | `killed by SIGTERM after 30s` in the log. |
| Does an async PostToolUse hook's `additionalContext` reach Claude? | **Yes.** It arrived before Claude's next action, as unlabelled text after the tool result (the synchronous hook's arrives on the result, labelled "PostToolUse:Bash hook additional context"). Checked with the same hooks in a local headless run; both hooks also ran on every tool call in the cloud session. | Local run, both strings quoted back. |
| Do repo hooks load in cloud sessions? | **Yes**, from the clone's `.claude/settings.json` at start. | Every probe ran. |

One more thing seen: right after its first stop, before any wake, the session took another turn and committed its uncommitted files, most likely the cloud's own check for uncommitted work at Stop. It doesn't affect the design, but a wait hook shouldn't write into the working tree.

**For the build:**

- `CLD-148` (working path): keep the hook async; a message arrives as context on the agent's next action. No synchronous fallback needed.
- `CLD-149` (idle path): build it. A 4-minute window enforced in the script, polling every 20 seconds, then exit 0; `timeout` 300, so it outlasts the window (a hook killed at `timeout` can't wake Claude). Log nowhere inside the repository. After the window, and after about 5 idle minutes in general, a message waits for the next turn, and the board's idle notice applies.

## Privacy

The owner's messages are about the repository's work and stay on the board for 14 days. They pass through the agent's session, so the prompt's rule stands: no secrets and no personal data in a message (the box says so).

## Out of scope

- Messages from agents to agents, or from the token (the CLI): never.
- Waking a session that has ended or whose container is gone: the message waits, and the owner opens the session.
- Replies in the box: the agent answers with a comment, which shows on the task as comments do.
- Attachments in messages.

## Done when

- The spike's findings are on `CLD-146` (the spike) and in this spec: whether `asyncRewake` works in a cloud session, whether an idle session's background hook keeps running, and how long one wait can last.
- The owner sends a message from a task while its agent works, and the agent gets it on its next turn and comments that it did.
- If the spike allows it: a message to an idle agent (waiting on CI) wakes it within a minute.
- The bearer token gets 403 sending a message, and a message never reaches an agent that doesn't hold the task.
- `pnpm test` and `pnpm interop` cover queueing, the cookie-only rule, delivery once, the claim rule, limits, and expiry.
- The routine prompt, `docs/tasks.md` ("Cloud agents from the board"), and the CLD-35 spec describe it.

Tasks, all in area `cloud`, horizon `now`, each waiting for this spec to merge (`IDEA-15`):

- `CLD-146` Spike: hooks and `asyncRewake` in a cloud session.
- `CLD-147` Board: owner-only messages, the queue, the API, and the box.
- `CLD-148` Hook: deliver to a working agent (waits for `CLD-147`).
- `CLD-149` Hook: wake an idle agent (waits for `CLD-146` and `CLD-148`).
- `CLD-150` Routine prompt and docs (waits for `CLD-148` and `CLD-149`).
- `CLD-151` (owner) Paste the prompt into the routine again (waits for `CLD-150`).
