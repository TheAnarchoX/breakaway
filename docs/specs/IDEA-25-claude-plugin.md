# IDEA-25 · breakaway as a Claude Code plugin

Task: IDEA-25 on the board · Status: built (as of 5 Oct 2026; what's left is the owner's: LCH-25, LCH-26, and LCH-27)

> Licence note (BRK-295): from 2.0.0, breakaway's licence is PolyForm Noncommercial 1.0.0; this spec keeps the licence it was written under (FSL-1.1-Apache-2.0), which releases before 2.0.0 stay under.

## Problem
A repository joins a board today through `npx breakaway repos init`, which opens a pull request that copies the board's files into it: the `tasks` and `pipeline` skills, the session hooks in `.claude/settings.json`, the core and the stub, the release helpers, and a record of what it copied (`tools/tasks/copied.json`). Every change to the skill or the hooks then needs `repos init --update` in every repository, and a local Claude Code session in a repository nobody ran `repos init` in knows nothing about the board.

The owner's idea: package the `tasks` skill, the session hooks, slash commands (claim, next, hand over), and the MCP server (IDEA-24) as one Claude Code plugin, so a repository joins a board by installing the plugin instead of copying files. The owner added two screenshots of Anthropic's plugin directory submission flow, asked that the plugin meets everything it asks, and that it can be published from this repository the way the site is: from a branch a workflow moves.

What the screenshots show, in words:
- **Source (step 1 of 5):** a GitHub repository (`owner/repo`), an optional plugin path ("the folder that holds `.claude-plugin/plugin.json`, if the plugin isn't at the repository root"), and an optional branch or tag ("what the directory follows for new versions; leave empty to follow the default branch; a tag stays on its commit until you change it"). The directory validates the manifest and runs its checks before you continue.
- **Data handling (step 3 of 5):** does the plugin read or store personal data (no, reads only, reads and stores); does any skill send data to a service other than the declared connectors (no, yes and listed in the README); how long the service keeps data received from Claude (not kept, under 30 days, longer); and is it meant for people under 18. The other steps are listing details, compliance, and review and submit.

## Fit
- **Free, and self-hosted.** The plugin is a folder of text files in this repository, under the same licence. It has no server of its own: every request it makes goes to the board the person set it up with, on their own Cloudflare account. Listing it in Anthropic's directory is a way to find it, not a hosted version.
- **An install keeps its data.** The plugin adds no call to anything new. Its hooks and commands run the CLI through `npx` as `.claude/settings.json` does today (npm's public registry, read only), and its MCP server is the person's own board. Nothing goes to breakaway's author or to Anthropic beyond what Claude Code already does.
- **The person who runs the board decides.** The commands do what an agent may already do with the CLI: claim, release, comment, and hand over. None merges, deploys, or starts an agent, and the MCP server's own limits (IDEA-24, section 3) stand behind them.
- **One claim per task, and pull requests close tasks.** `/breakaway:claim` is the CLI's atomic claim, never `--force`; `/breakaway:hand-over` opens a pull request that says `Closes <ID>.` and never marks a task done.
- **Taskwarrior stays first-class.** Untouched. Taskwarrior is set up per machine (`npx breakaway setup`) and per checkout (`.taskrc`, `scripts/task`), which a plugin can't do, so `repos init` keeps that part.
- **One board, several repositories.** The plugin is installed once per person or per repository, and works in whichever checkout it runs: the repository is the checkout's `origin`, as for the CLI.
- **Copied files** (`AGENTS.md`'s "Code conventions"): the plugin's skill is the `tasks` skill, kept identical by a test, so it still goes out with the release and nothing is bumped by hand.

## Design

### 1. The plugin, in `plugin/`
One plugin, named `breakaway`, in a `plugin/` folder at this repository's root (the directory's "plugin path"):

```
plugin/
  .claude-plugin/plugin.json   name, displayName, version, description, author, homepage, repository, license, keywords, userConfig
  skills/tasks/SKILL.md        the tasks skill, generated from .agents/skills/tasks/SKILL.md
  skills/claim/SKILL.md        /breakaway:claim <ID>
  skills/next/SKILL.md         /breakaway:next
  skills/hand-over/SKILL.md    /breakaway:hand-over
  hooks/hooks.json             the session hooks
  .mcp.json                    the board's MCP server (section 4)
  README.md                    what it does, what it runs, where it sends what (section 6)
  LICENSE                      FSL-1.1-Apache-2.0, as at the root
```

- **The skill.** `skills/tasks/SKILL.md` is the `tasks` skill as `repos init` renders it for another repository (`skillFor` in `src/init.js`: links to the board's docs point at GitHub, and the wording names "this repository" instead of breakaway). It's generated by `node scripts/plugin.mjs` and committed, because the directory reads the folder from git; a test fails when it's behind, the way `init.test.js` already guards `src/board-files.json`. The `pipeline` skill stays with `repos init --pipeline`: it's for repositories that move to the deploy flow, not for every one.
- **Commands are skills.** Claude Code prefers `skills/` over `commands/` for new plugins, and a plugin's skills are its slash commands, named `/breakaway:<skill>`. Each command runs the CLI (`npx --yes breakaway@1 …`), so it works with or without the MCP server:
  - `/breakaway:claim <ID>`: name the session (`BREAKAWAY_AGENT`, else `claude-<branch>`), claim, `show` the task, and say what it waits for; refuse an `IDEA-` with the core's "shape it, don't build it".
  - `/breakaway:next`: `next --claim` in the checkout's repository, then the same as claim. Never `--force`.
  - `/breakaway:hand-over`: run the repository's checks (from its `AGENTS.md`), post the peloton step, open the pull request with the work ID in its title and `Closes <ID>.` in its description, `modify <ID> --pr`, and a one-line comment. It never marks a task done and never merges.
- **The hooks.** `hooks/hooks.json` is what `sessionHooks()` in `src/init.js` writes into `.claude/settings.json` today (`npx --yes breakaway@1 hook session` on four events, and `hook wait` with `asyncRewake` on Stop), rendered from the same function so the two never drift. They post a cloud agent's output to its task and wake it for the owner's messages; with no claimed task, or no board configured, they exit quietly, as they do now.
- **The version** in `plugin.json` is the CLI's release version, written by the release, so the directory sees a new version exactly when a release moves the branch it follows (section 5).

### 2. Which board: the plugin's settings
A plugin is installed once and works in every checkout, so it has to be told which board. `plugin.json` declares three `userConfig` options, asked when it's enabled:

| Option | Type | What |
| --- | --- | --- |
| `board_url` | string, required | The board's address, like `https://board.example.com` |
| `token` | string, sensitive | The board's token. Claude Code keeps it in the system keychain (section 2 says where a session sees it) |
| `agent_name` | string, optional | The name to claim with; empty means `claude-<branch>` |

The hooks and commands see them as `CLAUDE_PLUGIN_OPTION_BOARD_URL`, `CLAUDE_PLUGIN_OPTION_TOKEN`, and `CLAUDE_PLUGIN_OPTION_AGENT_NAME`. The CLI reads them **after** its own settings: the environment (`BREAKAWAY_URL`, `BREAKAWAY_TOKEN`, `BREAKAWAY_AGENT`), then `tasks.env`, then the checkout's `.taskrc`, and only then the plugin's options. So a machine already set up with `npx breakaway setup` keeps working unchanged, and a cloud session, which can't answer a prompt, uses the environment's credentials as it does today. `npx breakaway health` says which source it used, never the value. Claude Code exports the options only to the plugin's hooks, not to the commands its skills run, so the plugin's `SessionStart` hook appends them, under the same names, to `CLAUDE_ENV_FILE`, which Claude Code applies to the session's later Bash commands (CLI-8). For the session, the token is then in that file, as it is in `tasks.env` for a machine set up with `npx breakaway setup`.

### 3. Two ways to install it
- **For one person:** `/plugin marketplace add TheAnarchoX/breakaway`, then `/plugin install breakaway@breakaway`; or from Anthropic's directory once it's listed (section 6). This repository's root carries `.claude-plugin/marketplace.json`, naming one plugin whose source is this repository's `plugin/` folder on the `plugin` branch (a `git-subdir` source with `ref: plugin`), so people get released versions, never `main`'s.
- **For a repository and every agent in it, by default:** `repos init <slug>` writes `.claude/settings.json` with `extraKnownMarketplaces` (breakaway's marketplace) and `enabledPlugins` (`breakaway@breakaway`) instead of the session hooks, and copies no `tasks` skill. The board's first commit to an empty repository does the same (`src/init.js` serves both). Cloud sessions read the repository's settings, so the board's agents get the plugin too. `repos init --update` moves a repository from copies to the plugin in one pull request: it removes the copied `tasks` skill and the hooks it wrote (only those `tools/tasks/copied.json` lists, as `--update` already does) and adds the two keys.
- **Copies, for a repository that asks:** `repos init --copies` (and `--update --copies`) keeps today's copied skill and hooks, for a repository whose agents aren't Claude Code and read `.agents/skills/` instead.

What `repos init` still copies, plugin or not: the core and the stub (`tools/tasks/prompts/`), the repository's agent prompt and `AGENTS.md`, the shared `taskrc`, `.envrc`, `scripts/task`, and the release helpers. The board's agents read the core from the checkout, because it's reviewed like code there; the routine on claude.ai holds only the stub, which points at it. Moving the core into the plugin is out of scope (below).

The plugin is the default as soon as it ships (decided on BRK-158): few repositories depend on the copies yet, so there's no release of opt-in first.

### 4. The MCP server
`.mcp.json` names one HTTP server, `breakaway`, at `${user_config.board_url}/mcp` (IDEA-24, section 1). Its headers depend on the checkout (the repository) and the session (the agent's name), which a static file can't know, so it uses Claude Code's `headersHelper`: `npx --yes breakaway@1 mcp --headers` prints the three headers IDEA-24 names (`Authorization`, `X-Breakaway-Agent`, `X-Breakaway-Repo`) as JSON, from the same settings as the CLI (section 2) and the checkout's `origin`. It writes nothing and prints the token only to Claude Code on standard output, never to a log. With no board configured, or outside a repository the board tracks, it prints only `Authorization`, and the server's repository tools refuse and say why, as IDEA-24's edge states describe.

The MCP server ships in a plugin release only once `/mcp` is on the installs (BRK-154). Until then the plugin has no `.mcp.json`, and the commands run the CLI.

What Claude Code allows shaped how it's built (CLI-9). A plugin's `headersHelper` runs in the plugin's folder, through a shell, without the plugin's options and without environment variables named like a credential (so no `BREAKAWAY_TOKEN`), and it can't reference `${user_config.*}`. So:

- The token reaches `/mcp` as a static header, `Authorization: Bearer ${user_config.token}`, which Claude Code fills in from the keychain. The helper's own `Authorization`, from the CLI's settings that it can read (`tasks.env`), overrides it, so a machine set up with `npx breakaway setup` comes first, as for the CLI.
- The helper is `npx --yes breakaway@1 mcp --headers`, and `mcp --headers` works in the session's checkout, so the checkout's `origin` and branch are the session's: `CLAUDE_PROJECT_DIR` when the environment has it, else, run in the plugin's folder, the folder of the nearest process above it that works elsewhere (Claude Code's). It was `cd "${CLAUDE_PROJECT_DIR}" && …` until CLI-20: the plugin directory refuses a helper whose shell computes a path.
- When the helper can ask the board (`GET /api/repos`, with a token), it sends the board's slug, or only `Authorization` outside a tracked repository. When it can't (only the plugin's token is set up), it sends the checkout's GitHub `owner/name`, and `/mcp` matches that against its repositories itself; one it doesn't track still connects, and the repository's tools say it isn't on the board.
- The agent's name is the CLI's when it has one (`BREAKAWAY_AGENT` or `tasks.env`'s), else the plugin's `agent_name`, else `claude-<branch>`, the same order as the session's CLI (CLI-16). `agent_name` can't reach the helper, so it goes as a static header, `X-Breakaway-Agent: ${user_config.agent_name}`, with a default of `""` so an unset option is empty rather than left unfilled. The helper sends `X-Breakaway-Agent` only for a name of the CLI's own, which overrides it; otherwise it sends `claude-<branch>` as `X-Breakaway-Agent-Default`, which `/mcp` uses when `X-Breakaway-Agent` is empty.
- Without a board address of its own (only the plugin set up), the helper still runs: it asks the board Claude Code names in `CLAUDE_CODE_MCP_SERVER_URL`.

### 5. Publishing from a branch, like the site
The directory follows a branch or a tag. Following `main` would publish every merged pull request, including pre-release changes, to everyone who installed the plugin. So it follows a `plugin` branch, moved the way the **Site** workflow moves `site` (`.github/workflows/site.yml`):

- A **Plugin** workflow, with `workflow_dispatch` (input: a tag or commit on `main`) and `workflow_call` (the stable job of **Release** calls it with the released tag, as it calls **Site**). It checks the ref is on `main`, runs `claude plugin validate --strict plugin`, and moves `plugin` to it with a deploy key in a `plugin` environment that only `main` can use, under a ruleset that lets only that key move the branch.
- It's the owner's to run, like **Site**: agents never dispatch it (`AGENTS.md`, "What agents never do", gains the **Plugin** workflow beside **Site**).
- **CI** runs `claude plugin validate --strict plugin` on every pull request that touches `plugin/`, so the directory's own checks never fail first at release.

Moving `plugin` gives the directory the new version (Source: `TheAnarchoX/breakaway`, plugin path `plugin`, branch `plugin`), and the repository's own marketplace (section 3) the same.

The owner set it up on 5 Oct 2026 (LCH-26), the same way as `site`: a write deploy key, its private half as `PLUGIN_DEPLOY_KEY` in the `plugin` environment, and the ruleset **Plugin branch: deploy keys only**, which lets only a deploy key create, move, delete, or force-push `plugin`. The first stable with the plugin is 1.5.0: v1.4.0 and earlier have no `plugin/`, and the workflow refuses them, so the branch first exists when 1.5.0's stable job runs it (LCH-27). Until then the marketplace's `ref: plugin` has nothing to install, and `repos init` copies the skill and hooks (section 7).

### 6. What the directory asks, and our answers
The plugin's `README.md` (over 40 words, in `plugin/`, as the directory requires) says what the plugin does, how to set it up, and everything it runs, sends, or fetches:

- It runs `npx --yes breakaway@1`, which downloads the CLI from npm's public registry. The CLI has no dependencies, and since CLI-21 each release ships it with `npm-shrinkwrap.json`, so the plugin directory sees that what npx installs is the package it reviewed.
- It sends to **the board you set it up with, and nowhere else**: the task you claim, your comments, the session's output while you hold a task (the hooks), and the MCP server's calls. That board runs on your own Cloudflare account.
- It stores nothing of its own: the settings are Claude Code's (the token in the keychain), and the board keeps what you send it.

The answers the owner gives in the submission form, from that:

| Question | Answer | Why |
| --- | --- | --- |
| Reads or stores personal data? | No | The board holds tasks and agent names, no personal data (`AGENTS.md`). |
| Sends data to a service other than the declared connectors? | Yes, listed in the README | The hooks post to the person's own board through the CLI, outside the declared MCP server. |
| How long does your service keep data from Claude? | Not kept | breakaway runs no service: the data goes to the person's own board, which they control. |
| Meant for people under 18? | No | |

Listing details (name `breakaway`, the description from the brand guide, the icon from `brand/`) and the compliance step are the owner's, at submission; the docs task drafts the listing copy for them.

### 7. Edge states
- **Installed, not set up** (no board URL anywhere): the hooks do nothing, `/breakaway:claim` says to set the board's address in the plugin's settings or run `npx breakaway setup`, and the MCP server isn't connected.
- **A checkout the board doesn't track:** the commands say so with the CLI's own message and point at `repos add` on the board; nothing is claimed.
- **Both the plugin and old copies** (a repository set up before the plugin, or with `--copies`, used by someone who installed the plugin): the hooks would run twice. The plugin's hooks run with `CLAUDE_PLUGIN_ROOT` set, so `hook session` and `hook wait` there do nothing when the checkout's `.claude/settings.json` already runs them, and output is never posted twice; `repos init --update` removes the copies.
- **The plugin isn't published yet** (no `plugin` branch, before the first stable release that moves it): `repos init` checks the branch exists, and until it does, copies the skill and hooks as today and says why, so a pre-release never points a repository at a plugin nobody can install.
- **A cloud session:** no prompt for settings, so the environment's `BREAKAWAY_URL` and `BREAKAWAY_TOKEN` are what it uses, as now.
- **A new major of the CLI:** the plugin pins `breakaway@1`, as `repos init` does, and moves with the release that changes the pin.

## Privacy
- The plugin stores nothing itself; the token lives in Claude Code's keychain, and the URL and agent name in its settings. While a session runs, they're also in Claude Code's file for that session's environment (section 2), so the CLI in its Bash commands can read them.
- Nothing new leaves the machine: everything goes to the person's own board, plus the npm download the hooks already do.
- An agent sees what the CLI shows it today, for the checkout's repository.

## Out of scope
- **Moving the core and the stub into the plugin.** The board's agents read the core from the checkout, where it's reviewed like code, and the routine's stub points there. Reading it from the plugin can follow as its own idea, now that the plugin is the default.
- **Taskwarrior and the release helpers in the plugin.** They're per checkout and per machine, so `repos init` keeps them.
- **The `pipeline` skill in the plugin.** It stays with `repos init --pipeline`.
- **Owner commands** (merge, start agents, decisions, routines): the plugin is for agents, like the MCP server.
- **Anthropic's directory itself:** submitting is the owner's (a `+owner` task); this spec only makes sure the plugin passes it.

## Decided
The owner answered BRK-158 on 5 Oct 2026:

1. **The directory:** list breakaway in Anthropic's plugin directory, following the `plugin` branch, as recommended (sections 5 and 6; the owner submits it, LCH-25).
2. **`repos init`'s default:** the plugin, as soon as it ships, not the recommended release of opt-in first: few repositories rely on the copies yet. `repos init` sets a repository up with the plugin, `--update` moves existing ones over, and `--copies` keeps the old way for a repository that asks (section 3).
3. **The plugin's settings:** asked when the plugin is enabled, as recommended (section 2).

## Done when
- `plugin/` passes `claude plugin validate --strict`, and installing it from this repository's marketplace gives a local Claude Code session the `tasks` skill, `/breakaway:claim`, `/breakaway:next`, `/breakaway:hand-over`, and the session hooks.
- The plugin's skill and hooks can't drift from the `tasks` skill and `sessionHooks()`: a test fails when they do.
- `repos init` sets up a repository with the plugin instead of copies, `--update` moves one over, and `--copies` keeps the copies.
- The **Plugin** workflow moves the `plugin` branch at a stable release, and CI validates the plugin on every pull request that touches it.
- With BRK-154 built, the plugin connects the board's MCP server with no config beyond its settings.
- The plugin's README answers what the directory asks.

The tasks, all in the `ai-native` feature, all waiting for IDEA-25: listed in the pull request that adds this spec.

## How to check it
1. Once the tasks are merged and 1.5.0, the first stable with the plugin, is out, open Claude Code in a checkout of one of your repositories and type `/plugin marketplace add TheAnarchoX/breakaway`, then `/plugin install breakaway@breakaway`.
2. When it asks, give it your board's address and token. You should see the plugin enabled, and `/breakaway:` should list `claim`, `next`, and `hand-over`.
3. Type `/breakaway:next`. Claude should claim the best ready task in that repository and tell you what it is; on the web board, the task shows as claimed.
4. Ask it to finish the task and type `/breakaway:hand-over`. A pull request should open with the work ID in its title and `Closes <ID>.` in its description, and the task should move to In review on the board.
5. Type `/mcp`. Once the MCP server is on your board, you should see `breakaway` connected.
6. Run `npx breakaway repos init <slug> --update` for one of your repositories and merge its pull request. Its `.claude/settings.json` should name the breakaway plugin, and the copied `tasks` skill should be gone. Start an agent from the board on one of its tasks. Its output should show on the task while it works, as it does today.
7. After 1.5.0 is published, run `git fetch origin plugin` and `git log --oneline -2 origin/plugin` in a checkout of breakaway. You should see "The breakaway plugin, version 1.5.0" on top of v1.5.0's commit. Then run `git push --force origin origin/main:refs/heads/plugin`. GitHub should refuse it, because only the deploy key moves `plugin`; if it goes through, run the **Plugin** workflow with v1.5.0 to put the branch back.
