# The site: the landing page, the docs, and the update feed

This folder is what breakaway.samewave.dev serves: a landing page and the docs (`public/`, static files) and the update feed (`src/`, a Worker). Both are deployed together from `site/wrangler.jsonc`.

## The landing page and the docs

The pages are written in `content/` (`index.html` for the landing page, one Markdown file per docs page in `content/docs/`, listed in `lib/site.js`) and built into `public/` by `node site/build.mjs`. **The built pages are committed**, so deploying needs no build step, and `pnpm test` fails when they differ from what the content builds. `public/tokens.css` is a copy of `brand/tokens.css` (a test keeps them equal); the fonts are the board's own, self-hosted. No scripts or styles come from anywhere else, there is no pricing, sign-up, ad, or analytics, and the copy follows the [brand guide](../brand/README.md).

```sh
node site/build.mjs                             # after editing content/
pnpm exec wrangler dev -c site/wrangler.jsonc   # preview at localhost:8787
```

## The update feed

A small Worker that serves `/releases.json`: for each channel (`stable` and `main`), the latest release's version, tag, bundle, manifest, and checksum URLs, the notes' URL, whether it needs steps by hand (`manual`, and `manualSteps` when it does), and the lowest version it updates from (`updatesFrom`). An install reads this one feed instead of GitHub's API, which limits requests per address, and Workers share addresses.

```json
{
  "repository": "TheAnarchoX/breakaway",
  "channels": {
    "stable": { "version": "0.2.0", "tag": "v0.2.0", "bundle": "https://…/breakaway-bundle.tar.gz", "manifest": "https://…/manifest.json", "checksums": "https://…/SHA256SUMS", "notes": "https://github.com/…/releases/tag/v0.2.0", "manual": false, "updatesFrom": "0.1.0", "published": "2026-10-03T09:00:00Z" },
    "main": { "version": "0.2.1-main.4", "tag": "v0.2.1-main.4", "…": "…" }
  }
}
```

A channel with no usable release (none yet, or its assets or manifest are missing) is `null`. Releases are ordered by version and pre-release number, never by date.

- **Built from GitHub's releases** with a ten-minute cache, so GitHub sees a few requests an hour. If GitHub can't be reached and nothing is cached, the feed answers `503` with `Retry-After`.
- **Nothing about who asked.** Open CORS, no cookies, no analytics, no logging of requests, and no secrets: the repository's releases are public.
- **Never deployed from this repository**, which holds no Cloudflare credentials.

## Run it

```sh
pnpm exec wrangler dev -c site/wrangler.jsonc
curl localhost:8787/releases.json
```

Point it at another repository, or at a stand-in for GitHub's API, with the `RELEASES_REPO` and `GITHUB_API` variables (`--var GITHUB_API:…`). `pnpm test` covers it with fixture releases.

## Deploy it

The site deploys itself from breakaway's latest stable release, so the docs follow what `npx breakaway` installs. [`deploy.yml`](deploy.yml) is the workflow, and it runs in the repository that deploys your board, never here:

1. Copy `site/deploy.yml` into that repository as `.github/workflows/site.yml`.
2. Set the repository variable `SITE_HOST` to the site's host, like `breakaway.example.com`. The workflow deploys the site there as a custom domain.
3. It uses the same `production` environment secrets as the board's Deploy: `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`, which needs Workers Scripts Edit and, for the custom domain, Workers Routes Edit on the host's zone.
4. Run it once by hand to put the site live.

From then on it looks for a new stable release every hour and deploys it, and does nothing when the site already runs it. Each deploy writes `deployed.txt` (the tag or branch, the commit, and when) and checks the site serves it and the feed answers. Run it by hand with a tag or branch to put a fix live before the next release: a fix stays until a newer stable release comes out. Keep `RELEASES_REPO` as `TheAnarchoX/breakaway` unless you run a fork, and change `BREAKAWAY_REPO` in the workflow with it.

Only `/releases.json` runs the Worker; every other path is a static file, and unknown paths get `404.html`.
