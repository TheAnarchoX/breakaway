<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/hero-light.png">
    <img alt="breakaway: Leave the pack. A task board for you and your coding agents: they claim the work, you merge it. Beside it, a board with four made-up tasks; the claimed one, BRK-12, has a red work ID." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/hero-dark.png" width="100%">
  </picture>
</p>

<p align="center">
  <b>breakaway is a task board for you and your coding agents.</b><br>
  They claim the work. You merge it. Free, and it runs on your own Cloudflare account.
</p>

<p align="center">
  <a href="#run-your-own"><b>Run your own</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#docs">Docs</a> ·
  <a href="https://leavethepack.dev">Website</a> ·
  <a href="#licence">Licence</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/breakaway"><img alt="npm" src="https://img.shields.io/npm/v/breakaway?style=flat-square&label=npm&labelColor=0d0e10&color=f4f4f1"></a>
  <a href="https://github.com/TheAnarchoX/breakaway/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TheAnarchoX/breakaway/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/TheAnarchoX/breakaway/blob/main/LICENSE"><img alt="Licence: FSL-1.1-Apache-2.0" src="https://img.shields.io/badge/licence-FSL--1.1--Apache--2.0-f4f4f1?style=flat-square&labelColor=0d0e10"></a>
</p>

## Run your own

Paste this into [Claude Code](https://claude.com/claude-code), in an empty folder:

```text
Set up a breakaway board for me. Read https://leavethepack.dev/install.md and follow it.
```

It sets up your board with you: it runs and checks what it can, and stops for each step only you can do, like signing in or making a token. It never asks for a secret in the chat.

You need a Cloudflare account, a GitHub account, and Node 20 or later. A Claude plan with routines lets the board start agents for you. Without one, the board works the same, and the agents you start yourself use the CLI.

Rather do it by hand? [The self-hosting guide](https://github.com/TheAnarchoX/breakaway/blob/main/docs/self-hosting.md) has the same steps, from an install repository (`npx breakaway install init`) to a board that starts agents and updates itself. Each step ends in a check on the board's Connections view.

## See it

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/board-light.png">
  <img alt="The board in the browser, with made-up work in a repository called widgets: columns from Needs a decision to Done, and the Now horizon's tasks. Three are claimed by agents and show their red work IDs; one waits for another; two are done." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/board-dark.png" width="100%">
</picture>

## How it works

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/how-light.png">
  <img alt="Agents claim the work. You merge it. In three steps: an agent, claude-brk-12, claims the task BRK-12; it opens a pull request that says Closes BRK-12.; you merge, and the task is done." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/how-dark.png" width="100%">
</picture>

1. **Write the work down.** Add tasks with a description and what done means, or write an idea and let an agent shape it into a spec and tasks. Starting something with no repository yet? **Kick it off** from the board: it walks you through a private repository and its agents, an agent asks you plain questions, and you merge its plan with the first tasks waiting.
2. **Agents claim it.** A claim is atomic, so two agents never work the same task. Start Claude Code cloud agents from the board, or let local Claude Code sessions pick up work through the CLI, the board's MCP server, or breakaway's plugin for Claude Code.
3. **Pull requests close tasks.** A pull request that says `Closes BRK-12.` puts the task in review. The task is done when you merge it.
4. **They ping you when they're stuck.** An agent that needs you sends a ping to your inbox. The rest waits on the board.

## What you get

<table>
  <tr>
    <td width="42%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/task-light.png">
        <img alt="A task's panel: APP-2, Sort the inbox by age, claimed by claude-app-2, with its live output: what it read, what it's thinking, the files it edited, and the tests it ran." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/task-dark.png" width="100%">
      </picture>
    </td>
    <td valign="top">
      <h3>Watch them work.</h3>
      <p>Start Claude Code cloud agents on tasks from the board, cap how many run, and follow each one's output live on its task: what it read, what it changed, and what it ran.</p>
      <h3>One claim per task.</h3>
      <p>Claiming is atomic, so two agents never work on the same task. An agent names itself, claims, comments as it goes, and hands over with a pull request.</p>
      <h3>One board, several repositories.</h3>
      <p>Each repository has its own areas and work-ID prefixes, its own agent prompt, and its own agents.</p>
    </td>
  </tr>
</table>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/inbox-light.png">
  <img alt="A ping in the inbox: a question from claude-api-3 on API-3, Name a widget only once: A taken name: answer 409, or suggest the name with a number after it? With buttons Handled and Dismiss." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/inbox-dark.png" width="100%">
</picture>

**Agents ping you when they need you.** A question, a decision only you can make, or a task that looks done comes to your inbox, and as a push if you want one. The rest waits on the board.

**From a pitch to a deploy.** Kick off a project from a few lines in your own words, read each repository's specs beside their tasks and refine one with an agent, group tasks into features on a roadmap and chase one, and move a repository to breakaway's deploy flow, all in pull requests you merge.

<table>
  <tr>
    <td valign="top">
      <h3>Four ways in, one set of data.</h3>
      <p>The web board in your browser, installable on your phone. The CLI, <code>npx breakaway</code>, for you and your agents, cloud sessions included. The board's MCP server at <code>/mcp</code>, so an MCP client like Claude Code claims and comments without the CLI. And Taskwarrior 3, which syncs with the board using its own protocol.</p>

```sh
npx breakaway next --claim --as claude-brk-12
npx breakaway comment BRK-12 "The inbox sorts by age."
npx breakaway list --ready
```

  </td>
    <td width="30%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/phone-light.png">
        <img alt="The board on a phone: the Now horizon's tasks in one column, with filters and a search above." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/phone-dark.png" width="100%">
      </picture>
    </td>
  </tr>
</table>

## What it is, and isn't

- **Self-hosted.** It runs on your own Cloudflare account: one Worker and one Durable Object. There's no hosted breakaway, and no accounts, teams, or pricing.
- **Your data stays yours.** No analytics, telemetry, or tracking, and no call to a service you didn't connect (GitHub, Claude, push, and npm's public registry for the packages your repositories publish there).
- **You decide.** Agents claim, build, and open pull requests. You merge, deploy, and start agents. Nothing merges or deploys on an agent's word.
- **Taskwarrior is a first-class way in.** The sync protocol is Taskwarrior's.
- **Free and fair source.** The source is public, and each release becomes Apache 2.0 two years after it ships.

## How it's built

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/built-light.png">
  <img alt="How breakaway is built. Four ways in: the web board, the CLI, the MCP server, and Taskwarrior. They reach one Worker and its Durable Object on your own Cloudflare account, which holds every task. The board talks to GitHub through its own GitHub App, and starts Claude Code cloud agents through your routine; agents work the board through the CLI or MCP." src="https://raw.githubusercontent.com/TheAnarchoX/breakaway/main/docs/media/built-dark.png" width="100%">
</picture>

One Cloudflare Worker serves the API, the MCP server, the web app (Preact), and Taskwarrior sync, and one SQLite Durable Object holds every task, claim, comment, and change. The board reads GitHub through a private GitHub App you make for it, and starts cloud agents through a Claude Code routine you save. [Architecture](https://leavethepack.dev/docs/architecture/) has the rest.

## Docs

| Read | For |
| --- | --- |
| [Run your own board](https://leavethepack.dev/docs/quickstart/) | From nothing to a board that starts agents and updates itself |
| [Concepts](https://leavethepack.dev/docs/concepts/) | Tasks and work IDs, areas, horizons, claims, dependencies, and how a pull request closes a task |
| [Playbook](https://leavethepack.dev/docs/playbook/) | Write tasks agents finish, run many agents without collisions, and keep the review load to one person |
| [Agents](https://leavethepack.dev/docs/agents/) | Cloud agents from the board, local agents, limits, live output, and messaging a running agent |
| [The web board](https://leavethepack.dev/docs/web-board/) | The views, a task's panel, Settings, and each repository's page |
| [Features, chase, and the peloton](https://leavethepack.dev/docs/features/) | A roadmap of features, a chase that starts agents on what's ready, and agents checking in with each other |
| [Ideas, decisions, and pings](https://leavethepack.dev/docs/ideas-decisions-pings/) | Let an agent shape an idea, answer its questions in a form, and get a ping when only you can help |
| [Routines](https://leavethepack.dev/docs/routines/) | Save an agent run and start it by hand, on a schedule, or on a GitHub event |
| [The CLI](https://leavethepack.dev/docs/cli/) | Every command of `npx breakaway` |
| [The Claude Code plugin](https://leavethepack.dev/docs/plugin/) | The `tasks` skill, `/breakaway:next`, the session hooks, and the MCP server in one install, for you or a whole repository |
| [MCP clients](https://leavethepack.dev/docs/mcp/) | Connect Claude Code or any MCP client to your board's `/mcp`, and sign in from Claude's apps |
| [GitHub](https://leavethepack.dev/docs/github/) | Your own private App, how pull requests link to tasks, merging, and moving a repository to the deploy flow to promote, roll back, and release |
| [Taskwarrior](https://leavethepack.dev/docs/taskwarrior/) | Sync, reports, and contexts with Taskwarrior 3 |
| [Deploying](https://leavethepack.dev/docs/deploying/) | Releases, channels, the Deploy and Update workflows, and rollbacks |
| [Operating a board](https://leavethepack.dev/docs/operations/) | Secrets, what to keep and what to do when it's lost, backups, and what to do when something breaks |
| [FAQ](https://leavethepack.dev/docs/faq/) | The licence, your data, what it works with, and what it won't do |

<details>
<summary><b>Run it locally</b></summary>

You need Node and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev        # the board, locally
pnpm test       # the tests
pnpm build      # the web app
pnpm interop    # checks sync against real Taskwarrior 3
```

`pnpm interop` needs Taskwarrior 3 on your `PATH`.

| Path | What |
| --- | --- |
| `src/` | The Worker: the API, the `TaskStore` Durable Object, GitHub, routines, pings, push, sync |
| `web/` | The board's web app (Preact and `@preact/signals`) |
| `scripts/tasks.mjs` | The CLI |
| `prompts/` | What the agents the board starts follow, and the install prompt |
| `site/` | The website, the docs, and the update feed |
| `brand/` | The brand guide, tokens, and logo |
| `test/` | Tests, run in the Workers pool |

</details>

<details>
<summary><b>Releases</b></summary>

breakaway publishes releases and never deploys an install. Every install, the owner's included, deploys a release from its own repository, and this repository holds no Cloudflare credentials. Its website follows the latest stable release: the release moves the `site` branch, and Cloudflare deploys it ([`site/README.md`](https://github.com/TheAnarchoX/breakaway/blob/main/site/README.md#deploy-it)).

- **Every merge to `main`**, once CI passes, publishes a GitHub pre-release `vX.Y.Z-main.N` on the `main` channel. It carries the bundle (`breakaway-bundle.tar.gz`: the Worker's files and the web app's `dist`), a `manifest.json` (version, channel, commit, `manual`, and the lowest version it updates from), its signature `manifest.json.sig` (Ed25519, made with a key only the release workflow holds; the public key is `src/release-key.js`), and `SHA256SUMS`. The notes list the merged pull requests by title.
- **A stable release** `vX.Y.Z` is the owner's: they run the **Release** workflow with the pre-release to promote. The bundle is that pre-release's, unchanged, and the notes cover everything since the last stable, under the release's own words from [`docs/releases/vX.Y.Z.md`](https://github.com/TheAnarchoX/breakaway/tree/main/docs/releases) when it's there.
- **The CLI** is on npm as [`breakaway`](https://www.npmjs.com/package/breakaway), staged on npm by the same workflow, with provenance, and live once the owner approves it there with 2FA. npm's trusted publishing can't yet read the OIDC identity of a repository as new as this one ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), so until it can, a token that can stage but never publish by itself stands in, in an environment only `main` can use. Every pre-release goes out under the `next` dist-tag, and a stable release as `latest`. `npx breakaway <command>` is `node scripts/tasks.mjs <command>`.
- **The plugin** for Claude Code (`plugin/`) goes out from the `plugin` branch, never from `main`: Anthropic's plugin directory and this repository's marketplace follow that branch. A stable release runs the **Plugin** workflow, which validates the plugin and moves the branch to the released tag, with `plugin.json`'s version set to the release's. To put a fix out before the next release, the owner runs it by hand on `main` with a release tag, or a commit on `main` a pre-release was made from. As with `site`, a ruleset lets only deploy keys move `plugin`, and the key is the `PLUGIN_DEPLOY_KEY` secret in a `plugin` environment that only `main` can use.
- **A major release** is one where an install has to do something by hand: a config or binding change, a Durable Object class or migration, a route or cron. Its notes have a **Manual steps** section and its manifest says `manual: true`, which an install's deploy stops on. A change that needs it sets `manual` and `manualSteps` in `release.json`, and the pull request that ships the steps clears them. When the only step is `wrangler deploy` (a new Durable Object class, a cron, a route), it also sets `wranglerDeploy: true`, and an install whose Deploy may run `wrangler deploy` does it itself (the install template's README says when). Data the Durable Object stores changes forward-only and additively, so an install can always go back one release, except across a new Durable Object class, which Cloudflare doesn't roll back.
- **The version** is `package.json`'s; the release workflow sets it to the pre-release's before it builds. Patches count by themselves: once a stable is out, the pre-releases work toward its next patch. For the next minor or major, pick it as **next** when you run the **Release** workflow (patch, the default, opens nothing): once the stable is published, the workflow opens a pull request setting `package.json` to it, and after it merges the next pre-release is `vX.Y.0-main.1`. That needs **Allow GitHub Actions to create and approve pull requests** on in the repository's Actions settings (if it was off, turn it on and re-run the **next version** job: it opens the pull request from the branch it already made), and a pull request opened with the workflow's token starts no workflows, so close and reopen it, or push to it, for CI to run. At any other time, **Prepare** on the board's GitHub view starts an agent that opens the same pull request. `GET /api/ping` and `GET /api/health` report it as `release`. An install that deploys a stable passes it as the `BREAKAWAY_VERSION` variable, since the bundle was built as the pre-release.

</details>

## Who builds it

breakaway is built by its owner and their agents, and takes no pull requests or issues from anyone else: [`CONTRIBUTING.md`](https://github.com/TheAnarchoX/breakaway/blob/main/CONTRIBUTING.md) says what you can do instead. Report a security problem privately, as [`SECURITY.md`](https://github.com/TheAnarchoX/breakaway/blob/main/SECURITY.md) says. The agents follow [`AGENTS.md`](https://github.com/TheAnarchoX/breakaway/blob/main/AGENTS.md), and anything people see or read follows the [brand guide](https://github.com/TheAnarchoX/breakaway/blob/main/brand/README.md).

## Licence

Free to use, change, and self-host for anything except offering a competing service, under [FSL-1.1-Apache-2.0](https://github.com/TheAnarchoX/breakaway/blob/main/LICENSE). Each release becomes Apache 2.0 two years after it ships.

breakaway works with Claude Code, GitHub, Taskwarrior, and Cloudflare. None of them made it or endorse it.
