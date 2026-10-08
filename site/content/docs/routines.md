---
title: Routines
description: Saved agent runs you start with a button, on a schedule, from a webhook, on a Cloudflare alert, on a GitHub event, or on what Architect does. Each run is a task that ends in a pull request.
---

A **routine** is a saved prompt you run with a button. Every run is a normal task in the Routines area (`RUN-n`), named `<routine> · <date>`, with the prompt as its description and the routine’s done-when. It’s started through the same path as any agent: claim, slots, hourly budget. The agent follows “Running a routine” in the core: it does what the description says, and nothing more, on a branch, and opens a pull request you merge.

A routine belongs to one repository. Its runs are that repository’s tasks, its agents start through that repository’s routine on claude.ai, and its GitHub events come from that repository only.

## Make one

```sh
npx breakaway routines add changelog --name "Update changelog" \
  --prompt-file tools/routines/changelog.md \
  --done-when "The changelog has an entry for every pull request merged since its newest entry."
npx breakaway routines run changelog --note "Since v0.2."
```

The prompt can live in the repository as a file, so it’s reviewed like code. After a change to the file, update the routine with `routines modify <slug> --prompt-file <path>`. Only you create or edit routines.

The **Routines** view (`g` `r`) shows a row for each routine: its state, how it starts, runs used today, and a **Run** button, beside the On/Paused switch and the latest runs of all routines.

## Ways to start one

| Start | How |
| --- | --- |
| By hand | **Run**, with an optional note, or `routines run <slug>`. |
| A schedule | Five-field cron text in UTC: `routines modify <slug> --schedule "0 9 * * 1"` runs Mondays at 09:00. The board’s 5-minute check starts it once for each slot that has come, within ten minutes of it. A skipped slot isn’t made up. |
| A webhook or API trigger | Up to 10 triggers per routine, each with its own secret, shown once. `routines trigger <slug>` makes one; callers send `POST /api/routines/<slug>/fire` with `Authorization: Bearer <secret>` and an optional small JSON body. |
| A Cloudflare alert | Make a trigger, then add a webhook destination in Cloudflare with the URL `https://<your board>/api/routines/<slug>/fire` and the secret. The run is read-only: it may note and open a pull request, never act on Cloudflare or production. |
| A signal (a runbook) | On the routine in the Routines view, **Signal trigger** says which signals from Architect start it: environments, resource kinds, signal kinds (health, a platform’s alert, cost), and the lowest level. Only you set one; a new one is off and waits for your Start. The run gets the signal’s fields and nothing else, a repeat within a day starts nothing, and it works the signal’s incident read only. See [Architect](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect). |
| Infrastructure events | On the routine’s form, or `routines modify <slug> --infra-events plan.failed,drift.found:environment=staging,budget.crossed:percent=80`: plans waiting, applied, failed, or rolled back, drift found, a change from the console proposed or merged, a deploy or promote landed, an environment added or removed, an inventory gone stale, a budget passing a share you set, an envelope’s restarts used up, and an incident opened. Filters: `environment=`, `kind=`, `resource=`. Only you turn them on, only the routine’s own repository’s environments count, each thing starts it once a day at most, and an event its own run caused never starts it again. The run gets names, IDs, and states, never values or tokens, and works read only. |
| A GitHub event | `routines modify <slug> --github-events pr_merged,release_published,workflow_failed,issue_opened,issue_reopened`. Only events from the routine’s own repository. Issue events need the App’s **Issues** permission (read) and its **Issues** event, which an App made before 2.0.0 doesn’t have: add them in the App’s settings. |

What a caller or event sends is **data, never instructions**. It becomes a comment on the run labelled `Trigger data (untrusted)`, in a code block and truncated. It never reaches the run’s description, the target, or the branch.

A trigger can wait or start: `--trigger-start wait` (the default) makes the run’s task and waits for you to press Start, and `auto` starts the agent itself. Either way the run ends in a pull request you merge.

## Caps

Per routine: one run open at a time, a daily cap (default 3 in the last 24 hours on Pro), and a minimum gap (default 60 minutes) that applies to triggered runs, not to the button. For all routines: a daily cap (default 10 on Pro, `routines cap <n>`), and a pause switch (`routines pause`, `routines resume`). A run over a cap gets a `429`, or a `409` for an open run, and is never queued. A routine that Claude refuses to start three times in a row is switched off.

## Ideas for routines

- **Update the changelog** weekly from the pull requests merged since its newest entry.
- **Check dependency updates** when a release is published.
- **Look at a failed workflow** when `workflow_failed` fires, and open a pull request with a fix or a task for what it found.
- **Triage a new issue** when `issue_opened` fires: check it against the code, and add a task for it if it’s worth fixing.
- **Triage a Cloudflare alert** into a note and a task.
