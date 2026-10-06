# Agent instructions

This file is for breakaway's own repository. If `git remote get-url origin` doesn't end with `/breakaway`, you're in a repository that carries a copy of breakaway's code: follow that repository's `AGENTS.md`, not this one.

## Project context

- **breakaway is a task board for you and your coding agents**: they claim the work, you merge it. It's a Cloudflare Worker with one Durable Object (`src/`), a Preact web app (`web/`), Taskwarrior sync, and a CLI. Each install runs on its owner's own Cloudflare account and can track several repositories. The licence is FSL-1.1-Apache-2.0, and the repository is public.
- **Work lives on the board** that tracks this repository. Use the [`tasks` skill](.agents/skills/tasks/SKILL.md) and the CLI, `npx breakaway`, to claim, comment, and hand over. breakaway's areas, with their work-ID prefixes: board (`BRK`), web (`WEB`), docs (`DOC`), launch (`LCH`), brand (`ID`), and cli (`CLI`). Ideas (`IDEA`) and routine runs (`RUN`) are shared by every repository on the install.
- **Agents the board starts** follow [`prompts/breakaway.md`](prompts/breakaway.md), which starts with the board's shared core, [`prompts/core.md`](prompts/core.md).
- **Specs** go in `docs/specs/<ID>-<slug>.md`: the problem, what you chose and why, what's out of scope, open questions, done when, and how to check it. A small change needs none; the task's description is enough.
- **The brand** is [`brand/README.md`](brand/README.md): the name, the voice, the words, the claims that must stay true, the logo, color, and type. Use the [`brand-guide` skill](.agents/skills/brand-guide/SKILL.md) for anything people see or read.

### Where things are

| Path | What |
| --- | --- |
| `src/` | The Worker: the API, the `TaskStore` Durable Object, GitHub, routines, pings, push, sync |
| `web/` | The board's web app (Preact and `@preact/signals`) |
| `test/` | Tests, run in the Workers pool with `wrangler.test.jsonc` |
| `prompts/` | The shared core every agent follows, the routine stub, the template for another repository's prompt, and breakaway's own prompt |
| `brand/` | The brand guide, tokens, logo, and the script that draws them |
| `install.mjs`, `breakaway.config.json` | An install's names and URLs, turned into its wrangler config |
| `interop.mjs` | Checks the Worker against real Taskwarrior |
| `plugin/`, `.claude-plugin/` | The Claude Code plugin and the marketplace that offers it |
| `scripts/tasks.mjs` | The CLI |

## What breakaway is, and isn't

These are settled. If a task would break one, ask the owner with a decision before you build it.

- **Free, and self-hosted.** Each person runs their own install on their own Cloudflare account. No hosted version, accounts, teams, tenants, pricing, paid features, or ads.
- **An install keeps its data.** No analytics, telemetry, or tracking, and no call to a service the install's owner didn't connect (GitHub, Claude, push, the infrastructure providers the owner connects for Architect, and npm's public registry, read only for the packages a repository's own workflows publish there). What Architect reads from a provider (the inventory and its signals) is redacted and stays in the install.
- **The person who runs the board decides.** Agents claim, build, and open pull requests; people merge, deploy, and start agents. Nothing in breakaway merges or deploys on an agent's word. Infrastructure follows the same rule ([decision log](docs/decisions.md#decision-log), 6 Oct 2026): the board holds no write credentials, only a read-only token per provider, and the one path that changes infrastructure is the executor, a workflow in the repository that the board starts for one plan the owner approved, with its write token in a GitHub environment. Every plan asks the owner, in every environment, unless it fits an **envelope**: bounds the owner approved once on an environment, for scaling and for restarts up to a cap, production included. Anything outside an envelope waits for the owner. The board's own install is observe only: Architect watches it and never applies to it.
- **One claim per task, and pull requests close tasks.** The [claims that must stay true](brand/README.md#claims-that-must-stay-true) describe what the board does; a change that breaks one changes the copy in the same pull request.
- **Taskwarrior stays a first-class way in.** The sync protocol must keep working with Taskwarrior 3.

## One board, several repositories

The install that tracks breakaway also tracks other repositories, and some of them are private.

- **The checkout decides.** The CLI works in the repository this checkout's `origin` names; `claim` refuses another repository's task. Never cross it with `--repo` to build there: that work belongs in that repository's checkout, under its own `AGENTS.md`.
- **Work that spans repositories** is a task in each with a `depends` between them. A pull request closes only this repository's tasks.
- **Nothing from another repository comes in here.** This repository is public: never copy another repository's tasks, comments, code, names, or people into a file, commit, pull request, spec, or test here. Fixtures use made-up repositories (`acme/widgets`) and made-up work IDs.
- **Board rules go in the core** (`prompts/core.md`); breakaway's rules go here and in `prompts/breakaway.md`. `repos init` copies the core and the stub into other repositories unchanged, so a change to either reaches every repository's agents: keep them about the board, never about breakaway's code.

## What agents never do

- **Never deploy an install** or change one: no `pnpm deploy`, `wrangler deploy`, `wrangler secret`, or Secrets Store changes, no routine, GitHub App, webhook, or DNS changes, and no `repos add`, `repos modify`, `repos remove`, `routines add`, or `agents-connect`. Those are the owner's, whichever tool would do them. The one exception is `routines add` (and `routines modify` on the routines your task made) when the board started you with `Mode: routines`: "Making routines" in [`prompts/core.md`](prompts/core.md) says how, and the board refuses it to every other agent. `wrangler dev` and the tests run locally and are fine.
- **Never apply infrastructure.** Read, diagnose, and propose a change by pull request; never hold a provider's write token, start the apply runner, or approve a plan or an envelope. Approve is the owner's, on the board, and the executor applies.
- **Never merge, and never push to `main`.** Changes reach `main` through pull requests the owner merges. Never force-push or rewrite `main`'s history.
- **Never cut a stable release, or move the site or the plugin.** The **Release** workflow's stable job and the **Site** and **Plugin** workflows are the owner's to run; agents don't dispatch them. Pre-releases publish by themselves when a pull request merges. If a change needs an install to do something by hand, set `manual` and `manualSteps` in `release.json` (see the README's releases section).
- **Never start agents.** Don't run `agents start`, `agents next`, or `routines run`, and never set `--autostart`.
- **Never commit a secret.** The repository is public, and a pushed secret is published. Tests generate throwaway keys (`vitest.config.js`) or use values that are plainly fake; real ones live in `.dev.vars` or the install's Secrets Store, never in a tracked file.
- **Never read an install's data** beyond what the CLI shows you about your own task, and never put a person's details, a token, or another repository's work in a task, comment, or pull request.

## Code conventions

- **JavaScript ES modules, no build step for the Worker.** Annotate new server code with JSDoc types. The Worker reads its names and secrets through `src/install.js` and the install's config, never a hard-coded name: an install picks its own Worker, Durable Object, URL, and secrets prefix.
- **Tests first for server logic** (`test/*.test.js`, Vitest in the Workers pool with `wrangler.test.jsonc`). Nothing reaches the network: GitHub, Claude, and Web Push are mocked. The web app has no DOM tests: check a change to it in the running app (`pnpm dev`), in both themes, narrow and wide.
- **The web app is Preact and `@preact/signals`** (no other UI framework). Use the design tokens, never hex values, and keep both themes working: carbon (dark) is the default, chalk (light) follows the system or the person's choice. Respect reduced motion.
- **The sync protocol is Taskwarrior's.** When you touch sync, the replica, or the store's task model, run `pnpm interop` (it needs Taskwarrior 3 on `PATH`).
- **Copied files go out with the release.** When a file `repos init` copies into other repositories changes (the CLI, the core, the stub, the `tasks` skill, the shared `taskrc`), there's nothing to bump: the release version moves when your pull request merges, and `src/board-files.json` (the Worker's copy of them, for an empty repository's first commit) is generated by `node scripts/board-files.mjs`, which installing the packages, `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm deploy` run first, and is never committed. `CLI_VERSION` in `src/cli-version.js` is frozen; leave it (BRK-148). The plugin's `tasks` skill, hooks, and licence are generated too, but committed, because the plugin is read from git: after changing the `tasks` skill or `sessionHooks()`, run `node scripts/plugin.mjs` and commit what it writes in `plugin/` (a test fails until you do).
- **Copy follows the brand guide**: lowercase "breakaway", sentence case, verbs on buttons, errors that say what failed and what to do, and none of the words it rules out.

## Before handing back

Run `pnpm lint` (`pnpm format` fixes the formatting), `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm interop` (when you touched sync), and for changes people see, look at them in both themes, narrow and wide. Open a pull request whose title is the task's work ID and a plain sentence (`BRK-12: Sort the inbox by age`), with no other prefix. Its description says what changed and why, what you checked, the brand checklist when people will see the change, and what the owner has to do after merging, and ends with `Closes <ID>.`
