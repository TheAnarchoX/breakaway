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

The first provider is Cloudflare (BRK-169), where the board and the deploy flow already run. BRK-188 writes down its API surface and the narrowest tokens as a **First provider** section in this spec; BRK-189 discovers, BRK-191 observes, BRK-192 plans and applies for Workers and their bindings, BRK-193 prices, and BRK-227 scales and restarts inside an envelope, for the kinds that can.

### Environments

A named target in one of the board's repositories: kind (`production`, `staging`, `short-lived`), its provider, an owning task for a short-lived one, a **freeze** switch (the pause switch, generalised; owner-only; no change windows, BRK-171), whether production gates apply, and **observe only**. The environment that runs the board's own install is always observe only (BRK-169) (BRK-174). A fresh install has none, and the Infrastructure view says what to connect first.

### Inventory

What actually exists, from each provider's `discover`, scoped to what the board's repositories run on (BRK-169: nothing outside an environment's scope is stored): a graph of resources with relations (this Worker uses that database, secret by name, and route), ownership (repository, task, environment), last health, and last cost. An environment's scope is its target (the resource whose ID or name is the environment's `target`) and everything the target reaches by relations; the store applies it to whatever a provider returns, so an environment without a target stores nothing. A refresh replaces one provider's slice atomically, and a failed discovery changes nothing (BRK-177).

### Desired state

What should exist, as code, read from the repository's default branch once per new commit, the way `.github/breakaway-pipeline.json` is read (BRK-180). One file per environment, `.github/breakaway-infra/<environment>.json` (BRK-169). A file for an environment that doesn't exist shows as one to add; one for an observe-only environment is refused. An invalid file shows its error and keeps the last valid copy. `npx breakaway infra check` validates it locally and asks for the plan it would make (CLI-14).

### Plans

The exact difference an apply would make: the provider's diff, the cost change, the blast radius (from the inventory's relations), whether it can be undone or why not, the policy results, and a state (`draft`, `waiting`, `approved`, `rejected`, `applying`, `applied`, `failed`, `rolled back`). Its source is a pull request, drift, an envelope, an incident, or the deploy flow (BRK-178).

### Change

One flow for app and infrastructure: a pull request that changes a desired-state or policy file gets the plan and policy results as a check, and the board's pull request page shows them (BRK-185). Merging applies nothing: the plan made from `main` waits for approval.

### Policy

Rules as code beside the desired state, checked at plan time: what needs the owner, budgets, and a frozen environment refusing everything. A repository with no policy file gets the default, which BRK-171 set to **every plan, in every environment**; it still names each rule that applies (production, destructive or irreversible, access and exposure, a cost change over the limit) so the plan says why. The cost limit starts at 5 a month and the budget at 20 a month per environment (BRK-172), both changeable in the policy file. Each rule's result is on the plan in words (BRK-181). A repository's own policy can let some plans through; envelopes are the only standing exception to the default.

### Approvals

Approve and Reject are owner-only and cookie-only (BRK-182). A plan that waits sends one push linking to the plan page, so the owner approves from the phone (WEB-62). A plan a repository's policy lets through is approved with the rule that allowed it recorded; the default lets nothing through.

### Executor

The only path that changes infrastructure (BRK-183): take the environment's lock (BRK-179), start the apply runner for exactly one approved plan, record each step, verify health through the provider, roll back by itself if verification fails (BRK-171), release the lock, and write the outcome. One environment at a time; production last and only on approval.

The runner is **a workflow in the repository, started by the board on approval, with a write token per environment in a GitHub environment** (BRK-171), which is the trust Promote has today, so the board itself still holds no write credentials. CLI-12 renders it with `npx breakaway infra init`, like `pipeline init`. An observe-only environment is refused.

### Envelopes

Bounds the owner approves once on one environment, in any environment, production included (BRK-171): scaling bounds ("2 to 10 instances", "up to this much a month") and a **restart cap** (how many restarts in a window; 3 a day by default, set by the owner). A scaling rule in the repository, or a runbook, acts inside them through the executor with no press, writes an audit entry, and notes it quietly in the inbox. Once the restart cap is used up, the next restart becomes a plan that waits, with a push. Anything else, or outside the bounds, is a plan that waits (BRK-186, BRK-227).

### Drift

On the cron, desired against actual for each environment with a desired state. Drift shows on the environment and becomes one draft plan; the board never forces it (BRK-184).

### Break-glass

The owner may change something by hand. Marking the drift as break-glass records it and makes a follow-up task to put it into code by pull request (BRK-171); the board never proposes undoing it (BRK-187).

### Audit trail

Every plan, approval, apply, envelope action, lock release, and break-glass, appended once and never edited, redacted, kept at least a year (BRK-175). The environment page shows it.

### Signals

Health, the platform's alerts, and cost (BRK-172: no metrics, logs, or traces in the first version), normalised into one shape (source, environment, resource, kind, level, value, time, short text), redacted before it's stored, kept 7 days, with daily summaries kept 90 (BRK-190). The deploy flow's failed health checks and rollbacks become signals too (BRK-198), and the existing Cloudflare alert webhook feeds the stream as well as its routines (BRK-191).

### Runbooks

A runbook is a routine with a signal trigger: by environment, resource kind, and level, allowlisted fields only, deduplicated, under the routine's caps (BRK-196).

### Incidents

A signal that crosses a rule opens an incident: a task in the repository that owns the resource, tagged `+incident` (BRK-172), with a push for a production incident and a quiet inbox entry for any other, and steps on the task: **diagnose** (read only), **propose** (a plan, by pull request), **approve**, **apply**, **verify**, then a write-up and follow-up tasks. A repeat signal comments on the open incident (BRK-197, WEB-63). An incident never starts an agent by itself: a diagnosis agent starts only from a runbook the owner turned on, one by one (BRK-172, BRK-196).

### Cost

Each resource's estimate from the provider, summed by environment, repository, and owning task, with budgets in the policy and a signal near or over one (BRK-199, WEB-65). Every amount is marked as an estimate.

The owner works in euros, or any currency (BRK-171, BRK-172), while platforms price in US dollars. BRK-225 asks how the board converts (recommended: a rate the owner sets in Settings, because fetching rates would be a call to a service the owner didn't connect), which currencies, and where the choice lives; BRK-226 builds it. Until then limits and budgets are in the provider's currency.

### Short-lived environments

A task can ask for its own environment, made from the repository's template through a plan and removed through a plan when the task closes (BRK-200).

### Clean up

Anything nobody owns is flagged, and after a grace period a removal plan waits for the owner: removal is destructive, so it always asks (BRK-201).

### Golden paths

The owner's opinionated templates for a capability (a queue, a database, a new service) live in the repository; `npx breakaway infra add <template>` scaffolds the change into the checkout, and the agent opens an ordinary pull request (CLI-15).

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
- **BRK-225, cost in the owner's currency (open):** how to convert, which currencies, and where it's chosen. Only BRK-226 waits for it.

## Open questions

- Whether short-lived environments are made on claim, on a tag, or only on a press. BRK-200 starts with a tag or a press.
- Whether the plan check needs a new GitHub App permission (checks: write). BRK-185 adds an owner task if it does.

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
6. Change the same setting by hand on the platform. Within the hour the environment should show drift and a plan to put it back, waiting for you, and nothing should change by itself.
7. Trigger a test alert on the platform. An incident should appear in your inbox, as a task with its steps, and production ones should push.
8. Press **Freeze** on staging, and try step 5 again: the plan should be refused until you unfreeze.
