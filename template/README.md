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
2. **Make a GitHub environment named `production`** (Settings, Environments) with two secrets: `CLOUDFLARE_API_TOKEN`, a token that can edit Workers on your account, and `CLOUDFLARE_ACCOUNT_ID`.
3. **Allow the update workflow to open pull requests:** Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests".
4. **Set the board's secrets** (`npx breakaway init-secrets`, then the Worker's secrets or your Secrets Store: see `.dev.vars.example`).
5. **Run the Deploy workflow** from the Actions tab. Choose "dry-run" first to check everything up to the Worker without changing it.
6. **Optional:** set a repository variable, `BREAKAWAY_URL`, to where the board answers. The deploy checks that address after it deploys, and goes back to the previous version if the new one doesn't answer.

## How it updates

- **`stable`** (the default): `breakaway.json` pins a release. The update workflow opens a pull request that bumps it, with the release notes. Merging it deploys it. Nothing deploys until you merge.
- **`main`**: the board follows the latest pre-release, one per merge to breakaway. The update workflow starts a deploy when there is a newer one.

Both workflows run breakaway's CLI from the release's own source on GitHub, with Node. Apart from `wrangler`, nothing comes from npm.

If Deploy stops with "Couldn't list the Worker's deployments", it changed nothing: only a Worker that doesn't exist yet counts as a first deploy. Check that `CLOUDFLARE_ACCOUNT_ID` is your account's ID (32 hex characters) and that `CLOUDFLARE_API_TOKEN` can read and edit Workers on it, then run Deploy again.

A release can need steps by hand (a change to the Durable Object classes, say). The workflow stops with those steps in its message and deploys nothing; do them, then deploy with `wrangler`. The same stop happens when you change something in `breakaway.config.json` the workflow can't deploy: the address, cron triggers, or Durable Object classes. Apply that change yourself (`npx breakaway install config` makes the Worker config), then run Deploy again.

## Change the install

Edit `breakaway.config.json` and merge it: Deploy runs on every push to `main`.
