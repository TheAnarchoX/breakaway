---
title: GitHub
description: How the board reads GitHub through your own private App, the GitHub view and its packages, how pull requests link to tasks, reviewing them with an agent, and what the board can merge, update, promote, and roll back.
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

## The GitHub view

The **GitHub** view (`h`) is a dashboard. It opens on what’s live:

- **Open pull requests**, with their verdict, checks, reviews, and tasks.
- **Live now**: staging and production, with each one’s version and commit and **Promote or roll back**. Only for a repository with a [deploy pipeline](#deploys-releases-promote-and-roll-back).
- **Checks on main**: each workflow’s latest run on the default branch, failures first.
- **Packages**: for a repository whose workflows publish npm packages, each package’s latest pre-release and release. A version the workflows staged shows as waiting for your approval on npm, with the command to approve it and a link to its npm page.
- **Security alerts** from Dependabot.

The longer lists are tabs under it: **Releases** and **Deploys** (with a pipeline), **Packages** (every version staged or published, newest first, with its dist-tag and run), **Recently completed**, **CI runs**, and **Commits on main**. The arrow keys, Home, and End move between tabs, and the browser remembers the last one. A repository without a pipeline or packages shows none of those parts.

The board never approves a package: that takes your two-factor authentication on npm. It only reads what the repository’s own workflows staged and published, from npm’s public registry.

### Prepare the next version

A repository whose releases include pre-releases (`v1.3.6-main.4`) counts patches by itself from `package.json`’s version. Moving to the next minor or major takes a pull request that sets it. The GitHub view’s **Next version** section shows the version the pre-releases count toward, and **Prepare** for the next minor and the next major (from 1.3.6, 1.4.0 or 2.0.0).

**Prepare** opens a dialog with the prompt the board writes (set `package.json` to that version, and open one pull request that closes the task), a note, and Force start, and starts an agent from it, like [New agent](/docs/agents/#from-a-prompt-new-agent). While that task is open, the section links to it instead. You merge its pull request, as always. `npx breakaway agents new --next minor|major` does the same from a terminal.

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

## Review with an agent

Before you merge, an agent can review a pull request and leave its answer on the pull request’s page.

- **When it shows.** **Review with an agent** shows on the page of a pull request that can merge as it stands: open, not a draft, no conflicts, not behind, its checks passed or still running, and closing an open task. It’s in the task menu too. One that’s behind, conflicts, or fails its checks shows Update branch or Fix with an agent instead. A Dependabot pull request keeps **Safe to merge?**.
- **The agent** works on the task the pull request closes. It checks out the branch, runs the repository’s checks, and reads the diff against the task’s description, done when, and spec, for what checks can’t see: behaviour that’s wrong or missing, tests that don’t cover the change, work outside the task, and the repository’s own rules. It never pushes and never merges.
- **Its answer** is one verdict: **Looks ready**, **Ready with a follow-up** (it adds that task and names it), or **Needs changes** (what and where). It’s a comment on the task, and an **Agent review** section below the pull request’s description shows the latest one, with the commit it reviewed, marked when the branch has moved since. Nothing is posted to GitHub.

`npx breakaway github review <n> [--note …]` does the same from a terminal.

## Fix with an agent

On the page of an open, non-draft pull request that has a merge conflict, failing checks, or review comments, **Fix with an agent** (or **Address review comments**) starts an agent on the pull request’s own task. An agent’s review that needs changes counts as review comments, and the fix agent reads it. It merges the default branch in, or fixes the checks, or answers the review threads, on the pull request’s own branch. It never rewrites history and never merges. `npx breakaway github fix <n> [--problem conflicts|failing|review]` does the same from a terminal.

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
