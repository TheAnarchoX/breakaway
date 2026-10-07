# The site: the landing page, the docs, and the update feed

This folder is what leavethepack.dev serves: a landing page and the docs (`public/`, static files) and the update feed (`src/`, a Worker). Both are deployed together from `site/wrangler.jsonc`.

## The landing page and the docs

The pages are written in `content/` (`index.html` for the landing page, `architect.md` for `/architect/`, one Markdown file per docs page in `content/docs/`, listed in `lib/site.js`) and built into `public/` by `node site/build.mjs`, which also copies the screenshots they show from `docs/media` to `public/media` (`MEDIA` in `lib/site.js`). **The built pages are committed**, so deploying needs no build step, and `pnpm test` fails when they differ from what the content builds. `public/tokens.css` is a copy of `brand/tokens.css` (a test keeps them equal); the fonts are the board's own, self-hosted. No scripts or styles come from anywhere else, there is no pricing, sign-up, ad, or analytics, and the copy follows the [brand guide](../brand/README.md).

```sh
node site/build.mjs                             # after editing content/
pnpm exec wrangler dev -c site/wrangler.jsonc   # preview at localhost:8787
```

## The update feed

A small Worker that serves `/releases.json`: for each channel (`stable` and `main`), the latest release's version, tag, bundle, manifest, and checksum URLs, the signature's URL (`signature`, or `null` for a release from before signing), the notes' URL, whether it needs steps by hand (`manual`, and `manualSteps` when it does), and the lowest version it updates from (`updatesFrom`). An install reads this one feed instead of GitHub's API, which limits requests per address, and Workers share addresses.

```json
{
  "repository": "TheAnarchoX/breakaway",
  "channels": {
    "stable": { "version": "0.2.0", "tag": "v0.2.0", "bundle": "https://…/breakaway-bundle.tar.gz", "manifest": "https://…/manifest.json", "checksums": "https://…/SHA256SUMS", "signature": "https://…/manifest.json.sig", "notes": "https://github.com/…/releases/tag/v0.2.0", "manual": false, "updatesFrom": "0.1.0", "published": "2026-10-03T09:00:00Z" },
    "main": { "version": "0.2.1-main.4", "tag": "v0.2.1-main.4", "…": "…" }
  }
}
```

A channel with no usable release (none yet, or its assets or manifest are missing) is `null`. Releases are ordered by version and pre-release number, never by date.

- **Built from GitHub's releases** with a ten-minute cache, so GitHub sees a few requests an hour. If GitHub can't be reached and nothing is cached, the feed answers `503` with `Retry-After`.
- **Nothing about who asked.** Open CORS, no cookies, no analytics, no logging of requests, and no secrets: the repository's releases are public.
- **Deployed by Cloudflare from this repository**, which still holds no Cloudflare credentials: Workers Builds pulls the `site` branch itself.

## Run it

```sh
pnpm exec wrangler dev -c site/wrangler.jsonc
curl localhost:8787/releases.json
```

Point it at another repository, or at a stand-in for GitHub's API, with the `RELEASES_REPO` and `GITHUB_API` variables (`--var GITHUB_API:…`). `pnpm test` covers it with fixture releases.

## Deploy it

Cloudflare's [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys the site from this repository's `site` branch, so no Cloudflare credentials live in GitHub. The branch follows breakaway's latest stable release, so the docs and the install prompt match what `npx breakaway` installs: the Release workflow's stable job calls the [Site workflow](../.github/workflows/site.yml), which moves `site` to the released tag.

The site serves the prompt people paste into Claude Code, so `site` is guarded like `main`:

- **A ruleset** lets only deploy keys create, move, or delete `site`: not agents, and not the owner's own credentials.
- **The deploy key** is the `SITE_DEPLOY_KEY` secret in the `site` environment, which only `main` can use. The Site workflow is the only thing that holds it.
- **Only merged work goes live.** The Site workflow refuses a tag or commit that isn't on `main`.

To put a fix live before the next release, the owner runs the Site workflow by hand on `main` with that commit. It stays until the next stable release moves the branch again. Agents never run it.

### Set it up once

In the Cloudflare dashboard, on the account that holds the site's domain:

1. **Workers & Pages, Create, Import a repository**: connect `TheAnarchoX/breakaway` (Cloudflare's GitHub app asks for access to it).
2. **Worker name** `breakaway-releases`, the `name` in [`wrangler.jsonc`](wrangler.jsonc). **Root directory** `site`. **Build command** empty. **Deploy command** `npx wrangler deploy`.
3. **Build variable** `SKIP_DEPENDENCY_INSTALL` set to `1`, under Settings, Build: a build variable, not one of the Worker's runtime variables, which the build doesn't read. The site installs nothing: `npx` fetches Wrangler, and the Worker imports nothing from npm. Without it, Workers Builds runs `pnpm install` and stops on the repository's `pnpm-workspace.yaml`, which its older pnpm doesn't read.
4. **Branch control**: production branch `site`, and builds for non-production branches off, so no other branch builds anything and no pull request gets a Workers Builds check. The dashboard only offers branches that exist, so `site` has to be there first: the first stable release's site job creates it, or the Site workflow run by hand on `main`.
5. **The first build.** Workers Builds builds on a push to `site`, and the push that created it came before it was the production branch. Retry a failed build of `site` if there is one, or run the Site workflow again from `main` with ref `main`, which moves `site` and starts the build.

The custom domain is in `wrangler.jsonc`, so the first deploy sets it up. Keep `RELEASES_REPO` as `TheAnarchoX/breakaway` unless you run a fork; a fork changes the domain and `RELEASES_REPO` with it.

Only `/releases.json` runs the Worker; every other path is a static file, and unknown paths get `404.html`.
