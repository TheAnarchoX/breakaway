# IDEA-19 · Architect: breakaway runs the infrastructure too

Task: IDEA-19 on the board, in the `architect` feature · Status: approved (shaped 5 Oct 2026, merged by the owner; the owner answered BRK-169, BRK-171, and BRK-172 on 6 Oct 2026, folded in by DOC-38). Not built yet: the tasks that build it are open, and one small decision (BRK-225, cost in the owner's currency) waits for the owner.

## Problem

breakaway runs the work on code: agents claim tasks, open pull requests, and the owner merges. The infrastructure that code runs on is still run by hand: deciding what should exist, making it, watching it, scaling it, cleaning it up, and answering when it breaks. The owner wants the board to do that too, so one person can run real infrastructure the way they already run code, from the board and their phone.

The idea is an architecture with no vendors picked. This spec turns it into a first version that can be built as many small pull requests, run by a chase, with the owner's opinions asked as decisions up front instead of deferred.

Some of it already exists, and it comes first: the deploy flow (Deploy, Promote, Roll back, `DEPLOYS_PAUSED`, health checks with automatic rollback), Connections, routines started by Cloudflare alerts, and self-update's verified deploy-and-roll-back. Architect generalises those rather than replacing them.

## Fit

- **The person who runs the board decides.** Agents read and propose; they never hold write credentials and never apply. The board's executor applies only a plan the owner approved, or one inside bounds the owner approved once (an envelope, which BRK-171 allows for scaling and capped restarts). Approve is cookie-only, like Merge, so no agent token can press it. "Nothing in breakaway merges or deploys on an agent's word" still holds; DOC-29 writes the envelope case into `AGENTS.md` and the decision log.
- **An install keeps its data.** Providers are connections the owner makes, like GitHub and push. Signals and the inventory are the owner's own systems' data, kept in the install's Durable Object, redacted, and never sent anywhere else. No telemetry.
- **Free and self-hosted.** Everything runs in the install, on the owner's own accounts. No hosted control plane.
- **One claim per task, and pull requests close tasks.** Infrastructure changes are pull requests too; incidents are tasks.
- **Taskwarrior stays first-class.** Nothing here changes the task model or sync: environments, plans, and signals are their own tables beside tasks, like features and routines. An incident is an ordinary task with a tag.
- **What agents never do** (`AGENTS.md`) is unchanged for agents, and the board's own install is observe only (BRK-169).
- **Not like IDEA-16.** That idea was deferred whole to 3.0. Architect doesn't wait for it: it uses GitHub pull requests and checks as they are, and the Artifacts work can plug in later as another change source.

## Design

Seven layers, as the idea draws them. Layers 1, 2, and 7 exist; this builds 3 to 5 and teaches 6.

| Layer | What it is here | Built by |
| --- | --- | --- |
| 1. Intent | Tasks, ideas, decisions, incidents | exists; incidents BRK-197 |
| 2. Change | Desired state and policy as files, changed by pull request, with the plan as a check | BRK-180, BRK-185, CLI-14 |
| 3. Control plane | Environments, plans, policy, approvals, the executor, locks, the audit trail | BRK-174, BRK-178, BRK-181, BRK-182, BRK-183, BRK-179, BRK-175 |
| 4. Providers | One adapter per platform behind one interface | BRK-173, then BRK-188 to BRK-193 |
| 5. Signals | One normalised, redacted stream | BRK-190, BRK-191, BRK-198 |
| 6. Agents | Read wide, propose by pull request, never apply | CLI-13, BRK-202, BRK-203 |
| 7. The owner | Views, approvals from the phone, freeze, break-glass | WEB-60 to WEB-65, BRK-187 |

Every piece is its own `store-*.js` module and test file, so agents running in parallel in a chase rarely touch the same file; routes in the Worker are small additions.

### Words

The brand guide gets the words before any view is built (ID-5): **environment**, **plan**, **approve** and **reject**, **envelope**, **signal**, **incident**, **break-glass**, **freeze**. Apply is never a button: the owner approves, the board applies.

### Providers

`src/infra-provider.js` defines a provider: `discover` (what exists, with relations), `plan` (desired against actual, as a diff with reversibility), `apply` (one plan, only inside the runner), `observe` (health), `cost`, and `events` (signals). A registry holds the connected ones. A fake in-memory provider backs every test, and a shared contract test runs against every real provider (BRK-173). The core never names a vendor.

Adapters call the platform's API directly; no infrastructure-as-code tool, state file, or second source of truth (BRK-169). A provider may declare **scale** and **restart** as change kinds per resource kind, for envelopes.

The first provider is Cloudflare (BRK-169), where the board and the deploy flow already run. BRK-188 wrote down its API surface and the narrowest tokens in [First provider: Cloudflare](#first-provider-cloudflare); BRK-189 discovers, BRK-191 observes, BRK-192 plans and applies for Workers and their bindings, BRK-193 prices, and BRK-227 scales and restarts inside an envelope, for the kinds that can.

### Environments

A named target in one of the board's repositories: kind (`production`, `staging`, `short-lived`), its provider, an owning task for a short-lived one, a **freeze** switch (the pause switch, generalised; owner-only; no change windows, BRK-171), whether production gates apply, and **observe only**. The environment that runs the board's own install is always observe only (BRK-169) (BRK-174). A fresh install has none, and the Infrastructure view says what to connect first.

### Inventory

What actually exists, from each provider's `discover`, scoped to what the board's repositories run on (BRK-169: nothing outside an environment's scope is stored): a graph of resources with relations (this Worker uses that database, secret by name, and route), ownership (repository, task, environment), last health, and last cost. An environment's scope is its target (the resource whose ID or name is the environment's `target`) and everything the target reaches by relations; the store applies it to whatever a provider returns, so an environment without a target stores nothing. A refresh replaces one provider's slice atomically, and a failed discovery changes nothing (BRK-177).

### Desired state

What should exist, as code, read from the repository's default branch once per new commit, the way `.github/breakaway-pipeline.json` is read (BRK-180). One file per environment, `.github/breakaway-infra/<environment>.json` (BRK-169). A file for an environment that doesn't exist shows as one to add; one for an observe-only environment is refused. An invalid file shows its error and keeps the last valid copy. `npx breakaway infra check` validates it locally and asks for the plan it would make (CLI-14).

Nobody has to write the first file by hand (BRK-240): `GET /api/infra/environments/<id>/draft` writes it from the environment's slice of the inventory, valid as written, with only the settings the provider manages (never what the platform reports by itself, like versions and sizes) and never a secret's value, and notes saying what it left out. Agents read it with the token as well as the owner; `infra adopt` (CLI-23) writes it into a checkout. An environment with no inventory yet gets a 409 saying to connect the provider and refresh. On the environment page, an environment with no file shows the draft, read only with Copy, under **Describe it as code** (WEB-92), with one press, **Have an agent open the pull request**: the owner's only, it adds `Describe <environment> as code` (+agent +general, never autostart) in the environment's repository and starts its agent there, which runs `infra adopt`, then `infra check`, and opens the pull request. One is open at a time per environment; the page shows it and its pull request instead of the button. Without the repository's agent routine connected it adds nothing and points to Connections. The board opens no pull request itself, and nothing is applied.

### Plans

The exact difference an apply would make: the provider's diff, the cost change, the blast radius (from the inventory's relations), whether it can be undone or why not, the policy results, and a state (`draft`, `waiting`, `approved`, `rejected`, `applying`, `applied`, `failed`, `rolled back`). Its source is a pull request, drift, an envelope, an incident, or the deploy flow (BRK-178).

### Change

One flow for app and infrastructure: a pull request that changes a desired-state or policy file gets the plan and policy results as a check, and the board's pull request page shows them (BRK-185). Merging applies nothing: the plan made from `main` waits for approval. The comparison after the merge makes it (source `pull-request`, naming the merged pull request when the sync knows it) and puts it in front of the owner with one push, unless the repository's policy lets it through (BRK-246).

### Policy

Rules as code beside the desired state, checked at plan time: what needs the owner, budgets, and a frozen environment refusing everything. A repository with no policy file gets the default, which BRK-171 set to **every plan, in every environment**; it still names each rule that applies (production, destructive or irreversible, access and exposure, a cost change over the limit) so the plan says why. The cost limit starts at 5 a month and the budget at 20 a month per environment (BRK-172), both changeable in the policy file. Each rule's result is on the plan in words (BRK-181). A repository's own policy can let some plans through; envelopes are the only standing exception to the default.

The file is `.github/breakaway-infra/policy.json` on the default branch, read with the desired state (BRK-181):

```json
{
  "version": 1,
  "costLimit": 5,
  "budget": 20,
  "environments": { "production": { "budget": 200 } },
  "access": { "kinds": ["route"], "settings": ["public"] },
  "allow": [
    { "name": "small staging changes", "environments": ["staging"], "changes": ["update", "scale"], "maxChanges": 3 },
    { "name": "task environments", "environmentKinds": ["short-lived"] }
  ]
}
```

Every key but `version` is optional. The guards are checked first, in order: **frozen** refuses the plan; **production** (an environment with production gates), **destructive** (a delete, or a change that can't be undone), **access** (a resource kind or setting the provider marks as deciding who or what can reach something, plus the ones `access` names), **cost** (a change over the cost limit, or one whose cost isn't known), and **budget** (a plan that takes the environment over its budget) each make it wait for the owner. A file sets the limits and adds access kinds and settings, but can't turn a guard off. A plan no guard caught waits too, unless an `allow` rule covers every one of its changes; then it's let through with the rule's name. A file that doesn't check fails closed: the default decides until it's fixed, and the plan says so. The result is on the plan as `policy`: which policy decided, the outcome (`refused`, `needs-owner`, or `allowed`), the rule that decided, and each rule's reason in words.

### Approvals

Approve and Reject are owner-only and cookie-only (BRK-182). A plan that waits sends one push linking to the plan page, so the owner approves from the phone (WEB-62). A plan a repository's policy lets through is approved with the rule that allowed it recorded; the default lets nothing through.

### Executor

The only path that changes infrastructure (BRK-183): take the environment's lock (BRK-179), start the apply runner for exactly one approved plan, record each step, verify health through the provider, roll back by itself if verification fails (BRK-171), release the lock, and write the outcome. One environment at a time; production last and only on approval.

The runner is **a workflow in the repository, started by the board on approval, with a write token per environment in a GitHub environment** (BRK-171), which is the trust Promote has today, so the board itself still holds no write credentials. CLI-12 renders it with `npx breakaway infra init`, like `pipeline init`. An observe-only environment is refused. Each GitHub environment that holds a write token has a deployment branch rule of the default branch only, as CLD-27's do: the workflow's own `if:` is read from whichever branch runs it, so the rule is what keeps the token from a run of an edited copy on another branch (BRK-229).

Each run records the GitHub environment it applies in (BRK-242): the environment's own name, or `short-lived` for every short-lived environment, since each of those is named for its task and no GitHub environment could hold a token for a name that's new each time. The board starts the workflow with it (`github_environment`, sent only when it isn't the environment's own name, so a workflow rendered earlier still starts for staging and production) and checks the run's OIDC `environment` claim against what it recorded, never against the inputs, which anyone who can run workflows can set: a short-lived plan's run in staging's or production's GitHub environment gets nothing, and so does a staging plan's run in `short-lived`. The provider's scope still keeps each apply inside its own environment's resources. A repository with `short-lived.json` renders the workflow with the environment as any name rather than a list; after that file is added, or after upgrading past BRK-242, the owner runs `npx breakaway infra init --update` and merges it.

The runner and the board share no secret (CLI-12, `src/infra-runner.js`). The workflow, `.github/workflows/breakaway-infra.yml`, takes the plan's ID and the environment, runs only from the default branch, checks out none of the repository's code, and asks the board for the plan at `/api/infra/runs/<plan>` with the run's GitHub OIDC token. The board answers only the run it started, for a plan approved for that environment, and only once; the runner stops otherwise, before it reads the write token. Each step it reports carries the digest of the plan it applies, so a plan changed since approval is refused.

Approving a plan queues it (BRK-183, `src/store-infra-runs.js`), and the board starts it a moment later: it checks the plan again (still approved, its digest still its diff's, not out of date) and the environment (not frozen, not observe only), checks the repository has the runner's workflow, takes the environment's lock, and starts the workflow on the default branch through the GitHub App. A plan that can't start yet stays approved and its run says why (`GET /api/infra/runs/<plan>`): another plan holds the lock, the repository has no runner, or GitHub refused. The owner can still reject an approved plan that hasn't started applying. After the run reports **applied**, the board reads the health of what changed through the provider; when a resource is down or degraded, or health can't be read, or the apply failed partway, it starts the same workflow a second time for the reverse of what was applied, under the same lock, and the plan ends **Rolled back**. A change that can't be undone is never rolled back by itself: the plan ends **Failed** and says why. When the provider can't tell any touched resource's health yet (a Worker with no requests), the plan is **Applied** and the run `unverified`, with a warning signal. A run that stops reporting is marked failed once the lock expires. Every end but a clean apply is a signal from `executor`, critical for a failure in production, so the incident rule (BRK-197) opens an incident and pushes; the executor sends no push of its own.

### Envelopes

Bounds the owner approves once on one environment, in any environment, production included (BRK-171): scaling bounds ("2 to 10 instances", "up to this much a month") and a **restart cap** (how many restarts in a window; 3 a day by default, set by the owner). A scaling rule in the repository, or a runbook, acts inside them through the executor with no press, writes an audit entry, and notes it quietly in the inbox. Once the restart cap is used up, the next restart becomes a plan that waits, with a push. Anything else, or outside the bounds, is a plan that waits (BRK-186, BRK-227).

An envelope is kept on the board, one per environment, never in the repository, so a pull request can't widen it (`src/store-infra-envelopes.js`). Setting, changing, and revoking it is the owner's, from the signed-in board (`PUT` and `DELETE /api/infra/envelopes/<environment>`), each an `envelope` entry in the audit trail; it holds scale bounds (a minimum and maximum of the setting a kind's scale changes, the provider's `scales`, for one resource by name or every resource of a kind), an optional cost bound (the most the environment may cost a month after a scale, in the board's currency), and the restart cap (`{ cap, hours }`, 3 in 24 by default; 0 asks for every restart). An observe-only environment has none. An act (`POST /api/infra/envelopes/<environment>/act`, `{ resource, change: scale | restart, value, task }`) is a runbook's agent's, for the run it holds, or the board's: the board discovers the resource and builds the plan itself (source `envelope`), never from the body, and refuses a change the resource's kind can't make and a frozen environment. Inside the bounds the plan is approved by the envelope and queued for the executor, with an `envelope` audit entry and a quiet note on the run's task in the inbox; outside, or once the cap is used up, it waits for the owner with its push. Scaling rules (BRK-241) are in `.github/breakaway-infra/scaling.json` on the default branch, read in the same sync as the policy (no new GitHub permission) and checked by `infra check`: `{ "version": 1, "rules": [ { "name", "environments", "resource" or "resourceKinds", "kinds", "level", "above", "below", "act": "scale" with "to" or "step", or "restart" } ] }`. An invalid file fails closed: it acts on nothing, and `GET /api/infra/scaling` shows its line and field. A rule hears the signals stream (health and alert, never cost, so a budget alert never scales anything up) and turns a matching signal about a resource into one act through the envelope, by the board, so the envelope's bounds, its restart cap, a freeze, and observe-only decide, never the rule: inside them it applies with no press, outside them it's a plan that waits. A step scales from what the inventory says the resource runs. The same rule and signal (environment, resource, kind, level) acts once a day, and only those fields and the value are read: the signal's text never reaches the act. Each act or refusal is kept on the repository's scaling rules, and the act's audit entry names the rule.

### Drift

On the cron, desired against actual for each environment with a desired state. Drift shows on the environment and becomes one plan; the board never forces it (BRK-184). Where it comes from decides what the plan does (BRK-246): drift from a change by hand is a draft, and drift from a merged change waits for the owner.

The cron compares each environment with a provider and a desired state at most once an hour, or as soon as its desired state moves to a new commit, five environments a tick. What differs shows on the environment (`driftCount`, and `drift` with each resource and what the plan would do to it) and in `GET /api/infra/drift`. One drift makes one plan, by the board. When the environment's desired state is the one its drift was last settled against, what differs was changed by hand: the plan is a draft (source `drift`) the owner puts in front of themselves, rejects, or turns into a task, with no push. When the desired state moved since (a merged change; on an environment's first comparison, when its file was added after the board started reading the repository), the plan is the merge's (source `pull-request`, `#<number>` when the sync knows the merged pull request) and waits for the owner with one push, the same push as any waiting plan; a policy that lets it through approves it as usual. A comparison that finds an open plan with the same changes (from drift, a pull request, or anything else) makes none, and while an earlier plan from a comparison is open it makes no other and says that one no longer matches, so the owner rejects it and the next comparison makes a new one (from the merge, if one is still unplanned). A provider that fails keeps what differed last time, with why. A frozen environment's drift is shown but planned only once it's unfrozen. The owner can compare one now from the board. Observe-only environments are never compared: they take no desired state.

### Break-glass

The owner may change something by hand. Marking the drift as break-glass records it and makes a follow-up task to put it into code by pull request (BRK-171); the board never proposes undoing it (BRK-187).

**Mark as break-glass** on an environment's drift, with a note, is the owner's, from the signed-in board (`POST /api/infra/break-glass/<environment>`). The board compares the environment again, so the mark is for what differs now, then appends one `break-glass` entry to the audit trail and makes one task in the environment's repository, tagged `+break-glass`, whose brief names `.github/breakaway-infra/<environment>.json` and, change by change, what to write into it so the file says what runs. It rejects the open drift plans, which would put the change back, and makes no drift plan while what differs still holds a marked change; it refuses while an approved drift plan is about to apply. Marking the same changes again returns the first mark. A mark is settled once none of its changes differ any more (the file caught up, or the change is gone), and drift is planned as usual after that. The drift shows the standing mark (`breakGlass`), and `GET /api/infra/break-glass` lists the marks.

### Audit trail

Every plan, approval, apply, envelope action, lock release, and break-glass, appended once and never edited, redacted, kept at least a year (BRK-175). The environment page shows it.

### Signals

Health, the platform's alerts, and cost (BRK-172: no metrics, logs, or traces in the first version), normalised into one shape (source, environment, resource, kind, level, value, time, short text), redacted before it's stored, kept 7 days, with daily summaries kept 90 (BRK-190). The deploy flow's failed health checks and rollbacks become signals too (BRK-198), and the existing Cloudflare alert webhook feeds the stream as well as its routines (BRK-191).

### Runbooks

A runbook is a routine with a signal trigger: by environment, resource kind, and level, allowlisted fields only, deduplicated, under the routine's caps (BRK-196).

### Incidents

A signal that crosses a rule opens an incident: a task in the repository that owns the resource, tagged `+incident` (BRK-172), with a push for a production incident and a quiet inbox entry for any other, and steps on the task: **diagnose** (read only), **propose** (a plan, by pull request), **approve**, **apply**, **verify**, then a write-up and follow-up tasks. A repeat signal comments on the open incident (BRK-197, WEB-63). An incident never starts an agent by itself: a diagnosis agent starts only from a runbook the owner turned on, one by one (BRK-172, BRK-196). The incident's title is the signal's kind, level, environment, and resource; the signal's own words go only in its brief and its comments, quoted and labelled untrusted, since they come from the system being watched (BRK-229).

### Cost

Each resource's estimate from the provider, summed by environment, repository, and owning task, with budgets in the policy and a signal near or over one (BRK-199, WEB-65). Every amount is marked as an estimate.

The owner works in euros, or any currency (BRK-171, BRK-172), while platforms price in US dollars. BRK-225 settled it: any currency, once for the whole board in Settings, at a rate the owner sets and changes when they like; the board fetches no rate.

**As built (BRK-226).** `src/infra-currency.js` holds the conversion, in one place: `checkCurrency` (an ISO 4217 code, and a rate above 0 for anything but US dollars), `convert`, `costInCurrency` for a resource's cost, `costChangeInCurrency` for a plan's, and `rateWords` ("at 1 USD = 0.92 EUR, set 3 Oct"). The setting is `GET /api/infra/currency` for anyone signed in and `PUT /api/infra/currency` (`{ currency, rate }`) from the signed-in board only, with an agent's `by` refused; it's kept in the store's `meta` with when it was set. Estimates stay stored in the provider's currency: the inventory converts on read, so switching back to US dollars rewrites nothing. A plan converts its cost change when it's made and keeps it with its `rate`, because the policy checked it then: the cost limit and budgets are in the board's currency, the cost rule's reason names the rate, and `policy.limits` carries the currency and rate. A cost in a currency no rate covers is unknown, so the cost and budget guards ask the owner rather than compare across currencies. Settings has a Currency section; `npx breakaway infra show` and `infra plan` print the rate once beside the amounts.

**As built (BRK-199).** `src/infra-costs.js` adds up the inventory's estimates (`sumCosts`) by environment, by repository, and by the task that owns a short-lived environment, in the board's currency. A resource with no estimate, or in a currency no rate covers, is counted as `unknown`, never mixed in: a total with unknowns is a floor, so it can say an environment is near or over its budget but never that it's inside it. Each environment's budget is its repository's policy's (`limitsFor`, 20 a month by default). After each inventory refresh, `recordInfraCosts` keeps the month in `infra_costs` (24 months, estimates by currency, converted on read) and, the first time a month goes near (80%) or over its budget, records one `cost` signal on the environment: a warning when near, critical when over, which opens an incident (BRK-197) whose text says it's a budget. Coming back inside sends nothing; a new month starts again. `GET /api/infra/costs[?repo=&environment=]` returns `environments` (each with `cost`, `budget` with `used` and `state`, and `months`), `repositories`, and `tasks`, every total marked as an estimate.

### Short-lived environments

A task can ask for its own environment, made from the repository's template through a plan and removed through a plan when the task closes (BRK-200).

**As built (BRK-200).** The template is `.github/breakaway-infra/short-lived.json` on the default branch, a reserved name read with the desired state: a desired-state file with a `provider` and a `target`, where `{environment}` in the target and in each resource's id and name becomes the environment's name (every id must have it, so no two tasks share a resource). An invalid template keeps the last valid one, with its error, like a desired-state file.

```json
{
  "version": 1,
  "provider": "cloudflare",
  "target": "app-{environment}",
  "resources": [{ "id": "app-{environment}", "kind": "worker", "name": "app-{environment}" }]
}
```

A task asks with the `+environment` tag (an agent tags its own task), or the owner presses for one (`POST /api/infra/short-lived/<task>`, from the signed-in board only). Asking only asks: the board adds an environment named after the task's work ID (`ops-12`), kind short-lived, owned by the task, appends an `environment` entry to the audit trail, and makes the plan that makes it (source `short-lived`, by the board). Under the default policy it waits for the owner, with a push; a repository's policy can let it through with an allow rule for `"environmentKinds": ["short-lived"]`. A repository has at most 3 short-lived environments at once, inside its cap of 50; a request over it, or with no template or no connected provider, is refused with why and looked at again in an hour.

The board notices from the alarm and the cron, so a task closed anywhere (the board, the CLI, a merged pull request, Taskwarrior) counts. When the task closes, the board makes the plan that removes everything in the environment's scope; it's all deletes, so the destructive guard always asks the owner, whatever the policy says. Once it's applied, the environment goes, with an `environment` entry. A task that closes while the plan that makes its environment still waits for the owner has that plan rejected by the board (nothing was made), and an environment with nothing in it goes at once. An environment whose task stays open is offered for removal after a grace period of 14 days; when the owner rejects a removal (or it fails), it stays for another 14 days before the board asks again. `GET /api/infra/short-lived` lists the requests, with each repository's template.

### Clean up

Anything nobody owns is flagged, and after a grace period a removal plan waits for the owner: removal is destructive, so it always asks (BRK-201).

What nobody owns is what runs in an environment's scope (its inventory slice) that its desired state doesn't declare, so its provider's plan would delete it, and that nothing else owns: not the environment's target, not a short-lived environment's (its task owns it, and BRK-200 removes it), and not a resource a break-glass mark covers (its task puts it into code). Drift's comparison finds it, and drift leaves deletes out of its own count and plan. The board flags it on the environment (`unowned`, and `GET /api/infra/cleanup`) with an audit entry; a week later it makes one removal plan (source `cleanup`) for every flag that's due and puts it in front of the owner, since a delete always trips the destructive guard. A removal the owner rejects keeps the resource, and the board proposes it no more; a frozen environment's flags wait. A flag drops when its resource is declared, covered by break-glass, or gone. Never in an observe-only environment or the board's own install.

### Golden paths

The owner's opinionated templates for a capability (a queue, a database, a new service) live in the repository; `npx breakaway infra add <template>` scaffolds the change into the checkout, and the agent opens an ordinary pull request (CLI-15). The repository's templates are `.github/breakaway-infra/templates/<name>/template.json`; breakaway ships one example, `queue` for Cloudflare, which a repository's template of the same name replaces. `infra add` writes files and nothing else: it never plans or applies.

### Connections

A row per provider: state, the token's permissions by name (never its value), the last discovery and signal, and the fix in words. The board may hold a read-only token per provider (BRK-171): the owner pastes it in a form that stores it encrypted, like routine tokens (BRK-194).

### The first instance

A repository with a pipeline gets its staging and production environments by itself (freeze mirrors `DEPLOYS_PAUSED`), and every Promote and Roll back is recorded as an applied plan (BRK-195). The deploy flow's workflows and buttons don't change.

### CLI

`npx breakaway infra` (environments), `infra show <environment>`, `infra plans`, `infra plan <id>`, `infra signals`, each with `--json` (CLI-13); `infra check` (CLI-14); `infra init` (CLI-12); `infra add` (CLI-15). The same reads are read-only MCP tools (BRK-202).

### Views

An **Infrastructure** view next to Board and List (WEB-60): each repository's environments with health, drift, cost, freeze, and the plan waiting. An environment's page (WEB-61), the plan page with Approve and Reject (WEB-62), incidents (WEB-63), policy and envelopes in Settings (WEB-64), and cost (WEB-65). Empty states: no provider connected says what to connect and where; no environments yet says how to add one. Both themes, one column on a phone, reduced motion respected.

### Agents

The core gets an incident mode, and the tasks skill learns `infra` and `infra check`: diagnose read only, propose by pull request, never apply, never hold write credentials (BRK-203). Agents on more providers than Claude are a spec of their own ([BRK-176](BRK-176-agent-providers.md)); its build is a later idea (BRK-169).

### Recovery

breakaway keeps a way to recover that doesn't depend on itself: a manual page that rebuilds an install and its environments from the repository with `wrangler` and the desired-state files alone (DOC-30), rehearsed by the owner (BRK-208). Architect observes the board's own install and never applies to it (BRK-169), so the page also says how to redeploy the install itself by hand.

## First provider: Cloudflare

BRK-188 read Cloudflare's API documentation on 6 Oct 2026 and wrote down what the first provider calls for each step, and the narrowest tokens. Nothing here was called against a real account: BRK-189 to BRK-193 and BRK-227 check each call against recorded fixtures, and the owner's first read token (BRK-204) and staging plan (BRK-207) prove them for real. Where the documentation left something open, it says **verify** and names the task that settles it.

Every path is under `https://api.cloudflare.com/client/v4`, with `{a}` for the account ID and `{z}` for a zone ID. Every call is a plain `fetch` with `Authorization: Bearer <token>`; the provider takes `ctx.fetch` so tests mock it (BRK-173).

### What it found

- **There is no plan endpoint.** Cloudflare has no dry run, so `plan` is the provider's own diff of the desired state against `discover`, made with the read token. Nothing is written to plan.
- **A Worker change is a version, then a deployment.** Bindings and compatibility settings belong to a version; creating a version doesn't touch traffic, and a deployment sends traffic to it. So a Worker change is reversible: rolling back is a deployment of the version that was live before. A rollback across a secret change is refused unless it's forced (`?force=true`), and the provider asks for that only inside the executor's own rollback, never in a plan (BRK-192).
- **Deleting is the irreversible part.** Deleting a D1 database, KV namespace, R2 bucket, queue, Durable Object namespace (by a delete migration), or container application destroys its data or its messages. Every delete is marked irreversible, with why. D1's Time Travel can restore a database's contents to a point in the last 30 days, but not a deleted database.
- **Only Workers can be scoped one by one.** Cloudflare's Workers roles (BRK-243) can be given per Worker, so an environment's write token can reach only its own Workers (Workers Editor on them); every other account permission (D1, KV, R2, Queues, Containers) covers every resource of that kind in the account, and zone permissions can be scoped to chosen zones. So the provider itself keeps every call inside the environment's scope (`ctx.scope`: the Workers, databases, buckets, namespaces, queues, applications, and zones it names), and refuses a plan that touches anything outside it. Keeping staging and production fully apart by token takes **separate Cloudflare accounts**; on one account, a staging write token scoped to staging's Workers can't touch production's, but it can technically write production's databases, namespaces, buckets, and queues, and the provider's scope check is what stops it. The same is true of the board's own install when it shares the account: it is observe only in the board, but the token can't enforce that (see Open questions).
- **Read permissions can read data.** `Workers KV Storage Read` can read values, `Workers R2 Storage Read` can read objects, and the legacy `Workers Scripts Read` can download a Worker's code (Cloudflare maps it to the Workers role Content Read-Only), which is why the board asks for **Workers Metadata Read-Only** instead (BRK-243). The provider never calls the value, object, or content endpoints (`…/values/…`, object `GET`s, `…/content`, `…/versions/{id}?include=modules`), and the contract test fails a fixture that does. Secrets are listed by name only; the API never returns their values.
- **Only containers and queue consumers scale.** Workers, Durable Objects, D1, KV, and R2 have no instance count to set and nothing to restart: the platform scales them. Containers on the default scheduling policy have `max_instances`, and a rollout replaces every instance (a restart). Queue consumers have `max_concurrency`. Containers on the Durable Object scheduling policy are started and stopped by the application's own code, so they have neither (BRK-227).
- **Usage and prices come in US dollars.** The published prices are in USD. The Billable Usage API (`GET /accounts/{a}/billable-usage`, `Billing Read`) is alpha, for self-serve accounts only, updated daily, and per product rather than per resource, so the provider estimates each resource's cost from its usage in the analytics and a price table, and doesn't ask for `Billing Read` (BRK-193).
- **Rate limits.** 1,200 requests per 5 minutes per token across the whole API (dashboard use by the same user counts too), and a 429 blocks every call for the next 5 minutes; GraphQL analytics allows 300 queries per 5 minutes on top of that. `discover` makes about 4 calls per Worker plus 1 per other resource and per page, so it stays well inside for the board's repositories; the provider stops on a 429 and reports the error rather than retrying in a loop, and asks for one GraphQL query per dataset for the whole environment, not one per resource.

### Resource kinds

The provider's kinds, as BRK-173's `kinds` declares them: `worker`, `durable-object`, `d1`, `kv`, `r2`, `queue`, `container`, `route`, `custom-domain`. A Worker's secrets are names in its settings, not resources (BRK-189: a relation needs a resource at each end). Each table gives the calls for one kind, and the permission each needs (read ones in the board's token, write ones in the runner's).

**Workers** (`worker`). Changes: create, update, delete.

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/workers/scripts` (names, handlers, last modified); per Worker `GET …/scripts/{name}/settings` (bindings, compatibility, observability, which give the relations), `GET …/scripts/{name}/deployments` (the live versions), `GET …/scripts/{name}/secrets` (names only), `GET …/scripts/{name}/schedules` (cron triggers) | Workers Metadata Read-Only (legacy: Workers Scripts Read) |
| Plan | Diff only: the desired bindings, compatibility date and flags, cron triggers, and routes against what discover found | none beyond discover |
| Apply | `POST /accounts/{a}/workers/workers/{id}/versions` (a new version with the changed bindings, carrying the live version's modules), then `POST /accounts/{a}/workers/scripts/{name}/deployments` (`strategy: percentage`, the new version at 100); cron triggers `PUT …/scripts/{name}/schedules`; delete `DELETE …/scripts/{name}` (irreversible). BRK-192 checked: the versions endpoint needs the version's `modules` (the code), and the provider never reads a Worker's code, so it uses the fallback, `PATCH …/scripts/{name}/settings` (see "Plan and apply, as built") | Workers Editor on the environment's Workers (legacy: Workers Scripts Write, which the dashboard may call Edit). Making a Worker (`POST /accounts/{a}/workers/workers`) or deleting one needs Workers Admin at the Workers product scope, which Editor doesn't have |
| Roll back | `POST …/scripts/{name}/deployments` with the previous version at 100 | Workers Editor on the Worker (legacy: Workers Scripts Write) |
| Observe | GraphQL `workersInvocationsAdaptive` by `scriptName`: requests and errors over the last 15 minutes give healthy, degraded, or down; a Worker with no deployment is down | Account Analytics Read |
| Cost | The same dataset's requests and CPU time, times the price table | Account Analytics Read |
| Scale or restart | Neither | |

**Durable Objects** (`durable-object`). Changes: create, update (both through the Worker that defines the class, by a migration), delete (a delete migration, irreversible).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/workers/durable_objects/namespaces` (class, script, SQLite or not); the Worker's settings give the binding | Workers Metadata Read-Only (legacy: Workers Scripts Read): Durable Objects have no role of their own and follow the Worker that implements them |
| Plan | Diff only; a new class or a deleted one is a migration on the Worker's next version | none beyond discover |
| Apply | The Worker's version and deployment above, with the migration in the version | Workers Editor on the Worker (legacy: Workers Scripts Write) |
| Observe | GraphQL `durableObjectsInvocationsAdaptiveGroups` by namespace: requests and errors | Account Analytics Read |
| Cost | `durableObjectsInvocationsAdaptiveGroups` (requests, duration), `durableObjectsStorageGroups` (stored bytes), times the price table | Account Analytics Read |
| Scale or restart | Neither | |

**D1** (`d1`). Changes: create, delete (irreversible). A database's schema is the repository's migrations, not Architect's.

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/d1/database`, `GET …/d1/database/{id}` (size, tables count, read replication) | D1 Read |
| Plan | Diff only | none beyond discover |
| Apply | `POST /accounts/{a}/d1/database`; `DELETE …/d1/database/{id}` | D1 Write |
| Observe | GraphQL `d1AnalyticsAdaptiveGroups` by `databaseId`: queries and `queryBatchTimeMs` (slow is degraded; the dataset has no error count) | Account Analytics Read |
| Cost | `d1AnalyticsAdaptiveGroups` (`rowsRead`, `rowsWritten`), `d1StorageAdaptiveGroups` (size), times the price table | Account Analytics Read |
| Scale or restart | Neither | |

**KV** (`kv`). Changes: create, update (the title), delete (irreversible).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/storage/kv/namespaces` (never keys or values) | Workers KV Storage Read |
| Plan | Diff only | none beyond discover |
| Apply | `POST …/storage/kv/namespaces`; `PUT …/namespaces/{id}` (rename); `DELETE …/namespaces/{id}` | Workers KV Storage Write |
| Observe | GraphQL `kvOperationsAdaptiveGroups` by `namespaceId`: operations and latency (the dataset has no error count, so KV is healthy or unknown) | Account Analytics Read |
| Cost | `kvOperationsAdaptiveGroups` (`requests` by `actionType`: read, write, delete, list), `kvStorageAdaptiveGroups` (`byteCount`), times the price table | Account Analytics Read |
| Scale or restart | Neither | |

**R2** (`r2`). Changes: create, update (CORS, lifecycle, custom domain), delete (irreversible, and refused by Cloudflare unless the bucket is empty).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/r2/buckets`; per bucket `GET …/buckets/{name}/cors`, `…/lifecycle`, `…/domains/custom` (never objects) | Workers R2 Storage Read |
| Plan | Diff only | none beyond discover |
| Apply | `POST …/r2/buckets`; `PUT …/buckets/{name}/cors`, `…/lifecycle`; `POST`/`DELETE …/domains/custom`; `DELETE …/buckets/{name}` | Workers R2 Storage Write |
| Observe | GraphQL `r2OperationsAdaptiveGroups` by `bucketName`: operations by response status | Account Analytics Read |
| Cost | `r2OperationsAdaptiveGroups` (class A and B operations), `r2StorageAdaptiveGroups` (stored bytes), times the price table; egress is free | Account Analytics Read |
| Scale or restart | Neither | |

**Queues** (`queue`). Changes: create, update (settings, consumers), delete (irreversible: its messages go), and **scale** (a consumer's `max_concurrency`).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/queues`; per queue `GET …/queues/{id}/consumers` (the consuming Worker, batch size, retries, dead-letter queue, concurrency) | Queues Read |
| Plan | Diff only | none beyond discover |
| Apply | `POST …/queues`; `PATCH …/queues/{id}` (settings; `PUT` replaces them all); `POST`/`PUT`/`DELETE …/queues/{id}/consumers/{consumer}`; `DELETE …/queues/{id}` | Queues Write |
| Observe | `GET …/queues/{id}/metrics` (the backlog now: `backlog_count`, `oldest_message_timestamp_ms`), and GraphQL `queuesBacklogAdaptiveGroups` and `queueMessageOperationsAdaptiveGroups` (`retryCount`, `lagTime`) for the trend; a backlog that keeps growing, or an old oldest message, is degraded | Queues Read, Account Analytics Read |
| Cost | `queueMessageOperationsAdaptiveGroups` (operations), times the price table | Account Analytics Read |
| Scale | `PUT …/queues/{id}/consumers/{consumer}` with `settings.max_concurrency` inside the envelope's bounds | Queues Write |
| Restart | None | |

**Containers** (`container`). Changes: update, delete (irreversible), and, on the default scheduling policy only, **scale** and **restart**. A container application is made by the Worker's deploy, not by Architect, so there is no create.

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/containers/applications` (scheduling policy, instance type, `max_instances`, the Durable Object it belongs to, instance counts); `GET …/applications/{id}/instances-v2` for each instance's state | Containers Read |
| Plan | Diff only | none beyond discover |
| Apply | `PATCH …/containers/applications/{id}` (`max_instances`, constraints, observability, rollout grace period); `DELETE …/applications/{id}` | Containers Write |
| Observe | The application's instance counts (`active` against `assigned`) and each instance's state; none active when some are assigned is down | Containers Read |
| Cost | Active instances, their instance type, and the time they ran, times the price table (vCPU, memory, and disk by the second). A rougher estimate than the others: **verify** against the dashboard in BRK-193 | Containers Read |
| Scale | `PATCH …/applications/{id}` with `max_instances` inside the envelope's bounds | Containers Write |
| Restart | `POST …/applications/{id}/rollouts` with the current configuration: every instance is replaced, step by step, after `SIGTERM` and up to 15 minutes to drain. The documentation shows the endpoint but not its body; BRK-227 sends the body Wrangler sends for a deploy's rollout (`description`, `strategy: rolling`, `kind: full_auto`, `step_percentage`, `target_configuration` from `GET …/applications/{id}`), which the docs don't confirm: **verify** in BRK-207's staging run | Containers Write |

**Routes** (`route`). Changes: create, update, delete (reversible: a route holds no data).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /zones/{z}/workers/routes` for each zone in the environment's scope; `GET /zones?account.id={a}` once, to name the zones | Workers Routes Read (zone), Zone Read (zone) |
| Plan | Diff only | none beyond discover |
| Apply | `POST /zones/{z}/workers/routes`; `PUT …/routes/{id}`; `DELETE …/routes/{id}` | Workers Routes Write (zone) |
| Observe | A route's health is its Worker's | |
| Cost | None of its own | |
| Scale or restart | Neither | |

**Custom domains** (`custom-domain`). Changes: create, delete (reversible, but the hostname stops answering until it's attached again).

| Step | Calls | Permission |
| --- | --- | --- |
| Discover | `GET /accounts/{a}/workers/domains` (hostname, zone, Worker) | Workers Metadata Read-Only (legacy: Workers Scripts Read) |
| Plan | Diff only | none beyond discover |
| Apply | `PUT /accounts/{a}/workers/domains`; `DELETE …/workers/domains/{id}`. BRK-192 checked Cloudflare's Workers authorization page: adding, changing, or removing a custom domain needs Workers Routes Write on every zone it touches, as routes do | Workers Editor at the Workers product scope, since custom domains have no per-Worker role yet (legacy: Workers Scripts Write), and Workers Routes Write (zone) |
| Observe | Its Worker's health | |
| Cost | None of its own | |
| Scale or restart | Neither | |

### Discover, as built (BRK-189)

`src/infra-cloudflare.js` starts at the environment's target (a Worker's name) and follows what it reaches: the Workers it calls by a service binding or whose Durable Object classes it binds, and then each Worker's D1 databases, KV namespaces, R2 buckets, queues, Durable Object namespaces, the containers those run, and the routes and custom domains that serve it. It only fetches a list when a Worker in scope binds that kind, and keeps nothing else from it. Resource IDs are the kind and Cloudflare's own ID (`worker:acme-api`, `d1:<uuid>`). Relations: `calls` (Worker to Worker), `uses` (Worker to D1, KV, R2, or Durable Object), `produces` and `consumes` (Worker to queue), `runs-in` (Durable Object to the Worker its class is in), `defines` (a Worker to a Durable Object it defines but doesn't bind), `runs` (Durable Object to container), and `serves` (Worker to route or custom domain). A Worker keeps its bindings by name and type, never a variable's text, and no deployment's author.

The account is `ctx.scope.account` when given, else the one account `GET /accounts` lists for the token; a token that reaches several is refused. Every call is a `GET`, checked against a list of paths that read data before it's made. A 403 on queues or containers skips that kind and marks its permission missing on Connections; a 403 on anything else fails discovery and marks that permission missing.

### Cost, as built (BRK-193)

`cost` prices what discover found (the store passes it as `ctx.resources`, so nothing is discovered twice) from the last 7 days of usage, scaled to 30 days, times `PRICES` in `src/infra-cloudflare.js`: Cloudflare's list prices on the Workers Paid plan, kept as data with each product's pricing page and the date they were read (6 Oct 2026). Stored data is priced at its most over the week. Amounts are in US dollars and marked as estimates; converting is BRK-226's.

The usage comes from `src/infra-cloudflare-analytics.js`, which BRK-191 reuses for health: `analyticsQuery` sends one GraphQL query (a POST of a `query`, never a mutation) and stops on a 429 or 403, and `readDataset` reads one dataset for every resource of its kind in the environment at once and adds it up per resource. The datasets: `workersInvocationsAdaptive` (`requests`, `cpuTimeUs`), `durableObjectsInvocationsAdaptiveGroups` (`requests`), `durableObjectsPeriodicGroups` (`activeTime`, billed at 128 MB per object), `durableObjectsStorageGroups` (`storedBytes`), `d1AnalyticsAdaptiveGroups` (`rowsRead`, `rowsWritten`), `d1StorageAdaptiveGroups` (`databaseSizeBytes`), `kvOperationsAdaptiveGroups` (`requests` by `actionType`), `kvStorageAdaptiveGroups` (`byteCount`), `r2OperationsAdaptiveGroups` (`requests` by `actionType`, sorted into Class A, Class B, and free, with anything unknown priced as Class A), `r2StorageAdaptiveGroups` (`payloadSize`, `metadataSize`), and `queueMessageOperationsAdaptiveGroups` (`billableOperations`). A container is priced from discover's instance type and active instances: memory and disk for the instances running now, all month. CPU isn't counted, since Cloudflare bills it by use and doesn't report it per application. Routes and custom domains cost nothing of their own.

Every estimate carries a note, which the inventory keeps and shows with the amount: it is before what the plan includes, which Cloudflare counts across the whole account rather than per resource, so the bill can be lower (the $5 subscription is the account's, too). A dataset Cloudflare's analytics won't return is left out of the resources it prices, and their notes say which; a 429, a 403, or Cloudflare out of reach stops the estimate, and the store keeps the last one. **Verify** on a real account (BRK-205): the time field each dataset filters on, whether `durableObjectsStorageGroups` has a `namespaceId` dimension, and that the 7-day window is within each dataset's range.

### Plan and apply, as built (BRK-192)

`src/infra-cloudflare-plan.js`. **Plan** discovers the environment with the board's read token and diffs the desired state against it, writing nothing. A desired resource matches a discovered one by its ID, or by its kind and name, since a database or namespace the plan makes has no Cloudflare ID yet. Only the settings Architect manages are compared, and only those the file gives, so a file can leave the rest to the deploy: a Worker's compatibility date and flags, usage model, observability, placement, bindings to Cloudflare resources, and cron triggers; R2's CORS and lifecycle; a queue's delivery delay, pause, and retention; a container's `max_instances`; a route's pattern and Worker; a custom domain's Worker and environment; and a KV namespace's title. A Worker's handlers, secrets, and live versions, and a database's size, are never compared. A discovered resource the file doesn't list is deleted. Changes apply in an order that makes what's bound first and deletes it last: new data kinds, then Workers, then routes and custom domains, then deletes the other way round.

A binding in the file gives its name and type and, for one to a resource, what it binds to: Cloudflare's own field (`id`, `namespace_id`, `bucket_name`, `queue_name`, `service`, `class_name`), or `resource`, the desired ID of a database or namespace the same plan makes. A binding with only its name and type keeps what it binds to. Variables and secrets (`plain_text`, `json`, `secret_text`, and every other type) are never changed: a file that gives a variable's text, or adds, drops, or retypes one, is refused, and an apply carries them over with `keep_bindings`, so the board never reads or holds a value.

Because only Workers can be scoped one by one, plan refuses: a resource whose name already exists on the account outside the environment's scope; a database, namespace, bucket, or queue no Worker in the file binds (it would be outside the scope, and never discovered again); a delete of something a remaining Worker still binds or calls; deleting the environment's target; and what Architect doesn't make, a Durable Object class (a migration in its Worker's code) and a container application (its Worker's deploy). A new Worker is the Worker alone (`POST /accounts/{a}/workers/workers`), with its cron triggers: its first version, with its code, comes from its deploy, and its settings are compared once it has one.

**Apply** runs only in the apply runner, with the environment's write token in `ctx.writeToken`, which only the runner sets (from `BREAKAWAY_WRITE_TOKEN`) and the board never does: without it, apply and `rollbackWorker()` stop before any call to Cloudflare. A read-only token put in the runner's secret by mistake gets Cloudflare's 403 at the first write, and the step fails naming the permission. It discovers again first and fails a change whose resource isn't what the plan saw ("changed since it was planned: plan again"), then makes one change at a time and stops at the first that fails. A Worker's settings and bindings change with `PATCH …/scripts/{name}/settings` (a multipart `settings` part), which makes a new version and deploys it; the version that was live before is in the change's `before.versions`. `rollbackWorker()` deploys those versions again (`POST …/scripts/{name}/deployments`), with `?force=true` only when the executor's own rollback crosses a secret change (BRK-183). `estimate(ctx, change)` prices what a change leaves for BRK-178's cost change: a new resource from its settings with `priceResource()` (no usage yet, so most are $0), a changed or scaled one with `cost()` over its last week of use and its new settings, and nothing for a delete or a restart. **Verify** with BRK-207's staging plan that the settings endpoint deploys the new version at 100% on an account that uses gradual deployments.

### Alerts

The board already takes Cloudflare's notification webhooks at `/api/routines/<slug>/fire`, with the secret in `cf-webhook-auth`, and keeps only the alert's name, time, and Worker (`alertData` in `src/store-routines.js`). BRK-191 sends the same cut-down alert into the signal stream as well as to its routines, as an `alert` signal on the Worker it names (or the whole environment when it names none), with nothing else from the body.

To show which alerts reach the board, the provider reads the account's alert setup with `GET /accounts/{a}/alerting/v3/available_alerts` (the kinds the account can have), `GET …/alerting/v3/policies` (which are on, and where they go), and `GET …/alerting/v3/destinations/webhooks` (whether one points at the board). `GET …/alerting/v3/history` (the last 30 days) fills in alerts that fired while the webhook wasn't set up. All need **Notifications Read**. The alert types themselves come from `available_alerts`, not a list in the code, since Cloudflare adds them. Setting up a policy or a webhook is the owner's, in the dashboard: the token never has Notifications Write.

### Health and alerts, as built (BRK-191)

`observe` reads what discover found (`ctx.resources`) from the same analytics reader, one query per dataset for the whole environment over the last 15 minutes (`HEALTH_DATASETS` in `src/infra-cloudflare-analytics.js`): `workersInvocationsAdaptive` and `durableObjectsInvocationsAdaptiveGroups` (`requests`, `errors`: 5% failing is degraded, half is down, a Worker with no deployment is down), `d1AnalyticsAdaptiveGroups` (queries, and `queryBatchTimeMs` on average: over a second is degraded), `kvOperationsAdaptiveGroups` (operations), `r2OperationsAdaptiveGroups` (`requests` by `responseStatusCode`: 5xx count as failed), and `queuesBacklogAdaptiveGroups` (the backlog on average), plus `GET …/queues/{id}/metrics` for the backlog now (an oldest message older than 15 minutes, or a backlog over 1,000 and twice its average, is degraded; paused delivery too). A container application is down when none of its assigned instances is active, and degraded when some aren't. A route or custom domain takes its Worker's health. No traffic in the window is **unknown**, not healthy, and so is a dataset the analytics won't answer, saying which; a 429 or a 403 stops it, and the store keeps the last health. The limits are `HEALTH_LIMITS` in `src/infra-cloudflare.js`.

When the inventory refreshes, a resource that's degraded (warning) or down (critical) becomes a `health` signal, and one that's healthy again after it wasn't becomes an `info` signal; staying healthy or unknown adds nothing. `events` reads the alert history since the last refresh (at most the 7 days the stream keeps) and reports each alert as an `alert` signal, cut down by `alertFields` exactly as the webhook's are, so the two read the same: the store keeps one signal for an alert heard both ways (the same environment, resource, and text, within 2 minutes). The webhook's alert lands on the Worker it names in every environment whose inventory has it, or else on the routine's repository's Cloudflare environments as a whole; it's recorded before the routine's caps are checked, so it's in the stream whether or not a run starts. Connections shows the last signal read as the provider's **signal**: a refused alert history marks Notifications Read missing.

`GET /api/infra/alerts?provider=cloudflare` reads which alerts reach the board, live with the read token: each alert type the account can have (from `available_alerts`) with how many policies use it and whether one is on and sends to a webhook that fires a routine on the board, each policy by name, and how many webhooks point at the board. It keeps names only: no webhook URL, no email, and no other destination.

**Verify** on a real account (BRK-205): which of these datasets filter on `datetime` and serve `errors`, `avg { queryBatchTimeMs }`, `responseStatusCode`, and `avg { messages }`; the queue metrics endpoint's field names; and that an alert history entry's `alert_body` carries the webhook's fields (`alert_name`, `ts`, `data.script_name`), so the two copies of one alert match.

### Tokens

**The board's read token** (BRK-194 stores it; the owner makes it in BRK-204). A custom **account API token** (Manage Account › Account API Tokens), so it doesn't stop working if a person leaves the account; a user token with the same permissions works too. No permission ends in Edit or Write.

| Scope | Permission | For |
| --- | --- | --- |
| Account, Workers product | Workers Metadata Read-Only (legacy: Workers Scripts Read) | Workers, their settings, deployments, secret names, cron triggers, Durable Object namespaces, custom domains; never their code |
| Account | Workers KV Storage Read | KV namespaces (never values) |
| Account | Workers R2 Storage Read | R2 buckets and their settings (never objects) |
| Account | D1 Read | D1 databases |
| Account | Queues Read | Queues and their consumers |
| Account | Containers Read | Container applications and instances |
| Account | Account Analytics Read | Health and usage, through GraphQL |
| Account | Notifications Read | Which alerts are set up, and alert history |
| Zone (only the zones the environments use) | Zone Read | Naming the zones |
| Zone (only the zones the environments use) | Workers Routes Read | Routes |

Account resources: the one account the environments run on. Not asked for, on purpose: Billing Read (it shows invoices and the billing address, and its usage is per product, not per resource), Workers Tail Read and anything for logs (BRK-172 left logs out), DNS Read, and any Edit or Write. A repository that uses no containers or queues can leave those two out; the provider then reports the kind as not readable instead of failing discovery. BRK-194 checks a pasted token with `GET /accounts/{a}/tokens/verify` (an account token) or `GET /user/tokens/verify` (a user token), which says it's active but not its permissions, so the Connections row lists the permissions the owner was asked for, and marks one missing when a call returns 403. That also means the board can't see a permission the token has but shouldn't: a token made with an Edit or Write permission by mistake still works, so the form and BRK-204 tell the owner to make it from this list, read only, by hand, and the row says it can't check for extra permissions.

**The runner's write token, one per environment** (in that environment's GitHub environment as a secret, BRK-171; the owner makes the staging one in BRK-206). Short-lived environments share one: the GitHub environment named `short-lived` (BRK-242), never staging's, whose token has only the Write permissions the short-lived template declares, scoped to the template's Workers where Cloudflare allows it. A custom account API token with the read token's permissions, plus only the Write permissions for the kinds that environment's desired state declares:

| Scope | Permission | When |
| --- | --- | --- |
| Account, the environment's Workers | Workers Editor (legacy: Workers Scripts Write) | Always: its Workers and their Durable Objects. Scope it to the Workers product instead when the environment declares custom domains (they have no per-Worker role yet) |
| Zone (only that environment's zones) | Workers Routes Write | When it declares routes or custom domains |
| Account | D1 Write | When it declares D1 databases |
| Account | Workers KV Storage Write | When it declares KV namespaces |
| Account | Workers R2 Storage Write | When it declares R2 buckets |
| Account | Queues Write | When it declares queues |
| Account | Containers Write | When it declares containers |

Give it an expiry date and rotate it, never Account Settings, API Tokens, Billing, DNS, or Notifications Write, and never reuse it for another environment. The dashboard may name a write permission Edit rather than Write; it's the same permission. Because account permissions other than Workers reach every resource of their kind, a production write token belongs on a separate Cloudflare account from staging when the owner can arrange it (see "What it found").

#### Cloudflare's Workers roles (BRK-243)

Cloudflare marks Workers Scripts Read and Write as legacy (no deprecation date yet) and replaces them with **Workers roles**, which an account API token takes at the Workers product scope or for chosen Workers ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), last updated 15 Sep 2026, read 6 Oct 2026). Its own mapping: Workers Scripts Read is Content Read-Only at the product scope, which can read a Worker's code; Workers Scripts Edit is Editor at the product scope. So the board's token asks for **Metadata Read-Only** at the Workers product scope, and each environment's write token for **Editor** on that environment's Workers. A token made with the legacy permissions still works: Connections counts Workers Scripts Read as Metadata Read-Only, and every message that names a permission gives the legacy name in parentheses.

| Role | What Cloudflare says it allows | Where Architect uses it |
| --- | --- | --- |
| Metadata Read-Only | Workers' metadata, settings, and observability (metrics, logs, traces); not their code or secret values. Durable Objects follow the Worker that implements them | The board's read token, at the Workers product scope |
| Content Read-Only | Metadata Read-Only, plus the code | Never: the board never reads code |
| Editor | Read, update, deploy, and rename existing Workers: settings, schedules, versions, deployments; not create or delete | Each environment's write token, on its Workers |
| Admin | Everything, including creating and deleting Workers (at the product scope) | Only for an apply that makes or deletes a Worker, given by hand |

Which calls each needs, checked against that page:

| Calls | Needs | Checked |
| --- | --- | --- |
| `GET …/workers/scripts`, `…/scripts/{name}/settings`, `…/deployments`, `…/schedules`, `GET …/workers/durable_objects/namespaces`, `GET …/workers/domains` | Metadata Read-Only | Documented: lists, settings, schedules, and deployments are metadata, and Durable Objects inherit the Worker's role |
| `GET …/scripts/{name}/secrets` (names only) | Metadata Read-Only | Not stated: the page rules out secret *values*, not names. **Verify** with BRK-205's read-only look; if it's refused, discovery fails naming Metadata Read-Only, and the fix is to stop reading secret names, not a wider role |
| GraphQL analytics (health, cost) | Account Analytics Read, as before | Metadata Read-Only covers Workers observability in the dashboard; the GraphQL API still asks for Account Analytics Read, so the token keeps it |
| `PATCH …/scripts/{name}/settings`, `PUT …/schedules`, `POST …/deployments` (apply and roll back) | Editor on the Worker | Documented: Editor updates settings, schedules, versions, and deployments |
| `PUT` and `DELETE …/workers/domains` | Editor at the Workers product scope, and Workers Routes Write on the zone | Documented: custom domains have no per-Worker role yet, and a domain or route change needs Workers Routes Write on every zone it touches |
| `POST …/workers/workers` (a new Worker), `DELETE …/scripts/{name}` | Admin at the Workers product scope | Documented: per-Worker roles can't be given for a Worker that doesn't exist yet, and Editor can't delete |

Apply discovers again with the write token, so it carries the read token's permissions too; per-Worker Editor reads its own Workers, and Metadata Read-Only at the product scope lets that discovery list the account's. A plan that deletes a Worker says, in its reason, that the write token needs Workers Admin for that apply; a 403 on making or deleting one says the same. A file that adds a Worker makes it with `POST …/workers/workers`, which needs Admin too, but a new Worker usually comes from its first deploy instead, so Admin is never part of the standing write token: the owner gives it for the one apply that needs it and takes it away after.

### Scale and restart, for envelopes

| Kind | Scale | Restart |
| --- | --- | --- |
| `container` (default scheduling policy) | `max_instances` | A rollout of the current configuration |
| `container` (Durable Object scheduling policy) | No | No |
| `queue` | The consumer's `max_concurrency` | No |
| `worker`, `durable-object`, `d1`, `kv`, `r2`, `route`, `custom-domain` | No: the platform scales them | No |

So the kinds BRK-227 declares are `container` (scale and restart, `scales: maxInstances`) and `queue` (scale, `scales: maxConcurrency`, its Worker consumer's, which discover adds to the queue's settings). The envelope form offers nothing else (BRK-186). A resource whose kind scales but which can't (a container application on another scheduling policy, a queue with no Worker consumer) is refused by the provider's `refuses(resource, op)`, in words, before an act plans and again at apply. Apply reads each scale back, and the executor checks health after it as after any apply; a container application's instance counts don't make a plan out of date, since Cloudflare moves them by itself.

## How a chase runs it

The owner's note asks for this to make sense as a chase. The graph is shaped for that:

- **Wide at the start.** Once this pull request merges, four tasks are ready with no decision (ID-5, the words; BRK-173, providers; BRK-174, environments; BRK-175, the audit trail), and the three decisions show as **Needs you**. The chase starts the first four at once (two areas, under three per area).
- **Decisions gate only their branch.** BRK-169 holds the desired state, the first provider, and the agent-providers spec. BRK-171 holds policy, the runner, Connections' token, and envelopes. BRK-172 holds signals and everything after them. Answer them in any order; each unblocks its own branch while the others keep running.
- **Owner steps are where the chase stops on purpose.** BRK-204 (make the read token), BRK-205 (look at the inventory before anything can apply), BRK-206 (write credentials for staging only), and BRK-207 (the first staging plan end to end). Production gets credentials only after BRK-207, as a new task.
- **Related tasks never run together.** BRK-196 and BRK-197 both hook the signal stream, BRK-200 and BRK-201 both remove resources, and CLI-14 and BRK-185 both compute a plan from the desired state; each pair is marked related.
- **One link outside the feature:** BRK-202 waits for the MCP endpoint (BRK-154, ai-native), which the chase pulls in as a blocker.
- **Board-only critical path:** BRK-173 and BRK-174 → BRK-178 → BRK-181 → BRK-182 → BRK-183, with BRK-179 and CLI-12 beside it. Everything else hangs off that spine or off the signal stream.

## Privacy

The board stores resource names, kinds, relations, health, cost, and signals from the owner's own accounts, redacted before storage (no emails, tokens, or request bodies), and nothing about people. Tokens are stored encrypted, shown only as "set" and their permissions by name, and sent only to their provider. Agent sessions see the inventory, plans, and redacted signals through the CLI and MCP, never a credential or personal data from the systems being run.

## Out of scope

- A hosted control plane, accounts, or anything shared across installs.
- A second provider before the first has applied a staging plan end to end.
- Agents holding write credentials, or applying anything.
- Moving the deploy flow onto the executor: it keeps its workflows; Architect records it.
- Building pluggable agent providers (BRK-176 is a spec only).
- Repositories on Cloudflare Artifacts (IDEA-16); they can become a change source later.
- Managing the board's own install: observe only (BRK-169).
- Metrics, logs, and traces as signals (BRK-172).
- Change windows: the freeze switch is the only one (BRK-171).
- Driving an infrastructure-as-code tool (BRK-169).

## Decisions

Answered by the owner on 6 Oct 2026; DOC-29 records them in the decision log and `AGENTS.md`.

- **BRK-169, what Architect manages first:** what the board's repositories run on, not whole accounts; Cloudflare first; adapters call the API directly; desired state in `.github/breakaway-infra/<environment>.json`; the board's own install observed, never applied to; pluggable agents a spec now (BRK-176), built as their own idea.
- **BRK-171, keys and approvals:** the runner is a workflow in the repository with credentials in GitHub environments; a read-only token per provider on the board; every plan asks the owner by default; a cost limit of 5 a month, configurable, in the owner's currency; envelopes for scaling and capped restarts (a push when the cap is used up), in every environment, production included; automatic rollback; no change windows, a freeze switch; break-glass is recorded and brought into code by pull request.
- **BRK-172, signals and incidents:** health, alerts, and cost; raw signals 7 days, daily summaries 90; an incident is a `+incident` task in the owning repository; production incidents push, others go to the inbox quietly; a diagnosis agent starts only from runbooks the owner turns on; a budget of 20 a month per environment, configurable, in the owner's currency.
- **BRK-225, cost in the owner's currency:** a rate the owner sets in Settings, any currency, once for the whole board (BRK-226 builds it). The owner's note asks to fetch a rate once to prefill the field; that's BRK-239, since it changes what the install calls.

## Open questions

- Whether short-lived environments are made on claim, on a tag, or only on a press. BRK-200 starts with a tag or a press. Whether 14 days is the right grace for an environment whose task stays open.
- Whether the plan check needs a new GitHub App permission (checks: write). BRK-185 adds an owner task if it does.
- Whether the board's own install, staging, and production should be on separate Cloudflare accounts. Cloudflare's per-Worker Workers Editor keeps a staging write token off production's and the board's Workers, but every other account permission reaches every resource of its kind, so on one account only the provider's scope check keeps it off production's data (First provider). Separate accounts make the token the boundary; the owner chooses when making the tokens (BRK-204, BRK-206).

## Done when

- The owner connects a provider and sees what exists, with relations, health, and cost, on the Infrastructure view.
- A pull request that changes a staging environment's desired state shows its plan as a check; after merging, the owner approves the plan from the phone, and the board applies it, verifies it, and records it, rolling back by itself if verification fails.
- Drift, an unowned resource, and a failing signal each show up and propose a plan or open an incident; nothing applies without the owner's approval or an envelope.
- The deploy flow's environments and promotions show in Architect, unchanged.
- Agents can read all of it from the CLI and MCP, and the core teaches the incident mode.
- The manual, the decision log, and the brand's claims describe it, and the recovery page has been rehearsed.

The tasks, all in the `architect` feature, all on the `now` horizon, and all waiting (directly or through another) for IDEA-19:

| Task | What | Waits for |
| --- | --- | --- |
| BRK-169 | Decide what Architect manages first (`+owner`) | IDEA-19 |
| BRK-171 | Decide the keys, approvals, and envelopes (`+owner`) | IDEA-19 |
| BRK-172 | Decide signals and incidents (`+owner`) | IDEA-19 |
| ID-5 | Architect's words in the brand guide | IDEA-19 |
| BRK-173 | The provider interface and the fake provider | IDEA-19 |
| BRK-174 | Environments | IDEA-19 |
| BRK-175 | The audit trail | IDEA-19 |
| BRK-176 | Spec: pluggable agent providers | BRK-169 |
| BRK-225 | Decide cost in your currency (`+owner`) | — |
| BRK-177 | Inventory | BRK-173, BRK-174 |
| BRK-178 | Plans | BRK-173, BRK-174, BRK-175 |
| BRK-179 | Environment locks | BRK-174 |
| BRK-180 | Desired state | BRK-169, BRK-174 |
| CLI-12 | The apply runner (`infra init`) | BRK-171, BRK-180 |
| BRK-181 | Policy as code | BRK-171, BRK-178 |
| BRK-182 | Approve and reject | BRK-181 |
| BRK-183 | The executor | BRK-182, BRK-179, CLI-12 |
| BRK-184 | Drift | BRK-180, BRK-177, BRK-178 |
| BRK-185 | Plans from pull requests | BRK-180, BRK-181 |
| BRK-186 | Envelopes: scaling and capped restarts | BRK-183 |
| BRK-187 | Break-glass | BRK-184 |
| BRK-188 | Research the first provider | BRK-169, BRK-173 |
| BRK-189 | First provider: discover | BRK-188, BRK-177 |
| BRK-190 | Signals | BRK-172, BRK-173 |
| BRK-191 | First provider: observe and events | BRK-189, BRK-190 |
| BRK-192 | First provider: plan and apply | BRK-189, BRK-180, BRK-178 |
| BRK-193 | First provider: cost | BRK-189 |
| BRK-226 | Costs in your currency | BRK-225, BRK-181 |
| BRK-227 | First provider: scale and restart in an envelope | BRK-186, BRK-192, BRK-188 |
| BRK-194 | Connections for providers | BRK-171, BRK-173 |
| BRK-195 | The deploy flow as the first instance | BRK-178 |
| BRK-196 | Runbooks on signals (related to BRK-197) | BRK-190 |
| BRK-197 | Incidents | BRK-190, BRK-178 |
| BRK-198 | The deploy flow's health checks as signals | BRK-190 |
| BRK-199 | Cost attribution and budgets | BRK-177, BRK-181, BRK-190, BRK-226 |
| BRK-200 | Short-lived environments (related to BRK-201) | BRK-183 |
| BRK-201 | Clean up what nobody owns | BRK-177, BRK-182 |
| CLI-13 | `npx breakaway infra` reads | BRK-177, BRK-178 |
| CLI-14 | `infra check` (related to BRK-185) | BRK-180, CLI-13 |
| CLI-15 | Golden paths and `infra add` | CLI-14 |
| BRK-202 | Read-only MCP tools | CLI-13, BRK-154 |
| WEB-60 | The Infrastructure view | ID-5, BRK-177 |
| WEB-61 | An environment's page | WEB-60, BRK-175 |
| WEB-62 | The plan page | WEB-60, BRK-182 |
| WEB-63 | Incidents on the board | WEB-60, BRK-197 |
| WEB-64 | Policy and envelopes | WEB-60, BRK-186 |
| WEB-65 | Cost on the view | WEB-60, BRK-199 |
| BRK-203 | Teach agents infrastructure work | BRK-185, BRK-197, CLI-13 |
| DOC-29 | Record the decisions | BRK-169, BRK-171, BRK-172 |
| DOC-30 | The recovery page | BRK-180 |
| DOC-31 | Architect in the manual, README, and site | BRK-183, BRK-197, WEB-62, CLI-15 |
| BRK-204 | Make the read token and connect it (`+owner`) | BRK-194, BRK-188 |
| BRK-205 | Try it read-only on your account (`+owner`) | BRK-204, BRK-191, WEB-61 |
| BRK-206 | Executor credentials for staging (`+owner`) | BRK-183, BRK-192 |
| BRK-207 | A first staging plan end to end (`+owner`) | BRK-206, BRK-205, WEB-62 |
| BRK-208 | Rehearse recovering without the board (`+owner`) | DOC-30 |

## How to check it

1. Once the tasks are merged, update and deploy your board as usual, then open **Connections** and connect the first provider with the read-only token. Its row should say it works and list the token's permissions by name.
2. Open **Infrastructure** in the sidebar. You should see your repositories' environments, starting with staging and production for any repository that already deploys with breakaway, each with its health, cost this month, and whether it's frozen.
3. Open the staging environment. You should see what actually runs there (your Workers, databases, and the like), what each one uses, and which repository owns it.
4. Ask an agent to make a small staging change (for example, a new setting). Its pull request should show a plan as a check, saying what will change, what it costs, and whether it can be undone.
5. Merge it. Your phone should get a push; open it and press **Approve**. The plan should apply, check health, and show as applied in the environment's history.
6. Change the same setting by hand on the platform. Within the hour the environment should show drift and a draft plan to put it back, with no push, and nothing should change by itself.
7. Trigger a test alert on the platform. An incident should appear in your inbox, as a task with its steps, and production ones should push.
8. Press **Freeze** on staging, and try step 5 again: the plan should be refused until you unfreeze.
