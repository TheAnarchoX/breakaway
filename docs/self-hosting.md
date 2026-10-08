# Run your own board

breakaway is free, and it runs on your own Cloudflare account. This guide takes you from nothing to a board whose first task is closed by a pull request you merged. It has nine steps, and you're done at the end of the ninth, not when the board is deployed.

Each step ends with a check, which reads one of three ways:

- **Verified:** a command or the board tested it. On **Connections**, the board's own list of what it leans on, that's a row that reads **Working** or **Verified**.
- **Not verified yet:** it's set up, but nothing has used it. The check says what will verify it. A Claude routine reads this until the first agent it starts claims a task.
- **Failed:** the check says what failed and the fix. On Connections, that's a row that reads **Needs attention**.

The licence is PolyForm Noncommercial 1.0.0: breakaway is free for personal and noncommercial use, and commercial use is by exception. [`LICENSING.md`](https://github.com/TheAnarchoX/breakaway/blob/main/LICENSING.md) says what that covers. Releases before 2.0.0 stay under FSL-1.1-Apache-2.0.

## With Claude Code

Paste this into [Claude Code](https://claude.com/claude-code), in an empty folder:

```text
Set up a breakaway board for me. Read https://leavethepack.dev/install.md and follow it.
```

It works through the steps below with you. It runs and checks what it can, and stops for each step only you can do: signing in, making a token, anything in a browser or with a secret. For each, it names the page, what to press, and what the page shows when it worked. It never asks for a secret in the chat, and it ends with one real task, which an agent finishes and you merge.

**It looks before it makes anything.** It starts by checking what's already there (`tasks.env`, the install repository, the Worker, the board, its repositories, and Connections), says what it found, and carries on from the first step that isn't done. It never makes a second install repository, Worker, `tasks.env`, GitHub App, or routine; when something exists but doesn't match, it stops and asks you.

**Stopped halfway?** Open Claude Code in the same folder and paste the same line. It looks first and carries on where it stopped.

The prompt it reads is [`prompts/install.md`](https://github.com/TheAnarchoX/breakaway/blob/main/prompts/install.md) in breakaway's repository.

Rather do it by hand? The steps follow.

## What you need

- macOS, Linux, or Windows through WSL. Every command here runs in a POSIX shell; Windows itself (PowerShell) isn't supported. On Windows, [install WSL](https://learn.microsoft.com/windows/wsl/install) first (`wsl --install` in PowerShell as administrator, restart, then open **Ubuntu**), and do everything inside it.
- A Cloudflare account, and a token that can edit Workers on it.
- Cloudflare's Workers Paid plan, if you'll chase features. The board runs on Workers Free, but in a chase every agent riding the peloton listens for the others, asking the board 12 times a minute: six agents listening make about 4,300 requests an hour, so a long chase uses a large share of Workers Free's 100,000 requests a day, and the board stops answering once they're gone. Workers Paid includes far more than a chase uses. breakaway itself stays free either way: the plan is between you and Cloudflare.
- A GitHub account that can make a private repository, and one for the code the agents work on.
- Node 20 or later, and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) signed in to your Cloudflare account. The commands that store secrets call it.
- A Claude plan that has [routines](https://claude.ai/code/routines), to start agents from the board. The board works without one, but you give up starting agents from the board, live output on a task, starting by itself when ready, chase, and scheduled routines: you start agents yourself in Claude Code, and they use the CLI.
- Taskwarrior 3, if you want it. It's optional: the web board and the CLI work without it.

You'll use two repositories. The **install repository** holds your board's settings and the workflows that deploy it. The other is the code your agents work on.

## 1. Make the install repository

```sh
mkdir my-board && cd my-board
git init
npx breakaway install init
```

It asks for the board's name, the Worker's name, an address on your own domain (blank is fine: the board answers on workers.dev), a Secrets Store ID (blank is fine: the secrets go on the Worker), and the install repository's `owner/name`. It writes the settings, the Deploy and Update workflows, and a README. It never overwrites a file.

It also writes `installRepository` (the repository's `origin`, or what you type) so the board can look for updates on its own. `channel` starts the same in `breakaway.config.json` and `breakaway.json`: `stable` pins a release and sends you a pull request to move it, and `main` follows breakaway's pre-releases. Add `origin` first (`git remote add origin …`) to have it filled in without asking.

Push it to a **private** GitHub repository, and keep it private. Then, on GitHub:

1. Make an environment named `production` (Settings, Environments) with two secrets: `CLOUDFLARE_API_TOKEN`, a Cloudflare API token, and `CLOUDFLARE_ACCOUNT_ID`. Workers Editor on the board's Worker deploys each release; a token that can also run `wrangler deploy` lets Deploy apply a new address, cron triggers, or a new Durable Object class too. The install repository's README says which token does what.
2. Turn on Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests". The update workflow needs it.

**Check:** nothing on Connections yet, because there's no board. The files are in the repository, and the environment has its secrets.

## 2. Set the board's secrets

```sh
npx breakaway init-secrets
```

Run it once per install. If a board already runs and you've lost `tasks.env`, don't run it: new secrets lock you out of that board. [When something's lost](tasks.md#when-somethings-lost) says how to get each value back.

It writes `tasks.env` in `~/.config/breakaway` and says which value goes where. Three are required: `TASKS_API_TOKEN`, `TASKS_CLIENT_ID`, and `TASKS_SYNC_KEY`. Set each as a Worker secret (Cloudflare, Workers, your Worker, Settings, Variables and Secrets), or in your Secrets Store if you gave a Secrets Store ID. Without a Secrets Store, the Worker doesn't exist until its first deploy: set them right after step 3's deploy. `.dev.vars.example` in the repository lists them.

`tasks.env` holds the only copy of the sync secret. Keep it in your password manager, with the rest of [what to keep](#what-to-keep).

**Check:** the file exists. You can't read the board yet, so the secrets are Not verified yet until step 3, when the **Secrets Store bindings** row under Cloudflare reads **Working**. If it says `TASKS_API_TOKEN is unset`, that secret isn't on the Worker yet.

## 3. Deploy it

On GitHub, open the install repository's Actions tab, pick **Deploy**, and run it with **dry-run** on. It checks the release and builds it, and stops before it touches the Worker. When it passes, run it again with dry-run off. It deploys, checks that the Worker answers `/api/ping`, and goes back to the previous version if it doesn't.

On an address on your own domain, the first deploy can wait up to five minutes for its certificate, and can end by saying the board is waiting for its secrets: that's expected, so put them on now (step 2).

It stops with a message when something needs your hands: a release that has manual steps, or a change a version upload can't carry (the address, cron triggers, or a new Durable Object class) when its token can't run `wrangler deploy` or the repository variable `BREAKAWAY_DEPLOY_CHANGES` isn't `true`. Do what the message says, then run Deploy again. It never changes the Worker's name or its Durable Object, since either opens an empty board, and it refuses to deploy a new Worker when the install already has a board.

**Check:** the run is green. Then, once you're signed in (next step), the Cloudflare rows read **Working**: **Worker**, **Secrets Store bindings**, **Cron (every 5 minutes)** (it reads "no run recorded yet" until the first run, within 5 minutes), and **TaskChampion sync server**.

## 4. Sign in

Open the board's address (the workers.dev address Cloudflare shows for the Worker, or your own). Sign in with `BREAKAWAY_TOKEN` from `tasks.env`.

Every view says "This board has no repository yet" and points to **Set up the board** on Connections. Open it. It lists the rest of this guide's steps, ticks each one when its connection works, and ends with your first task: **A first agent's pull request merged** with a routine, or **A first task closed** without one. Taskwarrior is an optional line in it.

**Check:** you're in. A wrong token keeps asking for it; copy `BREAKAWAY_TOKEN` again.

## 5. Register a repository

Register the repository your agents work on: on Connections, in **Set up the board**, fill in its short name, its GitHub `owner/name`, and its areas, each an area and a work-ID prefix like `product:PRD`. Or from a terminal:

```sh
npx breakaway repos add <slug> <owner/name> --area product:PRD
```

The first repository you register is the board's default. A prefix belongs to one repository and never changes.

**Check:** **Registered repository** reads **Working**, and **Register a repository** is ticked.

## 6. Connect GitHub

The board reads GitHub through a private GitHub App that you make for it.

1. On the board's GitHub view, press **Create the App on GitHub**. GitHub shows what the App may read; keep the name and press **Create GitHub App**. You land back on the board, which shows a `npx breakaway github-connect <code>` command.
2. Run it in your install repository's folder, within the hour. It stores the App's keys as secrets and deploys a new version of the Worker. If the board already has a working App, it refuses: that's the App to keep, and `--replace` is only for one Connections says has failed.
3. Install the App on the repository you registered, and on the install repository if you chose `main`: the board starts its Deploy workflow, which needs read and write on Actions.
4. On the repository's GitHub settings, General, Pull Requests, turn on **Allow auto-merge**.
5. Add the board's files to the repository: `npx breakaway repos init <slug>`. In a terminal it asks for each part of the agent prompt. It pushes the files as the first commit of an empty repository, or opens a pull request. Then fill in anything left in `<…>` in the agent prompt and `AGENTS.md`, and merge it.

**Check:** press **Check now** on Connections. These rows read **Working**:

- **GitHub App**
- **Installed on `owner/name`**
- **Permissions on `owner/name`**
- **Allow auto-merge on `owner/name`**
- **Sync with `owner/name`**

**Webhook** is Not verified yet until GitHub sends one, which merging the board's files does.

Each says what to change when it doesn't. Pull requests and Contents need write, and Actions needs write on a repository with a deploy pipeline. An agent prompt with a `<…>` left in it makes **Agent routine** need attention until you fill it in.

## 7. Connect a Claude routine

The board starts agents through a routine you save on claude.ai. Without a Claude plan that has routines, skip to step 8: you'll start agents yourself in Claude Code.

At [claude.ai/code/routines](https://claude.ai/code/routines), press **New routine**, and go down this list, one line at a time. Connections can't read claude.ai, so it can't check these for you.

- **Repository:** the one you registered.
- **Instructions:** the stub, from the board's **Agents** view (**Copy stub**), pasted as it is. `repos init` copied it into the repository too.
- **Cloud environment, network access:** **Custom**, with the board's host under **Allowed domains**, and **Also include default list of common package managers** ticked.
- **Cloud environment, API credential:** **Add credential**, type **Bearer**, the board's host as the allowed website, and `BREAKAWAY_TOKEN` from `tasks.env` as the value. Not as an environment variable: the credential keeps the token out of the session.
- **Cloud environment, environment variable:** `BREAKAWAY_AGENT=claude-cloud`.
- **Trigger:** **Add trigger**, **API**. It shows a URL and a token, the token once.

Then connect it: paste the trigger's URL and token into the **Agent routine** row's form on Connections, or run `npx breakaway agents-connect` and paste both when it asks. For another repository, add `--repo <slug>`.

[Cloud agents](tasks.md#cloud-agents) has the environment settings in full.

**Check:** **Agent routine** is connected and reads **Not verified yet**: the board can't read claude.ai, so nothing proves the routine works until an agent it starts claims a task. Step 9 does that; don't start an agent just to test it. Then the row reads **Verified by** that task, with the time, and **Live output from sessions** reads **Working** once the session sends something back. If it says a started session sends nothing back, the environment doesn't allow the board's host.

**What Connections can't check.** It can't see claude.ai or Cloudflare's dashboard, so these are yours to check:

- The routine's cloud environment: the allowed hosts (the board's, `api.githubcopilot.com`, `registry.npmjs.org`, and the common package managers).
- The routine's prompt: it should match the stub the Agents view shows.
- Cloudflare's own settings: the custom domain, the Secrets Store, and the Worker's cron triggers beyond what the Worker reports.

## 8. Connect the CLI

On the machine you work from, `tasks.env` needs the board's address too. Add `BREAKAWAY_URL=<the board's address>`, then:

```sh
npx breakaway health
```

It checks that the CLI reaches the board. Any call with the token counts, so you don't need Taskwarrior.

Taskwarrior is optional. If you use it, run `npx breakaway setup`: it writes Taskwarrior's settings and runs the first `task sync`. To use Taskwarrior in a checkout, [Another install](tasks.md#another-install) shows the three lines for its `.taskrc`.

**Check:** **Command line** reads **Working**, and **Connect the CLI** is ticked. With Taskwarrior, **Taskwarrior sync** reads **Working** too.

## 9. Finish a first task

The board is set up when one real task is closed by its merged pull request.

1. **Add one.** Pick something small and useful from the repository, with a done when you can check in a few minutes, and add it from a checkout of the repository: `npx breakaway add "<title>" --project <area> --tag agent --horizon now --brief "<what and why>" --done-when "<what you can check>"`.
2. **With a routine:** the last step of **Set up the board** opens the **Add a repository** wizard's agent step. Press **Start an agent on <ID>**, or **Start an agent** on the task's own page. The step ticks as it goes: started, live output, pull request. If the start fails, the step says why and the fix, with **Try again**. Once the agent claims the task, **Agent routine** reads **Verified by <ID>**.
3. **Without one:** open Claude Code in the checkout and say "Work on <ID> from the board". The board's files tell it how to claim, report, and open the pull request.
4. **Review and merge.** The pull request's title starts with the work ID and its description says `Closes <ID>.`. Check it against the done when, and merge it on GitHub or on the board's pull request page. Merging is yours; the agent never merges.

**Check:** `npx breakaway show <ID>` says it's completed, merged in its pull request. **A first agent's pull request merged** (or **A first task closed**) is ticked, and **Set up the board** disappears: every step is done.

## What to keep

The board takes secrets and never gives them back, so a few files on your machine, in `~/.config/breakaway/`, hold the only copy. Put each one, whole, in your password manager, and never in Git:

- `tasks.env`: the token, and the only copy of the sync secret.
- `tasks-routines.json`, when there is one: other repositories' routines.
- `github-app.json`, only if `github-connect` wrote it: the App's keys, until they're stored.

[What to keep](tasks.md#what-to-keep) says what each one costs to lose, and [When something's lost](tasks.md#when-somethings-lost) what to do when one is gone.

## Updates

The Version row on Connections says what the board runs, and the latest release in its channel.

- **`stable`**: the install repository's Update workflow looks for a newer release every hour and opens a pull request that moves `breakaway.json` to it, with the release's notes. Merge it and Deploy runs. Nothing deploys until you merge. The board adds a note to your inbox, once per release.
- **`main`**: the board follows the latest pre-release, which breakaway's owner publishes from `main` when they choose. It starts the Deploy workflow by itself when there's a newer one, so the App needs read and write on Actions on the install repository. The hourly Update run is the fallback.

**A release that asks for your hands.** A release that changes the Durable Object classes, a route, a cron, or a binding is a major release, and its notes have a **Manual steps** section. Deploy stops on it and deploys nothing, and the Version row needs attention. Do the steps, then deploy with `wrangler`: `npx breakaway install config` makes the Worker's config.

**Roll back.** Deploy checks that the new release answers `/api/ping`, with its secrets readable, within a minute, and goes back to the previous version when it doesn't. To go back by hand:

1. For a `stable` install, revert the pull request that moved `breakaway.json`, and merge the revert. Deploy runs the old release.
2. For a bad deploy you want undone now, on either channel, run `wrangler rollback <version-id>`. The Worker's versions are on Cloudflare.

The board's data only changes forward, and only by adding, so an install can always go back one release.

**Check:** **Version** reads **Working**, and says its release is the latest. If it says a release "isn't running yet", open Actions on the install repository: the Deploy run says why it stopped.

## Updating a board that has no repository

A board made with the Deploy to Cloudflare button has no install repository, so there's no Update workflow to open a pull request. It updates itself instead, when you press a button. Nothing updates on its own, on either channel.

**Turn it on, once.** On Connections, the Version row says **Updates from the board are off**. Press **Turn on updates…** and paste two things:

- A Cloudflare API token with **Workers Scripts: edit** on your account, and nothing else. Make it under My profile, API tokens.
- Your account's ID, the 32 characters on the right of its Workers page.

The board checks that the token reaches its own Worker, then keeps it as a secret on that Worker (`TASKS_UPDATE_TOKEN`). It never shows it again and sends it only to Cloudflare. A token that can edit this Worker can also change its code, so give it no more scope than that. A board with an install repository can't turn this on: its repository updates it.

**Check for updates, then update.** Press **Check for updates**. The board reads the release feed at `leavethepack.dev/releases.json`, one of two calls it makes that you didn't connect (the other is **Fetch today's rate** in Settings, on your press), and it sends nothing about itself. If the latest release in your channel is newer and checks out, the row says so and shows **Update to `<version>`**. Pressing it:

1. Checks the release's signature, then its checksums, then that your version is new enough to update to it directly.
2. Uploads the release as a new Worker version, with the bindings the running Worker has, so a binding you added by hand stays.
3. Deploys it.
4. Checks that the new version answers `/api/ping` and reports the new release with its secrets readable, within a minute.

Only you can press it: the board's own token, and so an agent, is refused. Live conversations end when it deploys, like any deploy. If a step before the deploy fails, nothing has changed, and the row says which step and what to do. If the check fails, the board deploys the previous version again and says so.

**Signatures.** Each release's `manifest.json` is signed with an Ed25519 key that only breakaway's release workflow holds. The manifest holds the bundle's checksum, so one signature covers the bundle. Your board checks it against the public key that its running version ships with, so whoever controls the feed can hide an update but can't push one. A release that fails the check isn't installed: the row says "This release didn't pass its signature check, so it wasn't installed. Nothing changed." A release from before signing can't be installed by the board; update by hand once.

**A release that asks for your hands.** A release that changes the Durable Object classes, routes, crons, or bindings is a major release, and a version upload can't carry it. The row shows its **Manual steps** and no Update button. Do the steps with your own `wrangler`: `npx breakaway install config` writes the Worker's config, then run `wrangler deploy` yourself. Or make the board a repository: `npx breakaway install init`, then push it and follow the steps above. It then updates through the install repository's workflows, and turning off updates on the board is the last step.

**Roll back.** After an update, the row shows **Roll back to `<version>`** for as long as Cloudflare keeps that version. It puts the version before the update in front of everyone. The board's data only changes forward, and only by adding, so the older version still reads it. If going back from the board fails, open the Worker's Deployments on Cloudflare and roll back to the previous version there.

**Turn it off.** **Turn off updates** stops the board using the token. Delete the token on Cloudflare yourself: the board can't.

**Check:** **Version** reads **Working**, and says its release is the latest. If it says "Can't read the update feed", the board keeps running as it is; press **Check for updates** again later.

## When something's wrong

Run `npx breakaway connections`. It lists every row with its state and the fix, the same as the Connections view. For an agent run that's stuck, the task's Agent section says what it's doing and what to do ([What a run is doing](tasks.md#what-a-run-is-doing)). [When something's wrong](tasks.md#when-somethings-wrong) covers the rest. [The task board's manual](tasks.md) has every command.
