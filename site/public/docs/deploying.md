# Deploying and updating

> How a change reaches your board: pre-releases and stable releases, the install repository’s Deploy and Update workflows, channels, manual steps, rollbacks, and the update feed.

breakaway **publishes releases and never deploys an install**. Every install, the maintainers’ own included, deploys a release from its own repository, and breakaway’s repository holds no Cloudflare credentials: even this site is deployed by Cloudflare, from a branch each stable release moves. Nothing runs new code on your board until you decide to update it.

## The shape of it

```text
merge to breakaway's main
        |
        v
CI passes -> a pre-release vX.Y.Z-main.N is published (the main channel)
        |
        v   (the maintainer runs the Release workflow)
a stable release vX.Y.Z (the stable channel)

your install repository ──reads── the update feed (/releases.json)
        |
        v
Update workflow -> a pull request that moves breakaway.json   (stable)
Update workflow / the board -> starts Deploy                  (main)
        |
        v
Deploy -> checks -> wrangler deploy -> /api/ping -> keep it, or go back
```

## Releases

- **Every merge to `main`**, once CI passes, publishes a GitHub pre-release `vX.Y.Z-main.N` on the **main** channel. It carries the bundle (`breakaway-bundle.tar.gz`: the Worker’s files and the web app’s `dist`), a `manifest.json`, and `SHA256SUMS`. The notes list the merged pull requests by title.
- **A stable release** `vX.Y.Z` is the maintainer’s: they run the **Release** workflow with the pre-release to promote. The bundle is that pre-release’s, unchanged, and the notes cover everything since the last stable.
- **The next version.** After a stable, pre-releases count patches from it by themselves. When the maintainer runs the **Release** workflow they also pick **next**: patch, the default, changes nothing; minor or major opens a pull request, once the stable is out, that sets `package.json` to the next minor or major after it (1.3.0 becomes 1.4.0 or 2.0.0), so the next merge publishes `v1.4.0-main.1`.
- **The CLI** is on npm as [`breakaway`](https://www.npmjs.com/package/breakaway), staged on npm by the same workflow, with provenance, and live once breakaway’s owner approves it there with 2FA. npm’s trusted publishing can’t yet read the OIDC identity of a repository as new as breakaway’s ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), so until it can, a token that can stage but never publish by itself stands in, in an environment only `main` can use. Every pre-release goes out under the `next` dist-tag, and a stable release as `latest`.
- **The version** is what `GET /api/ping` and `GET /api/health` report as `release`.

A **manifest** records the version, channel, commit, whether the release needs steps by hand (`manual`, and `wranglerDeploy` when its only step is `wrangler deploy`), and the lowest version it updates from (`updatesFrom`).

### Major releases and manual steps

A **major release** is one where an install has to do something by hand: a config or binding change, a Durable Object class or migration, a route or cron. Its notes have a **Manual steps** section and its manifest says `manual: true`, which an install’s Deploy stops on. When the only step is `wrangler deploy` (a new Durable Object class, a cron, a route), the manifest also says `wranglerDeploy: true`, and an install whose Deploy may run `wrangler deploy` does it itself. Data the Durable Object stores changes forward-only and additively, so an install can always go back one release, except across a new Durable Object class, which Cloudflare doesn’t roll back.

## Choosing a channel

| Channel | What you get | How it reaches you |
| --- | --- | --- |
| `stable` | A release the maintainer promoted. | The Update workflow looks hourly and opens a pull request that moves `breakaway.json`, with the release’s notes. You merge it, and Deploy runs. The board adds a note to your inbox, once per release. |
| `main` | The latest pre-release, one per merge. | The board starts your Deploy workflow by itself when there’s a newer one, so the GitHub App needs read and write on Actions on the install repository. The hourly Update run is the fallback. |

Keep `channel` in `breakaway.config.json` the same as in `breakaway.json`: `install init` writes both. An install with no `installRepository` makes no call and shows only what it runs.

## The install repository

`npx breakaway install init` writes five things:

| File | What |
| --- | --- |
| `breakaway.config.json` | The install’s names: the board’s name, Worker, address, Secrets Store, and Durable Object. |
| `breakaway.json` | The release this board runs (`version`) and how it updates (`channel`). |
| `.github/workflows/deploy.yml` | Deploys the release to the Worker, checks that it answers, and goes back if it doesn’t. |
| `.github/workflows/update.yml` | Looks for a newer release every hour. |
| `.dev.vars.example` | The board’s secrets, and where each comes from. |

Keep it private. Both workflows run breakaway’s CLI from the release’s own source on GitHub, with Node; apart from `wrangler`, nothing comes from npm.

### What Deploy does

1. Picks the release: `breakaway.json`’s pinned version on `stable`, or the latest pre-release on `main`. It reads the update feed named by the repository variable `BREAKAWAY_FEED`, and asks GitHub when the feed has nothing. Then it downloads the release’s bundle and checks it against `SHA256SUMS`.
2. Compares the Worker as it runs (the config the running release makes) with what this deploy makes. It stops, deploying nothing, if the release needs manual steps, or if the deploy changes what a version upload can’t carry (the address, cron triggers, or a new Durable Object class) and the install hasn’t let it run `wrangler deploy`: that takes a token that can and the repository variable `BREAKAWAY_DEPLOY_CHANGES` set to `true`. It always stops on a new Worker name, Durable Object (`store`), or jurisdiction, since each opens an empty board.
3. Builds the Worker’s config (`install config`) and looks the Worker up. A Worker that doesn’t exist is the first deploy only while the install has no board: if the repository variable `BREAKAWAY_URL` is set, or the address answers as a release, the name changed or is mistyped, and Deploy stops, deploying nothing. A **dry-run** run stops here, after `wrangler deploy --dry-run`.
4. Uploads a new version and deploys it (the very first run creates the Worker and its Durable Object), so every later deploy can be rolled back. A change a version can’t carry goes out with `wrangler deploy` instead, which can be rolled back too, apart from a new Durable Object class; going back never undoes the address or cron triggers.
5. Asks the Worker for `/api/ping` for up to a minute (five, at a new address, while its certificate is issued) and checks it reports the new release and that its secrets can be read. If it doesn’t, it goes back to the previous version and the run fails. The first deploy gives an address on your domain five minutes, and passes without the secrets, saying it’s waiting for them, since they go on the Worker it just made.

Deploy runs on every push to `main` of the install repository, so editing `breakaway.config.json` and merging it is how you change the install. Set the repository variable `BREAKAWAY_URL` so the post-deploy check knows where to ask.

### Updating

For `stable`, merge the Update workflow’s pull request. For `main`, do nothing. To update by hand, edit `breakaway.json`'s `version` and merge, or run Deploy from the Actions tab.

The board’s **Connections** page has a **Version** row that says what the board runs and the latest release in its channel. If it says a release “isn’t running yet”, open Actions on the install repository: the Deploy run says why it stopped.

### Doing a manual step

When Deploy stops on **Manual steps**, read the release notes, do the steps (for example, a new binding), and deploy with `wrangler` yourself. `npx breakaway install config` makes the Worker’s config. Then run Deploy again so the board records the release.

## Rolling back

Deploy checks that the new release answers and goes back by itself when it doesn’t. To go back by hand:

1. **`stable`:** revert the pull request that moved `breakaway.json`, and merge the revert. Deploy runs the old release.
2. **Either channel, right now:** run `wrangler rollback <version-id>`. The Worker’s versions are on Cloudflare.

The board’s data only changes forward, and only by adding, so an install can always go back one release.

## The update feed

An install reads **one public feed** instead of GitHub’s API, which limits requests per address, and Workers share addresses. This site serves it at [`/releases.json`](https://leavethepack.dev/releases.json):

```json
{
  "repository": "TheAnarchoX/breakaway",
  "channels": {
    "stable": { "version": "0.2.0", "tag": "v0.2.0", "bundle": "https://…/breakaway-bundle.tar.gz", "manifest": "https://…/manifest.json", "checksums": "https://…/SHA256SUMS", "notes": "https://github.com/…/releases/tag/v0.2.0", "manual": false, "updatesFrom": "0.1.0", "published": "2026-10-03T09:00:00Z" },
    "main": { "version": "0.2.1-main.4", "tag": "v0.2.1-main.4" }
  }
}
```

A channel with no usable release (none yet, or its assets or manifest are missing) is `null`. Releases are ordered by version and pre-release number, never by date. The feed is cached for ten minutes, has open CORS, and keeps nothing about who asked: no cookies, no analytics, no request logs. If GitHub can’t be reached and nothing is cached, it answers `503` with `Retry-After`.

You can run your own copy of the feed from `site/` in the repository (`wrangler dev -c site/wrangler.jsonc`), pointed at a fork with the `RELEASES_REPO` variable. To host it, copy `site/deploy.yml` into the repository that deploys your board: it deploys the site from the latest stable release on your own domain, and again each time a new one comes out (`site/README.md` has the steps).

## Deploying a repository your agents work on

A different matter: a repository the board tracks can have its own **deploy pipeline** (staging and production Workers, and Deploy, Promote, and Roll back workflows) and release flow for an npm package. The board shows what’s on staging and what’s live, and you press **Promote**, **Roll back**, and **Release** in the browser. To move a repository there, see [Move a repository to the deploy flow](https://leavethepack.dev/docs/github/#move-a-repository-to-the-deploy-flow).

Agents never deploy. Merging to a repository’s default branch deploys to staging only if its pipeline says so, and the merge dialog warns you first.
