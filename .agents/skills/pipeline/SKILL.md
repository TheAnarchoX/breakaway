---
name: pipeline
description: Use when a task asks to move a repository's CI/CD to breakaway's deploy flow or release flow (Move to breakaway's deploy flow, Deploy with breakaway, Release with breakaway), to write or change .github/breakaway-pipeline.json, to run npx breakaway pipeline init or pipeline check, or to map an old deploy or npm publish workflow onto Deploy, Promote, Roll back, and Release.
---

# Moving a repository to the deploy flow

A move is one task and one pull request: you read how the repository checks, deploys, and publishes today, write `.github/breakaway-pipeline.json`, render the workflows from it with `npx breakaway pipeline init`, and account for every step of the old setup, so nothing is lost and nothing runs twice. The design is the [move's spec](../../../docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md) (sections 2, 2b, and 3), and the [docs](../../../docs/tasks.md#moving-a-repository-to-the-deploy-flow) say what the flows do.

It is an ordinary build: claim, check in on the peloton, and hand over the way the repository's prompt and the `tasks` skill say. This skill is how to do the move itself.

**You never** deploy, publish, run or re-run a workflow, touch Cloudflare, npm, or the repository's GitHub settings (environments, secrets, variables, the App's permissions), or set the repository's pipeline on the board (`repos modify --pipeline` and **Turn on deploys** are the owner's). You write files in a pull request; the owner does the rest.

## 1. Read what's there

Read all of it before you decide anything:

- **Workflows**, `.github/workflows/*.yml`: each one's `name:` line, its triggers (`push`, `pull_request`, `workflow_run`, `release`, `workflow_dispatch`, `schedule`), and every job and step. Note which steps check (lint, test, build, typecheck), which deploy (`wrangler deploy`, `wrangler versions upload`, `cloudflare/wrangler-action`), which publish (`npm publish`, or pnpm's or yarn's, `JS-DevTools/npm-publish`, a `release` event), and which do something else (a migration, a cache purge, a notification, a manual approval through an `environment` with reviewers).
- **Wrangler config**, `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`: the Worker's `name`, its `env` blocks (each one's name, and the Worker name it deploys as), and its bindings, above all D1 databases and their `migrations_dir`.
- **Migrations**: the folder and how they're applied today (`wrangler d1 migrations apply`, a script).
- **`package.json`**: `name`, `version`, `private`, `scripts` (`build`, `test`, `deploy`, `release`, `prepublishOnly`), `publishConfig`, and `workspaces`; and the lockfile, which says the install command (`npm ci` for `package-lock.json`, or pnpm's or yarn's frozen install for theirs).
- **Versioning tools**: `.changeset/`, `release-please-config.json`, `.releaserc*` or a `release` key in `package.json` (semantic-release), and `lerna.json`.
- **Anything already at the flow's paths**: `.github/breakaway-pipeline.json`, `.github/deploy-paths.json`, and `deploy.yml`, `promote.yml`, `rollback.yml`, or `release.yml` in `.github/workflows/`.
- **Scripts the workflows run**, in `scripts/` or `package.json`: what each does, so you know whether `beforeDeploy` can run it.

## 2. Decide what moves

| The repository today | What you do |
| --- | --- |
| Deploys a Worker with `wrangler`, from Actions, Workers Builds, or by hand | Move it: `workers` in the config. |
| Has checks but deploys by hand | Move it: the deploy is new, and the checks stay as they are. |
| Publishes a package to npm, from Actions or by hand | Move it: `package` in the config. |
| Deploys a Worker and publishes a package | Both, in one config and one pull request. |
| Publishes to another registry (GitHub Packages, JSR, PyPI) | That publishing stays as it is. Say so in the pull request; move a Worker deploy if there is one. |
| Deploys somewhere else (Pages, Vercel, Fly, a server, containers) | Stop (below). breakaway's deploy flow runs Cloudflare Workers only; a deploy command of the repository's own is planned, not built. |
| `package.json` says `"private": true` and nothing deploys | Stop: there is nothing the flows can take. |

The first version takes **one staging and one production Worker** and **one package** per repository. With more Workers, move the pair the task names (or that the old deploy targets on the default branch), and leave the others' deploys as they are, saying so. With several publishable packages (a monorepo), move the one the task names (or ask, below), and leave the others' publishing as it is.

**Stopping** means changing nothing and opening no pull request: `comment` on the task what you found and why it doesn't move (the row above, in a sentence the owner can act on), then `release` it. When only the owner can choose (which package, which Worker pair, or what to do with a versioning tool), ask with a decision instead (the core's "Asking for a decision") and release.

## 3. Write the config

`.github/breakaway-pipeline.json` is the repository's own. Every value comes from what you read, never invented:

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "wranglerEnv": { "staging": "staging", "production": "production" },
  "branch": "main",
  "checks": ["CI"],
  "install": "npm ci",
  "build": "npm run build",
  "beforeDeploy": ["npx wrangler d1 migrations apply DB --remote --env $BREAKAWAY_ENV"],
  "deployPaths": { "widgets": "^(src|public|migrations)/|^wrangler\\.jsonc$|^package(-lock)?\\.json$" },
  "healthCheck": { "staging": "https://widgets-staging.example.workers.dev/", "production": "https://widgets.example.com/" },
  "package": { "name": "widgets", "directory": ".", "access": "public" }
}
```

- **`workers`**: the staging and production Worker names, as the wrangler config deploys them (with its `env` blocks, the name each environment deploys as). Two different Workers. A repository with only production today needs a staging Worker: name it `<production>-staging`, and the owner creates it (the checklist).
- **`wranglerEnv`**: only when the wrangler config has `env` blocks; the environment name for each Worker, passed as `--env`.
- **`branch`**: the default branch, when it isn't `main`.
- **`checks`**: the `name:` line of each workflow that must pass before a deploy or a release, exactly as written. Every check the old deploy waited for, and the ones that run on push to the default branch. Never a workflow you're about to remove.
- **`install`, `build`**: the repository's own one-line commands, from its old workflow or lockfile. Leave `build` out when nothing builds.
- **`beforeDeploy`**: the old deploy's steps before `wrangler deploy` (migrations first), one command each. They read `$BREAKAWAY_ENV` (`staging` or `production`) and `$WORKER`. A step that needs more than one line goes in a script the command runs; a step that can't run there stays where it is (step 5).
- **`deployPaths`**: per Worker, a regular expression of the paths whose change needs a deploy: its source, static assets, migrations, the wrangler config, and the package and lockfile. The board reads the same patterns to say "No deploy needed", so a path left out never ships and a path put in too many deploys for nothing. You can't prove them from reading, so the pull request lists each part and what it covers (step 6).
- **`healthCheck`**: an address the old workflow or the README checks after a deploy, as a string (staging only) or `{ "staging", "production" }`. Leave it out when there is none; never guess one.
- **`package`**: `name` exactly as its `package.json` says, `directory` its folder (`.` at the root), and `access` (`restricted` only when `publishConfig.access` or the old publish says so; a scoped package published `public` today stays `public`). Its `package.json` needs a plain `X.Y.Z` version: the flow counts from it. A repository that only publishes has no `workers`, `deployPaths`, `healthCheck`, `beforeDeploy`, or `wranglerEnv`.

**A versioning tool with its own scheme** (changesets, semantic-release, release-please) decides versions from commits or changeset files; the release flow takes `package.json`'s version and stages `X.Y.Z-main.N` on `next` for every merge. They can't both run, and one can't be mapped onto the other. Don't replace it: ask the owner with a decision (keep the tool and move only the Worker deploy; or drop the tool for the release flow, which a later task does), and stop the package part until it's answered. Move a Worker deploy in the meantime only if the decision says to.

## 4. Render the workflows

In the checkout, run `npx breakaway pipeline init`. It checks the config, naming the field that's wrong and what it should be, and the rendered workflows (YAML, pinned actions, expressions, secrets only in an environment), and writes nothing if either fails. It writes `.github/workflows/deploy.yml`, `promote.yml`, `rollback.yml`, and `.github/deploy-paths.json` for `workers`, and `.github/workflows/release.yml` for `package`. Never edit what it writes: change the config and run it again.

- **It refuses a file already there** that it didn't render. When that file is the old deploy or publish workflow you're replacing, delete it in this pull request (step 5) and run `pipeline init` again. When it's something else that only shares the name, stop and ask the owner with a decision: never rename or overwrite it silently.
- **It names helper scripts the repository lacks** (`scripts/record-deployment.mjs` and the others). `repos init <slug> --update` copies them, and that is the owner's: say so under **After merging** (the workflows fail without them), unless they're already there.
- **`npx breakaway pipeline check`** passes before you hand over: the config is sound, and the files are what it renders now.

## 5. Nothing lost, nothing twice

Every old job and step ends up in exactly one place: the config, a rendered workflow, kept where it was, or dropped with the reason. The rules:

- **Checks are the repository's own.** Never edit or remove a workflow that checks. Deploy and Release wait for them by name.
- **A workflow that only deploys or only publishes** comes out in the same pull request, deleted, or with its trigger on the default branch removed when it also runs for something else (a tag, by hand, a preview on pull requests, which stays). Otherwise the merge deploys or publishes twice.
- **A workflow that checks and deploys, or checks and publishes**, is split: its checks stay as they are, and the deploy or publish job or steps come out (with the `needs:`, `if:`, permissions, and `environment` only they used). If its deploy job is all that runs on push to the default branch, drop that trigger too, so the checks still run where they did.
- **Workers Builds** (Cloudflare's git integration) deploys from Cloudflare, not from a file: you can't turn it off. Say under **After merging** that the owner disconnects it before merging, or the merge deploys twice.
- **A step the flow can't do** (a manual approval, a custom deploy script `beforeDeploy` can't run, a notification, a cache purge, publishing to another registry) stays exactly where it is, and the pull request lists it under **After merging** for the owner to decide. Never invent an equivalent.
- **Publishing by hand** (a `release` or `publish` script someone runs from a laptop) stays in `package.json`; the pull request says the release flow replaces it and the owner stops running it.
- **Never** add or change a secret, an environment, or a variable, and never put a token in a file.

## 6. The pull request

Open it the way the repository's prompt's **Pull requests** says, closing the task. Its description holds, besides what that asks:

- **What moves**: the row from step 2, the Workers, and the package.
- **Step by step**: a table of every old workflow, job, and step, and where each went:

  | Old | Was | Now |
  | --- | --- | --- |
  | `deploy.yml` · deploy | `wrangler deploy` on push to `main` | Deploy (`deploy.yml`, rendered) after CI passes; the old file is removed |
  | `ci.yml` · test | `npm test` | Kept as it is; Deploy and Release wait for CI |
  | `ci.yml` · publish | `npm publish` on a tag | Release (`release.yml`): `next` on every merge, `latest` on the owner's Release; the step is removed |
  | `deploy.yml` · migrate | `wrangler d1 migrations apply` | `beforeDeploy` |
  | `deploy.yml` · notify | posts to chat | Kept where it was (After merging) |

- **Deploy paths**: each pattern's parts and what they cover, so the owner can check them.
- **After merging**: the owner's checklist below, the steps kept where they were, and anything you stopped short of.

**The owner's part comes before the merge.** The merge itself runs Deploy and Release once its checks pass, so without the owner's part both fail. Add a `+owner` task for it, filled in like any task, with the checklist in its brief and only what this repository needs. It doesn't depend on the move task (it comes first), and the pull request's **After merging** repeats it under "Before you merge":

- the staging and production Workers (or confirm the existing ones), and a Cloudflare API token for each;
- the GitHub environments `staging` and `production`, each with its token as `CLOUDFLARE_API_TOKEN` and restricted to the default branch, and the repository variable `CLOUDFLARE_ACCOUNT_ID`;
- read and write on **Actions** for the board's GitHub App on the repository (Promote, Roll back, and Release start workflows);
- the helper scripts, with `repos init <slug> --update`, when `pipeline init` named any;
- Workers Builds disconnected, when the repository used it;
- for a package: the GitHub environment `npm`, restricted to the default branch; on npm, a trusted publisher for `release.yml` and the `npm` environment, or a granular `NPM_TOKEN` in that environment that can't bypass 2FA; and, after each run, approving the staged version on npm with 2FA (`npm stage approve <id>`, or Staged Packages on npmjs.com). The board shows what waits and never approves;
- optional: the repository variable `DEPLOYS_PAUSED` (`true` stops Promote and Release), and the health-check addresses;
- after the merge, **Turn on deploys** on the repository's GitHub page, which sets its pipeline from the files.

## Before handing over

- `npx breakaway pipeline check` passes.
- The repository's own checks pass, and every workflow you changed still parses and runs the jobs it ran before, minus what moved.
- Every old step is in the table, and no deploy or publish is left that the merge would run besides Deploy and Release.
- No secret, token, or address you didn't read in the repository is in a file, the task, or the pull request.
