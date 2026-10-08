# Architect

> The board running the infrastructure your repositories run on, and you still deciding what changes. What Architect is, how a change goes, what stays true, its words, and where to read on.

**Architect** is the part of the board that runs what your repositories run on: their Workers, databases, namespaces, buckets, queues, containers, routes, and custom domains. It came in 2.0.0, it runs on Cloudflare, and it’s off until you connect a provider. Until then the board makes no call for it.

It works the way the rest of the board does. What should exist is a file in the repository. Agents change it by pull request. The board works out the exact change, a **plan**, and the plan waits for you. You press **Approve**, and a workflow in the repository applies it, with a write token the board never holds. Then the board checks health, and rolls back by itself if the check fails.

## How a change goes

```text
the file: what should exist     Cloudflare: what runs
staging.json                    (the read-only token)
            \                     /
             the board compares them
                       |
                       v
     a plan: what changes, what it costs,
     what else it touches, can it be undone
                       |
     the policy: it waits for you, or it
     fits bounds you approved once
                       |
               you press Approve
                       |
                       v
     the repository's apply workflow, with
     staging's write token, from a GitHub
     environment only the default branch uses
                       |
                       v
     the board checks health, and rolls
     back by itself if the check fails
```

Every step is on the board: the plan as it forms, your approval, the run, and the health check, on the environment’s page and in its audit trail. A plan that waits for you sends one push, so you can approve from your phone.

## Two lanes: code, and what it runs on

Architect doesn’t replace the deploy flow. They’re two lanes, and a repository can use either or both.

| | The deploy flow | Architect |
| --- | --- | --- |
| What it changes | The code: a new version of a Worker | What the code runs on: a Worker’s settings and bindings, and the resources around it |
| Where it’s written | The code and its wrangler config | `.github/breakaway-infra/<environment>.json` |
| How it goes | Merging deploys staging; you press **Promote** and **Roll back** | Merging plans; you press **Approve**, the board applies |
| Its buttons | **Promote**, **Roll back**, **Release** | **Approve**, **Reject**, **Freeze** |

On a repository with both, staging and production are one pair of environments: their deploys, Promotes, and Roll backs show on the same pages as their plans. [Architect and the deploy flow](https://leavethepack.dev/docs/architect-deploy-flow/) says how to set up an app and its infrastructure together.

## What stays true

- **Agents propose and never apply.** They read everything and change infrastructure only by pull request. They never hold a write token, start the apply workflow, or press Approve.
- **Nothing changes without your approval**, or inside bounds you approved once on an environment: an [envelope](https://leavethepack.dev/docs/architect-envelopes/), or a [policy](https://leavethepack.dev/docs/architect-policy/) you loosened. Until then, every plan waits for you, in every environment.
- **The board holds no write credentials.** It keeps one read-only token per provider. Each environment’s write token lives in a GitHub environment in its repository, and only the apply workflow reads it, for one plan you approved.
- **The board only watches its own install.** The environment the board runs on is always observe only: no plans, no envelope, no apply. Its way back is [Recover without the board](https://leavethepack.dev/docs/recovery/).
- **Your data stays in your install.** The board keeps names, kinds, settings, health, and cost, never a secret’s value, a stored value, or code. The read-only token goes only to its provider.

## The words

Architect uses the same few words everywhere: on the board, in pushes, in the CLI, and here.

| Word | What it means |
| --- | --- |
| **environment** | A named place a repository runs: **production**, **staging**, or **short-lived** (one task’s own). |
| **provider** | A platform you connect so the board can see what runs there. Cloudflare, in 2.0. |
| **desired state** | What should exist in one environment: its file in `.github/breakaway-infra/`. |
| **change** | What you edit on an environment’s page before it becomes a pull request and a plan. |
| **plan** | The exact change the board would make to one environment: what changes, what it costs, what else it touches, and whether it can be undone. |
| **approve**, **reject** | Your answer to a plan that waits for you. Only you can, and only on the board. |
| **apply** | What the board does with a plan you approved. It’s a status, never a button. |
| **policy** | The rules that decide which plans wait for you. |
| **envelope** | Bounds you approve once on one environment, like “2 to 10 instances” or “3 restarts a day”. |
| **signal** | One thing the board heard about an environment: its health, a platform’s alert, or its cost. |
| **incident** | A task tagged `+incident`, opened when a signal crosses a rule. |
| **drift** | What runs no longer matches its file. |
| **break-glass** | A change you made by hand outside a plan, on purpose. The board records it and never undoes it. |
| **freeze** | Stop every plan on one environment until you unfreeze it. |
| **observe only** | An environment the board watches and never changes. |

## Where it shows

- **Infrastructure**, in the sidebar (`g` then `n`): each repository’s environments, with health, drift, estimated cost, freeze, and the plan waiting. **Add an environment** and **Policy** are here.
- **An environment’s page**, its console: what runs there as a map, a live stream of what happens, its plans, incidents, drift, deploys, cost, and audit trail. You change it here too.
- **A plan’s page**, the link a waiting plan’s push carries, with **Approve** and **Reject**.
- **The inbox**: incidents lead it, production’s first.
- **A repository’s settings page**, under **Infrastructure**: the policy in force, each environment’s freeze, and its envelope.
- **Connections**: the provider’s token, and each repository’s **Infrastructure tokens** checklist.
- **Settings**, under The board: the currency costs show in.
- **The terminal**: `npx breakaway infra` and its reads, for you and your agents ([Agents and infrastructure](https://leavethepack.dev/docs/architect-agents/)).

## Read on

| You want to | Read |
| --- | --- |
| Go from nothing to your first approved plan | [Get started with Architect](https://leavethepack.dev/docs/get-started-with-architect/) |
| Know what it can run, change, and scale | [What’s supported](https://leavethepack.dev/docs/architect-supported/) |
| Add an environment, or build one from nothing | [Environments](https://leavethepack.dev/docs/architect-environments/) |
| Write or read the files in `.github/breakaway-infra/` | [Describe it as code](https://leavethepack.dev/docs/architect-desired-state/) |
| Change what runs, from the board or by pull request | [Change an environment](https://leavethepack.dev/docs/architect-changes/) |
| Read a plan, approve it, and follow it to applied | [Plans and approvals](https://leavethepack.dev/docs/architect-plans/) |
| Decide which plans wait for you | [Policy](https://leavethepack.dev/docs/architect-policy/) |
| Let the board scale and restart within bounds | [Envelopes and scaling rules](https://leavethepack.dev/docs/architect-envelopes/) |
| Hear when something breaks, and work it | [Signals, incidents, and runbooks](https://leavethepack.dev/docs/architect-signals/) |
| See what it costs, and set budgets | [Cost and budgets](https://leavethepack.dev/docs/architect-cost/) |
| Copy a setup that works | [Patterns](https://leavethepack.dev/docs/architect-patterns/) |
| Set up the tokens, GitHub environments, and the apply workflow | [Tokens, GitHub, and the apply workflow](https://leavethepack.dev/docs/architect-connections/) |
| Run an app’s deploys and its infrastructure together | [Architect and the deploy flow](https://leavethepack.dev/docs/architect-deploy-flow/) |
| Know what agents may do | [Agents and infrastructure](https://leavethepack.dev/docs/architect-agents/) |
| Stop every change, or see who holds an environment | [Freeze, gates, and locks](https://leavethepack.dev/docs/architect-freeze/) |
| Change something by hand, and put it back in code | [Drift, break-glass, and clean up](https://leavethepack.dev/docs/architect-drift/) |
| Fix what didn’t go through, or recover without the board | [When it goes wrong](https://leavethepack.dev/docs/architect-recovery/) |
