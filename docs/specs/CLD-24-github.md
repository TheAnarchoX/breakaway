# CLD-24 · GitHub on the task board

Task: `CLD-24` on the board · Status: built (before the move to breakaway, under the first install's work IDs; approved 29 Sep 2026, by the owner: GitHub App, done on merge, read-only, every part of the GitHub view)

## Problem

The board says who is working on what, but not what happened to the work after that: whether the pull request is open, whether CI passed, whether review asked for changes, whether it merged. That lives on GitHub, one tab per PR. With many agents opening PRs, the owner needs to see it all from the board, and tasks should move by themselves when their PR does.

## Fit

Read-only and project data only: pull requests, checks, workflow runs, commits, and Dependabot alerts of the repository the board runs (samewave's, on the install this was written for). Nothing about the people who use what that repository builds. GitHub logins of the people and bots who open PRs are shown as GitHub shows them. Nothing is written to GitHub, except as amended on 29 Sep 2026 (`CLD-56`, `CLD-57`): the App also has write access to pull requests and contents so the owner can Update branch, Merge, and Merge when green from the board, from the signed-in browser only ([IDEA-2](IDEA-2-review-and-merge-on-the-board.md), [how](../tasks.md#update-branch-merge-and-merge-when-green)).

## Design

**Connection: a GitHub App**, named after the install, private, installed on the board's repository only, with read permissions for metadata, contents, pull requests, checks, actions, commit statuses, and Dependabot alerts, and webhooks for `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `workflow_run`, `status`, `push`, and `dependabot_alert`.

- Created with GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest): the board's GitHub view posts the manifest to GitHub, the owner confirms, GitHub returns to `/github/connected` (checked against a one-hour `state`), and the view shows `node scripts/tasks.mjs github-connect <code>`. That command, on the owner's machine, exchanges the code for the app's ID, private key, and webhook secret, and pipes them into the Secrets Store (`GITHUB_APP_ID`, `GITHUB_KEY` as PKCS#8, and `GITHUB_WEBHOOK_SECRET`, after the install's secrets prefix). The value `unset` means not connected. Then the owner installs the app on the repository.
- The Worker signs a short JWT with the key, trades it for an installation token (kept in memory, never stored), and calls the REST API.

**Getting data: webhooks plus a reconcile.** `POST /github/webhook` checks `X-Hub-Signature-256` and only schedules work: a Durable Object alarm 5 seconds later runs one reconcile, so a burst of check events costs one. A cron every 5 minutes reconciles too, so a missed webhook fixes itself. A reconcile fetches the 50 most recently updated PRs, the checks, statuses, and reviews of the open ones (and closed ones not seen yet), the 30 latest workflow runs, the 30 latest commits on `main`, and open Dependabot alerts, and stores them in the Durable Object's SQLite (`gh_prs`, `gh_runs`, `gh_commits`, `gh_alerts`, `gh_events`), keeping the last 100 closed PRs, 200 runs, 100 commits, and 300 events.

**Linking PRs to tasks.** Work IDs (`CLD-24`, any case) found in a PR:

- **close** the task when a sentence or line of the title or description starts with GitHub's closing words (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved) directly followed by the IDs (`Closes CLD-24.`, `- Fixes PRD-5 and OPS-1`), outside code blocks and quotes, or when the task's `pr` field is the PR's number;
- are **mentions** anywhere else, the branch name included (a spec or planning PR often carries the ID in its branch without finishing the work): shown on the task as "mentioned in #31", never changing it.

The first sync after connecting only records history: PRs merged or closed before then never move tasks. (Found while testing against the real repository, where a planning PR would otherwise have finished its task.) The first rule was looser (any of close, fix, resolve, finish, or complete, anywhere up to the end of the sentence); the pull request that built this then finished a task by saying in its description that its first sync "finished" it. Fixed in `CLD-26`, with that description as a test case.

**Workflow.** A pending task with an open closing PR is **In review** (a new board column between In progress and Blocked). Its `pr` field is set to the PR if empty. When the PR merges, the task is marked done with the note "Merged in #31: title." When it's closed without merging, the task gets the note "#31 was closed without merging." and is no longer in review. Each happens once per PR. These changes are ordinary versions from the source `github`, so Taskwarrior replicas get them.

Agents no longer mark tasks done when they open a PR: they `modify <ID> --pr <number>` and write "Closes <ID>" in the description. The `tasks` skill and the pull request template change to match.

**What people see.**

- On the board, list, and graph: a PR badge on each task (state, checks, review).
- In a task: a GitHub section with its PRs (closing and mentioning), each with checks by name, the review decision, and links.
- A **GitHub** view: connection status and Sync now; open Dependabot alerts; open PRs (drafts included) with checks, reviews, and linked tasks, then recently merged and closed; CI runs, running and failing first; commits on `main` with their PR and tasks.
- In **Activity**: PR opened, ready for review, merged, closed; CI failing and passing again; alerts opened and fixed, next to the task changes.

## Privacy

Project data only, and nothing about the people who use what the repository builds. The app's private key and webhook secret are only in the Secrets Store; installation tokens only in memory. Webhook bodies are verified before anything is read, and events for other repositories are ignored.

## Out of scope

Writing to GitHub (comments, labels, statuses, merging), other repositories, GitHub Issues, deploy tracking.

## Done when

- The app is created and installed (`CLD-25`, the owner), and the GitHub view shows PRs, CI runs, commits, and alerts within 10 seconds of a change on GitHub.
- A PR whose branch or description closes a task puts it In review, and merging it marks the task done with a note, visible in Taskwarrior after `task sync`.
- `pnpm test` covers signature checks, linking rules, the reconcile against a mocked GitHub API, and the workflow.
