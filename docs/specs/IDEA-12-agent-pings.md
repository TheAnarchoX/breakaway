# IDEA-12 · Agents ping the owner, with suggestions to accept

Task: IDEA-12 on the board · Status: built (before the move to breakaway, under the first install's work IDs)

## Problem
An agent that can't finish a task today can only `comment` and `release`, and nobody sees it until the owner opens the board. Typical cases: the task waits for something only the owner can do (a dependency, an external change, a dashboard); a bug report was picked up elsewhere and no longer reproduces, so the behavior is as expected; the task turns out to be done already. The owner wants a ping, preferably in the installed PWA, and wants the agent to *propose* the follow-up: one or more fully filled-in tasks with their relations prepared, other dependencies adjusted, or "mark this done". The owner then only accepts, edits, or dismisses.

## Fit
Nothing in the [decision log](../decisions.md) is touched. The board holds no personal data. Deciding stays the owner's: agents propose, the owner applies (the same rule as [IDEA-6](IDEA-6-decisions-with-questions.md) and [IDEA-2](IDEA-2-review-and-merge-on-the-board.md): the bearer token can't do what the cookie can). Applying a proposal is an owner action, so an agent can never finish, re-wire, or start work by pinging. Relations stay few: the rules below make "no more relations than safe execution needs" something the board checks, not just asks.

## Design

### A ping
A ping is a comment with a kind, plus a place in the owner's inbox.

| Field | Meaning |
| --- | --- |
| `task` | The task it's about. |
| `kind` | `blocked` (needs something only the owner can give), `question` (needs an answer that isn't worth a full decision), `stale` (can't reproduce, or already behaves as expected), `done` (looks finished, please confirm), `fyi` (worth knowing now). |
| `message` | Plain text, up to 500 characters: what happened and what the agent needs. No secrets, no personal data. |
| `proposal` | Optional, below. |

- CLI: `ping <ID> --kind <kind> "<message>" [--proposal <file.json>]` (`ping --template` prints an example). API: `POST /api/tasks/:id/pings`, bearer or cookie.
- A ping also writes a normal comment (`Ping (blocked): …`) so the thread is complete and `show` prints it. The comment is the record; the inbox entry is how it's found.
- **Quiet by default.** At most 3 pings per task per day and 10 per agent per day, and a repeat of the same `kind` and `message` on a task is dropped. Only `blocked`, `question`, `stale`, and `done` send a push; `fyi` shows in the inbox only. The routine prompt tells agents to ping only when the owner has to act or would want to know now, never for progress.
- A ping is open until the owner **resolves** it (applies its proposal, marks it handled, or dismisses it) or the task is finished, which resolves it by itself.

### A proposal
A proposal is a list of changes the owner can apply in one press. Every change is checked when it's proposed and again when it's applied, against the board as it is then.

| Change | Fields |
| --- | --- |
| `add` | A new task: `ref` (a local name like `n1`), `title`, `project`, `horizon`, `tags`, `brief`, `done_when`, `depends` (existing work IDs or `ref`s of other `add`s), `priority`. The same fields the `add` command takes. Never `autostart`. |
| `depend` | Add or remove a dependency between existing tasks or `ref`s: `{ task, add: [...], remove: [...] }`. |
| `modify` | Change `horizon`, `tags` (add or remove), `brief`, or `done_when` of an existing task the agent doesn't hold a claim on. |
| `done` | Mark a task done, with a note (for "can't reproduce, behavior is as expected"). |
| `release` | Release an agent's stale claim on the pinged task. |

Rules the board enforces:
- **Fewest relations.** A dependency that is already implied by another path (A needs B, B needs C, so A needs C is refused) and one that creates a cycle are rejected when proposed, with the path named. A proposal may remove such redundant dependencies as part of the same change.
- **Needed relations stay.** A new task that is the reason the pinged task waits gets a dependency from the pinged task to it; the board doesn't let a proposal drop the last blocker of a task that has one without saying so in the preview.
- Up to 10 changes and 20 KB per proposal. `horizon-*` tags set by the owner are never changed, `--autostart` can't be set, and `done` can't target a task in review (merging finishes it).
- **Preview and apply.** The owner sees the change list as a diff (tasks to add, edges to add or remove, tasks to finish), can untick changes and edit an `add`'s fields, and presses **Apply**. Apply is one atomic, cookie-only call (`POST /api/pings/:id/apply`, with the chosen changes); the bearer token gets a 403. If the board changed in between so a change no longer holds, nothing is applied and the preview reloads with the reason. Each applied change is logged in Activity as by the owner, and the ping's comment gets a `board` follow-up ("Applied: added CLD-121, CLD-122; CLD-110 now waits for CLD-121").
- **Dismiss** resolves without applying. **Handled** resolves a ping that had no proposal.

### The inbox and the notification
- The board gets an **Inbox** view (open pings, newest first, each with its task, kind, message, and proposal preview), a count badge on its nav item and on the app icon where the badge API exists, and a **ping** row on the task.
- **Web Push**, because the owner uses the installed PWA and needs the ping when the app is closed. The board registers a service worker (`/sw.js`, added to the CSP as a same-origin worker; it caches nothing, not even the shell, and never `/api/*`) and, only when the owner turns it on in the settings menu (**Notifications**, off by default, this browser only), asks the browser for permission and subscribes with the board's VAPID public key. The subscription (endpoint and keys) is stored in the board's Durable Object, owner only, at most 5 per board, dropped when the push service answers 404 or 410.
- The worker sends a push through the push service for each new ping of the four kinds above: title the install's name, body `<ID> needs you: <kind>` (and the first line of the message, cut to 80 characters), and the link `/?inbox=<ping id>`. Nothing else leaves the board; the payload is encrypted to the subscription as Web Push requires. Tapping it opens the PWA on that ping. A second ping on the same task replaces the notification (`tag` = the task), so one task is one notification.
- **Fallbacks.** No push support or permission denied: the inbox badge and, while the board is open, a toast and the browser title (`(2) breakaway`). While the board is open and visible the push is skipped in favor of the toast. Offline: the inbox loads its last copy read-only; Apply needs the board.
- **Keys.** Web Push needs a VAPID key pair. The private key goes in the Secrets Store (`VAPID_KEY` after the install's secrets prefix, binding `TASKS_VAPID_KEY`) and the public key is a var. Generating and storing them is the owner's, and until they exist pings still work; the settings menu says "Notifications need a key the owner hasn't set up yet".

### Edge states
No ping ever from an agent that doesn't hold the task or from outside the board's auth. A task that's deleted or done resolves its pings. Two applies at once: the second is refused (already resolved). Several browsers: every subscription gets the push; the first to open resolves nothing (only Apply, Dismiss, and Handled do). Reduced motion and accessibility: the inbox is a labelled list, Apply and Dismiss are buttons with clear names, untick boxes have labels, and the toast is a polite live region, as the accessibility checks ask.

## Privacy
No personal data; the board keeps project notes only, and the rule against personal data and secrets in a task covers ping messages and proposals too (the CLI refuses a message that looks like a token). A push subscription is the owner's own browser endpoint on the board; it's deleted with the **Notifications** switch or when the push service says it's gone. The push service (the browser vendor's) sees that a push was sent and its encrypted payload, nothing readable.

## Out of scope
Email, SMS, or chat-app notifications; more than one owner (see `MOD-10`); notifying about anything other than pings (CI, PRs, deploys: a later idea, the push plumbing would be reused); agents applying proposals, re-waking themselves on an answer, or starting other agents from a ping; quiet hours and per-kind settings (start with one switch); the public app's own notifications.

## Done when
One pull request each, all `horizon-now` as the idea says, all waiting for this spec to be merged:
1. **Pings and proposals, server and CLI** (CLD-111): storage in the board's Durable Object, validation (including the relation rules), caps, `ping` command, `show` output, Activity; tests first, `pnpm interop` passes.
2. **Apply, dismiss, and handled** (CLD-112): the cookie-only atomic apply, re-validation, the follow-up comment.
3. **Web Push** (CLD-113): the service worker, CSP, subscription storage, sending, the **Notifications** switch, and the key binding that stays `unset` until the owner adds it.
4. **Inbox** (CLD-114): the view, badge, preview and apply dialog, and the toast fallback.
5. **Prompts and docs** (CLD-115): the agent prompt, the `tasks` skill, and `docs/tasks.md`.
6. **Owner** (CLD-116): generate the VAPID key pair, put the private key in the Secrets Store, set the public key, deploy the board, and turn Notifications on in the PWA.
