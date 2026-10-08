---
title: Policy
description: The rules that decide which plans wait for you, per repository and per environment. The default, the guards no file can turn off, the limits, allow rules, and changing it on the board, where loosening is never one press.
---

The **policy** decides which plans wait for you. It’s a file beside the environments’ files, `.github/breakaway-infra/policy.json` on the default branch, changed by pull request like the rest, and checked each time a plan is made. A repository’s settings page shows the policy in force, in words, under **Infrastructure**.

## The default: every plan waits for you

A repository with no `policy.json` gets the default, and so does one whose file doesn’t check, until it’s fixed: **every plan, in every environment, waits for you**. You loosen it on purpose, a rule at a time, or you set an [envelope](/docs/architect-envelopes/) for scaling and restarts. There is no other way a plan goes through without you.

## The guards

The guards come first, in this order, and no file can turn one off:

| Guard | Catches | Then |
| --- | --- | --- |
| **Frozen** | Any plan in a frozen environment | Refused, until you unfreeze it |
| **Production** | Any plan in an environment with production gates | Waits for you |
| **Destructive** | A delete, or a change that can’t be undone | Waits for you |
| **Access** | A change to what decides who or what can reach something: a route or a custom domain, plus the kinds and settings `access` names | Waits for you |
| **Cost** | A change that adds more than the cost limit to the environment’s monthly cost, or whose cost isn’t known | Waits for you |
| **Budget** | A plan that takes the environment over its budget | Waits for you |

A plan no guard caught still waits for you, unless an `allow` rule covers every one of its changes.

## The file

```json
{
  "version": 1,
  "costLimit": 5,
  "budget": 20,
  "access": { "kinds": ["route"], "settings": ["public"] },
  "allow": [
    { "name": "small staging changes", "environments": ["staging"], "changes": ["update", "scale"], "maxChanges": 3 },
    { "name": "task environments", "environmentKinds": ["short-lived"] }
  ],
  "environments": {
    "production": { "budget": 200, "allow": [] }
  }
}
```

Every key but `version` is optional.

- **`costLimit`**: the most one plan may add to an environment’s monthly cost before it waits for you. 5 a month by default, in your board’s currency ([Cost and budgets](/docs/architect-cost/)).
- **`budget`**: what one environment may cost a month. 20 by default. Near it and over it, the board records a signal.
- **`access`**: more kinds and settings that decide who can reach something. They add to Cloudflare’s own, never take one away.
- **`allow`**: the rules that let some plans through ([below](#letting-some-through)).
- **`environments`**: one environment’s own rules, by name ([below](#two-levels)).

## Letting some through

An `allow` rule lets a plan through, recorded with the rule’s name, when it covers every one of the plan’s changes and no guard caught the plan:

- **`name`**: what the plan and the audit trail call it.
- **`environments`** (names) or **`environmentKinds`** (`production`, `staging`, `short-lived`): where it applies. Inside one environment’s own rules, leave them out.
- **`changes`**: the kinds of change it covers: `create`, `update`, `delete`, `scale`, `restart`. A delete still waits, since the destructive guard comes first.
- **`maxChanges`**: optional, the most changes one plan may have.

## Two levels

The top of the file is the repository’s rules. `environments` overrides them for one environment, by name:

- Its `costLimit` and `budget` replace the repository’s.
- Its `access` adds kinds and settings; it can’t take one away.
- Its own `allow`, when it has one, replaces the repository’s rules there. `"production": { "allow": [] }` makes every plan in production wait for you, whatever the repository allows.

## Change it on the board

**Policy**, on Infrastructure and on each environment’s console, opens the Policy view: each environment’s rules in words, where each comes from (always, the repository’s, or the environment’s own), its envelope, and the recent plans with the rules that applied.

1. **Change the policy** edits the repository’s rules or one environment’s. As you edit, the board says what the change does, a line each, marked **Loosens** or **Tightens**.
2. **Propose the change** writes `policy.json` on the board’s own branch and opens the pull request. Its plan check says the same lines.
3. **Approve.** Tightening is one press: Approve merges it.

**Loosening is never one press.** A change that lets more through without you (a limit raised, a rule added or widened, an access kind or setting dropped, or an environment’s own rules that let through more than the repository’s) is marked **Loosens your policy**. Approve names exactly what will no longer wait for you, and only **Loosen it**, a second press, merges it.

**Never with a plan it would let through.** While a plan waits for you that the new policy would let through, Approve refuses and names the plan: answer that plan on its own first, so a policy change never approves a plan behind your back.

**It applies nothing.** Merging a policy change approves and changes no plan. A plan made before keeps its answer; the plans made after are checked against the new policy. **Reject** closes the pull request, and the policy stays as it was.

An agent can change `policy.json` in a pull request too: its plan check shows what it loosens, and merging it is yours.

## Recipes

| You want | Write |
| --- | --- |
| Small setting changes on staging to go through | `{ "name": "staging settings", "environments": ["staging"], "changes": ["update"], "maxChanges": 3 }` |
| Task environments to be made without asking | `{ "name": "task environments", "environmentKinds": ["short-lived"], "changes": ["create"] }` |
| Production to always ask, whatever the repository allows | `"environments": { "production": { "allow": [] } }` |
| A tighter cost limit on production | `"environments": { "production": { "costLimit": 1 } }` |
| Scaling to go through within bounds | Not a rule: an [envelope](/docs/architect-envelopes/), set on the board, so a pull request can’t widen it |
