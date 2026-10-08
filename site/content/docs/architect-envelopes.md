---
title: Envelopes and scaling rules
nav: Envelopes and scaling
description: Bounds you approve once on one environment, so the board scales and restarts inside them without asking you again, and the scaling rules in your repository that ask it to.
---

An **envelope** is bounds you approve once on one environment, production included: “2 to 10 instances”, “up to 60 a month”, “3 restarts a day”. Inside them, the board scales and restarts without asking you again, and tells you after. Anything outside them is a plan that waits for you, with its push.

Envelopes start empty. Until you set one, every scale and restart waits for you.

## Set one

On the repository’s settings page, under **Infrastructure**, each environment shows its envelope or “No envelope: every scale and restart waits for you.” Press **Add an envelope**, or **Change** on one you have:

- **Scale bounds**: a minimum and a maximum, for one resource by name or every resource of a kind. Only what Cloudflare can scale is offered: a container’s most instances, and a queue consumer’s concurrency ([What’s supported](/docs/architect-supported/#scale-and-restart)).
- **A cost bound**, optional: the most the environment may cost a month after a scale, in your currency. A scale that would go past it waits for you.
- **A restart cap**: how many restarts in a window, 3 a day by default. Once they’re used, the next restart waits for you, with a push. 0 asks you about every restart.

**Set envelope** asks first. **Revoke** puts every scale and restart back in front of you. Each is an `envelope` entry in the audit trail.

An envelope lives on the board, one per environment, never in the repository, so a pull request can’t widen it. Setting, changing, and revoking one is yours alone. An observe-only environment has none.

## Who acts inside it

Nothing scales just because an envelope exists. Two things can ask:

- **A scaling rule**, in your repository ([below](#scaling-rules)), when a signal matches it.
- **A runbook’s run**, when its routine’s description says to, with `npx breakaway infra act <environment> <resource> scale <n>` or `restart` and the run’s own key ([Signals, incidents, and runbooks](/docs/architect-signals/#runbooks)).

Either way the board builds the plan itself and decides:

| The ask | What happens |
| --- | --- |
| Inside the bounds, the cost bound, and the restart cap | Approved by the envelope and applied with no press, through the same apply workflow. A quiet note in the inbox: “Scaled widgets-api to 6 instances, inside its envelope.” |
| Outside the bounds, past the cost bound, or the restart cap used up | A plan that waits for you, with a push |
| A frozen or observe-only environment, or a change the resource can’t make | Refused |

## Scaling rules

Scaling rules are in `.github/breakaway-infra/scaling.json` on the default branch, checked by `infra check`. Each rule listens to the environment’s signals and turns a matching one into one ask through the envelope:

```json
{
  "version": 1,
  "rules": [
    {
      "name": "render backlog",
      "environments": ["production"],
      "resourceKinds": ["container"],
      "kinds": ["health"],
      "level": "warning",
      "act": "scale",
      "step": 2
    },
    {
      "name": "render down",
      "environments": ["production"],
      "resource": "widgets-render",
      "kinds": ["health"],
      "level": "critical",
      "act": "restart"
    }
  ]
}
```

- **What it hears**: `environments` (every one when left out); one resource by name (`resource`) or every resource of some kinds (`resourceKinds`); the signal `kinds`, `health` or `alert`, never cost, so a budget never scales anything up; the lowest `level` that counts (`critical` when left out); and optionally a value `above` or `below`.
- **What it asks**, of the resource the signal is about: `"act": "scale"` with `to` (a whole number) or `step` (up or down by a whole number, from what runs now), or `"act": "restart"`.

The envelope, its restart cap, a freeze, and observe only decide, never the rule. The same rule and signal ask at most once a day, and only the signal’s fields and value are read: its text never reaches the ask. A file that doesn’t check asks for nothing, and the board shows its line and field. Each ask, or its refusal, shows on the repository’s scaling rules, and its audit entry names the rule.

## Hear about it

- A scale or restart inside the envelope is a quiet note in the inbox, never a push.
- A restart the cap turned away is a plan that waits for you, with a push, and the infrastructure event `envelope.used_up`, which can start a routine ([Signals, incidents, and runbooks](/docs/architect-signals/#infrastructure-events)).
- **Freeze** stops envelopes too, until you unfreeze ([Freeze, gates, and locks](/docs/architect-freeze/)).
