---
title: Environments
description: What an environment is, the three ways to add one, how to build one from nothing or have an agent set it up, and short-lived environments, one per task.
---

An **environment** is a named place a repository runs. It has a kind, a provider, a **target** (what it points at on the provider: a Worker’s name), and three switches: **freeze**, **production gates**, and **observe only** ([Freeze, gates, and locks](/docs/architect-freeze/)). Its name is also its file’s name: `staging` is `.github/breakaway-infra/staging.json`.

A fresh install has none. A repository can have up to 50.

## Kinds

| Kind | What it’s for | By default |
| --- | --- | --- |
| **production** | What your people use | Production gates on: every plan waits for you, and its incidents push to your phone |
| **staging** | Where changes go first | Plans wait for you under the default policy; its incidents wait quietly in the inbox |
| **short-lived** | One task’s own, made for it and removed when it closes | Made and removed by plans that wait for you |

## Add one

There are three ways, and you pick by where the repository starts.

1. **It’s on the deploy flow.** It already has two: **staging** and **production**, pointing at its pipeline’s Workers. The board made them when it read the pipeline, and its deploys, Promote, and Roll back show on them ([Architect and the deploy flow](/docs/architect-deploy-flow/)).
2. **It runs something already.** On **Infrastructure**, press **Add an environment**: pick the repository, a name like `staging`, its kind, the provider, and its target, the Worker’s name. The board looks at what runs there right after, and every 15 minutes.
3. **You’d rather describe it.** In the same dialog, **Have an agent do it** writes the agent’s prompt for you in three steps:
   - **How**: **Describe what you need** in your own words (“a Worker with a D1 database and a queue for exports”), or **Let the agent work it out** from the repository’s wrangler config, bindings, and code.
   - **Environment**: its name, kind, provider, and target, if it has one yet.
   - **Prompt**: read it, change it if you like, and **Open New agent**. Nothing starts until you press **Start agent** there.

   The agent writes the environment’s file, runs `infra check`, and opens a pull request. Its plan waits for you after you merge it.

Adding, renaming, and removing an environment are yours: an agent’s request is refused. Kickoff’s **Run it** step can add staging and production for a new project too ([Patterns](/docs/architect-patterns/#a-new-project-from-kickoff)).

## The target

The target is where the board starts looking. It reads the target and everything the target reaches: the Workers it calls, and what they bind. Nothing else on the account is read or kept, so the map shows only what this environment runs.

- **No target yet?** The board looks with the one Worker the environment’s merged file declares, and skips it while the file declares none or several.
- **Approving a plan that gives an environment its target** always waits for you, whatever your policy lets through.
- **A first apply that failed** leaves the target pointing at nothing. The console says so, with **Clear the target** to start over: nothing that runs changes, and the next change, or **Compare now** while the file still declares it, plans it again.

## Build one from nothing

An environment with nothing in it shows **Add resource** as its first step. You can build the whole thing from the board, without writing a file:

1. **Add an environment** with no target.
2. **Add resource**, then **Worker**: give it a name. A new Worker starts with a small module that answers `/health`, until your deploy puts its code on it.
3. **Add resource** again for each thing it uses, a D1 database, a KV namespace, a bucket, or a queue, and pick the Worker under **Bind it to**, with the binding name your code will use. Each shows dashed on the map, marked **+ adds**.
4. **Propose it**. The board opens the pull request with the environment’s first file, and the apply workflow too when the repository doesn’t have one yet and the App may write workflows.
5. **Approve**. This plan gives the environment its target, so it always waits for you. Making a Worker needs **Workers Admin** on the environment’s write token, for this one apply: add it before you approve, and take it away after ([Tokens, GitHub, and the apply workflow](/docs/architect-connections/#each-environments-write-token)).
6. **Deploy the code** into the new Worker, with the deploy flow or your own workflow. Its wrangler config names the same bindings ([Architect and the deploy flow](/docs/architect-deploy-flow/#keep-the-wrangler-config-and-the-file-in-agreement)).

A Durable Object or a container is made by code. The console says what code must exist, and **Have an agent write it** starts an agent on it. Its plan applies only once that code is deployed.

## What an environment’s page shows

- **A status band**: health, freeze, the plan waiting, the budget used, drift, and who holds the lock while one apply runs.
- **The map**: each resource with its health and estimated monthly cost, and what uses what. **List** shows the same as rows. A plan waiting marks the resources it changes.
- **The live stream**: signals, plans, applies, deploys, and freezes, as they happen.
- **Plans, incidents, drift, what nobody owns, recent deploys, cost, and the audit trail**, newest first.

**Refresh** looks at what runs now, and **Last looked** says when the board last did, and what went wrong if anything did.

## Short-lived environments

A task can have its own environment: made from a template through a plan, and removed through a plan when the task closes. Use them when an agent’s change needs somewhere real to run before it reaches staging.

1. **Write the template**, `.github/breakaway-infra/short-lived.json`. It’s a desired state with a `target`, where `{environment}` in the target and in every resource’s `id` and `name` becomes the environment’s name, so no two tasks share a resource:

   ```json
   {
     "version": 1,
     "provider": "cloudflare",
     "target": "widgets-{environment}",
     "resources": [
       { "id": "worker:widgets-{environment}", "kind": "worker", "name": "widgets-{environment}" },
       { "id": "kv:widgets-cache-{environment}", "kind": "kv", "name": "widgets-cache-{environment}" }
     ]
   }
   ```

2. **Give them a write token**: one GitHub environment, `short-lived`, for all of them, with only the write permissions the template needs. Then run `npx breakaway infra init --update` and merge it, so the apply workflow takes any environment name.
3. **Ask for one.** An agent tags its own task `+environment`, or you press **Give it an environment** in the task’s **Environment** section. The board adds an environment named after the task’s work ID (`wgt-12`), owned by the task, and the plan that makes it, which waits for you. A policy rule for `"environmentKinds": ["short-lived"]` can let it through ([Policy](/docs/architect-policy/#letting-some-through)).
4. **When the task closes**, anywhere (the board, the CLI, a merged pull request, Taskwarrior), the board makes the plan that removes everything in it. That plan is all deletes, so it always waits for you. Once it’s applied, the environment goes. One whose task stays open is offered for removal after 14 days.

A repository has at most 3 short-lived environments at once. A request over that, or with no template or no connected provider, is refused with why, and looked at again in an hour. Each one’s estimated cost adds up on its task.
