---
title: Plans and approvals
description: What a plan says, where plans come from, their statuses, approving and rejecting one, and what happens after you approve: the lock, the apply workflow, the health check, and the rollback.
---

A **plan** is the exact change the board would make to one environment. The board works out every plan itself, from the environment’s file against what runs, never from what a request sends it. A plan is what you approve: never a pull request, and never a guess.

## What a plan says

```text
plan-2 · staging · from #41 · waiting for you

What changes                         2 changes
  widgets-exports-staging   queue    adds
  widgets-api-staging       worker   binds EXPORTS to widgets-exports-staging

What it costs        6.40 more a month, estimated
What else it touches 1 more resource: widgets-api-staging's routes
Can it be undone     Yes

The policy           Needs you: the default asks you about every plan.
```

- **What changes**, setting by setting, for each resource: adds, changes, or removes.
- **What it costs**: the change to the environment’s estimated monthly cost, in your currency, with the rate it was checked at.
- **What else it touches**: what uses the resources it changes, from what the board knows runs there.
- **Can it be undone**: and why not, when it can’t. Deleting a database, a namespace, a queue, or a Worker can’t be undone.
- **The policy**: which policy decided, its answer (refused, needs you, or allowed), and each rule’s reason in words, a line each: “Production needs you.” “Can’t be undone: it deletes the `widgets` database.”

## Where plans come from

| Source | When | What happens |
| --- | --- | --- |
| **Pull request** | A pull request that changed the environment’s file merged | Waits for you, with a push, unless the policy lets it through |
| **Drift** | What runs changed by hand | A **draft**, with no push ([Drift, break-glass, and clean up](/docs/architect-drift/)) |
| **Envelope** | A scaling rule or a runbook asked for a scale or a restart | Applies with no press inside the envelope; waits for you outside it |
| **Clean up** | Something nobody owns, a week after the board flagged it | Waits for you: it’s a delete |
| **Short-lived** | A task asked for its own environment, or closed | Waits for you, unless the policy lets a short-lived one through; a removal always waits |
| **Deploy** | A Promote or Roll back on the deploy flow finished | Recorded as already applied: the workflow did it |

## Statuses

| Status | What it means |
| --- | --- |
| **Draft** | The board’s suggestion. It sends no push. Approving it from its page puts it in front of you and approves it in one step |
| **Waiting for you** | It needs your answer |
| **Approved** | You approved it, or the policy or an envelope did, and it’s queued to apply |
| **Rejected** | Nothing changed |
| **Applying** | The repository’s apply workflow holds the write token and is applying it |
| **Applied** | It applied, and the health check passed. **Applied, unverified** means nothing had called what changed yet, so its health couldn’t be read |
| **Failed** | It didn’t apply, or applied partway and couldn’t be undone. **Failed: nothing applied** means the run stopped before it had the plan |
| **Rolled back** | It applied, the health check failed, and the board applied the reverse |

## Approve or reject

A plan that waits for you sends one push, which names the environment and links to the plan’s page. Open it on your phone or at your desk, read it, and press **Approve** or **Reject**. The same buttons are on the environment’s page and, for a change from the console, on the change’s card.

- **Approve** asks first and says what follows: “Approve this plan for production? The board applies it next and rolls back if the health check fails.”
- **Reject** changes nothing: “Reject this plan? Nothing changes.” You can still reject a plan you approved, until it starts applying.
- **Only you can press them**, from the signed-in board, like **Merge**. The token agents and the CLI hold can’t, and a request signed with an agent’s name is refused.

A plan the policy let through, or an envelope, is approved with that rule or envelope recorded on it, so you can always see why it didn’t ask you.

## After you approve

Approving queues the plan. A moment later the board starts it, and you can follow each step on the plan’s page and the environment’s stream:

1. **It checks again**: the plan is still approved, still the changes you saw (its digest), and not out of date; the environment isn’t frozen or observe only; the repository has the apply workflow; and its GitHub environment lets only the default branch deploy.
2. **It takes the environment’s lock**, so one apply runs at a time per environment.
3. **It starts the apply workflow** on the default branch, through the GitHub App, for this one plan.
4. **The run asks the board for the plan**, with its GitHub OIDC token. The board answers only the run it started, on the default branch, for a plan approved for that environment, and only once. Anything else stops the run before it reads the write token.
5. **The run applies it** with the environment’s write token, and reports each step with the plan’s digest, so a plan that changed since you approved it is refused.
6. **The board checks health** of what changed, through the provider. Healthy: **Applied**. A resource down or degraded, health that can’t be read, or an apply that failed partway: the board starts the workflow again for the reverse of what applied, under the same lock, and the plan ends **Rolled back**.

A change that can’t be undone is never rolled back by itself: the plan ends **Failed** and says why. Every end but a clean apply is a signal, and a failure in production opens an incident and pushes.

## Start the run again

A run can stop before it ever asked for the plan: its setup failed, or it was cancelled. The runner only gets a plan from the board, so it changed nothing. A few minutes after a start, if the run hasn’t asked, the board reads the workflow’s runs on GitHub and links the run on the plan; the Plan tile reads “Waiting for the run to check in, 4 min”. When GitHub says the run ended, the plan is **Failed: nothing applied**, with GitHub’s conclusion and a link, and the lock is released.

Fix what GitHub’s run says, then press **Start the run again** on the plan. It checks everything a start checks, puts the plan back to approved, and starts a new run under a new lock. It’s only offered when nothing applied, for certain.

**GitHub’s Re-run never applies a plan.** A plan runs once per start, so a re-run is refused, and its log says to press **Start the run again** on the board.

## The lock

One apply runs at a time per environment. The lock lasts 15 minutes, and the board renews it while the apply works; a lock nobody renews frees itself within the hour. While one is held, the environment’s page says which plan holds it.

A plan that can’t start yet stays **Approved**, and says why: another plan holds the lock, the repository has no apply workflow, its GitHub environment lets another branch deploy, or GitHub refused. Fix what it says, and it starts on its own. **Release the lock**, under the environment’s status band, frees it by force: it asks first, since the next approved plan can start at once.

## The audit trail

Every write Architect makes is appended once and never edited: a plan, its approval or rejection, an apply, a rollback, an envelope set or acting, a lock released, a freeze, break-glass, an environment added or pointed somewhere else, and what nobody owns, flagged or removed. Each entry names the environment, who did it (you, the board, an envelope, a rule, or an agent’s task), and what, redacted. An environment’s page shows its trail, newest first. Entries are kept two years.

## From the terminal

```sh
npx breakaway infra plans --environment staging --state waiting
npx breakaway infra plan plan-2
```

Both only read, for you and your agents. Approving stays on the board.
