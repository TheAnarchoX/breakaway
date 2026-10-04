# Set up a breakaway board

You're helping someone set up their own breakaway board: a task board for them and their coding agents, on their own Cloudflare account. It's theirs: they own it, run it, and decide. You do the typing. This file is the whole job. Read it to the end before you start, then work through it one step at a time.

The owner started you with something like: "Set up a breakaway board for me. Read https://leavethepack.dev/install.md and follow it." The full guide behind these steps is at https://leavethepack.dev/docs/quickstart/, if a step needs more detail.

## How you work

- **They decide, you do the typing.** Before anything that changes something outside this folder (a GitHub repository or its settings, anything on Cloudflare, a deploy), say in one line what it does and wait for a yes.
- **Never ask for a secret in the chat, and never print one.** A token or key goes straight from where it is to where it's needed: a command reads it from a file without showing it, or the owner types it into their own terminal, where nothing reaches you. If one lands in the conversation anyway, say so, and have them make a new one.
- **Some steps are theirs.** Signing in to Cloudflare, GitHub, and claude.ai, making a token, anything in a browser, and the commands that ask for a secret. Say exactly what to click or type, then wait until they say it's done.
- **Each step ends with a check.** Don't go on until it passes. When it doesn't, say what failed and what to do about it. Once the board is up, `npx breakaway connections` lists everything it leans on, with the fix for each row that needs attention.
- **Keep it short.** One step at a time: what you're doing and why, in a sentence, then do it.

## 0. What's there, and what they want

Check, and help install what's missing:

- Node 20 or later: `node --version`.
- Git, and the GitHub CLI signed in: `gh auth status`. If it isn't, they run `gh auth login` themselves.
- Wrangler signed in to their Cloudflare account: `npx wrangler whoami`. If it isn't, they run `npx wrangler login` themselves. Note the account ID it shows: it isn't a secret, and step 1 needs it.

Then ask, in one message:

1. What to call the board, and the GitHub `owner/name` for its install repository, the private repository that deploys it (for example `<their login>/my-board`).
2. Where the board should answer: an address on a domain in their Cloudflare account (like `tasks.example.com`), or nothing, for a `workers.dev` address.
3. The repository their agents will work on (`owner/name`), a short name for it, and its areas, each with a work-ID prefix (like `app:APP` or `docs:DOC`).
4. Whether they have a Claude plan with routines, to start agents from the board. Without one, the board works the same, and they start agents themselves.
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

The Cloudflare API token is theirs to make. On Cloudflare: My Profile, API Tokens, Create Token, the **Edit Cloudflare Workers** template, for their account. For an address on their own domain, also add Zone, Workers Routes, Edit, for that domain's zone. Then they run this in their own terminal, not through you. It asks for the token without showing it:

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production --repo <owner>/<name>
```

That token can run `wrangler deploy`, so Deploy can apply a new address, cron triggers, or a new Durable Object class by itself instead of stopping for them. That's theirs to turn on; after a yes:

```sh
gh variable set BREAKAWAY_DEPLOY_CHANGES --body true --repo <owner>/<name>
```

**Check:** `gh api repos/<owner>/<name>/environments/production/secrets --jq '.secrets[].name'` lists both secrets, and the workflows are on `main`.

## 2. The board's secrets

```sh
npx breakaway init-secrets
```

It writes `~/.config/breakaway/tasks.env` (only they can read it) and prints which value goes where, never the values. Tell them to keep a copy of that file in their password manager: it holds the only copy of the sync secret.

**Check:** the file exists. The secrets go on the Worker in step 3, once it exists.

## 3. Deploy

Run the install repository's Deploy workflow, first as a dry run, then for real, after a yes:

```sh
gh workflow run deploy.yml --repo <owner>/<name> -f dry-run=true
gh run list --repo <owner>/<name> --workflow deploy.yml --limit 1   # it takes a few seconds to show
gh run watch <run ID> --repo <owner>/<name> --exit-status
```

When the dry run passes, run it again without `-f dry-run=true` and watch it the same way. It stops with a message when something needs their hands: read the run's log (`gh run view <run ID> --repo <owner>/<name> --log-failed`) and say what it asks for.

Then put the three secrets on the Worker. Each command reads its value from `tasks.env` and pipes it to Wrangler, so it never shows:

```sh
v() { sed -n "s/^$1=//p" ~/.config/breakaway/tasks.env; }
v BREAKAWAY_TOKEN | npx wrangler secret put TASKS_API_TOKEN --name <worker-name>
v BREAKAWAY_CLIENT_ID | npx wrangler secret put TASKS_CLIENT_ID --name <worker-name>
v BREAKAWAY_SYNC_KEY | npx wrangler secret put TASKS_SYNC_KEY --name <worker-name>
```

The board's address is the one they chose, or the `workers.dev` one the run's log shows. Add it to `tasks.env` as `BREAKAWAY_URL=<address>`, and to the install repository as the variable `BREAKAWAY_URL` (`gh variable set BREAKAWAY_URL --repo <owner>/<name> --body <address>`), so later deploys check it.

**Check:** `npx breakaway health` says the board is healthy. Then they open the address in their browser and sign in with `BREAKAWAY_TOKEN` from `tasks.env`, copying it from the file themselves.

## 4. The repository their agents work on

```sh
npx breakaway repos add <slug> <owner/name> --area <area:PREFIX> --area <area:PREFIX>
```

The first repository is the board's default. A prefix belongs to one repository and never changes.

**Check:** `npx breakaway repos` lists it.

## 5. GitHub

The board reads GitHub through a private GitHub App made for it.

1. **Theirs:** on the board's GitHub view, press **Connect GitHub**, make the App, and copy the code it shows. Then they run `npx breakaway github-connect <code>` in their own terminal. It stores the App's keys and deploys a new version of the Worker.
2. **Theirs:** install the App on the repository from step 4, and on the install repository if they chose `main` (the board starts its Deploy workflow).
3. **Yours, after a yes:** turn on auto-merge for the repository: `gh api -X PATCH repos/<owner/name> -F allow_auto_merge=true`.
4. **Yours:** add the board's files to the repository with `npx breakaway repos init <slug>`. It writes the agent prompt from sections you can fill in well: read the repository's README, `AGENTS.md`, and package scripts first, then pass `--building`, `--checks`, and `--pull-requests` from what you found. Ask them for `--direction` (what matters most right now) and `--never-share` (what must never leave the repository). It opens a pull request on the repository. They review and merge it.

**Check:** `npx breakaway connections` shows the GitHub rows as Working: the App, the webhook (once GitHub has sent one), installed, permissions, auto-merge, and sync.

## 6. Agents from the board

Only with a Claude plan that has routines. Otherwise skip to step 7.

1. **Theirs:** at https://claude.ai/code/routines, make a routine for the repository, with a cloud environment whose network access allows the board's host (Custom, plus the default package managers). Add the board's token as an API credential for that host, and `BREAKAWAY_AGENT=claude-cloud` as an environment variable. Paste the stub `repos init` wrote (`tools/tasks/prompts/stub.md` in the repository) as its instructions, and add an API trigger.
2. **Theirs:** run `npx breakaway agents-connect` in their own terminal and paste the trigger's URL and token when it asks.

**Check:** `npx breakaway connections` shows **Agent routine** as Working. Once they start an agent on a task, **Live output from sessions** reads Working when its session sends something back.

## 7. Done

Run `npx breakaway connections` and go through anything that still needs attention, with the fix each row gives. Taskwarrior is optional: if they use it, `npx breakaway setup` connects it.

Then add a first task together, in a checkout of the repository: `npx breakaway add "<something small that needs doing>" --project <area> --tag agent --horizon now`. Show them the board. Tell them where things are: the board in their browser, `npx breakaway help` for the CLI, and the docs at https://leavethepack.dev/docs/. Then stop. From here on, the board is theirs.
