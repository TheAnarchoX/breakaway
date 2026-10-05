# IDEA-16 · breakaway on Cloudflare: Artifacts and Workers Builds next to GitHub

Task: IDEA-16 on the board · Status: approved (shaped 1 Oct 2026 from the brainstorm in `CLD-154` and the owner's answers on `CLD-155`; merged by the owner, and BRK-11 and BRK-35 are decided). Not built yet: its tasks, BRK-12 to BRK-36, are open.

## Problem

The board runs the work, but its git layer is borrowed from GitHub: pull requests, checks, reviews, merges, deploy records, webhooks, and one GitHub App. GitHub was built for people working in branches and pull requests. The board already does the part on top that agents need (atomic claims, dependencies, routines, live output, pings, decisions) and leaves the rest to GitHub.

On 1 Oct 2026 Cloudflare put Artifacts in open beta: git repositories made by the million for agents, with a Workers binding, repository-scoped tokens, and an event on every push ([blog](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)). Workers Builds now builds and deploys a Worker straight from an Artifacts repository, with a Preview for every branch. The board already runs on Workers, a Durable Object, and the Secrets Store, so the board, its data, and the code it manages could all live on one platform.

What Artifacts lacks is the layer GitHub adds on top of git: pull requests, reviews, required checks, a merge, diffs, and webhooks to any URL. **That missing layer is what the board adds.** Cloudflare's post asks "How do you review everything they produce? How do you keep track of not just what changed, but why a change was made?" The board already answers "how do agents know what other agents are working on"; this is about the rest.

## What the owner decided (`CLD-155`, 1 Oct 2026)

| Question | Answer | What it means here |
| --- | --- | --- |
| Extend or replace? | **Extend**: GitHub and Artifacts side by side, chosen per repository. | A repository on the board has a host. GitHub can still go later, one repository at a time. |
| Moving between them | Decide later, once Artifacts reaches some feature parity. What's sure: an agent working on Artifacts gets a repository of its own. | A fork per claimed task (section 2). Moving, mirroring, and a hybrid wait for `CLD-181`. |
| Where agents run | **Claude routines, as today.** Using the inference API is a separate, later idea. | Section 8. Agents on Cloudflare sandboxes are out of scope. |
| Checks and deploys | **A CI Workflow checks every push; Workers Builds deploys `main` after the owner's merge.** | Sections 4 to 6. The 29 Sep 2026 GitHub Actions decision stays for repositories on GitHub. |
| A Cloudflare API token on the board | **Yes**: the goal is to show Workers Builds the way the board shows GitHub Actions runs. | Section 6, and `CLD-163` finds the narrowest token. |
| Repositories in the EU | **Yes.** | Every namespace is made with the `eu` jurisdiction, which can't be changed later. |
| Which repository first | **breakaway, once public on GitHub; samewave after a soak**, but deploys, promotions, and rollbacks need near one-to-one results with GitHub Actions before any move. | Section 10 (`CLD-179`) is the condition for section 11. |

The owner also asked (board message, 1 Oct 2026) for all of this to wait until multi-repo (IDEA-14) and breakaway as a project of its own (IDEA-13) are done: every task below is on the **later** horizon.

## Fit

- **Free, and one person can run it.** breakaway stays free. Everything runs on the Cloudflare account the install already runs on, with no new service to keep alive. The owner sets up the namespaces, event subscriptions, and the Workers Builds connection once; the board cleans up forks.
- **Settled decisions.**
  - The 29 Sep 2026 decision (GitHub Actions, not Workers Builds) holds for repositories on GitHub. On Artifacts, Workers Builds deploying `main` is safe because the board's Merge only moves `main` to checked code, which is the wait Workers Builds couldn't do on GitHub.
  - "The owner merges every pull request" becomes "every change", still owner-only and cookie-only.
  - Agents still never deploy, promote, merge, or touch production, and the CI Workflow never deploys.
  - IDEA-14's "Repositories outside GitHub" moves into scope, and its "no Cloudflare API token on the board" is replaced by the owner's yes for a read-only use (`CLD-167` records both in `decisions.md`).
- **What breakaway isn't** (`AGENTS.md`): nothing there is touched.

## What Cloudflare offers

Checked against Cloudflare's docs on 1 Oct 2026. Artifacts is a beta, so recheck before building.

| Piece | What it is | What it means for the board |
| --- | --- | --- |
| [Repositories and namespaces](https://developers.cloudflare.com/artifacts/concepts/repositories/) | Each repository is its own git service with its own history, tokens, and remote, inside a namespace. A namespace can be pinned to the EU or the US when it's made, and that can't be changed afterwards. Names use letters, digits, `.`, `_`, and `-`. | One namespace per install (or per environment), in the EU like the board's Durable Object (`TASKS_JURISDICTION`). |
| [Git remote](https://developers.cloudflare.com/artifacts/api/git-protocol/) | `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git` over smart HTTP. Push is protocol v1 only, and there's no partial-clone `filter`. | Any git client works: Claude Code, a sandbox, the owner's machine. |
| [Tokens](https://developers.cloudflare.com/artifacts/api/rest-api/#tokens) | Per repository, `read` or `write`, from 60 seconds to a year (24 hours by default), shaped `art_v1_<40 hex>?expires=<unix>`, revocable. No permissions per branch. | A write token can push to any branch, `main` included, so isolation has to come from separate repositories (see "A task gets a workspace"). |
| [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) | `create`, `get`, `list`, `import`, `delete`; per repository `createToken`, `listTokens`, `revokeToken`, `fork`, `log`, `readCommit`, `readTree`. The REST API adds file, blob, and raw reads, and the blog's example also calls `readFile` and `info` on the binding. | The board's Worker manages repositories with no Cloudflare API token. |
| [Forks](https://developers.cloudflare.com/artifacts/concepts/best-practices/) | A fork is a new repository that starts from another's history. Cloudflare's advice is one repository per unit of autonomous work ("If you have 10,000 agents, create 10,000 repos"), and not one shared repository as a queue for many agents. | A fork per task. |
| [Import](https://developers.cloudflare.com/artifacts/guides/import-repositories/) | From a **public** HTTPS remote (GitHub, GitLab), optionally shallow. | breakaway, once public, imports in one call. samewave is private and can't: its history has to be pushed in. |
| [Events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) | Account-wide: `cf.artifacts.repo.created`, `.deleted`, `.forked`, `.imported`. Per repository, through Queues event subscriptions: `.pushed`, `.cloned`, `.fetched`, `.token.created`, `.token.revoked`. A Worker can also declare a `triggers.events` entry for `cf.artifacts.repo.pushed` filtered to a whole namespace, which starts a Workflow on every push to any repository in it. A push carries `ref`, `before`, `after`, and the commits (message, author and committer name and email, parents). | Pushes reach the board without polling, for every task's fork, with no subscription per fork. |
| [CI on Workflows](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/) | `@cloudflare/ci`: a `CIWorkflow` whose `ci.runner({ name, command, cache })` steps run in sandboxes (Containers), with installs cached as snapshots in R2. A failed step stops the Workflow before it deploys. | Checks for Artifacts repositories: the job `Test and build` does on GitHub. |
| [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/) | Connects a Worker to an Artifacts repository, set up in the dashboard. A push to `main` (the only production branch it supports) runs `npx wrangler deploy`; a push to another branch runs `npx wrangler preview`. It sends `cf.workersBuilds.worker.build.started`, `.succeeded`, `.failed`, and `.canceled` events, with `workerName`, `branch`, and `commitHash`. | Deploys after a merge, and Previews of branches. It watches one repository, so task forks need a way in (see "Checks, previews, and deploys"). |
| [Previews](https://developers.cloudflare.com/workers/previews/) | A Preview per branch under the same Worker, with its own variables, secrets, and bindings and a fresh Durable Object namespace. Public unless put behind Access; up to 500 per Worker. | A "try this change" link on every task. |
| [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) and [Sandbox SDK](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) | Mounts a repository without a full clone; a sandbox template that hands each sandbox its own repository. | Where agents could run on Cloudflare later. |
| [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) and [price](https://developers.cloudflare.com/artifacts/platform/pricing/) | 10 GB a repository, 1 TB an account, unlimited repositories, 2,000 requests per 10 seconds per namespace and per repository. Workers Paid only: 10,000 operations and 1 GB-month included each month, then $0.15 per 1,000 operations and $0.50 per GB-month. Billing starts 15 Oct 2026. | Pennies at this size. The CI sandboxes (Containers) and Workflows will cost more than the repositories. |

What Artifacts doesn't have: pull requests, reviews, issues, required checks or branch protection, a merge or compare API, diffs, Dependabot or security alerts, secret scanning (samewave's private GitHub repository has none either), and webhooks to any URL. Its dashboard shows files and commits, not diffs. **That missing layer is what the board would add.**


## Design

Everything above the host stays as it is: Taskwarrior and sync, work IDs, claims, dependencies, decisions, pings, routines, live output, and the Agents view.

### 1. A repository has a host

IDEA-14's `repos` row gets `host` (`github` by default, so samewave's row doesn't change) and, for Artifacts, the namespace, the repository's name, and its remote (never a token). The board talks to a small host interface: changes, a change's commits and files, checks, merge, and events in. `GitHubClient` is one implementation, and an `ArtifactsClient` on the binding is the other, so the board needs no API token to manage repositories. GitHub-only parts (the App, Dependabot alerts, Deployments, Promote) stay features of GitHub repositories and show only there, the way IDEA-14 makes the pipeline optional. (`CLD-167`)

### 2. A task gets its own repository

The owner's rule: an agent working on Artifacts makes a repository version of its own, which is what namespaces and repositories are for. Cloudflare's advice agrees ("If you have 10,000 agents, create 10,000 repos").

- When an agent claims a task in an Artifacts repository, the board forks it into `<repo>-<wid>` (`breakaway-cld-200`, default branch only).
- `workspace <ID>` in the CLI prints the fork's remote and a write token for that fork only, while the agent holds the claim: **the claim is the key.** Tokens last an hour or two, are renewed while the claim holds, and are revoked on release, takeover, or finish.
- Only the board ever holds a write token for the repository itself, so agents can't push to `main` at all, instead of being told not to.
- Tokens never go into a payload, comment, ping, or log: the session log's `redact()` (`scripts/tasks/session-log.js`) and the ping's token check (`src/ping.js`) learn `art_v1_`. (`CLD-168`)

### 3. Changes instead of pull requests

A **change** is a task's fork measured against `main`: its head, its base, the files it touches, its checks, its review, and a verdict. The pull request page (`CLD-55`, `CLD-57`: verdict, checks, reviews, the diff file by file, Merge) shows changes too, so reviewing works the same on either host.

- A change belongs to its task by construction, so there's no `Closes <ID>.` to forget.
- A fork still being pushed to is a draft; `ready <ID>`, the CLI's version of opening a pull request, asks for review.
- Diffs are read live from trees and blobs and never stored. Whether that runs in the Worker or a sandbox is `CLD-160`'s answer. (`CLD-169`)

### 4. Checks

A Workflow triggered by `cf.artifacts.repo.pushed` across the namespace runs a repository's checks with `@cloudflare/ci`: one install with the lockfile cached, then the steps (lint, type-check, test, build for this repository) in parallel. The steps, and which are required, come from a small file in the repository, so each repository brings its own. Each step reports to the board as a check on the change's exact head, with its log. A cost cap (the owner's answer on `CLD-157`) stops new runs when reached. The Workflow never deploys. (`CLD-170`)

### 5. Review, Merge, and the merge queue

- **Review.** When a change is ready, the board can start a review agent on it. Its findings land on the change as comments by file and line, shown like GitHub reviews. `claude-review` and `brand-review` become routines a repository opts into. (`CLD-176`)
- **Merge stays the owner's**, cookie-only. The board refuses it until the required checks passed on the change's exact head and the change is up to date with `main`: what `Protect main` does on GitHub, enforced where the merge happens. A merge Workflow squashes or fast-forwards that head onto `main` with the board's token. The board then finishes the task, revokes the fork's tokens, and deletes the fork after a grace period.
- **A merge queue for free.** A repository's state lives in one Durable Object, so merges line up by themselves. When `main` moves, a clean change is updated; a conflicting one can start a fix agent (`Mode: fix-pr`). (`CLD-171`)

### 6. Workers Builds: builds, deploys, and Previews

- **Deploys.** The owner connects a Worker to an Artifacts repository in Workers Builds. After the owner's merge, Workers Builds deploys `main`.
- **Status on the board.** The owner wants Workers Builds shown like GitHub Actions runs today. The board takes the `cf.workersBuilds.worker.build.*` events and reads builds and logs through a Cloudflare API token, and shows each build by commit and branch with its state and log link: next to the change it came from, and as the deploy record for `main`. Read only: the board never starts or cancels a build. The cron reconciles missed events. (`CLD-172`)
- **The token.** Cloudflare's docs (1 Oct 2026) say the Builds API takes only a **user-scoped** token with *Workers Builds Configuration: Edit* (and *Workers Scripts: Read* for the Worker's tag); account-owned tokens aren't supported yet. An edit token could change build settings if it leaked, so `CLD-163` finds the narrowest working token, or shows the events alone are enough, before the owner makes it (`CLD-166`).
- **Previews.** Workers Builds builds the branches of the one repository it's connected to, not forks. `CLD-162` picks the way in: `wrangler preview --name <wid>` from the CI runner, or the board copying a ready change's head to a `preview/<wid>` branch only it writes. Either way a ready change gets a Preview link, behind Access for anything with real data, removed when the change merges or is dropped. (`CLD-173`)

### 7. Routines on Cloudflare's events

Today a routine starts by hand, on a schedule, from a webhook, from a Cloudflare alert, or on three GitHub events (`ROUTINE_GITHUB_EVENTS`). Cloudflare's events arrive at a `queue()` consumer on the board's Worker, read through an allowlist like the GitHub one:

| Routine event | From | For example |
| --- | --- | --- |
| `change_ready`, `change_merged` | the board | review every ready change; write release notes on a merge |
| `main_pushed` | `cf.artifacts.repo.pushed` on `main` | update the docs; check the changelog |
| `checks_failed` | the CI Workflow | start a fixer on the failing change, with the step's log |
| `build_failed`, `build_succeeded` | `cf.workersBuilds.worker.build.*` | start a fixer when `main` fails to build; smoke-test a fresh Preview |
| `repo_imported` | `cf.artifacts.repo.imported` | read a new repository's README and AGENTS.md and propose its areas |

Each delivery is deduplicated by a key (like `routine_gh_seen`), carries only allowlisted fields (never commit emails), and goes through the same caps as every start. Deliveries can repeat or arrive late, so the five-minute cron also reconciles from each repository's `log`. (`CLD-174`)

### 8. Agents

Agents stay Claude routines. A cloud session starts in the GitHub repository its routine was saved with; for an Artifacts task, the agent clones its fork with the token from `workspace <ID>`. The routine's cloud environment allows `<ACCOUNT_ID>.artifacts.cloudflare.net` next to the board's host. Whether a session can push to a remote that isn't GitHub is `CLD-159`; the routine prompt, the tasks skill, and the docs learn the flow in `CLD-175`. Agents on Cloudflare sandboxes with the Agent SDK are paid per API token, so they're a separate idea.

### 9. Connections and reading code

- **Connections** gets a Cloudflare section per Artifacts repository: the binding answers, the namespace and its jurisdiction, the last event and CI run, the last build of each connected Worker, whether the API token works (by state only), and what it can't check (the Workers Builds connection, event subscriptions, the routine's allowed host). (`CLD-177`)
- **Reading code.** Cloudflare's dashboard shows files and commits but no diffs, so the board gets a small browser for Artifacts repositories: the tree, a file, and the commit log, linked from a change's diff, read live. It's the biggest piece of new interface. (`CLD-178`)

### 10. The pipeline on Cloudflare, before any move

The owner's condition for moving any repository: deploys, promotions, and rollbacks get near one-to-one results with GitHub Actions. The pipeline samewave runs on GitHub (staging on merge, a build made once, migrations in order, a health check, automatic rollback, `DEPLOYS_PAUSED`, releases, and the board's Promote and Roll back buttons) is the bar. `CLD-179` writes that spec: every step mapped to Workers Builds, Workflows, and Worker versions and deployments, with each gap named. Its build tasks come after the owner approves it.

### 11. Moving repositories (decided later)

Moving a repository from GitHub to Artifacts with its tasks and work IDs, mirroring `main` back to GitHub (for a public face and Dependabot alerts), and a hybrid were in the brainstorm. The owner put them off until there's parity. `CLD-181` asks them after the rehearsal (`CLD-180`) and the pipeline spec, with breakaway first once it's public (`OPS-28`) and samewave after a soak. Until then the board can register Artifacts repositories next to GitHub ones, but nothing moves.

### Later, if it proves useful

- **Overlap warnings.** The board knows which files every open change touches: show where two overlap, warn on claim, and offer the smaller one first in the merge queue. It works for GitHub pull requests too. (`CLD-182`)
- **Why, in git notes.** At each push, a short redacted summary of the agent's session as a git note (never a transcript), shown with the commit. (`CLD-183`)

## Spikes

Artifacts is a beta, so a few things get tried before anything is built, on a dev namespace in the EU and never production. Agents have no Cloudflare credentials and never deploy, so first the owner chooses how the spikes reach Cloudflare (`CLD-157`: through a dev-namespace binding on the board, `CLD-164`; the owner running scripts agents write; or a dev-only token), how many namespaces there are, and when the CI cost gets a cap. Then:

| Spike | Question |
| --- | --- |
| `CLD-159` | Can a routine session clone and push to an Artifacts fork with a token the board minted, and does anything leak the token? |
| `CLD-160` | What does the binding really offer, and can diffs and merges run in the Worker or need a sandbox? |
| `CLD-161` | Do namespace-wide push events and Workers Builds events reach the board, how fast, and what do they carry? |
| `CLD-162` | What do this repository's checks cost in `@cloudflare/ci` runners, and which way do Previews of forks work? |
| `CLD-163` | Which Cloudflare API token, with which scopes, lets the board show Workers Builds, and is one needed at all? |

A private repository pushed into Artifacts with its history (the brainstorm's sixth spike) waits for the move decision.

## Privacy

- Push events name commit authors and their emails. The board keeps hashes, messages, and the files touched, and drops the emails; routine payloads never carry them.
- Repositories sit in EU namespaces (`CLD-155`). `CLD-167` checks what this changes in the board's processing of personal data, and moving a repository's code (`CLD-181`) gets its own check.
- **Security.** Repository-scoped, short-lived tokens; a repository per task; only the board writes `main`; tokens kept out of everything the session hook and pings send; the Cloudflare API token read-only in use, in the Secrets Store, and as narrow as Cloudflare allows.

## Risks

- Artifacts is a beta: names and shapes may change, and billing starts 15 Oct 2026. Recheck the docs before each build task.
- If routine sessions can't push to a remote that isn't GitHub (`CLD-159`), Artifacts work waits for agents that run elsewhere, which is a separate decision.
- The Builds API's token is user-scoped with edit rights today; the board must not depend on it more than the owner is comfortable with (`CLD-163`).
- No security alerts for Artifacts repositories. Until a mirror exists (`CLD-181`), a scheduled `pnpm audit` routine can stand in.
- Events arrive at least once and possibly late: deduplicate, and reconcile from the cron.
- Lock-in is low: it's git, and moving back is a push.

## Out of scope

- Replacing GitHub, moving any repository, mirroring, and a hybrid (`CLD-181` decides, later).
- samewave's pipeline on Cloudflare beyond the parity spec (`CLD-179`).
- Agents on Cloudflare sandboxes or the inference API (a separate idea).
- Several people, teams, or accounts; a hosted or paid breakaway.
- Agents deploying anything, or the board touching production.

## Order

IDEA-14 (multi-repo) and IDEA-13 (breakaway as a project of its own) come first, as the owner asked; every task here is on **later**, and the build waits for IDEA-14's registry (`CLD-122`, `CLD-124`) and its rehearsal (`CLD-130`).

1. The owner's spike setup (`CLD-157`, `CLD-158`, `CLD-164` if chosen) and the spikes.
2. The host and the Artifacts client, then a repository per task, changes, checks, Merge.
3. Workers Builds on the board and Previews; routines on events; review; Connections; reading code.
4. The rehearsal with a scratch repository (`CLD-180`) and the pipeline spec (`CLD-179`).
5. The move decision (`CLD-181`), with breakaway first once it's public.

## Done when

- An Artifacts repository sits on the board next to GitHub repositories, and a task in it goes from claim to merged and deployed: the agent works in its own fork with a token only for that, checks gate the owner's Merge, Workers Builds deploys `main`, and the board shows its builds like GitHub Actions runs.
- Routines start on Cloudflare's events, Connections shows each Cloudflare link, and samewave's GitHub flow is unchanged throughout.
- The rehearsal (`CLD-180`) has passed, and the owner has the pipeline spec and the move decision in front of them.

Tasks (all on **later**, all waiting for IDEA-16):

| Task | What | Waits for |
| --- | --- | --- |
| `CLD-157` | Decide how the spikes reach Cloudflare, the namespaces, and the CI budget (owner) | IDEA-16 |
| `CLD-158` | Make the dev namespace in the EU and allow it in the routine's environment (owner) | `CLD-157` |
| `CLD-164` | A dev-namespace binding on the board for the spikes (only if `CLD-157` picks it) | `CLD-157` |
| `CLD-159` | Spike: an agent session pushes to an Artifacts fork | `CLD-158` |
| `CLD-160` | Spike: the binding's surface, diffs, and merges | `CLD-158` |
| `CLD-161` | Spike: push and build events reach the board | `CLD-158` |
| `CLD-162` | Spike: checks and a Preview in `@cloudflare/ci` runners | `CLD-158` |
| `CLD-163` | Spike: Workers Builds status and the narrowest API token | `CLD-158` |
| `CLD-166` | Make the board's Cloudflare API token (owner) | `CLD-163` |
| `CLD-167` | A host on the registry and an Artifacts client (main task) | `CLD-122`, `CLD-124`, `CLD-160` |
| `CLD-168` | A repository per claimed task, and its token through the CLI | `CLD-167`, `CLD-123`, `CLD-159` |
| `CLD-169` | Changes on the pull request page, and `ready <ID>` | `CLD-168`, `CLD-125` |
| `CLD-170` | A CI Workflow checks every push | `CLD-169`, `CLD-161`, `CLD-162` |
| `CLD-171` | Owner-only Merge, required checks, and a merge queue | `CLD-170` |
| `CLD-172` | Workers Builds on the board | `CLD-167`, `CLD-161`, `CLD-166` |
| `CLD-173` | A Preview link on every ready change | `CLD-172`, `CLD-170` |
| `CLD-174` | Routines on Cloudflare events | `CLD-170`, `CLD-172`, `CLD-127` |
| `CLD-175` | Teach agents the Artifacts flow | `CLD-168`, `CLD-127` |
| `CLD-176` | Review agents on changes | `CLD-169`, `CLD-174` |
| `CLD-177` | Connections for Cloudflare | `CLD-172`, `CLD-129` |
| `CLD-178` | Read files and commits on the board | `CLD-167` |
| `CLD-179` | Spec: the pipeline on Cloudflare with GitHub Actions' results | `CLD-162`, `CLD-163` |
| `CLD-180` | Try Artifacts with a scratch repository (owner) | `CLD-171`, `CLD-173`, `CLD-175`, `CLD-176`, `CLD-177`, `CLD-178`, `CLD-130` |
| `CLD-181` | Decide moving between GitHub and Artifacts (owner) | `CLD-180`, `CLD-179`, `OPS-28` |
| `CLD-182` | Overlap warnings | `CLD-169` |
| `CLD-183` | Why, in git notes | `CLD-168` |
