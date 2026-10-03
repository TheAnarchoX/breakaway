# Specs

A spec is the written design for one piece of work on the board: what it is, why, and how it will work, settled before anyone builds it. A small change doesn't need one; the task's description is enough. Write one when the work has real choices (a new table, a change to the Durable Object or the sync protocol, a feature with flows and edge states), when more than one agent will work on it, or when the owner has to approve the design.

- **Where:** `docs/specs/<ID>-<slug>.md`, for example `docs/specs/BRK-12-sort-the-inbox.md`. One spec per task. A spec that covers several tasks is named after the main one, and the others link to it.
- **Link it:** `node scripts/tasks.mjs modify <ID> --spec docs/specs/<ID>-<slug>.md`. The board shows the link and opens it on GitHub.
- **A spec's pull request** says `Part of <ID>.`, not `Closes`, unless writing the spec is the whole task (an idea's spec closes the idea).
- **After it's built,** the spec stays as the record of the design. If the build changed the design, update the spec in the same pull request. Lasting rules move to their real home (the [decision log](../decisions.md), [`AGENTS.md`](../../AGENTS.md), the [brand guide](../../brand/README.md), or the [manual](../tasks.md)), and the spec links there.

## The specs written before breakaway

The board began inside samewave, the first install, and the specs below were written there, with work IDs from that install's board (`CLD-`, `OPS-`, `BRD-`, and the shared `IDEA-`). They keep what they decided, and they name samewave where it was the install they were written for. Tasks that moved here keep these paths in their `spec` field.

| Spec | What it decided |
| --- | --- |
| [CLD-24](CLD-24-github.md) | GitHub on the board: the App, webhooks and the reconcile, and pull requests that close tasks |
| [CLD-27](CLD-27-continuous-deployment.md) | Continuous deployment from `main`, the board's side: `/api/ping`, Deployments, and shipped tasks |
| [CLD-35](CLD-35-cloud-agents.md) | Starting Claude cloud agents from the board, its limits, and live output |
| [CLD-47](CLD-47-idea-intake.md) | Ideas: write one down, and an agent shapes it |
| [IDEA-1](IDEA-1-refine-with-an-agent.md) | Refining a task with an agent |
| [IDEA-2](IDEA-2-review-and-merge-on-the-board.md) | Reviewing and merging pull requests on the board |
| [IDEA-3](IDEA-3-close-a-horizon.md) | Closing a horizon |
| [IDEA-4](IDEA-4-routines.md) | Routines: saved prompts, schedules, and triggers |
| [IDEA-5](IDEA-5-task-structure.md) | A task's description, done when, and comments |
| [IDEA-6](IDEA-6-decisions-with-questions.md) | Decisions as questions the owner answers |
| [IDEA-8](IDEA-8-images-on-ideas.md) | Images on ideas and tasks |
| [IDEA-10](IDEA-10-promote-releases.md) | Promoting a staging build to production, the board's side |
| [IDEA-12](IDEA-12-agent-pings.md) | Pings, proposals, and push |
| [IDEA-13](IDEA-13-breakaway.md) | breakaway as a project of its own |
| [IDEA-14](IDEA-14-multi-repo.md) | One board for several repositories, and Connections |
| [IDEA-15](IDEA-15-message-a-running-agent.md) | Messaging a running agent |
| [IDEA-16](IDEA-16-artifacts-and-workers-builds.md) | Repositories on Cloudflare Artifacts, and Workers Builds |

## Template

```md
# <ID> · <title>

Task: <ID> on the board · Status: draft | approved (<date>, by the owner) | built (<pull request>)

## Problem
Who it's for and what's wrong today, in a few sentences.

## Fit
The settled decisions it touches ([decision log](../decisions.md), and "What breakaway is, and isn't" in AGENTS.md), and why it still fits.

## Design
What you chose and why: flows, data, API, and UI, with every edge state where it applies (signed out, empty, offline, a fresh install, several repositories).

## Privacy
What it stores, what leaves the install, and what an agent session sees. The board holds no personal data and no secrets.

## Out of scope
What this doesn't do, so nobody builds it by accident.

## Open questions
What the owner still has to decide, asked as a decision on the board.

## Done when
Checkable outcomes, and the follow-up tasks it makes, with their work IDs.
```
