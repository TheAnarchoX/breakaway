# {{name}}

This repository deploys a [breakaway](https://github.com/TheAnarchoX/breakaway) board, `{{worker}}`, to your own Cloudflare account. It holds the board's config and two workflows; the board's code comes from breakaway's releases. Keep this repository private.

The board answers at {{address}}.

## What's here

| File | What |
| --- | --- |
| `breakaway.config.json` | This install's names: the board's name, Worker, address, Secrets Store, and Durable Object |
| `breakaway.json` | The release this board runs (`version`) and how it updates (`channel`: `stable` or `main`) |
| `.github/workflows/deploy.yml` | Deploys the release to the Worker, checks that it answers, and goes back if it doesn't |
| `.github/workflows/update.yml` | Looks for a newer release every hour |
| `.dev.vars.example` | The board's secrets and where each comes from |

## Set it up once

1. **Push this to a private GitHub repository.**
2. **Make a GitHub environment named `production`** (Settings, Environments) with two secrets: `CLOUDFLARE_API_TOKEN`, a Cloudflare API token ([which token does what](#which-token-does-what)), and `CLOUDFLARE_ACCOUNT_ID`.
3. **Allow the update workflow to open pull requests:** Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests".
4. **Set the board's secrets** (`npx breakaway init-secrets`, then the Worker's secrets or your Secrets Store: see `.dev.vars.example`).
5. **Run the Deploy workflow** from the Actions tab. Choose "dry-run" first to check everything up to the Worker without changing it.
6. **Optional:** set a repository variable, `BREAKAWAY_URL`, to where the board answers. The deploy checks that address after it deploys, and goes back to the previous version if the new one doesn't answer.

## How it updates

- **`stable`** (the default): `breakaway.json` pins a release. The update workflow opens a pull request that bumps it, with the release notes. Merging it deploys it. Nothing deploys until you merge.
- **`main`**: the board follows the latest pre-release, one per merge to breakaway. The update workflow starts a deploy when there is a newer one.

Both workflows run breakaway's CLI from the release's own source on GitHub, with Node. Apart from `wrangler`, nothing comes from npm.

If Deploy stops with "There is no Worker named …, but this install already has a board", it changed nothing: `worker` in `breakaway.config.json` isn't the name the board runs as, and deploying it would make a second, empty board. Put the name back. Only if that board is gone and you want an empty one, delete the repository variable `BREAKAWAY_URL`, then run Deploy again.

If Deploy stops with "Couldn't list the Worker's deployments", it changed nothing: only a Worker that doesn't exist yet counts as a first deploy. Check that `CLOUDFLARE_ACCOUNT_ID` is your account's ID (32 hex characters) and that `CLOUDFLARE_API_TOKEN` can read and edit Workers on it, then run Deploy again.

A release can need steps by hand (a Durable Object class deleted or renamed, say). The workflow stops with those steps in its message and deploys nothing; do them, then deploy with `wrangler`. A release whose only step is `wrangler deploy` says so in its notes, and Deploy runs it itself when it may ([below](#which-token-does-what)). The same goes for a new address in `breakaway.config.json`, which a version upload can't carry: without that, apply it yourself (`npx breakaway install config` makes the Worker config), then run Deploy again.

## Which token does what

`CLOUDFLARE_API_TOKEN` decides what Deploy can do by itself. Most deploys only upload a new version of the Worker. A deploy that changes the address, the cron triggers, or the Durable Object classes needs `wrangler deploy`, and so a token that can run it:

| Token | What Deploy does |
| --- | --- |
| **Workers Editor on this Worker** | Uploads each release, checks it, and goes back if it fails. It stops on an address, cron, or Durable Object class change, and you apply that yourself. |
| **Workers Editor on every Worker**, and **Zone, Workers Routes, Write** on the board's zone | The same, and with the repository variable `BREAKAWAY_DEPLOY_CHANGES` set to `true`, it runs `wrangler deploy` for those changes too. Custom domains don't support per-Worker roles yet, so Editor has to cover every Worker. |

Either token also needs **Account, Secrets Store, Edit** when the board has a Secrets Store: every deploy binds its secrets. The very first deploy makes the Worker, which takes **Workers Admin**; after that, Editor is enough.

Whatever the token, Deploy never changes the Worker's name, its Durable Object (`store`), or its jurisdiction: each opens an empty board, so it stops instead.

With `wrangler deploy`:

- **A new address replaces the old one.** The Worker answers only on the addresses in its config, so the old one stops answering, and in a workflow `wrangler deploy` takes over the new hostname's DNS record, or another Worker's domain on it, without asking. Moving to another zone needs Workers Routes, Write on both zones. The check after the deploy asks the new address, for up to five minutes while its certificate is issued. If you set `BREAKAWAY_URL`, change it with the address.
- **Going back brings back the code only.** The address and cron triggers stay as `wrangler deploy` left them, and Cloudflare doesn't roll back across a new Durable Object class, so after one the only way is forward.

## Change the install

Edit `breakaway.config.json` and merge it: Deploy runs on every push to `main`.

To move the board to a new address without a gap, add the new one under `aliases` first, so both answer; then swap `url` and the alias; and remove the alias once nothing uses the old address. breakaway's [docs/tasks.md](https://github.com/TheAnarchoX/breakaway/blob/main/docs/tasks.md#moving-to-a-new-address) has the whole list of what names the address.
