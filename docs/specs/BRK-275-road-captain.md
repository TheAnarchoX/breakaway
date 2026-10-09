# BRK-275 · The road captain is a role on the board

Task: BRK-275 on the board, in the `captaincy` feature · Status: draft

## Problem

A road captain today ([BRK-137](IDEA-28-features-and-chase.md)) is a general agent the owner starts by prompt, from a chase's controls. Nothing starts one by itself, nothing replaces it when its session runs long or its context fills, and as a general agent it may change any open task in its repository, not only its chase's. A big chase needs one rider who keeps the plan, answers the peloton, and turns the owner's feedback into tasks, for as long as the chase runs.

## What it became

The road captain is the board's: one per chase, started with it, shown on the feature, and handed over on a clock.

### 1. One per chase, a setting on Chase

- A chase has a **road captain** setting, kept on the feature (`chase_captain`), and a **watch** in hours (`chase_captain_hours`, 12 by default, 1 to 72).
- Pressing Chase takes `captain: true | false`. Left out, it's on for a chase of more than 10 tasks, the size where agents start to step on each other, and off below it. The web's Chase shows it as a switch, set to that default; the CLI takes `--captain`, `--no-captain`, and `--watch <hours>`.
- On a running chase, turning it on starts a captain now; turning it off stands the captain down.
- The owner's **Start a road captain** (the feature's header and the chase's controls) now turns the setting on and starts the board's captain, with what the owner wrote as its note. The note is optional. While a captain runs, the button isn't there: message it on its task instead.

### 2. The captain's task

- One open task per chase, tagged `+agent +captain +<feature>`, titled "Road captain for <feature>", in the repository most of the feature's tasks are in. It has no area, so no work ID, like a general agent's. The board makes it the first time it starts a captain and keeps it until the chase stops or ends, when it finishes it ("The chase ended: its road captain stands down.").
- It isn't one of the chase's tasks: the chase never starts it as work, it doesn't count in the feature's progress or the chase's line, and Start next and auto-start leave it alone. It does ride the chase's peloton, so `@captain` reaches it and the feature's riders list it.
- Each captain is a fresh agent on that task, named `claude-captain-<feature>-<n>`, where n counts the captains the chase has had. The payload says `Mode: captain` and `Chase: <feature>`, carries the chase's plan, and the last captain's log.
- It's always force started: the owner asked for it, and it holds no area.

### 3. What it may do

Its rights are a chase agent's, inside its chase only (IDEA-36 section 6, BRK-274): change the description, done when, area, horizon, priority, tags, and dependencies of the chase's open, unclaimed tasks in its repository; add tasks with the feature's tag; delete only a task an agent added after the chase started; plan ideas and features as any agent may. It keeps the chase's plan and runs its huddles (IDEA-36). Unlike the general agent it used to be, it changes nothing outside its chase: the board refuses it. It never merges, deploys, publishes, starts agents, or approves, like every agent.

The core gets a section, "Captaining a chase", with its job: align the agents, answer the peloton, review risky pull requests (with `review`'s verdicts on the task, never pushing to them), turn the owner's feedback into wired tasks, keep the plan, and hand over.

### 4. The captain's log, and handing over

- `POST /api/features/<slug>/captain` with `{ log, handover, by }`, the captain's only (it must hold the captain task): adds an entry to the **captain's log** (up to 8,000 characters), kept on the feature, newest first, the last 50. The CLI is `npx breakaway captain <feature> log --file <path> [--handover]`, and `npx breakaway captain <feature>` prints the captain and its log.
- With `handover`, the board takes the claim back from it and starts the next captain at once, which reads the log and the plan first (they're in its payload).
- **On the clock.** When a captain has run its watch, the board posts on the chase's peloton, mentioning it: write your log and the plan, then hand over. If it hasn't in 30 minutes, the board hands over itself, with a log entry that says so.
- **Near full context.** The captain hands over early, the same way: the board can't see its context, so the core tells it when.
- **Gone.** If a captain lets go of its task, or its start fails, the board starts another on its next check, at most once every 15 minutes.

### 5. Where it shows

- The feature's page and the chase's panel show the captain: its name, since when, when its watch ends, and the log, newest first.
- Activity shows each captain started and each handover, as chase events.

## Out of scope

- Seeing a session's context: the captain decides when it's near full.
- A captain across several chases, or one outside a chase.
- Caps on pull requests waiting for review (BRK-276) and the hourly digest (BRK-277), which build on this.

## Open questions

- Is 10 tasks the right line for the default? It's a constant (`CAPTAIN_OVER`) and easy to move.

## Done when

Pressing Chase can start a captain; the captain shows on the feature and answers `@captain`; after its watch or near full context it writes a log and the plan, and the board starts its successor, which reads them; its edits are limited to its chase; tests and docs cover it.

## How to check it

1. Tag 11 tasks with a feature and press Chase on its page: the Road captain switch is on. A captain starts with the chase, and the page shows "Road captain: claude-captain-<feature>-1".
2. On the chase's peloton, post `@captain` with a question: it reaches the captain.
3. Have the captain hand over (`npx breakaway captain <feature> log --file log.md --handover`): the log shows on the feature, and `claude-captain-<feature>-2` starts with the log in its payload.
4. As the captain, change a task outside the chase: the board refuses it.
