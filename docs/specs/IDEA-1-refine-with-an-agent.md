# IDEA-1 · Refine a task with an agent

Task: IDEA-1 on the board · Status: built (before the move to breakaway, under the first install's work IDs)

## Problem

An agent can start on a task to build it, or on an idea to shape it. There is no way to say "make this task better first": tighten its notes, split it, find what it waits for, or answer a question about it. The Agent section's note is for the build run, so it doesn't fit. The owner wants a Refine button and a text box on the task's side view; a modal was suggested.

## Fit

It reuses the routine, the claim, the limits, and the live log ([cloud agents](CLD-35-cloud-agents.md)). It adds no service and no data beyond the run's kind. Every start still uses the owner's subscription, so it only ever starts when the owner presses the button; there is no auto-start for refining. Nothing in the [decision log](../decisions.md) is touched.

## Design

- **A run has a kind:** `build` (today) or `refine`. The routine payload gets a `Mode: refine` line and the owner's text as `Refinement request:`. Without a `Mode:` line the run is a build, so the routine keeps working until its instructions are updated.
- **Where the button is:** in the task's Agent section, beside Start an agent (moved there from the header actions in CLD-165, when the Agent section moved up to sit right below the actions). **Refine with an agent** opens a modal (`Dialog`, focus trapped, Escape closes): a required textarea, "What should it look at or change?", and **Start refining** / **Cancel**. Refining is a different question from running the task, and a modal keeps the two boxes apart. The Agent section shows the refine run's live log like any other run.
- **Who can be refined:** any open task that nobody has claimed and that has no open pull request closing it. Unlike a build, a `+decide` or `+owner` task can be refined (often that is what helps), and the task needn't be tagged `+agent`. Not connected, claimed, or in review: the button is disabled with the reason, as for builds.
- **The claim is the lock.** A refine run claims the task as `claude-refine-<id>` in the same step as the start, and releases it when it finishes, so a build can't start on a task while it is being refined, and the reverse. It counts against the same agent limits and hourly cap.
- **What the agent does** ("Refining a task" in the agent prompt): it reads the request, the task's notes and spec, and its neighbours on the board, then improves the task on the board: rewrites the note, fixes area, horizon, tags, and dependencies, splits it into filled-in tasks, or adds a `+decide` task for a question only the owner can answer. It never builds the task, never sets `--autostart`, and never changes the owner's `horizon-*` tag. If the task has a spec it may edit it, or write one, in a pull request that says `Part of <ID>.`. When it's done it `note`s what changed and `release`s the claim. If it opened a pull request, the owner merges it as usual.
- **Ideas:** refining an idea whose spec pull request is open is blocked ("in review"); ask for changes on that pull request instead.
- **Command line:** `node scripts/tasks.mjs agents refine <ID> --note "…"`, next to `agents start`. The API is `POST /api/agents/start` with `mode: "refine"`.
- **Edge states:** routine not connected: the modal says so and links to the setup. Claude refuses the start: the claim is released and the modal shows why, keeping what was typed. An empty request is refused.

## Privacy

None. It is board work with the owner's own words, and the rule that tasks hold no personal data still applies.

## Out of scope

- Refining several tasks at once, and refining by itself (no autostart).
- Replying to the agent while it runs; the note and pull-request comments cover it.
- Building the task.

## Done when

- The board can start a refine run from the modal and the command line, and the payload carries the mode and request.
- The routine prompt has a "Refining a task" section, and `docs/tasks.md` explains the button.
- Tests cover the blocker rules, the payload, and the claim being released after a failed start.
- Follow-up: the owner pastes the updated routine prompt into the routine on claude.ai.
