---
title: Signals, incidents, and runbooks
nav: Signals and incidents
description: What the board hears about an environment, how a signal becomes an incident on the board, how an agent works one, and runbooks and infrastructure events that start routines by themselves.
---

When something breaks, it’s a task. A **signal** is one thing the board heard about an environment; one that crosses a rule opens an **incident**, a task in the repository that owns what broke. An agent diagnoses it and proposes the fix by pull request, and approving the fix is still yours.

## Signals

| Source | What it hears | When |
| --- | --- | --- |
| **Health** | A resource degraded, down, or healthy again | Each time the board looks, every 15 minutes |
| **The platform’s alerts** | Cloudflare’s notifications, like a Worker’s error rate | When Cloudflare sends one to the board |
| **Cost** | An environment’s month near (80%) or over its budget | The first time it crosses, each month |
| **The deploy flow** | A deploy’s failed health check, or a rollback | When the workflow reports it |
| **The apply workflow** | An apply that failed, rolled back, or couldn’t be verified | At the end of a run |

Each signal has an environment, a resource, a level (**info**, **warning**, or **critical**), a value, a time, and a short text, redacted before it’s stored. They’re kept 7 days, and their daily summaries 90. A signal sends no push by itself.

Read them on an environment’s live stream, or from the terminal:

```sh
npx breakaway infra signals --environment production --level warning
npx breakaway infra signals --days 7     # the daily summaries
```

### Cloudflare’s alerts

Cloudflare sends its alerts to a routine’s webhook trigger, which also feeds the signal stream:

1. Make a routine for them, and **Add a trigger** on it; the board shows its secret once.
2. In Cloudflare, under **Notifications**, add a webhook destination: the URL `https://<your board>/api/routines/<routine>/fire` and the secret.
3. Add the notifications you want to that destination.

The Cloudflare row on **Connections** lists which alert types the account has, and whether they reach the board. Only the alert’s name, its time, and the Worker it names are kept ([Routines](/docs/routines/#ways-to-start-one)).

## Incidents

A **critical** signal opens an incident: an ordinary task tagged `+incident`, in the repository that owns the environment, with the signal and what the board knows about the resource in its description. Its title is the signal’s kind, level, environment, and resource; the signal’s own words go only in its description and comments, quoted and marked as untrusted, since they come from the system being watched.

- **A production incident pushes**, “WGT-41: incident in production”, and so does one in any environment with production gates. Any other waits quietly in the inbox. Incidents lead the inbox, production’s first.
- **A repeat** of the same signal (the same environment, resource, and kind) comments on the open incident, counted rather than commented within 15 minutes, so a noisy signal can’t flood it.
- **Going over a budget** is critical, so it opens one that says it’s a budget. Going near it is a warning, and opens none.

### Its steps

Each incident shows its steps on the task, from the plan linked to it and the signals since:

| Step | Whose | What |
| --- | --- | --- |
| **Diagnose** | An agent | Reads, read only, and comments what broke, since when, what it touches, and the likely cause |
| **Propose** | An agent | A pull request with the fix, ending `Part of <the incident>.` |
| **Approve** | You | The plan from that pull request, after you merge it |
| **Apply** | The board | Through the apply workflow, with the health check |
| **Verify** | The board | The signals show health back |
| **Write-up** | An agent | What happened, the cause, the fix, follow-up tasks, then a ping so you close it |

**An incident never starts an agent by itself.** Start one on it from the board, the way you start any agent, or turn on a runbook for its signal. Either way the agent follows “Working an incident” in its prompt’s core: read wide, comment, propose by pull request, and never apply.

```sh
npx breakaway infra incidents             # open incidents, with the step each is on
npx breakaway infra incidents --json      # with their linked plans
```

## Runbooks

A **runbook** is a routine with a signal trigger: the only way an agent starts by itself on an incident. On the routine, in the Routines view, its **Signal trigger** says:

- which signals start it: environments, resource kinds, signal kinds, and the lowest level;
- whether it’s on;
- whether a match starts the agent, or makes a run that waits for your **Start**.

Only you set one, from the signed-in board, and a new one is off and waits. A run gets the signal’s allowlisted fields (its ID, source, environment, resource and its kind, signal kind, level, value, time, and redacted text) and nothing else. A repeat within a day starts nothing, and the routine’s caps apply.

The run works the signal’s incident read only, and comments on it. When its routine’s description says to, it may ask for one scale or restart, inside your envelope:

```sh
BREAKAWAY_ACT_KEY=<the run's key> npx breakaway infra act production widgets-render restart
```

Each start of a runbook’s run gets its own **act key**, handed only to that run, good only while it holds the run, for 12 hours at most. Inside the envelope the board applies it with no press; outside it, a plan waits for you ([Envelopes and scaling rules](/docs/architect-envelopes/)). No other agent can ask.

### A runbook’s prompt

Keep it to what a first look needs. For example:

```text
Production's render container is unhealthy. Work its open incident read only:
read infra incidents, infra show production, and infra signals for the
resource, and comment what you find on the incident. If the container is
down and was healthy within the last hour, restart it once with infra act.
If that doesn't bring it back, or anything else is wrong, propose the fix by
pull request ending "Part of <the incident>." Never apply anything else.
```

## Infrastructure events

A routine can also start on what Architect does, in its own repository’s environments. None is on until you add it, in the routine’s form or from the terminal:

```sh
npx breakaway routines modify weekly-cleanup --infra-events plan.failed,drift.found:environment=staging,budget.crossed:percent=80
```

| Event | When |
| --- | --- |
| `plan.waiting`, `plan.applied`, `plan.failed`, `plan.rolled_back` | A plan reached that status |
| `drift.found` | The board found drift |
| `change.proposed`, `change.merged` | A change from the console was proposed, or merged |
| `deploy.done`, `promote.done` | A Deploy or a Promote landed |
| `environment.created`, `environment.removed` | An environment came or went, short-lived ones too |
| `inventory.stale` | The board couldn’t look at what runs |
| `budget.crossed` | A month’s cost went past `percent=` of its budget (100 unless you say) |
| `envelope.used_up` | A restart the envelope’s cap turned away |
| `incident.opened` | An incident opened |

Each takes filters joined by `:`: `environment=`, `kind=` (`production`, `staging`, `short-lived`), and `resource=` (resource kinds), several values joined by `+`. The run gets the event’s names, IDs, states, and counts, never a setting’s value or a token, and is read only. Each thing that happens starts a routine once a day at most, and an event the routine’s own run caused never starts it again.
