# CLD-27 · Continuous deployment from main (the board's side)

Task: `CLD-27` on the board · Status: approved (29 Sep 2026, by the owner, [answers](#the-owners-answers-29-sep-2026))

This spec was written for samewave, the first install, whose repository deploys two Workers: its app and the board. This copy keeps the board's side: how the board's own Worker deploys, and how a repository's deploys reach the board. The app's side (its database migrations, domains, and health checks) stays with samewave.

> **Partly superseded (30 Sep 2026, `IDEA-10`).** A merge to `main` no longer deploys production: it deploys staging, and the owner promotes that build with Promote ([spec](IDEA-10-promote-releases.md), [decision](../decisions.md)). Superseded here: "merging deploys production", "the pause variable and Roll back are the brakes" (`DEPLOYS_PAUSED` now pauses Promote and the board's Worker, not staging, and Roll back is never paused), and the production job in Deploy (now in `promote.yml`). Still current: GitHub Actions as the pipeline, the tokens and environments, rolling back, the board's Worker deploying on merge, Deployments as how deploys reach the board, and agents never deploying.

## Problem

Production changed only when the owner ran `pnpm run deploy` on their laptop. So `main` and production drifted apart: nobody knew which version ran where, merged tasks looked finished before anyone could use them, and every release depended on the owner having a free, alert half hour. The board was the same, with its own `pnpm run deploy`.

The aim: a merge to `main` that passes the required check is live within minutes, checked, rolled back when it's broken, and recorded on the board, without handing anyone more power over production than the pipeline needs.

## Fit

- **It changed a settled decision.** "Deploys stay manual and with the owner" became "Deploys run from `main` through a pipeline the owner controls; the owner can pause it, and production changes outside it stay the owner's." That's in the [decision log](../decisions.md).
- **One person can run it**: fewer manual steps, one place to see deploys, and one switch to stop them.
- **The owner merges.** Because merging deploys, the owner merges every pull request, Dependabot's included. Agents never deploy.

## Design

### Options

| | **GitHub Actions** (a `deploy.yml` that runs after CI) | **Cloudflare Workers Builds** (Cloudflare builds and deploys on push) |
| --- | --- | --- |
| Deploys only after the required check passes on `main` | Yes: `workflow_run` on CI, `conclusion == success`, on the exact commit CI tested | No. Builds start on every push to the production branch and don't wait for GitHub checks. Work-arounds: run the tests again in the build command (a second CI, and not the check the ruleset requires), or trigger through a Deploy Hook from an Action (then Actions is in the loop anyway, and a hook builds the branch head, not the tested commit) |
| Health check and rollback | Steps after the deploy, plus a Roll back workflow with a button | A script inside the deploy command; rollback in the dashboard or on the owner's laptop |
| The token | An **account-owned** token, scoped to one Worker, stored in a GitHub environment only `main` can use | **User tokens only** (account-owned "coming soon"), tied to the owner's login, and broader than a deploy needs |
| Several Workers from one repository | A job each, each with its own path filter | A trigger each, with build watch paths per Worker. Works |
| Recording deploys on the board (`CLD-32`) | GitHub Deployments, which the board's App can read | Check runs on the commit, without version IDs |
| Where the owner looks | GitHub, next to CI and the pull request | The Cloudflare dashboard |

**The owner chose GitHub Actions** (29 Sep 2026). Workers Builds can't wait for the required check without an Action in front of it, and once an Action is there it's simpler for it to do the whole job. Workers Builds would also need a user-owned token with broader access. Revisit if Cloudflare adds "wait for GitHub checks" and account-owned build tokens; [IDEA-16](IDEA-16-artifacts-and-workers-builds.md) looks at that again.

### The pipeline (`CLD-29`, `CLD-30`)

One workflow, `.github/workflows/deploy.yml`, "Deploy":

```text
CI on a push to main ── success ──▶ Deploy
                                    ├─ gate: is this still main's tip? are deploys paused?
                                    └─ each Worker whose files changed: build → deploy → check → (roll back)
```

- **Trigger.** `on: workflow_run` for CI, `types: [completed]`, `branches: [main]`, and only when CI succeeded on a push in this repository. It checks out `workflow_run.head_sha`, the commit CI tested. `workflow_run` always runs the copy of `deploy.yml` on `main`, so a pull request can't change what a deploy does before it's merged. `workflow_dispatch` redeploys by hand, for example after a pause.
- **Gate.** Skip when `head_sha` isn't `main`'s tip any more (a newer commit is on its way and includes this one), or when the repository variable `DEPLOYS_PAUSED` is `true`. Deploy a Worker only when the diff since its last successful deploy touches its files. Each Worker's paths are a list the workflow and the board both read, so the two never disagree.
- **One job per Worker**, in a GitHub environment named after it, with a concurrency group so deploys of one Worker queue instead of overlapping:
  1. **Record the start**: a GitHub Deployment (environment = the Worker, `ref` = the commit), set `in_progress`.
  2. **Build** as CI does. The tests don't run again.
  3. **Note the current version**, which is what a rollback goes back to.
  4. **Deploy**: `wrangler versions upload`, then `wrangler versions deploy <version>@100`. Uploading a version never touches triggers, so the token needs no zone access. A commit that changes routes, crons, Durable Object migrations, `workers_dev`, or `preview_urls` stops with an error, and the owner deploys it by hand.
  5. **Check**, for up to 90 seconds. The board's `/api/health` needs the board's token, which the pipeline shouldn't have, so `CLD-30` adds a public **`GET /api/ping`** that answers `{ ok, version }` and nothing about tasks. The check expects the new version, and `GET /` to answer `200`.
  6. **Roll back when the check fails** (the owner's choice: better safe than sorry): `wrangler rollback` to the noted version, check again, mark the Deployment `failure`, and fail the job, so GitHub mails the owner.
  7. **Record the end**: Deployment status `success` with the run's link and a description `version <id>`.

### The token (`CLD-28`)

- **One account-owned API token per Worker**, so a leak of one can't deploy the other: Workers Editor on that Worker only, and no zone permission (the custom domains already exist, and an Editor may deploy as long as the deploy doesn't change them). A Worker with a Secrets Store binding also needs Secrets Store Edit, which can't be limited to one secret. One year's expiry, with a task to rotate them before then.
- **Where they live:** a GitHub environment per Worker, with the secret `CLOUDFLARE_API_TOKEN` and a deployment branch rule of `main` only. The account ID is a repository variable. Nothing goes in repository-level secrets.
- **No per-deploy approval.** Required reviewers on an environment need GitHub Enterprise for a private repository, so the owner's controls are the pause variable, the Roll back workflow, and merging itself.
- **Hardening:** `permissions:` at the least (`contents: read`, `deployments: write`, `actions: read`), third-party actions pinned to a commit SHA, no `pull_request_target`, and the token reaches only `wrangler`.

### Rolling back (`CLD-31`)

- **Automatic**, after a failed check.
- **By hand from GitHub:** a Roll back workflow (`workflow_dispatch`, `main` only) with the Worker, an optional version (default: the one before), and a reason. It rolls back, checks, and records a Deployment. The GitHub mobile app can run it, so the owner can roll back from a phone.
- **By hand from a laptop** when GitHub is down. That one isn't recorded, so the owner adds a note to the board.

### How deploys reach the board (`CLD-32`)

The board reads GitHub and never writes to it here, and GitHub has no credential for the board. Both stay that way.

- **Carrier: GitHub Deployments.** Each deploy is a Deployment (environment = Worker, `ref` = commit) with statuses `in_progress`, then `success` or `failure`, and a description with the version. They also show on GitHub, in the repository's Environments and as "deployed" on merged pull requests.
- **The board's App** adds the read permission `deployments` and the webhook events `deployment` and `deployment_status`. The owner accepts the new permission on the installation once.
- **Shipped tasks:** for a successful Deployment, the board compares its commit with the previous successful one, finds the pull requests merged in between, and marks the tasks they closed "shipped in `<version>`".
- **Rejected:** a board token in GitHub that the workflow posts to (that token can do anything on the board), and a workflow artifact the board unzips (it works with fewer permissions, but hides deploys from GitHub's own views).

### What the repository's AGENTS.md says afterwards

- **Merging to `main` deploys**, so the owner merges every pull request, Dependabot's included. Agents may test a Dependabot pull request and say whether it's safe to merge, but don't merge it.
- **The pipeline is the only way agents change production.** Agents never deploy, roll back, run the Deploy or Roll back workflows, or change `DEPLOYS_PAUSED`, the environments, or their secrets.
- **Deploys the pipeline can't do** stay with the owner: a new or changed domain or route, Secrets Store changes, and anything while deploys are paused.

## Privacy

Nothing personal enters the pipeline. It reads the repository, runs Wrangler's deploy commands, and fetches `/` and the board's `/api/ping`, which says only which build runs.

## Out of scope

- Preview deployments, and deploying production from any branch but `main`.
- Changes to domains, DNS, the Secrets Store, or the dashboard.
- Release notes and GitHub releases (`CLD-33`).
- Holding deploys for quiet hours: the owner chose to deploy straight away.

## Done when

The owner approves this spec, which finishes `CLD-27`. Then, on the board: `CLD-28` (the owner: the tokens and environments), `CLD-29` (the Deploy workflow), `CLD-30` (the board's job and `/api/ping`), `CLD-31` (the Roll back workflow), and `CLD-32` (Deployments on the board and shipped tasks; the owner accepts the App's new permission).

## The owner's answers (29 Sep 2026)

| Question | Answer |
| --- | --- |
| GitHub Actions or Workers Builds? | **GitHub Actions**, as recommended. |
| Roll back automatically when the check fails? | **Yes**, better safe than sorry. |
| Deploy straight away, or hold for quiet hours? | **Straight away.** |
| Is the pause variable enough as a brake (no per-deploy approval without Enterprise)? | **Yes.** |
| One token per Worker, or one for both? | **One per Worker.** |
| Give the board's GitHub App read access to Deployments? | **Yes.** |
| Who merges Dependabot's pull requests once merging deploys? | **The owner**, not an agent. |
