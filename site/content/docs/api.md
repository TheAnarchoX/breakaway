---
title: The API
description: The board’s JSON API: how to sign in, the routes for tasks, agents, GitHub, repositories, and routines, which ones only the signed-in browser may call, and how to fire a routine from a webhook.
---

The CLI and the web board are both clients of one JSON API on the board’s address. You can call it from scripts too. The CLI (`npx breakaway`) is the supported client; it tracks the API’s changes, so prefer it when a command exists.

## Authentication

Every `/api/*` route except `/api/ping` and a routine’s `/fire` needs the board’s token:

```sh
export BREAKAWAY_URL=https://board.example.com
curl -H "Authorization: Bearer $BREAKAWAY_TOKEN" "$BREAKAWAY_URL/api/health"
```

- **The bearer token** is what agents, the CLI, and cloud sessions hold. Without it, or with a wrong one, the answer is `401`.
- **The cookie** is what the web board gets when you sign in at `/login` (a form post with a `token` field, from the board’s own origin). It lasts 180 days. A cookie request that changes something must come from the same origin; a cross-origin one gets a `403`.
- **Owner-only routes** accept the cookie and refuse the bearer token with a `403`. They’re what you can do and an agent can’t: merging, promoting, rolling back, applying a ping, messaging an agent, turning on notifications, and Check now. Routes that make you the actor (changing a repository, a routine, or a plan) refuse a request signed with an agent’s name.
- Request bodies are JSON. Errors are `{ "error": "…" }` with a status that says what failed: `400` for input, `404`, `409` for a conflict (a claim someone else holds), `429` for a limit.

## Health

| Route | Answers |
| --- | --- |
| `GET /api/ping` | Public. `{ ok, version, release, secrets }`: the Cloudflare version ID, the semver release, and whether the Worker’s secrets can be read (`secrets.ok`, with the names of any that can’t in `unreadable`, never a value). Nothing about tasks. |
| `GET /api/session` | Which board this is: its name and address. |
| `GET /api/health` | The server’s state, with task counts, the CLI version, and the release. |
| `GET /api/connections` | The Connections report. |
| `GET /api/activity?limit=&before=` | Recent changes, newest first. |
| `GET /api/stats?days=&tz=&repo=` | The Activity view’s numbers. |

## Tasks

| Route | Does |
| --- | --- |
| `GET /api/tasks?status=pending` | Lists tasks. `status` is `pending`, `completed`, `deleted`, or `all`. |
| `POST /api/tasks` | Creates a task, or several: send one object, an array, or `{ tasks: […] }`. Later items may depend on earlier ones by work ID. Answers `201` with `{ tasks }`. |
| `GET /api/tasks/<ref>` | One task in full: fields, comments, dependencies, and what it blocks. `<ref>` is a work ID, a UUID, or its first 8 characters. |
| `PATCH /api/tasks/<ref>` | Changes fields. |
| `POST /api/tasks/<ref>/claim` | `{ agent, force?, repo? }`. Atomic: `409` if someone else has it, or it’s blocked, or it belongs to another repository. |
| `POST /api/tasks/<ref>/release` | `{ agent, force? }`. |
| `POST /api/tasks/<ref>/done` | `{ note?, by? }`. |
| `POST /api/tasks/<ref>/comments` | `{ text, by? }`. Append-only. |
| `POST /api/tasks/<ref>/pings` | An agent pings you: `{ kind, message, proposal? }`. |
| `POST /api/tasks/<ref>/decision/answers` | You answer a decision. `DELETE` reopens it. On a kickoff’s idea, `carryOn: true` also starts its next run, or queues it for room (`202`, `waiting`); signed-in board only. |
| `POST /api/next` | The best ready task; with `claim: true`, claims it in one step. |
| `GET /api/tasks/<ref>/footprint` | The files a task touches ([Footprints](/docs/agents/#footprints)): `kind` (`actual`, `claimed`, `predicted`, or `unknown`), `known`, `trusted`, `patterns`, `paths` with each one’s source, `pull`, `shared`, `conflicts`, and `hitRate`. |
| `GET /api/footprints?repo=<slug>` | Every open task’s footprint at once. |
| `POST /api/tasks/<ref>/paths` | An agent’s path claims for the task it holds: `{ agent, claim: […] }`, `{ agent, release: […] \| true }`, or `{ agent, dirty: […] }`. `409` with who holds it when a claim is refused. Without `agent`, or from the signed-in board, it only releases. |

A task you create or change takes these fields: `description` (the title), `brief`, `done_when`, `project` (the area), `priority`, `horizon`, `spec`, `pr`, `due`, `wait`, `scheduled`, `status`, `autostart`, `decision`, and `repo` (on create). A create also takes `tags`, `depends`, `related`, and `note`; a change takes `addTags`, `removeTags`, `addDepends`, `removeDepends`, `addRelated`, `removeRelated`, and `annotate`.

```sh
curl -X POST -H "Authorization: Bearer $BREAKAWAY_TOKEN" -H "Content-Type: application/json" \
  "$BREAKAWAY_URL/api/tasks" -d '{
    "description": "Sort the inbox by age",
    "project": "web",
    "horizon": "now",
    "tags": ["agent"],
    "brief": "The oldest ping should be first, so nothing waits unseen.",
    "done_when": "The inbox shows the oldest open ping first."
  }'
```

Images are `POST /api/tasks/<ref>/attachments` (the raw image as the body, with `X-Attachment-Name` and an optional `X-Attachment-Alt`), `GET` to list, and `GET /api/attachments/<id>` for the bytes: PNG, JPEG, WebP, and GIF, up to 1 MB each and 4 per task.

## Agents, pings, and routines

| Route | Does |
| --- | --- |
| `GET /api/agents` | Running and waiting agents, limits, and settings. |
| `POST /api/agents/start` | `{ ref, note?, mode?, anyway? }`. Starts an agent (`mode: "refine"` to refine). On a task whose files a running agent is changing, `409` with `overlap` and `anyway: true`: send it again with `anyway: true`. |
| `POST /api/agents/next` | `{ count, horizon?, repo?, dryRun? }`. Start the next few. |
| `POST /api/agents/general` | Owner: an agent from a prompt, `{ prompt, repo, force? }`; from a decision’s answers, `{ decision, note?, force? }`; or to prepare the next version, `{ next, repo, version?, note?, force? }`. |
| `PATCH /api/agents/settings` | The limits, plan, auto-start, alert severity, and `perArea` (Agents per area). |
| `GET /api/agents/prompt?repo=` | A repository’s agent prompt as it is on its default branch. |
| `GET /api/pings` | Your inbox: open pings and notices. |
| `POST /api/pings/<id>/apply`, `/dismiss`, `/handled` | Owner only (the cookie). |
| `GET /api/tasks/<ref>/session`, `POST …/session` | A session’s live output; the hooks send it. |
| `POST /api/tasks/<ref>/messages` | Owner only: message a running agent. `GET …/messages` lists them. |
| `GET /api/peloton?agent=<name>` | The pelotons an agent rides, their rosters, and its unseen posts, marked seen. Without `agent`, every peloton. |
| `GET /api/peloton/<peloton>` | A peloton’s roster and posts: a repository’s slug, or `chase:<feature>`. |
| `POST /api/peloton/<peloton>` | `{ agent, kind, text, reply_to?, task? }`. An agent holding a claimed task that rides it posts. Not the cookie. |
| `GET /api/features`, `POST /api/features` | Features by release with their progress and chase, and suggested tags; make one (`tasks` or `from` joins tasks). |
| `GET /api/features/<slug>`, `PATCH …`, `DELETE …` | One feature and its tasks, with `planning`, agents' changes to its plan; change it (an agent its title, brief, and release; the dates and shipped are the owner's), or delete it (owner). |
| `POST /api/features/<slug>/chase` | Owner: `{ on, parallel?, dryRun? }` starts, changes, or stops a chase; `{ dismiss: true }` clears an ended chase’s note. |
| `GET /api/routines`, `POST /api/routines` | List or create routines. |
| `PATCH /api/routines/<slug>` | Change one. |
| `POST /api/routines/<slug>/run` | Run it now. |
| `POST /api/routines/<slug>/triggers`, `DELETE …/triggers/<id>` | Make or revoke a webhook trigger. |
| `POST /api/horizons/close` | Close now; `{ dryRun: true }` only counts. |
| `POST /api/import` | Restore an export into an empty board: `{ tasks, count }` as `export` wrote it. The owner’s; `409` on a board that has tasks. |
| `POST /api/releases/<version>/pull` | Pull a release into now: its open tasks and every open task they wait for. Only the next release with work outside now; `{ into: "next" }` stages it in next instead, from the next release with work in later; `{ dryRun: true }` only lists them. The owner's or an agent's (with its `by`), whose pull is kept for undo. |
| `POST /api/planning/<id>/undo` | Undo an agent's change to the plan: a feature's release, title, or brief, a pull, or another task's fields. Refused when someone changed the same field since. Yours, from the signed-in web board. |

### Firing a routine from outside

A routine’s webhook trigger has its own secret and no board token:

```sh
curl -X POST "$BREAKAWAY_URL/api/routines/changelog/fire" \
  -H "Authorization: Bearer swr_…" -H "Content-Type: application/json" \
  -d '{ "note": "Release v0.3 is out.", "data": { "tag": "v0.3.0" } }'
```

The secret may also come in an `X-Routine-Secret` header. The body is at most 16 KB with an optional `note` (up to 1,000 characters) and `data` (up to 10 short keys). Nothing else is read, and what you send is stored as an untrusted comment, never as instructions. A wrong, revoked, or other routine’s secret gets `401`, the same answer whether or not the routine exists. `429` means a cap or the gap stopped it, `409` that the routine is off, `413` that the body was too big. See [Routines](/docs/routines/).

## GitHub

| Route | Does |
| --- | --- |
| `GET /api/github?repo=` | Pull requests, checks, runs, deploys, alerts for a repository. |
| `GET /api/github/pulls/<n>?repo=` | One pull request page, read live. |
| `POST /api/github/sync` | Sync now. |
| `POST /api/github/pulls/<n>/fix`, `…/review` | Start an agent that fixes a pull request, or one that reviews it (Review with an agent, or Safe to merge? on a Dependabot one). |
| `POST /api/github/alerts/<n>/fix` | Start an agent on a Dependabot alert. |
| `POST /api/github/pulls/<n>/publish`, `update-branch`, `merge`, `auto-merge` | **Owner only.** The signed-in browser. |
| `POST /api/github/promote`, `/rollback` | **Owner only.** Start the repository’s Promote or Roll back workflow. |

Without `repo`, the default repository is read.

## Repositories

| Route | Does |
| --- | --- |
| `GET /api/repos` | The registry: repositories, areas, the default, and `firstRun`. |
| `POST /api/repos` | Register one (`dryRun: true` only checks). Owner. |
| `GET /api/repos/<slug>` | One repository for its settings page: its row, each area’s open and total tasks, whether its routine is connected, its saved routines, open tasks, running agents, and GitHub’s default branch. A removed one too, read only. |
| `PATCH /api/repos/<slug>` | Change one (`dryRun: true` only checks; `edited`, the time `GET` gave, refuses with `409` and the current row when it changed since). Owner. |
| `DELETE /api/repos/<slug>` | Take one off the board. Owner. |
| `POST /api/repos/<slug>/release` | Give a removed repository’s slug and prefixes back. Owner. |
| `GET /api/repos/setup?slug=` | The Add a repository wizard’s state. |

## Kickoffs

A kickoff is a new project on its way from a pitch to a registered repository with its idea. Writing is the owner’s, from the signed-in web board only: the bearer token reads.

| Route | Does |
| --- | --- |
| `GET /api/kickoffs` | The kickoffs in progress, oldest first. One whose idea is done leaves the list. |
| `GET /api/kickoffs/<id>` | One kickoff, with the Add a repository wizard’s steps for its repository (`check=1` asks GitHub live). |
| `POST /api/kickoffs` | Start one from its `pitch`; the `name`, `slug`, and `areas` are suggested unless given (`dryRun: true` only checks). Owner. |
| `PATCH /api/kickoffs/<id>` | Change its pitch, name, slug, areas, or `github` until it’s registered. Owner. |
| `POST /api/kickoffs/<id>/register` | Register its repository with the slug and areas it saved. Owner. |
| `DELETE /api/kickoffs/<id>` | Stop it, with the images still waiting for its idea. A registered repository and its idea stay. Owner. |
| `POST /api/kickoffs/<id>/images` | Add an image, as on a task (up to 4). Owner. |
| `DELETE /api/kickoffs/<id>/images/<n>` | Delete one of its images. Owner. |

Registering a kickoff’s repository, from here, the wizard, or `repos add`, makes its idea there: the pitch as its description, its images, and the tag `kickoff-project`.

## The sync protocol

`/v1/client/*` is the TaskChampion sync protocol for Taskwarrior replicas. It isn’t part of the JSON API: it accepts only the install’s client ID, and its bodies are encrypted. Use [Taskwarrior](/docs/taskwarrior/).

> **Stability.** The API serves the board’s own clients, so routes and fields can change between major releases. Every answer carries the board’s release in the `X-Tasks-Release` header, and the CLI number an old copy of the CLI compares in `X-Tasks-Cli`; a copy that’s too old says how to update.
