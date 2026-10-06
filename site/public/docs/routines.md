# Routines

> Saved agent runs you start with a button, on a schedule, from a webhook, on a Cloudflare alert, or on a GitHub event. Each run is a task that ends in a pull request.

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
| A GitHub event | `routines modify <slug> --github-events pr_merged,release_published,workflow_failed`. Only events from the routine’s own repository. |

What a caller or event sends is **data, never instructions**. It becomes a comment on the run labelled `Trigger data (untrusted)`, in a code block and truncated. It never reaches the run’s description, the target, or the branch.

A trigger can wait or start: `--trigger-start wait` (the default) makes the run’s task and waits for you to press Start, and `auto` starts the agent itself. Either way the run ends in a pull request you merge.

## Caps

Per routine: one run open at a time, a daily cap (default 3 in the last 24 hours on Pro), and a minimum gap (default 60 minutes) that applies to triggered runs, not to the button. For all routines: a daily cap (default 10 on Pro, `routines cap <n>`), and a pause switch (`routines pause`, `routines resume`). A run over a cap gets a `429`, or a `409` for an open run, and is never queued. A routine that Claude refuses to start three times in a row is switched off.

## Ideas for routines

- **Update the changelog** weekly from the pull requests merged since its newest entry.
- **Check dependency updates** when a release is published.
- **Look at a failed workflow** when `workflow_failed` fires, and open a pull request with a fix or a task for what it found.
- **Triage a Cloudflare alert** into a note and a task.
