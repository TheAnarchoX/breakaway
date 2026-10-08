---
title: Tokens, GitHub, and the apply workflow
nav: Tokens and the apply workflow
description: What lives where so the board can read what runs and a plan you approved can apply: the board’s read-only token, each environment’s write token in a GitHub environment, the apply workflow, and the GitHub App’s permissions.
---

Architect splits reading from writing on purpose. The board reads with one read-only token per provider. Writing happens only in your repository, in a workflow the board starts for one plan you approved, with a write token the board never sees.

## What lives where

| What | Where | Who sets it up |
| --- | --- | --- |
| The read-only token | On the board, encrypted, under **Connections** | You paste it |
| Each environment’s write token | A secret, `CLOUDFLARE_API_TOKEN`, in a GitHub environment of the same name | You, on Cloudflare and GitHub |
| The GitHub environment’s branch rule | GitHub: only the default branch may deploy | You, or **Make it on GitHub** |
| `BREAKAWAY_URL` | A repository variable: your board’s address | You |
| The apply workflow | `.github/workflows/breakaway-infra.yml` on the default branch | `npx breakaway infra init`, or the board’s change |
| Starting a workflow | The GitHub App’s **Actions: read and write** | You accept it on the App |

Agents never set up any of it.

## The Infrastructure tokens checklist

Each repository’s card on **Connections** has a checklist, **Infrastructure tokens**, that walks you through all of it and checks what it can through the GitHub App:

1. **The board’s read token**, for each provider the repository’s environments run on: the exact permissions, and **Open Cloudflare with these filled in**, a link to Cloudflare’s create-token page with the ones its links can fill in. It marks the rest **add by hand**.
2. **Each environment’s write token**, one GitHub environment at a time (`short-lived` once for all short-lived ones): the GitHub environment exists, only the default branch may deploy to it, and it holds a secret named `CLOUDFLARE_API_TOKEN`, read by name only. The permissions it lists come from the environment’s file.
3. **The apply workflow** on the default branch, offering every environment that needs a write token.

**Check again** reads GitHub afresh. Otherwise the checklist is kept for five minutes.

## The board’s read token

One custom account API token on Cloudflare, with an expiry date, and exactly these permissions:

- **Workers: Metadata Read-Only**, at the Workers product scope. It lists your Workers and their settings and can’t read their code. A token with the legacy Workers Scripts Read still works.
- On the account: **Workers KV Storage Read**, **Workers R2 Storage Read**, **D1 Read**, **Queues Read**, **Containers Read**, **Account Analytics Read**, and **Notifications Read**. Leave out queues or containers if no repository uses them.
- On the zones your environments use, and only those: **Zone Read** and **Workers Routes Read**, on the same zones.

Nothing that ends in Edit or Write, and not Billing Read, Workers Tail Read, or DNS Read. The board can’t see a permission a token has but shouldn’t, so keeping it read only is yours.

On **Connections**, find **Cloudflare**, paste it, and press **Connect**. The board checks it with Cloudflare, refuses one that’s missing a permission and says which, stores it encrypted, and never shows it again. **Replace the token** and **Forget the token** are on the same row. The board looks at what runs right after, then every 15 minutes.

If Cloudflare later refuses the token, the board stops looking until you paste a new one, and the row says why. A permission a call needed and didn’t have shows as missing on the row.

## Each environment’s write token

A second custom token per environment, with an expiry date, never reused for another environment:

- **Everything the read token has.**
- **Workers: Editor**, scoped to that environment’s Workers. If the environment has custom domains, scope it to the Workers product instead.
- **Only the writes its file needs**: **D1 Write**, **Workers KV Storage Write**, **Workers R2 Storage Write**, **Queues Write**, or **Containers Write**, and **Workers Routes Write** on its zones for routes and custom domains.
- **Never** Account Settings, API Tokens, Billing, DNS, or Notifications Write.

**Workers Admin**, which making or deleting a Worker needs, is never part of the standing token. Give it for the one apply that needs it, then take it away. The checklist marks it, for the first apply only, while a Worker the file declares doesn’t run yet.

On the deploy flow, staging and production already have a token each, in the same GitHub environments. Widen those, rather than adding a second one ([Architect and the deploy flow](/docs/architect-deploy-flow/)).

**Short-lived environments** share one token, in the GitHub environment `short-lived`, with only the writes the short-lived template declares.

### Keep staging and production apart

The board reads one Cloudflare account in 2.0: its read-only token is an account token, and it reaches one. So staging and production share that account, and their write tokens are kept apart by what they may do:

- each environment’s Workers role is scoped to its own Workers, the one permission Cloudflare scopes to single resources;
- every other permission reaches every resource of its kind on the account, so the board keeps each call inside the environment’s resources and refuses a plan that reaches outside them;
- each write token lives only in its own GitHub environment, which only the default branch may use.

Name each environment’s resources apart, like `widgets-api-staging` and `widgets-api` ([Patterns](/docs/architect-patterns/#staging-and-production-on-one-account-kept-apart)).

## The GitHub environment

In the repository’s **Settings**, under **Environments**, one per board environment, named the same:

1. **New environment**, named `staging`.
2. Under **Deployment branches and tags**, pick **Selected branches and tags**, and add only the default branch.
3. Add the write token as the secret **`CLOUDFLARE_API_TOKEN`**.

The board reads the branch rule before every run, and starts none, saying what to set, while another branch, a protected branch, or a tag may deploy. The workflow’s own check is read from whichever branch runs it, so the rule is what keeps the token from an edited copy on another branch.

**Make it on GitHub**, on the checklist, has the App make a missing environment with only the default branch allowed. It needs the App’s **Administration: write**, which nothing else on the board uses. On an environment that already exists, it only adds the default branch to a rule that names chosen branches and none yet; anything else there is yours to change. The secret is always yours to add.

## The apply workflow

`.github/workflows/breakaway-infra.yml`, **Apply infrastructure**, is the one path that changes infrastructure. In a checkout of the repository:

```sh
npx breakaway infra init              # writes it for every environment with a file
npx breakaway infra init --dry-run    # says what it would write
npx breakaway infra init --update     # after adding an environment, or a short-lived template
```

Commit it, open a pull request, and merge it. It takes the default branch from `origin` (or `--branch`), pins the breakaway release it runs, and checks itself before it writes. It never overwrites a file: `--update` replaces only what it wrote before.

**A change from the board brings it.** When the board proposes an environment’s file, from the console or from nothing, the same commit adds the workflow when it’s missing, or updates it when it’s the board’s own and differs, when the App has **Workflows: write**. Without it, the change comes without the workflow, and its card, its pull request, and the plan check say so before you approve: give the App Workflows: write and propose again, or run `infra init` and merge it.

**What it does**, for one plan, from the default branch only:

- runs in the GitHub environment of the same name, with only the `id-token: write` permission, and checks out none of your code;
- installs the runner, pinned to the release, with no install scripts, before any step holds the write token;
- asks the board for the plan with the run’s GitHub OIDC token, and stops before it reads the write token unless the board answers: only the run it started, for a plan approved for that environment, and only once;
- applies it, and reports each step with the plan’s digest, so a plan that changed since you approved it is refused.

Then the board checks health, and rolls back if it fails ([Plans and approvals](/docs/architect-plans/#after-you-approve)).

## The GitHub App’s permissions

Architect works without each of these, and says what’s waiting. Accept each on the App’s installation once you want what it’s for ([how](/docs/updating-to-2/#accept-the-github-apps-new-permissions)):

| Permission | What it’s for | Without it |
| --- | --- | --- |
| **Actions**: read and write | Starting the apply workflow, and Promote, Roll back, and Release | A plan stays **Approved**, and says why |
| **Checks**: read and write | The plan as a check on its pull request | The board’s pull request page still shows the plan |
| **Variables**: read and write | Freezing production sets `DEPLOYS_PAUSED` on the deploy flow | The freeze holds on the board only, and Connections says so |
| **Workflows**: read and write | A change from the board brings the apply workflow | Run `npx breakaway infra init` instead |
| **Administration**: read and write | **Make it on GitHub** makes a GitHub environment | Make it yourself, as above |
| **Environments**: read | The checklist checks the write token’s name | That step says it can’t check |
| **Pull requests** and **Contents**: read and write | The board opens and merges a change’s pull request | A board made from the manifest already has them |
