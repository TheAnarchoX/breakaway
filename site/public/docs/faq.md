# FAQ

> The licence, what breakaway does with your data, what it works with, what it won’t do, and the questions people ask first.

## Is breakaway free?

For personal and noncommercial use, yes: free to run, free to change, and free to self-host. The licence is the **PolyForm Noncommercial License 1.0.0**. It lets anyone use breakaway for personal use (research, study, hobby projects, and the like, with no commercial application in view), and lets charities, educational institutions, public research organizations, public safety, health, and environmental organizations, and government institutions use it, however they’re funded. The source is public.

Commercial use is by exception: the owner grants a free commercial licence case by case. [Licensing](https://leavethepack.dev/licensing/) says who can ask and how.

The licence applies from 2.0.0. Every release before it stays under FSL-1.1-Apache-2.0, the licence it shipped with.

There is no hosted version, and no sign-up, hosted accounts, tenants, pricing, paid features, or ads. You can invite the people you work with to your own install, each with a role per repository ([People and roles](https://leavethepack.dev/docs/people/)), and you stay its owner.

## Who hosts this site?

breakaway’s maintainer hosts it, as a non-commercial project. The page has no accounts, pricing, ads, or analytics. The only request it makes of its own is an optional fetch of the [update feed](https://leavethepack.dev/releases.json), to show the latest release.

## Where does my data live?

On your Cloudflare account, in your board’s Durable Object. An install keeps its data: no analytics, telemetry, or tracking, and no call to a service you didn’t connect. The services it can call are GitHub (through your private App), Claude (to start the sessions you ask for), Web Push (if you turn on notifications), the providers you connect for Architect (Cloudflare, with the read-only token you paste; what it reads is redacted and stays on your board), breakaway’s update feed on this site, to look for updates once your config names an install repository, npm's public registry, read-only, to see whether a version your repository's workflows staged on npm is live yet, Frankfurter's public exchange rates, only when you press Fetch today's rate in Settings, and the health URL you name for an environment, your own service, checked on each refresh.

## Does it run my code, or deploy it?

No. The board starts agents, and agents open pull requests. **You** merge and deploy. Nothing in breakaway merges or deploys on an agent’s word. The merge, update-branch, Promote, and Roll back routes accept only the signed-in browser. The bearer token that agents and the CLI hold gets a 403. With Architect, infrastructure follows the same rule: agents propose changes by pull request, and the repository’s apply workflow applies a plan only once you approve it on the board, or when it fits bounds you approved once (an envelope).

## What does it work with?

Claude Code, GitHub, Taskwarrior, and Cloudflare. None of them made it or endorse it. Cloud agents start through Claude Code’s routines, so starting agents from the board needs a Claude plan that has them. Local Claude Code sessions use the CLI and need nothing more.

## Can I use it without Claude?

Yes. The board is useful on its own as a task board with atomic claims, and any agent that can run `npx breakaway` can claim tasks and open pull requests. Starting agents from the board is Claude Code’s cloud routines today.

## Can I use it without Taskwarrior?

Yes. The web board and the CLI work without it. Taskwarrior 3 is a first-class way in if you want filters, reports, and offline work.

## How many repositories can one board run?

Several. Each has its own areas, prompt, agents, and GitHub App installation. The board shares the Worker, sign-in, inbox, and the limits on how many agents run at once.

## What happens if two agents claim the same task?

They can’t. The Durable Object checks and sets the claim in one step, so one wins and the other gets a `409`.

## Does a release update my board by itself?

Only if you choose the `main` channel, where the board starts your own Deploy workflow when there’s a newer pre-release. On `stable`, a newer release is a pull request in your install repository, and nothing deploys until you merge it. Either way Deploy goes back by itself if the new version doesn’t answer. See [Deploying and updating](https://leavethepack.dev/docs/deploying/).

## How do I stay on top of what agents are doing?

Open the Agents view for the running ones and their latest line, open a task for its live output, and read the Activity view for the stream. Pings arrive in your inbox, and as a push if you turned notifications on.

## What does “leave the pack” mean?

A breakaway is the rider who leaves the pack and holds the lead alone. That’s the idea: one person with one tool, moving fast.

## How do I report a problem or a security issue?

Report a security issue privately, as breakaway’s [security policy](https://github.com/TheAnarchoX/breakaway/blob/main/SECURITY.md) says. breakaway takes no issues or pull requests otherwise, apart from a [licence exception request](https://leavethepack.dev/licensing/#how-to-ask): it’s built by its owner and their agents. The licence lets you fix your own copy.
