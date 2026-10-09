---
title: Recover without the board
nav: Recovery
description: Redeploy your board and rebuild your environments by hand, with wrangler and your repositories alone, and what to export while the board still answers.
---

The board can run your infrastructure, so you need a way back that doesn't depend on it. This page is that way. Every step after **Before you need it** runs on your machine with `wrangler`, the install repository, and each repository's `.github/breakaway-infra/` files, and none of them asks the board anything. Rehearse it once on a scratch Cloudflare account, so the day you need it isn't the first time.

The examples use made-up names: a repository `acme/widgets` with a Worker `acme-api`, its environments `staging` and `production`, and a board at `https://board.example.com`. Put your own in their place.

## What you need

- A machine with Node 20 or later and Git. `wrangler` comes with `npx`.
- `wrangler` signed in to the Cloudflare account, as you: `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set to a token of your own that can write what you rebuild. The board's read token can't write anything, and the executor's write tokens are secrets in GitHub environments, which nobody can read back. If you make a token for this, give it an expiry date.
- A clone of the install repository and of each repository you rebuild.
- What you keep in your password manager: `tasks.env` and the rest of [What to keep](/docs/operations/#what-to-keep), and the values of your own Workers' secrets. The board and Cloudflare only ever list a secret by name.
- What you exported in **Before you need it**.

## Before you need it

Do this while the board answers: now, after you add or change an environment, and once a month. It writes four files. Keep them with `tasks.env`, out of Git: they hold no secret (the board redacts what it stores), but they name your infrastructure.

```sh
set -a; . ~/.config/breakaway/tasks.env; set +a
mkdir -p ~/breakaway-backup && cd ~/breakaway-backup
npx breakaway export --out tasks-backup.json
curl -fsS -H "Authorization: Bearer $BREAKAWAY_TOKEN" "$BREAKAWAY_URL/api/infra/environments" > environments.json
curl -fsS -H "Authorization: Bearer $BREAKAWAY_TOKEN" "$BREAKAWAY_URL/api/infra/desired" > desired.json
curl -fsS -H "Authorization: Bearer $BREAKAWAY_TOKEN" "$BREAKAWAY_URL/api/infra/inventory" > inventory.json
```

- `tasks-backup.json`: every task in every repository ([Backups and export](/docs/operations/#backups-and-export)).
- `environments.json`: each environment's repository, name, kind, provider, target, freeze, and whether it's observe only.
- `desired.json`: the desired state the board last read from each repository, with the last valid copy of a file that's broken now. The files themselves are in Git; this is what the board was working from.
- `inventory.json`: what actually ran, by name and setting: each Worker's bindings, cron triggers, routes, and the names of its secrets. It's the list to rebuild from when something wasn't in a desired-state file.

Then the audit trail, 200 entries at a time, newest first, into `audit.json`:

```sh
node --input-type=module -e '
const url = process.env.BREAKAWAY_URL, auth = { authorization: `Bearer ${process.env.BREAKAWAY_TOKEN}` };
const all = [];
for (let before = ""; ; ) {
  const res = await fetch(`${url}/api/infra/audit?limit=200${before && `&before=${before}`}`, { headers: auth });
  if (!res.ok) throw new Error(`the board answered ${res.status}`);
  const { entries, more } = await res.json();
  all.push(...entries);
  if (!more || !entries.length) break;
  before = entries.at(-1).id;
}
(await import("node:fs")).writeFileSync("audit.json", JSON.stringify(all, null, 2));
console.log(`${all.length} audit entries in audit.json`);
'
```

**Check:** five files in `~/breakaway-backup`, and `export` and the audit count both said how many they wrote.

## Redeploy the board by hand

Do this when the install repository's Deploy can't run (GitHub Actions is down, or its token is gone), when the board's Worker was deleted, or when you move the board to another Cloudflare account. The board's own install is observe only: Architect watches it and never changes it, so the board always comes back this way or through Deploy, never through a plan.

Run it in a clone of the install repository, the one with `breakaway.config.json` and `breakaway.json`.

1. **Get the release the board runs.** On `stable`, `breakaway.json`'s `version` is the release. On `main`, it's the one the board last ran: set `VERSION` by hand to the `release` its `/api/ping` reported, or to the newest pre-release on [breakaway's releases](https://github.com/TheAnarchoX/breakaway/releases) without the `v`, instead of the first line below. Download its bundle, manifest, and checksums, check them, and unpack the bundle:

   ```sh
   VERSION=$(node -p "require('./breakaway.json').version")
   mkdir -p release bundle cli
   cd release
   for f in breakaway-bundle.tar.gz manifest.json SHA256SUMS; do
     curl -fsSLO "https://github.com/TheAnarchoX/breakaway/releases/download/v$VERSION/$f"
   done
   sha256sum --check SHA256SUMS
   cd ..
   tar -xzf release/breakaway-bundle.tar.gz -C bundle
   ```

   On macOS, `shasum -a 256 --check SHA256SUMS` does the same check. Stop if it fails: the files aren't the release.

2. **Get that release's CLI and make the Worker's config.** The release's own source makes the config that matches its code:

   ```sh
   curl -fsSL "https://github.com/TheAnarchoX/breakaway/archive/refs/tags/v$VERSION.tar.gz" | tar -xz -C cli --strip-components 1
   node cli/scripts/tasks.mjs install config --bundle bundle --out wrangler.generated.json
   ```

   `wrangler.generated.json` names the Worker, its address, its Durable Object, its cron trigger, and its secrets, all from `breakaway.config.json`. Never change `worker` or `store` to get a deploy through: either one opens an empty board.

3. **Look before you deploy.** A board that still exists has versions you can go back to:

   ```sh
   npx wrangler@4 deployments list -c wrangler.generated.json
   npx wrangler@4 deploy --dry-run --outdir dry -c wrangler.generated.json
   ```

   If the Worker answers but runs a bad version, go back instead of deploying: `npx wrangler@4 rollback <version-id> -c wrangler.generated.json`, with an ID from the list. You're done once its check (step 6) passes.

4. **Deploy it.**

   ```sh
   npx wrangler@4 deploy -c wrangler.generated.json
   ```

   On the same account, the Worker keeps its Durable Object, so the board comes back with every task, comment, and environment it had. A Worker that didn't exist yet (a new account, or one that was deleted) gets a new, empty Durable Object: see **The board's data** below.

5. **Put its secrets back, if it's a new Worker.** A Worker that kept its secrets, or an install whose secrets are in a Secrets Store on the same account, needs nothing here. Otherwise, from `tasks.env`:

   ```sh
   set -a; . ~/.config/breakaway/tasks.env; set +a
   printf %s "$BREAKAWAY_TOKEN" | npx wrangler@4 secret put TASKS_API_TOKEN -c wrangler.generated.json
   printf %s "$BREAKAWAY_CLIENT_ID" | npx wrangler@4 secret put TASKS_CLIENT_ID -c wrangler.generated.json
   printf %s "$BREAKAWAY_SYNC_KEY" | npx wrangler@4 secret put TASKS_SYNC_KEY -c wrangler.generated.json
   ```

   On an install with a Secrets Store, a new account needs a new store: make it, put the same three values in it under your `secretsPrefix` (`BREAKAWAY_API_TOKEN`, `BREAKAWAY_CLIENT_ID`, `BREAKAWAY_SYNC_KEY` by default), set `secretsStore` in `breakaway.config.json` to its ID, and go back to step 2. The GitHub App's keys, routine tokens, and push keys can't be put back from a file: connect each again from Connections ([When something's lost](/docs/operations/#when-somethings-lost)).

6. **Check it answers.**

   ```sh
   curl -fsS https://board.example.com/api/ping
   ```

   It says `"ok": true`, the `release` you deployed, and `"secrets": { "ok": true, … }`. Then `npx breakaway connections` lists anything else that needs you.

7. **Hand back to Deploy.** Once GitHub Actions works again, run the install repository's **Deploy** once, so later updates start from what runs. If you moved the board to another account, update the `production` environment's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` first.

### The board's data

The board's data lives in its Durable Object, so it's safe as long as the Worker and its `store` stay on the same account: a deploy, a rollback, or a deleted version never touches it. Cloudflare keeps the Durable Object's storage restorable for 30 days.

A Durable Object on a new account starts empty. Bring your tasks back from `tasks-backup.json`:

1. **Register the repositories again**, with the same slugs and areas as before: `npx breakaway repos add <slug> <owner/name> --area <project:PREFIX>`, once for each. The import refuses an export with tasks of a repository the board doesn't have, and names it.
2. **Import the export**, before anyone adds a task:

   ```sh
   npx breakaway import tasks-backup.json
   ```

   Every task comes back with its work ID, repository, area, horizon, tags, dependencies, decision, your quoted words, and comments with who wrote them and when. Claims and autostart are cleared: nobody holds work on a board that just came back, so start agents again from the board. The import runs only on a board with no tasks, so it never mixes two boards; on one that has tasks it changes nothing and says so.
3. **Start each Taskwarrior replica again** (move `.task/` aside, then `task sync`): the new board has a new history, so an old replica gets `410 Gone`.

**Check:** `import` says how many tasks it restored, and `npx breakaway health` shows the same total as the export's `count`.

The environments are quick to add again from `environments.json`, on the Infrastructure view; each repository's desired state comes back by itself from Git. The audit trail stays in `audit.json`, as the record of what happened before.

## Rebuild an environment by hand

Do this when an environment needs fixing and the board can't change it: the board is down, or the executor can't run. A change made by hand outside a plan is **break-glass**: when the board is back, it shows what you changed as drift, and **Mark as break-glass** records it and adds a task to put it into code. It never undoes it.

While the board is down, nothing applies: the executor only starts on the board's approval. If the board answers and you're working around it, **freeze** the environment first, so nothing else changes it while you do.

1. **Read what should exist.** The environment's desired state is one file on the repository's default branch:

   ```sh
   cd widgets
   git fetch origin
   git show origin/main:.github/breakaway-infra/production.json
   ```

   It reads like this:

   ```json
   {
     "version": 1,
     "provider": "cloudflare",
     "resources": [
       { "id": "acme-api", "kind": "worker", "name": "acme-api" },
       { "id": "widgets-db", "kind": "d1", "name": "widgets-db" },
       { "id": "widgets-cache", "kind": "kv", "name": "widgets-cache" },
       { "id": "widgets-files", "kind": "r2", "name": "widgets-files" },
       { "id": "widgets-jobs", "kind": "queue", "name": "widgets-jobs" },
       { "id": "api-domain", "kind": "custom-domain", "name": "api.widgets.example.com" }
     ]
   }
   ```

   Each resource has a `kind` and the `name` it has on Cloudflare; `attrs`, when it's there, holds the settings to give it. `policy.json` and `scaling.json` in the same folder aren't environments. `desired.json` from your backup has the same files, if you can't reach Git.

2. **See what exists.** List each kind the file names, and compare by name:

   ```sh
   npx wrangler@4 deployments list --name acme-api
   npx wrangler@4 d1 list
   npx wrangler@4 kv namespace list
   npx wrangler@4 r2 bucket list
   npx wrangler@4 queues list
   npx wrangler@4 containers list
   ```

3. **Make what's missing, data first, then the Worker.** The repository's own wrangler config binds the Worker to its databases, namespaces, buckets, and queues, so make them before you deploy it:

   | Kind | Make it | Then |
   | --- | --- | --- |
   | `d1` | `npx wrangler@4 d1 create widgets-db` | Put its new `database_id` in the repository's wrangler config. Run the repository's migrations: `npx wrangler@4 d1 migrations apply widgets-db --remote`. A deleted database's data is gone. |
   | `kv` | `npx wrangler@4 kv namespace create widgets-cache` | Put its new `id` in the wrangler config. It starts empty. |
   | `r2` | `npx wrangler@4 r2 bucket create widgets-files` | Its CORS and lifecycle rules from `attrs`: `npx wrangler@4 r2 bucket cors set widgets-files --file cors.json` and `npx wrangler@4 r2 bucket lifecycle set widgets-files --file lifecycle.json`. A custom domain: `npx wrangler@4 r2 bucket domain add widgets-files --domain files.widgets.example.com --zone-id <zone-id>`. |
   | `queue` | `npx wrangler@4 queues create widgets-jobs` | Its consumer comes with the consuming Worker's deploy. |
   | `worker` | `npx wrangler@4 deploy` in the repository, at the commit that last ran | Its bindings, compatibility date, cron triggers, routes, and custom domains come from its wrangler config. |
   | `durable-object`, `container` | Come with the Worker that defines them, by its `wrangler deploy` | A container's image builds on the deploy, so it needs Docker. A deleted Durable Object class's data is gone. |
   | `route`, `custom-domain` | Come with the Worker's `wrangler deploy`, from `routes` in its wrangler config | Deploying them needs Workers Routes write on the zone. |

   A resource that exists but is wrong (a Worker on a bad version, a database whose data broke) is fixed in place instead:

   - A Worker: `npx wrangler@4 rollback <version-id> --name acme-api`, with an ID from `deployments list`. Cloudflare refuses a rollback across a Durable Object class change, or to a version bound to something that no longer exists.
   - A D1 database's data, to any minute in the last 30 days: `npx wrangler@4 d1 time-travel restore widgets-db --timestamp=2026-10-06T09:00:00Z`.

4. **Put its secrets back.** `inventory.json` names each Worker's secrets. Put each one back from your own copy of its value:

   ```sh
   npx wrangler@4 secret put STRIPE_KEY --name acme-api
   ```

5. **Check it's healthy.** Open the Worker's address, or `curl` the health check the repository uses, and list again (step 2) to see every resource the file names exists.

6. **Put it back in code.** A new database or namespace has a new ID, and the repository's wrangler config has to say it: open a pull request in the repository with the change, as for any other change. When the board is back, it reads the inventory again; anything that still differs from the desired state shows as drift, to mark as break-glass or put into code.

Never change the board's own install this way to work around Architect: it's observe only, and **Redeploy the board by hand** above is the way to change it.

## Rehearse it

Follow this page once on a scratch Cloudflare account, with a copy of the install repository and one environment: export, redeploy the board there, and rebuild the environment from its file. Note anything that didn't work as written as a task on the board, so the page gets fixed before you need it.
