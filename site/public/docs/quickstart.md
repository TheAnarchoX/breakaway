# Run your own board

> Eight steps from nothing to a board that starts agents and updates itself. Each step ends with a check on Connections, the board’s own list of what it leans on.

breakaway is free, and it runs on your own Cloudflare account. This guide takes you from nothing to a board that starts agents and updates itself. It has eight steps, and each one ends with a check on **Connections**, the board’s own list of what it leans on. A check is a row that reads **Working**. If it reads **Needs attention**, the row says what’s wrong and how to fix it.

The licence is FSL-1.1-Apache-2.0: free to use, change, and self-host for anything except offering a competing service, and each release becomes Apache 2.0 two years after it ships. That’s fair source.

## With Claude Code

Paste this into [Claude Code](https://claude.com/claude-code), in an empty folder:

```text
Set up a breakaway board for me. Read https://leavethepack.dev/install.md and follow it.
```

It works through the steps below with you. It runs and checks what it can, and stops for each step only you can do: signing in, making a token, anything with a secret. It never asks for a secret in the chat. The prompt it reads is [`prompts/install.md`](https://github.com/TheAnarchoX/breakaway/blob/main/prompts/install.md) in breakaway’s repository.

Rather do it by hand? The steps follow.

## What you need

- A Cloudflare account, and a token that can edit Workers on it.
- A GitHub account that can make a private repository, and one for the code the agents work on.
- Node 20 or later, and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) signed in to your Cloudflare account. The commands that store secrets call it.
- A Claude plan that has [routines](https://claude.ai/code/routines), to start agents from the board. The board works without one: agents you start yourself use the CLI.
- Taskwarrior 3, if you want it. It’s optional: the web board and the CLI work without it.

You’ll use two repositories. The **install repository** holds your board’s settings and the workflows that deploy it. The other is the code your agents work on.

## 1. Make the install repository

```sh
mkdir my-board && cd my-board
git init
npx breakaway install init
```

It asks for the board’s name, the Worker’s name, an address on your own domain (blank is fine: the board answers on workers.dev), and a Secrets Store ID (blank is fine: the secrets go on the Worker). It writes the settings, the Deploy and Update workflows, and a README. It never overwrites a file.

Then open `breakaway.config.json` and add one line, so the board can look for updates on its own: `"installRepository": "<you>/my-board"`. Keep `channel` the same as in `breakaway.json`: `stable` pins a release and sends you a pull request to move it, and `main` follows every merge to breakaway.

Push it to a **private** GitHub repository, and keep it private. Then, on GitHub:

1. Make an environment named `production` (Settings, Environments) with two secrets: `CLOUDFLARE_API_TOKEN`, a Cloudflare API token, and `CLOUDFLARE_ACCOUNT_ID`. Workers Editor on the board’s Worker deploys each release; a token that can also run `wrangler deploy` lets Deploy apply a new address, cron triggers, or a new Durable Object class too. The install repository’s README says which token does what.
2. Turn on Settings, Actions, General, “Allow GitHub Actions to create and approve pull requests”. The update workflow needs it.

**Check:** nothing on Connections yet, because there’s no board. The files are in the repository, and the environment has its secrets.

## 2. Set the board’s secrets

```sh
npx breakaway init-secrets
```

It writes `tasks.env` in `~/.config/breakaway` and says which value goes where. Three are required: `TASKS_API_TOKEN`, `TASKS_CLIENT_ID`, and `TASKS_SYNC_KEY`. Set each as a Worker secret (Cloudflare, Workers, your Worker, Settings, Variables and Secrets), or in your Secrets Store if you gave a Secrets Store ID. Without a Secrets Store, the Worker doesn’t exist until its first deploy: set them right after step 3’s deploy. `.dev.vars.example` in the repository lists them.

> `tasks.env` holds the only copy of the sync secret. Keep it in your password manager too.

**Check:** you can’t read the board yet, so this step is checked in step 3: the **Secrets Store bindings** row under Cloudflare reads **Working**. If it says `TASKS_API_TOKEN is unset`, that secret isn’t on the Worker yet.

## 3. Deploy it

On GitHub, open the install repository’s Actions tab, pick **Deploy**, and run it with **dry-run** on. It checks the release and builds it, and stops before it touches the Worker. When it passes, run it again with dry-run off. It deploys, checks that the Worker answers `/api/ping`, and goes back to the previous version if it doesn’t.

It stops with a message when something needs your hands: a release that has manual steps, or a change a version upload can’t carry (the address, cron triggers, or a new Durable Object class) when its token can’t run `wrangler deploy` or the repository variable `BREAKAWAY_DEPLOY_CHANGES` isn’t `true`. Do what the message says, then run Deploy again. It never changes the Worker’s name or its Durable Object, since either opens an empty board.

**Check:** the run is green. Then, once you’re signed in (next step), the Cloudflare rows read **Working**: **Worker**, **Secrets Store bindings**, **Cron (every 5 minutes)** (it reads “no run recorded yet” until the first run, within 5 minutes), and **TaskChampion sync server**.

## 4. Sign in

Open the board’s address (the workers.dev address Cloudflare shows for the Worker, or your own). Sign in with `BREAKAWAY_TOKEN` from `tasks.env`.

Every view says “This board has no repository yet” and points to Connections. Open it. **Set up the board** lists the rest of this guide’s steps, and ticks each one when its connection works.

**Check:** you’re in. A wrong token keeps asking for it; copy `BREAKAWAY_TOKEN` again.

## 5. Register a repository

Register the repository your agents work on: on Connections, in **Set up the board**, fill in its short name, its GitHub `owner/name`, and its areas, each an area and a work-ID prefix like `product:PRD`. Or from a terminal:

```sh
npx breakaway repos add <slug> <owner/name> --area product:PRD
```

The first repository you register is the board’s default. A prefix belongs to one repository and never changes.

**Check:** **Registered repository** reads **Working**, and **Register a repository** is ticked.

## 6. Connect GitHub

The board reads GitHub through a private GitHub App that you make for it.

1. On the board’s GitHub view, press **Connect GitHub**, make the App, and copy the code it shows.
2. Run `npx breakaway github-connect <code>`. It stores the App’s keys as secrets and deploys a new version of the Worker.
3. Install the App on the repository you registered, and on the install repository if you chose `main`: the board starts its Deploy workflow, which needs read and write on Actions.
4. On the repository’s GitHub settings, General, Pull Requests, turn on **Allow auto-merge**.
5. Add the board’s files to the repository: `npx breakaway repos init <slug>`. In a terminal it asks for each part of the agent prompt. It pushes the files as the first commit of an empty repository, or opens a pull request. Then fill in anything left in `<…>` in the agent prompt and `AGENTS.md`, and merge it.

**Check:** press **Check now** on Connections. These rows read **Working**: **GitHub App**, **Webhook** (once GitHub has sent one), **Installed on `owner/name`**, **Permissions on `owner/name`**, **Allow auto-merge on `owner/name`**, and **Sync with `owner/name`**.

Each says what to change when it doesn’t. Pull requests and Contents need write, and Actions needs write on a repository with a deploy pipeline. An agent prompt with a `<…>` left in it makes **Agent routine** need attention until you fill it in.

## 7. Connect a Claude routine

The board starts agents through a routine you save on claude.ai.

1. At [claude.ai/code/routines](https://claude.ai/code/routines), make a new routine: name it after the repository, add the repository, and pick a cloud environment. In the environment, set **Network access** to **Custom** and allow the board’s host, add the board’s token as an API credential (or set `BREAKAWAY_TOKEN`), and set `BREAKAWAY_AGENT=claude-cloud`.
2. Paste the stub as its instructions. The Agents view shows it, and `repos init` copied it into the repository.
3. Add an **API** trigger, generate its token, and copy the URL and the token. The token shows once.
4. Run `npx breakaway agents-connect` and paste both. For another repository, add `--repo <slug>`.

**Check:** **Agent routine** reads **Working**. Start an agent on a task: **Live output from sessions** reads **Working** once a session sends something back. If it says a started session sends nothing back, the environment doesn’t allow the board’s host. [Agents](https://leavethepack.dev/docs/agents/) has the environment settings in full.

> **What Connections can’t check.** It can’t see claude.ai or Cloudflare’s own settings, so these are yours to check: the routine’s cloud environment (the allowed hosts: the board’s, `api.githubcopilot.com`, `registry.npmjs.org`, and the common package managers), the routine’s prompt (it should match the stub the Agents view shows), and Cloudflare’s custom domain, Secrets Store, and cron triggers.

## 8. Connect the CLI and Taskwarrior

On the machine you work from, `tasks.env` needs the board’s address too. Add `BREAKAWAY_URL=<the board’s address>`, then:

```sh
npx breakaway health
npx breakaway setup
```

`health` checks that the CLI reaches the board. `setup` writes Taskwarrior’s settings and runs the first `task sync`. To use Taskwarrior in a checkout, [Taskwarrior](https://leavethepack.dev/docs/taskwarrior/) shows the three lines for its `.taskrc`.

**Check:** **Taskwarrior sync** reads **Working**, and **Connect the CLI and Taskwarrior** is ticked. Then **Set up the board** disappears: every step is done.

Add a first task and claim it from a checkout of the repository:

```sh
npx breakaway add "Write the README’s install section" --project docs --tag agent --horizon now \
  --brief "Say how to install and run it." --done-when "A newcomer can run it from the README alone."
npx breakaway claim DOC-1
```

That’s the board, working. Next: [Concepts](https://leavethepack.dev/docs/concepts/) explains what you just made, and [the playbook](https://leavethepack.dev/docs/playbook/) covers how to get agents to finish what you hand them.

## When something’s wrong

Run `npx breakaway connections`. It lists every row with its state and the fix, the same as the Connections view. [Operating a board](https://leavethepack.dev/docs/operations/#when-somethings-wrong) covers the rest.
