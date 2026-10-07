---
title: Get started with Architect
nav: Get started with Architect
description: From a read-only token to your first approved plan, in the order it goes for real: connect Cloudflare, see staging, describe it as code, give it a way to apply, then change something and approve it. Then envelopes, runbooks, and production.
---

This is the way in to **Architect**, the board running the infrastructure your repositories run on. You’ll go from nothing connected to a first plan you approved on staging, applied and health-checked, in five steps, the order an owner took them for real. Each step ends in a check. The [manual’s Architect section](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect) says what every piece is, in full; this page says how to start.

Nothing here hands an agent a write credential or lets one apply. The board holds only a read-only token. The one thing that changes infrastructure is a workflow in your repository, which the board starts for one plan you approved.

## Before you start

- **A board on 2.0.0**, or a 2.0.0 pre-release ([Updating to 2.0.0](/docs/updating-to-2/)), with the repository whose infrastructure you want on it.
- **The GitHub App’s new permissions accepted**: Checks and Variables ([how](/docs/updating-to-2/#accept-the-github-apps-new-permissions)). Without Checks, a pull request gets no plan check; the board’s own pull request page still shows the plan.
- **A Cloudflare account** the repository runs on. Ideally staging lives on its own account: every permission but Workers’ reaches every resource of its kind on an account, so only separate accounts keep staging and production fully apart.
- **The board on your phone**, with pushes on, if you want to approve from it. A plan that waits sends one push.

You need nothing on the board’s own install. Architect only watches the environment the board runs on, and never changes it.

## 1. Connect Cloudflare with a read-only token

The board needs one token per provider, and it only reads with it: what runs, what it uses, its health, and what it costs.

1. In Cloudflare, open **Manage Account**, then **Account API Tokens**, and create a custom token with an expiry date.
2. Give it exactly these permissions:
   - **Workers: Metadata Read-Only**, at the Workers product scope. It lists your Workers and their settings and can’t read their code. (A token with the legacy Workers Scripts Read still works.)
   - On the account: **Workers KV Storage Read**, **Workers R2 Storage Read**, **D1 Read**, **Queues Read**, **Containers Read**, **Account Analytics Read**, and **Notifications Read**. Leave out queues or containers if you don’t use them.
   - On the zones your environments use, and only those: **Zone Read** and **Workers Routes Read**. Give both the same zones.
3. Add nothing that ends in Edit or Write, and not Billing Read, Workers Tail Read, or DNS Read. The board can’t see a permission a token has but shouldn’t, so read only is yours to keep.
4. On the board, open **Connections**, find **Cloudflare**, paste the token, and press **Connect**. The board checks it with Cloudflare, stores it encrypted, and never shows it again.

**Check:** Cloudflare’s row reads **Working**, with each permission by name, and says it can’t check for extra ones.

**If a permission shows as missing,** the row says which one and gives Cloudflare’s own message beside it. Add it to the token on Cloudflare and paste the token again with **Replace the token**. A zone that Zone Read covers and Workers Routes Read doesn’t is skipped and named on the row, not a failure: add it to the token’s zones, or take it out of Zone Read.

## 2. See what runs

Open **Infrastructure** in the sidebar (`g` then `n`).

- **A repository on the deploy flow** already has two environments, **staging** and **production**, pointing at its pipeline’s Workers. The board made them on a GitHub sync; its deploys, Promote, and Roll back show on them.
- **Any other repository** gets one with **Add an environment**: its repository, the name `staging`, kind staging, provider Cloudflare, and its target, the Worker’s name. The name is also its file’s name later, `.github/breakaway-infra/staging.json`.

The board looks at what runs right after you connect the token, then every 15 minutes. **Refresh** looks now, and **Last looked** beside it says when, and what went wrong if anything did.

Open **staging**. Its page shows what runs there as a map: the Worker, and what it uses (its KV namespaces, databases, buckets, queues, containers, routes, and custom domains), each with its health and an estimated monthly cost. Below are its signals, plans, and audit trail, empty for now.

**Check:** staging’s map matches what you know runs there, and what uses what looks right. A Worker nobody called lately reads as idle, not down. If the map is missing something, look at Connections for a permission the row marks missing.

## 3. Describe staging as code

Before the board can plan a change, staging needs a file saying what should exist. Nobody writes it by hand: the board drafts it from what runs.

With no file yet, staging’s page shows **Describe it as code**: the draft, read only, with **Copy**. Then either:

- **Propose it**, on the change beside the map: the board opens the pull request with the draft as the file, or
- **Have an agent open the pull request**: the board adds a task, `Describe staging as code`, and starts the repository’s agent, which runs `npx breakaway infra adopt staging` and `infra check` and opens it.

The pull request gets a check, **breakaway: infrastructure plan**, which shows the plan the file would make. The file says what already runs, so the plan should change nothing. Read it, then merge: a draft the board proposed with no edits plans nothing, so its card shows **Merge** instead of Approve; an agent’s pull request you merge the way you merge any other.

**Check:** staging’s page shows its desired state, and no drift. Merging applied nothing.

## 4. Give staging a way to apply

The board holds no write credentials. Staging’s write token lives in a GitHub environment in the repository, and only the repository’s apply workflow reads it, for a plan you approved. This step is all on Cloudflare and GitHub, and it’s yours: agents never do it.

1. **Staging’s write token.** A second custom token on Cloudflare, with an expiry date: everything the read token has, plus
   - **Workers: Editor**, scoped to staging’s Workers. If staging has custom domains, scope it to the Workers product instead.
   - Only for what `staging.json` declares: **D1 Write**, **Workers KV Storage Write**, **Workers R2 Storage Write**, **Queues Write**, or **Containers Write**, and **Workers Routes Write** on staging’s zones for routes and custom domains.
   - Never Account Settings, API Tokens, Billing, DNS, or Notifications Write, and never reuse it for production. On the deploy flow, staging already has a token; widen that one.
2. **A GitHub environment named `staging`**, in the repository’s settings under **Environments**. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only the default branch. Add the token as the secret **`CLOUDFLARE_API_TOKEN`**. The board reads that rule before every run and starts none while another branch could deploy.
3. **The repository variable `BREAKAWAY_URL`**: your board’s address.
4. **Actions: read and write** for the board’s GitHub App on the repository. An App on the deploy flow usually has it.
5. **The apply workflow.** In a checkout of the repository, run `npx breakaway infra init`. It writes `.github/workflows/breakaway-infra.yml`, **Apply infrastructure**, for each environment with a file. Commit it, open a pull request, and merge it.

**Check:** the repository has the **Apply infrastructure** workflow on its default branch, and the `staging` GitHub environment holds the token and lets only the default branch deploy. Production stays without a write token until you’ve seen staging work.

## 5. Change something, and approve it

You change staging on its page, the board opens the pull request, and you approve the plan. You never have to open a file.

1. **Change it.** On staging’s map, pick a resource and press **Change**. Its settings the console may change become fields: for a Worker, its compatibility date, flags, observability, placement, cron triggers, and bindings; for a queue, its delivery delay. Pick something small, like the Worker’s observability. Variables and secrets show by name only: they’re set with the Worker’s deploy, never here.
2. **Watch the plan form.** Your change shows beside the map, an edit a line, and the edited resource is marked “your change”. A moment after you stop editing, the board previews the plan: what changes, what it costs, what else it touches, what can’t be undone, and the policy’s answer. Until you propose it, your change is only in this browser.
3. **Propose the change.** The board checks the plan once more, commits the file on its own branch, and opens the pull request, “Change staging: …”. The change’s card reads **Checking** while the plan check runs, then **Waiting for you**.
4. **Approve.** Press **Approve** on the card, or on the pull request’s page on the board, from your desk or your phone. It asks, “Approve this plan for staging? The board merges its pull request, applies the plan, and rolls back if the health check fails.” On the deploy flow, merging deploys staging too, and the dialog says so.
5. **Watch it apply.** The card reads **Merging**, then the plan’s own status: **Approved**, **Applying** while the repository’s Apply infrastructure run holds the write token, then **Applied** once the board has checked the health of what changed. If the health check fails, the board applies the reverse by itself and the plan ends **Rolled back**.

**Check:** the plan reads **Applied**, staging’s map shows the new setting, and its audit trail has the plan, your approval, and the apply, newest first.

**Changing it by pull request instead.** An agent, or you, can change `staging.json` in an ordinary pull request (`infra adopt`, `infra add` for a template, then `infra check`). The plan check shows on it, and merging applies nothing: the board plans from the default branch, and the plan waits for you with one push, which names the environment and the plan. Open it on your phone, read it, and press **Approve**. This is how an agent’s change, and every incident’s fix, reaches you.

### If it doesn’t go through

| What you see | What to do |
| --- | --- |
| **Can’t merge**, with why | Fix what it names (checks failing, a conflict), then **Propose again**: it replays your edits on the current head |
| GitHub refuses the merge for a required review | Add the board’s GitHub App to the ruleset’s bypass list (the repository’s **Settings**, **Rules**, **Rulesets**, the rule, **Bypass list**). The App merges only on your press. Until then, review the pull request on GitHub |
| The plan stays **Approved**, with a reason | The run couldn’t start: no apply workflow, a GitHub environment another branch may use, or another plan holds staging’s lock. Fix what it says; it starts on its own |
| **Staging is frozen: unfreeze it to approve.** | **Unfreeze** staging, or leave it frozen until you’re ready |
| **Failed** | Read the plan’s steps for what Cloudflare refused, often a write permission the token lacks. A change that can’t be undone is never rolled back by itself |
| **Applied**, unverified | Nothing called what changed, so the board couldn’t read its health yet. Call it, and look again after the next refresh |

## Next

- **Envelopes.** Bounds you approve once on an environment, on the repository’s settings page under Infrastructure: “2 to 10 instances”, “3 restarts a day”. The board scales and restarts inside them without asking you again, and tells you after. Anything outside them waits for you ([Envelopes and scaling rules](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#envelopes-and-scaling-rules)).
- **Runbooks.** A routine with a signal trigger, so an agent starts on an incident by itself, reads, diagnoses, and proposes the fix by pull request. Approve stays yours ([Runbooks](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#runbooks)).
- **Production.** Its own write token, in a GitHub environment named `production` limited to the default branch, then `npx breakaway infra init --update` and merge it. Production gates make every plan there wait for you and its incidents push. **Freeze** stops every plan, and on the deploy flow pauses Promote and Release too; Roll back still works.
- **The policy.** `.github/breakaway-infra/policy.json` decides which plans wait for you. By default every plan does, in every environment ([Policy](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#policy)).
