# GitHub

> How the board reads GitHub through your own private App, the GitHub view and its packages, how pull requests link to tasks, reviewing them with an agent, and what the board can merge, update, promote, and roll back.

The board reads each registered repository through a **private GitHub App** that you make for it. It reads, and writes in exactly five cases, all for you: Publish, Update branch, Merge, and Merge when green (pressed on the pull request page, or sent by two settings you can turn on in your browser), and Promote, Roll back, Release, and Build a pre-release, which start a repository’s own workflows. Nothing else writes to GitHub.

## Connecting it

1. Open the board’s **GitHub** view and select **Create the App on GitHub**. GitHub shows the App and its permissions; create it. GitHub sends you back to the board.
2. The view shows `npx breakaway github-connect <code>`. Run it in a checkout of the board’s repository, with `wrangler` logged in, within the hour. It trades the code for the App’s ID, private key, and webhook secret and stores them as the board’s secrets. They never pass through the board or a command line.
3. Open the install link it prints, choose **Only select repositories**, pick the repository, and install.
4. In the repository’s settings, turn on **Allow auto-merge**.

The App needs read and write on **Pull requests** and **Contents**, read and write on **Actions** where a repository has a deploy pipeline, and read on the rest (metadata, checks, commit statuses, deployments, Dependabot alerts, and issues, which only start routines on an opened or reopened issue). An App made from the board’s manifest has them. **Workflows** read and write is optional: with it, a change you propose from the board brings Architect’s apply workflow, `.github/workflows/breakaway-infra.yml`, when the repository needs it; without it, the change says so before you approve, and you run `npx breakaway infra init` in the repository instead. If you made yours before a permission was added, the buttons say so; change it under GitHub, Settings, Developer settings, GitHub Apps, Permissions & events, then accept the request on the installation.

Install the App on every repository you register. One App serves them all.

## Pull requests and tasks

A pull request **closes** a task when a sentence or line of its title or description *starts* with a closing word directly followed by the work IDs: `Closes BRK-12.`, `- Fixes BRK-5, BRK-12 and WEB-1`, `Resolves: DOC-6`. It also closes a task whose `pr` field is its number. Everything else is a **mention**. A pending task with an open closing pull request is **In review**; when the pull request merges the task is done, and when it’s closed without merging it gets a note and leaves review. Write `Part of <ID>.` in a spec or planning pull request.

### How it stays current

Webhooks for pull requests, reviews, checks, workflow runs, statuses, pushes, Dependabot alerts, deployments, and releases schedule a sync 5 seconds later (a burst becomes one). A cron syncs every registered repository every 5 minutes in case one went missing, each on its own, so one repository’s failure or rate limit never stops another. **Sync now** in the GitHub view, or `npx breakaway github --sync`, does it at once. After each sync, the GitHub view and the repository’s sync on Connections show what’s left of GitHub's rate limits (REST and GraphQL), when they reset, and how many calls the last sync made and how many came back free because nothing had changed.

## The GitHub view

The **GitHub** view (`g` `h`) is a dashboard. It opens on what’s live:

- **Open pull requests**, with their verdict, checks, reviews, and tasks.
- **Live now**: staging and production, with each one’s version and commit and **Promote or roll back**. Only for a repository with a [deploy pipeline](#deploys-releases-promote-and-roll-back).
- **Checks on main**: each workflow’s latest run on the default branch, failures first.
- **Packages**: for a repository whose workflows publish npm packages, each package’s latest pre-release and release. A version the workflows staged shows as waiting for your approval on npm, with the command to approve it and a link to its npm page.
- **Security alerts** from Dependabot.

The longer lists are tabs under it: **Releases** and **Deploys** (with a pipeline), **Packages** (every version staged or published, newest first, with its dist-tag and run), **Recently completed**, **CI runs**, and **Commits on main**. The arrow keys, Home, and End move between tabs, and the browser remembers the last one. A repository without a pipeline or packages shows none of those parts.

The board never approves a package: that takes your two-factor authentication on npm. It only reads what the repository’s own workflows staged and published, from npm’s public registry.

### Prepare the next version

A repository whose releases include pre-releases (`v1.3.6-main.4`) counts patches by itself from `package.json`’s version. Moving to the next minor or major takes a pull request that sets it. The GitHub view’s **Next version** section shows the version the pre-releases count toward, and **Prepare** for the next minor and the next major (from 1.3.6, 1.4.0 or 2.0.0).

**Prepare** opens a dialog with the prompt the board writes (set `package.json` to that version, and open one pull request that closes the task), a note, and Force start, and starts an agent from it, like [New agent](https://leavethepack.dev/docs/agents/#from-a-prompt-new-agent). While that task is open, the section links to it instead. You merge its pull request, as always. `npx breakaway agents new --next minor|major` does the same from a terminal.

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

Each repository’s page in **Settings** has two switches under **Pull requests**, both off until you turn them on. They’re a standing “press it for me”, with the same refusals.

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

## Move a repository to the deploy flow

breakaway can deploy a repository’s Cloudflare Worker and release its npm package: staging on every merge, **Promote** to production, **Roll back**, and **Release** for a package, with the board showing what shipped where. A repository gets there with one config file and the workflows `npx breakaway pipeline init` renders from it.

### From the GitHub view

A registered repository without a pipeline shows **Deploy with breakaway** on the GitHub view (**Release with breakaway** when it only publishes a package, **Deploy and release with breakaway** with both), and the same card in its settings page’s Deploys section and the Add a repository wizard’s Deploys step. **Move to breakaway’s deploy flow** adds one task and starts its agent, which follows the `pipeline` skill and does what the rest of this section describes, in a pull request you merge. The card follows it: the agent and its live output, the pull request and what’s left for you after merging, the merge, and [Turn on deploys](#turn-on-deploys). If the agent stops without a pull request, **Try again** starts a new one on the same task. **Skip** hides the offer in this browser. The steps below are the same by hand.

### What it moves, and what it leaves alone

| The repository | What the move does |
| --- | --- |
| Deploys a Worker with `wrangler`, from Actions or by hand | The deploy flow: Deploy, Promote, and Roll back. |
| Publishes a package to npm, from Actions or by hand | The release flow: a pre-release on `next` for every merge, and a stable on `latest` when you release one. |
| Both | Both flows, side by side. Neither waits on the other. |
| Deploys somewhere else (Pages, Vercel, Fly, a server), or publishes to another registry | Nothing. The flow runs Cloudflare Workers and npm; keep the setup you have. |

The move keeps the repository’s checks. Deploy and Release run after the workflows you name in `checks` pass on the exact commit, so your CI stays your own. Take a workflow that only deploys or only publishes out in the same pull request, so a merge can’t deploy or publish twice; one that checks and deploys keeps its checks and loses the deploy step. A step the flow can’t do (a manual approval, say) stays where it is.

The first version takes one staging and production Worker pair, and one package, per repository.

### Write the config

`.github/breakaway-pipeline.json`, in the repository:

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "checks": ["CI"],
  "install": "npm ci",
  "build": "npm run build",
  "beforeDeploy": ["npx wrangler d1 migrations apply DB --remote --env $BREAKAWAY_ENV"],
  "deployPaths": { "widgets": "^(src|public|migrations)/|^wrangler\\.jsonc$|^package(-lock)?\\.json$" },
  "healthCheck": { "staging": "https://widgets-staging.example.workers.dev/", "production": "https://widgets.example.com/" },
  "package": { "name": "widgets", "directory": ".", "access": "public" }
}
```

- `workers`, `package`, or both. A repository that only publishes leaves out `workers` and the fields for it.
- `checks` are the `name:` lines of the workflows that must pass first.
- `install`, `build`, and `beforeDeploy` are your own commands, one line each. `beforeDeploy` runs before each deploy and reads `$BREAKAWAY_ENV` (`staging` or `production`) and `$WORKER`.
- `deployPaths` says, per Worker, which files need a deploy. The board reads the same file to mark a pull request “No deploy needed”.
- `healthCheck` is the address each deploy checks; a deploy that doesn’t answer within 90 seconds goes back to the version before. A plain string checks staging only.
- Optional: `branch` (default `main`) and `wranglerEnv`, the wrangler config’s environment for each Worker.
- `package` names the package as its `package.json` does, the folder it’s in, and `public` or `restricted`. A `package.json` that says `"private": true` gets no release flow.

### Render the workflows

In the repository’s checkout:

- `npx breakaway pipeline init` writes `.github/workflows/deploy.yml`, `promote.yml`, `rollback.yml`, and `.github/deploy-paths.json` for the Workers, and `release.yml` for the package. It never overwrites a file; `--dry-run` lists what it would write. Without a config it prints an example.
- `npx breakaway pipeline check` says whether the config is sound and the workflows are what it renders now.
- `npx breakaway pipeline init --update` replaces what it rendered before, after you change the config or update breakaway. It leaves a workflow of your own alone and says so.

A new repository can get all of this from `repos init`: `npx breakaway repos init <slug> --pipeline` adds a starter config for the Workers `<slug>-staging` and `<slug>` (or `--staging` and `--production`, asked in a terminal), what it renders, and, when the repository has no workflow yet, a minimal `ci.yml` for them to wait for. `--package` adds the release flow for the package `package.json` names, with its `publishConfig.access`; a private `package.json` gets none. They are new files in the pull request `repos init` opens, and nothing that’s there is changed: a repository that already has the config or one of the workflows gets nothing from them. Narrow the starter `deployPaths` to the Worker’s code before you merge.

The workflows run helper scripts that `npx breakaway repos init <slug> --update` copies in; `pipeline init` names any that are missing. Open a pull request with the config, the rendered files, and the old deploy or publish steps taken out. Do your part below before you merge it: once the workflows are on the default branch, the merge’s own checks start them, so the first deploy to staging and the first pre-release come from the merge itself. Without your part, they fail.

### Do your part by hand

The board has no Cloudflare, GitHub settings, or npm credentials, and agents never get them. These are yours:

- Create the staging and production Workers, or use the ones you have, and a Cloudflare API token for each.
- Make the GitHub environments `staging` and `production`, each with its token as `CLOUDFLARE_API_TOKEN` and restricted to the default branch, and a repository variable `CLOUDFLARE_ACCOUNT_ID`.
- Give the board’s GitHub App read and write on **Actions** for the repository: Promote, Roll back, and Release need it.
- For a package: make the GitHub environment `npm`, restricted to the default branch. On npm, add a trusted publisher for `release.yml` and the `npm` environment, or put a granular `NPM_TOKEN` that can’t bypass 2FA in the environment.
- Give the App read and write on **Variables** too: freezing production on the board sets the repository variable `DEPLOYS_PAUSED`, which stops Promote and Release, and setting it on GitHub freezes production on the board.

### Turn on deploys

Once the config and the workflows are on the default branch, the GitHub view shows **Turn on deploys**, with the Workers, the package, and the files it read. Press it and the board sets the repository’s pipeline from them, read again from GitHub. A file that’s missing or a config the board can’t use shows instead, with what to run. Nothing deploys from the press: the workflows run on the next merge.

## Deploys, releases, Promote and Roll back

A repository with a **deploy pipeline** gets Releases, Promote, Roll back, and the warnings that merging deploys; one whose pipeline names a package gets **Release**. [Turn on deploys](#turn-on-deploys) sets it, or set it yourself with `npx breakaway repos modify <slug> --pipeline pipeline.json`:

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "package": "widgets",
  "workflows": { "deploy": "deploy.yml", "promote": "promote.yml", "rollback": "rollback.yml", "release": "release.yml" },
  "deployPaths": ".github/deploy-paths.json"
}
```

It needs `workers`, `package`, or both. `workflows` and `deployPaths` are optional. Without a pipeline, merging deploys nothing and the GitHub view shows none of this.

- A repository’s **Deploy**, **Promote**, and **Roll back** workflows record each deploy as a GitHub Deployment. The board reads them and shows a card for staging and one for production, with the commit, version, when it went live, and the tasks it carries.
- When a deploy succeeds, the board finds the merged pull requests since the previous successful deploy and marks the tasks they closed **On staging** or **Live**.
- **Promote to production…** asks first, listing the tasks and migrations, and starts the repository’s `promote.yml` with the latest successful staging deploy. A destructive migration needs a tick. **Roll back…** asks for the version to go back to and what broke, and starts `rollback.yml`. Both are cookie only, and the workflows check everything again.
- **Release…** beside any of the package’s pre-releases makes it the stable version on `latest`, from the same commit’s files, and asks what comes next: patch, which counts by itself, or the next minor or major, which opens a pull request that sets the version. Once a stable is out, its other pre-releases show as superseded. Only you can press it, in the browser or with `npx breakaway github release <pre-release> [--next minor|major]`. Every version waits on npm until you approve it with 2FA: `npm stage approve <id>`, or Staged Packages on npmjs.com. The board never publishes or approves anything there.
- **Build a pre-release**, for a package whose `release.yml` builds pre-releases only by hand (a merge publishes nothing, as breakaway’s own does), sits on the package’s card. It says how many merges the default branch has since the latest pre-release, with their pull requests and work IDs, and starts the workflow’s pre-release job on the default branch, with `prerelease` left empty. The card follows the run, and once the new pre-release is staged it has **Release…**. It waits while CI on the default branch’s latest commit is running or failed, and while one is building. **Release…** on a pre-release the default branch has moved past says how many merges it leaves out, and offers **Build a pre-release first**. So the order is: build, test it, then release. Only you can press it, in the browser.
- A merged pull request that changes only docs, skills, or CI shows “No deploy needed”.

The scripts those workflows run are copied into a repository by `repos init`, so every repository makes the same checks.

## Several repositories

A webhook syncs the repository its delivery names; one that isn’t registered gets a `202` and is ignored. A pull request closes only tasks of its own repository: `Closes BRK-3.` in another repository’s pull request is a mention. The GitHub App is one; its installations are per repository.

## Disconnecting, and a leaked key

To disconnect, uninstall the App on GitHub. If the App’s key leaks, generate a new private key in the App’s settings, store it as the board’s `GITHUB_KEY` secret as one line of base64 PKCS#8, then delete the old key on GitHub. Because the App can merge, treat this as urgent.
