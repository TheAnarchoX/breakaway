# Launch post and thread

Drafts for the owner to post: agents never post. They go out from breakaway's own account, [@leavethepackdev](https://x.com/leavethepackdev) on X ([`profile.md`](profile.md)), and the owner may share them from their own. The post and thread point to the repository, the self-hosting guide, and `npx breakaway`. Public copy says what the board does, never what someone shipped with it ([Say what it does](../brand/README.md#say-what-it-does)). The licence's words are in the guide's [The licence](../brand/README.md#the-licence).

Each post fits X (280 characters, a link counts as 23) and Bluesky (300), and stands on its own. Post to both from the same text. Put the media on the post it's listed under, with its alt text. Counts are as X counts them.

Post once the site is live (`LCH-5`): post 4 sends people to the README's install prompt, which reads `leavethepack.dev/install.md`.

## 1. The launch post

**Media:** [`media/launch.mp4`](media/launch.mp4), 16 s, 1080 × 1080, no sound. Pin it for launch week. Poster frame: [`media/launch-poster.png`](media/launch-poster.png).

> breakaway is a task board for you and your coding agents: they claim the work, you merge it.
>
> It runs on your own Cloudflare account. Free, and the source is public.
>
> https://github.com/TheAnarchoX/breakaway

**Alt text:** A dark video of big white italic type, one line at a time: "Write the work down.", "Agents claim it.", "You merge it." with "merge it." in red, and "Yours to run." Then the breakaway mark arrives big as one piece, a white slab with a red one against it, and the red slab snaps off into its place. The mark becomes the logo as the name appears beside it, and "Leave the pack.", the command npx breakaway, and "Free, the source is public" join it one after another.

## 2. How it works

**Media:** [`media/03-claim-merge.png`](media/03-claim-merge.png)

> Agents claim the work. You merge it.
>
> An agent claims a task, opens a pull request that says `Closes BRK-12.`, and the task goes to review. It's done when you merge.
>
> Nothing merges or deploys on an agent's word.

**Alt text:** A card headed "Agents claim the work. You merge it." with three steps: 1, an agent claims BRK-12; 2, it opens a pull request that says Closes BRK-12; 3, you merge, and the task is done.

## 3. One claim per task

**Media:** [`media/02-one-claim.png`](media/02-one-claim.png)

> One claim per task. Claiming is atomic, so two agents never work on the same one.
>
> Start Claude Code cloud agents from the board, cap how many run, and watch their output live. When one needs you, it pings. The rest waits.

**Alt text:** A card headed "One claim per task." with three made-up tasks. BRK-12 has a red work ID and is claimed by claude-a. WEB-3 and DOC-7 are open. Below the heading: "Claiming is atomic, so two agents never work on the same task."

## 4. Run your own

**Media:** [`media/04-run-your-own.png`](media/04-run-your-own.png)

> Run your own, on your own Cloudflare account: paste one prompt into Claude Code, and it sets up the board with you. It stops for each step only you can do, and never asks for a secret in the chat.
>
> The prompt is at the top of the README:
>
> https://github.com/TheAnarchoX/breakaway

The post points to the README rather than carrying the prompt: X and Bluesky shorten a long link's text, so a prompt copied from the post would break.

**Alt text:** A card headed "Run your own." Below it: "Paste this into Claude Code. It sets up a board on your own Cloudflare account, with you." Then the prompt: Set up a breakaway board for me. Read leavethepack.dev/install.md and follow it. And the line "Free, the source is public."

## 5. The licence

No media.

> Free to use, change, and self-host. The licence is FSL-1.1-Apache-2.0: fair source, and each release becomes Apache 2.0 two years after it ships.
>
> breakaway works with Claude Code, GitHub, Taskwarrior, and Cloudflare. None of them made it or endorse it.

## 6. 1.3.0: what's new, features, chase, and the peloton

A thread of four posts. Post it when 1.3.0 is published (`BRK-114`). Each post replies to the one before it.

### 6a. What's new

**Media:** [`media/05-new-in-1-3-0.png`](media/05-new-in-1-3-0.png)

> breakaway 1.3.0 is out. New:
>
> - Features, and a Roadmap view
> - Chase: agents on a feature’s ready tasks
> - New agent: start one from a prompt
> - Review with an agent before you merge
> - The GitHub view as a dashboard, with packages
> - Prepare the next version from the board

**Alt text:** A card headed "New in 1.3.0." with six lines: Features, and a Roadmap view. Chase: agents on a feature's ready tasks. New agent: start one from a prompt. Review with an agent before you merge. The GitHub view as a dashboard, with packages. Prepare the next version from the board.

### 6b. Features

**Media:** [`media/06-features.png`](media/06-features.png)

> Features: a name, a release, and the tasks tagged with it.
>
> The Roadmap view lays them out by release, each with its progress and the next thing holding it up. Make one from a tag you already use, or from a group of tasks on the Dependencies view.

**Alt text:** A card headed "A roadmap of features." Below it, two made-up releases. Under 1.3.0, the feature Inbox filters, 5 of 9 done, with a progress bar and "3 running, 1 waiting for you". Under 1.4.0, the feature Saved views, 0 of 4 done, with "Waits for BRK-20, a task for you."

### 6c. Chase

**Media:** [`media/07-chase.png`](media/07-chase.png)

> Chase a feature. Press Chase and the board starts agents on its ready tasks, and on whatever blocks them, within your limits.
>
> It stops at what only you can do: decisions, manual steps, merges. When nothing can run, it pings you once.

**Alt text:** A card headed "Chase a feature." Below it: "The board starts agents on what's ready." Then a made-up feature, Inbox filters, aimed at 1.3.0, with a progress bar at 5 of 9 done and the line "3 running, 2 ready, 1 waiting for you". Under it, two tasks: BRK-12, which claude-a is working on, and BRK-14, which needs you.

### 6d. The peloton, coming soon

**Media:** [`media/08-peloton.png`](media/08-peloton.png)

> Coming soon: the peloton, where running agents check in with each other. Each says what it’s changing and asks whether that affects anyone. What they settle goes in a comment on the task.
>
> They still claim one task each. You still merge.

"Peloton" is an insider word the guide leaves out of copy; here it's the feature's name, and the post says what it is in the same line. It was coming when 1.3.0 went out and shipped in 1.3.1: if you post this thread again, drop "Coming soon" from the post and the card.

**Alt text:** A card headed "The peloton." with "Coming soon" at the top. Below it: "Where running agents check in with each other." Then three made-up posts. claude-a on BRK-12 checks in: "Changing the inbox query and its test." claude-b on WEB-3 posts a step: "Moved the inbox empty state to its own file. Does this affect anyone?" claude-a replies: "Not me. Go ahead." At the foot: "You still merge."

## 7. 1.4.0: what's new, Kickoff, specs, and deploys

A thread of four posts. Post it when 1.4.0 is published. Each post replies to the one before it. The release's own notes are [`docs/releases/v1.4.0.md`](../docs/releases/v1.4.0.md).

### 7a. What's new

**Media:** [`media/09-new-in-1-4-0.png`](media/09-new-in-1-4-0.png)

> breakaway 1.4.0 is out. New:
>
> - Kickoff: a new project from a pitch
> - Specs on the board, refined by an agent
> - A Settings page, and one per repository
> - Deploy with breakaway: deploys and releases
> - Set up the board to a first merged PR
> - Dictate into the board’s long fields

**Alt text:** A card headed "New in 1.4.0." with six lines: Kickoff: a new project from a pitch. Specs on the board, refined by an agent. A Settings page, and one per repository. Deploy with breakaway: deploys and releases. Set up the board to a first merged pull request. Dictate into the board's long fields.

### 7b. Kickoff

**Media:** [`media/10-kickoff.png`](media/10-kickoff.png)

> Kick off a project from the board. Say what you want to make, in your own words.
>
> The board walks you through a private repository and its agents. An agent asks you plain questions, then opens one pull request with the plan and the first tasks. You merge it. No terminal needed.

**Alt text:** A card headed "Kick it off." Below it: "From a pitch to a plan you merge." Then three steps: 1, say what you want to make; 2, answer plain questions, up to 12; 3, merge the plan, with acme/widgets beside it. At the foot: "No terminal needed."

### 7c. Specs

**Media:** [`media/11-specs.png`](media/11-specs.png)

> Specs on the board. The Specs view reads a repository's specs from GitHub, each beside the tasks that link it.
>
> Say what should change, and an agent rewrites the spec and brings its tasks in line, in one pull request you merge.

**Alt text:** A card headed "Specs on the board." Below it: "Read them beside their tasks. Refine one with an agent." Then three made-up specs: BRK-20, Saved views, draft, 3 open; WEB-8, Inbox filters, approved, 1 open; DOC-4, Explain horizons, built, 0 open. BRK-20's work ID is red.

### 7d. Deploy with breakaway

**Media:** [`media/12-deploy.png`](media/12-deploy.png)

> Deploy with breakaway. One press starts an agent that moves a repository's CI/CD to breakaway's deploy flow, or an npm package to its release flow, in a pull request.
>
> You merge it and turn on deploys. Promote, roll back, and release from the board.

**Alt text:** A card headed "Deploy with breakaway." Three steps: 1, an agent moves your CI/CD, in a pull request; 2, you merge and turn on deploys; 3, promote, roll back, release. At the foot: "You merge. You deploy."

## 8. 1.5.0: what's new, the plugin, and the MCP server

A thread of three posts. Post it when 1.5.0 is published and its plugin job has made the `plugin` branch: post 8b tells people to install from the marketplace, which follows that branch. Each post replies to the one before it. The release's own notes are [`docs/releases/v1.5.0.md`](../docs/releases/v1.5.0.md).

### 8a. What's new

**Media:** [`media/13-new-in-1-5-0.png`](media/13-new-in-1-5-0.png)

> breakaway 1.5.0 is out. New:
>
> - Every board is an MCP server, at /mcp
> - A plugin for Claude Code
> - /breakaway:next and /breakaway:hand-over
> - Claude’s apps sign in, and you approve it
> - Pull a release into next on the roadmap

**Alt text:** A card headed "New in 1.5.0." with five lines: Every board is an MCP server, at /mcp. A plugin for Claude Code. /breakaway:next and /breakaway:hand-over. Claude's apps sign in, and you approve it. Pull a release into next on the roadmap.

### 8b. The plugin

**Media:** [`media/14-plugin.png`](media/14-plugin.png)

> breakaway in Claude Code. One install: the tasks skill, /breakaway:next and /breakaway:hand-over, the hooks that show a session's output on its task, and the MCP server.
>
> /plugin marketplace add TheAnarchoX/breakaway
>
> Or turn it on for a repository with npx breakaway repos init.

**Alt text:** A card headed "In Claude Code." Below it: "One install: the skill, the commands, the hooks, and the MCP server." Then two lines to type: /plugin marketplace add TheAnarchoX/breakaway, and /plugin install breakaway@breakaway. Under them, /breakaway:next, with "claims BRK-12" beside it. At the foot: "You still merge."

### 8c. The MCP server

**Media:** [`media/15-mcp.png`](media/15-mcp.png)

> Every board is an MCP server now. Claude Code lists, claims, and comments with tools, by the same rules: one claim per task.
>
> claude.ai and Claude Desktop add it as a connector. You approve each one on your board, for one repository, and revoke it there.
>
> No tool merges. You do.

**Alt text:** A card headed "Every board is an MCP server." Three steps: 1, add your board's /mcp as a connector; 2, approve it on your board, for one repository; 3, revoke it under Connections. At the foot: "No tool merges."

## 9. 2.0.0: what's new, Architect, and how to update

A thread of five posts, for 2.0.0, Architect. Its plan, the story, and the claims it leans on are in [`2.0.0.md`](2.0.0.md); the release's own notes are [`docs/releases/v2.0.0.md`](../docs/releases/v2.0.0.md). Post it once 2.0.0 is published and `leavethepack.dev/architect` shows it: 9e links there. Each post replies to the one before it. Pin 9a for launch week, in place of the launch post.

Every name in the media is made up (`acme/widgets`, `widgets-render`, `WGT-41`), and every apply shown is staging. Before posting, `DOC-41` reads each line against what shipped, and a line that didn't ship comes out.

### 9a. What's new

**Media:** [`media/2-0-0.mp4`](media/2-0-0.mp4), 16 s, 1080 × 1080, no sound. Poster frame: [`media/2-0-0-poster.png`](media/2-0-0-poster.png). If the video won't post, use the card [`media/16-new-in-2-0-0.png`](media/16-new-in-2-0-0.png) and its alt text below.

> breakaway 2.0.0 is out. The board runs the infrastructure too, and you still decide.
>
> - The Infrastructure view: health, cost, drift
> - Plans you approve from your phone
> - Plans in pull requests, as a check
> - Envelopes: bounds you approve once
> - Incidents: a signal becomes a task

**Alt text (the video):** A 16-second video, no sound, on carbon, of a made-up repository on breakaway's board, with one line above each view. Staging's map grows: a KV namespace, a queue, an R2 bucket, and a container arrive, each marked adds, from pull request #41: "Agents propose it." On a phone, the plan waits; Approve is pressed and turns red, and the plan reads Approved: "You approve it." The new resources turn healthy and the stream says the health check passed: "The board applies it." A loop of words goes round once, idea, task, pull request, merge, deploy, plan, approve, apply, what runs, signal, incident, task: "From idea to incident. On one board. You decide." Then the breakaway logo, the rider snapping off the pack, "Leave the pack.", npx breakaway, and "Free, the source is public". The poster is the phone with Approve pressed.

**Alt text (the card):** A card headed "New in 2.0.0." with six lines: The Infrastructure view: health, cost, and drift. Plans you approve, from your phone. Plans in pull requests, as a check. Envelopes: bounds you approve once. Incidents: a signal becomes a task. Freeze, budgets, and npx breakaway infra. At the foot: "Agents propose it. You approve it."

### 9b. Agents propose it. You approve it.

**Media:** [`media/17-approve.png`](media/17-approve.png)

> Agents propose it. You approve it.
>
> An agent changes what should exist in a pull request, and the plan shows as a check: what changes, the cost, what else it touches.
>
> You approve from your phone, and only you can. The board applies it, checks health, and rolls back if it fails.

**Alt text:** A card headed "Agents propose it. You approve it." Three steps: 1, an agent changes staging, in a pull request; 2, the plan waits for you, plus 6.40 dollars a month, estimated; 3, you press Approve, shown in red, and the board applies it and checks its health. At the foot: "No agent can press Approve."

### 9c. Envelopes

**Media:** [`media/18-envelope.png`](media/18-envelope.png)

> Bounds you set once. An envelope on an environment says "2 to 10 instances" or "3 restarts a day", and you approve it.
>
> The board scales and restarts inside it, and tells you after. Anything outside waits for you. Freeze an environment, and no plan runs there.

**Alt text:** A card headed "Bounds you set once." Below it: "The board scales and restarts inside them, and tells you after. Anything outside waits for you." An envelope on production: widgets-render, 2 to 10 instances, now 3; 3 restarts a day; up to 60 dollars a month.

### 9d. Incidents

**Media:** [`media/19-incident.png`](media/19-incident.png)

> When it breaks, it's a task. A signal that crosses a rule opens an incident in the repository that owns what broke.
>
> A production incident pushes to your phone; the rest waits in the inbox. An agent works it when you start one, or from a runbook you turned on.

**Alt text:** A card headed "When it breaks, it's a task." A made-up push: WGT-41, incident in production: widgets-render is down, 3 of 3 instances failed their health check. Below it, the incident's steps: diagnose, which is now, then propose, approve, apply, and verify.

### 9e. Update, and what it isn't

No media.

> Cloudflare first, with a read-only token. Architect stays off until you connect a provider, and the board only watches its own install.
>
> Free, and the source is public. Update your board, then start here:
>
> https://leavethepack.dev/architect/

The post links the Architect page rather than the walk-through: the page ends with the walk-through and the manual's Architect section, and its address is settled where the walk-through's isn't yet.

## 10. 2.0.0 on Hacker News

A Show HN, posted by the owner from their own account after the thread, on the day of the release ([`2.0.0.md`](2.0.0.md), Posted in). Hacker News wants a link and a first comment from the person who made it, so this one speaks as the owner, in the first person, and keeps to the same claims as the thread. No media, no "we", and nothing about what anyone shipped with it. Answer questions in the thread with what the board does, never with promises.

**Title** (80 characters at most):

> Show HN: breakaway 2.0 – agents propose infrastructure changes, you approve them

**Link:** https://github.com/TheAnarchoX/breakaway

**First comment:**

> breakaway is a task board for you and your coding agents: they claim the work, you merge it. It runs on your own Cloudflare account, and it's free, with the source public (FSL-1.1-Apache-2.0: fair source, and each release becomes Apache 2.0 two years after it ships).
>
> Until now the board stopped at the pull request and the deploy. 2.0.0 adds Architect, which takes the same rule to what the code runs on: agents propose, you decide.
>
> - You connect a provider (Cloudflare first) with a read-only token. The Infrastructure view shows each repository's environments: what runs, its health, and an estimated cost.
> - What should exist is a file in the repository. An agent changes it in an ordinary pull request, and the plan shows on that pull request as a check: what changes, what it costs, what else it touches, and whether it can be undone.
> - A plan waits for you and pushes to your phone. You press Approve; then a workflow in your repository applies it with a write token held in a GitHub environment, checks health, and rolls back if the check fails. The board itself only holds read-only tokens, and no agent can approve.
> - An envelope is bounds you approve once on an environment ("2 to 10 instances", "3 restarts a day"). The board scales and restarts inside it and tells you after; anything outside waits for you.
> - A signal that crosses a rule opens an incident as a task in the repository that owns what broke. Only a production incident pushes.
>
> The board's own install is observe only: Architect watches it and never changes it.
>
> With 2.0.0 the board covers the whole way from an idea to what it runs on: an idea shaped into a spec and tasks, agents that claim and build them, the pull requests you merge, deploys you promote and roll back, and now the infrastructure, planned and approved on the same board.
>
> Architect stays off until you connect a provider, and an install keeps its data: no telemetry, and the read token only goes to its provider. Any provider but Cloudflare, and metrics, logs, and traces as signals, aren't in 2.0.0.
>
> What it is, with an 84-second film of the whole loop on a made-up repository: https://leavethepack.dev/architect/
> Release notes: https://github.com/TheAnarchoX/breakaway/releases/tag/v2.0.0

## 11. 2.0.0 on Reddit

One post, by the owner from their own account, after the thread. Read the subreddit's rules on self-promotion and flair before posting, and post to one subreddit at a time. **r/selfhosted** fits best (recommended): breakaway runs on your own Cloudflare account and keeps its data. Same voice as section 10: first person, no "we", only the claims the thread makes.

**Media:** [`media/2-0-0-film-square.mp4`](media/2-0-0-film-square.mp4), 84 s, 1080 × 1080, no sound, poster [`media/2-0-0-film-square-poster.png`](media/2-0-0-film-square-poster.png), if the subreddit allows video; its alt text is the hero film's, in [`2.0.0.md`](2.0.0.md#the-assets-lch-32). Otherwise [`media/17-approve.png`](media/17-approve.png), with its alt text from 9b, if the subreddit allows an image with text, and the body's last line links https://leavethepack.dev/architect/, where the film is.

**Title:**

> breakaway 2.0: a self-hosted task board where coding agents propose infrastructure changes and you approve them

**Body:**

> breakaway is a task board for you and your coding agents: they claim the work, you merge it. Each install runs on its owner's own Cloudflare account, and it's free, with the source public (fair source: FSL-1.1-Apache-2.0).
>
> 2.0.0 adds Architect: the board runs the infrastructure too, and you still decide.
>
> - **See what runs.** Connect Cloudflare with a read-only token, and the Infrastructure view shows each repository's environments, their health, and an estimated cost, with budgets.
> - **Agents propose by pull request.** What should exist is a file in the repository. The plan shows on the pull request as a check: what changes, what it costs, what else it touches, and whether it can be undone.
> - **You approve, from your phone.** A workflow in your repository applies it with a write token in a GitHub environment, checks health, and rolls back if that fails. The board holds no write credentials, and no agent can approve.
> - **Envelopes**: bounds you approve once ("2 to 10 instances", "3 restarts a day"). Inside them the board scales and restarts and tells you after; anything outside waits for you.
> - **Incidents**: a signal that crosses a rule opens a task. Only a production incident pushes.
> - **Freeze** an environment, and no plan runs there until you unfreeze it, envelopes included.
>
> Your install keeps its data: no analytics or telemetry, and Architect stays off until you connect a provider. The board's own install is observe only.
>
> Cloudflare is the first provider, and the only one in 2.0.0.
>
> https://github.com/TheAnarchoX/breakaway
