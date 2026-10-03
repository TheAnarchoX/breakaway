# Architecture

> What runs where: one Cloudflare Worker, one SQLite Durable Object, the TaskChampion sync protocol, the JSON API, the web app, and how GitHub and agents plug in.

The board is **one Cloudflare Worker** on the install’s address. It has no build step for the server, and a Preact web app built with Vite served as static files.

## The pieces

- **`/v1/client/*`** is the [TaskChampion sync protocol](https://gothenburgbitfactory.org/taskchampion/), the same one as `taskchampion-sync-server`: a linear chain of encrypted versions, each a batch of Taskwarrior operations, plus snapshots. It accepts only the install’s client ID.
- **One SQLite Durable Object** (`TaskStore`) stores the chain. It also holds the **derived sync key**: the client decrypts with PBKDF2 of the secret, and the Worker only ever sees the result. So it decrypts every version as it arrives and keeps the tasks in a table. Changes made through the API are written back as ordinary encrypted versions, so `task sync` picks them up like any other replica’s. The server takes its own snapshot every 50 versions, so a new replica starts fast.
- **Claims are atomic.** The Durable Object runs one request at a time, and `claim` checks and sets in the same step.
- **`/api/*`** is the JSON API behind the CLI and the web board. It needs the token as a bearer token, or the cookie the web board gets at `/login`; cookie requests that change something must come from the same origin. See [the API](https://breakaway.samewave.dev/docs/api/).
- **`/`** is the web board: a Preact app on `@preact/signals`, built by Vite on breakaway’s design tokens and self-hosted fonts.
- **GitHub.** `/github/webhook` checks each delivery’s signature and schedules a Durable Object alarm; the alarm and a 5-minute cron reconcile with GitHub’s REST API using a short-lived installation token kept in memory only, and store pull requests, runs, commits, alerts, and events in the same SQLite.
- **Agents.** The board calls the Claude routine’s `/fire` endpoint to start a session. The session’s hooks send its output back to the board.

The Worker logs nothing about tasks and has no invocation logs. Pages and API answers are `noindex` and never cached.

## Data

Everything is in the Durable Object’s SQLite. Task fields are Taskwarrior properties (UDAs), so `task sync` carries them. Short-lived things (session output, owner messages) live in their own tables and are deleted after 14 days; images are stored in an `attachments` table, never public. Data changes forward-only and additively, which is why an install can go back one release.

## What leaves your account

An install keeps its data. It calls only what you connect:

- **GitHub**, through your private App, to read repositories and to do the five things you press.
- **Claude**, to start the sessions you ask for.
- **Web Push**, if you turn on notifications.

No analytics, no telemetry, no tracking, and no other service.

## Tests

`pnpm test` runs the server’s tests: crypto against TaskChampion’s own test vector, the protocol, the replica, the API, sign-in, rotation, activity, and more. Nothing reaches the network: GitHub, Claude, and Web Push are mocked. `pnpm interop` checks the Worker against real Taskwarrior 3: two and three replicas, API changes and claims, conflicting edits, and a replica that starts from the server’s snapshot. Run it after changing sync, the replica, or the task model.

## How breakaway is built

breakaway is built by its owner and their agents, and takes no pull requests or issues from anyone else. The agents follow the repository’s `AGENTS.md`: what breakaway is and isn’t, what agents never do, and the conventions. A change that people see follows the brand guide in `brand/`. The licence lets you change your own copy as much as you like.

```sh
pnpm install
pnpm dev        # the board, locally
pnpm test       # the tests
pnpm build      # the web app
pnpm interop    # checks sync against real Taskwarrior 3
```
