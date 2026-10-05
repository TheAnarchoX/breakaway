# Set up a breakaway board

You're helping someone set up their own breakaway board: a task board for them and their coding agents, on their own Cloudflare account. It's theirs: they own it, run it, and decide. You do the typing. This file is the whole job. Read it to the end before you start, then work through it one step at a time.

The owner started you with something like: "Set up a breakaway board for me. Read https://leavethepack.dev/install.md and follow it." The full guide behind these steps is at https://leavethepack.dev/docs/quickstart/, if a step needs more detail. The install is done when one real task is closed by a merged pull request, not when the board is deployed.

## How you work

- **They decide, you do the typing.** Before anything that changes something outside this folder (a GitHub repository or its settings, anything on Cloudflare, a deploy, a task on the board), say in one line what it does and wait for a yes.
- **Look before you make.** Never make anything twice: a second install repository, Worker, `tasks.env`, GitHub App, or routine. When something exists but doesn't match what you expect, stop and ask.
- **Never ask for a secret in the chat, and never print one.** A token or key goes straight from where it is to where it's needed: a command reads it from a file without showing it, or the owner types it into their own terminal, where nothing reaches you. If one lands in the conversation anyway, say so, and have them make a new one.
- **Some steps are theirs.** Signing in to Cloudflare, GitHub, and claude.ai, making a token, anything in a browser, and the commands that ask for a secret. For each, name the page (with its link), what to press or type, and what the page shows when it worked. Then wait until they say it's done.
- **Each step ends with a check, read one of three ways.** **Verified**: a command or the board tested it. **Not verified yet**: it's set up, but nothing has used it; say what will verify it. **Failed**: say what failed and the fix. Never call a step done when it's only Not verified yet. Once the board is up, `npx breakaway connections` lists everything it leans on: a row that reads Working or Verified is Verified, Not verified yet is the same, and Needs attention is Failed, with the row's fix.
- **POSIX shell only.** Every command here runs in a POSIX shell on macOS, Linux, or Windows through WSL.
- **Keep it short.** One step at a time: what you're doing and why, in a sentence, then do it.

## 0. The system, and what's there

**The system.** Run `uname -s`. `Darwin` is macOS and `Linux` is Linux, or WSL when `grep -qi microsoft /proc/version` succeeds: carry on. Anything else (`MINGW…`, `MSYS…`, `CYGWIN…`, or no `uname`) is Windows itself, which the board doesn't support. Say so plainly, and that the fix is WSL: they open PowerShell as administrator, run `wsl --install`, restart, and open **Ubuntu** from the Start menu (https://learn.microsoft.com/windows/wsl/install). Inside it they install Node and Claude Code, make a folder, open Claude Code there, and paste the same line. Everything from here happens inside WSL; stop until then.

**The tools.** Check, and help install what's missing:

- Node 20 or later: `node --version`.
- Git, and the GitHub CLI signed in: `gh auth status`. If it isn't, they run `gh auth login` themselves and pick GitHub.com and the browser; it ends with "Logged in as <login>".
- Wrangler signed in to their Cloudflare account: `npx wrangler whoami`. If it isn't, they run `npx wrangler login` themselves: a Cloudflare page opens, they press **Allow**, and the terminal says "Successfully logged in". Note the account ID `whoami` shows: it isn't a secret, and step 1 needs it.

**What's there.** Before asking anything, look, in this order, and say what you found in one short list:

1. `~/.config/breakaway/tasks.env`: `test -f ~/.config/breakaway/tasks.env`, and which board it's for, `sed -n 's/^BREAKAWAY_URL=//p' ~/.config/breakaway/tasks.env`. Read nothing else from it.
2. The install repository: `breakaway.config.json` in this folder, or in the folder they name. If it's there, its `worker` and `url`, and `git remote get-url origin`.
3. The Worker: `npx wrangler deployments list --name <worker>`.
4. The board: `npx breakaway health`.
5. Its repositories: `npx breakaway repos`.
6. Its connections: `npx breakaway connections --json`.

Then carry on from the first step below that isn't done, and never repeat one that is:

| Step | Done when |
| --- | --- |
| 1. The install repository | `breakaway.config.json` is on the GitHub repository's `main`, and its `production` environment has both Cloudflare secrets |
| 2. The board's secrets | `tasks.env` exists |
| 3. Deploy | `health` says the board is healthy, and `tasks.env` has its address |
| 4. The repository their agents work on | `repos` lists it |
| 5. GitHub | the GitHub rows on Connections are Verified, and the board's files are on the repository's default branch |
| 6. Agents from the board | its **Agent routine** row is connected (or they have no routines) |
| 7. The first task | a task is closed by a merged pull request |

Stop and ask, and make nothing, when what's there doesn't fit:

- a `tasks.env` for another address, or a `breakaway.config.json` whose `worker` isn't the Worker they mean;
- a Worker that exists while `tasks.env` doesn't: never run `init-secrets` for it, since new secrets lock them out of that board. Their copy may be in their password manager; otherwise https://leavethepack.dev/docs/operations/ says how to recover each value;
- `health` answering 401: the token in `tasks.env` isn't the one on the Worker. `npx wrangler secret list --name <worker>` shows only names: if the three secrets are already there, they're another `tasks.env`'s, so never put new ones over them.

Then ask what's still open, in one message, and nothing the look already answered:

1. What to call the board, and the GitHub `owner/name` for its install repository, the private repository that deploys it (for example `<their login>/my-board`).
2. Where the board should answer: an address on a domain in their Cloudflare account (like `tasks.example.com`), or nothing, for a `workers.dev` address.
3. The repository their agents will work on (`owner/name`), a short name for it, and its areas, each with a work-ID prefix (like `app:APP` or `docs:DOC`).
4. Whether they have a Claude plan with routines, to start agents from the board. Without one, the board works the same, but they give up starting agents from the board, live output on a task, starting by itself when ready, chase, and scheduled routines; they start agents themselves in Claude Code.
5. `stable` (recommended: each new release comes as a pull request they merge) or `main` (the board follows every change to breakaway).

## 1. The install repository

In a new, empty folder, after a yes:

```sh
git init
gh repo create <owner>/<name> --private --source . --remote origin
npx breakaway install init --name "<board name>" --worker <worker-name> --channel <stable|main>
```

Add `--url https://<address>` for an address on their own domain. `install init` writes `breakaway.config.json`, `breakaway.json`, the Deploy and Update workflows, and a README, and never overwrites a file. Commit everything and push it to `main`.

Then the repository's settings, after a yes:

```sh
gh api -X PUT repos/<owner>/<name>/environments/production
gh secret set CLOUDFLARE_ACCOUNT_ID --env production --repo <owner>/<name> --body <account ID>
gh api -X PUT repos/<owner>/<name>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

**Theirs: the Cloudflare API token.** At https://dash.cloudflare.com/profile/api-tokens, they press **Create Token**, then **Use template** beside **Edit Cloudflare Workers**. Under **Account Resources** they pick their account; under **Zone Resources**, their domain's zone for an address on their own domain, or all zones otherwise. **Continue to summary**, then **Create Token**: the page shows the token once. Then they run this in their own terminal, not through you; it asks for the token without showing it, and says "Set Actions secret CLOUDFLARE_API_TOKEN":

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production --repo <owner>/<name>
```

That token can run `wrangler deploy`, so Deploy can apply a new address, cron triggers, or a new Durable Object class by itself instead of stopping for them. That's theirs to turn on; after a yes:

```sh
gh variable set BREAKAWAY_DEPLOY_CHANGES --body true --repo <owner>/<name>
```

**Check:** `gh api repos/<owner>/<name>/environments/production/secrets --jq '.secrets[].name'` lists both secrets, and the workflows are on `main`. That's Verified; whether the token works is Not verified yet, until step 3's dry run.

## 2. The board's secrets

Only when step 0 found no `tasks.env` and no Worker:

```sh
npx breakaway init-secrets
```

It writes `~/.config/breakaway/tasks.env` (only they can read it), lists what to keep, and prints which value goes where, never the values. Never run it with `--force` on an install that has a board.

**Check:** the file exists. The secrets go on the Worker in step 3, once it exists.

## 3. Deploy

Run the install repository's Deploy workflow, first as a dry run, then for real, after a yes:

```sh
gh workflow run deploy.yml --repo <owner>/<name> -f dry-run=true
gh run list --repo <owner>/<name> --workflow deploy.yml --limit 1   # it takes a few seconds to show
gh run watch <run ID> --repo <owner>/<name> --exit-status
```

When the dry run passes, run it again without `-f dry-run=true` and watch it the same way. On an address on their own domain, this first deploy can wait up to five minutes for its certificate, and can end with a notice that the board is waiting for its secrets: that's expected, they go on next. It stops with a message when something needs their hands, and it refuses to make a second, empty board when the install already has one: read the run's log (`gh run view <run ID> --repo <owner>/<name> --log-failed`) and say what it asks for.

Then put the three secrets on the Worker, unless `npx wrangler secret list --name <worker-name>` already lists them (step 0 says what then). Each command reads its value from `tasks.env` and pipes it to Wrangler, so it never shows:

```sh
v() { sed -n "s/^$1=//p" ~/.config/breakaway/tasks.env; }
v BREAKAWAY_TOKEN | npx wrangler secret put TASKS_API_TOKEN --name <worker-name>
v BREAKAWAY_CLIENT_ID | npx wrangler secret put TASKS_CLIENT_ID --name <worker-name>
v BREAKAWAY_SYNC_KEY | npx wrangler secret put TASKS_SYNC_KEY --name <worker-name>
```

The board's address is the one they chose, or the `workers.dev` one the run's log shows. Add it to `tasks.env` as `BREAKAWAY_URL=<address>` if it isn't there, and to the install repository as the variable `BREAKAWAY_URL` (`gh variable set BREAKAWAY_URL --repo <owner>/<name> --body <address>`), so later deploys check it.

**Check:** `npx breakaway health` says the board is healthy. Then they open the address in their browser and sign in with `BREAKAWAY_TOKEN` from `tasks.env`, copying it from the file themselves. The board says it has no repository yet and points to **Set up the board** on Connections, which ticks the steps below as they work.

## 4. The repository their agents work on

```sh
npx breakaway repos add <slug> <owner/name> --area <area:PREFIX> --area <area:PREFIX>
```

The first repository is the board's default. A prefix belongs to one repository and never changes.

**Check:** `npx breakaway repos` lists it.

## 5. GitHub

The board reads GitHub through a private GitHub App made for it.

1. **Theirs: make the App.** On the board, they open **GitHub** in the sidebar and press **Create the App on GitHub**. GitHub shows a **Create GitHub App** page with what the App may read; they keep the name and press **Create GitHub App**, and land back on the board, which shows a `npx breakaway github-connect <code>` command. They run it in their own terminal, in this folder, within the hour. It stores the App's keys and deploys a new version of the Worker. If it refuses because the board already has a working App, stop: that's the App to keep, and `--replace` is only for one Connections says has failed.
2. **Theirs: install it.** The command prints the install link. On GitHub they pick **Only select repositories**, choose the repository from step 4 (and the install repository too if they chose `main`, so the board can start its Deploy workflow), and press **Install**. Within a few seconds the board's GitHub view fills in.
3. **Yours, after a yes:** turn on auto-merge for the repository: `gh api -X PATCH repos/<owner/name> -F allow_auto_merge=true`.
4. **Yours:** add the board's files to the repository with `npx breakaway repos init <slug>`. It writes the agent prompt from sections you can fill in well: read the repository's README, `AGENTS.md`, and package scripts first, then pass `--building`, `--checks`, and `--pull-requests` from what you found. Ask them for `--direction` (what matters most right now) and `--never-share` (what must never leave the repository). It opens a pull request on the repository. They review and merge it on GitHub.

**Check:** `npx breakaway connections` shows the GitHub rows Verified: the App, installed, permissions, auto-merge, and sync. The webhook stays Not verified yet until GitHub sends one, which the merge in item 4 does.

## 6. Agents from the board

Only with a Claude plan that has routines. Without one, say again what they give up (step 0, question 4) and go to step 7.

**Theirs: the routine.** At https://claude.ai/code/routines, they press **New routine**, and go down this list, one line at a time, saying each one is done:

- [ ] **Repository:** the one from step 4.
- [ ] **Instructions:** the stub, from the board's **Agents** view (**Copy stub**), pasted as it is.
- [ ] **Cloud environment, network access:** **Custom**, with the board's host under **Allowed domains**, and **Also include default list of common package managers** ticked.
- [ ] **Cloud environment, API credential:** **Add credential**, type **Bearer**, the board's host as the allowed website, and `BREAKAWAY_TOKEN` from `tasks.env` as the value, which they copy from the file themselves. Not as an environment variable: the credential keeps the token out of the session.
- [ ] **Cloud environment, environment variable:** `BREAKAWAY_AGENT=claude-cloud`.
- [ ] **Trigger:** **Add trigger**, **API**. It shows a URL and a token, the token once.

**Theirs: connect it.** On the board's Connections, the **Agent routine** row's form takes the trigger's URL and token; or they run `npx breakaway agents-connect` in their own terminal and paste them when it asks.

**Check:** `npx breakaway connections` shows **Agent routine** connected and **Not verified yet**: the board can't read claude.ai, so nothing proves the routine works until an agent it starts claims a task. Step 7 does that. Don't start an agent just to test it.

## 7. The first task

The install is done when one real task is closed by its merged pull request.

1. **Propose one.** Read the repository's README and its open issues (`gh issue list --repo <owner/name> --limit 20`), and propose one small, useful task: a title, a sentence on why, and a done when they can check in a few minutes. After a yes, add it from a checkout of the repository (`gh repo clone <owner/name>` next to this folder, if there's none):

   ```sh
   npx breakaway add "<title>" --project <area> --tag agent --horizon now --brief "<what and why>" --done-when "<what they can check>"
   ```

2. **With routines:** they open **Set up the board** on Connections; its last step opens the **Add a repository** wizard's agent step, where they press **Start an agent on <ID>** (if it names another task, they press **Start an agent** on <ID>'s own page instead). The step ticks as it goes: started, live output, pull request. If the start fails, the step says why and the fix, and **Try again**. The **Agent routine** row reads **Verified by <ID>** once the agent claims the task.
3. **Without routines:** they open Claude Code in the checkout and say "Work on <ID> from the board". The board's files tell it how to claim, report, and open the pull request.
4. **Theirs: review and merge.** The pull request's title starts with the work ID and its description says `Closes <ID>.` They check it against the done when, and merge it on GitHub or on the board's pull request page. Merging stays theirs; the agent never merges.

**Check:** `npx breakaway show <ID>` says it's completed, merged in the pull request. With routines, the wizard's last check, merged, ticks too.

## Before you stop

Run `npx breakaway connections` and go through anything that's Failed, with the fix each row gives. Taskwarrior is optional: if they use it, `npx breakaway setup` connects it.

Ask them to confirm they've put these in their password manager, whole, since the board can't give the values back:

- `~/.config/breakaway/tasks.env`: the token, and the only copy of the sync secret.
- `~/.config/breakaway/tasks-routines.json`, when there is one: other repositories' routines.
- `~/.config/breakaway/github-app.json`, only if `github-connect` wrote it: the App's keys, until they're stored.

Tell them how to get back in: open Claude Code in this same folder and paste the same line; it looks first and carries on where it stopped. Tell them where things are: the board in their browser, `npx breakaway help` for the CLI, and the docs at https://leavethepack.dev/docs/. Then stop. From here on, the board is theirs.
