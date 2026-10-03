# CLD-47 · Ideas: write an idea, let an agent shape it

Task: CLD-47 on the board · Status: draft

## Problem

Turning an idea into board work takes the owner several steps before anything happens: choose an area and a horizon, work out what it waits for, decide whether it needs a spec, write the notes. The owner wants to write the idea down as it comes, and have an agent do the shaping.

## Fit

It uses what the board already has: tasks, dependencies, `autostart`, the routine that starts cloud agents, and pull requests that close tasks. It adds no new service and holds no personal data. Every agent start still uses the owner's subscription, so whether an idea's agent starts by itself is the owner's choice (see Design).

## Design

- **An idea is a task** in a new area, `ideas`, with the work ID prefix `IDEA`. Its title is the first line of what was written (up to 120 characters) and its description is the whole text (the owner's own words; the agent shaping it never rewrites it). It is tagged `+agent +idea`, on the `now` horizon so agents pick it up before other work.
- **Ways in.** The web board's New idea (`i`, or the Idea tab of the New task dialog) and `node scripts/tasks.mjs idea "…"`. Both use the existing `POST /api/tasks`, so the server needs nothing beyond knowing the area.
- **The auto-start toggle belongs to the owner.** The form's toggle, *Start its agent as soon as there's room*, is the task's `autostart` field, set when the idea is saved. The existing auto-starter does the rest, with its usual rules: the limit on agents at once, one agent per area, and the hourly cap. Off means the idea waits until someone starts its agent. The agent is told never to set `autostart` on the tasks it makes, and never to start agents.
- **The horizon belongs to the owner too.** The form (and `--horizon` on the command line) offers Now, Next, Later, and Auto, kept on the idea as the tag `horizon-now`, `horizon-next`, `horizon-later`, or `horizon-auto` (default Auto). A fixed choice is given to every task the agent makes; with Auto the agent chooses per task. The idea's own horizon stays `now` so it gets picked up.
- **The agent shapes, it doesn't build** ("Shaping an idea" in the agent prompt, now the shared core in [`prompts/core.md`](../../prompts/core.md)): it reads the idea, the repository's `AGENTS.md`, and its settled decisions and direction, looks at the board for overlaps and blockers, writes a spec in `docs/specs/IDEA-<n>-<slug>.md`, and adds the real tasks with area, horizon, tags, dependencies, and notes.
- **Blockers by construction.** Every task the agent adds depends on the idea's own ID. The idea's pull request holds the spec and closes the idea, so the tasks become ready only when the owner has merged it. An idea that breaks a principle or a settled decision becomes one `+owner +decide` task that asks the question.
- **Failure and edge states.** If the routine isn't connected, saving still works and the idea waits, with the reason shown in the Agents view. An empty idea is refused in the form. If the agent can't finish, it releases the idea with a note.

## Privacy

None. The board is project work and holds no personal data. Ideas are the owner's own words about the project, and the same rule as every task applies: no personal data about anyone, and no secrets.

## Out of scope

- Any way for people outside the project to submit ideas.
- The agent building what it shaped. Building goes through the normal task flow.
- Changing the routine's instructions on claude.ai; pasting the prompt in again is the owner's step.

## Done when

- The Ideas area exists on the board, the CLI, and the docs.
- New idea works on the web board with the toggle, and `tasks idea` on the command line.
- The routine prompt covers `IDEA-` tasks.
- `pnpm test`, `pnpm build`, and the brand checks pass.
- Follow-up: the owner updates the routine's instructions (an `owner` task on the board).
