# IDEA-2 · Review and merge pull requests on the board

Task: IDEA-2 on the board · Status: built (before the move to breakaway, under the first install's work IDs)

## Problem

On GitHub the owner now only does four things with a pull request: read the diff, see whether it conflicts or has fallen behind `main`, press **Update branch** (or ask an agent to fix a conflict), and press **Merge**. Each means leaving the board, where the PR, its task, its checks, and its agent already are. The owner wants those four things on the board, plus whatever else greatly shortens that loop, all in the `now` horizon.

## Fit

- **Read-only is a settled decision.** [CLD-24](CLD-24-github.md) approved a read-only GitHub App that "never writes to GitHub", and `AGENTS.md` says the owner merges every pull request. Merge and Update branch are writes. They fit the intent (the owner is still the one who merges) but change the App's permissions, so the owner has to approve that first: task below, `+decide`.
- **Agents must not gain a merge button.** The board's API token is shared by the owner's browser and by every agent, but the board already tells them apart (`authenticate()` returns `cookie` for a signed-in browser and `token` for a bearer). Merge and Update branch accept the **cookie only**, from this origin, so an agent, the CLI, and a cloud session cannot merge even though they hold the token.
- **`Protect main` stays in charge.** GitHub still enforces the ruleset (passing `Test and build`, branch up to date). The board disables the button with the reason first, and if GitHub refuses anyway it shows GitHub's message. It never bypasses anything.
- **Production changes.** Merging to `main` deploys. The merge dialog says so, and says whether the PR changes files that run in a Worker or is docs only (the board already knows: `.github/deploy-paths.json`).
- Nothing touches a settled decision; this is board work with no personal data.

## Design

Everything lives in the board's **GitHub** view and on the task's side view, on the PR row that already shows checks and reviews.

**1. Pull request page (read).** Selecting a PR opens a page: title, description, linked tasks, branch and author, and

- **Status strip:** checks (with links to the failed run and its log), reviews, unresolved review threads, and a single verdict: **Ready to merge**, **Behind main**, **Has conflicts**, **Checks failing**, **Checks running**, or **Waiting on review**. The verdict comes from GitHub's `mergeable` and `mergeable_state` (read on open, refreshed by the webhook sync), not from a guess.
- **Diff viewer:** the file list (with added and removed counts, and a filter for "files that run in a Worker"), and per-file unified diffs from GitHub's files endpoint, with a split view on wide screens. Large or binary files show "too large to show" with a link to GitHub. Syntax colouring is out (see below); the diff uses the design tokens, works in both themes, and is keyboard reachable with a text alternative for the add and remove markers (not colour alone).
- **Conversation:** review comments and threads, read-only; replying happens on GitHub for now.
- **Diffs are fetched when opened**, through the installation token, and are not stored: the sync keeps only the PR summary it stores today.

**2. Update branch (write).** Shown when the verdict is **Behind main**. Calls GitHub's update-branch endpoint (a merge commit of `main` into the head, never a rebase or force-push). Confirm dialog, then the status strip goes back to "Checks running" until the webhook says otherwise. If the update conflicts, GitHub says so, the verdict becomes **Has conflicts**, and 3 takes over.

**3. Fix with an agent (write to the board only).** Shown on **Has conflicts** and **Checks failing** (and for unresolved review comments, as **Address review comments**). It starts a cloud agent the way Fix with an agent works for alerts ([CLD-35](CLD-35-cloud-agents.md)): the PR's task if it has one, otherwise a task made from the PR (Tech debt for a Dependabot PR). The routine gets `Mode: fix-pr`, the PR number, and what is wrong (conflict, or the failing check names), and follows the rules already in the system prompt for driving a PR to green: merge `main` in without rewriting history, fix, run the checks, push, and never merge. The claim, limits, hourly cap, and live log are the ones agents already have. The button is disabled with the reason when the routine isn't connected, the task is claimed, or an agent is already on that PR.

**4. Merge (write).** Shown on **Ready to merge**. A dialog names the PR, the task(s) it closes, whether it will deploy, the method (merge commit or squash, the two the repo allows, defaulting to the last one used), and the commit title, which is the PR title as `AGENTS.md` asks. **Merge** then calls GitHub's merge endpoint with the head SHA the owner saw, so a push in between refuses the merge instead of merging something unreviewed. Afterwards the board's existing flow marks the task done and, once the deploy runs, shipped. Never enabled for a PR whose verdict isn't Ready to merge, and never for a draft.

**5. Also, because they shorten the loop:**

- **An inbox order.** The GitHub view's PR list sorts by what needs the owner: Ready to merge first, then conflicts and failures (with their Fix with an agent), then behind, then running. A count of "ready to merge" sits on the nav item so the board is worth opening.
- **Merge when green.** On a PR that isn't ready yet, **Merge when green** turns on GitHub's auto-merge (needs "Allow auto-merge" turned on in the repository settings, an owner task) with the same method and head-SHA check, and can be turned off. The owner's decision is recorded as an Activity event.
- **Dependabot.** Dependabot PRs show a **Safe to merge?** action that starts an agent in test-and-review mode (`AGENTS.md` already lets an agent test one and say whether it's safe); its answer is a note on the PR's task and a comment on the PR, and the owner still presses Merge.

**Edge states.** GitHub not connected, or connected with the old read-only permissions: the buttons that write are hidden and the page says what permission is missing, with the fix. Signed in with a bearer token only (the CLI): the page reads, the write buttons are absent. The PR merged or closed while the dialog was open: the dialog says so and closes. GitHub refuses (checks, ruleset, stale head): show its reason, change nothing. Offline: the page shows the last synced state marked as stale; write buttons are disabled.

## Privacy

No personal data is involved. The board additionally handles code diffs of the repository in the owner's browser only, not stored. The GitHub App gains write scopes, so the [key-leak guidance](../tasks.md#github) matters more: rotate the key if it leaks.

## Out of scope

- Reviewing in the sense of approving or requesting changes on GitHub, and inline comments on diff lines. The owner reviews by reading and merging; if that changes, it is a follow-up.
- Editing files, resolving conflicts by hand in the browser, and rebasing. Conflicts go to an agent.
- Syntax highlighting and a full code browser.
- Merging from the CLI or by an agent, ever.
- Merging PRs in other repositories.

## Questions for the owner

1. Is it right that the board's GitHub App gets write access (pull requests and contents) for merge and update-branch, changing CLD-24's "read-only"? The alternative is a second, separate App that only the merge endpoints use.
2. Which merge methods should the dialog offer, and which is the default? (The repo allows a merge commit or a squash.)

## Done when

- The PR page shows the verdict, checks, and a diff, and matches GitHub on a set of PRs (clean, behind, conflicting, failing, draft, Dependabot, docs-only).
- Update branch, Merge, and Merge when green work only from the signed-in browser, refuse when GitHub refuses, and use the head SHA the owner saw; tests prove a bearer token gets a 403 on them.
- Fix with an agent starts an agent that ends with a pushed fix or a note, never a merge.
- `docs/tasks.md` and the CLD-24 spec describe the new permissions and the cookie-only rule.
