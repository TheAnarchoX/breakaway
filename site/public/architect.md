# Architect: Agents propose it. You approve it.

> breakaway runs the infrastructure too, and you still decide. Agents change what should exist in a pull request, the plan waits for you, and the board applies what you approve. Cloudflare first.

The board already holds the work: ideas, tasks, pull requests, deploys, and releases. Architect adds what that work runs on. Agents propose a change to an environment in a pull request. Nothing changes until you approve it, or until it fits bounds you approved once. Then the board applies it.

![Agents propose it. You approve it. In three steps: 1, an agent changes staging in a pull request, #41, to staging.json. 2, the plan waits for you: 2 changes, 6.40 dollars more a month, estimated, and it can be undone. 3, you press Approve, and the board applies it and checks its health.](https://leavethepack.dev/media/architect-dark.png)

## 1. The board sees what runs

Connect a provider with a read-only token: Cloudflare first. The Infrastructure view shows each repository’s environments, production, staging, and the short-lived ones a task makes: what runs there, what it uses, its health, and what it costs a month, marked as an estimate.

![The Infrastructure view, with made-up environments of a repository called widgets on Cloudflare: production is down, 1 of 7 resources, at 24.30 dollars a month inside its 60 dollar budget; staging is healthy, at 13.50 dollars a month inside its 20 dollar budget, and plan-2 waits for you.](https://leavethepack.dev/media/infra-dark.png "The Infrastructure view, with made-up environments.")

Open an environment, and its page shows what runs there as a map, what changes next, and what happened, as it happens.

![Staging’s page on the board: healthy, not frozen, plan-2 waits for you, 68% of its budget. Its resources as a map: a route in front of the widgets-api-staging Worker, which holds a KV namespace, a D1 database, a queue, an R2 bucket, and a container, with the queue and the container marked as changing. Beside it, the live stream: the plan from pull request #41 waiting for you, and before it, plan-1 applied by the executor, its health check passed.](https://leavethepack.dev/media/environment-dark.png "An environment’s page: its map and its live stream.")

## 2. Agents propose by pull request

What should exist is a file in the repository, under `.github/breakaway-infra/`. An agent changes it in an ordinary pull request, and the pull request shows the plan as a check: what changes, what it costs, what else it touches, and whether it can be undone. Merging applies nothing. The board plans from the default branch, and the plan waits for you.

- **Agents never apply.** They hold no write credentials, and no agent can press Approve.
- **Read wide.** Any agent reads the environments, plans, signals, and incidents with `npx breakaway infra` or the board’s MCP server, before it changes anything.
- **Pull requests close tasks**, and a change to infrastructure is a pull request too.

## 3. You approve. The board applies.

A plan that waits for you pushes to your phone. Open it, read it, and press **Approve** or **Reject**. The board applies what you approve with the repository’s own apply workflow, whose write token lives in a GitHub environment, never on the board. Then it checks health, and rolls back by itself if the check fails.

![A plan for staging on a phone: plan-2, from pull request #41, waiting for you: 2 changes, plus 6.40 dollars a month, estimated, touching 1 more resource, and it can be undone. What changes: widgets-exports-staging scales from 3 to 4. At the bottom, Reject and Approve.](https://leavethepack.dev/media/plan-dark.png "A plan that waits for you, on a phone.")

Every plan asks you, in every environment, until you say otherwise. **Freeze** an environment, and every plan there stops, envelopes included, until you unfreeze it.

## 4. Bounds you set once

An envelope is bounds you approve once on one environment: “2 to 10 instances”, “3 restarts a day”, and up to what it may cost a month. The board scales and restarts inside them without asking you again, and tells you after. Anything outside them waits for you, production included.

![Environments in a repository’s settings. Production has an envelope: 2 to 10 for widgets-render, up to 60 a month, 3 restarts in a day, with 0 of 3 restarts used in the last day, and Revoke and Change. Staging has none: every scale and restart waits for you.](https://leavethepack.dev/media/envelope-dark.png "An envelope on production, in Settings.")

## 5. When something breaks, it’s a task

A signal that crosses a rule opens an incident: a task, in the repository that owns what broke. A production incident pushes; the rest waits in the inbox. Its steps show on the board: diagnose, propose, approve, apply, verify, and a write-up. An agent diagnoses and proposes the fix by pull request. Approve is still yours.

![An incident on the board, a task: Incident, health, critical, in production (widgets-render), open, pushed to your phone. Its steps: diagnose, now; then propose, approve, apply, verify, and write up.](https://leavethepack.dev/media/incident-dark.png "An incident is a task, with its steps.")

## What it does, and doesn’t

- **It runs what your repositories run on**, on Cloudflare first. Not every cloud, and not anything the board’s repositories don’t use.
- **It never acts on its own word.** An envelope is bounds you approved. Outside them, the plan waits for you.
- **It only watches its own install.** The board’s own environment is observe only: Architect never changes it.
- **Your data stays.** The inventory and the signals stay in your install, redacted: names and settings, never values or code. The read-only token goes only to its provider.
- **Amounts are estimates**, in the currency you set, with the rate when converted.
- **Off until you connect a provider.** Updating to 2.0.0 changes nothing until then.
- **Free, and the source is public.** Architect is in the same licence. There is no paid tier and no hosted version.

## Read more

- [Updating to 2.0.0](https://leavethepack.dev/docs/updating-to-2/): what updating changes, what stays off, and how to go back.
- [The manual’s Architect section](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#architect): environments, plans, envelopes, signals, incidents, and cost, in full.
- [Run your own board](https://leavethepack.dev/docs/quickstart/), if you don’t have one yet.
