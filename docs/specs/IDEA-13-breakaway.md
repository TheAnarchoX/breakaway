# IDEA-13 · breakaway: the task board as a project of its own

Task: IDEA-13 on the board · Status: draft

## Problem

The task board (`tools/tasks/`, the CLI in `scripts/tasks.mjs`, the routine prompt) changed how the owner works: no editor, Claude Code to brainstorm and fix, claude.ai to update the routine, 160 pull requests in under 48 hours, alone. Other people should be able to work like that. It has to leave samewave's repository without breaking the board the owner uses every day.

The owner's decisions (30 Sep 2026) are in the idea and are not reopened here: the name **breakaway**; free, with the source public under **FSL-1.1-Apache-2.0** (fair source: each release turns Apache 2.0 two years after it ships); its own public repository with **fresh history**; **samewave runs breakaway and breakaway runs breakaway** (one install, samewave's, tracks both repositories); the landing page at **breakaway.samewave.dev**; samewave's repository is never made public.

## Fit

- The landing page sits on samewave's domain, and samewave is non-commercial, so the page carries no pricing, paid-plan sign-ups, or ads. A paid hosted version isn't planned and isn't in this spec; `AGENTS.md` now rules it out.
- Nothing in the [decision log](../decisions.md) is touched. Agents still never deploy, promote, touch production, or turn on Merge when green; this spec's tasks never get `--autostart`.
- No samewave history, data, or secrets enter the public repository, and the board's own data stays on the install. There is no secret scanning on the private repository, so the export is scanned before anything is public.

## Gate: multi-repo comes first

[IDEA-14](IDEA-14-multi-repo.md) is merged and its decisions are answered on `CLD-119`: one board for all repositories, a shared agent pool with optional per-repository caps, `IDEA` and `RUN` install-wide with every other area per repository, a short stub in the claude.ai routine with the real prompt in each repository (and copyable from the board), and broken connections as an inbox note without a push. This spec builds on that and doesn't redesign it.

Every task made from this idea waits for **`CLD-130`**, the owner's rehearsal with a scratch repository, which waits for the whole multi-repo build. Only the first tasks name it; the later ones inherit it through their own dependencies (the board refuses redundant relations). Two things breakaway needs that IDEA-14 didn't cover became tasks under that chain, which `CLD-130` now waits for:

- `CLD-131`: a fresh install has no samewave. IDEA-14 reads "no `repo`" as samewave and seeds samewave from `TASKS_GITHUB_REPO`; a self-hosted board needs the first registered repository as its default and a first-run path.
- `CLD-132`: copy a repository's routine stub and prompt from the Agents view (the owner's answer on `CLD-119`: opening GitHub for it is awful).

## Design

### 1. Order of the move, so samewave's board never stops

1. **Make the board configurable and self-contained, in place**, in samewave's repository. Every step is additive, `pnpm test`, `pnpm tasks:interop` and the build pass, and samewave's board behaves as today. Nothing is deployed until the owner does it as usual.
2. **Export** a clean tree with a script, scan it, and keep it private. The owner creates the empty private `breakaway` repository, installs the GitHub App, seeds it, registers it on the existing board (`repos add`, with its own areas), and connects its routine. **From here breakaway's development is tracked on the board**, while the code still deploys from samewave's repository.
3. **Cutover**: samewave's deploy of the board takes breakaway's code instead (how is the owner's decision below). The owner takes a `task export` first, deploys, and checks Connections. The board's data never moves: the same Worker, Durable Object, Secrets Store and Taskwarrior replica carry on; only where the code comes from changes. Rolling back is redeploying the previous build.
4. **Go public** only after a scan of the full tree and history, the licence and contribution docs, and the owner's review. The landing page goes up after that.

Between steps 1 and 3 the code exists in two places, and breakaway is the one that gets new work; the copy under `tools/tasks/` is frozen once step 2 completes (a note at its top, and CI in samewave stays green). Removing it from samewave is the last task, after a soak.

### 2. Decoupling (what is samewave's today, and what it becomes)

| Today | Becomes |
| --- | --- |
| `SAMEWAVE_TASKS_*` secret names, `SAMEWAVE_TASKS_URL`, `SAMEWAVE_AGENT` | One configurable prefix per install (default `BREAKAWAY_`), with the old `SAMEWAVE_` names read as fallbacks so samewave's install and existing agents keep working. A single `breakaway.config.json` holds names (Worker, Durable Object, D1/Secrets Store binding names), URLs, and the default repository. |
| samewave's repository, areas, and prefixes in `PROJECTS` | The repository registry from IDEA-14 (`CLD-122`, `CLD-131`); nothing hard-coded. |
| Imports of `src/app/styles/tokens.css`, `base.css`, and fonts | The board's own tokens, styles, and fonts inside its folder, in breakaway's identity. |
| `scripts/lib/promote.js`, `.github/deploy-paths.json`, `routine-prompt.md` imported from outside `tools/tasks/` | Inside the package; the pipeline stays an optional per-repository `pipeline` (IDEA-14), so a repository without one has no Releases, Promote, Roll back, or Merge when green warning. |
| The CLI at `scripts/tasks.mjs`, Taskwarrior config | The CLI ships with the package, takes its install from the config or environment, and `taskrc` points at any install. |
| The prompt in samewave's repository | breakaway's own prompt, same shape as samewave's (below). |

The check that it worked: the package builds and its tests pass with samewave's files absent, and `grep` finds no `samewave` outside the compatibility fallbacks and the docs that describe samewave as an example.

### 3. Self-hosting, plug and play

- A **Deploy to Cloudflare button** in the README that provisions the Worker, the Durable Object, and the binding names from the config template; secrets are set from a documented `.dev.vars.example`, and the Secrets Store is used when available.
- A **first-run path** (`CLD-131`) that walks a new install through: sign in as the owner, register a repository, install the per-install GitHub App (the manifest flow already exists), connect a Claude routine, connect the CLI and Taskwarrior. **The Connections view (`CLD-120`, `CLD-121`, `CLD-129`) is how a new install checks each step**; the self-hosting guide names the Connections states to look for after each step rather than describing checks twice.
- The guide covers the parts the Worker can't verify (routine environment allowlist, the prompt on claude.ai) as the list Connections already shows.

### 4. breakaway's own AGENTS.md and agent prompt

Same shape as samewave's after `CLD-127`: a short `AGENTS.md` (project context, "One board, several repositories", code conventions, what agents never do), the `tasks` skill, and an agent prompt made of the shared core of board rules plus a project file with breakaway's rules, with the routine's claude.ai stub pointing at it. breakaway's `AGENTS.md` carries the same rules samewave's does about production and the owner (agents never deploy or touch the install's secrets) and its own voice and design rules from the identity. Skills that are samewave-specific (brand-guide for samewave, privacy-by-design, product-design, social-media) are not copied; breakaway gets its own `brand-guide` from the identity.

Where they are (`CLD-137`): the prompt is `tools/tasks/prompts/breakaway.md`, beside the core. `AGENTS.md` and the skills wait in `tools/tasks/root/`, where no agent working in samewave takes them for its own, and the export (`CLD-138`) puts them at the root of breakaway's tree: `root/AGENTS.md` as `AGENTS.md`, `root/skills/<name>/` as `.agents/skills/<name>/` with `.claude/skills` linking to it. They're written for a tree whose root is the package (`tools/tasks/`), with the CLI at `scripts/tasks.mjs` (`CLD-136`); `tools/tasks/test/agent-files.test.js` checks their links in that layout, that the prompt has every section the core refers to, and that none of them mention samewave. breakaway is registered with `--prompt prompts/breakaway.md` (`OPS-27`).

### 5. Identity

A loud, fast voice and a logo with forward motion: the opposite of samewave's calm one, with its own short voice rules, word list, palette (dark and light), type, and logo, in the new repository's `brand/` and a design-system-style tokens file the board uses. Not samewave's brand guide and not the mint check, which BRD-26 made for the board's app icon and is only a starting point. An agent drafts two or three directions; the owner picks one in the pull request. Imagery and copy never claim more than is true: the 48-hour story uses the owner's real numbers (160 pull requests, under 48 hours, one person) and says it is the owner's own experience.

### 6. Landing page

A static page on a Worker at `breakaway.samewave.dev`: the pitch, the 48-hour story, the repository link, how to self-host. No pricing, sign-ups, or ads, no analytics beyond what samewave itself uses (none), and it says samewave hosts the page and is non-commercial. Adding the custom domain is the owner's (the pipeline stops on custom domains).

### 7. Launch

README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE (FSL-1.1-Apache-2.0, with its change date) and a launch post and thread as drafts in the repository's `launch/` folder; the owner posts.

## Decisions for the owner

One decision task, on the board:

1. How samewave's deploy takes breakaway's code after the cutover: **a pinned git ref checked out by samewave's deploy workflow** (recommended: same flow as today, a version bump is a pull request), a git submodule, or a published package.
2. The areas and work-ID prefixes for breakaway's own tasks (recommended set offered, free text allowed).
3. Which of the 48-hour story's facts may be public (the numbers in the idea; the repository's name).

## Out of scope

- A hosted or paid breakaway, accounts, teams, or tenants; a domain of its own.
- Rebuilding multi-repo or Connections here (IDEA-14).
- Making samewave's repository public, or moving any samewave data or history.
- Posting anything: launch material is drafts.
- Contribution workflows beyond the guide (a roadmap, governance, a Discord).

## Done when

- A stranger can deploy their own board from the button, follow the guide, check each step in Connections, and run an agent on their own repository.
- samewave's install runs breakaway's code and tracks samewave's and breakaway's repositories; no task, comment, image, history, claim, link, routine, or Taskwarrior sync was lost.
- The public repository has fresh history, passed a secrets scan, carries the licence and docs, and its landing page is live without pricing or ads.

Follow-up tasks (all horizon `next`, none autostart). The roots (`CLD-133`, `BRD-27`, `CLD-134`) wait for `CLD-130`; the rest wait for their predecessors.

| Task | What | Waits for |
| --- | --- | --- |
| `CLD-133` | Configurable install: names, secrets prefix, config file | `CLD-130` |
| `BRD-27` | Identity: voice, palette, type, logo options | `CLD-130` |
| `CLD-134` | Decide: how samewave takes the code, areas, public facts (owner) | `CLD-130` |
| `CLD-135` | Self-contained package | `CLD-133` |
| `CLD-136` | CLI and Taskwarrior against any install | `CLD-133` |
| `BRD-28` | Identity applied to the board's web app | `BRD-27`, `CLD-135` |
| `CLD-137` | breakaway's AGENTS.md, skills, and prompt | `BRD-27`, `CLD-135` |
| `CLD-138` | Export script, fresh history, secrets scan | `CLD-135`, `CLD-137`, `CLD-134` |
| `OPS-27` | Create the repository, seed it, register it (owner) | `CLD-138` |
| `CLD-139` | Deploy button, config template, first-run | `CLD-135`, `CLD-136` |
| `CLD-140` | Self-hosting guide using Connections | `CLD-139` |
| `BRD-29` | README, CONTRIBUTING, licence, launch drafts | `CLD-140`, `BRD-28` |
| `BRD-30` | Landing page | `BRD-27`, `CLD-140` |
| `CLD-141` | samewave's deploy takes breakaway's code | `CLD-134`, `OPS-27` |
| `OPS-28` | Scan and make the repository public (owner) | `BRD-29`, `OPS-27` |
| `OPS-29` | Cut samewave's install over (owner) | `CLD-141` |
| `OPS-30` | Landing page live on its domain (owner) | `BRD-30`, `OPS-28` |
| `CLD-142` | Remove the board's copy from samewave | `OPS-29` |
