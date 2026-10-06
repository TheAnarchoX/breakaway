# Operating a board

> Secrets and what each one does, rotating them, what to keep and what to do when it’s lost, Connections, backups and export, the health endpoint, and a table of what to do when something breaks.

## Connections

`npx breakaway connections` (or the **Connections** view, `w`) lists everything the board leans on. Each row is **Working**, **Needs attention**, or **Not connected**, with what the board saw, when, and the exact fix for each failure it can tell apart.

- **Cloudflare:** the Worker’s version, each secret binding as `set` or `unset` (by name only, never a value), the 5-minute cron’s last run and first error, and whether the sync server reads its history and the stored secrets match after a rotation.
- **GitHub:** the App (GitHub refusing its key), whether it’s installed on each registered repository, its permissions against what the board needs, **Allow auto-merge**, the webhook (when it last got one, signatures it refused, and failures from GitHub’s delivery log), and the sync: last success, last error, and requests left.
- **Claude:** the routine connected or not, the last start’s result, a routine **Paused** after Claude refused it, routines switched off after three failed starts, the shared budget, and whether a started session is sending live output.
- **Per repository:** each registered repository gets its own rows: the App installed on it, its permissions, auto-merge, its sync, and its agent routine.
- **Taskwarrior** (when a replica last synced) and **Push** (keys set, browsers subscribed, the last send).
- **Version:** what the board runs and the latest release in its channel.

A connected routine also reads **Verified** or **Not verified yet**. The board can’t read claude.ai, so a routine is verified by the first agent it starts: it reads **Not verified yet: start an agent on a task to verify it** until a session it started claims its task, then **Verified by <task>**, with the time. The claim reports what the session can see about its own environment (whether it has an agent name, where its token came from, and whether its stub matches the board’s), never a value; a report that finds a problem needs attention, with the fix. Nothing starts an agent just to verify one, and a routine connected again reads Not verified yet again.

The install prompt and [the quickstart](https://leavethepack.dev/docs/quickstart/) read every check one of three ways: **Verified** (a row that reads Working or Verified), **Not verified yet**, and **Failed** (a row that reads Needs attention).

A check only reads. It never writes to GitHub, never starts an agent, and never costs a Claude start. The GitHub checks run once an hour from the cron, and again when you press **Check now** (the signed-in browser only, once every 30 seconds). How many rows need attention shows as a count on Connections and on Settings, and as a dot on the phone’s menu button. When a connection has needed attention for 10 minutes, your inbox gets a note, and another when it works again.

Connections lists what it can’t check: the routine’s cloud environment and prompt on claude.ai, and Cloudflare’s own settings.

## Secrets

On an install with a Secrets Store, the secrets are in it (scope `workers`), bound in the Worker’s config, with names that start with the install’s `secretsPrefix` (`BREAKAWAY_` by default). Without one, they’re Worker secrets under their binding names.

| Secrets Store name | Binding | What |
| --- | --- | --- |
| `BREAKAWAY_CLIENT_ID` | `TASKS_CLIENT_ID` | The Taskwarrior client ID. Anyone with it and the secret can read and write the board through Taskwarrior. |
| `BREAKAWAY_SYNC_KEY` | `TASKS_SYNC_KEY` | PBKDF2-HMAC-SHA256(secret, client ID, 600000) as base64. Not the secret itself. |
| `BREAKAWAY_API_TOKEN` | `TASKS_API_TOKEN` | The API and web token, at least 32 characters. Also signs the web cookie. |
| `BREAKAWAY_ROUTINE_URL`, `BREAKAWAY_ROUTINE_TOKEN` | `TASKS_ROUTINE_*` | The default repository’s agent routine: its `/fire` URL and token. The token can only start that routine. |
| `BREAKAWAY_ROUTINES` | `TASKS_ROUTINES` | Every other repository’s routine, as JSON keyed by slug. |
| `BREAKAWAY_VAPID_KEY` (and the var `TASKS_VAPID_PUBLIC`) | `TASKS_VAPID_KEY` | The VAPID key pair for Web Push on pings. `unset` means notifications are off. |
| `BREAKAWAY_GITHUB_APP_ID`, `…_GITHUB_KEY`, `…_GITHUB_WEBHOOK_SECRET` | `TASKS_GITHUB_*` | The GitHub App’s ID, private key, and webhook secret, written by `github-connect`. |

`unset` means not connected. On an install without a Secrets Store, the commands that write secrets (`github-connect`, `agents-connect`, `rotate-sync`, `rotate-token`) set them with `wrangler secret put`, and each deploys a new version of the Worker.

### Rotating secrets

Both rotations are one command on your machine (with `wrangler` logged in). Each writes the new values to `tasks.env.next` before anything changes, keeps the old file as `tasks.env.<time>.bak` (its values stop working, so delete it once you’ve updated your password manager), and never puts a secret on a command line.

**Rotate the sync credentials** when the client ID or secret leaked, or a machine that had them is gone:

```sh
npx breakaway rotate-sync
```

It makes a new client ID and secret and sends only the derived key to the server, which decrypts every stored version and the snapshot with the old key and seals them again with the new one, **keeping every version ID**, in one transaction. No history is lost and every replica carries on, including work it hadn’t synced yet. From that moment the old client ID gets a 403, and a replica syncs again once it has the new values (copy `tasks.env` to it and run `npx breakaway setup`). Cloud agents only use the token, so they need nothing.

**Rotate the API token** when it leaked, or someone should lose access:

```sh
npx breakaway rotate-token
```

It updates the stored secret, waits until the server accepts the new token, and saves it. Every browser is signed out. Update `BREAKAWAY_TOKEN`, or the API credential, in your cloud environments.

### What to keep

The Secrets Store, Worker secrets, and the board take values and never give them back. So a few files on your machine, in `~/.config/breakaway/` (`$BREAKAWAY_HOME` when it’s set), hold the only copy of what you’d need again. Keep each one, whole, in your password manager, and never in Git. `init-secrets` prints the same list.

| File | What it holds | If it’s lost |
| --- | --- | --- |
| `tasks.env` | The token, the sync client ID and secret, the derived key, and the board’s address | Without the token you can’t use the CLI or sign in to a new browser. Without the sync secret no new machine can sync with Taskwarrior. Everything else keeps working. |
| `tasks-routines.json`, when there is one | The URL and token of each routine `agents-connect --repo` connected: every repository’s but the default one’s | Agents keep starting. `agents-connect --repo` and `repos remove` stop instead of dropping the routines the file doesn’t hold. |
| `github-app.json`, only when `github-connect` couldn’t store the App’s keys | The App’s ID, private key, and webhook secret | It matters only until the keys are stored; then delete it. Lost before then, the board has no key for the App. |

The rest needs no copy: the board keeps it, and you replace it rather than get it back. That’s the default repository’s routine, a routine connected from the board’s form, the push keys, and the App’s keys once they’re stored. A `tasks.env.<time>.bak` from a rotation holds values that stopped working; one from `init-secrets --force` holds the sync secret the board may still run on, so keep it until you know.

### When something’s lost

Each recovery runs on your machine, with `wrangler` logged in to the install’s Cloudflare account, and prints no value.

**The token.** Look for it first: your password manager, `tasks.env` on another machine, or `BREAKAWAY_TOKEN` in a cloud environment’s variables (an API credential can’t be read back). Found, it goes back in `tasks.env` as `BREAKAWAY_TOKEN=…`. If it leaked, someone should lose access, or it’s gone everywhere, run `npx breakaway rotate-token`. Without a token the board accepts, it can’t ask the board which install it is, so it says where the new token goes, as this checkout’s `breakaway.config.json` names it, and asks for the Worker’s name (or the Secrets Store’s ID) before it writes anything; `--worker <name>` gives it ahead. Every browser is signed out; sign in with the new token, and update `BREAKAWAY_TOKEN` or the API credential in your cloud environments.

**The sync secret.** The board holds only the client ID and the key derived from the secret, and can’t give the secret back. Everything but Taskwarrior keeps working: the web board, the CLI, agents (they use the token), GitHub, and pushes. Replicas that already sync carry on. Look for it first: every machine that ran `npx breakaway setup` has it in `~/.config/breakaway/taskrc`, as `sync.encryption_secret` beside `sync.server.client_id`. Put both back in `tasks.env` as `BREAKAWAY_SECRET` and `BREAKAWAY_CLIENT_ID`, then run `npx breakaway setup` where you need it; if the machine that lost it might be in someone else’s hands, run `npx breakaway rotate-sync` too. If no machine has it, run `npx breakaway rotate-sync`: it doesn’t need the old secret, because the board re-encrypts its history with the key it holds. Then copy the new `tasks.env` to each machine and run `npx breakaway setup` there. Never set a new sync key by hand: the board’s history is sealed with the old one, and it would stop reading it.

**A routine token.** The board holds it and keeps starting agents with it; you need a new one only to connect the routine again. Generate a token in the routine’s API trigger on claude.ai, then connect it: from its form in Connections (**Replace the routine**) when it was connected there, with `npx breakaway agents-connect` for the default repository, or `npx breakaway agents-connect --repo <slug>` for any other.

**`tasks-routines.json`.** `agents-connect --repo` and `repos remove` stop and name the routines it doesn’t hold. Copy the file from the machine that connected them. If none has it, run `npx breakaway agents-connect --repo <slug> --replace`, which writes only that routine, then connect each of the others again with a new token, from its form in Connections or with `agents-connect --repo`; until then those repositories can’t start agents.

**The App’s keys.** Once stored, the board holds them and you keep nothing; if the key leaked, generate a new one ([GitHub](https://leavethepack.dev/docs/github/#disconnecting-and-a-leaked-key) says how). If `github-app.json` was lost before the keys were stored, the App on GitHub has no key the board can use: delete that App on GitHub (Settings → Developer settings → GitHub Apps), and connect a new one from the board’s GitHub view.

## Health

`GET /api/ping` is public and says only that the Worker answers: `{ "ok": true, "version": "<Cloudflare version ID>", "release": "<semver>", "secrets": { "ok": true, "unreadable": [] } }`: `secrets` says whether each bound secret can be read, by name and never a value. Nothing about tasks. A check after a deploy uses it. `npx breakaway health` (`GET /api/health`) is the signed-in version with the task count, the CLI version the board was built with, and a Connections count.

## Backups and export

The Durable Object’s SQLite storage has Cloudflare’s point-in-time recovery for the last 30 days. For a copy of your own:

```sh
npx breakaway export --out tasks-backup.json
```

It writes every task in every repository, with status and horizon, as the board’s JSON with comments, and checks the count against `health`, failing when they differ. Keep the file out of Git. A Taskwarrior replica is a full copy only while it syncs: compare `task count` with `health`’s total. A point-in-time restore of the Durable Object puts every replica that synced after the restore point in the same state: each one gets `410 Gone` and has to be started again.

To redeploy the board, or rebuild an environment, with the board down, see [Recover without the board](https://leavethepack.dev/docs/recovery/). Its first section is what to export while the board still answers.

## The install

What makes one board itself and not another is one file, `breakaway.config.json`:

| Setting | What | A new install’s default |
| --- | --- | --- |
| `name` | The name people see: push notifications, the GitHub App | `breakaway` |
| `worker` | The Worker’s name on Cloudflare | `breakaway` |
| `url` | Where the board answers | none: workers.dev, and the address it was opened at |
| `aliases` | Other addresses it answers on beside `url`, while it moves to a new one | none |
| `secretsPrefix` | Starts every secret’s name in the Secrets Store | `BREAKAWAY_` |
| `secretsStore` | The Secrets Store’s ID | none: the secrets are Worker secrets |
| `store` | The Durable Object’s name. Changing it starts an empty board | `breakaway` |
| `installRepository`, `channel` | The repository the install deploys from and the channel it follows | none, `stable` |
| `jurisdiction` | The Durable Object’s jurisdiction (`eu` or `fedramp`) | none |

`node install.mjs` turns it into the Worker’s wrangler config. Never change `store` on a running install.

## When something’s wrong

| What you see | What to do |
| --- | --- |
| A button on the board doesn’t work, or something seems off | Run `npx breakaway connections`: it says which connection is broken and how to fix it. |
| `Could not read include file '~/.config/breakaway/taskrc'` | Run `npx breakaway setup` (it needs `tasks.env`). |
| `task sync` fails with a 403 | This replica has another client ID. Run `npx breakaway setup` again. |
| `task sync` fails with `410 Gone` on `get-child-version` | This replica last synced with another server. Start it again: `mv .task .task-stale`, then `scripts/task sync`. |
| `health` says the server can’t read its history | A replica synced with the right client ID but a different secret. Set that replica’s secret right, remove what it added, then rebuild with `POST /api/admin/rebuild`. |
| A claim fails with “claimed by …” | Someone has it. Pick another, or ask the owner. `--force` is for the owner clearing a stale claim. |
| “can’t reach https://…” or “HTTP 403 from the session’s proxy” in a cloud session | The environment’s network settings don’t allow the board’s host. See [Agents](https://leavethepack.dev/docs/agents/#the-cloud-environment). |
| The GitHub view says the last sync failed | A 401 or 404 means the App was uninstalled or its key changed: reinstall it, or store the current key. A 403 on Dependabot alerts is fine. |
| A merged pull request didn’t finish its task | The pull request has to close it: `Closes <ID>.` in its title or description, or its number in the task’s `pr` field. A branch name only mentions. |
| The web board keeps asking for the token | The token was rotated, or the cookie expired after 180 days. Sign in again. |
| An agent never shows live output | The session hook can’t reach the board. Check the environment’s allowed hosts and `claim`’s warning. |
| An agent run reads **Starting** for over 10 minutes | Its session never claimed the task. Open the session from the task’s Agent section and see what it’s doing. |
| An agent run reads **Silent since <time>** | Its session has said nothing for 30 minutes. It keeps its claim and its slot, and you get one ping. Open the session and decide: let it carry on, or stop it and release the task. |
| An agent run reads **Retrying** | Claude’s limit for starting sessions. Nothing to do: it starts again by itself at the time it shows. One you started by hand says when you can start it again. |
| An agent run reads **Paused** | Claude refused the routine: its token (401), no access to it (403), or no routine at that address (404). Auto-start and chase start nothing in that repository until it works. Press **Reconnect the routine**, which opens Connections, and connect it with a new token from its API trigger on claude.ai, from the routine’s form or with `npx breakaway agents-connect` (`--repo <slug>` for another repository). Starts resume once it works. |
| An agent run reads **Couldn’t start** | Claude didn’t start the session, for the reason it shows. Press **Try again**. Auto-start and chase try again by themselves after 10 minutes. |
| An agent run reads **Needs you** | Two fix agents on one pull request didn’t get it green, so no third starts by itself, or the agent pinged you. Read what they tried, or the ping in your inbox, then fix it yourself or force start one more. |
| **Agent routine** reads **Not verified yet** | Nothing has used the routine. Start an agent on a task: once its session claims the task, the row reads **Verified by** it. |
| `npx breakaway` says it “doesn’t run on Windows itself” | The commands that store secrets need macOS, Linux, or Windows through WSL. [Install WSL](https://learn.microsoft.com/windows/wsl/install) and run them in its terminal. |
| Deploy stopped with a message | A release needs manual steps, or `breakaway.config.json` changed something Deploy can’t deploy. Do what the message says, then run Deploy again. |
| Version says a release “isn’t running yet” | Open Actions on the install repository: the Deploy run says why it stopped. |
