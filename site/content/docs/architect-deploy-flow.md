---
title: Architect and the deploy flow
nav: With the deploy flow
description: Run an app’s code and what it runs on from one board: Deploy, Promote, and Roll back for the code, plans you approve for its infrastructure, on the same staging and production. How to set both up, in order, and keep them in agreement.
---

breakaway has two lanes for one app. The **deploy flow** ships its code: every merge deploys staging, **Promote** takes it to production, and **Roll back** takes it back. **Architect** runs what the code runs on: its Worker’s settings and bindings, and the databases, namespaces, buckets, queues, containers, routes, and custom domains around it, by plans you approve. Set up together, they share one staging and one production, one set of tokens, and one freeze.

## Which lane does what

| | The deploy flow | Architect |
| --- | --- | --- |
| **Changes** | The Worker’s code, its variables and secrets, Durable Object classes, containers’ images, and the database migrations you run before a deploy | The resources around the code, and the Worker settings its file manages |
| **Written in** | The code, the wrangler config, and `.github/breakaway-pipeline.json` | `.github/breakaway-infra/<environment>.json` |
| **On merge** | Deploys staging | Plans; the plan waits for you |
| **To production** | **Promote to production…** | A plan for production, which you approve |
| **Going back** | **Roll back…** to a version | The board rolls back a plan whose health check failed; for the rest, a new plan |
| **Its workflows** | `deploy.yml`, `promote.yml`, `rollback.yml` | `breakaway-infra.yml` |
| **Its token** | `CLOUDFLARE_API_TOKEN` in the GitHub environments `staging` and `production` | The same one, widened |

## Set it up, in order

Start from a repository that deploys a Worker with `wrangler`. Each step ends in a check.

### 1. Move it to the deploy flow

On the GitHub view, **Deploy with breakaway**, then **Move to breakaway’s deploy flow**: an agent writes `.github/breakaway-pipeline.json` and the workflows `npx breakaway pipeline init` renders, in a pull request. Before you merge it, do your part: the staging and production Workers, the GitHub environments `staging` and `production`, each limited to the default branch with its token as `CLOUDFLARE_API_TOKEN`, the variable `CLOUDFLARE_ACCOUNT_ID`, and the App’s **Actions** and **Variables** ([GitHub: move a repository to the deploy flow](/docs/github/#move-a-repository-to-the-deploy-flow)).

Merge it, then press **Turn on deploys**.

**Check:** the GitHub view shows **Live now**, with staging deployed from the merge.

### 2. See staging and production on Infrastructure

Once deploys are on, the board adds two environments for the repository at its next sync, **staging** and **production**, pointing at the pipeline’s Workers. There’s nothing to add by hand. Their deploys show on their pages, and on the GitHub view as before.

Connect Cloudflare’s read-only token on **Connections**, if you haven’t ([Tokens, GitHub, and the apply workflow](/docs/architect-connections/#the-boards-read-token)).

**Check:** each environment’s map shows its Worker and what it uses, with health and cost, and its recent deploys.

### 3. Describe both as code

On each environment’s page, **Describe it as code**, then **Propose it**; or have an agent run `npx breakaway infra adopt staging` and `infra adopt production` in one pull request. The files say what already runs, so their plans change nothing ([Describe it as code](/docs/architect-desired-state/#write-the-first-one-from-what-runs)).

**Check:** both pages show their desired state, and no drift.

### 4. Widen the tokens, and add the apply workflow

The deploy flow’s GitHub environments are Architect’s too: same names, same secret. Don’t add a second token. Widen each environment’s existing one with the writes its file needs ([Each environment’s write token](/docs/architect-connections/#each-environments-write-token)). Then:

- add the repository variable **`BREAKAWAY_URL`**, your board’s address;
- run `npx breakaway infra init`, commit `.github/workflows/breakaway-infra.yml`, and merge it. A change you propose from the console brings it instead, when the App may write workflows.

**Check:** the repository’s **Infrastructure tokens** checklist on Connections reads **All in place**.

### 5. Change staging, then production

Make a small change on staging’s console and approve it, then the same on production ([Get started with Architect](/docs/get-started-with-architect/#5-change-something-and-approve-it)). Production has production gates: every plan there waits for you.

**Check:** both plans read **Applied**, and each environment’s audit trail has the plan, your approval, and the apply.

## Day to day

- **Merging deploys staging.** That includes a change from the console: when merging it also deploys staging, Approve’s dialog says so: “Merging also deploys staging.” After the merge, the deploy and the plan each run on their own.
- **Promote and Roll back** are on production’s environment page as well as the GitHub view, and work as they always have. Each Promote and Roll back is recorded on its environment as a plan that already ran, and in the audit trail, so production’s page shows its code and its infrastructure in one history.
- **A deploy’s failed health check, or its rollback, is a signal**, so it can open an incident like any other. The pipeline’s `healthCheck` is what each deploy checks; an environment’s file can name a health address for the board to check every 15 minutes too ([Describe it as code](/docs/architect-desired-state/#a-health-address)).
- **Routines can start on both lanes**: `deploy.done` and `promote.done` as well as `plan.applied` and the rest ([Signals, incidents, and runbooks](/docs/architect-signals/#infrastructure-events)).

## Freeze is the deploy pause

Freezing production is one switch for both lanes:

- **Freeze production**, on Infrastructure, its page, or the repository’s settings, and the board sets the repository variable `DEPLOYS_PAUSED` to `true` through the App. Every plan there stops, envelopes included; **Promote** is disabled with the reason, and the Promote and Release workflows stop at their first step. **Roll back** still works.
- **Unfreeze** sets it back to `false`.
- **Setting `DEPLOYS_PAUSED` on GitHub by hand** freezes or unfreezes production on the board at the next sync.
- **Freezing staging** stops its plans only: merges keep deploying it, and the freeze says so.

Without the App’s **Variables** permission the freeze still holds on the board, and the board still refuses Promote, but the workflows don’t know; Connections shows **Deploy pause** with the fix ([Freeze, gates, and locks](/docs/architect-freeze/)).

## Keep the wrangler config and the file in agreement

A few Worker settings are in both lanes’ files: its bindings, compatibility date and flags, Workers Logs, placement, and cron triggers. Each deploy sets them from the wrangler config; each plan sets them from the environment’s file. When the two disagree, every deploy puts back what the wrangler config says, and the board shows the difference as drift.

- **Change both in one pull request.** When a binding or a setting changes, the wrangler config and the environment’s file say the same thing, so the deploy and the plan agree.
- **Or leave the setting out of the file.** A setting the file leaves out isn’t compared, so it stays the deploy’s. For a Worker that only the deploy flow changes, a file that lists the Worker with no `attrs` still lets Architect watch it, and manage everything around it.
- **Drift after a deploy** is a draft plan, with no push. Don’t approve it to undo a deploy: bring the two files into agreement by pull request, and the drift settles.

## Add a resource the code uses: make it first, bind it second

A deploy fails when the code binds something that doesn’t exist yet. So adding, say, a queue the Worker sends to takes two pull requests, in this order:

1. **Make it.** Add the queue to staging’s file, from the console’s **Add resource**, or with `npx breakaway infra add queue staging name=exports worker=widgets-api-staging` and a pull request. Approve its plan. The queue now exists.
2. **Bind it.** A pull request that adds the binding to the wrangler config and the code that uses it, and the same binding to the file if it manages the Worker’s bindings. Merging deploys staging with the binding.

Then the same for production: its file in one pull request, approved; **Promote** takes the code there. Removing works the other way round: stop using it and deploy, then remove it from the file.

## Without the deploy flow

Architect works on a repository with no pipeline too. You deploy its code your own way, and Architect runs what it runs on: add its environments with **Add an environment**, and every step above from step 2 on applies, except that a freeze stops plans only, and there’s no Promote or Roll back. A new project can get both from the start ([Patterns](/docs/architect-patterns/#a-new-project-from-kickoff)).
