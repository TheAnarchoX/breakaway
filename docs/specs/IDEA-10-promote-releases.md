# IDEA-10 · Promote releases instead of deploying everything on merge (the board's side)

Task: `IDEA-10` on the board · Status: built (before the move to breakaway, under the first install's work IDs). The owner's answers to the idea are settled ([below](#the-owners-answers-30-sep-2026)), three points went to the owner in one decision task ([questions](#questions-for-the-owner)), and the [decision log](../decisions.md) has what they decided.

This spec was written for samewave, the first install, whose app deploys through a staging Worker and a production Worker. This copy keeps the board's side: what a repository's pipeline has to do for the board to show it, and the board's Releases flow, Promote and Roll back, and shipped marks. In the examples, the repository's app runs as `app-staging` and `app`; on a real install they're the names in the repository's `pipeline` ([IDEA-14](IDEA-14-multi-repo.md#1-what-a-repository-is-on-the-board)).

## Problem

A merge to `main` deployed staging and then production by itself ([CLD-27](CLD-27-continuous-deployment.md)). Production had no step where the owner looks at what staging runs and says "this one". Staging only gates on its own health check, so a bug only a person would notice (a layout, a sign-in flow) reached everyone within minutes.

Wanted: one `main`; every merge goes to staging only; the owner **promotes** the staging build to production with one press on the board, and can still roll back.

## Fit

- **Supersedes** the CLD-27 rules "merging deploys production" and "the pause variable and Roll back are the brakes": the brake becomes a press. That's in the [decision log](../decisions.md): "Production changes when the owner promotes a staging build, not when a pull request merges."
- **Stays:** GitHub Actions as the pipeline, production read-only for agents, and the board's own Worker deploying on merge (left out of promotion).
- **One person can run it:** one press per release, no branches to keep in step, and it shows what's waiting.
- **No** `dev`, `staging`, or `release` branches, and no preview deployments of production.

## Design

### What gets promoted

**The exact staging version can't run in production.** A Worker version belongs to one Worker and carries its bindings, and Cloudflare deploys a version only to the Worker that uploaded it. So there's no `versions deploy` of staging's version into production.

**Closest safe option (recommended):** *build once, upload per environment.* The merge builds the tested commit for both environments in one job, checks the two outputs are the same code (every file byte-identical except the generated `wrangler.json`, which holds the bindings), keeps both as one workflow artifact `release-<sha>` with a hash manifest, and uploads the staging one. Promote downloads that artifact, checks the manifest (its hash is on the staging Deployment, so the artifact can't be swapped), and uploads the production output. Nothing is rebuilt at promote time: production runs the bytes built from the commit CI tested and staging ran.

The promoted thing is a **commit** (full SHA) on `main`. The version IDs differ per Worker, and the board shows both.

### The repository's workflows

```text
merge to main ─ CI ─▶ Deploy:  gate ─ build both ─ staging (upload, deploy, check, roll back)
                                   └─ the board's Worker (as before, not promotable)
Promote (board or Actions UI, input sha) ─▶ check candidate ─ upload ─ deploy ─ check ─ (roll back) ─ tag + release
Roll back (board or Actions UI) ─▶ production only
```

- **Deploy (`deploy.yml`)** deploys staging only. A branch deploy records its Deployment with task `try`, and everything that works out "candidate" or "shipped" ignores tasks other than `deploy`.
- **Promote (`promote.yml`)**: `workflow_dispatch` on `main` only, with inputs `sha` (required) and `destructive_ok` (default false). It runs in production's environment and in production's deploy lane, so it never overlaps a rollback. In order, and any failure stops before the next step:
  1. **Check the candidate** (the workflow decides; the board only asks): `DEPLOYS_PAUSED` isn't `true`; `sha` is the commit of the **latest successful `deploy` Deployment of staging**; no staging deploy is in progress; staging still serves that version; the artifact exists and matches the manifest; the commit is on `main`; production isn't already running it.
  2. **Deploy** the production output, with the repository's own steps before it (migrations, in order, from the promoted commit).
  3. **Check and roll back** as Deploy does.
  4. **Record** a production Deployment (`task: deploy`, `ref` = sha, description `version <id>`), with the step in the description as it goes (`migrating`, `deploying`, `checking`), so the board can show progress.
  5. **Release**: a tag `v<date>-<short>` and a GitHub release covering every task since the commit production ran before. **Production only.**
- **Roll back (`rollback.yml`)** stays production only. A merge now only reaches staging, so a rollback holds until the next promote.
- **Staging builds are pre-releases:** staging Deployments are described `pre-release · version <id>`, and the board labels them so. They get no tag and no GitHub release.

### A merge while a promote runs or waits

Staging and production deploy in separate lanes, so they don't block each other.

| When the merge lands | What happens |
| --- | --- |
| Promote of A is **running** | It finishes with A. Staging deploys B meanwhile. Afterwards B is the candidate. |
| Promote of A is **queued** behind a rollback or another promote | When it starts it checks step 1 again, finds B is the latest, and stops with "superseded by B: promote B instead". Nothing changed. |
| Staging is **deploying B** when Promote is pressed | Step 1 stops: "staging is deploying". The board disables the button while a staging deploy is in progress. |
| B **fails** on staging and rolls back to A | The candidate stays A, the latest *successful* staging deploy. B is red on the board and never promotable. |

Promoting only the latest build means a promote carries every merge since production's last one, in order. A pending destructive migration stops the promote unless `destructive_ok` is true, which the board's dialog offers only with the file named and an explicit tick.

### The board

The GitHub view ([`docs/tasks.md`](../tasks.md#promote-and-roll-back)) gets **Releases** at the top, before the pull request list: two cards joined by a line, **staging** then **production**. It shows only for a repository with a `pipeline`.

- **Each card** shows the live build: the commit (short SHA, linked), the tasks it carries (work ID and title; the pull request title when there's none), the version ID, when it went live, CI on that commit, and the deploy's own check. States, each with words and an icon, not color alone: *live*, *deploying* (with the current step), *failed*, *rolled back*, *nothing deployed yet*, *can't read* (the board's GitHub sync is stale).
- **The line** says what a promote would do: "Staging is 3 merges ahead: 4 tasks, 1 migration", or "Production is up to date". A change that needs a deploy by hand (routes and the like) and a destructive migration show there too, before anyone presses.
- **Staging's card: Promote to production.** It asks first, listing the tasks and migrations, and warns when the candidate was already tried and rolled back. The press asks the Worker to dispatch `promote.yml` with the candidate's SHA, and the card switches to *deploying* from the Deployment statuses. It's disabled, with the reason beside it, when there's no candidate, staging is deploying, production already runs it, or the last promote is still running. The board can't see `DEPLOYS_PAUSED` (a repository variable), so a paused promote fails at step 1 and the card says so from the run.
- **Production's card: Roll back.** It asks for the version to go back to (the one before is preselected) and a reason, and dispatches `rollback.yml`.
- **Permissions and safety:** both endpoints are cookie-only and same-origin, like Merge and Merge when green: the owner only, never an agent's token, never a setting. The workflow checks everything again at step 1, so a forged request can at worst fail. Activity records each press.
- **Accessibility and brand:** the flow is a region with a heading; each card is a labelled group; the line is real text and status changes are announced politely, once per change; the buttons are real buttons in order, focus returns to the card after the dialog, and motion stops under reduced motion. Tokens only, in both themes, narrow (the cards stack) and wide.

### The GitHub App

Dispatching a workflow needs **Actions: read and write** on the board's App. The owner sets it and accepts the request on the installation once. Deployments read, and the `deployment`, `deployment_status`, `release`, and `workflow_run` events, already reach the board.

- **What the wider key can do:** start a workflow on any ref. Production's secrets sit in an environment only `main` may read, and the workflows check their inputs, so a leaked key can't deploy code that isn't `main`'s staging candidate; it can start runs and use minutes. Rotate it as [the manual says](../tasks.md#github).
- **Rejected:** `repository_dispatch`, which needs only Contents write. GitHub doesn't check its inputs, the run isn't tied to a workflow file, and running it by hand from the Actions UI (the fallback when the board is down) wouldn't take the same path.
- **When the board or the App is down:** the same workflows run from GitHub, Actions, Run workflow (the mobile app too). Promote needs only the SHA, which the staging Deployment shows.

### Shipped marks and the task's detail

The shipped mark splits by where a Deployment happened, each environment compared with its own previous successful deploy:

- A task reads *Merged*, *On staging*, *Live*, or *No deploy needed*. The Finished filter gets **Not on staging** and **On staging, not live**, the second being what a promote would carry.
- **A task's detail** lists, for each environment, the merge commit, the Deployment's commit, the Actions run, the version ID, and the time, and for production the promote run and the release tag. `show` and `github` on the command line print the same, and the board's notes read "On staging in `<version>`" and "Live in `<version>`".
- Deployments of task `try` (branch deploys) and rollbacks never mark anything shipped. Rows from before staging deploys existed stay production ones; the store change is additive (an `environment` field that defaults to production).

### Hotfix

A hotfix is a pull request with a small fix that must be live now. It takes the normal path, which is short: merge, staging deploys, press Promote. The options were:

| | What | For | Against |
| --- | --- | --- | --- |
| **A. The normal path** (recommended) | Merge; when staging is green, Promote. | Every release passes staging and its checks, and there's nothing new to get wrong. | A few minutes of staging deploy before Promote. |
| **B. Promote when staging is ready** | Arm the next candidate; Promote dispatches by itself once staging's deploy succeeds. | Saves waiting at the screen. | An approval given in advance on code the owner hasn't seen on staging, and the board acting unattended. |
| **C. Direct to production** | Promote a commit that hasn't been on staging. | Works when staging itself is broken. | Breaks "only what passed staging is promoted", and staging falls behind. |

Roll back works in all of them: it changes only production's live version and never waits on staging.

### The rest

- **The owner merges every pull request:** still. A merge now reaches staging and the board's own Worker, and production moves only when the owner presses Promote. Merge when green's confirmation says "Merging deploys to staging. Promote it to put it live." Agents never press Promote or Roll back and never dispatch these workflows.
- **`DEPLOYS_PAUSED`** pauses production (Promote stops at step 1) and the board's Worker deploy. **Staging keeps deploying**, so a fix is already on staging when the pause ends. **Roll back is never paused.**
- **Deploy paths** stay one list the workflows and the board both read.
- **First run after the change:** the staging build already live has no artifact, so the first merge afterwards makes the first candidate; until then Promote says "no candidate".

## Privacy

No personal data: the flow shows commits, task titles, version IDs, and workflow states, all already on the board. The artifact holds the built app, which holds no secrets (bindings are names, not values).

## Out of scope

- Promoting the board's own Worker, which keeps deploying on merge.
- Promoting an older build or a branch.
- Canary or percentage rollouts, a soak timer, and approvals by a second person.
- A third environment, and preview deployments.
- Changing the owner-merges rule, or Merge when green.

## Questions for the owner

One decision task (`+decide`), three questions:

1. **How to get the same code into production.** A: build both outputs at merge and upload the production one at promote (recommended). B: rebuild the same commit at promote time (simplest, but the bytes differ from what staging ran). C: put production's bindings into staging's output (one build, but rewriting generated config is fragile).
2. **The hotfix path:** A, B, or C above (A recommended).
3. **Does each staging build get a GitHub pre-release?** Recommended: a label on the board and in the Deployment, with no tag or release per merge, to keep the tag list to real releases.

## Done when

The owner answers the decision and approves this spec. Then, on the board: `CLD-102` (the owner: the decision), `CLD-103` (build once, staging on merge, `promote.yml`, tag and release for production only), `CLD-105` (the board's Releases flow with Promote and Roll back), `CLD-106` (the split shipped marks and task detail), `CLD-107` (the hotfix path the owner chose), `CLD-108` (the docs), and `CLD-104` and `CLD-109` (the owner: the App's Actions permission, and watching the first promote).

## The owner's answers (30 Sep 2026)

| Point | Answer |
| --- | --- |
| Promote the exact artifact? | If Cloudflare allows; it doesn't across Workers ([why](#what-gets-promoted)), so the closest option is a decision. |
| Flow on the board | Two cards with a line, Promote on staging's, Roll back on production's, accessible and on brand. |
| Sequential | Only the latest staging build; every migration in order. |
| Approval | On the board, through the App. |
| Release pieces | Tag and release for production only; staging builds are pre-releases; the board's Worker left out; shipped splits in two; the task's detail shows commits, runs, and versions. |
| Hotfix | Propose, recommend, owner decides. |
| The rest | Decided above. |
