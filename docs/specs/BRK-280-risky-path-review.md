# BRK-280 · Risky-path review

Task: BRK-280 on the board, in the `agent-conduct` feature · Status: draft

## Problem

In the Architect chase, tests passed on three unsafe defaults that only a person reading the code caught: a branch force-pushed over whatever had the board's name, an incident paged on one failed probe, and a permission struck that another environment had just read. Tests check what the author thought of. The paths where a wrong default merges, deletes, overwrites, leaks, or pages the owner need a second reader who isn't the author, every time, before Merge when green can merge them.

## What it became

### 1. A repository lists its risky paths

`.github/breakaway-infra/risky-paths.json`, beside the policy:

```json
{
  "version": 1,
  "areas": [
    { "name": "Merging", "why": "What merges without a person pressing Merge.", "paths": ["src/store-github.js", "web/src/lib/autopilot.js"] },
    { "name": "Workflows", "why": "What runs with write tokens.", "paths": [".github/workflows/"] }
  ]
}
```

- `paths` are from the repository's root: `**` is any number of folders, `*` anything within one name, and a path ending in `/` covers everything under that folder. Up to 30 areas and 60 paths.
- The board reads it from the **default branch**, from the folder listing it already makes for the desired state, so a repository without one costs no call, and a pull request can't take its own paths off the list. A change to the list is reviewed under the list as it was.
- `risky-paths` is reserved, like `policy` and `scaling`: no environment can take the name.
- breakaway's own list names merging, git refs and force, credentials and tokens, incidents, pings, and pushes, deletes and applies (with `.github/workflows/` and the apply template), and the list itself.
- A list that doesn't check reviews nothing, and the sync's GitHub error says why.

### 2. A pull request that touches one gets a separate reviewer

During a sync, each open pull request whose head moved is looked at once (three a sync, the rest at the next):

- A **draft** waits until it's published.
- One that touches a listed path, closes an open task, and comes from the repository itself starts a **reviewer**: a separate session through the repository's routine, named `claude-<id>-risk`, with `Mode: risk-review`, `Pull request: #n`, and `Risky paths:` naming the areas and files. It **never takes the task's claim**: the author keeps it. Its run is kept apart from `agent_runs`, so it never shows as the task's agent, but its start counts toward the board's and the repository's starts an hour, and while it reads it counts toward the board's agents at once.
- With no room (agents at once, starts an hour, Claude's 429), it **waits**, holds Merge when green, and tries again at the next sync. When the routine can't start one at all (not connected, a prompt with a `<…>` left in it), nothing holds the pull request, and the check says so.
- A pull request from a fork, or one that closes no open task, starts no reviewer: the check says to read those paths before merging.
- Each new head is reviewed again, up to **3 heads** a pull request; after that the board starts no more, and the check says so.

The reviewer's instructions are a mode in the core ("Reviewing risky paths"): read the risky files whole and their callers; look for what could merge, delete, overwrite, force-push, leak, hold a credential too long or too wide, or page on one bad reading; check first runs, empty values, retries, races, and error answers; flag a platform fact (a limit, price, default, or behaviour) the diff states without a source (BRK-282); and mark a finding **blocking** only for a harm it traced from a real caller. It never claims, pushes, fixes, or answers.

### 3. Posted as a check

One check, `breakaway: risky-path review`, on the head commit, updated in place:

| State | Check | Holds Merge when green |
| --- | --- | --- |
| A reviewer is reading it, or waits for room | in progress | yes |
| Reviewed, a blocking finding has no answer | action required | yes |
| Reviewed, nothing blocking, or every blocking finding answered | success | no |
| No reviewer: a fork, no task, the routine refused, or 3 heads reviewed | neutral | no |

The summary lists the areas and files, the reviewer's summary, each finding with its file and line, and each answer. The check is public: the reviewer's prompt says nothing the repository's **Never share** lists goes in it. The pull request's page on the board gets `riskReview`, and the GitHub view's list gets `riskHold`.

### 4. The reviewer answers, the author answers back

- `npx breakaway risk-review <task> --pr <n> --file <findings.json>`: `{ "summary": "…", "findings": [{ "severity": "blocking" | "note", "text": "…", "path": "…", "line": 12 }] }`, up to 30 findings. Only the agent the board started for that pull request's current head is taken, and never the task's claim holder. It's a comment on the task too. Without `--file`, it prints the task's reviews and answers.
- `npx breakaway risk-answer <task> <finding> "<what changed, or why it's safe>"`: the agent holding the task, or the owner from the signed-in board. Not the reviewer. Every agent holds the bearer token, so an answer without a name is refused there. Answering again replaces it.

### 5. The hold

While a review holds (the table above):

- **Merge when green** (`auto-merge` on) is refused with the reason, and the owner's pull request settings (Keep branches up to date and Merge when green) skip the pull request, including the merge they'd make once it's ready.
- When a reviewer starts or posts a blocking finding on a pull request with GitHub's auto-merge already on, the board turns it off, so it can't merge on green before the author answers. Turning it off is never held.
- The owner's own **Merge** press is never held: merging is the owner's.

## Out of scope

- A view for the review on the pull request's page in the web app; the page's data carries it, and GitHub shows the check. A follow-up can draw it.
- Making the check required in branch protection: that's the owner's choice on GitHub.
- The security watcher (IDEA-59), which this becomes the first job of.
- Reviewing the board's own changes to infrastructure (the plan check already does).

## Open questions

- Whether a review should also hold the owner's own Merge press with a confirm. Today it doesn't: the owner decides.
- Whether 3 heads a pull request is the right cap once real pull requests run through it.

## Done when

A pull request touching a listed risky path gets a review from a separate agent session as a check, with blocking findings holding Merge when green; breakaway's risky paths are listed; tests cover triggering and the hold.

## How to check it

1. On a board tracking this repository, with its agent routine connected, open a pull request that changes `src/auth.js` and closes a task.
2. Within a sync, the pull request on GitHub shows the `breakaway: risky-path review` check running, and the task's session list shows a new session named `claude-<id>-risk` while the task stays with its author.
3. On the board's pull request page, Merge when green is refused, saying a reviewer is reading it.
4. When the reviewer posts a blocking finding, the check turns to action required and lists it; Merge when green stays refused.
5. Answer it with `npx breakaway risk-answer <task> 1 "…"` as the author: the check turns green and Merge when green works.
