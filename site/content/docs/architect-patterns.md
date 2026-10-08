---
title: Patterns
description: Setups that work, each with when to use it and how: staging first, an app with its infrastructure, adding what the code uses, golden paths, loosening staging only, scaling on a signal, runbooks, an environment per task, one account kept apart, and more.
---

Each pattern says when it fits, how to set it up, and what you’ll see. They combine: most repositories end up with the first three, and add the rest as they need them.

## Staging first, then production

**When:** always. It’s how Architect is meant to start.

1. Connect the read-only token, and describe staging as code ([Get started with Architect](/docs/get-started-with-architect/)).
2. Give staging a write token and the apply workflow, and approve a few small changes there.
3. Only then give production its own write token, in its own GitHub environment, and run `npx breakaway infra init --update`.

**You’ll see:** staging’s audit trail fill with plans, approvals, and applies before production has a token at all. A mistake in a token or a workflow shows up on staging, where it costs nothing.

## An app with its infrastructure

**When:** a Worker app whose code you deploy, and whose resources you want on the board too.

Put the repository on the deploy flow, then let Architect watch the same staging and production. Merges deploy staging, **Promote** ships production, and plans you approve change what the code runs on. One token per environment does both. [Architect and the deploy flow](/docs/architect-deploy-flow/) walks through it in order.

**You’ll see:** each environment’s page with its deploys, Promotes, Roll backs, and plans in one history, and one **Freeze** that stops both on production.

## Add something the code uses: make it, then bind it

**When:** the code needs a new database, namespace, bucket, or queue.

1. **Make it** in a pull request that changes only the environment’s file, from **Add resource** on the console or `npx breakaway infra add`. Approve its plan.
2. **Bind it** in a second pull request: the wrangler config’s binding and the code that uses it.

**Why two:** a deploy fails when the code binds something that doesn’t exist yet, and a plan that’s all creates is easy to read and undo. Do staging, then production. To remove one, go the other way: stop using it and deploy, then take it out of the file.

## A golden path for what you add often

**When:** you add the same kind of thing again and again, and want it done your way every time: the same queue settings, the same naming, the same sender module.

Write `.github/breakaway-infra/templates/<name>/template.json` with its inputs, the resources it adds, the binding it extends, and the code it writes ([Describe it as code](/docs/architect-desired-state/#golden-paths)). Then a task for an agent is one line: “Add an exports queue to staging with the queue template.”

**You’ll see:** your template on the console’s **Add resource**, under the kinds, and agents’ pull requests that all look the same.

## Let staging move, keep production waiting

**When:** you trust small changes on staging, and approving each one there is noise.

```json
{
  "version": 1,
  "allow": [{ "name": "small staging changes", "environments": ["staging"], "changes": ["update"], "maxChanges": 3 }],
  "environments": { "production": { "allow": [] } }
}
```

Propose it from **Policy** on Infrastructure. It loosens your policy, so it takes a second press, **Loosen it**.

**You’ll see:** small setting changes on staging applied with the rule’s name recorded, and everything else still waiting for you: deletes, routes and domains, anything over the cost limit, and every plan in production.

## Scale on a signal, inside bounds

**When:** a container or a queue consumer needs more room under load, and you’d rather not be woken to say yes.

1. On the repository’s settings page, **Add an envelope** on production: “2 to 10 instances” for the container, a cost bound, and the restart cap.
2. Add a rule to `.github/breakaway-infra/scaling.json` that scales it up a step on a warning about it ([Envelopes and scaling rules](/docs/architect-envelopes/#scaling-rules)), and merge it.

**You’ll see:** a quiet note in the inbox each time it scales inside the envelope, and a plan that waits for you, with a push, the moment it would go past.

## Let an agent take the first look

**When:** incidents happen at hours you’re not at your desk, and you want the diagnosis ready when you are.

Make a routine whose prompt works the signal’s incident read only, and give it a **Signal trigger**: production, critical, and **wait** for your Start at first. Once you trust it, let a match start the agent. If its description allows one restart, it can ask for it inside your envelope ([Signals, incidents, and runbooks](/docs/architect-signals/#runbooks)).

**You’ll see:** the incident’s push, and, by the time you open it, the agent’s diagnosis as a comment and its fix as a pull request waiting for you.

## An environment per task

**When:** agents’ changes need somewhere real to run before staging, like a preview of a new service.

Write `.github/breakaway-infra/short-lived.json`, give the GitHub environment `short-lived` its token, and run `npx breakaway infra init --update` ([Environments](/docs/architect-environments/#short-lived-environments)). To make them without asking, add `{ "name": "task environments", "environmentKinds": ["short-lived"], "changes": ["create"] }` to the policy.

**You’ll see:** an environment named after the task’s work ID when it’s tagged `+environment`, its cost added up on the task, and a removal plan waiting for you when the task closes.

## Staging and production on one account, kept apart

**When:** staging and production share a Cloudflare account, which is the only way the board sees both in 2.0: its read-only token is an account token, and it reaches one account.

- **Name them apart**: `widgets-api-staging` and `widgets-api`, `widgets-staging` and `widgets` for the database, so neither file can name the other’s resources.
- **Scope the Workers role** of each write token to that environment’s Workers only. It’s the one Cloudflare permission that can be scoped to single resources.
- **Keep production’s token for production**, in its own GitHub environment, and never reuse staging’s.

The board keeps each call inside an environment’s resources and refuses a plan that reaches outside them, so a staging plan never touches production. What it can’t do is narrow Cloudflare’s other permissions: a staging token with D1 Write could write any database on the account, if something other than the apply workflow used it. That’s why it lives only in a GitHub environment the default branch alone may use.

## Watch the budget

**When:** you want to hear before a month goes over, not after.

Set budgets in the policy (`"environments": { "production": { "budget": 200 } }`), and a routine on `budget.crossed:percent=70` whose prompt reads `infra show` and comments what grew and why ([Cost and budgets](/docs/architect-cost/)).

**You’ll see:** the routine’s run at 70%, the board’s warning signal at 80%, and an incident only if it goes over.

## Freeze while you look

**When:** something’s wrong, or you’re about to launch, and nothing should change under you.

**Freeze** production. Every plan stops, envelopes included; on the deploy flow, Promote and Release stop too, and **Roll back** still works. Look, fix by pull request or break-glass, then **Unfreeze** ([Freeze, gates, and locks](/docs/architect-freeze/)).

## A new project from Kickoff

**When:** you’re starting something from a pitch, with no repository yet.

Kick it off from the board. Its **Run it** step asks once whether it runs anywhere: **Set it up now** walks you through the provider, the write tokens, staging and production, and the first plan; **Have an agent do it** has the kickoff’s agent write staging’s and production’s files and the apply workflow in the same pull request as its plan. Either way the first plan waits for you, and **Deploys** puts the code on the deploy flow ([GitHub](/docs/github/#move-a-repository-to-the-deploy-flow)).

**You’ll see:** the project’s first pull request with its plan, its tasks, and its infrastructure as code together, and nothing applied until you approve it.
