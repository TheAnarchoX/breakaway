---
title: Agents propose it. You approve it.
kicker: Architect · new in 2.0
lede: breakaway runs the infrastructure too, and you still decide.
description: breakaway runs the infrastructure too, and you still decide. Agents change what should exist in a pull request, the plan waits for you, and the board applies what you approve. On Cloudflare.
---
The board already holds the work: ideas, tasks, pull requests, deploys, and releases. Architect adds what that work runs on. Agents propose a change to an environment in a pull request. Nothing changes until you approve it, or until it fits bounds you approved once. Then the board applies it.

![Agents propose it. You approve it. In three steps: 1, an agent changes staging in a pull request, #41, to staging.json. 2, the plan waits for you: 2 changes, 6.40 dollars more a month, estimated, and it can be undone. 3, you press Approve, and the board applies it and checks its health.](/media/architect-dark.png)

![An 84-second film, no sound, on carbon, of a made-up repository, acme/widgets, on breakaway's board, with one line beside each view. An idea, "Let people export their widgets", arrives on the board, then its three tasks: "Write the work down." An agent claims WGT-12, its work ID turns red, and its output streams on the task: "Agents claim it." Its pull request, #38, is ready to merge with 3 of 3 checks passed, and WGT-12 arrives in Done: "You merge it." Production's map draws itself: two custom domains, one Worker, two Durable Objects, and a D1 database, all healthy with their estimated costs, and Promoted lands in its stream: "See what runs." On staging's map a KV namespace, a queue, an R2 bucket, and a container arrive, each marked adds, from pull request #41, and its plan waits for you: "Agents propose it." On production's console, a change of the render container's most instances from 3 to 6, its plan formed under it, plus 7.20 dollars a month, needing your approval, and Propose the change is pressed: "Or change it yourself." On a phone, a push says plan-2 waits for you; Approve is pressed and turns red, and the plan reads Approved: "You approve it." The new resources turn healthy and the stream says the health check passed: "The board applies it." The feature Exports, chasing, as three agents claim a task each: "Many agents. One claim each." Three short-lived environments arrive, one per task: "An environment per task." Staging's render container scales from 2 to 4 inside its envelope, 2 to 6: "Bounds you set once." Production's render container goes down, a push says WGT-41 needs you: incident, and the incident shows diagnose and propose done and approve now: "When it breaks, it's a task." Its follow-up, WGT-42, lands on the board: "Back on the board." Then a loop of words drawn around a ring: idea, task, pull request, merge, deploy, plan, approve, apply, what runs, signal, incident, task: "From idea to incident, on one board. You decide." Then the breakaway logo, "Leave the pack.", npx breakaway, and "Free for people, not for profit".](/media/2-0-0-film.mp4 "The whole loop, on a made-up repository: 84 seconds, no sound.")

## 1. The board sees what runs

Connect a provider with a read-only token: Cloudflare, the one provider in 2.0.0. The Infrastructure view shows each repository’s environments, production, staging, and the short-lived ones a task makes: what runs there, what it uses, its health, and what it costs a month, marked as an estimate.

![The Infrastructure view, with made-up environments of a repository called widgets on Cloudflare: production is down, 1 of 7 resources, at 24.30 dollars a month inside its 60 dollar budget; staging is healthy, at 13.50 dollars a month inside its 20 dollar budget, and plan-2 waits for you.](/media/infra-dark.png "The Infrastructure view, with made-up environments.")

Open an environment, and its page shows what runs there as a map, what changes next, and what happened, as it happens.

![Staging’s page on the board: healthy, not frozen, plan-2 waits for you, 68% of its budget. Its resources as a map: a route in front of the widgets-api-staging Worker, which holds a KV namespace, a D1 database, a queue, an R2 bucket, and a container, with the queue and the container marked as changing. Beside it, the live stream: the plan from pull request #41 waiting for you, and before it, plan-1 applied by the executor, its health check passed.](/media/environment-dark.png "An environment’s page: its map and its live stream.")

## 2. Agents propose by pull request

What should exist is a file in the repository, under `.github/breakaway-infra/`. An agent changes it in an ordinary pull request, and the pull request shows the plan as a check: what changes, what it costs, what else it touches, and whether it can be undone. Merging applies nothing. The board plans from the default branch, and the plan waits for you.

Or change it yourself, on an environment’s console: change what you see, and the plan forms beside the map as you edit. Press **Propose the change**, and the board opens the pull request, so you never have to. Approve merges it and applies the plan.

- **Agents never apply.** They hold no write credentials, and no agent can press Approve.
- **Read wide.** Any agent reads the environments, plans, signals, and incidents with `npx breakaway infra` or the board’s MCP server, before it changes anything.
- **Pull requests close tasks**, and a change to infrastructure is a pull request too.

## 3. You approve. The board applies.

A plan that waits for you pushes to your phone. Open it, read it, and press **Approve** or **Reject**. The board applies what you approve with the repository’s own apply workflow, whose write token lives in a GitHub environment only the default branch can use, never on the board. Then it checks health, and rolls back by itself if the check fails.

Connections walks you through the tokens: the read-only one for the board, and for each environment a GitHub environment with its write token. The repository also needs the variable `BREAKAWAY_URL`, your board’s address, and the apply workflow, which a change from the console brings with it, or `npx breakaway infra init` writes.

![A plan for staging on a phone: plan-2, from pull request #41, waiting for you: 2 changes, plus 6.40 dollars a month, estimated, touching 1 more resource, and it can be undone. What changes: widgets-exports-staging scales from 3 to 4. At the bottom, Reject and Approve.](/media/plan-dark.png "A plan that waits for you, on a phone.")

Every plan asks you, in every environment, until you approve an envelope or loosen your policy, and loosening is never one press. A plan that gives an environment its target, the Worker it runs, always waits for you. **Freeze** an environment, and every plan there stops, envelopes included, until you unfreeze it. Freezing production pauses its deploys too; Roll back still works.

## 4. Bounds you set once

An envelope is bounds you approve once on one environment: “2 to 10 instances”, “3 restarts a day”, and up to what it may cost a month. The board scales and restarts inside them without asking you again, and tells you after. Anything outside them waits for you, production included.

![Environments in a repository’s settings. Production has an envelope: 2 to 10 for widgets-render, up to 60 a month, 3 restarts in a day, with 0 of 3 restarts used in the last day, and Revoke and Change. Staging has none: every scale and restart waits for you.](/media/envelope-dark.png "An envelope on production, in Settings.")

## 5. When something breaks, it’s a task

A signal that crosses a rule opens an incident: a task, in the repository that owns what broke. A production incident pushes; the rest waits in the inbox. Its steps show on the board: diagnose, propose, approve, apply, verify, and a write-up. An agent you start, or a runbook you turned on, diagnoses it and proposes the fix by pull request. Approve is still yours.

![An incident on the board, a task: Incident, health, critical, in production (widgets-render), open, pushed to your phone. Its steps: diagnose, now; then propose, approve, apply, verify, and write up.](/media/incident-dark.png "An incident is a task, with its steps.")

## What it does, and doesn’t

- **It runs what your repositories run on**, on Cloudflare, the one provider in 2.0.0. Not every cloud, and not anything the board’s repositories don’t use.
- **It never acts on its own word.** An envelope, or a policy you loosened, is bounds you approved. Outside them, the plan waits for you.
- **It only watches its own install.** The board’s own environment is observe only: Architect never changes it.
- **Your data stays.** The inventory and the signals stay in your install, redacted: names and settings, never values or code. The read-only token goes only to its provider.
- **Amounts are estimates**, in the currency you set, with the rate when converted.
- **Off until you connect a provider.** Updating to 2.0.0 changes nothing until then.
- **Free for personal and noncommercial use, and the source is public.** Architect is in the same licence, the PolyForm Noncommercial License 1.0.0. Commercial use is by exception, granted free and case by case ([licensing](/licensing/)). There is no paid tier and no hosted version.

## Read more

- [Get started with Architect](/docs/get-started-with-architect/): from a read-only token to your first approved plan, step by step.
- [Updating to 2.0.0](/docs/updating-to-2/): what updating changes, what stays off, and how to go back.
- [The manual’s Architect section](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect): environments, plans, envelopes, signals, incidents, and cost, in full.
- [Run your own board](/docs/quickstart/), if you don’t have one yet.
