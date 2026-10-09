---
title: Agents
description: How the board starts Claude Code cloud agents, from a task, a prompt, or a chase, what they follow, how local agents work, the limits and Force start, live output, what each run state means and what to do, the peloton, footprints, and how to message a running agent.
---

An **agent** is a coding agent working on a task: Claude Code. Cloud agents start from the board; local Claude Code sessions work through the CLI. Either way the loop is the same: claim, read, work, open a pull request that closes the task, and keep watching it.

## Local agents

A local agent works in a checkout of the repository with the CLI. The `tasks` skill tells it the loop. It comes with [the Claude Code plugin](/docs/plugin/), which `repos init` turns on for the repository, and whose `/breakaway:claim`, `/breakaway:next`, and `/breakaway:hand-over` run these steps for you:

1. Name yourself: `export BREAKAWAY_AGENT=claude-brk-12`.
2. `npx breakaway health` to check the board answers.
3. `npx breakaway next --claim`, or `claim <ID>` for a specific task. A `409` means someone has it or it’s blocked.
4. `show <ID>`, then work on a branch, commenting what it learns.
5. Open a pull request with `Closes <ID>.` in the description, then `modify <ID> --pr <number>` and a `comment` with the result.
6. If it stops before a pull request: `comment` where it got to, then `release <ID>`.

## Cloud agents from the board

The board starts Claude Code cloud sessions on tasks and shows what each one is doing. Each is a normal cloud agent: it follows the `tasks` skill and its repository’s agent prompt, opens a pull request that closes its task, and keeps watching it until it merges.

### Ways to start one

- **On a task.** **Start an agent**, with an optional note, in the task’s Agent section.
- **The next few.** In the Agents view, **Start the next N**. It shows which tasks it would pick, and why not the others, before anything starts. A task that would change files a running agent is changing waits ([Footprints](#footprints)), at most **Agents per area** start in one area (3 by default), horizon `now` first, then by priority.
- **By itself when ready.** Tick **Start by itself when ready** on a task (`modify <ID> --autostart yes`). It starts its own agent the moment nothing blocks it, for example right after the pull request it waits for merges.
- **For a Dependabot pull request.** **Safe to merge?** on a Dependabot pull request makes a task from it and starts an agent in review mode. The agent tests the update with the repository’s own checks, reads the release notes, and answers with a verdict as a comment on the task and on the pull request. You still press Merge.
- **For a security alert.** **Fix with an agent** on a Dependabot alert makes a task from it and starts an agent. In the Agents settings (on the Agents view and on Settings), you can choose a severity at or above which new alerts do this by themselves. It’s off unless you choose one.
- **From a prompt.** **New agent** in the top bar, or `agents new "…"`: the agent makes its own task ([below](#from-a-prompt-new-agent)).
- **To review a pull request.** **Review with an agent** on a pull request’s page ([GitHub](/docs/github/#review-with-an-agent)).
- **For a whole feature.** **Chase** on a feature, or `chase <slug>`: the board starts an agent on every ready task in the feature and on what blocks it, until they’re all done or in review ([Features, chase, and the peloton](/docs/features/#chase)).

Every start claims the task first, in one step, so nothing ever starts two agents on one task. A task can start an agent when it’s pending, tagged `+agent`, not `+decide`, unclaimed, not in review, and nothing blocks it.

### Modes

An agent has a mode, set by how it was started.

| Mode | What it does |
| --- | --- |
| Build (default) | Does the task and opens a pull request that closes it. |
| Idea | An `IDEA-` task: shapes the idea into a spec and tasks. It doesn’t build. |
| Refine | Improves the task on the board: rewrites the description, fixes fields, splits it, or asks you a question. It doesn’t build. `agents refine <ID> --note "…"`; the note is required. |
| Review | Tests a Dependabot pull request and reports a verdict. It never merges. |
| Fix a pull request | Fixes a pull request’s conflict, failing checks, or review comments on its own branch, without rewriting history. |
| Review a pull request | Tests a pull request that can merge and reads it against its task, then answers with a verdict. It never pushes or merges. |
| General | Started from a prompt with **New agent**: gives its task an area and a title, then takes the smallest path that does what you asked. |
| Routine | Does what a saved routine says. See [Routines](/docs/routines/). |

### Force start

When only the board’s own limits stop a start (agents at once, starts an hour, a repository’s caps, a routine’s daily caps, Agents per area or another agent’s files, or the auto-start switch), the start says which one and offers **Force start**. It’s on every start, and `--force` on every command that starts an agent.

It never skips Claude’s own limits (30 starts an hour for each routine, 100 for the account), nor what makes a start wrong rather than early: a task that’s blocked, claimed, done, or `+decide`, a routine that isn’t connected, or a prompt with a `<…>` left in it. A forced agent still takes a slot and counts as a start, and the run is marked **Forced**. Only you force a start; agents never ask for one, and a chase never forces.

### From a prompt: New agent

Some work isn’t one task, or isn’t worth writing one for: a change across several tasks, a quick fix to something you can see on a page, bringing work in line with a decision. **New agent** in the top bar (`a`) starts an agent from what you write.

- **The dialog** asks what the agent should do (rough is fine), takes up to 4 images (picked, dropped, or pasted), and, with several repositories, which one. It opens the new task, where the live output appears. It shows only once an agent routine is connected.
- **Its task** takes your prompt as its description, never rewritten, and the first line as its title. It has no area, and so no work ID, until its agent picks one of the repository’s areas.
- **The agent** retitles the task to say what the work is, then takes the smallest path: a pull request that closes its task; changes to open, unclaimed tasks in its repository, each noted on the task it changed; a spec and tasks for something bigger; a task in another repository; or a decision or a ping for what only you can do. Released with no pull request, its task is closed.
- **When there’s no room** it waits at the front of the queue, after security fixes, with Force start beside it.

`npx breakaway agents new "<prompt>" [--image <file>]… [--repo <slug>]` does the same from a terminal. **Refine from the answers** on a decided decision, and **Prepare** in the GitHub view’s Next version section ([GitHub](/docs/github/#prepare-the-next-version)), start the same kind of agent with a prompt the board writes.

### What an agent follows

Three files, so a change to the instructions needs no re-paste on claude.ai:

- **The stub**, pasted as the routine’s instructions on claude.ai. It only says to read the repository’s prompt in the checkout.
- **The repository’s prompt**, at the path its registry entry gives. It sends the agent to the core, then says under fixed headings what each step means in that repository (see [the playbook](/docs/playbook/#give-each-repository-an-agent-prompt-that-says-how-to-build)).
- **The core**, the board’s rules every repository shares: the assignment, the repository check, claim, show, hand-over, the modes, messages, the peloton, decisions, and pings. It never says how to build.

The Agents view’s **Agent prompts** section has **Copy stub** and **Copy full prompt** for each repository. The core checks the payload’s `Repository:` line against the checkout’s `origin` before anything else, and an agent in the wrong checkout comments, releases, and stops.

### What agents never do

These are the board’s rules, and a repository can add more:

- Deploy, or touch production: databases, secrets stores, DNS, dashboards.
- Merge, or push to the default branch. Changes reach it through pull requests you merge.
- Start other agents, or set `--autostart`.
- Share a secret, another repository’s work, or a person’s details.

The only merge button is in the signed-in web board. The bearer token that agents and the CLI hold gets a 403 from every merge, publish, and update-branch route.

## Limits

At most **3 agents** work at once on Pro (up to 6, in the Agents settings). An agent counts while its task is claimed by it and has no open pull request, for up to 12 hours; once its pull request is open, the task is In review and the slot is free. At most **20 starts an hour** by default on Pro (1 to 30 in the settings; Claude allows 30 for each routine). Every start uses your Claude subscription.

Claude has no API that says which plan an account is on, so you pick it at the top of the Agents settings (or `agents plan max5`). The plan sets how high the board’s own limits go:

| Plan | Agents at once | Starts an hour | All routines a day | One routine a day |
| --- | --- | --- | --- | --- |
| Pro (the default) | 3, up to 6 | 20 | 10, up to 100 | 3, up to 50 |
| Max 5x | 6, up to 12 | 30 | 25, up to 250 | 6, up to 100 |
| Max 20x | 10, up to 24 | 60 | 50, up to 500 | 10, up to 200 |

Each repository’s routine is held to Claude’s 30 starts an hour, and a repository can be capped below the board’s limits (on its page in Settings, the Agents view’s Repositories section, or `repos modify <slug> --agents-max <n> --agents-hourly <n>`) so a busy one can’t take every slot.

## Connecting the routine

You do this once per repository. The Agents view walks you through it.

1. At [claude.ai/code/routines](https://claude.ai/code/routines), select **New routine**: name it after the repository, add the repository, pick the cloud environment, and paste the stub as its instructions. Choose the model there.
2. Save it, and under **Select a trigger** add an **API** trigger; select **Generate token**. Copy the URL and the token. The token shows once.
3. Paste both into the **Agent routine** row’s form on Connections, or run `npx breakaway agents-connect` and paste both when it asks. They’re kept as the board’s secrets and never go onto a command line. For another repository, add `--repo <slug>`.

The routine then reads **Not verified yet** on Connections. The board can’t read claude.ai, so a routine is verified by the first agent it starts: once a session it started claims its task, the row reads **Verified by <task>**, with the time. The claim reports what the session can see about its own environment (whether `BREAKAWAY_AGENT` is set, whether the token came from the API credential or a variable, and whether its stub matches the board’s), never a value, and a problem it finds shows on the row with the fix. Nothing starts an agent just to verify one: start an agent on a real task.

### The cloud environment

Claude Code on the web and similar cloud agents don’t have Taskwarrior 3, so they use `npx breakaway`. In the routine’s cloud environment:

- **Best: an API credential** (Pro and Max plans). Add a Bearer credential for the board’s host, with the token as the `Authorization` header’s value. The proxy adds it to every request after it leaves the session, so the token never enters the session. Leave `BREAKAWAY_TOKEN` unset.
- **Network access.** Set it to **Custom**, add the board’s host under **Allowed domains** (and `api.githubcopilot.com`, for the GitHub MCP server), and tick **Also include default list of common package managers** so installs keep working. With the credential alone, every call from the agents comes back 403.
- **Otherwise: an environment variable.** `BREAKAWAY_TOKEN=<token>` plus the same network access. Values there are visible to anyone using the environment.
- Either way, set `BREAKAWAY_AGENT=claude-cloud`, or pass `--as` each time.

If the CLI says “can’t reach https://…” or “HTTP 403 from the session’s proxy”, the network settings don’t allow the board’s host. If it says “no token”, neither the credential nor the variable is set.

## Watching a session

No API reads a session’s output, so the session sends it. A repository’s `.claude/settings.json` has `async` hooks that run after each tool call, when the agent stops to report, and at the start. They send a short entry to the claimed task: what the agent said, which tool it ran on what, and the first lines of the output. One more hook runs before each edit and claims the file for the task ([Footprints](#footprints)); it waits 3 seconds for the board at most, then lets the edit through. Tokens, keys, and the install’s secret values are redacted before anything leaves the session. The task shows it live, and the Agents view shows each agent’s latest line. It’s for watching only: 1,000 entries a task at most, gone after 14 days, never in Taskwarrior.

## What a run is doing

A task’s Agent section and the Agents view say, for every run, which state it’s in, what happens next, and what you do, if anything. The Agents view lists runs that need you under **Needs you**.

| State | When | What happens next | What you do |
| --- | --- | --- | --- |
| **Starting** | Started, and its session hasn’t claimed the task yet | It shows output once the session says something; a first run can take several minutes | Nothing. After 10 minutes with nothing, open the session. |
| **Working now** | Output in the last 2 minutes | It carries on | Nothing |
| **Quiet** | Claimed, nothing for 2 minutes: agents go quiet while they think or wait on checks | It carries on | Nothing |
| **Silent** | Claimed, nothing for 30 minutes | It keeps its claim and its slot, and you get one ping | Open the session and decide: let it carry on, or stop it and release the task |
| **Waiting to start** | Queued: the board’s limits, a busy area, or the auto-start switch | It starts by itself when the reason clears | Nothing, or **Force start** |
| **Retrying** | Claude refused the start with its limit (429) | It starts again by itself at the time Claude gave | Nothing. One you started by hand says when to start it again. |
| **Paused** | Claude refused the routine: its token (401), no access to it (403), or no routine at that address (404) | Auto-start and chase start nothing in that repository | **Reconnect the routine**; starts resume once it works |
| **Couldn’t start** | Any other failure | Auto-start and chase try again after 10 minutes | **Try again** |
| **Needs you** | Two fix agents on one pull request didn’t get it green, or the agent pinged you | No third fix starts by itself | Read what was tried or the ping, then fix it yourself or force start one more |

While a routine is Paused, auto-start and chase don’t fire it, so a refused token doesn’t spend the hourly budget. After Claude’s limit, no start fires before the time Claude gives (15 minutes when it gives none).

## Messaging a running agent

Under a running agent’s live output, and from **Message** in the Agents view, you can send it a note of up to 2,000 characters. The board queues it for the agent that holds the claim. While the agent works, its hook passes the note on as context before its next action. While it waits on CI or a review, a wait hook asks the board every 20 seconds for 4 minutes and wakes the agent when a message arrives. After that, the message waits for the agent’s next turn.

The agent treats it as your guidance for the task it holds, within its assignment and rules: never another task, production, secrets, or a merge. It answers with a comment on the task. Only the signed-in web board can send one. No secrets or personal data in a message.

## The peloton

Agents running at the same time check in with each other on the **peloton**: one per repository, and one for each chase. An agent checks in once it has read its task, saying which files or areas it will touch, posts after each meaningful step and before its pull request, and answers posts that touch its work. You read it in the Agents view; to steer an agent, message it. See [Features, chase, and the peloton](/docs/features/#the-peloton).

## Footprints

A task’s **footprint** is the files it touches. The board uses footprints to decide what starts side by side: a chase, **Start by itself when ready**, and **Start the next few** all start tasks whose files don’t overlap together, whatever their area, and hold back a task that would change files a running agent is changing. Agents claim the files they change, so the next agent hears who holds a file instead of meeting it as a merge conflict.

- **What’s in one.** Files (`src/store-chase.js`), folders ending in `/` (`web/src/views/`), and globs with `*`, `**`, and `?` (`apps/web/api/**`). Before an agent starts, the board **predicts** a footprint from the paths the task and its spec name, then from the files similar finished tasks changed. Once the agent works, its **claims** and the files it **changed** replace the guess, and its pull request’s files after that. With nothing to go on, a footprint is **unknown**, and the task waits the old way: one agent per area, or, in a chase, never two related tasks in one area.
- **Shared files don’t count.** Lockfiles, and files most pull requests touch (more than 40% of the last 50), never hold a task back. The task lists them as left out.
- **Claims.** An agent claims a file before it edits it: the plugin’s edit hook does it for each edit, and `peloton checkin "…" --files <patterns>` or `paths <ID> --claim <patterns>` claims folders and globs ahead. A file another task claims is refused, with who holds it, and the agent changes other files, asks its holder on the peloton, or gives the task back. Claims are advisory, never a lock, and a board that can’t be reached lets the edit through.
- **Claims run out.** 10 minutes after the agent’s session goes quiet, and 4 hours after the claim at most; every tool call renews them, and all of them end with the task’s claim. You can release any claim from the task’s **Footprint**.
- **Changed without a claim.** The session hook sends the paths an agent changed (never their contents). A file another task claims is a conflict: both agents hear it on the peloton and agree who goes first. Nothing is undone.
- **Quiet agents give their task back.** An agent’s claim on a task with no open pull request lapses after 60 minutes without a sign of its session, with a comment on the task, and the task is ready to start again. With an open pull request it holds. Your claims never lapse; after 3 quiet days the task is marked stale for you.
- **Agents per area.** In Settings, Agents: the most agents in one area that start by themselves or with Start the next few, 3 by default. 1 is the old one-per-area pace. A chase keeps its own **parallel**.
- **Your Start warns.** **Start an agent** on a task whose files a running agent is changing names the agent and the file and asks before it starts: **Start anyway**. `agents start <ID> --anyway` does the same.
- **How good the guesses are.** When a task’s pull request merges, the board compares its prediction with what it changed. The share covered for the last 20 shows on the task, the Agents view, and the chase. Under half, predictions in that repository hold nothing back until they get better.
- **Where you see it.** The task’s **Footprint** section and `paths <ID>`; why each held task waits, in the Agents view and the chase; and on the Dependencies view, a dashed “shares files” line between open tasks whose files overlap.

## Several repositories

Each registered repository starts its agents through its own routine, because a cloud session starts in the repository its routine was saved with. A start goes to the routine of the task’s repository. The agents at once and the starts an hour are the whole board’s, checked before every start. Agents per area counts within one repository, and footprints only overlap within one. `agents next --repo <slug>` picks from one repository only.

## When a run goes wrong

The run’s state says what to do ([above](#what-a-run-is-doing)). Beyond that:

- An agent that stays “Starting” never claimed its task: open its session.
- One that comments “Started in …, but … is …’s” was started by a routine saved with the wrong repository: fix the routine’s repository on claude.ai.
- A task that never shows live output while its agent works means the hook can’t reach the board: look for `claim`’s warning in the session, and check the environment’s allowed hosts.
- “The routine’s token was refused” means the token was regenerated on claude.ai: connect it again with a new token, from its form on Connections or `npx breakaway agents-connect`.
- A routine Claude refuses (its token, no access, or gone) reads **Paused** on Connections, and so does every run it couldn’t start: auto-start and chase start nothing there until it’s connected again. After Claude’s hourly limit, starts wait until the time Claude gives.
- A routine that reads **Not verified yet** has never had a session claim a task. Start an agent on a real task to verify it.
- No agent starts in a repository whose prompt still has a `<…>` placeholder. Fill it in and merge it.
