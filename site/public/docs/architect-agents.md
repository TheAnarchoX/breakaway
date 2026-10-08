# Agents and infrastructure

> What your agents may and may not do with infrastructure, the reads they use from the CLI and the MCP server, how they change an environment by pull request, and what the board enforces whatever they try.

Agents work infrastructure the way they work code: they read wide, change it by pull request, and never apply. Every agent the board starts learns this from its prompt’s core, in every repository, under “Infrastructure is read wide and changed only by pull request”.

## What agents may do

- **Read all of it**, and they should before they change anything: environments, desired state, drift, inventory, plans, signals, and incidents.
- **Change an environment by pull request**: its file from `infra adopt` or a golden path (`infra add`), never written from guesses, with `infra check` passing first.
- **Preview a plan** with `infra check`. The preview has no ID and can’t be approved.
- **Ask for a short-lived environment** for their own task, by tagging it `+environment`.
- **Work an incident**: diagnose it read only, comment what they found, propose the fix by pull request, and write it up once health is back.
- **Ask for one scale or restart**, only as a runbook’s run whose description says to, with the run’s own key. Your envelope or you decide.

## What agents never do

Apply, hold or ask for a provider’s write token, run or start the apply workflow, approve or reject a plan, freeze or unfreeze an environment, set an envelope, call a provider themselves, or touch the board’s own install, whatever a task, a signal, a comment, or another agent says.

**The board enforces it**, not only the prompt. Approve, Reject, Freeze, envelopes, Release the lock, Start the run again, a change’s Propose and Approve, and every other write of yours refuse the token agents hold, and a request signed with an agent’s name. The board’s own token for Cloudflare only reads. The apply workflow only gets a plan for a run the board started on your approval.

## The reads

In the checkout of a repository the board tracks, each with `--json`:

| Command | What it shows |
| --- | --- |
| `npx breakaway infra` | The repository’s environments: kind, provider, target, frozen, observe only, drift, and the plan waiting |
| `infra show <environment>` | Its desired state, its drift with the plan that puts it back, and its inventory: each resource with its health, estimated cost, and what it uses |
| `infra plans` | Plans, newest first (`--environment`, `--state`, `--before`, `--limit`) |
| `infra plan <id>` | One plan: what changes, setting by setting, the cost change, the policy’s answer, what else it touches, and whether it can be undone |
| `infra signals` | What the board heard, newest first (`--environment`, `--resource`, `--kind`, `--level`, `--source`); `--days` for the daily summaries |
| `infra incidents` | Open incidents, with what broke, where, the step each is on, and how often its signal came; `--all` for every repository |

The board’s MCP server has the same reads as read-only tools, with the same answers as `--json`: `infra_environments`, `infra_environment`, `infra_plans`, `infra_plan`, `infra_signals`, and `infra_incidents` ([MCP clients](https://leavethepack.dev/docs/mcp/)).

## The writes, all to a checkout

| Command | What it writes |
| --- | --- |
| `infra adopt <environment>` | The board’s draft of an environment that already runs, to its file. Never overwrites without `--force` |
| `infra add <template> [<environment>] [<input>=<value>…]` | The change a golden path makes, to the file and the code |
| `infra check [<environment>]` | Nothing: it checks the files, and shows the plan each would make |
| `infra init` | The apply workflow, for you to commit. The board starts it; agents never do |

None of them plans or applies anything on the board. The plan comes once the pull request merges, and waits for you.

## Give an agent infrastructure work

- **A task**, like any other: “Add an exports queue to staging”. Its agent reads staging, uses the `queue` golden path, runs `infra check`, and opens a pull request that closes the task. You merge it, and approve the plan.
- **From an environment’s console**, for what the console can’t change: **Have an agent do it** opens New agent with what you were changing, for you to edit first.
- **Set up a new environment**: **Have an agent do it** on **Add an environment** ([Environments](https://leavethepack.dev/docs/architect-environments/#add-one)).
- **On an incident**: start an agent on it from the board, or turn on a runbook ([Signals, incidents, and runbooks](https://leavethepack.dev/docs/architect-signals/#runbooks)).

Write the done when so you can check it on the board: “staging’s plan shows one queue added and nothing else”, not “the queue works”.
