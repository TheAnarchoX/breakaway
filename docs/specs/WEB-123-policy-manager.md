# WEB-123: A policy manager on the infrastructure console

Task: WEB-123 on the board, in the `architect` feature · Status: built (2.0.0: #451, then #467)

## The problem

The policy (`.github/breakaway-infra/policy.json`, BRK-181) decides which plans wait for the owner, but it was a file only: read in words in a repository's settings, changed by a pull request the owner writes by hand. BRK-258 kept it off the console on purpose: changing the rules on the screen where you approve could let one tired press widen what passes.

## What we chose

- **A Policy view per repository** (`#/infrastructure/policy?of=<repository>`), linked from Infrastructure, each environment's console, and the repository's settings: each environment's rules in words with the level each comes from (always, the repository's, the environment's own, or the default), its envelope read only with a link to where it's set, the recent plans with the rules that applied, and the policy changes.
- **Two levels in the file.** `environments.<name>` gains `access` (added to the repository's) and `allow` (replaces the repository's rules for that environment), next to its limits. Backward compatible: every file that checked still checks the same.
- **Editing is a change like an environment's.** The board writes `policy.json` on its own branch (`breakaway/infra/policy-<n>`) and opens the pull request, with the same branch writing, take-over detection, and merge settings and refusals as an environment's change (`writeChangeBranch`, `changePullFate`, `changeMergeSettings`, `mergeRoute`, `mergeRefusal`). Its own table is `infra_policy_changes`; the audit gets a `policy` entry in every environment the policy decides for.
- **Loosen detection** (`comparePolicies`, pure): per environment and for every other one, a raised limit, an access kind or setting dropped, or an allow rule not covered by one before it loosens; the reverse tightens. A rule is covered when another lets through every plan it does (its changes, kinds, environment kinds, and most changes). The same line in several environments is one line naming them. The plan check on the pull request says the same lines.
- **Loosening is never one press.** Approve answers with the exact lines that will no longer wait; only a second press that sends those lines back merges. Tightening is one press.
- **Not with a plan it would let through.** Approve refuses while a waiting plan would pass under the new policy, naming it.
- **It applies nothing.** Merging approves no plan and re-checks none; plans keep the result they were made with.

## Out of scope

- Editing `scaling.json` or envelopes here: they're shown read only, with a link to where they're set.
- A time-based "sitting" (a cool-down after approving a loosening): the waiting-plan rule covers the risk the task names without one.
- Auto-merge for a policy change: Approve merges when GitHub says it can, else says why (checks running, failing, conflicts, behind).

## Open questions

- Should a loosening also push? Today it doesn't: pushes stay for a waiting plan and a production incident.

## Done when

Each repository has a Policy view listing its rules in words and which recent plans they applied to; editing proposes `policy.json` through the board's own pull request with the rule diff in words; a loosening change needs a second confirm naming what will no longer wait and can't be approved while a plan it would let through waits; tightening is one press; nothing applies or approves by itself.

## How to check it

1. Open Infrastructure and press **Policy**. Each environment lists its rules in words, and recent plans show which rules applied.
2. Press **Change the policy**, raise the cost limit. The line reads **Loosens**. Press **Propose the change**: a pull request opens on GitHub with the same lines.
3. Back on the Policy view, press **Approve**. The board names what will no longer wait for you; only **Loosen it** merges it.
4. Propose a lower budget instead: **Approve** merges it in one press.
