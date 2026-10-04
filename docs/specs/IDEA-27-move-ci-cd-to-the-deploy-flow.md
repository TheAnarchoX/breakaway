# IDEA-27 · Move a repository's CI/CD to breakaway's deploy and release flows from the GitHub page

Task: `IDEA-27` on the board · Status: draft · The npm release flow added by `BRK-102` (4 Oct 2026)

## Problem

breakaway can deploy a repository's app: staging on every merge, **Promote** to production, **Roll back**, and the board showing what shipped where ([IDEA-10](IDEA-10-promote-releases.md), [`docs/tasks.md`](../tasks.md#promote-and-roll-back)). It only does so for a repository with a `pipeline` ([IDEA-14](IDEA-14-multi-repo.md)), which means the repository already has the Deploy, Promote, and Roll back workflows, the helper scripts they run, and a staging and a production Worker. Today an owner gets there by hand: write the three workflows, work out the deploy paths, and set `repos modify --pipeline`. Nothing in this repository helps: `template/` holds only the files for deploying a board, and `repos init` copies the helper scripts but not the workflows that call them.

A repository can ship a second way: as an npm package. breakaway does it for its own CLI ([the README's releases](../../README.md#releases)): every merge to `main` stages a pre-release, `X.Y.Z-main.N`, on the `next` dist-tag; the owner promotes one to a stable `X.Y.Z` on `latest`; and each version waits, staged on npm, until a person approves it with 2FA. Another repository gets none of that, and the board shows nothing of a package (`BRK-101` and `WEB-18` add a Packages feed). So the move covers both, side by side: a repository's Worker deploys, and its npm releases.

The owner's note on the idea sets the bar: for a new repository, template files; for a repository being onboarded, a step in the wizard; "basically just a few clicks, without having anyone lose anything in their CI/CD". It shouldn't matter which checks they run or where they deploy.

## Fit

- **Free and self-hosted, an install keeps its data:** nothing leaves the install. The templates are files in the owner's own repository; the board adds no call to a service the owner didn't connect.
- **People merge and deploy.** The move is a pull request the owner merges. The agent never deploys, never touches secrets or environments, never runs a workflow, and never sets the pipeline ([`AGENTS.md`](../../AGENTS.md#what-agents-never-do)). The board sets the pipeline only on the owner's press.
- **People approve what goes to npm.** The release flow stages each version, and it goes live only when the owner approves it on npm with 2FA. The board never publishes, approves, or holds an npm token: it reads what's staged and published, and that's all (`BRK-101`, read-only, the owner's decision of 4 Oct 2026).
- **Taskwarrior and the board's core are untouched.** No new agent mode in `prompts/core.md` (copied everywhere); the move is an ordinary build task with a good brief.

## Design

### 1. What the button moves, and what it says for the rest

The first version moves **a repository that deploys Cloudflare Workers with Wrangler**, which is what the pipeline's workflows run, **a repository that publishes a package to npm**, which is what the release flow runs, or both. For anything else the button doesn't pretend:

| The repository today | What the GitHub page says |
| --- | --- |
| Deploys a Worker with `wrangler` (from Actions, or Workers Builds git integration) | **Move to breakaway's deploy flow**, the whole feature. |
| Has CI but deploys by hand, or from a laptop | Same button: the move adds deploys and keeps its CI as it is. |
| Has no CI at all (a new repository) | Same button, and the PR also adds a minimal CI workflow, which the owner edits to taste ([new repositories](#4-new-repositories)). |
| Publishes an npm package (from Actions, or by hand from a laptop) | **Move to breakaway's release flow**: a pre-release on `next` for every merge, and a stable release on `latest` when the owner promotes one ([2b](#2b-the-release-flow-for-npm-packages)). |
| Deploys a Worker and publishes a package | Both, in one pull request. The two flows sit side by side and don't wait on each other. |
| Publishes to another registry (GitHub Packages, JSR, PyPI) | No release flow for it. The card says the release flow publishes to npm, and the current setup stays as it is. |
| Deploys somewhere else (Pages, Vercel, Fly, a server, containers) | No button. The card says "breakaway's deploy flow runs Cloudflare Workers. Your current setup stays as it is." and links the docs on what the flow needs. Nothing is half-moved. |

The agent decides which row applies by reading the workflows, `wrangler.*`, and `package.json`; if it is a "somewhere else", it stops, comments why on the task, and opens no pull request. A deploy target the flow could learn later (a `deploy` command per environment instead of `wrangler`) is out of scope; the config names the commands ([below](#2-the-templates)) so that door stays open.

### 2. The templates

`template/pipeline/` (new) holds what a repository needs, as files the CLI renders from one small config the repository owns, `.github/breakaway-pipeline.json`:

```json
{
  "workers": { "staging": "widgets-staging", "production": "widgets" },
  "checks": ["CI"],
  "install": "npm ci",
  "build": "npm run build",
  "beforeDeploy": ["npm run migrate"],
  "deployPaths": { "widgets": "^(src|public)/|^wrangler\\.jsonc$|^package(-lock)?\\.json$" },
  "healthCheck": "https://widgets-staging.example.workers.dev/",
  "package": { "name": "widgets", "directory": ".", "access": "public" }
}
```

- `checks` is the names of the workflows that gate a deploy. Deploy runs after them (`workflow_run`, success, on the exact commit), so **whatever checks the repository runs stay its own**: the move reads their names, never rewrites them.
- `install`, `build`, `beforeDeploy`, and `healthCheck` are the repository's own commands and address, taken from its old workflow. This is how "it shouldn't matter what checks they want to run or where to deploy to" holds: the templates call commands, they don't prescribe them.
- The rendered files are `deploy.yml`, `promote.yml`, `rollback.yml`, and `deploy-paths.json`, and they follow the design already approved for the flow ([CLD-27](CLD-27-continuous-deployment.md), [IDEA-10](IDEA-10-promote-releases.md)): build once and upload per environment, migrations in order, a health check with automatic rollback, `DEPLOYS_PAUSED`, tag and release on production only, Deployments as the record. They run the helper scripts `repos init` already copies (`record-deployment.mjs`, `promote-check.mjs`, `release-notes.mjs`, `check-migrations.mjs`, `release-artifact.mjs`).
- Three optional fields came with the renderer (`BRK-90`): `branch` (the default branch, `main` when left out), `wranglerEnv` (`{ "staging", "production" }`, the wrangler config's environment for each Worker, passed as `--env`), and `healthCheck` as `{ "staging", "production" }` when production has its own address (a string checks staging only). `beforeDeploy` commands read `$BREAKAWAY_ENV` (`staging` or `production`) and `$WORKER`.
- `package` is there only for a repository that publishes to npm ([2b](#2b-the-release-flow-for-npm-packages)): the package's name (the one in that directory's `package.json`), where it lives, and `public` or `restricted` access. `workers` is optional when `package` is set, so a repository that only publishes gets only the release flow; the config needs one of the two.
- **The renderer is a CLI command**, `npx breakaway pipeline init` in the repository's checkout (and `pipeline check`, which validates the config and that the rendered files are current). The agent's judgment goes into the config; the files come from the renderer, so every repository gets the same workflows and a fix to the template reaches them by `pipeline init --update` (a pull request, like `repos init --update`).

### 2b. The release flow for npm packages

The flow breakaway runs for its own CLI, as a template.

- **Versions come from `package.json`**, as breakaway's do (`nextPrerelease` in `scripts/release/lib.js`). Every merge to the default branch stages `X.Y.Z-main.N` on `next`. Once a stable `X.Y.Z` exists, the next pre-releases are the next patch's, so patches count themselves. The next minor or major is a pull request that sets `package.json`'s version, which `BRK-100` lets the owner start from the board.
- **The rendered file is `release.yml`, with two jobs.** **pre-release** runs after the `checks` (`workflow_run`, success, on the exact commit, the default branch only), like Deploy. **stable** runs when the owner promotes a pre-release: the same commit's files under `X.Y.Z` on `latest`, nothing rebuilt from a later commit.
- **Both stage, neither publishes.** Each runs `npm stage publish --provenance --access <access> --tag next|latest` from a job in the `npm` environment, which only the default branch can use. npm's trusted publishing comes first (npm reads the workflow's identity). Until it applies, a granular `NPM_TOKEN` in that environment stands in: one that can't bypass 2FA, so it stages a version and never publishes one by itself (breakaway's own `BRK-75`). A private repository publishes without `--provenance`, which npm refuses from one.
- **Each run says what it staged, in one notice line**, word for word what breakaway's Release workflow prints: `<package>@<version> goes live on <dist-tag> once the owner approves it with 2FA: npm stage approve <id>, or Staged Packages on npmjs.com`. That line is what the board's Packages feed reads (`BRK-101`), so the template keeps it exactly.
- **Stops, not surprises.** `DEPLOYS_PAUSED` pauses releases too. A version already on npm stops the run with npm's message; it never retries under another number. The stable job tags `vX.Y.Z`, or `<package>@X.Y.Z` in a repository whose production deploys already tag `v…`.
- **Beside the Worker flow, not inside it.** Promote deploys the Worker and publishes nothing. A package's stable release is its own press, **Release** on the GitHub page next to Promote: the owner's, cookie only, and it runs `release.yml`'s stable job with the pre-release the owner chose (`BRK-103`). A repository that wants the two in step presses both.
- **`repos init` copies the release helpers** with the deploy helpers: the pre-release number and the stable version, worked out as `scripts/release/lib.js` does for breakaway.

### 3. One agent run, not a plan of tasks

A move is one pull request, and the pieces depend on each other (the config decides the workflows). So it is **one task and one agent run**, an ordinary build:

1. **The button** (owner only, cookie only, same-origin, like Merge) adds a task to the repository, `Move <repo> to breakaway's deploy flow`, area from the repository's own, with a brief that says what to do and a done when, and starts its routine run. It is the owner's press, so it is not `--autostart`. Pressing it again while the task is open does nothing; it shows the open one.
2. **The agent** follows the repository's prompt and a new copied skill, `.agents/skills/pipeline/SKILL.md`, which `repos init` copies (and `--update` refreshes) with the templates. It: reads the workflows, `wrangler.*`, scripts, and migrations; decides the [row](#1-what-the-button-moves-and-what-it-says-for-the-rest); writes `.github/breakaway-pipeline.json`; runs `pipeline init`; and **accounts for every step of the old setup** (below) in the pull request.
3. **Nothing lost, nothing twice.** The pull request carries a table, step by step: each old workflow, job, and step, and where it went (the config, a rendered workflow, kept as it is, or dropped with the reason, for example "deployed on push to main: now Deploy after CI"). Rules for the agent:
   - It never edits or removes a check workflow. A workflow that only deploys is removed or has its deploy trigger turned off in the same pull request, so the merge can't deploy twice. A workflow that checks and deploys is split: the checks stay, the deploy step moves.
   - A step it can't map (a manual approval, a custom script it can't run through `beforeDeploy`) stays where it is, and the PR says so under **After merging**; it never invents an equivalent.
   - It can't tell whether a deploy path pattern is right from reading alone, so the PR lists the patterns and what each one covers.
   - An old publish setup is mapped the same way. A workflow that only publishes is removed or has its trigger turned off, so a merge can't publish twice; a publish step in a check workflow moves. A versioning tool with a scheme of its own (changesets, semantic-release, release-please) can't be mapped onto `package.json` plus `-main.N`, so the agent stops and asks the owner with a decision rather than replacing it.
4. **The owner reviews and merges.** Merging deploys nothing: the new Deploy workflow runs on the next merge to the default branch, and until the owner has done their part ([below](#what-the-owner-still-does-by-hand)) it stops at its first step with a message that says which part.

### What the owner still does by hand

The board has no Cloudflare or GitHub-settings credentials, and agents never get them, so these stay the owner's. They are a checklist on a `+owner` task the agent adds (depending on its own), and the PR's **After merging** repeats it:

- Create the staging and production Workers (or confirm the existing ones) and a Cloudflare API token per Worker ([CLD-27](CLD-27-continuous-deployment.md#the-token-cld-28)).
- Make the GitHub environments (`staging`, `production`) with the token as `CLOUDFLARE_API_TOKEN`, restricted to the default branch, and the repository variable for the account ID.
- Give the board's GitHub App **Actions: read and write** on the repository (Promote and Roll back need it).
- Optional: the `DEPLOYS_PAUSED` variable's habit, and the health-check address.
- For a package: make the `npm` environment, restricted to the default branch; on npm, add a trusted publisher for `release.yml` and that environment, or put a granular `NPM_TOKEN` that can't bypass 2FA in the environment; and approve each staged version on npm with 2FA (`npm stage approve <id>`, or Staged Packages on npmjs.com). The board shows what waits (`WEB-18`) and never approves.

### 4. New repositories

`repos init` already prepares a new repository for agents. It gets one more optional step: `repos init <slug> --pipeline` also runs `pipeline init` from a starter config (the two Worker names it asks for, the default `build`, no `beforeDeploy`) and, when the repository has no workflow at all, adds a minimal `ci.yml` (install, build, test if the repository has a `test` script). Both are new files in the same pull request `repos init` already opens; nothing existing is touched. `--package` adds the release flow for the package that `package.json` names, with its `access`; without it there's no package flow, and a `package.json` that says `"private": true` gets none either way. This is the owner's "template files for new repositories".

### 5. Turning it on after the merge

The pipeline field is how the board knows a repository deploys. Once the three workflows and `.github/breakaway-pipeline.json` are on the default branch (the sync already reads the tree), the GitHub page's card changes from "waiting for the pull request" to **Turn on deploys**: it shows the Worker names and workflow files it read, and one press sets the repository's `pipeline` (owner only, cookie only, the same validation as `repos modify --pipeline`). The CLI route stays. Nothing about the pipeline changes until that press, so a merged-but-unconfigured repository shows no Releases card, no Promote, no "merging deploys" warning.

The pipeline field gains `package`, the package's npm name, and `workers` becomes optional when `package` is set: the field needs one of the two (`BRK-103`). **Turn on deploys** reads both from the default branch and says which flows it turns on. With a package, the GitHub page shows the Packages feed (`BRK-101`, `WEB-18`) and the **Release** press ([2b](#2b-the-release-flow-for-npm-packages)).

### 6. The wizard and the GitHub page

- **The GitHub page** shows, for a registered repository without a pipeline, a card at the top: **Deploy with breakaway** (what it does in two sentences, the button, and "Skip" that hides the card for this repository in this browser). For a repository that publishes a package, it says **Deploy and release with breakaway**, or **Release with breakaway** when it deploys no Worker, and the two sentences name the package. The same card follows the run:

  | Stage | What the card says | Where it comes from |
  | --- | --- | --- |
  | Not started | The explanation and **Move to breakaway's deploy flow** | no open move task |
  | Agent running | "An agent is reading your workflows", the live output link, and the task | the task and its agent run |
  | Pull request open | The PR (title, checks), and the **After merging** checklist | the PR the task points at |
  | Merged, not on | **Turn on deploys** ([5](#5-turning-it-on-after-the-merge)) | workflows on the default branch |
  | On | The card goes away; Releases takes its place | the repository has a `pipeline` |
  | The agent stopped | Its reason from the task's last comment, and **Try again** | the released task |

- **The Add a repository wizard** gets an optional step, **Deploys**, after **Register** and **init**: the same card, skippable, and never blocking the steps after it (an agent can claim tasks without a pipeline). Skipping is a remembered choice, not a failure.
- Every state has words and an icon, not color alone; the button is a real button; the card is a labelled region; status changes are announced politely once; motion stops under reduced motion; tokens only, in both themes ([brand guide](../../brand/README.md)). Copy follows the guide: verbs on buttons, errors that say what failed and what to do.
- Signed out or Ghost-like read-only states: the card is read-only text with no buttons, as Merge is.

### Edge states

| State | What happens |
| --- | --- |
| The repository has no commits | The wizard's existing "no commits yet" step comes first; the card waits. |
| The GitHub App isn't installed or lacks write access | The card says which and links Connections; the button is disabled with the reason beside it. |
| A move task is already open | The card shows it; no second task. |
| The repository already has workflows named `deploy.yml`, `promote.yml`, or `rollback.yml` | The agent doesn't overwrite them silently: it maps them in the table and either replaces them in the PR (when they are the old deploy) or stops and asks with a decision (when they aren't). |
| Several Workers in one repository (an app and a worker) | The config's `deployPaths` is per Worker, as today; the first version supports one staging and one production Worker pair, and the card says so when it finds more. |
| The agent opens a pull request that fails its own checks | The ordinary flow: the board's **Fix with an agent**. |
| The repository publishes several packages (a monorepo) | The first version releases one package per repository. The card says so, and the agent leaves the others' publishing as it is. |
| `package.json` says `"private": true` | No release flow. The card says the package isn't publishable. |
| The name on npm belongs to someone else, or the version is already published | The release run stops at that step with npm's message; nothing is renamed or renumbered. |

## Privacy

Stores nothing new. The config holds Worker names and commands the repository already shows; no secret is read, written, or put in a task. What the agent sees is the repository's workflows and scripts, which is what any agent working there sees. The templates make no network call but the ones the approved pipeline already makes (Cloudflare through Wrangler, GitHub's API with the workflow's own token), and, for a package, npm's from the release workflow. An npm token, when there is one, lives in the repository's `npm` environment, and the board never sees it. The board's reads of npm's public registry are `BRK-101`'s, read-only.

## Out of scope

- Deploy targets other than Cloudflare Workers, and more than one staging and production pair.
- Moving a repository off GitHub Actions to Workers Builds or Artifacts ([IDEA-16](IDEA-16-artifacts-and-workers-builds.md), `BRK-33`).
- Setting up Cloudflare or GitHub for the owner (Workers, tokens, environments, App permissions): the owner's, by hand.
- Rewriting or replacing a repository's checks.
- A new agent mode in `prompts/core.md`.
- Registries other than npm, and versioning schemes other than `package.json`'s version plus `-main.N` (changesets, semantic-release).
- The board publishing or approving anything on npm.

## Open questions

Asked as one decision on the board (`+decide`):

1. **Who writes the files, the CLI renderer or the agent?** Recommended: the renderer, with the agent filling the config, so every repository gets the same workflows and updates reach them. The alternative is the agent adapting the templates freely, which fits odd setups better and drifts.
2. **What does "keep what the old setup did" do with a step that can't be mapped?** Recommended: leave it where it is and say so. The alternative is to stop and open no pull request.
3. **Does a repository with a deploy target other than Workers get nothing, or a later "bring your own deploy command" option?** Recommended: nothing now.

## Done when

- A repository that deploys a Worker from GitHub Actions gets one pull request from the button with the three workflows, the deploy paths, and the config, and a table showing where each old step went; merging it and doing the owner's checklist is all it takes for Deploy to run on the next merge.
- A repository that publishes an npm package gets the release flow in the same pull request: a pre-release on `next` for every merge, a stable on `latest` from the owner's **Release** press, each staged until the owner approves it on npm, and the board's Packages feed shows them.
- `repos init <slug> --pipeline` does the same for a new repository, with `--package` for its package.
- After the merge, one press on the GitHub page turns the pipeline on.
- The card follows the run from not started to on, and the wizard has the optional step.
- The docs say what the move does, what it leaves alone, and what the owner does by hand.

Built by these tasks, each a pull request of its own, all waiting for this spec to merge:

| Task | What | Waits for |
| --- | --- | --- |
| `BRK-89` | The owner's decision on the open questions | this spec |
| `BRK-90` | The templates (Deploy, Promote, Roll back, deploy paths, and `release.yml` for a package) and the `pipeline init` and `pipeline check` renderer | `BRK-89` |
| `BRK-91` | `repos init --pipeline` (and `--package`) for a new repository | `BRK-90` |
| `BRK-92` | The `pipeline` skill the agent follows, copied by `repos init`, including an old publish setup | `BRK-90`, `BRK-89` |
| `BRK-103` | The pipeline field's `package`, and the **Release** press for a package's stable | `BRK-90` |
| `WEB-12` | The card and the Move button on the GitHub page | `BRK-92`, `BRK-89` |
| `WEB-13` | Turn on deploys after the merge | `BRK-90` |
| `WEB-14` | The wizard's Deploys step | `WEB-12` |
| `DOC-12` | The docs | `WEB-13` |

Related, built on their own: `BRK-100` (prepare the next minor or major from the board), `BRK-101` (the Packages feed), `WEB-18` (packages on the GitHub page). `BRK-102` added the release flow to this spec.
