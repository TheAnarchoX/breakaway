---
title: GitHub
description: How the board reads GitHub through your own private App, how pull requests link to tasks, and what the board can merge, update, promote, and roll back.
---

The board reads each registered repository through a **private GitHub App** that you make for it. It reads, and writes in exactly five cases, all for you: Publish, Update branch, Merge, and Merge when green (pressed on the pull request page, or sent by two settings you can turn on in your browser), and Promote and Roll back, which start two workflows. Nothing else writes to GitHub.

## Connecting it

1. Open the board’s **GitHub** view and select **Create the App on GitHub**. GitHub shows the App and its permissions; create it. GitHub sends you back to the board.
2. The view shows `npx breakaway github-connect <code>`. Run it in a checkout of the board’s repository, with `wrangler` logged in, within the hour. It trades the code for the App’s ID, private key, and webhook secret and stores them as the board’s secrets. They never pass through the board or a command line.
3. Open the install link it prints, choose **Only select repositories**, pick the repository, and install.
4. In the repository’s settings, turn on **Allow auto-merge**.

The App needs read and write on **Pull requests** and **Contents**, read and write on **Actions** where a repository has a deploy pipeline, and read on the rest (metadata, checks, commit statuses, deployments, Dependabot alerts). An App made from the board’s manifest has them. If you made yours before a permission was added, the buttons say so; change it under GitHub, Settings, Developer settings, GitHub Apps, Permissions & events, then accept the request on the installation.

Install the App on every repository you register. One App serves them all.

## Pull requests and tasks

A pull request **closes** a task when a sentence or line of its title or description *starts* with a closing word directly followed by the work IDs: `Closes BRK-12.`, `- Fixes BRK-5, BRK-12 and WEB-1`, `Resolves: DOC-6`. It also closes a task whose `pr` field is its number. Everything else is a **mention**. A pending task with an open closing pull request is **In review**; when the pull request merges the task is done, and when it’s closed without merging it gets a note and leaves review. Write `Part of <ID>.` in a spec or planning pull request.

### How it stays current

Webhooks for pull requests, reviews, checks, workflow runs, statuses, pushes, Dependabot alerts, deployments, and releases schedule a sync 5 seconds later (a burst becomes one). A cron syncs every registered repository every 5 minutes in case one went missing, each on its own, so one repository’s failure or rate limit never stops another. **Sync now** in the GitHub view, or `npx breakaway github --sync`, does it at once.

## The pull request page

Select a pull request in the GitHub view to read it without leaving the board: a **verdict**, its checks (each linking to the run and its log), reviews, the conversation, and the diff, file by file. The verdict comes from GitHub’s `mergeable_state`:

**Ready to merge**, **Has conflicts**, **Checks failing**, **Behind main**, **Checks running**, **Waiting on review**, or **Draft**. The open list sorts by it, and the GitHub item in the sidebar counts what’s ready to merge. The page is read live through the installation token, and diffs are never stored.

### Publish, Update branch, Merge, Merge when green

- **Publish…** marks a draft ready for review.
- **Update branch** merges the default branch into the pull request’s branch (a merge commit, never a rebase or force-push), when it’s behind.
- **Merge…** opens a dialog with the method (squash or merge commit), the tasks it finishes, and whether merging deploys a Worker. The head commit the page showed goes to GitHub with the request, so a push in between refuses the merge instead of merging code you haven’t seen.
- **Merge when green…** turns on GitHub’s auto-merge while checks are still running. It needs **Allow auto-merge** in the repository’s settings.

These are **cookie only**: they accept only the signed-in web board, from its own origin. The bearer token that agents, the CLI, and cloud sessions hold gets a 403, so none of them can merge, whatever they try. **The repository’s rules stay in charge:** the board refuses to merge drafts, closed pull requests, and ones that are behind, blocked, or conflicting, and if GitHub refuses anyway (a required check, a ruleset) it shows GitHub’s own message and changes nothing. Conflicts go to an agent.

### Two standing settings

The board’s **Settings** has two switches under **Pull requests**, both off until you turn them on. They’re a standing “press it for me”, with the same refusals.

- **Keep branches up to date.** When the default branch moves on, the board updates the branch of every open pull request that’s behind. It skips drafts and pull requests with conflicts.
- **Merge when green.** Every open pull request that isn’t a draft merges once its required checks pass, Dependabot’s included. It uses the method you last chose in the merge dialog. In a repository with a pipeline, merging deploys to staging, so turning it on asks first and says how many pull requests are ready to merge straight away.

They’re kept in the browser’s local storage, not on the server, so they’re on only where you turned them on, and only while the board is open there. Agents can’t turn them on.

## Fix with an agent

On the page of an open, non-draft pull request that has a merge conflict, failing checks, or review comments, **Fix with an agent** (or **Address review comments**) starts an agent on the pull request’s own task. It merges the default branch in, or fixes the checks, or answers the review threads, on the pull request’s own branch. It never rewrites history and never merges.

## Deploys, releases, Promote and Roll back

A repository with a **deploy pipeline** gets Releases, Promote, Roll back, and the warnings that merging deploys. Set it with `npx breakaway repos modify <slug> --pipeline pipeline.json`:

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "workflows": { "deploy": "deploy.yml", "promote": "promote.yml", "rollback": "rollback.yml" },
  "deployPaths": ".github/deploy-paths.json"
}
```

`workers` is required. `workflows` and `deployPaths` are optional. Without a pipeline, merging deploys nothing and the GitHub view shows none of this.

- A repository’s **Deploy**, **Promote**, and **Roll back** workflows record each deploy as a GitHub Deployment. The board reads them and shows a card for staging and one for production, with the commit, version, when it went live, and the tasks it carries.
- When a deploy succeeds, the board finds the merged pull requests since the previous successful deploy and marks the tasks they closed **On staging** or **Live**.
- **Promote to production…** asks first, listing the tasks and migrations, and starts the repository’s `promote.yml` with the latest successful staging deploy. A destructive migration needs a tick. **Roll back…** asks for the version to go back to and what broke, and starts `rollback.yml`. Both are cookie only, and the workflows check everything again.
- A merged pull request that changes only docs, skills, or CI shows “No deploy needed”.

The scripts those workflows run (`record-deployment.mjs`, `promote-check.mjs`, `release-notes.mjs`, `check-migrations.mjs`, `release-artifact.mjs`) are copied into a repository by `repos init`, so every repository makes the same checks.

## Several repositories

A webhook syncs the repository its delivery names; one that isn’t registered gets a `202` and is ignored. A pull request closes only tasks of its own repository: `Closes BRK-3.` in another repository’s pull request is a mention. The GitHub App is one; its installations are per repository.

## Disconnecting, and a leaked key

To disconnect, uninstall the App on GitHub. If the App’s key leaks, generate a new private key in the App’s settings, store it as the board’s `GITHUB_KEY` secret as one line of base64 PKCS#8, then delete the old key on GitHub. Because the App can merge, treat this as urgent.
