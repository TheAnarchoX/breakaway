---
title: What’s supported
description: The provider Architect runs on, every kind of resource it sees, which settings it changes, what it can make, remove, scale, and restart, what it never touches, and its limits.
---

Architect runs on **Cloudflare** in 2.0. It sees what an environment runs by starting at its **target**, a Worker, and following what that Worker reaches: the Workers it calls, and every database, namespace, bucket, queue, Durable Object, container, route, and custom domain they use. Nothing outside that scope is read or kept.

## Kinds of resource

Each resource in an environment’s file has a `kind`. These are Cloudflare’s:

| Kind | What it is | The settings Architect manages | Make | Remove |
| --- | --- | --- | --- | --- |
| `worker` | A Worker | Compatibility date and flags, usage model, Workers Logs, placement, cron triggers, and bindings | Yes: it starts with a small module that answers `/health` until your deploy puts its code on it | Yes, and it can’t be undone |
| `durable-object` | A Durable Object namespace | None: its class and the Worker that has it | By code: the Worker exports the class, and a migration in its wrangler config adds it | By a delete migration, and its data goes |
| `d1` | A D1 database | None. Its schema is your repository’s migrations | Yes | Yes, and its data goes |
| `kv` | A KV namespace | None | Yes | Yes, and its values go |
| `r2` | An R2 bucket | CORS rules and lifecycle rules | Yes | Only when it’s empty: Cloudflare refuses otherwise |
| `queue` | A queue | Delivery delay, delivery paused, retention, and most consumers at once | Yes | Yes, and its messages go |
| `container` | A container application | Most instances | By code: the image, the Durable Object class that starts it, and the container in the Worker’s wrangler config | Yes, and it can’t be undone |
| `route` | A route: a hostname and path sent to a Worker | Its pattern and its Worker | Yes | Yes, and it can be put back |
| `custom-domain` | A hostname a Worker serves | Its Worker | Yes | Yes; the hostname stops answering until it’s attached again |

A setting the file leaves out isn’t compared, so it stays the deploy’s. A Worker’s variables and secrets show by name only, and are set with its deploy, never by Architect. A Durable Object or a container can be added on the console, which says what code must exist first: its plan applies only once that code is deployed.

Changes to a `route` or a `custom-domain` decide who reaches what, so the policy’s **access** guard makes every one of them wait for you, whatever your allow rules say ([Policy](/docs/architect-policy/)).

## Scale and restart

[Envelopes](/docs/architect-envelopes/) let the board scale and restart without asking you each time. On Cloudflare, two kinds can:

| Kind | Scale | Restart |
| --- | --- | --- |
| `container`, on the default scheduling policy | Its most instances (`max_instances`) | A rollout of its current configuration: each instance is replaced in turn, with time to drain |
| `queue`, with a Worker consumer | Its consumer’s concurrency (`max_concurrency`) | No |

Cloudflare scales everything else by itself, so nothing else is offered. A container on the Durable Object scheduling policy, or a queue with no Worker consumer, is refused in words before anything is planned.

## Health

The board reads each resource’s health when it looks, every 15 minutes, and when you press **Refresh**:

- **Workers and Durable Objects**: requests and errors over the last 15 minutes. Errors make it degraded; no deployment makes it down. With no requests, the board looks back an hour, then a day, before it calls it **idle**, which isn’t down.
- **D1**: its queries and how long they take; slow is degraded.
- **KV and R2**: their operations.
- **Queues**: the backlog and the oldest message. A backlog that keeps growing, or no consumer, is degraded.
- **Containers**: the instances running against those assigned. None running when some are assigned is down.
- **Routes and custom domains**: their Worker’s health, or your own health address when the environment’s file names one ([Describe it as code](/docs/architect-desired-state/#a-health-address)).

The board reads health with the read-only token, through Cloudflare’s analytics. It reads no logs, traces, or metrics beyond these.

## What it never touches

- **Code.** The read-only token can’t read a Worker’s code, and the apply workflow checks none of your repository’s code out.
- **Values.** A variable’s or secret’s value, what’s stored in a database, a namespace, or a bucket, and a queue’s messages.
- **Your account.** DNS, account settings, members, billing, and API tokens. No token the board asks for can change them.
- **The board’s own install.** It’s always observe only.
- **Anything outside an environment’s scope**, even on the same account.

## What isn’t supported yet

- **Other providers.** Pages, other clouds, servers, and containers outside Cloudflare’s aren’t seen. The deploy flow is Workers only too.
- **Metrics, logs, and traces** as signals. Signals are health, the platform’s alerts, and cost.
- **Change windows.** Freeze is the one switch.
- **A Worker’s code, schema migrations, and secrets** through a plan. Those stay the deploy’s.

## Limits

| What | Limit |
| --- | --- |
| Environments per repository | 50, with at most 3 short-lived ones at once |
| Resources in one environment’s file | 500, in at most 256 KB |
| Edits in one change on the console | 50 |
| Plan previews on the console | 6 a minute per environment |
| `infra check` previews | 10 a minute per repository |
| Plan checks on one pull request | Up to 5 environments |
| How often the board looks at what runs | Every 15 minutes, and on **Refresh** |
| How often it compares for drift | At most once an hour per environment, and as soon as its file changes |
| One apply’s lock on an environment | 15 minutes, renewed while it works |
| Signals | Kept 7 days; their daily summaries 90 |
| The audit trail | Kept two years |
