# Cost and budgets

> What each resource is estimated to cost a month, added up by environment, repository, and task, in the currency you pick, with a budget per environment and a cost limit per plan.

Every resource on the map shows an **estimated monthly cost**, and the board adds them up by environment, by repository, and by the task that owns a short-lived environment. Infrastructure shows each environment’s month and its trend; an environment’s page shows each resource’s.

## How it estimates

- **From the last week of use, scaled to a month**, at Cloudflare’s prices: requests and CPU time for Workers, requests, duration, and storage for Durable Objects, rows and storage for D1, operations and storage for KV and R2, operations for queues, and instance time for containers.
- **Before what your plan includes.** Every amount is marked as an estimate. Cloudflare’s plan includes some use, so your bill can be lower.
- **Unknown is never zero.** A resource with no estimate counts as unknown. A total with unknowns can say an environment is near or over its budget, but never that it’s inside it.

## In your currency

Estimates are kept in the provider’s currency, US dollars on Cloudflare, and shown in the one you set for the whole board, in **Settings**, under **Currency**, at a rate you set and change when you like: “At 1 USD = 0.92 EUR, set 3 Oct.”

**Fetch today’s rate** fills the field from Frankfurter’s public rates, only when you press it, and sends only the currency pair. You still save it. Until you set a currency, amounts are in US dollars.

A plan keeps the rate it was checked at, since the policy compared its cost then. A cost no rate covers is unknown, so the cost and budget guards ask you.

## Budgets and the cost limit

Both are in the [policy](https://leavethepack.dev/docs/architect-policy/), in your currency:

| | What it is | Default | What happens |
| --- | --- | --- | --- |
| **Cost limit** (`costLimit`) | The most one plan may add to an environment’s monthly cost | 5 a month | A plan over it, or whose cost isn’t known, waits for you |
| **Budget** (`budget`) | What one environment may cost a month | 20 a month | A plan that takes the environment over it waits for you; near it and over it, a signal |

Set one per environment under `environments`, like `"production": { "budget": 200 }`.

The first time a month goes near (80%) or over an environment’s budget, the board records one cost signal: a warning when near, critical when over, which opens an incident that says it’s a budget. Coming back inside sends nothing, and a new month starts again. A routine can start on `budget.crossed` at any percent you pick ([Signals, incidents, and runbooks](https://leavethepack.dev/docs/architect-signals/#infrastructure-events)).

An [envelope](https://leavethepack.dev/docs/architect-envelopes/) can have a cost bound too: a scale that would take the environment past it waits for you.

## From the terminal

```sh
npx breakaway infra show production    # each resource with its estimated cost
npx breakaway infra plan plan-2        # what one plan adds or saves
```
