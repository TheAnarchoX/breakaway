# IDEA-4 · Routines on the task board

Task: IDEA-4 on the board · Status: draft

## Problem
Some agent work repeats: draft the changelog from what shipped, check something weekly, react to an alert. Today each run means picking or writing a task and starting an agent by hand. The owner wants **routines**: a saved prompt and target, started by a button, a schedule, a webhook, a GitHub event, or an alert. The first use is keeping `content/changelog.md` (the What's new page, `BRD-10`) up to date.

## Fit
One person runs it, and the board stays the one place for work. The board holds no personal data, and every run ends in a pull request the owner merges. Nothing deploys and nothing touches production; agent limits ([CLD-35](CLD-35-cloud-agents.md)) apply. Two choices need the owner (see the questions).

## Design
**A routine is a saved recipe, and every run is a normal task.** This reuses everything the board already does (claims, live session output, the PR link, limits) instead of a second way to run agents.

- **A routine** (a table in the board's Durable Object, next to tasks): `slug`, `name`, `prompt` (the instructions, owner-written; it is the routine's description, edited like a task's, with an edited-by line), optional `done_when`, `project` and `horizon` for the tasks it makes, `enabled`, its triggers, and its caps. Created and edited only with the board's owner token (web, CLI `routines add|modify|list`, API `/api/routines`). Agents never create or edit routines or their triggers.
- **A run** makes a task in area `routines` named `<routine name> · <date>`, with `+agent`, and the routine's prompt copied into its **description** (the owner's own words, like an idea; [`IDEA-5`](IDEA-5-task-structure.md) gives tasks a description apart from their comments), plus the routine's `done_when` if it has one. It starts through the existing start path: the atomic claim, the routine's `/fire` payload, slots, and the hourly budget. The payload says `Mode: routine` and `Routine: <slug>`. The agent follows a new "Running a routine" section of [the agent prompt](../../prompts/core.md): do what the description says, on a branch, open a PR ("Closes" its run task), keep watching it. The run task finishes when the PR merges. A run that has nothing to do notes that, opens no PR, and `release`s (the board closes the task).
- **Trigger data is data.** A trigger (a webhook body, a GitHub event, an alert) is stored as a **comment** by `routine:<slug>`, clearly labelled (`Trigger data (untrusted)`), truncated, never in the prompt or the run's description, the payload's `Task:` line, the branch name, or the target. It can start a run and inform it; it can't change what the routine does, which repository or task it works on, or whether it may touch production (it may not, ever).
- **Triggers**, one routine may have several:
  1. **Manual**: a "Run" button on the routine, with an optional note.
  2. **Schedule**: cron text (UTC) checked by the board's existing 5-minute cron; skipped runs are not made up.
  3. **Webhook / API**: `POST /api/routines/<slug>/fire` on the board with a per-trigger secret. The board makes each secret, stores only its SHA-256, and shows it once (the Secrets Store stays the owner's). Constant-time compare, revocable, rotated by making a new one. Body over 16 KB is rejected; only a plain-text `note` field and a small JSON object are kept.
  4. **GitHub events**: the existing GitHub App webhook (already signature-checked with `X-Hub-Signature-256`) gets a routine filter: event type and action from an allowlist (pull request merged, release published, workflow run failed) on this repository only. The routine sees title, number, and URL, never the body of a PR from someone else as instructions.
  5. **Cloudflare alerts**: Cloudflare's notification webhooks send a secret in a header, so they use the same per-trigger secret as 3, with a fixed mapping of the alert's name and time. Alert routines are read-only: they may note and open a PR, never act on Cloudflare.
- **Cost and abuse limits**, because every run uses the owner's subscription. Per routine: at most one run open at a time (a trigger that arrives meanwhile is noted on the open run, not started), a minimum gap (default 1 hour for webhooks, GitHub, and alerts), and a daily cap (default 3). Globally: the existing agent slots and 20 starts an hour, plus a routines-wide daily cap (default 10). A trigger over a cap is answered with `429`, logged in Activity, and never queued. A routine that fails 3 runs in a row disables itself and says so on the board. A "pause all routines" switch sits with the Agents settings.
- **Where it shows.** A Routines view (`u`) lists each routine with its triggers, last run, next scheduled run, and open run; a run's task shows its live output as any task does.

## Privacy
No personal data is involved; the board holds none, and trigger data stays out of tasks when it might (payloads are cut to allowlisted fields; no request headers or IPs are stored). Trigger secrets are hashed. Webhook payloads from Cloudflare alerts hold Worker names and error counts, no logs.

## First routine: Update changelog
A routine with a manual button (and a weekly schedule later). Its prompt: read `content/changelog.md`, find what shipped since its newest entry (merged PRs and the GitHub release notes `CLD-33` drafts), write new entries in the brand voice (plain sentences, what people notice, no task IDs, per the `brand-guide`), and open a PR the owner merges. It never edits anything but `content/changelog.md`.

## Out of scope
Routines that deploy, change production, read production data, handle secrets, or merge. A routine editor for agents. Chaining routines. Running more than one Claude routine on claude.ai (the board keeps one task agent routine and its `/fire` endpoint; the owner pastes the updated prompt in, as for every mode).

## Questions for the owner
1. **Caps.** Are the defaults right (1 run open, 1 hour gap, 3 a day per routine, 10 a day in all)? Every run draws on your subscription.
2. **Webhook routines starting without a click.** A webhook or alert can start a run on its own. Proposed: allowed once you've created that trigger, always ending in a PR you merge. Say if you want each trigger-started run to wait for your OK on the board first.

## Done when
After [`IDEA-5`](IDEA-5-task-structure.md)'s storage and API (`CLD-71`, `CLD-72`) exist, built in order, one PR each: `CLD-64` model and manual trigger (then `CLD-65`, the owner pastes the updated prompt), `BRD-23` Update changelog, `CLD-67` schedules, `CLD-68` webhook/API triggers, `CLD-69` GitHub events, `CLD-70` Cloudflare alerts. `CLD-66` asks the owner the two questions above and blocks the inbound triggers.
